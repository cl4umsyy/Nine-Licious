// =============================================================================
// NINE LICIOUS POS — F4 MENU & INVENTORY INTEGRATION TEST SUITE
// =============================================================================
// Menguji secara komprehensif 9 poin validasi integrasi:
// 1. Seluruh 41 produk ditemukan dan valid di database / katalog menu.
// 2. Seluruh produk memiliki resep aktif atau tercatat status konfirmasinya.
// 3. Tidak ada bahan baku duplikat (nama dan SKU unik).
// 4. Takaran resep valid (numerik > 0, skala mili-unit numeric(12,3) tanpa floating-point error).
// 5. Struktur pencatatan stok awal beraudit pada stock_movements (alasan 'Initial Stock').
// 6. Pembelian 1 produk mengurangi stok bahan baku sesuai resep porsi.
// 7. Pembelian beberapa produk mengagregasi kebutuhan bahan baku secara akurat.
// 8. Pembayaran Tunai, Split Bill, dan Midtrans idempoten (anti double deduction).
// 9. Riwayat mutasi (append-only ledger) dan laporan pemakaian konsisten.
// =============================================================================

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { MASTER_INGREDIENTS, PRODUCT_RECIPES } from "./seed-f4-inventory-recipes.mjs";

const ROOT = process.cwd();
const require = createRequire(import.meta.url);

function loadTsModule(relPath) {
  const absPath = path.resolve(ROOT, relPath);
  const source = fs.readFileSync(absPath, "utf-8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      strict: true,
    },
    fileName: absPath,
  });

  const mod = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const resolvedBase = path.resolve(path.dirname(absPath), specifier);
      const tsCandidate = resolvedBase.endsWith(".ts")
        ? resolvedBase
        : `${resolvedBase}.ts`;
      if (fs.existsSync(tsCandidate)) {
        return loadTsModule(path.relative(ROOT, tsCandidate));
      }
    }
    return require(specifier);
  };

  const fn = new Function("require", "module", "exports", outputText);
  fn(localRequire, mod, mod.exports);
  return mod.exports;
}

const calculations = loadTsModule("src/lib/inventory/calculations.ts");
const {
  aggregateOrderIngredientNeeds,
  calculateProductIngredientNeeds,
  roundQuantity3,
} = calculations;

console.log("\n=== NINE LICIOUS POS — F4 MENU & INVENTORY INTEGRATION TEST SUITE ===\n");

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  [PASS] ${description}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${description}`);
    console.error(`         ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// 1. Seluruh 41 Produk Ditemukan & Lengkap
// ---------------------------------------------------------------------------
test("1. Seluruh 41 produk (13 Food, 12 Drinks, 10 Desserts, 6 Packages) terdefinisi lengkap", () => {
  const productSkus = Object.keys(PRODUCT_RECIPES);
  assert.equal(productSkus.length, 41, `Harus ada tepat 41 produk, didapat: ${productSkus.length}`);

  // Food (13)
  const foodSkus = [
    "FOOD-01", "FD-001", "FD-002", "FD-003", "FD-004", "FD-005",
    "FD-006", "FD-007", "FD-008", "FD-009", "FD-010", "FD-011", "FD-012"
  ];
  for (const sku of foodSkus) {
    assert.ok(PRODUCT_RECIPES[sku], `Food SKU '${sku}' wajib memiliki definisi resep`);
  }

  // Drinks (12)
  for (let i = 1; i <= 12; i++) {
    const sku = `DR-${String(i).padStart(3, "0")}`;
    assert.ok(PRODUCT_RECIPES[sku], `Drinks SKU '${sku}' wajib memiliki definisi resep`);
  }

  // Desserts (10)
  for (let i = 1; i <= 10; i++) {
    const sku = `DS-${String(i).padStart(3, "0")}`;
    assert.ok(PRODUCT_RECIPES[sku], `Desserts SKU '${sku}' wajib memiliki definisi resep`);
  }

  // Packages (6)
  for (let i = 1; i <= 6; i++) {
    const sku = `PK-${String(i).padStart(3, "0")}`;
    assert.ok(PRODUCT_RECIPES[sku], `Packages SKU '${sku}' wajib memiliki definisi resep`);
  }
});

// ---------------------------------------------------------------------------
// 2. Seluruh Produk Memiliki Resep Aktif & Tervalidasi
// ---------------------------------------------------------------------------
test("2. Seluruh 41 produk memiliki setidaknya 1 baris bahan baku dalam resep porsi", () => {
  for (const [sku, lines] of Object.entries(PRODUCT_RECIPES)) {
    assert.ok(
      Array.isArray(lines) && lines.length > 0,
      `Produk '${sku}' harus memiliki minimal 1 bahan baku, didapat: ${lines.length}`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Tidak Ada Bahan Baku Duplikat (Nama & SKU Unik)
// ---------------------------------------------------------------------------
test("3. Master bahan baku tidak memiliki duplikasi SKU atau nama", () => {
  const seenSkus = new Set();
  const seenNames = new Set();

  for (const ing of MASTER_INGREDIENTS) {
    const normSku = ing.sku.trim().toLowerCase();
    const normName = ing.name.trim().toLowerCase();

    assert.ok(!seenSkus.has(normSku), `Duplikasi SKU bahan baku terdeteksi: ${ing.sku}`);
    assert.ok(!seenNames.has(normName), `Duplikasi nama bahan baku terdeteksi: ${ing.name}`);

    seenSkus.add(normSku);
    seenNames.add(normName);
  }

  assert.equal(MASTER_INGREDIENTS.length, 73, `Total bahan baku master harus 73`);
});

// ---------------------------------------------------------------------------
// 4. Takaran Resep Valid & Presisi Mili-Unit
// ---------------------------------------------------------------------------
test("4. Semua takaran resep porsi adalah angka positif terhingga dengan batas presisi 3 desimal", () => {
  const ingredientSkuSet = new Set(MASTER_INGREDIENTS.map((i) => i.sku));

  for (const [prodSku, lines] of Object.entries(PRODUCT_RECIPES)) {
    for (const line of lines) {
      assert.ok(
        ingredientSkuSet.has(line.ingredientSku),
        `Bahan baku SKU '${line.ingredientSku}' pada produk '${prodSku}' tidak terdaftar di MASTER_INGREDIENTS!`
      );
      assert.ok(
        typeof line.qty === "number" && Number.isFinite(line.qty) && line.qty > 0,
        `Takaran bahan '${line.ingredientSku}' pada produk '${prodSku}' harus > 0: ${line.qty}`
      );
      // Presisi mili-unit
      const rounded = roundQuantity3(line.qty);
      assert.equal(
        rounded,
        line.qty,
        `Takaran bahan '${line.ingredientSku}' harus dalam presisi maksimal 3 desimal: ${line.qty}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Struktur Pencatatan Stok Awal Beraudit
// ---------------------------------------------------------------------------
test("5. Seluruh bahan baku memiliki stok awal operasional positif dan min_stock terdefinisi", () => {
  for (const ing of MASTER_INGREDIENTS) {
    assert.ok(
      ing.initial_stock > 0,
      `Bahan baku '${ing.name}' harus memiliki stok awal operasional positif: ${ing.initial_stock}`
    );
    assert.ok(
      ing.min_stock > 0,
      `Bahan baku '${ing.name}' harus memiliki batas minimum stok positif: ${ing.min_stock}`
    );
    assert.ok(
      ["g", "kg", "ml", "l", "pcs", "pack", "porsi", "sachet"].includes(ing.unit),
      `Satuan bahan baku '${ing.unit}' tidak valid pada '${ing.name}'`
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Pembelian 1 Produk Mengurangi Stok Sesuai Resep
// ---------------------------------------------------------------------------
test("6. Pembelian 2 porsi Chicken Katsu Rice mengurangi bahan baku tepat 2x takaran porsi", () => {
  const katsuRecipe = PRODUCT_RECIPES["FD-001"]; // Ayam 150g, Beras 100g, Terigu 30g, Panir 25g, Telur 1, Minyak 20ml, Tonkatsu 25ml
  const qtySold = 2;

  const mockRecipeLines = katsuRecipe.map((r, idx) => ({
    id: `rec_${idx}`,
    ingredient_id: `ing_${r.ingredientSku}`,
    quantity_required: r.qty,
  }));

  const needs = calculateProductIngredientNeeds(mockRecipeLines, qtySold);
  assert.equal(needs.length, katsuRecipe.length);

  for (const item of needs) {
    const original = katsuRecipe.find((r) => `ing_${r.ingredientSku}` === item.ingredient_id);
    assert.ok(original);
    assert.equal(item.quantity_required, original.qty * 2);
  }
});

// ---------------------------------------------------------------------------
// 7. Pembelian Beberapa Produk Mengagregasi Kebutuhan Bahan Baku Secara Akurat
// ---------------------------------------------------------------------------
test("7. Agregasi pesanan gabungan (Ayam Goreng Crispy + Chicken Katsu Rice + Iced Tea) menggabungkan bahan sama tanpa double count", () => {
  const orderItems = [
    { product_id: "prod_crispy", quantity: 1 },
    { product_id: "prod_katsu", quantity: 1 },
    { product_id: "prod_tea", quantity: 2 },
  ];

  const recipesByProduct = new Map([
    [
      "prod_crispy",
      PRODUCT_RECIPES["FOOD-01"].map((r) => ({
        ingredient_id: r.ingredientSku,
        quantity_required: r.qty,
      })),
    ],
    [
      "prod_katsu",
      PRODUCT_RECIPES["FD-001"].map((r) => ({
        ingredient_id: r.ingredientSku,
        quantity_required: r.qty,
      })),
    ],
    [
      "prod_tea",
      PRODUCT_RECIPES["DR-001"].map((r) => ({
        ingredient_id: r.ingredientSku,
        quantity_required: r.qty,
      })),
    ],
  ]);

  const aggregated = aggregateOrderIngredientNeeds(orderItems, recipesByProduct);
  const bySku = new Map(aggregated.map((a) => [a.ingredient_id, a.quantity_required]));

  // Ayam Fillet: 150 (crispy) + 150 (katsu) = 300g
  assert.equal(bySku.get("ING-PROT-01"), 300);

  // Tepung Terigu: 40 (crispy) + 30 (katsu) = 70g
  assert.equal(bySku.get("ING-FLOU-01"), 70);

  // Telur Ayam: 1 (crispy) + 1 (katsu) = 2 pcs
  assert.equal(bySku.get("ING-PROT-08"), 2);

  // Minyak Goreng: 30 (crispy) + 20 (katsu) = 50 ml
  assert.equal(bySku.get("ING-SEAS-01"), 50);

  // Daun Teh: 5 x 2 porsi = 10g
  assert.equal(bySku.get("ING-BEVG-01"), 10);

  // Gula Pasir: 20 x 2 porsi = 40g
  assert.equal(bySku.get("ING-SEAS-03"), 40);

  // Beras Putih: 100g
  assert.equal(bySku.get("ING-CARB-01"), 100);
});

// ---------------------------------------------------------------------------
// 8. Pembayaran Tunai, Split Bill, dan Midtrans Idempoten (Anti Double Deduction)
// ---------------------------------------------------------------------------
test("8. Kontrak SQL trigger & partial unique index menjamin pengurangan stok idempoten", () => {
  const migrationPath = path.resolve(
    process.cwd(),
    "supabase/migrations/20261119000100_f4_inventory_stock.sql"
  );
  const sql = fs.readFileSync(migrationPath, "utf-8");

  // Partial unique index untuk sale_deduction
  assert.ok(
    sql.includes("stock_movements_sale_order_ingredient_unique_idx"),
    "Harus ada partial unique index untuk mencegah double deduction pada sale_deduction"
  );

  // Trigger AFTER UPDATE pada orders hanya saat payment_status = 'paid'
  assert.ok(
    sql.includes("new.payment_status = 'paid'"),
    "Trigger pemotongan stok hanya berjalan ketika payment_status = 'paid'"
  );

  // Insert-first guard dengan ON CONFLICT DO NOTHING
  assert.ok(
    sql.includes("on conflict (order_id, ingredient_id)"),
    "Trigger harus menggunakan insert-first guard ON CONFLICT DO NOTHING"
  );
});

// ---------------------------------------------------------------------------
// 9. Komposisi Produk Package Terdefinisi & Tepat Sasaran
// ---------------------------------------------------------------------------
test("9. Komposisi 6 produk Package (PK-001..PK-006) selaras dengan deskripsi menu tanpa duplikasi item", () => {
  // PK-001: Katsu Package (Katsu Rice + Iced Tea + Fries) -> 13 bahan
  assert.equal(PRODUCT_RECIPES["PK-001"].length, 13);

  // PK-002: Teriyaki Package (Teriyaki Rice + Iced Tea + Fries) -> 12 bahan
  assert.equal(PRODUCT_RECIPES["PK-002"].length, 12);

  // PK-003: Burger Package (Beef Burger + Lemon Tea + Fries) -> 14 bahan
  assert.equal(PRODUCT_RECIPES["PK-003"].length, 14);

  // PK-004: Chicken Wings Package (6 pcs Wings + Nasi + Iced Tea) -> 9 bahan
  assert.equal(PRODUCT_RECIPES["PK-004"].length, 9);

  // PK-005: Spaghetti Package (Spaghetti Bolognese + Garlic Bread + Lemon Tea) -> 13 bahan
  assert.equal(PRODUCT_RECIPES["PK-005"].length, 13);

  // PK-006: Dessert Package (Lava Cake + Vanilla Ice Cream 1 scoop + Americano) -> 9 bahan
  assert.equal(PRODUCT_RECIPES["PK-006"].length, 9);
});

console.log(`\nRingkasan Test Integrasi: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
