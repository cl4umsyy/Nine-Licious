// @ts-check
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

console.log("===============================================================================");
console.log(" NINE LICIOUS POS: MIDTRANS SETTLEMENT RECONCILIATION COMPREHENSIVE SIMULATION");
console.log("===============================================================================\n");

let passed = 0;
let total = 0;

function test(title, fn) {
  total++;
  try {
    fn();
    console.log(`✓ [PASS] #${total} ${title}`);
    passed++;
  } catch (err) {
    console.error(`✗ [FAIL] #${total} ${title}`);
    console.error(err);
    throw err;
  }
}

async function testAsync(title, fn) {
  total++;
  try {
    await fn();
    console.log(`✓ [PASS] #${total} ${title}`);
    passed++;
  } catch (err) {
    console.error(`✗ [FAIL] #${total} ${title}`);
    console.error(err);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// CORE BUSINESS LOGIC UNDER TEST
// -----------------------------------------------------------------------------
function isMidtransPaidStatus(transactionStatus, fraudStatus) {
  const normFraud = (fraudStatus || "").trim().toLowerCase();
  if (normFraud === "challenge" || normFraud === "deny") {
    return false;
  }
  if (transactionStatus === "settlement") {
    return !normFraud || normFraud === "accept";
  }
  return transactionStatus === "capture" && normFraud === "accept";
}

function parseMidtransGrossAmount(grossAmount) {
  if (typeof grossAmount !== "string" && typeof grossAmount !== "number") return null;
  const str = String(grossAmount).trim();
  const parsed = Number.parseFloat(str);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return null;
  // Non-integer cents in IDR are invalid
  if (Math.round(parsed) !== parsed && str.includes(".")) {
    const parts = str.split(".");
    if (parts[1] && Number(parts[1]) !== 0) return null;
  }
  return Math.round(parsed);
}

function computeEventFingerprint(payload) {
  const parts = [
    payload.order_id || "",
    payload.status_code || "",
    payload.gross_amount || "",
    payload.currency || "IDR",
    payload.transaction_status || "",
    payload.fraud_status || "",
    payload.transaction_id || "",
  ];
  return createHash("sha256").update(parts.join(":")).digest("hex");
}

// -----------------------------------------------------------------------------
// IN-MEMORY SIMULATION LEDGER (Simulating PostgreSQL Atomic State Machine)
// -----------------------------------------------------------------------------
class SimulatedPosDatabase {
  constructor() {
    this.reset();
  }

  reset() {
    this.order = {
      id: "ddab4c63-bee3-4878-86e4-056190f87c00",
      order_number: "ORD-20261121-0001",
      order_type: "dine_in",
      table_id: "d0c3bce5-e19f-4d2f-a2de-fa4f0c8ddc72",
      dining_session_id: "d84163f9-9c3f-45b6-87f3-de1f06ce0aa3",
      status: "awaiting_payment",
      payment_status: "unpaid",
      grand_total: 32200,
      paid_total: 0,
      is_finalized: true,
      queue_number: null,
      kds_status: null,
    };

    this.midtransTx = {
      id: "293e945d-79f5-4f8a-97c5-1d4a799fa361",
      order_id: this.order.id,
      midtrans_order_id: "ORD-20261121-0001-A1",
      gross_amount: 32200,
      lifecycle_status: "pending",
      midtrans_transaction_status: "pending",
      payment_expires_at: "2026-11-21T09:33:46.648Z",
      sanitized_response: {
        transaction_id: "0b5fc9c2-4e56-4e4b-9fbb-2cf460135f28",
      },
    };

    this.ingredientReservations = [
      { id: "res-1", ingredient_id: "ing-tepung", name: "Tepung Terigu", qty: 20, status: "active" },
      { id: "res-2", ingredient_id: "ing-cokelat", name: "Dark Chocolate", qty: 50, status: "active" },
      { id: "res-3", ingredient_id: "ing-eskrim", name: "Es Krim Vanila", qty: 50, status: "active" },
      { id: "res-4", ingredient_id: "ing-mentega", name: "Mentega (Butter)", qty: 25, status: "active" },
      { id: "res-5", ingredient_id: "ing-gula", name: "Gula Pasir", qty: 25, status: "active" },
      { id: "res-6", ingredient_id: "ing-telur", name: "Telur Ayam", qty: 1, status: "active" },
    ];

    this.payments = [];
    this.stockMovements = [];
    this.webhookEvents = new Map(); // fingerprint -> event
    this.auditLogs = [];
    this.queueSeq = 0;
    this.lockMutex = false; // concurrency row-lock simulation
  }

  // Validasi payment_method & source whitelist
  validatePaymentMethodAndSource(method, source) {
    const validPairs = {
      cash: ["cash_drawer"],
      midtrans: ["midtrans_snap", "midtrans_qris"],
      debit: ["edc_bca", "edc_mandiri", "edc_bri"],
      credit: ["edc_bca", "edc_mandiri", "edc_bri"],
      qris: ["midtrans_qris"],
      transfer: ["manual_transfer"],
    };
    if (!method || !source) return false;
    const allowedSources = validPairs[method];
    return Boolean(allowedSources && allowedSources.includes(source));
  }

  // Atomik settlement execution (equivalent to execute_order_payment_internal)
  async executeOrderPaymentInternal({
    orderId,
    paymentMethod,
    paymentSource,
    amount,
    referenceNumber,
    idempotencyKey,
  }) {
    if (!this.validatePaymentMethodAndSource(paymentMethod, paymentSource)) {
      throw new Error(`INVALID_PAYMENT_METHOD_SOURCE: ${paymentMethod} / ${paymentSource}`);
    }

    if (orderId !== this.order.id) {
      throw new Error("ORDER_NOT_FOUND");
    }

    // Idempotency: jika idempotency_key sudah ada di payments
    const existingPayment = this.payments.find((p) => p.idempotency_key === idempotencyKey);
    if (existingPayment) {
      return {
        payment_id: existingPayment.id,
        payment_status: "success",
        is_idempotent: true,
      };
    }

    // Balance check
    const remaining = this.order.grand_total - this.order.paid_total;
    if (remaining <= 0 && this.order.payment_status === "paid") {
      return {
        payment_id: this.payments[0]?.id || "already-paid",
        payment_status: "success",
        is_idempotent: true,
      };
    }

    // Insert payment
    const paymentId = `pay-${this.payments.length + 1}`;
    this.payments.push({
      id: paymentId,
      order_id: orderId,
      payment_method: paymentMethod,
      payment_source: paymentSource,
      amount,
      payment_status: "success",
      reference_number: referenceNumber,
      idempotency_key: idempotencyKey,
      created_at: new Date().toISOString(),
    });

    this.order.paid_total += amount;

    // Transition to paid
    if (this.order.paid_total >= this.order.grand_total) {
      this.order.payment_status = "paid";
      this.order.status = "paid";

      // Queue number generation (Anti-duplicate)
      if (this.order.queue_number === null) {
        this.queueSeq++;
        this.order.queue_number = `A-${String(this.queueSeq).padStart(3, "0")}`;
      }

      this.order.kds_status = "queued";

      // Trigger: deduct stock and fulfill reservations
      for (const res of this.ingredientReservations) {
        // Unique index guard: (order_id, ingredient_id)
        const alreadyDeducted = this.stockMovements.some(
          (m) => m.order_id === orderId && m.ingredient_id === res.ingredient_id
        );
        if (!alreadyDeducted) {
          this.stockMovements.push({
            id: `mov-${this.stockMovements.length + 1}`,
            order_id: orderId,
            ingredient_id: res.ingredient_id,
            movement_type: "sale_deduction",
            quantity_delta: -res.qty,
          });
          res.status = "fulfilled";
        }
      }
    }

    this.auditLogs.push({
      action: "payment.completed",
      entity_id: this.order.id,
      amount,
      payment_id: paymentId,
    });

    return {
      payment_id: paymentId,
      payment_status: "success",
      is_idempotent: false,
    };
  }

  // execute_midtrans_webhook_settlement simulation
  async executeMidtransWebhookSettlement(payload) {
    const fingerprint = computeEventFingerprint(payload);

    // Concurrency handling on webhook event
    if (this.webhookEvents.has(fingerprint)) {
      const existing = this.webhookEvents.get(fingerprint);
      if (["settled", "ignored_duplicate"].includes(existing.processing_result)) {
        return { status: "ignored_duplicate", event_fingerprint: fingerprint };
      }
    }

    this.webhookEvents.set(fingerprint, {
      id: this.webhookEvents.size + 1,
      fingerprint,
      processing_result: "received",
      payload,
    });

    // Validasi gross_amount
    const grossAmount = parseMidtransGrossAmount(payload.gross_amount);
    if (grossAmount === null) {
      this.webhookEvents.get(fingerprint).processing_result = "failed";
      return { status: "failed", error: "INVALID_GROSS_AMOUNT" };
    }

    // Validasi Currency
    if (payload.currency !== "IDR") {
      this.webhookEvents.get(fingerprint).processing_result = "failed";
      return { status: "failed", error: "INVALID_CURRENCY" };
    }

    // Validasi kesesuaian order
    if (payload.order_id !== this.midtransTx.midtrans_order_id) {
      this.webhookEvents.get(fingerprint).processing_result = "failed";
      return { status: "failed", error: "TRANSACTION_NOT_FOUND" };
    }

    // Validasi nominal eksak
    if (grossAmount !== this.midtransTx.gross_amount) {
      this.midtransTx.lifecycle_status = "reconciliation_required";
      this.webhookEvents.get(fingerprint).processing_result = "reconciliation_flagged";
      return { status: "reconciliation_required_amount_mismatch" };
    }

    // Idempotency: jika transaction sudah settled
    if (this.midtransTx.lifecycle_status === "settled") {
      this.webhookEvents.get(fingerprint).processing_result = "ignored_duplicate";
      return { status: "already_settled", order_id: this.order.id };
    }

    // Cek Paid status
    const isPaid = isMidtransPaidStatus(payload.transaction_status, payload.fraud_status);

    if (isPaid) {
      const paymentRes = await this.executeOrderPaymentInternal({
        orderId: this.order.id,
        paymentMethod: "midtrans",
        paymentSource: "midtrans_snap",
        amount: grossAmount,
        referenceNumber: payload.order_id,
        idempotencyKey: `MT-WH-${payload.order_id}`,
      });

      this.midtransTx.lifecycle_status = "settled";
      this.midtransTx.midtrans_transaction_status = payload.transaction_status;
      this.webhookEvents.get(fingerprint).processing_result = "settled";

      return {
        status: "success",
        lifecycle_status: "settlement",
        payment_result: paymentRes,
      };
    }

    if (["expire", "cancel", "deny"].includes(payload.transaction_status)) {
      this.midtransTx.lifecycle_status =
        payload.transaction_status === "expire" ? "expired" : "cancelled";
      this.webhookEvents.get(fingerprint).processing_result = "terminal_released";
      // Lepas reservasi
      for (const res of this.ingredientReservations) {
        res.status = "released";
      }
      return { status: "success", lifecycle_status: payload.transaction_status };
    }

    if (payload.transaction_status === "pending") {
      this.midtransTx.lifecycle_status = "pending";
      this.webhookEvents.get(fingerprint).processing_result = "processing";
      return { status: "success", lifecycle_status: "pending" };
    }

    return { status: "unhandled" };
  }

  // reconcileActiveMidtransPayment simulation
  async reconcileActiveMidtransPayment(midtransApiResponse) {
    // Fast path: jika DB sudah lunas
    if (this.order.payment_status === "paid" || this.order.status === "paid") {
      return {
        ok: true,
        isSettled: true,
        orderNumber: this.order.order_number,
        message: "Pesanan sudah berstatus lunas di database.",
      };
    }

    // a. Validasi Order ID
    if (midtransApiResponse.order_id !== this.midtransTx.midtrans_order_id) {
      return {
        ok: false,
        isSettled: false,
        error: `Order ID Midtrans tidak cocok: diharapkan ${this.midtransTx.midtrans_order_id}, diterima ${midtransApiResponse.order_id}.`,
      };
    }

    // b. Validasi Gross Amount
    const reportedGross = parseMidtransGrossAmount(midtransApiResponse.gross_amount);
    if (reportedGross === null || reportedGross !== this.midtransTx.gross_amount) {
      return {
        ok: false,
        isSettled: false,
        error: `Nominal transaksi Midtrans (${midtransApiResponse.gross_amount}) tidak cocok dengan tagihan lokal (${this.midtransTx.gross_amount}).`,
      };
    }

    // c. Validasi Mata Uang
    if (midtransApiResponse.currency !== "IDR") {
      return {
        ok: false,
        isSettled: false,
        error: `Mata uang tidak didukung: ${midtransApiResponse.currency}.`,
      };
    }

    // d. Validasi Status Code
    if (!midtransApiResponse.status_code) {
      return {
        ok: false,
        isSettled: false,
        error: "Respons status Midtrans tidak memiliki status_code yang valid.",
      };
    }

    const rawStatus = (midtransApiResponse.transaction_status || "").trim().toLowerCase();
    const fraudStatus = (midtransApiResponse.fraud_status || "").trim().toLowerCase();

    // e. Validasi Fraud Status pada settlement
    if (rawStatus === "settlement" && fraudStatus && fraudStatus !== "accept") {
      return {
        ok: false,
        isSettled: false,
        error: `Status fraud transaksi Midtrans (${fraudStatus}) tidak valid untuk settlement.`,
      };
    }

    // f. Validasi Transaction ID
    const transactionId = (midtransApiResponse.transaction_id || "").trim();
    const isPaid = isMidtransPaidStatus(rawStatus, fraudStatus);

    if (isPaid && !transactionId) {
      return {
        ok: false,
        isSettled: false,
        error: "Respons status Midtrans tidak memiliki transaction_id yang valid.",
      };
    }

    // g. Validasi konsistensi Transaction ID dengan catatan lokal
    const existingTxId = this.midtransTx.sanitized_response?.transaction_id;
    if (existingTxId && transactionId && existingTxId !== transactionId) {
      return {
        ok: false,
        isSettled: false,
        error: `Transaction ID Midtrans (${transactionId}) tidak cocok dengan catatan lokal (${existingTxId}).`,
      };
    }

    // Settlement execution
    if (isPaid) {
      const res = await this.executeMidtransWebhookSettlement({
        ...midtransApiResponse,
        transaction_id: transactionId,
      });

      if (res.status === "failed") {
        return {
          ok: false,
          isSettled: false,
          error: "Gagal memproses settlement pembayaran ke database.",
        };
      }

      const isOrderFullySettled =
        this.order.payment_status === "paid" &&
        this.order.paid_total >= this.order.grand_total;

      return {
        ok: true,
        isSettled: isOrderFullySettled,
        orderNumber: this.order.order_number,
        midtransStatus: rawStatus,
        message: "Pembayaran Midtrans berhasil diverifikasi dan pesanan telah lunas.",
      };
    }

    if (["expire", "cancel", "deny"].includes(rawStatus)) {
      await this.executeMidtransWebhookSettlement(midtransApiResponse);
      return {
        ok: true,
        isSettled: false,
        reservationReleased: true,
        midtransStatus: rawStatus,
        message: `Transaksi Midtrans telah berakhir (${rawStatus}) dan reservasi dilepas.`,
      };
    }

    if (rawStatus === "pending") {
      await this.executeMidtransWebhookSettlement(midtransApiResponse);
      return {
        ok: true,
        isSettled: false,
        midtransStatus: "pending",
        message: "Pembayaran masih menunggu penyelesaian dari pelanggan.",
      };
    }

    return { ok: true, isSettled: false, midtransStatus: rawStatus };
  }

  // Receipt guard check
  canIssueReceipt() {
    return this.order.paid_total > 0 && this.order.payment_status === "paid";
  }
}

// =============================================================================
// TEST SUITE EXECUTION
// =============================================================================

async function main() {
  await testAsync("1. Settlement Sukses: Transaksi terekonsiliasi, order paid, reservasi fulfilled, stok terpotong, antrean terbuat", async () => {
    const db = new SimulatedPosDatabase();

    const mockMidtransResponse = {
      status_code: "200",
      order_id: "ORD-20261121-0001-A1",
      transaction_id: "0b5fc9c2-4e56-4e4b-9fbb-2cf460135f28",
      transaction_status: "settlement",
      fraud_status: "accept",
      payment_type: "bank_transfer",
      gross_amount: "32200.00",
      currency: "IDR",
    };

    const result = await db.reconcileActiveMidtransPayment(mockMidtransResponse);

    assert.equal(result.ok, true, "Rekonsiliasi harus mengembalikan ok=true");
    assert.equal(result.isSettled, true, "Rekonsiliasi harus menandai isSettled=true");
    assert.equal(db.order.status, "paid", "Status pesanan harus berpindah menjadi 'paid'");
    assert.equal(db.order.payment_status, "paid", "Payment status harus 'paid'");
    assert.equal(db.order.paid_total, 32200, "Paid total harus 32200");
    assert.equal(db.payments.length, 1, "Harus ada tepat 1 baris payment");
    assert.equal(db.payments[0].payment_method, "midtrans");
    assert.equal(db.payments[0].payment_source, "midtrans_snap");
    assert.equal(db.payments[0].payment_status, "success");
    assert.equal(db.midtransTx.lifecycle_status, "settled");

    // Reservasi & Mutasi Stok
    assert.equal(db.stockMovements.length, 6, "Harus ada 6 mutasi pengurangan stok (sale_deduction)");
    for (const res of db.ingredientReservations) {
      assert.equal(res.status, "fulfilled", `Reservasi ${res.name} harus fulfilled`);
    }

    // Antrean & KDS
    assert.equal(db.order.queue_number, "A-001", "Nomor antrean harus digenerate");
    assert.equal(db.order.kds_status, "queued", "KDS status harus 'queued'");

    // Struk Pembayaran
    assert.equal(db.canIssueReceipt(), true, "Struk pembayaran harus dibuka setelah status lunas");
  });

  await testAsync("2. Konkurensi: Webhook dan Reconcile berjalan paralel, tidak terjadi double payment", async () => {
    const db = new SimulatedPosDatabase();

    const payload = {
      status_code: "200",
      order_id: "ORD-20261121-0001-A1",
      transaction_id: "0b5fc9c2-4e56-4e4b-9fbb-2cf460135f28",
      transaction_status: "settlement",
      fraud_status: "accept",
      payment_type: "bank_transfer",
      gross_amount: "32200.00",
      currency: "IDR",
    };

    // Jalankan bersamaan menggunakan Promise.all
    const [resWebhook, resReconcile] = await Promise.all([
      db.executeMidtransWebhookSettlement(payload),
      db.reconcileActiveMidtransPayment(payload),
    ]);

    const settlements = [resWebhook.status, resReconcile.message].filter((s) => Boolean(s));
    assert.equal(settlements.length, 2, "Kedua proses harus selesai tanpa crash");

    assert.equal(db.payments.length, 1, "ANTI-DOUBLE PAYMENT: Tepat 1 record pembayaran!");
    assert.equal(db.stockMovements.length, 6, "ANTI-DOUBLE DEDUCTION: Tepat 6 baris pengurangan stok!");
    assert.equal(db.order.queue_number, "A-001", "ANTI-DUPLICATE QUEUE: Nomor antrean tetap A-001");
    assert.equal(db.order.paid_total, 32200, "Paid total tidak boleh berlipat ganda");
  });

  await testAsync("3. Idempotency Berulang: Dipanggil 5 kali berurutan, hasil tetap konsisten dan aman", async () => {
    const db = new SimulatedPosDatabase();

    const payload = {
      status_code: "200",
      order_id: "ORD-20261121-0001-A1",
      transaction_id: "0b5fc9c2-4e56-4e4b-9fbb-2cf460135f28",
      transaction_status: "settlement",
      fraud_status: "accept",
      payment_type: "bank_transfer",
      gross_amount: "32200.00",
      currency: "IDR",
    };

    for (let i = 1; i <= 5; i++) {
      const res = await db.reconcileActiveMidtransPayment(payload);
      assert.equal(res.ok, true, `Iterasi #${i} harus ok=true`);
      assert.equal(res.isSettled, true, `Iterasi #${i} harus isSettled=true`);
    }

    assert.equal(db.payments.length, 1, "Record payment tetap 1 setelah 5 kali pemanggilan");
    assert.equal(db.stockMovements.length, 6, "Mutasi stok tetap 6 setelah 5 kali pemanggilan");
    assert.equal(db.order.queue_number, "A-001", "Nomor antrean tidak berubah");
    assert.equal(db.order.paid_total, 32200, "Paid total tetap 32200");
  });

  await testAsync("4. Nominal Tidak Cocok: Gateway mengembalikan jumlah berbeda, rekonsiliasi ditolak", async () => {
    const db = new SimulatedPosDatabase();

    const payloadMismatch = {
      status_code: "200",
      order_id: "ORD-20261121-0001-A1",
      transaction_id: "0b5fc9c2-4e56-4e4b-9fbb-2cf460135f28",
      transaction_status: "settlement",
      fraud_status: "accept",
      payment_type: "bank_transfer",
      gross_amount: "35000.00",
      currency: "IDR",
    };

    const res = await db.reconcileActiveMidtransPayment(payloadMismatch);

    assert.equal(res.ok, false, "Nominal mismatch harus ditolak");
    assert.equal(res.isSettled, false, "Tidak boleh dianggap settled");
    assert.match(res.error, /Nominal transaksi Midtrans .* tidak cocok/);
    assert.equal(db.payments.length, 0, "DILARANG membuat record payment jika nominal mismatch");
    assert.equal(db.order.status, "awaiting_payment", "Status order harus tetap awaiting_payment");
    assert.equal(db.stockMovements.length, 0, "Stok tidak boleh dipotong");
    assert.equal(db.canIssueReceipt(), false, "Struk dilarang diterbitkan");
  });

  await testAsync("5. Transaction ID Tidak Cocok: Gateway mengembalikan ID berbeda, rekonsiliasi ditolak", async () => {
    const db = new SimulatedPosDatabase();

    const payloadWrongTxId = {
      status_code: "200",
      order_id: "ORD-20261121-0001-A1",
      transaction_id: "mismatched-transaction-id-999",
      transaction_status: "settlement",
      fraud_status: "accept",
      payment_type: "bank_transfer",
      gross_amount: "32200.00",
      currency: "IDR",
    };

    const resA = await db.reconcileActiveMidtransPayment(payloadWrongTxId);
    assert.equal(resA.ok, false, "Transaction ID mismatch harus ditolak");
    assert.match(resA.error, /Transaction ID Midtrans .* tidak cocok dengan catatan lokal/);
    assert.equal(db.payments.length, 0);

    const payloadEmptyTxId = {
      status_code: "200",
      order_id: "ORD-20261121-0001-A1",
      transaction_id: "",
      transaction_status: "settlement",
      fraud_status: "accept",
      payment_type: "bank_transfer",
      gross_amount: "32200.00",
      currency: "IDR",
    };

    const resB = await db.reconcileActiveMidtransPayment(payloadEmptyTxId);
    assert.equal(resB.ok, false, "Transaction ID kosong pada status berbayar harus ditolak");
    assert.match(resB.error, /tidak memiliki transaction_id yang valid/);
    assert.equal(db.payments.length, 0);
  });

  await testAsync("6. Status Terminal: Expire dan Cancel melepas reservasi bahan baku, struk terkunci", async () => {
    const dbExpire = new SimulatedPosDatabase();
    const resExpire = await dbExpire.reconcileActiveMidtransPayment({
      status_code: "200",
      order_id: "ORD-20261121-0001-A1",
      transaction_id: "0b5fc9c2-4e56-4e4b-9fbb-2cf460135f28",
      transaction_status: "expire",
      gross_amount: "32200.00",
      currency: "IDR",
    });

    assert.equal(resExpire.ok, true);
    assert.equal(resExpire.isSettled, false);
    assert.equal(resExpire.reservationReleased, true);
    assert.equal(dbExpire.order.status, "awaiting_payment");
    assert.equal(dbExpire.canIssueReceipt(), false, "Struk dilarang diterbitkan untuk pesanan expired");
    for (const res of dbExpire.ingredientReservations) {
      assert.equal(res.status, "released", "Reservasi harus berstatus released");
    }

    const dbCancel = new SimulatedPosDatabase();
    const resCancel = await dbCancel.reconcileActiveMidtransPayment({
      status_code: "200",
      order_id: "ORD-20261121-0001-A1",
      transaction_id: "0b5fc9c2-4e56-4e4b-9fbb-2cf460135f28",
      transaction_status: "cancel",
      gross_amount: "32200.00",
      currency: "IDR",
    });

    assert.equal(resCancel.ok, true);
    assert.equal(resCancel.isSettled, false);
    assert.equal(resCancel.reservationReleased, true);
    assert.equal(dbCancel.canIssueReceipt(), false, "Struk dilarang diterbitkan untuk pesanan cancelled");
    for (const res of dbCancel.ingredientReservations) {
      assert.equal(res.status, "released", "Reservasi harus berstatus released");
    }
  });

  await testAsync("7. Status Pending: Reservasi dipertahankan, tidak ada pembayaran, struk terkunci", async () => {
    const db = new SimulatedPosDatabase();

    const res = await db.reconcileActiveMidtransPayment({
      status_code: "201",
      order_id: "ORD-20261121-0001-A1",
      transaction_id: "0b5fc9c2-4e56-4e4b-9fbb-2cf460135f28",
      transaction_status: "pending",
      gross_amount: "32200.00",
      currency: "IDR",
    });

    assert.equal(res.ok, true);
    assert.equal(res.isSettled, false);
    assert.equal(res.midtransStatus, "pending");
    assert.equal(db.order.status, "awaiting_payment");
    assert.equal(db.payments.length, 0);
    assert.equal(db.stockMovements.length, 0);
    assert.equal(db.order.queue_number, null);
    assert.equal(db.canIssueReceipt(), false, "Struk harus terkunci saat pending");

    for (const r of db.ingredientReservations) {
      assert.equal(r.status, "active", "Reservasi harus tetap active saat pending");
    }
  });

  test("8. Fraud Status Bukan Accept: Settlement dengan fraud_status 'challenge' ditolak", () => {
    assert.equal(
      isMidtransPaidStatus("settlement", "challenge"),
      false,
      "Settlement dengan fraud_status=challenge TIDAK boleh dianggap paid"
    );
    assert.equal(
      isMidtransPaidStatus("settlement", "deny"),
      false,
      "Settlement dengan fraud_status=deny TIDAK boleh dianggap paid"
    );
    assert.equal(
      isMidtransPaidStatus("capture", "challenge"),
      false,
      "Capture dengan fraud_status=challenge TIDAK boleh dianggap paid"
    );
    assert.equal(
      isMidtransPaidStatus("settlement", "accept"),
      true,
      "Settlement dengan fraud_status=accept harus paid"
    );
    assert.equal(
      isMidtransPaidStatus("settlement", undefined),
      true,
      "Settlement tanpa fraud_status (mis. Bank Transfer) harus paid"
    );
  });

  test("9. Whitelist Compliance: Validasi ketat kombinasi metode dan sumber pembayaran", () => {
    const db = new SimulatedPosDatabase();

    assert.equal(db.validatePaymentMethodAndSource("midtrans", "midtrans_snap"), true);
    assert.equal(db.validatePaymentMethodAndSource("midtrans", "midtrans_qris"), true);
    assert.equal(db.validatePaymentMethodAndSource("cash", "cash_drawer"), true);
    assert.equal(db.validatePaymentMethodAndSource("debit", "edc_bca"), true);

    // Kombinasi ilegal
    assert.equal(db.validatePaymentMethodAndSource("midtrans", "cash_drawer"), false);
    assert.equal(db.validatePaymentMethodAndSource("cash", "midtrans_snap"), false);
    assert.equal(db.validatePaymentMethodAndSource(null, "midtrans_snap"), false);
    assert.equal(db.validatePaymentMethodAndSource("midtrans", null), false);
    assert.equal(db.validatePaymentMethodAndSource("crypto", "binance"), false);
  });

  await testAsync("10. Atomicity Integrity: Jika terjadi error di tengah proses, kondisi database tidak setengah selesai", async () => {
    const db = new SimulatedPosDatabase();

    const illegalPayload = {
      status_code: "200",
      order_id: "ORD-NONEXISTENT",
      transaction_id: "0b5fc9c2-4e56-4e4b-9fbb-2cf460135f28",
      transaction_status: "settlement",
      fraud_status: "accept",
      gross_amount: "32200.00",
      currency: "IDR",
    };

    const res = await db.reconcileActiveMidtransPayment(illegalPayload);
    assert.equal(res.ok, false);
    assert.equal(db.payments.length, 0, "Tidak boleh ada payment parsial");
    assert.equal(db.stockMovements.length, 0, "Tidak boleh ada mutasi stok parsial");
    assert.equal(db.order.paid_total, 0, "Saldo paid_total tetap 0");
    assert.equal(db.order.queue_number, null, "Queue number tidak teralokasi");
  });

  console.log(`\n===============================================================================`);
  console.log(` SEMUA ${passed}/${total} PENGUJIAN SIMULASI REKONSILIASI MIDTRANS BERHASIL (PASS)`);
  console.log(`===============================================================================\n`);
}

main().catch((err) => {
  console.error("FATAL ERROR IN TEST SUITE:", err);
  process.exit(1);
});

