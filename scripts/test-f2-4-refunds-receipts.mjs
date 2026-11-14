#!/usr/bin/env node
/**
 * NINE LICIOUS POS - F2.4 REFUNDS & RECEIPTS COMPREHENSIVE 51-SCENARIO VERIFICATION SUITE
 * 
 * Pengujian Lengkap Berdasarkan Section M Instruksi Audit:
 * - SECURITY (Skr. 1-8)
 * - REFUND CORE (Skr. 9-18)
 * - IDEMPOTENCY (Skr. 19-23)
 * - MIDTRANS GATEWAY INTEGRATION (Skr. 24-32)
 * - SPLIT BILL REFUNDS (Skr. 33-36)
 * - KITCHEN DISPLAY SYSTEM INTEGRATION (Skr. 37-40)
 * - DIGITAL RECEIPT CALCULATION (Skr. 41-46)
 * - DINING SESSION STATUS & SUMMARY (Skr. 47-51)
 *
 * Pelabelan Hasil Pengujian:
 * - [Source/Static Audit]: Pengujian struktur DDL, SQL privilege, constraint, dan kontrak RLS.
 * - [Unit/Logic Simulation]: Pengujian matematis transaksi, state machine, anti-overlap, dan boundary.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("===============================================================================");
console.log(" NINE LICIOUS POS - F2.4 51-SCENARIO COMPREHENSIVE AUDIT & REGRESSION SUITE");
console.log("===============================================================================\n");

let passedTests = 0;
let totalTests = 0;

function runTest(number, category, label, name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✓ [PASS] [${label}] #${number} [${category}] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`✗ [FAIL] [${label}] #${number} [${category}] ${name}`);
    console.error(`  Detail Kesalahan: ${err.message}\n`);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// READ MIGRATION FILE
// -----------------------------------------------------------------------------
const migrationPath = path.resolve(process.cwd(), "supabase/migrations/20261115000100_refunds_receipts.sql");
assert.ok(fs.existsSync(migrationPath), "File 20261115000100_refunds_receipts.sql harus ada.");
const sqlContent = fs.readFileSync(migrationPath, "utf-8");

// -----------------------------------------------------------------------------
// SIMULATION ENGINE FOR DATABASE & BUSINESS LOGIC
// -----------------------------------------------------------------------------
class RefundEngine {
  constructor() {
    this.orders = new Map();
    this.payments = new Map();
    this.refunds = new Map();
    this.sessions = new Map();
    this.tables = new Map();
    this.auditLogs = [];
    this.seq = 1;
  }

  generateRefundNumber() {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return `RF-${today}-${String(this.seq++).padStart(4, "0")}`;
  }

  processOrderRefund(params, user) {
    const { orderId, amount, refundType, refundMethod, reason, paymentId = null, idempotencyKey } = params;

    // Security check
    if (!user || user.role !== "admin") {
      throw new Error("Hanya admin yang berhak memproses pengembalian dana (refund).");
    }

    // Input validation
    if (!orderId) throw new Error("ID pesanan wajib diisi.");
    if (!amount || amount <= 0) throw new Error("Nominal refund harus lebih dari Rp 0.");
    if (!reason || reason.trim().length < 3) throw new Error("Alasan refund wajib diisi (minimal 3 karakter).");
    if (!["full", "partial"].includes(refundType)) throw new Error(`Tipe refund tidak valid: ${refundType}.`);
    if (!["cash", "transfer", "midtrans", "manual"].includes(refundMethod)) {
      throw new Error(`Metode refund tidak valid: ${refundMethod}.`);
    }
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new Error("Kunci idempotensi (idempotency key) wajib disertakan pada setiap mutasi refund.");
    }

    // Idempotency check with full payload comparison
    const existing = Array.from(this.refunds.values()).find((r) => r.idempotency_key === idempotencyKey.trim());
    if (existing) {
      if (
        existing.order_id !== orderId ||
        (existing.payment_id || null) !== (paymentId || null) ||
        existing.amount !== amount ||
        existing.refund_type !== refundType ||
        existing.refund_method !== refundMethod ||
        existing.reason.trim() !== reason.trim()
      ) {
        throw new Error(`Konflik Idempotensi: Kunci "${idempotencyKey}" telah digunakan dengan rincian data refund yang berbeda.`);
      }

      return {
        refund_id: existing.id,
        refund_number: existing.refund_number,
        order_id: existing.order_id,
        payment_id: existing.payment_id,
        amount: existing.amount,
        status: existing.status,
        is_duplicate: true,
        message: "Permintaan refund telah diproses sebelumnya (idempotent replay).",
      };
    }

    // Order validation
    const order = this.orders.get(orderId);
    if (!order) throw new Error("Pesanan tidak ditemukan.");
    if (order.status === "cancelled") throw new Error("Pesanan sudah dibatalkan dan tidak dapat direfund.");
    if (order.status === "refunded") throw new Error("Pesanan sudah direfund penuh sebelumnya.");
    if (!order.paid_total || order.paid_total <= 0) {
      throw new Error("Pesanan belum memiliki riwayat pembayaran yang berhasil (paid_total = Rp 0).");
    }

    // Anti-overlap pending balance check
    const committedRefundTotal = order.refunded_total || 0;
    const pendingRefundTotal = Array.from(this.refunds.values())
      .filter((r) => r.order_id === orderId && r.status === "pending")
      .reduce((sum, r) => sum + r.amount, 0);

    const availableRefundable = order.paid_total - (committedRefundTotal + pendingRefundTotal);

    if (availableRefundable <= 0) {
      if (pendingRefundTotal > 0) {
        throw new Error(`Pesanan tidak memiliki saldo pembayaran yang dapat dikembalikan. Seluruh saldo sisa (Rp ${pendingRefundTotal}) sedang dicadangkan oleh permintaan refund pending.`);
      }
      throw new Error("Pesanan tidak memiliki saldo pembayaran yang dapat dikembalikan.");
    }

    if (amount > availableRefundable) {
      throw new Error(`Nominal refund (Rp ${amount}) melebihi sisa dana yang dapat dikembalikan (Rp ${availableRefundable}).`);
    }

    // Split bill payment validation
    let paymentRefundedSoFar = 0;
    let targetPayment = null;
    if (paymentId) {
      targetPayment = this.payments.get(paymentId);
      if (!targetPayment || targetPayment.order_id !== orderId) {
        throw new Error("Baris pembayaran spesifik tidak ditemukan pada pesanan ini.");
      }
      if (targetPayment.payment_status !== "success") {
        throw new Error("Hanya baris pembayaran berstatus success yang dapat direfund.");
      }

      paymentRefundedSoFar = Array.from(this.refunds.values())
        .filter((r) => r.payment_id === paymentId && ["completed", "pending"].includes(r.status))
        .reduce((sum, r) => sum + r.amount, 0);

      const paymentRemaining = targetPayment.amount - paymentRefundedSoFar;
      if (amount > paymentRemaining) {
        throw new Error(`Nominal refund (Rp ${amount}) melebihi sisa dana pada baris pembayaran ini (Rp ${paymentRemaining}).`);
      }
    }

    const isFullRefund = amount === availableRefundable && pendingRefundTotal === 0;
    if (refundType === "full" && !isFullRefund) {
      throw new Error(`Tipe refund full dipilih tetapi nominal tidak mencakup seluruh sisa dana.`);
    }
    if (refundType === "partial" && isFullRefund) {
      throw new Error(`Nominal mencakup seluruh sisa dana; gunakan tipe refund full.`);
    }

    const refundId = `ref_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const refundNumber = this.generateRefundNumber();

    // Midtrans: Created as pending without deducting order financial balance
    if (refundMethod === "midtrans") {
      const refundRecord = {
        id: refundId,
        order_id: orderId,
        payment_id: paymentId,
        refund_number: refundNumber,
        gateway_refund_id: null,
        refund_type: refundType,
        refund_method: refundMethod,
        amount,
        reason: reason.trim(),
        status: "pending",
        requested_by: user.id,
        approved_by: null,
        approved_at: null,
        kitchen_notified_at: null,
        idempotency_key: idempotencyKey.trim(),
      };
      this.refunds.set(refundId, refundRecord);
      this.auditLogs.push({ action: "order.refund_requested", refundId, orderId, amount, status: "pending" });

      return {
        refund_id: refundId,
        refund_number: refundNumber,
        order_id: orderId,
        payment_id: paymentId,
        amount,
        status: "pending",
        is_duplicate: false,
        message: "Permintaan refund Midtrans dicatat sebagai pending. Memerlukan verifikasi server-side.",
      };
    }

    // Manual / Cash / Transfer: Completed immediately
    let newOrderStatus = order.status;
    let newPaymentStatus = "partially_refunded";
    let kdsStatusAfter = order.kds_status;
    let kitchenNotifiedAt = null;

    if (isFullRefund) {
      newOrderStatus = ["paid", "completed"].includes(order.status) ? "refunded" : "cancelled";
      newPaymentStatus = "refunded";
      if (["queued", "preparing", "ready"].includes(order.kds_status)) {
        kdsStatusAfter = null;
        kitchenNotifiedAt = new Date().toISOString();
      }
      for (const p of this.payments.values()) {
        if (p.order_id === orderId && p.payment_status === "success") {
          p.payment_status = "refunded";
        }
      }
    } else {
      newOrderStatus = order.status; // PRESERVED completed status
      newPaymentStatus = "partially_refunded";
      if (paymentId && targetPayment) {
        const completedTotalOnPayment = Array.from(this.refunds.values())
          .filter((r) => r.payment_id === paymentId && r.status === "completed")
          .reduce((sum, r) => sum + r.amount, 0) + amount;
        if (completedTotalOnPayment >= targetPayment.amount) {
          targetPayment.payment_status = "refunded";
        }
      }
    }

    const newRefundedTotal = committedRefundTotal + amount;
    const refundRecord = {
      id: refundId,
      order_id: orderId,
      payment_id: paymentId,
      refund_number: refundNumber,
      gateway_refund_id: null,
      refund_type: refundType,
      refund_method: refundMethod,
      amount,
      reason: reason.trim(),
      status: "completed",
      requested_by: user.id,
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      kitchen_notified_at: kitchenNotifiedAt,
      idempotency_key: idempotencyKey.trim(),
    };
    this.refunds.set(refundId, refundRecord);

    order.refunded_total = newRefundedTotal;
    order.status = newOrderStatus;
    order.payment_status = newPaymentStatus;
    order.kds_status = kdsStatusAfter;
    if (isFullRefund) {
      order.cancelled_by = user.id;
      order.cancelled_at = new Date().toISOString();
      order.cancel_reason = reason.trim();
    }

    this.auditLogs.push({ action: "order.refunded", refundId, orderId, amount, isFullRefund });

    return {
      refund_id: refundId,
      refund_number: refundNumber,
      order_id: orderId,
      payment_id: paymentId,
      amount,
      status: "completed",
      new_order_status: newOrderStatus,
      new_payment_status: newPaymentStatus,
      refunded_total: newRefundedTotal,
      kitchen_notified: kitchenNotifiedAt !== null,
      is_duplicate: false,
    };
  }

  confirmMidtransRefund(params, isServiceRole) {
    if (!isServiceRole) {
      throw new Error("Akses ditolak: Hanya service_role yang berhak mengonfirmasi refund Midtrans.");
    }

    const { refundId, gatewayRefundId, expectedAmount } = params;
    if (!gatewayRefundId || gatewayRefundId.trim().length < 3) {
      throw new Error("Gateway refund ID wajib diisi dari gateway Midtrans.");
    }

    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error(`Data refund dengan ID ${refundId} tidak ditemukan.`);

    if (refund.refund_method !== "midtrans") {
      throw new Error(`Hanya refund dengan metode midtrans yang dapat dikonfirmasi gateway (metode: ${refund.refund_method}).`);
    }

    if (refund.status === "completed") {
      if (refund.gateway_refund_id === gatewayRefundId.trim()) {
        return { refund_id: refund.id, status: "completed", is_duplicate: true };
      }
      throw new Error(`Konflik Gateway: Refund ini sudah selesai dengan gateway refund ID lain (${refund.gateway_refund_id}).`);
    }

    if (refund.status !== "pending") {
      throw new Error(`Hanya refund berstatus pending yang dapat dikonfirmasi.`);
    }

    // Check uniqueness of gateway_refund_id
    const existingGw = Array.from(this.refunds.values()).find(
      (r) => r.gateway_refund_id === gatewayRefundId.trim() && r.id !== refundId
    );
    if (existingGw) {
      throw new Error(`Gateway refund ID "${gatewayRefundId}" telah digunakan oleh transaksi refund lain.`);
    }

    if (expectedAmount !== undefined && expectedAmount !== refund.amount) {
      throw new Error(`Nominal konfirmasi gateway (Rp ${expectedAmount}) tidak sesuai dengan nominal refund yang diminta (Rp ${refund.amount}).`);
    }

    const order = this.orders.get(refund.order_id);
    if (!order) throw new Error("Pesanan tidak ditemukan.");

    const newRefundedTotal = (order.refunded_total || 0) + refund.amount;
    const isFullRefund = newRefundedTotal === order.paid_total;

    let newOrderStatus = order.status;
    let newPaymentStatus = "partially_refunded";
    let kdsStatusAfter = order.kds_status;
    let kitchenNotifiedAt = null;

    if (isFullRefund) {
      newOrderStatus = ["paid", "completed"].includes(order.status) ? "refunded" : "cancelled";
      newPaymentStatus = "refunded";
      if (["queued", "preparing", "ready"].includes(order.kds_status)) {
        kdsStatusAfter = null;
        kitchenNotifiedAt = new Date().toISOString();
      }
      for (const p of this.payments.values()) {
        if (p.order_id === refund.order_id && p.payment_status === "success") {
          p.payment_status = "refunded";
        }
      }
    } else {
      newOrderStatus = order.status;
      newPaymentStatus = "partially_refunded";
      if (refund.payment_id) {
        const p = this.payments.get(refund.payment_id);
        if (p) {
          const completedOnP = Array.from(this.refunds.values())
            .filter((r) => r.payment_id === refund.payment_id && r.status === "completed" && r.id !== refundId)
            .reduce((sum, r) => sum + r.amount, 0) + refund.amount;
          if (completedOnP >= p.amount) {
            p.payment_status = "refunded";
          }
        }
      }
    }

    refund.status = "completed";
    refund.gateway_refund_id = gatewayRefundId.trim();
    refund.approved_by = refund.requested_by;
    refund.approved_at = new Date().toISOString();
    refund.kitchen_notified_at = kitchenNotifiedAt;

    order.refunded_total = newRefundedTotal;
    order.status = newOrderStatus;
    order.payment_status = newPaymentStatus;
    order.kds_status = kdsStatusAfter;
    if (isFullRefund) {
      order.cancelled_by = refund.requested_by;
      order.cancelled_at = new Date().toISOString();
      order.cancel_reason = refund.reason;
    }

    this.auditLogs.push({ action: "order.refund_confirmed", refundId, gatewayRefundId });

    return {
      refund_id: refund.id,
      refund_number: refund.refund_number,
      gateway_refund_id: gatewayRefundId.trim(),
      amount: refund.amount,
      status: "completed",
      new_order_status: newOrderStatus,
      new_payment_status: newPaymentStatus,
      refunded_total: newRefundedTotal,
      kitchen_notified: kitchenNotifiedAt !== null,
      is_duplicate: false,
    };
  }

  getReceiptData(orderId) {
    const order = this.orders.get(orderId);
    if (!order) return null;

    const orderRefunds = Array.from(this.refunds.values()).filter((r) => r.order_id === orderId);
    const completedRefunds = orderRefunds.filter((r) => r.status === "completed").reduce((sum, r) => sum + r.amount, 0);
    const pendingRefunds = orderRefunds.filter((r) => r.status === "pending").reduce((sum, r) => sum + r.amount, 0);

    return {
      order: {
        id: order.id,
        order_number: order.order_number,
        paid_total: order.paid_total,
        refunded_total: completedRefunds,
        pending_refund_total: pendingRefunds,
        net_paid: order.paid_total - completedRefunds,
      },
      refunds: orderRefunds,
    };
  }

  getDiningSessionSummary(sessionId) {
    const sessionOrders = Array.from(this.orders.values()).filter((o) => o.dining_session_id === sessionId);
    const sessionGrandTotal = sessionOrders.reduce((sum, o) => sum + (["cancelled", "refunded"].includes(o.status) ? 0 : o.grand_total), 0);
    const sessionPaidTotal = sessionOrders.reduce((sum, o) => sum + (["cancelled", "refunded"].includes(o.status) ? 0 : o.paid_total), 0);
    const sessionRefundedTotal = sessionOrders.reduce((sum, o) => sum + (o.refunded_total || 0), 0);

    const pendingRefundCount = Array.from(this.refunds.values()).filter((r) => {
      const ord = this.orders.get(r.order_id);
      return ord && ord.dining_session_id === sessionId && r.status === "pending";
    }).length;

    let canClose = true;
    let blockingReason = null;

    if (sessionGrandTotal - sessionPaidTotal > 0) {
      canClose = false;
      blockingReason = "Masih ada sisa tagihan belum dibayar.";
    } else if (pendingRefundCount > 0) {
      canClose = false;
      blockingReason = "Terdapat permohonan refund yang masih berstatus pending dan menunggu konfirmasi gateway.";
    }

    return {
      session_grand_total: sessionGrandTotal,
      session_paid_total: sessionPaidTotal,
      session_refunded_total: sessionRefundedTotal,
      session_remaining_balance: Math.max(0, sessionGrandTotal - sessionPaidTotal),
      pending_refund_count: pendingRefundCount,
      can_close_session: canClose,
      blocking_reason: blockingReason,
    };
  }
}

// PROFILE FIXTURES
const adminUser = { id: "usr_admin_001", role: "admin", name: "Kepala Kasir & Admin" };
const cashierUser = { id: "usr_cashier_002", role: "kasir", name: "Kasir Shift Pagi" };

// =============================================================================
// I. SECURITY TESTS (Skenario 1 - 8)
// =============================================================================

runTest(1, "SECURITY", "Source/Static Audit", "Anon tidak dapat membaca public.refunds", () => {
  assert.match(sqlContent, /revoke\s+all\s+on\s+public\.refunds\s+from\s+public,\s*anon/i);
});

runTest(2, "SECURITY", "Source/Static Audit", "Anon tidak dapat menjalankan RPC refund dan role 3VL terlindungi", () => {
  assert.match(sqlContent, /revoke\s+all\s+on\s+function\s+public\.process_order_refund_atomic[\s\S]*?from\s+public,\s*anon/i);
  assert.match(sqlContent, /revoke\s+all\s+on\s+function\s+public\.confirm_midtrans_refund_atomic[\s\S]*?from\s+public,\s*anon/i);
  assert.match(sqlContent, /if\s+v_user_id\s+is\s+null\s+or\s+coalesce\(v_user_role,\s*''\)\s*<>\s*'admin'/i);
});

runTest(3, "SECURITY", "Source/Static Audit", "Authenticated tidak dapat INSERT langsung ke public.refunds", () => {
  assert.match(sqlContent, /drop\s+policy\s+if\s+exists\s+refunds_insert_admin\s+on\s+public\.refunds/i);
  assert.doesNotMatch(sqlContent, /create\s+policy\s+refunds_insert/i);
});

runTest(4, "SECURITY", "Source/Static Audit", "Authenticated tidak dapat UPDATE langsung pada public.refunds", () => {
  assert.match(sqlContent, /drop\s+policy\s+if\s+exists\s+refunds_update_admin\s+on\s+public\.refunds/i);
  assert.doesNotMatch(sqlContent, /create\s+policy\s+refunds_update/i);
});

runTest(5, "SECURITY", "Source/Static Audit", "Authenticated tidak dapat DELETE langsung pada public.refunds", () => {
  assert.match(sqlContent, /drop\s+policy\s+if\s+exists\s+refunds_delete_admin\s+on\s+public\.refunds/i);
  assert.doesNotMatch(sqlContent, /create\s+policy\s+refunds_delete/i);
});

runTest(6, "SECURITY", "Unit/Logic Simulation", "Admin dapat mengakses fitur refund sesuai otorisasi", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_sec_adm", { id: "ord_sec_adm", status: "completed", payment_status: "paid", paid_total: 50000, refunded_total: 0 });
  const res = engine.processOrderRefund({
    orderId: "ord_sec_adm",
    amount: 50000,
    refundType: "full",
    refundMethod: "cash",
    reason: "Pemberian refund oleh admin",
    idempotencyKey: "idem_sec_admin_01",
  }, adminUser);
  assert.equal(res.status, "completed");
});

runTest(7, "SECURITY", "Unit/Logic Simulation", "Kasir ditolak saat mencoba mengeksekusi refund admin-only", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_sec_kas", { id: "ord_sec_kas", status: "completed", payment_status: "paid", paid_total: 50000, refunded_total: 0 });
  assert.throws(() => {
    engine.processOrderRefund({
      orderId: "ord_sec_kas",
      amount: 50000,
      refundType: "full",
      refundMethod: "cash",
      reason: "Kasir coba refund",
      idempotencyKey: "idem_sec_kasir_01",
    }, cashierUser);
  }, /Hanya admin yang berhak memproses pengembalian dana/);
});

runTest(8, "SECURITY", "Unit/Logic Simulation", "Service role hanya digunakan pada backend (confirm_midtrans_refund)", () => {
  const engine = new RefundEngine();
  engine.refunds.set("ref_sec_sr", { id: "ref_sec_sr", order_id: "ord_x", status: "pending", amount: 20000, requested_by: adminUser.id });
  assert.throws(() => {
    engine.confirmMidtransRefund({ refundId: "ref_sec_sr", gatewayRefundId: "gw_123" }, false);
  }, /Hanya service_role yang berhak mengonfirmasi refund Midtrans/);
});

// =============================================================================
// II. REFUND CORE TESTS (Skenario 9 - 18)
// =============================================================================

runTest(9, "REFUND", "Unit/Logic Simulation", "Refund penuh (full refund) menuntaskan saldo dan mengubah status order", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_full_01", { id: "ord_full_01", status: "paid", payment_status: "paid", paid_total: 100000, refunded_total: 0, kds_status: "queued" });
  engine.payments.set("pay_full_01", { id: "pay_full_01", order_id: "ord_full_01", amount: 100000, payment_status: "success" });

  const res = engine.processOrderRefund({
    orderId: "ord_full_01",
    amount: 100000,
    refundType: "full",
    refundMethod: "cash",
    reason: "Bahan makanan habis",
    idempotencyKey: "idem_full_001",
  }, adminUser);

  assert.equal(res.status, "completed");
  assert.equal(res.new_order_status, "refunded");
  assert.equal(res.new_payment_status, "refunded");
  assert.equal(engine.orders.get("ord_full_01").refunded_total, 100000);
});

runTest(10, "REFUND", "Unit/Logic Simulation", "Refund parsial mempertahankan status completed", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_part_01", { id: "ord_part_01", status: "completed", payment_status: "paid", paid_total: 150000, refunded_total: 0 });
  const res = engine.processOrderRefund({
    orderId: "ord_part_01",
    amount: 50000,
    refundType: "partial",
    refundMethod: "cash",
    reason: "Satu item komplain dingin",
    idempotencyKey: "idem_part_001",
  }, adminUser);

  assert.equal(res.status, "completed");
  assert.equal(res.new_order_status, "completed", "Status completed tidak boleh terdegradasi");
  assert.equal(res.new_payment_status, "partially_refunded");
  assert.equal(engine.orders.get("ord_part_01").refunded_total, 50000);
});

runTest(11, "REFUND", "Unit/Logic Simulation", "Refund melebihi saldo yang tersedia ditolak", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_over_01", { id: "ord_over_01", status: "completed", payment_status: "paid", paid_total: 100000, refunded_total: 80000 });
  assert.throws(() => {
    engine.processOrderRefund({
      orderId: "ord_over_01",
      amount: 30000,
      refundType: "partial",
      refundMethod: "cash",
      reason: "Mencoba melebihi sisa 20k",
      idempotencyKey: "idem_over_001",
    }, adminUser);
  }, /melebihi sisa dana yang dapat dikembalikan/);
});

runTest(12, "REFUND", "Unit/Logic Simulation", "Refund pada order unpaid (paid_total = 0) ditolak", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_unpaid_01", { id: "ord_unpaid_01", status: "awaiting_payment", payment_status: "unpaid", paid_total: 0, refunded_total: 0 });
  assert.throws(() => {
    engine.processOrderRefund({
      orderId: "ord_unpaid_01",
      amount: 50000,
      refundType: "full",
      refundMethod: "cash",
      reason: "Belum bayar",
      idempotencyKey: "idem_unpaid_001",
    }, adminUser);
  }, /belum memiliki riwayat pembayaran yang berhasil/);
});

runTest(13, "REFUND", "Unit/Logic Simulation", "Refund pada order yang tidak valid / tidak ada ditolak", () => {
  const engine = new RefundEngine();
  assert.throws(() => {
    engine.processOrderRefund({
      orderId: "ord_non_existent",
      amount: 50000,
      refundType: "full",
      refundMethod: "cash",
      reason: "Pesanan gaib",
      idempotencyKey: "idem_ghost_001",
    }, adminUser);
  }, /Pesanan tidak ditemukan/);
});

runTest(14, "REFUND", "Unit/Logic Simulation", "Refund dengan payment_id yang tidak sesuai order ditolak", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_tgt_1", { id: "ord_tgt_1", status: "completed", payment_status: "paid", paid_total: 100000, refunded_total: 0 });
  engine.payments.set("pay_other", { id: "pay_other", order_id: "ord_other_99", amount: 100000, payment_status: "success" });

  assert.throws(() => {
    engine.processOrderRefund({
      orderId: "ord_tgt_1",
      paymentId: "pay_other",
      amount: 50000,
      refundType: "partial",
      refundMethod: "cash",
      reason: "Cross order payment ID",
      idempotencyKey: "idem_cross_001",
    }, adminUser);
  }, /Baris pembayaran spesifik tidak ditemukan pada pesanan ini/);
});

runTest(15, "REFUND", "Unit/Logic Simulation", "Refund dengan metode Midtrans dicatat pending dan saldo belum terpotong", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_mid_01", { id: "ord_mid_01", status: "completed", payment_status: "paid", paid_total: 80000, refunded_total: 0 });
  const res = engine.processOrderRefund({
    orderId: "ord_mid_01",
    amount: 80000,
    refundType: "full",
    refundMethod: "midtrans",
    reason: "Permintaan refund QRIS",
    idempotencyKey: "idem_mid_001",
  }, adminUser);

  assert.equal(res.status, "pending");
  assert.equal(engine.orders.get("ord_mid_01").refunded_total, 0, "Saldo tidak boleh dipotong saat pending");
});

runTest(16, "REFUND", "Unit/Logic Simulation", "Refund dengan metode cash diselesaikan langsung", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_cash_01", { id: "ord_cash_01", status: "completed", payment_status: "paid", paid_total: 50000, refunded_total: 0 });
  const res = engine.processOrderRefund({
    orderId: "ord_cash_01",
    amount: 50000,
    refundType: "full",
    refundMethod: "cash",
    reason: "Cash return",
    idempotencyKey: "idem_cash_001",
  }, adminUser);
  assert.equal(res.status, "completed");
  assert.equal(engine.orders.get("ord_cash_01").refunded_total, 50000);
});

runTest(17, "REFUND", "Unit/Logic Simulation", "Refund dengan metode transfer diselesaikan langsung", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_trf_01", { id: "ord_trf_01", status: "completed", payment_status: "paid", paid_total: 75000, refunded_total: 0 });
  const res = engine.processOrderRefund({
    orderId: "ord_trf_01",
    amount: 75000,
    refundType: "full",
    refundMethod: "transfer",
    reason: "Transfer bank return",
    idempotencyKey: "idem_trf_001",
  }, adminUser);
  assert.equal(res.status, "completed");
  assert.equal(engine.orders.get("ord_trf_01").refunded_total, 75000);
});

runTest(18, "REFUND", "Unit/Logic Simulation", "Refund pending tidak mengurangi net_paid", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_net_01", { id: "ord_net_01", status: "completed", payment_status: "paid", paid_total: 100000, refunded_total: 0 });
  engine.processOrderRefund({
    orderId: "ord_net_01",
    amount: 40000,
    refundType: "partial",
    refundMethod: "midtrans",
    reason: "Pending refund",
    idempotencyKey: "idem_net_001",
  }, adminUser);

  const receipt = engine.getReceiptData("ord_net_01");
  assert.equal(receipt.order.pending_refund_total, 40000);
  assert.equal(receipt.order.refunded_total, 0);
  assert.equal(receipt.order.net_paid, 100000, "net_paid harus tetap 100.000 saat refund masih pending");
});

// =============================================================================
// III. IDEMPOTENCY TESTS (Skenario 19 - 23)
// =============================================================================

runTest(19, "IDEMPOTENCY", "Unit/Logic Simulation", "Key sama dan parameter sama mengembalikan record asli tanpa mutasi ganda", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_idem_eq", { id: "ord_idem_eq", status: "completed", payment_status: "paid", paid_total: 100000, refunded_total: 0 });
  const payload = {
    orderId: "ord_idem_eq",
    amount: 30000,
    refundType: "partial",
    refundMethod: "cash",
    reason: "Alasan yang konsisten",
    idempotencyKey: "idem_key_exact_match",
  };
  const res1 = engine.processOrderRefund(payload, adminUser);
  const res2 = engine.processOrderRefund(payload, adminUser);

  assert.equal(res2.is_duplicate, true);
  assert.equal(res2.refund_id, res1.refund_id);
  assert.equal(engine.orders.get("ord_idem_eq").refunded_total, 30000);
});

runTest(20, "IDEMPOTENCY", "Unit/Logic Simulation", "Key sama tetapi nominal berbeda ditolak (payload tampering)", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_idem_diff_amt", { id: "ord_idem_diff_amt", status: "completed", payment_status: "paid", paid_total: 100000, refunded_total: 0 });
  engine.processOrderRefund({
    orderId: "ord_idem_diff_amt",
    amount: 25000,
    refundType: "partial",
    refundMethod: "cash",
    reason: "Alasan awal",
    idempotencyKey: "idem_key_tamper_amt",
  }, adminUser);

  assert.throws(() => {
    engine.processOrderRefund({
      orderId: "ord_idem_diff_amt",
      amount: 40000, // Nominal diubah
      refundType: "partial",
      refundMethod: "cash",
      reason: "Alasan awal",
      idempotencyKey: "idem_key_tamper_amt",
    }, adminUser);
  }, /Konflik Idempotensi/);
});

runTest(21, "IDEMPOTENCY", "Unit/Logic Simulation", "Key sama tetapi payment_id berbeda ditolak", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_idem_diff_pay", { id: "ord_idem_diff_pay", status: "completed", payment_status: "paid", paid_total: 100000, refunded_total: 0 });
  engine.payments.set("pay_a", { id: "pay_a", order_id: "ord_idem_diff_pay", amount: 50000, payment_status: "success" });
  engine.payments.set("pay_b", { id: "pay_b", order_id: "ord_idem_diff_pay", amount: 50000, payment_status: "success" });

  engine.processOrderRefund({
    orderId: "ord_idem_diff_pay",
    paymentId: "pay_a",
    amount: 20000,
    refundType: "partial",
    refundMethod: "cash",
    reason: "Refund pay A",
    idempotencyKey: "idem_key_diff_payment",
  }, adminUser);

  assert.throws(() => {
    engine.processOrderRefund({
      orderId: "ord_idem_diff_pay",
      paymentId: "pay_b", // Payment id diubah
      amount: 20000,
      refundType: "partial",
      refundMethod: "cash",
      reason: "Refund pay A",
      idempotencyKey: "idem_key_diff_payment",
    }, adminUser);
  }, /Konflik Idempotensi/);
});

runTest(22, "IDEMPOTENCY", "Unit/Logic Simulation", "Key sama tetapi reason berbeda ditolak", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_idem_diff_rsn", { id: "ord_idem_diff_rsn", status: "completed", payment_status: "paid", paid_total: 100000, refunded_total: 0 });

  engine.processOrderRefund({
    orderId: "ord_idem_diff_rsn",
    amount: 20000,
    refundType: "partial",
    refundMethod: "cash",
    reason: "Alasan A asli",
    idempotencyKey: "idem_key_diff_rsn",
  }, adminUser);

  assert.throws(() => {
    engine.processOrderRefund({
      orderId: "ord_idem_diff_rsn",
      amount: 20000,
      refundType: "partial",
      refundMethod: "cash",
      reason: "Alasan B diubah", // Reason diubah
      idempotencyKey: "idem_key_diff_rsn",
    }, adminUser);
  }, /Konflik Idempotensi/);
});

runTest(23, "IDEMPOTENCY", "Source/Static Audit", "Tabel refunds memiliki unique index pada idempotency_key", () => {
  assert.match(sqlContent, /create\s+index\s+if\s+not\s+exists\s+refunds_idempotency_key_idx\s+on\s+public\.refunds\s*\(idempotency_key\)/i);
  assert.match(sqlContent, /idempotency_key\s+text\s+unique/i);
});

// =============================================================================
// IV. MIDTRANS GATEWAY INTEGRATION (Skenario 24 - 32)
// =============================================================================

runTest(24, "MIDTRANS", "Unit/Logic Simulation", "Gateway amount sesuai menyelesaikan konfirmasi refund", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_mt_amt_ok", { id: "ord_mt_amt_ok", status: "completed", payment_status: "paid", paid_total: 60000, refunded_total: 0 });
  const resPending = engine.processOrderRefund({
    orderId: "ord_mt_amt_ok",
    amount: 60000,
    refundType: "full",
    refundMethod: "midtrans",
    reason: "Midtrans refund test",
    idempotencyKey: "idem_mt_amt_ok",
  }, adminUser);

  const resConfirm = engine.confirmMidtransRefund({
    refundId: resPending.refund_id,
    gatewayRefundId: "gw_mt_ok_001",
    expectedAmount: 60000,
  }, true);

  assert.equal(resConfirm.status, "completed");
  assert.equal(engine.orders.get("ord_mt_amt_ok").refunded_total, 60000);
});

runTest(25, "MIDTRANS", "Unit/Logic Simulation", "Gateway amount berbeda ditolak konfirmasinya", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_mt_amt_mismatch", { id: "ord_mt_amt_mismatch", status: "completed", payment_status: "paid", paid_total: 60000, refunded_total: 0 });
  const resPending = engine.processOrderRefund({
    orderId: "ord_mt_amt_mismatch",
    amount: 60000,
    refundType: "full",
    refundMethod: "midtrans",
    reason: "Mismatch test",
    idempotencyKey: "idem_mt_amt_mismatch",
  }, adminUser);

  assert.throws(() => {
    engine.confirmMidtransRefund({
      refundId: resPending.refund_id,
      gatewayRefundId: "gw_mt_mismatch_001",
      expectedAmount: 50000, // Berbeda dengan 60000
    }, true);
  }, /Nominal konfirmasi gateway .* tidak sesuai dengan nominal refund yang diminta/);
});

runTest(26, "MIDTRANS", "Source/Static Audit", "RPC confirm_midtrans_refund_atomic mencatat status completed pada refund", () => {
  assert.match(sqlContent, /update\s+public\.refunds\s+set\s+status\s*=\s*'completed'/i);
});

runTest(27, "MIDTRANS", "Source/Static Audit", "RPC confirm_midtrans_refund_atomic tidak mengubah order jika refund bukan pending", () => {
  assert.match(sqlContent, /if\s+v_refund\.status\s*<>\s*'pending'\s+then\s+raise\s+exception/i);
});

runTest(28, "MIDTRANS", "Unit/Logic Simulation", "Gateway refund ID yang digunakan ulang ditolak", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_gw_re1", { id: "ord_gw_re1", status: "completed", payment_status: "paid", paid_total: 100000, refunded_total: 0 });
  engine.orders.set("ord_gw_re2", { id: "ord_gw_re2", status: "completed", payment_status: "paid", paid_total: 100000, refunded_total: 0 });

  const ref1 = engine.processOrderRefund({ orderId: "ord_gw_re1", amount: 40000, refundType: "partial", refundMethod: "midtrans", reason: "Ref 1", idempotencyKey: "idem_gw_1" }, adminUser);
  const ref2 = engine.processOrderRefund({ orderId: "ord_gw_re2", amount: 50000, refundType: "partial", refundMethod: "midtrans", reason: "Ref 2", idempotencyKey: "idem_gw_2" }, adminUser);

  engine.confirmMidtransRefund({ refundId: ref1.refund_id, gatewayRefundId: "gw_shared_id_999" }, true);

  assert.throws(() => {
    engine.confirmMidtransRefund({ refundId: ref2.refund_id, gatewayRefundId: "gw_shared_id_999" }, true);
  }, /telah digunakan oleh transaksi refund lain/);
});

runTest(29, "MIDTRANS", "Unit/Logic Simulation", "Konfirmasi gateway pada refund non-Midtrans (cash/transfer) ditolak", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_mt_non", { id: "ord_mt_non", status: "completed", payment_status: "paid", paid_total: 50000, refunded_total: 0 });
  const res = engine.processOrderRefund({ orderId: "ord_mt_non", amount: 50000, refundType: "full", refundMethod: "cash", reason: "Cash refund", idempotencyKey: "idem_cash_non_mt" }, adminUser);

  assert.throws(() => {
    engine.confirmMidtransRefund({ refundId: res.refund_id, gatewayRefundId: "gw_fake_01" }, true);
  }, /Hanya refund berstatus pending yang dapat dikonfirmasi|Hanya refund dengan metode midtrans/);
});

runTest(30, "MIDTRANS", "Unit/Logic Simulation", "Konfirmasi ulang pada refund yang sudah completed menghasilkan idempotent replay", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_mt_reconfirm", { id: "ord_mt_reconfirm", status: "completed", payment_status: "paid", paid_total: 50000, refunded_total: 0 });
  const ref = engine.processOrderRefund({ orderId: "ord_mt_reconfirm", amount: 50000, refundType: "full", refundMethod: "midtrans", reason: "Reconfirm test", idempotencyKey: "idem_mt_reconf" }, adminUser);

  engine.confirmMidtransRefund({ refundId: ref.refund_id, gatewayRefundId: "gw_reconf_01" }, true);
  const reconfirm = engine.confirmMidtransRefund({ refundId: ref.refund_id, gatewayRefundId: "gw_reconf_01" }, true);

  assert.equal(reconfirm.is_duplicate, true);
  assert.equal(reconfirm.status, "completed");
});

runTest(31, "MIDTRANS", "Source/Static Audit", "Unique index gateway_refund_id menjamin proteksi level database", () => {
  assert.match(sqlContent, /create\s+unique\s+index\s+if\s+not\s+exists\s+refunds_gateway_refund_id_idx\s+on\s+public\.refunds\s*\(gateway_refund_id\)/i);
});

runTest(32, "MIDTRANS", "Unit/Logic Simulation", "Respons gateway tidak valid (gateway_refund_id kosong/pendek) ditolak", () => {
  const engine = new RefundEngine();
  engine.refunds.set("ref_inv_gw", { id: "ref_inv_gw", order_id: "ord_x", status: "pending", amount: 10000, requested_by: adminUser.id });
  assert.throws(() => {
    engine.confirmMidtransRefund({ refundId: "ref_inv_gw", gatewayRefundId: "  " }, true);
  }, /Gateway refund ID wajib diisi/);
});

// =============================================================================
// V. SPLIT BILL REFUNDS (Skenario 33 - 36)
// =============================================================================

runTest(33, "SPLIT BILL", "Unit/Logic Simulation", "Refund bertahap 40% + 60% pada satu payment baris mengubah status menjadi refunded", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_sb_100k", { id: "ord_sb_100k", status: "completed", payment_status: "paid", paid_total: 200000, refunded_total: 0 });
  engine.payments.set("pay_sb_a", { id: "pay_sb_a", order_id: "ord_sb_100k", amount: 100000, payment_status: "success" });
  engine.payments.set("pay_sb_b", { id: "pay_sb_b", order_id: "ord_sb_100k", amount: 100000, payment_status: "success" });

  // Tahap 1: 40% (Rp 40.000) pada Payment A
  const res1 = engine.processOrderRefund({
    orderId: "ord_sb_100k",
    paymentId: "pay_sb_a",
    amount: 40000,
    refundType: "partial",
    refundMethod: "cash",
    reason: "Refund tahap 1 (40%)",
    idempotencyKey: "idem_sb_step_1",
  }, adminUser);
  assert.equal(res1.status, "completed");
  assert.equal(engine.payments.get("pay_sb_a").payment_status, "success", "Payment status masih success setelah 40%");

  // Tahap 2: 60% (Rp 60.000) pada Payment A (menuntaskan 100k)
  const res2 = engine.processOrderRefund({
    orderId: "ord_sb_100k",
    paymentId: "pay_sb_a",
    amount: 60000,
    refundType: "partial",
    refundMethod: "cash",
    reason: "Refund tahap 2 (60%)",
    idempotencyKey: "idem_sb_step_2",
  }, adminUser);
  assert.equal(res2.status, "completed");
  assert.equal(engine.payments.get("pay_sb_a").payment_status, "refunded", "Payment status harus berubah menjadi refunded setelah 100%");
  assert.equal(engine.payments.get("pay_sb_b").payment_status, "success", "Payment B tetap success");
});

runTest(34, "SPLIT BILL", "Unit/Logic Simulation", "Refund pada satu payment split bill tidak mengubah status payment lain", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_sb_multi", { id: "ord_sb_multi", status: "completed", payment_status: "paid", paid_total: 150000, refunded_total: 0 });
  engine.payments.set("pay_cust_1", { id: "pay_cust_1", order_id: "ord_sb_multi", amount: 70000, payment_status: "success" });
  engine.payments.set("pay_cust_2", { id: "pay_cust_2", order_id: "ord_sb_multi", amount: 80000, payment_status: "success" });

  engine.processOrderRefund({
    orderId: "ord_sb_multi",
    paymentId: "pay_cust_1",
    amount: 70000,
    refundType: "partial",
    refundMethod: "cash",
    reason: "Customer 1 cancel",
    idempotencyKey: "idem_sb_cust1",
  }, adminUser);

  assert.equal(engine.payments.get("pay_cust_1").payment_status, "refunded");
  assert.equal(engine.payments.get("pay_cust_2").payment_status, "success", "Payment 2 harus tetap success");
});

runTest(35, "SPLIT BILL", "Unit/Logic Simulation", "Akumulasi refund tidak dapat melampaui nominal pembayaran terkait", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_sb_limit", { id: "ord_sb_limit", status: "completed", payment_status: "paid", paid_total: 100000, refunded_total: 0 });
  engine.payments.set("pay_limit", { id: "pay_limit", order_id: "ord_sb_limit", amount: 50000, payment_status: "success" });

  engine.processOrderRefund({
    orderId: "ord_sb_limit",
    paymentId: "pay_limit",
    amount: 30000,
    refundType: "partial",
    refundMethod: "cash",
    reason: "Refund 30k",
    idempotencyKey: "idem_sb_lim_1",
  }, adminUser);

  assert.throws(() => {
    engine.processOrderRefund({
      orderId: "ord_sb_limit",
      paymentId: "pay_limit",
      amount: 25000, // 30k + 25k = 55k > 50k
      refundType: "partial",
      refundMethod: "cash",
      reason: "Kelebihan limit payment",
      idempotencyKey: "idem_sb_lim_2",
    }, adminUser);
  }, /melebihi sisa dana pada baris pembayaran ini/);
});

runTest(36, "SPLIT BILL", "Source/Static Audit", "Pembaruan status payment split bill menghitung agregasi sum(amount) dari public.refunds", () => {
  assert.match(sqlContent, /select\s+coalesce\(sum\(amount\),\s*0\)\s+into\s+v_payment_completed_after[\s\S]*?from\s+public\.refunds[\s\S]*?where\s+payment_id\s*=\s*/i);
});

// =============================================================================
// VI. KITCHEN DISPLAY SYSTEM INTEGRATION (Skenario 37 - 40)
// =============================================================================

runTest(37, "KDS", "Unit/Logic Simulation", "Refund penuh mereset kds_status ke null dan mengisi audit pembatalan pesanan", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_kds_full", {
    id: "ord_kds_full",
    status: "paid",
    payment_status: "paid",
    kds_status: "preparing",
    paid_total: 120000,
    refunded_total: 0,
    cancelled_by: null,
    cancelled_at: null,
    cancel_reason: null,
  });

  const res = engine.processOrderRefund({
    orderId: "ord_kds_full",
    amount: 120000,
    refundType: "full",
    refundMethod: "cash",
    reason: "Pelanggan harus pergi mendadak",
    idempotencyKey: "idem_kds_full_01",
  }, adminUser);

  assert.equal(res.status, "completed");
  const order = engine.orders.get("ord_kds_full");
  assert.equal(order.kds_status, null, "Tiket KDS harus dinonaktifkan (null)");
  assert.equal(order.cancelled_by, adminUser.id);
  assert.ok(order.cancelled_at);
  assert.equal(order.cancel_reason, "Pelanggan harus pergi mendadak");
});

runTest(38, "KDS", "Unit/Logic Simulation", "Refund parsial tidak menghapus tiket KDS", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_kds_part", {
    id: "ord_kds_part",
    status: "paid",
    payment_status: "paid",
    kds_status: "queued",
    paid_total: 150000,
    refunded_total: 0,
  });

  engine.processOrderRefund({
    orderId: "ord_kds_part",
    amount: 30000,
    refundType: "partial",
    refundMethod: "cash",
    reason: "Kompensasi minuman",
    idempotencyKey: "idem_kds_part_01",
  }, adminUser);

  const order = engine.orders.get("ord_kds_part");
  assert.equal(order.kds_status, "queued", "kds_status harus tetap aktif pada refund parsial");
});

runTest(39, "KDS", "Source/Static Audit", "Pembaruan orders dan refunds terdaftar pada supabase_realtime publication", () => {
  assert.match(sqlContent, /update\s+public\.orders\s+set[\s\S]*?updated_at\s*=\s*now\(\)[\s\S]*?where\s+id\s*=\s*p_order_id/i);
  assert.match(sqlContent, /alter\s+publication\s+supabase_realtime\s+add\s+table\s+public\.orders/i);
  assert.match(sqlContent, /alter\s+publication\s+supabase_realtime\s+add\s+table\s+public\.refunds/i);
});

runTest(40, "KDS", "Unit/Logic Simulation", "Histori order tetap tersedia setelah refund penuh", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_hist_check", { id: "ord_hist_check", status: "paid", payment_status: "paid", paid_total: 50000, refunded_total: 0 });
  engine.processOrderRefund({ orderId: "ord_hist_check", amount: 50000, refundType: "full", refundMethod: "cash", reason: "Cek histori", idempotencyKey: "idem_hist_01" }, adminUser);

  assert.ok(engine.orders.has("ord_hist_check"), "Record order tidak boleh dihapus dari database!");
  assert.equal(engine.orders.get("ord_hist_check").status, "refunded");
});

// =============================================================================
// VII. DIGITAL RECEIPT TESTS (Skenario 41 - 46)
// =============================================================================

runTest(41, "RECEIPT", "Unit/Logic Simulation", "Receipt tanpa refund menampilkan net_paid sama dengan paid_total", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_rec_clean", { id: "ord_rec_clean", order_number: "ORD-001", paid_total: 80000, refunded_total: 0 });
  const receipt = engine.getReceiptData("ord_rec_clean");
  assert.equal(receipt.order.refunded_total, 0);
  assert.equal(receipt.order.net_paid, 80000);
});

runTest(42, "RECEIPT", "Unit/Logic Simulation", "Receipt dengan refund pending tidak mengurangi net_paid", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_rec_pend", { id: "ord_rec_pend", order_number: "ORD-002", paid_total: 90000, refunded_total: 0 });
  engine.processOrderRefund({ orderId: "ord_rec_pend", amount: 45000, refundType: "partial", refundMethod: "midtrans", reason: "Midtrans pending", idempotencyKey: "idem_rec_p" }, adminUser);

  const receipt = engine.getReceiptData("ord_rec_pend");
  assert.equal(receipt.order.pending_refund_total, 45000);
  assert.equal(receipt.order.refunded_total, 0);
  assert.equal(receipt.order.net_paid, 90000);
});

runTest(43, "RECEIPT", "Unit/Logic Simulation", "Receipt dengan refund parsial menampilkan net_paid akurat", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_rec_part", { id: "ord_rec_part", order_number: "ORD-003", paid_total: 100000, refunded_total: 0 });
  engine.processOrderRefund({ orderId: "ord_rec_part", amount: 30000, refundType: "partial", refundMethod: "cash", reason: "Cash partial", idempotencyKey: "idem_rec_part" }, adminUser);

  const receipt = engine.getReceiptData("ord_rec_part");
  assert.equal(receipt.order.refunded_total, 30000);
  assert.equal(receipt.order.net_paid, 70000);
});

runTest(44, "RECEIPT", "Unit/Logic Simulation", "Receipt dengan refund penuh menampilkan net_paid Rp 0", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_rec_full", { id: "ord_rec_full", order_number: "ORD-004", paid_total: 100000, refunded_total: 0 });
  engine.processOrderRefund({ orderId: "ord_rec_full", amount: 100000, refundType: "full", refundMethod: "cash", reason: "Cash full", idempotencyKey: "idem_rec_full" }, adminUser);

  const receipt = engine.getReceiptData("ord_rec_full");
  assert.equal(receipt.order.refunded_total, 100000);
  assert.equal(receipt.order.net_paid, 0);
});

runTest(45, "RECEIPT", "Source/Static Audit", "RPC get_order_receipt_data menghitung net_paid secara ketat dari completed refunds", () => {
  assert.match(sqlContent, /'net_paid',\s*\(v_order\.paid_total\s*-\s*v_completed_refund_total\)/i);
});

runTest(46, "RECEIPT", "Source/Static Audit", "RPC get_order_receipt_data menyertakan rincian pembayaran split bill", () => {
  assert.match(sqlContent, /'payments',\s*v_payments/i);
  assert.match(sqlContent, /from\s+public\.payments\s+p\s+where\s+p\.order_id\s*=\s*p_order_id/i);
});

// =============================================================================
// VIII. DINING SESSION TESTS (Skenario 47 - 51)
// =============================================================================

runTest(47, "SESSION", "Unit/Logic Simulation", "Session dengan pembayaran penuh tanpa refund dapat ditutup", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_sess_1", { id: "ord_sess_1", dining_session_id: "sess_01", grand_total: 100000, paid_total: 100000, refunded_total: 0, status: "completed" });
  const summary = engine.getDiningSessionSummary("sess_01");
  assert.equal(summary.session_remaining_balance, 0);
  assert.equal(summary.can_close_session, true);
});

runTest(48, "SESSION", "Unit/Logic Simulation", "Session dengan refund parsial completed dapat ditutup jika kewajiban lunas", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_sess_2", { id: "ord_sess_2", dining_session_id: "sess_02", grand_total: 100000, paid_total: 100000, refunded_total: 20000, status: "completed" });
  const summary = engine.getDiningSessionSummary("sess_02");
  assert.equal(summary.can_close_session, true);
});

runTest(49, "SESSION", "Unit/Logic Simulation", "Session dengan refund pending ditolak penutupannya (blocker aktif)", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_sess_3", { id: "ord_sess_3", dining_session_id: "sess_03", grand_total: 100000, paid_total: 100000, refunded_total: 0, status: "completed" });
  engine.processOrderRefund({ orderId: "ord_sess_3", amount: 50000, refundType: "partial", refundMethod: "midtrans", reason: "Pending refund", idempotencyKey: "idem_sess_pend" }, adminUser);

  const summary = engine.getDiningSessionSummary("sess_03");
  assert.equal(summary.pending_refund_count, 1);
  assert.equal(summary.can_close_session, false);
  assert.match(summary.blocking_reason, /menunggu konfirmasi gateway/i);
});

runTest(50, "SESSION", "Unit/Logic Simulation", "Session dengan refund penuh (order status refunded) dapat ditutup", () => {
  const engine = new RefundEngine();
  engine.orders.set("ord_sess_4", { id: "ord_sess_4", dining_session_id: "sess_04", grand_total: 100000, paid_total: 100000, refunded_total: 100000, status: "refunded" });
  const summary = engine.getDiningSessionSummary("sess_04");
  assert.equal(summary.session_remaining_balance, 0);
  assert.equal(summary.can_close_session, true);
});

runTest(51, "SESSION", "Source/Static Audit", "RPC get_dining_session_summary memeriksa pending refund sebagai blocker resmi", () => {
  assert.match(sqlContent, /elsif\s+v_pending_refund_count\s*>\s*0\s+then\s+v_can_close\s*:=\s*false/i);
  assert.match(sqlContent, /'Terdapat permohonan refund yang masih berstatus pending dan menunggu konfirmasi gateway\.'/i);
});

console.log("\n===============================================================================");
console.log(` HASIL PENGUJIAN: ${passedTests}/${totalTests} SKENARIO PENGUJIAN BERHASIL (100% PASS)`);
console.log("===============================================================================\n");
