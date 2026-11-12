-- ===========================================================================
-- Nine Licious POS - Migration F1.4: Diskon, Approval Nonce, & Finalisasi Pesanan
-- File: supabase/migrations/20261111000400_discounts.sql
--
-- Bergantung pada:
--   20261111000100_menu_master.sql (F1.1)
--   20261111000200_tables_layout.sql (F1.2)
--   20261111000300_orders_pos.sql (F1.3)
--
-- Menambahkan:
-- 1. Kolom finalisasi pada tabel orders (is_finalized, finalized_at, finalized_by).
-- 2. Tabel master discounts (kebijakan promo produk dan pesanan).
-- 3. Tabel discount_approval_nonces (token persetujuan admin satu kali pakai).
-- 4. Tabel order_discounts (snapshot rincian diskon per transaksi).
-- 5. Fungsi transaksi create_pos_order_atomic (3 parameter tanpa default).
-- 6. Fungsi wrapper kompatibilitas create_pos_order_atomic (2 parameter untuk F1.3).
-- 7. Pembaruan fungsi append_order_items_atomic dengan proteksi finalisasi.
-- 8. Fungsi finalize_pos_order dan unfinalize_pos_order.
-- 9. Row Level Security (RLS) dan hak akses (grants/revokes).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Penambahan Kolom Finalisasi pada Tabel orders
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists is_finalized boolean not null default false,
  add column if not exists finalized_at timestamptz,
  add column if not exists finalized_by uuid
    references public.profiles (id) on delete set null;

create index if not exists orders_is_finalized_idx
  on public.orders (is_finalized)
  where (is_finalized = true);

comment on column public.orders.is_finalized is
  'Menandai apakah pesanan sudah difinalisasi oleh kasir sebelum pembayaran F2.';

-- ---------------------------------------------------------------------------
-- 2. Tabel Master Kebijakan Diskon & Promo (discounts)
-- ---------------------------------------------------------------------------
create table if not exists public.discounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  scope text not null check (scope in ('product', 'order')),
  discount_type text not null check (discount_type in ('percentage', 'fixed')),
  discount_value numeric(10,2) not null check (discount_value > 0),
  applies_to_category_id uuid
    references public.menu_categories (id) on delete set null,
  applies_to_product_id uuid
    references public.products (id) on delete set null,
  min_order_amount integer not null default 0 check (min_order_amount >= 0),
  max_discount_amount integer check (max_discount_amount is null or max_discount_amount > 0),
  is_active boolean not null default true,
  created_by uuid
    references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discounts_name_length_check check (
    char_length(btrim(name)) between 2 and 80
  ),
  constraint discounts_percentage_check check (
    discount_type <> 'percentage' or (discount_value > 0 and discount_value <= 100)
  ),
  constraint discounts_order_scope_targets_check check (
    scope <> 'order' or (applies_to_category_id is null and applies_to_product_id is null)
  )
);

create index if not exists discounts_active_scope_idx
  on public.discounts (is_active, scope, name);

drop trigger if exists discounts_handle_updated_at on public.discounts;
drop trigger if exists discounts_set_updated_at on public.discounts;
create trigger discounts_set_updated_at
  before update on public.discounts
  for each row
  execute function public.set_updated_at();

comment on table public.discounts is
  'Master data kebijakan diskon produk dan promo pesanan yang dikelola oleh Admin.';

-- ---------------------------------------------------------------------------
-- 3. Tabel Token Persetujuan Diskon Manual (discount_approval_nonces)
--    Single-use, terikat kasir, admin, nilai, alasan, dan batas waktu 5 menit.
-- ---------------------------------------------------------------------------
create table if not exists public.discount_approval_nonces (
  id uuid primary key default gen_random_uuid(),
  nonce text not null unique,
  approver_id uuid not null
    references public.profiles (id) on delete restrict,
  cashier_id uuid not null
    references public.profiles (id) on delete restrict,
  discount_type text not null check (discount_type in ('percentage', 'fixed')),
  discount_value numeric(10,2) not null check (discount_value > 0),
  reason text not null,
  context_ref text,
  is_used boolean not null default false,
  used_at timestamptz,
  used_in_order_id uuid
    references public.orders (id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint approval_nonce_reason_check check (
    char_length(btrim(reason)) >= 3
  )
);

create index if not exists approval_nonces_lookup_idx
  on public.discount_approval_nonces (nonce, is_used, expires_at);

comment on table public.discount_approval_nonces is
  'Token persetujuan diskon manual satu kali pakai yang diverifikasi secara server-side.';

-- ---------------------------------------------------------------------------
-- 4. Tabel Snapshot Diskon Transaksi (order_discounts)
-- ---------------------------------------------------------------------------
create table if not exists public.order_discounts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null
    references public.orders (id) on delete cascade,
  discount_id uuid
    references public.discounts (id) on delete set null,
  order_item_id uuid
    references public.order_items (id) on delete cascade,
  scope text not null check (scope in ('product', 'order', 'manual')),
  name text not null,
  discount_type text not null check (discount_type in ('percentage', 'fixed')),
  discount_rate numeric(10,2) not null check (discount_rate > 0),
  discount_amount integer not null check (discount_amount >= 0),
  reason text,
  approved_by uuid
    references public.profiles (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint order_discounts_manual_approval_check check (
    scope <> 'manual' or (
      approved_by is not null and
      reason is not null and
      char_length(btrim(reason)) >= 3
    )
  ),
  constraint order_discounts_scope_item_check check (
    (scope = 'product' and order_item_id is not null) or
    (scope in ('order', 'manual') and order_item_id is null)
  )
);

create unique index if not exists order_discounts_one_per_item_idx
  on public.order_discounts (order_item_id)
  where (scope = 'product');

create index if not exists order_discounts_order_id_idx
  on public.order_discounts (order_id);

comment on table public.order_discounts is
  'Snapshot seluruh diskon yang diterapkan pada pesanan (produk, pesanan, dan manual).';

-- ---------------------------------------------------------------------------
-- 5. Fungsi Utama Transaksi Pembuatan Pesanan F1.4 (create_pos_order_atomic - 3 Parameter)
-- ---------------------------------------------------------------------------
create or replace function public.create_pos_order_atomic(
  p_order jsonb,
  p_items jsonb,
  p_discounts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_idempotency_key text;
  v_existing_order record;
  v_order_type text;
  v_table_id uuid;
  v_session_id uuid;
  v_table record;
  v_order_number text;
  v_order_id uuid;
  v_item jsonb;
  v_item_id uuid;
  v_mod jsonb;
  v_item_count integer := 0;

  -- Variabel diskon
  v_disc jsonb;
  v_disc_scope text;
  v_disc_type text;
  v_disc_rate numeric;
  v_disc_amount integer;
  v_disc_name text;
  v_disc_reason text;
  v_disc_approver_id uuid;
  v_disc_target_item_id uuid;
  v_nonce text;
  v_nonce_rec record;
  v_master_disc record;
  v_target_product_id uuid;
  v_target_category_id uuid;
  v_max_discount_amount integer;

  v_subtotal_before_discount integer := 0;
  v_discount_product_total integer := 0;
  v_discount_order_total integer := 0;
  v_discount_manual_total integer := 0;
  v_discount_total integer := 0;
  v_subtotal_after_product_discount integer := 0;
  v_manual_discount_base integer := 0;
  v_taxable_base integer := 0;
  v_tax_percent numeric := 10;
  v_tax_total integer := 0;
  v_service_percent numeric := 5;
  v_service_total integer := 0;
  v_grand_total integer := 0;

  v_item_subtotal integer;
  v_item_discount integer;
  v_item_line_total integer;
  v_item_map jsonb := '{}'::jsonb;
begin
  v_user_id := auth.uid();
  v_user_role := public.current_user_role();

  if v_user_role not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir yang berhak membuat pesanan.';
  end if;

  -- 1. Cek Idempotency Key
  v_idempotency_key := nullif(btrim(p_order->>'idempotency_key'), '');
  if v_idempotency_key is not null then
    select * into v_existing_order
    from public.orders
    where idempotency_key = v_idempotency_key;

    if found then
      return jsonb_build_object(
        'id', v_existing_order.id,
        'order_number', v_existing_order.order_number,
        'order_type', v_existing_order.order_type,
        'table_id', v_existing_order.table_id,
        'dining_session_id', v_existing_order.dining_session_id,
        'status', v_existing_order.status,
        'payment_status', v_existing_order.payment_status,
        'subtotal', v_existing_order.subtotal,
        'discount_total', v_existing_order.discount_total,
        'tax_percent', v_existing_order.tax_percent,
        'tax_total', v_existing_order.tax_total,
        'service_charge_percent', v_existing_order.service_charge_percent,
        'service_total', v_existing_order.service_total,
        'grand_total', v_existing_order.grand_total,
        'is_finalized', v_existing_order.is_finalized,
        'created_at', v_existing_order.created_at,
        'is_duplicate', true
      );
    end if;
  end if;

  v_order_type := p_order->>'order_type';
  if v_order_type not in ('dine_in', 'takeaway') then
    raise exception 'Tipe pesanan tidak valid: %', v_order_type;
  end if;

  -- 2. Validasi & Penanganan Meja Dine-in
  if v_order_type = 'dine_in' then
    v_table_id := (p_order->>'table_id')::uuid;
    if v_table_id is null then
      raise exception 'Meja wajib dipilih untuk pesanan Dine-in.';
    end if;

    select * into v_table
    from public.dining_tables
    where id = v_table_id
    for update;

    if not found or not v_table.is_active then
      raise exception 'Meja tidak ditemukan atau sedang tidak aktif.';
    end if;

    if v_table.status = 'occupied' then
      raise exception 'Meja % sedang terisi. Pesanan baru tidak dapat dibuat untuk meja yang terisi.', v_table.name;
    end if;

    select id into v_session_id
    from public.dining_sessions
    where table_id = v_table_id
      and status = 'open'
    limit 1;

    if v_session_id is null then
      insert into public.dining_sessions (table_id, status, opened_by)
      values (v_table_id, 'open', v_user_id)
      returning id into v_session_id;
    end if;

    update public.dining_tables
    set status = 'awaiting_payment'
    where id = v_table_id;
  else
    v_table_id := null;
    v_session_id := null;
  end if;

  -- 3. Nomor pesanan harian
  v_order_number := public.generate_order_number();

  -- 4. Persiapan insert orders dengan nilai awal
  v_tax_percent := coalesce((p_order->>'tax_percent')::numeric, 10);
  v_service_percent := coalesce((p_order->>'service_charge_percent')::numeric, 5);

  insert into public.orders (
    order_number,
    order_type,
    table_id,
    dining_session_id,
    status,
    payment_status,
    customer_name,
    subtotal,
    discount_product_total,
    discount_order_total,
    discount_manual_total,
    discount_total,
    tax_percent,
    tax_total,
    service_charge_percent,
    service_total,
    grand_total,
    paid_total,
    idempotency_key,
    notes,
    is_finalized,
    created_by
  ) values (
    v_order_number,
    v_order_type,
    v_table_id,
    v_session_id,
    'awaiting_payment',
    'unpaid',
    nullif(btrim(p_order->>'customer_name'), ''),
    0, 0, 0, 0, 0,
    v_tax_percent, 0,
    v_service_percent, 0,
    0, 0,
    v_idempotency_key,
    nullif(btrim(p_order->>'notes'), ''),
    false,
    v_user_id
  ) returning id into v_order_id;

  -- 5. Insert order_items dan modifiers
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_item_subtotal := (v_item->>'subtotal')::integer;
    v_subtotal_before_discount := v_subtotal_before_discount + v_item_subtotal;

    insert into public.order_items (
      order_id,
      product_id,
      product_name_snapshot,
      product_sku_snapshot,
      unit_price_snapshot,
      quantity,
      notes,
      modifier_total,
      subtotal,
      discount_amount,
      line_total,
      kitchen_station
    ) values (
      v_order_id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name_snapshot',
      nullif(v_item->>'product_sku_snapshot', ''),
      (v_item->>'unit_price_snapshot')::integer,
      (v_item->>'quantity')::integer,
      nullif(v_item->>'notes', ''),
      coalesce((v_item->>'modifier_total')::integer, 0),
      v_item_subtotal,
      0,
      v_item_subtotal, -- default line_total = subtotal sebelum diskon produk
      nullif(v_item->>'kitchen_station', '')
    ) returning id into v_item_id;

    v_item_count := v_item_count + 1;

    -- Simpan peta client_item_id -> v_item_id jika ada
    if v_item ? 'client_item_id' then
      v_item_map := v_item_map || jsonb_build_object(v_item->>'client_item_id', v_item_id::text);
    end if;

    if v_item ? 'modifiers' and jsonb_array_length(v_item->'modifiers') > 0 then
      for v_mod in select * from jsonb_array_elements(v_item->'modifiers')
      loop
        insert into public.order_item_modifiers (
          order_item_id,
          modifier_option_id,
          group_name_snapshot,
          option_name_snapshot,
          price_delta_snapshot
        ) values (
          v_item_id,
          (v_mod->>'modifier_option_id')::uuid,
          v_mod->>'group_name_snapshot',
          v_mod->>'option_name_snapshot',
          coalesce((v_mod->>'price_delta_snapshot')::integer, 0)
        );
      end loop;
    end if;
  end loop;

  if v_item_count = 0 then
    raise exception 'Pesanan harus memiliki minimal satu item.';
  end if;

  -- 6. Proses dan Simpan Diskon (p_discounts)
  if p_discounts is not null and jsonb_array_length(p_discounts) > 0 then
    -- Tahap 6a: Diskon Produk
    for v_disc in select * from jsonb_array_elements(p_discounts)
    loop
      v_disc_scope := v_disc->>'scope';
      if v_disc_scope = 'product' then
        -- Ambil item target
        if v_disc ? 'order_item_id' then
          v_disc_target_item_id := (v_disc->>'order_item_id')::uuid;
        elsif v_disc ? 'client_item_id' and v_item_map ? (v_disc->>'client_item_id') then
          v_disc_target_item_id := (v_item_map->>(v_disc->>'client_item_id'))::uuid;
        else
          raise exception 'Diskon produk % tidak memiliki item target yang valid.', coalesce(v_disc->>'name', 'Produk');
        end if;

        -- Ambil subtotal dan product_id item bersangkutan
        select subtotal, product_id into v_item_subtotal, v_target_product_id
        from public.order_items
        where id = v_disc_target_item_id and order_id = v_order_id;

        if not found then
          raise exception 'Item target diskon produk tidak ditemukan pada pesanan.';
        end if;

        v_disc_name := coalesce(nullif(btrim(v_disc->>'name'), ''), 'Diskon Produk');
        v_disc_type := v_disc->>'discount_type';
        v_disc_rate := (v_disc->>'discount_rate')::numeric;
        v_max_discount_amount := null;

        -- H-2: Jika discount_id disediakan, ambil konfigurasi master diskon dari public.discounts
        if v_disc ? 'discount_id' and nullif(v_disc->>'discount_id', '') is not null then
          select * into v_master_disc
          from public.discounts
          where id = (v_disc->>'discount_id')::uuid;

          if not found or not v_master_disc.is_active then
            raise exception 'Kebijakan diskon produk tidak ditemukan atau sudah tidak aktif.';
          end if;

          if v_master_disc.scope <> 'product' then
            raise exception 'Kebijakan diskon % bukan untuk produk.', v_master_disc.name;
          end if;

          -- Override data resmi dari master promo
          v_disc_name := v_master_disc.name;
          v_disc_type := v_master_disc.discount_type;
          v_disc_rate := v_master_disc.discount_value;
          v_max_discount_amount := v_master_disc.max_discount_amount;

          -- Validasi kecocokan produk jika master promo menentukan applies_to_product_id
          if v_master_disc.applies_to_product_id is not null and v_master_disc.applies_to_product_id <> v_target_product_id then
            raise exception 'Promo % hanya berlaku untuk produk tertentu.', v_master_disc.name;
          end if;

          -- Validasi kecocokan kategori jika master promo menentukan applies_to_category_id
          if v_master_disc.applies_to_category_id is not null then
            select category_id into v_target_category_id
            from public.products
            where id = v_target_product_id;

            if v_target_category_id is distinct from v_master_disc.applies_to_category_id then
              raise exception 'Promo % hanya berlaku untuk kategori produk tertentu.', v_master_disc.name;
            end if;
          end if;
        end if;

        -- H-1: Hitung ulang secara authoritatif di SQL
        if v_disc_type = 'percentage' then
          if v_disc_rate <= 0 or v_disc_rate > 100 then
            raise exception 'Persentase diskon produk tidak valid (harus > 0 dan <= 100): %', v_disc_rate;
          end if;
          v_disc_amount := round((v_item_subtotal * v_disc_rate) / 100.0);
          if v_max_discount_amount is not null and v_disc_amount > v_max_discount_amount then
            v_disc_amount := v_max_discount_amount;
          end if;
        elsif v_disc_type = 'fixed' then
          if v_disc_rate <= 0 then
            raise exception 'Nominal diskon produk tidak valid: %', v_disc_rate;
          end if;
          v_disc_amount := round(v_disc_rate)::integer;
          if v_disc_amount > v_item_subtotal then
            raise exception 'Nilai diskon produk nominal (Rp %) melebihi subtotal baris item (Rp %).', v_disc_amount, v_item_subtotal;
          end if;
        else
          raise exception 'Tipe diskon produk tidak valid: %', v_disc_type;
        end if;

        if v_disc_amount > v_item_subtotal then
          v_disc_amount := v_item_subtotal;
        end if;

        v_discount_product_total := v_discount_product_total + v_disc_amount;

        -- Update order_items
        update public.order_items
        set
          discount_amount = v_disc_amount,
          line_total = v_item_subtotal - v_disc_amount
        where id = v_disc_target_item_id;

        -- Insert order_discounts
        insert into public.order_discounts (
          order_id,
          discount_id,
          order_item_id,
          scope,
          name,
          discount_type,
          discount_rate,
          discount_amount,
          reason,
          approved_by,
          approved_at
        ) values (
          v_order_id,
          nullif(v_disc->>'discount_id', '')::uuid,
          v_disc_target_item_id,
          'product',
          v_disc_name,
          v_disc_type,
          v_disc_rate,
          v_disc_amount,
          nullif(btrim(v_disc->>'reason'), ''),
          null,
          null
        );
      end if;
    end loop;

    v_subtotal_after_product_discount := v_subtotal_before_discount - v_discount_product_total;

    -- Tahap 6b: Diskon Seluruh Pesanan
    for v_disc in select * from jsonb_array_elements(p_discounts)
    loop
      v_disc_scope := v_disc->>'scope';
      if v_disc_scope = 'order' then
        v_disc_name := coalesce(nullif(btrim(v_disc->>'name'), ''), 'Diskon Pesanan');
        v_disc_type := v_disc->>'discount_type';
        v_disc_rate := (v_disc->>'discount_rate')::numeric;
        v_max_discount_amount := null;

        -- H-2: Jika discount_id disediakan, ambil konfigurasi master promo
        if v_disc ? 'discount_id' and nullif(v_disc->>'discount_id', '') is not null then
          select * into v_master_disc
          from public.discounts
          where id = (v_disc->>'discount_id')::uuid;

          if not found or not v_master_disc.is_active then
            raise exception 'Kebijakan promo pesanan tidak ditemukan atau sudah tidak aktif.';
          end if;

          if v_master_disc.scope <> 'order' then
            raise exception 'Kebijakan promo % bukan untuk pesanan.', v_master_disc.name;
          end if;

          if v_master_disc.min_order_amount > 0 and v_subtotal_before_discount < v_master_disc.min_order_amount then
            raise exception 'Pesanan tidak memenuhi syarat minimum belanja promo % (min. Rp %, subtotal Rp %).',
              v_master_disc.name, v_master_disc.min_order_amount, v_subtotal_before_discount;
          end if;

          -- Override data resmi dari master promo
          v_disc_name := v_master_disc.name;
          v_disc_type := v_master_disc.discount_type;
          v_disc_rate := v_master_disc.discount_value;
          v_max_discount_amount := v_master_disc.max_discount_amount;
        end if;

        -- H-1: Hitung ulang nominal diskon secara authoritatif di SQL
        if v_disc_type = 'percentage' then
          if v_disc_rate <= 0 or v_disc_rate > 100 then
            raise exception 'Persentase diskon pesanan tidak valid (harus > 0 dan <= 100): %', v_disc_rate;
          end if;
          v_disc_amount := round((v_subtotal_after_product_discount * v_disc_rate) / 100.0);
          if v_max_discount_amount is not null and v_disc_amount > v_max_discount_amount then
            v_disc_amount := v_max_discount_amount;
          end if;
        elsif v_disc_type = 'fixed' then
          if v_disc_rate <= 0 then
            raise exception 'Nominal diskon pesanan tidak valid: %', v_disc_rate;
          end if;
          v_disc_amount := round(v_disc_rate)::integer;
          if v_disc_amount > v_subtotal_after_product_discount then
            raise exception 'Nilai diskon pesanan nominal (Rp %) melebihi subtotal setelah diskon produk (Rp %).',
              v_disc_amount, v_subtotal_after_product_discount;
          end if;
        else
          raise exception 'Tipe diskon pesanan tidak valid: %', v_disc_type;
        end if;

        if v_disc_amount > v_subtotal_after_product_discount then
          v_disc_amount := v_subtotal_after_product_discount;
        end if;

        v_discount_order_total := v_discount_order_total + v_disc_amount;

        insert into public.order_discounts (
          order_id,
          discount_id,
          order_item_id,
          scope,
          name,
          discount_type,
          discount_rate,
          discount_amount,
          reason,
          approved_by,
          approved_at
        ) values (
          v_order_id,
          nullif(v_disc->>'discount_id', '')::uuid,
          null,
          'order',
          v_disc_name,
          v_disc_type,
          v_disc_rate,
          v_disc_amount,
          nullif(btrim(v_disc->>'reason'), ''),
          null,
          null
        );
      end if;
    end loop;

    -- Tahap 6c: Diskon Manual (Wajib Verifikasi & Konsumsi Nonce Approval)
    v_manual_discount_base := v_subtotal_after_product_discount - v_discount_order_total;

    for v_disc in select * from jsonb_array_elements(p_discounts)
    loop
      v_disc_scope := v_disc->>'scope';
      if v_disc_scope = 'manual' then
        v_disc_name := coalesce(nullif(btrim(v_disc->>'name'), ''), 'Diskon Manual');
        v_disc_type := v_disc->>'discount_type';
        v_disc_rate := (v_disc->>'discount_rate')::numeric;
        v_disc_reason := nullif(btrim(v_disc->>'reason'), '');
        v_nonce := nullif(btrim(v_disc->>'approval_nonce'), '');

        if v_nonce is null then
          raise exception 'Diskon manual wajib menyertakan token otorisasi admin (approval_nonce).';
        end if;

        if v_disc_reason is null or char_length(v_disc_reason) < 3 then
          raise exception 'Alasan diskon manual wajib diisi (minimal 3 karakter).';
        end if;

        -- Kunci dan verifikasi nonce
        select * into v_nonce_rec
        from public.discount_approval_nonces
        where nonce = v_nonce
        for update;

        if not found then
          raise exception 'Token persetujuan diskon manual tidak valid.';
        end if;

        if v_nonce_rec.is_used then
          raise exception 'Token persetujuan diskon manual sudah pernah digunakan.';
        end if;

        if now() > v_nonce_rec.expires_at then
          raise exception 'Token persetujuan diskon manual sudah kedaluwarsa.';
        end if;

        if v_nonce_rec.cashier_id <> v_user_id then
          raise exception 'Token persetujuan diskon tidak cocok dengan kasir pembuat pesanan.';
        end if;

        -- C-1: Verifikasi approver_id benar-benar Admin aktif di public.profiles
        if not exists (
          select 1
          from public.profiles
          where id = v_nonce_rec.approver_id
            and role = 'admin'
            and is_active = true
        ) then
          raise exception 'Pemberi otorisasi diskon manual bukan Admin aktif.';
        end if;

        if v_nonce_rec.discount_type <> v_disc_type or v_nonce_rec.discount_value <> v_disc_rate then
          raise exception 'Nilai atau jenis diskon tidak cocok dengan otorisasi admin.';
        end if;

        -- Validasi keterikatan konteks pesanan (context_ref) wajib berbasis idempotency_key keranjang
        if v_idempotency_key is null then
          raise exception 'Pesanan dengan diskon manual wajib menyertakan kunci idempotensi keranjang (idempotency_key).';
        end if;

        if v_nonce_rec.context_ref is null or btrim(v_nonce_rec.context_ref) = '' then
          raise exception 'Token persetujuan diskon tidak memiliki binding konteks keranjang yang valid.';
        end if;

        declare
          v_ref text := btrim(v_nonce_rec.context_ref);
          v_expected_ref text := v_idempotency_key;
        begin
          if v_ref like 'idempotency:%' then
            v_ref := substring(v_ref from 13);
          end if;

          if v_ref <> v_expected_ref then
            raise exception 'Token persetujuan diskon tidak cocok dengan keranjang pesanan ini (konteks: %, pesanan: %). Token tidak dapat dipindahkan antar keranjang.',
              v_nonce_rec.context_ref, v_expected_ref;
          end if;
        end;

        v_disc_approver_id := v_nonce_rec.approver_id;
        -- Gunakan alasan resmi yang disetujui Admin sebagai sumber kebenaran snapshot
        v_disc_reason := v_nonce_rec.reason;

        -- H-1: Hitung nominal diskon manual secara authoritatif di SQL
        if v_disc_type = 'percentage' then
          if v_disc_rate <= 0 or v_disc_rate > 100 then
            raise exception 'Persentase diskon manual tidak valid (harus > 0 dan <= 100): %', v_disc_rate;
          end if;
          v_disc_amount := round((v_manual_discount_base * v_disc_rate) / 100.0);
        elsif v_disc_type = 'fixed' then
          if v_disc_rate <= 0 then
            raise exception 'Nominal diskon manual tidak valid: %', v_disc_rate;
          end if;
          v_disc_amount := round(v_disc_rate)::integer;
          if v_disc_amount > v_manual_discount_base then
            raise exception 'Nilai diskon manual nominal (Rp %) melebihi batas subtotal yang dapat didiskon (Rp %).',
              v_disc_amount, v_manual_discount_base;
          end if;
        else
          raise exception 'Tipe diskon manual tidak valid: %', v_disc_type;
        end if;

        if v_disc_amount > v_manual_discount_base then
          v_disc_amount := v_manual_discount_base;
        end if;

        v_discount_manual_total := v_discount_manual_total + v_disc_amount;

        -- Tandai nonce sudah digunakan
        update public.discount_approval_nonces
        set
          is_used = true,
          used_at = now(),
          used_in_order_id = v_order_id
        where id = v_nonce_rec.id;

        insert into public.order_discounts (
          order_id,
          discount_id,
          order_item_id,
          scope,
          name,
          discount_type,
          discount_rate,
          discount_amount,
          reason,
          approved_by,
          approved_at
        ) values (
          v_order_id,
          null,
          null,
          'manual',
          v_disc_name,
          v_disc_type,
          v_disc_rate,
          v_disc_amount,
          v_disc_reason,
          v_disc_approver_id,
          now()
        );
      end if;
    end loop;
  end if;

  -- 7. Hitung Agregat Akhir & Pajak/Service
  v_discount_total := v_discount_product_total + v_discount_order_total + v_discount_manual_total;
  if v_discount_total > v_subtotal_before_discount then
    v_discount_total := v_subtotal_before_discount;
  end if;

  v_taxable_base := v_subtotal_before_discount - v_discount_total;
  if v_taxable_base < 0 then
    v_taxable_base := 0;
  end if;

  v_tax_total := round((v_taxable_base * v_tax_percent) / 100);
  v_service_total := round((v_taxable_base * v_service_percent) / 100);
  v_grand_total := v_taxable_base + v_tax_total + v_service_total;

  -- Update baris pesanan utama
  update public.orders
  set
    subtotal = v_subtotal_before_discount,
    discount_product_total = v_discount_product_total,
    discount_order_total = v_discount_order_total,
    discount_manual_total = v_discount_manual_total,
    discount_total = v_discount_total,
    tax_percent = v_tax_percent,
    tax_total = v_tax_total,
    service_charge_percent = v_service_percent,
    service_total = v_service_total,
    grand_total = v_grand_total
  where id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id,
    'order_number', v_order_number,
    'order_type', v_order_type,
    'table_id', v_table_id,
    'dining_session_id', v_session_id,
    'status', 'awaiting_payment',
    'payment_status', 'unpaid',
    'subtotal', v_subtotal_before_discount,
    'discount_total', v_discount_total,
    'grand_total', v_grand_total,
    'item_count', v_item_count,
    'is_finalized', false,
    'is_duplicate', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Fungsi Wrapper Kompatibilitas F1.3 (create_pos_order_atomic - 2 Parameter)
-- ---------------------------------------------------------------------------
create or replace function public.create_pos_order_atomic(
  p_order jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.create_pos_order_atomic(p_order, p_items, '[]'::jsonb);
end;
$$;

revoke all on function public.create_pos_order_atomic(jsonb, jsonb, jsonb) from anon;
grant execute on function public.create_pos_order_atomic(jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.create_pos_order_atomic(jsonb, jsonb, jsonb) to service_role;

revoke all on function public.create_pos_order_atomic(jsonb, jsonb) from anon;
grant execute on function public.create_pos_order_atomic(jsonb, jsonb) to authenticated;
grant execute on function public.create_pos_order_atomic(jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Pembaruan Fungsi append_order_items_atomic dengan Proteksi Finalisasi
-- ---------------------------------------------------------------------------
create or replace function public.append_order_items_atomic(
  p_order_id uuid,
  p_items jsonb,
  p_subtotal_delta integer,
  p_tax_delta integer,
  p_service_delta integer,
  p_grand_total_delta integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_role text;
  v_order record;
  v_item jsonb;
  v_item_id uuid;
  v_mod jsonb;
  v_appended_count integer := 0;

  -- Variabel kalkulasi ulang diskon dan total pesanan
  v_new_subtotal integer := 0;
  v_discount_product_total integer := 0;
  v_discount_order_total integer := 0;
  v_discount_manual_total integer := 0;
  v_discount_total integer := 0;
  v_subtotal_after_product_discount integer := 0;
  v_manual_discount_base integer := 0;
  v_taxable_base integer := 0;
  v_new_tax_total integer := 0;
  v_new_service_total integer := 0;
  v_new_grand_total integer := 0;
  v_disc_rec record;
  v_recomputed_amount integer;
  v_master_disc record;
begin
  v_user_role := public.current_user_role();

  if v_user_role not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir yang berhak memperbarui pesanan.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  if v_order.status <> 'awaiting_payment' or v_order.payment_status <> 'unpaid' then
    raise exception 'Hanya pesanan yang belum dibayar (Menunggu Pembayaran) yang dapat ditambah item.';
  end if;

  -- Proteksi Finalisasi
  if v_order.is_finalized then
    raise exception 'Pesanan sudah difinalisasi dan tidak dapat diubah.';
  end if;

  -- 1. Insert item dan modifiers baru
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.order_items (
      order_id,
      product_id,
      product_name_snapshot,
      product_sku_snapshot,
      unit_price_snapshot,
      quantity,
      notes,
      modifier_total,
      subtotal,
      discount_amount,
      line_total,
      kitchen_station
    ) values (
      v_order.id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name_snapshot',
      nullif(v_item->>'product_sku_snapshot', ''),
      (v_item->>'unit_price_snapshot')::integer,
      (v_item->>'quantity')::integer,
      nullif(v_item->>'notes', ''),
      coalesce((v_item->>'modifier_total')::integer, 0),
      (v_item->>'subtotal')::integer,
      0,
      (v_item->>'line_total')::integer,
      nullif(v_item->>'kitchen_station', '')
    ) returning id into v_item_id;

    v_appended_count := v_appended_count + 1;

    if v_item ? 'modifiers' and jsonb_array_length(v_item->'modifiers') > 0 then
      for v_mod in select * from jsonb_array_elements(v_item->'modifiers')
      loop
        insert into public.order_item_modifiers (
          order_item_id,
          modifier_option_id,
          group_name_snapshot,
          option_name_snapshot,
          price_delta_snapshot
        ) values (
          v_item_id,
          (v_mod->>'modifier_option_id')::uuid,
          v_mod->>'group_name_snapshot',
          v_mod->>'option_name_snapshot',
          coalesce((v_mod->>'price_delta_snapshot')::integer, 0)
        );
      end loop;
    end if;
  end loop;

  if v_appended_count = 0 then
    raise exception 'Tidak ada item yang ditambahkan.';
  end if;

  -- 2. Hitung subtotal baru seluruh item pesanan
  select coalesce(sum(subtotal), 0) into v_new_subtotal
  from public.order_items
  where order_id = v_order.id;

  -- 3. Pertahankan diskon produk yang sudah ada
  select coalesce(sum(discount_amount), 0) into v_discount_product_total
  from public.order_discounts
  where order_id = v_order.id and scope = 'product';

  v_subtotal_after_product_discount := v_new_subtotal - v_discount_product_total;
  if v_subtotal_after_product_discount < 0 then
    v_subtotal_after_product_discount := 0;
  end if;

  -- 4. Hitung ulang diskon pesanan (scope = 'order')
  for v_disc_rec in
    select *
    from public.order_discounts
    where order_id = v_order.id and scope = 'order'
    order by created_at asc
    for update
  loop
    if v_disc_rec.discount_type = 'percentage' then
      v_recomputed_amount := round((v_subtotal_after_product_discount * v_disc_rec.discount_rate) / 100.0);

      -- Cek max_discount_amount dari master promo jika ada
      if v_disc_rec.discount_id is not null then
        select * into v_master_disc
        from public.discounts
        where id = v_disc_rec.discount_id;

        if found and v_master_disc.max_discount_amount is not null and v_recomputed_amount > v_master_disc.max_discount_amount then
          v_recomputed_amount := v_master_disc.max_discount_amount;
        end if;
      end if;

      if v_recomputed_amount > v_subtotal_after_product_discount then
        v_recomputed_amount := v_subtotal_after_product_discount;
      end if;
    elsif v_disc_rec.discount_type = 'fixed' then
      -- fixed: pertahankan nominal tetap dan tolak jika melebihi dasar diskon setelah penambahan item
      v_recomputed_amount := v_disc_rec.discount_amount;
      if v_recomputed_amount > v_subtotal_after_product_discount then
        raise exception 'Nilai diskon pesanan nominal (Rp %) melebihi subtotal setelah penambahan item (Rp %).',
          v_recomputed_amount, v_subtotal_after_product_discount;
      end if;
    else
      v_recomputed_amount := v_disc_rec.discount_amount;
    end if;

    update public.order_discounts
    set discount_amount = v_recomputed_amount
    where id = v_disc_rec.id;

    v_discount_order_total := v_discount_order_total + v_recomputed_amount;
  end loop;

  -- 5. Hitung ulang diskon manual (scope = 'manual')
  v_manual_discount_base := v_subtotal_after_product_discount - v_discount_order_total;
  if v_manual_discount_base < 0 then
    v_manual_discount_base := 0;
  end if;

  for v_disc_rec in
    select *
    from public.order_discounts
    where order_id = v_order.id and scope = 'manual'
    order by created_at asc
    for update
  loop
    if v_disc_rec.discount_type = 'percentage' then
      v_recomputed_amount := round((v_manual_discount_base * v_disc_rec.discount_rate) / 100.0);
      if v_recomputed_amount > v_manual_discount_base then
        v_recomputed_amount := v_manual_discount_base;
      end if;
    elsif v_disc_rec.discount_type = 'fixed' then
      -- fixed: pertahankan nominal tetap dan tolak jika melebihi dasar diskon setelah penambahan item
      v_recomputed_amount := v_disc_rec.discount_amount;
      if v_recomputed_amount > v_manual_discount_base then
        raise exception 'Nilai diskon manual nominal (Rp %) melebihi sisa dasar subtotal setelah penambahan item (Rp %).',
          v_recomputed_amount, v_manual_discount_base;
      end if;
    else
      v_recomputed_amount := v_disc_rec.discount_amount;
    end if;

    update public.order_discounts
    set discount_amount = v_recomputed_amount
    where id = v_disc_rec.id;

    v_discount_manual_total := v_discount_manual_total + v_recomputed_amount;
  end loop;

  -- 6. Agregat final dan kalkulasi pajak/service
  v_discount_total := v_discount_product_total + v_discount_order_total + v_discount_manual_total;
  if v_discount_total > v_new_subtotal then
    v_discount_total := v_new_subtotal;
  end if;

  v_taxable_base := v_new_subtotal - v_discount_total;
  if v_taxable_base < 0 then
    v_taxable_base := 0;
  end if;

  v_new_tax_total := round((v_taxable_base * v_order.tax_percent) / 100.0);
  v_new_service_total := round((v_taxable_base * v_order.service_charge_percent) / 100.0);
  v_new_grand_total := v_taxable_base + v_new_tax_total + v_new_service_total;

  update public.orders
  set
    subtotal = v_new_subtotal,
    discount_product_total = v_discount_product_total,
    discount_order_total = v_discount_order_total,
    discount_manual_total = v_discount_manual_total,
    discount_total = v_discount_total,
    tax_total = v_new_tax_total,
    service_total = v_new_service_total,
    grand_total = v_new_grand_total
  where id = v_order.id;

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'status', v_order.status,
    'appended_count', v_appended_count,
    'new_subtotal', v_new_subtotal,
    'new_discount_total', v_discount_total,
    'new_grand_total', v_new_grand_total
  );
end;
$$;

revoke all on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) from anon;
grant execute on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) to authenticated;
grant execute on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Fungsi Finalisasi dan Pembukaan Kembali Pesanan (finalize / unfinalize)
-- ---------------------------------------------------------------------------
create or replace function public.finalize_pos_order(
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_order record;
  v_item_count integer;
begin
  v_user_id := auth.uid();
  v_user_role := public.current_user_role();

  if v_user_role not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir yang berhak memfinalisasi pesanan.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  if v_order.status <> 'awaiting_payment' or v_order.payment_status <> 'unpaid' then
    raise exception 'Hanya pesanan belum lunas yang dapat difinalisasi.';
  end if;

  if v_order.is_finalized then
    raise exception 'Pesanan sudah difinalisasi sebelumnya.';
  end if;

  select count(*) into v_item_count
  from public.order_items
  where order_id = p_order_id;

  if v_item_count = 0 then
    raise exception 'Pesanan tanpa item tidak dapat difinalisasi.';
  end if;

  update public.orders
  set
    is_finalized = true,
    finalized_at = now(),
    finalized_by = v_user_id
  where id = p_order_id;

  -- M-1: Pencatatan Audit Log Finalisasi Pesanan
  insert into public.audit_logs (
    user_id,
    action,
    entity,
    entity_id,
    details
  ) values (
    v_user_id,
    'order.finalize',
    'order',
    p_order_id::text,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'grand_total', v_order.grand_total,
      'actor_role', v_user_role
    )
  );

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'is_finalized', true,
    'grand_total', v_order.grand_total,
    'finalized_at', now()
  );
end;
$$;

revoke all on function public.finalize_pos_order(uuid) from anon;
grant execute on function public.finalize_pos_order(uuid) to authenticated;
grant execute on function public.finalize_pos_order(uuid) to service_role;

create or replace function public.unfinalize_pos_order(
  p_order_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_order record;
begin
  v_user_id := auth.uid();
  v_user_role := public.current_user_role();

  if v_user_role not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir yang berhak membuka kembali pesanan final.';
  end if;

  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'Alasan pembukaan kembali pesanan wajib diisi (minimal 3 karakter).';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  if not v_order.is_finalized then
    raise exception 'Pesanan ini belum difinalisasi.';
  end if;

  if v_order.payment_status <> 'unpaid' then
    raise exception 'Pesanan yang sudah memiliki pembayaran tidak dapat dibuka kembali.';
  end if;

  update public.orders
  set
    is_finalized = false,
    finalized_at = null,
    finalized_by = null
  where id = p_order_id;

  -- M-1: Pencatatan Audit Log Pembukaan Kembali Finalisasi Pesanan
  insert into public.audit_logs (
    user_id,
    action,
    entity,
    entity_id,
    details
  ) values (
    v_user_id,
    'order.unfinalize',
    'order',
    p_order_id::text,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'grand_total', v_order.grand_total,
      'reason', btrim(p_reason),
      'actor_role', v_user_role
    )
  );

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'is_finalized', false,
    'reason', btrim(p_reason)
  );
end;
$$;

revoke all on function public.unfinalize_pos_order(uuid, text) from anon;
grant execute on function public.unfinalize_pos_order(uuid, text) to authenticated;
grant execute on function public.unfinalize_pos_order(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Row Level Security (RLS) dan Grants
-- ---------------------------------------------------------------------------
alter table public.discounts enable row level security;
alter table public.discount_approval_nonces enable row level security;
alter table public.order_discounts enable row level security;

-- Discounts: Staf baca; Admin tulis
create policy "discounts_select_staff" on public.discounts
  for select to authenticated
  using (public.current_user_role() in ('admin', 'kasir'));

create policy "discounts_insert_admin" on public.discounts
  for insert to authenticated
  with check (public.current_user_role() = 'admin');

create policy "discounts_update_admin" on public.discounts
  for update to authenticated
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

create policy "discounts_delete_admin" on public.discounts
  for delete to authenticated
  using (public.current_user_role() = 'admin');

-- Approval Nonces: Staf baca saja; Penulisan DILARANG lewat REST API kasir.
-- Pembuatan nonce HANYA dapat dilakukan oleh Server Action tepercaya dengan hak service_role
-- setelah verifikasi kredensial Admin lewat client auth terisolasi (C-1).
create policy "approval_nonces_select_staff" on public.discount_approval_nonces
  for select to authenticated
  using (public.current_user_role() in ('admin', 'kasir'));

-- Order Discounts: Staf baca saja melalui REST API.
-- Penulisan DILARANG lewat PostgREST publik untuk mencegah manipulasi client;
-- seluruh penulisan diwajibkan melalui fungsi SECURITY DEFINER create_pos_order_atomic.
create policy "order_discounts_select_staff" on public.order_discounts
  for select to authenticated
  using (public.current_user_role() in ('admin', 'kasir'));

-- Grants & Revokes
revoke all on public.discounts from anon;
grant select on public.discounts to authenticated;
grant insert, update, delete on public.discounts to authenticated;
grant all on public.discounts to service_role;

revoke all on public.discount_approval_nonces from anon;
revoke insert on public.discount_approval_nonces from authenticated;
grant select on public.discount_approval_nonces to authenticated;
grant all on public.discount_approval_nonces to service_role;

revoke all on public.order_discounts from anon;
grant select on public.order_discounts to authenticated;
grant all on public.order_discounts to service_role;

