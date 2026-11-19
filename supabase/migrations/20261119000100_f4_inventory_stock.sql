-- =============================================================================
-- NINE LICIOUS POS — F4.1 STOK DAN BAHAN BAKU (INVENTORY & RECIPE FOUNDATION)
-- =============================================================================
-- Milestone   : F4 (Stok dan bahan baku) — Tahap F4.1 (Database, RLS, RPC, Trigger)
-- Tanggal     : 19 November 2026
-- Prasyarat   : Migrasi F0 sampai F3 (termasuk 20261118000100) sudah dijalankan.
--
-- Cakupan migrasi:
-- 1. Tabel public.ingredients (master bahan baku + soft archive + min_stock).
-- 2. Tabel public.recipes (relasi produk F1.1 <-> bahan baku + takaran per porsi).
-- 3. Tabel public.stock_movements (buku besar mutasi stok append-only & idempoten).
-- 4. Guard trigger anti-mutasi langsung pada ingredients.current_stock.
-- 5. RPC atomik public.adjust_ingredient_stock_atomic (manual_in, manual_out,
--    stock_opname) khusus admin aktif + alasan wajib + idempotency + audit_logs.
-- 6. Fungsi internal public.deduct_order_stock_internal + trigger non-invasif
--    AFTER UPDATE ON public.orders ketika payment_status berubah menjadi 'paid':
--    - Berlaku seragam untuk Tunai, Split Bill, dan Midtrans.
--    - Agregasi bahan baku lintas produk/item dalam satu pesanan.
--    - Penguncian baris terurut ORDER BY ingredient_id ASC (level L8, anti-deadlock).
--    - Idempoten (partial unique index + insert-first guard -> anti double deduction).
--    - Produk tanpa resep dilewati secara aman.
--    - Stok boleh menjadi negatif akibat penjualan lunas; subtransaksi EXCEPTION
--      menjamin kegagalan stok tidak pernah menggagalkan pembayaran yang sudah sah.
--    - Refund penuh TIDAK otomatis mengembalikan stok (admin memakai manual_in).
--
-- Perlindungan fitur F0–F3:
-- - Tidak mengubah struktur/constraint/RPC F0–F3 (payments, midtrans, KDS,
--   order serving confirmation, dining sessions, dining tables).
-- - Tidak membuat data stok atau transaksi contoh (zero demo data).
--
-- Jalankan file ini secara manual melalui Supabase SQL Editor setelah review
-- dan backup database.
-- =============================================================================

begin;

-- =============================================================================
-- 1. TABEL MASTER BAHAN BAKU: public.ingredients
-- =============================================================================
create table if not exists public.ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sku text,
  unit text not null,
  current_stock numeric(12, 3) not null default 0,
  min_stock numeric(12, 3) not null default 0,
  is_active boolean not null default true,
  notes text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ingredients_name_length_check check (
    char_length(btrim(name)) between 2 and 80
  ),
  constraint ingredients_sku_format_check check (
    sku is null or sku ~ '^[A-Za-z0-9._-]{2,32}$'
  ),
  constraint ingredients_unit_check check (
    unit in ('g', 'kg', 'ml', 'l', 'pcs', 'pack', 'porsi', 'sachet')
  ),
  constraint ingredients_min_stock_non_negative_check check (
    min_stock >= 0
  ),
  constraint ingredients_notes_length_check check (
    notes is null or char_length(notes) <= 500
  )
);

comment on table public.ingredients is
  'Master bahan baku Nine Licious POS (F4). Mendukung soft archive (is_active) dan peringatan stok rendah (current_stock <= min_stock). current_stock boleh negatif akibat penjualan lunas agar pembayaran sah tidak pernah gagal.';

comment on column public.ingredients.current_stock is
  'Saldo stok bahan baku saat ini (numeric 12,3). Hanya boleh berubah melalui RPC adjust_ingredient_stock_atomic atau fungsi internal deduct_order_stock_internal.';

comment on column public.ingredients.min_stock is
  'Batas ambang peringatan stok rendah untuk admin (current_stock <= min_stock).';

comment on column public.ingredients.is_active is
  'Soft archive bahan baku. Bahan yang pernah dipakai resep/mutasi dinonaktifkan, tidak dihapus permanen.';

-- Index bahan baku
create unique index if not exists ingredients_active_name_unique_idx
  on public.ingredients (lower(btrim(name)))
  where (is_active = true);

create unique index if not exists ingredients_sku_unique_idx
  on public.ingredients (lower(btrim(sku)))
  where (sku is not null);

create index if not exists ingredients_active_name_idx
  on public.ingredients (is_active, name);

create index if not exists ingredients_low_stock_idx
  on public.ingredients (current_stock asc, name asc)
  where (is_active = true and current_stock <= min_stock);

-- Trigger updated_at
drop trigger if exists ingredients_set_updated_at on public.ingredients;
create trigger ingredients_set_updated_at
  before update on public.ingredients
  for each row
  execute function public.set_updated_at();

-- =============================================================================
-- 2. GUARD TRIGGER ANTI-MUTASI LANGSUNG PADA ingredients.current_stock
-- =============================================================================
create or replace function public.protect_ingredient_current_stock_direct_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_allowed text;
begin
  v_allowed := current_setting('nine_licious.allow_stock_mutation', true);

  if tg_op = 'INSERT' then
    if coalesce(new.current_stock, 0) <> 0 and v_allowed is distinct from 'on' then
      raise exception
        'Stok awal bahan baku wajib 0 saat pembuatan master. Gunakan RPC adjust_ingredient_stock_atomic untuk mencatat stok masuk awal agar tercatat di buku besar stok dan audit.';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.current_stock is distinct from old.current_stock
       and v_allowed is distinct from 'on' then
      raise exception
        'Perubahan current_stock secara langsung dilarang. Semua mutasi stok wajib melalui RPC adjust_ingredient_stock_atomic atau pengurangan stok penjualan otomatis.';
    end if;
    return new;
  end if;

  return new;
end;
$$;

revoke all on function public.protect_ingredient_current_stock_direct_mutation() from public;
revoke all on function public.protect_ingredient_current_stock_direct_mutation() from anon;
revoke all on function public.protect_ingredient_current_stock_direct_mutation() from authenticated;
revoke all on function public.protect_ingredient_current_stock_direct_mutation() from service_role;

drop trigger if exists ingredients_protect_current_stock on public.ingredients;
create trigger ingredients_protect_current_stock
  before insert or update on public.ingredients
  for each row
  execute function public.protect_ingredient_current_stock_direct_mutation();

-- =============================================================================
-- 3. TABEL RESEP PRODUK: public.recipes
-- =============================================================================
create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete restrict,
  quantity_required numeric(12, 3) not null,
  notes text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint recipes_product_ingredient_unique unique (product_id, ingredient_id),
  constraint recipes_quantity_positive_check check (quantity_required > 0),
  constraint recipes_notes_length_check check (
    notes is null or char_length(notes) <= 300
  )
);

comment on table public.recipes is
  'Komposisi resep yang menghubungkan produk F1.1 (products) ke bahan baku (ingredients) dengan takaran pemakaian per 1 porsi produk.';

create index if not exists recipes_product_id_idx
  on public.recipes (product_id);

create index if not exists recipes_ingredient_id_idx
  on public.recipes (ingredient_id);

drop trigger if exists recipes_set_updated_at on public.recipes;
create trigger recipes_set_updated_at
  before update on public.recipes
  for each row
  execute function public.set_updated_at();

-- =============================================================================
-- 4. TABEL MUTASI STOK (APPEND-ONLY LEDGER): public.stock_movements
-- =============================================================================
create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references public.ingredients (id) on delete restrict,
  movement_type text not null,
  quantity_delta numeric(12, 3) not null,
  stock_before numeric(12, 3) not null,
  stock_after numeric(12, 3) not null,
  order_id uuid references public.orders (id) on delete restrict,
  reason text not null,
  idempotency_key text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint stock_movements_type_check check (
    movement_type in ('sale_deduction', 'manual_in', 'manual_out', 'stock_opname')
  ),
  constraint stock_movements_delta_non_zero_check check (
    quantity_delta <> 0
  ),
  constraint stock_movements_direction_and_order_check check (
    (movement_type = 'sale_deduction' and quantity_delta < 0 and order_id is not null)
    or (movement_type = 'manual_in' and quantity_delta > 0 and order_id is null)
    or (movement_type = 'manual_out' and quantity_delta < 0 and order_id is null)
    or (movement_type = 'stock_opname' and quantity_delta <> 0 and order_id is null)
  ),
  constraint stock_movements_balance_math_check check (
    stock_after = (stock_before + quantity_delta)
  ),
  constraint stock_movements_reason_length_check check (
    char_length(btrim(reason)) between 3 and 500
  ),
  constraint stock_movements_idempotency_key_length_check check (
    idempotency_key is null
    or char_length(btrim(idempotency_key)) between 8 and 128
  )
);

comment on table public.stock_movements is
  'Buku besar append-only seluruh perubahan stok bahan baku (pengurangan penjualan lunas dan penyesuaian manual admin). Refund penuh tidak otomatis mengembalikan stok.';

-- Partial unique index anti-double-deduction untuk penjualan lunas
create unique index if not exists stock_movements_sale_order_ingredient_unique_idx
  on public.stock_movements (order_id, ingredient_id)
  where (movement_type = 'sale_deduction' and order_id is not null);

-- Unique index idempotency untuk penyesuaian stok manual
create unique index if not exists stock_movements_idempotency_key_unique_idx
  on public.stock_movements (idempotency_key)
  where (idempotency_key is not null);

create index if not exists stock_movements_ingredient_created_idx
  on public.stock_movements (ingredient_id, created_at desc);

create index if not exists stock_movements_created_at_idx
  on public.stock_movements (created_at desc);

create index if not exists stock_movements_type_created_idx
  on public.stock_movements (movement_type, created_at desc);

create index if not exists stock_movements_order_id_idx
  on public.stock_movements (order_id)
  where (order_id is not null);

-- =============================================================================
-- 5. ROW LEVEL SECURITY (RLS) & LEAST-PRIVILEGE GRANTS
-- =============================================================================
-- Kebijakan keamanan ketat F4:
-- - Hanya role 'admin' aktif (public.is_admin()) yang dapat membaca data stok,
--   resep, dan mutasi stok.
-- - Role 'kasir', 'kitchen', dan 'anon' TIDAK memiliki akses baca maupun tulis.
-- - Role 'authenticated' tidak memiliki izin INSERT/UPDATE/DELETE langsung
--   pada ingredients, recipes, maupun stock_movements.
-- =============================================================================

alter table public.ingredients enable row level security;
alter table public.recipes enable row level security;
alter table public.stock_movements enable row level security;

-- Policy SELECT khusus admin aktif
drop policy if exists ingredients_select_admin on public.ingredients;
create policy ingredients_select_admin
  on public.ingredients
  for select
  to authenticated
  using (public.is_admin());

drop policy if exists recipes_select_admin on public.recipes;
create policy recipes_select_admin
  on public.recipes
  for select
  to authenticated
  using (public.is_admin());

drop policy if exists stock_movements_select_admin on public.stock_movements;
create policy stock_movements_select_admin
  on public.stock_movements
  for select
  to authenticated
  using (public.is_admin());

-- Revoke seluruh akses anon & publik
revoke all on public.ingredients from public, anon;
revoke all on public.recipes from public, anon;
revoke all on public.stock_movements from public, anon;

-- Authenticated hanya SELECT (difilter RLS is_admin()); mutasi wajib lewat server/RPC
revoke insert, update, delete, truncate on public.ingredients from authenticated;
revoke insert, update, delete, truncate on public.recipes from authenticated;
revoke insert, update, delete, truncate on public.stock_movements from authenticated;

grant select on public.ingredients to authenticated;
grant select on public.recipes to authenticated;
grant select on public.stock_movements to authenticated;

-- Service role untuk operasi server-side terverifikasi (admin CRUD metadata & resep)
grant all on public.ingredients to service_role;
grant all on public.recipes to service_role;
grant select, insert on public.stock_movements to service_role;

-- =============================================================================
-- 6. RPC ATOMIK PENYESUAIAN STOK MANUAL: public.adjust_ingredient_stock_atomic
-- =============================================================================
create or replace function public.adjust_ingredient_stock_atomic(
  p_ingredient_id uuid,
  p_movement_type text,
  p_quantity numeric,
  p_reason text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_username text;
  v_is_active boolean;
  v_reason text;
  v_idempotency_key text;
  v_qty numeric(12, 3);
  v_ingredient record;
  v_existing_movement record;
  v_stock_before numeric(12, 3);
  v_stock_after numeric(12, 3);
  v_delta numeric(12, 3);
  v_movement_id uuid;
  v_now timestamptz := now();
begin
  -- 1. Otorisasi ketat berbasis sesi JWT admin aktif (bukan service_role / anon / kasir / kitchen)
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Autentikasi sesi admin diperlukan untuk melakukan penyesuaian stok.';
  end if;

  select role, username, is_active
  into v_user_role, v_username, v_is_active
  from public.profiles
  where id = v_user_id;

  if not found
     or v_is_active is distinct from true
     or v_user_role is distinct from 'admin' then
    raise exception 'Hanya admin aktif yang berhak melakukan penyesuaian stok bahan baku.';
  end if;

  -- 2. Validasi parameter input
  if p_ingredient_id is null then
    raise exception 'ID bahan baku tidak valid.';
  end if;

  if p_movement_type is null
     or p_movement_type not in ('manual_in', 'manual_out', 'stock_opname') then
    raise exception 'Jenis penyesuaian stok tidak valid. Gunakan manual_in, manual_out, atau stock_opname.';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'Alasan penyesuaian stok wajib diisi (minimal 3 karakter, maksimal 500 karakter).';
  end if;

  if p_quantity is null
     or p_quantity = 'NaN'::numeric
     or p_quantity = 'Infinity'::numeric
     or p_quantity = '-Infinity'::numeric then
    raise exception 'Jumlah penyesuaian stok tidak valid.';
  end if;

  if abs(p_quantity) > 999999999 then
    raise exception 'Jumlah penyesuaian stok melebihi batas maksimum yang diizinkan.';
  end if;

  v_qty := round(p_quantity::numeric, 3);

  if p_movement_type in ('manual_in', 'manual_out') and v_qty <= 0 then
    raise exception 'Jumlah untuk % harus lebih besar dari 0.', p_movement_type;
  end if;

  if p_movement_type = 'stock_opname' and v_qty < 0 then
    raise exception 'Stok aktual pada stock_opname tidak boleh negatif.';
  end if;

  v_idempotency_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_idempotency_key is not null
     and (char_length(v_idempotency_key) < 8 or char_length(v_idempotency_key) > 128) then
    raise exception 'Format idempotency_key penyesuaian stok tidak valid (8–128 karakter).';
  end if;

  -- 3. Kunci baris bahan baku (level kunci L8 — tidak pernah mengunci tabel orders/payments)
  select *
  into v_ingredient
  from public.ingredients
  where id = p_ingredient_id
  for update;

  if not found then
    raise exception 'Bahan baku tidak ditemukan.';
  end if;

  -- 4. Pemeriksaan idempotency setelah baris terkunci (cegah double-click / retry)
  if v_idempotency_key is not null then
    select *
    into v_existing_movement
    from public.stock_movements
    where idempotency_key = v_idempotency_key
    limit 1;

    if found then
      if v_existing_movement.ingredient_id <> p_ingredient_id
         or v_existing_movement.movement_type <> p_movement_type then
        raise exception 'idempotency_key sudah digunakan untuk bahan baku atau jenis penyesuaian berbeda.';
      end if;

      return jsonb_build_object(
        'movement_id', v_existing_movement.id,
        'ingredient_id', v_ingredient.id,
        'ingredient_name', v_ingredient.name,
        'unit', v_ingredient.unit,
        'movement_type', v_existing_movement.movement_type,
        'quantity_delta', v_existing_movement.quantity_delta,
        'stock_before', v_existing_movement.stock_before,
        'stock_after', v_existing_movement.stock_after,
        'min_stock', v_ingredient.min_stock,
        'is_low_stock', (v_existing_movement.stock_after <= v_ingredient.min_stock),
        'reason', v_existing_movement.reason,
        'idempotent_replay', true,
        'created_at', v_existing_movement.created_at
      );
    end if;
  end if;

  -- 5. Tolak penyesuaian pada bahan baku nonaktif (diarsipkan)
  if v_ingredient.is_active is distinct from true then
    raise exception 'Bahan baku "%" sedang nonaktif (diarsipkan) dan tidak dapat disesuaikan stoknya.', v_ingredient.name;
  end if;

  -- 6. Hitung delta dan validasi integritas stok manual
  v_stock_before := v_ingredient.current_stock;

  if p_movement_type = 'manual_in' then
    v_delta := v_qty;
    v_stock_after := round((v_stock_before + v_delta)::numeric, 3);
  elsif p_movement_type = 'manual_out' then
    v_delta := -v_qty;
    v_stock_after := round((v_stock_before + v_delta)::numeric, 3);
    if v_stock_after < 0 then
      raise exception
        'Pengurangan stok manual (%, %) melebihi stok saat ini (% %). Gunakan stock_opname untuk menyetel ulang stok aktual.',
        v_qty,
        v_ingredient.unit,
        v_stock_before,
        v_ingredient.unit;
    end if;
  else
    -- stock_opname: p_quantity adalah hasil hitung fisik aktual (>= 0)
    v_stock_after := v_qty;
    v_delta := round((v_stock_after - v_stock_before)::numeric, 3);
    if v_delta = 0 then
      raise exception
        'Stok hasil opname (% %) sama dengan stok saat ini. Tidak ada perubahan stok untuk dicatat.',
        v_qty,
        v_ingredient.unit;
    end if;
  end if;

  -- 7. Izinkan mutasi current_stock khusus untuk UPDATE ini lalu segera kunci kembali
  perform set_config('nine_licious.allow_stock_mutation', 'on', true);

  update public.ingredients
  set
    current_stock = v_stock_after,
    updated_at = v_now
  where id = p_ingredient_id;

  perform set_config('nine_licious.allow_stock_mutation', 'off', true);

  insert into public.stock_movements (
    ingredient_id,
    movement_type,
    quantity_delta,
    stock_before,
    stock_after,
    order_id,
    reason,
    idempotency_key,
    created_by,
    created_at
  ) values (
    p_ingredient_id,
    p_movement_type,
    v_delta,
    v_stock_before,
    v_stock_after,
    null,
    v_reason,
    v_idempotency_key,
    v_user_id,
    v_now
  )
  returning id into v_movement_id;

  -- 8. Catat audit log permanen dalam transaksi yang sama
  insert into public.audit_logs (
    action,
    user_id,
    username,
    entity,
    entity_id,
    details
  ) values (
    'inventory.stock_adjusted',
    v_user_id,
    v_username,
    'ingredient',
    p_ingredient_id::text,
    jsonb_build_object(
      'movement_id', v_movement_id,
      'ingredient_id', v_ingredient.id,
      'ingredient_name', v_ingredient.name,
      'sku', v_ingredient.sku,
      'unit', v_ingredient.unit,
      'movement_type', p_movement_type,
      'quantity_input', v_qty,
      'quantity_delta', v_delta,
      'stock_before', v_stock_before,
      'stock_after', v_stock_after,
      'min_stock', v_ingredient.min_stock,
      'is_low_stock', (v_stock_after <= v_ingredient.min_stock),
      'reason', v_reason,
      'idempotency_key', v_idempotency_key,
      'actor_role', v_user_role
    )
  );

  return jsonb_build_object(
    'movement_id', v_movement_id,
    'ingredient_id', v_ingredient.id,
    'ingredient_name', v_ingredient.name,
    'unit', v_ingredient.unit,
    'movement_type', p_movement_type,
    'quantity_delta', v_delta,
    'stock_before', v_stock_before,
    'stock_after', v_stock_after,
    'min_stock', v_ingredient.min_stock,
    'is_low_stock', (v_stock_after <= v_ingredient.min_stock),
    'reason', v_reason,
    'idempotent_replay', false,
    'created_at', v_now
  );
end;
$$;

-- Least-privilege execution grant: hanya authenticated (admin diverifikasi via auth.uid() di dalam RPC)
revoke all on function public.adjust_ingredient_stock_atomic(uuid, text, numeric, text, text) from public;
revoke all on function public.adjust_ingredient_stock_atomic(uuid, text, numeric, text, text) from anon;
revoke all on function public.adjust_ingredient_stock_atomic(uuid, text, numeric, text, text) from service_role;
grant execute on function public.adjust_ingredient_stock_atomic(uuid, text, numeric, text, text) to authenticated;

-- =============================================================================
-- 7. PENGURANGAN STOK OTOMATIS SAAT PESANAN LUNAS (payment_status = 'paid')
-- =============================================================================
-- Prinsip operasional & keamanan:
-- 1. Hanya dieksekusi untuk pesanan yang benar-benar lunas (payment_status = 'paid')
--    dan bukan cancelled/refunded.
-- 2. Mengagregasi kebutuhan bahan baku yang sama dari beberapa produk / baris item
--    dalam pesanan yang sama.
-- 3. Mengunci baris public.ingredients dengan urutan deterministik
--    ORDER BY ingredient_id ASC (level kunci L8, setelah L1–L7 F2) -> bebas deadlock.
-- 4. Produk tanpa resep dilewati secara aman.
-- 5. Anti-double-deduction berlapis:
--    (a) Partial unique index (order_id, ingredient_id) untuk sale_deduction.
--    (b) Insert-first dengan ON CONFLICT DO NOTHING RETURNING id; current_stock
--        HANYA diperbarui jika baris stock_movements benar-benar baru disisipkan.
-- 6. Stok boleh menjadi negatif akibat penjualan lunas agar pembayaran sah
--    (Tunai, Split Bill, Midtrans) tidak pernah ditolak atau di-rollback.
-- =============================================================================

create or replace function public.deduct_order_stock_internal(
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order record;
  v_req record;
  v_ingredient record;
  v_stock_before numeric(12, 3);
  v_stock_after numeric(12, 3);
  v_delta numeric(12, 3);
  v_inserted_id uuid;
  v_now timestamptz := now();
  v_deducted_count integer := 0;
  v_skipped_existing_count integer := 0;
  v_low_stock_ids jsonb := '[]'::jsonb;
  v_negative_stock_ids jsonb := '[]'::jsonb;
  v_deducted_items jsonb := '[]'::jsonb;
begin
  if p_order_id is null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'invalid_order_id',
      'deducted_count', 0
    );
  end if;

  select id, order_number, status, payment_status, created_by
  into v_order
  from public.orders
  where id = p_order_id;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'reason', 'order_not_found',
      'deducted_count', 0
    );
  end if;

  -- Guard keras: hanya pesanan yang benar-benar lunas yang boleh memotong stok
  if v_order.payment_status <> 'paid'
     or v_order.status in ('cancelled', 'refunded') then
    return jsonb_build_object(
      'ok', true,
      'order_id', v_order.id,
      'skipped', true,
      'reason', 'order_not_eligible_for_stock_deduction',
      'deducted_count', 0
    );
  end if;

  -- Agregasi kebutuhan bahan baku per ingredient_id, terurut ASC untuk mencegah deadlock.
  -- Produk tanpa resep otomatis tidak masuk hasil JOIN (dilewati dengan aman).
  for v_req in
    select
      r.ingredient_id,
      round(sum(r.quantity_required * oi.quantity)::numeric, 3) as total_required
    from public.order_items oi
    inner join public.recipes r
      on r.product_id = oi.product_id
    inner join public.ingredients i
      on i.id = r.ingredient_id
     and i.is_active = true
    where oi.order_id = p_order_id
      and oi.quantity > 0
    group by r.ingredient_id
    having round(sum(r.quantity_required * oi.quantity)::numeric, 3) > 0
    order by r.ingredient_id asc
  loop
    -- Kunci baris bahan baku satu per satu dalam urutan UUID menaik (L8)
    select id, name, unit, current_stock, min_stock, is_active
    into v_ingredient
    from public.ingredients
    where id = v_req.ingredient_id
    for update;

    if not found or v_ingredient.is_active is distinct from true then
      continue;
    end if;

    v_stock_before := v_ingredient.current_stock;
    v_delta := -v_req.total_required;
    v_stock_after := round((v_stock_before + v_delta)::numeric, 3);

    -- Insert-first idempoten: jika (order_id, ingredient_id) sudah pernah dipotong,
    -- ON CONFLICT DO NOTHING membuat v_inserted_id = NULL sehingga current_stock
    -- TIDAK PERNAH berkurang dua kali.
    v_inserted_id := null;

    insert into public.stock_movements (
      ingredient_id,
      movement_type,
      quantity_delta,
      stock_before,
      stock_after,
      order_id,
      reason,
      idempotency_key,
      created_by,
      created_at
    ) values (
      v_ingredient.id,
      'sale_deduction',
      v_delta,
      v_stock_before,
      v_stock_after,
      v_order.id,
      format('Pengurangan stok otomatis dari pesanan lunas #%s', v_order.order_number),
      null,
      v_order.created_by,
      v_now
    )
    on conflict (order_id, ingredient_id)
      where (movement_type = 'sale_deduction' and order_id is not null)
    do nothing
    returning id into v_inserted_id;

    if v_inserted_id is null then
      v_skipped_existing_count := v_skipped_existing_count + 1;
      continue;
    end if;

    -- Perbarui saldo bahan baku (diizinkan menjadi negatif sesuai kebijakan F4)
    perform set_config('nine_licious.allow_stock_mutation', 'on', true);

    update public.ingredients
    set
      current_stock = v_stock_after,
      updated_at = v_now
    where id = v_ingredient.id;

    perform set_config('nine_licious.allow_stock_mutation', 'off', true);

    v_deducted_count := v_deducted_count + 1;

    if v_stock_after <= v_ingredient.min_stock then
      v_low_stock_ids := v_low_stock_ids || to_jsonb(v_ingredient.id);
    end if;

    if v_stock_after < 0 then
      v_negative_stock_ids := v_negative_stock_ids || to_jsonb(v_ingredient.id);
    end if;

    v_deducted_items := v_deducted_items || jsonb_build_array(
      jsonb_build_object(
        'movement_id', v_inserted_id,
        'ingredient_id', v_ingredient.id,
        'ingredient_name', v_ingredient.name,
        'unit', v_ingredient.unit,
        'quantity_deducted', v_req.total_required,
        'stock_before', v_stock_before,
        'stock_after', v_stock_after
      )
    );
  end loop;

  -- Catat ringkasan audit log jika ada pengurangan stok yang benar-benar terjadi
  if v_deducted_count > 0 then
    insert into public.audit_logs (
      action,
      user_id,
      username,
      entity,
      entity_id,
      details
    ) values (
      'inventory.sale_deducted',
      v_order.created_by,
      null,
      'order',
      v_order.id::text,
      jsonb_build_object(
        'order_id', v_order.id,
        'order_number', v_order.order_number,
        'deducted_count', v_deducted_count,
        'low_stock_ingredient_ids', v_low_stock_ids,
        'negative_stock_ingredient_ids', v_negative_stock_ids,
        'items', v_deducted_items
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'deducted_count', v_deducted_count,
    'skipped_existing_count', v_skipped_existing_count,
    'low_stock_ingredient_ids', v_low_stock_ids,
    'negative_stock_ingredient_ids', v_negative_stock_ids
  );
end;
$$;

-- Fungsi internal: tolak public, anon, authenticated; hanya owner/trigger & service_role
revoke all on function public.deduct_order_stock_internal(uuid) from public;
revoke all on function public.deduct_order_stock_internal(uuid) from anon;
revoke all on function public.deduct_order_stock_internal(uuid) from authenticated;
grant execute on function public.deduct_order_stock_internal(uuid) to service_role;

-- =============================================================================
-- 8. TRIGGER NON-INVASIF PADA public.orders (FAIL-SAFE TERHADAP PEMBAYARAN)
-- =============================================================================
create or replace function public.trg_fn_orders_deduct_stock_on_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_err_state text;
  v_err_msg text;
begin
  -- Subtransaksi terisolasi: bila terjadi galat tak terduga saat pemotongan stok,
  -- hanya savepoint stok yang di-rollback; transaksi pembayaran sah TETAP SUKSES.
  begin
    perform public.deduct_order_stock_internal(new.id);
  exception
    when others then
      v_err_state := sqlstate;
      v_err_msg := sqlerrm;
      raise warning
        '[F4 Inventory] Gagal memotong stok otomatis untuk order % (%): [%] %',
        new.id,
        new.order_number,
        v_err_state,
        v_err_msg;

      -- Best-effort catat kegagalan ke audit_logs tanpa pernah membatalkan pembayaran
      begin
        insert into public.audit_logs (
          action,
          user_id,
          username,
          entity,
          entity_id,
          details
        ) values (
          'inventory.sale_deduction_failed',
          new.created_by,
          null,
          'order',
          new.id::text,
          jsonb_build_object(
            'order_id', new.id,
            'order_number', new.order_number,
            'sqlstate', v_err_state,
            'error_message', v_err_msg
          )
        );
      exception
        when others then
          null;
      end;
  end;

  return new;
end;
$$;

revoke all on function public.trg_fn_orders_deduct_stock_on_paid() from public;
revoke all on function public.trg_fn_orders_deduct_stock_on_paid() from anon;
revoke all on function public.trg_fn_orders_deduct_stock_on_paid() from authenticated;
revoke all on function public.trg_fn_orders_deduct_stock_on_paid() from service_role;

drop trigger if exists trg_orders_deduct_stock_on_paid on public.orders;
create trigger trg_orders_deduct_stock_on_paid
  after update of payment_status on public.orders
  for each row
  when (old.payment_status is distinct from 'paid' and new.payment_status = 'paid')
  execute function public.trg_fn_orders_deduct_stock_on_paid();

commit;
