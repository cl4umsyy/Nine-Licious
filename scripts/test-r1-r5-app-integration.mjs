#!/usr/bin/env node
/**
 * NINE LICIOUS POS — R1-R5 REFUND, REPLACEMENT, INVENTORY, & REPORT INTEGRATION TEST SUITE
 *
 * Pure offline verification (in-memory TypeScript loader + contract assertions).
 * Zero mutations against Supabase production database.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
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
    if (specifier.startsWith("@/")) {
      const target = path.resolve(ROOT, "src", specifier.slice(2));
      const tsCandidate = target.endsWith(".ts") ? target : `${target}.ts`;
      if (fs.existsSync(tsCandidate)) {
        return loadTsModule(path.relative(ROOT, tsCandidate));
      }
    }
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

const refundCalc = loadTsModule("src/lib/refunds/calculations.ts");
const refundValidation = loadTsModule("src/lib/refunds/validation.ts");
const reportCalc = loadTsModule("src/lib/reports/calculations.ts");
const invCalc = loadTsModule("src/lib/inventory/calculations.ts");
const invConst = loadTsModule("src/lib/inventory/constants.ts");

function readUtf8(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

let passed = 0;
let failed = 0;

function runTest(id, title, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] #${id} ${title}`);
  } catch (err) {
    failed += 1;
    console.error(`  [FAIL] #${id} ${title}`);
    console.error(`         ${err instanceof Error ? err.stack || err.message : String(err)}`);
  }
}

console.log("\n=== NINE LICIOUS POS — R1-R5 INTEGRATION TEST SUITE ===\n");

runTest(1, "Rule A.2: Kompensasi 25% & 50% murni dari DPP bersih tanpa Pajak/Service + simpan reference tax/service", () => {
  const order = {
    subtotal: 100000,
    discount_product_total: 0,
    discount_order_total: 10000,
    discount_manual_total: 0,
    service_total: 4500, // 5% dari DPP 90.000
    tax_total: 9000, // 10% dari DPP 90.000
    kds_status: "ready",
  };
  const items = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      product_name_snapshot: "Wagyu Steak",
      unit_price_snapshot: 100000,
      quantity: 1,
      subtotal: 100000,
      discount_amount: 0,
      created_at: "2026-11-26T10:00:00Z",
    },
  ];
  const baselines = refundCalc.buildOrderItemBaselines({
    order,
    orderItems: items,
    priorRefundItems: [],
  });
  assert.equal(baselines[0].netDpp, 90000);
  assert.equal(baselines[0].serviceShare, 4500);
  assert.equal(baselines[0].taxShare, 9000);

  // Kompensasi ringan 25%
  const preview25 = refundCalc.calculateRefundBreakdownPreview({
    baselines,
    availableRefundable: 103500,
    resolutionType: "partial_refund",
    reasonCategory: "food_quality",
    selectedItems: [
      {
        orderItemId: items[0].id,
        quantity: 1,
        compensationSeverity: "light",
      },
    ],
  });
  assert.equal(preview25.validationError, null);
  assert.equal(preview25.totalRefundAmount, 22500); // 25% * 90.000
  assert.equal(preview25.serviceChargeAmount, 0);
  assert.equal(preview25.taxAmount, 0);
  assert.equal(preview25.referenceServiceChargeAmount, 4500);
  assert.equal(preview25.referenceTaxAmount, 9000);

  // Kompensasi sedang 50%
  const preview50 = refundCalc.calculateRefundBreakdownPreview({
    baselines,
    availableRefundable: 103500,
    resolutionType: "partial_refund",
    reasonCategory: "wrong_order",
    selectedItems: [
      {
        orderItemId: items[0].id,
        quantity: 1,
        compensationSeverity: "medium",
      },
    ],
  });
  assert.equal(preview50.validationError, null);
  assert.equal(preview50.totalRefundAmount, 45000); // 50% * 90.000
  assert.equal(preview50.serviceChargeAmount, 0);
  assert.equal(preview50.taxAmount, 0);
});

runTest(2, "Rule A.3: Pengajuan ulang item (25% -> 50% -> diblokir >100%) & item exhausted ditolak", () => {
  const order = {
    subtotal: 100000,
    discount_product_total: 0,
    discount_order_total: 0,
    discount_manual_total: 0,
    service_total: 5000,
    tax_total: 10000,
    kds_status: "ready",
  };
  const itemId = "22222222-2222-4222-8222-222222222222";
  const orderItems = [
    {
      id: itemId,
      product_name_snapshot: "Pasta",
      unit_price_snapshot: 100000,
      quantity: 1,
      subtotal: 100000,
      discount_amount: 0,
      created_at: "2026-11-26T10:00:00Z",
    },
  ];

  // Klaim sebelumnya: 25% + 50% = 75.000 DPP (belum rejected/cancelled) + 1 pengajuan rejected yg harus diabaikan
  const priorClaims = [
    {
      order_item_id: itemId,
      quantity: 1,
      net_item_amount: 25000,
      service_charge_amount: 0,
      tax_amount: 0,
      refund_amount: 25000,
      compensation_percentage: 25,
      is_full_item_refund: false,
      approval_status: "approved",
      payout_status: "completed",
      resolution_type: "partial_refund",
    },
    {
      order_item_id: itemId,
      quantity: 1,
      net_item_amount: 50000,
      service_charge_amount: 0,
      tax_amount: 0,
      refund_amount: 50000,
      compensation_percentage: 50,
      is_full_item_refund: false,
      approval_status: "approved",
      payout_status: "completed",
      resolution_type: "partial_refund",
    },
    {
      order_item_id: itemId,
      quantity: 1,
      net_item_amount: 100000,
      service_charge_amount: 5000,
      tax_amount: 10000,
      refund_amount: 115000,
      compensation_percentage: 100,
      is_full_item_refund: true,
      approval_status: "rejected",
      payout_status: "not_required",
      resolution_type: "full_refund",
    },
  ];

  const baselines = refundCalc.buildOrderItemBaselines({
    order,
    orderItems,
    priorRefundItems: priorClaims,
  });
  assert.equal(baselines[0].priorRefundTotal, 75000);
  assert.equal(baselines[0].isExhausted, false);

  // Pengajuan ulang 50% sekarang melampaui batas DPP 100.000 -> DITOLAK
  const overPreview = refundCalc.calculateRefundBreakdownPreview({
    baselines,
    availableRefundable: 40000,
    resolutionType: "partial_refund",
    reasonCategory: "food_quality",
    selectedItems: [
      {
        orderItemId: itemId,
        quantity: 1,
        compensationSeverity: "medium",
      },
    ],
  });
  assert.ok(overPreview.validationError);

  // Pengajuan 25% menuntaskan sisa DPP (75k + 25k = 100k DPP) -> VALID
  const okPreview25 = refundCalc.calculateRefundBreakdownPreview({
    baselines,
    availableRefundable: 40000,
    resolutionType: "partial_refund",
    reasonCategory: "food_quality",
    selectedItems: [
      {
        orderItemId: itemId,
        quantity: 1,
        compensationSeverity: "light",
      },
    ],
  });
  assert.equal(okPreview25.validationError, null);
  assert.equal(okPreview25.totalRefundAmount, 25000);
});

runTest(3, "Replacement menghasilkan nominal Rp 0 dan batas 24 jam dihitung akurat", () => {
  const order = {
    subtotal: 50000,
    discount_product_total: 0,
    discount_order_total: 0,
    discount_manual_total: 0,
    service_total: 2500,
    tax_total: 5000,
    kds_status: "ready",
  };
  const itemId = "33333333-3333-4333-8333-333333333333";
  const baselines = refundCalc.buildOrderItemBaselines({
    order,
    orderItems: [
      {
        id: itemId,
        product_name_snapshot: "Espresso",
        unit_price_snapshot: 50000,
        quantity: 1,
        subtotal: 50000,
        discount_amount: 0,
        created_at: "2026-11-26T10:00:00Z",
      },
    ],
    priorRefundItems: [],
  });
  const repPreview = refundCalc.calculateRefundBreakdownPreview({
    baselines,
    availableRefundable: 57500,
    resolutionType: "replacement",
    reasonCategory: "wrong_order",
    selectedItems: [{ orderItemId: itemId, quantity: 1 }],
  });
  assert.equal(repPreview.validationError, null);
  assert.equal(repPreview.totalRefundAmount, 0);
  assert.equal(repPreview.items[0].compensationPercentage, 0);

  const nowMs = Date.parse("2026-11-26T12:00:00Z");
  assert.equal(
    refundCalc.isWithinRefund24HourWindow("2026-11-26T00:00:00Z", nowMs).within24Hours,
    true,
  );
  assert.equal(
    refundCalc.isWithinRefund24HourWindow("2026-11-25T11:59:59Z", nowMs).within24Hours,
    false,
  );
});

runTest(4, "TAHAP 2: calculateSalesReport & calculateRefundReport mengecualikan replacement Rp 0", () => {
  const orders = [
    {
      id: "ord-std-1",
      order_kind: "standard",
      status: "paid",
      subtotal: 100000,
      discount_total: 0,
      tax_total: 10000,
      service_total: 5000,
      grand_total: 115000,
      paid_total: 115000,
      created_at: "2026-11-26T10:00:00+07:00",
    },
    {
      id: "ord-rpl-1",
      order_kind: "replacement",
      status: "paid",
      subtotal: 0,
      discount_total: 0,
      tax_total: 0,
      service_total: 0,
      grand_total: 0,
      paid_total: 0,
      created_at: "2026-11-26T11:00:00+07:00",
    },
  ];
  const refunds = [
    {
      id: "ref-rpl",
      refund_number: "RFD-RPL",
      order_id: "ord-std-1",
      payment_id: null,
      amount: 0,
      reason: "Buat ulang menu",
      refund_type: "replacement",
      resolution_type: "replacement",
      approval_status: "approved",
      payout_status: "not_required",
      refund_method: "none",
      status: "completed",
      approved_at: "2026-11-26T11:00:00+07:00",
      created_at: "2026-11-26T11:00:00+07:00",
    },
    {
      id: "ref-fin",
      refund_number: "RFD-FIN",
      order_id: "ord-std-1",
      payment_id: null,
      amount: 15000,
      reason: "Kompensasi parsial",
      refund_type: "partial",
      resolution_type: "partial_refund",
      approval_status: "approved",
      payout_status: "completed",
      refund_method: "cash",
      status: "completed",
      approved_at: "2026-11-26T11:30:00+07:00",
      created_at: "2026-11-26T11:30:00+07:00",
    },
  ];

  const period = { startDate: "2026-11-26", endDate: "2026-11-26" };
  const sales = reportCalc.calculateSalesReport(orders, refunds, period, 1);
  assert.equal(sales.paidOrdersCount, 1, "Order replacement Rp 0 dilarang ikut paidOrdersCount");
  assert.equal(sales.averageOrderValue, 100000, "AOV tetap 100.000 bukan terbagi 2 order");
  assert.equal(sales.totalRefund, 15000);

  const refRep = reportCalc.calculateRefundReport(refunds, period);
  assert.equal(refRep.totalRefundCount, 1, "Replacement Rp 0 dilarang dihitung sebagai refund finansial");
  assert.equal(refRep.totalRefundAmount, 15000);
});

runTest(5, "TAHAP 2 Query Filters: reports, transactions, export (fix tables->dining_tables), queue, stale-cleanup, orders", () => {
  const reportsSrc = readUtf8("src/lib/reports/actions.ts");
  assert.equal((reportsSrc.match(/\.neq\("order_kind", "replacement"\)/g) || []).length >= 2, true);
  assert.match(reportsSrc, /\.neq\("resolution_type", "replacement"\)/);

  const txSrc = readUtf8("src/lib/transactions/actions.ts");
  assert.match(txSrc, /\.neq\("order_kind", "replacement"\)/);
  assert.match(txSrc, /\.neq\("resolution_type", "replacement"\)/);

  const exportSrc = readUtf8("src/lib/export/actions.ts");
  assert.match(exportSrc, /\.neq\("order_kind", "replacement"\)/);
  assert.equal(exportSrc.includes('.from("tables")'), false, "Bug tabel 'tables' harus sudah diganti ke 'dining_tables'");
  assert.match(exportSrc, /\.from\("dining_tables"\)\.select\("id, name"\)/);

  const paymentsSrc = readUtf8("src/lib/payments/actions.ts");
  assert.equal((paymentsSrc.match(/\.neq\("order_kind", "replacement"\)/g) || []).length >= 2, true);

  const cleanupSrc = readUtf8("src/lib/midtrans/stale-cleanup.ts");
  assert.equal((cleanupSrc.match(/\.neq\("order_kind", "replacement"\)/g) || []).length >= 3, true);

  const ordersSrc = readUtf8("src/lib/orders/actions.ts");
  assert.equal((ordersSrc.match(/\.neq\("order_kind", "replacement"\)/g) || []).length >= 3, true);
});

runTest(6, "F4 Inventory: 'waste' mencatat wasted_quantity tanpa double-deduction & menjaga STOCK_MOVEMENT_TYPES", () => {
  assert.deepEqual(invConst.STOCK_MOVEMENT_TYPES, [
    "sale_deduction",
    "manual_in",
    "manual_out",
    "stock_opname",
  ]);
  assert.ok(invConst.ALL_STOCK_MOVEMENT_TYPES.includes("waste"));
  assert.ok(invConst.ALL_STOCK_MOVEMENT_TYPES.includes("refund_restock"));

  const ingId = "44444444-4444-4444-8444-444444444444";
  const ingMap = new Map([
    [
      ingId,
      {
        id: ingId,
        name: "Beef Patty",
        sku: "ING-01",
        unit: "pcs",
        is_active: true,
        current_stock: 9,
        min_stock: 2,
      },
    ],
  ]);

  const rows = invCalc.aggregateIngredientUsageReport(
    [
      {
        ingredient_id: ingId,
        movement_type: "sale_deduction",
        quantity_delta: -2,
        wasted_quantity: 0,
        order_id: "ord-1",
      },
      {
        ingredient_id: ingId,
        movement_type: "waste",
        quantity_delta: 0,
        wasted_quantity: 2,
        order_id: "ord-1",
      },
      {
        ingredient_id: ingId,
        movement_type: "refund_restock",
        quantity_delta: 1,
        wasted_quantity: 0,
        order_id: "ord-2",
      },
    ],
    ingMap,
  );
  assert.equal(rows[0].sale_deducted_total, 2);
  assert.equal(rows[0].waste_total, 2);
  assert.equal(rows[0].refund_restock_total, 1);
  assert.equal(rows[0].net_change, -1, "Waste quantity_delta = 0 tidak boleh memotong net_change dua kali");
});

runTest(7, "Keamanan RBAC, Validasi Evidence 50MB/MIME/Traversal, Isolasi KDS & Struk", () => {
  const refundActionsSrc = readUtf8("src/lib/refunds/actions.ts");
  assert.match(refundActionsSrc, /p_auto_approve:\s*isAdmin\s*\?\s*Boolean\(input\.autoApprove\)\s*:\s*false/);
  assert.match(refundActionsSrc, /export async function approveOrderRefundAction[\s\S]{0,300}getAdminActor\(\)/);
  assert.match(refundActionsSrc, /export async function rejectOrderRefundAction[\s\S]{0,300}getAdminActor\(\)/);
  assert.match(refundActionsSrc, /export async function requestRefundEvidenceAction[\s\S]{0,300}getAdminActor\(\)/);
  assert.match(refundActionsSrc, /export async function completeRefundManualFallbackAction[\s\S]{0,300}getAdminActor\(\)/);
  assert.match(refundActionsSrc, /export async function recordRefundCorrectionAction[\s\S]{0,300}getAdminActor\(\)/);
  assert.match(refundActionsSrc, /!input\.filePath\.startsWith\(`\$\{actor\.session\.user\.id\}\/`\)/);

  // Evidence validation rejects traversal & oversize & invalid MIME
  assert.equal(
    refundValidation.attachRefundEvidenceSchema.safeParse({
      refundId: "11111111-1111-4111-8111-111111111111",
      filePath: "user1/../secret.jpg",
      fileName: "secret.jpg",
      fileType: "image/jpeg",
      fileSize: 1024,
    }).success,
    false,
  );
  assert.equal(
    refundValidation.attachRefundEvidenceSchema.safeParse({
      refundId: "11111111-1111-4111-8111-111111111111",
      filePath: "user1/ref/big.mp4",
      fileName: "big.mp4",
      fileType: "video/mp4",
      fileSize: 60_000_000,
    }).success,
    false,
  );
  assert.equal(
    refundValidation.attachRefundEvidenceSchema.safeParse({
      refundId: "11111111-1111-4111-8111-111111111111",
      filePath: "user1/ref/script.sh",
      fileName: "script.sh",
      fileType: "text/plain",
      fileSize: 100,
    }).success,
    false,
  );

  // Receipt modal isolates replacement & non-approved refunds from financial breakdown
  const receiptSrc = readUtf8("src/components/pos/receipt-modal.tsx");
  assert.match(receiptSrc, /r\.resolution_type !== "replacement"/);
  assert.match(receiptSrc, /r\.approval_status === "approved"/);

  // KDS membaca tabel non-finansial via RLS
  const kdsSrc = readUtf8("src/lib/kds/actions.ts");
  assert.match(kdsSrc, /\.from\("order_replacements"\)/);
  assert.match(kdsSrc, /\.from\("kds_item_cancellations"\)/);
});

console.log("\n===============================================================================");
console.log(` HASIL TEST R1-R5: ${passed} / ${passed + failed} TEST CASES PASS`);
console.log("===============================================================================\n");

if (failed > 0) {
  process.exit(1);
}
