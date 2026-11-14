-- =============================================================================
-- Migration: 20261115000200_f2_4_post_migration_patch.sql
-- Fase: F2.4 Post-Migration Security & Realtime Hardening Patch
-- Tujuan:
-- Menerapkan perbaikan yang dibuat setelah migration utama 20261115000100_refunds_receipts.sql
-- dijalankan secara manual di Supabase:
-- 1. Penegakan Three-Valued Logic (3VL) pada pengecekan otorisasi admin/kasir
--    (mencegah lolosnya eksekusi jika auth.uid() bernilai NULL).
-- 2. Registrasi aman publikasi Supabase Realtime untuk tabel orders dan refunds.
-- 3. Penambahan constraint pelindung integritas orders_refunded_total_le_paid_total
--    (hanya jika belum ada, tanpa merusak data yang sudah ada).
--
-- Karakteristik Keamanan Patch:
-- - Aman untuk database yang sudah memiliki data aktif (tidak ada DROP TABLE / TRUNCATE).
-- - Tidak mengubah signature, argumen default, atau tipe kembalian RPC.
-- - Bersifat idempotent (aman dijalankan berulang kali).
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. CONSTRAINT PELINDUNG: orders.refunded_total <= orders.paid_total
-- Menjamin secara struktural di tingkat database bahwa total refund pesanan
-- tidak akan pernah melampaui total dana yang berhasil dibayarkan pelanggan.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_refunded_total_le_paid_total'
  ) then
    alter table public.orders
      add constraint orders_refunded_total_le_paid_total
      check (refunded_total <= paid_total);
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- 2. PUBLIKASI REALTIME: Daftarkan orders & refunds ke supabase_realtime
-- Memastikan perubahan status pesanan (kds_status = null saat refund penuh)
-- dan ledger refund dapat disiarkan langsung melalui WebSocket Supabase Realtime.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'orders'
    ) then
      alter publication supabase_realtime add table public.orders;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'refunds'
    ) then
      alter publication supabase_realtime add table public.refunds;
    end if;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- 3. PEMBARUAN RPC: process_order_refund_atomic
-- Perbaikan: Proteksi Three-Valued Logic (3VL) pada otorisasi admin.
-- Mengganti `if v_user_role <> 'admin'` menjadi `if v_user_id is null or coalesce(v_user_role, '') <> 'admin'`.
-- -----------------------------------------------------------------------------
create or replace function public.process_order_refund_atomic(
  p_order_id uuid,
  p_amount integer,
  p_refund_type text,
  p_refund_method text,
  p_reason text,
  p_payment_id uuid default null,
  p_idempotency_key text default null
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
begin
  -- 1. Validasi Otorisasi Staf: Wajib Admin Aktif dengan Proteksi 3VL Eksplisit
  v_user_id := auth.uid();
  v_user_role := public.current_user_role();

  if v_user_id is null or coalesce(v_user_role, '') <> 'admin' then
    raise exception 'Hanya admin yang berhak memproses pengembalian dana (refund).';
  end if;

  -- 2. Validasi Parameter Input
  if p_order_id is null then
    raise exception 'ID pesanan wajib diisi.';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Nominal refund harus lebih dari Rp 0.';
  end if;

  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'Alasan refund wajib diisi (minimal 3 karakter).';
  end if;

  if p_refund_type not in ('full', 'partial') then
    raise exception 'Tipe refund tidak valid: % (harus full atau partial).', p_refund_type;
  end if;

  if p_refund_method not in ('cash', 'transfer', 'midtrans', 'manual') then
    raise exception 'Metode refund tidak valid: %.', p_refund_method;
  end if;

  if p_idempotency_key is null or char_length(btrim(p_idempotency_key)) = 0 then
    raise exception 'Kunci idempotensi (idempotency key) wajib disertakan pada setiap mutasi refund.';
  end if;

  -- 3. Idempotency Check Awal (Pre-lock)
  select * into v_existing_refund
  from public.refunds
  where idempotency_key = btrim(p_idempotency_key);

  if found then
    if v_existing_refund.order_id <> p_order_id
       or coalesce(v_existing_refund.payment_id, '00000000-0000-0000-0000-000000000000'::uuid) <> coalesce(p_payment_id, '00000000-0000-0000-0000-000000000000'::uuid)
       or v_existing_refund.amount <> p_amount
       or v_existing_refund.refund_type <> p_refund_type
       or v_existing_refund.refund_method <> p_refund_method
       or btrim(v_existing_refund.reason) <> btrim(p_reason)
    then
      raise exception 'Konflik Idempotensi: Kunci "%" telah digunakan sebelumnya dengan rincian data refund yang berbeda.',
        btrim(p_idempotency_key);
    end if;

    return jsonb_build_object(
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

  -- 4. Pre-read Relasi Pesanan untuk Menentukan Urutan Kunci Kanonikal
  select id, order_number, order_type, table_id, dining_session_id, status, payment_status, kds_status, paid_total, refunded_total
  into v_pre_order
  from public.orders
  where id = p_order_id;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  -- 5. Hierarchical Locking Anti-Deadlock (L1 -> L2 -> L3 -> L4 -> L5 -> L6)
  if v_pre_order.order_type = 'dine_in' and v_pre_order.table_id is not null then
    perform 1 from public.dining_tables where id = v_pre_order.table_id for update;
  end if;

  if v_pre_order.order_type = 'dine_in' and v_pre_order.dining_session_id is not null then
    perform 1 from public.dining_sessions where id = v_pre_order.dining_session_id for update;
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  -- Re-check idempotency setelah lock orders diperoleh (mencegah race condition)
  select * into v_existing_refund
  from public.refunds
  where idempotency_key = btrim(p_idempotency_key);

  if found then
    if v_existing_refund.order_id <> p_order_id
       or coalesce(v_existing_refund.payment_id, '00000000-0000-0000-0000-000000000000'::uuid) <> coalesce(p_payment_id, '00000000-0000-0000-0000-000000000000'::uuid)
       or v_existing_refund.amount <> p_amount
       or v_existing_refund.refund_type <> p_refund_type
       or v_existing_refund.refund_method <> p_refund_method
       or btrim(v_existing_refund.reason) <> btrim(p_reason)
    then
      raise exception 'Konflik Idempotensi: Kunci "%" telah digunakan sebelumnya dengan rincian data refund yang berbeda.',
        btrim(p_idempotency_key);
    end if;

    return jsonb_build_object(
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

  -- Level 4: Kunci order_allocations terurut
  perform 1
  from public.order_allocations
  where order_id = p_order_id
  order by id asc
  for update;

  -- Level 5: Kunci midtrans_transactions terurut
  perform 1
  from public.midtrans_transactions
  where order_id = p_order_id
  order by id asc
  for update;

  -- Level 6: Kunci payments terurut
  perform 1
  from public.payments
  where order_id = p_order_id
  order by id asc
  for update;

  -- 6. Validasi Status Pesanan & Sisa Dana Refundable (Termasuk Proteksi Saldo Pending)
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

  -- Hitung total refund yang masih berstatus 'pending' pada pesanan ini
  select coalesce(sum(amount), 0) into v_pending_refund_total
  from public.refunds
  where order_id = p_order_id
    and status = 'pending';

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

  -- Validasi Spesifik Split Bill (payment_id)
  if p_payment_id is not null then
    select * into v_payment
    from public.payments
    where id = p_payment_id and order_id = p_order_id;

    if not found then
      raise exception 'Baris pembayaran spesifik tidak ditemukan pada pesanan ini.';
    end if;

    if v_payment.payment_status <> 'success' then
      raise exception 'Hanya baris pembayaran berstatus success yang dapat direfund.';
    end if;

    select coalesce(sum(amount), 0) into v_payment_refunded_so_far
    from public.refunds
    where payment_id = p_payment_id
      and status in ('completed', 'pending');

    v_payment_remaining := v_payment.amount - v_payment_refunded_so_far;

    if v_payment_remaining <= 0 then
      raise exception 'Baris pembayaran ini sudah tidak memiliki saldo refundable (seluruh dana Rp % telah direfund atau berstatus pending).',
        v_payment.amount;
    end if;

    if p_amount > v_payment_remaining then
      raise exception 'Nominal refund (Rp %) melebihi sisa dana pada baris pembayaran ini (Rp %). Sebelumnya telah direfund/pending: Rp % dari total Rp %.',
        p_amount, v_payment_remaining, v_payment_refunded_so_far, v_payment.amount;
    end if;
  end if;

  -- Evaluasi Apakah Ini Refund Penuh Sisa Dana
  if p_amount = v_available_refundable and v_pending_refund_total = 0 then
    v_is_full_refund := true;
  else
    v_is_full_refund := false;
  end if;

  if p_refund_type = 'full' and not v_is_full_refund then
    raise exception 'Tipe refund full dipilih tetapi nominal (Rp %) tidak mencakup seluruh sisa dana (Rp %).',
      p_amount, v_available_refundable;
  end if;

  if p_refund_type = 'partial' and v_is_full_refund then
    raise exception 'Nominal mencakup seluruh sisa dana; gunakan tipe refund full.';
  end if;

  -- 7. PENANGANAN METODE MIDTRANS: Selalu Pending dari Sisi POS
  if p_refund_method = 'midtrans' then
    v_refund_number := public.generate_refund_number();

    insert into public.refunds (
      order_id,
      payment_id,
      refund_number,
      refund_type,
      refund_method,
      amount,
      reason,
      status,
      requested_by,
      approved_by,
      approved_at,
      kitchen_notified_at,
      idempotency_key,
      metadata
    ) values (
      p_order_id,
      p_payment_id,
      v_refund_number,
      p_refund_type,
      p_refund_method,
      p_amount,
      btrim(p_reason),
      'pending',
      v_user_id,
      null,           -- approved_by Wajib NULL saat pending
      null,           -- approved_at Wajib NULL saat pending
      null,
      btrim(p_idempotency_key),
      jsonb_build_object(
        'previous_order_status', v_order.status,
        'previous_payment_status', v_order.payment_status,
        'previous_kds_status', v_order.kds_status,
        'is_full_refund', v_is_full_refund,
        'requested_by_role', v_user_role,
        'verification_mode', 'server_side_midtrans'
      )
    ) returning id into v_refund_id;

    insert into public.audit_logs (
      action,
      user_id,
      entity,
      entity_id,
      details
    ) values (
      'order.refund_requested',
      v_user_id,
      'order',
      p_order_id::text,
      jsonb_build_object(
        'refund_id', v_refund_id,
        'refund_number', v_refund_number,
        'refund_type', p_refund_type,
        'refund_method', p_refund_method,
        'amount', p_amount,
        'reason', btrim(p_reason),
        'status', 'pending',
        'gateway_verification_required', true
      )
    );

    return jsonb_build_object(
      'refund_id', v_refund_id,
      'refund_number', v_refund_number,
      'order_id', p_order_id,
      'order_number', v_order.order_number,
      'payment_id', p_payment_id,
      'amount', p_amount,
      'refund_type', p_refund_type,
      'refund_method', p_refund_method,
      'status', 'pending',
      'is_duplicate', false,
      'message', 'Permintaan refund Midtrans dicatat sebagai pending. Memerlukan verifikasi server-side sebelum dana dieksekusi.'
    );
  end if;

  -- 8. PENANGANAN METODE MANUAL (Cash, Transfer, Manual): Eksekusi Selesai Langsung
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
      v_kitchen_notified_at := now();
    else
      v_kds_status_after := null;
      v_kitchen_notified_at := null;
    end if;

    update public.payments
    set payment_status = 'refunded',
        updated_at = now()
    where order_id = p_order_id
      and payment_status = 'success';

  else
    v_new_order_status := v_order.status;
    v_new_payment_status := 'partially_refunded';
    v_kds_status_after := v_order.kds_status;
    v_kitchen_notified_at := null;

    if p_payment_id is not null then
      select coalesce(sum(amount), 0) into v_payment_completed_after
      from public.refunds
      where payment_id = p_payment_id
        and status = 'completed';

      v_payment_completed_after := v_payment_completed_after + p_amount;

      if v_payment_completed_after >= v_payment.amount then
        update public.payments
        set payment_status = 'refunded',
            updated_at = now()
        where id = p_payment_id;
      end if;
    end if;
  end if;

  v_new_refunded_total := v_committed_refund_total + p_amount;
  v_refund_number := public.generate_refund_number();

  insert into public.refunds (
    order_id,
    payment_id,
    refund_number,
    refund_type,
    refund_method,
    amount,
    reason,
    status,
    requested_by,
    approved_by,
    approved_at,
    kitchen_notified_at,
    idempotency_key,
    metadata
  ) values (
    p_order_id,
    p_payment_id,
    v_refund_number,
    p_refund_type,
    p_refund_method,
    p_amount,
    btrim(p_reason),
    'completed',
    v_user_id,
    v_user_id,
    now(),
    v_kitchen_notified_at,
    btrim(p_idempotency_key),
    jsonb_build_object(
      'previous_order_status', v_order.status,
      'previous_payment_status', v_order.payment_status,
      'previous_kds_status', v_order.kds_status,
      'is_full_refund', v_is_full_refund,
      'refunded_by_role', v_user_role
    )
  ) returning id into v_refund_id;

  update public.orders
  set
    refunded_total = v_new_refunded_total,
    status = v_new_order_status,
    payment_status = v_new_payment_status,
    kds_status = v_kds_status_after,
    cancelled_by = case when v_is_full_refund then v_user_id else cancelled_by end,
    cancelled_at = case when v_is_full_refund then now() else cancelled_at end,
    cancel_reason = case when v_is_full_refund then btrim(p_reason) else cancel_reason end,
    updated_at = now()
  where id = p_order_id;

  if v_order.order_type = 'dine_in' and v_order.table_id is not null and v_order.dining_session_id is not null then
    perform public.sync_dining_table_status_internal(v_order.table_id, v_order.dining_session_id, v_user_id);
  end if;

  insert into public.audit_logs (
    action,
    user_id,
    entity,
    entity_id,
    details
  ) values (
    'order.refunded',
    v_user_id,
    'order',
    p_order_id::text,
    jsonb_build_object(
      'refund_id', v_refund_id,
      'refund_number', v_refund_number,
      'refund_type', p_refund_type,
      'refund_method', p_refund_method,
      'amount', p_amount,
      'reason', btrim(p_reason),
      'previous_order_status', v_order.status,
      'new_order_status', v_new_order_status,
      'new_payment_status', v_new_payment_status,
      'is_full_refund', v_is_full_refund,
      'kitchen_notified', (v_kitchen_notified_at is not null)
    )
  );

  return jsonb_build_object(
    'refund_id', v_refund_id,
    'refund_number', v_refund_number,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'payment_id', p_payment_id,
    'amount', p_amount,
    'refund_type', p_refund_type,
    'refund_method', p_refund_method,
    'status', 'completed',
    'new_order_status', v_new_order_status,
    'new_payment_status', v_new_payment_status,
    'refunded_total', v_new_refunded_total,
    'kitchen_notified', (v_kitchen_notified_at is not null),
    'is_duplicate', false
  );
end;
$$;

revoke all on function public.process_order_refund_atomic(uuid, integer, text, text, text, uuid, text) from public, anon;
grant execute on function public.process_order_refund_atomic(uuid, integer, text, text, text, uuid, text) to authenticated;
grant execute on function public.process_order_refund_atomic(uuid, integer, text, text, text, uuid, text) to service_role;


-- -----------------------------------------------------------------------------
-- 4. PEMBARUAN RPC: get_order_receipt_data
-- Perbaikan: Proteksi Three-Valued Logic (3VL) pada otorisasi pembacaan struk.
-- Mengganti `if v_user_role not in ('admin', 'kasir')` menjadi `if coalesce(v_user_role, '') not in ('admin', 'kasir')`.
-- -----------------------------------------------------------------------------
create or replace function public.get_order_receipt_data(
  p_order_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
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
  -- 1. Validasi Autentikasi Staf dengan Proteksi 3VL Eksplisit
  v_user_role := public.current_user_role();
  if coalesce(v_user_role, '') not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir yang berhak mengakses data struk pesanan.';
  end if;

  -- 2. Ambil Data Pesanan
  select * into v_order
  from public.orders
  where id = p_order_id;

  if not found then
    return null;
  end if;

  -- 3. Ambil Pengaturan Restoran
  select * into v_settings
  from public.restaurant_settings
  where id = 1;

  -- 4. Ambil Meja jika Dine-In
  if v_order.table_id is not null then
    select * into v_table
    from public.dining_tables
    where id = v_order.table_id;
  end if;

  -- 5. Ambil Profil Kasir Pembuat
  if v_order.created_by is not null then
    select full_name into v_cashier
    from public.profiles
    where id = v_order.created_by;
  end if;

  -- 6. Agregasi Order Items dan Modifiers
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
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
          select jsonb_agg(
            jsonb_build_object(
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

  -- 7. Agregasi Order Discounts
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
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

  -- 8. Agregasi Payments
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
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

  -- 9. Agregasi Refunds & Hitung Akumulasi Terpisah Completed vs Pending
  select
    coalesce(sum(amount) filter (where status = 'completed'), 0),
    coalesce(sum(amount) filter (where status = 'pending'), 0)
  into v_completed_refund_total, v_pending_refund_total
  from public.refunds
  where order_id = p_order_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'refund_number', r.refund_number,
        'gateway_refund_id', r.gateway_refund_id,
        'refund_type', r.refund_type,
        'refund_method', r.refund_method,
        'amount', r.amount,
        'reason', r.reason,
        'status', r.status,
        'created_at', r.created_at,
        'approver_name', (
          select p.full_name from public.profiles p where p.id = r.approved_by
        )
      ) order by r.created_at asc
    ),
    '[]'::jsonb
  ) into v_refunds
  from public.refunds r
  where r.order_id = p_order_id;

  -- 10. Susun Respons Lengkap
  return jsonb_build_object(
    'restaurant', jsonb_build_object(
      'name', coalesce(v_settings.name, 'Nine Licious'),
      'address', v_settings.address,
      'phone', v_settings.phone,
      'logo_url', v_settings.logo_url,
      'receipt_header', v_settings.receipt_header,
      'receipt_footer', v_settings.receipt_footer,
      'receipt_width', coalesce(v_settings.receipt_width, 58)
    ),
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', v_order.order_number,
      'order_type', v_order.order_type,
      'table_name', v_table.name,
      'customer_name', v_order.customer_name,
      'status', v_order.status,
      'payment_status', v_order.payment_status,
      'queue_number', v_order.queue_number,
      'queue_date', v_order.queue_date,
      'cashier_name', coalesce(v_cashier.full_name, 'Kasir'),
      'created_at', v_order.created_at,
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
grant execute on function public.get_order_receipt_data(uuid) to authenticated;
grant execute on function public.get_order_receipt_data(uuid) to service_role;


-- -----------------------------------------------------------------------------
-- 5. PEMBARUAN RPC: get_dining_session_summary
-- Perbaikan: Proteksi Three-Valued Logic (3VL) pada otorisasi ringkasan sesi.
-- Mengganti `if v_user_role not in ('admin', 'kasir')` menjadi `if coalesce(v_user_role, '') not in ('admin', 'kasir')`.
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
    return jsonb_build_object(
      'table_id', v_table.id,
      'table_name', v_table.name,
      'table_status', v_table.status,
      'has_active_session', false
    );
  end if;

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
      'refunded_total', coalesce(o.refunded_total, 0),
      'remaining_balance', (o.grand_total - o.paid_total),
      'created_at', o.created_at
    ) order by o.created_at asc
  ) into v_orders
  from public.orders o
  where o.dining_session_id = v_session.id;

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
  where dining_session_id = v_session.id;

  select
    count(*),
    coalesce(sum(r.amount), 0)
  into v_pending_refund_count, v_session_pending_refund_total
  from public.refunds r
  join public.orders o on o.id = r.order_id
  where o.dining_session_id = v_session.id
    and r.status = 'pending';

  select count(*) into v_reserved_alloc_count
  from public.order_allocations oa
  join public.orders o on o.id = oa.order_id
  where o.dining_session_id = v_session.id
    and oa.allocation_status = 'reserved';

  select count(*) into v_pending_trx_count
  from public.midtrans_transactions mt
  join public.orders o on o.id = mt.order_id
  where o.dining_session_id = v_session.id
    and mt.lifecycle_status in (
      'initiated', 'token_created', 'pending', 'capture_challenge', 'reconciliation_required'
    );

  select count(*) into v_processing_webhook_count
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
    v_blocking_reason := 'Terdapat permohonan refund yang masih berstatus pending dan menunggu konfirmasi gateway.';
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
grant execute on function public.get_dining_session_summary(uuid) to authenticated;
grant execute on function public.get_dining_session_summary(uuid) to service_role;

commit;
