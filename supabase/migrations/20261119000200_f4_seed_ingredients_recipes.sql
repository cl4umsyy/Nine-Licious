-- =============================================================================
-- NINE LICIOUS POS — F4.2 SEED: MASTER BAHAN BAKU, STOK AWAL & RESEP 41 PRODUK
-- =============================================================================
-- Tanggal: 19 November 2026
-- Prasyarat: Migrasi F4.1 (20261119000100_f4_inventory_stock.sql) sudah aktif.
-- Cakupan:
-- 1. Master 56 bahan baku terpadu (satuan g, ml, pcs + min_stock rasional).
-- 2. Stok awal beraudit untuk seluruh bahan baku (movement_type = 'manual_in', reason = 'Initial Stock').
-- 3. Resep porsi tunggal untuk seluruh 41 produk (13 Food, 12 Drinks, 10 Desserts, 6 Packages).
-- =============================================================================

begin;

-- Aktifkan izin mutasi internal untuk inisialisasi stok awal beraudit
set local nine_licious.allow_stock_mutation = 'on';

-- =============================================================================
-- 1. UPSERT MASTER BAHAN BAKU (56 BAHAN)
-- =============================================================================
insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-PROT-01', 'Ayam Fillet', 'g', 0, 3000, 'Dada & paha ayam fillet segar tanpa tulang', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-PROT-02', 'Sayap Ayam', 'pcs', 0, 60, 'Sayap ayam segar per pieces', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-PROT-03', 'Daging Sapi Slice', 'g', 0, 2000, 'Shortplate / brisket slice tipis 1.5mm', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-PROT-04', 'Daging Sapi Cincang', 'g', 0, 2000, 'Daging sapi cincang segar untuk saus bolognese', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-PROT-05', 'Daging Burger Sapi (Patty)', 'g', 0, 2000, 'Daging sapi giling bentuk patty burger', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-PROT-06', 'Ikan Dori Fillet', 'g', 0, 2000, 'Fillet ikan dori beku tanpa tulang', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-PROT-07', 'Beef Bacon', 'g', 0, 1000, 'Smoked beef bacon slice untuk carbonara', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-PROT-08', 'Telur Ayam', 'pcs', 0, 50, 'Telur ayam segar grade A per butir', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-CARB-01', 'Beras Putih', 'g', 0, 5000, 'Beras pulen pilihan kualitas premium', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-CARB-02', 'Pasta Spaghetti', 'g', 0, 2000, 'Spaghetti kering durum wheat semolina', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-CARB-03', 'Kentang Beku (French Fries)', 'g', 0, 3000, 'Shoestring / straight cut potato fries', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-CARB-04', 'Roti Burger Bun', 'pcs', 0, 20, 'Roti brioche bun tabur wijen', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-CARB-05', 'Roti Baguette', 'pcs', 0, 20, 'Roti baguette renyah untuk garlic bread', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-CARB-06', 'Biskuit Ladyfinger', 'pcs', 0, 30, 'Savoiardi ladyfingers untuk tiramisu', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-CARB-07', 'Biskuit Renyah (Crust)', 'g', 0, 500, 'Crushed graham/digestive crackers untuk cheesecake', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-FLOU-01', 'Tepung Terigu', 'g', 0, 2000, 'Tepung terigu serbaguna protein sedang', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-FLOU-02', 'Tepung Maizena', 'g', 0, 1000, 'Pati jagung pengental dan perenyah', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-FLOU-03', 'Tepung Panir', 'g', 0, 1000, 'Breadcrumbs putih renyah untuk katsu', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-01', 'Minyak Goreng', 'ml', 0, 5000, 'Minyak kelapa sawit murni untuk deep fry', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-02', 'Mentega (Butter)', 'g', 0, 1000, 'Mentega gurih serbaguna', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-03', 'Gula Pasir', 'g', 0, 3000, 'Gula pasir putih kristal', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-04', 'Gula Cair (Fruktosa)', 'ml', 0, 2000, 'Simple syrup pemanis minuman', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-05', 'Garam Dapur', 'g', 0, 500, 'Garam halus beriodium', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-06', 'Saus Tonkatsu', 'ml', 0, 1000, 'Saus gurih manis khas katsu Jepang', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-07', 'Saus Teriyaki', 'ml', 0, 1000, 'Saus teriyaki manis gurih beraroma shoyu', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-08', 'Saus Yakiniku', 'ml', 0, 1000, 'Saus yakiniku dengan aroma wijen dan bawang', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-09', 'Saus Lada Hitam', 'ml', 0, 1000, 'Saus black pepper pedas hangat', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-10', 'Saus Bolognese', 'ml', 0, 2000, 'Saus tomat pasta slow-cooked', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-11', 'Saus Barbeque', 'ml', 0, 1000, 'Saus BBQ smokey manis pedas', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-12', 'Saus Tartar', 'ml', 0, 1000, 'Saus tartar gurih asam segar untuk dori', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-13', 'Saus Burger Spesial', 'ml', 0, 1000, 'Racikan mayo, mustard, dan rempah burger', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-14', 'Bumbu Nasi Goreng Spesial', 'g', 0, 500, 'Pasta bumbu rempah nasi goreng Nine Licious', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-15', 'Bumbu Marinasi Ayam Crispy', 'g', 0, 500, 'Campuran rempah marinasi ayam crispy', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-16', 'Garlic Spread', 'g', 0, 500, 'Campuran mentega, bawang putih cincang, dan parsley', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-17', 'Biji Wijen Sangrai', 'g', 0, 200, 'Wijen putih sangrai harum untuk garnish', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-SEAS-18', 'Kerupuk Bawang', 'g', 0, 500, 'Kerupuk renyah pendamping nasi goreng', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-VEGE-01', 'Bawang Bombay', 'g', 0, 1000, 'Bawang bombay kuning segar', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-VEGE-02', 'Paprika Merah Hijau', 'g', 0, 500, 'Potongan paprika merah dan hijau segar', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-VEGE-03', 'Brokoli Segar', 'g', 0, 500, 'Brokoli hijau kukus pendamping teriyaki', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-VEGE-04', 'Selada Segar', 'g', 0, 500, 'Daun selada iceberg segar renyah', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-VEGE-05', 'Tomat Segar', 'g', 0, 500, 'Irisan tomat merah matang', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-VEGE-06', 'Jeruk Lemon Segar', 'pcs', 0, 20, 'Jeruk lemon kuning segar', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-VEGE-07', 'Buah Stroberi Segar', 'pcs', 0, 30, 'Stroberi segar untuk minuman & dessert', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-VEGE-08', 'Buah Leci Kaleng', 'pcs', 0, 30, 'Buah leci utuh manis kalengan', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-BEVG-01', 'Daun Teh Hitam Melati', 'g', 0, 1000, 'Daun teh melati wangi pilihan', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-BEVG-02', 'Biji Kopi Arabika Espresso', 'g', 0, 1000, 'Biji kopi sangrai medium-dark blend', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-BEVG-03', 'Susu Sapi Segar (Fresh Milk)', 'ml', 0, 5000, 'Susu pasteurisasi segar murni', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-BEVG-04', 'Bubuk Matcha Uji', 'g', 0, 500, 'Matcha bubuk murni kualitas Jepang', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-BEVG-05', 'Bubuk Cokelat Premium', 'g', 0, 1000, 'Kakao bubuk murni kaya rasa', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-BEVG-06', 'Bubuk Taro Ungu', 'g', 0, 500, 'Taro powder wangi manis khas talas', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-BEVG-07', 'Sirup Stroberi', 'ml', 0, 1000, 'Sirup konsentrat stroberi manis asam', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-BEVG-08', 'Sirup Leci', 'ml', 0, 1000, 'Sirup konsentrat aroma buah leci alami', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-BEVG-09', 'Puree Mangga', 'ml', 0, 1000, 'Puree mangga harum manis kental', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-BEVG-10', 'Selai Stroberi Chunks', 'g', 0, 1000, 'Selai stroberi homemade dengan bulir buah', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-BEVG-11', 'Susu Fermentasi Yakult', 'pcs', 0, 20, 'Botol Yakult probiotik 65ml per pcs', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-BEVG-12', 'Es Batu Kristal', 'g', 0, 10000, 'Es batu kristal tabung higienis', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-BEVG-13', 'Air Mineral', 'ml', 0, 10000, 'Air mineral murni galon higienis', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-01', 'Dark Chocolate Compound', 'g', 0, 2000, 'Cokelat blok hitam pekat untuk baking & lava', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-02', 'Saus Cokelat (Fudge)', 'ml', 0, 1000, 'Saus siraman cokelat kental mengkilap', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-03', 'Cream Cheese', 'g', 0, 1000, 'Keju krim padat lembut untuk cheesecake', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-04', 'Mascarpone Cheese', 'g', 0, 500, 'Keju mascarpone khas Italia untuk tiramisu', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-05', 'Keju Parmesan', 'g', 0, 500, 'Keju parmesan parut kering gurih', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-06', 'Keju Cheddar Slice', 'pcs', 0, 20, 'Keju cheddar lembaran leleh untuk burger', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-07', 'Whipping Cream Cair', 'ml', 0, 1000, 'Krim kental cair dairy 35% fat', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-08', 'Es Krim Vanila', 'g', 0, 2000, 'Es krim vanila madagaskar lembut', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-09', 'Es Krim Cokelat', 'g', 0, 2000, 'Es krim cokelat pekat lembut', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-10', 'Es Krim Stroberi', 'g', 0, 2000, 'Es krim stroberi manis segar dengan bulir', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-11', 'Sirup Maple', 'ml', 0, 1000, 'Sirup maple harum untuk waffle dan pancake', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-12', 'Selai Buah Berry', 'g', 0, 500, 'Selai buah berry untuk topping cheesecake', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-13', 'Saus Karamel Sutra', 'ml', 0, 500, 'Saus karamel gula leleh wangi untuk puding', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-14', 'Bubuk Agar-Agar / Gelatin', 'g', 0, 200, 'Bubuk pengental jeli puding', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-15', 'Kacang Kenari Cincang', 'g', 0, 300, 'Walnut panggang cincang untuk brownies', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();

insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('ING-DEST-16', 'Wafer Stik Cokelat', 'pcs', 0, 30, 'Wafer roll stik renyah hiasan es krim', true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();


-- =============================================================================
-- 2. STOK AWAL BERAUDIT (INITIAL STOCK DI BUKU BESAR STOCK_MOVEMENTS)
-- =============================================================================
do $$
declare
  v_ing record;
  v_initial_stocks jsonb := jsonb_build_object(
    'ING-PROT-01', 15000,
    'ING-PROT-02', 300,
    'ING-PROT-03', 10000,
    'ING-PROT-04', 10000,
    'ING-PROT-05', 8000,
    'ING-PROT-06', 8000,
    'ING-PROT-07', 5000,
    'ING-PROT-08', 300,
    'ING-CARB-01', 30000,
    'ING-CARB-02', 10000,
    'ING-CARB-03', 15000,
    'ING-CARB-04', 100,
    'ING-CARB-05', 80,
    'ING-CARB-06', 150,
    'ING-CARB-07', 3000,
    'ING-FLOU-01', 15000,
    'ING-FLOU-02', 5000,
    'ING-FLOU-03', 5000,
    'ING-SEAS-01', 25000,
    'ING-SEAS-02', 6000,
    'ING-SEAS-03', 15000,
    'ING-SEAS-04', 10000,
    'ING-SEAS-05', 3000,
    'ING-SEAS-06', 5000,
    'ING-SEAS-07', 5000,
    'ING-SEAS-08', 5000,
    'ING-SEAS-09', 5000,
    'ING-SEAS-10', 10000,
    'ING-SEAS-11', 5000,
    'ING-SEAS-12', 5000,
    'ING-SEAS-13', 5000,
    'ING-SEAS-14', 3000,
    'ING-SEAS-15', 3000,
    'ING-SEAS-16', 2000,
    'ING-SEAS-17', 1000,
    'ING-SEAS-18', 2500,
    'ING-VEGE-01', 5000,
    'ING-VEGE-02', 2500,
    'ING-VEGE-03', 2500,
    'ING-VEGE-04', 3000,
    'ING-VEGE-05', 3000,
    'ING-VEGE-06', 100,
    'ING-VEGE-07', 150,
    'ING-VEGE-08', 150,
    'ING-BEVG-01', 5000,
    'ING-BEVG-02', 8000,
    'ING-BEVG-03', 30000,
    'ING-BEVG-04', 3000,
    'ING-BEVG-05', 6000,
    'ING-BEVG-06', 4000,
    'ING-BEVG-07', 6000,
    'ING-BEVG-08', 6000,
    'ING-BEVG-09', 6000,
    'ING-BEVG-10', 5000,
    'ING-BEVG-11', 120,
    'ING-BEVG-12', 50000,
    'ING-BEVG-13', 60000,
    'ING-DEST-01', 10000,
    'ING-DEST-02', 5000,
    'ING-DEST-03', 6000,
    'ING-DEST-04', 3000,
    'ING-DEST-05', 3000,
    'ING-DEST-06', 100,
    'ING-DEST-07', 6000,
    'ING-DEST-08', 12000,
    'ING-DEST-09', 10000,
    'ING-DEST-10', 10000,
    'ING-DEST-11', 5000,
    'ING-DEST-12', 3000,
    'ING-DEST-13', 3000,
    'ING-DEST-14', 1500,
    'ING-DEST-15', 2000,
    'ING-DEST-16', 150
  );
  v_sku text;
  v_init_qty numeric(12, 3);
  v_before numeric(12, 3);
  v_after numeric(12, 3);
  v_admin_id uuid;
begin
  -- Ambil profile admin jika ada
  select id into v_admin_id from public.profiles where role = 'admin' and is_active = true limit 1;

  for v_sku, v_init_qty in select key, value::numeric from jsonb_each_text(v_initial_stocks) loop
    select * into v_ing from public.ingredients where sku = v_sku;
    if found and v_init_qty > 0 then
      -- Pemeriksaan idempotensi ketat: jika initial stock untuk SKU ini sudah pernah tercatat,
      -- lewati sepenuhnya agar eksekusi berulang tidak pernah menggandakan stok atau menimpa saldo operasional.
      perform 1 from public.stock_movements
      where ingredient_id = v_ing.id
        and idempotency_key = 'init_stock_' || v_sku;

      if not found and v_ing.current_stock = 0 then
        v_before := v_ing.current_stock;
        v_after := v_before + v_init_qty;

        perform set_config('nine_licious.allow_stock_mutation', 'on', true);

        update public.ingredients
        set current_stock = v_after,
            updated_at = now()
        where id = v_ing.id;

        insert into public.stock_movements (
          ingredient_id,
          movement_type,
          quantity_delta,
          stock_before,
          stock_after,
          reason,
          created_by,
          idempotency_key
        ) values (
          v_ing.id,
          'manual_in',
          v_init_qty,
          v_before,
          v_after,
          'Initial Stock',
          v_admin_id,
          'init_stock_' || v_sku
        ) on conflict (idempotency_key) do nothing;
      end if;
    end if;
  end loop;
end $$;

-- =============================================================================
-- 3. RESEP PORSI TUNGGAL UNTUK 41 PRODUK
-- =============================================================================
-- Resep Produk: FOOD-01
delete from public.recipes where product_id = (select id from public.products where sku = 'FOOD-01');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 150, 'Ayam potong / fillet'
from public.products p, public.ingredients i
where p.sku = 'FOOD-01' and i.sku = 'ING-PROT-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 40, 'Tepung terigu krispi'
from public.products p, public.ingredients i
where p.sku = 'FOOD-01' and i.sku = 'ING-FLOU-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 15, 'Tepung maizena perenyah'
from public.products p, public.ingredients i
where p.sku = 'FOOD-01' and i.sku = 'ING-FLOU-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, 'Telur ayam pengikat adonan'
from public.products p, public.ingredients i
where p.sku = 'FOOD-01' and i.sku = 'ING-PROT-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Minyak goreng porsi serap'
from public.products p, public.ingredients i
where p.sku = 'FOOD-01' and i.sku = 'ING-SEAS-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 10, 'Bumbu marinasi khas Nine Licious'
from public.products p, public.ingredients i
where p.sku = 'FOOD-01' and i.sku = 'ING-SEAS-15';

-- Resep Produk: FD-001
delete from public.recipes where product_id = (select id from public.products where sku = 'FD-001');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 150, 'Ayam fillet dada katsu'
from public.products p, public.ingredients i
where p.sku = 'FD-001' and i.sku = 'ING-PROT-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Beras pulen (1 porsi nasi)'
from public.products p, public.ingredients i
where p.sku = 'FD-001' and i.sku = 'ING-CARB-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Tepung terigu pelapis'
from public.products p, public.ingredients i
where p.sku = 'FD-001' and i.sku = 'ING-FLOU-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Tepung panir katsu'
from public.products p, public.ingredients i
where p.sku = 'FD-001' and i.sku = 'ING-FLOU-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, 'Telur ayam kocok'
from public.products p, public.ingredients i
where p.sku = 'FD-001' and i.sku = 'ING-PROT-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Minyak goreng katsu'
from public.products p, public.ingredients i
where p.sku = 'FD-001' and i.sku = 'ING-SEAS-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Saus tonkatsu siram'
from public.products p, public.ingredients i
where p.sku = 'FD-001' and i.sku = 'ING-SEAS-06';

-- Resep Produk: FD-002
delete from public.recipes where product_id = (select id from public.products where sku = 'FD-002');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 150, 'Ayam fillet potong dadu'
from public.products p, public.ingredients i
where p.sku = 'FD-002' and i.sku = 'ING-PROT-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Beras pulen (1 porsi nasi)'
from public.products p, public.ingredients i
where p.sku = 'FD-002' and i.sku = 'ING-CARB-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Saus teriyaki manis gurih'
from public.products p, public.ingredients i
where p.sku = 'FD-002' and i.sku = 'ING-SEAS-07';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 3, 'Biji wijen sangrai tabur'
from public.products p, public.ingredients i
where p.sku = 'FD-002' and i.sku = 'ING-SEAS-17';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 40, 'Brokoli kukus segar'
from public.products p, public.ingredients i
where p.sku = 'FD-002' and i.sku = 'ING-VEGE-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 10, 'Minyak tumis'
from public.products p, public.ingredients i
where p.sku = 'FD-002' and i.sku = 'ING-SEAS-01';

-- Resep Produk: FD-003
delete from public.recipes where product_id = (select id from public.products where sku = 'FD-003');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Daging sapi slice premium'
from public.products p, public.ingredients i
where p.sku = 'FD-003' and i.sku = 'ING-PROT-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Beras pulen (1 porsi nasi)'
from public.products p, public.ingredients i
where p.sku = 'FD-003' and i.sku = 'ING-CARB-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Bawang bombay iris'
from public.products p, public.ingredients i
where p.sku = 'FD-003' and i.sku = 'ING-VEGE-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Saus yakiniku harum'
from public.products p, public.ingredients i
where p.sku = 'FD-003' and i.sku = 'ING-SEAS-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 10, 'Minyak tumis'
from public.products p, public.ingredients i
where p.sku = 'FD-003' and i.sku = 'ING-SEAS-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 3, 'Biji wijen sangrai tabur'
from public.products p, public.ingredients i
where p.sku = 'FD-003' and i.sku = 'ING-SEAS-17';

-- Resep Produk: FD-004
delete from public.recipes where product_id = (select id from public.products where sku = 'FD-004');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 150, 'Ayam fillet potong dadu'
from public.products p, public.ingredients i
where p.sku = 'FD-004' and i.sku = 'ING-PROT-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Beras pulen (1 porsi nasi)'
from public.products p, public.ingredients i
where p.sku = 'FD-004' and i.sku = 'ING-CARB-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Saus lada hitam gurih pedas'
from public.products p, public.ingredients i
where p.sku = 'FD-004' and i.sku = 'ING-SEAS-09';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Bawang bombay iris'
from public.products p, public.ingredients i
where p.sku = 'FD-004' and i.sku = 'ING-VEGE-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Paprika merah hijau'
from public.products p, public.ingredients i
where p.sku = 'FD-004' and i.sku = 'ING-VEGE-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 10, 'Minyak tumis'
from public.products p, public.ingredients i
where p.sku = 'FD-004' and i.sku = 'ING-SEAS-01';

-- Resep Produk: FD-005
delete from public.recipes where product_id = (select id from public.products where sku = 'FD-005');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Beras pulen (1 porsi nasi)'
from public.products p, public.ingredients i
where p.sku = 'FD-005' and i.sku = 'ING-CARB-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 2, '1 butir orak-arik + 1 butir ceplok'
from public.products p, public.ingredients i
where p.sku = 'FD-005' and i.sku = 'ING-PROT-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 50, 'Ayam suwir spesial'
from public.products p, public.ingredients i
where p.sku = 'FD-005' and i.sku = 'ING-PROT-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Bumbu nasi goreng spesial'
from public.products p, public.ingredients i
where p.sku = 'FD-005' and i.sku = 'ING-SEAS-14';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 15, 'Minyak goreng tumis'
from public.products p, public.ingredients i
where p.sku = 'FD-005' and i.sku = 'ING-SEAS-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 10, 'Kerupuk pendamping renyah'
from public.products p, public.ingredients i
where p.sku = 'FD-005' and i.sku = 'ING-SEAS-18';

-- Resep Produk: FD-006
delete from public.recipes where product_id = (select id from public.products where sku = 'FD-006');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Pasta spaghetti kering'
from public.products p, public.ingredients i
where p.sku = 'FD-006' and i.sku = 'ING-CARB-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 80, 'Daging sapi cincang segar'
from public.products p, public.ingredients i
where p.sku = 'FD-006' and i.sku = 'ING-PROT-04';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Saus tomat ragu bolognese'
from public.products p, public.ingredients i
where p.sku = 'FD-006' and i.sku = 'ING-SEAS-10';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 10, 'Keju parmesan parut tabur'
from public.products p, public.ingredients i
where p.sku = 'FD-006' and i.sku = 'ING-DEST-05';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 10, 'Minyak tumis saus'
from public.products p, public.ingredients i
where p.sku = 'FD-006' and i.sku = 'ING-SEAS-01';

-- Resep Produk: FD-007
delete from public.recipes where product_id = (select id from public.products where sku = 'FD-007');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Pasta spaghetti kering'
from public.products p, public.ingredients i
where p.sku = 'FD-007' and i.sku = 'ING-CARB-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 40, 'Beef bacon renyah'
from public.products p, public.ingredients i
where p.sku = 'FD-007' and i.sku = 'ING-PROT-07';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 80, 'Susu segar krim carbonara'
from public.products p, public.ingredients i
where p.sku = 'FD-007' and i.sku = 'ING-BEVG-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 15, 'Keju parmesan gurih'
from public.products p, public.ingredients i
where p.sku = 'FD-007' and i.sku = 'ING-DEST-05';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, 'Kuning telur pengental saus'
from public.products p, public.ingredients i
where p.sku = 'FD-007' and i.sku = 'ING-PROT-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 10, 'Mentega tumis bacon'
from public.products p, public.ingredients i
where p.sku = 'FD-007' and i.sku = 'ING-SEAS-02';

-- Resep Produk: FD-008
delete from public.recipes where product_id = (select id from public.products where sku = 'FD-008');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 6, '6 pcs sayap ayam segar'
from public.products p, public.ingredients i
where p.sku = 'FD-008' and i.sku = 'ING-PROT-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 40, 'Saus barbeque manis gurih'
from public.products p, public.ingredients i
where p.sku = 'FD-008' and i.sku = 'ING-SEAS-11';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Minyak goreng sayap'
from public.products p, public.ingredients i
where p.sku = 'FD-008' and i.sku = 'ING-SEAS-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 3, 'Biji wijen sangrai tabur'
from public.products p, public.ingredients i
where p.sku = 'FD-008' and i.sku = 'ING-SEAS-17';

-- Resep Produk: FD-009
delete from public.recipes where product_id = (select id from public.products where sku = 'FD-009');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 150, 'Kentang beku french fries'
from public.products p, public.ingredients i
where p.sku = 'FD-009' and i.sku = 'ING-CARB-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Minyak goreng kentang'
from public.products p, public.ingredients i
where p.sku = 'FD-009' and i.sku = 'ING-SEAS-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 3, 'Garam laut bumbu tabur'
from public.products p, public.ingredients i
where p.sku = 'FD-009' and i.sku = 'ING-SEAS-05';

-- Resep Produk: FD-010
delete from public.recipes where product_id = (select id from public.products where sku = 'FD-010');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, '1 pcs roti burger bun wijen'
from public.products p, public.ingredients i
where p.sku = 'FD-010' and i.sku = 'ING-CARB-04';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Patty daging sapi panggang'
from public.products p, public.ingredients i
where p.sku = 'FD-010' and i.sku = 'ING-PROT-05';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, '1 lembar keju cheddar leleh'
from public.products p, public.ingredients i
where p.sku = 'FD-010' and i.sku = 'ING-DEST-06';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Daun selada segar'
from public.products p, public.ingredients i
where p.sku = 'FD-010' and i.sku = 'ING-VEGE-04';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Irisan tomat segar'
from public.products p, public.ingredients i
where p.sku = 'FD-010' and i.sku = 'ING-VEGE-05';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Saus burger spesial Nine Licious'
from public.products p, public.ingredients i
where p.sku = 'FD-010' and i.sku = 'ING-SEAS-13';

-- Resep Produk: FD-011
delete from public.recipes where product_id = (select id from public.products where sku = 'FD-011');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, '1 pcs roti burger bun wijen'
from public.products p, public.ingredients i
where p.sku = 'FD-011' and i.sku = 'ING-CARB-04';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Paha ayam fillet patty'
from public.products p, public.ingredients i
where p.sku = 'FD-011' and i.sku = 'ING-PROT-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Tepung krispi buttermilk'
from public.products p, public.ingredients i
where p.sku = 'FD-011' and i.sku = 'ING-FLOU-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Minyak goreng patty ayam'
from public.products p, public.ingredients i
where p.sku = 'FD-011' and i.sku = 'ING-SEAS-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Coleslaw & selada segar'
from public.products p, public.ingredients i
where p.sku = 'FD-011' and i.sku = 'ING-VEGE-04';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Saus mayo pedas burger'
from public.products p, public.ingredients i
where p.sku = 'FD-011' and i.sku = 'ING-SEAS-13';

-- Resep Produk: FD-012
delete from public.recipes where product_id = (select id from public.products where sku = 'FD-012');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 150, 'Fillet ikan dori segar'
from public.products p, public.ingredients i
where p.sku = 'FD-012' and i.sku = 'ING-PROT-06';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Kentang goreng pendamping'
from public.products p, public.ingredients i
where p.sku = 'FD-012' and i.sku = 'ING-CARB-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 40, 'Tepung batter renyah dori'
from public.products p, public.ingredients i
where p.sku = 'FD-012' and i.sku = 'ING-FLOU-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 40, 'Minyak goreng deep fry'
from public.products p, public.ingredients i
where p.sku = 'FD-012' and i.sku = 'ING-SEAS-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Saus tartar segar'
from public.products p, public.ingredients i
where p.sku = 'FD-012' and i.sku = 'ING-SEAS-12';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 0.5, 'Setengah buah lemon segar'
from public.products p, public.ingredients i
where p.sku = 'FD-012' and i.sku = 'ING-VEGE-06';

-- Resep Produk: DR-001
delete from public.recipes where product_id = (select id from public.products where sku = 'DR-001');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 5, 'Daun teh melati seduh'
from public.products p, public.ingredients i
where p.sku = 'DR-001' and i.sku = 'ING-BEVG-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Gula pasir pemanis'
from public.products p, public.ingredients i
where p.sku = 'DR-001' and i.sku = 'ING-SEAS-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Es batu kristal dingin'
from public.products p, public.ingredients i
where p.sku = 'DR-001' and i.sku = 'ING-BEVG-12';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 200, 'Air seduhan teh'
from public.products p, public.ingredients i
where p.sku = 'DR-001' and i.sku = 'ING-BEVG-13';

-- Resep Produk: DR-002
delete from public.recipes where product_id = (select id from public.products where sku = 'DR-002');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 5, 'Daun teh melati seduh'
from public.products p, public.ingredients i
where p.sku = 'DR-002' and i.sku = 'ING-BEVG-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 0.5, 'Perasan & irisan lemon segar'
from public.products p, public.ingredients i
where p.sku = 'DR-002' and i.sku = 'ING-VEGE-06';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Gula pasir penyeimbang asam'
from public.products p, public.ingredients i
where p.sku = 'DR-002' and i.sku = 'ING-SEAS-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Es batu kristal'
from public.products p, public.ingredients i
where p.sku = 'DR-002' and i.sku = 'ING-BEVG-12';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 180, 'Air seduhan teh'
from public.products p, public.ingredients i
where p.sku = 'DR-002' and i.sku = 'ING-BEVG-13';

-- Resep Produk: DR-003
delete from public.recipes where product_id = (select id from public.products where sku = 'DR-003');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 5, 'Daun teh melati seduh'
from public.products p, public.ingredients i
where p.sku = 'DR-003' and i.sku = 'ING-BEVG-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Sirup leci manis alami'
from public.products p, public.ingredients i
where p.sku = 'DR-003' and i.sku = 'ING-BEVG-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 2, '2 pcs buah leci utuh segar'
from public.products p, public.ingredients i
where p.sku = 'DR-003' and i.sku = 'ING-VEGE-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Es batu kristal'
from public.products p, public.ingredients i
where p.sku = 'DR-003' and i.sku = 'ING-BEVG-12';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 180, 'Air seduhan teh'
from public.products p, public.ingredients i
where p.sku = 'DR-003' and i.sku = 'ING-BEVG-13';

-- Resep Produk: DR-004
delete from public.recipes where product_id = (select id from public.products where sku = 'DR-004');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 5, 'Daun teh melati seduh'
from public.products p, public.ingredients i
where p.sku = 'DR-004' and i.sku = 'ING-BEVG-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Sirup stroberi segar'
from public.products p, public.ingredients i
where p.sku = 'DR-004' and i.sku = 'ING-BEVG-07';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 2, '2 pcs buah stroberi potong'
from public.products p, public.ingredients i
where p.sku = 'DR-004' and i.sku = 'ING-VEGE-07';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Es batu kristal'
from public.products p, public.ingredients i
where p.sku = 'DR-004' and i.sku = 'ING-BEVG-12';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 180, 'Air seduhan teh'
from public.products p, public.ingredients i
where p.sku = 'DR-004' and i.sku = 'ING-BEVG-13';

-- Resep Produk: DR-005
delete from public.recipes where product_id = (select id from public.products where sku = 'DR-005');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 15, 'Bubuk matcha Uji murni'
from public.products p, public.ingredients i
where p.sku = 'DR-005' and i.sku = 'ING-BEVG-04';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 180, 'Susu sapi segar dingin'
from public.products p, public.ingredients i
where p.sku = 'DR-005' and i.sku = 'ING-BEVG-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Gula cair pemanis'
from public.products p, public.ingredients i
where p.sku = 'DR-005' and i.sku = 'ING-SEAS-04';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Es batu kristal'
from public.products p, public.ingredients i
where p.sku = 'DR-005' and i.sku = 'ING-BEVG-12';

-- Resep Produk: DR-006
delete from public.recipes where product_id = (select id from public.products where sku = 'DR-006');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Bubuk kakao premium'
from public.products p, public.ingredients i
where p.sku = 'DR-006' and i.sku = 'ING-BEVG-05';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 180, 'Susu sapi segar'
from public.products p, public.ingredients i
where p.sku = 'DR-006' and i.sku = 'ING-BEVG-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Saus cokelat pekat siram'
from public.products p, public.ingredients i
where p.sku = 'DR-006' and i.sku = 'ING-DEST-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Es batu kristal'
from public.products p, public.ingredients i
where p.sku = 'DR-006' and i.sku = 'ING-BEVG-12';

-- Resep Produk: DR-007
delete from public.recipes where product_id = (select id from public.products where sku = 'DR-007');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 180, 'Susu sapi segar dingin'
from public.products p, public.ingredients i
where p.sku = 'DR-007' and i.sku = 'ING-BEVG-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 40, 'Selai stroberi chunks homemade'
from public.products p, public.ingredients i
where p.sku = 'DR-007' and i.sku = 'ING-BEVG-10';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, 'Buah stroberi segar garnish'
from public.products p, public.ingredients i
where p.sku = 'DR-007' and i.sku = 'ING-VEGE-07';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Es batu kristal'
from public.products p, public.ingredients i
where p.sku = 'DR-007' and i.sku = 'ING-BEVG-12';

-- Resep Produk: DR-008
delete from public.recipes where product_id = (select id from public.products where sku = 'DR-008');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Bubuk taro ungu wangi'
from public.products p, public.ingredients i
where p.sku = 'DR-008' and i.sku = 'ING-BEVG-06';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 180, 'Susu sapi segar'
from public.products p, public.ingredients i
where p.sku = 'DR-008' and i.sku = 'ING-BEVG-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 15, 'Gula cair pemanis'
from public.products p, public.ingredients i
where p.sku = 'DR-008' and i.sku = 'ING-SEAS-04';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Es batu kristal'
from public.products p, public.ingredients i
where p.sku = 'DR-008' and i.sku = 'ING-BEVG-12';

-- Resep Produk: DR-009
delete from public.recipes where product_id = (select id from public.products where sku = 'DR-009');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 18, 'Biji kopi espresso arabika'
from public.products p, public.ingredients i
where p.sku = 'DR-009' and i.sku = 'ING-BEVG-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 180, 'Steamed fresh milk mikro foam'
from public.products p, public.ingredients i
where p.sku = 'DR-009' and i.sku = 'ING-BEVG-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 10, 'Gula cair (opsional rasa)'
from public.products p, public.ingredients i
where p.sku = 'DR-009' and i.sku = 'ING-SEAS-04';

-- Resep Produk: DR-010
delete from public.recipes where product_id = (select id from public.products where sku = 'DR-010');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 18, 'Double shot espresso arabika'
from public.products p, public.ingredients i
where p.sku = 'DR-010' and i.sku = 'ING-BEVG-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 180, 'Air mineral dingin/panas'
from public.products p, public.ingredients i
where p.sku = 'DR-010' and i.sku = 'ING-BEVG-13';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Es batu kristal'
from public.products p, public.ingredients i
where p.sku = 'DR-010' and i.sku = 'ING-BEVG-12';

-- Resep Produk: DR-011
delete from public.recipes where product_id = (select id from public.products where sku = 'DR-011');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 18, 'Biji kopi espresso arabika'
from public.products p, public.ingredients i
where p.sku = 'DR-011' and i.sku = 'ING-BEVG-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 140, 'Steamed milk busa tebal'
from public.products p, public.ingredients i
where p.sku = 'DR-011' and i.sku = 'ING-BEVG-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 2, 'Bubuk cokelat tabur atas'
from public.products p, public.ingredients i
where p.sku = 'DR-011' and i.sku = 'ING-BEVG-05';

-- Resep Produk: DR-012
delete from public.recipes where product_id = (select id from public.products where sku = 'DR-012');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 40, 'Puree mangga manis kental'
from public.products p, public.ingredients i
where p.sku = 'DR-012' and i.sku = 'ING-BEVG-09';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, '1 botol Yakult probiotik'
from public.products p, public.ingredients i
where p.sku = 'DR-012' and i.sku = 'ING-BEVG-11';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Es batu kristal'
from public.products p, public.ingredients i
where p.sku = 'DR-012' and i.sku = 'ING-BEVG-12';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 80, 'Air mineral penyeimbang'
from public.products p, public.ingredients i
where p.sku = 'DR-012' and i.sku = 'ING-BEVG-13';

-- Resep Produk: DS-001
delete from public.recipes where product_id = (select id from public.products where sku = 'DS-001');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 50, 'Dark chocolate compound lumer'
from public.products p, public.ingredients i
where p.sku = 'DS-001' and i.sku = 'ING-DEST-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Mentega leleh cake'
from public.products p, public.ingredients i
where p.sku = 'DS-001' and i.sku = 'ING-SEAS-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, 'Telur ayam adonan'
from public.products p, public.ingredients i
where p.sku = 'DS-001' and i.sku = 'ING-PROT-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Gula pasir adonan'
from public.products p, public.ingredients i
where p.sku = 'DS-001' and i.sku = 'ING-SEAS-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Tepung terigu cake'
from public.products p, public.ingredients i
where p.sku = 'DS-001' and i.sku = 'ING-FLOU-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 50, '1 scoop es krim vanila pendamping'
from public.products p, public.ingredients i
where p.sku = 'DS-001' and i.sku = 'ING-DEST-08';

-- Resep Produk: DS-002
delete from public.recipes where product_id = (select id from public.products where sku = 'DS-002');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 40, 'Dark chocolate compound'
from public.products p, public.ingredients i
where p.sku = 'DS-002' and i.sku = 'ING-DEST-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Tepung terigu brownies'
from public.products p, public.ingredients i
where p.sku = 'DS-002' and i.sku = 'ING-FLOU-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Mentega leleh'
from public.products p, public.ingredients i
where p.sku = 'DS-002' and i.sku = 'ING-SEAS-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, 'Telur ayam'
from public.products p, public.ingredients i
where p.sku = 'DS-002' and i.sku = 'ING-PROT-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Gula pasir'
from public.products p, public.ingredients i
where p.sku = 'DS-002' and i.sku = 'ING-SEAS-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 10, 'Kacang kenari cincang tabur'
from public.products p, public.ingredients i
where p.sku = 'DS-002' and i.sku = 'ING-DEST-15';

-- Resep Produk: DS-003
delete from public.recipes where product_id = (select id from public.products where sku = 'DS-003');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 60, 'Cream cheese padat lembut'
from public.products p, public.ingredients i
where p.sku = 'DS-003' and i.sku = 'ING-DEST-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Crust biskuit renyah dasar'
from public.products p, public.ingredients i
where p.sku = 'DS-003' and i.sku = 'ING-CARB-07';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Whipping cream cair'
from public.products p, public.ingredients i
where p.sku = 'DS-003' and i.sku = 'ING-DEST-07';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Gula pasir pemanis'
from public.products p, public.ingredients i
where p.sku = 'DS-003' and i.sku = 'ING-SEAS-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 15, 'Selai buah berry siram'
from public.products p, public.ingredients i
where p.sku = 'DS-003' and i.sku = 'ING-DEST-12';

-- Resep Produk: DS-004
delete from public.recipes where product_id = (select id from public.products where sku = 'DS-004');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 3, '3 pcs biskuit ladyfinger'
from public.products p, public.ingredients i
where p.sku = 'DS-004' and i.sku = 'ING-CARB-06';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 50, 'Keju mascarpone lembut'
from public.products p, public.ingredients i
where p.sku = 'DS-004' and i.sku = 'ING-DEST-04';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 10, 'Kopi espresso celupan biskuit'
from public.products p, public.ingredients i
where p.sku = 'DS-004' and i.sku = 'ING-BEVG-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Whipping cream kocok'
from public.products p, public.ingredients i
where p.sku = 'DS-004' and i.sku = 'ING-DEST-07';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 5, 'Bubuk kakao tabur atas'
from public.products p, public.ingredients i
where p.sku = 'DS-004' and i.sku = 'ING-BEVG-05';

-- Resep Produk: DS-005
delete from public.recipes where product_id = (select id from public.products where sku = 'DS-005');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 60, 'Tepung terigu adonan waffle'
from public.products p, public.ingredients i
where p.sku = 'DS-005' and i.sku = 'ING-FLOU-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 60, 'Susu sapi segar'
from public.products p, public.ingredients i
where p.sku = 'DS-005' and i.sku = 'ING-BEVG-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, 'Telur ayam'
from public.products p, public.ingredients i
where p.sku = 'DS-005' and i.sku = 'ING-PROT-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 15, 'Mentega leleh waffle'
from public.products p, public.ingredients i
where p.sku = 'DS-005' and i.sku = 'ING-SEAS-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Sirup maple siraman hangat'
from public.products p, public.ingredients i
where p.sku = 'DS-005' and i.sku = 'ING-DEST-11';

-- Resep Produk: DS-006
delete from public.recipes where product_id = (select id from public.products where sku = 'DS-006');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 60, 'Tepung terigu adonan pancake'
from public.products p, public.ingredients i
where p.sku = 'DS-006' and i.sku = 'ING-FLOU-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 70, 'Susu sapi segar'
from public.products p, public.ingredients i
where p.sku = 'DS-006' and i.sku = 'ING-BEVG-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, 'Telur ayam'
from public.products p, public.ingredients i
where p.sku = 'DS-006' and i.sku = 'ING-PROT-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 15, 'Mentega leleh pancake'
from public.products p, public.ingredients i
where p.sku = 'DS-006' and i.sku = 'ING-SEAS-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Sirup maple siraman manis'
from public.products p, public.ingredients i
where p.sku = 'DS-006' and i.sku = 'ING-DEST-11';

-- Resep Produk: DS-007
delete from public.recipes where product_id = (select id from public.products where sku = 'DS-007');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Susu sapi segar sutra'
from public.products p, public.ingredients i
where p.sku = 'DS-007' and i.sku = 'ING-BEVG-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 5, 'Bubuk agar-agar jeli'
from public.products p, public.ingredients i
where p.sku = 'DS-007' and i.sku = 'ING-DEST-14';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Gula pasir adonan'
from public.products p, public.ingredients i
where p.sku = 'DS-007' and i.sku = 'ING-SEAS-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Saus karamel lumer harum'
from public.products p, public.ingredients i
where p.sku = 'DS-007' and i.sku = 'ING-DEST-13';

-- Resep Produk: DS-008
delete from public.recipes where product_id = (select id from public.products where sku = 'DS-008');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, '3 scoop es krim vanila (40g x 3)'
from public.products p, public.ingredients i
where p.sku = 'DS-008' and i.sku = 'ING-DEST-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, '1 pcs wafer stik hiasan'
from public.products p, public.ingredients i
where p.sku = 'DS-008' and i.sku = 'ING-DEST-16';

-- Resep Produk: DS-009
delete from public.recipes where product_id = (select id from public.products where sku = 'DS-009');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, '3 scoop es krim cokelat (40g x 3)'
from public.products p, public.ingredients i
where p.sku = 'DS-009' and i.sku = 'ING-DEST-09';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 15, 'Saus cokelat siraman'
from public.products p, public.ingredients i
where p.sku = 'DS-009' and i.sku = 'ING-DEST-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, '1 pcs wafer stik hiasan'
from public.products p, public.ingredients i
where p.sku = 'DS-009' and i.sku = 'ING-DEST-16';

-- Resep Produk: DS-010
delete from public.recipes where product_id = (select id from public.products where sku = 'DS-010');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, '3 scoop es krim stroberi (40g x 3)'
from public.products p, public.ingredients i
where p.sku = 'DS-010' and i.sku = 'ING-DEST-10';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, '1 pcs buah stroberi garnish'
from public.products p, public.ingredients i
where p.sku = 'DS-010' and i.sku = 'ING-VEGE-07';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, '1 pcs wafer stik hiasan'
from public.products p, public.ingredients i
where p.sku = 'DS-010' and i.sku = 'ING-DEST-16';

-- Resep Produk: PK-001
delete from public.recipes where product_id = (select id from public.products where sku = 'PK-001');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 150, 'Ayam fillet katsu paket'
from public.products p, public.ingredients i
where p.sku = 'PK-001' and i.sku = 'ING-PROT-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Beras pulen 1 porsi nasi'
from public.products p, public.ingredients i
where p.sku = 'PK-001' and i.sku = 'ING-CARB-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Tepung terigu katsu'
from public.products p, public.ingredients i
where p.sku = 'PK-001' and i.sku = 'ING-FLOU-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Tepung panir katsu'
from public.products p, public.ingredients i
where p.sku = 'PK-001' and i.sku = 'ING-FLOU-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, 'Telur ayam katsu'
from public.products p, public.ingredients i
where p.sku = 'PK-001' and i.sku = 'ING-PROT-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Saus tonkatsu katsu'
from public.products p, public.ingredients i
where p.sku = 'PK-001' and i.sku = 'ING-SEAS-06';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 80, 'Kentang goreng porsi kecil paket'
from public.products p, public.ingredients i
where p.sku = 'PK-001' and i.sku = 'ING-CARB-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 35, 'Minyak goreng katsu & fries'
from public.products p, public.ingredients i
where p.sku = 'PK-001' and i.sku = 'ING-SEAS-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 2, 'Garam tabur kentang'
from public.products p, public.ingredients i
where p.sku = 'PK-001' and i.sku = 'ING-SEAS-05';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 5, 'Daun teh Iced Tea paket'
from public.products p, public.ingredients i
where p.sku = 'PK-001' and i.sku = 'ING-BEVG-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Gula pasir Iced Tea paket'
from public.products p, public.ingredients i
where p.sku = 'PK-001' and i.sku = 'ING-SEAS-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Es batu kristal'
from public.products p, public.ingredients i
where p.sku = 'PK-001' and i.sku = 'ING-BEVG-12';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 200, 'Air seduhan teh'
from public.products p, public.ingredients i
where p.sku = 'PK-001' and i.sku = 'ING-BEVG-13';

-- Resep Produk: PK-002
delete from public.recipes where product_id = (select id from public.products where sku = 'PK-002');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 150, 'Ayam fillet teriyaki paket'
from public.products p, public.ingredients i
where p.sku = 'PK-002' and i.sku = 'ING-PROT-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Beras pulen 1 porsi nasi'
from public.products p, public.ingredients i
where p.sku = 'PK-002' and i.sku = 'ING-CARB-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Saus teriyaki paket'
from public.products p, public.ingredients i
where p.sku = 'PK-002' and i.sku = 'ING-SEAS-07';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 3, 'Biji wijen sangrai'
from public.products p, public.ingredients i
where p.sku = 'PK-002' and i.sku = 'ING-SEAS-17';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 40, 'Brokoli kukus segar'
from public.products p, public.ingredients i
where p.sku = 'PK-002' and i.sku = 'ING-VEGE-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 80, 'Kentang goreng porsi kecil paket'
from public.products p, public.ingredients i
where p.sku = 'PK-002' and i.sku = 'ING-CARB-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Minyak goreng teriyaki & fries'
from public.products p, public.ingredients i
where p.sku = 'PK-002' and i.sku = 'ING-SEAS-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 2, 'Garam tabur kentang'
from public.products p, public.ingredients i
where p.sku = 'PK-002' and i.sku = 'ING-SEAS-05';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 5, 'Daun teh Iced Tea paket'
from public.products p, public.ingredients i
where p.sku = 'PK-002' and i.sku = 'ING-BEVG-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Gula pasir Iced Tea paket'
from public.products p, public.ingredients i
where p.sku = 'PK-002' and i.sku = 'ING-SEAS-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Es batu kristal'
from public.products p, public.ingredients i
where p.sku = 'PK-002' and i.sku = 'ING-BEVG-12';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 200, 'Air seduhan teh'
from public.products p, public.ingredients i
where p.sku = 'PK-002' and i.sku = 'ING-BEVG-13';

-- Resep Produk: PK-003
delete from public.recipes where product_id = (select id from public.products where sku = 'PK-003');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, 'Roti burger bun wijen'
from public.products p, public.ingredients i
where p.sku = 'PK-003' and i.sku = 'ING-CARB-04';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Patty daging sapi burger'
from public.products p, public.ingredients i
where p.sku = 'PK-003' and i.sku = 'ING-PROT-05';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, 'Keju cheddar slice leleh'
from public.products p, public.ingredients i
where p.sku = 'PK-003' and i.sku = 'ING-DEST-06';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Selada segar burger'
from public.products p, public.ingredients i
where p.sku = 'PK-003' and i.sku = 'ING-VEGE-04';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Tomat segar burger'
from public.products p, public.ingredients i
where p.sku = 'PK-003' and i.sku = 'ING-VEGE-05';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Saus burger spesial'
from public.products p, public.ingredients i
where p.sku = 'PK-003' and i.sku = 'ING-SEAS-13';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Kentang goreng paket'
from public.products p, public.ingredients i
where p.sku = 'PK-003' and i.sku = 'ING-CARB-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Minyak goreng kentang'
from public.products p, public.ingredients i
where p.sku = 'PK-003' and i.sku = 'ING-SEAS-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 2, 'Garam tabur kentang'
from public.products p, public.ingredients i
where p.sku = 'PK-003' and i.sku = 'ING-SEAS-05';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 5, 'Daun teh Lemon Tea paket'
from public.products p, public.ingredients i
where p.sku = 'PK-003' and i.sku = 'ING-BEVG-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 0.5, 'Jeruk lemon segar perasan'
from public.products p, public.ingredients i
where p.sku = 'PK-003' and i.sku = 'ING-VEGE-06';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Gula pasir Lemon Tea paket'
from public.products p, public.ingredients i
where p.sku = 'PK-003' and i.sku = 'ING-SEAS-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Es batu kristal'
from public.products p, public.ingredients i
where p.sku = 'PK-003' and i.sku = 'ING-BEVG-12';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 180, 'Air seduhan teh'
from public.products p, public.ingredients i
where p.sku = 'PK-003' and i.sku = 'ING-BEVG-13';

-- Resep Produk: PK-004
delete from public.recipes where product_id = (select id from public.products where sku = 'PK-004');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 6, '6 pcs sayap ayam paket'
from public.products p, public.ingredients i
where p.sku = 'PK-004' and i.sku = 'ING-PROT-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 40, 'Saus barbeque wings'
from public.products p, public.ingredients i
where p.sku = 'PK-004' and i.sku = 'ING-SEAS-11';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 30, 'Minyak goreng sayap'
from public.products p, public.ingredients i
where p.sku = 'PK-004' and i.sku = 'ING-SEAS-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 3, 'Biji wijen sangrai'
from public.products p, public.ingredients i
where p.sku = 'PK-004' and i.sku = 'ING-SEAS-17';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Beras pulen 1 porsi nasi'
from public.products p, public.ingredients i
where p.sku = 'PK-004' and i.sku = 'ING-CARB-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 5, 'Daun teh Iced Tea paket'
from public.products p, public.ingredients i
where p.sku = 'PK-004' and i.sku = 'ING-BEVG-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Gula pasir Iced Tea paket'
from public.products p, public.ingredients i
where p.sku = 'PK-004' and i.sku = 'ING-SEAS-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Es batu kristal'
from public.products p, public.ingredients i
where p.sku = 'PK-004' and i.sku = 'ING-BEVG-12';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 200, 'Air seduhan teh'
from public.products p, public.ingredients i
where p.sku = 'PK-004' and i.sku = 'ING-BEVG-13';

-- Resep Produk: PK-005
delete from public.recipes where product_id = (select id from public.products where sku = 'PK-005');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Pasta spaghetti bolognese paket'
from public.products p, public.ingredients i
where p.sku = 'PK-005' and i.sku = 'ING-CARB-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 80, 'Daging sapi cincang saus'
from public.products p, public.ingredients i
where p.sku = 'PK-005' and i.sku = 'ING-PROT-04';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Saus tomat ragu bolognese'
from public.products p, public.ingredients i
where p.sku = 'PK-005' and i.sku = 'ING-SEAS-10';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 10, 'Keju parmesan parut'
from public.products p, public.ingredients i
where p.sku = 'PK-005' and i.sku = 'ING-DEST-05';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 10, 'Minyak tumis saus'
from public.products p, public.ingredients i
where p.sku = 'PK-005' and i.sku = 'ING-SEAS-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 2, '2 pcs roti baguette garlic bread'
from public.products p, public.ingredients i
where p.sku = 'PK-005' and i.sku = 'ING-CARB-05';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 15, 'Mentega olesan garlic bread'
from public.products p, public.ingredients i
where p.sku = 'PK-005' and i.sku = 'ING-SEAS-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 10, 'Garlic spread bawang putih'
from public.products p, public.ingredients i
where p.sku = 'PK-005' and i.sku = 'ING-SEAS-16';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 5, 'Daun teh Lemon Tea paket'
from public.products p, public.ingredients i
where p.sku = 'PK-005' and i.sku = 'ING-BEVG-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 0.5, 'Jeruk lemon segar perasan'
from public.products p, public.ingredients i
where p.sku = 'PK-005' and i.sku = 'ING-VEGE-06';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Gula pasir Lemon Tea paket'
from public.products p, public.ingredients i
where p.sku = 'PK-005' and i.sku = 'ING-SEAS-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 120, 'Es batu kristal'
from public.products p, public.ingredients i
where p.sku = 'PK-005' and i.sku = 'ING-BEVG-12';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 180, 'Air seduhan teh'
from public.products p, public.ingredients i
where p.sku = 'PK-005' and i.sku = 'ING-BEVG-13';

-- Resep Produk: PK-006
delete from public.recipes where product_id = (select id from public.products where sku = 'PK-006');
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 50, 'Dark chocolate compound lava cake'
from public.products p, public.ingredients i
where p.sku = 'PK-006' and i.sku = 'ING-DEST-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Mentega leleh lava cake'
from public.products p, public.ingredients i
where p.sku = 'PK-006' and i.sku = 'ING-SEAS-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 1, 'Telur ayam lava cake'
from public.products p, public.ingredients i
where p.sku = 'PK-006' and i.sku = 'ING-PROT-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 25, 'Gula pasir lava cake'
from public.products p, public.ingredients i
where p.sku = 'PK-006' and i.sku = 'ING-SEAS-03';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 20, 'Tepung terigu lava cake'
from public.products p, public.ingredients i
where p.sku = 'PK-006' and i.sku = 'ING-FLOU-01';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 50, '1 scoop es krim vanila pendamping'
from public.products p, public.ingredients i
where p.sku = 'PK-006' and i.sku = 'ING-DEST-08';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 18, 'Biji kopi espresso Americano'
from public.products p, public.ingredients i
where p.sku = 'PK-006' and i.sku = 'ING-BEVG-02';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 180, 'Air mineral Americano'
from public.products p, public.ingredients i
where p.sku = 'PK-006' and i.sku = 'ING-BEVG-13';
insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, 100, 'Es batu kristal Americano'
from public.products p, public.ingredients i
where p.sku = 'PK-006' and i.sku = 'ING-BEVG-12';

commit;
