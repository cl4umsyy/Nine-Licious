-- =============================================================================
-- NINE LICIOUS POS — SINGLE GLOBAL ACTIVE CASHIER SHIFT ENFORCEMENT
-- File: supabase/migrations/20261127000100_enforce_single_global_active_shift.sql
--
-- TUJUAN:
-- Menjamin sistem Nine Licious hanya mengizinkan SATU shift kasir berstatus 'open'
-- secara global pada satu waktu (bukan satu shift per kasir).
--
-- PERUBAHAN UTAMA:
-- 1. Preflight check: menolak migrasi bila terdeteksi >= 2 shift berstatus 'open'
--    agar tidak pernah menghapus atau menutup rekonsiliasi kas secara diam-diam.
-- 2. Mengganti partial unique index per-kasir (idx_shifts_single_active_cashier)
--    menjadi partial unique index global (idx_shifts_single_global_active).
-- 3. Memperbarui open_shift_atomic dengan pg_advisory_xact_lock + FOR UPDATE
--    global serta penolakan eksplisit jika kasir lain sedang bertugas.
-- 4. Menambahkan RPC get_active_global_shift_status() (non-finansial) agar UI
--    kasir lain dapat mengetahui bahwa shift sedang digunakan beserta nama kasir
--    yang sedang bertugas tanpa membuka data finansial milik kasir aktif via RLS.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. PREFLIGHT SAFETY CHECK (TANPA MUTASI DATA HISTORIS)
-- -----------------------------------------------------------------------------
do $$
declare
  v_open_count integer;
  v_open_list text;
begin
  select
    count(*)::integer,
    string_agg(
      format(
        'shift_id=%s cashier=%s (%s) opened_at=%s',
        s.id,
        coalesce(p.full_name, '-'),
        coalesce(p.username, s.cashier_id::text),
        to_char(s.opened_at at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI')
      ),
      '; '
    )
  into v_open_count, v_open_list
  from public.shifts s
  left join public.profiles p on p.id = s.cashier_id
  where s.status = 'open';

  if coalesce(v_open_count, 0) > 1 then
    raise exception
      'PREFLIGHT_MULTIPLE_OPEN_SHIFTS: Ditemukan % shift berstatus open secara bersamaan (%). Tutup shift berlebih terlebih dahulu melalui /admin/shifts atau close_shift_atomic sebelum menjalankan migrasi ini.',
      v_open_count,
      v_open_list;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 2. GLOBAL PARTIAL UNIQUE INDEX: MAKSIMAL SATU SHIFT AKTIF ('open') SECARA GLOBAL
-- -----------------------------------------------------------------------------
drop index if exists public.idx_shifts_single_active_cashier;

create unique index if not exists idx_shifts_single_global_active
  on public.shifts ((1))
  where (status = 'open');

comment on index public.idx_shifts_single_global_active is
  'Menjamin secara ketat pada level engine database hanya boleh ada maksimal 1 shift kasir berstatus open secara global.';

-- -----------------------------------------------------------------------------
-- 3. RPC NON-FINANSIAL: GET_ACTIVE_GLOBAL_SHIFT_STATUS()
-- Mengembalikan informasi non-finansial shift aktif global agar UI kasir lain
-- mengetahui siapa kasir yang sedang bertugas tanpa melonggarkan RLS finansial.
-- -----------------------------------------------------------------------------
create or replace function public.get_active_global_shift_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid;
  v_caller_role text;
  v_caller_active boolean;
  v_shift record;
begin
  v_caller_id := auth.uid();
  if v_caller_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select role, is_active
  into v_caller_role, v_caller_active
  from public.profiles
  where id = v_caller_id;

  if not found or v_caller_active is distinct from true then
    raise exception 'Profil pengguna tidak ditemukan atau tidak aktif.';
  end if;

  if v_caller_role not in ('admin', 'kasir') then
    raise exception 'Hanya Admin dan Kasir yang dapat memeriksa status shift aktif.';
  end if;

  select
    s.id as shift_id,
    s.cashier_id,
    s.opened_at,
    p.full_name as cashier_name,
    p.username as cashier_username
  into v_shift
  from public.shifts s
  left join public.profiles p on p.id = s.cashier_id
  where s.status = 'open'
  order by s.opened_at asc
  limit 1;

  if not found then
    return pg_catalog.jsonb_build_object(
      'has_active_shift', false,
      'shift_id', null,
      'cashier_id', null,
      'cashier_name', null,
      'cashier_username', null,
      'opened_at', null,
      'is_owned_by_caller', false
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'has_active_shift', true,
    'shift_id', v_shift.shift_id,
    'cashier_id', v_shift.cashier_id,
    'cashier_name', v_shift.cashier_name,
    'cashier_username', v_shift.cashier_username,
    'opened_at', v_shift.opened_at,
    'is_owned_by_caller', (v_shift.cashier_id = v_caller_id)
  );
end;
$$;

revoke all on function public.get_active_global_shift_status() from public, anon, service_role;
grant execute on function public.get_active_global_shift_status() to authenticated;
grant execute on function public.get_active_global_shift_status() to service_role;

-- -----------------------------------------------------------------------------
-- 4. RPC ATOMIK HARDENED: OPEN_SHIFT_ATOMIC (SINGLE GLOBAL ACTIVE SHIFT)
-- -----------------------------------------------------------------------------
create or replace function public.open_shift_atomic(
  p_opening_cash integer,
  p_notes text default null,
  p_cashier_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid;
  v_caller_profile record;
  v_target_cashier_id uuid;
  v_target_profile record;
  v_active_shift record;
  v_concurrent_shift record;
  v_new_shift record;
  v_admin_username text;
  v_shift_notes text;
  v_holder_label text;
begin
  -- 1. Validasi sesi pengguna pemanggil
  v_caller_id := auth.uid();
  if v_caller_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select id, role, is_active, username, full_name
  into v_caller_profile
  from public.profiles
  where id = v_caller_id
  for share;

  if not found or v_caller_profile.is_active is distinct from true then
    raise exception 'Profil pengguna tidak ditemukan atau tidak aktif.';
  end if;

  if v_caller_profile.role not in ('admin', 'kasir') then
    raise exception 'Hanya Admin dan Kasir yang dapat membuka shift.';
  end if;

  -- 2. Tentukan kasir target (Kasir hanya boleh membuka untuk dirinya sendiri)
  if p_cashier_id is not null and p_cashier_id <> v_caller_id then
    if v_caller_profile.role <> 'admin' then
      raise exception 'Kasir hanya dapat membuka shift untuk dirinya sendiri.';
    end if;
    v_target_cashier_id := p_cashier_id;
  else
    v_target_cashier_id := v_caller_id;
  end if;

  select id, role, is_active
  into v_target_profile
  from public.profiles
  where id = v_target_cashier_id
  for share;

  if not found or v_target_profile.is_active is distinct from true then
    raise exception 'Profil kasir target tidak ditemukan atau tidak aktif.';
  end if;

  if v_target_profile.role not in ('admin', 'kasir') then
    raise exception 'Pengguna target bukan kasir atau admin.';
  end if;

  -- Format catatan jika dibuka oleh Admin atas nama kasir
  if v_target_cashier_id <> v_caller_id then
    v_admin_username := coalesce(v_caller_profile.username, v_caller_profile.full_name, 'Admin');
    if p_notes is not null and btrim(p_notes) <> '' then
      v_shift_notes := '[Dibuka oleh Admin: ' || v_admin_username || '] ' || btrim(p_notes);
    else
      v_shift_notes := '[Dibuka oleh Admin: ' || v_admin_username || ']';
    end if;
  else
    v_shift_notes := nullif(btrim(p_notes), '');
  end if;

  -- 3. Validasi modal awal
  if p_opening_cash is null or p_opening_cash < 0 then
    raise exception 'Modal kas awal tidak boleh bernilai negatif.';
  end if;

  -- 4. Serialisasi pembukaan shift global menggunakan advisory lock tingkat transaksi
  --    sehingga dua kasir yang menekan "Buka Shift" di milidetik bersamaan tetap antre aman.
  perform pg_catalog.pg_advisory_xact_lock(91500501);

  select
    s.id,
    s.cashier_id,
    p.full_name as cashier_name,
    p.username as cashier_username
  into v_active_shift
  from public.shifts s
  left join public.profiles p on p.id = s.cashier_id
  where s.status = 'open'
  order by s.opened_at asc
  limit 1
  for update of s;

  if found then
    if v_active_shift.cashier_id = v_target_cashier_id then
      raise exception 'Kasir masih memiliki shift aktif yang belum ditutup (Shift ID: %). Tutup shift terlebih dahulu.',
        v_active_shift.id;
    end if;

    v_holder_label := coalesce(
      nullif(btrim(v_active_shift.cashier_name), ''),
      nullif(btrim(v_active_shift.cashier_username), ''),
      'kasir lain'
    );
    if v_active_shift.cashier_username is not null and btrim(v_active_shift.cashier_username) <> ''
       and v_holder_label <> btrim(v_active_shift.cashier_username) then
      v_holder_label := v_holder_label || ' (@' || btrim(v_active_shift.cashier_username) || ')';
    end if;

    raise exception 'SHIFT_OCCUPIED_BY_OTHER_CASHIER: Tidak dapat membuka shift baru karena masih ada shift aktif yang sedang digunakan oleh %. Tutup shift tersebut terlebih dahulu.',
      v_holder_label;
  end if;

  -- 5. Insert shift baru dengan pengaman constraint global unique_violation
  begin
    insert into public.shifts (
      cashier_id,
      opening_cash,
      expected_cash,
      actual_cash,
      cash_difference,
      status,
      notes,
      opened_at
    ) values (
      v_target_cashier_id,
      p_opening_cash,
      p_opening_cash,
      null,
      null,
      'open',
      v_shift_notes,
      pg_catalog.now()
    ) returning * into v_new_shift;
  exception
    when unique_violation then
      select
        s.id,
        s.cashier_id,
        p.full_name as cashier_name,
        p.username as cashier_username
      into v_concurrent_shift
      from public.shifts s
      left join public.profiles p on p.id = s.cashier_id
      where s.status = 'open'
      order by s.opened_at asc
      limit 1;

      if v_concurrent_shift.cashier_id = v_target_cashier_id then
        raise exception 'Kasir masih memiliki shift aktif yang belum ditutup (Shift ID: %). Tutup shift terlebih dahulu.',
          v_concurrent_shift.id;
      end if;

      v_holder_label := coalesce(
        nullif(btrim(v_concurrent_shift.cashier_name), ''),
        nullif(btrim(v_concurrent_shift.cashier_username), ''),
        'kasir lain'
      );
      raise exception 'SHIFT_OCCUPIED_BY_OTHER_CASHIER: Tidak dapat membuka shift baru karena masih ada shift aktif yang sedang digunakan oleh %. Tutup shift tersebut terlebih dahulu.',
        v_holder_label;
  end;

  -- 6. Catat cash_movement pembukaan kas
  insert into public.cash_movements (
    shift_id,
    movement_type,
    amount,
    balance_before,
    balance_after,
    reason,
    created_by
  ) values (
    v_new_shift.id,
    'opening_cash',
    p_opening_cash,
    0,
    p_opening_cash,
    'Modal kas awal shift kasir',
    v_caller_id
  );

  -- 7. Audit Log
  insert into public.audit_logs (
    user_id,
    action,
    entity,
    entity_id,
    details
  ) values (
    v_caller_id,
    'shift.opened',
    'shift',
    v_new_shift.id::text,
    pg_catalog.jsonb_build_object(
      'shift_id', v_new_shift.id,
      'cashier_id', v_target_cashier_id,
      'opened_by', v_caller_id,
      'is_opened_by_admin', (v_target_cashier_id <> v_caller_id),
      'admin_username', case when v_target_cashier_id <> v_caller_id then v_admin_username else null end,
      'opening_cash', p_opening_cash,
      'notes', v_shift_notes
    )
  );

  return pg_catalog.jsonb_build_object(
    'shift_id', v_new_shift.id,
    'cashier_id', v_new_shift.cashier_id,
    'opened_at', v_new_shift.opened_at,
    'opening_cash', v_new_shift.opening_cash,
    'expected_cash', v_new_shift.expected_cash,
    'status', v_new_shift.status,
    'notes', v_new_shift.notes
  );
end;
$$;

revoke all on function public.open_shift_atomic(integer, text, uuid) from public, anon;
grant execute on function public.open_shift_atomic(integer, text, uuid) to authenticated;
grant execute on function public.open_shift_atomic(integer, text, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 5. AKTIFKAN SUPABASE REALTIME PUBLICATION UNTUK TABEL public.shifts
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'shifts'
    ) then
      alter publication supabase_realtime add table public.shifts;
    end if;
  end if;
end $$;

commit;
