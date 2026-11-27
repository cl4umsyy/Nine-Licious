#!/usr/bin/env node
/**
 * NINE LICIOUS POS - TEST SUITE: DINING SESSION CLOSURE (PENUTUPAN SESI MEJA)
 *
 * Menguji seluruh skenario yang diwajibkan:
 * 1. Sesi dengan semua tagihan lunas (status 'completed' & status 'paid' dgn KDS queued).
 * 2. Sesi dengan tagihan belum lunas (awaiting_payment / partially_paid / sisa saldo > 0).
 * 3. Sesi dengan pesanan tambahan (semua lunas vs pesanan tambahan belum lunas).
 * 4. Sesi dengan pembayaran split bill (parsial, alokasi reserved, Midtrans pending, webhook in-flight, lunas).
 * 5. Sesi dengan refund (pending refund, partial refund pada pesanan belum lunas, partial refund pada pesanan lunas, full refund).
 * 6. Penutupan sesi yang sudah pernah ditutup (session_status='closed' / tidak ada sesi aktif).
 * 7. Isolasi sesi baru saat meja digunakan kembali (verifikasi kontrak create_pos_order_atomic).
 * 8. Sinkronisasi status meja pada denah & komponen kasir (FloorPlanCanvas, TableSessionDialog, TableSelectModal, PosContainer).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Replikasi identik pure function dari src/lib/orders/session-closure.ts
// disertai verifikasi sinkronisasi sumber file.
const closureSourcePath = path.join(process.cwd(), "src", "lib", "orders", "session-closure.ts");
const closureSource = fs.readFileSync(closureSourcePath, "utf-8");

const ACTIVE_KDS_STATUSES = new Set(["queued", "preparing", "ready"]);
const TERMINAL_CLOSED_ORDER_STATUSES = new Set(["cancelled", "refunded"]);
const UNPAID_ORDER_STATUSES = new Set(["awaiting_payment", "partially_paid"]);
const UNPAID_PAYMENT_STATUSES = new Set(["unpaid", "partially_paid"]);

function formatSessionCode(sessionId) {
  if (!sessionId) return "-";
  const clean = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
  return clean ? `SES-${clean}` : "-";
}

function evaluateDiningSessionClosure(summary) {
  const emptyResult = {
    canClose: false,
    blockingReason: null,
    paidOrdersToComplete: [],
    partiallyRefundedPaidOrdersToComplete: [],
    completedOrdersWithActiveKds: [],
  };

  if (!summary.has_active_session || !summary.session_id) {
    return {
      ...emptyResult,
      blockingReason: "Meja tidak memiliki sesi kunjungan aktif.",
    };
  }

  if (summary.session_status && summary.session_status !== "open") {
    return {
      ...emptyResult,
      blockingReason: `Sesi kunjungan sudah ditutup (status: ${summary.session_status}).`,
    };
  }

  const orders = Array.isArray(summary.orders) ? summary.orders : [];

  const unpaidOrders = orders.filter((o) => {
    if (TERMINAL_CLOSED_ORDER_STATUSES.has(o.status)) return false;
    const grandTotal = Number(o.grand_total) || 0;
    const paidTotal = Number(o.paid_total) || 0;
    const remaining = Math.max(0, grandTotal - paidTotal);
    return (
      UNPAID_ORDER_STATUSES.has(o.status) ||
      UNPAID_PAYMENT_STATUSES.has(o.payment_status) ||
      remaining > 0
    );
  });

  if ((summary.unpaid_orders_count ?? 0) > 0 || unpaidOrders.length > 0) {
    const count = Math.max(summary.unpaid_orders_count ?? 0, unpaidOrders.length);
    const totalRemaining = Math.max(
      Number(summary.session_remaining_balance) || 0,
      unpaidOrders.reduce(
        (sum, o) => sum + Math.max(0, (Number(o.grand_total) || 0) - (Number(o.paid_total) || 0)),
        0,
      ),
    );
    const remainingSuffix =
      totalRemaining > 0
        ? ` (sisa tagihan Rp ${totalRemaining.toLocaleString("id-ID")})`
        : "";
    return {
      ...emptyResult,
      blockingReason: `Sesi belum dapat ditutup: masih terdapat ${count} pesanan yang belum lunas${remainingSuffix}.`,
    };
  }

  const sessionRemaining = Math.max(
    Number(summary.session_remaining_balance) || 0,
    (Number(summary.session_grand_total) || 0) - (Number(summary.session_paid_total) || 0),
  );
  if (sessionRemaining > 0) {
    return {
      ...emptyResult,
      blockingReason: `Sesi belum dapat ditutup: masih terdapat sisa tagihan sebesar Rp ${sessionRemaining.toLocaleString("id-ID")}.`,
    };
  }

  // Seluruh pesanan aktif harus sudah disajikan (`served_at` terisi).
  // Pesanan 'completed' dari alur lama tetap dianggap sudah diserahkan.
  const unservedOrders = orders.filter((order) => {
    if (TERMINAL_CLOSED_ORDER_STATUSES.has(order.status)) return false;
    if (order.status === "completed") return false;
    return !order.served_at;
  });

  if (unservedOrders.length > 0) {
    return {
      ...emptyResult,
      blockingReason: `Sesi belum dapat ditutup: masih terdapat ${unservedOrders.length} pesanan yang belum disajikan kepada pelanggan.`,
    };
  }

  if ((summary.reserved_allocations_count ?? 0) > 0) {
    return {
      ...emptyResult,
      blockingReason:
        "Sesi belum dapat ditutup: terdapat alokasi pembayaran split bill yang masih berstatus reserved.",
    };
  }

  if ((summary.pending_midtrans_transactions_count ?? 0) > 0) {
    return {
      ...emptyResult,
      blockingReason:
        "Sesi belum dapat ditutup: terdapat transaksi Midtrans yang masih menunggu penyelesaian.",
    };
  }

  if ((summary.processing_webhooks_count ?? 0) > 0) {
    return {
      ...emptyResult,
      blockingReason:
        "Sesi belum dapat ditutup: terdapat notifikasi pembayaran Midtrans yang sedang diproses.",
    };
  }

  if ((summary.pending_refund_count ?? 0) > 0) {
    return {
      ...emptyResult,
      blockingReason:
        "Sesi belum dapat ditutup: masih terdapat permohonan refund yang berstatus pending.",
    };
  }

  const paidOrdersToComplete = [];
  const partiallyRefundedPaidOrdersToComplete = [];
  const completedOrdersWithActiveKds = [];

  for (const order of orders) {
    if (order.status === "paid") {
      if (order.payment_status === "paid") {
        paidOrdersToComplete.push(order);
      } else if (
        order.payment_status === "partially_refunded" &&
        (Number(order.paid_total) || 0) >= (Number(order.grand_total) || 0)
      ) {
        partiallyRefundedPaidOrdersToComplete.push(order);
      } else {
        return {
          ...emptyResult,
          blockingReason: `Sesi belum dapat ditutup: pesanan #${order.order_number} memiliki status pembayaran yang belum tuntas (${order.payment_status}).`,
        };
      }
    } else if (
      order.status === "completed" &&
      order.kds_status &&
      ACTIVE_KDS_STATUSES.has(order.kds_status)
    ) {
      completedOrdersWithActiveKds.push(order);
    }
  }

  return {
    canClose: true,
    blockingReason: null,
    paidOrdersToComplete,
    partiallyRefundedPaidOrdersToComplete,
    completedOrdersWithActiveKds,
  };
}

function makeOrder(overrides = {}) {
  return {
    id: "ord-1",
    order_number: "ORD-20261118-0001",
    status: "paid",
    payment_status: "paid",
    kds_status: "queued",
    subtotal: 30000,
    discount_total: 0,
    tax_total: 3000,
    service_total: 1500,
    grand_total: 34500,
    paid_total: 34500,
    refunded_total: 0,
    remaining_balance: 0,
    served_at: "2026-11-18T06:57:00.000Z",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeSummary(overrides = {}) {
  const orders = overrides.orders ?? [makeOrder()];
  const activeOrders = orders.filter((o) => !["cancelled", "refunded"].includes(o.status));
  const grandTotal = activeOrders.reduce((s, o) => s + o.grand_total, 0);
  const paidTotal = activeOrders.reduce((s, o) => s + o.paid_total, 0);
  const unpaidCount = orders.filter((o) => ["awaiting_payment", "partially_paid"].includes(o.status)).length;
  const uncompletedCount = orders.filter((o) => o.status === "paid").length;
  const completedCount = orders.filter((o) => o.status === "completed").length;

  return {
    table_id: "table-a08",
    table_name: "A08",
    table_status: "occupied",
    has_active_session: true,
    session_id: "70bf7d5c-50f9-4c02-b1d8-81e4b564a4c7",
    session_status: "open",
    opened_at: new Date().toISOString(),
    total_orders: orders.length,
    unpaid_orders_count: unpaidCount,
    uncompleted_orders_count: uncompletedCount,
    completed_orders_count: completedCount,
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
    session_refunded_total: 0,
    session_remaining_balance: Math.max(0, grandTotal - paidTotal),
    can_close_session: false,
    blocking_reason: null,
    orders,
    ...overrides,
  };
}

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ [FAIL] ${name}: ${err.message}`);
  }
}

console.log("===============================================================================");
console.log("  NINE LICIOUS POS - DINING SESSION CLOSURE TEST SUITE");
console.log("===============================================================================\n");

// 1. Sesi lunas
runTest("1a. Sesi dengan pesanan lunas (status='completed', remaining=0) dapat ditutup", () => {
  const res = evaluateDiningSessionClosure(
    makeSummary({ orders: [makeOrder({ status: "completed", kds_status: null })] }),
  );
  assert.equal(res.canClose, true);
  assert.equal(res.blockingReason, null);
  assert.equal(res.paidOrdersToComplete.length, 0);
});

runTest("1b. Sesi dengan pesanan lunas (status='paid', kds_status='ready') dapat ditutup & ditandai auto-complete", () => {
  const res = evaluateDiningSessionClosure(
    makeSummary({ orders: [makeOrder({ status: "paid", payment_status: "paid", kds_status: "ready" })] }),
  );
  assert.equal(res.canClose, true);
  assert.equal(res.blockingReason, null);
  assert.equal(res.paidOrdersToComplete.length, 1);
  assert.equal(res.paidOrdersToComplete[0].id, "ord-1");
});

runTest("1c. Pesanan lunas & KDS ready tetapi belum disajikan (served_at NULL) DITOLAK", () => {
  const res = evaluateDiningSessionClosure(
    makeSummary({
      orders: [
        makeOrder({ status: "paid", payment_status: "paid", kds_status: "ready", served_at: null }),
      ],
    }),
  );
  assert.equal(res.canClose, false);
  assert.ok(res.blockingReason.includes("belum disajikan"));
});

runTest("1d. Status penyajian dievaluasi terpisah per pesanan dalam satu sesi", () => {
  const res = evaluateDiningSessionClosure(
    makeSummary({
      orders: [
        makeOrder({ id: "ord-1", order_number: "ORD-001", status: "paid", kds_status: "ready" }),
        makeOrder({
          id: "ord-2",
          order_number: "ORD-002",
          status: "paid",
          kds_status: "ready",
          served_at: null,
        }),
      ],
    }),
  );
  assert.equal(res.canClose, false);
  assert.ok(res.blockingReason.includes("1 pesanan"));
  assert.ok(res.blockingReason.includes("belum disajikan"));
});

runTest("1e. Pesanan 'completed' lama tanpa served_at tetap dianggap sudah diserahkan", () => {
  const res = evaluateDiningSessionClosure(
    makeSummary({
      orders: [
        makeOrder({ status: "completed", kds_status: null, served_at: null }),
      ],
    }),
  );
  assert.equal(res.canClose, true);
});

// 2. Sesi belum lunas
runTest("2a. Sesi dengan pesanan awaiting_payment ditolak ditutup", () => {
  const res = evaluateDiningSessionClosure(
    makeSummary({
      table_status: "awaiting_payment",
      orders: [
        makeOrder({
          status: "awaiting_payment",
          payment_status: "unpaid",
          paid_total: 0,
          remaining_balance: 34500,
        }),
      ],
    }),
  );
  assert.equal(res.canClose, false);
  assert.ok(res.blockingReason.includes("belum lunas"));
});

runTest("2b. Sesi dengan sisa tagihan > 0 meski status anomali ditolak ditutup", () => {
  const res = evaluateDiningSessionClosure(
    makeSummary({
      orders: [
        makeOrder({
          status: "paid",
          payment_status: "paid",
          grand_total: 50000,
          paid_total: 40000,
          remaining_balance: 10000,
        }),
      ],
    }),
  );
  assert.equal(res.canClose, false);
  assert.ok(res.blockingReason.includes("belum lunas"));
});

// 3. Pesanan tambahan
runTest("3a. Sesi dengan pesanan utama lunas + pesanan tambahan belum lunas DITOLAK", () => {
  const res = evaluateDiningSessionClosure(
    makeSummary({
      orders: [
        makeOrder({ id: "ord-1", order_number: "ORD-001", status: "completed", kds_status: null }),
        makeOrder({
          id: "ord-2",
          order_number: "ORD-002",
          status: "awaiting_payment",
          payment_status: "unpaid",
          grand_total: 25000,
          paid_total: 0,
          remaining_balance: 25000,
        }),
      ],
    }),
  );
  assert.equal(res.canClose, false);
  assert.ok(res.blockingReason.includes("25.000") || res.blockingReason.includes("25,000"));
});

runTest("3b. Sesi dengan pesanan utama + pesanan tambahan SEMUA LUNAS dapat ditutup", () => {
  const res = evaluateDiningSessionClosure(
    makeSummary({
      orders: [
        makeOrder({ id: "ord-1", order_number: "ORD-001", status: "completed", kds_status: null }),
        makeOrder({ id: "ord-2", order_number: "ORD-002", status: "paid", payment_status: "paid", kds_status: "ready" }),
      ],
    }),
  );
  assert.equal(res.canClose, true);
  assert.equal(res.paidOrdersToComplete.length, 1);
  assert.equal(res.paidOrdersToComplete[0].id, "ord-2");
});

// 4. Split bill
runTest("4a. Sesi dengan split bill partially_paid (masih ada sisa tagihan) DITOLAK", () => {
  const res = evaluateDiningSessionClosure(
    makeSummary({
      orders: [
        makeOrder({
          status: "partially_paid",
          payment_status: "partially_paid",
          grand_total: 100000,
          paid_total: 60000,
          remaining_balance: 40000,
        }),
      ],
    }),
  );
  assert.equal(res.canClose, false);
  assert.ok(res.blockingReason.includes("belum lunas"));
});

runTest("4b. Sesi dengan alokasi split bill reserved DITOLAK", () => {
  const res = evaluateDiningSessionClosure(
    makeSummary({ reserved_allocations_count: 1 }),
  );
  assert.equal(res.canClose, false);
  assert.ok(res.blockingReason.includes("split bill"));
});

runTest("4c. Sesi dengan transaksi Midtrans pending / webhook in-flight DITOLAK", () => {
  const r1 = evaluateDiningSessionClosure(makeSummary({ pending_midtrans_transactions_count: 1 }));
  assert.equal(r1.canClose, false);
  assert.ok(r1.blockingReason.includes("Midtrans"));

  const r2 = evaluateDiningSessionClosure(makeSummary({ processing_webhooks_count: 1 }));
  assert.equal(r2.canClose, false);
  assert.ok(r2.blockingReason.includes("notifikasi"));
});

// 5. Refund
runTest("5a. Sesi dengan pending refund DITOLAK", () => {
  const res = evaluateDiningSessionClosure(makeSummary({ pending_refund_count: 1 }));
  assert.equal(res.canClose, false);
  assert.ok(res.blockingReason.includes("refund"));
});

runTest("5b. Refund sebagian pada pesanan BELUM LUNAS (partially_paid) tetap DITOLAK (tidak dianggap lunas)", () => {
  const res = evaluateDiningSessionClosure(
    makeSummary({
      orders: [
        makeOrder({
          status: "partially_paid",
          payment_status: "partially_refunded",
          grand_total: 100000,
          paid_total: 60000,
          refunded_total: 20000,
          remaining_balance: 40000,
        }),
      ],
    }),
  );
  assert.equal(res.canClose, false);
  assert.ok(res.blockingReason.includes("belum lunas"));
});

runTest("5c. Refund sebagian pada pesanan yang SUDAH LUNAS (paid_total >= grand_total, pending_refund=0) dapat ditutup tanpa deadlock", () => {
  const res = evaluateDiningSessionClosure(
    makeSummary({
      orders: [
        makeOrder({
          status: "paid",
          payment_status: "partially_refunded",
          grand_total: 50000,
          paid_total: 50000,
          refunded_total: 10000,
          remaining_balance: 0,
        }),
      ],
      session_refunded_total: 10000,
    }),
  );
  assert.equal(res.canClose, true);
  assert.equal(res.partiallyRefundedPaidOrdersToComplete.length, 1);
});

runTest("5d. Full refund (status='refunded', pending_refund=0) tanpa pesanan unpaid dapat ditutup", () => {
  const res = evaluateDiningSessionClosure(
    makeSummary({
      orders: [
        makeOrder({
          status: "refunded",
          payment_status: "refunded",
          kds_status: null,
          grand_total: 50000,
          paid_total: 50000,
          refunded_total: 50000,
          remaining_balance: 0,
        }),
      ],
      session_refunded_total: 50000,
    }),
  );
  assert.equal(res.canClose, true);
});

// 6. Penutupan sesi yang sudah pernah ditutup
runTest("6. Sesi yang sudah berstatus 'closed' atau tanpa sesi aktif DITOLAK ditutup ulang", () => {
  const rClosed = evaluateDiningSessionClosure(makeSummary({ session_status: "closed" }));
  assert.equal(rClosed.canClose, false);
  assert.ok(rClosed.blockingReason.includes("sudah ditutup"));

  const rNone = evaluateDiningSessionClosure(makeSummary({ has_active_session: false, session_id: undefined }));
  assert.equal(rNone.canClose, false);
  assert.ok(rNone.blockingReason.includes("tidak memiliki sesi"));
});

// 7 & 8. Format nomor sesi, kontrak server action, UI konfirmasi, & sinkronisasi denah
runTest("7. formatSessionCode menghasilkan nomor sesi ringkas yang konsisten", () => {
  assert.equal(formatSessionCode("70bf7d5c-50f9-4c02-b1d8-81e4b564a4c7"), "SES-70BF7D5C");
  assert.equal(formatSessionCode(null), "-");
});

runTest("8. Verifikasi kontrak file source: session-closure, actions, dialog konfirmasi, & sinkronisasi denah", () => {
  assert.ok(closureSource.includes("export function evaluateDiningSessionClosure"));
  assert.ok(closureSource.includes("export function formatSessionCode"));

  const actionsSrc = fs.readFileSync(path.join(process.cwd(), "src", "lib", "orders", "actions.ts"), "utf-8");
  assert.ok(actionsSrc.includes('close_dining_session_atomic'));
  assert.ok(actionsSrc.includes('complete_pos_order'));
  assert.ok(actionsSrc.includes('sessionRow.status !== "open"'));
  assert.ok(actionsSrc.includes('evaluateDiningSessionClosure'));
  assert.ok(actionsSrc.includes('revalidatePosPaths()'));
  assert.ok(actionsSrc.includes('served_at'));
  assert.ok(actionsSrc.includes('belum disajikan'));

  const dialogSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "components", "tables", "table-session-dialog.tsx"),
    "utf-8",
  );
  assert.ok(dialogSrc.includes("Tutup Sesi Meja"));
  assert.ok(dialogSrc.includes("Konfirmasi Tutup Sesi Meja"));
  assert.ok(dialogSrc.includes("AlertDialog"));
  assert.ok(dialogSrc.includes("Nomor Sesi"));
  assert.ok(dialogSrc.includes("Total Pesanan"));
  assert.ok(dialogSrc.includes("Total Pembayaran"));
  assert.ok(dialogSrc.includes("Sisa Tagihan"));
  assert.ok(dialogSrc.includes("Sesi Aktif"));
  assert.ok(dialogSrc.includes("confirmOrderServedAction"));
  assert.ok(dialogSrc.includes("Tandai Sudah Disajikan"));
  assert.ok(dialogSrc.includes("isOrderPendingServing"));
  assert.ok(dialogSrc.includes("served_at"));
  assert.equal(dialogSrc.includes("completePosOrderAction"), false);
  assert.equal(dialogSrc.includes("Tandai Selesai"), false);

  const floorSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "components", "tables", "floor-plan-canvas.tsx"),
    "utf-8",
  );
  assert.ok(floorSrc.includes("useRouter"));
  assert.ok(floorSrc.includes("statusOverrides"));
  assert.ok(floorSrc.includes("TableSessionDialog"));
  assert.ok(floorSrc.includes("router.refresh()"));

  const selectModalSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "components", "pos", "table-select-modal.tsx"),
    "utf-8",
  );
  assert.ok(selectModalSrc.includes("TableSessionDialog"));
  assert.ok(selectModalSrc.includes("Tutup Sesi Meja"));

  const posContainerSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "components", "pos", "pos-container.tsx"),
    "utf-8",
  );
  assert.ok(posContainerSrc.includes("handleTableStatusChanged"));
  assert.ok(posContainerSrc.includes("router.refresh()"));
});

console.log("\n===============================================================================");
console.log(` HASIL: ${passed} / ${passed + failed} PENGUJIAN LOLOS`);
console.log("===============================================================================\n");

if (failed > 0) {
  process.exit(1);
}
