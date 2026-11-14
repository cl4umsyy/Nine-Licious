-- =============================================================================
-- Migration: 20261114000100_additional_orders_table_status.sql
-- Fase: F2.3 Additional Orders & Table Status
-- 
-- Fitur:
-- 1. Dukungan pesanan tambahan (Additional Order) pada meja dine-in 'occupied'.
-- 2. Mengaitkan pesanan tambahan ke dining_session aktif yang sama.
-- 3. Deteksi & penolakan tegas inkonsistensi meja (occupied/awaiting_payment tanpa sesi open).
-- 4. Penguncian kanonikal hierarki FOR UPDATE selaras dengan F2.1 & F2.2:
--    dining_tables -> dining_sessions -> orders -> order_allocations -> midtrans_transactions
-- 5. RPC konfirmasi penyerahan pesanan (complete_pos_order): 'paid' -> 'completed'.
-- 6. RPC penutupan sesi meja atomik (close_dining_session_atomic) dengan 7 pintu validasi:
--    - Menolak jika masih ada tagihan belum lunas
--    - Menolak jika ada alokasi split bill reserved
--    - Menolak jika ada transaksi gateway Midtrans aktif / non-terminal
--    - Menolak jika webhook Midtrans sedang diproses
--    - Menolak jika pesanan belum diserahkan (status 'paid' atau kds_status 'queued'/'preparing'/'ready')
--    - Mengosongkan meja dan menutup sesi hanya saat seluruh kewajiban tuntas
--    - Immutabilitas riwayat & nominal pembayaran (tanpa pemaksaan status otomatis)
-- 7. RPC agregasi ringkasan sesi meja (get_dining_session_summary).
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. REVISI FUNGSI create_pos_order_atomic (3 Parameter)
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

  -- 1. Idempotency Key Check
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

    -- Evaluasi status meja & sesi aktif
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
      0, 0, 0, 0, 0,
      v_tax_percent, 0,
      v_service_percent, 0,
      0, 0,
      v_idempotency_key,
      nullif(btrim(p_order->>'notes'), ''),
      v_user_id
    ) returning id into v_order_id;
  exception
    when unique_violation then
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

-- Wrapper Kompatibilitas 2-Parameter
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


-- -----------------------------------------------------------------------------
-- 1b. RPC PENAMBAHAN ITEM PESANAN BELUM LUNAS (append_order_items_atomic)
-- Menyelaraskan hierarki penguncian global:
-- dining_tables -> dining_sessions -> orders -> order_discounts
-- Mencegah circular wait deadlock dengan close_dining_session_atomic dan payment RPCs.
-- -----------------------------------------------------------------------------
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


-- -----------------------------------------------------------------------------
-- 2. RPC KONFIRMASI PENYERAHAN PESANAN (complete_pos_order)
-- Status transisi: 'paid' -> 'completed'.
-- Hanya dapat dilakukan oleh kasir/admin setelah pesanan selesai diserahkan ke pelanggan.
-- -----------------------------------------------------------------------------
create or replace function public.complete_pos_order(
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
  v_pre_order record;
  v_order record;
begin
  v_user_id := auth.uid();
  v_user_role := public.current_user_role();

  if v_user_role not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir yang berhak mengonfirmasi penyelesaian pesanan.';
  end if;

  -- 1. Baca data relasi pesanan (pre-order check)
  select id, table_id, dining_session_id, order_type
  into v_pre_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  -- 2. Kunci hierarkis FOR UPDATE (dining_tables -> dining_sessions -> orders)
  -- Menjamin keselarasan urutan penguncian global anti-deadlock
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

  if v_order.status = 'completed' then
    return jsonb_build_object(
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'status', 'completed',
      'already_completed', true
    );
  end if;

  if v_order.status <> 'paid' or v_order.payment_status <> 'paid' then
    raise exception 'Hanya pesanan yang sudah lunas (paid) yang dapat diselesaikan.';
  end if;

  -- Update pesanan menjadi completed dan bersihkan status KDS aktif
  update public.orders
  set
    status = 'completed',
    kds_status = null,
    updated_at = now()
  where id = p_order_id;

  -- Catat audit log
  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'order.completed',
    v_user_id,
    'order',
    p_order_id::text,
    jsonb_build_object(
      'order_number', v_order.order_number,
      'table_id', v_order.table_id,
      'dining_session_id', v_order.dining_session_id
    )
  );

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'status', 'completed',
    'already_completed', false
  );
end;
$$;

revoke all on function public.complete_pos_order(uuid) from public;
revoke all on function public.complete_pos_order(uuid) from anon;
grant execute on function public.complete_pos_order(uuid) to authenticated;
grant execute on function public.complete_pos_order(uuid) to service_role;


-- -----------------------------------------------------------------------------
-- 3. RPC PENUTUPAN SESI MEJA ATOMIK (close_dining_session_atomic)
-- Hierarki Penguncian:
-- dining_tables -> dining_sessions -> orders -> order_allocations -> midtrans_transactions
-- 7 Pintu Validasi Ketat.
-- -----------------------------------------------------------------------------
create or replace function public.close_dining_session_atomic(
  p_table_id uuid,
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_table record;
  v_session record;
  v_unpaid_count integer := 0;
  v_remaining_balance integer := 0;
  v_reserved_alloc_count integer := 0;
  v_pending_trx_count integer := 0;
  v_processing_webhook_count integer := 0;
  v_uncompleted_order_count integer := 0;
  v_active_kds_count integer := 0;
  v_total_orders integer := 0;
begin
  v_user_id := auth.uid();
  v_user_role := public.current_user_role();

  if v_user_role not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir yang berhak menutup kunjungan meja.';
  end if;

  if p_table_id is null or p_session_id is null then
    raise exception 'Parameter meja dan sesi kunjungan wajib diisi.';
  end if;

  -- 1. Lock Level 1: dining_tables
  select * into v_table
  from public.dining_tables
  where id = p_table_id
  for update;

  if not found or not v_table.is_active then
    raise exception 'Meja tidak ditemukan atau sedang tidak aktif.';
  end if;

  -- 2. Lock Level 2: dining_sessions
  select * into v_session
  from public.dining_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Sesi kunjungan tidak ditemukan.';
  end if;

  if v_session.table_id <> p_table_id then
    raise exception 'Sesi kunjungan tidak sesuai dengan meja yang dipilih.';
  end if;

  if v_session.status <> 'open' then
    raise exception 'Sesi kunjungan sudah tidak aktif (status: %).', v_session.status;
  end if;

  -- 3. Lock Level 3: orders (kunci seluruh pesanan dalam sesi secara terurut)
  perform 1
  from public.orders
  where dining_session_id = p_session_id
  order by id asc
  for update;

  -- 4. Lock Level 4 & 5: order_allocations & midtrans_transactions
  perform 1
  from public.order_allocations oa
  join public.orders o on o.id = oa.order_id
  where o.dining_session_id = p_session_id
  order by oa.id asc
  for update;

  perform 1
  from public.midtrans_transactions mt
  join public.orders o on o.id = mt.order_id
  where o.dining_session_id = p_session_id
  order by mt.id asc
  for update;

  -- ---------------------------------------------------------------------------
  -- 7 PINTU VALIDASI PENUTUPAN SESI
  -- ---------------------------------------------------------------------------

  -- Pintu 1: Validasi Pesanan Belum Lunas
  select count(*) into v_unpaid_count
  from public.orders
  where dining_session_id = p_session_id
    and status in ('awaiting_payment', 'partially_paid');

  if v_unpaid_count > 0 then
    raise exception 'Tidak dapat menutup sesi: Terdapat % pesanan yang belum lunas pada meja ini.', v_unpaid_count;
  end if;

  -- Pintu 2: Validasi Sisa Saldo Tagihan
  select coalesce(sum(grand_total - paid_total), 0) into v_remaining_balance
  from public.orders
  where dining_session_id = p_session_id
    and status not in ('cancelled', 'refunded');

  if v_remaining_balance > 0 then
    raise exception 'Tidak dapat menutup sesi: Masih terdapat sisa kewajiban pembayaran sebesar Rp % pada sesi ini.', v_remaining_balance;
  end if;

  -- Pintu 3: Validasi Alokasi Split Bill Reserved
  select count(*) into v_reserved_alloc_count
  from public.order_allocations oa
  join public.orders o on o.id = oa.order_id
  where o.dining_session_id = p_session_id
    and oa.allocation_status = 'reserved';

  if v_reserved_alloc_count > 0 then
    raise exception 'Tidak dapat menutup sesi: Terdapat alokasi pembayaran split bill yang masih berstatus reserved.';
  end if;

  -- Pintu 4: Validasi Transaksi Gateway Midtrans Non-Terminal
  select count(*) into v_pending_trx_count
  from public.midtrans_transactions mt
  join public.orders o on o.id = mt.order_id
  where o.dining_session_id = p_session_id
    and mt.lifecycle_status in (
      'initiated', 'token_created', 'pending', 'capture_challenge', 'reconciliation_required'
    );

  if v_pending_trx_count > 0 then
    raise exception 'Tidak dapat menutup sesi: Terdapat transaksi gateway Midtrans yang masih aktif / belum mencapai status terminal.';
  end if;

  -- Pintu 5: Validasi Webhook Midtrans In-Flight
  select count(*) into v_processing_webhook_count
  from public.midtrans_webhook_events mwe
  join public.midtrans_transactions mt on mt.midtrans_order_id = mwe.midtrans_order_id
  join public.orders o on o.id = mt.order_id
  where o.dining_session_id = p_session_id
    and mwe.processing_result in ('received', 'processing');

  if v_processing_webhook_count > 0 then
    raise exception 'Tidak dapat menutup sesi: Terdapat notifikasi pembayaran webhook Midtrans yang sedang diproses.';
  end if;

  -- Pintu 6: Validasi Pesanan Belum Selesai Diserahkan (status 'paid' wajib diserahkan dahulu)
  select count(*) into v_uncompleted_order_count
  from public.orders
  where dining_session_id = p_session_id
    and status = 'paid';

  if v_uncompleted_order_count > 0 then
    raise exception 'Tidak dapat menutup sesi: Terdapat % pesanan yang sudah lunas tetapi belum selesai diserahkan ke pelanggan (status belum completed).',
      v_uncompleted_order_count;
  end if;

  -- Pintu 7: Validasi KDS (queued, preparing, atau ready)
  select count(*) into v_active_kds_count
  from public.orders
  where dining_session_id = p_session_id
    and kds_status in ('queued', 'preparing', 'ready');

  if v_active_kds_count > 0 then
    raise exception 'Tidak dapat menutup sesi: Terdapat pesanan yang masih dalam antrean dapur atau siap diambil (kds_status: queued/preparing/ready).';
  end if;

  -- Hitung total pesanan selesai dalam sesi untuk audit
  select count(*) into v_total_orders
  from public.orders
  where dining_session_id = p_session_id;

  -- ---------------------------------------------------------------------------
  -- EKSEKUSI PENUTUPAN SESI & PENGOSONGAN MEJA
  -- ---------------------------------------------------------------------------

  update public.dining_sessions
  set
    status = 'closed',
    closed_at = now(),
    closed_by = v_user_id,
    updated_at = now()
  where id = p_session_id;

  update public.dining_tables
  set
    status = 'empty',
    updated_at = now()
  where id = p_table_id;

  -- Catat Audit Log
  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'table.session_closed',
    v_user_id,
    'dining_session',
    p_session_id::text,
    jsonb_build_object(
      'table_id', p_table_id,
      'table_name', v_table.name,
      'orders_count', v_total_orders
    )
  );

  return jsonb_build_object(
    'table_id', p_table_id,
    'session_id', p_session_id,
    'session_status', 'closed',
    'table_status', 'empty',
    'orders_count', v_total_orders,
    'closed_at', now()
  );
end;
$$;

revoke all on function public.close_dining_session_atomic(uuid, uuid) from public;
revoke all on function public.close_dining_session_atomic(uuid, uuid) from anon;
grant execute on function public.close_dining_session_atomic(uuid, uuid) to authenticated;
grant execute on function public.close_dining_session_atomic(uuid, uuid) to service_role;


-- -----------------------------------------------------------------------------
-- 4. FUNGSI QUERY HELPER get_dining_session_summary
-- Mengembalikan agregasi ringkasan finansial dan status seluruh order dalam sesi.
-- Hanya dapat diakses oleh admin dan kasir.
-- -----------------------------------------------------------------------------
create or replace function public.get_dining_session_summary(
  p_table_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_role text;
  v_session record;
  v_table record;
  v_summary record;
  v_orders jsonb := '[]'::jsonb;
  v_reserved_alloc_count integer := 0;
  v_pending_trx_count integer := 0;
  v_processing_webhook_count integer := 0;
  v_can_close boolean := false;
  v_blocking_reason text := null;
begin
  v_user_role := public.current_user_role();
  if v_user_role not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir yang berhak mengakses ringkasan sesi meja.';
  end if;

  select * into v_table
  from public.dining_tables
  where id = p_table_id;

  if not found then
    return null;
  end if;

  select * into v_session
  from public.dining_sessions
  where table_id = p_table_id
    and status = 'open'
  limit 1;

  if not found or v_session.id is null then
    return jsonb_build_object(
      'table_id', v_table.id,
      'table_name', v_table.name,
      'table_status', v_table.status,
      'has_active_session', false
    );
  end if;

  -- Ambil list order dalam sesi
  select jsonb_agg(
    jsonb_build_object(
      'id', o.id,
      'order_number', o.order_number,
      'status', o.status,
      'payment_status', o.payment_status,
      'kds_status', o.kds_status,
      'subtotal', o.subtotal,
      'discount_total', o.discount_total,
      'tax_total', o.tax_total,
      'service_total', o.service_total,
      'grand_total', o.grand_total,
      'paid_total', o.paid_total,
      'remaining_balance', (o.grand_total - o.paid_total),
      'created_at', o.created_at
    ) order by o.created_at asc
  ) into v_orders
  from public.orders o
  where o.dining_session_id = v_session.id;

  -- Agregasi finansial sesi
  select
    count(*) as total_orders,
    count(*) filter (where status in ('awaiting_payment', 'partially_paid')) as unpaid_orders_count,
    count(*) filter (where status = 'paid') as uncompleted_orders_count,
    count(*) filter (where kds_status in ('queued', 'preparing', 'ready')) as active_kds_count,
    count(*) filter (where status = 'completed') as completed_orders_count,
    count(*) filter (where status in ('cancelled', 'refunded')) as closed_orders_count,
    coalesce(sum(subtotal) filter (where status not in ('cancelled', 'refunded')), 0) as session_subtotal,
    coalesce(sum(discount_total) filter (where status not in ('cancelled', 'refunded')), 0) as session_discount_total,
    coalesce(sum(tax_total) filter (where status not in ('cancelled', 'refunded')), 0) as session_tax_total,
    coalesce(sum(service_total) filter (where status not in ('cancelled', 'refunded')), 0) as session_service_total,
    coalesce(sum(grand_total) filter (where status not in ('cancelled', 'refunded')), 0) as session_grand_total,
    coalesce(sum(paid_total) filter (where status not in ('cancelled', 'refunded')), 0) as session_paid_total
  into v_summary
  from public.orders
  where dining_session_id = v_session.id;

  -- Periksa status alokasi split bill reserved
  select count(*) into v_reserved_alloc_count
  from public.order_allocations oa
  join public.orders o on o.id = oa.order_id
  where o.dining_session_id = v_session.id
    and oa.allocation_status = 'reserved';

  -- Periksa transaksi Midtrans aktif non-terminal
  select count(*) into v_pending_trx_count
  from public.midtrans_transactions mt
  join public.orders o on o.id = mt.order_id
  where o.dining_session_id = v_session.id
    and mt.lifecycle_status in (
      'initiated', 'token_created', 'pending', 'capture_challenge', 'reconciliation_required'
    );

  -- Periksa webhook Midtrans in-flight
  select count(*) into v_processing_webhook_count
  from public.midtrans_webhook_events mwe
  join public.midtrans_transactions mt on mt.midtrans_order_id = mwe.midtrans_order_id
  join public.orders o on o.id = mt.order_id
  where o.dining_session_id = v_session.id
    and mwe.processing_result in ('received', 'processing');

  -- Tentukan apakah sesi dapat ditutup (sinkron 100% dengan close_dining_session_atomic)
  if coalesce(v_summary.unpaid_orders_count, 0) > 0 then
    v_can_close := false;
    v_blocking_reason := 'Terdapat pesanan yang belum lunas.';
  elsif (coalesce(v_summary.session_grand_total, 0) - coalesce(v_summary.session_paid_total, 0)) > 0 then
    v_can_close := false;
    v_blocking_reason := 'Masih ada sisa tagihan belum dibayar.';
  elsif v_reserved_alloc_count > 0 then
    v_can_close := false;
    v_blocking_reason := 'Terdapat alokasi pembayaran split bill yang masih berstatus reserved.';
  elsif v_pending_trx_count > 0 then
    v_can_close := false;
    v_blocking_reason := 'Terdapat transaksi gateway Midtrans yang masih aktif / belum selesai.';
  elsif v_processing_webhook_count > 0 then
    v_can_close := false;
    v_blocking_reason := 'Terdapat notifikasi pembayaran webhook Midtrans yang sedang diproses.';
  elsif coalesce(v_summary.uncompleted_orders_count, 0) > 0 then
    v_can_close := false;
    v_blocking_reason := 'Terdapat pesanan lunas yang belum diserahkan ke pelanggan.';
  elsif coalesce(v_summary.active_kds_count, 0) > 0 then
    v_can_close := false;
    v_blocking_reason := 'Terdapat pesanan yang masih diproses dapur atau siap diambil.';
  else
    v_can_close := true;
    v_blocking_reason := null;
  end if;

  return jsonb_build_object(
    'table_id', v_table.id,
    'table_name', v_table.name,
    'table_status', v_table.status,
    'has_active_session', true,
    'session_id', v_session.id,
    'opened_at', v_session.opened_at,
    'total_orders', coalesce(v_summary.total_orders, 0),
    'unpaid_orders_count', coalesce(v_summary.unpaid_orders_count, 0),
    'uncompleted_orders_count', coalesce(v_summary.uncompleted_orders_count, 0),
    'completed_orders_count', coalesce(v_summary.completed_orders_count, 0),
    'reserved_allocations_count', v_reserved_alloc_count,
    'pending_midtrans_transactions_count', v_pending_trx_count,
    'processing_webhooks_count', v_processing_webhook_count,
    'session_subtotal', coalesce(v_summary.session_subtotal, 0),
    'session_discount_total', coalesce(v_summary.session_discount_total, 0),
    'session_tax_total', coalesce(v_summary.session_tax_total, 0),
    'session_service_total', coalesce(v_summary.session_service_total, 0),
    'session_grand_total', coalesce(v_summary.session_grand_total, 0),
    'session_paid_total', coalesce(v_summary.session_paid_total, 0),
    'session_remaining_balance', (coalesce(v_summary.session_grand_total, 0) - coalesce(v_summary.session_paid_total, 0)),
    'can_close_session', v_can_close,
    'blocking_reason', v_blocking_reason,
    'orders', coalesce(v_orders, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_dining_session_summary(uuid) from public;
revoke all on function public.get_dining_session_summary(uuid) from anon;
grant execute on function public.get_dining_session_summary(uuid) to authenticated;
grant execute on function public.get_dining_session_summary(uuid) to service_role;

commit;
