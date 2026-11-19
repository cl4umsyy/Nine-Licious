#!/usr/bin/env node
/**
 * NINE LICIOUS POS — F4.3 VERIFICATION SUITE: ADMIN INVENTORY UI, RBAC & NAVIGATION
 *
 * Memverifikasi kontrak UI, RBAC, integrasi navigasi, penggunaan eksklusif Server Actions F4.2,
 * penanganan MIGRATION_REQUIRED, dan pencegahan akses langsung ke DB/current_stock dari frontend.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

function loadPureTs(relPath) {
  const absPath = path.resolve(ROOT, relPath);
  const src = fs.readFileSync(absPath, "utf-8");
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: absPath,
  });
  const mod = { exports: {} };
  const fn = new Function("exports", "module", outputText);
  fn(mod.exports, mod);
  return mod.exports;
}

const rolesMod = loadPureTs("src/lib/auth/roles.ts");
const navSrc = readFile("src/lib/navigation.ts");
const adminPageSrc = readFile("src/app/(app)/admin/page.tsx");
const inventoryPageSrc = readFile("src/app/(app)/admin/inventory/page.tsx");
const mgmtSrc = readFile("src/components/admin/inventory/inventory-management.tsx");
const ingredientSrc = readFile("src/components/admin/inventory/ingredient-manager.tsx");
const adjustSrc = readFile("src/components/admin/inventory/stock-adjustment-dialog.tsx");
const recipeSrc = readFile("src/components/admin/inventory/recipe-manager.tsx");
const usageSrc = readFile("src/components/admin/inventory/usage-report-panel.tsx");

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

console.log("\n=== NINE LICIOUS POS — F4.3 ADMIN INVENTORY UI & RBAC TEST SUITE ===\n");

runTest("1. RBAC rute /admin/inventory hanya mengizinkan admin (kasir & kitchen ditolak)", () => {
  assert.equal(rolesMod.canAccessPath("/admin/inventory", "admin"), true);
  assert.equal(rolesMod.canAccessPath("/admin/inventory", "kasir"), false);
  assert.equal(rolesMod.canAccessPath("/admin/inventory", "kitchen"), false);
  assert.equal(rolesMod.safeNextPath("/admin/inventory", "kasir"), "/pos");
  assert.equal(rolesMod.safeNextPath("/admin/inventory", "kitchen"), "/kitchen");
  assert.equal(rolesMod.safeNextPath("/admin/inventory", "admin"), "/admin/inventory");
  assert.ok(inventoryPageSrc.includes('await requireRole("admin");'));
});

runTest("2. Navigasi menu 'Stok & Resep' (/admin/inventory) khusus role admin", () => {
  const idx = navSrc.indexOf('href: "/admin/inventory"');
  assert.ok(idx !== -1, "navigation.ts harus memuat rute /admin/inventory");
  const block = navSrc.slice(idx, idx + 260);
  assert.ok(block.includes('label: "Stok & Resep"'));
  assert.ok(block.includes('roles: ["admin"]'));
  assert.ok(!block.includes("kasir") && !block.includes("kitchen"));
});

runTest("3. Halaman /admin/inventory mendukung fallback MIGRATION_REQUIRED & zona waktu Asia/Jakarta", () => {
  assert.ok(inventoryPageSrc.includes("MIGRATION_REQUIRED"));
  assert.ok(inventoryPageSrc.includes("PGRST205") && inventoryPageSrc.includes("42P01"));
  assert.ok(inventoryPageSrc.includes("20261119000100_f4_inventory_stock.sql"));
  assert.ok(inventoryPageSrc.includes('timeZone: "Asia/Jakarta"'));
});

runTest("4. Semua komponen frontend F4.3 hanya memakai Server Actions F4.2 (tanpa akses DB client langsung)", () => {
  const clientFiles = [
    ["inventory-management.tsx", mgmtSrc],
    ["ingredient-manager.tsx", ingredientSrc],
    ["stock-adjustment-dialog.tsx", adjustSrc],
    ["recipe-manager.tsx", recipeSrc],
    ["usage-report-panel.tsx", usageSrc],
  ];

  for (const [name, src] of clientFiles) {
    assert.ok(src.startsWith('"use client";'), `${name} harus berupa Client Component`);
    assert.ok(
      !src.includes("@/lib/supabase/client") && !src.includes("@/lib/supabase/admin"),
      `${name} dilarang mengakses Supabase client/admin secara langsung`,
    );
  }

  assert.ok(ingredientSrc.includes("createIngredientAction"));
  assert.ok(ingredientSrc.includes("updateIngredientAction"));
  assert.ok(ingredientSrc.includes("toggleIngredientActiveAction"));
  assert.ok(adjustSrc.includes("adjustIngredientStockAction"));
  assert.ok(recipeSrc.includes("saveProductRecipeAction"));
  assert.ok(recipeSrc.includes("deleteRecipeLineAction"));
  assert.ok(usageSrc.includes("getIngredientUsageReportAction"));
});

runTest("5. InventoryManagement memuat 4 KPI ringkasan, 3 tab, & peringatan stok rendah/negatif kritis", () => {
  for (const kpi of [
    "Total Bahan Baku Aktif",
    "Bahan Stok Rendah",
    "Bahan Habis / Kritis",
    "Total Mutasi Hari Ini",
  ]) {
    assert.ok(mgmtSrc.includes(kpi), `KPI '${kpi}' wajib tampil`);
  }
  for (const tab of ["Bahan Baku", "Resep Produk", "Laporan Pemakaian"]) {
    assert.ok(mgmtSrc.includes(tab), `Tab '${tab}' wajib tersedia`);
  }
  assert.ok(mgmtSrc.includes("buildLowStockAlerts"));
  assert.ok(mgmtSrc.includes("Kritis (Negatif)"));
});

runTest("6. IngredientManager mendukung pencarian, 4 filter, dialog tambah/edit/arsip, & konfirmasi produk terkait", () => {
  assert.ok(ingredientSrc.includes("Semua Aktif"));
  assert.ok(ingredientSrc.includes("Stok Rendah"));
  assert.ok(ingredientSrc.includes("Habis / Kritis"));
  assert.ok(ingredientSrc.includes("Nonaktif"));
  assert.ok(ingredientSrc.includes("INGREDIENT_IN_USE_REQUIRES_CONFIRMATION"));
  assert.ok(ingredientSrc.includes("confirmArchiveWithActiveRecipes"));
  assert.ok(ingredientSrc.includes("Konfirmasi Tetap Arsipkan"));
  assert.ok(!ingredientSrc.includes("currentStock:") && !ingredientSrc.includes("current_stock:"));
});

runTest("7. StockAdjustmentDialog mendukung manual_in, manual_out, stock_opname, pratinjau saldo, alasan wajib & idempotency", () => {
  assert.ok(adjustSrc.includes("Stok Masuk"));
  assert.ok(adjustSrc.includes("Stok Keluar / Waste"));
  assert.ok(adjustSrc.includes("Stock Opname"));
  assert.ok(adjustSrc.includes("Stok Sebelum"));
  assert.ok(adjustSrc.includes("Perubahan"));
  assert.ok(adjustSrc.includes("Stok Sesudah"));
  assert.ok(adjustSrc.includes("Alasan Penyesuaian"));
  assert.ok(adjustSrc.includes("idempotencyKey"));
  assert.ok(adjustSrc.includes("calculateStockOpnameDelta"));
});

runTest("8. RecipeManager memblokir bahan nonaktif dari resep baru & mengonfirmasi penghapusan baris resep", () => {
  assert.ok(recipeSrc.includes("ing.is_active && !usedIds.has(ing.id)"));
  assert.ok(recipeSrc.includes("Hapus Bahan dari Resep?"));
  assert.ok(recipeSrc.includes("deleteRecipeLineAction"));
  assert.ok(recipeSrc.includes("saveProductRecipeAction"));
});

runTest("9. UsageReportPanel memuat filter tanggal WIB, ringkasan per bahan, riwayat mutasi, & state lengkap", () => {
  assert.ok(usageSrc.includes('timeZone: "Asia/Jakarta"'));
  assert.ok(usageSrc.includes("Pemakaian Penjualan"));
  assert.ok(usageSrc.includes("Stok Masuk Manual"));
  assert.ok(usageSrc.includes("Stok Keluar Manual"));
  assert.ok(usageSrc.includes("Selisih Opname"));
  assert.ok(usageSrc.includes("Riwayat Mutasi Stok"));
  assert.ok(usageSrc.includes("<Skeleton"));
});

runTest("10. Dashboard /admin menampilkan kartu ringkasan stok rendah ke /admin/inventory & status fase F4", () => {
  assert.ok(adminPageSrc.includes('href="/admin/inventory"'));
  assert.ok(adminPageSrc.includes("Ringkasan Stok Bahan Baku"));
  assert.ok(adminPageSrc.includes("Menunggu Migrasi F4.1"));
  assert.ok(adminPageSrc.includes("F4 · Stok & bahan baku"));
  assert.ok(adminPageSrc.includes("buildLowStockAlerts"));
});

console.log(`\nRingkasan F4.3: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
