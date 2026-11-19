import pkg from "@next/env";
import { createClient } from "@supabase/supabase-js";

const { loadEnvConfig } = pkg;
loadEnvConfig(process.cwd(), true);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function runOpeningStockAudit() {
  const { data: ingredients, error: e1 } = await supabase
    .from("ingredients")
    .select("*")
    .order("sku", { ascending: true });

  const { data: recipes, error: e2 } = await supabase
    .from("recipes")
    .select("product_id, ingredient_id, quantity_required");

  const { data: products, error: e3 } = await supabase
    .from("products")
    .select("id, name, sku, is_active");

  if (!ingredients || !recipes || !products) {
    console.error("Error fetching data:", e1 || e2 || e3);
    return;
  }

  const prodMap = new Map(products.map((p) => [p.id, p]));
  const usageByIng = new Map();

  for (const r of recipes) {
    const list = usageByIng.get(r.ingredient_id) || [];
    const prod = prodMap.get(r.product_id);
    list.push({
      productName: prod?.name || r.product_id,
      quantityRequired: Number(r.quantity_required),
    });
    usageByIng.set(r.ingredient_id, list);
  }

  console.log(`=== AUDIT KEBUTUHAN RESEP DARI ${products.length} PRODUK UNTUK ${ingredients.length} BAHAN BAKU ===\n`);

  const report = [];

  for (const ing of ingredients) {
    const usages = usageByIng.get(ing.id) || [];
    const current = Number(ing.current_stock);
    const minStock = Number(ing.min_stock);

    let maxSinglePortion = 0;
    let sumUsage = 0;
    for (const u of usages) {
      sumUsage += u.quantityRequired;
      if (u.quantityRequired > maxSinglePortion) {
        maxSinglePortion = u.quantityRequired;
      }
    }

    report.push({
      id: ing.id,
      sku: ing.sku,
      name: ing.name,
      unit: ing.unit,
      currentStock: current,
      minStock: minStock,
      linkedProductCount: usages.length,
      maxSinglePortion,
      sumUsage,
      usages: usages.slice(0, 3).map((u) => `${u.productName} (${u.quantityRequired} ${ing.unit})`).join(", "),
    });
  }

  // Print summary by category
  console.log(`Total Ingredients: ${report.length}`);
  console.log(`Negative Ingredients count: ${report.filter((r) => r.currentStock < 0).length}`);
  console.log(`Zero stock Ingredients count: ${report.filter((r) => r.currentStock === 0).length}`);
  console.log(`Positive stock Ingredients count: ${report.filter((r) => r.currentStock > 0).length}`);

  console.log("\n--- Top Negative & Depleted Ingredients Example ---");
  for (const r of report.filter((r) => r.currentStock < 0)) {
    console.log(`[NEGATIVE] ${r.name} (${r.sku}): Current=${r.currentStock} ${r.unit}, Min=${r.minStock} ${r.unit}, MaxPortion=${r.maxSinglePortion} ${r.unit}, Used in: ${r.linkedProductCount} products (${r.usages})`);
  }
}

runOpeningStockAudit().catch(console.error);
