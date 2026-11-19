#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MASTER_INGREDIENTS, PRODUCT_RECIPES } from "./seed-f4-inventory-recipes.mjs";

console.log("Generating SQL migration for F4 ingredients, initial stock, and recipes...");

let sql = `-- =============================================================================
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
set local nine_licious.allow_current_stock_mutation = 'on';

-- =============================================================================
-- 1. UPSERT MASTER BAHAN BAKU (56 BAHAN)
-- =============================================================================
`;

for (const ing of MASTER_INGREDIENTS) {
  const notesEscaped = ing.notes ? `'${ing.notes.replace(/'/g, "''")}'` : "null";
  sql += `insert into public.ingredients (sku, name, unit, current_stock, min_stock, notes, is_active)
values ('${ing.sku}', '${ing.name.replace(/'/g, "''")}', '${ing.unit}', 0, ${ing.min_stock}, ${notesEscaped}, true)
on conflict (sku) where (sku is not null) do update set
  name = excluded.name,
  unit = excluded.unit,
  min_stock = excluded.min_stock,
  notes = excluded.notes,
  is_active = true,
  updated_at = now();\n\n`;
}

sql += `\n-- =============================================================================
-- 2. STOK AWAL BERAUDIT (INITIAL STOCK DI BUKU BESAR STOCK_MOVEMENTS)
-- =============================================================================
do $$
declare
  v_ing record;
  v_initial_stocks jsonb := jsonb_build_object(
`;

const stockEntries = MASTER_INGREDIENTS.map(
  (ing) => `    '${ing.sku}', ${ing.initial_stock}`
).join(",\n");

sql += stockEntries + `
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
`;

for (const [prodSku, recipeLines] of Object.entries(PRODUCT_RECIPES)) {
  sql += `-- Resep Produk: ${prodSku}\n`;
  sql += `delete from public.recipes where product_id = (select id from public.products where sku = '${prodSku}');\n`;

  for (const line of recipeLines) {
    const notesEscaped = line.notes ? `'${line.notes.replace(/'/g, "''")}'` : "null";
    sql += `insert into public.recipes (product_id, ingredient_id, quantity_required, notes)
select p.id, i.id, ${line.qty}, ${notesEscaped}
from public.products p, public.ingredients i
where p.sku = '${prodSku}' and i.sku = '${line.ingredientSku}';\n`;
  }
  sql += "\n";
}

sql += `commit;\n`;

const targetPath = resolve(process.cwd(), "supabase/migrations/20261119000200_f4_seed_ingredients_recipes.sql");
writeFileSync(targetPath, sql, "utf-8");
console.log(`Successfully written SQL migration to: ${targetPath}`);
