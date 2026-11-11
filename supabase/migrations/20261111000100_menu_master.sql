-- ---------------------------------------------------------------------------
-- Nine Licious - F1.1 Menu & Master Data
--
-- Isi migration:
-- - kategori menu,
-- - produk (harga rupiah, foto, ketersediaan, stasiun dapur),
-- - grup dan opsi modifier,
-- - relasi produk-modifier,
-- - seed empat kategori utama,
-- - RLS, grant, index, trigger updated_at,
-- - bucket dan policy foto produk.
--
-- Jalankan file ini di Supabase SQL Editor setelah migration F0. Backup database
-- dan tinjau perubahan sebelum menjalankannya di production.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. Kategori menu
-- ---------------------------------------------------------------------------
create table if not exists public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  color text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint menu_categories_name_length_check check (
    char_length(btrim(name)) between 2 and 60
  ),
  constraint menu_categories_slug_format_check check (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    and char_length(slug) between 2 and 40
  ),
  constraint menu_categories_color_format_check check (
    color is null or color ~ '^#[0-9A-Fa-f]{6}$'
  ),
  constraint menu_categories_sort_order_check check (sort_order >= 0)
);

create unique index if not exists menu_categories_slug_unique_idx
  on public.menu_categories (slug);
create unique index if not exists menu_categories_name_unique_idx
  on public.menu_categories (lower(name));
create index if not exists menu_categories_sort_idx
  on public.menu_categories (is_active, sort_order, name);

-- ---------------------------------------------------------------------------
-- 2. Produk
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null
    references public.menu_categories (id) on delete restrict,
  name text not null,
  sku text,
  price integer not null,
  photo_url text,
  photo_path text,
  description text,
  is_active boolean not null default true,
  is_available boolean not null default true,
  kitchen_station text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_name_length_check check (
    char_length(btrim(name)) between 2 and 80
  ),
  constraint products_sku_format_check check (
    sku is null or sku ~ '^[A-Za-z0-9._-]{2,32}$'
  ),
  constraint products_price_check check (price >= 0),
  constraint products_description_length_check check (
    description is null or char_length(description) <= 500
  ),
  constraint products_kitchen_station_format_check check (
    kitchen_station is null
    or kitchen_station ~ '^[a-z][a-z0-9_]{1,31}$'
  ),
  constraint products_sort_order_check check (sort_order >= 0)
);

create unique index if not exists products_sku_unique_idx
  on public.products (lower(sku))
  where sku is not null;
create index if not exists products_category_sort_idx
  on public.products (category_id, is_active, sort_order, name);
create index if not exists products_availability_idx
  on public.products (is_active, is_available, sort_order);

-- ---------------------------------------------------------------------------
-- 3. Grup modifier
-- ---------------------------------------------------------------------------
create table if not exists public.modifier_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  selection_type text not null default 'single',
  is_required boolean not null default false,
  min_select integer not null default 0,
  max_select integer not null default 1,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint modifier_groups_name_length_check check (
    char_length(btrim(name)) between 2 and 60
  ),
  constraint modifier_groups_selection_type_check check (
    selection_type in ('single', 'multiple')
  ),
  constraint modifier_groups_limits_check check (
    min_select >= 0
    and max_select >= 1
    and max_select >= min_select
    and (
      selection_type <> 'single'
      or (min_select <= 1 and max_select = 1)
    )
    and (is_required = false or min_select >= 1)
    and (is_required = true or min_select = 0)
  ),
  constraint modifier_groups_sort_order_check check (sort_order >= 0)
);

create unique index if not exists modifier_groups_name_unique_idx
  on public.modifier_groups (lower(name));
create index if not exists modifier_groups_sort_idx
  on public.modifier_groups (is_active, sort_order, name);

-- ---------------------------------------------------------------------------
-- 4. Opsi modifier
-- ---------------------------------------------------------------------------
create table if not exists public.modifier_options (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null
    references public.modifier_groups (id) on delete cascade,
  name text not null,
  price_delta integer not null default 0,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint modifier_options_name_length_check check (
    char_length(btrim(name)) between 2 and 60
  ),
  constraint modifier_options_price_delta_check check (price_delta >= 0),
  constraint modifier_options_sort_order_check check (sort_order >= 0)
);

create unique index if not exists modifier_options_group_name_unique_idx
  on public.modifier_options (group_id, lower(name));
create index if not exists modifier_options_group_sort_idx
  on public.modifier_options (group_id, is_active, sort_order, name);

-- ---------------------------------------------------------------------------
-- 5. Relasi produk-modifier (many-to-many)
-- ---------------------------------------------------------------------------
create table if not exists public.product_modifier_groups (
  product_id uuid not null
    references public.products (id) on delete cascade,
  modifier_group_id uuid not null
    references public.modifier_groups (id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (product_id, modifier_group_id),
  constraint product_modifier_groups_sort_order_check check (sort_order >= 0)
);

create index if not exists product_modifier_groups_group_idx
  on public.product_modifier_groups (modifier_group_id, product_id);

-- ---------------------------------------------------------------------------
-- 6. Trigger updated_at
-- ---------------------------------------------------------------------------
drop trigger if exists menu_categories_set_updated_at
  on public.menu_categories;
create trigger menu_categories_set_updated_at
  before update on public.menu_categories
  for each row execute function public.set_updated_at();

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

drop trigger if exists modifier_groups_set_updated_at on public.modifier_groups;
create trigger modifier_groups_set_updated_at
  before update on public.modifier_groups
  for each row execute function public.set_updated_at();

drop trigger if exists modifier_options_set_updated_at on public.modifier_options;
create trigger modifier_options_set_updated_at
  before update on public.modifier_options
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. Seed empat kategori utama (master data, bukan data demo)
-- ---------------------------------------------------------------------------
insert into public.menu_categories (name, slug, sort_order, is_active)
values
  ('Food', 'food', 10, true),
  ('Drinks', 'drinks', 20, true),
  ('Desserts', 'desserts', 30, true),
  ('Packages', 'packages', 40, true)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 8. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.menu_categories enable row level security;
alter table public.products enable row level security;
alter table public.modifier_groups enable row level security;
alter table public.modifier_options enable row level security;
alter table public.product_modifier_groups enable row level security;

-- Semua staf aktif boleh membaca master menu untuk POS, KDS, dan laporan.
drop policy if exists menu_categories_select_staff on public.menu_categories;
create policy menu_categories_select_staff
  on public.menu_categories
  for select
  to authenticated
  using (public.current_user_role() is not null);

drop policy if exists products_select_staff on public.products;
create policy products_select_staff
  on public.products
  for select
  to authenticated
  using (public.current_user_role() is not null);

drop policy if exists modifier_groups_select_staff on public.modifier_groups;
create policy modifier_groups_select_staff
  on public.modifier_groups
  for select
  to authenticated
  using (public.current_user_role() is not null);

drop policy if exists modifier_options_select_staff on public.modifier_options;
create policy modifier_options_select_staff
  on public.modifier_options
  for select
  to authenticated
  using (public.current_user_role() is not null);

drop policy if exists product_modifier_groups_select_staff
  on public.product_modifier_groups;
create policy product_modifier_groups_select_staff
  on public.product_modifier_groups
  for select
  to authenticated
  using (public.current_user_role() is not null);

-- Hanya admin yang boleh menulis master menu. Server action tetap memakai
-- pemeriksaan peran eksplisit; RLS menjadi lapisan pertahanan kedua.
drop policy if exists menu_categories_insert_admin on public.menu_categories;
create policy menu_categories_insert_admin
  on public.menu_categories
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists menu_categories_update_admin on public.menu_categories;
create policy menu_categories_update_admin
  on public.menu_categories
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists menu_categories_delete_admin on public.menu_categories;
create policy menu_categories_delete_admin
  on public.menu_categories
  for delete
  to authenticated
  using (public.is_admin());

drop policy if exists products_insert_admin on public.products;
create policy products_insert_admin
  on public.products
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists products_update_admin on public.products;
create policy products_update_admin
  on public.products
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists products_delete_admin on public.products;
create policy products_delete_admin
  on public.products
  for delete
  to authenticated
  using (public.is_admin());

drop policy if exists modifier_groups_insert_admin on public.modifier_groups;
create policy modifier_groups_insert_admin
  on public.modifier_groups
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists modifier_groups_update_admin on public.modifier_groups;
create policy modifier_groups_update_admin
  on public.modifier_groups
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists modifier_groups_delete_admin on public.modifier_groups;
create policy modifier_groups_delete_admin
  on public.modifier_groups
  for delete
  to authenticated
  using (public.is_admin());

drop policy if exists modifier_options_insert_admin on public.modifier_options;
create policy modifier_options_insert_admin
  on public.modifier_options
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists modifier_options_update_admin on public.modifier_options;
create policy modifier_options_update_admin
  on public.modifier_options
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists modifier_options_delete_admin on public.modifier_options;
create policy modifier_options_delete_admin
  on public.modifier_options
  for delete
  to authenticated
  using (public.is_admin());

drop policy if exists product_modifier_groups_insert_admin
  on public.product_modifier_groups;
create policy product_modifier_groups_insert_admin
  on public.product_modifier_groups
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists product_modifier_groups_update_admin
  on public.product_modifier_groups;
create policy product_modifier_groups_update_admin
  on public.product_modifier_groups
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists product_modifier_groups_delete_admin
  on public.product_modifier_groups;
create policy product_modifier_groups_delete_admin
  on public.product_modifier_groups
  for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------
revoke all on public.menu_categories from anon;
revoke all on public.products from anon;
revoke all on public.modifier_groups from anon;
revoke all on public.modifier_options from anon;
revoke all on public.product_modifier_groups from anon;

grant select, insert, update, delete on public.menu_categories to authenticated;
grant select, insert, update, delete on public.products to authenticated;
grant select, insert, update, delete on public.modifier_groups to authenticated;
grant select, insert, update, delete on public.modifier_options to authenticated;
grant select, insert, update, delete on public.product_modifier_groups
  to authenticated;

grant all on public.menu_categories to service_role;
grant all on public.products to service_role;
grant all on public.modifier_groups to service_role;
grant all on public.modifier_options to service_role;
grant all on public.product_modifier_groups to service_role;

-- ---------------------------------------------------------------------------
-- 10. Storage foto produk
-- ---------------------------------------------------------------------------
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'product-photos',
  'product-photos',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists product_photos_select_public on storage.objects;
create policy product_photos_select_public
  on storage.objects
  for select
  to public
  using (bucket_id = 'product-photos');

drop policy if exists product_photos_insert_admin on storage.objects;
create policy product_photos_insert_admin
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'product-photos'
    and public.is_admin()
  );

drop policy if exists product_photos_update_admin on storage.objects;
create policy product_photos_update_admin
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'product-photos'
    and public.is_admin()
  )
  with check (
    bucket_id = 'product-photos'
    and public.is_admin()
  );

drop policy if exists product_photos_delete_admin on storage.objects;
create policy product_photos_delete_admin
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'product-photos'
    and public.is_admin()
  );

commit;
