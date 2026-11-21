#!/usr/bin/env node
/**
 * NINE LICIOUS POS — F4.2 TEST SUITE: INVENTORY DOMAIN, ZOD VALIDATION, CALCULATIONS & SERVER ACTIONS
 *
 * Menguji LANGSUNG kode TypeScript asli di `src/lib/inventory/` (via transpile in-memory)
 * serta kontrak keamanan, RBAC, penanganan bahan nonaktif, idempotency, dan error DB
 * pada `src/lib/inventory/actions.ts`.
 *
 * Cakupan pengujian (16 skenario komprehensif):
 *  1. Constants & keselarasan 100% dengan constraint CHECK migrasi F4.1.
 *  2. Validasi bahan baku (createIngredientSchema & updateIngredientSchema): nama, SKU, unit,
 *     minStock, notes, serta penolakan `.strict()` terhadap mass-assignment (`currentStock`, `role`).
 *  3. Validasi arsip bahan baku (toggleIngredientActiveSchema).
 *  4. Validasi resep (saveProductRecipeSchema & deleteRecipeLineSchema): takaran positif,
 *     maksimal 3 desimal, dan penolakan bahan baku duplikat dalam 1 resep.
 *  5. Validasi penyesuaian stok manual (adjustIngredientStockSchema): `manual_in`, `manual_out`,
 *     `stock_opname`, validasi alasan wajib (>= 3 char), idempotency key, dan tolak `sale_deduction`.
 *  6. Validasi filter laporan pemakaian (usageReportFilterSchema): tanggal kalender valid,
 *     rentang terbalik ditolak, rentang > 366 hari ditolak.
 *  7. Aritmetika presisi desimal `numeric(12,3)` tanpa floating-point drift (0.1 + 0.2, 0.15 * 3, 1.005).
 *  8. Perhitungan kebutuhan bahan 1 produk (`calculateProductIngredientNeeds`).
 *  9. Agregasi kebutuhan bahan beberapa produk & beberapa baris item (`aggregateOrderIngredientNeeds`),
 *     melewati produk tanpa resep & bahan nonaktif, serta urutan deterministik `ingredient_id ASC`.
 * 10. Status stok (`safe`, `low_stock`, `out_of_stock` termasuk stok negatif) & `buildLowStockAlerts`.
 * 11. Perhitungan delta `stock_opname` (`calculateStockOpnameDelta`) & penolakan stok aktual negatif.
 * 12. Agregasi laporan pemakaian bahan baku (`aggregateIngredientUsageReport`): penjualan,
 *     manual_in, manual_out, opname, net_change, & distinct order count.
 * 13. Kontrak RBAC & anti-manipulasi role pada seluruh 7 Server Actions di `actions.ts`.
 * 14. Kontrak keamanan `adjustIngredientStockAction` (RPC via authenticated client, BUKAN service_role,
 *     tidak pernah direct UPDATE `current_stock`, mendukung idempotency).
 * 15. Kontrak penanganan bahan nonaktif pada `saveProductRecipeAction` & `toggleIngredientActiveAction`
 *     (tolak bahan nonaktif di resep baru, pertahankan riwayat lama, info produk terhubung sebelum arsip).
 * 16. Kontrak penanganan error database (`PGRST205`/`42P01`/`PGRST202`/`42883` migrasi belum aktif,
 *     `23505` duplikat, `23503` FK, `23514` CHECK, `42501` RLS, `P0001` RPC exception) & audit logs.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const ROOT = process.cwd();
const require = createRequire(import.meta.url);

// ============================================================================
// In-Memory Loader untuk mengeksekusi langsung modul TS murni F4.2
// ============================================================================
const moduleCache = new Map();

function loadTsModule(relPath) {
  const absPath = path.resolve(ROOT, relPath);
  if (moduleCache.has(absPath)) {
    return moduleCache.get(absPath).exports;
  }

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
  moduleCache.set(absPath, mod);

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

const constants = loadTsModule("src/lib/inventory/constants.ts");
const calculations = loadTsModule("src/lib/inventory/calculations.ts");
const validation = loadTsModule("src/lib/inventory/validation.ts");

const actionsSrc = fs.readFileSync(
  path.join(ROOT, "src/lib/inventory/actions.ts"),
  "utf-8",
);
const typesSrc = fs.readFileSync(
  path.join(ROOT, "src/lib/inventory/types.ts"),
  "utf-8",
);
const migrationSrc = fs.readFileSync(
  path.join(ROOT, "supabase/migrations/20261119000100_f4_inventory_stock.sql"),
  "utf-8",
);

const UUID_1 = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";
const UUID_3 = "33333333-3333-4333-8333-333333333333";
const UUID_4 = "44444444-4444-4444-8444-444444444444";

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err instanceof Error ? err.stack || err.message : String(err)}`);
    failed += 1;
  }
}

console.log("\n=== NINE LICIOUS POS — F4.2 INVENTORY DOMAIN & ACTIONS TEST SUITE ===\n");

runTest("1. Constants selaras 100% dengan constraint database F4.1", () => {
  assert.deepEqual(constants.INGREDIENT_UNITS, [
    "g",
    "kg",
    "ml",
    "l",
    "pcs",
    "pack",
    "porsi",
    "sachet",
  ]);
  for (const unit of constants.INGREDIENT_UNITS) {
    assert.ok(migrationSrc.includes(`'${unit}'`), `Unit '${unit}' harus ada di migrasi F4.1`);
    assert.ok(constants.INGREDIENT_UNIT_LABELS[unit], `Label unit '${unit}' harus ada`);
  }

  assert.deepEqual(constants.STOCK_MOVEMENT_TYPES, [
    "sale_deduction",
    "manual_in",
    "manual_out",
    "stock_opname",
  ]);
  assert.deepEqual(constants.MANUAL_STOCK_MOVEMENT_TYPES, [
    "manual_in",
    "manual_out",
    "stock_opname",
  ]);
  assert.deepEqual(constants.STOCK_STATUSES, ["safe", "low_stock", "out_of_stock"]);

  // Pastikan seluruh tipe utama diekspor di types.ts
  for (const typeName of [
    "export type Ingredient =",
    "export type RecipeItem =",
    "export type ProductWithRecipe =",
    "export type StockMovement =",
    "export type LowStockAlert =",
    "export type IngredientUsageRow =",
  ]) {
    assert.ok(typesSrc.includes(typeName), `types.ts harus mengekspor ${typeName}`);
  }
});

runTest("2. Validasi bahan baku (create & update) + tolak mass-assignment currentStock/role", () => {
  const validCreate = validation.createIngredientSchema.safeParse({
    name: "  Beras Pandan Wangi  ",
    sku: "  ING-BRS-01 ",
    unit: "kg",
    minStock: 2.5,
    notes: "  Beras utama nasi goreng  ",
  });
  assert.equal(validCreate.success, true);
  assert.equal(validCreate.data.name, "Beras Pandan Wangi");
  assert.equal(validCreate.data.sku, "ING-BRS-01");
  assert.equal(validCreate.data.minStock, 2.5);

  // Tolak nama < 2 karakter, SKU invalid, unit invalid, minStock negatif, > 3 desimal
  assert.equal(
    validation.createIngredientSchema.safeParse({ name: "A", unit: "g", minStock: 0 }).success,
    false,
  );
  assert.equal(
    validation.createIngredientSchema.safeParse({
      name: "Beras",
      sku: "BAD SKU SPACE!",
      unit: "g",
      minStock: 0,
    }).success,
    false,
  );
  assert.equal(
    validation.createIngredientSchema.safeParse({ name: "Beras", unit: "liter", minStock: 0 }).success,
    false,
  );
  assert.equal(
    validation.createIngredientSchema.safeParse({ name: "Beras", unit: "kg", minStock: -1 }).success,
    false,
  );
  assert.equal(
    validation.createIngredientSchema.safeParse({ name: "Beras", unit: "kg", minStock: 1.2345 }).success,
    false,
  );

  // Tolak mass-assignment currentStock / current_stock / role pada create & update (.strict())
  assert.equal(
    validation.createIngredientSchema.safeParse({
      name: "Beras",
      unit: "kg",
      minStock: 1,
      currentStock: 100,
    }).success,
    false,
  );
  assert.equal(
    validation.updateIngredientSchema.safeParse({
      ingredientId: UUID_1,
      name: "Beras",
      unit: "kg",
      minStock: 1,
      current_stock: 999,
    }).success,
    false,
  );
  assert.equal(
    validation.updateIngredientSchema.safeParse({
      ingredientId: UUID_1,
      name: "Beras",
      unit: "kg",
      minStock: 1,
      role: "admin",
    }).success,
    false,
  );
});

runTest("3. Validasi arsip bahan baku (toggleIngredientActiveSchema)", () => {
  const ok = validation.toggleIngredientActiveSchema.safeParse({
    ingredientId: UUID_1,
    isActive: false,
  });
  assert.equal(ok.success, true);
  assert.equal(ok.data.confirmArchiveWithActiveRecipes, false);

  assert.equal(
    validation.toggleIngredientActiveSchema.safeParse({
      ingredientId: "not-a-uuid",
      isActive: false,
    }).success,
    false,
  );
});

runTest("4. Validasi resep produk (saveProductRecipeSchema & deleteRecipeLineSchema)", () => {
  const ok = validation.saveProductRecipeSchema.safeParse({
    productId: UUID_1,
    items: [
      { ingredientId: UUID_2, quantityRequired: 0.15, notes: "Takaran standar" },
      { ingredientId: UUID_3, quantityRequired: 2 },
    ],
  });
  assert.equal(ok.success, true);

  // Tolak quantityRequired <= 0 atau > 3 desimal
  assert.equal(
    validation.saveProductRecipeSchema.safeParse({
      productId: UUID_1,
      items: [{ ingredientId: UUID_2, quantityRequired: 0 }],
    }).success,
    false,
  );
  assert.equal(
    validation.saveProductRecipeSchema.safeParse({
      productId: UUID_1,
      items: [{ ingredientId: UUID_2, quantityRequired: -5 }],
    }).success,
    false,
  );
  assert.equal(
    validation.saveProductRecipeSchema.safeParse({
      productId: UUID_1,
      items: [{ ingredientId: UUID_2, quantityRequired: 0.1234 }],
    }).success,
    false,
  );

  // Tolak bahan duplikat dalam satu resep
  const dup = validation.saveProductRecipeSchema.safeParse({
    productId: UUID_1,
    items: [
      { ingredientId: UUID_2, quantityRequired: 10 },
      { ingredientId: UUID_2, quantityRequired: 20 },
    ],
  });
  assert.equal(dup.success, false);
  assert.match(validation.firstZodError(dup.error), /lebih dari sekali/);

  assert.equal(
    validation.deleteRecipeLineSchema.safeParse({ recipeId: UUID_4 }).success,
    true,
  );
});

runTest("5. Validasi penyesuaian stok manual, alasan wajib, idempotency, & tolak sale_deduction", () => {
  assert.equal(
    validation.adjustIngredientStockSchema.safeParse({
      ingredientId: UUID_1,
      movementType: "manual_in",
      quantity: 12.5,
      reason: "Restock supplier pagi",
      idempotencyKey: "adj-20261119-001",
    }).success,
    true,
  );

  // stock_opname boleh 0 (menyetel stok aktual habis), tidak boleh negatif
  assert.equal(
    validation.adjustIngredientStockSchema.safeParse({
      ingredientId: UUID_1,
      movementType: "stock_opname",
      quantity: 0,
      reason: "Opname gudang habis",
    }).success,
    true,
  );
  assert.equal(
    validation.adjustIngredientStockSchema.safeParse({
      ingredientId: UUID_1,
      movementType: "stock_opname",
      quantity: -0.5,
      reason: "Opname negatif",
    }).success,
    false,
  );

  // manual_in & manual_out wajib > 0
  for (const mt of ["manual_in", "manual_out"]) {
    assert.equal(
      validation.adjustIngredientStockSchema.safeParse({
        ingredientId: UUID_1,
        movementType: mt,
        quantity: 0,
        reason: "Alasan valid",
      }).success,
      false,
    );
  }

  // Alasan wajib >= 3 karakter (spasi saja ditolak)
  for (const badReason of ["", "   ", "ab"]) {
    assert.equal(
      validation.adjustIngredientStockSchema.safeParse({
        ingredientId: UUID_1,
        movementType: "manual_in",
        quantity: 5,
        reason: badReason,
      }).success,
      false,
    );
  }

  // Tolak movementType = 'sale_deduction' dan idempotencyKey < 8 karakter
  assert.equal(
    validation.adjustIngredientStockSchema.safeParse({
      ingredientId: UUID_1,
      movementType: "sale_deduction",
      quantity: 5,
      reason: "Percobaan manipulasi",
    }).success,
    false,
  );
  assert.equal(
    validation.adjustIngredientStockSchema.safeParse({
      ingredientId: UUID_1,
      movementType: "manual_in",
      quantity: 5,
      reason: "Restock",
      idempotencyKey: "short",
    }).success,
    false,
  );
});

runTest("6. Validasi filter laporan pemakaian bahan baku", () => {
  const ok = validation.usageReportFilterSchema.safeParse({
    startDate: "2026-11-01",
    endDate: "2026-11-18",
    ingredientId: "",
    movementType: "sale_deduction",
  });
  assert.equal(ok.success, true);
  assert.equal(ok.data.ingredientId, null);

  // Tanggal tidak valid (31 Feb), rentang terbalik, rentang > 366 hari -> DITOLAK
  assert.equal(
    validation.usageReportFilterSchema.safeParse({
      startDate: "2026-02-31",
      endDate: "2026-03-01",
    }).success,
    false,
  );
  assert.equal(
    validation.usageReportFilterSchema.safeParse({
      startDate: "2026-11-20",
      endDate: "2026-11-18",
    }).success,
    false,
  );
  assert.equal(
    validation.usageReportFilterSchema.safeParse({
      startDate: "2025-01-01",
      endDate: "2026-11-18",
    }).success,
    false,
  );
});

runTest("7. Aritmetika mili-unit numeric(12,3) bebas kesalahan floating-point & pengujian tipe", () => {
  assert.equal(calculations.toMilliUnits("0.1") + calculations.toMilliUnits("0.2"), 300);
  assert.equal(calculations.fromMilliUnits(300), 0.3);

  // 1. Integer (number & string)
  assert.equal(calculations.roundQuantity3(5), 5);
  assert.equal(calculations.roundQuantity3("5"), 5);
  assert.equal(calculations.roundQuantity3(0), 0);
  assert.equal(calculations.roundQuantity3("0"), 0);

  // 2. Decimal (number & string)
  assert.equal(calculations.roundQuantity3(1.234), 1.234);
  assert.equal(calculations.roundQuantity3("1.234"), 1.234);
  assert.equal(calculations.roundQuantity3("1.005"), 1.005);
  assert.equal(calculations.roundQuantity3("1.0055"), 1.006);
  assert.equal(calculations.roundQuantity3(-2.345), -2.345);
  assert.equal(calculations.roundQuantity3("-2.345"), -2.345);

  // 3. String numerik
  assert.equal(calculations.roundQuantity3("  0.500  "), 0.5);
  assert.equal(calculations.roundQuantity3("+10.5"), 10.5);

  // 4. Null & Undefined ditangani secara aman (melempar Error deskriptif, bukan TypeError .trim())
  assert.throws(
    () => calculations.toMilliUnits(null),
    /Nilai kuantitas tidak boleh kosong/,
  );
  assert.throws(
    () => calculations.toMilliUnits(undefined),
    /Nilai kuantitas tidak boleh kosong/,
  );
  assert.throws(
    () => calculations.roundQuantity3(null),
    /Nilai kuantitas tidak boleh kosong/,
  );
  assert.throws(
    () => calculations.roundQuantity3(undefined),
    /Nilai kuantitas tidak boleh kosong/,
  );

  // 5. String kosong & spasi
  assert.throws(
    () => calculations.toMilliUnits(""),
    /Nilai kuantitas tidak boleh berupa string kosong/,
  );
  assert.throws(
    () => calculations.toMilliUnits("   "),
    /Nilai kuantitas tidak boleh berupa string kosong/,
  );
  assert.throws(
    () => calculations.roundQuantity3(""),
    /Nilai kuantitas tidak boleh berupa string kosong/,
  );
  assert.throws(
    () => calculations.roundQuantity3("   "),
    /Nilai kuantitas tidak boleh berupa string kosong/,
  );

  // 6. Input numerik tidak valid (NaN, Infinity, string non-angka, tipe selain number/string)
  assert.throws(
    () => calculations.toMilliUnits(NaN),
    /Nilai kuantitas tidak valid/,
  );
  assert.throws(
    () => calculations.toMilliUnits(Infinity),
    /Nilai kuantitas tidak valid/,
  );
  assert.throws(
    () => calculations.roundQuantity3(NaN),
    /Nilai kuantitas tidak valid/,
  );
  assert.throws(
    () => calculations.roundQuantity3(Infinity),
    /Nilai kuantitas tidak valid/,
  );
  assert.throws(
    () => calculations.toMilliUnits("abc"),
    /Format angka desimal tidak valid/,
  );
  assert.throws(
    () => calculations.roundQuantity3("abc"),
    /Format angka desimal tidak valid/,
  );
  assert.throws(
    () => calculations.toMilliUnits("12.34.56"),
    /Format angka desimal tidak valid/,
  );
  assert.throws(
    () => calculations.roundQuantity3({}),
    /Format angka desimal tidak valid/,
  );
  assert.throws(
    () => calculations.roundQuantity3(true),
    /Format angka desimal tidak valid/,
  );
});

runTest("8. Perhitungan kebutuhan bahan 1 produk (calculateProductIngredientNeeds)", () => {
  const needs = calculations.calculateProductIngredientNeeds(
    [
      { ingredient_id: UUID_2, quantity_required: 0.15 },
      { ingredient_id: UUID_1, quantity_required: 1.25 },
    ],
    3,
  );
  // 0.15 * 3 = 0.45 tepat (bukan 0.44999999999999996), terurut ASC
  assert.deepEqual(needs, [
    { ingredient_id: UUID_1, quantity_required: 3.75 },
    { ingredient_id: UUID_2, quantity_required: 0.45 },
  ]);
  assert.deepEqual(calculations.calculateProductIngredientNeeds([], 2), []);
  assert.deepEqual(
    calculations.calculateProductIngredientNeeds([{ ingredient_id: UUID_1, quantity_required: 1 }], 0),
    [],
  );
});

runTest("9. Agregasi beberapa produk, multi baris item, produk tanpa resep, & bahan nonaktif", () => {
  const recipesByProduct = new Map([
    [
      "prod-nasgor",
      [
        { ingredient_id: "ing-z-beras", quantity_required: 0.15 },
        { ingredient_id: "ing-b-minyak", quantity_required: 0.025 },
        { ingredient_id: "ing-inactive", quantity_required: 10 },
      ],
    ],
    [
      "prod-geprek",
      [
        { ingredient_id: "ing-z-beras", quantity_required: 0.15 },
        { ingredient_id: "ing-a-ayam", quantity_required: 0.12 },
        { ingredient_id: "ing-b-minyak", quantity_required: 0.03 },
      ],
    ],
  ]);

  const ingredientsById = new Map([
    ["ing-z-beras", { is_active: true }],
    ["ing-b-minyak", { is_active: true }],
    ["ing-a-ayam", { is_active: true }],
    ["ing-inactive", { is_active: false }],
  ]);

  const result = calculations.aggregateOrderIngredientNeeds(
    [
      { product_id: "prod-nasgor", quantity: 2 },
      { product_id: "prod-nasgor", quantity: 1 }, // baris item ke-2 produk sama
      { product_id: "prod-geprek", quantity: 3 },
      { product_id: "prod-air-mineral", quantity: 5 }, // produk tanpa resep -> dilewati aman
    ],
    recipesByProduct,
    ingredientsById,
  );

  // Urutan wajib ASC: ing-a-ayam, ing-b-minyak, ing-z-beras; ing-inactive dilewati
  assert.deepEqual(result, [
    { ingredient_id: "ing-a-ayam", quantity_required: 0.36 }, // 0.12 * 3
    { ingredient_id: "ing-b-minyak", quantity_required: 0.165 }, // 0.025*3 + 0.03*3 = 0.075 + 0.09
    { ingredient_id: "ing-z-beras", quantity_required: 0.9 }, // 0.15*3 + 0.15*3 = 0.45 + 0.45
  ]);
});

runTest("10. Status stok aman / rendah / habis (termasuk negatif) & buildLowStockAlerts", () => {
  assert.equal(calculations.getStockStatus(10, 5), "safe");
  assert.equal(calculations.getStockStatus(5, 5), "low_stock");
  assert.equal(calculations.getStockStatus(0, 5), "out_of_stock");
  assert.equal(calculations.getStockStatus(-2.5, 5), "out_of_stock");
  assert.equal(calculations.isLowStock(5, 5), true);
  assert.equal(calculations.isLowStock(5.001, 5), false);

  const alerts = calculations.buildLowStockAlerts([
    { id: "1", name: "Garam", sku: null, unit: "g", current_stock: 500, min_stock: 100, is_active: true },
    { id: "2", name: "Beras", sku: "BRS", unit: "kg", current_stock: 1.5, min_stock: 2, is_active: true },
    { id: "3", name: "Daging", sku: "DGG", unit: "kg", current_stock: -0.5, min_stock: 1, is_active: true },
    { id: "4", name: "Bahan Arsip", sku: null, unit: "g", current_stock: 0, min_stock: 100, is_active: false },
  ]);

  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].ingredient_id, "3"); // out_of_stock negatif paling kritis di urutan 1
  assert.equal(alerts[0].status, "out_of_stock");
  assert.equal(alerts[0].is_negative, true);
  assert.equal(alerts[0].deficit, 1.5); // min 1 - (-0.5) = 1.5
  assert.equal(alerts[1].ingredient_id, "2");
  assert.equal(alerts[1].status, "low_stock");
  assert.equal(alerts[1].deficit, 0.5);
});

runTest("11. Perhitungan delta stock opname (calculateStockOpnameDelta)", () => {
  const down = calculations.calculateStockOpnameDelta(7.5, 1.25);
  assert.deepEqual(down, {
    stock_before: 7.5,
    stock_after: 1.25,
    delta: -6.25,
    has_change: true,
    direction: "decrease",
  });

  const upFromNegative = calculations.calculateStockOpnameDelta(-0.4, 2.1);
  assert.deepEqual(upFromNegative, {
    stock_before: -0.4,
    stock_after: 2.1,
    delta: 2.5,
    has_change: true,
    direction: "increase",
  });

  const same = calculations.calculateStockOpnameDelta(3, 3);
  assert.equal(same.has_change, false);
  assert.equal(same.delta, 0);

  assert.throws(() => calculations.calculateStockOpnameDelta(5, -1), /tidak boleh negatif/);
});

runTest("12. Agregasi laporan pemakaian bahan baku (aggregateIngredientUsageReport)", () => {
  const ingredientsMap = new Map([
    [
      "ing-1",
      { id: "ing-1", name: "Beras", sku: "BRS", unit: "kg", is_active: true, current_stock: 4.5, min_stock: 2 },
    ],
    [
      "ing-2",
      { id: "ing-2", name: "Telur", sku: "TLR", unit: "pcs", is_active: true, current_stock: 8, min_stock: 10 },
    ],
  ]);

  const movements = [
    { ingredient_id: "ing-1", movement_type: "manual_in", quantity_delta: 5, order_id: null },
    { ingredient_id: "ing-1", movement_type: "sale_deduction", quantity_delta: -0.3, order_id: "ord-a" },
    { ingredient_id: "ing-1", movement_type: "sale_deduction", quantity_delta: -0.15, order_id: "ord-b" },
    { ingredient_id: "ing-1", movement_type: "manual_out", quantity_delta: -0.05, order_id: null },
    { ingredient_id: "ing-2", movement_type: "sale_deduction", quantity_delta: -2, order_id: "ord-a" },
    { ingredient_id: "ing-2", movement_type: "stock_opname", quantity_delta: -1, order_id: null },
  ];

  const rows = calculations.aggregateIngredientUsageReport(movements, ingredientsMap);
  assert.equal(rows.length, 2);

  // Terurut pemakaian penjualan terbesar dulu: ing-2 (2) sebelum ing-1 (0.45)
  assert.equal(rows[0].ingredient_id, "ing-2");
  assert.equal(rows[0].sale_deducted_total, 2);
  assert.equal(rows[0].opname_net_delta, -1);
  assert.equal(rows[0].net_change, -3);
  assert.equal(rows[0].sale_order_count, 1);
  assert.equal(rows[0].stock_status, "low_stock");

  assert.equal(rows[1].ingredient_id, "ing-1");
  assert.equal(rows[1].sale_deducted_total, 0.45);
  assert.equal(rows[1].manual_in_total, 5);
  assert.equal(rows[1].manual_out_total, 0.05);
  assert.equal(rows[1].net_change, 4.5);
  assert.equal(rows[1].movement_count, 4);
  assert.equal(rows[1].sale_order_count, 2);
  assert.equal(rows[1].stock_status, "safe");
});

runTest("13. Kontrak RBAC admin di seluruh 7 Server Actions & pencegahan manipulasi role client", () => {
  assert.ok(actionsSrc.startsWith('"use server";'), "actions.ts wajib memakai directive 'use server'");

  const requiredActions = [
    "createIngredientAction",
    "updateIngredientAction",
    "toggleIngredientActiveAction",
    "saveProductRecipeAction",
    "deleteRecipeLineAction",
    "adjustIngredientStockAction",
    "getIngredientUsageReportAction",
  ];

  for (const fnName of requiredActions) {
    const startIdx = actionsSrc.indexOf(`export async function ${fnName}`);
    assert.ok(startIdx !== -1, `actions.ts harus mengekspor ${fnName}`);
    const bodySnippet = actionsSrc.slice(startIdx, startIdx + 400);
    assert.ok(
      bodySnippet.includes("const actor = await getAdminActor();"),
      `${fnName} wajib memeriksa role admin di server lewat getAdminActor()`,
    );
  }
});

runTest("14. Kontrak keamanan adjustIngredientStockAction (RPC via authenticated client, anti direct current_stock update)", () => {
  const adjustStart = actionsSrc.indexOf("export async function adjustIngredientStockAction");
  const adjustEnd = actionsSrc.indexOf("export async function getIngredientUsageReportAction");
  const adjustBody = actionsSrc.slice(adjustStart, adjustEnd);

  assert.ok(
    adjustBody.includes("createSupabaseServerClient()"),
    "adjustIngredientStockAction harus memanggil RPC memakai createSupabaseServerClient (JWT authenticated)",
  );
  assert.ok(
    !adjustBody.includes("createSupabaseAdminClient()"),
    "adjustIngredientStockAction TIDAK boleh memanggil RPC memakai service_role (karena direvoke di F4.1)",
  );
  assert.ok(
    adjustBody.includes('.rpc("adjust_ingredient_stock_atomic"'),
    "adjustIngredientStockAction wajib memanggil RPC adjust_ingredient_stock_atomic",
  );
  assert.ok(
    adjustBody.includes("p_idempotency_key: idempotencyKey"),
    "adjustIngredientStockAction wajib meneruskan p_idempotency_key",
  );

  // updateIngredientAction tidak boleh pernah menyentuh current_stock
  const updateStart = actionsSrc.indexOf("export async function updateIngredientAction");
  const updateEnd = actionsSrc.indexOf("export async function toggleIngredientActiveAction");
  const updateBody = actionsSrc.slice(updateStart, updateEnd);
  assert.ok(
    !updateBody.includes("current_stock:"),
    "updateIngredientAction dilarang mengubah current_stock secara langsung",
  );
});

runTest("15. Kontrak penanganan bahan nonaktif di saveProductRecipeAction & toggleIngredientActiveAction", () => {
  const recipeStart = actionsSrc.indexOf("export async function saveProductRecipeAction");
  const recipeEnd = actionsSrc.indexOf("export async function deleteRecipeLineAction");
  const recipeBody = actionsSrc.slice(recipeStart, recipeEnd);

  assert.ok(
    recipeBody.includes("if (!ing.is_active && !isAlreadyInRecipe)") &&
      recipeBody.includes('code: "INACTIVE_INGREDIENT"'),
    "saveProductRecipeAction wajib menolak penambahan bahan nonaktif ke resep baru sembari menjaga riwayat lama",
  );

  const toggleStart = actionsSrc.indexOf("export async function toggleIngredientActiveAction");
  const toggleEnd = actionsSrc.indexOf("export async function saveProductRecipeAction");
  const toggleBody = actionsSrc.slice(toggleStart, toggleEnd);

  assert.ok(
    toggleBody.includes('code: "INGREDIENT_IN_USE_REQUIRES_CONFIRMATION"') &&
      toggleBody.includes("linkedProducts"),
    "toggleIngredientActiveAction wajib mengembalikan info produk yang masih menggunakan bahan sebelum diarsipkan",
  );
  assert.ok(
    !toggleBody.includes('.from("stock_movements")') && !toggleBody.includes(".delete()"),
    "toggleIngredientActiveAction tidak boleh menghapus resep atau riwayat stock_movements",
  );
});

runTest("16. Kontrak penanganan error DB (termasuk migrasi belum aktif) & audit log di actions.ts", () => {
  for (const dbCode of ["PGRST205", "42P01", "PGRST202", "42883", "42501", "23505", "23503", "23514", "P0001"]) {
    assert.ok(
      actionsSrc.includes(`"${dbCode}"`),
      `mapInventoryDbError harus menangani kode error PostgreSQL/PostgREST '${dbCode}'`,
    );
  }
  assert.ok(
    actionsSrc.includes('code: "MIGRATION_REQUIRED"'),
    "actions.ts harus menangani database yang belum menjalankan migrasi F4.1 secara anggun",
  );

  for (const auditEvent of [
    "inventory.ingredient_created",
    "inventory.ingredient_updated",
    "inventory.ingredient_archived",
    "inventory.ingredient_reactivated",
    "inventory.recipe_saved",
    "inventory.recipe_line_deleted",
  ]) {
    assert.ok(actionsSrc.includes(`"${auditEvent}"`), `actions.ts harus mencatat audit event '${auditEvent}'`);
  }
  assert.ok(actionsSrc.includes('revalidatePath("/admin/inventory")'));
});

console.log(`\nRingkasan F4.2: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
