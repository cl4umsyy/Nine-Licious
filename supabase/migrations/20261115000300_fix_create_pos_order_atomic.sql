-- =============================================================================
-- Migration: 20261115000300_fix_create_pos_order_atomic.sql
-- Fase: F2.5 Hotfix & Schema Alignment
--
-- MASALAH:
-- Saat menyimpan pesanan di POS, muncul error PostgreSQL:
-- "column 'client_item_id' of relation 'order_items' does not exist" (Error code 42703).
-- Hal ini disebabkan oleh inkonsistensi pada instance database Supabase di mana
-- definisi RPC create_pos_order_atomic mencoba melakukan INSERT ke kolom
-- 'client_item_id' pada public.order_items.
--
-- ANALISIS KANONIKAL F2.3:
-- Sesuai arsitektur F1.4 / F2.3, 'client_item_id' BUKANLAH kolom tabel database fisik,
-- melainkan properti sementara (ephemeral) di dalam payload JSON p_items untuk memetakan
-- diskon produk (v_item_map) ke UUID baris pesanan (v_item_id) di dalam memori PL/pgSQL.
--
-- SOLUSI KANONIKAL:
-- 1. TIDAK mengubah skema fisik public.order_items (menghindari polusi kolom tidak perlu).
-- 2. Memperbarui fungsi create_pos_order_atomic (3 parameter) agar menghapus
--    referensi 'client_item_id' dari klausa INSERT INTO public.order_items, namun tetap
--    membaca 'v_client_item_id' ke dalam v_item_map untuk pemetaan diskon di memori.
-- 3. Memperbarui fungsi wrapper create_pos_order_atomic (2 parameter) untuk kompatibilitas.
-- 4. Menjamin hak akses eksekusi RPC hanya untuk authenticated dan service_role.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Definisi Kanonikal create_pos_order_atomic (3 Parameter)
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 3. Definisi Wrapper Kompatibilitas create_pos_order_atomic (2 Parameter)
-- -----------------------------------------------------------------------------
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

revoke all on function public.create_pos_order_atomic(jsonb, jsonb) from public;
revoke all on function public.create_pos_order_atomic(jsonb, jsonb) from anon;
grant execute on function public.create_pos_order_atomic(jsonb, jsonb) to authenticated;
grant execute on function public.create_pos_order_atomic(jsonb, jsonb) to service_role;

commit;
