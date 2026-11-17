-- =============================================================================
-- Nine Licious POS - Idempotent Seed: Denah Restoran (Area Utama & Area Teras)
-- 
-- Fitur:
-- 1. Zona/Area: 'Utama' (Indoor Dining) dan 'Teras' (Outdoor Al Fresco)
-- 2. Meja Area Utama (10 Meja: A01-A10):
--    - A01 - A04 : Kapasitas 2 orang (Rectangle: 108x58)
--    - A05 - A07 : Kapasitas 4 orang (Rectangle: 116x63)
--    - A08 - A09 : Kapasitas 4 orang (Rectangle: 116x63)
--    - A10       : Kapasitas 6 orang (Rectangle: 124x69)
-- 3. Meja Area Teras (4 Meja: T01-T04):
--    - T01 - T02 : Kapasitas 2 orang (Round: 80x80)
--    - T03 - T04 : Kapasitas 4 orang (Rectangle: 116x63)
-- 4. Status terbit layout pada public.floor_plans untuk kedua zona
-- 5. Bersifat aman (idempotent), tidak menduplikasi jika dijalankan berulang kali.
-- =============================================================================

begin;

-- 1. Insert atau update zona 'Utama' dan 'Teras'
insert into public.table_zones (name, sort_order, is_active)
values 
  ('Utama', 10, true),
  ('Teras', 20, true)
on conflict (lower(name)) 
do update set 
  sort_order = excluded.sort_order,
  is_active = true,
  updated_at = now();

-- 2. Insert atau update 10 Meja di Area Utama
do $$
declare
  v_zone_id uuid;
begin
  select id into v_zone_id from public.table_zones where lower(name) = 'utama';

  insert into public.dining_tables (zone_id, name, capacity, position_x, position_y, shape, status, is_active)
  values
    (v_zone_id, 'A01', 2, 80,  80,  'rectangle', 'empty', true),
    (v_zone_id, 'A02', 2, 80,  200, 'rectangle', 'empty', true),
    (v_zone_id, 'A03', 2, 80,  320, 'rectangle', 'empty', true),
    (v_zone_id, 'A04', 2, 80,  440, 'rectangle', 'empty', true),
    (v_zone_id, 'A05', 4, 380, 120, 'rectangle', 'empty', true),
    (v_zone_id, 'A06', 4, 380, 280, 'rectangle', 'empty', true),
    (v_zone_id, 'A07', 4, 380, 440, 'rectangle', 'empty', true),
    (v_zone_id, 'A08', 4, 700, 120, 'rectangle', 'empty', true),
    (v_zone_id, 'A09', 4, 700, 280, 'rectangle', 'empty', true),
    (v_zone_id, 'A10', 6, 700, 440, 'rectangle', 'empty', true)
  on conflict (lower(name)) 
  do update set
    zone_id = excluded.zone_id,
    capacity = excluded.capacity,
    position_x = excluded.position_x,
    position_y = excluded.position_y,
    shape = excluded.shape,
    is_active = true,
    updated_at = now();
end $$;

-- 3. Insert atau update 4 Meja di Area Teras
do $$
declare
  v_zone_id uuid;
begin
  select id into v_zone_id from public.table_zones where lower(name) = 'teras';

  insert into public.dining_tables (zone_id, name, capacity, position_x, position_y, shape, status, is_active)
  values
    (v_zone_id, 'T01', 2, 250, 180, 'round',     'empty', true),
    (v_zone_id, 'T02', 2, 650, 180, 'round',     'empty', true),
    (v_zone_id, 'T03', 4, 250, 400, 'rectangle', 'empty', true),
    (v_zone_id, 'T04', 4, 650, 400, 'rectangle', 'empty', true)
  on conflict (lower(name)) 
  do update set
    zone_id = excluded.zone_id,
    capacity = excluded.capacity,
    position_x = excluded.position_x,
    position_y = excluded.position_y,
    shape = excluded.shape,
    is_active = true,
    updated_at = now();
end $$;

-- 4. Terbitkan layout denah untuk kedua zona
insert into public.floor_plans (zone_id, published_at)
select id, now()
from public.table_zones
where lower(name) in ('utama', 'teras')
on conflict (zone_id)
do update set
  published_at = now(),
  updated_at = now();

commit;
