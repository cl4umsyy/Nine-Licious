import pkg from "@next/env";
import { createClient } from "@supabase/supabase-js";

const { loadEnvConfig } = pkg;
loadEnvConfig(process.cwd(), true);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function inspectIngredientsAndRecipes() {
  const { data: ingredients, error: ingErr } = await supabase
    .from("ingredients")
    .select("*")
    .order("sku", { ascending: true });

  if (ingErr) {
    console.error("Error ingredients:", ingErr.message);
    return;
  }

  const { data: recipes, error: recErr } = await supabase
    .from("recipes")
    .select("product_id, ingredient_id, quantity_required");

  if (recErr) {
    console.error("Error recipes:", recErr.message);
    return;
  }

  const { data: products } = await supabase
    .from("products")
    .select("id, name, sku, category_id");

  console.log(`Total bahan baku: ${ingredients.length}`);
  console.log(`Total baris resep: ${recipes.length}`);

  // Hitung berapa produk yang memakai tiap bahan baku dan total takaran per 1 porsi menu gabungan
  const usageByIng = new Map();
  for (const r of recipes) {
    const prev = usageByIng.get(r.ingredient_id) || { count: 0, totalPortionQty: 0, products: [] };
    const prod = products.find((p) => p.id === r.product_id);
    prev.count += 1;
    prev.totalPortionQty += Number(r.quantity_required);
    if (prod) prev.products.push(prod.name);
    usageByIng.set(r.ingredient_id, prev);
  }

  console.log("\nDAFTAR 74 BAHAN BAKU & KEBUTUHAN RESEP:");
  for (const ing of ingredients) {
    const usage = usageByIng.get(ing.id) || { count: 0, totalPortionQty: 0, products: [] };
    console.log(
      `${ing.sku.padEnd(12)} | ${ing.name.padEnd(28)} | Unit: ${ing.unit.padEnd(4)} | ` +
      `Current: ${String(ing.current_stock).padStart(6)} | Min: ${String(ing.min_stock).padStart(6)} | ` +
      `Used in ${usage.count} prods (Sum 1-port: ${usage.totalPortionQty} ${ing.unit})`
    );
  }
}

inspectIngredientsAndRecipes().catch(console.error);
