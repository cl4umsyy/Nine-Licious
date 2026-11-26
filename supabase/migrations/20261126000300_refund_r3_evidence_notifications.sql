-- =============================================================================
-- NINE LICIOUS POS — REFUND SYSTEM MIGRATION R3: EVIDENCE & NOTIFICATIONS
-- File: supabase/migrations/20261126000300_refund_r3_evidence_notifications.sql
--
-- PRASYARAT: Migrations R1 & R2 sudah dijalankan.
--
-- TUJUAN:
-- 1. Membuat tabel public.refund_evidence untuk menyimpan metadata bukti
--    foto/video komplain pelanggan (opsional per pengajuan).
-- 2. Membuat bucket privat Supabase Storage 'refund-evidence' beserta
--    kebijakan RLS storage.objects (hanya admin & kasir aktif; anon & kitchen
--    ditolak).
-- 3. Membuat tabel persisten public.notifications untuk notifikasi real-time
--    lintas peran:
--    - Admin: pengajuan refund baru & koreksi
--    - Kasir: persetujuan, penolakan, pembatalan, permintaan bukti tambahan
--    - Kitchen (KDS): pembatalan item & tiket Replacement (tanpa data finansial)
-- 4. Mendaftarkan notifications, order_replacements, & kds_item_cancellations
--    ke publikasi supabase_realtime.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. TABEL BARU: public.refund_evidence
-- -----------------------------------------------------------------------------
create table if not exists public.refund_evidence (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null
    references public.refunds (id) on delete cascade,
  order_id uuid not null
    references public.orders (id) on delete restrict,
  file_path text not null unique
    check (char_length(btrim(file_path)) between 3 and 500),
  file_name text not null
    check (char_length(btrim(file_name)) between 1 and 255),
  file_type text not null
    check (file_type in (
      'image/jpeg',
      'image/png',
      'image/webp',
      'video/mp4',
      'video/webm',
      'video/quicktime'
    )),
  file_size bigint not null
    check (file_size > 0 and file_size <= 52428800),
  evidence_kind text not null
    check (evidence_kind in ('photo', 'video')),
  notes text
    check (notes is null or char_length(notes) <= 500),
  uploaded_by uuid not null
    references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);

comment on table public.refund_evidence is
  'Metadata file bukti foto atau video komplain pelanggan pada bucket privat refund-evidence.';

create index if not exists refund_evidence_refund_id_idx
  on public.refund_evidence (refund_id, created_at desc);

create index if not exists refund_evidence_order_id_idx
  on public.refund_evidence (order_id);

alter table public.refund_evidence enable row level security;

drop policy if exists refund_evidence_select_staff on public.refund_evidence;
create policy refund_evidence_select_staff
  on public.refund_evidence
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role in ('admin', 'kasir')
        and is_active = true
    )
  );

revoke all on public.refund_evidence from public, anon, authenticated;
grant select on public.refund_evidence to authenticated;
grant all on public.refund_evidence to service_role;


-- -----------------------------------------------------------------------------
-- 2. SUPABASE STORAGE: PRIVATE BUCKET 'refund-evidence' & STORAGE POLICIES
-- -----------------------------------------------------------------------------
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'refund-evidence',
  'refund-evidence',
  false,
  52428800,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'video/mp4',
    'video/webm',
    'video/quicktime'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists refund_evidence_storage_select_staff on storage.objects;
create policy refund_evidence_storage_select_staff
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'refund-evidence'
    and exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role in ('admin', 'kasir')
        and is_active = true
    )
  );

drop policy if exists refund_evidence_storage_insert_staff on storage.objects;
create policy refund_evidence_storage_insert_staff
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'refund-evidence'
    and exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role in ('admin', 'kasir')
        and is_active = true
    )
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists refund_evidence_storage_delete_admin on storage.objects;
create policy refund_evidence_storage_delete_admin
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'refund-evidence'
    and public.is_admin()
  );


-- -----------------------------------------------------------------------------
-- 3. TABEL BARU: public.notifications
-- -----------------------------------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null
    references public.profiles (id) on delete cascade,
  type text not null
    check (type in (
      'refund_requested',
      'refund_approved',
      'refund_rejected',
      'refund_cancelled',
      'refund_evidence_requested',
      'refund_payout_processing',
      'refund_payout_completed',
      'refund_payout_failed',
      'refund_corrected',
      'kds_item_cancelled',
      'kds_replacement_ticket'
    )),
  title text not null
    check (char_length(btrim(title)) between 2 and 160),
  message text not null
    check (char_length(btrim(message)) between 2 and 1000),
  reference_type text not null
    check (reference_type in ('refund', 'order', 'replacement')),
  reference_id text not null
    check (char_length(btrim(reference_id)) >= 1),
  metadata jsonb not null default '{}'::jsonb,
  is_read boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.notifications is
  'Notifikasi persisten per akun staf (admin, kasir, kitchen). Konten untuk kitchen wajib bebas nominal finansial dan bebas PII.';

create index if not exists notifications_recipient_unread_idx
  on public.notifications (recipient_id, is_read, created_at desc);

create index if not exists notifications_reference_idx
  on public.notifications (reference_type, reference_id);

-- Guard agar user hanya boleh mengubah is_read dan read_at saat UPDATE langsung
create or replace function public.protect_notification_payload_on_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    if new.recipient_id is distinct from old.recipient_id
       or new.type is distinct from old.type
       or new.title is distinct from old.title
       or new.message is distinct from old.message
       or new.reference_type is distinct from old.reference_type
       or new.reference_id is distinct from old.reference_id
       or new.metadata is distinct from old.metadata
       or new.created_at is distinct from old.created_at then
      raise exception 'Konten notifikasi bersifat permanen; hanya status baca (is_read) yang boleh diperbarui.';
    end if;

    if new.is_read = true and new.read_at is null then
      new.read_at := pg_catalog.now();
    elsif new.is_read = false then
      new.read_at := null;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.protect_notification_payload_on_update() from public, anon, authenticated, service_role;

drop trigger if exists trg_notifications_protect_payload on public.notifications;
create trigger trg_notifications_protect_payload
  before update on public.notifications
  for each row
  execute function public.protect_notification_payload_on_update();

alter table public.notifications enable row level security;

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own
  on public.notifications
  for select
  to authenticated
  using (recipient_id = auth.uid());

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own
  on public.notifications
  for update
  to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

revoke all on public.notifications from public, anon, authenticated;
grant select, update on public.notifications to authenticated;
grant all on public.notifications to service_role;


-- -----------------------------------------------------------------------------
-- 4. HELPER INTERNAL NOTIFIKASI & RPC TANDAI DIBACA
-- -----------------------------------------------------------------------------
create or replace function public.notify_user_internal(
  p_recipient_id uuid,
  p_type text,
  p_title text,
  p_message text,
  p_reference_type text,
  p_reference_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_recipient_id is null then
    return null;
  end if;

  insert into public.notifications (
    recipient_id,
    type,
    title,
    message,
    reference_type,
    reference_id,
    metadata
  ) values (
    p_recipient_id,
    p_type,
    pg_catalog.btrim(p_title),
    pg_catalog.btrim(p_message),
    p_reference_type,
    pg_catalog.btrim(p_reference_id),
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.notify_user_internal(uuid, text, text, text, text, text, jsonb) from public, anon, authenticated, service_role;

create or replace function public.notify_role_users_internal(
  p_roles text[],
  p_type text,
  p_title text,
  p_message text,
  p_reference_type text,
  p_reference_id text,
  p_metadata jsonb default '{}'::jsonb,
  p_exclude_user_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  if p_roles is null or pg_catalog.array_length(p_roles, 1) is null then
    return 0;
  end if;

  with inserted as (
    insert into public.notifications (
      recipient_id,
      type,
      title,
      message,
      reference_type,
      reference_id,
      metadata
    )
    select
      p.id,
      p_type,
      pg_catalog.btrim(p_title),
      pg_catalog.btrim(p_message),
      p_reference_type,
      pg_catalog.btrim(p_reference_id),
      coalesce(p_metadata, '{}'::jsonb)
    from public.profiles p
    where p.is_active = true
      and p.role = any(p_roles)
      and (p_exclude_user_id is null or p.id <> p_exclude_user_id)
    returning id
  )
  select count(*) into v_count from inserted;

  return v_count;
end;
$$;

revoke all on function public.notify_role_users_internal(text[], text, text, text, text, text, jsonb, uuid) from public, anon, authenticated, service_role;

create or replace function public.mark_notifications_read_atomic(
  p_notification_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_updated integer := 0;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Sesi pengguna tidak valid.';
  end if;

  if p_notification_id is not null then
    with upd as (
      update public.notifications
      set is_read = true,
          read_at = coalesce(read_at, pg_catalog.now())
      where id = p_notification_id
        and recipient_id = v_user_id
        and is_read = false
      returning id
    )
    select count(*) into v_updated from upd;
  else
    with upd as (
      update public.notifications
      set is_read = true,
          read_at = coalesce(read_at, pg_catalog.now())
      where recipient_id = v_user_id
        and is_read = false
      returning id
    )
    select count(*) into v_updated from upd;
  end if;

  return v_updated;
end;
$$;

revoke all on function public.mark_notifications_read_atomic(uuid) from public, anon;
grant execute on function public.mark_notifications_read_atomic(uuid) to authenticated;
grant execute on function public.mark_notifications_read_atomic(uuid) to service_role;


-- -----------------------------------------------------------------------------
-- 5. PUBLIKASI REALTIME UNTUK NOTIFIKASI & SINKRONISASI KDS REPLACEMENT
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
    ) then
      alter publication supabase_realtime add table public.notifications;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_replacements'
    ) then
      alter publication supabase_realtime add table public.order_replacements;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'kds_item_cancellations'
    ) then
      alter publication supabase_realtime add table public.kds_item_cancellations;
    end if;
  end if;
end $$;

commit;
