-- =============================================================================
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
  v_targets jsonb;
  v_sku text;
begin
  select id into v_admin_id from public.profiles where role = 'admin' and is_active = true limit 1;

  -- 1. Normalisasi stok negatif pra-eksekusi ke 0 jika ada bahan yang terlanjur minus
  perform set_config('nine_licious.allow_stock_mutation', 'on', true);
  update public.ingredients
  set
    current_stock = 0,
    updated_at = v_now
  where current_stock < 0;

  -- 2. Bangun target opening stock 74 bahan baku dengan jsonb_object_agg dari kumpulan VALUES
  select jsonb_object_agg(sku, target)
  into v_targets
  from (
    values
      ('ING-BEVG-01', 5000),
      ('ING-BEVG-02', 10000),
      ('ING-BEVG-03', 30000),
      ('ING-BEVG-04', 4000),
      ('ING-BEVG-05', 5000),
      ('ING-BEVG-06', 4000),
      ('ING-BEVG-07', 5000),
      ('ING-BEVG-08', 5000),
      ('ING-BEVG-09', 5000),
      ('ING-BEVG-10', 5000),
      ('ING-BEVG-11', 120),
      ('ING-BEVG-12', 50000),
      ('ING-BEVG-13', 500000),
      ('ING-CARB-01', 30000),
      ('ING-CARB-02', 10000),
      ('ING-CARB-03', 20000),
      ('ING-CARB-04', 100),
      ('ING-CARB-05', 80),
      ('ING-CARB-06', 150),
      ('ING-CARB-07', 3000),
      ('ING-DEST-01', 8000),
      ('ING-DEST-02', 4000),
      ('ING-DEST-03', 4000),
      ('ING-DEST-04', 3000),
      ('ING-DEST-05', 3000),
      ('ING-DEST-06', 150),
      ('ING-DEST-07', 4000),
      ('ING-DEST-08', 8000),
      ('ING-DEST-09', 8000),
      ('ING-DEST-10', 8000),
      ('ING-DEST-11', 4000),
      ('ING-DEST-12', 3000),
      ('ING-DEST-13', 3000),
      ('ING-DEST-14', 3000),
      ('ING-DEST-15', 3000),
      ('ING-DEST-16', 150),
      ('ING-FLOU-01', 20000),
      ('ING-FLOU-02', 5000),
      ('ING-FLOU-03', 5000),
      ('ING-PROT-01', 20000),
      ('ING-PROT-02', 300),
      ('ING-PROT-03', 10000),
      ('ING-PROT-04', 10000),
      ('ING-PROT-05', 10000),
      ('ING-PROT-06', 10000),
      ('ING-PROT-07', 10000),
      ('ING-PROT-08', 300),
      ('ING-SEAS-01', 30000),
      ('ING-SEAS-02', 6000),
      ('ING-SEAS-03', 20000),
      ('ING-SEAS-04', 10000),
      ('ING-SEAS-05', 5000),
      ('ING-SEAS-06', 5000),
      ('ING-SEAS-07', 5000),
      ('ING-SEAS-08', 5000),
      ('ING-SEAS-09', 5000),
      ('ING-SEAS-10', 10000),
      ('ING-SEAS-11', 5000),
      ('ING-SEAS-12', 5000),
      ('ING-SEAS-13', 5000),
      ('ING-SEAS-14', 3000),
      ('ING-SEAS-15', 3000),
      ('ING-SEAS-16', 3000),
      ('ING-SEAS-17', 3000),
      ('ING-SEAS-18', 3000),
      ('ING-VEGE-01', 10000),
      ('ING-VEGE-02', 3000),
      ('ING-VEGE-03', 3000),
      ('ING-VEGE-04', 3000),
      ('ING-VEGE-05', 3000),
      ('ING-VEGE-06', 100),
      ('ING-VEGE-07', 150),
      ('ING-VEGE-08', 150),
      ('POP-ES-03', 10)
  ) as t(sku, target);

  -- 3. Terapkan opening balance & stock opname terhitung sesuai kebutuhan resep
  for v_sku, v_target in select key, value::numeric from jsonb_each_text(v_targets) loop
    select * into v_ing from public.ingredients where sku = v_sku for update;
    if found then
      -- Idempotensi ketat: jika initial opening balance untuk SKU ini sudah pernah tercatat,
      -- lewati sepenuhnya agar eksekusi ulang tidak pernah mengubah stok riil secara diam-diam.
      perform 1
      from public.stock_movements
      where idempotency_key = 'opening_balance_f4_' || v_sku;

      if not found and v_ing.current_stock < v_target then
        v_before := v_ing.current_stock;
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
  v_actual_deduction numeric(12, 3);
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
      v_actual_deduction := least(greatest(v_stock_before, 0), v_res.total_required);
      if v_actual_deduction <= 0 then
        continue;
      end if;
      v_delta := -v_actual_deduction;
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
-- 8B. TRIGGER PADA public.midtrans_transactions: TRANSAKSI EXPIRED / CANCELLED / DENIED
-- =============================================================================
create or replace function public.trg_fn_midtrans_transactions_release_stock_on_terminal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_other_active boolean;
  v_order record;
begin
  if (old.lifecycle_status is distinct from new.lifecycle_status
      and new.lifecycle_status in ('expired', 'cancelled', 'denied')) then

    select id, payment_status into v_order
    from public.orders
    where id = new.order_id;

    if found and v_order.payment_status = 'unpaid' then
      -- Pastikan tidak ada transaksi midtrans lain yang masih aktif/pending untuk pesanan ini
      select exists (
        select 1 from public.midtrans_transactions
        where order_id = new.order_id
          and id <> new.id
          and lifecycle_status in ('initiated', 'pending', 'challenge')
      ) into v_other_active;

      if not v_other_active then
        perform public.release_order_stock_reservations_internal(new.order_id);
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_midtrans_transactions_release_stock_on_terminal on public.midtrans_transactions;
create trigger trg_midtrans_transactions_release_stock_on_terminal
  after update of lifecycle_status on public.midtrans_transactions
  for each row
  when (new.lifecycle_status in ('expired', 'cancelled', 'denied'))
  execute function public.trg_fn_midtrans_transactions_release_stock_on_terminal();

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
  v_session record;
  v_order_number text;
  v_order_id uuid;
  v_item jsonb;
  v_mod jsonb;
  v_disc jsonb;
  v_item_id uuid;
  v_tax_percent numeric;
  v_service_percent numeric;
  v_client_item_id text;
  v_is_additional_order boolean := false;

  v_item_count integer := 0;
  v_item_subtotal integer;
  v_item_map jsonb := '{}'::jsonb;
  v_subtotal_before_discount integer := 0;
  v_discount_product_total integer := 0;
  v_discount_order_total integer := 0;
  v_discount_manual_total integer := 0;
  v_discount_total integer := 0;
  v_subtotal_after_product_discount integer := 0;
  v_manual_discount_base integer := 0;
  v_taxable_base integer := 0;
  v_tax_total integer := 0;
  v_service_total integer := 0;
  v_grand_total integer := 0;

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
begin
  v_user_id := auth.uid();
  v_user_role := public.current_user_role();

  if v_user_role not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir yang berhak membuat pesanan.';
  end if;

  -- 1. Idempotency Key Check (Tahap 1: Sebelum Lock)
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
        'discount_product_total', v_existing_order.discount_product_total,
        'discount_order_total', v_existing_order.discount_order_total,
        'discount_manual_total', v_existing_order.discount_manual_total,
        'discount_total', v_existing_order.discount_total,
        'tax_percent', v_existing_order.tax_percent,
        'tax_total', v_existing_order.tax_total,
        'service_charge_percent', v_existing_order.service_charge_percent,
        'service_total', v_existing_order.service_total,
        'grand_total', v_existing_order.grand_total,
        'created_at', v_existing_order.created_at,
        'is_duplicate', true
      );
    end if;
  end if;

  v_order_type := p_order->>'order_type';
  if v_order_type not in ('dine_in', 'takeaway') then
    raise exception 'Tipe pesanan tidak valid: %', v_order_type;
  end if;

  -- 2. Penanganan Meja & Sesi Dine-in (Hierarchical Locking: dining_tables -> dining_sessions)
  if v_order_type = 'dine_in' then
    v_table_id := (p_order->>'table_id')::uuid;
    if v_table_id is null then
      raise exception 'Meja wajib dipilih untuk pesanan Dine-in.';
    end if;

    -- Lock 1: dining_tables FOR UPDATE
    select * into v_table
    from public.dining_tables
    where id = v_table_id
    for update;

    if not found or not v_table.is_active then
      raise exception 'Meja tidak ditemukan atau sedang tidak aktif.';
    end if;

    -- Re-check idempotency key setelah lock meja diperoleh untuk menangkap transaksi konkuren
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
          'discount_product_total', v_existing_order.discount_product_total,
          'discount_order_total', v_existing_order.discount_order_total,
          'discount_manual_total', v_existing_order.discount_manual_total,
          'discount_total', v_existing_order.discount_total,
          'tax_percent', v_existing_order.tax_percent,
          'tax_total', v_existing_order.tax_total,
          'service_charge_percent', v_existing_order.service_charge_percent,
          'service_total', v_existing_order.service_total,
          'grand_total', v_existing_order.grand_total,
          'created_at', v_existing_order.created_at,
          'is_duplicate', true
        );
      end if;
    end if;

    -- Evaluasi status meja & sesi aktif (F2.3 Strict Anomaly Rejection)
    if v_table.status = 'empty' then
      -- Meja kosong: Buka sesi kunjungan baru
      insert into public.dining_sessions (table_id, status, opened_by)
      values (v_table_id, 'open', v_user_id)
      returning id into v_session_id;

    elsif v_table.status = 'occupied' then
      -- Lock 2: dining_sessions FOR UPDATE
      select * into v_session
      from public.dining_sessions
      where table_id = v_table_id
        and status = 'open'
      for update;

      -- Penolakan tegas inkonsistensi: Meja terisi tanpa sesi open dilarang auto-healing!
      if not found or v_session.id is null then
        raise exception 'Inkonsistensi data meja: Meja % berstatus occupied namun tidak memiliki sesi kunjungan aktif (open). Pesanan dibatalkan.',
          v_table.name;
      end if;

      v_session_id := v_session.id;
      v_is_additional_order := true;

    elsif v_table.status = 'awaiting_payment' then
      raise exception 'Meja % sedang menunggu pembayaran (awaiting_payment). Dilarang membuat pesanan baru; gunakan penambahan item pada pesanan aktif.',
        v_table.name;

    else
      raise exception 'Status meja % tidak dikenali atau tidak dapat digunakan: %', v_table.name, v_table.status;
    end if;

    -- Transisi status meja: Setiap ada pesanan baru belum lunas, status meja menjadi 'awaiting_payment'
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

  begin
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
      created_by
    ) values (
      v_order_number,
      v_order_type,
      v_table_id,
      v_session_id,
      'awaiting_payment',
      'unpaid',
      nullif(btrim(p_order->>'customer_name'), ''),
      0,
      0,
      0,
      0,
      0,
      v_tax_percent,
      0,
      v_service_percent,
      0,
      0,
      0,
      v_idempotency_key,
      nullif(btrim(p_order->>'notes'), ''),
      v_user_id
    ) returning id into v_order_id;
  exception
    when unique_violation then
      -- Idempotency race collision: kembalikan order yang sudah ada
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
            'discount_product_total', v_existing_order.discount_product_total,
            'discount_order_total', v_existing_order.discount_order_total,
            'discount_manual_total', v_existing_order.discount_manual_total,
            'discount_total', v_existing_order.discount_total,
            'tax_percent', v_existing_order.tax_percent,
            'tax_total', v_existing_order.tax_total,
            'service_charge_percent', v_existing_order.service_charge_percent,
            'service_total', v_existing_order.service_total,
            'grand_total', v_existing_order.grand_total,
            'created_at', v_existing_order.created_at,
            'is_duplicate', true
          );
        end if;
      end if;
      raise;
  end;

  -- 5. Insert order_items dan modifiers
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_item_count := v_item_count + 1;
    v_item_subtotal := (v_item->>'subtotal')::integer;
    v_subtotal_before_discount := v_subtotal_before_discount + v_item_subtotal;
    v_client_item_id := nullif(btrim(v_item->>'client_item_id'), '');

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
      v_item->>'product_sku_snapshot',
      (v_item->>'unit_price_snapshot')::integer,
      (v_item->>'quantity')::integer,
      nullif(btrim(v_item->>'notes'), ''),
      coalesce((v_item->>'modifier_total')::integer, 0),
      v_item_subtotal,
      0,
      v_item_subtotal,
      v_item->>'kitchen_station'
    ) returning id into v_item_id;

    if v_client_item_id is not null then
      v_item_map := jsonb_set(v_item_map, array[v_client_item_id], to_jsonb(v_item_id::text));
    end if;

    if v_item->'modifiers' is not null and jsonb_array_length(v_item->'modifiers') > 0 then
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
          (v_mod->>'price_delta_snapshot')::integer
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

  -- 8. Catat Audit Log
  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    case when v_is_additional_order then 'order.created_additional' else 'order.created' end,
    v_user_id,
    'order',
    v_order_id::text,
    jsonb_build_object(
      'order_number', v_order_number,
      'order_type', v_order_type,
      'table_id', v_table_id,
      'dining_session_id', v_session_id,
      'is_additional_order', v_is_additional_order,
      'grand_total', v_grand_total
    )
  );

  -- 8b. Validasi & Reservasi Kebutuhan Bahan Baku secara Atomik (F4.4)
  perform public.reserve_order_stock_internal(v_order_id);

  return jsonb_build_object(
    'id', v_order_id,
    'order_number', v_order_number,
    'order_type', v_order_type,
    'table_id', v_table_id,
    'dining_session_id', v_session_id,
    'status', 'awaiting_payment',
    'payment_status', 'unpaid',
    'subtotal', v_subtotal_before_discount,
    'discount_product_total', v_discount_product_total,
    'discount_order_total', v_discount_order_total,
    'discount_manual_total', v_discount_manual_total,
    'discount_total', v_discount_total,
    'tax_percent', v_tax_percent,
    'tax_total', v_tax_total,
    'service_charge_percent', v_service_percent,
    'service_total', v_service_total,
    'grand_total', v_grand_total,
    'is_additional_order', v_is_additional_order,
    'is_duplicate', false
  );
end;
$$;

revoke all on function public.create_pos_order_atomic(jsonb, jsonb, jsonb) from public;
revoke all on function public.create_pos_order_atomic(jsonb, jsonb, jsonb) from anon;
grant execute on function public.create_pos_order_atomic(jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.create_pos_order_atomic(jsonb, jsonb, jsonb) to service_role;

-- =============================================================================
-- 11. RE-DEFINISI append_order_items_atomic DENGAN ATOMIC STOCK RESERVATION
-- =============================================================================
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
  v_pre_order record;
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

  -- 1. Pre-read relasi pesanan
  select id, order_type, table_id, dining_session_id
  into v_pre_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  -- 2. Kunci hierarkis FOR UPDATE (dining_tables -> dining_sessions -> orders)
  -- Menjamin keselarasan urutan penguncian global anti-deadlock di seluruh sistem
  if v_pre_order.order_type = 'dine_in' then
    if v_pre_order.table_id is not null then
      perform 1 from public.dining_tables where id = v_pre_order.table_id for update;
    end if;
    if v_pre_order.dining_session_id is not null then
      perform 1 from public.dining_sessions where id = v_pre_order.dining_session_id for update;
    end if;
  end if;

  -- 3. Kunci baris orders FOR UPDATE
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

  -- 4. Insert item dan modifiers baru
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

  -- 5. Hitung subtotal baru seluruh item pesanan
  select coalesce(sum(subtotal), 0) into v_new_subtotal
  from public.order_items
  where order_id = v_order.id;

  -- 6. Pertahankan diskon produk yang sudah ada
  select coalesce(sum(discount_amount), 0) into v_discount_product_total
  from public.order_discounts
  where order_id = v_order.id and scope = 'product';

  v_subtotal_after_product_discount := v_new_subtotal - v_discount_product_total;
  if v_subtotal_after_product_discount < 0 then
    v_subtotal_after_product_discount := 0;
  end if;

  -- 7. Hitung ulang diskon pesanan (scope = 'order')
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

  -- 8. Hitung ulang diskon manual (scope = 'manual')
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

  -- 9. Agregat final dan kalkulasi pajak/service
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
    grand_total = v_new_grand_total,
    updated_at = now()
  where id = v_order.id;

  -- 10. Pertahankan status meja sebagai awaiting_payment jika dine-in
  if v_order.order_type = 'dine_in' and v_order.table_id is not null then
    update public.dining_tables
    set status = 'awaiting_payment',
        updated_at = now()
    where id = v_order.table_id;
  end if;

  -- Validasi & Reservasi Kebutuhan Bahan Baku Tambahan secara Atomik (F4.4)
  perform public.reserve_order_stock_internal(v_order.id);

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

revoke all on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) from public;
revoke all on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) from anon;
grant execute on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) to authenticated;
grant execute on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) to service_role;

commit;
