import pkg from "@next/env";
import { createClient } from "@supabase/supabase-js";

const { loadEnvConfig } = pkg;
loadEnvConfig(process.cwd(), true);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error("Missing Supabase credentials.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

async function runAudit() {
  console.log("=== MEMULAI AUDIT DATABASE SUPABASE NINE LICIOUS ===\n");

  // 1. Audit Tabel Ingredients
  const { data: ingredients, error: ingErr, count: ingCount } = await supabase
    .from("ingredients")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: true });

  if (ingErr) {
    console.error("Gagal membaca tabel ingredients:", ingErr.message);
  } else {
    console.log(`[1] TABEL INGREDIENTS:`);
    console.log(`- Jumlah baris aktual: ${ingCount}`);
    
    // Cek duplikasi SKU
    const skuMap = new Map();
    const nameMap = new Map();
    let dupSku = 0;
    let dupName = 0;
    let zeroStockCount = 0;
    let positiveStockCount = 0;
    const positiveStockList = [];

    for (const ing of ingredients) {
      if (skuMap.has(ing.sku)) dupSku++;
      else skuMap.set(ing.sku, ing.id);

      const normName = ing.name.trim().toLowerCase();
      if (nameMap.has(normName)) dupName++;
      else nameMap.set(normName, ing.id);

      const stockNum = Number(ing.current_stock);
      if (stockNum > 0) {
        positiveStockCount++;
        positiveStockList.push({ sku: ing.sku, name: ing.name, stock: stockNum, unit: ing.unit });
      } else {
        zeroStockCount++;
      }
    }

    console.log(`- Duplikasi SKU: ${dupSku}`);
    console.log(`- Duplikasi Nama: ${dupName}`);
    console.log(`- Bahan dengan current_stock > 0: ${positiveStockCount}`, positiveStockList);
    console.log(`- Bahan dengan current_stock = 0: ${zeroStockCount}`);
  }

  // 2. Audit Tabel Recipes
  const { data: recipes, error: recErr, count: recCount } = await supabase
    .from("recipes")
    .select("id, product_id, ingredient_id, quantity_required", { count: "exact" });

  if (recErr) {
    console.error("Gagal membaca tabel recipes:", recErr.message);
  } else {
    console.log(`\n[2] TABEL RECIPES:`);
    console.log(`- Total baris resep aktual: ${recCount}`);

    const productIdsWithRecipe = new Set(recipes.map((r) => r.product_id));
    console.log(`- Jumlah produk unik yang punya resep: ${productIdsWithRecipe.size}`);

    // Cek duplikasi (product_id, ingredient_id)
    const recPairMap = new Set();
    let dupPair = 0;
    for (const r of recipes) {
      const key = `${r.product_id}:${r.ingredient_id}`;
      if (recPairMap.has(key)) dupPair++;
      recPairMap.add(key);
    }
    console.log(`- Duplikasi baris resep (product_id, ingredient_id): ${dupPair}`);
  }

  // 3. Audit Tabel Menu Categories & Products
  const { data: categories } = await supabase
    .from("menu_categories")
    .select("id, name, slug");

  const catMap = new Map((categories || []).map((c) => [c.id, c.name]));

  const { data: products, error: prodErr, count: prodCount } = await supabase
    .from("products")
    .select("id, category_id, name, sku, price, description, is_active")
    .order("name", { ascending: true });

  if (prodErr) {
    console.error("Gagal membaca tabel products:", prodErr.message);
  } else {
    console.log(`\n[3] TABEL PRODUCTS:`);
    console.log(`- Total produk di database: ${prodCount}`);

    const recPids = new Set(recipes ? recipes.map((r) => r.product_id) : []);
    const linked = products.filter((p) => recPids.has(p.id));
    const unlinked = products.filter((p) => !recPids.has(p.id));
    console.log(`- Produk terhubung resep: ${linked.length} dari ${products.length}`);
    if (unlinked.length > 0) {
      console.log(`- Produk BELUM terhubung resep (${unlinked.length}):`, unlinked.map((p) => p.name));
    } else {
      console.log(`- SEMUA ${products.length} PRODUK SUDAH TERHUBUNG KE RESEP.`);
    }

    // Breakdown per kategori
    const catBreakdown = {};
    for (const p of products) {
      const cname = catMap.get(p.category_id) || "Tanpa Kategori";
      catBreakdown[cname] = (catBreakdown[cname] || 0) + 1;
    }
    console.log(`- Distribusi kategori produk:`, catBreakdown);

    // Detail Paket di database
    const pkgProducts = products.filter((p) => {
      const cname = (catMap.get(p.category_id) || "").toLowerCase();
      return cname.includes("package") || p.name.toLowerCase().includes("package");
    });
    console.log(`\n[3.1] DETAIL PRODUK PAKET DI DATABASE (${pkgProducts.length} paket):`);
    for (const pkg of pkgProducts) {
      const pkgRecipes = (recipes || []).filter((r) => r.product_id === pkg.id);
      console.log(`\n* Paket: "${pkg.name}" (SKU: ${pkg.sku}, ID: ${pkg.id})`);
      console.log(`  Harga: Rp ${pkg.price.toLocaleString("id-ID")}`);
      console.log(`  Deskripsi di DB: "${pkg.description || '-'}"`);
      console.log(`  Jumlah baris resep: ${pkgRecipes.length}`);
      
      // Tampilkan bahan-bahan resep paket
      if (pkgRecipes.length > 0 && ingredients) {
        const ingLookup = new Map(ingredients.map((i) => [i.id, i]));
        for (const pr of pkgRecipes) {
          const ing = ingLookup.get(pr.ingredient_id);
          console.log(`    - ${ing ? ing.name : pr.ingredient_id}: ${pr.quantity_required} ${ing ? ing.unit : ''}`);
        }
      }
    }
  }

  // 4. Audit Tabel Stock Movements
  const { data: movements, error: movErr, count: movCount } = await supabase
    .from("stock_movements")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: true });

  if (movErr) {
    console.error("Gagal membaca tabel stock_movements:", movErr.message);
  } else {
    console.log(`\n[4] TABEL STOCK MOVEMENTS:`);
    console.log(`- Total baris stock movements: ${movCount}`);

    const typeBreakdown = {};
    const reasonBreakdown = {};
    let initialStockCount = 0;
    const idempotencySet = new Set();
    let dupIdempotency = 0;

    for (const m of movements) {
      typeBreakdown[m.movement_type] = (typeBreakdown[m.movement_type] || 0) + 1;
      reasonBreakdown[m.reason] = (reasonBreakdown[m.reason] || 0) + 1;
      if (m.reason === "Initial Stock") initialStockCount++;
      if (m.idempotency_key) {
        if (idempotencySet.has(m.idempotency_key)) dupIdempotency++;
        idempotencySet.add(m.idempotency_key);
      }
    }

    console.log(`- Breakdown per movement_type:`, typeBreakdown);
    console.log(`- Breakdown per reason:`, reasonBreakdown);
    console.log(`- Jumlah mutasi 'Initial Stock': ${initialStockCount}`);
    console.log(`- Duplikasi idempotency_key: ${dupIdempotency}`);
    if (movements.length > 0) {
      console.log(`- Seluruh mutasi yang ada di DB:`, movements.map((m) => ({
        id: m.id,
        type: m.movement_type,
        qty: m.quantity,
        before: m.balance_before,
        after: m.balance_after,
        reason: m.reason,
        ref: m.reference_id,
        idempotency_key: m.idempotency_key,
        created_at: m.created_at
      })));
    }
  }
}

runAudit().catch(console.error);
