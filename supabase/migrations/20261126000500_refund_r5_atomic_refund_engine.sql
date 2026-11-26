-- =============================================================================
-- NINE LICIOUS POS — REFUND SYSTEM MIGRATION R5: ATOMIC REFUND ENGINE (RPCs)
-- File: supabase/migrations/20261126000500_refund_r5_atomic_refund_engine.sql
--
-- PRASYARAT: Migrations R1, R2, R3, dan R4 sudah dijalankan berurutan.
--
-- TUJUAN:
-- Menyediakan seluruh mesin transaksional atomik (SECURITY DEFINER, SET search_path = '')
-- dengan skema terkuantifikasi penuh (public.*, auth.*, pg_catalog.*) untuk:
-- 1. request_order_refund_atomic          (Kasir / Admin mengajukan refund/replacement,
--                                          plus auto-approve atomik khusus Admin, serta
--                                          locking L1..L7 sebelum hitung kumulatif item)
-- 2. approve_order_refund_atomic          (Admin menyetujui + eksekusi Tunai/Midtrans/
--                                          Split Bill multi-payment/Replacement/KDS/Stok)
-- 3. reject_order_refund_atomic           (Admin menolak dengan alasan wajib + notif)
-- 4. cancel_order_refund_atomic           (Kasir batal sebelum putusan; Admin batal
--                                          pasca-setuju bila payout belum dikirim/selesai)
-- 5. attach_refund_evidence_atomic & request_refund_evidence_atomic
-- 6. mark_midtrans_refund_processing_atomic & complete_refund_manual_fallback_atomic
-- 7. confirm_midtrans_refund_atomic       (service_role ONLY — idempoten per allocation)
-- 8. record_refund_correction_atomic      (Admin — under_refund & over_refund aman)
-- 9. process_order_refund_atomic          (Backward compatible 100% dengan F2.4 & F5)
--
-- KEAMANAN & HIERARKI LOCKING KANONIKAL:
-- L1 (dining_tables) -> L2 (dining_sessions) -> L3 (orders -> order_items) ->
-- L4 (order_allocations) -> L5 (midtrans_transactions) -> L6 (payments) ->
-- L7 (refunds -> refund_payout_allocations) -> L8 (shifts / ingredients)
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. HELPER INTERNAL: HITUNG SISA PENDING REFUND PER ORDER (SUPPORT MULTI-LEG)
-- Catatan: Menghitung seluruh nominal yang belum cancelled/rejected/failed agar
-- dua pengajuan refund berturutan tidak melampaui paid_total. Berbeda dengan
-- close_dining_session_atomic, helper ini TIDAK memblokir penutupan meja.
-- -----------------------------------------------------------------------------
create or replace function public.get_order_pending_refund_amount_internal(p_order_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    sum(
      case
        when exists (select 1 from public.refund_payout_allocations a where a.refund_id = r.id) then
          coalesce((
            select sum(a.amount)
            from public.refund_payout_allocations a
            where a.refund_id = r.id
              and a.payout_status in ('pending', 'processing', 'reconciliation_required')
          ), 0)
        else r.amount
      end
    ),
    0
  )::integer
  from public.refunds r
  where r.order_id = p_order_id
    and r.resolution_type <> 'replacement'
    and r.approval_status in ('pending_approval', 'approved')
    and r.payout_status in ('not_required', 'pending', 'processing', 'reconciliation_required')
    and r.status = 'pending';
$$;

revoke all on function public.get_order_pending_refund_amount_internal(uuid) from public, anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 2. HELPER INTERNAL: EKSEKUSI PENGGANTIAN MENU (REPLACEMENT) & STOK L8
-- Dipanggil di dalam transaksi persetujuan Admin setelah lock L1..L7 diperoleh.
-- -----------------------------------------------------------------------------
create or replace function public.execute_order_replacement_internal(
  p_refund_id uuid,
  p_admin_id uuid,
  p_admin_role text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pre_refund record;
  v_refund record;
  v_order record;
  v_replacement record;
  v_replacement_order_id uuid;
  v_replacement_order_number text;
  v_item record;
  v_ing record;
  v_now timestamptz := pg_catalog.now();
  v_table_name text := null;
  v_waste_count integer := 0;
  v_deduct_count integer := 0;
  v_kds_summary_items jsonb := '[]'::jsonb;
  v_req_ing record;
  v_available numeric(12, 3);
  v_delta numeric(12, 3);
  v_new_order_item_id uuid;
  v_src_mod record;
begin
  select id, order_id, resolution_type
  into v_pre_refund
  from public.refunds
  where id = p_refund_id;

  if not found or v_pre_refund.resolution_type <> 'replacement' then
    raise exception 'Data pengajuan Replacement tidak valid.';
  end if;

  -- Lock L3 (orders) -> L7 (refunds) -> order_replacements
  select * into v_order
  from public.orders
  where id = v_pre_refund.order_id
  for update;

  select * into v_refund
  from public.refunds
  where id = p_refund_id
  for update;

  if not found or v_refund.resolution_type <> 'replacement' then
    raise exception 'Data pengajuan Replacement tidak valid.';
  end if;

  select * into v_replacement
  from public.order_replacements
  where refund_id = p_refund_id
  for update;

  if not found then
    raise exception 'Metadata order_replacements tidak ditemukan untuk pengajuan ini.';
  end if;

  if v_replacement.replacement_order_id is not null then
    return pg_catalog.jsonb_build_object(
      'replacement_order_id', v_replacement.replacement_order_id,
      'status', v_replacement.status,
      'already_created', true
    );
  end if;

  if v_order.table_id is not null then
    select name into v_table_name
    from public.dining_tables
    where id = v_order.table_id;
  end if;

  -- L8 LOCKING (ingredients ASC) sebelum mutasi waste / pemotongan bahan pengganti
  for v_req_ing in
    select
      rec.ingredient_id,
      pg_catalog.round(sum(rec.quantity_required * ri.quantity)::numeric, 3) as qty_needed
    from public.refund_items ri
    join public.order_items oi on oi.id = ri.order_item_id
    join public.recipes rec on rec.product_id = oi.product_id
    where ri.refund_id = p_refund_id
      and ri.quantity > 0
    group by rec.ingredient_id
    order by rec.ingredient_id asc
  loop
    select id, name, unit, current_stock, reserved_stock
    into v_ing
    from public.ingredients
    where id = v_req_ing.ingredient_id
    for update;

    if not found then
      continue;
    end if;

    v_available := v_ing.current_stock - v_ing.reserved_stock;
    if v_available < v_req_ing.qty_needed then
      raise exception 'Stok tersedia untuk bahan pengganti "%" tidak mencukupi (Tersedia: % %, Dibutuhkan: % %).',
        v_ing.name,
        pg_catalog.round(v_available, 2),
        v_ing.unit,
        pg_catalog.round(v_req_ing.qty_needed, 2),
        v_ing.unit;
    end if;
  end loop;

  -- Buat pesanan pengganti terisolasi (order_kind = 'replacement', table_id = null, dining_session_id = null)
  v_replacement_order_id := pg_catalog.gen_random_uuid();
  v_replacement_order_number := 'RPL-' || v_order.order_number || '-' || pg_catalog.substr(pg_catalog.replace(v_replacement_order_id::text, '-', ''), 1, 4);

  insert into public.orders (
    id,
    order_number,
    order_type,
    order_kind,
    parent_order_id,
    table_id,
    dining_session_id,
    status,
    payment_status,
    kds_status,
    is_finalized,
    finalized_at,
    finalized_by,
    queue_number,
    queue_date,
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
    notes,
    created_by,
    created_at,
    updated_at
  ) values (
    v_replacement_order_id,
    v_replacement_order_number,
    v_order.order_type,
    'replacement',
    v_order.id,
    null,
    null,
    'paid',
    'paid',
    'queued',
    true,
    v_now,
    p_admin_id,
    null,
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    pg_catalog.format(
      '[REPLACEMENT] Pesanan pengganti #%s%s — %s',
      v_order.order_number,
      case when v_table_name is not null then ' (Meja ' || v_table_name || ')' else '' end,
      pg_catalog.btrim(v_refund.reason)
    ),
    p_admin_id,
    v_now,
    v_now
  );

  -- Salin item & modifier pesanan yang diganti dengan harga Rp 0
  for v_item in
    select
      ri.id as refund_item_id,
      ri.order_item_id,
      ri.quantity as replace_qty,
      ri.reason as item_reason,
      oi.product_id,
      oi.product_name_snapshot,
      oi.product_sku_snapshot,
      oi.notes,
      oi.kitchen_station
    from public.refund_items ri
    join public.order_items oi on oi.id = ri.order_item_id
    where ri.refund_id = p_refund_id
    order by ri.created_at asc
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
      v_replacement_order_id,
      v_item.product_id,
      '[REPLACEMENT] ' || v_item.product_name_snapshot,
      v_item.product_sku_snapshot,
      0,
      v_item.replace_qty,
      coalesce(v_item.item_reason, v_item.notes),
      0,
      0,
      0,
      0,
      v_item.kitchen_station
    )
    returning id into v_new_order_item_id;

    for v_src_mod in
      select modifier_option_id, group_name_snapshot, option_name_snapshot
      from public.order_item_modifiers
      where order_item_id = v_item.order_item_id
    loop
      insert into public.order_item_modifiers (
        order_item_id,
        modifier_option_id,
        group_name_snapshot,
        option_name_snapshot,
        price_delta_snapshot
      ) values (
        v_new_order_item_id,
        v_src_mod.modifier_option_id,
        v_src_mod.group_name_snapshot,
        v_src_mod.option_name_snapshot,
        0
      );
    end loop;

    v_kds_summary_items := v_kds_summary_items || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'product_name', v_item.product_name_snapshot,
        'quantity', v_item.replace_qty,
        'kitchen_station', coalesce(v_item.kitchen_station, 'kitchen')
      )
    );

    -- Catat bahan item awal yang dibuang sebagai WASTE (tanpa mengurangi current_stock kedua kalinya)
    for v_req_ing in
      select rec.ingredient_id, pg_catalog.round((rec.quantity_required * v_item.replace_qty)::numeric, 3) as qty_wasted
      from public.recipes rec
      where rec.product_id = v_item.product_id
      order by rec.ingredient_id asc
    loop
      select current_stock into v_ing from public.ingredients where id = v_req_ing.ingredient_id;
      if found and v_req_ing.qty_wasted > 0 then
        insert into public.stock_movements (
          ingredient_id,
          movement_type,
          quantity_delta,
          wasted_quantity,
          stock_before,
          stock_after,
          order_id,
          refund_id,
          order_item_id,
          reason,
          created_by,
          created_at
        ) values (
          v_req_ing.ingredient_id,
          'waste',
          0,
          v_req_ing.qty_wasted,
          v_ing.current_stock,
          v_ing.current_stock,
          v_order.id,
          p_refund_id,
          v_item.order_item_id,
          pg_catalog.format('Waste Replacement pesanan #%s (%s x%s)', v_order.order_number, v_item.product_name_snapshot, v_item.replace_qty),
          p_admin_id,
          v_now
        )
        on conflict (refund_id, order_item_id, ingredient_id)
          where (movement_type = 'waste' and refund_id is not null and order_item_id is not null)
        do nothing;

        v_waste_count := v_waste_count + 1;
      end if;
    end loop;
  end loop;

  -- Potong stok bahan baku aktual untuk produksi menu pengganti (terurut ingredient_id ASC)
  perform pg_catalog.set_config('nine_licious.allow_stock_mutation', 'on', true);

  for v_req_ing in
    select
      rec.ingredient_id,
      pg_catalog.round(sum(rec.quantity_required * ri.quantity)::numeric, 3) as qty_needed
    from public.refund_items ri
    join public.order_items oi on oi.id = ri.order_item_id
    join public.recipes rec on rec.product_id = oi.product_id
    where ri.refund_id = p_refund_id
      and ri.quantity > 0
    group by rec.ingredient_id
    order by rec.ingredient_id asc
  loop
    select id, current_stock into v_ing
    from public.ingredients
    where id = v_req_ing.ingredient_id
    for update;

    if not found or v_req_ing.qty_needed <= 0 then
      continue;
    end if;

    v_delta := -v_req_ing.qty_needed;

    insert into public.stock_movements (
      ingredient_id,
      movement_type,
      quantity_delta,
      wasted_quantity,
      stock_before,
      stock_after,
      order_id,
      refund_id,
      reason,
      created_by,
      created_at
    ) values (
      v_ing.id,
      'sale_deduction',
      v_delta,
      0,
      v_ing.current_stock,
      v_ing.current_stock + v_delta,
      v_replacement_order_id,
      p_refund_id,
      pg_catalog.format('Pemotongan stok bahan pengganti %s (dari #%s)', v_replacement_order_number, v_order.order_number),
      p_admin_id,
      v_now
    )
    on conflict (order_id, ingredient_id)
      where (movement_type = 'sale_deduction' and order_id is not null)
    do nothing;

    update public.ingredients
    set current_stock = current_stock + v_delta,
        updated_at = v_now
    where id = v_ing.id;

    v_deduct_count := v_deduct_count + 1;
  end loop;

  update public.order_replacements
  set replacement_order_id = v_replacement_order_id,
      status = 'in_kitchen',
      items_summary = v_kds_summary_items,
      approved_by = p_admin_id,
      approved_at = v_now,
      updated_at = v_now
  where id = v_replacement.id;

  -- Notifikasi ke Kitchen (bebas nominal & bebas PII)
  perform public.notify_role_users_internal(
    array['kitchen'],
    'kds_replacement_ticket',
    'Tiket Replacement Masuk Dapur',
    pg_catalog.format(
      'Pesanan pengganti %s untuk #%s%s masuk antrean dapur (%s).',
      v_replacement_order_number,
      v_order.order_number,
      case when v_table_name is not null then ' - Meja ' || v_table_name else '' end,
      pg_catalog.btrim(v_refund.reason)
    ),
    'replacement',
    v_replacement.id::text,
    pg_catalog.jsonb_build_object(
      'replacement_order_id', v_replacement_order_id,
      'replacement_order_number', v_replacement_order_number,
      'original_order_number', v_order.order_number,
      'items', v_kds_summary_items
    ),
    null
  );

  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'order.replacement_approved',
    p_admin_id,
    'order_replacement',
    v_replacement.id::text,
    pg_catalog.jsonb_build_object(
      'refund_id', p_refund_id,
      'original_order_id', v_order.id,
      'original_order_number', v_order.order_number,
      'replacement_order_id', v_replacement_order_id,
      'replacement_order_number', v_replacement_order_number,
      'waste_entries', v_waste_count,
      'deducted_ingredients', v_deduct_count,
      'approved_by_role', p_admin_role
    )
  );

  return pg_catalog.jsonb_build_object(
    'replacement_id', v_replacement.id,
    'replacement_order_id', v_replacement_order_id,
    'replacement_order_number', v_replacement_order_number,
    'waste_entries', v_waste_count,
    'deducted_ingredients', v_deduct_count
  );
end;
$$;

revoke all on function public.execute_order_replacement_internal(uuid, uuid, text) from public, anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 3. HELPER INTERNAL: EKSEKUSI PERSETUJUAN REFUND + PAYOUT + KDS + SHIFT + WASTE
-- -----------------------------------------------------------------------------
create or replace function public.execute_refund_approval_internal(
  p_refund_id uuid,
  p_admin_id uuid,
  p_admin_role text,
  p_payout_allocations jsonb default null,
  p_shift_id uuid default null,
  p_approval_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pre_refund record;
  v_refund record;
  v_order record;
  v_now timestamptz := pg_catalog.now();
  v_replacement_res jsonb;

  v_alloc_elem jsonb;
  v_pay_id uuid;
  v_pay_rec record;
  v_alloc_method text;
  v_alloc_amount integer;
  v_alloc_sum integer := 0;
  v_payment_refunded_so_far integer := 0;
  v_payment_remaining integer := 0;

  v_leg record;
  v_shift record;
  v_target_shift_id uuid := null;
  v_cash_shift_id uuid := null;
  v_any_cash_out_of_shift boolean := false;
  v_balance_before integer := 0;
  v_balance_after integer := 0;
  v_completed_leg_amount integer := 0;
  v_has_pending_midtrans boolean := false;

  v_new_refunded_total integer;
  v_is_full_refund boolean := false;
  v_new_order_status text;
  v_new_payment_status text;
  v_kds_status_after text;
  v_kitchen_notified_at timestamptz := null;

  v_item_rec record;
  v_kds_action text;
  v_req_ing record;
  v_ing record;
  v_stock_before numeric(12, 3);
  v_stock_after numeric(12, 3);
  v_distinct_methods text[];
  v_aggregate_payout_method text;
begin
  select id, order_id
  into v_pre_refund
  from public.refunds
  where id = p_refund_id;

  if not found then
    raise exception 'Data refund tidak ditemukan.';
  end if;

  -- Lock kanonikal: L3 (orders) -> L6 (payments) -> L7 (refunds)
  select * into v_order
  from public.orders
  where id = v_pre_refund.order_id
  for update;

  perform 1 from public.payments where order_id = v_order.id order by id asc for update;

  select * into v_refund
  from public.refunds
  where id = p_refund_id
  for update;

  if not found then
    raise exception 'Data refund tidak ditemukan.';
  end if;

  if v_refund.approval_status <> 'pending_approval' then
    raise exception 'Hanya pengajuan berstatus pending_approval yang dapat disetujui (status: %).', v_refund.approval_status;
  end if;

  if v_order.status in ('cancelled', 'refunded') then
    raise exception 'Pesanan sudah berstatus % dan tidak dapat disetujui untuk refund.', v_order.status;
  end if;

  -- Catat keputusan persetujuan Admin terpisah di audit_logs (termasuk self-approval Admin)
  update public.refunds
  set
    approval_status = 'approved',
    reviewed_by = p_admin_id,
    reviewed_at = v_now,
    approved_by = p_admin_id,
    approved_at = v_now,
    metadata = coalesce(metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'approval_notes', nullif(pg_catalog.btrim(coalesce(p_approval_notes, '')), ''),
      'approved_by_role', p_admin_role
    ),
    updated_at = v_now
  where id = p_refund_id;

  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'order.refund_approved',
    p_admin_id,
    'refund',
    p_refund_id::text,
    pg_catalog.jsonb_build_object(
      'refund_id', p_refund_id,
      'refund_number', v_refund.refund_number,
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'resolution_type', v_refund.resolution_type,
      'amount', v_refund.amount,
      'requested_by', v_refund.requested_by,
      'approved_by', p_admin_id,
      'is_self_approval', (v_refund.requested_by = p_admin_id)
    )
  );

  -- CABANG 1: REPLACEMENT (Rp 0)
  if v_refund.resolution_type = 'replacement' then
    v_replacement_res := public.execute_order_replacement_internal(p_refund_id, p_admin_id, p_admin_role);

    update public.refunds
    set
      payout_status = 'not_required',
      payout_method = 'none',
      payout_completed_at = v_now,
      kitchen_notified_at = v_now,
      status = 'completed',
      updated_at = v_now
    where id = p_refund_id;

    if v_refund.requested_by <> p_admin_id then
      perform public.notify_user_internal(
        v_refund.requested_by,
        'refund_approved',
        'Pengajuan Replacement Disetujui',
        pg_catalog.format('Pengajuan penggantian menu untuk pesanan #%s telah disetujui dan dikirim ke dapur.', v_order.order_number),
        'refund',
        p_refund_id::text,
        v_replacement_res
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'refund_id', p_refund_id,
      'refund_number', v_refund.refund_number,
      'order_id', v_order.id,
      'resolution_type', v_refund.resolution_type,
      'approval_status', 'approved',
      'payout_status', 'not_required',
      'status', 'completed',
      'amount', 0,
      'replacement', v_replacement_res
    );
  end if;

  -- CABANG 2: FULL / PARTIAL REFUND (amount > 0)
  if p_payout_allocations is not null
     and pg_catalog.jsonb_typeof(p_payout_allocations) = 'array'
     and pg_catalog.jsonb_array_length(p_payout_allocations) > 0 then
    for v_alloc_elem in select * from pg_catalog.jsonb_array_elements(p_payout_allocations) loop
      begin
        v_pay_id := (v_alloc_elem ->> 'payment_id')::uuid;
      exception when others then
        raise exception 'ID pembayaran pada alokasi Split Bill tidak valid.';
      end;

      v_alloc_amount := coalesce((v_alloc_elem ->> 'amount')::integer, 0);
      v_alloc_method := pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(v_alloc_elem ->> 'payout_method', '')), ''));

      if v_alloc_amount <= 0 then
        raise exception 'Nominal alokasi payout per payment harus lebih dari Rp 0.';
      end if;

      select * into v_pay_rec
      from public.payments
      where id = v_pay_id
        and order_id = v_order.id
      for update;

      if not found or v_pay_rec.payment_status <> 'success' then
        raise exception 'Pembayaran % tidak ditemukan atau sudah tidak aktif.', v_pay_id;
      end if;

      if v_alloc_method is null then
        v_alloc_method := case
          when v_pay_rec.payment_method = 'midtrans' or v_pay_rec.payment_source in ('midtrans_snap', 'qris_midtrans') then 'midtrans'
          when v_pay_rec.payment_method = 'cash' then 'cash'
          else 'transfer'
        end;
      end if;

      if v_alloc_method not in ('cash', 'transfer', 'midtrans', 'manual') then
        raise exception 'Metode pencairan % tidak valid.', v_alloc_method;
      end if;

      select coalesce(sum(a.amount), 0)::integer into v_payment_refunded_so_far
      from public.refund_payout_allocations a
      join public.refunds r2 on r2.id = a.refund_id
      where a.payment_id = v_pay_id
        and a.payout_status in ('pending', 'processing', 'completed', 'reconciliation_required')
        and r2.approval_status not in ('rejected', 'cancelled');

      v_payment_refunded_so_far := v_payment_refunded_so_far + coalesce((
        select sum(r2.amount)
        from public.refunds r2
        where r2.payment_id = v_pay_id
          and r2.status in ('completed', 'pending')
          and r2.approval_status not in ('rejected', 'cancelled')
          and not exists (select 1 from public.refund_payout_allocations ax where ax.refund_id = r2.id)
      ), 0);

      v_payment_remaining := v_pay_rec.amount - v_payment_refunded_so_far;
      if v_alloc_amount > v_payment_remaining then
        raise exception 'Alokasi refund (Rp %) melebihi sisa refundable pada pembayaran % (Rp %).',
          v_alloc_amount, v_pay_id, v_payment_remaining;
      end if;

      insert into public.refund_payout_allocations (
        refund_id,
        order_id,
        payment_id,
        payout_method,
        amount,
        payout_status
      ) values (
        p_refund_id,
        v_order.id,
        v_pay_id,
        v_alloc_method,
        v_alloc_amount,
        'pending'
      );

      v_alloc_sum := v_alloc_sum + v_alloc_amount;
    end loop;

    if v_alloc_sum <> v_refund.amount then
      raise exception 'Total alokasi pembayaran Split Bill (Rp %) harus sama persis dengan total refund (Rp %).',
        v_alloc_sum, v_refund.amount;
    end if;

  elsif v_refund.payment_id is not null then
    select * into v_pay_rec
    from public.payments
    where id = v_refund.payment_id and order_id = v_order.id
    for update;

    if not found or v_pay_rec.payment_status <> 'success' then
      raise exception 'Pembayaran target tidak ditemukan atau sudah tidak berstatus success.';
    end if;

    v_alloc_method := case
      when v_pay_rec.payment_method = 'midtrans' or v_pay_rec.payment_source in ('midtrans_snap', 'qris_midtrans') then 'midtrans'
      when v_pay_rec.payment_method = 'cash' then
        case when v_refund.refund_method = 'transfer' then 'transfer' else 'cash' end
      else
        case when v_refund.refund_method in ('transfer', 'manual') then v_refund.refund_method else 'transfer' end
    end;

    insert into public.refund_payout_allocations (
      refund_id,
      order_id,
      payment_id,
      payout_method,
      amount,
      payout_status
    ) values (
      p_refund_id,
      v_order.id,
      v_pay_rec.id,
      v_alloc_method,
      v_refund.amount,
      'pending'
    );
  else
    declare
      v_needed integer := v_refund.amount;
    begin
      for v_pay_rec in
        select *
        from public.payments
        where order_id = v_order.id
          and payment_status = 'success'
        order by created_at asc, id asc
        for update
      loop
        exit when v_needed <= 0;

        select coalesce(sum(a.amount), 0)::integer into v_payment_refunded_so_far
        from public.refund_payout_allocations a
        join public.refunds r2 on r2.id = a.refund_id
        where a.payment_id = v_pay_rec.id
          and a.payout_status in ('pending', 'processing', 'completed', 'reconciliation_required')
          and r2.approval_status not in ('rejected', 'cancelled');

        v_payment_refunded_so_far := v_payment_refunded_so_far + coalesce((
          select sum(r2.amount)
          from public.refunds r2
          where r2.payment_id = v_pay_rec.id
            and r2.status in ('completed', 'pending')
            and r2.approval_status not in ('rejected', 'cancelled')
            and not exists (select 1 from public.refund_payout_allocations ax where ax.refund_id = r2.id)
        ), 0);

        v_payment_remaining := v_pay_rec.amount - v_payment_refunded_so_far;
        if v_payment_remaining <= 0 then
          continue;
        end if;

        v_alloc_amount := least(v_needed, v_payment_remaining);
        v_alloc_method := case
          when v_pay_rec.payment_method = 'midtrans' or v_pay_rec.payment_source in ('midtrans_snap', 'qris_midtrans') then 'midtrans'
          when v_pay_rec.payment_method = 'cash' then 'cash'
          else 'transfer'
        end;

        insert into public.refund_payout_allocations (
          refund_id,
          order_id,
          payment_id,
          payout_method,
          amount,
          payout_status
        ) values (
          p_refund_id,
          v_order.id,
          v_pay_rec.id,
          v_alloc_method,
          v_alloc_amount,
          'pending'
        );

        v_needed := v_needed - v_alloc_amount;
      end loop;

      if v_needed > 0 then
        raise exception 'Sisa pembayaran asli tidak mencukupi untuk alokasi refund (kurang Rp %).', v_needed;
      end if;
    end;
  end if;

  select pg_catalog.array_agg(distinct payout_method) into v_distinct_methods
  from public.refund_payout_allocations
  where refund_id = p_refund_id;

  v_aggregate_payout_method := case
    when pg_catalog.array_length(v_distinct_methods, 1) = 1 then v_distinct_methods[1]
    else 'mixed'
  end;

  for v_leg in
    select *
    from public.refund_payout_allocations
    where refund_id = p_refund_id
    order by created_at asc, id asc
    for update
  loop
    if v_leg.payout_method = 'midtrans' then
      v_has_pending_midtrans := true;
      continue;
    end if;

    v_target_shift_id := null;
    v_balance_before := 0;
    v_balance_after := 0;

    if v_leg.payout_method = 'cash' then
      if p_shift_id is not null then
        select id, expected_cash, status into v_shift
        from public.shifts
        where id = p_shift_id
        for update;

        if not found then
          raise exception 'Shift kasir dengan ID % tidak ditemukan.', p_shift_id;
        end if;
        if v_shift.status <> 'open' then
          raise exception 'Shift kasir % sudah ditutup. Tidak dapat mengambil kas dari shift tertutup.', p_shift_id;
        end if;
        if v_shift.expected_cash < v_leg.amount then
          raise exception 'Saldo kas shift tidak mencukupi untuk refund tunai (Tersedia: Rp %, Diminta: Rp %).',
            v_shift.expected_cash, v_leg.amount;
        end if;

        v_target_shift_id := v_shift.id;
        v_cash_shift_id := coalesce(v_cash_shift_id, v_shift.id);
        v_balance_before := v_shift.expected_cash;
        v_balance_after := v_balance_before - v_leg.amount;

        update public.shifts
        set expected_cash = v_balance_after, updated_at = v_now
        where id = v_target_shift_id;
      else
        select id, expected_cash into v_shift
        from public.shifts
        where cashier_id = p_admin_id
          and status = 'open'
        for update;

        if found then
          if v_shift.expected_cash < v_leg.amount then
            raise exception 'Saldo kas shift tidak mencukupi untuk refund tunai (Tersedia: Rp %, Diminta: Rp %).',
              v_shift.expected_cash, v_leg.amount;
          end if;
          v_target_shift_id := v_shift.id;
          v_cash_shift_id := coalesce(v_cash_shift_id, v_shift.id);
          v_balance_before := v_shift.expected_cash;
          v_balance_after := v_balance_before - v_leg.amount;

          update public.shifts
          set expected_cash = v_balance_after, updated_at = v_now
          where id = v_target_shift_id;
        else
          -- Shift tutup / tidak ada shift aktif: catat eksplisit di luar shift (out_of_shift)
          v_target_shift_id := null;
          v_any_cash_out_of_shift := true;
          v_balance_before := 0;
          v_balance_after := 0;
        end if;
      end if;

      insert into public.cash_movements (
        shift_id,
        movement_type,
        amount,
        balance_before,
        balance_after,
        reason,
        order_id,
        payment_id,
        refund_id,
        created_by
      ) values (
        v_target_shift_id,
        'cash_refund',
        v_leg.amount,
        v_balance_before,
        v_balance_after,
        case
          when v_target_shift_id is not null then
            'Refund tunai pesanan ' || v_order.order_number || ': ' || pg_catalog.btrim(v_refund.reason)
          else
            'Refund tunai di luar shift (Admin out_of_shift): ' || pg_catalog.btrim(v_refund.reason)
        end,
        v_order.id,
        v_leg.payment_id,
        p_refund_id,
        p_admin_id
      );
    end if;

    update public.refund_payout_allocations
    set
      payout_status = 'completed',
      shift_id = v_target_shift_id,
      payout_completed_at = v_now,
      updated_at = v_now
    where id = v_leg.id;

    v_completed_leg_amount := v_completed_leg_amount + v_leg.amount;
  end loop;

  -- Integrasi KDS per Item & Inventory (Waste vs Restock)
  for v_item_rec in
    select
      ri.id as refund_item_id,
      ri.order_item_id,
      ri.quantity,
      ri.product_name_snapshot,
      ri.inventory_action,
      ri.kds_status_snapshot,
      oi.product_id
    from public.refund_items ri
    join public.order_items oi on oi.id = ri.order_item_id
    where ri.refund_id = p_refund_id
    order by ri.created_at asc
  loop
    if coalesce(v_item_rec.kds_status_snapshot, v_order.kds_status) in ('queued', 'preparing', 'ready') then
      v_kds_action := case coalesce(v_item_rec.kds_status_snapshot, v_order.kds_status)
        when 'queued' then 'cancel_ticket_or_item'
        when 'preparing' then 'stop_preparation_if_possible'
        else 'already_ready_no_action'
      end;

      insert into public.kds_item_cancellations (
        order_id,
        order_item_id,
        refund_id,
        order_number,
        queue_number,
        product_name,
        cancelled_quantity,
        kds_status_at_refund,
        kitchen_action,
        reason
      ) values (
        v_order.id,
        v_item_rec.order_item_id,
        p_refund_id,
        v_order.order_number,
        v_order.queue_number,
        v_item_rec.product_name_snapshot,
        v_item_rec.quantity,
        coalesce(v_item_rec.kds_status_snapshot, v_order.kds_status),
        v_kds_action,
        pg_catalog.btrim(v_refund.reason)
      )
      on conflict (refund_id, order_item_id) do nothing;

      v_kitchen_notified_at := v_now;
    end if;

    if v_item_rec.inventory_action in ('waste', 'restock') then
      for v_req_ing in
        select
          rec.ingredient_id,
          pg_catalog.round((rec.quantity_required * v_item_rec.quantity)::numeric, 3) as qty_ing
        from public.recipes rec
        where rec.product_id = v_item_rec.product_id
        order by rec.ingredient_id asc
      loop
        if v_req_ing.qty_ing <= 0 then
          continue;
        end if;

        select id, current_stock into v_ing
        from public.ingredients
        where id = v_req_ing.ingredient_id
        for update;

        if not found then
          continue;
        end if;

        v_stock_before := v_ing.current_stock;

        if v_item_rec.inventory_action = 'restock' then
          perform pg_catalog.set_config('nine_licious.allow_stock_mutation', 'on', true);
          v_stock_after := v_stock_before + v_req_ing.qty_ing;

          update public.ingredients
          set current_stock = v_stock_after, updated_at = v_now
          where id = v_ing.id;

          insert into public.stock_movements (
            ingredient_id,
            movement_type,
            quantity_delta,
            wasted_quantity,
            stock_before,
            stock_after,
            order_id,
            refund_id,
            order_item_id,
            reason,
            created_by,
            created_at
          ) values (
            v_ing.id,
            'refund_restock',
            v_req_ing.qty_ing,
            0,
            v_stock_before,
            v_stock_after,
            v_order.id,
            p_refund_id,
            v_item_rec.order_item_id,
            pg_catalog.format('Restock pembatalan item belum diproduksi #%s (%s x%s)', v_order.order_number, v_item_rec.product_name_snapshot, v_item_rec.quantity),
            p_admin_id,
            v_now
          )
          on conflict (refund_id, order_item_id, ingredient_id)
            where (movement_type = 'refund_restock' and refund_id is not null and order_item_id is not null)
          do nothing;
        else
          insert into public.stock_movements (
            ingredient_id,
            movement_type,
            quantity_delta,
            wasted_quantity,
            stock_before,
            stock_after,
            order_id,
            refund_id,
            order_item_id,
            reason,
            created_by,
            created_at
          ) values (
            v_ing.id,
            'waste',
            0,
            v_req_ing.qty_ing,
            v_stock_before,
            v_stock_before,
            v_order.id,
            p_refund_id,
            v_item_rec.order_item_id,
            pg_catalog.format('Waste komplain/refund pesanan #%s (%s x%s)', v_order.order_number, v_item_rec.product_name_snapshot, v_item_rec.quantity),
            p_admin_id,
            v_now
          )
          on conflict (refund_id, order_item_id, ingredient_id)
            where (movement_type = 'waste' and refund_id is not null and order_item_id is not null)
          do nothing;
        end if;
      end loop;
    end if;
  end loop;

  if v_kitchen_notified_at is not null then
    perform public.notify_role_users_internal(
      array['kitchen'],
      'kds_item_cancelled',
      'Pemberitahuan Pembatalan / Komplain Item',
      pg_catalog.format('Periksa papan KDS: ada pembatalan item pada pesanan #%s (%s).', v_order.order_number, pg_catalog.btrim(v_refund.reason)),
      'order',
      v_order.id::text,
      pg_catalog.jsonb_build_object(
        'order_id', v_order.id,
        'order_number', v_order.order_number,
        'queue_number', v_order.queue_number
      ),
      null
    );
  end if;

  if v_completed_leg_amount > 0 then
    v_new_refunded_total := coalesce(v_order.refunded_total, 0) + v_completed_leg_amount;
    if v_new_refunded_total > v_order.paid_total then
      raise exception 'Akumulasi refund (Rp %) melebihi total bayar pesanan (Rp %).', v_new_refunded_total, v_order.paid_total;
    end if;

    v_is_full_refund := (v_new_refunded_total = v_order.paid_total and not v_has_pending_midtrans);

    if v_is_full_refund then
      v_new_order_status := 'refunded';
      v_new_payment_status := 'refunded';
      if v_order.kds_status in ('queued', 'preparing', 'ready') then
        v_kds_status_after := null;
        v_kitchen_notified_at := coalesce(v_kitchen_notified_at, v_now);
      else
        v_kds_status_after := null;
      end if;

      update public.payments
      set payment_status = 'refunded', updated_at = v_now
      where order_id = v_order.id
        and payment_status = 'success';
    else
      v_new_order_status := v_order.status;
      v_new_payment_status := 'partially_refunded';
      v_kds_status_after := v_order.kds_status;

      update public.payments p
      set payment_status = 'refunded', updated_at = v_now
      where p.order_id = v_order.id
        and p.payment_status = 'success'
        and (
          select coalesce(sum(a.amount), 0)
          from public.refund_payout_allocations a
          where a.payment_id = p.id and a.payout_status = 'completed'
        ) + coalesce((
          select sum(r2.amount)
          from public.refunds r2
          where r2.payment_id = p.id
            and r2.status = 'completed'
            and not exists (select 1 from public.refund_payout_allocations ax where ax.refund_id = r2.id)
        ), 0) >= p.amount;
    end if;

    update public.orders
    set
      refunded_total = v_new_refunded_total,
      status = v_new_order_status,
      payment_status = v_new_payment_status,
      kds_status = v_kds_status_after,
      cancelled_by = case when v_is_full_refund then p_admin_id else cancelled_by end,
      cancelled_at = case when v_is_full_refund then v_now else cancelled_at end,
      cancel_reason = case when v_is_full_refund then pg_catalog.btrim(v_refund.reason) else cancel_reason end,
      updated_at = v_now
    where id = v_order.id;

    if v_order.order_type = 'dine_in' and v_order.table_id is not null and v_order.dining_session_id is not null then
      perform public.sync_dining_table_status_internal(v_order.table_id, v_order.dining_session_id, p_admin_id);
    end if;
  end if;

  update public.refunds
  set
    payout_method = v_aggregate_payout_method,
    payout_status = case when v_has_pending_midtrans then 'pending' else 'completed' end,
    status = case when v_has_pending_midtrans then 'pending' else 'completed' end,
    payout_completed_at = case when v_has_pending_midtrans then null else v_now end,
    shift_id = v_cash_shift_id,
    kitchen_notified_at = v_kitchen_notified_at,
    updated_at = v_now
  where id = p_refund_id;

  if v_refund.requested_by <> p_admin_id then
    perform public.notify_user_internal(
      v_refund.requested_by,
      case when v_has_pending_midtrans then 'refund_approved' else 'refund_payout_completed' end,
      case when v_has_pending_midtrans then 'Pengajuan Refund Disetujui (Menunggu Midtrans)' else 'Refund Disetujui & Selesai' end,
      pg_catalog.format('Pengajuan refund %s untuk pesanan #%s telah disetujui.', v_refund.refund_number, v_order.order_number),
      'refund',
      p_refund_id::text,
      pg_catalog.jsonb_build_object(
        'refund_number', v_refund.refund_number,
        'order_number', v_order.order_number,
        'payout_status', case when v_has_pending_midtrans then 'pending' else 'completed' end
      )
    );
  end if;

  if not v_has_pending_midtrans then
    insert into public.audit_logs (
      action,
      user_id,
      entity,
      entity_id,
      details
    ) values (
      'order.refunded',
      p_admin_id,
      'order',
      v_order.id::text,
      pg_catalog.jsonb_build_object(
        'refund_id', p_refund_id,
        'refund_number', v_refund.refund_number,
        'payout_method', v_aggregate_payout_method,
        'amount', v_refund.amount,
        'shift_id', v_cash_shift_id,
        'is_out_of_shift', v_any_cash_out_of_shift,
        'is_full_refund', v_is_full_refund
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'refund_id', p_refund_id,
    'refund_number', v_refund.refund_number,
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'approval_status', 'approved',
    'payout_status', case when v_has_pending_midtrans then 'pending' else 'completed' end,
    'payout_method', v_aggregate_payout_method,
    'status', case when v_has_pending_midtrans then 'pending' else 'completed' end,
    'amount', v_refund.amount,
    'refunded_total', coalesce(v_new_refunded_total, v_order.refunded_total)
  );
end;
$$;

revoke all on function public.execute_refund_approval_internal(uuid, uuid, text, jsonb, uuid, text) from public, anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 4. RPC PUBLIK: request_order_refund_atomic (KASIR & ADMIN)
-- Kasir hanya bisa mengajukan ('pending_approval').
-- Admin boleh mengajukan + menyetujui sendiri dalam 1 transaksi atomik bila
-- p_auto_approve = true (audit log tetap mencatat request dan approve terpisah).
-- Mengunci orders, order_items, dan refunds (FOR UPDATE) sebelum menghitung klaim.
-- -----------------------------------------------------------------------------
create or replace function public.request_order_refund_atomic(
  p_order_id uuid,
  p_resolution_type text,
  p_reason_category text,
  p_reason text,
  p_chronology text,
  p_items jsonb default '[]'::jsonb,
  p_preferred_payout_method text default null,
  p_payment_id uuid default null,
  p_receipt_verified boolean default true,
  p_duplicate_payment_amount integer default null,
  p_auto_approve boolean default false,
  p_payout_allocations jsonb default null,
  p_shift_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_is_active boolean;
  v_username text;
  v_full_name text;

  v_existing_refund record;
  v_pre_order record;
  v_order record;
  v_breakdown jsonb;
  v_calc_amount integer := 0;
  v_refund_id uuid;
  v_refund_number text;
  v_legacy_refund_type text;
  v_legacy_method text;
  v_now timestamptz := pg_catalog.now();
  v_item_el jsonb;
  v_item_id uuid;
  v_kds_snap text;
  v_inv_act text;
  v_table_name text := null;
  v_approval_result jsonb;
begin
  -- 1. Otorisasi ketat 3VL: Hanya kasir atau admin aktif
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select role, is_active, username, full_name
  into v_user_role, v_is_active, v_username, v_full_name
  from public.profiles
  where id = v_user_id;

  if not found or v_is_active is distinct from true or coalesce(v_user_role, '') not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir aktif yang berhak mengajukan refund.';
  end if;

  if p_auto_approve = true and v_user_role <> 'admin' then
    raise exception 'Hanya admin yang dapat mengajukan sekaligus menyetujui refund.';
  end if;

  if p_order_id is null then
    raise exception 'ID pesanan wajib diisi.';
  end if;

  if p_resolution_type not in ('full_refund', 'partial_refund', 'replacement') then
    raise exception 'Jenis penyelesaian komplain tidak valid: %.', p_resolution_type;
  end if;

  if p_reason_category not in ('stock_unavailable', 'wrong_order', 'missing_item', 'food_quality', 'long_waiting_time', 'payment_issue', 'other') then
    raise exception 'Kategori alasan refund tidak valid: %.', p_reason_category;
  end if;

  if p_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 3 then
    raise exception 'Alasan refund wajib diisi minimal 3 karakter.';
  end if;

  if p_chronology is null or pg_catalog.char_length(pg_catalog.btrim(p_chronology)) < 5 then
    raise exception 'Kronologi komplain pelanggan wajib diisi minimal 5 karakter.';
  end if;

  if coalesce(p_receipt_verified, false) is distinct from true then
    raise exception 'Verifikasi struk fisik atau digital Nine Licious wajib dilakukan sebelum mengajukan refund.';
  end if;

  if p_idempotency_key is null or pg_catalog.char_length(pg_catalog.btrim(p_idempotency_key)) < 8 then
    raise exception 'Kunci idempotensi wajib diisi (minimal 8 karakter).';
  end if;

  -- 2. Idempotency Check Awal
  select * into v_existing_refund
  from public.refunds
  where idempotency_key = pg_catalog.btrim(p_idempotency_key);

  if found then
    if v_existing_refund.order_id <> p_order_id
       or v_existing_refund.resolution_type <> p_resolution_type
       or v_existing_refund.reason_category <> p_reason_category then
      raise exception 'Konflik Idempotensi: Kunci "%" telah dipakai untuk pengajuan berbeda.', pg_catalog.btrim(p_idempotency_key);
    end if;

    return pg_catalog.jsonb_build_object(
      'refund_id', v_existing_refund.id,
      'refund_number', v_existing_refund.refund_number,
      'order_id', v_existing_refund.order_id,
      'resolution_type', v_existing_refund.resolution_type,
      'approval_status', v_existing_refund.approval_status,
      'payout_status', v_existing_refund.payout_status,
      'status', v_existing_refund.status,
      'amount', v_existing_refund.amount,
      'is_duplicate', true
    );
  end if;

  -- 3. Pre-read & Hierarchical Locking L1 -> L7 sebelum perhitungan kumulatif per order_item_id
  select id, order_type, order_kind, table_id, dining_session_id
  into v_pre_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  if v_pre_order.order_type = 'dine_in' and coalesce(v_pre_order.order_kind, 'standard') = 'standard' then
    if v_pre_order.table_id is not null then
      perform 1 from public.dining_tables where id = v_pre_order.table_id for update;
    end if;
    if v_pre_order.dining_session_id is not null then
      perform 1 from public.dining_sessions where id = v_pre_order.dining_session_id for update;
    end if;
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  perform 1 from public.order_items where order_id = p_order_id order by id asc for update;
  perform 1 from public.order_allocations where order_id = p_order_id order by id asc for update;
  perform 1 from public.midtrans_transactions where order_id = p_order_id order by id asc for update;
  perform 1 from public.payments where order_id = p_order_id order by id asc for update;
  perform 1 from public.refunds where order_id = p_order_id order by id asc for update;

  -- Re-check idempotency setelah lock
  select * into v_existing_refund
  from public.refunds
  where idempotency_key = pg_catalog.btrim(p_idempotency_key);

  if found then
    if v_existing_refund.order_id <> p_order_id
       or v_existing_refund.resolution_type <> p_resolution_type
       or v_existing_refund.reason_category <> p_reason_category then
      raise exception 'Konflik Idempotensi: Kunci "%" telah dipakai untuk pengajuan berbeda.', pg_catalog.btrim(p_idempotency_key);
    end if;

    return pg_catalog.jsonb_build_object(
      'refund_id', v_existing_refund.id,
      'refund_number', v_existing_refund.refund_number,
      'order_id', v_existing_refund.order_id,
      'resolution_type', v_existing_refund.resolution_type,
      'approval_status', v_existing_refund.approval_status,
      'payout_status', v_existing_refund.payout_status,
      'status', v_existing_refund.status,
      'amount', v_existing_refund.amount,
      'is_duplicate', true
    );
  end if;

  -- 4. Validasi Kelayakan Pesanan (Wajib Lunas, Non-Replacement, & Batas 24 Jam dari paid_at)
  if coalesce(v_order.order_kind, 'standard') <> 'standard' then
    raise exception 'Pesanan pengganti (replacement) tidak dapat diajukan refund kembali.';
  end if;

  if v_order.status = 'partially_paid' or v_order.payment_status = 'partially_paid' then
    raise exception 'Pesanan berstatus bayar sebagian (partially_paid) belum lunas dan tidak memenuhi syarat pengajuan refund baru.';
  end if;

  if v_order.status not in ('paid', 'completed') then
    raise exception 'Hanya pesanan yang sudah lunas (paid/completed) yang dapat diajukan refund (status saat ini: %).', v_order.status;
  end if;

  if v_order.paid_at is null then
    raise exception 'Pesanan belum memiliki timestamp pelunasan (paid_at) yang valid.';
  end if;

  if v_now > (v_order.paid_at + interval '24 hours') then
    raise exception 'Pengajuan refund ditolak: Batas waktu pengajuan maksimal 24 jam sejak transaksi lunas telah terlampaui.';
  end if;

  -- 5. Hitung Nominal Otomatis Server-Side (setelah baris order_items & refunds terkunci FOR UPDATE)
  v_breakdown := public.calculate_refund_breakdown_internal(
    p_order_id,
    p_items,
    p_resolution_type,
    p_reason_category,
    p_duplicate_payment_amount
  );

  v_calc_amount := coalesce((v_breakdown ->> 'total_refund_amount')::integer, 0);

  if p_resolution_type = 'full_refund' and v_calc_amount <> (v_breakdown ->> 'available_refundable')::integer then
    raise exception 'Untuk Full Refund, total item/nominal (Rp %) harus mencakup seluruh sisa dana refundable (Rp %).',
      v_calc_amount, (v_breakdown ->> 'available_refundable')::integer;
  end if;

  v_refund_number := public.generate_refund_number();
  v_legacy_refund_type := case p_resolution_type
    when 'full_refund' then 'full'
    when 'partial_refund' then 'partial'
    else 'replacement'
  end;

  if p_resolution_type = 'replacement' then
    v_legacy_method := 'none';
  elsif p_preferred_payout_method in ('cash', 'transfer', 'midtrans', 'manual', 'mixed') then
    v_legacy_method := p_preferred_payout_method;
  else
    select
      case
        when pg_catalog.count(distinct case
          when payment_method = 'midtrans' or payment_source in ('midtrans_snap', 'qris_midtrans') then 'midtrans'
          when payment_method = 'cash' then 'cash'
          else 'transfer'
        end) > 1 then 'mixed'
        else coalesce(
          pg_catalog.max(case
            when payment_method = 'midtrans' or payment_source in ('midtrans_snap', 'qris_midtrans') then 'midtrans'
            when payment_method = 'cash' then 'cash'
            else 'transfer'
          end),
          'cash'
        )
      end
    into v_legacy_method
    from public.payments
    where order_id = p_order_id
      and payment_status = 'success';
  end if;

  -- 6. Insert Header pengajuan pada public.refunds (termasuk kolom referensi pembukuan R1/R4)
  insert into public.refunds (
    order_id,
    payment_id,
    refund_number,
    refund_type,
    resolution_type,
    refund_method,
    payout_method,
    amount,
    subtotal_amount,
    discount_amount,
    service_charge_amount,
    tax_amount,
    reference_service_charge_amount,
    reference_tax_amount,
    rounding_adjustment,
    reason,
    reason_category,
    chronology,
    receipt_verified,
    status,
    approval_status,
    payout_status,
    requested_by,
    idempotency_key,
    metadata
  ) values (
    p_order_id,
    p_payment_id,
    v_refund_number,
    v_legacy_refund_type,
    p_resolution_type,
    v_legacy_method,
    v_legacy_method,
    v_calc_amount,
    coalesce((v_breakdown ->> 'subtotal_amount')::integer, 0),
    coalesce((v_breakdown ->> 'discount_amount')::integer, 0),
    coalesce((v_breakdown ->> 'service_charge_amount')::integer, 0),
    coalesce((v_breakdown ->> 'tax_amount')::integer, 0),
    coalesce((v_breakdown ->> 'reference_service_charge_amount')::integer, 0),
    coalesce((v_breakdown ->> 'reference_tax_amount')::integer, 0),
    coalesce((v_breakdown ->> 'rounding_adjustment')::integer, 0),
    pg_catalog.btrim(p_reason),
    p_reason_category,
    pg_catalog.btrim(p_chronology),
    true,
    'pending',
    'pending_approval',
    'not_required',
    v_user_id,
    pg_catalog.btrim(p_idempotency_key),
    pg_catalog.jsonb_build_object(
      'requested_by_role', v_user_role,
      'requested_by_username', v_username,
      'order_number', v_order.order_number,
      'paid_at', v_order.paid_at
    )
  )
  returning id into v_refund_id;

  -- 7. Insert item pengajuan pada public.refund_items
  v_kds_snap := case
    when v_order.kds_status in ('queued', 'preparing', 'ready') then v_order.kds_status
    else null
  end;

  for v_item_el in select * from pg_catalog.jsonb_array_elements(v_breakdown -> 'items') loop
    v_item_id := (v_item_el ->> 'order_item_id')::uuid;

    v_inv_act := null;
    if p_resolution_type = 'replacement' then
      v_inv_act := 'replace';
    else
      select pg_catalog.lower(coalesce(nullif(pg_catalog.btrim(raw_it ->> 'inventory_action'), ''), ''))
      into v_inv_act
      from pg_catalog.jsonb_array_elements(p_items) raw_it
      where (raw_it ->> 'order_item_id')::uuid = v_item_id
      limit 1;

      if v_inv_act not in ('none', 'waste', 'restock') then
        v_inv_act := case
          when v_kds_snap = 'queued' and p_reason_category in ('stock_unavailable', 'long_waiting_time') then 'restock'
          when p_reason_category in ('food_quality', 'wrong_order') then 'waste'
          else 'none'
        end;
      end if;

      if v_inv_act = 'restock' and coalesce(v_kds_snap, '') in ('preparing', 'ready') then
        raise exception 'Item yang sudah diproses/siap di dapur (%) tidak dapat di-restock otomatis; catat sebagai waste atau none.', v_kds_snap;
      end if;
    end if;

    insert into public.refund_items (
      refund_id,
      order_item_id,
      product_name_snapshot,
      quantity,
      unit_price,
      subtotal_amount,
      discount_amount,
      order_discount_share,
      net_item_amount,
      service_charge_amount,
      tax_amount,
      reference_service_charge_amount,
      reference_tax_amount,
      rounding_adjustment,
      compensation_severity,
      compensation_percentage,
      is_full_item_refund,
      refund_amount,
      kds_status_snapshot,
      inventory_action,
      reason
    ) values (
      v_refund_id,
      v_item_id,
      v_item_el ->> 'product_name_snapshot',
      (v_item_el ->> 'quantity')::integer,
      (v_item_el ->> 'unit_price')::integer,
      (v_item_el ->> 'subtotal_amount')::integer,
      (v_item_el ->> 'discount_amount')::integer,
      (v_item_el ->> 'order_discount_share')::integer,
      (v_item_el ->> 'net_item_amount')::integer,
      (v_item_el ->> 'service_charge_amount')::integer,
      (v_item_el ->> 'tax_amount')::integer,
      coalesce((v_item_el ->> 'reference_service_charge_amount')::integer, 0),
      coalesce((v_item_el ->> 'reference_tax_amount')::integer, 0),
      (v_item_el ->> 'rounding_adjustment')::integer,
      v_item_el ->> 'compensation_severity',
      (v_item_el ->> 'compensation_percentage')::integer,
      coalesce((v_item_el ->> 'is_full_item_refund')::boolean, false),
      (v_item_el ->> 'refund_amount')::integer,
      v_kds_snap,
      v_inv_act,
      v_item_el ->> 'reason'
    );
  end loop;

  if p_resolution_type = 'replacement' then
    if v_order.table_id is not null then
      select name into v_table_name from public.dining_tables where id = v_order.table_id;
    end if;

    insert into public.order_replacements (
      original_order_id,
      refund_id,
      original_order_type,
      table_name_snapshot,
      status,
      items_summary,
      reason,
      created_by
    ) values (
      p_order_id,
      v_refund_id,
      v_order.order_type,
      v_table_name,
      'pending_approval',
      v_breakdown -> 'items',
      pg_catalog.btrim(p_reason),
      v_user_id
    );
  end if;

  -- 8. Audit Log Pengajuan & Notifikasi ke semua Admin aktif
  insert into public.audit_logs (
    action,
    user_id,
    username,
    entity,
    entity_id,
    details
  ) values (
    'order.refund_requested',
    v_user_id,
    v_username,
    'refund',
    v_refund_id::text,
    pg_catalog.jsonb_build_object(
      'refund_id', v_refund_id,
      'refund_number', v_refund_number,
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'resolution_type', p_resolution_type,
      'reason_category', p_reason_category,
      'amount', v_calc_amount,
      'requested_by_role', v_user_role
    )
  );

  perform public.notify_role_users_internal(
    array['admin'],
    'refund_requested',
    pg_catalog.format('Pengajuan %s Baru (%s)', p_resolution_type, v_order.order_number),
    pg_catalog.format(
      '%s mengajukan %s sebesar Rp %s untuk transaksi #%s (%s).',
      coalesce(v_full_name, v_username, 'Staf'),
      p_resolution_type,
      v_calc_amount,
      v_order.order_number,
      pg_catalog.btrim(p_reason)
    ),
    'refund',
    v_refund_id::text,
    pg_catalog.jsonb_build_object(
      'refund_id', v_refund_id,
      'refund_number', v_refund_number,
      'order_number', v_order.order_number,
      'cashier_name', coalesce(v_full_name, v_username),
      'resolution_type', p_resolution_type,
      'reason_category', p_reason_category,
      'amount', v_calc_amount
    ),
    case when p_auto_approve then v_user_id else null end
  );

  -- 9. Self-Approval Admin dalam 1 aksi atomik (bila diminta eksplisit oleh Admin)
  if p_auto_approve = true and v_user_role = 'admin' then
    v_approval_result := public.execute_refund_approval_internal(
      v_refund_id,
      v_user_id,
      v_user_role,
      p_payout_allocations,
      p_shift_id,
      'Disetujui langsung saat pengajuan oleh Admin'
    );

    return v_approval_result || pg_catalog.jsonb_build_object('is_duplicate', false, 'auto_approved', true);
  end if;

  return pg_catalog.jsonb_build_object(
    'refund_id', v_refund_id,
    'refund_number', v_refund_number,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'resolution_type', p_resolution_type,
    'approval_status', 'pending_approval',
    'payout_status', 'not_required',
    'status', 'pending',
    'amount', v_calc_amount,
    'breakdown', v_breakdown,
    'is_duplicate', false
  );
end;
$$;

revoke all on function public.request_order_refund_atomic(uuid, text, text, text, text, jsonb, text, uuid, boolean, integer, boolean, jsonb, uuid, text) from public, anon;
grant execute on function public.request_order_refund_atomic(uuid, text, text, text, text, jsonb, text, uuid, boolean, integer, boolean, jsonb, uuid, text) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 5. RPC PUBLIK: approve_order_refund_atomic (ADMIN ONLY)
-- -----------------------------------------------------------------------------
create or replace function public.approve_order_refund_atomic(
  p_refund_id uuid,
  p_payout_allocations jsonb default null,
  p_shift_id uuid default null,
  p_approval_notes text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_is_active boolean;
  v_pre_refund record;
  v_pre_order record;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select role, is_active into v_user_role, v_is_active
  from public.profiles
  where id = v_user_id;

  if not found or v_is_active is distinct from true or coalesce(v_user_role, '') <> 'admin' then
    raise exception 'Hanya admin aktif yang berhak menyetujui pengajuan refund.';
  end if;

  if p_refund_id is null then
    raise exception 'ID pengajuan refund wajib diisi.';
  end if;

  select * into v_pre_refund from public.refunds where id = p_refund_id;
  if not found then
    raise exception 'Data pengajuan refund tidak ditemukan.';
  end if;

  if v_pre_refund.approval_status = 'approved' then
    return pg_catalog.jsonb_build_object(
      'refund_id', v_pre_refund.id,
      'refund_number', v_pre_refund.refund_number,
      'order_id', v_pre_refund.order_id,
      'approval_status', v_pre_refund.approval_status,
      'payout_status', v_pre_refund.payout_status,
      'status', v_pre_refund.status,
      'amount', v_pre_refund.amount,
      'is_duplicate', true
    );
  end if;

  select id, order_type, order_kind, table_id, dining_session_id
  into v_pre_order
  from public.orders
  where id = v_pre_refund.order_id;

  if v_pre_order.order_type = 'dine_in' and coalesce(v_pre_order.order_kind, 'standard') = 'standard' then
    if v_pre_order.table_id is not null then
      perform 1 from public.dining_tables where id = v_pre_order.table_id for update;
    end if;
    if v_pre_order.dining_session_id is not null then
      perform 1 from public.dining_sessions where id = v_pre_order.dining_session_id for update;
    end if;
  end if;

  perform 1 from public.orders where id = v_pre_refund.order_id for update;
  perform 1 from public.order_items where order_id = v_pre_refund.order_id order by id asc for update;
  perform 1 from public.order_allocations where order_id = v_pre_refund.order_id order by id asc for update;
  perform 1 from public.midtrans_transactions where order_id = v_pre_refund.order_id order by id asc for update;
  perform 1 from public.payments where order_id = v_pre_refund.order_id order by id asc for update;

  -- Re-check status setelah memperoleh lock agar double-approve paralel mengembalikan idempotent replay
  select * into v_pre_refund from public.refunds where id = p_refund_id for update;
  if v_pre_refund.approval_status = 'approved' then
    return pg_catalog.jsonb_build_object(
      'refund_id', v_pre_refund.id,
      'refund_number', v_pre_refund.refund_number,
      'order_id', v_pre_refund.order_id,
      'approval_status', v_pre_refund.approval_status,
      'payout_status', v_pre_refund.payout_status,
      'status', v_pre_refund.status,
      'amount', v_pre_refund.amount,
      'is_duplicate', true
    );
  end if;

  return public.execute_refund_approval_internal(
    p_refund_id,
    v_user_id,
    v_user_role,
    p_payout_allocations,
    p_shift_id,
    p_approval_notes
  ) || pg_catalog.jsonb_build_object('is_duplicate', false);
end;
$$;

revoke all on function public.approve_order_refund_atomic(uuid, jsonb, uuid, text, text) from public, anon;
grant execute on function public.approve_order_refund_atomic(uuid, jsonb, uuid, text, text) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 6. RPC PUBLIK: reject_order_refund_atomic (ADMIN ONLY)
-- -----------------------------------------------------------------------------
create or replace function public.reject_order_refund_atomic(
  p_refund_id uuid,
  p_rejection_reason text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_is_active boolean;
  v_pre_refund record;
  v_refund record;
  v_order record;
  v_now timestamptz := pg_catalog.now();
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select role, is_active into v_user_role, v_is_active
  from public.profiles
  where id = v_user_id;

  if not found or v_is_active is distinct from true or coalesce(v_user_role, '') <> 'admin' then
    raise exception 'Hanya admin aktif yang berhak menolak pengajuan refund.';
  end if;

  if p_refund_id is null then
    raise exception 'ID pengajuan refund wajib diisi.';
  end if;

  if p_rejection_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_rejection_reason)) < 3 then
    raise exception 'Alasan penolakan wajib diisi minimal 3 karakter.';
  end if;

  select * into v_pre_refund from public.refunds where id = p_refund_id;
  if not found then
    raise exception 'Data pengajuan refund tidak ditemukan.';
  end if;

  -- Lock kanonikal L3 -> L7
  select id, order_number into v_order from public.orders where id = v_pre_refund.order_id for update;

  select * into v_refund
  from public.refunds
  where id = p_refund_id
  for update;

  if v_refund.approval_status = 'rejected' then
    return pg_catalog.jsonb_build_object(
      'refund_id', v_refund.id,
      'refund_number', v_refund.refund_number,
      'approval_status', 'rejected',
      'status', 'rejected',
      'is_duplicate', true
    );
  end if;

  if v_refund.approval_status <> 'pending_approval' then
    raise exception 'Hanya pengajuan berstatus pending_approval yang dapat ditolak (status: %).', v_refund.approval_status;
  end if;

  update public.refunds
  set
    approval_status = 'rejected',
    payout_status = 'not_required',
    status = 'rejected',
    reviewed_by = v_user_id,
    reviewed_at = v_now,
    rejection_reason = pg_catalog.btrim(p_rejection_reason),
    updated_at = v_now
  where id = p_refund_id;

  if v_refund.resolution_type = 'replacement' then
    update public.order_replacements
    set status = 'rejected',
        approved_by = v_user_id,
        approved_at = v_now,
        updated_at = v_now
    where refund_id = p_refund_id;
  end if;

  perform public.notify_user_internal(
    v_refund.requested_by,
    'refund_rejected',
    'Pengajuan Refund Ditolak',
    pg_catalog.format('Pengajuan %s (#%s) ditolak oleh Admin. Alasan: %s', v_refund.refund_number, coalesce(v_order.order_number, '-'), pg_catalog.btrim(p_rejection_reason)),
    'refund',
    p_refund_id::text,
    pg_catalog.jsonb_build_object(
      'refund_number', v_refund.refund_number,
      'order_number', v_order.order_number,
      'rejection_reason', pg_catalog.btrim(p_rejection_reason)
    )
  );

  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'order.refund_rejected',
    v_user_id,
    'refund',
    p_refund_id::text,
    pg_catalog.jsonb_build_object(
      'refund_id', p_refund_id,
      'refund_number', v_refund.refund_number,
      'order_id', v_refund.order_id,
      'order_number', v_order.order_number,
      'rejection_reason', pg_catalog.btrim(p_rejection_reason)
    )
  );

  return pg_catalog.jsonb_build_object(
    'refund_id', p_refund_id,
    'refund_number', v_refund.refund_number,
    'approval_status', 'rejected',
    'status', 'rejected',
    'rejection_reason', pg_catalog.btrim(p_rejection_reason),
    'is_duplicate', false
  );
end;
$$;

revoke all on function public.reject_order_refund_atomic(uuid, text, text) from public, anon;
grant execute on function public.reject_order_refund_atomic(uuid, text, text) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 7. RPC PUBLIK: cancel_order_refund_atomic (KASIR SENDIRI PRE-APPROVAL | ADMIN PRE-PAYOUT)
-- -----------------------------------------------------------------------------
create or replace function public.cancel_order_refund_atomic(
  p_refund_id uuid,
  p_cancellation_reason text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_is_active boolean;
  v_pre_refund record;
  v_refund record;
  v_order record;
  v_now timestamptz := pg_catalog.now();
  v_any_completed_or_processing boolean := false;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select role, is_active into v_user_role, v_is_active
  from public.profiles
  where id = v_user_id;

  if not found or v_is_active is distinct from true or coalesce(v_user_role, '') not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir aktif yang dapat membatalkan pengajuan refund.';
  end if;

  if p_refund_id is null then
    raise exception 'ID pengajuan refund wajib diisi.';
  end if;

  if p_cancellation_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_cancellation_reason)) < 3 then
    raise exception 'Alasan pembatalan wajib diisi minimal 3 karakter.';
  end if;

  select * into v_pre_refund from public.refunds where id = p_refund_id;
  if not found then
    raise exception 'Data pengajuan refund tidak ditemukan.';
  end if;

  -- Lock kanonikal L3 -> L7
  select id, order_number into v_order from public.orders where id = v_pre_refund.order_id for update;

  select * into v_refund
  from public.refunds
  where id = p_refund_id
  for update;

  if v_refund.approval_status = 'cancelled' then
    return pg_catalog.jsonb_build_object(
      'refund_id', v_refund.id,
      'refund_number', v_refund.refund_number,
      'approval_status', 'cancelled',
      'status', 'cancelled',
      'is_duplicate', true
    );
  end if;

  if v_refund.payout_status = 'completed' or v_refund.status = 'completed' then
    raise exception 'Refund yang sudah selesai dikembalikan tidak dapat dibatalkan atau dihapus.';
  end if;

  if v_refund.approval_status = 'pending_approval' then
    if v_user_role = 'kasir' and v_refund.requested_by <> v_user_id then
      raise exception 'Kasir hanya dapat membatalkan pengajuan refund miliknya sendiri.';
    end if;
  elsif v_refund.approval_status = 'approved' then
    if v_user_role <> 'admin' then
      raise exception 'Hanya Admin yang dapat membatalkan refund yang sudah disetujui.';
    end if;

    select exists (
      select 1
      from public.refund_payout_allocations
      where refund_id = p_refund_id
        and payout_status in ('processing', 'completed', 'reconciliation_required')
    ) into v_any_completed_or_processing;

    if v_any_completed_or_processing
       or v_refund.payout_status in ('processing', 'completed', 'reconciliation_required') then
      raise exception 'Pembatalan ditolak: Proses pencairan sudah dikirim atau sedang dalam rekonsiliasi Midtrans. Periksa status provider terlebih dahulu.';
    end if;
  else
    raise exception 'Pengajuan berstatus % tidak dapat dibatalkan.', v_refund.approval_status;
  end if;

  update public.refunds
  set
    approval_status = 'cancelled',
    payout_status = 'not_required',
    status = 'cancelled',
    cancellation_reason = pg_catalog.btrim(p_cancellation_reason),
    cancelled_by = v_user_id,
    cancelled_at = v_now,
    updated_at = v_now
  where id = p_refund_id;

  update public.refund_payout_allocations
  set payout_status = 'failed', updated_at = v_now
  where refund_id = p_refund_id
    and payout_status = 'pending';

  if v_refund.resolution_type = 'replacement' then
    update public.order_replacements
    set status = 'cancelled', updated_at = v_now
    where refund_id = p_refund_id
      and status in ('pending_approval', 'approved');
  end if;

  if v_refund.requested_by <> v_user_id then
    perform public.notify_user_internal(
      v_refund.requested_by,
      'refund_cancelled',
      'Pengajuan Refund Dibatalkan Admin',
      pg_catalog.format('Pengajuan %s (#%s) dibatalkan. Alasan: %s', v_refund.refund_number, coalesce(v_order.order_number, '-'), pg_catalog.btrim(p_cancellation_reason)),
      'refund',
      p_refund_id::text,
      pg_catalog.jsonb_build_object('cancellation_reason', pg_catalog.btrim(p_cancellation_reason))
    );
  end if;

  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'order.refund_cancelled',
    v_user_id,
    'refund',
    p_refund_id::text,
    pg_catalog.jsonb_build_object(
      'refund_id', p_refund_id,
      'refund_number', v_refund.refund_number,
      'previous_approval_status', v_refund.approval_status,
      'cancellation_reason', pg_catalog.btrim(p_cancellation_reason),
      'cancelled_by_role', v_user_role
    )
  );

  return pg_catalog.jsonb_build_object(
    'refund_id', p_refund_id,
    'refund_number', v_refund.refund_number,
    'approval_status', 'cancelled',
    'status', 'cancelled',
    'is_duplicate', false
  );
end;
$$;

revoke all on function public.cancel_order_refund_atomic(uuid, text, text) from public, anon;
grant execute on function public.cancel_order_refund_atomic(uuid, text, text) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 8. RPC BUKTI PENGADUAN & PERMINTAAN BUKTI TAMBAHAN
-- -----------------------------------------------------------------------------
create or replace function public.attach_refund_evidence_atomic(
  p_refund_id uuid,
  p_file_path text,
  p_file_name text,
  p_file_type text,
  p_file_size bigint,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_is_active boolean;
  v_refund record;
  v_kind text;
  v_ev_id uuid;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select role, is_active into v_user_role, v_is_active
  from public.profiles
  where id = v_user_id;

  if not found or v_is_active is distinct from true or coalesce(v_user_role, '') not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir aktif yang dapat melampirkan bukti refund.';
  end if;

  select * into v_refund from public.refunds where id = p_refund_id;
  if not found then
    raise exception 'Pengajuan refund tidak ditemukan.';
  end if;

  if v_user_role = 'kasir' and v_refund.requested_by <> v_user_id then
    raise exception 'Kasir hanya dapat mengunggah bukti untuk pengajuannya sendiri.';
  end if;

  if coalesce(p_file_path, '') like '%..%' then
    raise exception 'Path file bukti tidak valid.';
  end if;

  v_kind := case when pg_catalog.lower(p_file_type) like 'video/%' then 'video' else 'photo' end;

  insert into public.refund_evidence (
    refund_id,
    order_id,
    file_path,
    file_name,
    file_type,
    file_size,
    evidence_kind,
    notes,
    uploaded_by
  ) values (
    p_refund_id,
    v_refund.order_id,
    pg_catalog.btrim(p_file_path),
    pg_catalog.btrim(p_file_name),
    pg_catalog.lower(pg_catalog.btrim(p_file_type)),
    p_file_size,
    v_kind,
    nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''),
    v_user_id
  )
  returning id into v_ev_id;

  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'refund.evidence_uploaded',
    v_user_id,
    'refund',
    p_refund_id::text,
    pg_catalog.jsonb_build_object(
      'evidence_id', v_ev_id,
      'file_name', pg_catalog.btrim(p_file_name),
      'file_type', pg_catalog.lower(pg_catalog.btrim(p_file_type)),
      'file_size', p_file_size
    )
  );

  return pg_catalog.jsonb_build_object('ok', true, 'evidence_id', v_ev_id);
end;
$$;

revoke all on function public.attach_refund_evidence_atomic(uuid, text, text, text, bigint, text) from public, anon;
grant execute on function public.attach_refund_evidence_atomic(uuid, text, text, text, bigint, text) to authenticated, service_role;

create or replace function public.request_refund_evidence_atomic(
  p_refund_id uuid,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_is_active boolean;
  v_refund record;
  v_order_number text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select role, is_active into v_user_role, v_is_active
  from public.profiles
  where id = v_user_id;

  if not found or v_is_active is distinct from true or coalesce(v_user_role, '') <> 'admin' then
    raise exception 'Hanya admin aktif yang dapat meminta bukti tambahan kepada kasir.';
  end if;

  if p_note is null or pg_catalog.char_length(pg_catalog.btrim(p_note)) < 3 then
    raise exception 'Catatan permintaan bukti wajib diisi minimal 3 karakter.';
  end if;

  select * into v_refund from public.refunds where id = p_refund_id;
  if not found then
    raise exception 'Pengajuan refund tidak ditemukan.';
  end if;

  select order_number into v_order_number from public.orders where id = v_refund.order_id;

  perform public.notify_user_internal(
    v_refund.requested_by,
    'refund_evidence_requested',
    'Admin Meminta Bukti Tambahan Refund',
    pg_catalog.format('Untuk pengajuan %s (#%s): %s', v_refund.refund_number, coalesce(v_order_number, '-'), pg_catalog.btrim(p_note)),
    'refund',
    p_refund_id::text,
    pg_catalog.jsonb_build_object('note', pg_catalog.btrim(p_note))
  );

  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'refund.evidence_requested',
    v_user_id,
    'refund',
    p_refund_id::text,
    pg_catalog.jsonb_build_object('note', pg_catalog.btrim(p_note))
  );

  return pg_catalog.jsonb_build_object('ok', true, 'refund_id', p_refund_id);
end;
$$;

revoke all on function public.request_refund_evidence_atomic(uuid, text) from public, anon;
grant execute on function public.request_refund_evidence_atomic(uuid, text) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 9. MIDTRANS PAYOUT STATUS, FALLBACK TRANSFER MANUAL, & KONFIRMASI GATEWAY
-- -----------------------------------------------------------------------------
create or replace function public.mark_midtrans_refund_processing_atomic(
  p_refund_id uuid,
  p_allocation_id uuid default null,
  p_payout_status text default 'processing',
  p_gateway_refund_id text default null,
  p_gateway_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_refund record;
  v_now timestamptz := pg_catalog.now();
begin
  v_user_id := auth.uid();
  if v_user_id is not null then
    v_user_role := public.current_user_role();
    if coalesce(v_user_role, '') <> 'admin' then
      raise exception 'Hanya admin yang berhak memperbarui status proses refund Midtrans.';
    end if;
  end if;

  if p_payout_status not in ('processing', 'failed', 'reconciliation_required') then
    raise exception 'Status proses Midtrans tidak valid: %.', p_payout_status;
  end if;

  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found or v_refund.approval_status <> 'approved' then
    raise exception 'Hanya refund yang sudah disetujui yang dapat dikirim ke Midtrans.';
  end if;

  if p_allocation_id is not null then
    update public.refund_payout_allocations
    set
      payout_status = p_payout_status,
      gateway_refund_id = coalesce(nullif(pg_catalog.btrim(coalesce(p_gateway_refund_id, '')), ''), gateway_refund_id),
      metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_gateway_payload, '{}'::jsonb),
      updated_at = v_now
    where id = p_allocation_id
      and refund_id = p_refund_id;
  else
    update public.refund_payout_allocations
    set
      payout_status = p_payout_status,
      gateway_refund_id = coalesce(nullif(pg_catalog.btrim(coalesce(p_gateway_refund_id, '')), ''), gateway_refund_id),
      metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_gateway_payload, '{}'::jsonb),
      updated_at = v_now
    where refund_id = p_refund_id
      and payout_method = 'midtrans'
      and payout_status in ('pending', 'processing');
  end if;

  update public.refunds
  set
    payout_status = p_payout_status,
    gateway_refund_id = coalesce(nullif(pg_catalog.btrim(coalesce(p_gateway_refund_id, '')), ''), gateway_refund_id),
    metadata = coalesce(metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object('midtrans_refund_update', coalesce(p_gateway_payload, '{}'::jsonb)),
    updated_at = v_now
  where id = p_refund_id;

  return pg_catalog.jsonb_build_object('ok', true, 'refund_id', p_refund_id, 'payout_status', p_payout_status);
end;
$$;

revoke all on function public.mark_midtrans_refund_processing_atomic(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.mark_midtrans_refund_processing_atomic(uuid, uuid, text, text, jsonb) to service_role;

create or replace function public.complete_refund_manual_fallback_atomic(
  p_refund_id uuid,
  p_allocation_id uuid default null,
  p_payout_reference text default null,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_is_active boolean;
  v_refund record;
  v_order record;
  v_leg record;
  v_leg_sum integer := 0;
  v_remaining_pending integer := 0;
  v_new_refunded_total integer;
  v_is_full boolean := false;
  v_now timestamptz := pg_catalog.now();
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select role, is_active into v_user_role, v_is_active
  from public.profiles where id = v_user_id;

  if not found or v_is_active is distinct from true or coalesce(v_user_role, '') <> 'admin' then
    raise exception 'Hanya admin aktif yang berhak menyelesaikan fallback transfer manual untuk refund Midtrans.';
  end if;

  if p_payout_reference is null or pg_catalog.char_length(pg_catalog.btrim(p_payout_reference)) < 3 then
    raise exception 'Referensi transfer manual (nomor referensi bank/bukti) wajib diisi.';
  end if;

  if p_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 3 then
    raise exception 'Alasan penggunaan transfer manual pengganti Midtrans wajib diisi.';
  end if;

  select * into v_refund from public.refunds where id = p_refund_id;
  if not found or v_refund.approval_status <> 'approved' then
    raise exception 'Refund belum berstatus disetujui (approved).';
  end if;

  select * into v_order from public.orders where id = v_refund.order_id for update;
  perform 1 from public.payments where order_id = v_order.id order by id asc for update;
  select * into v_refund from public.refunds where id = p_refund_id for update;

  for v_leg in
    select * from public.refund_payout_allocations
    where refund_id = p_refund_id
      and (p_allocation_id is null or id = p_allocation_id)
      and payout_method in ('midtrans', 'transfer')
      and payout_status in ('pending', 'failed', 'reconciliation_required')
    for update
  loop
    update public.refund_payout_allocations
    set
      payout_method = 'transfer',
      payout_status = 'completed',
      payout_reference = pg_catalog.btrim(p_payout_reference),
      payout_completed_at = v_now,
      metadata = coalesce(metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object('manual_fallback_reason', pg_catalog.btrim(p_reason), 'completed_by', v_user_id),
      updated_at = v_now
    where id = v_leg.id;

    v_leg_sum := v_leg_sum + v_leg.amount;
  end loop;

  if v_leg_sum = 0 then
    if v_refund.payout_status = 'completed' then
      return pg_catalog.jsonb_build_object('ok', true, 'refund_id', p_refund_id, 'status', 'completed', 'is_duplicate', true);
    end if;
    raise exception 'Tidak ada alokasi pencairan yang memenuhi syarat untuk diselesaikan sebagai transfer manual.';
  end if;

  v_new_refunded_total := coalesce(v_order.refunded_total, 0) + v_leg_sum;
  if v_new_refunded_total > v_order.paid_total then
    raise exception 'Akumulasi refund melebihi total dibayar.';
  end if;

  select pg_catalog.count(*)::integer into v_remaining_pending
  from public.refund_payout_allocations
  where refund_id = p_refund_id
    and payout_status in ('pending', 'processing', 'reconciliation_required');

  v_is_full := (v_new_refunded_total = v_order.paid_total);

  update public.orders
  set
    refunded_total = v_new_refunded_total,
    status = case when v_is_full then 'refunded' else status end,
    payment_status = case when v_is_full then 'refunded' else 'partially_refunded' end,
    kds_status = case when v_is_full then null else kds_status end,
    updated_at = v_now
  where id = v_order.id;

  if v_order.order_type = 'dine_in' and v_order.table_id is not null and v_order.dining_session_id is not null then
    perform public.sync_dining_table_status_internal(v_order.table_id, v_order.dining_session_id, v_user_id);
  end if;

  update public.payments p
  set payment_status = 'refunded', updated_at = v_now
  where p.order_id = v_order.id
    and p.payment_status = 'success'
    and (
      v_is_full
      or (select coalesce(sum(a.amount), 0) from public.refund_payout_allocations a where a.payment_id = p.id and a.payout_status = 'completed') >= p.amount
    );

  update public.refunds
  set
    payout_status = case when v_remaining_pending > 0 then 'pending' else 'completed' end,
    status = case when v_remaining_pending > 0 then 'pending' else 'completed' end,
    payout_reference = pg_catalog.btrim(p_payout_reference),
    payout_completed_at = case when v_remaining_pending > 0 then null else v_now end,
    updated_at = v_now
  where id = p_refund_id;

  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'order.refund_manual_payout_completed',
    v_user_id,
    'refund',
    p_refund_id::text,
    pg_catalog.jsonb_build_object(
      'refund_id', p_refund_id,
      'payout_reference', pg_catalog.btrim(p_payout_reference),
      'amount', v_leg_sum,
      'reason', pg_catalog.btrim(p_reason)
    )
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'refund_id', p_refund_id,
    'amount', v_leg_sum,
    'payout_status', case when v_remaining_pending > 0 then 'pending' else 'completed' end,
    'status', case when v_remaining_pending > 0 then 'pending' else 'completed' end,
    'is_duplicate', false
  );
end;
$$;

revoke all on function public.complete_refund_manual_fallback_atomic(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.complete_refund_manual_fallback_atomic(uuid, uuid, text, text, text) to authenticated, service_role;


-- Perbarui confirm_midtrans_refund_atomic (service_role ONLY) agar mendukung multi-leg R1 maupun F2.4 tunggal
create or replace function public.confirm_midtrans_refund_atomic(
  p_refund_id uuid,
  p_gateway_refund_id text,
  p_expected_amount integer default null,
  p_gateway_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund record;
  v_order record;
  v_payment record;
  v_pre_order record;
  v_leg record;
  v_is_full_refund boolean := false;
  v_new_order_status text;
  v_new_payment_status text;
  v_kds_status_after text;
  v_kitchen_notified_at timestamptz := null;
  v_new_refunded_total integer;
  v_payment_completed_after integer := 0;
  v_confirmed_leg_amount integer := 0;
  v_remaining_legs integer := 0;
  v_has_allocations boolean := false;
  v_now timestamptz := pg_catalog.now();
begin
  if p_gateway_refund_id is null or pg_catalog.char_length(pg_catalog.btrim(p_gateway_refund_id)) < 3 then
    raise exception 'Gateway refund ID wajib diisi dari gateway Midtrans.';
  end if;

  select * into v_refund from public.refunds where id = p_refund_id;
  if not found then
    raise exception 'Data refund dengan ID % tidak ditemukan.', p_refund_id;
  end if;

  if v_refund.refund_method not in ('midtrans', 'mixed') and v_refund.payout_method not in ('midtrans', 'mixed') then
    raise exception 'Hanya refund yang memiliki alokasi Midtrans yang dapat dikonfirmasi gateway.';
  end if;

  if v_refund.status = 'completed' and v_refund.payout_status = 'completed' then
    if v_refund.gateway_refund_id = pg_catalog.btrim(p_gateway_refund_id)
       or exists (
         select 1 from public.refund_payout_allocations a
         where a.refund_id = p_refund_id
           and a.gateway_refund_id = pg_catalog.btrim(p_gateway_refund_id)
           and a.payout_status = 'completed'
       ) then
      return pg_catalog.jsonb_build_object(
        'refund_id', v_refund.id,
        'refund_number', v_refund.refund_number,
        'gateway_refund_id', pg_catalog.btrim(p_gateway_refund_id),
        'amount', coalesce(p_expected_amount, v_refund.amount),
        'status', 'completed',
        'is_duplicate', true,
        'message', 'Refund Midtrans telah dikonfirmasi sebelumnya (idempotent replay).'
      );
    else
      raise exception 'Konflik Gateway: Refund ini sudah selesai dengan gateway refund ID lain (%).', v_refund.gateway_refund_id;
    end if;
  end if;

  if v_refund.status <> 'pending' then
    raise exception 'Hanya refund berstatus pending yang dapat dikonfirmasi (status saat ini: %).', v_refund.status;
  end if;

  if exists (
    select 1 from public.refunds
    where gateway_refund_id = pg_catalog.btrim(p_gateway_refund_id)
      and id <> p_refund_id
  ) or exists (
    select 1 from public.refund_payout_allocations
    where gateway_refund_id = pg_catalog.btrim(p_gateway_refund_id)
      and refund_id <> p_refund_id
  ) then
    raise exception 'Gateway refund ID "%" telah digunakan oleh transaksi refund lain.', pg_catalog.btrim(p_gateway_refund_id);
  end if;

  select id, order_number, order_type, order_kind, table_id, dining_session_id
  into v_pre_order
  from public.orders
  where id = v_refund.order_id;

  if not found then
    raise exception 'Pesanan terkait tidak ditemukan.';
  end if;

  -- Hierarchical Locking L1 -> L7
  if v_pre_order.order_type = 'dine_in' and coalesce(v_pre_order.order_kind, 'standard') = 'standard' then
    if v_pre_order.table_id is not null then
      perform 1 from public.dining_tables where id = v_pre_order.table_id for update;
    end if;
    if v_pre_order.dining_session_id is not null then
      perform 1 from public.dining_sessions where id = v_pre_order.dining_session_id for update;
    end if;
  end if;

  select * into v_order from public.orders where id = v_refund.order_id for update;
  perform 1 from public.order_allocations where order_id = v_refund.order_id order by id asc for update;
  perform 1 from public.midtrans_transactions where order_id = v_refund.order_id order by id asc for update;
  perform 1 from public.payments where order_id = v_refund.order_id order by id asc for update;
  select * into v_refund from public.refunds where id = p_refund_id for update;

  -- Idempotency guard per allocation (wajib untuk multi-leg Split Bill sebelum leg terakhir selesai)
  if exists (
    select 1
    from public.refund_payout_allocations a
    where a.refund_id = p_refund_id
      and a.gateway_refund_id = pg_catalog.btrim(p_gateway_refund_id)
      and a.payout_status = 'completed'
  ) then
    return pg_catalog.jsonb_build_object(
      'refund_id', v_refund.id,
      'refund_number', v_refund.refund_number,
      'gateway_refund_id', pg_catalog.btrim(p_gateway_refund_id),
      'amount', coalesce(p_expected_amount, v_refund.amount),
      'status', v_refund.status,
      'is_duplicate', true,
      'message', 'Alokasi refund Midtrans telah dikonfirmasi sebelumnya (idempotent replay).'
    );
  end if;

  select exists (
    select 1 from public.refund_payout_allocations where refund_id = p_refund_id
  ) into v_has_allocations;

  if v_has_allocations then
    for v_leg in
      select * from public.refund_payout_allocations
      where refund_id = p_refund_id
        and payout_method = 'midtrans'
        and payout_status in ('pending', 'processing', 'reconciliation_required')
        and (p_expected_amount is null or amount = p_expected_amount)
      order by created_at asc, id asc
      for update
    loop
      update public.refund_payout_allocations
      set
        payout_status = 'completed',
        gateway_refund_id = pg_catalog.btrim(p_gateway_refund_id),
        payout_completed_at = v_now,
        metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_gateway_payload, '{}'::jsonb),
        updated_at = v_now
      where id = v_leg.id;

      v_confirmed_leg_amount := v_confirmed_leg_amount + v_leg.amount;
      exit when p_expected_amount is not null;
    end loop;

    if v_confirmed_leg_amount = 0 then
      if p_expected_amount is not null then
        raise exception 'Nominal konfirmasi gateway (Rp %) tidak cocok dengan alokasi Midtrans pending pada refund ini.', p_expected_amount;
      end if;
      raise exception 'Tidak ada alokasi Midtrans yang menunggu konfirmasi pada refund ini.';
    end if;
  else
    if p_expected_amount is not null and p_expected_amount <> v_refund.amount then
      raise exception 'Nominal konfirmasi gateway (Rp %) tidak sesuai dengan nominal refund yang diminta (Rp %).',
        p_expected_amount, v_refund.amount;
    end if;
    v_confirmed_leg_amount := v_refund.amount;
  end if;

  v_new_refunded_total := coalesce(v_order.refunded_total, 0) + v_confirmed_leg_amount;
  if v_new_refunded_total > v_order.paid_total then
    raise exception 'Konfirmasi gagal: Akumulasi refund (Rp %) melampaui total bayar pesanan (Rp %).',
      v_new_refunded_total, v_order.paid_total;
  end if;

  select pg_catalog.count(*)::integer into v_remaining_legs
  from public.refund_payout_allocations
  where refund_id = p_refund_id
    and payout_status in ('pending', 'processing', 'reconciliation_required');

  v_is_full_refund := (v_new_refunded_total = v_order.paid_total);

  if v_is_full_refund then
    if v_order.status in ('paid', 'completed') then
      v_new_order_status := 'refunded';
      v_new_payment_status := 'refunded';
    elsif v_order.status in ('awaiting_payment', 'partially_paid') then
      v_new_order_status := 'cancelled';
      v_new_payment_status := 'refunded';
    else
      v_new_order_status := 'refunded';
      v_new_payment_status := 'refunded';
    end if;

    if v_order.kds_status in ('queued', 'preparing', 'ready') then
      v_kds_status_after := null;
      v_kitchen_notified_at := v_now;
    else
      v_kds_status_after := null;
      v_kitchen_notified_at := null;
    end if;

    update public.payments
    set payment_status = 'refunded', updated_at = v_now
    where order_id = v_refund.order_id and payment_status = 'success';
  else
    v_new_order_status := v_order.status;
    v_new_payment_status := 'partially_refunded';
    v_kds_status_after := v_order.kds_status;

    if v_has_allocations then
      update public.payments p
      set payment_status = 'refunded', updated_at = v_now
      where p.order_id = v_refund.order_id
        and p.payment_status = 'success'
        and (
          select coalesce(sum(a.amount), 0)
          from public.refund_payout_allocations a
          where a.payment_id = p.id and a.payout_status = 'completed'
        ) >= p.amount;
    elsif v_refund.payment_id is not null then
      select * into v_payment from public.payments where id = v_refund.payment_id;
      if found then
        select coalesce(sum(amount), 0)::integer into v_payment_completed_after
        from public.refunds
        where payment_id = v_refund.payment_id and status = 'completed' and id <> p_refund_id;

        if (v_payment_completed_after + v_confirmed_leg_amount) >= v_payment.amount then
          update public.payments set payment_status = 'refunded', updated_at = v_now where id = v_refund.payment_id;
        end if;
      end if;
    end if;
  end if;

  update public.refunds
  set
    status = case when v_remaining_legs > 0 then 'pending' else 'completed' end,
    payout_status = case when v_remaining_legs > 0 then 'pending' else 'completed' end,
    approval_status = 'approved',
    gateway_refund_id = coalesce(gateway_refund_id, pg_catalog.btrim(p_gateway_refund_id)),
    approved_by = coalesce(approved_by, requested_by),
    approved_at = coalesce(approved_at, v_now),
    reviewed_by = coalesce(reviewed_by, requested_by),
    reviewed_at = coalesce(reviewed_at, v_now),
    payout_completed_at = case when v_remaining_legs > 0 then null else v_now end,
    kitchen_notified_at = coalesce(kitchen_notified_at, v_kitchen_notified_at),
    metadata = coalesce(v_refund.metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'confirmed_at', v_now,
      'gateway_refund_id', pg_catalog.btrim(p_gateway_refund_id),
      'gateway_payload', coalesce(p_gateway_payload, '{}'::jsonb),
      'previous_order_status', v_order.status,
      'new_order_status', v_new_order_status
    ),
    updated_at = v_now
  where id = p_refund_id;

  update public.orders
  set
    refunded_total = v_new_refunded_total,
    status = v_new_order_status,
    payment_status = v_new_payment_status,
    kds_status = v_kds_status_after,
    cancelled_by = case when v_is_full_refund then coalesce(v_refund.approved_by, v_refund.requested_by) else cancelled_by end,
    cancelled_at = case when v_is_full_refund then v_now else cancelled_at end,
    cancel_reason = case when v_is_full_refund then v_refund.reason else cancel_reason end,
    updated_at = v_now
  where id = v_refund.order_id;

  if v_order.order_type = 'dine_in' and v_order.table_id is not null and v_order.dining_session_id is not null then
    perform public.sync_dining_table_status_internal(v_order.table_id, v_order.dining_session_id, v_refund.requested_by);
  end if;

  perform public.notify_user_internal(
    v_refund.requested_by,
    'refund_payout_completed',
    'Refund Midtrans Selesai Dikonfirmasi',
    pg_catalog.format('Pengembalian dana Midtrans %s (Rp %s) telah selesai dikonfirmasi.', v_refund.refund_number, v_confirmed_leg_amount),
    'refund',
    p_refund_id::text,
    pg_catalog.jsonb_build_object('gateway_refund_id', pg_catalog.btrim(p_gateway_refund_id), 'amount', v_confirmed_leg_amount)
  );

  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'order.refund_confirmed',
    coalesce(v_refund.approved_by, v_refund.requested_by),
    'order',
    v_refund.order_id::text,
    pg_catalog.jsonb_build_object(
      'refund_id', p_refund_id,
      'refund_number', v_refund.refund_number,
      'gateway_refund_id', pg_catalog.btrim(p_gateway_refund_id),
      'amount', v_confirmed_leg_amount,
      'new_order_status', v_new_order_status,
      'new_payment_status', v_new_payment_status,
      'is_full_refund', v_is_full_refund
    )
  );

  return pg_catalog.jsonb_build_object(
    'refund_id', p_refund_id,
    'refund_number', v_refund.refund_number,
    'gateway_refund_id', pg_catalog.btrim(p_gateway_refund_id),
    'order_id', v_refund.order_id,
    'amount', v_confirmed_leg_amount,
    'status', case when v_remaining_legs > 0 then 'pending' else 'completed' end,
    'new_order_status', v_new_order_status,
    'new_payment_status', v_new_payment_status,
    'refunded_total', v_new_refunded_total,
    'is_duplicate', false
  );
end;
$$;

revoke all on function public.confirm_midtrans_refund_atomic(uuid, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.confirm_midtrans_refund_atomic(uuid, text, integer, jsonb) to service_role;


-- -----------------------------------------------------------------------------
-- 10. RPC PUBLIK: record_refund_correction_atomic (ADMIN ONLY)
-- Tidak mengedit baris refund yang sudah selesai.
-- Over-refund tidak melanggar orders_refunded_total <= paid_total.
-- -----------------------------------------------------------------------------
create or replace function public.record_refund_correction_atomic(
  p_refund_id uuid,
  p_expected_amount integer,
  p_actual_amount integer,
  p_reason text,
  p_create_supplemental_refund boolean default false,
  p_supplemental_method text default 'cash',
  p_shift_id uuid default null,
  p_follow_up_notes text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_is_active boolean;
  v_existing record;
  v_refund record;
  v_order record;
  v_diff integer;
  v_type text;
  v_shortfall integer;
  v_available integer;
  v_pending_total integer;
  v_supp_id uuid := null;
  v_supp_number text := null;
  v_corr_id uuid;
  v_now timestamptz := pg_catalog.now();
  v_supp_res jsonb;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  select role, is_active into v_user_role, v_is_active from public.profiles where id = v_user_id;
  if not found or v_is_active is distinct from true or coalesce(v_user_role, '') <> 'admin' then
    raise exception 'Hanya admin aktif yang berhak mencatat koreksi refund.';
  end if;

  if p_refund_id is null or p_expected_amount is null or p_actual_amount is null then
    raise exception 'Parameter koreksi refund tidak lengkap.';
  end if;

  if p_expected_amount < 0 or p_actual_amount < 0 or p_expected_amount = p_actual_amount then
    raise exception 'Nominal seharusnya dan nominal aktual harus valid serta memiliki selisih.';
  end if;

  if p_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 3 then
    raise exception 'Alasan koreksi wajib diisi minimal 3 karakter.';
  end if;

  if p_idempotency_key is null or pg_catalog.char_length(pg_catalog.btrim(p_idempotency_key)) < 8 then
    raise exception 'Kunci idempotensi koreksi wajib diisi (minimal 8 karakter).';
  end if;

  select * into v_existing from public.refund_corrections where idempotency_key = pg_catalog.btrim(p_idempotency_key);
  if found then
    return pg_catalog.jsonb_build_object(
      'correction_id', v_existing.id,
      'correction_type', v_existing.correction_type,
      'difference_amount', v_existing.difference_amount,
      'supplemental_refund_id', v_existing.supplemental_refund_id,
      'is_duplicate', true
    );
  end if;

  select * into v_refund from public.refunds where id = p_refund_id;
  if not found then
    raise exception 'Data refund tidak ditemukan.';
  end if;

  if v_refund.approval_status <> 'approved' or v_refund.payout_status <> 'completed' then
    raise exception 'Koreksi hanya dapat dibuat untuk refund yang telah disetujui dan selesai dibayarkan.';
  end if;

  -- Hierarchical Locking: orders (L3) -> payments (L6) -> refunds (L7)
  select * into v_order from public.orders where id = v_refund.order_id for update;
  perform 1 from public.payments where order_id = v_order.id order by id asc for update;
  select * into v_refund from public.refunds where id = p_refund_id for update;

  -- Re-check idempotency setelah lock
  select * into v_existing from public.refund_corrections where idempotency_key = pg_catalog.btrim(p_idempotency_key);
  if found then
    return pg_catalog.jsonb_build_object(
      'correction_id', v_existing.id,
      'correction_type', v_existing.correction_type,
      'difference_amount', v_existing.difference_amount,
      'supplemental_refund_id', v_existing.supplemental_refund_id,
      'is_duplicate', true
    );
  end if;

  v_diff := p_actual_amount - p_expected_amount;
  v_type := case when v_diff < 0 then 'under_refund' else 'over_refund' end;

  if v_type = 'under_refund' and p_create_supplemental_refund = true then
    v_shortfall := pg_catalog.abs(v_diff);
    v_pending_total := public.get_order_pending_refund_amount_internal(v_order.id);
    v_available := coalesce(v_order.paid_total, 0) - (coalesce(v_order.refunded_total, 0) + v_pending_total);

    if v_shortfall > v_available then
      raise exception 'Kekurangan pengembalian (Rp %) melebihi sisa batas refundable pesanan (Rp %).', v_shortfall, v_available;
    end if;

    if p_supplemental_method not in ('cash', 'transfer', 'midtrans', 'manual') then
      raise exception 'Metode pencairan refund tambahan tidak valid.';
    end if;

    v_supp_number := public.generate_refund_number();

    insert into public.refunds (
      order_id,
      parent_refund_id,
      refund_number,
      refund_type,
      resolution_type,
      refund_method,
      payout_method,
      amount,
      reason,
      reason_category,
      chronology,
      receipt_verified,
      status,
      approval_status,
      payout_status,
      requested_by,
      idempotency_key,
      metadata
    ) values (
      v_order.id,
      p_refund_id,
      v_supp_number,
      case when v_shortfall = v_available and v_pending_total = 0 then 'full' else 'partial' end,
      case when v_shortfall = v_available and v_pending_total = 0 then 'full_refund' else 'partial_refund' end,
      p_supplemental_method,
      p_supplemental_method,
      v_shortfall,
      'Refund tambahan (koreksi under_refund ' || v_refund.refund_number || '): ' || pg_catalog.btrim(p_reason),
      v_refund.reason_category,
      'Koreksi kekurangan refund oleh Admin: ' || pg_catalog.btrim(p_reason),
      true,
      'pending',
      'pending_approval',
      'not_required',
      v_user_id,
      pg_catalog.btrim(p_idempotency_key) || '_supp',
      pg_catalog.jsonb_build_object('correction_parent_refund_id', p_refund_id)
    )
    returning id into v_supp_id;

    v_supp_res := public.execute_refund_approval_internal(
      v_supp_id,
      v_user_id,
      v_user_role,
      null,
      p_shift_id,
      'Pencairan tambahan dari koreksi under_refund'
    );
  end if;

  insert into public.refund_corrections (
    refund_id,
    expected_amount,
    actual_amount,
    difference_amount,
    correction_type,
    supplemental_refund_id,
    follow_up_status,
    follow_up_notes,
    reason,
    idempotency_key,
    created_by
  ) values (
    p_refund_id,
    p_expected_amount,
    p_actual_amount,
    v_diff,
    v_type,
    v_supp_id,
    case when v_type = 'under_refund' and v_supp_id is not null then 'resolved' else 'open' end,
    nullif(pg_catalog.btrim(coalesce(p_follow_up_notes, '')), ''),
    pg_catalog.btrim(p_reason),
    pg_catalog.btrim(p_idempotency_key),
    v_user_id
  )
  returning id into v_corr_id;

  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'order.refund_corrected',
    v_user_id,
    'refund_correction',
    v_corr_id::text,
    pg_catalog.jsonb_build_object(
      'correction_id', v_corr_id,
      'refund_id', p_refund_id,
      'refund_number', v_refund.refund_number,
      'order_id', v_order.id,
      'correction_type', v_type,
      'expected_amount', p_expected_amount,
      'actual_amount', p_actual_amount,
      'difference_amount', v_diff,
      'supplemental_refund_id', v_supp_id,
      'reason', pg_catalog.btrim(p_reason)
    )
  );

  return pg_catalog.jsonb_build_object(
    'correction_id', v_corr_id,
    'refund_id', p_refund_id,
    'correction_type', v_type,
    'expected_amount', p_expected_amount,
    'actual_amount', p_actual_amount,
    'difference_amount', v_diff,
    'supplemental_refund_id', v_supp_id,
    'supplemental_refund_number', v_supp_number,
    'is_duplicate', false
  );
end;
$$;

revoke all on function public.record_refund_correction_atomic(uuid, integer, integer, text, boolean, text, uuid, text, text) from public, anon;
grant execute on function public.record_refund_correction_atomic(uuid, integer, integer, text, boolean, text, uuid, text, text) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 11. BACKWARD COMPATIBILITY: PERBARUI process_order_refund_atomic (F2.4 / F5)
-- Signature 8-argumen tetap identik agar alur lama & tes regresi F2.4/F5 utuh,
-- sambil mengisi kolom baru R1 & mendukung get_order_pending_refund_amount_internal.
-- -----------------------------------------------------------------------------
create or replace function public.process_order_refund_atomic(
  p_order_id uuid,
  p_amount integer,
  p_refund_type text,
  p_refund_method text,
  p_reason text,
  p_payment_id uuid default null,
  p_idempotency_key text default null,
  p_shift_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_user_role text;
  v_pre_order record;
  v_order record;
  v_payment record;
  v_existing_refund record;
  v_pending_refund_total integer := 0;
  v_committed_refund_total integer := 0;
  v_available_refundable integer := 0;
  v_payment_refunded_so_far integer := 0;
  v_payment_remaining integer := 0;
  v_payment_completed_after integer := 0;
  v_is_full_refund boolean := false;
  v_new_refunded_total integer;
  v_new_order_status text;
  v_new_payment_status text;
  v_kds_status_after text;
  v_kitchen_notified_at timestamptz := null;
  v_refund_number text;
  v_refund_id uuid;
  v_shift record;
  v_target_shift_id uuid := null;
  v_balance_before integer := 0;
  v_balance_after integer := 0;
  v_now timestamptz := pg_catalog.now();
begin
  v_user_id := auth.uid();
  v_user_role := public.current_user_role();

  if v_user_id is null or coalesce(v_user_role, '') <> 'admin' then
    raise exception 'Hanya admin yang berhak memproses pengembalian dana (refund).';
  end if;

  if p_order_id is null then
    raise exception 'ID pesanan wajib diisi.';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Nominal refund harus lebih dari Rp 0.';
  end if;

  if p_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 3 then
    raise exception 'Alasan refund wajib diisi (minimal 3 karakter).';
  end if;

  if p_refund_type not in ('full', 'partial') then
    raise exception 'Tipe refund tidak valid: % (harus full atau partial).', p_refund_type;
  end if;

  if p_refund_method not in ('cash', 'transfer', 'midtrans', 'manual') then
    raise exception 'Metode refund tidak valid: %.', p_refund_method;
  end if;

  if p_idempotency_key is null or pg_catalog.char_length(pg_catalog.btrim(p_idempotency_key)) = 0 then
    raise exception 'Kunci idempotensi (idempotency key) wajib disertakan pada setiap mutasi refund.';
  end if;

  select * into v_existing_refund from public.refunds where idempotency_key = pg_catalog.btrim(p_idempotency_key);
  if found then
    if v_existing_refund.order_id <> p_order_id
       or coalesce(v_existing_refund.payment_id, '00000000-0000-0000-0000-000000000000'::uuid) <> coalesce(p_payment_id, '00000000-0000-0000-0000-000000000000'::uuid)
       or v_existing_refund.amount <> p_amount
       or v_existing_refund.refund_type <> p_refund_type
       or v_existing_refund.refund_method <> p_refund_method
       or pg_catalog.btrim(v_existing_refund.reason) <> pg_catalog.btrim(p_reason) then
      raise exception 'Konflik Idempotensi: Kunci "%" telah digunakan sebelumnya dengan rincian data refund yang berbeda.',
        pg_catalog.btrim(p_idempotency_key);
    end if;

    return pg_catalog.jsonb_build_object(
      'refund_id', v_existing_refund.id,
      'refund_number', v_existing_refund.refund_number,
      'order_id', v_existing_refund.order_id,
      'payment_id', v_existing_refund.payment_id,
      'amount', v_existing_refund.amount,
      'refund_type', v_existing_refund.refund_type,
      'refund_method', v_existing_refund.refund_method,
      'status', v_existing_refund.status,
      'is_duplicate', true,
      'message', 'Permintaan refund telah diproses sebelumnya (idempotent replay).'
    );
  end if;

  select id, order_number, order_type, order_kind, table_id, dining_session_id, status, payment_status, kds_status, paid_total, refunded_total
  into v_pre_order
  from public.orders where id = p_order_id;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  if v_pre_order.order_type = 'dine_in' and coalesce(v_pre_order.order_kind, 'standard') = 'standard' then
    if v_pre_order.table_id is not null then
      perform 1 from public.dining_tables where id = v_pre_order.table_id for update;
    end if;
    if v_pre_order.dining_session_id is not null then
      perform 1 from public.dining_sessions where id = v_pre_order.dining_session_id for update;
    end if;
  end if;

  select * into v_order from public.orders where id = p_order_id for update;

  select * into v_existing_refund from public.refunds where idempotency_key = pg_catalog.btrim(p_idempotency_key);
  if found then
    if v_existing_refund.order_id <> p_order_id
       or coalesce(v_existing_refund.payment_id, '00000000-0000-0000-0000-000000000000'::uuid) <> coalesce(p_payment_id, '00000000-0000-0000-0000-000000000000'::uuid)
       or v_existing_refund.amount <> p_amount
       or v_existing_refund.refund_type <> p_refund_type
       or v_existing_refund.refund_method <> p_refund_method
       or pg_catalog.btrim(v_existing_refund.reason) <> pg_catalog.btrim(p_reason) then
      raise exception 'Konflik Idempotensi: Kunci "%" telah digunakan sebelumnya dengan rincian data refund yang berbeda.',
        pg_catalog.btrim(p_idempotency_key);
    end if;

    return pg_catalog.jsonb_build_object(
      'refund_id', v_existing_refund.id,
      'refund_number', v_existing_refund.refund_number,
      'order_id', v_existing_refund.order_id,
      'payment_id', v_existing_refund.payment_id,
      'amount', v_existing_refund.amount,
      'refund_type', v_existing_refund.refund_type,
      'refund_method', v_existing_refund.refund_method,
      'status', v_existing_refund.status,
      'is_duplicate', true,
      'message', 'Permintaan refund telah diproses sebelumnya (idempotent replay).'
    );
  end if;

  perform 1 from public.order_allocations where order_id = p_order_id order by id asc for update;
  perform 1 from public.midtrans_transactions where order_id = p_order_id order by id asc for update;
  perform 1 from public.payments where order_id = p_order_id order by id asc for update;
  perform 1 from public.refunds where order_id = p_order_id order by id asc for update;

  if v_order.status = 'cancelled' then
    raise exception 'Pesanan sudah dibatalkan dan tidak dapat direfund.';
  end if;

  if v_order.status = 'refunded' then
    raise exception 'Pesanan sudah direfund penuh sebelumnya.';
  end if;

  if coalesce(v_order.paid_total, 0) <= 0 then
    raise exception 'Pesanan belum memiliki riwayat pembayaran yang berhasil (paid_total = Rp 0).';
  end if;

  v_committed_refund_total := coalesce(v_order.refunded_total, 0);
  v_pending_refund_total := public.get_order_pending_refund_amount_internal(p_order_id);
  v_available_refundable := coalesce(v_order.paid_total, 0) - (v_committed_refund_total + v_pending_refund_total);

  if v_available_refundable <= 0 then
    if v_pending_refund_total > 0 then
      raise exception 'Pesanan tidak memiliki saldo pembayaran yang dapat dikembalikan. Seluruh saldo sisa (Rp %) sedang dicadangkan oleh permintaan refund pending.',
        v_pending_refund_total;
    else
      raise exception 'Pesanan tidak memiliki saldo pembayaran yang dapat dikembalikan.';
    end if;
  end if;

  if p_amount > v_available_refundable then
    raise exception 'Nominal refund (Rp %) melebihi sisa dana yang dapat dikembalikan (Rp %). Pembayaran: Rp %, Sukses Refund: Rp %, Pending Refund: Rp %.',
      p_amount, v_available_refundable, v_order.paid_total, v_committed_refund_total, v_pending_refund_total;
  end if;

  if p_payment_id is not null then
    select * into v_payment from public.payments where id = p_payment_id and order_id = p_order_id;
    if not found then
      raise exception 'Baris pembayaran spesifik tidak ditemukan pada pesanan ini.';
    end if;
    if v_payment.payment_status <> 'success' then
      raise exception 'Hanya baris pembayaran berstatus success yang dapat direfund.';
    end if;

    select
      coalesce((
        select sum(r2.amount)
        from public.refunds r2
        where r2.payment_id = p_payment_id
          and r2.status in ('completed', 'pending')
          and r2.approval_status not in ('rejected', 'cancelled')
          and not exists (select 1 from public.refund_payout_allocations ax where ax.refund_id = r2.id)
      ), 0)
      + coalesce((
        select sum(a.amount)
        from public.refund_payout_allocations a
        join public.refunds r2 on r2.id = a.refund_id
        where a.payment_id = p_payment_id
          and a.payout_status in ('pending', 'processing', 'completed', 'reconciliation_required')
          and r2.approval_status not in ('rejected', 'cancelled')
      ), 0)
    into v_payment_refunded_so_far;

    v_payment_remaining := v_payment.amount - v_payment_refunded_so_far;
    if v_payment_remaining <= 0 or p_amount > v_payment_remaining then
      raise exception 'Nominal refund melebihi sisa refundable baris pembayaran ini (Rp %).', greatest(0, v_payment_remaining);
    end if;
  end if;

  v_is_full_refund := (p_amount = v_available_refundable and v_pending_refund_total = 0);

  if p_refund_type = 'full' and not v_is_full_refund then
    raise exception 'Tipe refund full dipilih tetapi nominal (Rp %) tidak mencakup seluruh sisa dana (Rp %).',
      p_amount, v_available_refundable;
  end if;

  if p_refund_type = 'partial' and v_is_full_refund then
    raise exception 'Nominal mencakup seluruh sisa dana; gunakan tipe refund full.';
  end if;

  if p_refund_method = 'midtrans' then
    v_refund_number := public.generate_refund_number();

    insert into public.refunds (
      order_id, payment_id, refund_number, refund_type, resolution_type, refund_method, payout_method,
      amount, reason, status, approval_status, payout_status,
      requested_by, approved_by, approved_at, reviewed_by, reviewed_at,
      kitchen_notified_at, idempotency_key, metadata
    ) values (
      p_order_id, p_payment_id, v_refund_number, p_refund_type,
      case when p_refund_type = 'full' then 'full_refund' else 'partial_refund' end,
      p_refund_method, p_refund_method,
      p_amount, pg_catalog.btrim(p_reason), 'pending', 'approved', 'pending',
      v_user_id, null, null, v_user_id, v_now,
      null, pg_catalog.btrim(p_idempotency_key),
      pg_catalog.jsonb_build_object(
        'previous_order_status', v_order.status,
        'previous_payment_status', v_order.payment_status,
        'previous_kds_status', v_order.kds_status,
        'is_full_refund', v_is_full_refund,
        'requested_by_role', v_user_role,
        'verification_mode', 'server_side_midtrans'
      )
    ) returning id into v_refund_id;

    insert into public.audit_logs (action, user_id, entity, entity_id, details)
    values (
      'order.refund_requested', v_user_id, 'order', p_order_id::text,
      pg_catalog.jsonb_build_object(
        'refund_id', v_refund_id, 'refund_number', v_refund_number,
        'refund_type', p_refund_type, 'refund_method', p_refund_method,
        'amount', p_amount, 'reason', pg_catalog.btrim(p_reason), 'status', 'pending', 'gateway_verification_required', true
      )
    );

    return pg_catalog.jsonb_build_object(
      'refund_id', v_refund_id, 'refund_number', v_refund_number, 'order_id', p_order_id,
      'order_number', v_order.order_number, 'payment_id', p_payment_id, 'amount', p_amount,
      'refund_type', p_refund_type, 'refund_method', p_refund_method, 'status', 'pending',
      'is_duplicate', false,
      'message', 'Permintaan refund Midtrans dicatat sebagai pending. Memerlukan verifikasi server-side sebelum dana dieksekusi.'
    );
  end if;

  if v_is_full_refund then
    if v_order.status in ('paid', 'completed') then
      v_new_order_status := 'refunded';
      v_new_payment_status := 'refunded';
    elsif v_order.status in ('awaiting_payment', 'partially_paid') then
      v_new_order_status := 'cancelled';
      v_new_payment_status := 'refunded';
    else
      v_new_order_status := 'refunded';
      v_new_payment_status := 'refunded';
    end if;

    if v_order.kds_status in ('queued', 'preparing', 'ready') then
      v_kds_status_after := null;
      v_kitchen_notified_at := v_now;
    else
      v_kds_status_after := null;
      v_kitchen_notified_at := null;
    end if;

    update public.payments
    set payment_status = 'refunded', updated_at = v_now
    where order_id = p_order_id and payment_status = 'success';
  else
    v_new_order_status := v_order.status;
    v_new_payment_status := 'partially_refunded';
    v_kds_status_after := v_order.kds_status;
    v_kitchen_notified_at := null;

    if p_payment_id is not null then
      select coalesce(sum(amount), 0)::integer into v_payment_completed_after
      from public.refunds where payment_id = p_payment_id and status = 'completed';

      if (v_payment_completed_after + p_amount) >= v_payment.amount then
        update public.payments set payment_status = 'refunded', updated_at = v_now where id = p_payment_id;
      end if;
    end if;
  end if;

  v_new_refunded_total := v_committed_refund_total + p_amount;
  v_refund_id := pg_catalog.gen_random_uuid();
  v_refund_number := public.generate_refund_number();

  if p_refund_method = 'cash' then
    if p_shift_id is not null then
      select id, expected_cash, status, cashier_id into v_shift from public.shifts where id = p_shift_id for update;
      if not found then
        raise exception 'Shift kasir dengan ID % tidak ditemukan.', p_shift_id;
      end if;
      if v_shift.status <> 'open' then
        raise exception 'Shift kasir % sudah ditutup. Tidak dapat mengeluarkan refund dari shift tertutup.', p_shift_id;
      end if;
      if v_shift.expected_cash < p_amount then
        raise exception 'Saldo kas shift tidak mencukupi untuk refund tunai (Tersedia: Rp %, Diminta: Rp %).',
          v_shift.expected_cash, p_amount;
      end if;
      v_target_shift_id := v_shift.id;
      v_balance_before := v_shift.expected_cash;
      v_balance_after := v_balance_before - p_amount;
      update public.shifts set expected_cash = v_balance_after, updated_at = v_now where id = v_target_shift_id;
    else
      select id, expected_cash, status into v_shift
      from public.shifts where cashier_id = v_user_id and status = 'open' for update;
      if found then
        if v_shift.expected_cash < p_amount then
          raise exception 'Saldo kas shift tidak mencukupi untuk refund tunai (Tersedia: Rp %, Diminta: Rp %).',
            v_shift.expected_cash, p_amount;
        end if;
        v_target_shift_id := v_shift.id;
        v_balance_before := v_shift.expected_cash;
        v_balance_after := v_balance_before - p_amount;
        update public.shifts set expected_cash = v_balance_after, updated_at = v_now where id = v_target_shift_id;
      else
        v_target_shift_id := null;
        v_balance_before := 0;
        v_balance_after := 0;
      end if;
    end if;
  end if;

  insert into public.refunds (
    id, order_id, payment_id, refund_number, refund_type, resolution_type, refund_method, payout_method,
    amount, reason, status, approval_status, payout_status,
    requested_by, approved_by, approved_at, reviewed_by, reviewed_at, payout_completed_at, shift_id,
    kitchen_notified_at, idempotency_key, metadata
  ) values (
    v_refund_id, p_order_id, p_payment_id, v_refund_number, p_refund_type,
    case when p_refund_type = 'full' then 'full_refund' else 'partial_refund' end,
    p_refund_method, p_refund_method,
    p_amount, pg_catalog.btrim(p_reason), 'completed', 'approved', 'completed',
    v_user_id, v_user_id, v_now, v_user_id, v_now, v_now, v_target_shift_id,
    v_kitchen_notified_at, pg_catalog.btrim(p_idempotency_key),
    pg_catalog.jsonb_build_object(
      'shift_id', v_target_shift_id, 'is_out_of_shift', (v_target_shift_id is null),
      'previous_order_status', v_order.status, 'previous_payment_status', v_order.payment_status,
      'previous_kds_status', v_order.kds_status, 'is_full_refund', v_is_full_refund, 'refunded_by_role', v_user_role
    )
  );

  if p_refund_method = 'cash' then
    insert into public.cash_movements (
      shift_id, movement_type, amount, balance_before, balance_after, reason, order_id, payment_id, refund_id, created_by
    ) values (
      v_target_shift_id, 'cash_refund', p_amount, v_balance_before, v_balance_after,
      case when v_target_shift_id is not null then 'Refund tunai pesanan ' || v_order.order_number || ': ' || pg_catalog.btrim(p_reason)
           else 'Refund tunai di luar shift (Admin): ' || pg_catalog.btrim(p_reason) end,
      p_order_id, p_payment_id, v_refund_id, v_user_id
    );
  end if;

  update public.orders
  set
    refunded_total = v_new_refunded_total, status = v_new_order_status, payment_status = v_new_payment_status,
    kds_status = v_kds_status_after,
    cancelled_by = case when v_is_full_refund then v_user_id else cancelled_by end,
    cancelled_at = case when v_is_full_refund then v_now else cancelled_at end,
    cancel_reason = case when v_is_full_refund then pg_catalog.btrim(p_reason) else cancel_reason end,
    updated_at = v_now
  where id = p_order_id;

  if v_order.order_type = 'dine_in' and v_order.table_id is not null and v_order.dining_session_id is not null then
    perform public.sync_dining_table_status_internal(v_order.table_id, v_order.dining_session_id, v_user_id);
  end if;

  insert into public.audit_logs (action, user_id, entity, entity_id, details)
  values (
    'order.refunded', v_user_id, 'order', p_order_id::text,
    pg_catalog.jsonb_build_object(
      'refund_id', v_refund_id, 'refund_number', v_refund_number,
      'refund_type', p_refund_type, 'refund_method', p_refund_method,
      'amount', p_amount, 'reason', pg_catalog.btrim(p_reason), 'shift_id', v_target_shift_id,
      'is_out_of_shift', (v_target_shift_id is null),
      'previous_order_status', v_order.status, 'new_order_status', v_new_order_status,
      'new_payment_status', v_new_payment_status, 'is_full_refund', v_is_full_refund,
      'kitchen_notified', (v_kitchen_notified_at is not null)
    )
  );

  return pg_catalog.jsonb_build_object(
    'refund_id', v_refund_id, 'refund_number', v_refund_number, 'order_id', p_order_id,
    'order_number', v_order.order_number, 'payment_id', p_payment_id, 'amount', p_amount,
    'refund_type', p_refund_type, 'refund_method', p_refund_method, 'status', 'completed',
    'new_order_status', v_new_order_status, 'new_payment_status', v_new_payment_status,
    'refunded_total', v_new_refunded_total, 'shift_id', v_target_shift_id,
    'kitchen_notified', (v_kitchen_notified_at is not null), 'is_duplicate', false
  );
end;
$$;

revoke all on function public.process_order_refund_atomic(uuid, integer, text, text, text, uuid, text, uuid) from public, anon;
grant execute on function public.process_order_refund_atomic(uuid, integer, text, text, text, uuid, text, uuid) to authenticated, service_role;

commit;
