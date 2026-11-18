-- =============================================================================
-- NINE LICIOUS POS — ORDER SERVING CONFIRMATION (KONFIRMASI PENYAJIAN PESANAN)
-- =============================================================================
-- Menambahkan pencatatan waktu penyajian (served_at) dan petugas yang
-- mengonfirmasi penyajian (served_by) pada tabel public.orders, beserta RPC
-- atomik confirm_order_served_atomic(p_order_id uuid).
--
-- Perlindungan fitur lama:
-- - Tidak mengubah constraint 3 status KDS (queued, preparing, ready).
-- - Tidak mengubah fungsi complete_pos_order atau close_dining_session_atomic.
-- - Tidak mengubah tabel/status dining_sessions, dining_tables, payments, refunds.
-- - Konfirmasi penyajian bersifat terpisah dari penyelesaian transaksi & tutup sesi meja.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tambah kolom served_at dan served_by pada public.orders
-- -----------------------------------------------------------------------------
alter table public.orders
  add column if not exists served_at timestamptz,
  add column if not exists served_by uuid
    references public.profiles (id) on delete set null;

comment on column public.orders.served_at is
  'Waktu pesanan dikonfirmasi sudah diambil/disajikan kepada pelanggan oleh kasir/admin.';

comment on column public.orders.served_by is
  'ID profil petugas (admin/kasir) yang mengonfirmasi penyajian pesanan. Menjadi NULL jika profil dihapus (ON DELETE SET NULL) tanpa menghapus riwayat served_at.';

-- Pastikan served_by tidak pernah terisi jika served_at masih NULL,
-- sekaligus tetap aman terhadap ON DELETE SET NULL ketika profil petugas dihapus
-- (served_at tetap tersimpan walau served_by menjadi NULL).
alter table public.orders
  drop constraint if exists orders_served_at_by_sync_check;

alter table public.orders
  add constraint orders_served_at_by_sync_check
  check (served_by is null or served_at is not null);

-- Partial index untuk mempercepat query daftar "Menunggu Disajikan" di POS & KDS
create index if not exists orders_pending_serving_idx
  on public.orders (updated_at asc, created_at asc)
  where (status = 'paid' and kds_status = 'ready' and served_at is null);

create index if not exists orders_served_at_idx
  on public.orders (served_at desc)
  where (served_at is not null);

-- -----------------------------------------------------------------------------
-- 2. RPC Atomik: public.confirm_order_served_atomic(p_order_id uuid)
-- -----------------------------------------------------------------------------
create or replace function public.confirm_order_served_atomic(
  p_order_id uuid
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
  v_order record;
  v_now timestamptz := now();
begin
  -- 1. Otorisasi ketat berbasis sesi pengguna terverifikasi:
  --    - Tolak jika auth.uid() NULL (anonim atau pemanggilan tanpa konteks user).
  --    - Verifikasi langsung ke public.profiles bahwa akun aktif dan ber-role admin/kasir.
  --    - Tolak tegas role kitchen maupun role lain.
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Autentikasi sesi pengguna diperlukan untuk mengonfirmasi penyajian pesanan.';
  end if;

  select role, username, is_active
  into v_user_role, v_username, v_is_active
  from public.profiles
  where id = v_user_id;

  if not found
     or v_is_active is distinct from true
     or v_user_role is null
     or v_user_role not in ('admin', 'kasir') then
    raise exception 'Hanya admin atau kasir aktif yang berhak mengonfirmasi penyajian pesanan.';
  end if;

  if p_order_id is null then
    raise exception 'ID pesanan tidak valid.';
  end if;

  -- 2. Kunci baris pesanan secara atomik untuk mencegah race condition & double-click
  select *
  into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pesanan tidak ditemukan.';
  end if;

  -- 3. Cegah konfirmasi ganda
  if v_order.served_at is not null then
    raise exception 'Pesanan #% sudah pernah dikonfirmasi disajikan sebelumnya.', v_order.order_number;
  end if;

  -- 4. Validasi status pesanan & status pembayaran
  if v_order.status = 'refunded' then
    raise exception 'Pesanan #% telah direfund penuh dan tidak dapat dikonfirmasi disajikan.', v_order.order_number;
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'Pesanan #% telah dibatalkan dan tidak dapat dikonfirmasi disajikan.', v_order.order_number;
  end if;

  if v_order.status = 'completed' then
    raise exception 'Pesanan #% sudah berstatus selesai.', v_order.order_number;
  end if;

  if v_order.status <> 'paid'
     or v_order.payment_status not in ('paid', 'partially_refunded')
     or coalesce(v_order.paid_total, 0) < coalesce(v_order.grand_total, 0) then
    raise exception 'Hanya pesanan yang sudah lunas yang dapat dikonfirmasi penyajiannya.';
  end if;

  -- 5. Validasi status KDS harus 'ready'
  if v_order.kds_status is distinct from 'ready' then
    raise exception 'Pesanan #% belum berstatus Siap Diambil dari dapur (status KDS saat ini: %).',
      v_order.order_number,
      coalesce(v_order.kds_status, 'tidak aktif');
  end if;

  -- 6. Mutasi atomik HANYA pada served_at, served_by, updated_at
  --    Tidak mengubah status, payment_status, kds_status, dining_sessions, maupun dining_tables.
  update public.orders
  set
    served_at = v_now,
    served_by = v_user_id,
    updated_at = v_now
  where id = p_order_id
    and status = 'paid'
    and payment_status in ('paid', 'partially_refunded')
    and kds_status = 'ready'
    and served_at is null;

  if not found then
    raise exception 'Status pesanan #% berubah bersamaan. Silakan muat ulang daftar penyajian.', v_order.order_number;
  end if;

  -- 7. Catat jejak audit permanen dalam transaksi yang sama
  insert into public.audit_logs (
    action,
    user_id,
    username,
    entity,
    entity_id,
    details
  ) values (
    'order.served_confirmed',
    v_user_id,
    v_username,
    'order',
    p_order_id::text,
    jsonb_build_object(
      'order_number', v_order.order_number,
      'queue_number', v_order.queue_number,
      'order_type', v_order.order_type,
      'table_id', v_order.table_id,
      'dining_session_id', v_order.dining_session_id,
      'served_at', v_now,
      'served_by', v_user_id,
      'actor_role', v_user_role
    )
  );

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'queue_number', v_order.queue_number,
    'order_type', v_order.order_type,
    'table_id', v_order.table_id,
    'dining_session_id', v_order.dining_session_id,
    'served_at', v_now,
    'served_by', v_user_id
  );
end;
$$;

-- Prinsip hak akses minimal (Least Privilege):
-- Hanya authenticated user (dengan konteks JWT auth.uid()) yang dapat memanggil RPC ini.
-- Tolak tegas public, anon, dan service_role.
revoke all on function public.confirm_order_served_atomic(uuid) from public;
revoke all on function public.confirm_order_served_atomic(uuid) from anon;
revoke all on function public.confirm_order_served_atomic(uuid) from service_role;
grant execute on function public.confirm_order_served_atomic(uuid) to authenticated;
