#!/usr/bin/env node
/**
 * NINE LICIOUS POS — TABLE & SERVING SYNCHRONIZATION TEST SUITE
 * File: scripts/test-table-serving-sync.mjs
 *
 * Menguji 7 skenario sinkronisasi status penyajian antara Daftar Pesanan Kasir,
 * Detail Meja pada Denah Meja, dan Penutupan Sesi Meja secara offline (tanpa mutasi DB):
 *
 * 1. Pesanan lunas dan sudah disajikan -> tombol "Tandai Sudah Disajikan" tidak muncul.
 * 2. Pesanan lunas tetapi belum disajikan -> tombol tetap muncul jika memenuhi syarat.
 * 3. Satu meja memiliki dua pesanan: satu sudah disajikan, satu belum ->
 *    evaluasi individual per pesanan & sesi masih terblokir untuk ditutup.
 * 4. Semua pesanan lunas dan semua sudah disajikan -> tombol "Tutup Sesi Meja" tersedia.
 * 5. Ada pesanan yang belum lunas -> sesi tidak boleh ditutup.
 * 6. Penyajian baru saja dikonfirmasi -> ringkasan modal langsung diperbarui
 *    (`served_at`, `served_by`, `can_close_session`, `blocking_reason`) tanpa reload.
 * 7. Sesi sudah ditutup -> penutupan ulang ditolak & meja kembali berstatus kosong (`empty`).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    const resolvedBase = path.join(ROOT, "src", request.slice(2));
    for (const candidate of [
      resolvedBase + ".ts",
      resolvedBase + ".tsx",
      path.join(resolvedBase, "index.ts"),
    ]) {
      const normalized = path.normalize(candidate);
      if (fs.existsSync(normalized)) return normalized;
    }
  }
  if (
    request.startsWith(".") &&
    parent &&
    (parent.filename.endsWith(".ts") || parent.filename.endsWith(".tsx"))
  ) {
    const dir = path.dirname(parent.filename);
    const resolvedBase = path.resolve(dir, request);
    for (const candidate of [
      resolvedBase + ".ts",
      resolvedBase + ".tsx",
      path.join(resolvedBase, "index.ts"),
    ]) {
      const normalized = path.normalize(candidate);
      if (fs.existsSync(normalized)) return normalized;
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

Module._extensions[".ts"] = function (mod, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  return mod._compile(outputText, filename);
};

const require = Module.createRequire(import.meta.url);
const serving = require(path.join(ROOT, "src/lib/orders/serving.ts"));
const closure = require(path.join(ROOT, "src/lib/orders/session-closure.ts"));

function readUtf8(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function makeOrder(overrides = {}) {
  return {
    id: "ord-1",
    order_number: "ORD-20261118-0002",
    status: "paid",
    payment_status: "paid",
    kds_status: "ready",
    subtotal: 50000,
    discount_total: 0,
    tax_total: 5000,
    service_total: 2500,
    grand_total: 57500,
    paid_total: 57500,
    remaining_balance: 0,
    served_at: null,
    served_by: null,
    served_by_name: null,
    created_at: "2026-11-18T06:00:00.000Z",
    ...overrides,
  };
}

function makeSummary(orders, overrides = {}) {
  const grandTotal = orders.reduce((s, o) => s + o.grand_total, 0);
  const paidTotal = orders.reduce((s, o) => s + o.paid_total, 0);
  const unpaidCount = orders.filter((o) =>
    ["awaiting_payment", "partially_paid"].includes(o.status),
  ).length;
  return {
    table_id: "tbl-a04",
    table_name: "A04",
    table_status: "occupied",
    has_active_session: true,
    session_id: "sess-a04-1",
    session_status: "open",
    opened_at: "2026-11-18T05:55:00.000Z",
    total_orders: orders.length,
    unpaid_orders_count: unpaidCount,
    uncompleted_orders_count: orders.filter((o) => o.status === "paid").length,
    completed_orders_count: orders.filter((o) => o.status === "completed").length,
    reserved_allocations_count: 0,
    pending_midtrans_transactions_count: 0,
    processing_webhooks_count: 0,
    pending_refund_count: 0,
    session_subtotal: grandTotal,
    session_discount_total: 0,
    session_tax_total: 0,
    session_service_total: 0,
    session_grand_total: grandTotal,
    session_paid_total: paidTotal,
    session_remaining_balance: Math.max(0, grandTotal - paidTotal),
    can_close_session: false,
    blocking_reason: null,
    orders,
    ...overrides,
  };
}

let passed = 0;
let total = 0;

function runTest(name, fn) {
  total += 1;
  fn();
  console.log(`  [PASS] #${total} ${name}`);
  passed += 1;
}

console.log("===============================================================================");
console.log(" NINE LICIOUS POS — TABLE & SERVING SYNCHRONIZATION TEST SUITE (7 SCENARIOS)");
console.log("===============================================================================\n");

runTest("1. Pesanan lunas & sudah disajikan (served_at terisi) -> tombol Tandai Sudah Disajikan TIDAK muncul", () => {
  const servedOrder = makeOrder({
    served_at: "2026-11-18T06:57:00.000Z",
    served_by: "user-kasir-1",
    served_by_name: "Kasir Satu",
  });
  assert.equal(serving.isOrderServed(servedOrder), true);
  assert.equal(serving.isOrderPendingServing(servedOrder), false);
});

runTest("2. Pesanan lunas & KDS ready tetapi belum disajikan -> tombol Tandai Sudah Disajikan muncul", () => {
  const unservedOrder = makeOrder({ served_at: null, served_by: null });
  assert.equal(serving.isOrderServed(unservedOrder), false);
  assert.equal(serving.isOrderPendingServing(unservedOrder), true);

  // Belum ready di dapur atau belum lunas tetap tidak boleh muncul tombol
  assert.equal(
    serving.isOrderPendingServing(makeOrder({ kds_status: "preparing" })),
    false,
  );
  assert.equal(
    serving.isOrderPendingServing(
      makeOrder({ status: "awaiting_payment", payment_status: "unpaid", paid_total: 0 }),
    ),
    false,
  );
});

runTest("3. Satu meja dua pesanan (1 sudah disajikan, 1 belum) -> evaluasi individual & sesi tetap terblokir", () => {
  const ordServed = makeOrder({
    id: "ord-1",
    order_number: "ORD-20261118-0002",
    served_at: "2026-11-18T06:57:00.000Z",
    served_by: "user-kasir-1",
    served_by_name: "Kasir Satu",
  });
  const ordPending = makeOrder({
    id: "ord-2",
    order_number: "ORD-20261118-0003",
    served_at: null,
    served_by: null,
  });

  assert.equal(serving.isOrderPendingServing(ordServed), false);
  assert.equal(serving.isOrderPendingServing(ordPending), true);

  const summary = makeSummary([ordServed, ordPending]);
  const evalRes = closure.evaluateDiningSessionClosure(summary);
  assert.equal(evalRes.canClose, false);
  assert.match(evalRes.blockingReason, /1 pesanan yang belum disajikan/i);
});

runTest("4. Semua pesanan lunas & semua sudah disajikan -> Tutup Sesi Meja tersedia (canClose = true)", () => {
  const ord1 = makeOrder({
    id: "ord-1",
    served_at: "2026-11-18T06:57:00.000Z",
    served_by: "user-kasir-1",
  });
  const ord2 = makeOrder({
    id: "ord-2",
    order_number: "ORD-20261118-0003",
    served_at: "2026-11-18T07:05:00.000Z",
    served_by: "user-kasir-1",
  });
  const summary = makeSummary([ord1, ord2]);
  const evalRes = closure.evaluateDiningSessionClosure(summary);
  assert.equal(evalRes.canClose, true);
  assert.equal(evalRes.blockingReason, null);
  assert.equal(evalRes.paidOrdersToComplete.length, 2);
});

runTest("5. Ada pesanan yang belum lunas -> sesi TIDAK boleh ditutup", () => {
  const ordPaidServed = makeOrder({
    id: "ord-1",
    served_at: "2026-11-18T06:57:00.000Z",
  });
  const ordUnpaid = makeOrder({
    id: "ord-2",
    order_number: "ORD-20261118-0004",
    status: "awaiting_payment",
    payment_status: "unpaid",
    kds_status: null,
    paid_total: 0,
    remaining_balance: 57500,
    served_at: null,
  });
  const summary = makeSummary([ordPaidServed, ordUnpaid]);
  const evalRes = closure.evaluateDiningSessionClosure(summary);
  assert.equal(evalRes.canClose, false);
  assert.match(evalRes.blockingReason, /belum lunas/i);
});

runTest("6. Penyajian baru saja dikonfirmasi -> status modal & can_close_session langsung berubah tanpa reload", () => {
  const ordPending = makeOrder({
    id: "ord-2",
    order_number: "ORD-20261118-0002",
    served_at: null,
  });
  const initialSummary = makeSummary([ordPending], {
    can_close_session: false,
    blocking_reason: "Sesi belum dapat ditutup: masih terdapat 1 pesanan yang belum disajikan kepada pelanggan.",
  });

  const updated = serving.applyServedConfirmationToSessionSummary(initialSummary, {
    orderId: "ord-2",
    servedAt: "2026-11-18T06:57:00.000Z",
    servedBy: "user-kasir-1",
    servedByName: "Kasir Satu",
  });

  assert.ok(updated);
  assert.equal(serving.isOrderPendingServing(updated.orders[0]), false);
  assert.equal(updated.orders[0].served_at, "2026-11-18T06:57:00.000Z");
  assert.equal(updated.orders[0].served_by_name, "Kasir Satu");
  assert.equal(updated.can_close_session, true);
  assert.equal(updated.blocking_reason, null);

  // Verifikasi kontrak Realtime, source-of-truth served_at, & dynamic floor plan
  const dialogSrc = readUtf8("src/components/tables/table-session-dialog.tsx");
  const floorSrc = readUtf8("src/components/tables/floor-plan-canvas.tsx");
  const floorPageSrc = readUtf8("src/app/(app)/pos/floor/page.tsx");
  const actionsSrc = readUtf8("src/lib/orders/actions.ts");
  const servingActionsSrc = readUtf8("src/lib/orders/serving-actions.ts");

  assert.match(dialogSrc, /isOrderPendingServing\(ord\)/);
  assert.match(dialogSrc, /applyServedConfirmationToSessionSummary/);
  assert.match(dialogSrc, /rawTableStatus = sessionSummary\?\.table_status/);
  assert.match(dialogSrc, /table:\s*"orders"/);
  assert.match(dialogSrc, /table:\s*"dining_sessions"/);
  assert.match(floorSrc, /inspectTableId/);
  assert.match(floorSrc, /table:\s*"dining_tables"/);
  assert.match(floorPageSrc, /export const dynamic = "force-dynamic"/);
  assert.match(actionsSrc, /enrichSessionOrdersWithServingInfo/);
  assert.match(actionsSrc, /\.select\("id, served_at, served_by"\)/);
  assert.match(servingActionsSrc, /revalidatePath\("\/pos\/floor"\)/);
  assert.match(servingActionsSrc, /revalidatePath\("\/pos\/orders"\)/);
});

runTest("7. Sesi sudah ditutup -> penutupan ulang ditolak & meja kembali berstatus kosong (empty)", () => {
  const closedSummary = makeSummary([], {
    has_active_session: false,
    session_status: "closed",
    table_status: "empty",
  });
  const evalClosed = closure.evaluateDiningSessionClosure(closedSummary);
  assert.equal(evalClosed.canClose, false);
  assert.match(evalClosed.blockingReason, /tidak memiliki sesi kunjungan aktif/i);

  const floorSrc = readUtf8("src/components/tables/floor-plan-canvas.tsx");
  assert.match(floorSrc, /setStatusOverrides\(\(prev\) => \(\{ \.\.\.prev, \[tableId\]: "empty" \}\)\)/);
});

console.log(`\nHASIL TABLE & SERVING SYNC: ${passed} / ${total} TEST CASES PASS`);
if (passed !== total) {
  process.exit(1);
}
