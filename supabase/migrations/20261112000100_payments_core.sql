-- =============================================================================
-- Nine Licious POS
-- Migration F2.1: Payments Core, Queue Number & Atomic Engine
-- File: 20261112000100_payments_core.sql
--
-- Ruang Lingkup:
-- 1. Queue number dan queue date
-- 2. Generator antrean harian atomik
-- 3. Tabel payments dan idempotency
-- 4. Helper sinkronisasi meja dan sesi
-- 5. Locking hierarchy
-- 6. Mesin pembayaran internal
-- 7. RPC pembayaran manual
-- 8. Pembatalan pesanan dengan locking aman
--
-- Prasyarat:
-- F0, F1.1, F1.2, F1.3, dan F1.4 sudah diterapkan.
--
-- Migration ini belum dijalankan ke database Supabase.
-- =============================================================================

begin;

-- =============================================================================
-- 1. QUEUE NUMBER
-- =============================================================================

alter table public.orders
  add column if not exists queue_number text,
  add column if not exists queue_date date;

comment on column public.orders.queue_number is
  'Nomor antrean harian pelanggan. Contoh A001. Dibuat saat pesanan lunas.';

comment on column public.orders.queue_date is
  'Tanggal antrean berdasarkan zona waktu Asia/Jakarta.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_queue_number_date_sync_check'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_queue_number_date_sync_check
      check (
        (queue_number is null and queue_date is null)
        or
        (queue_number is not null and queue_date is not null)
      );
  end if;
end;
$$;

create unique index if not exists orders_daily_queue_number_idx
  on public.orders (queue_date, queue_number)
  where queue_number is not null
    and queue_date is not null;

create index if not exists orders_queue_lookup_idx
  on public.orders (queue_date, queue_number, status);


-- =============================================================================
-- 2. GENERATOR NOMOR ANTREAN
-- =============================================================================

create or replace function public.generate_queue_number(
  p_date date
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seq integer;
begin
  if p_date is null then
    p_date := (now() at time zone 'Asia/Jakarta')::date;
  end if;

  insert into public.daily_sequences (
    sequence_date,
    sequence_name,
    last_value
  )
  values (
    p_date,
    'queue',
    1
  )
  on conflict (sequence_date, sequence_name)
  do update
  set
    last_value = public.daily_sequences.last_value + 1,
    updated_at = now()
  returning last_value into v_seq;

  if v_seq > 999 then
    return 'A' || v_seq::text;
  end if;

  return 'A' || lpad(v_seq::text, 3, '0');
end;
$$;

revoke all
  on function public.generate_queue_number(date)
  from public, anon, authenticated, service_role;

comment on function public.generate_queue_number(date) is
  'Generator nomor antrean harian atomik menggunakan daily_sequences.';


-- =============================================================================
-- 3. PAYMENTS TABLE
-- =============================================================================

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),

  order_id uuid not null
    references public.orders (id)
    on delete restrict,

  payment_method text not null,
  payment_source text not null,

  amount integer not null,

  cash_received integer,
  change_amount integer not null default 0,

  reference_number text,

  payment_status text not null default 'success',

  idempotency_key text not null,

  notes text,

  paid_total_after integer
    check (
      paid_total_after is null
      or paid_total_after > 0
    ),

  created_by uuid
    references public.profiles (id)
    on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payments_idempotency_key_not_empty_check
    check (btrim(idempotency_key) <> ''),

  constraint payments_payment_method_check
    check (
      payment_method in (
        'cash',
        'qris',
        'bank_transfer',
        'midtrans'
      )
    ),

  constraint payments_payment_source_check
    check (
      payment_source in (
        'cash',
        'qris_manual',
        'qris_midtrans',
        'bank_transfer',
        'midtrans_snap'
      )
    ),

  constraint payments_method_source_match_check
    check (
      (payment_method = 'cash' and payment_source = 'cash')
      or (
        payment_method = 'qris'
        and payment_source in ('qris_manual', 'qris_midtrans')
      )
      or (
        payment_method = 'bank_transfer'
        and payment_source = 'bank_transfer'
      )
      or (
        payment_method = 'midtrans'
        and payment_source = 'midtrans_snap'
      )
    ),

  constraint payments_status_check
    check (
      payment_status in (
        'pending',
        'success',
        'failed',
        'refunded'
      )
    ),

  constraint payments_amount_positive_check
    check (
      amount > 0
      and change_amount >= 0
    ),

  constraint payments_cash_integrity_check
    check (
      (
        payment_source = 'cash'
        and cash_received is not null
        and cash_received >= amount
        and change_amount = (cash_received - amount)
      )
      or (
        payment_source <> 'cash'
        and cash_received is null
        and change_amount = 0
      )
    )
);

alter table public.payments
  add column if not exists paid_total_after integer
  check (
    paid_total_after is null
    or paid_total_after > 0
  );

comment on column public.payments.paid_total_after is
  'Snapshot akumulasi pembayaran setelah transaksi berhasil diproses.';

create index if not exists payments_order_id_idx
  on public.payments (order_id);

create index if not exists payments_created_at_idx
  on public.payments (created_at);

create index if not exists payments_status_idx
  on public.payments (payment_status);

create unique index if not exists payments_idempotency_key_idx
  on public.payments (idempotency_key);

drop trigger if exists payments_set_updated_at
  on public.payments;

create trigger payments_set_updated_at
  before update on public.payments
  for each row
  execute function public.set_updated_at();

comment on table public.payments is
  'Riwayat transaksi pembayaran per pesanan. Mendukung split bill dan audit.';


-- =============================================================================
-- 4. RLS DAN GRANTS PAYMENTS
-- =============================================================================

alter table public.payments enable row level security;

drop policy if exists payments_select_staff
  on public.payments;

create policy payments_select_staff
  on public.payments
  for select
  to authenticated
  using (
    public.current_user_role() in ('admin', 'kasir')
  );

revoke all
  on public.payments
  from anon;

revoke insert, update, delete
  on public.payments
  from authenticated;

grant select
  on public.payments
  to authenticated;

grant all
  on public.payments
  to service_role;


-- =============================================================================
-- 5. HELPER SINKRONISASI MEJA DAN SESI
-- =============================================================================

create or replace function public.sync_dining_table_status_internal(
  p_table_id uuid,
  p_session_id uuid,
  p_actor_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table record;
  v_session record;

  v_unpaid_count integer := 0;
  v_paid_count integer := 0;

  v_target_status text;
begin
  if p_table_id is null
     or p_session_id is null then
    return null;
  end if;

  -- Lock 1: dining_tables
  select *
  into v_table
  from public.dining_tables
  where id = p_table_id
  for update;

  if not found or not v_table.is_active then
    return null;
  end if;

  -- Lock 2: dining_sessions
  select *
  into v_session
  from public.dining_sessions
  where id = p_session_id
  for update;

  if not found
     or v_session.status <> 'open'
     or v_session.table_id <> p_table_id then
    return null;
  end if;

  -- Pesanan yang belum lunas
  select count(*)
  into v_unpaid_count
  from public.orders
  where dining_session_id = p_session_id
    and status in (
      'awaiting_payment',
      'partially_paid'
    );

  -- Pesanan yang sudah lunas atau selesai
  select count(*)
  into v_paid_count
  from public.orders
  where dining_session_id = p_session_id
    and status in (
      'paid',
      'completed'
    );

  if v_unpaid_count > 0 then

    v_target_status := 'awaiting_payment';

  elsif v_paid_count > 0 then

    v_target_status := 'occupied';

  else

    v_target_status := 'empty';

    update public.dining_sessions
    set
      status = 'cancelled',
      closed_at = now(),
      closed_by = p_actor_id
    where id = p_session_id
      and status = 'open';

  end if;

  update public.dining_tables
  set status = v_target_status
  where id = p_table_id;

  return v_target_status;
end;
$$;

revoke all
  on function public.sync_dining_table_status_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function public.sync_dining_table_status_internal(uuid, uuid, uuid) is
  'Helper privat sinkronisasi meja dan sesi dengan locking hierarkis.';


-- =============================================================================
-- 6. MESIN PEMBAYARAN INTERNAL
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
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
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
begin

  -- ---------------------------------------------------------------------------
  -- 1. Validasi input
  -- ---------------------------------------------------------------------------

  if p_order_id is null then
    raise exception 'ID pesanan wajib diisi.';
  end if;

  if p_actor_id is null then
    raise exception 'Identitas petugas pembayaran tidak valid.';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Nominal pembayaran harus lebih besar dari 0.';
  end if;

  if p_idempotency_key is null
     or btrim(p_idempotency_key) = '' then
    raise exception 'Kunci idempotensi pembayaran wajib diisi.';
  end if;

  v_clean_key := btrim(p_idempotency_key);

  if length(v_clean_key) < 8 then
    raise exception 'Kunci idempotensi minimal 8 karakter.';
  end if;

  v_clean_ref := nullif(btrim(p_reference_number), '');
  v_clean_notes := nullif(btrim(p_notes), '');
  v_clean_change := coalesce(p_change_amount, 0);

  -- ---------------------------------------------------------------------------
  -- 2. Validasi metode dan sumber pembayaran
  -- ---------------------------------------------------------------------------

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

  -- ---------------------------------------------------------------------------
  -- 3. Validasi tunai dan non-tunai
  -- ---------------------------------------------------------------------------

  if p_payment_source = 'cash' then

    if p_cash_received is null
       or p_cash_received < p_amount then
      raise exception
        'Uang tunai yang diterima kurang dari nominal pembayaran.';
    end if;

    if v_clean_change <> (p_cash_received - p_amount) then
      raise exception
        'Perhitungan kembalian tunai tidak valid.';
    end if;

  else

    if p_cash_received is not null
       or v_clean_change <> 0 then
      raise exception
        'Pembayaran non-tunai tidak boleh memiliki uang diterima atau kembalian.';
    end if;

  end if;

  -- ---------------------------------------------------------------------------
  -- 4. Pre-read pesanan
  -- ---------------------------------------------------------------------------

  select
    id,
    order_type,
    table_id,
    dining_session_id
  into v_pre_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception
      'Pesanan dengan ID % tidak ditemukan.',
      p_order_id;
  end if;

  -- ---------------------------------------------------------------------------
  -- 5. Lock hierarkis
  -- dining_tables -> dining_sessions -> orders
  -- ---------------------------------------------------------------------------

  if v_pre_order.order_type = 'dine_in' then

    if v_pre_order.table_id is null
       or v_pre_order.dining_session_id is null then
      raise exception
        'Relasi meja atau sesi pesanan dine-in tidak valid.';
    end if;

    perform 1
    from public.dining_tables
    where id = v_pre_order.table_id
    for update;

    if not found then
      raise exception 'Meja pesanan tidak ditemukan.';
    end if;

    perform 1
    from public.dining_sessions
    where id = v_pre_order.dining_session_id
    for update;

    if not found then
      raise exception 'Sesi kunjungan tidak ditemukan.';
    end if;

  end if;

  select *
  into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 6. Validasi anti-race condition
  -- ---------------------------------------------------------------------------

  if v_order.order_type is distinct from v_pre_order.order_type
     or v_order.table_id is distinct from v_pre_order.table_id
     or v_order.dining_session_id is distinct from v_pre_order.dining_session_id then

    raise exception
      'Relasi pesanan berubah saat penguncian. Silakan coba kembali.';

  end if;

  -- ---------------------------------------------------------------------------
  -- 7. Pemeriksaan idempotency
  -- ---------------------------------------------------------------------------

  select *
  into v_existing_payment
  from public.payments
  where idempotency_key = v_clean_key;

  if found then

    if v_existing_payment.order_id <> p_order_id then
      raise exception
        'Idempotency key sudah digunakan untuk pesanan lain.';
    end if;

    if v_existing_payment.payment_method <> p_payment_method
       or v_existing_payment.payment_source <> p_payment_source
       or v_existing_payment.amount <> p_amount
       or coalesce(v_existing_payment.cash_received, 0)
          <> coalesce(p_cash_received, 0)
       or coalesce(v_existing_payment.change_amount, 0)
          <> v_clean_change
       or coalesce(v_existing_payment.reference_number, '')
          <> coalesce(v_clean_ref, '')
       or coalesce(v_existing_payment.notes, '')
          <> coalesce(v_clean_notes, '') then

      raise exception
        'Idempotency key digunakan dengan payload berbeda.';

    end if;

    return jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'order_id', v_existing_payment.order_id,
      'order_number', v_order.order_number,
      'amount', v_existing_payment.amount,
      'cash_received', v_existing_payment.cash_received,
      'change_amount', v_existing_payment.change_amount,
      'payment_status', v_existing_payment.payment_status,
      'paid_total',
        coalesce(
          v_existing_payment.paid_total_after,
          v_order.paid_total
        ),
      'grand_total', v_order.grand_total,
      'is_settled',
        (
          coalesce(
            v_existing_payment.paid_total_after,
            v_order.paid_total
          ) = v_order.grand_total
        ),
      'queue_number',
        case
          when coalesce(
            v_existing_payment.paid_total_after,
            v_order.paid_total
          ) = v_order.grand_total
          then v_order.queue_number
          else null
        end,
      'queue_date',
        case
          when coalesce(
            v_existing_payment.paid_total_after,
            v_order.paid_total
          ) = v_order.grand_total
          then v_order.queue_date
          else null
        end,
      'idempotent_replay', true
    );

  end if;

  -- ---------------------------------------------------------------------------
  -- 8. Validasi sesi dine-in
  -- ---------------------------------------------------------------------------

  if v_order.order_type = 'dine_in' then

    select *
    into v_dining_table
    from public.dining_tables
    where id = v_order.table_id;

    if not found or not v_dining_table.is_active then
      raise exception
        'Meja pesanan tidak ditemukan atau tidak aktif.';
    end if;

    select *
    into v_dining_session
    from public.dining_sessions
    where id = v_order.dining_session_id;

    if not found then
      raise exception 'Sesi kunjungan tidak ditemukan.';
    end if;

    if v_dining_session.status <> 'open' then
      raise exception 'Sesi kunjungan sudah tidak aktif.';
    end if;

    if v_dining_session.table_id <> v_order.table_id then
      raise exception
        'Meja sesi tidak sesuai dengan meja pesanan.';
    end if;

  end if;

  -- ---------------------------------------------------------------------------
  -- 9. Validasi status dan finalisasi pesanan
  -- ---------------------------------------------------------------------------

  if not v_order.is_finalized then
    raise exception 'Pesanan belum difinalisasi.';
  end if;

  if v_order.status not in (
    'awaiting_payment',
    'partially_paid'
  ) then
    raise exception
      'Status pesanan tidak mengizinkan pembayaran.';
  end if;

  if v_order.payment_status not in (
    'unpaid',
    'partially_paid'
  ) then
    raise exception
      'Status pembayaran tidak mengizinkan pembayaran baru.';
  end if;

  if v_order.grand_total is null
     or v_order.grand_total <= 0 then
    raise exception 'Total tagihan tidak valid.';
  end if;

  if v_order.paid_total < 0
     or v_order.paid_total > v_order.grand_total then
    raise exception 'Akumulasi pembayaran tidak valid.';
  end if;

  v_remaining := v_order.grand_total - v_order.paid_total;

  if v_remaining <= 0 then
    raise exception 'Sisa tagihan tidak valid.';
  end if;

  if p_amount > v_remaining then
    raise exception
      'Nominal pembayaran melebihi sisa tagihan.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 10. Hitung pembayaran baru
  -- ---------------------------------------------------------------------------

  v_new_paid_total := v_order.paid_total + p_amount;

  v_is_settled := (
    v_new_paid_total = v_order.grand_total
  );

  -- ---------------------------------------------------------------------------
  -- 11. Insert pembayaran
  -- ---------------------------------------------------------------------------

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
      created_by
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
      p_actor_id
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
          raise exception
            'Idempotency key sudah digunakan untuk pesanan lain.';
        end if;

        raise exception
          'Idempotency key sedang diproses transaksi lain.';

      end if;

      raise;

  end;

  -- ---------------------------------------------------------------------------
  -- 12. Update status pesanan dan antrean
  -- ---------------------------------------------------------------------------

  if v_is_settled then

    v_queue_date := (
      now() at time zone 'Asia/Jakarta'
    )::date;

    v_queue_number := public.generate_queue_number(
      v_queue_date
    );

    update public.orders
    set
      paid_total = v_new_paid_total,
      status = 'paid',
      payment_status = 'paid',
      kds_status = 'queued',
      queue_date = v_queue_date,
      queue_number = v_queue_number
    where id = p_order_id;

  else

    update public.orders
    set
      paid_total = v_new_paid_total,
      status = 'partially_paid',
      payment_status = 'partially_paid'
    where id = p_order_id;

  end if;

  -- ---------------------------------------------------------------------------
  -- 13. Sinkronisasi meja dan sesi
  -- ---------------------------------------------------------------------------

  if v_order.order_type = 'dine_in' then

    v_sync_result :=
      public.sync_dining_table_status_internal(
        v_order.table_id,
        v_order.dining_session_id,
        p_actor_id
      );

    if v_sync_result is null then
      raise exception
        'Sinkronisasi meja dan sesi gagal. Transaksi pembayaran dibatalkan.';
    end if;

  end if;

  -- ---------------------------------------------------------------------------
  -- 14. Audit trail
  -- ---------------------------------------------------------------------------

  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  )
  values (
    case
      when v_is_settled then 'payment.settled'
      else 'payment.partial'
    end,
    p_actor_id,
    'payment',
    v_payment_id::text,
    jsonb_build_object(
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'payment_method', p_payment_method,
      'payment_source', p_payment_source,
      'amount', p_amount,
      'paid_total', v_new_paid_total,
      'grand_total', v_order.grand_total,
      'is_settled', v_is_settled,
      'queue_number', v_queue_number,
      'queue_date', v_queue_date
    )
  );

  -- ---------------------------------------------------------------------------
  -- 15. Response pembayaran
  -- ---------------------------------------------------------------------------

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
    'idempotent_replay', false
  );

end;
$$;

revoke all
  on function public.execute_order_payment_internal(
    uuid, text, text, integer, integer, integer,
    text, text, text, uuid
  )
  from public, anon, authenticated, service_role;

comment on function public.execute_order_payment_internal(
  uuid, text, text, integer, integer, integer,
  text, text, text, uuid
) is
  'Mesin pembayaran internal dengan locking hierarkis, idempotency, antrean atomik, dan audit.';


-- =============================================================================
-- 7. RPC PEMBAYARAN MANUAL
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
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_profile record;
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

  if not found then
    raise exception 'Profil pengguna tidak ditemukan.';
  end if;

  if not v_actor_profile.is_active then
    raise exception 'Akun pengguna dinonaktifkan.';
  end if;

  if v_actor_profile.role not in ('admin', 'kasir') then
    raise exception
      'Hanya Admin dan Kasir yang dapat memproses pembayaran.';
  end if;

  if public.current_user_role() not in ('admin', 'kasir') then
    raise exception 'Otorisasi role pengguna tidak valid.';
  end if;

  if p_idempotency_key is null
     or btrim(p_idempotency_key) = '' then
    raise exception 'Idempotency key wajib diisi.';
  end if;

  if p_payment_source not in (
    'cash',
    'qris_manual',
    'bank_transfer'
  ) then
    raise exception
      'Sumber pembayaran tidak didukung oleh RPC manual.';
  end if;

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
    v_actor_id
  );

end;
$$;

revoke all
  on function public.process_pos_payment_manual(
    uuid, text, text, integer, integer,
    integer, text, text, text
  )
  from public, anon, service_role;

grant execute
  on function public.process_pos_payment_manual(
    uuid, text, text, integer, integer,
    integer, text, text, text
  )
  to authenticated;

comment on function public.process_pos_payment_manual(
  uuid, text, text, integer, integer,
  integer, text, text, text
) is
  'RPC pembayaran manual untuk Admin dan Kasir aktif.';


-- =============================================================================
-- 8. CANCEL POS ORDER
-- =============================================================================

create or replace function public.cancel_pos_order(
  p_order_id uuid,
  p_cancel_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;

  v_actor_profile record;

  v_pre_order record;
  v_order record;

  v_sync_result text;

  v_table_freed boolean := false;
  v_session_closed boolean := false;
begin

  -- ---------------------------------------------------------------------------
  -- 1. Autentikasi
  -- ---------------------------------------------------------------------------

  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 2. Validasi profil dan role
  -- ---------------------------------------------------------------------------

  select role, is_active
  into v_actor_profile
  from public.profiles
  where id = v_user_id
  for share;

  if not found
     or not v_actor_profile.is_active
     or v_actor_profile.role not in ('admin', 'kasir') then
    raise exception
      'Hanya Admin atau Kasir aktif yang dapat membatalkan pesanan.';
  end if;

  if public.current_user_role() not in ('admin', 'kasir') then
    raise exception 'Otorisasi role pengguna tidak valid.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 3. Validasi alasan
  -- ---------------------------------------------------------------------------

  if p_cancel_reason is null
     or char_length(btrim(p_cancel_reason)) < 3 then
    raise exception
      'Alasan pembatalan wajib diisi minimal 3 karakter.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 4. Pre-read pesanan
  -- ---------------------------------------------------------------------------

  select
    id,
    order_type,
    table_id,
    dining_session_id
  into v_pre_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 5. Lock hierarkis
  -- ---------------------------------------------------------------------------

  if v_pre_order.order_type = 'dine_in' then

    if v_pre_order.table_id is null
       or v_pre_order.dining_session_id is null then
      raise exception
        'Relasi meja atau sesi pesanan dine-in tidak valid.';
    end if;

    perform 1
    from public.dining_tables
    where id = v_pre_order.table_id
    for update;

    if not found then
      raise exception 'Meja pesanan tidak ditemukan.';
    end if;

    perform 1
    from public.dining_sessions
    where id = v_pre_order.dining_session_id
    for update;

    if not found then
      raise exception 'Sesi kunjungan tidak ditemukan.';
    end if;

  end if;

  select *
  into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 6. Validasi anti-race condition
  -- ---------------------------------------------------------------------------

  if v_order.order_type is distinct from v_pre_order.order_type
     or v_order.table_id is distinct from v_pre_order.table_id
     or v_order.dining_session_id is distinct from v_pre_order.dining_session_id then
    raise exception
      'Relasi pesanan berubah saat penguncian. Silakan coba kembali.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 7. Validasi status
  -- ---------------------------------------------------------------------------

  if v_order.status = 'cancelled' then
    raise exception 'Pesanan sudah dibatalkan sebelumnya.';
  end if;

  if v_order.status <> 'awaiting_payment'
     or v_order.payment_status <> 'unpaid' then
    raise exception
      'Hanya pesanan yang belum dibayar yang dapat dibatalkan.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 8. Mutasi status pesanan
  -- ---------------------------------------------------------------------------

  update public.orders
  set
    status = 'cancelled',
    cancelled_by = v_user_id,
    cancelled_at = now(),
    cancel_reason = btrim(p_cancel_reason)
  where id = p_order_id;

  -- ---------------------------------------------------------------------------
  -- 9. Sinkronisasi meja dan sesi
  -- ---------------------------------------------------------------------------

  if v_order.order_type = 'dine_in' then

    v_sync_result :=
      public.sync_dining_table_status_internal(
        v_order.table_id,
        v_order.dining_session_id,
        v_user_id
      );

    if v_sync_result is null then
      raise exception
        'Sinkronisasi meja dan sesi gagal. Pembatalan pesanan dibatalkan.';
    end if;

    if v_sync_result = 'empty' then
      v_table_freed := true;
      v_session_closed := true;
    end if;

  end if;

  -- ---------------------------------------------------------------------------
  -- 10. Audit trail
  -- ---------------------------------------------------------------------------

  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  )
  values (
    'order.cancel',
    v_user_id,
    'order',
    v_order.id::text,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'cancel_reason', btrim(p_cancel_reason),
      'table_freed', v_table_freed,
      'session_closed', v_session_closed
    )
  );

  -- ---------------------------------------------------------------------------
  -- 11. Response
  -- ---------------------------------------------------------------------------

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'status', 'cancelled',
    'table_freed', v_table_freed,
    'session_closed', v_session_closed
  );

end;
$$;

revoke all
  on function public.cancel_pos_order(uuid, text)
  from public, anon, service_role;

grant execute
  on function public.cancel_pos_order(uuid, text)
  to authenticated;

comment on function public.cancel_pos_order(uuid, text) is
  'Pembatalan pesanan dengan locking hierarkis, validasi anti-race, sinkronisasi meja, dan audit.';


-- =============================================================================
-- SELESAI
-- =============================================================================

commit;