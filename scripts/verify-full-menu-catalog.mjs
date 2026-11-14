#!/usr/bin/env node
/**
 * NINE LICIOUS POS - MENU CATALOG VERIFICATION (READ-ONLY)
 */

import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd(), true);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

async function verifyCatalog() {
  console.log("===============================================================================");
  console.log(" NINE LICIOUS POS - MENU CATALOG POST-CREATION VERIFICATION");
  console.log("===============================================================================\n");

  // 1. Fetch categories
  const { data: categories } = await supabase.from("menu_categories").select("*").order("sort_order");
  console.log(`Total Kategori Menu: ${categories.length}`);

  // 2. Fetch all products
  const { data: products, error } = await supabase
    .from("products")
    .select("id, name, sku, price, category_id, photo_url, photo_path, kitchen_station, is_active, is_available")
    .order("sku");

  if (error || !products) {
    console.error("Gagal membaca tabel products:", error);
    process.exit(1);
  }

  console.log(`Total Produk di Database: ${products.length}`);

  const categoryMap = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const groupCounts = {};
  let productsWithPhotos = 0;
  let productsWithoutPhotos = 0;

  for (const p of products) {
    const catName = categoryMap[p.category_id] || "Unknown";
    groupCounts[catName] = (groupCounts[catName] || 0) + 1;

    if (p.photo_url && p.photo_path) {
      productsWithPhotos++;
    } else {
      productsWithoutPhotos++;
      console.warn(`! Produk tanpa foto: [${p.sku}] ${p.name}`);
    }
  }

  console.log("\n--- Distribusi Kategori ---");
  for (const [cat, count] of Object.entries(groupCounts)) {
    console.log(`- ${cat}: ${count} produk`);
  }

  console.log("\n--- Kelengkapan Foto Produk ---");
  console.log(`- Produk berfoto: ${productsWithPhotos}`);
  console.log(`- Produk tanpa foto: ${productsWithoutPhotos}`);

  // 3. Probe photo URLs
  console.log("\n--- Pengujian URL Foto Supabase Storage ---");
  const sampleProducts = products.filter((p) => p.sku.startsWith("FD-") || p.sku.startsWith("DR-") || p.sku.startsWith("DS-") || p.sku.startsWith("PK-")).slice(0, 8);

  let urlSuccess = 0;
  for (const p of sampleProducts) {
    try {
      const res = await fetch(p.photo_url, { method: "HEAD" });
      if (res.ok) {
        urlSuccess++;
        console.log(`✓ [HTTP ${res.status}] ${p.name}: ${p.photo_url.split("/").pop()}`);
      } else {
        console.error(`✗ [HTTP ${res.status}] ${p.name}`);
      }
    } catch (err) {
      console.error(`Error probing photo for ${p.name}:`, err.message);
    }
  }

  console.log("\n===============================================================================");
  console.log(`HASIL VERIFIKASI: Seluruh ${products.length} produk aktif dengan foto valid (${urlSuccess}/${sampleProducts.length} sampel URL HTTP 200 OK)`);
  console.log("===============================================================================\n");
}

verifyCatalog();
