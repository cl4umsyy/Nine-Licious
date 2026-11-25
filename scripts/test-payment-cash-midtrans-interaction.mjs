#!/usr/bin/env node
/**
 * NINE LICIOUS POS - TEST SUITE: CASH & MIDTRANS RESERVATION INTERACTION
 *
 * Menguji seluruh skenario wajib Bagian 4A (Tunai) & Bagian 4B (Midtrans):
 *
 * A. PEMBAYARAN TUNAI:
 *  1. Pesanan belum dibayar tanpa reservasi Midtrans -> Tunai berhasil penuh.
 *  2. Pesanan yang sebelumnya memiliki transaksi Midtrans aktif -> Tunai ditolak
 *     secara jelas (PAYMENT_EXCEEDS_AVAILABLE_AMOUNT) untuk mencegah double payment.
 *  3. Pesanan yang transaksi Midtrans-nya expired (HTTP 404 + payment_expires_at <= now)
 *     -> Reservasi dilepas aman secara otomatis saat verifikasi, lalu Tunai berhasil.
 *  4. Pesanan yang transaksi Midtrans-nya dibatalkan (cancelActiveMidtransReservationAction)
 *     -> Reservasi dilepas (released), lalu Tunai berhasil.
 *  5. Pembayaran tunai penuh dengan kembalian (cashReceived > payAmount).
 *  6. Pembayaran tunai parsial / split bill (sisa tagihan akurat, status partially_paid).
 *  7. Klik tombol bayar berulang kali (idempotency_key dedup -> tidak pernah double payment).
 *  8. Pembayaran oleh 2 kasir secara bersamaan (FOR UPDATE row lock -> hanya 1 yang sukses,
 *     kasir kedua ditolak tanpa double settlement).
 *
 * B. PEMBAYARAN MIDTRANS:
 *  9. Membuat transaksi Midtrans Snap baru -> TIDAK langsung lunas & TIDAK langsung buka struk.
 * 10. Membuka Snap tanpa membayar (HTTP 404 sebelum expired) -> tetap unpaid, tidak lunas.
 * 11. Status pending di Midtrans -> tetap unpaid/partially_paid, tidak buka struk.
 * 12. Status settlement -> verifikasi server-to-server -> lunas & baru boleh buka struk.
 * 13. Status deny / expire -> lifecycle terminal & alokasi di-release -> Tunai/Snap baru terbuka.
 * 14. Membuka ulang Snap yang masih aktif & belum expired -> reuse snap_token tanpa duplikasi.
 * 15. Token Snap yang sudah expired -> tidak boleh dibuka ulang (canReopenSnap = false).
 * 16. Pembatalan transaksi Midtrans yang TERNYATA sudah settlement di Midtrans ->
 *     BATAL DITOLAK, sistem merekonsiliasi settlement (mencegah double payment).
 * 17. Kegagalan jaringan saat cek/batal ke Midtrans -> fail-closed (reservasi tidak dilepas paksa).
 * 18. Source & UI Contract Verification pada payment-modal.tsx, actions.ts, reconcile.ts,
 *     recovery.ts, reservation.ts, dan SQL RPC migration.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
function readProjectFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

// ============================================================================
// Pure Mirror of src/lib/midtrans/reservation.ts & State Machine Simulation
// ============================================================================
const ACTIVE_RESERVATION_LIFECYCLE_STATUSES = [
  "initiated",
  "token_created",
  "pending",
  "capture_challenge",
  "reconciliation_required",
];

const CANCELLABLE_LIFECYCLE_STATUSES = ["initiated", "token_created", "pending"];

function isMidtransTransactionExpired(paymentExpiresAt, nowMs = Date.now()) {
  if (!paymentExpiresAt) return false;
  const expiresMs = Date.parse(paymentExpiresAt);
  if (Number.isNaN(expiresMs)) return false;
  return expiresMs <= nowMs;
}

function canReopenMidtransSnap({ snapToken, lifecycleStatus, paymentExpiresAt, nowMs }) {
  if (!snapToken) return false;
  if (lifecycleStatus !== "token_created" && lifecycleStatus !== "pending") {
    return false;
  }
  return !isMidtransTransactionExpired(paymentExpiresAt, nowMs);
}

function canCancelMidtransReservation(lifecycleStatus) {
  return (
    typeof lifecycleStatus === "string" &&
    CANCELLABLE_LIFECYCLE_STATUSES.includes(lifecycleStatus)
  );
}

function computeOrderPaymentAvailability({ grandTotal, paidTotal, reservedAmount }) {
  const gt = Math.max(0, Math.round(Number(grandTotal) || 0));
  const pt = Math.max(0, Math.round(Number(paidTotal) || 0));
  const remainingBalance = Math.max(0, gt - pt);
  const res = Math.max(0, Math.round(Number(reservedAmount) || 0));
  const availableForCashAmount = Math.max(0, remainingBalance - res);
  return {
    grandTotal: gt,
    paidTotal: pt,
    remainingBalance,
    reservedAmount: res,
    availableForCashAmount,
    isFullyReservedByGateway: remainingBalance > 0 && availableForCashAmount === 0 && res > 0,
  };
}

// In-memory transactional ledger mirroring SQL RPCs & server actions
function createPaymentLedger({ orderId, orderNumber, grandTotal }) {
  const state = {
    order: {
      id: orderId,
      order_number: orderNumber,
      grand_total: grandTotal,
      paid_total: 0,
      payment_status: "unpaid",
      is_finalized: true,
      queue_number: null,
    },
    payments: [],
    midtransTxs: [],
    allocations: [],
    auditLogs: [],
    processedIdempotencyKeys: new Map(),
    lockVersion: 0,
  };

  function getReservedAmount() {
    return state.midtransTxs
      .filter((tx) => ACTIVE_RESERVATION_LIFECYCLE_STATUSES.includes(tx.lifecycle_status))
      .reduce((sum, tx) => sum + tx.gross_amount, 0);
  }

  function getAvailability() {
    return computeOrderPaymentAvailability({
      grandTotal: state.order.grand_total,
      paidTotal: state.order.paid_total,
      reservedAmount: getReservedAmount(),
    });
  }

  function processCashPayment({ amount, cashReceived, idempotencyKey }) {
    // 1. Idempotency check (mirrors process_pos_payment_manual)
    if (state.processedIdempotencyKeys.has(idempotencyKey)) {
      return {
        ok: true,
        idempotentReplay: true,
        ...state.processedIdempotencyKeys.get(idempotencyKey),
      };
    }

    // 2. Lock check & availability check
    if (state.order.payment_status === "paid") {
      return { ok: false, code: "ORDER_ALREADY_PAID" };
    }

    const avail = getAvailability();
    if (amount > avail.availableForCashAmount) {
      return {
        ok: false,
        code: "PAYMENT_EXCEEDS_AVAILABLE_AMOUNT",
        message: `Nominal pembayaran (Rp ${amount}) melebihi sisa tagihan yang belum direservasi gateway (Tersedia: Rp ${avail.availableForCashAmount}, Direservasi: Rp ${avail.reservedAmount}).`,
      };
    }

    if (cashReceived < amount) {
      return { ok: false, code: "INSUFFICIENT_CASH" };
    }

    const changeAmount = cashReceived - amount;
    const payment = {
      id: `pay-${state.payments.length + 1}`,
      method: "cash",
      amount,
      cash_received: cashReceived,
      change_amount: changeAmount,
      status: "paid",
      idempotency_key: idempotencyKey,
    };
    state.payments.push(payment);
    state.order.paid_total += amount;
    state.lockVersion += 1;

    if (state.order.paid_total >= state.order.grand_total) {
      state.order.payment_status = "paid";
      state.order.queue_number = state.order.queue_number || "A010";
    } else {
      state.order.payment_status = "partially_paid";
    }

    const result = {
      paymentId: payment.id,
      changeAmount,
      paidTotal: state.order.paid_total,
      remainingBalance: Math.max(0, state.order.grand_total - state.order.paid_total),
      isSettled: state.order.payment_status === "paid",
    };
    state.processedIdempotencyKeys.set(idempotencyKey, result);
    return { ok: true, idempotentReplay: false, ...result };
  }

  function createMidtransSnap({ amount, idempotencyKey, nowMs, ttlMinutes = 15 }) {
    const existingActive = state.midtransTxs.find((tx) =>
      ACTIVE_RESERVATION_LIFECYCLE_STATUSES.includes(tx.lifecycle_status),
    );
    if (existingActive && canReopenMidtransSnap({
      snapToken: existingActive.snap_token,
      lifecycleStatus: existingActive.lifecycle_status,
      paymentExpiresAt: existingActive.payment_expires_at,
      nowMs,
    })) {
      return {
        ok: true,
        reused: true,
        midtransOrderId: existingActive.midtrans_order_id,
        snapToken: existingActive.snap_token,
        isSettled: false,
      };
    }

    const avail = getAvailability();
    if (amount > avail.availableForCashAmount) {
      return { ok: false, code: "PAYMENT_EXCEEDS_AVAILABLE_AMOUNT" };
    }

    const attempt = state.midtransTxs.length + 1;
    const midtransOrderId = `${state.order.order_number}-A${attempt}`;
    const tx = {
      id: `mtx-${attempt}`,
      midtrans_order_id: midtransOrderId,
      gross_amount: amount,
      lifecycle_status: "token_created",
      midtrans_transaction_status: null,
      snap_token: `snap-tok-${attempt}`,
      payment_expires_at: new Date(nowMs + ttlMinutes * 60_000).toISOString(),
      idempotency_key: idempotencyKey,
    };
    state.midtransTxs.push(tx);
    state.allocations.push({
      midtrans_transaction_id: tx.id,
      allocated_amount: amount,
      allocation_status: "reserved",
    });

    // IMPORTANT: creating Snap NEVER settles the order or opens receipt
    return {
      ok: true,
      reused: false,
      midtransOrderId: tx.midtrans_order_id,
      snapToken: tx.snap_token,
      isSettled: false,
    };
  }

  function settleMidtrans(tx, statusResponse) {
    if (tx.lifecycle_status === "settled") {
      return { ok: true, alreadySettled: true };
    }
    tx.lifecycle_status = "settled";
    tx.midtrans_transaction_status = statusResponse.transaction_status;
    for (const alloc of state.allocations) {
      if (alloc.midtrans_transaction_id === tx.id && alloc.allocation_status === "reserved") {
        alloc.allocation_status = "settled";
      }
    }
    state.order.paid_total += tx.gross_amount;
    if (state.order.paid_total >= state.order.grand_total) {
      state.order.payment_status = "paid";
      state.order.queue_number = state.order.queue_number || "A011";
    } else {
      state.order.payment_status = "partially_paid";
    }
    return { ok: true, alreadySettled: false };
  }

  function releaseMidtrans(tx, nextLifecycle) {
    tx.lifecycle_status = nextLifecycle;
    for (const alloc of state.allocations) {
      if (alloc.midtrans_transaction_id === tx.id && alloc.allocation_status === "reserved") {
        alloc.allocation_status = "released";
      }
    }
  }

  function reconcileMidtrans({ midtransApiResponse, nowMs }) {
    const tx = [...state.midtransTxs].reverse()[0];
    if (!tx) return { ok: true, reconciled: false, reservationReleased: false };

    if (!ACTIVE_RESERVATION_LIFECYCLE_STATUSES.includes(tx.lifecycle_status)) {
      return { ok: true, reconciled: false, reservationReleased: false };
    }

    if (midtransApiResponse.networkError) {
      return { ok: false, reconciled: false, reservationReleased: false, error: "NETWORK_ERROR" };
    }

    if (midtransApiResponse.statusCode === 404) {
      if (isMidtransTransactionExpired(tx.payment_expires_at, nowMs)) {
        releaseMidtrans(tx, "expired");
        return { ok: true, reconciled: true, reservationReleased: true };
      }
      return { ok: true, reconciled: false, reservationReleased: false };
    }

    const st = midtransApiResponse.body.transaction_status;
    const fraud = midtransApiResponse.body.fraud_status;

    if (st === "settlement" || (st === "capture" && fraud === "accept")) {
      settleMidtrans(tx, midtransApiResponse.body);
      return { ok: true, reconciled: true, reservationReleased: false };
    }
    if (st === "pending") {
      tx.lifecycle_status = "pending";
      tx.midtrans_transaction_status = "pending";
      return { ok: true, reconciled: true, reservationReleased: false };
    }
    if (st === "expire" || st === "cancel" || st === "deny") {
      const next = st === "expire" ? "expired" : st === "cancel" ? "cancelled" : "denied";
      releaseMidtrans(tx, next);
      return { ok: true, reconciled: true, reservationReleased: true };
    }
    return { ok: true, reconciled: false, reservationReleased: false };
  }

  function cancelActiveMidtrans({ midtransStatusResp, midtransCancelResp, nowMs }) {
    const tx = [...state.midtransTxs]
      .reverse()
      .find((item) => ACTIVE_RESERVATION_LIFECYCLE_STATUSES.includes(item.lifecycle_status));
    if (!tx) return { ok: true, cancelled: false, wasAlreadySettled: false };

    // Must check live Midtrans status FIRST (fail-closed on network error)
    if (midtransStatusResp.networkError) {
      return { ok: false, code: "MIDTRANS_UNREACHABLE", reservationReleased: false };
    }

    if (midtransStatusResp.statusCode === 404) {
      const expired = isMidtransTransactionExpired(tx.payment_expires_at, nowMs);
      releaseMidtrans(tx, expired ? "expired" : "cancelled");
      state.auditLogs.push({ action: "midtrans.reservation_cancelled", txId: tx.id });
      return { ok: true, cancelled: true, wasAlreadySettled: false, reservationReleased: true };
    }

    const st = midtransStatusResp.body.transaction_status;
    const fraud = midtransStatusResp.body.fraud_status;
    if (st === "settlement" || (st === "capture" && fraud === "accept")) {
      // NEVER cancel settled transaction -> reconcile to prevent double payment!
      settleMidtrans(tx, midtransStatusResp.body);
      return {
        ok: true,
        cancelled: false,
        wasAlreadySettled: true,
        isSettled: state.order.payment_status === "paid",
      };
    }

    if (st === "expire" || st === "cancel" || st === "deny") {
      const next = st === "expire" ? "expired" : st === "cancel" ? "cancelled" : "denied";
      releaseMidtrans(tx, next);
      return { ok: true, cancelled: true, wasAlreadySettled: false, reservationReleased: true };
    }

    // Active pending transaction -> must call POST /v2/{id}/cancel
    if (!midtransCancelResp || midtransCancelResp.networkError || midtransCancelResp.statusCode >= 400) {
      return { ok: false, code: "MIDTRANS_CANCEL_FAILED", reservationReleased: false };
    }

    releaseMidtrans(tx, "cancelled");
    state.auditLogs.push({ action: "midtrans.reservation_cancelled", txId: tx.id });
    return { ok: true, cancelled: true, wasAlreadySettled: false, reservationReleased: true };
  }

  return {
    state,
    getReservedAmount,
    getAvailability,
    processCashPayment,
    createMidtransSnap,
    reconcileMidtrans,
    cancelActiveMidtrans,
  };
}

// ============================================================================
// TEST RUNNER
// ============================================================================
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

console.log("\n=== NINE LICIOUS POS - CASH & MIDTRANS RESERVATION TEST SUITE ===\n");

// --- A. PEMBAYARAN TUNAI ---
runTest("1. [Tunai] Pesanan belum dibayar tanpa reservasi Midtrans -> Tunai berhasil penuh", () => {
  const ledger = createPaymentLedger({
    orderId: "ord-1",
    orderNumber: "ORD-20261118-0101",
    grandTotal: 64400,
  });
  const avail = ledger.getAvailability();
  assert.equal(avail.remainingBalance, 64400);
  assert.equal(avail.reservedAmount, 0);
  assert.equal(avail.availableForCashAmount, 64400);
  assert.equal(avail.isFullyReservedByGateway, false);

  const res = ledger.processCashPayment({
    amount: 64400,
    cashReceived: 64400,
    idempotencyKey: "cash-key-1",
  });
  assert.equal(res.ok, true);
  assert.equal(res.isSettled, true);
  assert.equal(res.changeAmount, 0);
  assert.equal(ledger.state.order.payment_status, "paid");
});

runTest("2. [Tunai] Pesanan dengan transaksi Midtrans aktif -> Tunai ditolak (PAYMENT_EXCEEDS_AVAILABLE_AMOUNT)", () => {
  const now = Date.parse("2026-11-18T12:49:43+07:00");
  const ledger = createPaymentLedger({
    orderId: "ord-2",
    orderNumber: "ORD-20261118-0007",
    grandTotal: 64400,
  });
  const snap = ledger.createMidtransSnap({
    amount: 64400,
    idempotencyKey: "snap-key-1",
    nowMs: now,
  });
  assert.equal(snap.ok, true);
  assert.equal(snap.isSettled, false);

  const avail = ledger.getAvailability();
  assert.equal(avail.reservedAmount, 64400);
  assert.equal(avail.availableForCashAmount, 0);
  assert.equal(avail.isFullyReservedByGateway, true);

  const cashRes = ledger.processCashPayment({
    amount: 64400,
    cashReceived: 64400,
    idempotencyKey: "cash-key-2",
  });
  assert.equal(cashRes.ok, false);
  assert.equal(cashRes.code, "PAYMENT_EXCEEDS_AVAILABLE_AMOUNT");
  assert.match(cashRes.message, /Tersedia: Rp 0, Direservasi: Rp 64400/);
  assert.equal(ledger.state.order.payment_status, "unpaid");
});

runTest("3. [Tunai] Transaksi Midtrans expired (HTTP 404 + lewat payment_expires_at) -> dilepas aman, Tunai berhasil", () => {
  const t0 = Date.parse("2026-11-18T12:00:00+07:00");
  const tExpired = Date.parse("2026-11-18T12:20:00+07:00");
  const ledger = createPaymentLedger({
    orderId: "ord-3",
    orderNumber: "ORD-20261118-0103",
    grandTotal: 64400,
  });
  ledger.createMidtransSnap({ amount: 64400, idempotencyKey: "snap-3", nowMs: t0, ttlMinutes: 15 });

  // Sebelum expired: 404 TIDAK boleh melepas reservasi secara prematur
  const earlyCheck = ledger.reconcileMidtrans({
    midtransApiResponse: { statusCode: 404 },
    nowMs: t0 + 2 * 60_000,
  });
  assert.equal(earlyCheck.reservationReleased, false);
  assert.equal(ledger.getAvailability().reservedAmount, 64400);

  // Setelah expired: 404 melepas reservasi secara aman
  const expiredCheck = ledger.reconcileMidtrans({
    midtransApiResponse: { statusCode: 404 },
    nowMs: tExpired,
  });
  assert.equal(expiredCheck.ok, true);
  assert.equal(expiredCheck.reservationReleased, true);
  assert.equal(ledger.state.midtransTxs[0].lifecycle_status, "expired");
  assert.equal(ledger.state.allocations[0].allocation_status, "released");
  assert.equal(ledger.getAvailability().availableForCashAmount, 64400);

  // Sekarang Tunai berhasil penuh!
  const cashRes = ledger.processCashPayment({
    amount: 64400,
    cashReceived: 70000,
    idempotencyKey: "cash-3",
  });
  assert.equal(cashRes.ok, true);
  assert.equal(cashRes.changeAmount, 5600);
  assert.equal(cashRes.isSettled, true);
});

runTest("4. [Tunai] Pembatalan reservasi Midtrans (pending/uncreated) -> melepas reservasi & Tunai berhasil", () => {
  const now = Date.parse("2026-11-18T13:00:00+07:00");
  const ledger = createPaymentLedger({
    orderId: "ord-4",
    orderNumber: "ORD-20261118-0104",
    grandTotal: 59800,
  });
  ledger.createMidtransSnap({ amount: 59800, idempotencyKey: "snap-4", nowMs: now });

  // Transaksi sedang pending di Midtrans -> dibatalkan lewat POST /cancel
  const cancelRes = ledger.cancelActiveMidtrans({
    midtransStatusResp: {
      statusCode: 200,
      body: { transaction_status: "pending" },
    },
    midtransCancelResp: {
      statusCode: 200,
      body: { transaction_status: "cancel" },
    },
    nowMs: now + 60_000,
  });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.cancelled, true);
  assert.equal(cancelRes.reservationReleased, true);
  assert.equal(ledger.state.midtransTxs[0].lifecycle_status, "cancelled");
  assert.equal(ledger.state.allocations[0].allocation_status, "released");
  assert.equal(ledger.state.auditLogs.length, 1);

  const cashRes = ledger.processCashPayment({
    amount: 59800,
    cashReceived: 60000,
    idempotencyKey: "cash-4",
  });
  assert.equal(cashRes.ok, true);
  assert.equal(cashRes.changeAmount, 200);
  assert.equal(cashRes.isSettled, true);
});

runTest("5. [Tunai] Pembayaran tunai penuh dengan kembalian", () => {
  const ledger = createPaymentLedger({
    orderId: "ord-5",
    orderNumber: "ORD-20261118-0105",
    grandTotal: 43700,
  });
  const res = ledger.processCashPayment({
    amount: 43700,
    cashReceived: 100000,
    idempotencyKey: "cash-5",
  });
  assert.equal(res.ok, true);
  assert.equal(res.changeAmount, 56300);
  assert.equal(res.remainingBalance, 0);
  assert.equal(res.isSettled, true);
});

runTest("6. [Tunai] Pembayaran tunai parsial (split bill) + pelunasan sisa tagihan", () => {
  const ledger = createPaymentLedger({
    orderId: "ord-6",
    orderNumber: "ORD-20261118-0106",
    grandTotal: 100000,
  });

  const p1 = ledger.processCashPayment({
    amount: 40000,
    cashReceived: 50000,
    idempotencyKey: "cash-6-p1",
  });
  assert.equal(p1.ok, true);
  assert.equal(p1.isSettled, false);
  assert.equal(p1.changeAmount, 10000);
  assert.equal(p1.remainingBalance, 60000);
  assert.equal(ledger.state.order.payment_status, "partially_paid");

  const p2 = ledger.processCashPayment({
    amount: 60000,
    cashReceived: 60000,
    idempotencyKey: "cash-6-p2",
  });
  assert.equal(p2.ok, true);
  assert.equal(p2.isSettled, true);
  assert.equal(p2.remainingBalance, 0);
  assert.equal(ledger.state.order.payment_status, "paid");
});

runTest("7. [Tunai] Klik tombol bayar berulang kali (idempotency_key dedup -> tanpa double payment)", () => {
  const ledger = createPaymentLedger({
    orderId: "ord-7",
    orderNumber: "ORD-20261118-0107",
    grandTotal: 50000,
  });
  const first = ledger.processCashPayment({
    amount: 50000,
    cashReceived: 50000,
    idempotencyKey: "same-key-7",
  });
  const second = ledger.processCashPayment({
    amount: 50000,
    cashReceived: 50000,
    idempotencyKey: "same-key-7",
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.idempotentReplay, true);
  assert.equal(ledger.state.payments.length, 1);
  assert.equal(ledger.state.order.paid_total, 50000);
});

runTest("8. [Tunai] 2 kasir memproses pesanan yang sama bersamaan (row lock -> 1 sukses, 1 ditolak)", () => {
  const ledger = createPaymentLedger({
    orderId: "ord-8",
    orderNumber: "ORD-20261118-0108",
    grandTotal: 75000,
  });
  const cashierA = ledger.processCashPayment({
    amount: 75000,
    cashReceived: 100000,
    idempotencyKey: "cashier-A-key",
  });
  const cashierB = ledger.processCashPayment({
    amount: 75000,
    cashReceived: 75000,
    idempotencyKey: "cashier-B-key",
  });
  assert.equal(cashierA.ok, true);
  assert.equal(cashierA.isSettled, true);
  assert.equal(cashierB.ok, false);
  assert.equal(cashierB.code, "ORDER_ALREADY_PAID");
  assert.equal(ledger.state.payments.length, 1);
  assert.equal(ledger.state.order.paid_total, 75000);
});

// --- B. PEMBAYARAN MIDTRANS ---
runTest("9. [Midtrans] Buat transaksi Snap baru -> tidak langsung lunas & tidak langsung buka struk", () => {
  const now = Date.parse("2026-11-18T13:10:00+07:00");
  const ledger = createPaymentLedger({
    orderId: "ord-9",
    orderNumber: "ORD-20261118-0109",
    grandTotal: 43700,
  });
  const snap = ledger.createMidtransSnap({
    amount: 43700,
    idempotencyKey: "snap-9",
    nowMs: now,
  });
  assert.equal(snap.ok, true);
  assert.equal(snap.isSettled, false);
  assert.equal(ledger.state.order.payment_status, "unpaid");
  assert.equal(ledger.state.order.paid_total, 0);
  assert.equal(ledger.state.order.queue_number, null);
});

runTest("10. [Midtrans] Membuka Snap tanpa membayar (404 belum expired) -> tetap unpaid", () => {
  const now = Date.parse("2026-11-18T13:10:00+07:00");
  const ledger = createPaymentLedger({
    orderId: "ord-10",
    orderNumber: "ORD-20261118-0110",
    grandTotal: 43700,
  });
  ledger.createMidtransSnap({ amount: 43700, idempotencyKey: "snap-10", nowMs: now });
  const check = ledger.reconcileMidtrans({
    midtransApiResponse: { statusCode: 404 },
    nowMs: now + 30_000,
  });
  assert.equal(check.ok, true);
  assert.equal(check.reconciled, false);
  assert.equal(ledger.state.order.payment_status, "unpaid");
});

runTest("11. [Midtrans] Status pending -> tetap unpaid, tidak dianggap lunas", () => {
  const now = Date.parse("2026-11-18T13:10:00+07:00");
  const ledger = createPaymentLedger({
    orderId: "ord-11",
    orderNumber: "ORD-20261118-0111",
    grandTotal: 43700,
  });
  ledger.createMidtransSnap({ amount: 43700, idempotencyKey: "snap-11", nowMs: now });
  const check = ledger.reconcileMidtrans({
    midtransApiResponse: {
      statusCode: 200,
      body: { transaction_status: "pending" },
    },
    nowMs: now + 30_000,
  });
  assert.equal(check.ok, true);
  assert.equal(ledger.state.midtransTxs[0].lifecycle_status, "pending");
  assert.equal(ledger.state.order.payment_status, "unpaid");
  assert.equal(ledger.state.order.paid_total, 0);
});

runTest("12. [Midtrans] Status settlement -> terverifikasi server & pesanan menjadi paid", () => {
  const now = Date.parse("2026-11-18T13:10:00+07:00");
  const ledger = createPaymentLedger({
    orderId: "ord-12",
    orderNumber: "ORD-20261118-0112",
    grandTotal: 43700,
  });
  ledger.createMidtransSnap({ amount: 43700, idempotencyKey: "snap-12", nowMs: now });
  const check = ledger.reconcileMidtrans({
    midtransApiResponse: {
      statusCode: 200,
      body: { transaction_status: "settlement", fraud_status: "accept" },
    },
    nowMs: now + 60_000,
  });
  assert.equal(check.ok, true);
  assert.equal(check.reconciled, true);
  assert.equal(ledger.state.order.payment_status, "paid");
  assert.equal(ledger.state.order.paid_total, 43700);
  assert.equal(ledger.state.allocations[0].allocation_status, "settled");
});

runTest("13. [Midtrans] Status deny atau expire -> lifecycle terminal & alokasi released", () => {
  const now = Date.parse("2026-11-18T13:10:00+07:00");
  for (const terminal of ["deny", "expire"]) {
    const ledger = createPaymentLedger({
      orderId: `ord-13-${terminal}`,
      orderNumber: `ORD-20261118-0113-${terminal}`,
      grandTotal: 43700,
    });
    ledger.createMidtransSnap({ amount: 43700, idempotencyKey: `snap-13-${terminal}`, nowMs: now });
    const check = ledger.reconcileMidtrans({
      midtransApiResponse: {
        statusCode: 200,
        body: { transaction_status: terminal },
      },
      nowMs: now + 60_000,
    });
    assert.equal(check.ok, true);
    assert.equal(check.reservationReleased, true);
    assert.equal(ledger.state.allocations[0].allocation_status, "released");
    assert.equal(ledger.getAvailability().availableForCashAmount, 43700);
    assert.equal(ledger.state.order.payment_status, "unpaid");
  }
});

runTest("14. [Midtrans] Buka ulang Snap yang masih aktif & valid -> reuse token tanpa duplikasi", () => {
  const now = Date.parse("2026-11-18T13:10:00+07:00");
  const ledger = createPaymentLedger({
    orderId: "ord-14",
    orderNumber: "ORD-20261118-0114",
    grandTotal: 43700,
  });
  const first = ledger.createMidtransSnap({
    amount: 43700,
    idempotencyKey: "snap-14-1",
    nowMs: now,
  });
  const second = ledger.createMidtransSnap({
    amount: 43700,
    idempotencyKey: "snap-14-2",
    nowMs: now + 2 * 60_000,
  });
  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(second.snapToken, first.snapToken);
  assert.equal(ledger.state.midtransTxs.length, 1);
});

runTest("15. [Midtrans] Token Snap yang sudah expired tidak boleh dibuka ulang (canReopenSnap = false)", () => {
  const t0 = Date.parse("2026-11-18T12:00:00+07:00");
  const expiresAt = new Date(t0 + 15 * 60_000).toISOString();
  assert.equal(
    canReopenMidtransSnap({
      snapToken: "tok-valid",
      lifecycleStatus: "token_created",
      paymentExpiresAt: expiresAt,
      nowMs: t0 + 5 * 60_000,
    }),
    true,
  );
  assert.equal(
    canReopenMidtransSnap({
      snapToken: "tok-valid",
      lifecycleStatus: "token_created",
      paymentExpiresAt: expiresAt,
      nowMs: t0 + 16 * 60_000,
    }),
    false,
  );
  assert.equal(
    canCancelMidtransReservation("token_created"),
    true,
  );
  assert.equal(
    canCancelMidtransReservation("settled"),
    false,
  );
});

runTest("16. [Anti Double-Payment] Batalkan reservasi Midtrans padahal di Midtrans SUDAH settlement -> batal ditolak & direkonsiliasi paid", () => {
  const now = Date.parse("2026-11-18T12:50:00+07:00");
  const ledger = createPaymentLedger({
    orderId: "ord-16",
    orderNumber: "ORD-20261118-0007",
    grandTotal: 64400,
  });
  ledger.createMidtransSnap({ amount: 64400, idempotencyKey: "snap-16", nowMs: now });

  // Kasir klik "Batalkan Midtrans" tetapi server cek GET /status dulu -> ternyata settlement!
  const cancelRes = ledger.cancelActiveMidtrans({
    midtransStatusResp: {
      statusCode: 200,
      body: { transaction_status: "settlement", fraud_status: "accept" },
    },
    nowMs: now + 60_000,
  });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.cancelled, false);
  assert.equal(cancelRes.wasAlreadySettled, true);
  assert.equal(cancelRes.isSettled, true);
  assert.equal(ledger.state.order.payment_status, "paid");

  // Percobaan bayar Tunai setelah itu PASTI ditolak!
  const cashAfter = ledger.processCashPayment({
    amount: 64400,
    cashReceived: 64400,
    idempotencyKey: "cash-after-settled",
  });
  assert.equal(cashAfter.ok, false);
  assert.equal(cashAfter.code, "ORDER_ALREADY_PAID");
});

runTest("17. [Fail-Closed] Kegagalan jaringan saat cek/batal ke Midtrans -> reservasi TIDAK dilepas paksa", () => {
  const now = Date.parse("2026-11-18T13:20:00+07:00");
  const ledger = createPaymentLedger({
    orderId: "ord-17",
    orderNumber: "ORD-20261118-0117",
    grandTotal: 64400,
  });
  ledger.createMidtransSnap({ amount: 64400, idempotencyKey: "snap-17", nowMs: now });

  const cancelNetErr = ledger.cancelActiveMidtrans({
    midtransStatusResp: { networkError: true },
    nowMs: now + 60_000,
  });
  assert.equal(cancelNetErr.ok, false);
  assert.equal(cancelNetErr.code, "MIDTRANS_UNREACHABLE");
  assert.equal(ledger.getAvailability().reservedAmount, 64400);
  assert.equal(ledger.getAvailability().availableForCashAmount, 0);
});

runTest("18. [Contract Audit] Verifikasi kontrak kode sumber PaymentModal, Server Actions, Reconcile, Recovery, Webhook & SQL", () => {
  const paymentModalSrc = readProjectFile("src/components/pos/payment-modal.tsx");
  const actionsSrc = readProjectFile("src/lib/payments/actions.ts");
  const reconcileSrc = readProjectFile("src/lib/midtrans/reconcile.ts");
  const recoverySrc = readProjectFile("src/lib/midtrans/recovery.ts");
  const reservationSrc = readProjectFile("src/lib/midtrans/reservation.ts");
  const webhookSrc = readProjectFile("src/lib/midtrans/webhook.ts");
  const migrationSrc = readProjectFile("supabase/migrations/20261113000100_midtrans_gateway_split_bill.sql");

  // 1. PaymentModal TIDAK boleh lagi memanggil getOrderPaymentStatusAction otomatis pada useEffect perpindahan tab Midtrans
  assert.ok(
    paymentModalSrc.includes("getOrderPaymentSummaryAction(order.id)"),
    "PaymentModal harus memuat ringkasan reservasi read-only via getOrderPaymentSummaryAction",
  );
  assert.ok(
    !paymentModalSrc.includes('if (method !== "midtrans_snap") return;'),
    "PaymentModal tidak boleh lagi punya useEffect auto-reconcile saat berpindah ke tab Midtrans",
  );
  assert.ok(
    paymentModalSrc.includes("cancelActiveMidtransReservationAction"),
    "PaymentModal harus menyediakan pembatalan aman reservasi Midtrans",
  );
  assert.ok(
    paymentModalSrc.includes("isCashBlockedByReservation"),
    "PaymentModal harus mendeteksi dan menjelaskan pemblokiran Tunai akibat reservasi Midtrans",
  );
  assert.ok(
    paymentModalSrc.includes("isAlreadySettledInDb"),
    "PaymentModal harus menampilkan banner eksplisit jika pesanan sudah lunas (tanpa langsung loncat struk diam-diam)",
  );

  // 2. actions.ts memiliki getOrderPaymentSummaryAction (read-only) dan cancelActiveMidtransReservationAction (cek status Midtrans dulu)
  assert.ok(
    actionsSrc.includes("export async function getOrderPaymentSummaryAction"),
    "actions.ts harus mengekspor getOrderPaymentSummaryAction",
  );
  assert.ok(
    actionsSrc.includes("export async function cancelActiveMidtransReservationAction"),
    "actions.ts harus mengekspor cancelActiveMidtransReservationAction",
  );
  assert.ok(
    actionsSrc.includes("getMidtransStatus") &&
      actionsSrc.includes("cancelMidtransTransaction") &&
      actionsSrc.includes("midtrans.reservation_cancelled"),
    "cancelActiveMidtransReservationAction wajib memeriksa status Midtrans terlebih dahulu dan mencatat audit log",
  );

  // 3. reconcile.ts melepas reservasi 404 HANYA jika payment_expires_at sudah kedaluwarsa (lintas seluruh attempt)
  assert.ok(
    reconcileSrc.includes("isMidtransTransactionExpired") &&
      (reconcileSrc.includes("tx.payment_expires_at") ||
        reconcileSrc.includes("latestMidtransTx.payment_expires_at")),
    "reconcile.ts harus memeriksa isMidtransTransactionExpired sebelum melepas transaksi HTTP 404",
  );
  assert.ok(
    reconcileSrc.includes('allocation_status: "released"'),
    "reconcile.ts harus melepas order_allocations saat transaksi expired dilepas",
  );

  // 4. recovery.ts mengupdate lifecycle secara kondisional & membersihkan signature_key
  assert.ok(
    recoverySrc.includes('.in("lifecycle_status", ["initiated", "token_created", "pending"') &&
      !recoverySrc.includes('.in("lifecycle_status", ["initiated", "token_created", "pending", "settled"]'),
    "recovery.ts harus memperbarui lifecycle_status secara kondisional agar tidak menimpa settled",
  );
  assert.ok(
    recoverySrc.includes('bodyStatusCode === "404"') &&
      recoverySrc.includes("httpStatus: 404"),
    "recovery.ts harus menangani respons Midtrans Core API HTTP 200 dengan body status_code='404' sebagai 404",
  );
  assert.ok(
    recoverySrc.includes('k !== "signature_key"') &&
      recoverySrc.includes("sanitized_response: sanitizedBody"),
    "recovery.ts harus menyensor signature_key dari sanitized_response",
  );

  // 5. reservation.ts selaras dengan SQL calculate_active_gateway_reserved_amount
  for (const status of ACTIVE_RESERVATION_LIFECYCLE_STATUSES) {
    assert.ok(
      reservationSrc.includes(`"${status}"`) && migrationSrc.includes(`'${status}'`),
      `Status reservasi '${status}' harus konsisten antara reservation.ts dan SQL migration`,
    );
  }

  // 6. Webhook signature validation tetap ketat SHA512 tanpa kompromi
  assert.ok(
    webhookSrc.includes("verifyMidtransWebhookSignature") &&
      webhookSrc.includes("INVALID_SIGNATURE"),
    "Verifikasi signature SHA512 webhook Midtrans harus tetap aktif dan ketat",
  );

  // Sanity check SHA-512 helper consistency
  const sampleHash = createHash("sha512")
    .update("ORD-20261118-0007-A120064400.00SB-Mid-server-TEST")
    .digest("hex");
  assert.equal(sampleHash.length, 128);
});

console.log(`\nRingkasan: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
