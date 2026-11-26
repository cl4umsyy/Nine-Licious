-- =============================================================================
-- NINE LICIOUS POS — REFUND SYSTEM MIGRATION R1: REFUND FOUNDATION
-- File: supabase/migrations/20261126000100_refund_r1_foundation.sql
--
-- TUJUAN:
-- 1. Memperluas tabel public.refunds untuk memisahkan status persetujuan
--    (approval_status), status pencairan uang (payout_status), dan jenis
--    penyelesaian (resolution_type: full_refund | partial_refund | replacement),
--    sambil mempertahankan penuh kompatibilitas kolom lama F2.4 & F6.
-- 2. Menambahkan tabel public.refund_items untuk melacak item spesifik,
--    tingkat kompensasi (25%/50%/100%), serta pajak/service charge secara terpisah.
-- 3. Menambahkan tabel public.refund_corrections untuk mencatat kekurangan
--    (under_refund) maupun kelebihan pengembalian (over_refund) tanpa
--    mengedit baris refund selesai atau melanggar orders_refunded_total_le_paid_total.
-- 4. Menambahkan tabel public.refund_payout_allocations untuk alokasi refund
--    Split Bill ke banyak payment_id dan metode payout berbeda.
--
-- PRINSIP KEAMANAN:
-- - Tidak mengubah data transaksi lama (hanya backfill aman non-destruktif).
-- - Role 'kitchen' dan 'anon' TIDAK diberi akses SELECT ke tabel finansial refund.
-- - Mutasi data tetap terkunci (REVOKE INSERT/UPDATE/DELETE dari klien) dan hanya
--   dapat dilakukan melalui RPC SECURITY DEFINER pada R5 / F2.4.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. PENGEMBANGAN TABEL public.refunds
-- -----------------------------------------------------------------------------

-- 1a. Hapus constraint inline lama secara dinamis agar aman di berbagai instance PostgreSQL
do $$
declare
  v_con record;
begin
  for v_con in
    select conname
    from pg_constraint
    where conrelid = 'public.refunds'::regclass
      and contype = 'c'
      and (
        pg_get_constraintdef(oid) ilike '%amount > 0%'
        or pg_get_constraintdef(oid) ilike '%status%'
        or pg_get_constraintdef(oid) ilike '%refund_type%'
        or pg_get_constraintdef(oid) ilike '%refund_method%'
        or conname in (
          'refunds_amount_check',
          'refunds_status_check',
          'refunds_refund_type_check',
          'refunds_refund_method_check',
          'refunds_resolution_type_check',
          'refunds_approval_status_check',
          'refunds_payout_status_check',
          'refunds_reason_category_check',
          'refunds_payout_method_check',
          'refunds_resolution_amount_check',
          'refunds_rejection_reason_check',
          'refunds_cancellation_reason_check'
        )
      )
  loop
    execute format('alter table public.refunds drop constraint if exists %I', v_con.conname);
  end loop;
end $$;

-- 1b. Tambahkan kolom baru secara idempoten (default sementara aman untuk data historis F2.4)
alter table public.refunds
  add column if not exists resolution_type text not null default 'partial_refund',
  add column if not exists approval_status text not null default 'approved',
  add column if not exists payout_status text not null default 'completed',
  add column if not exists reason_category text not null default 'other',
  add column if not exists chronology text,
  add column if not exists subtotal_amount integer not null default 0,
  add column if not exists discount_amount integer not null default 0,
  add column if not exists service_charge_amount integer not null default 0,
  add column if not exists tax_amount integer not null default 0,
  add column if not exists reference_service_charge_amount integer not null default 0,
  add column if not exists reference_tax_amount integer not null default 0,
  add column if not exists rounding_adjustment integer not null default 0,
  add column if not exists reviewed_by uuid references public.profiles (id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists rejection_reason text,
  add column if not exists cancellation_reason text,
  add column if not exists cancelled_by uuid references public.profiles (id) on delete set null,
  add column if not exists cancelled_at timestamptz,
  add column if not exists payout_method text,
  add column if not exists payout_reference text,
  add column if not exists payout_completed_at timestamptz,
  add column if not exists shift_id uuid references public.shifts (id) on delete set null,
  add column if not exists parent_refund_id uuid references public.refunds (id) on delete restrict,
  add column if not exists receipt_verified boolean not null default false;

comment on column public.refunds.resolution_type is
  'Jenis penyelesaian komplain: full_refund, partial_refund, atau replacement (amount = 0).';
comment on column public.refunds.approval_status is
  'Status keputusan persetujuan Admin terpisah dari pencairan: pending_approval, approved, rejected, cancelled.';
comment on column public.refunds.payout_status is
  'Status pencairan pengembalian dana: not_required, pending, processing, completed, failed, reconciliation_required.';
comment on column public.refunds.status is
  'Status transisi legacy F2.4/F6 (disinkronkan oleh RPC agar laporan dan rekonsiliasi lama tetap kompatibel).';

-- 1c. Backfill non-destruktif baris refund F2.4 yang sudah ada di database
update public.refunds
set
  resolution_type = case
    when refund_type = 'full' then 'full_refund'
    when refund_type = 'replacement' then 'replacement'
    else 'partial_refund'
  end,
  approval_status = case
    when status = 'rejected' then 'rejected'
    when status = 'cancelled' then 'cancelled'
    else 'approved'
  end,
  payout_status = case
    when status = 'completed' then 'completed'
    when status in ('pending', 'approved') then 'pending'
    else 'not_required'
  end,
  reviewed_by = coalesce(reviewed_by, approved_by),
  reviewed_at = coalesce(reviewed_at, approved_at),
  payout_method = coalesce(payout_method, refund_method),
  payout_completed_at = case
    when status = 'completed' then coalesce(payout_completed_at, approved_at, updated_at, created_at)
    else payout_completed_at
  end,
  shift_id = coalesce(
    shift_id,
    case
      when metadata ? 'shift_id'
       and nullif(btrim(metadata ->> 'shift_id'), '') is not null
       and (metadata ->> 'shift_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      then (metadata ->> 'shift_id')::uuid
      else null
    end
  )
where true;

-- 1d. Sesuaikan default kolom untuk alur pengajuan baru pasca-migrasi
alter table public.refunds
  alter column approval_status set default 'pending_approval',
  alter column payout_status set default 'not_required',
  alter column status set default 'pending';

-- 1e. Pasang CHECK constraints terstruktur
alter table public.refunds
  add constraint refunds_refund_type_check
    check (refund_type in ('full', 'partial', 'replacement')),
  add constraint refunds_refund_method_check
    check (refund_method in ('none', 'cash', 'transfer', 'midtrans', 'manual', 'mixed')),
  add constraint refunds_status_check
    check (status in ('pending', 'approved', 'rejected', 'completed', 'cancelled')),
  add constraint refunds_resolution_type_check
    check (resolution_type in ('full_refund', 'partial_refund', 'replacement')),
  add constraint refunds_approval_status_check
    check (approval_status in ('pending_approval', 'approved', 'rejected', 'cancelled')),
  add constraint refunds_payout_status_check
    check (payout_status in ('not_required', 'pending', 'processing', 'completed', 'failed', 'reconciliation_required')),
  add constraint refunds_reason_category_check
    check (reason_category in (
      'stock_unavailable',
      'wrong_order',
      'missing_item',
      'food_quality',
      'long_waiting_time',
      'payment_issue',
      'other'
    )),
  add constraint refunds_payout_method_check
    check (payout_method is null or payout_method in ('none', 'cash', 'transfer', 'midtrans', 'manual', 'mixed')),
  add constraint refunds_financial_components_non_negative_check
    check (
      amount >= 0
      and subtotal_amount >= 0
      and discount_amount >= 0
      and service_charge_amount >= 0
      and tax_amount >= 0
      and reference_service_charge_amount >= 0
      and reference_tax_amount >= 0
    ),
  add constraint refunds_resolution_amount_check
    check (
      (resolution_type = 'replacement' and amount = 0)
      or (resolution_type in ('full_refund', 'partial_refund') and amount > 0)
    ),
  add constraint refunds_rejection_reason_check
    check (
      approval_status <> 'rejected'
      or (rejection_reason is not null and char_length(btrim(rejection_reason)) >= 3)
    ),
  add constraint refunds_cancellation_reason_check
    check (
      approval_status <> 'cancelled'
      or (
        cancellation_reason is not null
        and char_length(btrim(cancellation_reason)) >= 3
        and cancelled_by is not null
        and cancelled_at is not null
      )
    );

create index if not exists refunds_approval_status_idx
  on public.refunds (approval_status, created_at desc);

create index if not exists refunds_payout_status_idx
  on public.refunds (payout_status, created_at desc);

create index if not exists refunds_resolution_type_idx
  on public.refunds (resolution_type, created_at desc);

create index if not exists refunds_reason_category_idx
  on public.refunds (reason_category, created_at desc);

create index if not exists refunds_requested_by_idx
  on public.refunds (requested_by, created_at desc);

create index if not exists refunds_parent_refund_id_idx
  on public.refunds (parent_refund_id)
  where (parent_refund_id is not null);


-- -----------------------------------------------------------------------------
-- 2. TABEL BARU: public.refund_items
-- Mencatat item yang diajukan, kuantitas, tingkat kompensasi, & breakdown pajak/service
-- -----------------------------------------------------------------------------
create table if not exists public.refund_items (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null
    references public.refunds (id) on delete cascade,
  order_item_id uuid not null
    references public.order_items (id) on delete restrict,
  product_name_snapshot text not null,
  quantity integer not null check (quantity > 0),
  unit_price integer not null check (unit_price >= 0),
  subtotal_amount integer not null default 0 check (subtotal_amount >= 0),
  discount_amount integer not null default 0 check (discount_amount >= 0),
  order_discount_share integer not null default 0 check (order_discount_share >= 0),
  net_item_amount integer not null check (net_item_amount >= 0),
  service_charge_amount integer not null default 0 check (service_charge_amount >= 0),
  tax_amount integer not null default 0 check (tax_amount >= 0),
  reference_service_charge_amount integer not null default 0 check (reference_service_charge_amount >= 0),
  reference_tax_amount integer not null default 0 check (reference_tax_amount >= 0),
  rounding_adjustment integer not null default 0,
  compensation_severity text not null default 'heavy'
    check (compensation_severity in ('none', 'light', 'medium', 'heavy')),
  compensation_percentage integer not null default 100
    check (compensation_percentage in (0, 25, 50, 100)),
  is_full_item_refund boolean not null default false,
  refund_amount integer not null check (refund_amount >= 0),
  kds_status_snapshot text
    check (kds_status_snapshot is null or kds_status_snapshot in ('queued', 'preparing', 'ready')),
  inventory_action text not null default 'none'
    check (inventory_action in ('none', 'waste', 'restock', 'replace')),
  reason text,
  created_at timestamptz not null default now(),

  constraint refund_items_refund_order_item_unique unique (refund_id, order_item_id)
);

comment on table public.refund_items is
  'Rincian item pada setiap pengajuan refund/replacement beserta breakdown diskon, service charge, pajak, dan tingkat kompensasi.';

create index if not exists refund_items_refund_id_idx
  on public.refund_items (refund_id);

create index if not exists refund_items_order_item_id_idx
  on public.refund_items (order_item_id);

alter table public.refund_items enable row level security;

drop policy if exists refund_items_select_staff on public.refund_items;
create policy refund_items_select_staff
  on public.refund_items
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role in ('admin', 'kasir')
        and is_active = true
    )
  );

revoke all on public.refund_items from public, anon, authenticated;
grant select on public.refund_items to authenticated;
grant all on public.refund_items to service_role;


-- -----------------------------------------------------------------------------
-- 3. TABEL BARU: public.refund_corrections
-- Ledger koreksi kekurangan/kelebihan pengembalian tanpa mengedit baris refund lama
-- -----------------------------------------------------------------------------
create table if not exists public.refund_corrections (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null
    references public.refunds (id) on delete restrict,
  expected_amount integer not null check (expected_amount >= 0),
  actual_amount integer not null check (actual_amount >= 0),
  difference_amount integer not null check (difference_amount <> 0),
  correction_type text not null
    check (correction_type in ('under_refund', 'over_refund')),
  supplemental_refund_id uuid
    references public.refunds (id) on delete restrict,
  follow_up_status text not null default 'open'
    check (follow_up_status in ('open', 'resolved', 'written_off')),
  follow_up_notes text,
  reason text not null check (char_length(btrim(reason)) >= 3),
  idempotency_key text unique
    check (idempotency_key is null or btrim(idempotency_key) <> ''),
  created_by uuid not null
    references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint refund_corrections_math_check
    check (difference_amount = (actual_amount - expected_amount)),
  constraint refund_corrections_direction_check
    check (
      (correction_type = 'under_refund' and difference_amount < 0)
      or (correction_type = 'over_refund' and difference_amount > 0)
    )
);

comment on table public.refund_corrections is
  'Catatan audit koreksi selisih refund (under_refund / over_refund). Tidak mengizinkan perubahan langsung baris refund yang sudah selesai.';

create index if not exists refund_corrections_refund_id_idx
  on public.refund_corrections (refund_id, created_at desc);

create index if not exists refund_corrections_type_idx
  on public.refund_corrections (correction_type, follow_up_status);

drop trigger if exists refund_corrections_set_updated_at on public.refund_corrections;
create trigger refund_corrections_set_updated_at
  before update on public.refund_corrections
  for each row
  execute function public.set_updated_at();

alter table public.refund_corrections enable row level security;

drop policy if exists refund_corrections_select_staff on public.refund_corrections;
create policy refund_corrections_select_staff
  on public.refund_corrections
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role in ('admin', 'kasir')
        and is_active = true
    )
  );

revoke all on public.refund_corrections from public, anon, authenticated;
grant select on public.refund_corrections to authenticated;
grant all on public.refund_corrections to service_role;


-- -----------------------------------------------------------------------------
-- 4. TABEL BARU: public.refund_payout_allocations
-- Mendukung alokasi refund Split Bill ke beberapa payment_id & metode payout berbeda
-- -----------------------------------------------------------------------------
create table if not exists public.refund_payout_allocations (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null
    references public.refunds (id) on delete cascade,
  order_id uuid not null
    references public.orders (id) on delete restrict,
  payment_id uuid not null
    references public.payments (id) on delete restrict,
  payout_method text not null
    check (payout_method in ('cash', 'transfer', 'midtrans', 'manual')),
  amount integer not null check (amount > 0),
  payout_status text not null default 'pending'
    check (payout_status in ('pending', 'processing', 'completed', 'failed', 'reconciliation_required')),
  gateway_refund_id text,
  payout_reference text,
  shift_id uuid references public.shifts (id) on delete set null,
  payout_completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint refund_payout_allocations_refund_payment_unique unique (refund_id, payment_id)
);

comment on table public.refund_payout_allocations is
  'Pecahan alokasi pencairan refund ke tiap baris pembayaran asli pada transaksi Split Bill maupun pembayaran tunggal.';

create index if not exists refund_payout_allocations_refund_idx
  on public.refund_payout_allocations (refund_id);

create index if not exists refund_payout_allocations_payment_idx
  on public.refund_payout_allocations (payment_id, payout_status);

create unique index if not exists refund_payout_allocations_gateway_refund_id_idx
  on public.refund_payout_allocations (gateway_refund_id)
  where (gateway_refund_id is not null);

drop trigger if exists refund_payout_allocations_set_updated_at on public.refund_payout_allocations;
create trigger refund_payout_allocations_set_updated_at
  before update on public.refund_payout_allocations
  for each row
  execute function public.set_updated_at();

alter table public.refund_payout_allocations enable row level security;

drop policy if exists refund_payout_allocations_select_staff on public.refund_payout_allocations;
create policy refund_payout_allocations_select_staff
  on public.refund_payout_allocations
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role in ('admin', 'kasir')
        and is_active = true
    )
  );

revoke all on public.refund_payout_allocations from public, anon, authenticated;
grant select on public.refund_payout_allocations to authenticated;
grant all on public.refund_payout_allocations to service_role;

commit;
