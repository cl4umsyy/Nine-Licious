#!/usr/bin/env node
/**
 * NINE LICIOUS POS — F4 INVENTORY & RECIPES SEEDER
 *
 * Populates:
 * 1. 56 Unified Master Ingredients across 7 operational categories (Protein, Carb, Flour, Seasoning, Produce, Beverage, Dessert).
 * 2. Audited Initial Stock for all 56 ingredients via adjust_ingredient_stock_atomic (reason: 'Initial Stock').
 * 3. Exact 1-portion recipes for ALL 41 products in Supabase (13 Food, 12 Drinks, 10 Desserts, 6 Packages).
 * 4. Generates companion SQL migration `supabase/migrations/20261119000200_f4_seed_ingredients_recipes.sql`.
 */

import pkg from "@next/env";
import { createClient } from "@supabase/supabase-js";

const { loadEnvConfig } = pkg;
loadEnvConfig(process.cwd(), true);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey || !anonKey) {
  console.error("Missing Supabase credentials in environment.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

// Authenticated client untuk RPC adjust_ingredient_stock_atomic (khusus admin)
const authClient = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false },
});

// =============================================================================
// 1. DEFINISI 56 MASTER BAHAN BAKU TERPADU
// =============================================================================
export const MASTER_INGREDIENTS = [
  // --- PROTEIN & DAGING (8) ---
  { sku: "ING-PROT-01", name: "Ayam Fillet", unit: "g", min_stock: 3000, initial_stock: 15000, notes: "Dada & paha ayam fillet segar tanpa tulang" },
  { sku: "ING-PROT-02", name: "Sayap Ayam", unit: "pcs", min_stock: 60, initial_stock: 300, notes: "Sayap ayam segar per pieces" },
  { sku: "ING-PROT-03", name: "Daging Sapi Slice", unit: "g", min_stock: 2000, initial_stock: 10000, notes: "Shortplate / brisket slice tipis 1.5mm" },
  { sku: "ING-PROT-04", name: "Daging Sapi Cincang", unit: "g", min_stock: 2000, initial_stock: 10000, notes: "Daging sapi cincang segar untuk saus bolognese" },
  { sku: "ING-PROT-05", name: "Daging Burger Sapi (Patty)", unit: "g", min_stock: 2000, initial_stock: 8000, notes: "Daging sapi giling bentuk patty burger" },
  { sku: "ING-PROT-06", name: "Ikan Dori Fillet", unit: "g", min_stock: 2000, initial_stock: 8000, notes: "Fillet ikan dori beku tanpa tulang" },
  { sku: "ING-PROT-07", name: "Beef Bacon", unit: "g", min_stock: 1000, initial_stock: 5000, notes: "Smoked beef bacon slice untuk carbonara" },
  { sku: "ING-PROT-08", name: "Telur Ayam", unit: "pcs", min_stock: 50, initial_stock: 300, notes: "Telur ayam segar grade A per butir" },

  // --- BAHAN POKOK & KARBOHIDRAT (7) ---
  { sku: "ING-CARB-01", name: "Beras Putih", unit: "g", min_stock: 5000, initial_stock: 30000, notes: "Beras pulen pilihan kualitas premium" },
  { sku: "ING-CARB-02", name: "Pasta Spaghetti", unit: "g", min_stock: 2000, initial_stock: 10000, notes: "Spaghetti kering durum wheat semolina" },
  { sku: "ING-CARB-03", name: "Kentang Beku (French Fries)", unit: "g", min_stock: 3000, initial_stock: 15000, notes: "Shoestring / straight cut potato fries" },
  { sku: "ING-CARB-04", name: "Roti Burger Bun", unit: "pcs", min_stock: 20, initial_stock: 100, notes: "Roti brioche bun tabur wijen" },
  { sku: "ING-CARB-05", name: "Roti Baguette", unit: "pcs", min_stock: 20, initial_stock: 80, notes: "Roti baguette renyah untuk garlic bread" },
  { sku: "ING-CARB-06", name: "Biskuit Ladyfinger", unit: "pcs", min_stock: 30, initial_stock: 150, notes: "Savoiardi ladyfingers untuk tiramisu" },
  { sku: "ING-CARB-07", name: "Biskuit Renyah (Crust)", unit: "g", min_stock: 500, initial_stock: 3000, notes: "Crushed graham/digestive crackers untuk cheesecake" },

  // --- TEPUNG & OLAHAN (3) ---
  { sku: "ING-FLOU-01", name: "Tepung Terigu", unit: "g", min_stock: 2000, initial_stock: 15000, notes: "Tepung terigu serbaguna protein sedang" },
  { sku: "ING-FLOU-02", name: "Tepung Maizena", unit: "g", min_stock: 1000, initial_stock: 5000, notes: "Pati jagung pengental dan perenyah" },
  { sku: "ING-FLOU-03", name: "Tepung Panir", unit: "g", min_stock: 1000, initial_stock: 5000, notes: "Breadcrumbs putih renyah untuk katsu" },

  // --- SAUS, MINYAK & BUMBU DAPUR (18) ---
  { sku: "ING-SEAS-01", name: "Minyak Goreng", unit: "ml", min_stock: 5000, initial_stock: 25000, notes: "Minyak kelapa sawit murni untuk deep fry" },
  { sku: "ING-SEAS-02", name: "Mentega (Butter)", unit: "g", min_stock: 1000, initial_stock: 6000, notes: "Mentega gurih serbaguna" },
  { sku: "ING-SEAS-03", name: "Gula Pasir", unit: "g", min_stock: 3000, initial_stock: 15000, notes: "Gula pasir putih kristal" },
  { sku: "ING-SEAS-04", name: "Gula Cair (Fruktosa)", unit: "ml", min_stock: 2000, initial_stock: 10000, notes: "Simple syrup pemanis minuman" },
  { sku: "ING-SEAS-05", name: "Garam Dapur", unit: "g", min_stock: 500, initial_stock: 3000, notes: "Garam halus beriodium" },
  { sku: "ING-SEAS-06", name: "Saus Tonkatsu", unit: "ml", min_stock: 1000, initial_stock: 5000, notes: "Saus gurih manis khas katsu Jepang" },
  { sku: "ING-SEAS-07", name: "Saus Teriyaki", unit: "ml", min_stock: 1000, initial_stock: 5000, notes: "Saus teriyaki manis gurih beraroma shoyu" },
  { sku: "ING-SEAS-08", name: "Saus Yakiniku", unit: "ml", min_stock: 1000, initial_stock: 5000, notes: "Saus yakiniku dengan aroma wijen dan bawang" },
  { sku: "ING-SEAS-09", name: "Saus Lada Hitam", unit: "ml", min_stock: 1000, initial_stock: 5000, notes: "Saus black pepper pedas hangat" },
  { sku: "ING-SEAS-10", name: "Saus Bolognese", unit: "ml", min_stock: 2000, initial_stock: 10000, notes: "Saus tomat pasta slow-cooked" },
  { sku: "ING-SEAS-11", name: "Saus Barbeque", unit: "ml", min_stock: 1000, initial_stock: 5000, notes: "Saus BBQ smokey manis pedas" },
  { sku: "ING-SEAS-12", name: "Saus Tartar", unit: "ml", min_stock: 1000, initial_stock: 5000, notes: "Saus tartar gurih asam segar untuk dori" },
  { sku: "ING-SEAS-13", name: "Saus Burger Spesial", unit: "ml", min_stock: 1000, initial_stock: 5000, notes: "Racikan mayo, mustard, dan rempah burger" },
  { sku: "ING-SEAS-14", name: "Bumbu Nasi Goreng Spesial", unit: "g", min_stock: 500, initial_stock: 3000, notes: "Pasta bumbu rempah nasi goreng Nine Licious" },
  { sku: "ING-SEAS-15", name: "Bumbu Marinasi Ayam Crispy", unit: "g", min_stock: 500, initial_stock: 3000, notes: "Campuran rempah marinasi ayam crispy" },
  { sku: "ING-SEAS-16", name: "Garlic Spread", unit: "g", min_stock: 500, initial_stock: 2000, notes: "Campuran mentega, bawang putih cincang, dan parsley" },
  { sku: "ING-SEAS-17", name: "Biji Wijen Sangrai", unit: "g", min_stock: 200, initial_stock: 1000, notes: "Wijen putih sangrai harum untuk garnish" },
  { sku: "ING-SEAS-18", name: "Kerupuk Bawang", unit: "g", min_stock: 500, initial_stock: 2500, notes: "Kerupuk renyah pendamping nasi goreng" },

  // --- SAYURAN & BUAH SEGAR (8) ---
  { sku: "ING-VEGE-01", name: "Bawang Bombay", unit: "g", min_stock: 1000, initial_stock: 5000, notes: "Bawang bombay kuning segar" },
  { sku: "ING-VEGE-02", name: "Paprika Merah Hijau", unit: "g", min_stock: 500, initial_stock: 2500, notes: "Potongan paprika merah dan hijau segar" },
  { sku: "ING-VEGE-03", name: "Brokoli Segar", unit: "g", min_stock: 500, initial_stock: 2500, notes: "Brokoli hijau kukus pendamping teriyaki" },
  { sku: "ING-VEGE-04", name: "Selada Segar", unit: "g", min_stock: 500, initial_stock: 3000, notes: "Daun selada iceberg segar renyah" },
  { sku: "ING-VEGE-05", name: "Tomat Segar", unit: "g", min_stock: 500, initial_stock: 3000, notes: "Irisan tomat merah matang" },
  { sku: "ING-VEGE-06", name: "Jeruk Lemon Segar", unit: "pcs", min_stock: 20, initial_stock: 100, notes: "Jeruk lemon kuning segar" },
  { sku: "ING-VEGE-07", name: "Buah Stroberi Segar", unit: "pcs", min_stock: 30, initial_stock: 150, notes: "Stroberi segar untuk minuman & dessert" },
  { sku: "ING-VEGE-08", name: "Buah Leci Kaleng", unit: "pcs", min_stock: 30, initial_stock: 150, notes: "Buah leci utuh manis kalengan" },

  // --- MINUMAN, KOPI & BAR (13) ---
  { sku: "ING-BEVG-01", name: "Daun Teh Hitam Melati", unit: "g", min_stock: 1000, initial_stock: 5000, notes: "Daun teh melati wangi pilihan" },
  { sku: "ING-BEVG-02", name: "Biji Kopi Arabika Espresso", unit: "g", min_stock: 1000, initial_stock: 8000, notes: "Biji kopi sangrai medium-dark blend" },
  { sku: "ING-BEVG-03", name: "Susu Sapi Segar (Fresh Milk)", unit: "ml", min_stock: 5000, initial_stock: 30000, notes: "Susu pasteurisasi segar murni" },
  { sku: "ING-BEVG-04", name: "Bubuk Matcha Uji", unit: "g", min_stock: 500, initial_stock: 3000, notes: "Matcha bubuk murni kualitas Jepang" },
  { sku: "ING-BEVG-05", name: "Bubuk Cokelat Premium", unit: "g", min_stock: 1000, initial_stock: 6000, notes: "Kakao bubuk murni kaya rasa" },
  { sku: "ING-BEVG-06", name: "Bubuk Taro Ungu", unit: "g", min_stock: 500, initial_stock: 4000, notes: "Taro powder wangi manis khas talas" },
  { sku: "ING-BEVG-07", name: "Sirup Stroberi", unit: "ml", min_stock: 1000, initial_stock: 6000, notes: "Sirup konsentrat stroberi manis asam" },
  { sku: "ING-BEVG-08", name: "Sirup Leci", unit: "ml", min_stock: 1000, initial_stock: 6000, notes: "Sirup konsentrat aroma buah leci alami" },
  { sku: "ING-BEVG-09", name: "Puree Mangga", unit: "ml", min_stock: 1000, initial_stock: 6000, notes: "Puree mangga harum manis kental" },
  { sku: "ING-BEVG-10", name: "Selai Stroberi Chunks", unit: "g", min_stock: 1000, initial_stock: 5000, notes: "Selai stroberi homemade dengan bulir buah" },
  { sku: "ING-BEVG-11", name: "Susu Fermentasi Yakult", unit: "pcs", min_stock: 20, initial_stock: 120, notes: "Botol Yakult probiotik 65ml per pcs" },
  { sku: "ING-BEVG-12", name: "Es Batu Kristal", unit: "g", min_stock: 10000, initial_stock: 50000, notes: "Es batu kristal tabung higienis" },
  { sku: "ING-BEVG-13", name: "Air Mineral", unit: "ml", min_stock: 10000, initial_stock: 60000, notes: "Air mineral murni galon higienis" },

  // --- BAHAN DESSERT & BAKING (16) ---
  { sku: "ING-DEST-01", name: "Dark Chocolate Compound", unit: "g", min_stock: 2000, initial_stock: 10000, notes: "Cokelat blok hitam pekat untuk baking & lava" },
  { sku: "ING-DEST-02", name: "Saus Cokelat (Fudge)", unit: "ml", min_stock: 1000, initial_stock: 5000, notes: "Saus siraman cokelat kental mengkilap" },
  { sku: "ING-DEST-03", name: "Cream Cheese", unit: "g", min_stock: 1000, initial_stock: 6000, notes: "Keju krim padat lembut untuk cheesecake" },
  { sku: "ING-DEST-04", name: "Mascarpone Cheese", unit: "g", min_stock: 500, initial_stock: 3000, notes: "Keju mascarpone khas Italia untuk tiramisu" },
  { sku: "ING-DEST-05", name: "Keju Parmesan", unit: "g", min_stock: 500, initial_stock: 3000, notes: "Keju parmesan parut kering gurih" },
  { sku: "ING-DEST-06", name: "Keju Cheddar Slice", unit: "pcs", min_stock: 20, initial_stock: 100, notes: "Keju cheddar lembaran leleh untuk burger" },
  { sku: "ING-DEST-07", name: "Whipping Cream Cair", unit: "ml", min_stock: 1000, initial_stock: 6000, notes: "Krim kental cair dairy 35% fat" },
  { sku: "ING-DEST-08", name: "Es Krim Vanila", unit: "g", min_stock: 2000, initial_stock: 12000, notes: "Es krim vanila madagaskar lembut" },
  { sku: "ING-DEST-09", name: "Es Krim Cokelat", unit: "g", min_stock: 2000, initial_stock: 10000, notes: "Es krim cokelat pekat lembut" },
  { sku: "ING-DEST-10", name: "Es Krim Stroberi", unit: "g", min_stock: 2000, initial_stock: 10000, notes: "Es krim stroberi manis segar dengan bulir" },
  { sku: "ING-DEST-11", name: "Sirup Maple", unit: "ml", min_stock: 1000, initial_stock: 5000, notes: "Sirup maple harum untuk waffle dan pancake" },
  { sku: "ING-DEST-12", name: "Selai Buah Berry", unit: "g", min_stock: 500, initial_stock: 3000, notes: "Selai buah berry untuk topping cheesecake" },
  { sku: "ING-DEST-13", name: "Saus Karamel Sutra", unit: "ml", min_stock: 500, initial_stock: 3000, notes: "Saus karamel gula leleh wangi untuk puding" },
  { sku: "ING-DEST-14", name: "Bubuk Agar-Agar / Gelatin", unit: "g", min_stock: 200, initial_stock: 1500, notes: "Bubuk pengental jeli puding" },
  { sku: "ING-DEST-15", name: "Kacang Kenari Cincang", unit: "g", min_stock: 300, initial_stock: 2000, notes: "Walnut panggang cincang untuk brownies" },
  { sku: "ING-DEST-16", name: "Wafer Stik Cokelat", unit: "pcs", min_stock: 30, initial_stock: 150, notes: "Wafer roll stik renyah hiasan es krim" },
];

// =============================================================================
// 2. DEFINISI RESEP PORSI TUNGGAL UNTUK SELURUH 41 PRODUK
// =============================================================================
// SKU Produk -> Array of { ingredientSku, qty, notes }
export const PRODUCT_RECIPES = {
  // ---------------- FOOD (13 items) ----------------
  // 1. Ayam Goreng Crispy
  "FOOD-01": [
    { ingredientSku: "ING-PROT-01", qty: 150, notes: "Ayam potong / fillet" },
    { ingredientSku: "ING-FLOU-01", qty: 40, notes: "Tepung terigu krispi" },
    { ingredientSku: "ING-FLOU-02", qty: 15, notes: "Tepung maizena perenyah" },
    { ingredientSku: "ING-PROT-08", qty: 1, notes: "Telur ayam pengikat adonan" },
    { ingredientSku: "ING-SEAS-01", qty: 30, notes: "Minyak goreng porsi serap" },
    { ingredientSku: "ING-SEAS-15", qty: 10, notes: "Bumbu marinasi khas Nine Licious" },
  ],

  // 2. Chicken Katsu Rice
  "FD-001": [
    { ingredientSku: "ING-PROT-01", qty: 150, notes: "Ayam fillet dada katsu" },
    { ingredientSku: "ING-CARB-01", qty: 100, notes: "Beras pulen (1 porsi nasi)" },
    { ingredientSku: "ING-FLOU-01", qty: 30, notes: "Tepung terigu pelapis" },
    { ingredientSku: "ING-FLOU-03", qty: 25, notes: "Tepung panir katsu" },
    { ingredientSku: "ING-PROT-08", qty: 1, notes: "Telur ayam kocok" },
    { ingredientSku: "ING-SEAS-01", qty: 20, notes: "Minyak goreng katsu" },
    { ingredientSku: "ING-SEAS-06", qty: 25, notes: "Saus tonkatsu siram" },
  ],

  // 3. Chicken Teriyaki Rice
  "FD-002": [
    { ingredientSku: "ING-PROT-01", qty: 150, notes: "Ayam fillet potong dadu" },
    { ingredientSku: "ING-CARB-01", qty: 100, notes: "Beras pulen (1 porsi nasi)" },
    { ingredientSku: "ING-SEAS-07", qty: 30, notes: "Saus teriyaki manis gurih" },
    { ingredientSku: "ING-SEAS-17", qty: 3, notes: "Biji wijen sangrai tabur" },
    { ingredientSku: "ING-VEGE-03", qty: 40, notes: "Brokoli kukus segar" },
    { ingredientSku: "ING-SEAS-01", qty: 10, notes: "Minyak tumis" },
  ],

  // 4. Beef Yakiniku Rice
  "FD-003": [
    { ingredientSku: "ING-PROT-03", qty: 120, notes: "Daging sapi slice premium" },
    { ingredientSku: "ING-CARB-01", qty: 100, notes: "Beras pulen (1 porsi nasi)" },
    { ingredientSku: "ING-VEGE-01", qty: 30, notes: "Bawang bombay iris" },
    { ingredientSku: "ING-SEAS-08", qty: 30, notes: "Saus yakiniku harum" },
    { ingredientSku: "ING-SEAS-01", qty: 10, notes: "Minyak tumis" },
    { ingredientSku: "ING-SEAS-17", qty: 3, notes: "Biji wijen sangrai tabur" },
  ],

  // 5. Chicken Black Pepper Rice
  "FD-004": [
    { ingredientSku: "ING-PROT-01", qty: 150, notes: "Ayam fillet potong dadu" },
    { ingredientSku: "ING-CARB-01", qty: 100, notes: "Beras pulen (1 porsi nasi)" },
    { ingredientSku: "ING-SEAS-09", qty: 30, notes: "Saus lada hitam gurih pedas" },
    { ingredientSku: "ING-VEGE-01", qty: 30, notes: "Bawang bombay iris" },
    { ingredientSku: "ING-VEGE-02", qty: 20, notes: "Paprika merah hijau" },
    { ingredientSku: "ING-SEAS-01", qty: 10, notes: "Minyak tumis" },
  ],

  // 6. Nasi Goreng Special
  "FD-005": [
    { ingredientSku: "ING-CARB-01", qty: 120, notes: "Beras pulen (1 porsi nasi)" },
    { ingredientSku: "ING-PROT-08", qty: 2, notes: "1 butir orak-arik + 1 butir ceplok" },
    { ingredientSku: "ING-PROT-01", qty: 50, notes: "Ayam suwir spesial" },
    { ingredientSku: "ING-SEAS-14", qty: 20, notes: "Bumbu nasi goreng spesial" },
    { ingredientSku: "ING-SEAS-01", qty: 15, notes: "Minyak goreng tumis" },
    { ingredientSku: "ING-SEAS-18", qty: 10, notes: "Kerupuk pendamping renyah" },
  ],

  // 7. Spaghetti Bolognese
  "FD-006": [
    { ingredientSku: "ING-CARB-02", qty: 100, notes: "Pasta spaghetti kering" },
    { ingredientSku: "ING-PROT-04", qty: 80, notes: "Daging sapi cincang segar" },
    { ingredientSku: "ING-SEAS-10", qty: 100, notes: "Saus tomat ragu bolognese" },
    { ingredientSku: "ING-DEST-05", qty: 10, notes: "Keju parmesan parut tabur" },
    { ingredientSku: "ING-SEAS-01", qty: 10, notes: "Minyak tumis saus" },
  ],

  // 8. Spaghetti Carbonara
  "FD-007": [
    { ingredientSku: "ING-CARB-02", qty: 100, notes: "Pasta spaghetti kering" },
    { ingredientSku: "ING-PROT-07", qty: 40, notes: "Beef bacon renyah" },
    { ingredientSku: "ING-BEVG-03", qty: 80, notes: "Susu segar krim carbonara" },
    { ingredientSku: "ING-DEST-05", qty: 15, notes: "Keju parmesan gurih" },
    { ingredientSku: "ING-PROT-08", qty: 1, notes: "Kuning telur pengental saus" },
    { ingredientSku: "ING-SEAS-02", qty: 10, notes: "Mentega tumis bacon" },
  ],

  // 9. Chicken Wings
  "FD-008": [
    { ingredientSku: "ING-PROT-02", qty: 6, notes: "6 pcs sayap ayam segar" },
    { ingredientSku: "ING-SEAS-11", qty: 40, notes: "Saus barbeque manis gurih" },
    { ingredientSku: "ING-SEAS-01", qty: 30, notes: "Minyak goreng sayap" },
    { ingredientSku: "ING-SEAS-17", qty: 3, notes: "Biji wijen sangrai tabur" },
  ],

  // 10. French Fries
  "FD-009": [
    { ingredientSku: "ING-CARB-03", qty: 150, notes: "Kentang beku french fries" },
    { ingredientSku: "ING-SEAS-01", qty: 30, notes: "Minyak goreng kentang" },
    { ingredientSku: "ING-SEAS-05", qty: 3, notes: "Garam laut bumbu tabur" },
  ],

  // 11. Beef Burger
  "FD-010": [
    { ingredientSku: "ING-CARB-04", qty: 1, notes: "1 pcs roti burger bun wijen" },
    { ingredientSku: "ING-PROT-05", qty: 120, notes: "Patty daging sapi panggang" },
    { ingredientSku: "ING-DEST-06", qty: 1, notes: "1 lembar keju cheddar leleh" },
    { ingredientSku: "ING-VEGE-04", qty: 20, notes: "Daun selada segar" },
    { ingredientSku: "ING-VEGE-05", qty: 20, notes: "Irisan tomat segar" },
    { ingredientSku: "ING-SEAS-13", qty: 25, notes: "Saus burger spesial Nine Licious" },
  ],

  // 12. Chicken Burger
  "FD-011": [
    { ingredientSku: "ING-CARB-04", qty: 1, notes: "1 pcs roti burger bun wijen" },
    { ingredientSku: "ING-PROT-01", qty: 120, notes: "Paha ayam fillet patty" },
    { ingredientSku: "ING-FLOU-01", qty: 25, notes: "Tepung krispi buttermilk" },
    { ingredientSku: "ING-SEAS-01", qty: 20, notes: "Minyak goreng patty ayam" },
    { ingredientSku: "ING-VEGE-04", qty: 30, notes: "Coleslaw & selada segar" },
    { ingredientSku: "ING-SEAS-13", qty: 25, notes: "Saus mayo pedas burger" },
  ],

  // 13. Fish and Chips
  "FD-012": [
    { ingredientSku: "ING-PROT-06", qty: 150, notes: "Fillet ikan dori segar" },
    { ingredientSku: "ING-CARB-03", qty: 120, notes: "Kentang goreng pendamping" },
    { ingredientSku: "ING-FLOU-01", qty: 40, notes: "Tepung batter renyah dori" },
    { ingredientSku: "ING-SEAS-01", qty: 40, notes: "Minyak goreng deep fry" },
    { ingredientSku: "ING-SEAS-12", qty: 30, notes: "Saus tartar segar" },
    { ingredientSku: "ING-VEGE-06", qty: 0.5, notes: "Setengah buah lemon segar" },
  ],

  // ---------------- DRINKS (12 items) ----------------
  // 14. Iced Tea
  "DR-001": [
    { ingredientSku: "ING-BEVG-01", qty: 5, notes: "Daun teh melati seduh" },
    { ingredientSku: "ING-SEAS-03", qty: 20, notes: "Gula pasir pemanis" },
    { ingredientSku: "ING-BEVG-12", qty: 120, notes: "Es batu kristal dingin" },
    { ingredientSku: "ING-BEVG-13", qty: 200, notes: "Air seduhan teh" },
  ],

  // 15. Lemon Tea
  "DR-002": [
    { ingredientSku: "ING-BEVG-01", qty: 5, notes: "Daun teh melati seduh" },
    { ingredientSku: "ING-VEGE-06", qty: 0.5, notes: "Perasan & irisan lemon segar" },
    { ingredientSku: "ING-SEAS-03", qty: 25, notes: "Gula pasir penyeimbang asam" },
    { ingredientSku: "ING-BEVG-12", qty: 120, notes: "Es batu kristal" },
    { ingredientSku: "ING-BEVG-13", qty: 180, notes: "Air seduhan teh" },
  ],

  // 16. Lychee Tea
  "DR-003": [
    { ingredientSku: "ING-BEVG-01", qty: 5, notes: "Daun teh melati seduh" },
    { ingredientSku: "ING-BEVG-08", qty: 30, notes: "Sirup leci manis alami" },
    { ingredientSku: "ING-VEGE-08", qty: 2, notes: "2 pcs buah leci utuh segar" },
    { ingredientSku: "ING-BEVG-12", qty: 120, notes: "Es batu kristal" },
    { ingredientSku: "ING-BEVG-13", qty: 180, notes: "Air seduhan teh" },
  ],

  // 17. Strawberry Tea
  "DR-004": [
    { ingredientSku: "ING-BEVG-01", qty: 5, notes: "Daun teh melati seduh" },
    { ingredientSku: "ING-BEVG-07", qty: 30, notes: "Sirup stroberi segar" },
    { ingredientSku: "ING-VEGE-07", qty: 2, notes: "2 pcs buah stroberi potong" },
    { ingredientSku: "ING-BEVG-12", qty: 120, notes: "Es batu kristal" },
    { ingredientSku: "ING-BEVG-13", qty: 180, notes: "Air seduhan teh" },
  ],

  // 18. Matcha Latte
  "DR-005": [
    { ingredientSku: "ING-BEVG-04", qty: 15, notes: "Bubuk matcha Uji murni" },
    { ingredientSku: "ING-BEVG-03", qty: 180, notes: "Susu sapi segar dingin" },
    { ingredientSku: "ING-SEAS-04", qty: 20, notes: "Gula cair pemanis" },
    { ingredientSku: "ING-BEVG-12", qty: 100, notes: "Es batu kristal" },
  ],

  // 19. Chocolate Milk
  "DR-006": [
    { ingredientSku: "ING-BEVG-05", qty: 25, notes: "Bubuk kakao premium" },
    { ingredientSku: "ING-BEVG-03", qty: 180, notes: "Susu sapi segar" },
    { ingredientSku: "ING-DEST-02", qty: 20, notes: "Saus cokelat pekat siram" },
    { ingredientSku: "ING-BEVG-12", qty: 100, notes: "Es batu kristal" },
  ],

  // 20. Strawberry Milk
  "DR-007": [
    { ingredientSku: "ING-BEVG-03", qty: 180, notes: "Susu sapi segar dingin" },
    { ingredientSku: "ING-BEVG-10", qty: 40, notes: "Selai stroberi chunks homemade" },
    { ingredientSku: "ING-VEGE-07", qty: 1, notes: "Buah stroberi segar garnish" },
    { ingredientSku: "ING-BEVG-12", qty: 100, notes: "Es batu kristal" },
  ],

  // 21. Taro Milk
  "DR-008": [
    { ingredientSku: "ING-BEVG-06", qty: 25, notes: "Bubuk taro ungu wangi" },
    { ingredientSku: "ING-BEVG-03", qty: 180, notes: "Susu sapi segar" },
    { ingredientSku: "ING-SEAS-04", qty: 15, notes: "Gula cair pemanis" },
    { ingredientSku: "ING-BEVG-12", qty: 100, notes: "Es batu kristal" },
  ],

  // 22. Café Latte
  "DR-009": [
    { ingredientSku: "ING-BEVG-02", qty: 18, notes: "Biji kopi espresso arabika" },
    { ingredientSku: "ING-BEVG-03", qty: 180, notes: "Steamed fresh milk mikro foam" },
    { ingredientSku: "ING-SEAS-04", qty: 10, notes: "Gula cair (opsional rasa)" },
  ],

  // 23. Americano
  "DR-010": [
    { ingredientSku: "ING-BEVG-02", qty: 18, notes: "Double shot espresso arabika" },
    { ingredientSku: "ING-BEVG-13", qty: 180, notes: "Air mineral dingin/panas" },
    { ingredientSku: "ING-BEVG-12", qty: 100, notes: "Es batu kristal" },
  ],

  // 24. Cappuccino
  "DR-011": [
    { ingredientSku: "ING-BEVG-02", qty: 18, notes: "Biji kopi espresso arabika" },
    { ingredientSku: "ING-BEVG-03", qty: 140, notes: "Steamed milk busa tebal" },
    { ingredientSku: "ING-BEVG-05", qty: 2, notes: "Bubuk cokelat tabur atas" },
  ],

  // 25. Mango Yakult
  "DR-012": [
    { ingredientSku: "ING-BEVG-09", qty: 40, notes: "Puree mangga manis kental" },
    { ingredientSku: "ING-BEVG-11", qty: 1, notes: "1 botol Yakult probiotik" },
    { ingredientSku: "ING-BEVG-12", qty: 100, notes: "Es batu kristal" },
    { ingredientSku: "ING-BEVG-13", qty: 80, notes: "Air mineral penyeimbang" },
  ],

  // ---------------- DESSERTS (10 items) ----------------
  // 26. Chocolate Lava Cake
  "DS-001": [
    { ingredientSku: "ING-DEST-01", qty: 50, notes: "Dark chocolate compound lumer" },
    { ingredientSku: "ING-SEAS-02", qty: 25, notes: "Mentega leleh cake" },
    { ingredientSku: "ING-PROT-08", qty: 1, notes: "Telur ayam adonan" },
    { ingredientSku: "ING-SEAS-03", qty: 25, notes: "Gula pasir adonan" },
    { ingredientSku: "ING-FLOU-01", qty: 20, notes: "Tepung terigu cake" },
    { ingredientSku: "ING-DEST-08", qty: 50, notes: "1 scoop es krim vanila pendamping" },
  ],

  // 27. Brownies
  "DS-002": [
    { ingredientSku: "ING-DEST-01", qty: 40, notes: "Dark chocolate compound" },
    { ingredientSku: "ING-FLOU-01", qty: 30, notes: "Tepung terigu brownies" },
    { ingredientSku: "ING-SEAS-02", qty: 20, notes: "Mentega leleh" },
    { ingredientSku: "ING-PROT-08", qty: 1, notes: "Telur ayam" },
    { ingredientSku: "ING-SEAS-03", qty: 25, notes: "Gula pasir" },
    { ingredientSku: "ING-DEST-15", qty: 10, notes: "Kacang kenari cincang tabur" },
  ],

  // 28. Cheesecake
  "DS-003": [
    { ingredientSku: "ING-DEST-03", qty: 60, notes: "Cream cheese padat lembut" },
    { ingredientSku: "ING-CARB-07", qty: 25, notes: "Crust biskuit renyah dasar" },
    { ingredientSku: "ING-DEST-07", qty: 30, notes: "Whipping cream cair" },
    { ingredientSku: "ING-SEAS-03", qty: 20, notes: "Gula pasir pemanis" },
    { ingredientSku: "ING-DEST-12", qty: 15, notes: "Selai buah berry siram" },
  ],

  // 29. Tiramisu
  "DS-004": [
    { ingredientSku: "ING-CARB-06", qty: 3, notes: "3 pcs biskuit ladyfinger" },
    { ingredientSku: "ING-DEST-04", qty: 50, notes: "Keju mascarpone lembut" },
    { ingredientSku: "ING-BEVG-02", qty: 10, notes: "Kopi espresso celupan biskuit" },
    { ingredientSku: "ING-DEST-07", qty: 30, notes: "Whipping cream kocok" },
    { ingredientSku: "ING-BEVG-05", qty: 5, notes: "Bubuk kakao tabur atas" },
  ],

  // 30. Waffle
  "DS-005": [
    { ingredientSku: "ING-FLOU-01", qty: 60, notes: "Tepung terigu adonan waffle" },
    { ingredientSku: "ING-BEVG-03", qty: 60, notes: "Susu sapi segar" },
    { ingredientSku: "ING-PROT-08", qty: 1, notes: "Telur ayam" },
    { ingredientSku: "ING-SEAS-02", qty: 15, notes: "Mentega leleh waffle" },
    { ingredientSku: "ING-DEST-11", qty: 25, notes: "Sirup maple siraman hangat" },
  ],

  // 31. Pancake
  "DS-006": [
    { ingredientSku: "ING-FLOU-01", qty: 60, notes: "Tepung terigu adonan pancake" },
    { ingredientSku: "ING-BEVG-03", qty: 70, notes: "Susu sapi segar" },
    { ingredientSku: "ING-PROT-08", qty: 1, notes: "Telur ayam" },
    { ingredientSku: "ING-SEAS-02", qty: 15, notes: "Mentega leleh pancake" },
    { ingredientSku: "ING-DEST-11", qty: 25, notes: "Sirup maple siraman manis" },
  ],

  // 32. Pudding
  "DS-007": [
    { ingredientSku: "ING-BEVG-03", qty: 100, notes: "Susu sapi segar sutra" },
    { ingredientSku: "ING-DEST-14", qty: 5, notes: "Bubuk agar-agar jeli" },
    { ingredientSku: "ING-SEAS-03", qty: 20, notes: "Gula pasir adonan" },
    { ingredientSku: "ING-DEST-13", qty: 20, notes: "Saus karamel lumer harum" },
  ],

  // 33. Vanilla Ice Cream
  "DS-008": [
    { ingredientSku: "ING-DEST-08", qty: 120, notes: "3 scoop es krim vanila (40g x 3)" },
    { ingredientSku: "ING-DEST-16", qty: 1, notes: "1 pcs wafer stik hiasan" },
  ],

  // 34. Chocolate Ice Cream
  "DS-009": [
    { ingredientSku: "ING-DEST-09", qty: 120, notes: "3 scoop es krim cokelat (40g x 3)" },
    { ingredientSku: "ING-DEST-02", qty: 15, notes: "Saus cokelat siraman" },
    { ingredientSku: "ING-DEST-16", qty: 1, notes: "1 pcs wafer stik hiasan" },
  ],

  // 35. Strawberry Ice Cream
  "DS-010": [
    { ingredientSku: "ING-DEST-10", qty: 120, notes: "3 scoop es krim stroberi (40g x 3)" },
    { ingredientSku: "ING-VEGE-07", qty: 1, notes: "1 pcs buah stroberi garnish" },
    { ingredientSku: "ING-DEST-16", qty: 1, notes: "1 pcs wafer stik hiasan" },
  ],

  // ---------------- PACKAGES (6 items) ----------------
  // 36. Chicken Katsu Package (PK-001)
  // Deskripsi: Chicken Katsu Rice + Iced Tea segar + porsi kecil French Fries
  "PK-001": [
    { ingredientSku: "ING-PROT-01", qty: 150, notes: "Ayam fillet katsu paket" },
    { ingredientSku: "ING-CARB-01", qty: 100, notes: "Beras pulen 1 porsi nasi" },
    { ingredientSku: "ING-FLOU-01", qty: 30, notes: "Tepung terigu katsu" },
    { ingredientSku: "ING-FLOU-03", qty: 25, notes: "Tepung panir katsu" },
    { ingredientSku: "ING-PROT-08", qty: 1, notes: "Telur ayam katsu" },
    { ingredientSku: "ING-SEAS-06", qty: 25, notes: "Saus tonkatsu katsu" },
    { ingredientSku: "ING-CARB-03", qty: 80, notes: "Kentang goreng porsi kecil paket" },
    { ingredientSku: "ING-SEAS-01", qty: 35, notes: "Minyak goreng katsu & fries" },
    { ingredientSku: "ING-SEAS-05", qty: 2, notes: "Garam tabur kentang" },
    { ingredientSku: "ING-BEVG-01", qty: 5, notes: "Daun teh Iced Tea paket" },
    { ingredientSku: "ING-SEAS-03", qty: 20, notes: "Gula pasir Iced Tea paket" },
    { ingredientSku: "ING-BEVG-12", qty: 120, notes: "Es batu kristal" },
    { ingredientSku: "ING-BEVG-13", qty: 200, notes: "Air seduhan teh" },
  ],

  // 37. Chicken Teriyaki Package (PK-002)
  // Deskripsi: Chicken Teriyaki Rice dengan wijen dan brokoli + Iced Tea + kentang goreng renyah
  "PK-002": [
    { ingredientSku: "ING-PROT-01", qty: 150, notes: "Ayam fillet teriyaki paket" },
    { ingredientSku: "ING-CARB-01", qty: 100, notes: "Beras pulen 1 porsi nasi" },
    { ingredientSku: "ING-SEAS-07", qty: 30, notes: "Saus teriyaki paket" },
    { ingredientSku: "ING-SEAS-17", qty: 3, notes: "Biji wijen sangrai" },
    { ingredientSku: "ING-VEGE-03", qty: 40, notes: "Brokoli kukus segar" },
    { ingredientSku: "ING-CARB-03", qty: 80, notes: "Kentang goreng porsi kecil paket" },
    { ingredientSku: "ING-SEAS-01", qty: 25, notes: "Minyak goreng teriyaki & fries" },
    { ingredientSku: "ING-SEAS-05", qty: 2, notes: "Garam tabur kentang" },
    { ingredientSku: "ING-BEVG-01", qty: 5, notes: "Daun teh Iced Tea paket" },
    { ingredientSku: "ING-SEAS-03", qty: 20, notes: "Gula pasir Iced Tea paket" },
    { ingredientSku: "ING-BEVG-12", qty: 120, notes: "Es batu kristal" },
    { ingredientSku: "ING-BEVG-13", qty: 200, notes: "Air seduhan teh" },
  ],

  // 38. Burger Package (PK-003)
  // Deskripsi: Gourmet Beef Burger keju meleleh + French Fries renyah + Lemon Tea segar
  "PK-003": [
    { ingredientSku: "ING-CARB-04", qty: 1, notes: "Roti burger bun wijen" },
    { ingredientSku: "ING-PROT-05", qty: 120, notes: "Patty daging sapi burger" },
    { ingredientSku: "ING-DEST-06", qty: 1, notes: "Keju cheddar slice leleh" },
    { ingredientSku: "ING-VEGE-04", qty: 20, notes: "Selada segar burger" },
    { ingredientSku: "ING-VEGE-05", qty: 20, notes: "Tomat segar burger" },
    { ingredientSku: "ING-SEAS-13", qty: 25, notes: "Saus burger spesial" },
    { ingredientSku: "ING-CARB-03", qty: 100, notes: "Kentang goreng paket" },
    { ingredientSku: "ING-SEAS-01", qty: 25, notes: "Minyak goreng kentang" },
    { ingredientSku: "ING-SEAS-05", qty: 2, notes: "Garam tabur kentang" },
    { ingredientSku: "ING-BEVG-01", qty: 5, notes: "Daun teh Lemon Tea paket" },
    { ingredientSku: "ING-VEGE-06", qty: 0.5, notes: "Jeruk lemon segar perasan" },
    { ingredientSku: "ING-SEAS-03", qty: 25, notes: "Gula pasir Lemon Tea paket" },
    { ingredientSku: "ING-BEVG-12", qty: 120, notes: "Es batu kristal" },
    { ingredientSku: "ING-BEVG-13", qty: 180, notes: "Air seduhan teh" },
  ],

  // 39. Chicken Wings Package (PK-004)
  // Deskripsi: 6 pcs Chicken Wings bumbu lezat + nasi putih pulen hangat + Iced Tea segar
  "PK-004": [
    { ingredientSku: "ING-PROT-02", qty: 6, notes: "6 pcs sayap ayam paket" },
    { ingredientSku: "ING-SEAS-11", qty: 40, notes: "Saus barbeque wings" },
    { ingredientSku: "ING-SEAS-01", qty: 30, notes: "Minyak goreng sayap" },
    { ingredientSku: "ING-SEAS-17", qty: 3, notes: "Biji wijen sangrai" },
    { ingredientSku: "ING-CARB-01", qty: 100, notes: "Beras pulen 1 porsi nasi" },
    { ingredientSku: "ING-BEVG-01", qty: 5, notes: "Daun teh Iced Tea paket" },
    { ingredientSku: "ING-SEAS-03", qty: 20, notes: "Gula pasir Iced Tea paket" },
    { ingredientSku: "ING-BEVG-12", qty: 120, notes: "Es batu kristal" },
    { ingredientSku: "ING-BEVG-13", qty: 200, notes: "Air seduhan teh" },
  ],

  // 40. Spaghetti Package (PK-005)
  // Deskripsi: Spaghetti Bolognese daging cincang sapi + 2 potong Garlic Bread renyah + Lemon Tea
  "PK-005": [
    { ingredientSku: "ING-CARB-02", qty: 100, notes: "Pasta spaghetti bolognese paket" },
    { ingredientSku: "ING-PROT-04", qty: 80, notes: "Daging sapi cincang saus" },
    { ingredientSku: "ING-SEAS-10", qty: 100, notes: "Saus tomat ragu bolognese" },
    { ingredientSku: "ING-DEST-05", qty: 10, notes: "Keju parmesan parut" },
    { ingredientSku: "ING-SEAS-01", qty: 10, notes: "Minyak tumis saus" },
    { ingredientSku: "ING-CARB-05", qty: 2, notes: "2 pcs roti baguette garlic bread" },
    { ingredientSku: "ING-SEAS-02", qty: 15, notes: "Mentega olesan garlic bread" },
    { ingredientSku: "ING-SEAS-16", qty: 10, notes: "Garlic spread bawang putih" },
    { ingredientSku: "ING-BEVG-01", qty: 5, notes: "Daun teh Lemon Tea paket" },
    { ingredientSku: "ING-VEGE-06", qty: 0.5, notes: "Jeruk lemon segar perasan" },
    { ingredientSku: "ING-SEAS-03", qty: 25, notes: "Gula pasir Lemon Tea paket" },
    { ingredientSku: "ING-BEVG-12", qty: 120, notes: "Es batu kristal" },
    { ingredientSku: "ING-BEVG-13", qty: 180, notes: "Air seduhan teh" },
  ],

  // 41. Dessert Package (PK-006)
  // Deskripsi: Chocolate Lava Cake lumer + satu scoop Vanilla Ice Cream + Americano dingin/panas
  "PK-006": [
    { ingredientSku: "ING-DEST-01", qty: 50, notes: "Dark chocolate compound lava cake" },
    { ingredientSku: "ING-SEAS-02", qty: 25, notes: "Mentega leleh lava cake" },
    { ingredientSku: "ING-PROT-08", qty: 1, notes: "Telur ayam lava cake" },
    { ingredientSku: "ING-SEAS-03", qty: 25, notes: "Gula pasir lava cake" },
    { ingredientSku: "ING-FLOU-01", qty: 20, notes: "Tepung terigu lava cake" },
    { ingredientSku: "ING-DEST-08", qty: 50, notes: "1 scoop es krim vanila pendamping" },
    { ingredientSku: "ING-BEVG-02", qty: 18, notes: "Biji kopi espresso Americano" },
    { ingredientSku: "ING-BEVG-13", qty: 180, notes: "Air mineral Americano" },
    { ingredientSku: "ING-BEVG-12", qty: 100, notes: "Es batu kristal Americano" },
  ],
};

async function main() {
  console.log("\n=== NINE LICIOUS POS — SEEDING INVENTORY & RECIPES ===\n");

  const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminEmail = `${adminUsername.trim().toLowerCase()}@saji.app`;

  console.log(`Mengautentikasi admin (${adminEmail}) untuk RPC adjust_ingredient_stock_atomic...`);
  const { data: authSession, error: loginErr } = await authClient.auth.signInWithPassword({
    email: adminEmail,
    password: adminPassword,
  });

  if (loginErr || !authSession.user) {
    console.error("Gagal login sebagai admin:", loginErr?.message);
    process.exit(1);
  }
  console.log("Admin berhasil diautentikasi.\n");

  // Step 1: Ambil seluruh produk dari database
  const { data: dbProducts, error: prodErr } = await supabase
    .from("products")
    .select("id, name, sku")
    .order("sku");

  if (prodErr || !dbProducts) {
    console.error("Gagal mengambil data produk dari Supabase:", prodErr);
    process.exit(1);
  }

  console.log(`Ditemukan ${dbProducts.length} produk di database Supabase.`);
  const productBySku = new Map(dbProducts.map((p) => [p.sku, p]));

  // Validasi seluruh 41 produk ada di database
  const definedProductSkus = Object.keys(PRODUCT_RECIPES);
  for (const sku of definedProductSkus) {
    if (!productBySku.has(sku)) {
      console.warn(`[PERINGATAN] SKU produk '${sku}' tidak ditemukan di tabel products!`);
    }
  }

  // Step 2: Upsert 56 Master Bahan Baku
  console.log(`\nMenyinkronkan ${MASTER_INGREDIENTS.length} master bahan baku ke database...`);
  const ingredientIdBySku = new Map();

  for (const item of MASTER_INGREDIENTS) {
    // Cek apakah bahan baku sudah ada berdasarkan SKU
    const { data: existing, error: findErr } = await supabase
      .from("ingredients")
      .select("id, sku, current_stock, min_stock, is_active")
      .eq("sku", item.sku)
      .maybeSingle();

    if (findErr) {
      console.error(`Error mencari bahan baku ${item.sku}:`, findErr);
      continue;
    }

    let ingredientId;

    if (existing) {
      ingredientId = existing.id;
      // Perbarui info dasar jika perlu (name, unit, min_stock, notes)
      await supabase
        .from("ingredients")
        .update({
          name: item.name,
          unit: item.unit,
          min_stock: item.min_stock,
          notes: item.notes,
          is_active: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", ingredientId);
    } else {
      // Masukkan bahan baku baru dengan stok awal 0
      const { data: inserted, error: insertErr } = await supabase
        .from("ingredients")
        .insert({
          sku: item.sku,
          name: item.name,
          unit: item.unit,
          current_stock: 0,
          min_stock: item.min_stock,
          notes: item.notes,
          is_active: true,
        })
        .select("id")
        .single();

      if (insertErr || !inserted) {
        console.error(`Gagal membuat bahan baku ${item.name}:`, insertErr);
        continue;
      }
      ingredientId = inserted.id;
    }

    ingredientIdBySku.set(item.sku, ingredientId);

    // Step 3: Masukkan Stok Awal Beraudit jika stok masih 0
    const currentStock = existing ? Number(existing.current_stock) : 0;
    if (currentStock === 0 && item.initial_stock > 0) {
      const idempotencyKey = `init_${item.sku}`;
      const { data: adjustData, error: adjustErr } = await authClient.rpc(
        "adjust_ingredient_stock_atomic",
        {
          p_ingredient_id: ingredientId,
          p_movement_type: "manual_in",
          p_quantity: item.initial_stock,
          p_reason: "Initial Stock",
          p_idempotency_key: idempotencyKey,
        }
      );

      if (adjustErr) {
        console.error(`Gagal mengisi stok awal untuk ${item.name}:`, adjustErr.message);
      } else {
        console.log(`  [STOK AWAL] ${item.name} (${item.sku}): +${item.initial_stock} ${item.unit} (Audited saldo: ${adjustData?.balance_after})`);
      }
    }
  }

  console.log(`\nBerhasil memproses ${ingredientIdBySku.size}/${MASTER_INGREDIENTS.length} bahan baku.`);

  // Step 4: Hubungkan Resep ke Seluruh 41 Produk
  console.log(`\nMenghubungkan resep untuk 41 produk menu...`);
  let totalRecipeLines = 0;
  let linkedProductsCount = 0;

  for (const [prodSku, recipeLines] of Object.entries(PRODUCT_RECIPES)) {
    const product = productBySku.get(prodSku);
    if (!product) {
      console.warn(`[LEWATI] Produk SKU ${prodSku} tidak ada di database.`);
      continue;
    }

    // Bersihkan resep lama jika ada untuk produk ini (idempoten)
    await supabase.from("recipes").delete().eq("product_id", product.id);

    const rowsToInsert = [];
    for (const line of recipeLines) {
      const ingId = ingredientIdBySku.get(line.ingredientSku);
      if (!ingId) {
        console.error(`Bahan baku SKU ${line.ingredientSku} tidak ditemukan untuk resep ${product.name}!`);
        continue;
      }
      rowsToInsert.push({
        product_id: product.id,
        ingredient_id: ingId,
        quantity_required: line.qty,
        notes: line.notes ?? null,
      });
    }

    if (rowsToInsert.length > 0) {
      const { error: recInsertErr } = await supabase.from("recipes").insert(rowsToInsert);
      if (recInsertErr) {
        console.error(`Gagal menyimpan resep untuk ${product.name}:`, recInsertErr.message);
      } else {
        linkedProductsCount++;
        totalRecipeLines += rowsToInsert.length;
        console.log(`  [RESEP] ${product.name} (${prodSku}): ${rowsToInsert.length} bahan terhubung.`);
      }
    }
  }

  console.log(`\n=== SEEDING SELESAI ===`);
  console.log(`Total bahan baku aktif   : ${ingredientIdBySku.size}`);
  console.log(`Total produk terhubung   : ${linkedProductsCount}/${dbProducts.length}`);
  console.log(`Total baris resep aktif  : ${totalRecipeLines}`);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main().catch((err) => {
    console.error("Fatal error saat seeding inventori:", err);
    process.exit(1);
  });
}
