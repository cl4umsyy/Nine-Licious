-- ---------------------------------------------------------------------------
-- Nine Licious - F2.2 Midtrans Gateway, Webhook & Split Bill Engine
-- Migration: 20261113000100_midtrans_gateway_split_bill.sql
-- Fondasi tabel, constraint, audit log, webhook events, dan RPC security boundary.
-- ---------------------------------------------------------------------------

begin;

-- =============================================================================
-- 1. TABEL TRANSAKSI GATEWAY MIDTRANS
-- =============================================================================

create table if not exists public.midtrans_transactions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null
    references public.orders (id)
    on delete restrict,
  midtrans_order_id varchar(64) not null unique,
  gross_amount integer not null
    check (gross_amount > 0 and gross_amount <= 2147483647),
  payment_type varchar(32) not null default 'snap',
  snap_token varchar(255),
  snap_redirect_url text,
  lifecycle_status varchar(32) not null default 'initiated'
    check (
      lifecycle_status in (
        'initiated',
        'pre_request_aborted',
        'token_created',
        'pending',
        'capture_challenge',
        'settled',
        'reconciliation_required',
        'expired',
        'cancelled',
        'denied'
      )
    ),
  midtrans_transaction_status varchar(32),
  idempotency_key varchar(128) not null unique,
  payload_fingerprint varchar(64) not null,
  attempt_number integer not null default 1
    check (attempt_number >= 1),
  is_split_bill boolean not null default false,
  split_bill_type varchar(16)
    check (split_bill_type in ('custom_amount', 'by_item')),
  snap_page_expires_at timestamptz not null,
  payment_expires_at timestamptz not null,
  settled_at timestamptz,
  sanitized_response jsonb,
  created_by uuid
    references public.profiles (id)
    on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_midtrans_transactions_order_status
  on public.midtrans_transactions (order_id, lifecycle_status);

create index if not exists idx_midtrans_transactions_active_res
  on public.midtrans_transactions (order_id, gross_amount)
  where lifecycle_status in (
    'initiated',
    'token_created',
    'pending',
    'capture_challenge',
    'reconciliation_required'
  );

drop trigger if exists midtrans_transactions_set_updated_at
  on public.midtrans_transactions;
create trigger midtrans_transactions_set_updated_at
  before update on public.midtrans_transactions
  for each row
  execute function public.set_updated_at();

-- Proteksi integritas nominal: gross_amount tidak boleh diubah setelah dibuat
create or replace function public.prevent_gross_amount_mutation_midtrans_transactions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.gross_amount is distinct from new.gross_amount then
    raise exception 'GROSS_AMOUNT_IMMUTABLE: Nominal transaksi Midtrans (Rp %) tidak boleh diubah setelah transaksi dibuat.', old.gross_amount;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_gross_amount_mutation_midtrans_transactions
  on public.midtrans_transactions;
create trigger trg_prevent_gross_amount_mutation_midtrans_transactions
  before update on public.midtrans_transactions
  for each row
  execute function public.prevent_gross_amount_mutation_midtrans_transactions();

comment on table public.midtrans_transactions is
  'Transaksi gateway Midtrans Snap per attempt. Menampung status operasional, reservasi, dan integrasi webhook.';


-- =============================================================================
-- 2. TABEL ALOKASI PEMBAYARAN DAN SPLIT BILL (UNIFIED ALLOCATION)
-- =============================================================================

create table if not exists public.order_allocations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null
    references public.orders (id)
    on delete restrict,
  allocation_type varchar(16) not null
    check (allocation_type in ('full', 'custom_amount', 'by_item')),
  order_item_id uuid
    references public.order_items (id)
    on delete restrict,
  allocated_quantity integer
    check (
      (allocation_type = 'by_item' and allocated_quantity > 0)
      or (allocation_type in ('full', 'custom_amount') and allocated_quantity is null)
    ),
  allocated_line_subtotal integer not null
    check (allocated_line_subtotal >= 0),
  allocated_discount_share integer not null default 0
    check (allocated_discount_share >= 0),
  allocated_service_share integer not null default 0
    check (allocated_service_share >= 0),
  allocated_tax_share integer not null default 0
    check (allocated_tax_share >= 0),
  allocated_rounding_adjustment integer not null default 0,
  allocated_final_amount integer not null
    check (allocated_final_amount > 0),
  midtrans_transaction_id uuid
    references public.midtrans_transactions (id)
    on delete restrict,
  payment_id uuid
    references public.payments (id)
    on delete restrict,
  allocation_status varchar(16) not null default 'reserved'
    check (allocation_status in ('reserved', 'settled', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_alloc_type_structure
    check (
      (allocation_type = 'by_item' and order_item_id is not null and allocated_quantity is not null)
      or (allocation_type in ('full', 'custom_amount') and order_item_id is null and allocated_quantity is null)
    ),

  constraint chk_alloc_status_payment
    check (
      (allocation_status = 'reserved' and payment_id is null)
      or (allocation_status = 'settled' and payment_id is not null)
      or (allocation_status = 'released' and payment_id is null)
    ),

  constraint chk_alloc_financial_invariant
    check (
      allocated_final_amount = (
        allocated_line_subtotal
        - allocated_discount_share
        + allocated_service_share
        + allocated_tax_share
        + allocated_rounding_adjustment
      )
    )
);

create unique index if not exists uq_alloc_trx_item
  on public.order_allocations (midtrans_transaction_id, order_item_id)
  where allocation_type = 'by_item' and midtrans_transaction_id is not null;

create index if not exists idx_order_allocations_active_res
  on public.order_allocations (order_id, allocation_status);

create index if not exists idx_order_allocations_item_active
  on public.order_allocations (order_item_id, allocated_quantity)
  where allocation_type = 'by_item' and allocation_status = 'reserved';

drop trigger if exists order_allocations_set_updated_at
  on public.order_allocations;
create trigger order_allocations_set_updated_at
  before update on public.order_allocations
  for each row
  execute function public.set_updated_at();

-- Immutabilitas komponen finansial dan identitas alokasi setelah dibuat
create or replace function public.prevent_financial_mutation_order_allocations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.order_id <> new.order_id
     or old.allocation_type <> new.allocation_type
     or coalesce(old.order_item_id, '00000000-0000-0000-0000-000000000000'::uuid) <> coalesce(new.order_item_id, '00000000-0000-0000-0000-000000000000'::uuid)
     or coalesce(old.allocated_quantity, -1) <> coalesce(new.allocated_quantity, -1)
     or old.allocated_line_subtotal <> new.allocated_line_subtotal
     or old.allocated_discount_share <> new.allocated_discount_share
     or old.allocated_service_share <> new.allocated_service_share
     or old.allocated_tax_share <> new.allocated_tax_share
     or old.allocated_rounding_adjustment <> new.allocated_rounding_adjustment
     or old.allocated_final_amount <> new.allocated_final_amount
     or coalesce(old.midtrans_transaction_id, '00000000-0000-0000-0000-000000000000'::uuid) <> coalesce(new.midtrans_transaction_id, '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception 'IMMUTABLE_ALLOCATION_FINANCIALS: Komponen finansial dan identitas alokasi (order, item, subtotal, diskon, service, pajak, nominal) bersifat abadi dan tidak boleh diubah.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_financial_mutation_order_allocations
  on public.order_allocations;
create trigger trg_prevent_financial_mutation_order_allocations
  before update on public.order_allocations
  for each row
  execute function public.prevent_financial_mutation_order_allocations();

comment on table public.order_allocations is
  'Alokasi pembayaran pecahan nominal maupun item split bill dengan status reserved, settled, dan released.';


-- =============================================================================
-- 3. TRIGGER VALIDASI INTEGRITAS RELASI ANTAR-ORDER (ANTI-KONTAMINASI)
-- =============================================================================

create or replace function public.validate_order_allocation_relations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item_order_id uuid;
  v_trx_order_id uuid;
  v_pay_order_id uuid;
begin
  -- 1. Validasi order_item_id
  if new.order_item_id is not null then
    select order_id into v_item_order_id
    from public.order_items
    where id = new.order_item_id;

    if not found then
      raise exception 'Item pesanan % tidak ditemukan.', new.order_item_id;
    end if;

    if v_item_order_id <> new.order_id then
      raise exception
        'CROSS_ORDER_CONTAMINATION: Item % (Order %) tidak sesuai dengan Order Alokasi %.',
        new.order_item_id,
        v_item_order_id,
        new.order_id;
    end if;
  end if;

  -- 2. Validasi midtrans_transaction_id
  if new.midtrans_transaction_id is not null then
    select order_id into v_trx_order_id
    from public.midtrans_transactions
    where id = new.midtrans_transaction_id;

    if not found then
      raise exception 'Transaksi Midtrans % tidak ditemukan.', new.midtrans_transaction_id;
    end if;

    if v_trx_order_id <> new.order_id then
      raise exception
        'CROSS_ORDER_CONTAMINATION: Transaksi Midtrans % (Order %) tidak sesuai dengan Order Alokasi %.',
        new.midtrans_transaction_id,
        v_trx_order_id,
        new.order_id;
    end if;
  end if;

  -- 3. Validasi payment_id
  if new.payment_id is not null then
    select order_id into v_pay_order_id
    from public.payments
    where id = new.payment_id;

    if not found then
      raise exception 'Pembayaran % tidak ditemukan.', new.payment_id;
    end if;

    if v_pay_order_id <> new.order_id then
      raise exception
        'CROSS_ORDER_CONTAMINATION: Pembayaran % (Order %) tidak sesuai dengan Order Alokasi %.',
        new.payment_id,
        v_pay_order_id,
        new.order_id;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_order_allocation
  on public.order_allocations;
create trigger trg_validate_order_allocation
  before insert or update on public.order_allocations
  for each row
  execute function public.validate_order_allocation_relations();


-- =============================================================================
-- 4. TABEL AUDIT RIWAYAT ALOKASI (APPEND-ONLY LEDGER)
-- =============================================================================

create table if not exists public.order_allocation_events (
  id bigint generated always as identity primary key,
  allocation_id uuid not null
    references public.order_allocations (id)
    on delete restrict,
  order_id uuid not null
    references public.orders (id)
    on delete restrict,
  from_status varchar(16),
  to_status varchar(16) not null,
  transition_reason varchar(64) not null,
  payment_id uuid
    references public.payments (id)
    on delete restrict,
  midtrans_transaction_id uuid
    references public.midtrans_transactions (id)
    on delete restrict,
  event_metadata jsonb not null default '{}'::jsonb,
  actor_id uuid
    references public.profiles (id)
    on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists idx_allocation_events_lookup
  on public.order_allocation_events (allocation_id, created_at desc);

create or replace function public.log_order_allocation_status_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT') or (old.allocation_status is distinct from new.allocation_status) then
    insert into public.order_allocation_events (
      allocation_id,
      order_id,
      from_status,
      to_status,
      transition_reason,
      payment_id,
      midtrans_transaction_id,
      event_metadata,
      actor_id
    ) values (
      new.id,
      new.order_id,
      case when tg_op = 'INSERT' then null else old.allocation_status end,
      new.allocation_status,
      case
        when tg_op = 'INSERT' then 'allocation_created'
        when new.allocation_status = 'settled' then 'payment_settled'
        when new.allocation_status = 'released' then 'reservation_released'
        else 'status_updated'
      end,
      new.payment_id,
      new.midtrans_transaction_id,
      jsonb_build_object(
        'allocation_type', new.allocation_type,
        'allocated_quantity', new.allocated_quantity,
        'allocated_line_subtotal', new.allocated_line_subtotal,
        'allocated_discount_share', new.allocated_discount_share,
        'allocated_service_share', new.allocated_service_share,
        'allocated_tax_share', new.allocated_tax_share,
        'allocated_rounding_adjustment', new.allocated_rounding_adjustment,
        'allocated_final_amount', new.allocated_final_amount
      ),
      auth.uid()
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_log_order_allocation_event
  on public.order_allocations;
create trigger trg_log_order_allocation_event
  after insert or update on public.order_allocations
  for each row
  execute function public.log_order_allocation_status_event();

create or replace function public.prevent_mutation_order_allocation_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'IMMUTABLE_LEDGER: Baris pada order_allocation_events bersifat append-only dan tidak dapat diubah atau dihapus.';
end;
$$;

drop trigger if exists trg_prevent_mutation_order_allocation_events
  on public.order_allocation_events;
create trigger trg_prevent_mutation_order_allocation_events
  before update or delete on public.order_allocation_events
  for each row
  execute function public.prevent_mutation_order_allocation_events();

comment on table public.order_allocation_events is
  'Append-only immutable event ledger untuk melacak histori status reservasi dan settlement alokasi.';


-- =============================================================================
-- 5. TABEL PENCATATAN WEBHOOK MIDTRANS (DURABLE & IDEMPOTENT)
-- =============================================================================

create table if not exists public.midtrans_webhook_events (
  id bigint generated always as identity primary key,
  event_fingerprint varchar(128) not null unique,
  midtrans_order_id varchar(64) not null,
  transaction_id varchar(64),
  raw_status varchar(32) not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_result varchar(32) not null default 'received'
    check (
      processing_result in (
        'received',
        'processing',
        'settled',
        'ignored_duplicate',
        'ignored_out_of_order',
        'reconciliation_flagged',
        'terminal_released',
        'failed'
      )
    ),
  is_signature_verified boolean not null default false,
  is_duplicate boolean not null default false,
  delivery_attempts integer not null default 1
    check (delivery_attempts >= 1),
  last_delivery_at timestamptz not null default now(),
  error_message text,
  sanitized_payload jsonb not null
);

create index if not exists idx_mwe_order_lookup
  on public.midtrans_webhook_events (midtrans_order_id, received_at desc);

comment on table public.midtrans_webhook_events is
  'Pencatatan event webhook Midtrans secara durable dan idempotent dengan proteksi penyerahan berulang.';


-- =============================================================================
-- 6. HELPER SISA NOMINAL RESERVASI GATEWAY
-- =============================================================================

create or replace function public.calculate_active_gateway_reserved_amount(
  p_order_id uuid
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(gross_amount), 0)::integer
  from public.midtrans_transactions
  where order_id = p_order_id
    and lifecycle_status in (
      'initiated',
      'token_created',
      'pending',
      'capture_challenge',
      'reconciliation_required'
    );
$$;

-- Akses helper dibatasi ketat hanya untuk service_role dan fungsi internal
revoke all on function public.calculate_active_gateway_reserved_amount(uuid) from public, anon, authenticated;
grant execute on function public.calculate_active_gateway_reserved_amount(uuid) to service_role;


-- =============================================================================
-- 7. REPLACEMENT RPC: PROCESS_POS_PAYMENT_MANUAL (OVERRIDE F2.1 RESPEK RESERVASI)
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
  v_clean_key text;
  v_existing_payment record;
  v_pre_order record;
  v_order record;
  v_dining_table record;
  v_dining_session record;
  v_reserved_amount integer;
  v_available_amount integer;
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

  -- 4. Pemeriksaan idempotency sebelum validasi available amount
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
      v_actor_id
    );
  end if;

  -- 5. Jika pembayaran baru: evaluasi ketersediaan saldo reservasi gateway
  v_reserved_amount := public.calculate_active_gateway_reserved_amount(p_order_id);
  v_available_amount := v_order.grand_total - v_order.paid_total - v_reserved_amount;

  -- Seluruh metode pembayaran (termasuk cash) wajib menghormati kapasitas yang belum direservasi
  if p_amount > v_available_amount then
    raise exception
      'PAYMENT_EXCEEDS_AVAILABLE_AMOUNT: Nominal pembayaran (Rp %) melebihi sisa tagihan yang belum direservasi gateway (Tersedia: Rp %, Direservasi: Rp %).',
      p_amount,
      v_available_amount,
      v_reserved_amount;
  end if;

  -- Teruskan ke mesin pembayaran internal F2.1
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
    v_actor_id
  );

end;
$$;

revoke all on function public.process_pos_payment_manual(uuid, text, text, integer, integer, integer, text, text, text) from public, anon, service_role;
grant execute on function public.process_pos_payment_manual(uuid, text, text, integer, integer, integer, text, text, text) to authenticated;


-- =============================================================================
-- 8. REPLACEMENT RPC: CANCEL_POS_ORDER (OVERRIDE F2.1 GUARD GATEWAY AKTIF)
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
  v_active_res_count integer;
begin

  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select role, is_active
  into v_actor_profile
  from public.profiles
  where id = v_user_id
  for share;

  if not found or not v_actor_profile.is_active or v_actor_profile.role not in ('admin', 'kasir') then
    raise exception 'Hanya Admin atau Kasir aktif yang dapat membatalkan pesanan.';
  end if;

  if public.current_user_role() not in ('admin', 'kasir') then
    raise exception 'Otorisasi role pengguna tidak valid.';
  end if;

  if p_cancel_reason is null or char_length(btrim(p_cancel_reason)) < 3 then
    raise exception 'Alasan pembatalan wajib diisi minimal 3 karakter.';
  end if;

  -- 1. Pre-read relasi
  select id, order_type, table_id, dining_session_id
  into v_pre_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception 'Pesanan dengan ID % tidak ditemukan.', p_order_id;
  end if;

  -- 2. Kunci hierarki (dining_tables -> dining_sessions -> orders)
  if v_pre_order.order_type = 'dine_in' then
    if v_pre_order.table_id is not null then
      perform 1 from public.dining_tables where id = v_pre_order.table_id for update;
    end if;

    if v_pre_order.dining_session_id is not null then
      perform 1 from public.dining_sessions where id = v_pre_order.dining_session_id for update;
    end if;
  end if;

  select *
  into v_order
  from public.orders
  where id = p_order_id
  for update;

  if v_order.status = 'cancelled' then
    return jsonb_build_object(
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'status', 'cancelled'
    );
  end if;

  if v_order.status in ('completed', 'refunded') then
    raise exception
      'Pesanan dengan status % tidak dapat dibatalkan.',
      v_order.status;
  end if;

  if v_order.status not in ('awaiting_payment', 'partially_paid') then
    raise exception
      'Status pesanan tidak mengizinkan pembatalan.';
  end if;

  if v_order.payment_status not in ('unpaid', 'partially_paid') then
    raise exception
      'Status pembayaran tidak mengizinkan pembatalan.';
  end if;

  if v_order.paid_total > 0 then
    raise exception
      'Pesanan dengan pembayaran tercatat (Rp %) tidak dapat dibatalkan langsung.',
      v_order.paid_total;
  end if;

  -- Validasi apakah ada transaksi gateway Midtrans yang masih aktif atau un-reconciled
  select count(*) into v_active_res_count
  from public.midtrans_transactions
  where order_id = p_order_id
    and lifecycle_status in (
      'initiated',
      'token_created',
      'pending',
      'capture_challenge',
      'reconciliation_required'
    );

  if v_active_res_count > 0 then
    raise exception
      'ACTIVE_GATEWAY_TRANSACTIONS: Pesanan % memiliki % transaksi gateway aktif atau dalam proses rekonsiliasi. Selesaikan atau batalkan transaksi gateway terlebih dahulu.',
      p_order_id,
      v_active_res_count;
  end if;

  -- Update pembatalan pesanan
  update public.orders
  set
    status = 'cancelled',
    cancelled_by = v_user_id,
    cancelled_at = pg_catalog.now(),
    cancel_reason = btrim(p_cancel_reason)
  where id = p_order_id;

  if v_order.order_type = 'dine_in' and v_order.table_id is not null then
    v_sync_result := public.sync_dining_table_status_internal(
      v_order.table_id,
      v_order.dining_session_id,
      v_user_id
    );

    if v_sync_result is null then
      raise exception 'Sinkronisasi status meja gagal.';
    end if;
  end if;

  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  )
  values (
    'order.cancelled',
    v_user_id,
    'orders',
    p_order_id::text,
    jsonb_build_object(
      'order_number', v_order.order_number,
      'cancel_reason', btrim(p_cancel_reason)
    )
  );

  return jsonb_build_object(
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'status', 'cancelled'
  );

end;
$$;

revoke all on function public.cancel_pos_order(uuid, text) from public, anon, service_role;
grant execute on function public.cancel_pos_order(uuid, text) to authenticated;


-- =============================================================================
-- 9. RPC PEMBUATAN SNAP TRANSACTION & RESERVASI ATOMIK
-- =============================================================================

create or replace function public.create_midtrans_snap_transaction(
  p_order_id uuid,
  p_gross_amount integer,
  p_idempotency_key text,
  p_snap_page_expires_at timestamptz,
  p_payment_expires_at timestamptz,
  p_is_split_bill boolean default false,
  p_split_bill_type text default null,
  p_item_allocations jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_profile record;
  v_clean_key text;
  v_payload_fingerprint text;
  v_existing_tx record;
  v_pre_order record;
  v_order record;
  v_dining_table record;
  v_dining_session record;
  v_existing_alloc_type text;
  v_effective_mode text;
  v_active_mode_count integer;

  v_reserved_amount integer;
  v_available_amount integer;
  v_attempt_number integer := 1;
  v_midtrans_order_id text;

  v_tx_id uuid;
  v_alloc_item record;
  v_order_item record;
  v_item_prev_allocated_qty integer;
  v_item_new_cum_qty integer;
  v_input_qty integer;
  v_check_elem jsonb;

  v_item_count integer := 0;
  v_total_allocated_batch integer := 0;
  v_calculated_items jsonb := '[]'::jsonb;

  -- Variabel kalkulasi kumulatif server-side
  v_order_net_line integer;
  v_order_non_prod_disc integer;
  v_cum_net_line numeric := 0;
  v_cum_disc numeric := 0;
  v_cum_serv numeric := 0;
  v_cum_tax numeric := 0;
  v_weight numeric := 0;
  v_target_disc integer;
  v_target_serv integer;
  v_target_tax integer;
  v_cum_subtotal_before integer;
  v_cum_subtotal_after integer;
  v_step_subtotal integer;
  v_cum_pdisc_before integer;
  v_cum_pdisc_after integer;
  v_step_pdisc integer;
  v_calc_net_line integer;
  v_calc_disc_share integer;
  v_calc_serv_share integer;
  v_calc_tax_share integer;
  v_calc_final_amount integer;
  v_calc_rounding integer;
begin

  v_actor_id := auth.uid();

  if v_actor_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select role, is_active into v_actor_profile
  from public.profiles
  where id = v_actor_id
  for share;

  if not found or not v_actor_profile.is_active or v_actor_profile.role not in ('admin', 'kasir') then
    raise exception 'Hanya Admin dan Kasir yang dapat membuat transaksi gateway.';
  end if;

  if p_gross_amount is null or p_gross_amount <= 0 or p_gross_amount > 2147483647 then
    raise exception 'Nominal transaksi gateway harus berupa angka positif yang valid.';
  end if;

  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'Idempotency key wajib diisi.';
  end if;

  v_clean_key := btrim(p_idempotency_key);

  if p_snap_page_expires_at is null or p_payment_expires_at is null then
    raise exception 'Waktu kedaluwarsa Snap wajib diisi.';
  end if;

  -- 1. Validasi struktur JSON input p_item_allocations
  if p_item_allocations is not null then
    if jsonb_typeof(p_item_allocations) <> 'array' then
      raise exception 'Format item_allocations tidak valid, wajib berupa JSON array.';
    end if;

    if jsonb_array_length(p_item_allocations) > 200 then
      raise exception 'Jumlah item dalam satu alokasi melebihi batas maksimum 200 item.';
    end if;

    for v_check_elem in select * from jsonb_array_elements(p_item_allocations)
    loop
      if jsonb_typeof(v_check_elem) <> 'object' then
        raise exception 'Elemen item_allocations harus berupa objek JSON.';
      end if;

      if (v_check_elem->>'order_item_id') is null
         or (v_check_elem->>'order_item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'order_item_id tidak valid pada item_allocations.';
      end if;

      if (v_check_elem->>'allocated_quantity') is null
         or (v_check_elem->>'allocated_quantity')::numeric <> trunc((v_check_elem->>'allocated_quantity')::numeric)
         or (v_check_elem->>'allocated_quantity')::integer <= 0 then
        raise exception 'Kuantitas alokasi item % harus berupa bilangan bulat positif.', (v_check_elem->>'order_item_id');
      end if;
    end loop;
  end if;

  -- 2. Hitung fingerprint payload SHA-256 deterministik
  select encode(
    sha256(
      convert_to(
        p_order_id::text || '|' ||
        p_gross_amount::text || '|' ||
        coalesce(p_is_split_bill, false)::text || '|' ||
        coalesce(p_split_bill_type, '') || '|' ||
        coalesce((
          select string_agg(
            (x->>'order_item_id') || ':' || (x->>'allocated_quantity'),
            ',' order by (x->>'order_item_id')
          )
          from jsonb_array_elements(
            case
              when p_item_allocations is not null and jsonb_typeof(p_item_allocations) = 'array'
              then p_item_allocations
              else '[]'::jsonb
            end
          ) as x
        ), ''),
        'utf8'
      )
    ),
    'hex'
  ) into v_payload_fingerprint;

  -- 3. Pre-read relasi
  select id, order_type, table_id, dining_session_id into v_pre_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  -- 4. Kunci hierarki pesanan FOR UPDATE langsung sejak awal (dining_tables -> dining_sessions -> orders)
  if v_pre_order.order_type = 'dine_in' then
    if v_pre_order.table_id is not null then
      perform 1 from public.dining_tables where id = v_pre_order.table_id for update;
    end if;
    if v_pre_order.dining_session_id is not null then
      perform 1 from public.dining_sessions where id = v_pre_order.dining_session_id for update;
    end if;
  end if;

  select * into v_order from public.orders where id = p_order_id for update;

  -- Validasi ulang relasi meja dan sesi setelah lock diperoleh
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

  -- 5. Pemeriksaan idempotency sebelum validasi status pesanan baru
  select *
  into v_existing_tx
  from public.midtrans_transactions
  where idempotency_key = v_clean_key;

  if found then
    if v_existing_tx.payload_fingerprint <> v_payload_fingerprint then
      raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH: Idempotency key % sudah digunakan dengan payload berbeda.', v_clean_key;
    end if;

    return jsonb_build_object(
      'midtrans_transaction_id', v_existing_tx.id,
      'midtrans_order_id', v_existing_tx.midtrans_order_id,
      'gross_amount', v_existing_tx.gross_amount,
      'attempt_number', v_existing_tx.attempt_number,
      'snap_token', v_existing_tx.snap_token,
      'snap_redirect_url', v_existing_tx.snap_redirect_url,
      'lifecycle_status', v_existing_tx.lifecycle_status,
      'idempotent_replay', true
    );
  end if;

  -- 6. Validasi status pesanan untuk transaksi baru
  if not v_order.is_finalized then
    raise exception 'Pesanan belum difinalisasi.';
  end if;

  if v_order.status not in ('awaiting_payment', 'partially_paid') then
    raise exception 'Status pesanan tidak mengizinkan pembayaran baru.';
  end if;

  -- 7. Validasi konsistensi mode split bill
  if coalesce(p_is_split_bill, false) = false then
    if p_split_bill_type is not null then
      raise exception 'Non-split bill tidak boleh memiliki split_bill_type.';
    end if;
    if p_item_allocations is not null then
      raise exception 'Non-split bill tidak boleh memiliki item_allocations.';
    end if;
  else
    if p_split_bill_type is null then
      raise exception 'SPLIT_BILL_TYPE_REQUIRED: Tipe split bill wajib diisi saat is_split_bill bernilai true.';
    end if;

    if p_split_bill_type not in ('custom_amount', 'by_item') then
      raise exception 'Tipe split bill tidak valid: %. Harus custom_amount atau by_item.', p_split_bill_type;
    end if;

    if p_split_bill_type = 'custom_amount' and p_item_allocations is not null then
      raise exception 'Split bill custom_amount tidak boleh menyertakan item_allocations.';
    end if;

    if p_split_bill_type = 'by_item' then
      if p_item_allocations is null or jsonb_array_length(p_item_allocations) = 0 then
        raise exception 'Split bill by_item wajib menyertakan daftar item alokasi.';
      end if;
    end if;
  end if;

  -- Tentukan mode efektif dan tolak nilai unknown
  v_effective_mode := case
    when coalesce(p_is_split_bill, false) = false then 'full'
    when p_split_bill_type = 'custom_amount' then 'custom_amount'
    when p_split_bill_type = 'by_item' then 'by_item'
    else 'unknown'
  end;

  if v_effective_mode = 'unknown' or v_effective_mode not in ('full', 'custom_amount', 'by_item') then
    raise exception 'INVALID_EFFECTIVE_MODE: Mode alokasi tidak valid (%).', v_effective_mode;
  end if;

  -- Cegah pencampuran mode split bill pada satu pesanan yang sama
  select count(distinct allocation_type), min(allocation_type)
  into v_active_mode_count, v_existing_alloc_type
  from public.order_allocations
  where order_id = p_order_id
    and allocation_status in ('settled', 'reserved');

  if v_active_mode_count > 1 then
    raise exception
      'CORRUPTED_SPLIT_MODE: Pesanan % memiliki lebih dari satu mode alokasi aktif.',
      p_order_id;
  end if;

  if v_active_mode_count = 1 and v_existing_alloc_type is not null then
    if v_existing_alloc_type <> v_effective_mode then
      raise exception
        'MIXED_SPLIT_MODE_NOT_ALLOWED: Pesanan sudah memiliki alokasi aktif berjenis %, tidak boleh mencampur dengan %.',
        v_existing_alloc_type,
        v_effective_mode;
    end if;
  end if;

  -- 8. Validasi kapasitas saldo reservasi gateway
  v_reserved_amount := public.calculate_active_gateway_reserved_amount(p_order_id);
  v_available_amount := v_order.grand_total - v_order.paid_total - v_reserved_amount;

  if p_gross_amount > v_available_amount then
    raise exception
      'INSUFFICIENT_AVAILABLE_AMOUNT: Nominal pengajuan (Rp %) melebihi kapasitas yang belum direservasi (Rp %).',
      p_gross_amount,
      v_available_amount;
  end if;

  -- 9. Validasi & perhitungan dekomposisi alokasi server-side
  v_order_net_line := v_order.subtotal - v_order.discount_product_total;
  v_order_non_prod_disc := v_order.discount_order_total + v_order.discount_manual_total;

  if v_order_net_line <= 0 then
    raise exception 'Total net line pesanan tidak valid untuk alokasi split bill.';
  end if;

  if coalesce(p_is_split_bill, false) and p_split_bill_type = 'by_item' then

    -- Tolak item duplikat dalam satu request alokasi
    if (
      select count(distinct (x->>'order_item_id')) <> count(*)
      from jsonb_array_elements(p_item_allocations) as x
    ) then
      raise exception 'DUPLICATE_ORDER_ITEM_IN_REQUEST: Item pesanan duplikat terdeteksi dalam satu permintaan alokasi.';
    end if;

    -- Ambil akumulator dari alokasi historis terdahulu yang aktif (settled dan reserved)
    select
      coalesce(sum(allocated_line_subtotal), 0),
      coalesce(sum(allocated_discount_share), 0),
      coalesce(sum(allocated_service_share), 0),
      coalesce(sum(allocated_tax_share), 0)
    into v_cum_net_line, v_cum_disc, v_cum_serv, v_cum_tax
    from public.order_allocations
    where order_id = p_order_id
      and allocation_status in ('settled', 'reserved')
      and allocation_type = 'by_item';

    v_calculated_items := '[]'::jsonb;
    v_total_allocated_batch := 0;

    -- Iterasi validasi setiap item diurutkan secara deterministik berdasarkan order_item_id
    for v_alloc_item in
      select * from jsonb_to_recordset(p_item_allocations) as x(
        order_item_id uuid,
        allocated_quantity integer,
        allocated_line_subtotal integer,
        allocated_discount_share integer,
        allocated_service_share integer,
        allocated_tax_share integer,
        allocated_final_amount integer
      )
      order by order_item_id asc
    loop
      v_item_count := v_item_count + 1;

      -- Kunci baris order_item
      select * into v_order_item
      from public.order_items
      where id = v_alloc_item.order_item_id and order_id = p_order_id
      for update;

      if not found then
        raise exception 'Item pesanan % tidak ditemukan pada order %.', v_alloc_item.order_item_id, p_order_id;
      end if;

      v_input_qty := v_alloc_item.allocated_quantity;

      if v_input_qty <= 0 or v_input_qty > v_order_item.quantity then
        raise exception 'Kuantitas alokasi item % tidak valid (Input: %, Item: %).',
          v_alloc_item.order_item_id, v_input_qty, v_order_item.quantity;
      end if;

      -- Ambil kuantitas yang telah dialokasikan sebelumnya (settled + reserved)
      select coalesce(sum(allocated_quantity), 0)::integer into v_item_prev_allocated_qty
      from public.order_allocations
      where order_item_id = v_alloc_item.order_item_id and allocation_status in ('settled', 'reserved');

      v_item_new_cum_qty := v_item_prev_allocated_qty + v_input_qty;

      if v_item_new_cum_qty > v_order_item.quantity then
        raise exception
          'ITEM_QUANTITY_OVER_RESERVED: Kuantitas diajukan (%) melebihi sisa yang belum dibayar/direservasi (Total: %, Teralokasi Sebelumnya: %).',
          v_input_qty, v_order_item.quantity, v_item_prev_allocated_qty;
      end if;

      -- Perhitungan kumulatif subtotal dan diskon produk item untuk menjamin zero drift
      v_cum_subtotal_before := pg_catalog.round((v_order_item.subtotal::numeric / v_order_item.quantity) * v_item_prev_allocated_qty)::integer;
      v_cum_subtotal_after := pg_catalog.round((v_order_item.subtotal::numeric / v_order_item.quantity) * v_item_new_cum_qty)::integer;
      v_step_subtotal := v_cum_subtotal_after - v_cum_subtotal_before;

      v_cum_pdisc_before := pg_catalog.round((v_order_item.discount_amount::numeric / v_order_item.quantity) * v_item_prev_allocated_qty)::integer;
      v_cum_pdisc_after := pg_catalog.round((v_order_item.discount_amount::numeric / v_order_item.quantity) * v_item_new_cum_qty)::integer;
      v_step_pdisc := v_cum_pdisc_after - v_cum_pdisc_before;

      v_calc_net_line := v_step_subtotal - v_step_pdisc;

      v_cum_net_line := v_cum_net_line + v_calc_net_line;
      v_weight := v_cum_net_line / v_order_net_line;

      v_target_disc := pg_catalog.round(v_order_non_prod_disc * v_weight)::integer;
      v_target_serv := pg_catalog.round(v_order.service_total * v_weight)::integer;
      v_target_tax := pg_catalog.round(v_order.tax_total * v_weight)::integer;

      v_calc_disc_share := v_target_disc - v_cum_disc::integer;
      v_calc_serv_share := v_target_serv - v_cum_serv::integer;
      v_calc_tax_share := v_target_tax - v_cum_tax::integer;

      v_cum_disc := v_target_disc;
      v_cum_serv := v_target_serv;
      v_cum_tax := v_target_tax;

      v_calc_final_amount := v_calc_net_line - v_calc_disc_share + v_calc_serv_share + v_calc_tax_share;

      -- Validasi komponen finansial yang dikirim klien (jika dikirim, nilai wajib sama persis dengan server)
      if v_alloc_item.allocated_line_subtotal is not null and v_alloc_item.allocated_line_subtotal <> v_calc_net_line then
        raise exception 'ALLOCATION_FIELD_MISMATCH: allocated_line_subtotal item % (Rp %) berbeda dengan kalkulasi server (Rp %).',
          v_alloc_item.order_item_id, v_alloc_item.allocated_line_subtotal, v_calc_net_line;
      end if;

      if v_alloc_item.allocated_discount_share is not null and v_alloc_item.allocated_discount_share <> v_calc_disc_share then
        raise exception 'ALLOCATION_FIELD_MISMATCH: allocated_discount_share item % (Rp %) berbeda dengan kalkulasi server (Rp %).',
          v_alloc_item.order_item_id, v_alloc_item.allocated_discount_share, v_calc_disc_share;
      end if;

      if v_alloc_item.allocated_service_share is not null and v_alloc_item.allocated_service_share <> v_calc_serv_share then
        raise exception 'ALLOCATION_FIELD_MISMATCH: allocated_service_share item % (Rp %) berbeda dengan kalkulasi server (Rp %).',
          v_alloc_item.order_item_id, v_alloc_item.allocated_service_share, v_calc_serv_share;
      end if;

      if v_alloc_item.allocated_tax_share is not null and v_alloc_item.allocated_tax_share <> v_calc_tax_share then
        raise exception 'ALLOCATION_FIELD_MISMATCH: allocated_tax_share item % (Rp %) berbeda dengan kalkulasi server (Rp %).',
          v_alloc_item.order_item_id, v_alloc_item.allocated_tax_share, v_calc_tax_share;
      end if;

      -- Simpan ke koleksi hasil kalkulasi server
      v_calculated_items := v_calculated_items || jsonb_build_object(
        'order_item_id', v_alloc_item.order_item_id,
        'allocated_quantity', v_input_qty,
        'allocated_line_subtotal', v_calc_net_line,
        'allocated_discount_share', v_calc_disc_share,
        'allocated_service_share', v_calc_serv_share,
        'allocated_tax_share', v_calc_tax_share,
        'allocated_rounding_adjustment', 0,
        'allocated_final_amount', v_calc_final_amount,
        'client_final_amount', v_alloc_item.allocated_final_amount
      );

      v_total_allocated_batch := v_total_allocated_batch + v_calc_final_amount;
    end loop;

    -- Residual allocation jika pembayaran terminal (pembayaran ini menghabiskan seluruh sisa tagihan)
    if (v_order.paid_total + v_reserved_amount + p_gross_amount = v_order.grand_total) then
      declare
        v_res_diff integer;
        v_last_idx integer;
        v_last_elem jsonb;
        v_adj_final integer;
        v_adj_round integer;
      begin
        v_res_diff := p_gross_amount - v_total_allocated_batch;
        if v_res_diff <> 0 and jsonb_array_length(v_calculated_items) > 0 then
          v_last_idx := jsonb_array_length(v_calculated_items) - 1;
          v_last_elem := v_calculated_items -> v_last_idx;
          v_adj_final := (v_last_elem ->> 'allocated_final_amount')::integer + v_res_diff;
          v_adj_round := (v_last_elem ->> 'allocated_rounding_adjustment')::integer + v_res_diff;

          v_calculated_items := jsonb_set(
            v_calculated_items,
            array[v_last_idx::text, 'allocated_final_amount'],
            to_jsonb(v_adj_final)
          );
          v_calculated_items := jsonb_set(
            v_calculated_items,
            array[v_last_idx::text, 'allocated_rounding_adjustment'],
            to_jsonb(v_adj_round)
          );
          v_total_allocated_batch := v_total_allocated_batch + v_res_diff;
        end if;
      end;
    end if;

    -- Validasi allocated_final_amount setiap item terhadap hasil akhir kalkulasi server
    for v_alloc_item in
      select * from jsonb_to_recordset(v_calculated_items) as y(
        order_item_id uuid,
        allocated_final_amount integer,
        client_final_amount integer
      )
    loop
      if v_alloc_item.client_final_amount is not null and v_alloc_item.client_final_amount <> v_alloc_item.allocated_final_amount then
        raise exception 'ALLOCATION_FIELD_MISMATCH: allocated_final_amount item % (Rp %) berbeda dengan kalkulasi server (Rp %).',
          v_alloc_item.order_item_id, v_alloc_item.client_final_amount, v_alloc_item.allocated_final_amount;
      end if;
    end loop;

    -- Validasi bahwa total alokasi kalkulasi server sama persis dengan nominal transaksi
    if v_total_allocated_batch <> p_gross_amount then
      raise exception
        'ALLOCATION_TOTAL_MISMATCH: Total alokasi item hasil kalkulasi server (Rp %) tidak sama dengan gross amount transaksi (Rp %).',
        v_total_allocated_batch,
        p_gross_amount;
    end if;

  elsif coalesce(p_is_split_bill, false) and p_split_bill_type = 'custom_amount' then

    -- Dekomposisi finansial proporsional untuk custom_amount (bukan menaruh gross ke subtotal)
    v_weight := p_gross_amount::numeric / v_order.grand_total::numeric;
    v_calc_net_line := pg_catalog.round(v_order_net_line * v_weight)::integer;
    v_calc_disc_share := pg_catalog.round(v_order_non_prod_disc * v_weight)::integer;
    v_calc_serv_share := pg_catalog.round(v_order.service_total * v_weight)::integer;
    v_calc_tax_share := pg_catalog.round(v_order.tax_total * v_weight)::integer;
    v_calc_final_amount := v_calc_net_line - v_calc_disc_share + v_calc_serv_share + v_calc_tax_share;
    v_calc_rounding := p_gross_amount - v_calc_final_amount;

  else

    -- Mode normal (pembayaran penuh pesanan tanpa split bill)
    v_calc_net_line := v_order_net_line;
    v_calc_disc_share := v_order_non_prod_disc;
    v_calc_serv_share := v_order.service_total;
    v_calc_tax_share := v_order.tax_total;
    v_calc_rounding := 0;
    v_calc_final_amount := v_order.grand_total;

  end if;

  -- 10. Buat transaksi gateway dengan status initiated
  select coalesce(max(attempt_number), 0) + 1 into v_attempt_number
  from public.midtrans_transactions
  where order_id = p_order_id;

  v_midtrans_order_id := v_order.order_number || '-A' || v_attempt_number::text;

  if char_length(v_midtrans_order_id) > 64 then
    raise exception 'MIDTRANS_ORDER_ID_TOO_LONG: Panjang midtrans_order_id (%) melebihi 64 karakter.', v_midtrans_order_id;
  end if;

  insert into public.midtrans_transactions (
    order_id,
    midtrans_order_id,
    gross_amount,
    payment_type,
    lifecycle_status,
    idempotency_key,
    payload_fingerprint,
    attempt_number,
    is_split_bill,
    split_bill_type,
    snap_page_expires_at,
    payment_expires_at,
    created_by
  ) values (
    p_order_id,
    v_midtrans_order_id,
    p_gross_amount,
    'snap',
    'initiated',
    v_clean_key,
    v_payload_fingerprint,
    v_attempt_number,
    coalesce(p_is_split_bill, false),
    p_split_bill_type,
    p_snap_page_expires_at,
    p_payment_expires_at,
    v_actor_id
  ) returning id into v_tx_id;

  -- 11. Simpan baris alokasi sesuai mode (hanya dari hasil kalkulasi server)
  if coalesce(p_is_split_bill, false) and p_split_bill_type = 'by_item' then
    for v_alloc_item in
      select * from jsonb_to_recordset(v_calculated_items) as x(
        order_item_id uuid,
        allocated_quantity integer,
        allocated_line_subtotal integer,
        allocated_discount_share integer,
        allocated_service_share integer,
        allocated_tax_share integer,
        allocated_rounding_adjustment integer,
        allocated_final_amount integer
      )
    loop
      insert into public.order_allocations (
        order_id,
        allocation_type,
        order_item_id,
        allocated_quantity,
        allocated_line_subtotal,
        allocated_discount_share,
        allocated_service_share,
        allocated_tax_share,
        allocated_rounding_adjustment,
        allocated_final_amount,
        midtrans_transaction_id,
        allocation_status
      ) values (
        p_order_id,
        'by_item',
        v_alloc_item.order_item_id,
        v_alloc_item.allocated_quantity,
        v_alloc_item.allocated_line_subtotal,
        v_alloc_item.allocated_discount_share,
        v_alloc_item.allocated_service_share,
        v_alloc_item.allocated_tax_share,
        coalesce(v_alloc_item.allocated_rounding_adjustment, 0),
        v_alloc_item.allocated_final_amount,
        v_tx_id,
        'reserved'
      );
    end loop;
  elsif coalesce(p_is_split_bill, false) and p_split_bill_type = 'custom_amount' then
    insert into public.order_allocations (
      order_id,
      allocation_type,
      order_item_id,
      allocated_quantity,
      allocated_line_subtotal,
      allocated_discount_share,
      allocated_service_share,
      allocated_tax_share,
      allocated_rounding_adjustment,
      allocated_final_amount,
      midtrans_transaction_id,
      allocation_status
    ) values (
      p_order_id,
      'custom_amount',
      null,
      null,
      v_calc_net_line,
      v_calc_disc_share,
      v_calc_serv_share,
      v_calc_tax_share,
      v_calc_rounding,
      p_gross_amount,
      v_tx_id,
      'reserved'
    );
  else
    -- Non-split bill (mode 'full')
    insert into public.order_allocations (
      order_id,
      allocation_type,
      order_item_id,
      allocated_quantity,
      allocated_line_subtotal,
      allocated_discount_share,
      allocated_service_share,
      allocated_tax_share,
      allocated_rounding_adjustment,
      allocated_final_amount,
      midtrans_transaction_id,
      allocation_status
    ) values (
      p_order_id,
      'full',
      null,
      null,
      v_calc_net_line,
      v_calc_disc_share,
      v_calc_serv_share,
      v_calc_tax_share,
      0,
      v_calc_final_amount,
      v_tx_id,
      'reserved'
    );
  end if;

  return jsonb_build_object(
    'midtrans_transaction_id', v_tx_id,
    'midtrans_order_id', v_midtrans_order_id,
    'attempt_number', v_attempt_number,
    'gross_amount', p_gross_amount,
    'available_amount_after', v_available_amount - p_gross_amount,
    'idempotent_replay', false
  );

end;
$$;

revoke all on function public.create_midtrans_snap_transaction(uuid, integer, text, timestamptz, timestamptz, boolean, text, jsonb) from public, anon, service_role;
grant execute on function public.create_midtrans_snap_transaction(uuid, integer, text, timestamptz, timestamptz, boolean, text, jsonb) to authenticated;


-- =============================================================================
-- 10. RPC PERSISTENSI SNAP TOKEN (HANYA UNTUK SERVICE_ROLE)
-- =============================================================================

create or replace function public.update_midtrans_snap_details(
  p_midtrans_transaction_id uuid,
  p_snap_token text,
  p_snap_redirect_url text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trx record;
  v_clean_token text;
  v_clean_url text;
begin
  if p_midtrans_transaction_id is null then
    raise exception 'ID transaksi Midtrans wajib diisi.';
  end if;

  v_clean_token := nullif(btrim(p_snap_token), '');
  v_clean_url := nullif(btrim(p_snap_redirect_url), '');

  if v_clean_token is null or char_length(v_clean_token) < 10 then
    raise exception 'Snap token tidak valid.';
  end if;

  if v_clean_url is null or v_clean_url not like 'https://%' then
    raise exception 'Snap redirect URL tidak valid, wajib protokol HTTPS.';
  end if;

  select * into v_trx
  from public.midtrans_transactions
  where id = p_midtrans_transaction_id
  for update;

  if not found then
    raise exception 'Transaksi Midtrans % tidak ditemukan.', p_midtrans_transaction_id;
  end if;

  -- Idempotency: jika token dan url sudah sama dan status token_created, langsung sukses
  if v_trx.lifecycle_status = 'token_created'
     and v_trx.snap_token = v_clean_token
     and v_trx.snap_redirect_url = v_clean_url then
    return jsonb_build_object(
      'status', 'success',
      'midtrans_transaction_id', v_trx.id,
      'lifecycle_status', v_trx.lifecycle_status,
      'is_idempotent_replay', true
    );
  end if;

  -- Transisi status yang sah: hanya boleh dari 'initiated'
  if v_trx.lifecycle_status <> 'initiated' then
    raise exception 'Snap details hanya dapat disimpan untuk transaksi berstatus initiated (Status saat ini: %).', v_trx.lifecycle_status;
  end if;

  update public.midtrans_transactions
  set
    snap_token = v_clean_token,
    snap_redirect_url = v_clean_url,
    lifecycle_status = 'token_created',
    updated_at = pg_catalog.now()
  where id = v_trx.id;

  -- Audit log tanpa mencatat token sensitif
  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'midtrans.snap_token_created',
    v_trx.created_by,
    'midtrans_transactions',
    v_trx.id::text,
    jsonb_build_object(
      'midtrans_order_id', v_trx.midtrans_order_id,
      'order_id', v_trx.order_id,
      'gross_amount', v_trx.gross_amount,
      'has_redirect_url', true
    )
  );

  return jsonb_build_object(
    'status', 'success',
    'midtrans_transaction_id', v_trx.id,
    'lifecycle_status', 'token_created',
    'is_idempotent_replay', false
  );
end;
$$;

revoke all on function public.update_midtrans_snap_details(uuid, text, text) from public, anon, authenticated;
grant execute on function public.update_midtrans_snap_details(uuid, text, text) to service_role;


-- =============================================================================
-- 11. RPC EKSEKUSI WEBHOOK SETTLEMENT (HANYA UNTUK SERVICE_ROLE)
-- =============================================================================

create or replace function public.execute_midtrans_webhook_settlement(
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_fingerprint text;
  v_event_id bigint;
  v_sanitized_payload jsonb;
  v_existing_event record;
  v_retry_loop integer;
  v_lock_retry integer;
  v_relation_matched boolean := false;

  v_midtrans_order_id text;
  v_transaction_status text;
  v_fraud_status text;
  v_currency text;
  v_raw_gross text;
  v_gross_numeric numeric;
  v_gross_amount integer;

  v_trx record;
  v_pre_order record;
  v_order record;
  v_dining_table record;
  v_dining_session record;
  v_payment_result jsonb;
  v_payment_id uuid;
begin

  v_midtrans_order_id := p_payload ->> 'order_id';
  v_transaction_status := p_payload ->> 'transaction_status';
  v_fraud_status := p_payload ->> 'fraud_status';
  v_currency := p_payload ->> 'currency';
  v_raw_gross := p_payload ->> 'gross_amount';

  if v_midtrans_order_id is null or btrim(v_midtrans_order_id) = '' then
    raise exception 'Payload webhook tidak memiliki order_id.';
  end if;

  -- 1. Sanitasi signature_key sebelum penyimpanan log durable
  v_sanitized_payload := p_payload - 'signature_key';

  -- 2. Hitung fingerprint webhook event SHA-256 lengkap
  v_event_fingerprint := encode(
    sha256(
      convert_to(
        coalesce(v_midtrans_order_id, '') || ':' ||
        coalesce(p_payload->>'status_code', '') || ':' ||
        coalesce(v_raw_gross, '') || ':' ||
        coalesce(v_currency, '') || ':' ||
        coalesce(v_transaction_status, '') || ':' ||
        coalesce(v_fraud_status, '') || ':' ||
        coalesce(p_payload->>'transaction_id', ''),
        'utf8'
      )
    ),
    'hex'
  );

  -- 3. Catat webhook event secara durable dengan ON CONFLICT DO NOTHING
  insert into public.midtrans_webhook_events (
    event_fingerprint,
    midtrans_order_id,
    transaction_id,
    raw_status,
    processing_result,
    sanitized_payload
  ) values (
    v_event_fingerprint,
    v_midtrans_order_id,
    p_payload->>'transaction_id',
    coalesce(substring(v_transaction_status from 1 for 32), 'unknown'),
    'received',
    v_sanitized_payload
  )
  on conflict (event_fingerprint) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    -- Kunci baris event yang berkonflik untuk serialisasi deterministik.
    -- Jika transaksi konkuren (T1) mengarsipkan baris failed dan menyisipkan baris baru,
    -- EvalPlanQual pada query awal dapat mengeliminasi tuple lama karena perubahan fingerprint.
    -- Di bawah isolasi READ COMMITTED PL/pgSQL, statement SELECT berikutnya mengambil snapshot baru
    -- sehingga dapat menemukan dan mengunci baris aktif baru yang disisipkan oleh T1.
    for v_retry_loop in 1..3 loop
      select id, processing_result, delivery_attempts into v_existing_event
      from public.midtrans_webhook_events
      where event_fingerprint = v_event_fingerprint
      for update;

      if found and v_existing_event.id is not null then
        exit;
      end if;
    end loop;

    -- Jika setelah retry loop baris tetap tidak ditemukan (misal transaksi konkuren belum commit atau rollback),
    -- JANGAN PERNAH mengembalikan ignored_duplicate! Kembalikan status failed agar gateway Midtrans menjadwalkan retry.
    if v_existing_event.id is null then
      return jsonb_build_object(
        'status', 'failed',
        'error', 'CONCURRENT_EVENT_LOCK_RETRY_EXHAUSTED',
        'message', 'Gagal mengunci event webhook aktif pada serialisasi konkurensi. Menjadwalkan retry gateway.',
        'event_fingerprint', v_event_fingerprint,
        'midtrans_order_id', v_midtrans_order_id
      );
    end if;

    -- A. Jika event sebelumnya GAGAL (failed):
    -- Ambil alih event secara atomik di dalam database untuk pemrosesan ulang (reprocessing).
    -- Arsipkan baris gagal lama dengan menambahkan suffix id (:failed_<id>) yang dijamin unik secara absolut.
    if v_existing_event.processing_result = 'failed' then
      update public.midtrans_webhook_events
      set event_fingerprint = v_event_fingerprint || ':failed_' || v_existing_event.id::text
      where id = v_existing_event.id;

      -- Sisipkan event baru yang aktif dengan delivery_attempts terinkrementasi
      insert into public.midtrans_webhook_events (
        event_fingerprint,
        midtrans_order_id,
        transaction_id,
        raw_status,
        processing_result,
        delivery_attempts,
        is_duplicate,
        sanitized_payload
      ) values (
        v_event_fingerprint,
        v_midtrans_order_id,
        p_payload->>'transaction_id',
        coalesce(substring(v_transaction_status from 1 for 32), 'unknown'),
        'received',
        v_existing_event.delivery_attempts + 1,
        true,
        v_sanitized_payload
      )
      returning id into v_event_id;

    -- B. Jika event sebelumnya sedang diproses / fraud challenge
    elsif v_existing_event.processing_result = 'processing' then
      update public.midtrans_webhook_events
      set
        delivery_attempts = delivery_attempts + 1,
        last_delivery_at = pg_catalog.now(),
        is_duplicate = true
      where id = v_existing_event.id;

      return jsonb_build_object(
        'status', 'capture_challenge',
        'event_fingerprint', v_event_fingerprint,
        'midtrans_order_id', v_midtrans_order_id
      );

    -- C. Jika event sebelumnya dikarantina rekonsiliasi manual
    elsif v_existing_event.processing_result = 'reconciliation_flagged' then
      update public.midtrans_webhook_events
      set
        delivery_attempts = delivery_attempts + 1,
        last_delivery_at = pg_catalog.now(),
        is_duplicate = true
      where id = v_existing_event.id;

      return jsonb_build_object(
        'status', 'already_in_reconciliation',
        'event_fingerprint', v_event_fingerprint,
        'midtrans_order_id', v_midtrans_order_id
      );

    -- D. Jika event sebelumnya sudah settled / terminal / ignored: duplikat diabaikan
    elsif v_existing_event.processing_result in ('settled', 'terminal_released', 'ignored_duplicate', 'ignored_out_of_order') then
      update public.midtrans_webhook_events
      set
        delivery_attempts = delivery_attempts + 1,
        last_delivery_at = pg_catalog.now(),
        is_duplicate = true
      where id = v_existing_event.id;

      return jsonb_build_object(
        'status', 'ignored_duplicate',
        'event_fingerprint', v_event_fingerprint,
        'midtrans_order_id', v_midtrans_order_id
      );

    -- E. State tak terduga lainnya (misal: 'received' dari transaksi lain yang masih berlangsung)
    else
      update public.midtrans_webhook_events
      set
        delivery_attempts = delivery_attempts + 1,
        last_delivery_at = pg_catalog.now(),
        is_duplicate = true
      where id = v_existing_event.id;

      return jsonb_build_object(
        'status', 'failed',
        'error', 'UNEXPECTED_EVENT_PROCESSING_STATE',
        'message', 'Event webhook sedang dalam status ' || coalesce(v_existing_event.processing_result, 'NULL') || '. Menjadwalkan retry gateway.',
        'event_fingerprint', v_event_fingerprint,
        'midtrans_order_id', v_midtrans_order_id
      );
    end if;
  end if;

  -- 4. Validasi ketersediaan gross_amount
  if v_raw_gross is null or btrim(v_raw_gross) = '' then
    update public.midtrans_webhook_events
    set processing_result = 'failed',
        error_message = 'MISSING_GROSS_AMOUNT: Payload webhook tidak memiliki gross_amount.',
        processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'failed',
      'error', 'MISSING_GROSS_AMOUNT',
      'message', 'Payload webhook tidak memiliki gross_amount.'
    );
  end if;

  -- 5. Whitelist transaction_status resmi Midtrans
  if v_transaction_status is null
     or v_transaction_status not in (
       'capture',
       'settlement',
       'pending',
       'deny',
       'cancel',
       'expire',
       'refund',
       'partial_refund',
       'chargeback',
       'partial_chargeback'
     ) then
    update public.midtrans_webhook_events
    set processing_result = 'failed',
        error_message = 'INVALID_TRANSACTION_STATUS: Status transaksi ' || coalesce(v_transaction_status, 'null') || ' tidak valid atau tidak didukung.',
        processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'failed',
      'error', 'INVALID_TRANSACTION_STATUS',
      'message', 'Status transaksi tidak valid atau tidak didukung: ' || coalesce(v_transaction_status, 'null')
    );
  end if;

  -- 6. Validasi mata uang wajib ada dan wajib IDR
  if v_currency is null or btrim(v_currency) = '' then
    update public.midtrans_webhook_events
    set processing_result = 'failed',
        error_message = 'MISSING_CURRENCY',
        processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'failed',
      'error', 'MISSING_CURRENCY',
      'message', 'Mata uang wajib disertakan dalam payload webhook.'
    );
  end if;

  if btrim(v_currency) <> 'IDR' then
    update public.midtrans_webhook_events
    set processing_result = 'failed',
        error_message = 'INVALID_CURRENCY',
        processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'failed',
      'error', 'INVALID_CURRENCY',
      'message', 'Mata uang ' || v_currency || ' tidak didukung, hanya IDR yang diperbolehkan.'
    );
  end if;

  -- 7. Parsing numerik presisi tanpa pembulatan mengambang
  begin
    v_gross_numeric := v_raw_gross::numeric;
  exception when others then
    update public.midtrans_webhook_events
    set processing_result = 'failed',
        error_message = 'INVALID_GROSS_AMOUNT',
        processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'failed',
      'error', 'INVALID_GROSS_AMOUNT',
      'message', 'Format nominal ' || v_raw_gross || ' bukan angka valid.'
    );
  end;

  -- Tolak nominal pecahan rupiah (desimal non-nol)
  if v_gross_numeric <> trunc(v_gross_numeric) then
    update public.midtrans_webhook_events
    set processing_result = 'failed',
        error_message = 'FRACTIONAL_IDR_REJECTED',
        processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'failed',
      'error', 'FRACTIONAL_IDR_REJECTED',
      'message', 'Nominal pecahan rupiah (' || v_raw_gross || ') tidak diperbolehkan.'
    );
  end if;

  if v_gross_numeric <= 0 or v_gross_numeric > 2147483647 then
    update public.midtrans_webhook_events
    set processing_result = 'failed',
        error_message = 'OUT_OF_RANGE_GROSS_AMOUNT',
        processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'failed',
      'error', 'OUT_OF_RANGE_GROSS_AMOUNT',
      'message', 'Nominal (' || v_raw_gross || ') berada di luar batas yang diperbolehkan.'
    );
  end if;

  -- 8. Pre-read transaksi dan pesanan
  select id, order_id, gross_amount, lifecycle_status, created_by
  into v_trx
  from public.midtrans_transactions
  where midtrans_order_id = v_midtrans_order_id;

  if not found then
    update public.midtrans_webhook_events
    set processing_result = 'failed',
        error_message = 'TRANSACTION_NOT_FOUND',
        processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'failed',
      'error', 'TRANSACTION_NOT_FOUND',
      'message', 'Transaksi Midtrans ' || v_midtrans_order_id || ' tidak terdaftar.'
    );
  end if;

  -- 8. Strict Hierarchical Locking dengan Validasi Relasi dan Safe Retry
  -- Urutan kanonikal: dining_tables -> dining_sessions -> orders -> midtrans_transactions
  v_relation_matched := false;
  for v_lock_retry in 1..3 loop
    begin
      -- Pre-read relasi pesanan
      select id, order_type, table_id, dining_session_id
      into v_pre_order
      from public.orders
      where id = v_trx.order_id;

      if not found then
        update public.midtrans_webhook_events
        set processing_result = 'failed',
            error_message = 'ORDER_NOT_FOUND',
            processed_at = pg_catalog.now()
        where id = v_event_id;

        return jsonb_build_object(
          'status', 'failed',
          'error', 'ORDER_NOT_FOUND',
          'message', 'Pesanan ' || v_trx.order_id::text || ' tidak ditemukan.'
        );
      end if;

      -- Kunci meja dan sesi terlebih dahulu jika bertipe dine-in
      if v_pre_order.order_type = 'dine_in' then
        if v_pre_order.table_id is not null then
          perform 1 from public.dining_tables where id = v_pre_order.table_id for update;
        end if;
        if v_pre_order.dining_session_id is not null then
          perform 1 from public.dining_sessions where id = v_pre_order.dining_session_id for update;
        end if;
      end if;

      -- Kunci pesanan
      select * into v_order from public.orders where id = v_trx.order_id for update;

      -- Validasi anti-race condition: pastikan relasi pesanan tidak berubah sebelum lock diperoleh
      if (v_order.order_type is distinct from v_pre_order.order_type)
         or (v_order.table_id is distinct from v_pre_order.table_id)
         or (v_order.dining_session_id is distinct from v_pre_order.dining_session_id) then
        raise exception 'ORDER_RELATION_MUTATED';
      end if;

      v_relation_matched := true;
      exit; -- Kunci meja, sesi, dan pesanan berhasil diperoleh secara konsisten
    exception
      when others then
        if sqlerrm = 'ORDER_RELATION_MUTATED' and v_lock_retry < 3 then
          -- Subtransaksi otomatis di-rollback oleh exception handler PostgreSQL,
          -- melepaskan lock parsial lama agar iterasi berikutnya mengunci meja/sesi baru dari awal
          continue;
        elsif sqlerrm = 'ORDER_RELATION_MUTATED' then
          update public.midtrans_webhook_events
          set processing_result = 'failed',
              error_message = 'ORDER_RELATION_LOCK_MUTATED: Relasi pesanan berubah berulang kali saat penguncian.',
              processed_at = pg_catalog.now()
          where id = v_event_id;

          return jsonb_build_object(
            'status', 'failed',
            'error', 'ORDER_RELATION_LOCK_MUTATED',
            'message', 'Relasi pesanan berubah saat penguncian hierarkis. Menjadwalkan retry gateway.'
          );
        else
          raise;
        end if;
    end;
  end loop;

  -- Kunci transaksi Midtrans setelah relasi meja, sesi, dan pesanan terkunci rapi
  select * into v_trx
  from public.midtrans_transactions
  where id = v_trx.id
  for update;

  -- 9. Ambil data detail meja dan sesi setelah seluruh lock hierarkis diperoleh
  if v_order.order_type = 'dine_in' and v_order.table_id is not null then
    select * into v_dining_table from public.dining_tables where id = v_order.table_id;
    select * into v_dining_session from public.dining_sessions where id = v_order.dining_session_id;
  end if;

  -- 10. Validasi ketat nominal transaksi setelah lock diperoleh
  if v_gross_numeric <> v_trx.gross_amount::numeric then
    update public.midtrans_transactions
    set
      lifecycle_status = 'reconciliation_required',
      midtrans_transaction_status = v_transaction_status,
      sanitized_response = v_sanitized_payload,
      updated_at = pg_catalog.now()
    where id = v_trx.id;

    insert into public.audit_logs (
      action,
      user_id,
      entity,
      entity_id,
      details
    ) values (
      'webhook.gross_amount_mismatch',
      v_trx.created_by,
      'midtrans_transactions',
      v_trx.id::text,
      jsonb_build_object(
        'midtrans_order_id', v_midtrans_order_id,
        'expected_amount', v_trx.gross_amount,
        'received_amount', v_gross_numeric,
        'raw_payload_amount', v_raw_gross
      )
    );

    update public.midtrans_webhook_events
    set processing_result = 'reconciliation_flagged', processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'reconciliation_required_amount_mismatch',
      'expected_amount', v_trx.gross_amount,
      'received_amount', v_gross_numeric
    );
  end if;

  v_gross_amount := v_trx.gross_amount;

  -- 10b. Penanganan eksplisit refund dan chargeback
  -- Status ini TIDAK BOLEH diabaikan oleh pemeriksaan lifecycle_status = 'settled'.
  -- Karena belum tersedia proses pembalikan otomatis yang aman, transaksi wajib dimasukkan ke reconciliation_required,
  -- webhook event ditandai reconciliation_flagged, dan audit log dicatat untuk tindakan rekonsiliasi manual.
  if v_transaction_status in ('refund', 'partial_refund', 'chargeback', 'partial_chargeback') then
    update public.midtrans_transactions
    set
      lifecycle_status = 'reconciliation_required',
      midtrans_transaction_status = v_transaction_status,
      sanitized_response = v_sanitized_payload,
      updated_at = pg_catalog.now()
    where id = v_trx.id;

    insert into public.audit_logs (
      action,
      user_id,
      entity,
      entity_id,
      details
    ) values (
      case
        when v_transaction_status in ('refund', 'partial_refund') then 'webhook.refund_received'
        else 'webhook.chargeback_received'
      end,
      coalesce(v_trx.created_by, v_order.created_by),
      'midtrans_transactions',
      v_trx.id::text,
      jsonb_build_object(
        'midtrans_order_id', v_midtrans_order_id,
        'order_id', v_trx.order_id,
        'previous_lifecycle_status', v_trx.lifecycle_status,
        'received_status', v_transaction_status,
        'gross_amount', v_gross_amount,
        'refund_amount', p_payload->>'refund_amount',
        'refund_key', p_payload->>'refund_key',
        'action_needed', 'manual_reconciliation_required'
      )
    );

    update public.midtrans_webhook_events
    set processing_result = 'reconciliation_flagged', processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'reconciliation_required_' || v_transaction_status,
      'transaction_status', v_transaction_status,
      'previous_lifecycle_status', v_trx.lifecycle_status,
      'midtrans_order_id', v_midtrans_order_id
    );
  end if;

  -- Idempotency check: jika sudah settled, abaikan mutasi ulang
  if v_trx.lifecycle_status = 'settled' then
    update public.midtrans_webhook_events
    set processing_result = 'ignored_duplicate', processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'already_settled',
      'order_id', v_trx.order_id,
      'midtrans_order_id', v_midtrans_order_id
    );
  end if;

  -- 11. Validasi transisi status terminal (expired, cancelled, denied)
  if v_trx.lifecycle_status in ('expired', 'cancelled', 'denied') then
    -- Cegah status terminal mundur kembali menjadi pending
    if v_transaction_status = 'pending' then
      update public.midtrans_webhook_events
      set processing_result = 'ignored_out_of_order', processed_at = pg_catalog.now()
      where id = v_event_id;

      return jsonb_build_object(
        'status', 'ignored_terminal_to_pending',
        'current_lifecycle_status', v_trx.lifecycle_status,
        'midtrans_order_id', v_midtrans_order_id
      );
    end if;

    -- Settlement atau capture yang tiba setelah status terminal harus masuk reconciliation_required
    if v_transaction_status in ('settlement', 'capture') then
      update public.midtrans_transactions
      set
        lifecycle_status = 'reconciliation_required',
        midtrans_transaction_status = v_transaction_status,
        sanitized_response = v_sanitized_payload,
        updated_at = pg_catalog.now()
      where id = v_trx.id;

      insert into public.audit_logs (
        action,
        user_id,
        entity,
        entity_id,
        details
      ) values (
        'webhook.settlement_after_terminal_state',
        v_trx.created_by,
        'midtrans_transactions',
        v_trx.id::text,
        jsonb_build_object(
          'midtrans_order_id', v_midtrans_order_id,
          'order_id', v_trx.order_id,
          'terminal_status', v_trx.lifecycle_status,
          'received_status', v_transaction_status,
          'gross_amount', v_gross_amount,
          'action_needed', 'manual_reconciliation_required'
        )
      );

      update public.midtrans_webhook_events
      set processing_result = 'reconciliation_flagged', processed_at = pg_catalog.now()
      where id = v_event_id;

      return jsonb_build_object(
        'status', 'reconciliation_required_terminal_settlement',
        'terminal_status', v_trx.lifecycle_status,
        'midtrans_order_id', v_midtrans_order_id
      );
    end if;

    update public.midtrans_webhook_events
    set processing_result = 'terminal_released', processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'already_terminal',
      'lifecycle_status', v_trx.lifecycle_status,
      'midtrans_order_id', v_midtrans_order_id
    );
  end if;

  if v_trx.lifecycle_status = 'reconciliation_required' then
    update public.midtrans_webhook_events
    set processing_result = 'reconciliation_flagged', processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'already_in_reconciliation',
      'midtrans_order_id', v_midtrans_order_id
    );
  end if;

  -- 12. Kasus khusus: pesanan dibatalkan sebelum webhook tiba
  if v_order.status = 'cancelled' then
    update public.midtrans_transactions
    set
      lifecycle_status = 'reconciliation_required',
      midtrans_transaction_status = v_transaction_status,
      sanitized_response = v_sanitized_payload,
      updated_at = pg_catalog.now()
    where id = v_trx.id;

    insert into public.audit_logs (
      action,
      user_id,
      entity,
      entity_id,
      details
    ) values (
      'webhook.settlement_after_order_cancelled',
      v_trx.created_by,
      'midtrans_transactions',
      v_trx.id::text,
      jsonb_build_object(
        'midtrans_order_id', v_midtrans_order_id,
        'order_id', v_order.id,
        'gross_amount', v_gross_amount,
        'action_needed', 'manual_refund_required'
      )
    );

    update public.midtrans_webhook_events
    set processing_result = 'reconciliation_flagged', processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'reconciliation_required_order_cancelled',
      'midtrans_order_id', v_midtrans_order_id
    );
  end if;

  -- 13. Penanganan capture challenge (fraud_status <> 'accept')
  if v_transaction_status = 'capture' and coalesce(v_fraud_status, '') <> 'accept' then
    update public.midtrans_transactions
    set
      lifecycle_status = 'capture_challenge',
      midtrans_transaction_status = 'capture',
      sanitized_response = v_sanitized_payload,
      updated_at = pg_catalog.now()
    where id = v_trx.id;

    update public.midtrans_webhook_events
    set processing_result = 'processing', processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'capture_challenge',
      'fraud_status', v_fraud_status
    );
  end if;

  -- Cegah webhook pending menurunkan status capture_challenge
  if v_transaction_status = 'pending' and v_trx.lifecycle_status = 'capture_challenge' then
    update public.midtrans_webhook_events
    set processing_result = 'ignored_out_of_order', processed_at = pg_catalog.now()
    where id = v_event_id;

    return jsonb_build_object(
      'status', 'ignored_capture_challenge_to_pending',
      'current_lifecycle_status', v_trx.lifecycle_status
    );
  end if;

  -- 14. Eksekusi settlement pembayaran resmi F2.1
  if v_transaction_status = 'settlement' or (v_transaction_status = 'capture' and v_fraud_status = 'accept') then

    -- Eksekusi pembayaran melalui mesin resmi F2.1 (tepat 10 parameter)
    v_payment_result := public.execute_order_payment_internal(
      v_order.id,
      'midtrans',
      'midtrans_snap',
      v_gross_amount,
      null,
      0,
      v_midtrans_order_id,
      'MT-WH-' || v_midtrans_order_id,
      'Midtrans Snap settlement',
      coalesce(v_trx.created_by, v_order.created_by)
    );

    -- Validasi ketat hasil RPC pembayaran internal
    if v_payment_result is null
       or (v_payment_result ->> 'payment_status') is distinct from 'success'
       or (v_payment_result ->> 'payment_id') is null
       or btrim(v_payment_result ->> 'payment_id') = '' then
      raise exception 'PAYMENT_EXECUTION_FAILED: Mesin pembayaran gagal memproses settlement order % (Hasil: %).',
        v_order.id,
        coalesce(v_payment_result::text, 'NULL');
    end if;

    begin
      v_payment_id := (v_payment_result ->> 'payment_id')::uuid;
    exception
      when others then
        raise exception 'INVALID_PAYMENT_ID: ID pembayaran % yang dihasilkan tidak valid UUID.',
          v_payment_result ->> 'payment_id';
    end;

    -- Update status transaksi gateway
    update public.midtrans_transactions
    set
      lifecycle_status = 'settled',
      midtrans_transaction_status = v_transaction_status,
      settled_at = pg_catalog.now(),
      sanitized_response = v_sanitized_payload,
      updated_at = pg_catalog.now()
    where id = v_trx.id;

    -- Update alokasi split bill (otomatis memicu audit ledger via trigger)
    update public.order_allocations
    set
      allocation_status = 'settled',
      payment_id = v_payment_id,
      updated_at = pg_catalog.now()
    where midtrans_transaction_id = v_trx.id
      and allocation_status = 'reserved';

    update public.midtrans_webhook_events
    set processing_result = 'settled', processed_at = pg_catalog.now()
    where id = v_event_id;

  elsif v_transaction_status in ('expire', 'cancel', 'deny') then

    update public.midtrans_transactions
    set
      lifecycle_status = case
        when v_transaction_status = 'expire' then 'expired'
        when v_transaction_status = 'cancel' then 'cancelled'
        else 'denied'
      end,
      midtrans_transaction_status = v_transaction_status,
      sanitized_response = v_sanitized_payload,
      updated_at = pg_catalog.now()
    where id = v_trx.id;

    -- Pelepasan alokasi (otomatis memicu audit ledger via trigger)
    update public.order_allocations
    set
      allocation_status = 'released',
      updated_at = pg_catalog.now()
    where midtrans_transaction_id = v_trx.id
      and allocation_status = 'reserved';

    update public.midtrans_webhook_events
    set processing_result = 'terminal_released', processed_at = pg_catalog.now()
    where id = v_event_id;

  elsif v_transaction_status = 'pending' then

    update public.midtrans_transactions
    set
      lifecycle_status = 'pending',
      midtrans_transaction_status = 'pending',
      sanitized_response = v_sanitized_payload,
      updated_at = pg_catalog.now()
    where id = v_trx.id;

    update public.midtrans_webhook_events
    set processing_result = 'processing', processed_at = pg_catalog.now()
    where id = v_event_id;

  end if;

  return jsonb_build_object(
    'status', 'success',
    'lifecycle_status', v_transaction_status,
    'payment_result', v_payment_result
  );

end;
$$;

revoke all on function public.execute_midtrans_webhook_settlement(jsonb) from public, anon, authenticated;
grant execute on function public.execute_midtrans_webhook_settlement(jsonb) to service_role;


-- =============================================================================
-- 12. RPC PERSETUJUAN KHUSUS ADMIN: APPROVE_MIDTRANS_CAPTURE_CHALLENGE
-- =============================================================================

create or replace function public.approve_midtrans_capture_challenge(
  p_midtrans_transaction_id uuid,
  p_approval_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_profile record;
  v_trx record;
  v_pre_order record;
  v_order record;
  v_payment_result jsonb;
  v_payment_id uuid;
  v_lock_retry integer;
  v_relation_matched boolean := false;
begin

  v_actor_id := auth.uid();

  if v_actor_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select role, is_active into v_actor_profile
  from public.profiles
  where id = v_actor_id
  for share;

  if not found or not v_actor_profile.is_active or v_actor_profile.role <> 'admin' or public.current_user_role() <> 'admin' then
    raise exception 'Hanya Admin aktif yang berwenang menyetujui transaksi capture challenge.';
  end if;

  if p_approval_reason is null or char_length(btrim(p_approval_reason)) < 5 then
    raise exception 'Alasan persetujuan capture challenge wajib diisi minimal 5 karakter.';
  end if;

  -- 1. Pre-read
  select id, order_id, gross_amount, lifecycle_status, midtrans_order_id, created_by
  into v_trx
  from public.midtrans_transactions
  where id = p_midtrans_transaction_id;

  if not found then
    raise exception 'Transaksi Midtrans % tidak ditemukan.', p_midtrans_transaction_id;
  end if;

  -- Cek status: hanya capture_challenge yang boleh disetujui (mencegah persetujuan ganda)
  if v_trx.lifecycle_status <> 'capture_challenge' then
    raise exception 'Transaksi tidak berstatus capture_challenge (Status saat ini: %). Persetujuan tidak dapat diproses.', v_trx.lifecycle_status;
  end if;

  -- 2. Strict Hierarchical Locking dengan Validasi Relasi dan Safe Retry
  -- Urutan kanonikal: dining_tables -> dining_sessions -> orders -> midtrans_transactions
  v_relation_matched := false;
  for v_lock_retry in 1..3 loop
    begin
      select id, order_type, table_id, dining_session_id into v_pre_order
      from public.orders
      where id = v_trx.order_id;

      if not found then
        raise exception 'Pesanan % tidak ditemukan.', v_trx.order_id;
      end if;

      if v_pre_order.order_type = 'dine_in' then
        if v_pre_order.table_id is not null then
          perform 1 from public.dining_tables where id = v_pre_order.table_id for update;
        end if;
        if v_pre_order.dining_session_id is not null then
          perform 1 from public.dining_sessions where id = v_pre_order.dining_session_id for update;
        end if;
      end if;

      select * into v_order from public.orders where id = v_trx.order_id for update;

      if (v_order.order_type is distinct from v_pre_order.order_type)
         or (v_order.table_id is distinct from v_pre_order.table_id)
         or (v_order.dining_session_id is distinct from v_pre_order.dining_session_id) then
        raise exception 'ORDER_RELATION_MUTATED';
      end if;

      v_relation_matched := true;
      exit;
    exception
      when others then
        if sqlerrm = 'ORDER_RELATION_MUTATED' and v_lock_retry < 3 then
          continue;
        elsif sqlerrm = 'ORDER_RELATION_MUTATED' then
          raise exception 'Relasi pesanan berubah saat penguncian hierarkis. Silakan coba kembali.';
        else
          raise;
        end if;
    end;
  end loop;

  select * into v_trx from public.midtrans_transactions where id = p_midtrans_transaction_id for update;

  if v_trx.lifecycle_status <> 'capture_challenge' then
    raise exception 'Status transaksi telah berubah saat proses penguncian (Status: %).', v_trx.lifecycle_status;
  end if;

  -- 3. Eksekusi pembayaran melalui mesin resmi F2.1 (tepat 10 parameter)
  v_payment_result := public.execute_order_payment_internal(
    v_order.id,
    'midtrans',
    'midtrans_snap',
    v_trx.gross_amount,
    null,
    0,
    v_trx.midtrans_order_id,
    'MT-APPRV-' || v_trx.midtrans_order_id,
    'Midtrans capture challenge approved by admin: ' || btrim(p_approval_reason),
    v_actor_id
  );

  -- Validasi ketat hasil RPC pembayaran internal
  if v_payment_result is null
     or (v_payment_result ->> 'payment_status') is distinct from 'success'
     or (v_payment_result ->> 'payment_id') is null
     or btrim(v_payment_result ->> 'payment_id') = '' then
    raise exception 'PAYMENT_EXECUTION_FAILED: Mesin pembayaran gagal menyetujui capture challenge order % (Hasil: %).',
      v_order.id,
      coalesce(v_payment_result::text, 'NULL');
  end if;

  begin
    v_payment_id := (v_payment_result ->> 'payment_id')::uuid;
  exception
    when others then
      raise exception 'INVALID_PAYMENT_ID: ID pembayaran % yang dihasilkan tidak valid UUID.',
        v_payment_result ->> 'payment_id';
  end;

  -- 4. Update status transaksi gateway
  update public.midtrans_transactions
  set
    lifecycle_status = 'settled',
    midtrans_transaction_status = 'capture_approved',
    settled_at = pg_catalog.now(),
    updated_at = pg_catalog.now()
  where id = v_trx.id;

  -- 5. Update alokasi split bill (otomatis memicu audit ledger via trigger)
  update public.order_allocations
  set
    allocation_status = 'settled',
    payment_id = v_payment_id,
    updated_at = pg_catalog.now()
  where midtrans_transaction_id = v_trx.id
    and allocation_status = 'reserved';

  -- 6. Pencatatan audit trail resmi (5 parameter)
  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'midtrans.capture_challenge.approved',
    v_actor_id,
    'midtrans_transactions',
    v_trx.id::text,
    jsonb_build_object(
      'midtrans_order_id', v_trx.midtrans_order_id,
      'order_id', v_order.id,
      'gross_amount', v_trx.gross_amount,
      'payment_id', v_payment_id,
      'reason', btrim(p_approval_reason)
    )
  );

  return jsonb_build_object(
    'status', 'success',
    'lifecycle_status', 'settled',
    'payment_result', v_payment_result
  );

end;
$$;

revoke all on function public.approve_midtrans_capture_challenge(uuid, text) from public, anon, service_role;
grant execute on function public.approve_midtrans_capture_challenge(uuid, text) to authenticated;


-- =============================================================================
-- 13. ROW LEVEL SECURITY (RLS) & PRIVILEGES (DCL)
-- =============================================================================

alter table public.midtrans_transactions enable row level security;
alter table public.order_allocations enable row level security;
alter table public.order_allocation_events enable row level security;
alter table public.midtrans_webhook_events enable row level security;

-- Policies SELECT Staff (Role Aktual: admin dan kasir)
drop policy if exists p_mt_staff_select on public.midtrans_transactions;
create policy p_mt_staff_select on public.midtrans_transactions
  for select to authenticated
  using (public.current_user_role() in ('admin', 'kasir'));

drop policy if exists p_oa_staff_select on public.order_allocations;
create policy p_oa_staff_select on public.order_allocations
  for select to authenticated
  using (public.current_user_role() in ('admin', 'kasir'));

drop policy if exists p_oae_staff_select on public.order_allocation_events;
create policy p_oae_staff_select on public.order_allocation_events
  for select to authenticated
  using (public.current_user_role() in ('admin', 'kasir'));

drop policy if exists p_mwe_admin_select on public.midtrans_webhook_events;
create policy p_mwe_admin_select on public.midtrans_webhook_events
  for select to authenticated
  using (public.current_user_role() = 'admin');

-- DCL midtrans_transactions: Larang mutasi langsung dari pengguna web/kasir
revoke all on public.midtrans_transactions from public, anon;
revoke insert, update, delete on public.midtrans_transactions from authenticated;
grant select on public.midtrans_transactions to authenticated;
grant all on public.midtrans_transactions to service_role;

-- DCL order_allocations: Larang mutasi langsung dari pengguna web/kasir
revoke all on public.order_allocations from public, anon;
revoke insert, update, delete on public.order_allocations from authenticated;
grant select on public.order_allocations to authenticated;
grant all on public.order_allocations to service_role;

-- DCL order_allocation_events: strictly append-only ledger
-- Cabut UPDATE dan DELETE dari service_role dan seluruh role lainnya
revoke all on public.order_allocation_events from public, anon, authenticated;
grant select on public.order_allocation_events to authenticated;

revoke all on public.order_allocation_events from service_role;
grant select, insert on public.order_allocation_events to service_role;

-- DCL midtrans_webhook_events: Akses eksklusif service_role
revoke all on public.midtrans_webhook_events from public, anon, authenticated;
grant all on public.midtrans_webhook_events to service_role;

commit;
