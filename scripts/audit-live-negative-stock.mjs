import pkg from "@next/env";
import { createClient } from "@supabase/supabase-js";

const { loadEnvConfig } = pkg;
loadEnvConfig(process.cwd(), true);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function checkLiveState() {
  const { data: negIngs } = await supabase
    .from("ingredients")
    .select("id, name, sku, unit, current_stock, min_stock")
    .lt("current_stock", 0)
    .order("current_stock", { ascending: true });

  console.log("Negative ingredients count:", negIngs?.length);
  if (negIngs && negIngs.length > 0) {
    console.log("All negative ingredients in live DB:");
    for (const ing of negIngs) {
      console.log(`  - ${ing.name} (${ing.sku}): current_stock = ${ing.current_stock} ${ing.unit} (min: ${ing.min_stock})`);
    }
  }

  const { data: zeroIngs } = await supabase
    .from("ingredients")
    .select("id, name, sku, unit, current_stock")
    .eq("current_stock", 0);
  console.log("\nZero stock ingredients count:", zeroIngs?.length);

  const { data: posIngs } = await supabase
    .from("ingredients")
    .select("id, name, sku, unit, current_stock")
    .gt("current_stock", 0);
  console.log("Positive stock ingredients count:", posIngs?.length);
  for (const ing of posIngs || []) {
    console.log(`  + ${ing.name} (${ing.sku}): ${ing.current_stock} ${ing.unit}`);
  }

  const { data: totalIngs } = await supabase
    .from("ingredients")
    .select("id, name");
  console.log("\nTotal ingredients in DB:", totalIngs?.length);

  // Check column reserved_stock in ingredients
  const { data: sampleIng } = await supabase
    .from("ingredients")
    .select("*")
    .limit(1)
    .single();
  console.log("\nIngredients columns in DB:", Object.keys(sampleIng || {}));

  // Check ingredient_reservations table
  const { error: resErr } = await supabase
    .from("ingredient_reservations")
    .select("id")
    .limit(1);
  console.log("ingredient_reservations table exists?", resErr ? `NO (${resErr.message})` : "YES");

  // Check recent stock movements
  const { data: recentMvs } = await supabase
    .from("stock_movements")
    .select("id, ingredient_id, movement_type, quantity_delta, stock_before, stock_after, order_id, reason, created_at")
    .order("created_at", { ascending: false })
    .limit(10);
  console.log("\nRecent stock movements count:", recentMvs?.length);
  for (const m of recentMvs || []) {
    console.log(`  [${m.movement_type}] delta=${m.quantity_delta}, ${m.stock_before} -> ${m.stock_after}, reason: "${m.reason}", order: ${m.order_id}`);
  }

  // Check modifiers schema
  const { data: modOpts } = await supabase
    .from("modifier_options")
    .select("*")
    .limit(3);
  console.log("\nSample modifier_options columns:", Object.keys(modOpts?.[0] || {}));
}

checkLiveState().catch(console.error);
