-- ---------------------------------------------------------------------------
-- Nine Licious - F1.2 Tables & Floor Plan
--
-- Isi migration:
-- - zona/area meja,
-- - meja dine-in (nomor, kapasitas, posisi x/y, bentuk, status tampilan),
-- - status terbit layout per zona,
-- - seed zona default "Utama" sebagai master data,
-- - RLS, grant, index, trigger updated_at,
-- - proteksi zona yang masih memiliki meja aktif.
--
-- Catatan status meja:
-- Kolom dining_tables.status disediakan untuk merender tiga status pada F1.2.
-- Nilai status belum diubah oleh alur transaksi karena dining_sessions, orders,
-- dan payments baru dibuat pada F1.3/F2. Server action F1.2 tidak menyediakan
-- perubahan status manual; pengujian tiga status memakai data uji terkontrol.
-- Integrasi transisi status nyata mengikuti kunjungan/pesanan/pembayaran pada
-- F1.3 dan F2.
--
-- Jalankan file ini di Supabase SQL Editor setelah migration F0 dan F1.1.
-- Backup database dan tinjau perubahan sebelum menjalankannya di production.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. Zona/area meja
-- ---------------------------------------------------------------------------
create table if not exists public.table_zones (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint table_zones_name_length_check check (
    char_length(btrim(name)) between 2 and 40
  ),
  constraint table_zones_sort_order_check check (sort_order >= 0)
);

create unique index if not exists table_zones_name_unique_idx
  on public.table_zones (lower(name));
create index if not exists table_zones_sort_idx
  on public.table_zones (is_active, sort_order, name);

comment on table public.table_zones is
  'Zona/area meja restoran. Zona aktif menjadi pilihan area pada denah.';

-- ---------------------------------------------------------------------------
-- 2. Meja dine-in
-- ---------------------------------------------------------------------------
create table if not exists public.dining_tables (
  id uuid primary key default gen_random_uuid(),
  zone_id uuid not null
    references public.table_zones (id) on delete restrict,
  name text not null,
  capacity integer not null default 2,
  position_x integer not null default 0,
  position_y integer not null default 0,
  shape text not null default 'rectangle',
  status text not null default 'empty',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dining_tables_name_length_check check (
    char_length(btrim(name)) between 1 and 40
  ),
  constraint dining_tables_capacity_check check (capacity between 1 and 50),
  constraint dining_tables_position_x_check check (
    position_x >= 0 and position_x <= 1200
  ),
  constraint dining_tables_position_y_check check (
    position_y >= 0 and position_y <= 800
  ),
  constraint dining_tables_shape_check check (
    shape in ('rectangle', 'round')
  ),
  constraint dining_tables_status_check check (
    status in ('empty', 'awaiting_payment', 'occupied')
  )
);

-- Nomor/nama meja unik secara global agar tidak ambigu di POS dan KDS.
create unique index if not exists dining_tables_name_unique_idx
  on public.dining_tables (lower(name));
create index if not exists dining_tables_zone_idx
  on public.dining_tables (zone_id, is_active, name);
create index if not exists dining_tables_status_idx
  on public.dining_tables (is_active, status);

comment on table public.dining_tables is
  'Meja dine-in. Posisi memakai kanvas virtual 1200x800.';
comment on column public.dining_tables.status is
  'Status tampilan F1.2: empty, awaiting_payment, occupied. Transisi nyata di F1.3/F2.';
comment on column public.dining_tables.shape is
  'Bentuk tampilan meja pada denah: rectangle atau round.';

-- ---------------------------------------------------------------------------
-- 3. Status terbit layout per zona
-- ---------------------------------------------------------------------------
create table if not exists public.floor_plans (
  zone_id uuid primary key
    references public.table_zones (id) on delete cascade,
  published_at timestamptz,
  published_by uuid
    references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists floor_plans_published_idx
  on public.floor_plans (published_at desc);

comment on table public.floor_plans is
  'Metadata penerbitan layout denah per zona. Posisi aktual tersimpan di dining_tables.';

-- ---------------------------------------------------------------------------
-- 4. Seed zona default (master data, bukan data demo)
-- ---------------------------------------------------------------------------
insert into public.table_zones (name, sort_order, is_active)
values ('Utama', 10, true)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 5. Trigger updated_at
-- ---------------------------------------------------------------------------
drop trigger if exists table_zones_set_updated_at on public.table_zones;
create trigger table_zones_set_updated_at
  before update on public.table_zones
  for each row execute function public.set_updated_at();

drop trigger if exists dining_tables_set_updated_at on public.dining_tables;
create trigger dining_tables_set_updated_at
  before update on public.dining_tables
  for each row execute function public.set_updated_at();

drop trigger if exists floor_plans_set_updated_at on public.floor_plans;
create trigger floor_plans_set_updated_at
  before update on public.floor_plans
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Proteksi zona yang masih memiliki meja aktif
-- ---------------------------------------------------------------------------
create or replace function public.prevent_zone_deactivate_with_active_tables()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.is_active = true
     and new.is_active = false
     and exists (
       select 1
       from public.dining_tables
       where zone_id = old.id
         and is_active = true
     ) then
    raise exception
      'Zona masih memiliki meja aktif. Nonaktifkan atau pindahkan meja terlebih dahulu.';
  end if;

  return new;
end;
$$;

drop trigger if exists table_zones_prevent_deactivate
  on public.table_zones;
create trigger table_zones_prevent_deactivate
  before update on public.table_zones
  for each row execute function public.prevent_zone_deactivate_with_active_tables();

-- ---------------------------------------------------------------------------
-- 7. Fungsi update batch posisi meja (atomic / anti partial update)
-- ---------------------------------------------------------------------------
create or replace function public.update_table_positions(
  p_zone_id uuid,
  p_positions jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_expected integer;
begin
  if not public.is_admin() then
    raise exception 'Hanya admin yang dapat memperbarui posisi meja.';
  end if;

  if jsonb_typeof(p_positions) <> 'array' then
    raise exception 'Payload posisi meja harus berupa array.';
  end if;

  v_expected := jsonb_array_length(p_positions);
  if v_expected = 0 then
    return 0;
  end if;

  with updates as (
    select
      (item->>'id')::uuid as id,
      (item->>'x')::integer as x,
      (item->>'y')::integer as y
    from jsonb_array_elements(p_positions) as item
  ),
  applied as (
    update public.dining_tables dt
    set
      position_x = u.x,
      position_y = u.y
    from updates u
    where dt.id = u.id
      and dt.zone_id = p_zone_id
    returning dt.id
  )
  select count(*) into v_count from applied;

  if v_count <> v_expected then
    raise exception 'Gagal memperbarui seluruh posisi meja: diharapkan % meja, tetapi berhasil memperbarui % meja. Seluruh perubahan dibatalkan.', v_expected, v_count;
  end if;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.table_zones enable row level security;
alter table public.dining_tables enable row level security;
alter table public.floor_plans enable row level security;

-- Semua staf aktif boleh membaca zona, meja, dan status layout untuk POS/KDS.
drop policy if exists table_zones_select_staff on public.table_zones;
create policy table_zones_select_staff
  on public.table_zones
  for select
  to authenticated
  using (public.current_user_role() is not null);

drop policy if exists dining_tables_select_staff on public.dining_tables;
create policy dining_tables_select_staff
  on public.dining_tables
  for select
  to authenticated
  using (public.current_user_role() is not null);

drop policy if exists floor_plans_select_staff on public.floor_plans;
create policy floor_plans_select_staff
  on public.floor_plans
  for select
  to authenticated
  using (public.current_user_role() is not null);

-- Hanya admin yang boleh menulis zona, meja, dan status terbit layout.
-- Server action tetap memakai pemeriksaan peran eksplisit; RLS menjadi
-- lapisan pertahanan kedua.
drop policy if exists table_zones_insert_admin on public.table_zones;
create policy table_zones_insert_admin
  on public.table_zones
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists table_zones_update_admin on public.table_zones;
create policy table_zones_update_admin
  on public.table_zones
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists table_zones_delete_admin on public.table_zones;
create policy table_zones_delete_admin
  on public.table_zones
  for delete
  to authenticated
  using (public.is_admin());

drop policy if exists dining_tables_insert_admin on public.dining_tables;
create policy dining_tables_insert_admin
  on public.dining_tables
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists dining_tables_update_admin on public.dining_tables;
create policy dining_tables_update_admin
  on public.dining_tables
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists dining_tables_delete_admin on public.dining_tables;
create policy dining_tables_delete_admin
  on public.dining_tables
  for delete
  to authenticated
  using (public.is_admin());

drop policy if exists floor_plans_insert_admin on public.floor_plans;
create policy floor_plans_insert_admin
  on public.floor_plans
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists floor_plans_update_admin on public.floor_plans;
create policy floor_plans_update_admin
  on public.floor_plans
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists floor_plans_delete_admin on public.floor_plans;
create policy floor_plans_delete_admin
  on public.floor_plans
  for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------
revoke all on public.table_zones from anon;
revoke all on public.dining_tables from anon;
revoke all on public.floor_plans from anon;
revoke all on function public.update_table_positions(uuid, jsonb) from anon;

grant select, insert, update, delete on public.table_zones to authenticated;
grant select, insert, update, delete on public.dining_tables to authenticated;
grant select, insert, update, delete on public.floor_plans to authenticated;
grant execute on function public.update_table_positions(uuid, jsonb) to authenticated;

grant all on public.table_zones to service_role;
grant all on public.dining_tables to service_role;
grant all on public.floor_plans to service_role;
grant execute on function public.update_table_positions(uuid, jsonb) to service_role;

commit;
