-- =============================================================================
-- NINE LICIOUS POS — HARDENING: WAJIB SHIFT AKTIF SEBELUM MEMBUAT / MENAMBAH PESANAN
-- File: supabase/migrations/20261125000100_require_active_shift_for_pos_orders.sql
--
-- TUJUAN:
-- Menegakkan aturan pada level PostgreSQL sehingga kasir/staf terautentikasi
-- tidak dapat membuat pesanan baru, membuat pesanan tambahan, membuka sesi meja,
-- atau menambahkan item ke pesanan tanpa memiliki shift aktif (status = 'open').
--
-- CATATAN:
-- - Aturan ini hanya berlaku untuk operasi pembuatan/penambahan pesanan
--   (INSERT pada dining_sessions, orders, order_items) saat auth.uid() tersedia.
-- - Alur pembayaran Midtrans (webhook, rekonsiliasi, retry Snap), settlement,
--   refund, KDS, dan pemeliharaan service_role tidak terpengaruh.
-- =============================================================================

begin;

create or replace function public.assert_active_cashier_shift_for_order_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_shift_id uuid;
begin
  v_actor_id := auth.uid();

  -- Lewati bila dijalankan dari service_role internal / webhook / maintenance (auth.uid() IS NULL)
  if v_actor_id is null then
    return new;
  end if;

  select id
  into v_shift_id
  from public.shifts
  where cashier_id = v_actor_id
    and status = 'open'
    and closed_at is null
  limit 1;

  if not found then
    raise exception 'SHIFT_NOT_OPEN: Shift kasir belum dibuka atau sudah ditutup. Buka shift terlebih dahulu sebelum membuat atau menambah pesanan.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_dining_sessions_require_active_shift on public.dining_sessions;
create trigger trg_dining_sessions_require_active_shift
  before insert on public.dining_sessions
  for each row
  execute function public.assert_active_cashier_shift_for_order_mutation();

drop trigger if exists trg_orders_require_active_shift on public.orders;
create trigger trg_orders_require_active_shift
  before insert on public.orders
  for each row
  execute function public.assert_active_cashier_shift_for_order_mutation();

drop trigger if exists trg_order_items_require_active_shift on public.order_items;
create trigger trg_order_items_require_active_shift
  before insert on public.order_items
  for each row
  execute function public.assert_active_cashier_shift_for_order_mutation();

commit;
