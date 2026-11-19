import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

// Baca file canonical create_pos_order_atomic dari 20261115000300_fix_create_pos_order_atomic.sql
const fixCreatePosOrderSql = fs.readFileSync(
  path.join(ROOT, "supabase/migrations/20261115000300_fix_create_pos_order_atomic.sql"),
  "utf-8"
);

// Baca file append_order_items_atomic dari 20261114000100_additional_orders_table_status.sql
const appendOrderItemsSql = fs.readFileSync(
  path.join(ROOT, "supabase/migrations/20261114000100_additional_orders_table_status.sql"),
  "utf-8"
);

// Ambil blok fungsi create_pos_order_atomic (3 parameter)
const createPosOrderStart = fixCreatePosOrderSql.indexOf("create or replace function public.create_pos_order_atomic(\n  p_order jsonb,");
const createPosOrderEnd = fixCreatePosOrderSql.indexOf("end;\n$$;", createPosOrderStart) + "end;\n$$;".length;
let createPosOrderFn = fixCreatePosOrderSql.slice(createPosOrderStart, createPosOrderEnd);

// Sisipkan perform public.reserve_order_stock_internal(v_order_id); sebelum return jsonb_build_object(
const createReturnTarget = "  return jsonb_build_object(\n    'id', v_order_id,";
const createReservationInsertion = "  -- 8b. Validasi & Reservasi Kebutuhan Bahan Baku secara Atomik (F4.4)\n  perform public.reserve_order_stock_internal(v_order_id);\n\n  return jsonb_build_object(\n    'id', v_order_id,";

if (!createPosOrderFn.includes(createReturnTarget)) {
  console.error("Gagal menemukan target return di create_pos_order_atomic!");
  process.exit(1);
}
createPosOrderFn = createPosOrderFn.replace(createReturnTarget, createReservationInsertion);

// Ambil blok fungsi append_order_items_atomic
const appendStart = appendOrderItemsSql.indexOf("create or replace function public.append_order_items_atomic(");
const appendEnd = appendOrderItemsSql.indexOf("end;\n$$;", appendStart) + "end;\n$$;".length;
let appendFn = appendOrderItemsSql.slice(appendStart, appendEnd);

// Sisipkan perform public.reserve_order_stock_internal(v_order.id); sebelum return jsonb_build_object(
const appendReturnTarget = "  return jsonb_build_object(\n    'order_id', v_order.id,";
const appendReservationInsertion = "  -- Validasi & Reservasi Kebutuhan Bahan Baku Tambahan secara Atomik (F4.4)\n  perform public.reserve_order_stock_internal(v_order.id);\n\n  return jsonb_build_object(\n    'order_id', v_order.id,";

if (!appendFn.includes(appendReturnTarget)) {
  console.error("Gagal menemukan target return di append_order_items_atomic!");
  process.exit(1);
}
appendFn = appendFn.replace(appendReturnTarget, appendReservationInsertion);

console.log("Ekstraksi & modifikasi fungsi atomic berhasil.");

// Siapkan migration SQL lengkap
const migrationHeader = `-- =============================================================================
-- NINE LICIOUS POS — F4.4: SISTEM RESERVASI STOK & STRICT NON-NEGATIVE INVENTORY
-- =============================================================================
-- Migration: 20261119000300_f4_stock_reservation_and_strict_positive.sql
-- Tanggal: 19 November 2026
--
-- FOKUS & KONTRAK UTAMA:
-- 1. Pesanan tidak boleh dibuat jika bahan baku tidak mencukupi (Level 8 Locking).
-- 2. Stok fisik dan stok tersedia dilarang keras bernilai negatif.
-- 3. Reservasi bahan baku otomatis saat pesanan dibuat (create_pos_order_atomic & append_order_items_atomic).
-- 4. Konversi reservasi ke mutasi aktual (sale_deduction) saat pesanan lunas.
-- 5. Pelepasan reservasi otomatis saat pesanan batal (cancelled) atau expired.
-- 6. Penyesuaian stok manual dilarang membuat stok fisik lebih kecil dari reservasi aktif.
-- 7. Opening Balance & Stock Opname Setup untuk seluruh 74 bahan baku.
-- =============================================================================

begin;

-- =============================================================================
-- 1. STRUKTUR DATA: KOLOM RESERVED_STOCK PADA public.ingredients
-- =============================================================================
alter table public.ingredients
  add column if not exists reserved_stock numeric(12, 3) not null default 0;

comment on column public.ingredients.reserved_stock is
  'Jumlah stok bahan baku yang sedang direservasi oleh pesanan aktif yang belum lunas. Stok tersedia = current_stock - reserved_stock.';

-- =============================================================================
-- 2. TABEL BUKU BESAR RESERVASI: public.ingredient_reservations
-- =============================================================================
create table if not exists public.ingredient_reservations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete restrict,
  quantity_reserved numeric(12, 3) not null check (quantity_reserved > 0),
  status text not null default 'active' check (status in ('active', 'fulfilled', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ingredient_reservations_order_ingredient_unique unique (order_id, ingredient_id)
);

comment on table public.ingredient_reservations is
  'Pencatatan reservasi bahan baku per pesanan aktif. Status active berarti stok terkunci; fulfilled berarti telah dibayar lunas & stok fisik terpotong; released berarti pesanan batal/expired.';

create index if not exists idx_ingredient_reservations_order_status
  on public.ingredient_reservations (order_id, status);

create index if not exists idx_ingredient_reservations_ingredient_status
  on public.ingredient_reservations (ingredient_id, status);

alter table public.ingredient_reservations enable row level security;

drop policy if exists ingredient_reservations_select_admin on public.ingredient_reservations;
create policy ingredient_reservations_select_admin
  on public.ingredient_reservations
  for select
  to authenticated
  using (public.is_admin() or public.current_user_role() in ('admin', 'kasir'));

-- =============================================================================
-- 3. OPENING BALANCE & STOCK OPNAME SETUP UNTUK SELURUH 74 BAHAN BAKU
-- =============================================================================
-- Memastikan seluruh 74 bahan baku memiliki saldo awal positif rasional
-- sebelum constraint non-negatif diaktifkan.
do $$
declare
  v_admin_id uuid;
  v_ing record;
  v_target numeric(12, 3);
  v_before numeric(12, 3);
  v_delta numeric(12, 3);
  v_now timestamptz := now();
  v_targets jsonb := jsonb_build_object(
    'ING-BEVG-01', 5000,
    'ING-BEVG-02', 10000,
    'ING-BEVG-03', 30000,
    'ING-BEVG-04', 4000,
    'ING-BEVG-05', 5000,
    'ING-BEVG-06', 4000,
    'ING-BEVG-07', 5000,
    'ING-BEVG-08', 5000,
    'ING-BEVG-09', 5000,
    'ING-BEVG-10', 5000,
    'ING-BEVG-11', 120,
    'ING-BEVG-12', 50000,
    'ING-BEVG-13', 500000,
    'ING-CARB-01', 30000,
    'ING-CARB-02', 10000,
    'ING-CARB-03', 20000,
    'ING-CARB-04', 100,
    'ING-CARB-05', 80,
    'ING-CARB-06', 150,
    'ING-CARB-07', 3000,
    'ING-DEST-01', 8000,
    'ING-DEST-02', 4000,
    'ING-DEST-03', 4000,
    'ING-DEST-04', 3000,
    'ING-DEST-05', 3000,
    'ING-DEST-06', 150,
    'ING-DEST-07', 4000,
    'ING-DEST-08', 8000,
    'ING-DEST-09', 8000,
    'ING-DEST-10', 8000,
    'ING-DEST-11', 4000,
    'ING-DEST-12', 3000,
    'ING-DEST-13', 3000,
    'ING-DEST-14', 3000,
    'ING-DEST-15', 3000,
    'ING-DEST-16', 150,
    'ING-FLOU-01', 20000,
    'ING-FLOU-02', 5000,
    'ING-FLOU-03', 5000,
    'ING-PROT-01', 20000,
    'ING-PROT-02', 300,
    'ING-PROT-03', 10000,
    'ING-PROT-04', 10000,
    'ING-PROT-05', 10000,
    'ING-PROT-06', 10000,
    'ING-PROT-07', 10000,
    'ING-PROT-08', 300,
    'ING-SEAS-01', 30000,
    'ING-SEAS-02', 6000,
    'ING-SEAS-03', 20000,
    'ING-SEAS-04', 10000,
    'ING-SEAS-05', 5000,
    'ING-SEAS-06', 5000,
    'ING-SEAS-07', 5000,
    'ING-SEAS-08', 5000,
    'ING-SEAS-09', 5000,
    'ING-SEAS-10', 10000,
    'ING-SEAS-11', 5000,
    'ING-SEAS-12', 5000,
    'ING-SEAS-13', 5000,
    'ING-SEAS-14', 3000,
    'ING-SEAS-15', 3000,
    'ING-SEAS-16', 3000,
    'ING-SEAS-17', 3000,
    'ING-SEAS-18', 3000,
    'ING-VEGE-01', 10000,
    'ING-VEGE-02', 3000,
    'ING-VEGE-03', 3000,
    'ING-VEGE-04', 3000,
    'ING-VEGE-05', 3000,
    'ING-VEGE-06', 100,
    'ING-VEGE-07', 150,
    'ING-VEGE-08', 150,
    'POP-ES-03', 10
  );
  v_sku text;
begin
  select id into v_admin_id from public.profiles where role = 'admin' and is_active = true limit 1;

  for v_sku, v_target in select key, value::numeric from jsonb_each_text(v_targets) loop
    select * into v_ing from public.ingredients where sku = v_sku for update;
    if found then
      v_before := v_ing.current_stock;

      -- Hanya lakukan penyesuaian jika saldo saat ini belum mencapai target operasional
      if v_before < v_target then
        v_delta := v_target - v_before;

        perform set_config('nine_licious.allow_stock_mutation', 'on', true);

        update public.ingredients
        set
          current_stock = v_target,
          updated_at = v_now
        where id = v_ing.id;

        insert into public.stock_movements (
          ingredient_id,
          movement_type,
          quantity_delta,
          stock_before,
          stock_after,
          reason,
          created_by,
          idempotency_key,
          created_at
        ) values (
          v_ing.id,
          'stock_opname',
          v_delta,
          v_before,
          v_target,
          'Opening Balance & Stock Opname Setup (Sesuai Kebutuhan Resep Operasional)',
          v_admin_id,
          'opening_balance_f4_' || v_sku,
          v_now
        )
        on conflict (idempotency_key) where (idempotency_key is not null) do nothing;
      end if;
    end if;
  end loop;
end $$;

-- =============================================================================
-- 4. AKTIVASI CONSTRAINT NON-NEGATIF KETAT
-- =============================================================================
alter table public.ingredients
  drop constraint if exists ingredients_current_stock_non_negative_check;
alter table public.ingredients
  add constraint ingredients_current_stock_non_negative_check
  check (current_stock >= 0);

alter table public.ingredients
  drop constraint if exists ingredients_reserved_stock_non_negative_check;
alter table public.ingredients
  add constraint ingredients_reserved_stock_non_negative_check
  check (reserved_stock >= 0);

alter table public.ingredients
  drop constraint if exists ingredients_available_stock_non_negative_check;
alter table public.ingredients
  add constraint ingredients_available_stock_non_negative_check
  check (current_stock >= reserved_stock);

-- =============================================================================
-- 5. FUNGSI ATOMIK INTERNAL: RESERVASI KEBUTUHAN STOK PESANAN
-- =============================================================================
create or replace function public.reserve_order_stock_internal(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order record;
  v_req record;
  v_ing record;
  v_existing_res record;
  v_needed numeric(12, 3);
  v_available numeric(12, 3);
  v_delta numeric(12, 3);
  v_reserved_count integer := 0;
begin
  if p_order_id is null then
    raise exception 'ID pesanan tidak valid untuk reservasi stok.';
  end if;

  select id, order_number, status, payment_status, created_by
  into v_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception 'Pesanan tidak ditemukan untuk reservasi stok.';
  end if;

  if v_order.status in ('cancelled', 'refunded') then
    raise exception 'Pesanan dalam status batal tidak dapat mereservasi stok.';
  end if;

  if v_order.payment_status = 'paid' then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'order_already_paid');
  end if;

  -- Kunci dan validasi seluruh bahan baku yang dibutuhkan dalam urutan id ASC
  for v_req in
    select
      r.ingredient_id,
      round(sum(r.quantity_required * oi.quantity)::numeric, 3) as total_required
    from public.order_items oi
    inner join public.recipes r
      on r.product_id = oi.product_id
    where oi.order_id = p_order_id
      and oi.quantity > 0
    group by r.ingredient_id
    having round(sum(r.quantity_required * oi.quantity)::numeric, 3) > 0
    order by r.ingredient_id asc
  loop
    select id, name, unit, current_stock, reserved_stock, is_active
    into v_ing
    from public.ingredients
    where id = v_req.ingredient_id
    for update;

    if not found or v_ing.is_active is distinct from true then
      raise exception
        'Bahan baku "%" tidak aktif atau tidak ditemukan dalam master.',
        coalesce(v_ing.name, v_req.ingredient_id::text);
    end if;

    select *
    into v_existing_res
    from public.ingredient_reservations
    where order_id = p_order_id
      and ingredient_id = v_req.ingredient_id
      and status = 'active';

    if found then
      v_delta := v_req.total_required - v_existing_res.quantity_reserved;
    else
      v_delta := v_req.total_required;
    end if;

    if v_delta > 0 then
      v_available := v_ing.current_stock - v_ing.reserved_stock;
      if v_available < v_delta then
        raise exception
          'Stok bahan baku "%" tidak mencukupi untuk pesanan ini. Stok tersedia: % %, Dibutuhkan tambahan: % %.',
          v_ing.name,
          round(v_available::numeric, 2),
          v_ing.unit,
          round(v_delta::numeric, 2),
          v_ing.unit;
      end if;
    end if;

    if found then
      update public.ingredient_reservations
      set
        quantity_reserved = v_req.total_required,
        updated_at = now()
      where id = v_existing_res.id;
    else
      insert into public.ingredient_reservations (
        order_id,
        ingredient_id,
        quantity_reserved,
        status,
        created_at,
        updated_at
      ) values (
        p_order_id,
        v_req.ingredient_id,
        v_req.total_required,
        'active',
        now(),
        now()
      );
    end if;

    if v_delta <> 0 then
      perform set_config('nine_licious.allow_stock_mutation', 'on', true);
      update public.ingredients
      set
        reserved_stock = reserved_stock + v_delta,
        updated_at = now()
      where id = v_ing.id;
    end if;

    v_reserved_count := v_reserved_count + 1;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'reserved_ingredients_count', v_reserved_count
  );
end;
$$;

revoke all on function public.reserve_order_stock_internal(uuid) from public;
grant execute on function public.reserve_order_stock_internal(uuid) to authenticated;
grant execute on function public.reserve_order_stock_internal(uuid) to service_role;

-- =============================================================================
-- 6. FUNGSI ATOMIK INTERNAL: PELEPASAN RESERVASI (CANCEL / EXPIRE)
-- =============================================================================
create or replace function public.release_order_stock_reservations_internal(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res record;
  v_ing record;
  v_released_count integer := 0;
begin
  if p_order_id is null then
    return jsonb_build_object('ok', false, 'reason', 'null_order_id');
  end if;

  for v_res in
    select ir.id, ir.ingredient_id, ir.quantity_reserved
    from public.ingredient_reservations ir
    where ir.order_id = p_order_id
      and ir.status = 'active'
    order by ir.ingredient_id asc
  loop
    select id, reserved_stock
    into v_ing
    from public.ingredients
    where id = v_res.ingredient_id
    for update;

    if found then
      perform set_config('nine_licious.allow_stock_mutation', 'on', true);

      update public.ingredients
      set
        reserved_stock = greatest(0::numeric, reserved_stock - v_res.quantity_reserved),
        updated_at = now()
      where id = v_ing.id;
    end if;

    update public.ingredient_reservations
    set
      status = 'released',
      updated_at = now()
    where id = v_res.id;

    v_released_count := v_released_count + 1;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'released_count', v_released_count
  );
end;
$$;

revoke all on function public.release_order_stock_reservations_internal(uuid) from public;
grant execute on function public.release_order_stock_reservations_internal(uuid) to authenticated;
grant execute on function public.release_order_stock_reservations_internal(uuid) to service_role;

-- =============================================================================
-- 7. FUNGSI ATOMIK INTERNAL: KONVERSI RESERVASI KE MUTASI PENJUALAN (LUNAS)
-- =============================================================================
create or replace function public.deduct_order_stock_internal(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order record;
  v_res record;
  v_ing record;
  v_delta numeric(12, 3);
  v_stock_before numeric(12, 3);
  v_stock_after numeric(12, 3);
  v_now timestamptz := now();
  v_deducted_count integer := 0;
  v_inserted_id uuid;
begin
  if p_order_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_order_id', 'deducted_count', 0);
  end if;

  select id, order_number, status, payment_status, created_by
  into v_order
  from public.orders
  where id = p_order_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'order_not_found', 'deducted_count', 0);
  end if;

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

  -- SKENARIO A: Pesanan memiliki reservasi aktif di public.ingredient_reservations
  for v_res in
    select ir.id as reservation_id, ir.ingredient_id, ir.quantity_reserved
    from public.ingredient_reservations ir
    where ir.order_id = p_order_id
      and ir.status = 'active'
    order by ir.ingredient_id asc
  loop
    select id, name, current_stock, reserved_stock
    into v_ing
    from public.ingredients
    where id = v_res.ingredient_id
    for update;

    if not found then
      continue;
    end if;

    v_stock_before := v_ing.current_stock;
    v_delta := -v_res.quantity_reserved;
    v_stock_after := v_stock_before + v_delta;

    v_inserted_id := null;
    insert into public.stock_movements (
      ingredient_id,
      movement_type,
      quantity_delta,
      stock_before,
      stock_after,
      order_id,
      reason,
      created_by,
      created_at
    ) values (
      v_ing.id,
      'sale_deduction',
      v_delta,
      v_stock_before,
      v_stock_after,
      v_order.id,
      format('Pengurangan stok otomatis dari pesanan lunas #%s', v_order.order_number),
      v_order.created_by,
      v_now
    )
    on conflict (order_id, ingredient_id)
      where (movement_type = 'sale_deduction' and order_id is not null)
    do nothing
    returning id into v_inserted_id;

    if v_inserted_id is not null then
      perform set_config('nine_licious.allow_stock_mutation', 'on', true);

      update public.ingredients
      set
        current_stock = v_stock_after,
        reserved_stock = greatest(0::numeric, reserved_stock - v_res.quantity_reserved),
        updated_at = v_now
      where id = v_ing.id;

      update public.ingredient_reservations
      set
        status = 'fulfilled',
        updated_at = v_now
      where id = v_res.reservation_id;

      v_deducted_count := v_deducted_count + 1;
    else
      update public.ingredient_reservations
      set
        status = 'fulfilled',
        updated_at = v_now
      where id = v_res.reservation_id;
    end if;
  end loop;

  -- SKENARIO B: Pesanan historis / pesanan tanpa reservasi aktif sebelumnya
  if v_deducted_count = 0 then
    for v_res in
      select
        r.ingredient_id,
        round(sum(r.quantity_required * oi.quantity)::numeric, 3) as total_required
      from public.order_items oi
      inner join public.recipes r
        on r.product_id = oi.product_id
      where oi.order_id = p_order_id
        and oi.quantity > 0
      group by r.ingredient_id
      having round(sum(r.quantity_required * oi.quantity)::numeric, 3) > 0
      order by r.ingredient_id asc
    loop
      select id, name, current_stock, reserved_stock
      into v_ing
      from public.ingredients
      where id = v_res.ingredient_id
      for update;

      if not found then
        continue;
      end if;

      v_stock_before := v_ing.current_stock;
      v_delta := -v_res.total_required;
      v_stock_after := v_stock_before + v_delta;

      v_inserted_id := null;
      insert into public.stock_movements (
        ingredient_id,
        movement_type,
        quantity_delta,
        stock_before,
        stock_after,
        order_id,
        reason,
        created_by,
        created_at
      ) values (
        v_ing.id,
        'sale_deduction',
        v_delta,
        v_stock_before,
        v_stock_after,
        v_order.id,
        format('Pengurangan stok otomatis dari pesanan lunas #%s', v_order.order_number),
        v_order.created_by,
        v_now
      )
      on conflict (order_id, ingredient_id)
        where (movement_type = 'sale_deduction' and order_id is not null)
      do nothing
      returning id into v_inserted_id;

      if v_inserted_id is not null then
        perform set_config('nine_licious.allow_stock_mutation', 'on', true);
        update public.ingredients
        set
          current_stock = v_stock_after,
          updated_at = v_now
        where id = v_ing.id;

        v_deducted_count := v_deducted_count + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'order_id', v_order.id,
    'deducted_count', v_deducted_count
  );
end;
$$;

-- =============================================================================
-- 8. TRIGGER PADA public.orders: PEMBATALAN & KEDALUWARSA MELEPASKAN RESERVASI
-- =============================================================================
create or replace function public.trg_fn_orders_release_stock_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (old.status is distinct from new.status and new.status in ('cancelled', 'expired')) then
    perform public.release_order_stock_reservations_internal(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_orders_release_stock_on_cancel on public.orders;
create trigger trg_orders_release_stock_on_cancel
  after update of status on public.orders
  for each row
  when (new.status in ('cancelled', 'expired'))
  execute function public.trg_fn_orders_release_stock_on_cancel();

-- =============================================================================
-- 9. UPDATE adjust_ingredient_stock_atomic: LARANGAN MEMBUAT STOK FISIK < RESERVASI
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
  v_available numeric(12, 3);
  v_now timestamptz := now();
  v_movement_id uuid;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select username, role, is_active
  into v_username, v_user_role, v_is_active
  from public.profiles
  where id = v_user_id;

  if not found or v_is_active is distinct from true or v_user_role <> 'admin' then
    raise exception 'Hanya Admin aktif yang memiliki hak akses untuk melakukan penyesuaian stok bahan baku.';
  end if;

  if p_movement_type not in ('manual_in', 'manual_out', 'stock_opname') then
    raise exception 'Jenis penyesuaian stok tidak valid (harus manual_in, manual_out, atau stock_opname).';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'Alasan penyesuaian stok wajib diisi antara 3 hingga 500 karakter.';
  end if;

  if p_quantity is null or p_quantity != p_quantity then
    raise exception 'Nilai kuantitas penyesuaian stok tidak valid.';
  end if;

  v_qty := round(p_quantity::numeric, 3);

  if p_movement_type in ('manual_in', 'manual_out') and v_qty <= 0 then
    raise exception 'Kuantitas penyesuaian stok manual wajib bernilai positif lebih dari 0.';
  end if;

  if p_movement_type = 'stock_opname' and v_qty < 0 then
    raise exception 'Stok aktual pada stock_opname tidak boleh negatif.';
  end if;

  v_idempotency_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_idempotency_key is not null
     and (char_length(v_idempotency_key) < 8 or char_length(v_idempotency_key) > 128) then
    raise exception 'Format idempotency_key penyesuaian stok tidak valid (8–128 karakter).';
  end if;

  select id, name, unit, current_stock, reserved_stock, min_stock, is_active
  into v_ingredient
  from public.ingredients
  where id = p_ingredient_id
  for update;

  if not found then
    raise exception 'Bahan baku tidak ditemukan.';
  end if;

  if not v_ingredient.is_active then
    raise exception 'Bahan baku "%" sedang diarsipkan. Aktifkan kembali bahan baku sebelum melakukan mutasi stok.', v_ingredient.name;
  end if;

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
        'ok', true,
        'idempotent_replay', true,
        'movement_id', v_existing_movement.id,
        'ingredient_id', v_ingredient.id,
        'ingredient_name', v_ingredient.name,
        'unit', v_ingredient.unit,
        'movement_type', v_existing_movement.movement_type,
        'quantity_delta', v_existing_movement.quantity_delta,
        'stock_before', v_existing_movement.stock_before,
        'stock_after', v_existing_movement.stock_after,
        'current_stock', v_ingredient.current_stock,
        'reserved_stock', v_ingredient.reserved_stock,
        'available_stock', (v_ingredient.current_stock - v_ingredient.reserved_stock),
        'reason', v_existing_movement.reason,
        'created_at', v_existing_movement.created_at
      );
    end if;
  end if;

  v_stock_before := v_ingredient.current_stock;
  v_available := v_ingredient.current_stock - v_ingredient.reserved_stock;

  if p_movement_type = 'manual_in' then
    v_delta := v_qty;
    v_stock_after := v_stock_before + v_delta;

  elsif p_movement_type = 'manual_out' then
    if v_qty > v_available then
      raise exception
        'Pengurangan stok manual (% %) melebihi stok yang tersedia (% %). Direservasi pesanan aktif: % %.',
        v_qty,
        v_ingredient.unit,
        round(v_available::numeric, 2),
        v_ingredient.unit,
        round(v_ingredient.reserved_stock::numeric, 2),
        v_ingredient.unit;
    end if;
    v_delta := -v_qty;
    v_stock_after := v_stock_before + v_delta;

  elsif p_movement_type = 'stock_opname' then
    if v_qty < v_ingredient.reserved_stock then
      raise exception
        'Hasil stock opname (% %) tidak boleh lebih kecil dari stok yang sedang direservasi pesanan aktif (% %).',
        v_qty,
        v_ingredient.unit,
        round(v_ingredient.reserved_stock::numeric, 2),
        v_ingredient.unit;
    end if;

    v_stock_after := v_qty;
    v_delta := v_stock_after - v_stock_before;

    if v_delta = 0 then
      raise exception 'Stok aktual yang diinput sama persis dengan saldo tercatat saat ini (% %). Tidak ada penyesuaian yang perlu disimpan.', v_stock_before, v_ingredient.unit;
    end if;
  end if;

  perform set_config('nine_licious.allow_stock_mutation', 'on', true);

  update public.ingredients
  set
    current_stock = v_stock_after,
    updated_at = v_now
  where id = v_ingredient.id;

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

  return jsonb_build_object(
    'ok', true,
    'idempotent_replay', false,
    'movement_id', v_movement_id,
    'ingredient_id', v_ingredient.id,
    'ingredient_name', v_ingredient.name,
    'unit', v_ingredient.unit,
    'movement_type', p_movement_type,
    'quantity_delta', v_delta,
    'stock_before', v_stock_before,
    'stock_after', v_stock_after,
    'current_stock', v_stock_after,
    'reserved_stock', v_ingredient.reserved_stock,
    'available_stock', (v_stock_after - v_ingredient.reserved_stock),
    'is_low_stock', ((v_stock_after - v_ingredient.reserved_stock) <= v_ingredient.min_stock),
    'reason', v_reason,
    'idempotency_key', v_idempotency_key
  );
end;
$$;

-- =============================================================================
-- 10. RE-DEFINISI create_pos_order_atomic DENGAN ATOMIC STOCK RESERVATION
-- =============================================================================
${createPosOrderFn}

revoke all on function public.create_pos_order_atomic(jsonb, jsonb, jsonb) from public;
revoke all on function public.create_pos_order_atomic(jsonb, jsonb, jsonb) from anon;
grant execute on function public.create_pos_order_atomic(jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.create_pos_order_atomic(jsonb, jsonb, jsonb) to service_role;

-- =============================================================================
-- 11. RE-DEFINISI append_order_items_atomic DENGAN ATOMIC STOCK RESERVATION
-- =============================================================================
${appendFn}

revoke all on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) from public;
revoke all on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) from anon;
grant execute on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) to authenticated;
grant execute on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) to service_role;

commit;
`;

const targetPath = path.join(ROOT, "supabase/migrations/20261119000300_f4_stock_reservation_and_strict_positive.sql");
fs.writeFileSync(targetPath, migrationHeader, "utf-8");
console.log("Migration 20261119000300_f4_stock_reservation_and_strict_positive.sql berhasil dibuat!");
