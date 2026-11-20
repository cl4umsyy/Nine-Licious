-- =============================================================================
-- NINE LICIOUS POS — MILESTONE F5.1: SHIFT & CASH MANAGEMENT MIGRATION
-- File: supabase/migrations/20261120000100_f5_shift_and_cash_management.sql
--
-- TUJUAN:
-- 1. Membuat tabel public.shifts dan public.cash_movements
-- 2. Menambahkan relasi public.payments.shift_id (FK & Index)
-- 3. Mengatur RLS policies dan security privilege untuk admin dan kasir
-- 4. Menyediakan RPC atomik:
--    - open_shift_atomic
--    - close_shift_atomic
--    - record_cash_movement_atomic
-- 5. Mengintegrasikan pembayaran tunai (process_pos_payment_manual & execute_order_payment_internal)
--    dan pengembalian dana tunai (process_order_refund_atomic) dengan pencatatan shift kasir.
-- =============================================================================

-- =============================================================================
-- 1. ENUM TYPES
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'shift_status') then
    create type public.shift_status as enum ('open', 'closed');
  end if;

  if not exists (select 1 from pg_type where typname = 'cash_movement_type') then
    create type public.cash_movement_type as enum (
      'opening_cash',
      'cash_sale',
      'cash_refund',
      'cash_in',
      'cash_out',
      'closing_reconciliation'
    );
  end if;
end $$;

-- =============================================================================
-- 2. TABEL SHIFTS
-- =============================================================================

create table if not exists public.shifts (
  id uuid primary key default gen_random_uuid(),
  cashier_id uuid not null references public.profiles(id) on delete restrict,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  opening_cash integer not null check (opening_cash >= 0),
  expected_cash integer not null default 0 check (expected_cash >= 0),
  actual_cash integer check (actual_cash is null or actual_cash >= 0),
  cash_difference integer,
  status public.shift_status not null default 'open',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint check_shift_time_validity check (closed_at is null or closed_at >= opened_at)
);

create unique index if not exists idx_shifts_single_active_cashier
  on public.shifts (cashier_id)
  where status = 'open';

create index if not exists idx_shifts_cashier_id on public.shifts (cashier_id);
create index if not exists idx_shifts_status on public.shifts (status);
create index if not exists idx_shifts_opened_at on public.shifts (opened_at desc);

drop trigger if exists shifts_set_updated_at on public.shifts;
create trigger shifts_set_updated_at
  before update on public.shifts
  for each row
  execute function public.set_updated_at();

comment on table public.shifts is
  'Sesi kerja kasir (shift) dan rekonsiliasi kas drawer fisik.';

-- =============================================================================
-- 3. TABEL CASH_MOVEMENTS
-- =============================================================================

create table if not exists public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid references public.shifts(id) on delete set null,
  movement_type public.cash_movement_type not null,
  amount integer not null check (amount >= 0),
  balance_before integer not null check (balance_before >= 0),
  balance_after integer not null check (balance_after >= 0),
  reason text not null check (btrim(reason) <> ''),
  order_id uuid references public.orders(id) on delete set null,
  payment_id uuid references public.payments(id) on delete set null,
  refund_id uuid references public.refunds(id) on delete set null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists idx_cash_movements_shift_id on public.cash_movements (shift_id);
create index if not exists idx_cash_movements_movement_type on public.cash_movements (movement_type);
create index if not exists idx_cash_movements_order_id on public.cash_movements (order_id);
create index if not exists idx_cash_movements_payment_id on public.cash_movements (payment_id);
create index if not exists idx_cash_movements_refund_id on public.cash_movements (refund_id);
create index if not exists idx_cash_movements_created_at on public.cash_movements (created_at desc);

comment on table public.cash_movements is
  'Buku besar (ledger) mutasi fisik kas drawer per shift dan pengeluaran tunai di luar shift.';

-- =============================================================================
-- 4. PERUBAHAN TABEL PAYMENTS (shift_id)
-- =============================================================================

alter table public.payments
  add column if not exists shift_id uuid references public.shifts(id) on delete set null;

create index if not exists idx_payments_shift_id on public.payments (shift_id);

comment on column public.payments.shift_id is
  'Relasi transaksi pembayaran ke shift kasir aktif.';

-- =============================================================================
-- 5. ROW LEVEL SECURITY & PERMISSIONS
-- =============================================================================

alter table public.shifts enable row level security;
alter table public.cash_movements enable row level security;

-- SHIFTS RLS
drop policy if exists shifts_select_policy on public.shifts;
create policy shifts_select_policy on public.shifts
  for select
  to authenticated
  using (
    public.is_admin()
    or cashier_id = auth.uid()
  );

-- CASH_MOVEMENTS RLS
drop policy if exists cash_movements_select_policy on public.cash_movements;
create policy cash_movements_select_policy on public.cash_movements
  for select
  to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.shifts s
      where s.id = cash_movements.shift_id
        and s.cashier_id = auth.uid()
    )
  );

-- Revoke direct mutation from clients
revoke insert, update, delete on public.shifts from public, anon, authenticated;
revoke insert, update, delete on public.cash_movements from public, anon, authenticated;

grant select on public.shifts to authenticated;
grant select on public.cash_movements to authenticated;
grant all on public.shifts to service_role;
grant all on public.cash_movements to service_role;

-- =============================================================================
-- 6. RPC ATOMIK SHIFTS: OPEN_SHIFT_ATOMIC
-- =============================================================================

create or replace function public.open_shift_atomic(
  p_opening_cash integer,
  p_notes text default null,
  p_cashier_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_id uuid;
  v_caller_profile record;
  v_target_cashier_id uuid;
  v_target_profile record;
  v_existing_shift_id uuid;
  v_new_shift record;
  v_admin_username text;
  v_shift_notes text;
begin
  -- 1. Validasi Sesi Pengguna
  v_caller_id := auth.uid();
  if v_caller_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select id, role, is_active, username, full_name
  into v_caller_profile
  from public.profiles
  where id = v_caller_id
  for share;

  if not found or not v_caller_profile.is_active then
    raise exception 'Profil pengguna tidak ditemukan atau tidak aktif.';
  end if;

  if v_caller_profile.role not in ('admin', 'kasir') then
    raise exception 'Hanya Admin dan Kasir yang dapat membuka shift.';
  end if;

  -- 2. Tentukan Kasir Target: Kasir hanya boleh membuka untuk diri sendiri
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

  if not found or not v_target_profile.is_active then
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

  -- 3. Validasi Parameter Kas Awal
  if p_opening_cash is null or p_opening_cash < 0 then
    raise exception 'Modal kas awal tidak boleh bernilai negatif.';
  end if;

  -- 4. Cegah Shift Aktif Ganda (Race condition guard via lock + unique partial index)
  select id into v_existing_shift_id
  from public.shifts
  where cashier_id = v_target_cashier_id
    and status = 'open'
  for update;

  if found then
    raise exception 'Kasir masih memiliki shift aktif yang belum ditutup (Shift ID: %). Tutup shift terlebih dahulu.', v_existing_shift_id;
  end if;

  -- 5. Insert Shift Baru
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
    now()
  ) returning * into v_new_shift;

  -- 6. Insert Cash Movement Pertama: opening_cash
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
    jsonb_build_object(
      'shift_id', v_new_shift.id,
      'cashier_id', v_target_cashier_id,
      'opened_by', v_caller_id,
      'is_opened_by_admin', (v_target_cashier_id <> v_caller_id),
      'admin_username', case when v_target_cashier_id <> v_caller_id then v_admin_username else null end,
      'opening_cash', p_opening_cash,
      'notes', v_shift_notes
    )
  );

  return jsonb_build_object(
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

-- =============================================================================
-- 7. RPC ATOMIK SHIFTS: CLOSE_SHIFT_ATOMIC
-- =============================================================================

create or replace function public.close_shift_atomic(
  p_shift_id uuid,
  p_actual_cash integer,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_id uuid;
  v_caller_profile record;
  v_shift record;
  v_total_cash_in integer := 0;
  v_total_cash_out integer := 0;
  v_total_cash_sales integer := 0;
  v_total_cash_refunds integer := 0;
  v_expected_cash integer;
  v_difference integer;
  v_closed_shift record;
begin
  -- 1. Validasi Sesi Pengguna
  v_caller_id := auth.uid();
  if v_caller_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select id, role, is_active
  into v_caller_profile
  from public.profiles
  where id = v_caller_id
  for share;

  if not found or not v_caller_profile.is_active then
    raise exception 'Profil pengguna tidak ditemukan atau tidak aktif.';
  end if;

  if v_caller_profile.role not in ('admin', 'kasir') then
    raise exception 'Hanya Admin dan Kasir yang dapat menutup shift.';
  end if;

  -- 2. Validasi Parameter Kas Fisik
  if p_actual_cash is null or p_actual_cash < 0 then
    raise exception 'Nominal kas fisik tidak boleh bernilai negatif.';
  end if;

  -- 3. Lock Shift FOR UPDATE
  select *
  into v_shift
  from public.shifts
  where id = p_shift_id
  for update;

  if not found then
    raise exception 'Shift dengan ID % tidak ditemukan.', p_shift_id;
  end if;

  if v_shift.status <> 'open' then
    raise exception 'Shift sudah ditutup sebelumnya pada %.', v_shift.closed_at;
  end if;

  -- Kasir hanya boleh menutup shift miliknya sendiri
  if v_caller_profile.role = 'kasir' and v_shift.cashier_id <> v_caller_id then
    raise exception 'Kasir tidak berhak menutup shift milik kasir lain.';
  end if;

  -- 4. Hitung Ulang Total Mutasi Kas Secara Deterministik dari Ledger cash_movements
  select
    coalesce(sum(case when movement_type = 'cash_sale' then amount else 0 end), 0),
    coalesce(sum(case when movement_type = 'cash_in' then amount else 0 end), 0),
    coalesce(sum(case when movement_type = 'cash_refund' then amount else 0 end), 0),
    coalesce(sum(case when movement_type = 'cash_out' then amount else 0 end), 0)
  into
    v_total_cash_sales,
    v_total_cash_in,
    v_total_cash_refunds,
    v_total_cash_out
  from public.cash_movements
  where shift_id = p_shift_id
    and movement_type <> 'opening_cash'
    and movement_type <> 'closing_reconciliation';

  v_expected_cash := v_shift.opening_cash + v_total_cash_sales + v_total_cash_in - (v_total_cash_refunds + v_total_cash_out);
  v_difference := p_actual_cash - v_expected_cash;

  -- 5. Update Status Shift ke Closed
  update public.shifts
  set
    status = 'closed',
    closed_at = now(),
    expected_cash = v_expected_cash,
    actual_cash = p_actual_cash,
    cash_difference = v_difference,
    notes = coalesce(nullif(btrim(p_notes), ''), v_shift.notes),
    updated_at = now()
  where id = p_shift_id
  returning * into v_closed_shift;

  -- 6. Insert Movement Rekonsiliasi
  insert into public.cash_movements (
    shift_id,
    movement_type,
    amount,
    balance_before,
    balance_after,
    reason,
    created_by
  ) values (
    p_shift_id,
    'closing_reconciliation',
    p_actual_cash,
    v_expected_cash,
    p_actual_cash,
    case
      when v_difference = 0 then 'Penutupan shift: Kas seimbang (Pas)'
      when v_difference > 0 then 'Penutupan shift: Selisih lebih (+Rp ' || v_difference::text || ')'
      else 'Penutupan shift: Selisih kurang (-Rp ' || abs(v_difference)::text || ')'
    end,
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
    'shift.closed',
    'shift',
    p_shift_id::text,
    jsonb_build_object(
      'shift_id', p_shift_id,
      'cashier_id', v_shift.cashier_id,
      'closed_by', v_caller_id,
      'opening_cash', v_shift.opening_cash,
      'total_cash_sales', v_total_cash_sales,
      'total_cash_in', v_total_cash_in,
      'total_cash_refunds', v_total_cash_refunds,
      'total_cash_out', v_total_cash_out,
      'expected_cash', v_expected_cash,
      'actual_cash', p_actual_cash,
      'cash_difference', v_difference,
      'notes', p_notes
    )
  );

  return jsonb_build_object(
    'shift_id', v_closed_shift.id,
    'cashier_id', v_closed_shift.cashier_id,
    'opened_at', v_closed_shift.opened_at,
    'closed_at', v_closed_shift.closed_at,
    'opening_cash', v_closed_shift.opening_cash,
    'total_cash_sales', v_total_cash_sales,
    'total_cash_in', v_total_cash_in,
    'total_cash_refunds', v_total_cash_refunds,
    'total_cash_out', v_total_cash_out,
    'expected_cash', v_expected_cash,
    'actual_cash', p_actual_cash,
    'cash_difference', v_difference,
    'status', v_closed_shift.status,
    'notes', v_closed_shift.notes
  );
end;
$$;

revoke all on function public.close_shift_atomic(uuid, integer, text) from public, anon;
grant execute on function public.close_shift_atomic(uuid, integer, text) to authenticated;
grant execute on function public.close_shift_atomic(uuid, integer, text) to service_role;

-- =============================================================================
-- 8. RPC ATOMIK SHIFTS: RECORD_CASH_MOVEMENT_ATOMIC
-- =============================================================================

create or replace function public.record_cash_movement_atomic(
  p_shift_id uuid,
  p_movement_type text,
  p_amount integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_id uuid;
  v_caller_profile record;
  v_shift record;
  v_clean_reason text;
  v_balance_before integer;
  v_balance_after integer;
  v_movement_id uuid;
begin
  -- 1. Validasi Sesi Pengguna
  v_caller_id := auth.uid();
  if v_caller_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select id, role, is_active
  into v_caller_profile
  from public.profiles
  where id = v_caller_id
  for share;

  if not found or not v_caller_profile.is_active then
    raise exception 'Profil pengguna tidak ditemukan atau tidak aktif.';
  end if;

  if v_caller_profile.role not in ('admin', 'kasir') then
    raise exception 'Hanya Admin dan Kasir yang dapat mencatat mutasi kas.';
  end if;

  -- 2. Validasi Parameter
  if p_amount is null or p_amount <= 0 then
    raise exception 'Nominal mutasi kas harus lebih besar dari Rp 0.';
  end if;

  v_clean_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_clean_reason) < 3 then
    raise exception 'Alasan mutasi kas wajib diisi (minimal 3 karakter).';
  end if;

  if p_movement_type not in ('cash_in', 'cash_out') then
    raise exception 'Tipe mutasi manual hanya mendukung cash_in atau cash_out.';
  end if;

  -- 3. Penanganan Mutasi dalam Shift vs di Luar Shift
  if p_shift_id is not null then
    select *
    into v_shift
    from public.shifts
    where id = p_shift_id
    for update;

    if not found then
      raise exception 'Shift dengan ID % tidak ditemukan.', p_shift_id;
    end if;

    if v_shift.status <> 'open' then
      raise exception 'Tidak dapat mencatat mutasi kas pada shift yang sudah ditutup.';
    end if;

    if v_caller_profile.role = 'kasir' and v_shift.cashier_id <> v_caller_id then
      raise exception 'Kasir tidak dapat mencatat mutasi pada shift kasir lain.';
    end if;

    v_balance_before := v_shift.expected_cash;

    if p_movement_type = 'cash_out' then
      if v_shift.expected_cash < p_amount then
        raise exception 'Saldo kas shift tidak mencukupi (Tersedia: Rp %, Diminta: Rp %).',
          v_shift.expected_cash, p_amount;
      end if;
      v_balance_after := v_balance_before - p_amount;
    else
      v_balance_after := v_balance_before + p_amount;
    end if;

    -- Update expected_cash pada shift
    update public.shifts
    set
      expected_cash = v_balance_after,
      updated_at = now()
    where id = p_shift_id;

    -- Insert ke cash_movements
    insert into public.cash_movements (
      shift_id,
      movement_type,
      amount,
      balance_before,
      balance_after,
      reason,
      created_by
    ) values (
      p_shift_id,
      p_movement_type::public.cash_movement_type,
      p_amount,
      v_balance_before,
      v_balance_after,
      v_clean_reason,
      v_caller_id
    ) returning id into v_movement_id;

  else
    -- Mutasi di luar shift: HANYA BOLEH OLEH ADMIN
    if v_caller_profile.role <> 'admin' then
      raise exception 'Hanya admin yang berhak mencatat mutasi kas di luar shift.';
    end if;

    v_balance_before := 0;
    v_balance_after := 0;

    insert into public.cash_movements (
      shift_id,
      movement_type,
      amount,
      balance_before,
      balance_after,
      reason,
      created_by
    ) values (
      null,
      p_movement_type::public.cash_movement_type,
      p_amount,
      0,
      0,
      'Mutasi kas di luar shift (Admin): ' || v_clean_reason,
      v_caller_id
    ) returning id into v_movement_id;

  end if;

  -- 4. Audit Log
  insert into public.audit_logs (
    user_id,
    action,
    entity,
    entity_id,
    details
  ) values (
    v_caller_id,
    'cash.' || p_movement_type,
    'cash_movement',
    v_movement_id::text,
    jsonb_build_object(
      'shift_id', p_shift_id,
      'is_out_of_shift', (p_shift_id is null),
      'movement_type', p_movement_type,
      'amount', p_amount,
      'reason', v_clean_reason,
      'balance_before', v_balance_before,
      'balance_after', v_balance_after,
      'created_by', v_caller_id
    )
  );

  return jsonb_build_object(
    'movement_id', v_movement_id,
    'shift_id', p_shift_id,
    'movement_type', p_movement_type,
    'amount', p_amount,
    'balance_before', v_balance_before,
    'balance_after', v_balance_after,
    'reason', v_clean_reason
  );
end;
$$;

revoke all on function public.record_cash_movement_atomic(uuid, text, integer, text) from public, anon;
grant execute on function public.record_cash_movement_atomic(uuid, text, integer, text) to authenticated;
grant execute on function public.record_cash_movement_atomic(uuid, text, integer, text) to service_role;

-- =============================================================================
-- 9. INTEGRASI PEMBAYARAN: EXECUTE_ORDER_PAYMENT_INTERNAL (OVERLOAD DENGAN SHIFT)
-- =============================================================================

create or replace function public.execute_order_payment_internal(
  p_order_id uuid,
  p_payment_method text,
  p_payment_source text,
  p_amount integer,
  p_cash_received integer,
  p_change_amount integer,
  p_reference_number text,
  p_idempotency_key text,
  p_notes text,
  p_actor_id uuid,
  p_shift_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clean_key text;
  v_clean_ref text;
  v_clean_notes text;
  v_clean_change integer;

  v_pre_order record;
  v_order record;

  v_dining_table record;
  v_dining_session record;

  v_existing_payment record;

  v_remaining integer;
  v_new_paid_total integer;

  v_is_settled boolean := false;

  v_queue_date date;
  v_queue_number text;

  v_payment_id uuid;
  v_sync_result text;

  v_shift_expected integer;
begin
  -- 1. Validasi input
  if p_order_id is null then
    raise exception 'ID pesanan wajib diisi.';
  end if;

  if p_actor_id is null then
    raise exception 'Identitas petugas pembayaran tidak valid.';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Nominal pembayaran harus lebih besar dari 0.';
  end if;

  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'Kunci idempotensi pembayaran wajib diisi.';
  end if;

  v_clean_key := btrim(p_idempotency_key);
  if length(v_clean_key) < 8 then
    raise exception 'Kunci idempotensi minimal 8 karakter.';
  end if;

  v_clean_ref := nullif(btrim(p_reference_number), '');
  v_clean_notes := nullif(btrim(p_notes), '');
  v_clean_change := coalesce(p_change_amount, 0);

  -- 2. Validasi metode dan sumber pembayaran
  if (p_payment_method = 'cash' and p_payment_source <> 'cash')
     or (
       p_payment_method = 'qris'
       and p_payment_source not in ('qris_manual', 'qris_midtrans')
     )
     or (
       p_payment_method = 'bank_transfer'
       and p_payment_source <> 'bank_transfer'
     )
     or (
       p_payment_method = 'midtrans'
       and p_payment_source <> 'midtrans_snap'
     ) then
    raise exception
      'Kombinasi metode % dan sumber pembayaran % tidak valid.',
      p_payment_method,
      p_payment_source;
  end if;

  -- 3. Validasi tunai dan non-tunai
  if p_payment_source = 'cash' then
    if p_cash_received is null or p_cash_received < p_amount then
      raise exception 'Uang tunai yang diterima kurang dari nominal pembayaran.';
    end if;

    if v_clean_change <> (p_cash_received - p_amount) then
      raise exception 'Perhitungan kembalian tunai tidak valid.';
    end if;
  else
    if p_cash_received is not null or v_clean_change <> 0 then
      raise exception 'Pembayaran non-tunai tidak boleh memiliki uang diterima atau kembalian.';
    end if;
  end if;

  -- 4. Pre-read pesanan
  select id, order_type, table_id, dining_session_id
  into v_pre_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception 'Pesanan dengan ID % tidak ditemukan.', p_order_id;
  end if;

  -- 5. Lock hierarkis: dining_tables -> dining_sessions -> orders
  if v_pre_order.order_type = 'dine_in' then
    if v_pre_order.table_id is null or v_pre_order.dining_session_id is null then
      raise exception 'Relasi meja atau sesi pesanan dine-in tidak valid.';
    end if;

    perform 1
    from public.dining_tables
    where id = v_pre_order.table_id
    for update;

    perform 1
    from public.dining_sessions
    where id = v_pre_order.dining_session_id
    for update;
  end if;

  select *
  into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  -- 6. Validasi anti-race condition relasi
  if v_order.order_type is distinct from v_pre_order.order_type
     or v_order.table_id is distinct from v_pre_order.table_id
     or v_order.dining_session_id is distinct from v_pre_order.dining_session_id then
    raise exception 'Relasi pesanan berubah saat penguncian. Silakan coba kembali.';
  end if;

  -- 7. Pemeriksaan idempotency
  select *
  into v_existing_payment
  from public.payments
  where idempotency_key = v_clean_key;

  if found then
    if v_existing_payment.order_id <> p_order_id then
      raise exception 'Idempotency key sudah digunakan untuk pesanan lain.';
    end if;

    if v_existing_payment.payment_method <> p_payment_method
       or v_existing_payment.payment_source <> p_payment_source
       or v_existing_payment.amount <> p_amount
       or coalesce(v_existing_payment.cash_received, 0) <> coalesce(p_cash_received, 0)
       or coalesce(v_existing_payment.change_amount, 0) <> v_clean_change
       or coalesce(v_existing_payment.reference_number, '') <> coalesce(v_clean_ref, '')
       or coalesce(v_existing_payment.notes, '') <> coalesce(v_clean_notes, '') then
      raise exception 'Idempotency key digunakan dengan payload berbeda.';
    end if;

    return jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'order_id', v_existing_payment.order_id,
      'order_number', v_order.order_number,
      'amount', v_existing_payment.amount,
      'cash_received', v_existing_payment.cash_received,
      'change_amount', v_existing_payment.change_amount,
      'payment_status', v_existing_payment.payment_status,
      'paid_total', coalesce(v_existing_payment.paid_total_after, v_order.paid_total),
      'grand_total', v_order.grand_total,
      'is_settled', (coalesce(v_existing_payment.paid_total_after, v_order.paid_total) = v_order.grand_total),
      'queue_number',
        case
          when coalesce(v_existing_payment.paid_total_after, v_order.paid_total) = v_order.grand_total
          then v_order.queue_number
          else null
        end,
      'queue_date',
        case
          when coalesce(v_existing_payment.paid_total_after, v_order.paid_total) = v_order.grand_total
          then v_order.queue_date
          else null
        end,
      'idempotent_replay', true
    );
  end if;

  -- 8. Validasi sesi dine-in
  if v_order.order_type = 'dine_in' then
    select * into v_dining_table
    from public.dining_tables
    where id = v_order.table_id;

    if not found or not v_dining_table.is_active then
      raise exception 'Meja pesanan tidak ditemukan atau tidak aktif.';
    end if;

    select * into v_dining_session
    from public.dining_sessions
    where id = v_order.dining_session_id;

    if not found or v_dining_session.status <> 'open' then
      raise exception 'Sesi kunjungan tidak ditemukan atau sudah tidak aktif.';
    end if;

    if v_dining_session.table_id <> v_order.table_id then
      raise exception 'Meja sesi tidak sesuai dengan meja pesanan.';
    end if;
  end if;

  -- 9. Validasi status pesanan
  if not v_order.is_finalized then
    raise exception 'Pesanan belum difinalisasi.';
  end if;

  if v_order.status not in ('awaiting_payment', 'partially_paid') then
    raise exception 'Status pesanan tidak mengizinkan pembayaran.';
  end if;

  if v_order.payment_status not in ('unpaid', 'partially_paid') then
    raise exception 'Status pembayaran tidak mengizinkan pembayaran baru.';
  end if;

  if v_order.grand_total is null or v_order.grand_total <= 0 then
    raise exception 'Total tagihan tidak valid.';
  end if;

  v_remaining := v_order.grand_total - v_order.paid_total;
  if v_remaining <= 0 then
    raise exception 'Sisa tagihan tidak valid.';
  end if;

  if p_amount > v_remaining then
    raise exception 'Nominal pembayaran melebihi sisa tagihan.';
  end if;

  -- 10. Validasi & Lock Shift jika pembayaran tunai
  if p_payment_source = 'cash' then
    if p_shift_id is null then
      raise exception 'Pembayaran tunai wajib terhubung ke shift kasir yang aktif.';
    end if;

    select expected_cash
    into v_shift_expected
    from public.shifts
    where id = p_shift_id
      and status = 'open'
    for update;

    if not found then
      raise exception 'Shift kasir aktif tidak ditemukan atau sudah ditutup.';
    end if;
  end if;

  -- 11. Hitung akumulasi pembayaran baru
  v_new_paid_total := v_order.paid_total + p_amount;
  v_is_settled := (v_new_paid_total = v_order.grand_total);

  -- 12. Insert pembayaran ke public.payments
  begin
    insert into public.payments (
      order_id,
      payment_method,
      payment_source,
      amount,
      cash_received,
      change_amount,
      reference_number,
      payment_status,
      idempotency_key,
      notes,
      paid_total_after,
      created_by,
      shift_id
    )
    values (
      p_order_id,
      p_payment_method,
      p_payment_source,
      p_amount,
      p_cash_received,
      v_clean_change,
      v_clean_ref,
      'success',
      v_clean_key,
      v_clean_notes,
      v_new_paid_total,
      p_actor_id,
      p_shift_id
    )
    returning id into v_payment_id;

  exception
    when unique_violation then
      select *
      into v_existing_payment
      from public.payments
      where idempotency_key = v_clean_key;

      if found then
        if v_existing_payment.order_id <> p_order_id then
          raise exception 'Idempotency key sudah digunakan untuk pesanan lain.';
        end if;
        raise exception 'Idempotency key sedang diproses transaksi lain.';
      end if;
      raise;
  end;

  -- 13. Jika pembayaran tunai: Update expected_cash shift dan catat di cash_movements
  if p_payment_source = 'cash' then
    update public.shifts
    set
      expected_cash = expected_cash + p_amount,
      updated_at = now()
    where id = p_shift_id;

    insert into public.cash_movements (
      shift_id,
      movement_type,
      amount,
      balance_before,
      balance_after,
      reason,
      order_id,
      payment_id,
      created_by
    ) values (
      p_shift_id,
      'cash_sale',
      p_amount,
      v_shift_expected,
      v_shift_expected + p_amount,
      'Penjualan tunai pesanan ' || v_order.order_number,
      p_order_id,
      v_payment_id,
      p_actor_id
    );

    insert into public.audit_logs (
      user_id,
      action,
      entity,
      entity_id,
      details
    ) values (
      p_actor_id,
      'cash.sale',
      'shift',
      p_shift_id::text,
      jsonb_build_object(
        'order_id', p_order_id,
        'order_number', v_order.order_number,
        'payment_id', v_payment_id,
        'amount', p_amount,
        'shift_id', p_shift_id
      )
    );
  end if;

  -- 14. Update status pesanan dan antrean
  if v_is_settled then
    v_queue_date := (now() at time zone 'Asia/Jakarta')::date;
    v_queue_number := public.generate_queue_number(v_queue_date);

    update public.orders
    set
      paid_total = v_new_paid_total,
      status = 'paid',
      payment_status = 'paid',
      kds_status = 'queued',
      paid_at = now(),
      queue_date = v_queue_date,
      queue_number = v_queue_number,
      updated_at = now()
    where id = p_order_id;

    if v_order.order_type = 'dine_in' then
      select public.sync_dining_table_status_internal(
        v_order.table_id,
        v_order.dining_session_id,
        p_actor_id
      ) into v_sync_result;
    end if;

  else
    update public.orders
    set
      paid_total = v_new_paid_total,
      status = 'partially_paid',
      payment_status = 'partially_paid',
      updated_at = now()
    where id = p_order_id;
  end if;

  -- 15. Audit log pembayaran
  insert into public.audit_logs (
    user_id,
    action,
    entity,
    entity_id,
    details
  )
  values (
    p_actor_id,
    case when v_is_settled then 'payment.settled' else 'payment.partial' end,
    'payments',
    v_payment_id::text,
    jsonb_build_object(
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'payment_method', p_payment_method,
      'payment_source', p_payment_source,
      'amount', p_amount,
      'cash_received', p_cash_received,
      'change_amount', v_clean_change,
      'paid_total', v_new_paid_total,
      'grand_total', v_order.grand_total,
      'is_settled', v_is_settled,
      'queue_number', v_queue_number,
      'shift_id', p_shift_id
    )
  );

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'amount', p_amount,
    'cash_received', p_cash_received,
    'change_amount', v_clean_change,
    'payment_status', 'success',
    'paid_total', v_new_paid_total,
    'grand_total', v_order.grand_total,
    'is_settled', v_is_settled,
    'queue_number', v_queue_number,
    'queue_date', v_queue_date,
    'shift_id', p_shift_id,
    'idempotent_replay', false
  );
end;
$$;

-- Overload 10-argumen untuk backward-compatibility penuh dengan Midtrans webhook dan caller legacy
create or replace function public.execute_order_payment_internal(
  p_order_id uuid,
  p_payment_method text,
  p_payment_source text,
  p_amount integer,
  p_cash_received integer,
  p_change_amount integer,
  p_reference_number text,
  p_idempotency_key text,
  p_notes text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.execute_order_payment_internal(
    p_order_id,
    p_payment_method,
    p_payment_source,
    p_amount,
    p_cash_received,
    p_change_amount,
    p_reference_number,
    p_idempotency_key,
    p_notes,
    p_actor_id,
    null
  );
end;
$$;

revoke all on function public.execute_order_payment_internal(uuid, text, text, integer, integer, integer, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.execute_order_payment_internal(uuid, text, text, integer, integer, integer, text, text, text, uuid, uuid) to service_role;

revoke all on function public.execute_order_payment_internal(uuid, text, text, integer, integer, integer, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.execute_order_payment_internal(uuid, text, text, integer, integer, integer, text, text, text, uuid) to service_role;

-- =============================================================================
-- 10. REPLACEMENT RPC: PROCESS_POS_PAYMENT_MANUAL (DENGAN SHIFT GUARD & AUDIT)
-- =============================================================================

create or replace function public.process_pos_payment_manual(
  p_order_id uuid,
  p_payment_method text,
  p_payment_source text,
  p_amount integer,
  p_cash_received integer,
  p_change_amount integer,
  p_reference_number text,
  p_idempotency_key text,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_actor_profile record;
  v_clean_key text;
  v_existing_payment record;
  v_pre_order record;
  v_order record;
  v_dining_table record;
  v_dining_session record;
  v_reserved_amount integer;
  v_available_amount integer;
  v_shift_id uuid := null;
  v_active_shift record;
begin
  v_actor_id := auth.uid();

  if v_actor_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select role, is_active
  into v_actor_profile
  from public.profiles
  where id = v_actor_id
  for share;

  if not found or not v_actor_profile.is_active then
    raise exception 'Profil pengguna tidak ditemukan atau tidak aktif.';
  end if;

  if v_actor_profile.role not in ('admin', 'kasir')
     or public.current_user_role() not in ('admin', 'kasir') then
    raise exception 'Hanya Admin dan Kasir yang dapat memproses pembayaran.';
  end if;

  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'Idempotency key wajib diisi.';
  end if;

  v_clean_key := btrim(p_idempotency_key);

  if p_payment_source not in ('cash', 'qris_manual', 'bank_transfer') then
    raise exception 'Sumber pembayaran tidak didukung oleh RPC manual.';
  end if;

  -- 1. Pre-read relasi pesanan
  select id, order_type, table_id, dining_session_id
  into v_pre_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception 'Pesanan dengan ID % tidak ditemukan.', p_order_id;
  end if;

  -- 2. Kunci hierarkis FOR UPDATE (dining_tables -> dining_sessions -> orders)
  if v_pre_order.order_type = 'dine_in' then
    if v_pre_order.table_id is null or v_pre_order.dining_session_id is null then
      raise exception 'Relasi meja atau sesi pesanan dine-in tidak valid.';
    end if;

    perform 1
    from public.dining_tables
    where id = v_pre_order.table_id
    for update;

    perform 1
    from public.dining_sessions
    where id = v_pre_order.dining_session_id
    for update;
  end if;

  select *
  into v_order
  from public.orders
  where id = p_order_id
  for update;

  -- 3. Validasi ulang relasi meja dan sesi setelah lock diperoleh
  if v_order.order_type = 'dine_in' then
    select * into v_dining_table
    from public.dining_tables
    where id = v_order.table_id;

    if not found or not v_dining_table.is_active then
      raise exception 'Meja pesanan tidak ditemukan atau tidak aktif.';
    end if;

    select * into v_dining_session
    from public.dining_sessions
    where id = v_order.dining_session_id;

    if not found or v_dining_session.status <> 'open' then
      raise exception 'Sesi kunjungan tidak ditemukan atau sudah tidak aktif.';
    end if;

    if v_dining_session.table_id <> v_order.table_id then
      raise exception 'Meja sesi tidak sesuai dengan meja pesanan.';
    end if;
  end if;

  -- 4. Pemeriksaan idempotency sebelum validasi shift & saldo reservasi
  select *
  into v_existing_payment
  from public.payments
  where idempotency_key = v_clean_key;

  if found then
    return public.execute_order_payment_internal(
      p_order_id,
      p_payment_method,
      p_payment_source,
      p_amount,
      p_cash_received,
      p_change_amount,
      p_reference_number,
      v_clean_key,
      p_notes,
      v_actor_id,
      v_existing_payment.shift_id
    );
  end if;

  -- 5. Validasi Shift Kasir Aktif
  if p_payment_source = 'cash' or p_payment_method = 'cash' then
    select id, expected_cash
    into v_active_shift
    from public.shifts
    where cashier_id = v_actor_id
      and status = 'open'
    for update;

    if not found then
      raise exception 'Kasir belum membuka shift kasir. Buka shift terlebih dahulu sebelum memproses pembayaran tunai.';
    end if;

    v_shift_id := v_active_shift.id;
  else
    -- Non-tunai manual (QRIS Manual, Bank Transfer): Hubungkan ke shift aktif jika ada, tapi tidak memotong laci
    select id
    into v_shift_id
    from public.shifts
    where cashier_id = v_actor_id
      and status = 'open';
  end if;

  -- 6. Evaluasi ketersediaan saldo reservasi gateway
  v_reserved_amount := public.calculate_active_gateway_reserved_amount(p_order_id);
  v_available_amount := v_order.grand_total - v_order.paid_total - v_reserved_amount;

  if p_amount > v_available_amount then
    raise exception
      'PAYMENT_EXCEEDS_AVAILABLE_AMOUNT: Nominal pembayaran (Rp %) melebihi sisa tagihan yang belum direservasi gateway (Tersedia: Rp %, Direservasi: Rp %).',
      p_amount,
      v_available_amount,
      v_reserved_amount;
  end if;

  -- 7. Teruskan ke mesin pembayaran internal F2/F5
  return public.execute_order_payment_internal(
    p_order_id,
    p_payment_method,
    p_payment_source,
    p_amount,
    p_cash_received,
    p_change_amount,
    p_reference_number,
    v_clean_key,
    p_notes,
    v_actor_id,
    v_shift_id
  );

end;
$$;

revoke all on function public.process_pos_payment_manual(uuid, text, text, integer, integer, integer, text, text, text) from public, anon, service_role;
grant execute on function public.process_pos_payment_manual(uuid, text, text, integer, integer, integer, text, text, text) to authenticated;

-- =============================================================================
-- 11. REPLACEMENT RPC: PROCESS_ORDER_REFUND_ATOMIC (DENGAN INTEGRASI SHIFT KAS)
-- =============================================================================

drop function if exists public.process_order_refund_atomic(uuid, integer, text, text, text, uuid, text);

create or replace function public.process_order_refund_atomic(
  p_order_id uuid,
  p_amount integer,
  p_refund_type text,
  p_refund_method text,
  p_reason text,
  p_payment_id uuid default null,
  p_idempotency_key text default null,
  p_shift_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_pre_order record;
  v_order record;
  v_payment record;
  v_existing_refund record;
  v_pending_refund_total integer := 0;
  v_committed_refund_total integer := 0;
  v_available_refundable integer := 0;
  v_payment_refunded_so_far integer := 0;
  v_payment_remaining integer := 0;
  v_payment_completed_after integer := 0;
  v_is_full_refund boolean := false;
  v_new_refunded_total integer;
  v_new_order_status text;
  v_new_payment_status text;
  v_kds_status_after text;
  v_kitchen_notified_at timestamptz := null;
  v_refund_number text;
  v_refund_id uuid;
  v_shift record;
  v_target_shift_id uuid := null;
  v_balance_before integer := 0;
  v_balance_after integer := 0;
begin
  -- 1. Validasi Otorisasi Staf: Wajib Admin Aktif dengan Proteksi 3VL
  v_user_id := auth.uid();
  v_user_role := public.current_user_role();

  if v_user_id is null or coalesce(v_user_role, '') <> 'admin' then
    raise exception 'Hanya admin yang berhak memproses pengembalian dana (refund).';
  end if;

  -- 2. Validasi Parameter Input
  if p_order_id is null then
    raise exception 'ID pesanan wajib diisi.';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Nominal refund harus lebih dari Rp 0.';
  end if;

  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'Alasan refund wajib diisi (minimal 3 karakter).';
  end if;

  if p_refund_type not in ('full', 'partial') then
    raise exception 'Tipe refund tidak valid: % (harus full atau partial).', p_refund_type;
  end if;

  if p_refund_method not in ('cash', 'transfer', 'midtrans', 'manual') then
    raise exception 'Metode refund tidak valid: %.', p_refund_method;
  end if;

  if p_idempotency_key is null or char_length(btrim(p_idempotency_key)) = 0 then
    raise exception 'Kunci idempotensi (idempotency key) wajib disertakan pada setiap mutasi refund.';
  end if;

  -- 3. Idempotency Check Awal (Pre-lock)
  select * into v_existing_refund
  from public.refunds
  where idempotency_key = btrim(p_idempotency_key);

  if found then
    if v_existing_refund.order_id <> p_order_id
       or coalesce(v_existing_refund.payment_id, '00000000-0000-0000-0000-000000000000'::uuid) <> coalesce(p_payment_id, '00000000-0000-0000-0000-000000000000'::uuid)
       or v_existing_refund.amount <> p_amount
       or v_existing_refund.refund_type <> p_refund_type
       or v_existing_refund.refund_method <> p_refund_method
       or btrim(v_existing_refund.reason) <> btrim(p_reason)
    then
      raise exception 'Konflik Idempotensi: Kunci "%" telah digunakan sebelumnya dengan rincian data refund yang berbeda.',
        btrim(p_idempotency_key);
    end if;

    return jsonb_build_object(
      'refund_id', v_existing_refund.id,
      'refund_number', v_existing_refund.refund_number,
      'order_id', v_existing_refund.order_id,
      'payment_id', v_existing_refund.payment_id,
      'amount', v_existing_refund.amount,
      'refund_type', v_existing_refund.refund_type,
      'refund_method', v_existing_refund.refund_method,
      'status', v_existing_refund.status,
      'is_duplicate', true,
      'message', 'Permintaan refund telah diproses sebelumnya (idempotent replay).'
    );
  end if;

  -- 4. Pre-read Relasi Pesanan
  select id, order_number, order_type, table_id, dining_session_id, status, payment_status, kds_status, paid_total, refunded_total
  into v_pre_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  -- 5. Hierarchical Locking Anti-Deadlock
  if v_pre_order.order_type = 'dine_in' and v_pre_order.table_id is not null then
    perform 1 from public.dining_tables where id = v_pre_order.table_id for update;
  end if;

  if v_pre_order.order_type = 'dine_in' and v_pre_order.dining_session_id is not null then
    perform 1 from public.dining_sessions where id = v_pre_order.dining_session_id for update;
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  -- Re-check idempotency setelah lock orders diperoleh
  select * into v_existing_refund
  from public.refunds
  where idempotency_key = btrim(p_idempotency_key);

  if found then
    if v_existing_refund.order_id <> p_order_id
       or coalesce(v_existing_refund.payment_id, '00000000-0000-0000-0000-000000000000'::uuid) <> coalesce(p_payment_id, '00000000-0000-0000-0000-000000000000'::uuid)
       or v_existing_refund.amount <> p_amount
       or v_existing_refund.refund_type <> p_refund_type
       or v_existing_refund.refund_method <> p_refund_method
       or btrim(v_existing_refund.reason) <> btrim(p_reason)
    then
      raise exception 'Konflik Idempotensi: Kunci "%" telah digunakan sebelumnya dengan rincian data refund yang berbeda.',
        btrim(p_idempotency_key);
    end if;

    return jsonb_build_object(
      'refund_id', v_existing_refund.id,
      'refund_number', v_existing_refund.refund_number,
      'order_id', v_existing_refund.order_id,
      'payment_id', v_existing_refund.payment_id,
      'amount', v_existing_refund.amount,
      'refund_type', v_existing_refund.refund_type,
      'refund_method', v_existing_refund.refund_method,
      'status', v_existing_refund.status,
      'is_duplicate', true,
      'message', 'Permintaan refund telah diproses sebelumnya (idempotent replay).'
    );
  end if;

  perform 1 from public.order_allocations where order_id = p_order_id order by id asc for update;
  perform 1 from public.midtrans_transactions where order_id = p_order_id order by id asc for update;
  perform 1 from public.payments where order_id = p_order_id order by id asc for update;

  -- 6. Validasi Status Pesanan & Sisa Dana Refundable
  if v_order.status = 'cancelled' then
    raise exception 'Pesanan sudah dibatalkan dan tidak dapat direfund.';
  end if;

  if v_order.status = 'refunded' then
    raise exception 'Pesanan sudah direfund penuh sebelumnya.';
  end if;

  if coalesce(v_order.paid_total, 0) <= 0 then
    raise exception 'Pesanan belum memiliki riwayat pembayaran yang berhasil (paid_total = Rp 0).';
  end if;

  v_committed_refund_total := coalesce(v_order.refunded_total, 0);

  select coalesce(sum(amount), 0) into v_pending_refund_total
  from public.refunds
  where order_id = p_order_id
    and status = 'pending';

  v_available_refundable := coalesce(v_order.paid_total, 0) - (v_committed_refund_total + v_pending_refund_total);

  if v_available_refundable <= 0 then
    if v_pending_refund_total > 0 then
      raise exception 'Pesanan tidak memiliki saldo pembayaran yang dapat dikembalikan. Seluruh saldo sisa (Rp %) sedang dicadangkan oleh permintaan refund pending.',
        v_pending_refund_total;
    else
      raise exception 'Pesanan tidak memiliki saldo pembayaran yang dapat dikembalikan.';
    end if;
  end if;

  if p_amount > v_available_refundable then
    raise exception 'Nominal refund (Rp %) melebihi sisa dana yang dapat dikembalikan (Rp %). Pembayaran: Rp %, Sukses Refund: Rp %, Pending Refund: Rp %.',
      p_amount, v_available_refundable, v_order.paid_total, v_committed_refund_total, v_pending_refund_total;
  end if;

  if p_payment_id is not null then
    select * into v_payment
    from public.payments
    where id = p_payment_id and order_id = p_order_id;

    if not found then
      raise exception 'Baris pembayaran spesifik tidak ditemukan pada pesanan ini.';
    end if;

    if v_payment.payment_status <> 'success' then
      raise exception 'Hanya baris pembayaran berstatus success yang dapat direfund.';
    end if;

    select coalesce(sum(amount), 0) into v_payment_refunded_so_far
    from public.refunds
    where payment_id = p_payment_id
      and status in ('completed', 'pending');

    v_payment_remaining := v_payment.amount - v_payment_refunded_so_far;

    if v_payment_remaining <= 0 then
      raise exception 'Baris pembayaran ini sudah tidak memiliki saldo refundable (seluruh dana Rp % telah direfund atau berstatus pending).',
        v_payment.amount;
    end if;

    if p_amount > v_payment_remaining then
      raise exception 'Nominal refund (Rp %) melebihi sisa dana pada baris pembayaran ini (Rp %). Sebelumnya telah direfund/pending: Rp % dari total Rp %.',
        p_amount, v_payment_remaining, v_payment_refunded_so_far, v_payment.amount;
    end if;
  end if;

  if p_amount = v_available_refundable and v_pending_refund_total = 0 then
    v_is_full_refund := true;
  else
    v_is_full_refund := false;
  end if;

  if p_refund_type = 'full' and not v_is_full_refund then
    raise exception 'Tipe refund full dipilih tetapi nominal (Rp %) tidak mencakup seluruh sisa dana (Rp %).',
      p_amount, v_available_refundable;
  end if;

  if p_refund_type = 'partial' and v_is_full_refund then
    raise exception 'Nominal mencakup seluruh sisa dana; gunakan tipe refund full.';
  end if;

  -- 7. PENANGANAN METODE MIDTRANS: Selalu Pending dari Sisi POS
  if p_refund_method = 'midtrans' then
    v_refund_number := public.generate_refund_number();

    insert into public.refunds (
      order_id,
      payment_id,
      refund_number,
      refund_type,
      refund_method,
      amount,
      reason,
      status,
      requested_by,
      approved_by,
      approved_at,
      kitchen_notified_at,
      idempotency_key,
      metadata
    ) values (
      p_order_id,
      p_payment_id,
      v_refund_number,
      p_refund_type,
      p_refund_method,
      p_amount,
      btrim(p_reason),
      'pending',
      v_user_id,
      null,
      null,
      null,
      btrim(p_idempotency_key),
      jsonb_build_object(
        'previous_order_status', v_order.status,
        'previous_payment_status', v_order.payment_status,
        'previous_kds_status', v_order.kds_status,
        'is_full_refund', v_is_full_refund,
        'requested_by_role', v_user_role,
        'verification_mode', 'server_side_midtrans'
      )
    ) returning id into v_refund_id;

    insert into public.audit_logs (
      action,
      user_id,
      entity,
      entity_id,
      details
    ) values (
      'order.refund_requested',
      v_user_id,
      'order',
      p_order_id::text,
      jsonb_build_object(
        'refund_id', v_refund_id,
        'refund_number', v_refund_number,
        'refund_type', p_refund_type,
        'refund_method', p_refund_method,
        'amount', p_amount,
        'reason', btrim(p_reason),
        'status', 'pending',
        'gateway_verification_required', true
      )
    );

    return jsonb_build_object(
      'refund_id', v_refund_id,
      'refund_number', v_refund_number,
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'payment_id', p_payment_id,
      'amount', p_amount,
      'refund_type', p_refund_type,
      'refund_method', p_refund_method,
      'status', 'pending',
      'is_duplicate', false,
      'message', 'Permintaan refund Midtrans dicatat sebagai pending. Memerlukan verifikasi server-side sebelum dana dieksekusi.'
    );
  end if;

  -- 8. PENANGANAN METODE NON-MIDTRANS (Cash, Transfer, Manual): Eksekusi Langsung
  if v_is_full_refund then
    if v_order.status in ('paid', 'completed') then
      v_new_order_status := 'refunded';
      v_new_payment_status := 'refunded';
    elsif v_order.status in ('awaiting_payment', 'partially_paid') then
      v_new_order_status := 'cancelled';
      v_new_payment_status := 'refunded';
    else
      v_new_order_status := 'refunded';
      v_new_payment_status := 'refunded';
    end if;

    if v_order.kds_status in ('queued', 'preparing', 'ready') then
      v_kds_status_after := null;
      v_kitchen_notified_at := now();
    else
      v_kds_status_after := null;
      v_kitchen_notified_at := null;
    end if;

    update public.payments
    set payment_status = 'refunded',
        updated_at = now()
    where order_id = p_order_id
      and payment_status = 'success';

  else
    v_new_order_status := v_order.status;
    v_new_payment_status := 'partially_refunded';
    v_kds_status_after := v_order.kds_status;
    v_kitchen_notified_at := null;

    if p_payment_id is not null then
      select coalesce(sum(amount), 0) into v_payment_completed_after
      from public.refunds
      where payment_id = p_payment_id
        and status = 'completed';

      v_payment_completed_after := v_payment_completed_after + p_amount;

      if v_payment_completed_after >= v_payment.amount then
        update public.payments
        set payment_status = 'refunded',
            updated_at = now()
        where id = p_payment_id;
      end if;
    end if;
  end if;

  -- 9. Persiapan Data Refund
  v_new_refunded_total := v_committed_refund_total + p_amount;
  v_refund_id := gen_random_uuid();
  v_refund_number := public.generate_refund_number();

  -- 10. Integrasi Mutasi Kas Shift F5
  if p_refund_method = 'cash' then
    if p_shift_id is not null then
      -- 1. Drawer / Shift kasir spesifik ditentukan oleh Admin
      select id, expected_cash, status, cashier_id
      into v_shift
      from public.shifts
      where id = p_shift_id
      for update;

      if not found then
        raise exception 'Shift kasir dengan ID % tidak ditemukan.', p_shift_id;
      end if;

      if v_shift.status <> 'open' then
        raise exception 'Shift kasir % sudah ditutup. Tidak dapat mengeluarkan refund dari shift tertutup.', p_shift_id;
      end if;

      if v_shift.expected_cash < p_amount then
        raise exception 'Saldo kas shift tidak mencukupi untuk refund tunai (Tersedia: Rp %, Diminta: Rp %).',
          v_shift.expected_cash, p_amount;
      end if;

      v_target_shift_id := v_shift.id;
      v_balance_before := v_shift.expected_cash;
      v_balance_after := v_balance_before - p_amount;

      update public.shifts
      set
        expected_cash = v_balance_after,
        updated_at = now()
      where id = v_target_shift_id;

    else
      -- 2. p_shift_id null: Cek apakah Admin yang memproses memiliki shift aktif sendiri
      select id, expected_cash, status
      into v_shift
      from public.shifts
      where cashier_id = v_user_id
        and status = 'open'
      for update;

      if found then
        if v_shift.expected_cash < p_amount then
          raise exception 'Saldo kas shift tidak mencukupi untuk refund tunai (Tersedia: Rp %, Diminta: Rp %).',
            v_shift.expected_cash, p_amount;
        end if;

        v_target_shift_id := v_shift.id;
        v_balance_before := v_shift.expected_cash;
        v_balance_after := v_balance_before - p_amount;

        update public.shifts
        set
          expected_cash = v_balance_after,
          updated_at = now()
        where id = v_target_shift_id;

      else
        -- 3. Admin tidak memiliki shift aktif dan tidak memilih shift spesifik:
        -- Dicatat sebagai refund tunai di luar shift (shift_id = null)
        v_target_shift_id := null;
        v_balance_before := 0;
        v_balance_after := 0;
      end if;
    end if;
  end if;

  -- 11. Catat Transaksi Refund (Refunds Inserted Sebelum Ledger untuk Keabsahan Foreign Key)
  insert into public.refunds (
    id,
    order_id,
    payment_id,
    refund_number,
    refund_type,
    refund_method,
    amount,
    reason,
    status,
    requested_by,
    approved_by,
    approved_at,
    kitchen_notified_at,
    idempotency_key,
    metadata
  ) values (
    v_refund_id,
    p_order_id,
    p_payment_id,
    v_refund_number,
    p_refund_type,
    p_refund_method,
    p_amount,
    btrim(p_reason),
    'completed',
    v_user_id,
    v_user_id,
    now(),
    v_kitchen_notified_at,
    btrim(p_idempotency_key),
    jsonb_build_object(
      'shift_id', v_target_shift_id,
      'is_out_of_shift', (v_target_shift_id is null),
      'previous_order_status', v_order.status,
      'previous_payment_status', v_order.payment_status,
      'previous_kds_status', v_order.kds_status,
      'is_full_refund', v_is_full_refund,
      'refunded_by_role', v_user_role
    )
  );

  -- 12. Catat Mutasi Kas ke Ledger Cash Movements (refund_id terisi valid)
  if p_refund_method = 'cash' then
    insert into public.cash_movements (
      shift_id,
      movement_type,
      amount,
      balance_before,
      balance_after,
      reason,
      order_id,
      payment_id,
      refund_id,
      created_by
    ) values (
      v_target_shift_id,
      'cash_refund',
      p_amount,
      v_balance_before,
      v_balance_after,
      case
        when v_target_shift_id is not null then
          'Refund tunai pesanan ' || v_order.order_number || ': ' || btrim(p_reason)
        else
          'Refund tunai di luar shift (Admin): ' || btrim(p_reason)
      end,
      p_order_id,
      p_payment_id,
      v_refund_id,
      v_user_id
    );
  end if;

  update public.orders
  set
    refunded_total = v_new_refunded_total,
    status = v_new_order_status,
    payment_status = v_new_payment_status,
    kds_status = v_kds_status_after,
    cancelled_by = case when v_is_full_refund then v_user_id else cancelled_by end,
    cancelled_at = case when v_is_full_refund then now() else cancelled_at end,
    cancel_reason = case when v_is_full_refund then btrim(p_reason) else cancel_reason end,
    updated_at = now()
  where id = p_order_id;

  if v_order.order_type = 'dine_in' and v_order.table_id is not null and v_order.dining_session_id is not null then
    perform public.sync_dining_table_status_internal(v_order.table_id, v_order.dining_session_id, v_user_id);
  end if;

  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'order.refunded',
    v_user_id,
    'order',
    p_order_id::text,
    jsonb_build_object(
      'refund_id', v_refund_id,
      'refund_number', v_refund_number,
      'refund_type', p_refund_type,
      'refund_method', p_refund_method,
      'amount', p_amount,
      'reason', btrim(p_reason),
      'shift_id', v_target_shift_id,
      'is_out_of_shift', (v_target_shift_id is null),
      'previous_order_status', v_order.status,
      'new_order_status', v_new_order_status,
      'new_payment_status', v_new_payment_status,
      'is_full_refund', v_is_full_refund,
      'kitchen_notified', (v_kitchen_notified_at is not null)
    )
  );

  return jsonb_build_object(
    'refund_id', v_refund_id,
    'refund_number', v_refund_number,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'payment_id', p_payment_id,
    'amount', p_amount,
    'refund_type', p_refund_type,
    'refund_method', p_refund_method,
    'status', 'completed',
    'new_order_status', v_new_order_status,
    'new_payment_status', v_new_payment_status,
    'refunded_total', v_new_refunded_total,
    'shift_id', v_target_shift_id,
    'kitchen_notified', (v_kitchen_notified_at is not null),
    'is_duplicate', false
  );
end;
$$;

revoke all on function public.process_order_refund_atomic(uuid, integer, text, text, text, uuid, text, uuid) from public, anon;
grant execute on function public.process_order_refund_atomic(uuid, integer, text, text, text, uuid, text, uuid) to authenticated;
grant execute on function public.process_order_refund_atomic(uuid, integer, text, text, text, uuid, text, uuid) to service_role;
