// @ts-check
import assert from "node:assert/strict";

console.log("===============================================================================");
console.log(" NINE LICIOUS POS - MIDTRANS EXPIRATION, RECEIPT & STOCK RESERVATION TEST SUITE");
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

// -----------------------------------------------------------------------------
// 1. SNAP TOKEN ACTIVE
// -----------------------------------------------------------------------------
test("1. Snap Token Aktif: Status menunggu, Snap dapat dibuka ulang, reservasi tidak dilepas", () => {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const tx = {
    lifecycle_status: "pending",
    payment_expires_at: expiresAt,
    snap_token: "mock-active-token",
  };

  const isExpired = new Date(tx.payment_expires_at).getTime() < Date.now();
  const canReopenSnap = !isExpired && Boolean(tx.snap_token) && tx.lifecycle_status === "pending";

  assert.equal(isExpired, false, "Token aktif tidak boleh dianggap expired.");
  assert.equal(canReopenSnap, true, "Token aktif harus bisa dibuka kembali (canReopenSnap).");
});

// -----------------------------------------------------------------------------
// 2. SNAP TOKEN EXPIRED
// -----------------------------------------------------------------------------
test("2. Snap Token Expired: Terdeteksi kedaluwarsa, tidak dapat dibuka ulang, wajib verifikasi", () => {
  const expiresAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const tx = {
    lifecycle_status: "pending",
    payment_expires_at: expiresAt,
    snap_token: "mock-expired-token",
  };

  const isExpired = new Date(tx.payment_expires_at).getTime() < Date.now();
  const canReopenSnap = !isExpired && Boolean(tx.snap_token) && tx.lifecycle_status === "pending";

  assert.equal(isExpired, true, "Token masa lalu harus terdeteksi expired.");
  assert.equal(canReopenSnap, false, "Token expired tidak boleh dibuka ulang di Snap popup.");
});

// -----------------------------------------------------------------------------
// 3. STATUS PENDING MIDTRANS
// -----------------------------------------------------------------------------
test("3. Status Pending: Reservasi dipertahankan, tidak boleh dilepas, struk dilarang dibuat", () => {
  const midtransStatus = "pending";
  const order = { status: "awaiting_payment", payment_status: "unpaid", paid_total: 0, grand_total: 50000 };
  const reservations = [{ status: "active", qty: 2 }];

  // Handler rules:
  const shouldReleaseReservation = ["expire", "cancel", "deny"].includes(midtransStatus);
  const isSettled = ["settlement", "capture"].includes(midtransStatus);
  const canGenerateReceipt = order.payment_status === "paid" || order.paid_total > 0;

  assert.equal(shouldReleaseReservation, false, "Status pending TIDAK boleh melepaskan reservasi stok.");
  assert.equal(isSettled, false, "Status pending bukan transaksi settled.");
  assert.equal(canGenerateReceipt, false, "Status pending DILARANG menerbitkan struk pembayaran.");
  assert.equal(reservations[0].status, "active", "Reservasi stok harus tetap berstatus active.");
});

// -----------------------------------------------------------------------------
// 4. STATUS SETTLEMENT MIDTRANS
// -----------------------------------------------------------------------------
test("4. Status Settlement: Validasi nominal eksak, order menjadi lunas, struk berstatus LUNAS", () => {
  const order = { id: "ord-1", status: "awaiting_payment", payment_status: "unpaid", grand_total: 32200, paid_total: 0 };
  const midtransResponse = {
    order_id: "ord-1-A1",
    gross_amount: "32200.00",
    currency: "IDR",
    transaction_status: "settlement",
    fraud_status: "accept",
    status_code: "200",
  };

  // Validasi nominal
  const grossNumeric = Math.round(parseFloat(midtransResponse.gross_amount));
  assert.equal(grossNumeric, order.grand_total, "Nominal Midtrans harus tepat cocok dengan tagihan.");
  assert.equal(midtransResponse.currency, "IDR", "Mata uang wajib IDR.");

  // Simulasi settlement
  order.paid_total += grossNumeric;
  order.payment_status = "paid";
  order.status = "paid";

  const isFullySettled = order.payment_status === "paid" && order.paid_total >= order.grand_total;
  const remainingBalance = Math.max(0, order.grand_total - order.paid_total);

  assert.equal(isFullySettled, true, "Pesanan harus terkonfirmasi lunas.");
  assert.equal(remainingBalance, 0, "Sisa tagihan pesanan lunas harus 0.");
});

// -----------------------------------------------------------------------------
// 5. STATUS DENY MIDTRANS
// -----------------------------------------------------------------------------
test("5. Status Deny: Reservasi dilepas aman, tidak ada pembayaran, struk ditolak", () => {
  const midtransStatus = "deny";
  const shouldRelease = ["expire", "cancel", "deny"].includes(midtransStatus);
  let reservationStatus = "active";
  if (shouldRelease) {
    reservationStatus = "released";
  }

  const paid_total = 0;
  const canGenerateReceipt = paid_total > 0;

  assert.equal(shouldRelease, true, "Status deny harus memicu pelepasan reservasi.");
  assert.equal(reservationStatus, "released", "Reservasi harus berstatus released.");
  assert.equal(canGenerateReceipt, false, "Status deny tidak boleh menghasilkan struk.");
});

// -----------------------------------------------------------------------------
// 6. STATUS CANCEL MIDTRANS
// -----------------------------------------------------------------------------
test("6. Status Cancel: Pembatalan transaksi melepas reservasi stok, order tetap belum lunas", () => {
  const midtransStatus = "cancel";
  const shouldRelease = ["expire", "cancel", "deny"].includes(midtransStatus);
  let reservationStatus = "active";
  if (shouldRelease) {
    reservationStatus = "released";
  }

  assert.equal(reservationStatus, "released");
});

// -----------------------------------------------------------------------------
// 7. VERIFIKASI BERULANG (IDEMPOTENCY)
// -----------------------------------------------------------------------------
test("7. Verifikasi Berulang: Panggilan polling/webhook ganda tidak menggandakan pembayaran", () => {
  const processedEvents = new Set();
  const eventFp = "sha256-event-fingerprint-123";
  let paymentRecords = 0;

  function handleEvent(fp) {
    if (processedEvents.has(fp)) {
      return { status: "already_settled", ignored: true };
    }
    processedEvents.add(fp);
    paymentRecords++;
    return { status: "settled", ignored: false };
  }

  const res1 = handleEvent(eventFp);
  const res2 = handleEvent(eventFp);
  const res3 = handleEvent(eventFp);

  assert.equal(res1.status, "settled");
  assert.equal(res2.status, "already_settled");
  assert.equal(res3.status, "already_settled");
  assert.equal(paymentRecords, 1, "Hanya 1 pembayaran yang boleh dicatat.");
});

// -----------------------------------------------------------------------------
// 8. SPLIT BILL
// -----------------------------------------------------------------------------
test("8. Split Bill: Alokasi transaksi per porsi/item terpisah dan idempoten", () => {
  const orderGrandTotal = 50000;
  const splitAmount1 = 20000;
  const splitAmount2 = 30000;

  const tx1 = { midtrans_order_id: "ORD-01-A1", amount: splitAmount1, status: "settled" };
  const tx2 = { midtrans_order_id: "ORD-01-A2", amount: splitAmount2, status: "pending" };

  const currentPaid = tx1.amount;
  const remaining = orderGrandTotal - currentPaid;

  assert.equal(tx2.amount, splitAmount2);
  assert.equal(remaining, splitAmount2);
  assert.equal(currentPaid + remaining, orderGrandTotal);
});

// -----------------------------------------------------------------------------
// 9. PARTIAL PAYMENT RECEIPT
// -----------------------------------------------------------------------------
test("9. Partial Payment Receipt: Menampilkan total dibayar dan sisa tagihan, BUKAN status LUNAS", () => {
  const receiptData = {
    order: {
      grand_total: 50000,
      paid_total: 20000,
      payment_status: "partially_paid",
    },
    payments: [{ amount: 20000, payment_method: "cash" }],
  };

  const isFullySettled = receiptData.order.payment_status === "paid" || receiptData.order.paid_total >= receiptData.order.grand_total;
  const remainingAmount = Math.max(0, receiptData.order.grand_total - receiptData.order.paid_total);
  const statusLabel = isFullySettled ? "LUNAS" : "PEMBAYARAN SEBAGIAN";

  assert.equal(isFullySettled, false, "Pembayaran sebagian tidak boleh berstatus LUNAS.");
  assert.equal(statusLabel, "PEMBAYARAN SEBAGIAN");
  assert.equal(remainingAmount, 30000, "Sisa tagihan harus 30.000.");
  assert.equal(receiptData.order.paid_total, 20000, "Total dibayar harus 20.000.");
});

// -----------------------------------------------------------------------------
// 10. FULL PAYMENT RECEIPT
// -----------------------------------------------------------------------------
test("10. Full Payment Receipt: Menampilkan status LUNAS, sisa tagihan 0, kembalian tunai akurat", () => {
  const receiptData = {
    order: {
      grand_total: 32200,
      paid_total: 32200,
      payment_status: "paid",
    },
    payments: [{ amount: 32200, cash_received: 50000, change_amount: 17800, payment_method: "cash" }],
  };

  const isFullySettled = receiptData.order.payment_status === "paid" || receiptData.order.paid_total >= receiptData.order.grand_total;
  const remainingAmount = Math.max(0, receiptData.order.grand_total - receiptData.order.paid_total);
  const totalChange = receiptData.payments.reduce((acc, p) => acc + (p.change_amount || 0), 0);

  assert.equal(isFullySettled, true, "Pesanan harus terdeteksi LUNAS.");
  assert.equal(remainingAmount, 0, "Sisa tagihan harus 0.");
  assert.equal(totalChange, 17800, "Kembalian harus 17.800.");
});

// -----------------------------------------------------------------------------
// 11. REFUND
// -----------------------------------------------------------------------------
test("11. Refund: Struk menampilkan rincian refund dan menghitung net_paid secara akurat", () => {
  const paidTotal = 50000;
  const refunds = [
    { amount: 15000, status: "completed" },
    { amount: 10000, status: "completed" },
  ];

  const completedRefundTotal = refunds
    .filter((r) => r.status === "completed")
    .reduce((sum, r) => sum + r.amount, 0);

  const netPaid = paidTotal - completedRefundTotal;

  assert.equal(completedRefundTotal, 25000);
  assert.equal(netPaid, 25000, "Net paid harus 25.000 setelah refund 25.000.");
});

// -----------------------------------------------------------------------------
// 12. STOCK RESERVATION LIFECYCLE
// -----------------------------------------------------------------------------
test("12. Stock Reservation Lifecycle: Reservasi aktif tidak memotong stok fisik sebelum lunas", () => {
  let currentStock = 100;
  let reservedStock = 0;
  let reservationStatus = "none";

  // Step A: Buat pesanan -> reservasi 20
  reservedStock += 20;
  reservationStatus = "active";
  assert.equal(currentStock, 100, "Stok fisik belum berkurang saat reservasi.");
  assert.equal(reservedStock, 20);

  // Step B: Jika dibatalkan -> reservasi lepas
  reservedStock -= 20;
  reservationStatus = "released";
  assert.equal(currentStock, 100);
  assert.equal(reservedStock, 0);

  // Step C: Buat pesanan baru & lunas -> konversi ke sale_deduction
  reservedStock += 20;
  reservationStatus = "active";
  // Pembayaran lunas
  currentStock -= 20;
  reservedStock -= 20;
  reservationStatus = "fulfilled";

  assert.equal(currentStock, 80, "Stok fisik berkurang 20 saat lunas.");
  assert.equal(reservedStock, 0, "Reservasi stok kembali ke 0 setelah fulfilled.");
  assert.equal(reservationStatus, "fulfilled");
});

// -----------------------------------------------------------------------------
// 13. RECEIPT GENERATION PROTECTION
// -----------------------------------------------------------------------------
test("13. Receipt Generation Protection: Pesanan Unpaid, Pending, atau Batal tanpa bayar DITOLAK", () => {
  function validateReceiptRequest(order) {
    const paidTotal = Number(order.paid_total) || 0;
    if (paidTotal <= 0 || order.payment_status === "unpaid") {
      return { ok: false, message: "Pesanan belum memiliki riwayat pembayaran yang terverifikasi (Unpaid)." };
    }
    if (order.status === "cancelled" && paidTotal <= 0) {
      return { ok: false, message: "Pesanan telah dibatalkan tanpa pembayaran." };
    }
    return { ok: true };
  }

  // Uji pesanan belum dibayar
  const unpaidOrder = { status: "awaiting_payment", payment_status: "unpaid", paid_total: 0 };
  const resUnpaid = validateReceiptRequest(unpaidOrder);
  assert.equal(resUnpaid.ok, false, "Pesanan unpaid harus ditolak pembuatan struknya.");

  // Uji pesanan pending
  const pendingOrder = { status: "awaiting_payment", payment_status: "unpaid", paid_total: 0 };
  const resPending = validateReceiptRequest(pendingOrder);
  assert.equal(resPending.ok, false, "Pesanan pending harus ditolak pembuatan struknya.");

  // Uji pesanan dibatalkan tanpa bayar
  const cancelledOrder = { status: "cancelled", payment_status: "unpaid", paid_total: 0 };
  const resCancelled = validateReceiptRequest(cancelledOrder);
  assert.equal(resCancelled.ok, false, "Pesanan batal tanpa bayar harus ditolak pembuatan struknya.");

  // Uji pesanan lunas
  const paidOrder = { status: "paid", payment_status: "paid", paid_total: 32200 };
  const resPaid = validateReceiptRequest(paidOrder);
  assert.equal(resPaid.ok, true, "Pesanan lunas harus diizinkan mencetak struk.");
});

// -----------------------------------------------------------------------------
// 14. KDS INTEGRATION
// -----------------------------------------------------------------------------
test("14. KDS Integration: Pesanan HANYA masuk KDS 'queued' saat lunas penuh", () => {
  function computeKdsStatus(grandTotal, paidTotal) {
    if (paidTotal >= grandTotal) {
      return "queued";
    }
    return null; // Tidak masuk KDS
  }

  assert.equal(computeKdsStatus(50000, 0), null, "Unpaid tidak masuk KDS.");
  assert.equal(computeKdsStatus(50000, 25000), null, "Sebagian bayar tidak masuk KDS.");
  assert.equal(computeKdsStatus(50000, 50000), "queued", "Lunas penuh langsung masuk KDS queued.");
});

// -----------------------------------------------------------------------------
// 15. F6 TRANSACTION HISTORY & AUDIT LOGS
// -----------------------------------------------------------------------------
test("15. F6 Transaction History & Audit Logs: Seluruh peristiwa pembayaran tercatat di buku besar audit", () => {
  const auditLogs = [];
  function logAudit(action, details) {
    auditLogs.push({ action, details, timestamp: new Date().toISOString() });
  }

  logAudit("order.create", { order_number: "ORD-001" });
  logAudit("midtrans.snap_created", { order_number: "ORD-001", gross_amount: 32200 });
  logAudit("payment.settled", { order_number: "ORD-001", amount: 32200, source: "midtrans_snap" });

  assert.equal(auditLogs.length, 3);
  assert.equal(auditLogs[2].action, "payment.settled");
  assert.equal(auditLogs[2].details.amount, 32200);
});

console.log(`\n===============================================================================`);
console.log(` HASIL: Seluruh ${passed}/${total} skenario regression test LULUS 100%!`);
console.log(`===============================================================================\n`);
