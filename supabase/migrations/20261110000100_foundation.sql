-- ---------------------------------------------------------------------------
-- Nine Licious - F0 foundation
-- Jalankan file ini di Supabase SQL Editor pada project Supabase utama.
-- Backup database dan tinjau perubahan sebelum menjalankannya di production.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. Profil staf
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  full_name text not null,
  role text not null default 'kasir',
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_format check (
    username = lower(username)
    and username ~ '^[a-z0-9._-]{3,32}$'
  ),
  constraint profiles_role_check check (role in ('admin', 'kasir', 'kitchen')),
  constraint profiles_full_name_length check (char_length(full_name) between 2 and 80)
);

create index if not exists profiles_role_active_idx
  on public.profiles (role, is_active);

-- ---------------------------------------------------------------------------
-- 2. Pengaturan restoran (satu baris)
-- ---------------------------------------------------------------------------
create table if not exists public.restaurant_settings (
  id integer primary key default 1,
  name text not null default 'Nine Licious',
  logo_url text,
  address text,
  phone text,
  receipt_header text,
  receipt_footer text,
  tax_percent numeric(5, 2) not null default 10,
  service_charge_percent numeric(5, 2) not null default 5,
  receipt_width integer not null default 58,
  operating_hours jsonb not null default '{}'::jsonb,
  holidays jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint restaurant_settings_singleton check (id = 1),
  constraint restaurant_settings_tax_check check (tax_percent between 0 and 100),
  constraint restaurant_settings_service_check check (
    service_charge_percent between 0 and 100
  ),
  constraint restaurant_settings_receipt_width_check check (
    receipt_width in (58, 80)
  )
);

insert into public.restaurant_settings (id, name)
values (1, 'Nine Licious')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Audit log
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  username text,
  action text not null,
  entity text,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  ip_hash text,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_created_at_idx
  on public.audit_logs (created_at desc);
create index if not exists audit_logs_user_id_idx
  on public.audit_logs (user_id, created_at desc);
create index if not exists audit_logs_action_idx
  on public.audit_logs (action, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Percobaan login (rate limiting)
-- ---------------------------------------------------------------------------
create table if not exists public.login_attempts (
  id bigint generated always as identity primary key,
  username text not null,
  ip_hash text,
  success boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists login_attempts_username_created_at_idx
  on public.login_attempts (username, created_at desc);
create index if not exists login_attempts_ip_hash_created_at_idx
  on public.login_attempts (ip_hash, created_at desc)
  where ip_hash is not null;
create index if not exists login_attempts_created_at_idx
  on public.login_attempts (created_at desc);

-- ---------------------------------------------------------------------------
-- 5. Urutan nomor harian (dipakai fase transaksi)
-- ---------------------------------------------------------------------------
create table if not exists public.daily_sequences (
  sequence_date date not null,
  sequence_name text not null,
  last_value integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (sequence_date, sequence_name)
);

-- ---------------------------------------------------------------------------
-- 6. Trigger updated_at
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists restaurant_settings_set_updated_at
  on public.restaurant_settings;
create trigger restaurant_settings_set_updated_at
  before update on public.restaurant_settings
  for each row execute function public.set_updated_at();

drop trigger if exists daily_sequences_set_updated_at on public.daily_sequences;
create trigger daily_sequences_set_updated_at
  before update on public.daily_sequences
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. Profil otomatis saat auth user dibuat
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
  v_full_name text;
  v_role text;
begin
  v_username := lower(
    coalesce(
      nullif(new.raw_user_meta_data ->> 'username', ''),
      split_part(new.email, '@', 1)
    )
  );
  v_username := regexp_replace(v_username, '[^a-z0-9._-]', '', 'g');
  v_username := left(v_username, 32);

  if char_length(v_username) < 3 then
    v_username := 'user-' || left(new.id::text, 8);
  end if;

  if exists (
    select 1
    from public.profiles
    where username = v_username
      and id <> new.id
  ) then
    v_username := left(v_username, 27) || '-' || left(new.id::text, 4);
  end if;

  v_full_name := coalesce(
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    v_username
  );
  v_full_name := left(v_full_name, 80);

  if char_length(v_full_name) < 2 then
    v_full_name := v_username;
  end if;
  v_role := coalesce(new.raw_app_meta_data ->> 'role', 'kasir');

  if v_role not in ('admin', 'kasir', 'kitchen') then
    v_role := 'kasir';
  end if;

  insert into public.profiles (id, username, full_name, role)
  values (new.id, v_username, v_full_name, v_role)
  on conflict (id) do update
    set username = excluded.username,
        full_name = excluded.full_name,
        role = excluded.role,
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 8. Helper RLS
-- ---------------------------------------------------------------------------
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.profiles
  where id = auth.uid()
    and is_active = true
  limit 1;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
      and is_active = true
  );
$$;

revoke all on function public.current_user_role() from public;
revoke all on function public.is_admin() from public;
grant execute on function public.current_user_role() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Lindungi admin aktif terakhir
-- ---------------------------------------------------------------------------
create or replace function public.protect_last_active_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role = 'admin'
     and old.is_active
     and (new.role <> 'admin' or new.is_active = false) then
    if (
      select count(*)
      from public.profiles
      where role = 'admin'
        and is_active = true
    ) <= 1 then
      raise exception
        'Admin aktif terakhir tidak dapat dinonaktifkan atau diubah perannya.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_protect_last_admin on public.profiles;
create trigger profiles_protect_last_admin
  before update on public.profiles
  for each row execute function public.protect_last_active_admin();

-- ---------------------------------------------------------------------------
-- 10. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.restaurant_settings enable row level security;
alter table public.audit_logs enable row level security;
alter table public.login_attempts enable row level security;
alter table public.daily_sequences enable row level security;

-- Profil: staf aktif boleh membaca profilnya sendiri; admin boleh membaca semua.
drop policy if exists profiles_select_self_or_admin on public.profiles;
create policy profiles_select_self_or_admin
  on public.profiles
  for select
  to authenticated
  using (
    (id = auth.uid() and is_active = true)
    or public.is_admin()
  );

-- Profil: hanya admin yang boleh mengubah. Perubahan role/status tetap
-- dilindungi trigger admin terakhir.
drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin
  on public.profiles
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Pengaturan restoran: semua staf aktif boleh membaca, admin boleh mengubah.
drop policy if exists restaurant_settings_select_staff
  on public.restaurant_settings;
create policy restaurant_settings_select_staff
  on public.restaurant_settings
  for select
  to authenticated
  using (public.current_user_role() is not null);

drop policy if exists restaurant_settings_update_admin
  on public.restaurant_settings;
create policy restaurant_settings_update_admin
  on public.restaurant_settings
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Audit log: hanya admin yang boleh membaca. Penulisan lewat service role.
drop policy if exists audit_logs_select_admin on public.audit_logs;
create policy audit_logs_select_admin
  on public.audit_logs
  for select
  to authenticated
  using (public.is_admin());

-- Percobaan login: hanya admin yang boleh membaca. Penulisan lewat service role.
drop policy if exists login_attempts_select_admin on public.login_attempts;
create policy login_attempts_select_admin
  on public.login_attempts
  for select
  to authenticated
  using (public.is_admin());

-- Urutan harian: untuk sementara hanya admin yang boleh membaca.
drop policy if exists daily_sequences_select_admin on public.daily_sequences;
create policy daily_sequences_select_admin
  on public.daily_sequences
  for select
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 11. Grants
-- ---------------------------------------------------------------------------
revoke all on public.profiles from anon;
revoke all on public.restaurant_settings from anon;
revoke all on public.audit_logs from anon;
revoke all on public.login_attempts from anon;
revoke all on public.daily_sequences from anon;

revoke insert, delete on public.profiles from authenticated;
revoke insert, delete on public.restaurant_settings from authenticated;
revoke insert, update, delete on public.audit_logs from authenticated;
revoke insert, update, delete on public.login_attempts from authenticated;
revoke insert, update, delete on public.daily_sequences from authenticated;

grant select, update on public.profiles to authenticated;
grant select, update on public.restaurant_settings to authenticated;
grant select on public.audit_logs to authenticated;
grant select on public.login_attempts to authenticated;
grant select on public.daily_sequences to authenticated;

grant all on public.profiles to service_role;
grant all on public.restaurant_settings to service_role;
grant all on public.audit_logs to service_role;
grant all on public.login_attempts to service_role;
grant all on public.daily_sequences to service_role;

grant usage, select on all sequences in schema public to service_role;

commit;
