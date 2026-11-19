import pkg from "@next/env";
import { createClient } from "@supabase/supabase-js";

const { loadEnvConfig } = pkg;
loadEnvConfig(process.cwd(), true);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function calculateOpeningStockPlan() {
  const { data: ingredients } = await supabase
    .from("ingredients")
    .select("*")
    .order("sku", { ascending: true });

  const { data: recipes } = await supabase
    .from("recipes")
    .select("product_id, ingredient_id, quantity_required");

  const { data: products } = await supabase
    .from("products")
    .select("id, name, sku");

  const prodLookup = new Map(products.map((p) => [p.id, p]));

  // Agregasi penggunaan bahan per porsi
  const usageMap = new Map();
  for (const r of recipes) {
    const prev = usageMap.get(r.ingredient_id) || {
      count: 0,
      sumPortion: 0,
      maxSinglePortion: 0,
      products: []
    };
    const qty = Number(r.quantity_required);
    prev.count += 1;
    prev.sumPortion += qty;
    if (qty > prev.maxSinglePortion) prev.maxSinglePortion = qty;
    const prod = prodLookup.get(r.product_id);
    if (prod) prev.products.push({ name: prod.name, qty });
    usageMap.set(r.ingredient_id, prev);
  }

  console.log("=== RENCANA SALDO AWAL OPERASIONAL 74 BAHAN BAKU ===\n");

  const plan = [];

  for (const ing of ingredients) {
    const current = Number(ing.current_stock);
    const minStock = Number(ing.min_stock);
    const usage = usageMap.get(ing.id);

    let targetStock = 0;

    // Strategi penentuan saldo awal:
    // 1. Jika current_stock sudah sangat besar dan positif (misal Air Mineral 499750 atau Kopi 10000), pertahankan jika sudah di atas min_stock.
    // 2. Berdasarkan rasionalitas kapasitas operasional restoran (cukupi minimal 50-200 porsi dan minimal 3x min_stock):
    if (ing.sku === "ING-BEVG-13") {
      // Air mineral
      targetStock = Math.max(current, 500000); // 500 liter
    } else if (ing.sku === "ING-PROT-01") {
      // Ayam fillet: 150g/porsi, 100 porsi = 15.000g, min_stock 3000g -> target 20.000g
      targetStock = 20000;
    } else if (ing.sku === "ING-PROT-02") {
      // Sayap ayam: 4-6 pcs/porsi, min 60 -> target 300 pcs
      targetStock = 300;
    } else if (ing.sku === "ING-PROT-03") {
      // Daging sapi slice: 120g/porsi, min 2000g -> target 10000g
      targetStock = 10000;
    } else if (ing.sku === "ING-PROT-04") {
      // Daging sapi cincang: min 2000g -> target 10000g
      targetStock = 10000;
    } else if (ing.sku === "ING-PROT-05") {
      // Patty burger: min 2000g -> target 10000g
      targetStock = 10000;
    } else if (ing.sku === "ING-PROT-06") {
      // Ikan dori fillet: 150g/porsi, min 2000g -> target 10000g
      targetStock = 10000;
    } else if (ing.sku === "ING-PROT-07") {
      // Beef bacon: min 1000g -> target 10000g (saat ini sudah 10000)
      targetStock = Math.max(current, 10000);
    } else if (ing.sku === "ING-PROT-08") {
      // Telur ayam: min 50 pcs -> target 300 pcs
      targetStock = 300;
    } else if (ing.sku === "ING-CARB-01") {
      // Beras: min 5000g -> target 30000g (30 kg)
      targetStock = 30000;
    } else if (ing.sku === "ING-CARB-02") {
      // Spaghetti: min 2000g -> target 10000g
      targetStock = 10000;
    } else if (ing.sku === "ING-CARB-03") {
      // Kentang beku: min 3000g -> target 20000g
      targetStock = 20000;
    } else if (ing.sku === "ING-CARB-04") {
      // Burger bun: min 20 pcs -> target 100 pcs
      targetStock = 100;
    } else if (ing.sku === "ING-CARB-05") {
      // Baguette: min 20 pcs -> target 80 pcs
      targetStock = 80;
    } else if (ing.sku === "ING-CARB-06") {
      // Ladyfinger: min 30 pcs -> target 150 pcs
      targetStock = 150;
    } else if (ing.sku === "ING-CARB-07") {
      // Biskuit renyah crust: min 500g -> target 3000g
      targetStock = 3000;
    } else if (ing.sku === "ING-FLOU-01") {
      // Tepung terigu: min 2000g -> target 20000g
      targetStock = 20000;
    } else if (ing.sku === "ING-FLOU-02") {
      // Tepung maizena: min 1000g -> target 5000g
      targetStock = 5000;
    } else if (ing.sku === "ING-FLOU-03") {
      // Tepung panir: min 1000g -> target 5000g
      targetStock = 5000;
    } else if (ing.sku === "ING-SEAS-01") {
      // Minyak goreng: min 5000ml -> target 30000ml (30 L)
      targetStock = 30000;
    } else if (ing.sku === "ING-SEAS-02") {
      // Butter: min 1000g -> target 6000g
      targetStock = 6000;
    } else if (ing.sku === "ING-SEAS-03") {
      // Gula pasir: min 3000g -> target 20000g
      targetStock = 20000;
    } else if (ing.sku === "ING-SEAS-04") {
      // Gula cair: min 2000ml -> target 10000ml
      targetStock = 10000;
    } else if (ing.sku === "ING-SEAS-05") {
      // Garam: min 500g -> target 5000g
      targetStock = 5000;
    } else if (ing.sku.startsWith("ING-SEAS-")) {
      // Bumbu & saus dapur lainnya: minimal 5x min_stock
      targetStock = Math.max(minStock * 5, 3000);
    } else if (ing.sku === "ING-BEVG-01") {
      // Teh hitam: min 1000g -> target 5000g (1000 porsi teh)
      targetStock = 5000;
    } else if (ing.sku === "ING-BEVG-02") {
      // Biji kopi: sudah 10000g
      targetStock = Math.max(current, 10000);
    } else if (ing.sku === "ING-BEVG-03") {
      // Susu sapi segar: min 5000ml -> target 30000ml (30 L)
      targetStock = 30000;
    } else if (ing.sku === "ING-BEVG-11") {
      // Yakult: min 20 pcs -> target 120 pcs
      targetStock = 120;
    } else if (ing.sku === "ING-BEVG-12") {
      // Es batu: min 10000g -> target 50000g (50 kg)
      targetStock = 50000;
    } else if (ing.sku.startsWith("ING-BEVG-")) {
      // Minuman serbuk & sirup lainnya: minimal 5x min_stock
      targetStock = Math.max(minStock * 5, 4000);
    } else if (ing.sku === "ING-VEGE-01") {
      // Bawang bombay: sudah 10000g
      targetStock = Math.max(current, 10000);
    } else if (ing.sku === "ING-VEGE-06") {
      // Lemon segar: min 20 pcs -> target 100 pcs
      targetStock = 100;
    } else if (ing.sku === "ING-VEGE-07" || ing.sku === "ING-VEGE-08") {
      // Stroberi & Leci: min 30 pcs -> target 150 pcs
      targetStock = 150;
    } else if (ing.sku.startsWith("ING-VEGE-")) {
      // Sayuran segar lainnya: min 500g -> target 3000g
      targetStock = Math.max(minStock * 5, 3000);
    } else if (ing.sku === "ING-DEST-06" || ing.sku === "ING-DEST-16") {
      // Keju cheddar slice / Wafer stik (pcs): min 20-30 pcs -> target 150 pcs
      targetStock = 150;
    } else if (ing.sku.startsWith("ING-DEST-")) {
      // Bahan dessert: minimal 4-5x min_stock
      targetStock = Math.max(minStock * 4, 3000);
    } else if (ing.sku === "POP-ES-03") {
      targetStock = Math.max(current, 10);
    } else {
      targetStock = Math.max(minStock * 3, 1000);
    }

    const delta = targetStock - current;

    plan.push({
      id: ing.id,
      sku: ing.sku,
      name: ing.name,
      unit: ing.unit,
      current,
      target: targetStock,
      delta,
      minStock,
      usageCount: usage?.count || 0
    });
  }

  // Tampilkan tabel perbandingan
  console.log("SKU          | Nama                         | Satuan | Saldo Lama | Saldo Baru | Penyesuaian (Delta) | Min");
  console.log("-".repeat(95));
  for (const p of plan) {
    console.log(
      `${p.sku.padEnd(12)} | ${p.name.padEnd(28)} | ${p.unit.padEnd(6)} | ` +
      `${String(p.current).padStart(10)} | ${String(p.target).padStart(10)} | ` +
      `${String(p.delta > 0 ? "+" + p.delta : p.delta).padStart(19)} | ${p.minStock}`
    );
  }
}

calculateOpeningStockPlan().catch(console.error);
