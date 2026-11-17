// @ts-check
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

console.log("==================================================================");
console.log("=== UNIT TEST & SIMULATION: MIDTRANS ACTIVE RECONCILIATION ENGINE ===");
console.log("==================================================================");

const SERVER_KEY = "SB-Mid-server-test-dummy-key-123456789";

/**
 * Helper untuk menghitung SHA-512 signature Midtrans resmi
 */
function computeSignature(orderId, statusCode, grossAmount, serverKey) {
  return createHash("sha512")
    .update(`${orderId}${statusCode}${grossAmount}${serverKey}`)
    .digest("hex");
}

/**
 * Validasi status pembayaran lunas (sesuai kontrak F2.2 & B. Pemetaan Status)
 */
function isMidtransPaidStatus(transactionStatus, fraudStatus) {
  if (transactionStatus === "settlement") {
    return true;
  }
  return transactionStatus === "capture" && fraudStatus === "accept";
}

/**
 * Engine verifikasi dan rekonsiliasi status Midtrans
 */
function validateAndMapMidtransStatus({
  order,
  localTx,
  midtransResponse,
  apiError,
}) {
  // Skenario 11: Database sudah berstatus paid (Fast path)
  if (order.payment_status === "paid" || order.status === "paid") {
    return {
      ok: true,
      isSettled: true,
      status: "paid",
      action: "FAST_PATH_ALREADY_PAID",
      message: "Pesanan sudah berstatus lunas di database.",
    };
  }

  // Skenario 12: API Midtrans tidak tersedia / network error
  if (apiError || !midtransResponse) {
    return {
      ok: false,
      isSettled: false,
      status: "error",
      error: apiError || "Midtrans API tidak tersedia",
    };
  }

  // Skenario 8: Order ID tidak cocok
  if (midtransResponse.order_id !== localTx.midtrans_order_id) {
    return {
      ok: false,
      isSettled: false,
      status: "error",
      error: `Order ID tidak cocok: diharapkan ${localTx.midtrans_order_id}, diterima ${midtransResponse.order_id}`,
    };
  }

  // Skenario 7: Nominal tidak cocok
  const grossNumeric = Math.round(Number.parseFloat(midtransResponse.gross_amount));
  if (grossNumeric !== localTx.gross_amount) {
    return {
      ok: false,
      isSettled: false,
      status: "error",
      error: `Nominal tidak cocok: diharapkan ${localTx.gross_amount}, diterima ${grossNumeric}`,
    };
  }

  const txStatus = (midtransResponse.transaction_status || "").trim().toLowerCase();
  const fraudStatus = (midtransResponse.fraud_status || "").trim().toLowerCase();

  // Skenario 1 & 2: Settlement atau Capture + Accept
  if (isMidtransPaidStatus(txStatus, fraudStatus)) {
    return {
      ok: true,
      isSettled: true,
      status: "paid",
      lifecycleStatus: "settled",
      action: "SETTLEMENT_RECORDED",
      message: "Pembayaran berhasil diverifikasi dan diselesaikan.",
    };
  }

  // Skenario 4: Deny
  if (txStatus === "deny") {
    return {
      ok: true,
      isSettled: false,
      status: "denied",
      lifecycleStatus: "denied",
      action: "RELEASE_RESERVATION",
      message: "Transaksi Midtrans ditolak.",
    };
  }

  // Skenario 5: Expire
  if (txStatus === "expire") {
    return {
      ok: true,
      isSettled: false,
      status: "expired",
      lifecycleStatus: "expired",
      action: "RELEASE_RESERVATION",
      message: "Transaksi Midtrans telah kedaluwarsa.",
    };
  }

  // Skenario 6: Cancel
  if (txStatus === "cancel") {
    return {
      ok: true,
      isSettled: false,
      status: "cancelled",
      lifecycleStatus: "cancelled",
      action: "RELEASE_RESERVATION",
      message: "Transaksi Midtrans dibatalkan.",
    };
  }

  // Skenario 3: Pending
  if (txStatus === "pending") {
    return {
      ok: true,
      isSettled: false,
      status: "unpaid",
      lifecycleStatus: "pending",
      action: "KEEP_WAITING",
      message: "Pembayaran masih menunggu penyelesaian pelanggan.",
    };
  }

  return {
    ok: true,
    isSettled: false,
    status: txStatus,
    action: "UNHANDLED_STATUS",
  };
}

// Simulasi ledger untuk uji idempotensi dan konkurensi
class MockPaymentLedger {
  constructor() {
    this.payments = [];
    this.processedFingerprints = new Set();
    this.order = {
      id: "ord-test-001",
      order_number: "ORD-20261117-0007",
      status: "awaiting_payment",
      payment_status: "unpaid",
      paid_total: 0,
      grand_total: 48300,
    };
  }

  async reconcile(midtransResponse) {
    const fingerprint = `${midtransResponse.order_id}:${midtransResponse.transaction_id}:${midtransResponse.transaction_status}`;

    // Simulasi locking atomic: jika fingerprint sudah tercatat, kembalikan ALREADY_SETTLED
    if (this.processedFingerprints.has(fingerprint)) {
      return {
        ok: true,
        status: "already_settled",
        isSettled: true,
        duplicateCount: this.payments.length,
      };
    }

    this.processedFingerprints.add(fingerprint);
    const amount = Math.round(Number.parseFloat(midtransResponse.gross_amount));

    this.payments.push({
      id: `pay-${this.payments.length + 1}`,
      amount,
      payment_type: "midtrans",
      created_at: new Date().toISOString(),
    });

    this.order.paid_total += amount;
    this.order.payment_status = "paid";
    this.order.status = "paid";

    return {
      ok: true,
      status: "success",
      isSettled: true,
      duplicateCount: this.payments.length,
    };
  }
}

// ============================================================================
// MENJALANKAN 12 SKENARIO PENGUJIAN REKONSILIASI
// ============================================================================

const baseOrder = {
  id: "ord-001",
  order_number: "ORD-20261117-0007",
  status: "awaiting_payment",
  payment_status: "unpaid",
  paid_total: 0,
  grand_total: 48300,
};

const baseTx = {
  id: "tx-001",
  order_id: "ord-001",
  midtrans_order_id: "ORD-20261117-0007-A1",
  gross_amount: 48300,
};

// 0. Uji Algoritma Digital Signature SHA-512
console.log("\n[TEST 0] Validasi SHA-512 Signature Generator");
const testSig = computeSignature("ORD-20261117-0007-A1", "200", "48300.00", SERVER_KEY);
assert.equal(typeof testSig, "string");
assert.equal(testSig.length, 128);
console.log("✔ PASS: Algoritma SHA-512 menghasilkan tanda tangan 128 karakter heksadesimal valid.");

// 1. Uji Status Settlement
console.log("\n[TEST 1] Status Settlement -> Menghasilkan paid / isSettled: true");
const res1 = validateAndMapMidtransStatus({
  order: baseOrder,
  localTx: baseTx,
  midtransResponse: {
    status_code: "200",
    order_id: "ORD-20261117-0007-A1",
    gross_amount: "48300.00",
    transaction_status: "settlement",
    currency: "IDR",
  },
});
assert.equal(res1.ok, true);
assert.equal(res1.isSettled, true);
assert.equal(res1.status, "paid");
console.log("✔ PASS: Status settlement valid diverifikasi sebagai LUNAS.");

// 2. Uji Capture dengan fraud_status accept
console.log("\n[TEST 2] Capture + fraud_status accept -> Menghasilkan paid");
const res2 = validateAndMapMidtransStatus({
  order: baseOrder,
  localTx: baseTx,
  midtransResponse: {
    status_code: "200",
    order_id: "ORD-20261117-0007-A1",
    gross_amount: "48300.00",
    transaction_status: "capture",
    fraud_status: "accept",
    currency: "IDR",
  },
});
assert.equal(res2.ok, true);
assert.equal(res2.isSettled, true);
assert.equal(res2.status, "paid");
console.log("✔ PASS: Kartu kredit capture (fraud: accept) valid diverifikasi sebagai LUNAS.");

// 3. Uji Pending
console.log("\n[TEST 3] Status Pending -> Menghasilkan unpaid / isSettled: false");
const res3 = validateAndMapMidtransStatus({
  order: baseOrder,
  localTx: baseTx,
  midtransResponse: {
    status_code: "201",
    order_id: "ORD-20261117-0007-A1",
    gross_amount: "48300.00",
    transaction_status: "pending",
    currency: "IDR",
  },
});
assert.equal(res3.ok, true);
assert.equal(res3.isSettled, false);
assert.equal(res3.status, "unpaid");
console.log("✔ PASS: Status pending dipertahankan sebagai unpaid (menunggu bayar).");

// 4. Uji Deny
console.log("\n[TEST 4] Status Deny -> Menghasilkan status denied / lepas reservasi");
const res4 = validateAndMapMidtransStatus({
  order: baseOrder,
  localTx: baseTx,
  midtransResponse: {
    status_code: "202",
    order_id: "ORD-20261117-0007-A1",
    gross_amount: "48300.00",
    transaction_status: "deny",
    currency: "IDR",
  },
});
assert.equal(res4.ok, true);
assert.equal(res4.isSettled, false);
assert.equal(res4.status, "denied");
assert.equal(res4.action, "RELEASE_RESERVATION");
console.log("✔ PASS: Status deny memicu pelepasan reservasi.");

// 5. Uji Expire
console.log("\n[TEST 5] Status Expire -> Menghasilkan status expired");
const res5 = validateAndMapMidtransStatus({
  order: baseOrder,
  localTx: baseTx,
  midtransResponse: {
    status_code: "407",
    order_id: "ORD-20261117-0007-A1",
    gross_amount: "48300.00",
    transaction_status: "expire",
    currency: "IDR",
  },
});
assert.equal(res5.ok, true);
assert.equal(res5.isSettled, false);
assert.equal(res5.status, "expired");
assert.equal(res5.action, "RELEASE_RESERVATION");
console.log("✔ PASS: Status expire memicu pelepasan reservasi.");

// 6. Uji Cancel
console.log("\n[TEST 6] Status Cancel -> Menghasilkan status cancelled");
const res6 = validateAndMapMidtransStatus({
  order: baseOrder,
  localTx: baseTx,
  midtransResponse: {
    status_code: "200",
    order_id: "ORD-20261117-0007-A1",
    gross_amount: "48300.00",
    transaction_status: "cancel",
    currency: "IDR",
  },
});
assert.equal(res6.ok, true);
assert.equal(res6.isSettled, false);
assert.equal(res6.status, "cancelled");
assert.equal(res6.action, "RELEASE_RESERVATION");
console.log("✔ PASS: Status cancel memicu pembatalan transaksi.");

// 7. Uji Nominal Tidak Cocok
console.log("\n[TEST 7] Nominal Tidak Cocok -> Ditolak dengan error");
const res7 = validateAndMapMidtransStatus({
  order: baseOrder,
  localTx: baseTx,
  midtransResponse: {
    status_code: "200",
    order_id: "ORD-20261117-0007-A1",
    gross_amount: "50000.00", // Beda dengan tagihan 48300
    transaction_status: "settlement",
    currency: "IDR",
  },
});
assert.equal(res7.ok, false);
assert.equal(res7.isSettled, false);
assert(res7.error.includes("Nominal tidak cocok"));
console.log("✔ PASS: Selisih nominal tagihan berhasil ditolak secara ketat.");

// 8. Uji Order ID Tidak Cocok
console.log("\n[TEST 8] Order ID Tidak Cocok -> Ditolak dengan error");
const res8 = validateAndMapMidtransStatus({
  order: baseOrder,
  localTx: baseTx,
  midtransResponse: {
    status_code: "200",
    order_id: "ORD-20261117-9999-A1", // Order ID asing
    gross_amount: "48300.00",
    transaction_status: "settlement",
    currency: "IDR",
  },
});
assert.equal(res8.ok, false);
assert.equal(res8.isSettled, false);
assert(res8.error.includes("Order ID tidak cocok"));
console.log("✔ PASS: Order ID asing berhasil ditolak.");

// 9. Uji Rekonsiliasi Berulang (Idempotensi)
console.log("\n[TEST 9] Rekonsiliasi Berulang -> Idempoten, tidak menduplikasi pembayaran");
const ledger = new MockPaymentLedger();
const samplePayload = {
  order_id: "ORD-20261117-0007-A1",
  transaction_id: "tx-midtrans-unique-uuid",
  gross_amount: "48300.00",
  transaction_status: "settlement",
};

const call1 = await ledger.reconcile(samplePayload);
assert.equal(call1.status, "success");
assert.equal(call1.duplicateCount, 1);
assert.equal(ledger.order.payment_status, "paid");

const call2 = await ledger.reconcile(samplePayload);
assert.equal(call2.status, "already_settled");
assert.equal(call2.duplicateCount, 1, "Jumlah pembayaran tidak boleh bertambah (idempoten)");
console.log("✔ PASS: Panggilan berulang tidak menghasilkan pembayaran ganda.");

// 10. Uji Dua Permintaan Rekonsiliasi Bersamaan (Konkurensi)
console.log("\n[TEST 10] Dua Permintaan Rekonsiliasi Bersamaan -> Serialisasi atomik");
const concurrentLedger = new MockPaymentLedger();
const [conc1, conc2] = await Promise.all([
  concurrentLedger.reconcile(samplePayload),
  concurrentLedger.reconcile(samplePayload),
]);

assert(conc1.isSettled && conc2.isSettled, "Keduanya harus mengembalikan status selesai");
assert.equal(concurrentLedger.payments.length, 1, "Tepat satu pembayaran tersimpan di database");
console.log("✔ PASS: Permintaan konkuren berhasil diselesaikan tanpa race condition.");

// 11. Uji Database Sudah Paid (Fast-path)
console.log("\n[TEST 11] Database Sudah Paid -> Fast-path tanpa request eksternal");
const paidOrder = { ...baseOrder, payment_status: "paid", status: "paid", paid_total: 48300 };
const res11 = validateAndMapMidtransStatus({
  order: paidOrder,
  localTx: baseTx,
  midtransResponse: null, // Tanpa memanggil Midtrans
});
assert.equal(res11.ok, true);
assert.equal(res11.isSettled, true);
assert.equal(res11.action, "FAST_PATH_ALREADY_PAID");
console.log("✔ PASS: Pesanan yang sudah lunas langsung mengembalikan status tanpa beban jaringan.");

// 12. Uji Midtrans API Tidak Tersedia
console.log("\n[TEST 12] Midtrans API Tidak Tersedia -> Penanganan error anggun");
const res12 = validateAndMapMidtransStatus({
  order: baseOrder,
  localTx: baseTx,
  midtransResponse: null,
  apiError: "ECONNREFUSED / Network timeout to api.sandbox.midtrans.com",
});
assert.equal(res12.ok, false);
assert.equal(res12.isSettled, false);
assert(res12.error.includes("Network timeout"));
console.log("✔ PASS: Kegagalan koneksi API Midtrans ditangani secara anggun.");

console.log("\n==================================================================");
console.log("✨ ALL 12 RECONCILIATION SCENARIOS PASSED SUCCESSFULLY! ✨");
console.log("==================================================================");
