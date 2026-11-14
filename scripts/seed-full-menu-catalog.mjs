#!/usr/bin/env node
/**
 * NINE LICIOUS POS - FULL MENU CATALOG SEEDER & STORAGE SYNC
 *
 * Populates 40 items across 4 categories (Food, Drinks, Desserts, Packages).
 * Uploads generated AI food photographs from brain artifacts to Supabase Storage bucket 'product-photos'.
 * Links photo_url and photo_path to each product record in 'public.products'.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd(), true);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error("Missing Supabase credentials in environment.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

const BRAIN_DIR = "C:/Users/THINKPAD/.gemini/antigravity/brain/8b160ec4-566c-476f-860b-7ade60001432";

// 40 Products Catalog Definition
const CATALOG_ITEMS = [
  // ---------------- FOOD (12 items) ----------------
  {
    categorySlug: "food",
    name: "Chicken Katsu Rice",
    sku: "FD-001",
    price: 32000,
    kitchenStation: "kitchen",
    description: "Nasi putih hangat dengan potongan daging ayam goreng renyah katsu khas Jepang, disiram saus tonkatsu gurih dan kol segar.",
    imagePrefix: "chicken_katsu_rice",
    sortOrder: 10,
  },
  {
    categorySlug: "food",
    name: "Chicken Teriyaki Rice",
    sku: "FD-002",
    price: 32000,
    kitchenStation: "kitchen",
    description: "Potongan ayam panggang empuk dengan saus teriyaki manis gurih, taburan biji wijen sangrai, dan brokoli kukus segar.",
    imagePrefix: "chicken_teriyaki_rice",
    sortOrder: 20,
  },
  {
    categorySlug: "food",
    name: "Beef Yakiniku Rice",
    sku: "FD-003",
    price: 42000,
    kitchenStation: "kitchen",
    description: "Irisan daging sapi premium ditumis dengan bawang bombay dan saus yakiniku khas Jepang yang gurih dan beraroma harum.",
    imagePrefix: "beef_yakiniku_rice",
    sortOrder: 30,
  },
  {
    categorySlug: "food",
    name: "Chicken Black Pepper Rice",
    sku: "FD-004",
    price: 33000,
    kitchenStation: "kitchen",
    description: "Ayam empuk berpadu dengan saus lada hitam pedas gurih, paprika merah hijau, dan bawang bombay di atas nasi pulen.",
    imagePrefix: "chicken_black_pepper_rice",
    sortOrder: 40,
  },
  {
    categorySlug: "food",
    name: "Nasi Goreng Special",
    sku: "FD-005",
    price: 28000,
    kitchenStation: "kitchen",
    description: "Nasi goreng bumbu rempah spesial Nine Licious, disajikan dengan telur mata sapi, ayam goreng, acar, dan kerupuk renyah.",
    imagePrefix: "nasi_goreng_special",
    sortOrder: 50,
  },
  {
    categorySlug: "food",
    name: "Spaghetti Bolognese",
    sku: "FD-006",
    price: 35000,
    kitchenStation: "kitchen",
    description: "Pasta spaghetti al dente disiram saus daging cincang sapi segar dan tomat ragù slow-cooked, ditaburi keju parmesan.",
    imagePrefix: "spaghetti_bolognese",
    sortOrder: 60,
  },
  {
    categorySlug: "food",
    name: "Spaghetti Carbonara",
    sku: "FD-007",
    price: 37000,
    kitchenStation: "kitchen",
    description: "Pasta krim lembut khas Italia dengan potongan beef bacon renyah, keju parmesan, kuning telur, dan lada hitam tumbuk.",
    imagePrefix: "spaghetti_carbonara",
    sortOrder: 70,
  },
  {
    categorySlug: "food",
    name: "Chicken Wings",
    sku: "FD-008",
    price: 26000,
    kitchenStation: "kitchen",
    description: "6 potong sayap ayam goreng renyah dengan balutan saus barbeque manis gurih pedas dan taburan biji wijen.",
    imagePrefix: "chicken_wings",
    sortOrder: 80,
  },
  {
    categorySlug: "food",
    name: "French Fries",
    sku: "FD-009",
    price: 18000,
    kitchenStation: "kitchen",
    description: "Kentang goreng potongan tebal yang renyah di luar dan lembut di dalam, ditaburi garam laut dan rempah rosemary.",
    imagePrefix: "french_fries",
    sortOrder: 90,
  },
  {
    categorySlug: "food",
    name: "Beef Burger",
    sku: "FD-010",
    price: 36000,
    kitchenStation: "kitchen",
    description: "Burger daging sapi panggang tebal dan juicy, keju cheddar meleleh, selada segar, tomat, dan saus spesial dalam roti brioche wijen.",
    imagePrefix: "beef_burger",
    sortOrder: 100,
  },
  {
    categorySlug: "food",
    name: "Chicken Burger",
    sku: "FD-011",
    price: 30000,
    kitchenStation: "kitchen",
    description: "Burger paha ayam goreng buttermilk super renyah dengan coleslaw segar, acar timun, dan saus mayo pedas di roti brioche lembut.",
    imagePrefix: "chicken_burger",
    sortOrder: 110,
  },
  {
    categorySlug: "food",
    name: "Fish and Chips",
    sku: "FD-012",
    price: 38000,
    kitchenStation: "kitchen",
    description: "Fillet ikan dori berbalut tepung renyah keemasan, disajikan bersama kentang goreng gurih, saus tartar segar, dan irisan lemon.",
    imagePrefix: "fish_and_chips",
    sortOrder: 120,
  },

  // ---------------- DRINKS (12 items) ----------------
  {
    categorySlug: "drinks",
    name: "Iced Tea",
    sku: "DR-001",
    price: 8000,
    kitchenStation: "bar",
    description: "Teh hitam melati pilihan diseduh segar, disajikan dingin dengan es batu kristal yang menyegarkan dahaga.",
    imagePrefix: "iced_tea",
    sortOrder: 10,
  },
  {
    categorySlug: "drinks",
    name: "Lemon Tea",
    sku: "DR-002",
    price: 14000,
    kitchenStation: "bar",
    description: "Perpaduan teh hitam segar dan perasan jeruk lemon asli dengan irisan lemon dan daun mint dingin.",
    imagePrefix: "lemon_tea",
    sortOrder: 20,
  },
  {
    categorySlug: "drinks",
    name: "Lychee Tea",
    sku: "DR-003",
    price: 18000,
    kitchenStation: "bar",
    description: "Teh seduh dingin beraroma leci manis alami dengan buah leci utuh segar dan es batu melimpah.",
    imagePrefix: "lychee_tea",
    sortOrder: 30,
  },
  {
    categorySlug: "drinks",
    name: "Strawberry Tea",
    sku: "DR-004",
    price: 18000,
    kitchenStation: "bar",
    description: "Teh dingin dengan ekstrak buah stroberi merah segar dan potongan buah stroberi manis asam yang menyegarkan.",
    imagePrefix: "strawberry_tea",
    sortOrder: 40,
  },
  {
    categorySlug: "drinks",
    name: "Matcha Latte",
    sku: "DR-005",
    price: 24000,
    kitchenStation: "bar",
    description: "Teh hijau matcha Uji murni berpadu harmonis dengan susu segar dingin, menciptakan lapisan gradasi warna yang indah.",
    imagePrefix: "matcha_latte",
    sortOrder: 50,
  },
  {
    categorySlug: "drinks",
    name: "Chocolate Milk",
    sku: "DR-006",
    price: 22000,
    kitchenStation: "bar",
    description: "Susu cokelat kental dan creamy dengan kakao berkualitas tinggi serta siraman saus cokelat gelap pekat.",
    imagePrefix: "chocolate_milk",
    sortOrder: 60,
  },
  {
    categorySlug: "drinks",
    name: "Strawberry Milk",
    sku: "DR-007",
    price: 22000,
    kitchenStation: "bar",
    description: "Susu segar dingin gaya Korea dengan selai stroberi chunks buatan sendiri dan potongan stroberi asli.",
    imagePrefix: "strawberry_milk",
    sortOrder: 70,
  },
  {
    categorySlug: "drinks",
    name: "Taro Milk",
    sku: "DR-008",
    price: 22000,
    kitchenStation: "bar",
    description: "Minuman taro ungu beraroma wangi manis khas talas, dipadukan dengan susu murni segar dan es batu.",
    imagePrefix: "taro_milk",
    sortOrder: 80,
  },
  {
    categorySlug: "drinks",
    name: "Café Latte",
    sku: "DR-009",
    price: 24000,
    kitchenStation: "bar",
    description: "Single shot espresso biji kopi arabika pilihan dengan steamed fresh milk berbusa mikro halus dan latte art cantik.",
    imagePrefix: "cafe_latte",
    sortOrder: 90,
  },
  {
    categorySlug: "drinks",
    name: "Americano",
    sku: "DR-010",
    price: 20000,
    kitchenStation: "bar",
    description: "Espresso ganda murni berpadu air mineral dingin dan es batu, menghadirkan aroma kopi bold yang tajam dan segar.",
    imagePrefix: "americano",
    sortOrder: 100,
  },
  {
    categorySlug: "drinks",
    name: "Cappuccino",
    sku: "DR-011",
    price: 24000,
    kitchenStation: "bar",
    description: "Espresso hangat berimbang dengan susu berbusa tebal lembut, ditaburi serbuk kakao premium di atasnya.",
    imagePrefix: "cappuccino",
    sortOrder: 110,
  },
  {
    categorySlug: "drinks",
    name: "Mango Yakult",
    sku: "DR-012",
    price: 22000,
    kitchenStation: "bar",
    description: "Minuman asam manis menyegarkan dari puree mangga harum manis berpadu susu fermentasi probiotik Yakult dingin.",
    imagePrefix: "mango_yakult",
    sortOrder: 120,
  },

  // ---------------- DESSERTS (10 items) ----------------
  {
    categorySlug: "desserts",
    name: "Chocolate Lava Cake",
    sku: "DS-001",
    price: 28000,
    kitchenStation: "dessert",
    description: "Kue cokelat panggang hangat dengan lelehan cokelat pekat cair di tengahnya, taburan gula halus, dan es krim vanila.",
    imagePrefix: "chocolate_lava_cake",
    sortOrder: 10,
  },
  {
    categorySlug: "desserts",
    name: "Brownies",
    sku: "DS-002",
    price: 22000,
    kitchenStation: "dessert",
    description: "Fudge brownies cokelat pekat bertekstur padat lembut dengan lapisan atas crinkle mengkilap dan potongan kacang kenari.",
    imagePrefix: "brownies",
    sortOrder: 20,
  },
  {
    categorySlug: "desserts",
    name: "Cheesecake",
    sku: "DS-003",
    price: 32000,
    kitchenStation: "dessert",
    description: "Potongan New York baked cheesecake yang lembut creamy dengan dasar biskuit renyah dan selai buah berry segar.",
    imagePrefix: "cheesecake",
    sortOrder: 30,
  },
  {
    categorySlug: "desserts",
    name: "Tiramisu",
    sku: "DS-004",
    price: 32000,
    kitchenStation: "dessert",
    description: "Dessert klasik Italia dengan lapisan biskuit ladyfinger beraroma espresso dan krim mascarpone lembut ditaburi kakao.",
    imagePrefix: "tiramisu",
    sortOrder: 40,
  },
  {
    categorySlug: "desserts",
    name: "Waffle",
    sku: "DS-005",
    price: 24000,
    kitchenStation: "dessert",
    description: "Waffle Belgia renyah keemasan bertabur gula halus, disajikan bersama sirup maple hangat, mentega, dan buah berry.",
    imagePrefix: "waffle",
    sortOrder: 50,
  },
  {
    categorySlug: "desserts",
    name: "Pancake",
    sku: "DS-006",
    price: 24000,
    kitchenStation: "dessert",
    description: "Tumpukan tiga lapis pancake buttermilk yang empuk dan mengembang, disiram mentega leleh dan sirup maple manis.",
    imagePrefix: "pancake",
    sortOrder: 60,
  },
  {
    categorySlug: "desserts",
    name: "Pudding",
    sku: "DS-007",
    price: 16000,
    kitchenStation: "dessert",
    description: "Puding karamel susu sutra yang lembut lumer di lidah, bermandikan saus karamel manis kecokelatan yang harum.",
    imagePrefix: "pudding",
    sortOrder: 70,
  },
  {
    categorySlug: "desserts",
    name: "Vanilla Ice Cream",
    sku: "DS-008",
    price: 15000,
    kitchenStation: "dessert",
    description: "Tiga scoop es krim vanila lembut berbahan dasar biji vanila asli Madagaskar, disajikan dengan wafer stik renyah.",
    imagePrefix: "vanilla_ice_cream",
    sortOrder: 80,
  },
  {
    categorySlug: "desserts",
    name: "Chocolate Ice Cream",
    sku: "DS-009",
    price: 15000,
    kitchenStation: "dessert",
    description: "Tiga scoop es krim cokelat pekat lezat yang creamy, ditaburi serpihan cokelat hitam dan siraman saus cokelat.",
    imagePrefix: "chocolate_ice_cream",
    sortOrder: 90,
  },
  {
    categorySlug: "desserts",
    name: "Strawberry Ice Cream",
    sku: "DS-010",
    price: 15000,
    kitchenStation: "dessert",
    description: "Tiga scoop es krim stroberi manis segar dengan bulir buah stroberi asli dalam gelas coupe dessert elegan.",
    imagePrefix: "strawberry_ice_cream",
    sortOrder: 100,
  },

  // ---------------- PACKAGES (6 items) ----------------
  {
    categorySlug: "packages",
    name: "Chicken Katsu Package",
    sku: "PK-001",
    price: 42000,
    kitchenStation: "kitchen",
    description: "Paket lengkap hemat: Chicken Katsu Rice + Iced Tea segar + porsi kecil French Fries renyah.",
    imagePrefix: "chicken_katsu_package",
    sortOrder: 10,
  },
  {
    categorySlug: "packages",
    name: "Chicken Teriyaki Package",
    sku: "PK-002",
    price: 42000,
    kitchenStation: "kitchen",
    description: "Paket kenyang: Chicken Teriyaki Rice dengan wijen dan brokoli + Iced Tea dingin + kentang goreng renyah.",
    imagePrefix: "chicken_teriyaki_package",
    sortOrder: 20,
  },
  {
    categorySlug: "packages",
    name: "Burger Package",
    sku: "PK-003",
    price: 48000,
    kitchenStation: "kitchen",
    description: "Paket burger komplit: Gourmet Beef Burger keju meleleh + French Fries renyah + Lemon Tea segar.",
    imagePrefix: "burger_package",
    sortOrder: 30,
  },
  {
    categorySlug: "packages",
    name: "Chicken Wings Package",
    sku: "PK-004",
    price: 38000,
    kitchenStation: "kitchen",
    description: "Paket puas: 6 pcs Chicken Wings bumbu lezat + nasi putih pulen hangat + Iced Tea segar.",
    imagePrefix: "chicken_wings_package",
    sortOrder: 40,
  },
  {
    categorySlug: "packages",
    name: "Spaghetti Package",
    sku: "PK-005",
    price: 46000,
    kitchenStation: "kitchen",
    description: "Paket pasta Italia: Spaghetti Bolognese daging cincang sapi + 2 potong Garlic Bread renyah + Lemon Tea.",
    imagePrefix: "spaghetti_package",
    sortOrder: 50,
  },
  {
    categorySlug: "packages",
    name: "Dessert Package",
    sku: "PK-006",
    price: 42000,
    kitchenStation: "kitchen",
    description: "Paket manis penutup: Chocolate Lava Cake lumer + satu scoop Vanilla Ice Cream + Americano dingin/panas.",
    imagePrefix: "dessert_package",
    sortOrder: 60,
  },
];

async function seedCatalog() {
  console.log("=== NINE LICIOUS POS - MENU CATALOG SEEDER & SYNC ===");

  // 1. Fetch categories
  const { data: categories, error: catError } = await supabase.from("menu_categories").select("id, slug");
  if (catError || !categories) {
    console.error("Gagal mengambil data menu_categories:", catError);
    process.exit(1);
  }
  const categoryMap = Object.fromEntries(categories.map((c) => [c.slug, c.id]));
  console.log("Categories mapped:", Object.keys(categoryMap));

  // 2. Scan files in brain directory
  const brainFiles = existsSync(BRAIN_DIR) ? readdirSync(BRAIN_DIR) : [];
  console.log(`Ditemukan ${brainFiles.length} file di brain artifact directory.`);

  let successCount = 0;
  let imageUploadedCount = 0;

  for (const item of CATALOG_ITEMS) {
    const categoryId = categoryMap[item.categorySlug];
    if (!categoryId) {
      console.warn(`Category slug '${item.categorySlug}' tidak ditemukan di database untuk ${item.name}!`);
      continue;
    }

    // Check if product exists
    const { data: existing } = await supabase
      .from("products")
      .select("id, photo_path, photo_url")
      .eq("sku", item.sku)
      .maybeSingle();

    const productId = existing?.id || randomUUID();

    // Find matching generated image file
    const matchedFile = brainFiles.find((f) => f.startsWith(`${item.imagePrefix}_`) && f.endsWith(".jpg"));
    let photoPath = existing?.photo_path || null;
    let photoUrl = existing?.photo_url || null;

    if (matchedFile) {
      const localFilePath = join(BRAIN_DIR, matchedFile);
      const fileBytes = readFileSync(localFilePath);
      const storageKey = `products/${productId}/${randomUUID()}.jpg`;

      const { error: uploadErr } = await supabase.storage
        .from("product-photos")
        .upload(storageKey, fileBytes, {
          contentType: "image/jpeg",
          upsert: true,
        });

      if (uploadErr) {
        console.error(`Gagal upload foto untuk ${item.name}:`, uploadErr.message);
      } else {
        photoPath = storageKey;
        const { data: urlData } = supabase.storage.from("product-photos").getPublicUrl(storageKey);
        photoUrl = urlData.publicUrl;
        imageUploadedCount++;
      }
    }

    const payload = {
      id: productId,
      category_id: categoryId,
      name: item.name,
      sku: item.sku,
      price: item.price,
      description: item.description,
      kitchen_station: item.kitchenStation,
      sort_order: item.sortOrder,
      is_active: true,
      is_available: true,
      photo_path: photoPath,
      photo_url: photoUrl,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      const { error: updErr } = await supabase.from("products").update(payload).eq("id", productId);
      if (updErr) {
        console.error(`Gagal update produk ${item.name}:`, updErr.message);
      } else {
        successCount++;
        console.log(`✓ Updated [${item.sku}] ${item.name} | Photo: ${Boolean(photoUrl)}`);
      }
    } else {
      payload.created_at = new Date().toISOString();
      const { error: insErr } = await supabase.from("products").insert(payload);
      if (insErr) {
        console.error(`Gagal insert produk ${item.name}:`, insErr.message);
      } else {
        successCount++;
        console.log(`✓ Inserted [${item.sku}] ${item.name} | Photo: ${Boolean(photoUrl)}`);
      }
    }
  }

  console.log("\n=======================================================");
  console.log(`RINGKASAN: ${successCount} produk berhasil disinkronkan, ${imageUploadedCount} foto berhasil diunggah.`);
  console.log("=======================================================");
}

seedCatalog();
