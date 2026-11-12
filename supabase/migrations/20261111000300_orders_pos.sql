-- ---------------------------------------------------------------------------
-- Nine Licious - F1.3 POS Core, Kunjungan & Pesanan
--
-- Isi migration:
-- - Kunjungan dine-in (dining_sessions): satu sesi aktif per meja,
-- - Pesanan (orders): dine-in & takeaway, snapshot total, status awaiting_payment,
-- - Item pesanan (order_items): snapshot nama/harga/modifier,
-- - Modifier item (order_item_modifiers): snapshot nama/selisih harga,
-- - Generator nomor pesanan harian (ORD-YYYYMMDD-XXXX),
-- - Fungsi pembatalan pesanan aman (cancel_pos_order),
-- - RLS, grant, index, trigger updated_at.
--
-- Catatan:
-- - Tidak ada nomor antrean atau tiket KDS pada F1.3 (dibuat di F2 saat lunas).
-- - Tidak ada tabel pembayaran (payments) pada F1.3 (dibuat di F2).
-- - Seluruh pesanan baru berstatus 'awaiting_payment' (Menunggu Pembayaran).
-- - Pembatalan pesanan sebelum lunas mewajibkan alasan dan mencatat aktor.
--
-- Jalankan file ini di Supabase SQL Editor setelah migration F0, F1.1, dan F1.2.
-- Backup database dan tinjau perubahan sebelum menjalankannya di production.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. Kunjungan dine-in (dining_sessions)
-- ---------------------------------------------------------------------------
create table if not exists public.dining_sessions (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null
    references public.dining_tables (id) on delete restrict,
  status text not null default 'open',
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  opened_by uuid
    references public.profiles (id) on delete set null,
  closed_by uuid
    references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dining_sessions_status_check check (
    status in ('open', 'closed', 'cancelled')
  )
);

-- Aturan bisnis: satu meja hanya boleh memiliki satu kunjungan 'open' aktif.
create unique index if not exists dining_sessions_one_active_per_table_idx
  on public.dining_sessions (table_id)
  where (status = 'open');

create index if not exists dining_sessions_table_status_idx
  on public.dining_sessions (table_id, status);

comment on table public.dining_sessions is
  'Kunjungan dine-in pelanggan. Satu meja hanya memiliki satu sesi aktif (open).';

-- ---------------------------------------------------------------------------
-- 2. Generator nomor pesanan harian (ORD-YYYYMMDD-XXXX)
-- ---------------------------------------------------------------------------
create or replace function public.generate_order_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date;
  v_seq integer;
  v_date_str text;
begin
  v_today := (now() at time zone 'Asia/Jakarta')::date;
  v_date_str := to_char(v_today, 'YYYYMMDD');

  insert into public.daily_sequences (sequence_date, sequence_name, last_value)
  values (v_today, 'order_number', 1)
  on conflict (sequence_date, sequence_name)
  do update set
    last_value = daily_sequences.last_value + 1,
    updated_at = now()
  returning last_value into v_seq;

  return 'ORD-' || v_date_str || '-' || lpad(v_seq::text, 4, '0');
end;
$$;

revoke all on function public.generate_order_number() from anon;
grant execute on function public.generate_order_number() to authenticated;
grant execute on function public.generate_order_number() to service_role;

-- ---------------------------------------------------------------------------
-- 3. Pesanan (orders)
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique default public.generate_order_number(),
  order_type text not null default 'dine_in',
  table_id uuid
    references public.dining_tables (id) on delete restrict,
  dining_session_id uuid
    references public.dining_sessions (id) on delete restrict,
  status text not null default 'awaiting_payment',
  payment_status text not null default 'unpaid',
  kds_status text,
  customer_name text,
  subtotal integer not null default 0,
  discount_product_total integer not null default 0,
  discount_order_total integer not null default 0,
  discount_manual_total integer not null default 0,
  discount_total integer not null default 0,
  tax_percent numeric(5, 2) not null default 10,
  tax_total integer not null default 0,
  service_charge_percent numeric(5, 2) not null default 5,
  service_total integer not null default 0,
  grand_total integer not null default 0,
  paid_total integer not null default 0,
  idempotency_key text,
  business_date date not null default (now() at time zone 'Asia/Jakarta')::date,
  created_by uuid
    references public.profiles (id) on delete set null,
  cancelled_by uuid
    references public.profiles (id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_order_type_check check (
    order_type in ('dine_in', 'takeaway')
  ),
  constraint orders_status_check check (
    status in ('awaiting_payment', 'partially_paid', 'paid', 'completed', 'cancelled', 'refunded')
  ),
  constraint orders_payment_status_check check (
    payment_status in ('unpaid', 'partially_paid', 'paid', 'partially_refunded', 'refunded')
  ),
  constraint orders_kds_status_check check (
    kds_status is null or kds_status in ('queued', 'preparing', 'ready')
  ),
  constraint orders_amounts_check check (
    subtotal >= 0 and
    discount_product_total >= 0 and
    discount_order_total >= 0 and
    discount_manual_total >= 0 and
    discount_total >= 0 and
    tax_percent >= 0 and
    tax_total >= 0 and
    service_charge_percent >= 0 and
    service_total >= 0 and
    grand_total >= 0 and
    paid_total >= 0
  ),
  constraint orders_dine_in_table_check check (
    (order_type = 'takeaway' and table_id is null and dining_session_id is null) or
    (order_type = 'dine_in' and table_id is not null and dining_session_id is not null)
  ),
  constraint orders_cancellation_check check (
    status <> 'cancelled' or (
      cancelled_at is not null and
      cancelled_by is not null and
      cancel_reason is not null and
      char_length(btrim(cancel_reason)) >= 3
    )
  )
);

create unique index if not exists orders_idempotency_key_idx
  on public.orders (idempotency_key)
  where (idempotency_key is not null);

create index if not exists orders_status_idx
  on public.orders (status, created_at desc);

create index if not exists orders_table_session_idx
  on public.orders (table_id, dining_session_id, status);

create index if not exists orders_business_date_idx
  on public.orders (business_date, created_at desc);

comment on table public.orders is
  'Pesanan transaksi restoran. F1.3 mengelola pesanan awaiting_payment dan pembatalan.';

-- ---------------------------------------------------------------------------
-- 4. Item pesanan (order_items)
-- ---------------------------------------------------------------------------
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null
    references public.orders (id) on delete cascade,
  product_id uuid not null
    references public.products (id) on delete restrict,
  product_name_snapshot text not null,
  product_sku_snapshot text,
  unit_price_snapshot integer not null check (unit_price_snapshot >= 0),
  quantity integer not null check (quantity >= 1),
  notes text check (notes is null or char_length(notes) <= 300),
  modifier_total integer not null default 0 check (modifier_total >= 0),
  subtotal integer not null check (subtotal >= 0),
  discount_amount integer not null default 0 check (discount_amount >= 0),
  line_total integer not null check (line_total >= 0),
  kitchen_station text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists order_items_order_idx
  on public.order_items (order_id);

create index if not exists order_items_product_idx
  on public.order_items (product_id);

comment on table public.order_items is
  'Baris produk dalam pesanan beserta snapshot harga dan catatan.';

-- ---------------------------------------------------------------------------
-- 5. Modifier item pesanan (order_item_modifiers)
-- ---------------------------------------------------------------------------
create table if not exists public.order_item_modifiers (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null
    references public.order_items (id) on delete cascade,
  modifier_option_id uuid not null
    references public.modifier_options (id) on delete restrict,
  group_name_snapshot text not null,
  option_name_snapshot text not null,
  price_delta_snapshot integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists order_item_modifiers_item_idx
  on public.order_item_modifiers (order_item_id);

comment on table public.order_item_modifiers is
  'Snapshot pilihan modifier dan selisih harga per baris pesanan.';

-- ---------------------------------------------------------------------------
-- 6. Trigger updated_at
-- ---------------------------------------------------------------------------
drop trigger if exists dining_sessions_set_updated_at on public.dining_sessions;
create trigger dining_sessions_set_updated_at
  before update on public.dining_sessions
  for each row execute function public.set_updated_at();

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

drop trigger if exists order_items_set_updated_at on public.order_items;
create trigger order_items_set_updated_at
  before update on public.order_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. Fungsi transaksi pembatalan pesanan aman (cancel_pos_order)
-- ---------------------------------------------------------------------------
create or replace function public.cancel_pos_order(
  p_order_id uuid,
  p_cancel_reason text
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
  v_active_orders_count integer;
  v_table_freed boolean := false;
  v_session_closed boolean := false;
begin
  v_user_id := auth.uid();
  v_user_role := public.current_user_role();

  if v_user_role not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir yang berhak membatalkan pesanan.';
  end if;

  if p_cancel_reason is null or char_length(btrim(p_cancel_reason)) < 3 then
    raise exception 'Alasan pembatalan wajib diisi (minimal 3 karakter).';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'Pesanan sudah dibatalkan sebelumnya.';
  end if;

  if v_order.status <> 'awaiting_payment' or v_order.payment_status <> 'unpaid' then
    raise exception 'Hanya pesanan yang belum dibayar (Menunggu Pembayaran) yang dapat dibatalkan.';
  end if;

  -- Update pesanan menjadi dibatalkan
  update public.orders
  set
    status = 'cancelled',
    cancelled_by = v_user_id,
    cancelled_at = now(),
    cancel_reason = btrim(p_cancel_reason)
  where id = p_order_id;

  -- Bila pesanan adalah dine-in, evaluasi meja dan sesi kunjungan
  if v_order.order_type = 'dine_in' and v_order.dining_session_id is not null then
    select count(*) into v_active_orders_count
    from public.orders
    where dining_session_id = v_order.dining_session_id
      and status in ('awaiting_payment', 'partially_paid', 'paid')
      and id <> p_order_id;

    if v_active_orders_count = 0 then
      -- Tidak ada pesanan aktif lain, batalkan sesi dan kosongkan meja
      update public.dining_sessions
      set
        status = 'cancelled',
        closed_at = now(),
        closed_by = v_user_id
      where id = v_order.dining_session_id;
      v_session_closed := true;

      if v_order.table_id is not null then
        update public.dining_tables
        set status = 'empty'
        where id = v_order.table_id;
        v_table_freed := true;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'status', 'cancelled',
    'table_freed', v_table_freed,
    'session_closed', v_session_closed
  );
end;
$$;

revoke all on function public.cancel_pos_order(uuid, text) from anon;
grant execute on function public.cancel_pos_order(uuid, text) to authenticated;
grant execute on function public.cancel_pos_order(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Fungsi transaksi pembuatan pesanan atomik (create_pos_order_atomic)
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

    -- Ambil sesi open yang sudah ada pada meja
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

  -- 3. Nomor pesanan
  v_order_number := public.generate_order_number();

  -- 4. Insert orders
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
    coalesce((p_order->>'subtotal')::integer, 0),
    0, 0, 0, 0,
    coalesce((p_order->>'tax_percent')::numeric, 10),
    coalesce((p_order->>'tax_total')::integer, 0),
    coalesce((p_order->>'service_charge_percent')::numeric, 5),
    coalesce((p_order->>'service_total')::integer, 0),
    coalesce((p_order->>'grand_total')::integer, 0),
    0,
    v_idempotency_key,
    nullif(btrim(p_order->>'notes'), ''),
    v_user_id
  ) returning id into v_order_id;

  -- 5. Insert order_items dan modifiers
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
      v_order_id,
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

    v_item_count := v_item_count + 1;

    -- Modifiers jika ada
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

  return jsonb_build_object(
    'id', v_order_id,
    'order_number', v_order_number,
    'order_type', v_order_type,
    'table_id', v_table_id,
    'dining_session_id', v_session_id,
    'status', 'awaiting_payment',
    'payment_status', 'unpaid',
    'grand_total', (p_order->>'grand_total')::integer,
    'item_count', v_item_count,
    'is_duplicate', false
  );
end;
$$;

revoke all on function public.create_pos_order_atomic(jsonb, jsonb) from anon;
grant execute on function public.create_pos_order_atomic(jsonb, jsonb) to authenticated;
grant execute on function public.create_pos_order_atomic(jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Fungsi transaksi penambahan item ke pesanan belum lunas (append_order_items_atomic)
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

  update public.orders
  set
    subtotal = subtotal + p_subtotal_delta,
    tax_total = tax_total + p_tax_delta,
    service_total = service_total + p_service_delta,
    grand_total = grand_total + p_grand_total_delta
  where id = v_order.id;

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'status', v_order.status,
    'appended_count', v_appended_count,
    'new_grand_total', v_order.grand_total + p_grand_total_delta
  );
end;
$$;

revoke all on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) from anon;
grant execute on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) to authenticated;
grant execute on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.dining_sessions enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_item_modifiers enable row level security;

-- Semua staf aktif boleh membaca sesi, pesanan, dan item pesanan untuk POS/KDS.
drop policy if exists dining_sessions_select_staff on public.dining_sessions;
create policy dining_sessions_select_staff
  on public.dining_sessions
  for select
  to authenticated
  using (public.current_user_role() is not null);

drop policy if exists orders_select_staff on public.orders;
create policy orders_select_staff
  on public.orders
  for select
  to authenticated
  using (public.current_user_role() is not null);

drop policy if exists order_items_select_staff on public.order_items;
create policy order_items_select_staff
  on public.order_items
  for select
  to authenticated
  using (public.current_user_role() is not null);

drop policy if exists order_item_modifiers_select_staff on public.order_item_modifiers;
create policy order_item_modifiers_select_staff
  on public.order_item_modifiers
  for select
  to authenticated
  using (public.current_user_role() is not null);

-- Hanya admin dan kasir yang boleh membuat dan memperbarui sesi dan pesanan.
drop policy if exists dining_sessions_insert_cashier on public.dining_sessions;
create policy dining_sessions_insert_cashier
  on public.dining_sessions
  for insert
  to authenticated
  with check (public.current_user_role() in ('admin', 'kasir'));

drop policy if exists dining_sessions_update_cashier on public.dining_sessions;
create policy dining_sessions_update_cashier
  on public.dining_sessions
  for update
  to authenticated
  using (public.current_user_role() in ('admin', 'kasir'))
  with check (public.current_user_role() in ('admin', 'kasir'));

drop policy if exists orders_insert_cashier on public.orders;
create policy orders_insert_cashier
  on public.orders
  for insert
  to authenticated
  with check (public.current_user_role() in ('admin', 'kasir'));

drop policy if exists orders_update_cashier on public.orders;
create policy orders_update_cashier
  on public.orders
  for update
  to authenticated
  using (public.current_user_role() in ('admin', 'kasir'))
  with check (public.current_user_role() in ('admin', 'kasir'));

drop policy if exists order_items_insert_cashier on public.order_items;
create policy order_items_insert_cashier
  on public.order_items
  for insert
  to authenticated
  with check (public.current_user_role() in ('admin', 'kasir'));

drop policy if exists order_items_update_cashier on public.order_items;
create policy order_items_update_cashier
  on public.order_items
  for update
  to authenticated
  using (public.current_user_role() in ('admin', 'kasir'))
  with check (public.current_user_role() in ('admin', 'kasir'));

drop policy if exists order_item_modifiers_insert_cashier on public.order_item_modifiers;
create policy order_item_modifiers_insert_cashier
  on public.order_item_modifiers
  for insert
  to authenticated
  with check (public.current_user_role() in ('admin', 'kasir'));

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------
revoke all on public.dining_sessions from anon;
revoke all on public.orders from anon;
revoke all on public.order_items from anon;
revoke all on public.order_item_modifiers from anon;

grant select, insert, update on public.dining_sessions to authenticated;
grant select, insert, update on public.orders to authenticated;
grant select, insert, update on public.order_items to authenticated;
grant select, insert, update on public.order_item_modifiers to authenticated;

grant all on public.dining_sessions to service_role;
grant all on public.orders to service_role;
grant all on public.order_items to service_role;
grant all on public.order_item_modifiers to service_role;

commit;

