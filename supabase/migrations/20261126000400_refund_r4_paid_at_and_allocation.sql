-- =============================================================================
-- NINE LICIOUS POS — REFUND SYSTEM MIGRATION R4: PAID_AT, ALLOCATION & SESSION
-- File: supabase/migrations/20261126000400_refund_r4_paid_at_and_allocation.sql
--
-- PRASYARAT: Migrations R1, R2, R3 sudah dijalankan.
--
-- TUJUAN:
-- 1. Menambahkan orders.paid_at + backfill transaksi lama (termasuk pembayaran
--    berstatus 'success' maupun 'refunded') tanpa mengisi pesanan belum lunas.
-- 2. Memperbarui execute_order_payment_internal (11-arg, SET search_path = '')
--    untuk mengisi paid_at saat transaksi lunas.
-- 3. Menyediakan calculate_refund_breakdown_internal (SET search_path = '')
--    dengan aturan bisnis final:
--    - Kompensasi 25% & 50% dihitung HANYA dari nilai bersih item setelah alokasi
--      diskon (tanpa mengembalikan service charge & pajak), namun tetap menyimpan
--      reference_service_charge_amount & reference_tax_amount untuk pembukuan.
--    - Pembatalan item 100% mengembalikan komponen penuh secara proporsional.
--    - Mendukung pengajuan ulang pada item yang pernah menerima 25% / 50% memakai
--      cumulative refunded amount per order_item_id, sekaligus menolak item yang
--      sudah mencapai 100%.
-- 4. Memperbarui get_order_receipt_data, get_dining_session_summary, dan
--    close_dining_session_atomic (SET search_path = ''):
--    - approval_status = 'pending_approval' TIDAK menghalangi penutupan meja.
--    - Hanya payout gateway Midtrans aktif yang disetujui yang menahan sesi.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. KOLOM orders.paid_at & INDEKS
-- -----------------------------------------------------------------------------
alter table public.orders
  add column if not exists paid_at timestamptz;

comment on column public.orders.paid_at is
  'Timestamp server ketika pesanan resmi menjadi LUNAS (paid_total >= grand_total). Menjadi acuan batas waktu pengajuan refund 24 jam.';

create index if not exists orders_paid_at_idx
  on public.orders (paid_at desc)
  where (paid_at is not null);


-- -----------------------------------------------------------------------------
-- 2. BACKFILL NON-DESTRUKTIF orders.paid_at PADA TRANSAKSI LAMA
-- Mencakup payments berstatus 'success' DAN 'refunded' karena proses full refund
-- F2.4 mengubah payment_status pada payments dari 'success' menjadi 'refunded'.
-- -----------------------------------------------------------------------------
with last_payment_ts as (
  select
    p.order_id,
    max(p.created_at) as last_paid_ts
  from public.payments p
  where p.payment_status in ('success', 'refunded')
  group by p.order_id
),
last_midtrans_ts as (
  select
    mt.order_id,
    max(mt.settled_at) as last_settled_ts
  from public.midtrans_transactions mt
  where mt.lifecycle_status = 'settled'
    and mt.settled_at is not null
  group by mt.order_id
)
update public.orders o
set paid_at = coalesce(
  lp.last_paid_ts,
  lm.last_settled_ts,
  case
    when o.status in ('paid', 'completed', 'refunded')
     and coalesce(o.paid_total, 0) >= coalesce(o.grand_total, 0)
    then coalesce(o.updated_at, o.created_at)
    else null
  end
)
from last_payment_ts lp
full outer join last_midtrans_ts lm on lm.order_id = lp.order_id
where o.id = coalesce(lp.order_id, lm.order_id)
  and o.paid_at is null
  and coalesce(o.order_kind, 'standard') = 'standard'
  and (
    o.payment_status in ('paid', 'partially_refunded', 'refunded')
    or o.status in ('paid', 'completed', 'refunded')
  );

update public.orders o
set paid_at = coalesce(o.updated_at, o.created_at)
where o.paid_at is null
  and coalesce(o.order_kind, 'standard') = 'standard'
  and o.status in ('paid', 'completed', 'refunded')
  and o.payment_status in ('paid', 'partially_refunded', 'refunded')
  and coalesce(o.paid_total, 0) >= coalesce(o.grand_total, 0);


-- -----------------------------------------------------------------------------
-- 3. PEMBARUAN execute_order_payment_internal (11-ARGUMEN, SET search_path = '')
-- -----------------------------------------------------------------------------
create or replace function public.execute_order_payment_internal(
  p_order_id uuid,
  p_payment_method text,
  p_payment_source text,
  p_amount integer,
  p_cash_received integer,
  p_change_amount integer,
  p_reference_number text,
  p_idempotency_key text,
  p_notes text,
  p_actor_id uuid,
  p_shift_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clean_key text;
  v_clean_ref text;
  v_clean_notes text;
  v_clean_change integer;

  v_pre_order record;
  v_order record;

  v_dining_table record;
  v_dining_session record;

  v_existing_payment record;

  v_remaining integer;
  v_new_paid_total integer;

  v_is_settled boolean := false;

  v_queue_date date;
  v_queue_number text;

  v_payment_id uuid;
  v_sync_result text;

  v_shift_expected integer;
  v_now timestamptz := pg_catalog.now();
begin
  if p_order_id is null then
    raise exception 'ID pesanan wajib diisi.';
  end if;

  if p_actor_id is null then
    raise exception 'Identitas petugas pembayaran tidak valid.';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Nominal pembayaran harus lebih besar dari 0.';
  end if;

  if p_idempotency_key is null or pg_catalog.btrim(p_idempotency_key) = '' then
    raise exception 'Kunci idempotensi pembayaran wajib diisi.';
  end if;

  v_clean_key := pg_catalog.btrim(p_idempotency_key);
  if pg_catalog.length(v_clean_key) < 8 then
    raise exception 'Kunci idempotensi minimal 8 karakter.';
  end if;

  v_clean_ref := nullif(pg_catalog.btrim(p_reference_number), '');
  v_clean_notes := nullif(pg_catalog.btrim(p_notes), '');
  v_clean_change := coalesce(p_change_amount, 0);

  if (p_payment_method = 'cash' and p_payment_source <> 'cash')
     or (
       p_payment_method = 'qris'
       and p_payment_source not in ('qris_manual', 'qris_midtrans')
     )
     or (
       p_payment_method = 'bank_transfer'
       and p_payment_source <> 'bank_transfer'
     )
     or (
       p_payment_method = 'midtrans'
       and p_payment_source <> 'midtrans_snap'
     ) then
    raise exception
      'Kombinasi metode % dan sumber pembayaran % tidak valid.',
      p_payment_method,
      p_payment_source;
  end if;

  if p_payment_source = 'cash' then
    if p_cash_received is null or p_cash_received < p_amount then
      raise exception 'Uang tunai yang diterima kurang dari nominal pembayaran.';
    end if;

    if v_clean_change <> (p_cash_received - p_amount) then
      raise exception 'Perhitungan kembalian tunai tidak valid.';
    end if;
  else
    if p_cash_received is not null or v_clean_change <> 0 then
      raise exception 'Pembayaran non-tunai tidak boleh memiliki uang diterima atau kembalian.';
    end if;
  end if;

  select id, order_type, table_id, dining_session_id
  into v_pre_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception 'Pesanan dengan ID % tidak ditemukan.', p_order_id;
  end if;

  if v_pre_order.order_type = 'dine_in' then
    if v_pre_order.table_id is null or v_pre_order.dining_session_id is null then
      raise exception 'Relasi meja atau sesi pesanan dine-in tidak valid.';
    end if;

    perform 1
    from public.dining_tables
    where id = v_pre_order.table_id
    for update;

    perform 1
    from public.dining_sessions
    where id = v_pre_order.dining_session_id
    for update;
  end if;

  select *
  into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  if v_order.order_type is distinct from v_pre_order.order_type
     or v_order.table_id is distinct from v_pre_order.table_id
     or v_order.dining_session_id is distinct from v_pre_order.dining_session_id then
    raise exception 'Relasi pesanan berubah saat penguncian. Silakan coba kembali.';
  end if;

  select *
  into v_existing_payment
  from public.payments
  where idempotency_key = v_clean_key;

  if found then
    if v_existing_payment.order_id <> p_order_id then
      raise exception 'Idempotency key sudah digunakan untuk pesanan lain.';
    end if;

    if v_existing_payment.payment_method <> p_payment_method
       or v_existing_payment.payment_source <> p_payment_source
       or v_existing_payment.amount <> p_amount
       or coalesce(v_existing_payment.cash_received, 0) <> coalesce(p_cash_received, 0)
       or coalesce(v_existing_payment.change_amount, 0) <> v_clean_change
       or coalesce(v_existing_payment.reference_number, '') <> coalesce(v_clean_ref, '')
       or coalesce(v_existing_payment.notes, '') <> coalesce(v_clean_notes, '') then
      raise exception 'Idempotency key digunakan dengan payload berbeda.';
    end if;

    return pg_catalog.jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'order_id', v_existing_payment.order_id,
      'order_number', v_order.order_number,
      'amount', v_existing_payment.amount,
      'cash_received', v_existing_payment.cash_received,
      'change_amount', v_existing_payment.change_amount,
      'payment_status', v_existing_payment.payment_status,
      'paid_total', coalesce(v_existing_payment.paid_total_after, v_order.paid_total),
      'grand_total', v_order.grand_total,
      'is_settled', (coalesce(v_existing_payment.paid_total_after, v_order.paid_total) = v_order.grand_total),
      'queue_number',
        case
          when coalesce(v_existing_payment.paid_total_after, v_order.paid_total) = v_order.grand_total
          then v_order.queue_number
          else null
        end,
      'queue_date',
        case
          when coalesce(v_existing_payment.paid_total_after, v_order.paid_total) = v_order.grand_total
          then v_order.queue_date
          else null
        end,
      'idempotent_replay', true
    );
  end if;

  if v_order.order_type = 'dine_in' then
    select * into v_dining_table
    from public.dining_tables
    where id = v_order.table_id;

    if not found or not v_dining_table.is_active then
      raise exception 'Meja pesanan tidak ditemukan atau tidak aktif.';
    end if;

    select * into v_dining_session
    from public.dining_sessions
    where id = v_order.dining_session_id;

    if not found or v_dining_session.status <> 'open' then
      raise exception 'Sesi kunjungan tidak ditemukan atau sudah tidak aktif.';
    end if;

    if v_dining_session.table_id <> v_order.table_id then
      raise exception 'Meja sesi tidak sesuai dengan meja pesanan.';
    end if;
  end if;

  if coalesce(v_order.order_kind, 'standard') <> 'standard' then
    raise exception 'Pesanan pengganti (replacement) tidak menerima pembayaran.';
  end if;

  if not v_order.is_finalized then
    raise exception 'Pesanan belum difinalisasi.';
  end if;

  if v_order.status not in ('awaiting_payment', 'partially_paid') then
    raise exception 'Status pesanan tidak mengizinkan pembayaran.';
  end if;

  if v_order.payment_status not in ('unpaid', 'partially_paid') then
    raise exception 'Status pembayaran tidak mengizinkan pembayaran baru.';
  end if;

  if v_order.grand_total is null or v_order.grand_total <= 0 then
    raise exception 'Total tagihan tidak valid.';
  end if;

  v_remaining := v_order.grand_total - v_order.paid_total;
  if v_remaining <= 0 then
    raise exception 'Sisa tagihan tidak valid.';
  end if;

  if p_amount > v_remaining then
    raise exception 'Nominal pembayaran melebihi sisa tagihan.';
  end if;

  if p_payment_source = 'cash' then
    if p_shift_id is null then
      raise exception 'Pembayaran tunai wajib terhubung ke shift kasir yang aktif.';
    end if;

    select expected_cash
    into v_shift_expected
    from public.shifts
    where id = p_shift_id
      and status = 'open'
    for update;

    if not found then
      raise exception 'Shift kasir aktif tidak ditemukan atau sudah ditutup.';
    end if;
  end if;

  v_new_paid_total := v_order.paid_total + p_amount;
  v_is_settled := (v_new_paid_total = v_order.grand_total);

  begin
    insert into public.payments (
      order_id,
      payment_method,
      payment_source,
      amount,
      cash_received,
      change_amount,
      reference_number,
      payment_status,
      idempotency_key,
      notes,
      paid_total_after,
      created_by,
      shift_id
    )
    values (
      p_order_id,
      p_payment_method,
      p_payment_source,
      p_amount,
      p_cash_received,
      v_clean_change,
      v_clean_ref,
      'success',
      v_clean_key,
      v_clean_notes,
      v_new_paid_total,
      p_actor_id,
      p_shift_id
    )
    returning id into v_payment_id;

  exception
    when unique_violation then
      select *
      into v_existing_payment
      from public.payments
      where idempotency_key = v_clean_key;

      if found then
        if v_existing_payment.order_id <> p_order_id then
          raise exception 'Idempotency key sudah digunakan untuk pesanan lain.';
        end if;
        raise exception 'Idempotency key sedang diproses transaksi lain.';
      end if;
      raise;
  end;

  if p_payment_source = 'cash' then
    update public.shifts
    set
      expected_cash = expected_cash + p_amount,
      updated_at = v_now
    where id = p_shift_id;

    insert into public.cash_movements (
      shift_id,
      movement_type,
      amount,
      balance_before,
      balance_after,
      reason,
      order_id,
      payment_id,
      created_by
    ) values (
      p_shift_id,
      'cash_sale',
      p_amount,
      v_shift_expected,
      v_shift_expected + p_amount,
      'Penjualan tunai pesanan ' || v_order.order_number,
      p_order_id,
      v_payment_id,
      p_actor_id
    );

    insert into public.audit_logs (
      user_id,
      action,
      entity,
      entity_id,
      details
    ) values (
      p_actor_id,
      'cash.sale',
      'shift',
      p_shift_id::text,
      pg_catalog.jsonb_build_object(
        'order_id', p_order_id,
        'order_number', v_order.order_number,
        'payment_id', v_payment_id,
        'amount', p_amount,
        'shift_id', p_shift_id
      )
    );
  end if;

  if v_is_settled then
    v_queue_date := (v_now at time zone 'Asia/Jakarta')::date;
    v_queue_number := public.generate_queue_number(v_queue_date);

    update public.orders
    set
      paid_total = v_new_paid_total,
      status = 'paid',
      payment_status = 'paid',
      kds_status = 'queued',
      queue_date = v_queue_date,
      queue_number = v_queue_number,
      paid_at = coalesce(paid_at, v_now),
      updated_at = v_now
    where id = p_order_id;

    if v_order.order_type = 'dine_in' then
      select public.sync_dining_table_status_internal(
        v_order.table_id,
        v_order.dining_session_id,
        p_actor_id
      ) into v_sync_result;
    end if;

  else
    update public.orders
    set
      paid_total = v_new_paid_total,
      status = 'partially_paid',
      payment_status = 'partially_paid',
      updated_at = v_now
    where id = p_order_id;
  end if;

  insert into public.audit_logs (
    user_id,
    action,
    entity,
    entity_id,
    details
  )
  values (
    p_actor_id,
    case when v_is_settled then 'payment.settled' else 'payment.partial' end,
    'payments',
    v_payment_id::text,
    pg_catalog.jsonb_build_object(
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'payment_method', p_payment_method,
      'payment_source', p_payment_source,
      'amount', p_amount,
      'cash_received', p_cash_received,
      'change_amount', v_clean_change,
      'paid_total', v_new_paid_total,
      'grand_total', v_order.grand_total,
      'is_settled', v_is_settled,
      'queue_number', v_queue_number,
      'shift_id', p_shift_id
    )
  );

  return pg_catalog.jsonb_build_object(
    'payment_id', v_payment_id,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'amount', p_amount,
    'cash_received', p_cash_received,
    'change_amount', v_clean_change,
    'payment_status', 'success',
    'paid_total', v_new_paid_total,
    'grand_total', v_order.grand_total,
    'is_settled', v_is_settled,
    'queue_number', v_queue_number,
    'queue_date', v_queue_date,
    'shift_id', p_shift_id,
    'idempotent_replay', false
  );
end;
$$;

revoke all
  on function public.execute_order_payment_internal(uuid, text, text, integer, integer, integer, text, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute
  on function public.execute_order_payment_internal(uuid, text, text, integer, integer, integer, text, text, text, uuid, uuid)
  to service_role;


-- -----------------------------------------------------------------------------
-- 4. HELPER KALKULASI OTOMATIS: calculate_refund_breakdown_internal (SET search_path = '')
-- Mengimplementasikan Final Business Rules A.2 & A.3:
-- - Baseline per order_item dihitung proporsional terhadap seluruh pesanan agar
--   bebas rounding drift.
-- - Kompensasi 25% & 50% hanya dihitung dari nilai bersih item setelah alokasi
--   diskon (tanpa mengembalikan service charge & pajak), namun tetap mencatat
--   reference_service_charge_amount & reference_tax_amount untuk pembukuan.
-- - Pembatalan 100% mengembalikan sisa DPP + proporsi service charge & pajak.
-- - Pengajuan ulang item 25%/50% dibatasi cumulative refunded amount & menolak
--   item yang sudah mencapai 100%.
-- -----------------------------------------------------------------------------
create or replace function public.calculate_refund_breakdown_internal(
  p_order_id uuid,
  p_items jsonb,
  p_resolution_type text,
  p_reason_category text,
  p_duplicate_payment_amount integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order record;
  v_order_net_line_total integer := 0;
  v_order_non_product_discount integer := 0;
  v_committed_refund_total integer := 0;
  v_pending_refund_total integer := 0;
  v_available_refundable integer := 0;

  -- Pemetaan baseline per order_item_id agar total komponen item = grand_total pesanan
  v_item_baselines jsonb := '{}'::jsonb;
  v_all_oi record;
  v_run_net integer := 0;
  v_run_order_disc integer := 0;
  v_run_service integer := 0;
  v_run_tax integer := 0;
  v_w numeric;
  v_t_disc integer;
  v_t_svc integer;
  v_t_tax integer;
  v_b_disc integer;
  v_b_svc integer;
  v_b_tax integer;
  v_b_dpp integer;
  v_b_total integer;
  v_b_json jsonb;

  v_elem jsonb;
  v_item_id uuid;
  v_req_qty integer;
  v_severity text;
  v_pct integer;
  v_order_item record;

  -- Riwayat kumulatif per order_item_id (anti double-claim)
  v_prior_refund_total integer := 0;
  v_prior_dpp_claimed integer := 0;
  v_prior_service_refunded integer := 0;
  v_prior_tax_refunded integer := 0;
  v_prior_full_qty integer := 0;
  v_prior_has_full boolean := false;

  v_base_subtotal integer;
  v_base_prod_disc integer;
  v_base_order_disc integer;
  v_base_dpp integer;
  v_base_service integer;
  v_base_tax integer;
  v_base_full_total integer;

  v_req_subtotal integer;
  v_req_prod_disc integer;
  v_req_order_disc integer;
  v_req_dpp integer;
  v_req_service_ref integer;
  v_req_tax_ref integer;

  v_item_subtotal_out integer := 0;
  v_item_prod_disc_out integer := 0;
  v_item_order_disc_out integer := 0;
  v_item_dpp_out integer := 0;
  v_item_service_out integer := 0;
  v_item_tax_out integer := 0;
  v_item_refund_amt integer := 0;
  v_is_full_item boolean := false;
  v_remaining_dpp_cap integer := 0;
  v_remaining_svc_cap integer := 0;
  v_remaining_tax_cap integer := 0;
  v_remaining_total_cap integer := 0;

  v_total_subtotal integer := 0;
  v_total_discount integer := 0;
  v_total_service integer := 0;
  v_total_tax integer := 0;
  v_total_ref_service integer := 0;
  v_total_ref_tax integer := 0;
  v_total_rounding integer := 0;
  v_total_refund integer := 0;

  v_breakdown_items jsonb := '[]'::jsonb;
  v_seen_ids uuid[] := array[]::uuid[];
  v_residual integer := 0;
  v_all_items_full_after boolean := true;
  v_sum_claimed_after integer := 0;
begin
  if p_order_id is null then
    raise exception 'ID pesanan wajib diisi untuk perhitungan refund.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  if p_resolution_type not in ('full_refund', 'partial_refund', 'replacement') then
    raise exception 'Jenis penyelesaian komplain (%) tidak valid.', p_resolution_type;
  end if;

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
  )::integer into v_pending_refund_total
  from public.refunds r
  where r.order_id = p_order_id
    and r.resolution_type <> 'replacement'
    and r.approval_status in ('pending_approval', 'approved')
    and r.payout_status in ('not_required', 'pending', 'processing', 'reconciliation_required')
    and r.status = 'pending';

  v_committed_refund_total := coalesce(v_order.refunded_total, 0);
  v_available_refundable := greatest(0, coalesce(v_order.paid_total, 0) - (v_committed_refund_total + v_pending_refund_total));

  -- Kasus khusus: Pembayaran Ganda (payment_issue) tanpa item spesifik
  if p_reason_category = 'payment_issue' and p_duplicate_payment_amount is not null and p_duplicate_payment_amount > 0 then
    if p_resolution_type = 'replacement' then
      raise exception 'Masalah pembayaran ganda tidak dapat menggunakan penyelesaian Replacement.';
    end if;

    if p_duplicate_payment_amount > v_available_refundable then
      raise exception 'Nominal kompensasi pembayaran ganda (Rp %) melebihi saldo refundable (Rp %).',
        p_duplicate_payment_amount, v_available_refundable;
    end if;

    return pg_catalog.jsonb_build_object(
      'subtotal_amount', p_duplicate_payment_amount,
      'discount_amount', 0,
      'service_charge_amount', 0,
      'tax_amount', 0,
      'reference_service_charge_amount', 0,
      'reference_tax_amount', 0,
      'rounding_adjustment', 0,
      'total_refund_amount', p_duplicate_payment_amount,
      'available_refundable', v_available_refundable,
      'items', '[]'::jsonb
    );
  end if;

  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' or pg_catalog.jsonb_array_length(p_items) = 0 then
    raise exception 'Minimal satu item pesanan wajib dipilih untuk perhitungan refund/replacement.';
  end if;

  -- Hitung baseline seluruh item pesanan dalam urutan kanonikal sehingga bebas rounding drift
  v_order_net_line_total := greatest(1, coalesce(v_order.subtotal, 0) - coalesce(v_order.discount_product_total, 0));
  v_order_non_product_discount := coalesce(v_order.discount_order_total, 0) + coalesce(v_order.discount_manual_total, 0);

  for v_all_oi in
    select
      oi.*,
      row_number() over (order by oi.created_at asc, oi.id asc) as rn,
      count(*) over () as total_rows
    from public.order_items oi
    where oi.order_id = p_order_id
    order by oi.created_at asc, oi.id asc
  loop
    v_run_net := v_run_net + greatest(0, v_all_oi.subtotal - v_all_oi.discount_amount);
    if v_all_oi.rn = v_all_oi.total_rows then
      v_t_disc := v_order_non_product_discount;
      v_t_svc := coalesce(v_order.service_total, 0);
      v_t_tax := coalesce(v_order.tax_total, 0);
    else
      v_w := least(1::numeric, v_run_net::numeric / v_order_net_line_total::numeric);
      v_t_disc := pg_catalog.round(v_order_non_product_discount::numeric * v_w)::integer;
      v_t_svc := pg_catalog.round(coalesce(v_order.service_total, 0)::numeric * v_w)::integer;
      v_t_tax := pg_catalog.round(coalesce(v_order.tax_total, 0)::numeric * v_w)::integer;
    end if;

    v_b_disc := greatest(0, v_t_disc - v_run_order_disc);
    v_b_svc := greatest(0, v_t_svc - v_run_service);
    v_b_tax := greatest(0, v_t_tax - v_run_tax);

    v_run_order_disc := v_t_disc;
    v_run_service := v_t_svc;
    v_run_tax := v_t_tax;

    v_b_dpp := greatest(0, (v_all_oi.subtotal - v_all_oi.discount_amount) - v_b_disc);
    v_b_total := v_b_dpp + v_b_svc + v_b_tax;

    v_item_baselines := pg_catalog.jsonb_set(
      v_item_baselines,
      array[v_all_oi.id::text],
      pg_catalog.jsonb_build_object(
        'subtotal', v_all_oi.subtotal,
        'prod_disc', v_all_oi.discount_amount,
        'order_disc', v_b_disc,
        'dpp', v_b_dpp,
        'service', v_b_svc,
        'tax', v_b_tax,
        'full_total', v_b_total
      )
    );
  end loop;

  -- Validasi & hitung setiap item dalam pengajuan saat ini
  for v_elem in select * from pg_catalog.jsonb_array_elements(p_items) loop
    begin
      v_item_id := (v_elem ->> 'order_item_id')::uuid;
    exception when others then
      raise exception 'ID item pesanan tidak valid.';
    end;

    if v_item_id = any(v_seen_ids) then
      raise exception 'Item pesanan duplikat tidak diperbolehkan dalam satu pengajuan refund.';
    end if;
    v_seen_ids := pg_catalog.array_append(v_seen_ids, v_item_id);

    v_req_qty := coalesce((v_elem ->> 'quantity')::integer, 0);
    if v_req_qty <= 0 then
      raise exception 'Kuantitas item yang diajukan harus minimal 1.';
    end if;

    select * into v_order_item
    from public.order_items
    where id = v_item_id
      and order_id = p_order_id;

    if not found then
      raise exception 'Item pesanan % bukan milik transaksi ini.', v_item_id;
    end if;

    v_b_json := v_item_baselines -> v_item_id::text;
    v_base_subtotal := (v_b_json ->> 'subtotal')::integer;
    v_base_prod_disc := (v_b_json ->> 'prod_disc')::integer;
    v_base_order_disc := (v_b_json ->> 'order_disc')::integer;
    v_base_dpp := (v_b_json ->> 'dpp')::integer;
    v_base_service := (v_b_json ->> 'service')::integer;
    v_base_tax := (v_b_json ->> 'tax')::integer;
    v_base_full_total := (v_b_json ->> 'full_total')::integer;

    -- Baca kumulatif klaim terdahulu per order_item_id
    select
      coalesce(sum(ri.refund_amount), 0)::integer,
      coalesce(sum(ri.net_item_amount), 0)::integer,
      coalesce(sum(ri.service_charge_amount), 0)::integer,
      coalesce(sum(ri.tax_amount), 0)::integer,
      coalesce(sum(ri.quantity) filter (where ri.is_full_item_refund = true), 0)::integer,
      coalesce(bool_or(ri.is_full_item_refund = true or ri.compensation_percentage = 100), false)
    into
      v_prior_refund_total,
      v_prior_dpp_claimed,
      v_prior_service_refunded,
      v_prior_tax_refunded,
      v_prior_full_qty,
      v_prior_has_full
    from public.refund_items ri
    join public.refunds r on r.id = ri.refund_id
    where ri.order_item_id = v_item_id
      and r.approval_status not in ('rejected', 'cancelled')
      and r.payout_status <> 'failed'
      and r.resolution_type <> 'replacement';

    v_severity := pg_catalog.lower(coalesce(nullif(pg_catalog.btrim(v_elem ->> 'compensation_severity'), ''), 'heavy'));

    if p_resolution_type = 'replacement' then
      v_severity := 'none';
      v_pct := 0;
    elsif p_reason_category in ('wrong_order', 'food_quality') then
      if v_severity not in ('light', 'medium', 'heavy') then
        raise exception 'Tingkat kompensasi untuk kategori % wajib dipilih (light, medium, heavy).', p_reason_category;
      end if;
      v_pct := case v_severity
        when 'light' then 25
        when 'medium' then 50
        else 100
      end;
    else
      v_severity := 'heavy';
      v_pct := 100;
    end if;

    -- Rule A.3: Tolak item yang sudah mencapai 100% kompensasi/refund
    if v_prior_refund_total >= v_base_full_total
       or v_prior_full_qty >= v_order_item.quantity
       or (v_prior_has_full and v_order_item.quantity = 1)
       or (v_pct in (25, 50) and v_prior_dpp_claimed >= v_base_dpp) then
      raise exception 'Item "%" sudah mencapai batas kompensasi 100%% dan tidak dapat diajukan kembali.',
        v_order_item.product_name_snapshot;
    end if;

    if v_req_qty > (v_order_item.quantity - v_prior_full_qty) then
      raise exception 'Kuantitas yang diajukan untuk "%" (% porsi) melebihi sisa porsi yang belum dibatalkan penuh (% porsi).',
        v_order_item.product_name_snapshot,
        v_req_qty,
        (v_order_item.quantity - v_prior_full_qty);
    end if;

    -- Komponen proporsional porsi yang diajukan
    v_req_subtotal := pg_catalog.round((v_base_subtotal::numeric / v_order_item.quantity::numeric) * v_req_qty)::integer;
    v_req_prod_disc := pg_catalog.round((v_base_prod_disc::numeric / v_order_item.quantity::numeric) * v_req_qty)::integer;
    v_req_order_disc := pg_catalog.round((v_base_order_disc::numeric / v_order_item.quantity::numeric) * v_req_qty)::integer;
    v_req_dpp := pg_catalog.round((v_base_dpp::numeric / v_order_item.quantity::numeric) * v_req_qty)::integer;
    v_req_service_ref := pg_catalog.round((v_base_service::numeric / v_order_item.quantity::numeric) * v_req_qty)::integer;
    v_req_tax_ref := pg_catalog.round((v_base_tax::numeric / v_order_item.quantity::numeric) * v_req_qty)::integer;

    if v_pct = 0 then
      -- Replacement (Rp 0)
      v_item_subtotal_out := 0;
      v_item_prod_disc_out := 0;
      v_item_order_disc_out := 0;
      v_item_dpp_out := 0;
      v_item_service_out := 0;
      v_item_tax_out := 0;
      v_item_refund_amt := 0;
      v_is_full_item := false;

    elsif v_pct in (25, 50) then
      -- Rule A.2: Kompensasi 25%/50% HANYA dari nilai bersih item (DPP setelah alokasi diskon).
      -- Pajak & service charge TIDAK dikembalikan (0), tetapi tetap tersimpan di kolom reference_*.
      v_item_subtotal_out := pg_catalog.round(v_req_subtotal::numeric * v_pct::numeric / 100.0)::integer;
      v_item_prod_disc_out := pg_catalog.round(v_req_prod_disc::numeric * v_pct::numeric / 100.0)::integer;
      v_item_order_disc_out := pg_catalog.round(v_req_order_disc::numeric * v_pct::numeric / 100.0)::integer;
      v_item_dpp_out := pg_catalog.round(v_req_dpp::numeric * v_pct::numeric / 100.0)::integer;
      v_item_service_out := 0;
      v_item_tax_out := 0;

      v_remaining_dpp_cap := greatest(0, v_base_dpp - v_prior_dpp_claimed);

      -- Toleransi pembulatan 1 rupiah hanya saat klaim parsial tepat menuntaskan 100% DPP
      if v_item_dpp_out > v_remaining_dpp_cap then
        if (v_item_dpp_out - v_remaining_dpp_cap) <= 1 and v_remaining_dpp_cap > 0 then
          v_item_dpp_out := v_remaining_dpp_cap;
        else
          raise exception 'Total kompensasi untuk "%" (sudah diklaim DPP Rp %, diajukan Rp %) melampaui nilai bersih maksimum item (Rp %).',
            v_order_item.product_name_snapshot,
            v_prior_dpp_claimed,
            v_item_dpp_out,
            v_base_dpp;
        end if;
      end if;

      v_item_refund_amt := v_item_dpp_out;
      v_is_full_item := ((v_prior_dpp_claimed + v_item_dpp_out) >= v_base_dpp);

    else
      -- Pembatalan 100%: kembalikan sisa DPP + sisa service charge & pajak item
      v_remaining_dpp_cap := greatest(0, v_base_dpp - v_prior_dpp_claimed);
      v_remaining_svc_cap := greatest(0, v_base_service - v_prior_service_refunded);
      v_remaining_tax_cap := greatest(0, v_base_tax - v_prior_tax_refunded);
      v_remaining_total_cap := greatest(0, v_base_full_total - v_prior_refund_total);

      if v_req_qty = (v_order_item.quantity - v_prior_full_qty) then
        v_item_subtotal_out := least(v_req_subtotal, v_base_subtotal);
        v_item_prod_disc_out := least(v_req_prod_disc, v_base_prod_disc);
        v_item_order_disc_out := least(v_req_order_disc, v_base_order_disc);
        v_item_dpp_out := v_remaining_dpp_cap;
        v_item_service_out := v_remaining_svc_cap;
        v_item_tax_out := v_remaining_tax_cap;
      else
        v_item_subtotal_out := v_req_subtotal;
        v_item_prod_disc_out := v_req_prod_disc;
        v_item_order_disc_out := v_req_order_disc;
        v_item_dpp_out := least(v_req_dpp, v_remaining_dpp_cap);
        v_item_service_out := least(v_req_service_ref, v_remaining_svc_cap);
        v_item_tax_out := least(v_req_tax_ref, v_remaining_tax_cap);
      end if;

      v_item_refund_amt := least(
        v_remaining_total_cap,
        v_item_dpp_out + v_item_service_out + v_item_tax_out
      );
      v_is_full_item := true;
    end if;

    v_sum_claimed_after := v_prior_refund_total + v_item_refund_amt;
    if v_sum_claimed_after > v_base_full_total then
      raise exception 'Total kumulatif refund untuk "%" (Rp %) melebihi nilai maksimum item (Rp %).',
        v_order_item.product_name_snapshot,
        v_sum_claimed_after,
        v_base_full_total;
    end if;

    v_total_subtotal := v_total_subtotal + v_item_subtotal_out;
    v_total_discount := v_total_discount + v_item_prod_disc_out + v_item_order_disc_out;
    v_total_service := v_total_service + v_item_service_out;
    v_total_tax := v_total_tax + v_item_tax_out;
    v_total_ref_service := v_total_ref_service + v_req_service_ref;
    v_total_ref_tax := v_total_ref_tax + v_req_tax_ref;
    v_total_refund := v_total_refund + v_item_refund_amt;

    v_breakdown_items := v_breakdown_items || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'order_item_id', v_order_item.id,
        'product_name_snapshot', v_order_item.product_name_snapshot,
        'quantity', v_req_qty,
        'unit_price', v_order_item.unit_price_snapshot,
        'subtotal_amount', v_item_subtotal_out,
        'discount_amount', v_item_prod_disc_out,
        'order_discount_share', v_item_order_disc_out,
        'net_item_amount', v_item_dpp_out,
        'service_charge_amount', v_item_service_out,
        'tax_amount', v_item_tax_out,
        'reference_service_charge_amount', v_req_service_ref,
        'reference_tax_amount', v_req_tax_ref,
        'rounding_adjustment', 0,
        'compensation_severity', v_severity,
        'compensation_percentage', v_pct,
        'is_full_item_refund', v_is_full_item,
        'refund_amount', v_item_refund_amt,
        'reason', nullif(pg_catalog.btrim(coalesce(v_elem ->> 'reason', '')), '')
      )
    );
  end loop;

  -- Penyerapan sisa pembulatan bila Full Refund penuh menghabiskan seluruh item yang belum dibatalkan
  if p_resolution_type = 'full_refund' and v_total_refund <> v_available_refundable and v_available_refundable > 0 then
    v_residual := v_available_refundable - v_total_refund;
    if pg_catalog.abs(v_residual) <= greatest(50, pg_catalog.jsonb_array_length(v_breakdown_items) * 5) then
      v_total_rounding := v_residual;
      v_total_refund := v_available_refundable;
    end if;
  end if;

  if p_resolution_type <> 'replacement' and v_total_refund <= 0 then
    raise exception 'Hasil perhitungan nominal refund bernilai Rp 0.';
  end if;

  if p_resolution_type <> 'replacement' and v_total_refund > v_available_refundable then
    raise exception 'Total refund hasil perhitungan (Rp %) melebihi sisa dana yang dapat direfund (Rp %).',
      v_total_refund, v_available_refundable;
  end if;

  return pg_catalog.jsonb_build_object(
    'subtotal_amount', v_total_subtotal,
    'discount_amount', v_total_discount,
    'service_charge_amount', v_total_service,
    'tax_amount', v_total_tax,
    'reference_service_charge_amount', v_total_ref_service,
    'reference_tax_amount', v_total_ref_tax,
    'rounding_adjustment', v_total_rounding,
    'total_refund_amount', v_total_refund,
    'available_refundable', v_available_refundable,
    'items', v_breakdown_items
  );
end;
$$;

revoke all on function public.calculate_refund_breakdown_internal(uuid, jsonb, text, text, integer) from public, anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 5. SINKRONISASI RPC get_order_receipt_data (SET search_path = '')
-- -----------------------------------------------------------------------------
create or replace function public.get_order_receipt_data(
  p_order_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_role text;
  v_order record;
  v_table record;
  v_settings record;
  v_cashier record;
  v_items jsonb;
  v_discounts jsonb;
  v_payments jsonb;
  v_refunds jsonb;
  v_completed_refund_total integer := 0;
  v_pending_refund_total integer := 0;
begin
  v_user_role := public.current_user_role();
  if coalesce(v_user_role, '') not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir yang berhak mengakses data struk pesanan.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id;

  if not found then
    return null;
  end if;

  select * into v_settings
  from public.restaurant_settings
  where id = 1;

  if v_order.table_id is not null then
    select * into v_table
    from public.dining_tables
    where id = v_order.table_id;
  end if;

  if v_order.created_by is not null then
    select full_name into v_cashier
    from public.profiles
    where id = v_order.created_by;
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', oi.id,
        'product_id', oi.product_id,
        'product_name', oi.product_name_snapshot,
        'product_sku', oi.product_sku_snapshot,
        'unit_price', oi.unit_price_snapshot,
        'quantity', oi.quantity,
        'notes', oi.notes,
        'modifier_total', oi.modifier_total,
        'subtotal', oi.subtotal,
        'discount_amount', oi.discount_amount,
        'line_total', oi.line_total,
        'kitchen_station', oi.kitchen_station,
        'modifiers', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'group_name', oim.group_name_snapshot,
              'option_name', oim.option_name_snapshot,
              'price_delta', oim.price_delta_snapshot
            ) order by oim.created_at asc
          )
          from public.order_item_modifiers oim
          where oim.order_item_id = oi.id
        ), '[]'::jsonb)
      ) order by oi.created_at asc
    ),
    '[]'::jsonb
  ) into v_items
  from public.order_items oi
  where oi.order_id = p_order_id;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', od.id,
        'name', od.name,
        'scope', od.scope,
        'discount_type', od.discount_type,
        'discount_rate', od.discount_rate,
        'discount_amount', od.discount_amount,
        'reason', od.reason,
        'approved_by', od.approved_by,
        'approved_at', od.approved_at,
        'approver_name', (
          select p.full_name from public.profiles p where p.id = od.approved_by
        )
      ) order by od.created_at asc
    ),
    '[]'::jsonb
  ) into v_discounts
  from public.order_discounts od
  where od.order_id = p_order_id;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', p.id,
        'payment_method', p.payment_method,
        'payment_source', p.payment_source,
        'amount', p.amount,
        'cash_received', p.cash_received,
        'change_amount', p.change_amount,
        'payment_status', p.payment_status,
        'reference_number', p.reference_number,
        'created_at', p.created_at
      ) order by p.created_at asc
    ),
    '[]'::jsonb
  ) into v_payments
  from public.payments p
  where p.order_id = p_order_id;

  select
    coalesce(v_order.refunded_total, 0),
    coalesce(
      sum(
        case
          when r.status = 'pending' and r.approval_status = 'approved' then
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
          else 0
        end
      ),
      0
    )::integer
  into v_completed_refund_total, v_pending_refund_total
  from public.refunds r
  where r.order_id = p_order_id
    and r.resolution_type <> 'replacement';

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', r.id,
        'refund_number', r.refund_number,
        'gateway_refund_id', r.gateway_refund_id,
        'refund_type', r.refund_type,
        'resolution_type', r.resolution_type,
        'refund_method', r.refund_method,
        'amount', r.amount,
        'reason', r.reason,
        'reason_category', r.reason_category,
        'status', r.status,
        'approval_status', r.approval_status,
        'payout_status', r.payout_status,
        'created_at', r.created_at,
        'approver_name', (
          select p.full_name from public.profiles p where p.id = coalesce(r.reviewed_by, r.approved_by)
        )
      ) order by r.created_at asc
    ),
    '[]'::jsonb
  ) into v_refunds
  from public.refunds r
  where r.order_id = p_order_id;

  return pg_catalog.jsonb_build_object(
    'restaurant', pg_catalog.jsonb_build_object(
      'name', coalesce(v_settings.name, 'Nine Licious'),
      'address', v_settings.address,
      'phone', v_settings.phone,
      'logo_url', v_settings.logo_url,
      'receipt_header', v_settings.receipt_header,
      'receipt_footer', v_settings.receipt_footer,
      'receipt_width', coalesce(v_settings.receipt_width, 58)
    ),
    'order', pg_catalog.jsonb_build_object(
      'id', v_order.id,
      'order_number', v_order.order_number,
      'order_type', v_order.order_type,
      'order_kind', coalesce(v_order.order_kind, 'standard'),
      'table_name', v_table.name,
      'customer_name', v_order.customer_name,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'queue_number', v_order.queue_number,
      'queue_date', v_order.queue_date,
      'cashier_name', coalesce(v_cashier.full_name, 'Kasir'),
      'created_at', v_order.created_at,
      'paid_at', v_order.paid_at,
      'subtotal', v_order.subtotal,
      'discount_product_total', v_order.discount_product_total,
      'discount_order_total', v_order.discount_order_total,
      'discount_manual_total', v_order.discount_manual_total,
      'discount_total', v_order.discount_total,
      'tax_percent', v_order.tax_percent,
      'tax_total', v_order.tax_total,
      'service_charge_percent', v_order.service_charge_percent,
      'service_total', v_order.service_total,
      'grand_total', v_order.grand_total,
      'paid_total', v_order.paid_total,
      'refunded_total', v_completed_refund_total,
      'pending_refund_total', v_pending_refund_total,
      'net_paid', (v_order.paid_total - v_completed_refund_total)
    ),
    'items', v_items,
    'discounts', v_discounts,
    'payments', v_payments,
    'refunds', v_refunds
  );
end;
$$;

revoke all on function public.get_order_receipt_data(uuid) from public, anon;
grant execute on function public.get_order_receipt_data(uuid) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 6. SINKRONISASI PENUTUPAN MEJA (ATURAN A.1: pending_approval TIDAK MEMBLOKIR)
-- Baik get_dining_session_summary maupun close_dining_session_atomic memakai
-- SET search_path = '' dan hanya menahan tutup meja bila terdapat payout
-- gateway Midtrans yang sudah disetujui dan masih aktif ('pending'/'processing').
-- -----------------------------------------------------------------------------
create or replace function public.get_dining_session_summary(
  p_table_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
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
  v_pending_refund_count integer := 0;
  v_session_pending_refund_total integer := 0;
  v_can_close boolean := false;
  v_blocking_reason text := null;
begin
  v_user_role := public.current_user_role();
  if coalesce(v_user_role, '') not in ('admin', 'kasir') then
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
    return pg_catalog.jsonb_build_object(
      'table_id', v_table.id,
      'table_name', v_table.name,
      'table_status', v_table.status,
      'has_active_session', false
    );
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
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
      'refunded_total', coalesce(o.refunded_total, 0),
      'remaining_balance', (o.grand_total - o.paid_total),
      'created_at', o.created_at
    ) order by o.created_at asc
  ) into v_orders
  from public.orders o
  where o.dining_session_id = v_session.id
    and coalesce(o.order_kind, 'standard') = 'standard';

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
    coalesce(sum(paid_total) filter (where status not in ('cancelled', 'refunded')), 0) as session_paid_total,
    coalesce(sum(refunded_total), 0) as session_refunded_total
  into v_summary
  from public.orders
  where dining_session_id = v_session.id
    and coalesce(order_kind, 'standard') = 'standard';

  -- Aturan A.1: approval_status = 'pending_approval' TIDAK memblokir penutupan meja.
  -- Hanya payout gateway Midtrans aktif (approved + pending/processing/reconciliation_required) yang dihitung.
  select
    count(*)::integer,
    coalesce(sum(
      case
        when exists (select 1 from public.refund_payout_allocations a where a.refund_id = r.id) then
          coalesce((
            select sum(a.amount)
            from public.refund_payout_allocations a
            where a.refund_id = r.id
              and a.payout_method = 'midtrans'
              and a.payout_status in ('pending', 'processing', 'reconciliation_required')
          ), 0)
        else r.amount
      end
    ), 0)::integer
  into v_pending_refund_count, v_session_pending_refund_total
  from public.refunds r
  join public.orders o on o.id = r.order_id
  where o.dining_session_id = v_session.id
    and r.approval_status = 'approved'
    and r.resolution_type <> 'replacement'
    and r.status = 'pending'
    and r.payout_status in ('pending', 'processing', 'reconciliation_required')
    and (
      r.payout_method in ('midtrans', 'mixed')
      or r.refund_method in ('midtrans', 'mixed')
      or exists (
        select 1 from public.refund_payout_allocations a
        where a.refund_id = r.id
          and a.payout_method = 'midtrans'
          and a.payout_status in ('pending', 'processing', 'reconciliation_required')
      )
    );

  select count(*)::integer into v_reserved_alloc_count
  from public.order_allocations oa
  join public.orders o on o.id = oa.order_id
  where o.dining_session_id = v_session.id
    and oa.allocation_status = 'reserved';

  select count(*)::integer into v_pending_trx_count
  from public.midtrans_transactions mt
  join public.orders o on o.id = mt.order_id
  where o.dining_session_id = v_session.id
    and mt.lifecycle_status in (
      'initiated', 'token_created', 'pending', 'capture_challenge', 'reconciliation_required'
    );

  select count(*)::integer into v_processing_webhook_count
  from public.midtrans_webhook_events mwe
  join public.midtrans_transactions mt on mt.midtrans_order_id = mwe.midtrans_order_id
  join public.orders o on o.id = mt.order_id
  where o.dining_session_id = v_session.id
    and mwe.processing_result in ('received', 'processing');

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
  elsif v_pending_refund_count > 0 then
    v_can_close := false;
    v_blocking_reason := 'Terdapat pencairan refund gateway Midtrans yang masih aktif dan menunggu konfirmasi penyedia pembayaran.';
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

  return pg_catalog.jsonb_build_object(
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
    'closed_orders_count', coalesce(v_summary.closed_orders_count, 0),
    'reserved_allocations_count', v_reserved_alloc_count,
    'pending_midtrans_transactions_count', v_pending_trx_count,
    'processing_webhooks_count', v_processing_webhook_count,
    'pending_refund_count', v_pending_refund_count,
    'session_subtotal', coalesce(v_summary.session_subtotal, 0),
    'session_discount_total', coalesce(v_summary.session_discount_total, 0),
    'session_tax_total', coalesce(v_summary.session_tax_total, 0),
    'session_service_total', coalesce(v_summary.session_service_total, 0),
    'session_grand_total', coalesce(v_summary.session_grand_total, 0),
    'session_paid_total', coalesce(v_summary.session_paid_total, 0),
    'session_refunded_total', coalesce(v_summary.session_refunded_total, 0),
    'session_pending_refund_total', v_session_pending_refund_total,
    'session_remaining_balance', greatest(0, (coalesce(v_summary.session_grand_total, 0) - coalesce(v_summary.session_paid_total, 0))),
    'can_close_session', v_can_close,
    'blocking_reason', v_blocking_reason,
    'orders', coalesce(v_orders, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_dining_session_summary(uuid) from public, anon;
grant execute on function public.get_dining_session_summary(uuid) to authenticated, service_role;

create or replace function public.close_dining_session_atomic(
  p_table_id uuid,
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
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
  v_pending_refund_count integer := 0;
  v_uncompleted_order_count integer := 0;
  v_active_kds_count integer := 0;
  v_total_orders integer := 0;
  v_now timestamptz := pg_catalog.now();
begin
  v_user_id := auth.uid();
  v_user_role := public.current_user_role();

  if v_user_id is null or coalesce(v_user_role, '') not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir yang berhak menutup kunjungan meja.';
  end if;

  if p_table_id is null or p_session_id is null then
    raise exception 'Parameter meja dan sesi kunjungan wajib diisi.';
  end if;

  -- Lock hierarkis kanonikal: L1 -> L2 -> L3 -> L4 -> L5 -> L7
  select * into v_table
  from public.dining_tables
  where id = p_table_id
  for update;

  if not found or not v_table.is_active then
    raise exception 'Meja tidak ditemukan atau sedang tidak aktif.';
  end if;

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

  perform 1
  from public.orders
  where dining_session_id = p_session_id
  order by id asc
  for update;

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

  perform 1
  from public.refunds r
  join public.orders o on o.id = r.order_id
  where o.dining_session_id = p_session_id
  order by r.id asc
  for update;

  select count(*)::integer into v_unpaid_count
  from public.orders
  where dining_session_id = p_session_id
    and coalesce(order_kind, 'standard') = 'standard'
    and status in ('awaiting_payment', 'partially_paid');

  if v_unpaid_count > 0 then
    raise exception 'Tidak dapat menutup sesi: Terdapat % pesanan yang belum lunas pada meja ini.', v_unpaid_count;
  end if;

  select coalesce(sum(grand_total - paid_total), 0)::integer into v_remaining_balance
  from public.orders
  where dining_session_id = p_session_id
    and coalesce(order_kind, 'standard') = 'standard'
    and status not in ('cancelled', 'refunded');

  if v_remaining_balance > 0 then
    raise exception 'Tidak dapat menutup sesi: Masih terdapat sisa kewajiban pembayaran sebesar Rp % pada sesi ini.', v_remaining_balance;
  end if;

  select count(*)::integer into v_reserved_alloc_count
  from public.order_allocations oa
  join public.orders o on o.id = oa.order_id
  where o.dining_session_id = p_session_id
    and oa.allocation_status = 'reserved';

  if v_reserved_alloc_count > 0 then
    raise exception 'Tidak dapat menutup sesi: Terdapat alokasi pembayaran split bill yang masih berstatus reserved.';
  end if;

  select count(*)::integer into v_pending_trx_count
  from public.midtrans_transactions mt
  join public.orders o on o.id = mt.order_id
  where o.dining_session_id = p_session_id
    and mt.lifecycle_status in (
      'initiated', 'token_created', 'pending', 'capture_challenge', 'reconciliation_required'
    );

  if v_pending_trx_count > 0 then
    raise exception 'Tidak dapat menutup sesi: Terdapat transaksi gateway Midtrans yang masih aktif / belum mencapai status terminal.';
  end if;

  select count(*)::integer into v_processing_webhook_count
  from public.midtrans_webhook_events mwe
  join public.midtrans_transactions mt on mt.midtrans_order_id = mwe.midtrans_order_id
  join public.orders o on o.id = mt.order_id
  where o.dining_session_id = p_session_id
    and mwe.processing_result in ('received', 'processing');

  if v_processing_webhook_count > 0 then
    raise exception 'Tidak dapat menutup sesi: Terdapat notifikasi pembayaran webhook Midtrans yang sedang diproses.';
  end if;

  -- Aturan A.1: approval_status = 'pending_approval' TIDAK menghalangi penutupan meja;
  -- hanya payout gateway Midtrans aktif yang sudah disetujui yang ditahan sampai konfirmasi selesai.
  select count(*)::integer into v_pending_refund_count
  from public.refunds r
  join public.orders o on o.id = r.order_id
  where o.dining_session_id = p_session_id
    and r.approval_status = 'approved'
    and r.resolution_type <> 'replacement'
    and r.status = 'pending'
    and r.payout_status in ('pending', 'processing', 'reconciliation_required')
    and (
      r.payout_method in ('midtrans', 'mixed')
      or r.refund_method in ('midtrans', 'mixed')
      or exists (
        select 1 from public.refund_payout_allocations a
        where a.refund_id = r.id
          and a.payout_method = 'midtrans'
          and a.payout_status in ('pending', 'processing', 'reconciliation_required')
      )
    );

  if v_pending_refund_count > 0 then
    raise exception 'Tidak dapat menutup sesi: Terdapat % pencairan refund gateway Midtrans yang masih aktif menunggu konfirmasi gateway.', v_pending_refund_count;
  end if;

  select count(*)::integer into v_uncompleted_order_count
  from public.orders
  where dining_session_id = p_session_id
    and coalesce(order_kind, 'standard') = 'standard'
    and status = 'paid';

  if v_uncompleted_order_count > 0 then
    raise exception 'Tidak dapat menutup sesi: Terdapat % pesanan yang sudah lunas tetapi belum selesai diserahkan ke pelanggan (status belum completed).',
      v_uncompleted_order_count;
  end if;

  select count(*)::integer into v_active_kds_count
  from public.orders
  where dining_session_id = p_session_id
    and coalesce(order_kind, 'standard') = 'standard'
    and kds_status in ('queued', 'preparing', 'ready');

  if v_active_kds_count > 0 then
    raise exception 'Tidak dapat menutup sesi: Terdapat pesanan yang masih dalam antrean dapur atau siap diambil (kds_status: queued/preparing/ready).';
  end if;

  select count(*)::integer into v_total_orders
  from public.orders
  where dining_session_id = p_session_id
    and coalesce(order_kind, 'standard') = 'standard';

  update public.dining_sessions
  set
    status = 'closed',
    closed_at = v_now,
    closed_by = v_user_id,
    updated_at = v_now
  where id = p_session_id;

  update public.dining_tables
  set
    status = 'empty',
    updated_at = v_now
  where id = p_table_id;

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
    pg_catalog.jsonb_build_object(
      'table_id', p_table_id,
      'table_name', v_table.name,
      'orders_count', v_total_orders
    )
  );

  return pg_catalog.jsonb_build_object(
    'table_id', p_table_id,
    'session_id', p_session_id,
    'session_status', 'closed',
    'table_status', 'empty',
    'orders_count', v_total_orders,
    'closed_at', v_now
  );
end;
$$;

revoke all on function public.close_dining_session_atomic(uuid, uuid) from public, anon;
grant execute on function public.close_dining_session_atomic(uuid, uuid) to authenticated, service_role;

commit;
