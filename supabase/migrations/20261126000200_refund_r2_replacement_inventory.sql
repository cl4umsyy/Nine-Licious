-- =============================================================================
-- NINE LICIOUS POS — REFUND SYSTEM MIGRATION R2: REPLACEMENT & INVENTORY
-- File: supabase/migrations/20261126000200_refund_r2_replacement_inventory.sql
--
-- PRASYARAT: Migration R1 (20261126000100_refund_r1_foundation.sql) sudah dijalankan.
--
-- TUJUAN:
-- 1. Menambahkan penanda order_kind = 'replacement' & parent_order_id pada public.orders
--    sehingga pesanan pengganti:
--    - Tetap dapat masuk ke KDS (kds_status = 'queued')
--    - Tidak merusak status meja, dining_session, atau antrean pelanggan baru
--    - Dikecualikan dari trigger wajib shift kasir untuk pesanan biasa
--    - Tidak dihitung sebagai omzet/transaksi penjualan baru di laporan F6
-- 2. Membuat tabel public.order_replacements untuk melacak pengajuan & tiket replacement.
-- 3. Membuat tabel non-finansial public.kds_item_cancellations agar KDS (/kitchen)
--    menerima pemberitahuan item yang dibatalkan tanpa akses ke tabel finansial refunds.
-- 4. Mengembangkan public.stock_movements untuk mendukung:
--    - 'waste': mencatat bahan makanan yang terbuang TANPA memotong current_stock ulang
--    - 'refund_restock': mencatat pengembalian stok untuk item yang belum diproduksi
--
-- PRINSIP KEAMANAN:
-- - Kontrak F3 (3 status KDS) dan F4 (strict non-negative inventory) tetap terjaga.
-- - Role 'kitchen' hanya dapat membaca tabel non-finansial/non-PII.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. PENGEMBANGAN TABEL public.orders UNTUK ISOLASI REPLACEMENT
-- -----------------------------------------------------------------------------
alter table public.orders
  add column if not exists order_kind text not null default 'standard',
  add column if not exists parent_order_id uuid references public.orders (id) on delete restrict;

comment on column public.orders.order_kind is
  'Jenis pesanan: standard (penjualan normal POS) atau replacement (pesanan pengganti komplain Rp 0 yang masuk KDS tanpa memengaruhi omzet F6).';
comment on column public.orders.parent_order_id is
  'Referensi ke pesanan asli apabila order_kind = replacement.';

-- Perbarui constraint meja & sesi agar pesanan replacement tidak memicu atau mengubah meja/sesi aktif
do $$
declare
  v_con record;
begin
  for v_con in
    select conname
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and contype = 'c'
      and (
        conname in ('orders_dine_in_table_check', 'orders_order_kind_check', 'orders_replacement_check')
        or pg_get_constraintdef(oid) ilike '%dining_session_id is null%'
      )
  loop
    execute format('alter table public.orders drop constraint if exists %I', v_con.conname);
  end loop;
end $$;

alter table public.orders
  add constraint orders_order_kind_check
    check (order_kind in ('standard', 'replacement')),
  add constraint orders_dine_in_table_check
    check (
      (order_kind = 'replacement' and table_id is null and dining_session_id is null)
      or (order_kind = 'standard' and order_type = 'takeaway' and table_id is null and dining_session_id is null)
      or (order_kind = 'standard' and order_type = 'dine_in' and table_id is not null and dining_session_id is not null)
    ),
  add constraint orders_replacement_check
    check (
      (order_kind = 'standard' and parent_order_id is null)
      or (order_kind = 'replacement' and parent_order_id is not null and grand_total = 0 and paid_total = 0)
    );

create index if not exists orders_order_kind_idx
  on public.orders (order_kind, created_at desc);

create index if not exists orders_parent_order_id_idx
  on public.orders (parent_order_id)
  where (parent_order_id is not null);


-- -----------------------------------------------------------------------------
-- 2. PENYESUAIAN TRIGGER SHIFT PESANAN (20261125000100) AGAR REPLACEMENT TIDAK TERBLOKIR
-- Pesanan standard tetap wajib memiliki shift kasir aktif; pesanan replacement dikecualikan.
-- -----------------------------------------------------------------------------
create or replace function public.assert_active_cashier_shift_for_order_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_shift_id uuid;
  v_order_kind text;
  v_row_json jsonb;
begin
  v_actor_id := auth.uid();

  -- Lewati bila dijalankan dari service_role internal / webhook / maintenance (auth.uid() IS NULL)
  if v_actor_id is null then
    return new;
  end if;

  -- Serialisasikan record NEW sebagai jsonb agar aman dipakai lintas tabel (orders, order_items, dining_sessions)
  v_row_json := pg_catalog.to_jsonb(new);

  -- Kecualikan pesanan replacement dan order_items miliknya dari kewajiban shift kasir aktif
  if tg_table_name = 'orders' and coalesce(v_row_json ->> 'order_kind', 'standard') = 'replacement' then
    return new;
  end if;

  if tg_table_name = 'order_items' and nullif(v_row_json ->> 'order_id', '') is not null then
    select order_kind into v_order_kind
    from public.orders
    where id = (v_row_json ->> 'order_id')::uuid;

    if coalesce(v_order_kind, 'standard') = 'replacement' then
      return new;
    end if;
  end if;

  select id
  into v_shift_id
  from public.shifts
  where cashier_id = v_actor_id
    and status = 'open'
    and closed_at is null
  limit 1;

  if not found then
    raise exception 'SHIFT_NOT_OPEN: Shift kasir belum dibuka atau sudah ditutup. Buka shift terlebih dahulu sebelum membuat atau menambah pesanan.';
  end if;

  return new;
end;
$$;

revoke all on function public.assert_active_cashier_shift_for_order_mutation() from public, anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 3. TABEL BARU: public.order_replacements
-- Menghubungkan pengajuan replacement di refunds dengan tiket produksi KDS baru
-- (Tanpa kolom finansial/PII sehingga aman dibaca oleh KDS)
-- -----------------------------------------------------------------------------
create table if not exists public.order_replacements (
  id uuid primary key default gen_random_uuid(),
  original_order_id uuid not null
    references public.orders (id) on delete restrict,
  replacement_order_id uuid unique
    references public.orders (id) on delete restrict,
  refund_id uuid not null unique
    references public.refunds (id) on delete restrict,
  original_order_type text not null default 'takeaway'
    check (original_order_type in ('dine_in', 'takeaway')),
  table_name_snapshot text,
  status text not null default 'pending_approval'
    check (status in (
      'pending_approval',
      'approved',
      'rejected',
      'cancelled',
      'in_kitchen',
      'ready',
      'completed'
    )),
  items_summary jsonb not null default '[]'::jsonb,
  reason text not null check (char_length(btrim(reason)) >= 3),
  created_by uuid not null
    references public.profiles (id) on delete restrict,
  approved_by uuid
    references public.profiles (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.order_replacements is
  'Jejak operasional penggantian menu (Replacement) yang menghubungkan order awal, tiket KDS baru, dan pengajuan di refunds.';

create index if not exists order_replacements_original_order_idx
  on public.order_replacements (original_order_id);

create index if not exists order_replacements_status_idx
  on public.order_replacements (status, created_at desc);

drop trigger if exists order_replacements_set_updated_at on public.order_replacements;
create trigger order_replacements_set_updated_at
  before update on public.order_replacements
  for each row
  execute function public.set_updated_at();

alter table public.order_replacements enable row level security;

drop policy if exists order_replacements_select_staff on public.order_replacements;
create policy order_replacements_select_staff
  on public.order_replacements
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role in ('admin', 'kasir', 'kitchen')
        and is_active = true
    )
  );

revoke all on public.order_replacements from public, anon, authenticated;
grant select on public.order_replacements to authenticated;
grant all on public.order_replacements to service_role;


-- -----------------------------------------------------------------------------
-- 4. TABEL BARU (NON-FINANSIAL): public.kds_item_cancellations
-- Alert dapur untuk pembatalan per-item pada Partial Refund maupun Full Refund
-- Tanpa membuka akses finansial tabel refunds ke role kitchen
-- -----------------------------------------------------------------------------
create table if not exists public.kds_item_cancellations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null
    references public.orders (id) on delete restrict,
  order_item_id uuid not null
    references public.order_items (id) on delete restrict,
  refund_id uuid not null
    references public.refunds (id) on delete cascade,
  order_number text not null,
  queue_number text,
  product_name text not null,
  cancelled_quantity integer not null check (cancelled_quantity > 0),
  kds_status_at_refund text
    check (kds_status_at_refund is null or kds_status_at_refund in ('queued', 'preparing', 'ready')),
  kitchen_action text not null
    check (kitchen_action in ('cancel_ticket_or_item', 'stop_preparation_if_possible', 'already_ready_no_action')),
  reason text not null check (char_length(btrim(reason)) >= 3),
  acknowledged_by uuid references public.profiles (id) on delete set null,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),

  constraint kds_item_cancellations_refund_item_unique unique (refund_id, order_item_id)
);

comment on table public.kds_item_cancellations is
  'Pemberitahuan pembatalan/penghentian produksi item untuk KDS (bebas data finansial dan bebas PII pelanggan).';

create index if not exists kds_item_cancellations_order_idx
  on public.kds_item_cancellations (order_id, created_at desc);

create index if not exists kds_item_cancellations_unack_idx
  on public.kds_item_cancellations (created_at desc)
  where (acknowledged_at is null);

alter table public.kds_item_cancellations enable row level security;

drop policy if exists kds_item_cancellations_select_staff on public.kds_item_cancellations;
create policy kds_item_cancellations_select_staff
  on public.kds_item_cancellations
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role in ('admin', 'kasir', 'kitchen')
        and is_active = true
    )
  );

revoke all on public.kds_item_cancellations from public, anon, authenticated;
grant select on public.kds_item_cancellations to authenticated;
grant all on public.kds_item_cancellations to service_role;


-- -----------------------------------------------------------------------------
-- 5. PENGEMBANGAN TABEL public.stock_movements: DUKUNG 'waste' & 'refund_restock'
-- - 'waste': mencatat bahan makanan terbuang setelah pesanan lunas tanpa
--   memotong ingredients.current_stock untuk kedua kalinya (quantity_delta = 0,
--   wasted_quantity > 0).
-- - 'refund_restock': pengembalian stok untuk item yang belum diproduksi
--   (quantity_delta > 0, menambah current_stock secara teraudit).
-- -----------------------------------------------------------------------------
alter table public.stock_movements
  add column if not exists refund_id uuid references public.refunds (id) on delete set null,
  add column if not exists order_item_id uuid references public.order_items (id) on delete set null,
  add column if not exists wasted_quantity numeric(12, 3) not null default 0;

comment on column public.stock_movements.wasted_quantity is
  'Kuantitas bahan terbuang pada movement_type = waste (ketika current_stock sudah terpotong saat sale_deduction sehingga quantity_delta = 0).';

do $$
declare
  v_con record;
begin
  for v_con in
    select conname
    from pg_constraint
    where conrelid = 'public.stock_movements'::regclass
      and contype = 'c'
      and conname in (
        'stock_movements_type_check',
        'stock_movements_delta_non_zero_check',
        'stock_movements_direction_and_order_check',
        'stock_movements_wasted_quantity_check'
      )
  loop
    execute format('alter table public.stock_movements drop constraint if exists %I', v_con.conname);
  end loop;
end $$;

alter table public.stock_movements
  add constraint stock_movements_wasted_quantity_check
    check (wasted_quantity >= 0),
  add constraint stock_movements_type_check
    check (movement_type in (
      'sale_deduction',
      'manual_in',
      'manual_out',
      'stock_opname',
      'waste',
      'refund_restock'
    )),
  add constraint stock_movements_delta_non_zero_check
    check (
      (movement_type = 'waste' and quantity_delta = 0 and wasted_quantity > 0)
      or (movement_type <> 'waste' and quantity_delta <> 0 and wasted_quantity = 0)
    ),
  add constraint stock_movements_direction_and_order_check
    check (
      (movement_type = 'sale_deduction' and quantity_delta < 0 and order_id is not null)
      or (movement_type = 'manual_in' and quantity_delta > 0 and order_id is null)
      or (movement_type = 'manual_out' and quantity_delta < 0 and order_id is null)
      or (movement_type = 'stock_opname' and quantity_delta <> 0 and order_id is null)
      or (movement_type = 'waste' and quantity_delta = 0 and wasted_quantity > 0)
      or (movement_type = 'refund_restock' and quantity_delta > 0 and order_id is not null and refund_id is not null)
    );

create index if not exists stock_movements_refund_id_idx
  on public.stock_movements (refund_id)
  where (refund_id is not null);

-- Cegah double waste / double restock pada pasangan refund + order_item + ingredient
create unique index if not exists stock_movements_refund_waste_unique_idx
  on public.stock_movements (refund_id, order_item_id, ingredient_id)
  where (movement_type = 'waste' and refund_id is not null and order_item_id is not null);

create unique index if not exists stock_movements_refund_restock_unique_idx
  on public.stock_movements (refund_id, order_item_id, ingredient_id)
  where (movement_type = 'refund_restock' and refund_id is not null and order_item_id is not null);

commit;
