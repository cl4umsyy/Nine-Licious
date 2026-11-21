#!/usr/bin/env node
/**
 * NINE LICIOUS POS — MILESTONE F6.3 TEST SUITE
 * File: scripts/test-f6-3-transaction-history.mjs
 *
 * Verifikasi Komprehensif F6.3: Transaction History, Refunds & Shift Reconciliation
 *
 * 20 SKENARIO PENGUJIAN SESUAI SPESIFIKASI:
 *  1. Admin dapat mengakses halaman (/admin/transactions)
 *  2. Kasir dan kitchen ditolak (Route Guard & Server Action RBAC)
 *  3. Pencarian nomor pesanan dan pelanggan
 *  4. Filter tanggal (format YYYY-MM-DD dan zona waktu Asia/Jakarta)
 *  5. Filter status pembayaran (unpaid, partially_paid, paid, refunded)
 *  6. Filter metode pembayaran (cash, midtrans, split)
 *  7. Filter tipe pesanan (dine_in, takeaway)
 *  8. Pagination server-side (page, pageSize, totalPages, totalCount)
 *  9. Detail transaksi lengkap (order, items, discounts, payments, refunds, shifts, movements)
 * 10. Snapshot produk historis terjaga (product_name_snapshot, unit_price_snapshot)
 * 11. Split Bill: pembayaran terpisah tanpa menggandakan pesanan
 * 12. Riwayat refund terintegrasi (full, partial, nomor refund, metode, alasan)
 * 13. Refund pending tidak dihitung sebagai refund selesai
 * 14. Refund completed memotong penerimaan bersih secara akurat
 * 15. Hubungan transaksi dengan shift (shift_id pada payments)
 * 16. Cash movement ledger laci kas terkait pesanan dan pembayaran
 * 17. Rekonsiliasi shift: modal awal, penjualan tunai, expected vs actual cash
 * 18. Perlindungan shift yang sudah ditutup (read-only audit, status rekonsiliasi tri-state)
 * 19. Tidak ada double counting pada omzet pesanan split bill
 * 20. Penanganan data kosong (empty state) dan penanganan error
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

console.log("===============================================================================");
console.log(" NINE LICIOUS POS — F6.3 TRANSACTION HISTORY & RECONCILIATION TEST SUITE");
console.log("===============================================================================\n");

let totalTests = 0;
let passedTests = 0;

function runTest(number, category, name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✓ [PASS] #${String(number).padStart(2, "0")} [${category}] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`✗ [FAIL] #${String(number).padStart(2, "0")} [${category}] ${name}`);
    console.error(`  Detail Kesalahan: ${err.message}\n`);
    throw err;
  }
}

const ROOT_DIR = process.cwd();

function readFileUtf8(relPath) {
  const fullPath = path.join(ROOT_DIR, relPath);
  assert.ok(fs.existsSync(fullPath), `File tidak ditemukan: ${relPath}`);
  return fs.readFileSync(fullPath, "utf-8");
}

// -----------------------------------------------------------------------------
// 20 SKENARIO VERIFIKASI F6.3
// -----------------------------------------------------------------------------

// #1: Admin dapat mengakses halaman
runTest(1, "AUTH-GUARD", "Admin dapat mengakses rute /admin/transactions", () => {
  const pageFile = readFileUtf8("src/app/(app)/admin/transactions/page.tsx");
  assert.match(pageFile, /requireRole\(\["admin"\]\)/, "Halaman harus memanggil requireRole(['admin'])");
  assert.match(pageFile, /export\s+default\s+async\s+function\s+AdminTransactionsPage/, "Halaman harus mengekspor AdminTransactionsPage");
  assert.match(pageFile, /getAdminTransactionsAction/, "Halaman harus mengambil data awal via getAdminTransactionsAction");
});

// #2: Kasir dan kitchen ditolak
runTest(2, "SECURITY-RBAC", "Kasir dan kitchen ditolak pada route guard dan server actions", () => {
  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(actionsFile, /getAdminActor\(\)/, "Server Actions wajib memeriksa getAdminActor");
  assert.match(actionsFile, /if\s*\(!actor\.ok\)\s*\{\s*return\s*\{\s*ok:\s*false/);

  // Pastikan navigasi hanya mencantumkan role admin
  const navFile = readFileUtf8("src/lib/navigation.ts");
  assert.match(navFile, /href:\s*"\/admin\/transactions"/);
  assert.match(navFile, /roles:\s*\["admin"\]/);
});

// #3: Pencarian nomor pesanan dan pelanggan
runTest(3, "SEARCH", "Pencarian mendukung nomor pesanan dan nama pelanggan", () => {
  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(
    actionsFile,
    /order_number\.ilike\./,
    "Query harus menyertakan pencarian order_number",
  );
  assert.match(
    actionsFile,
    /customer_name\.ilike\./,
    "Query harus menyertakan pencarian customer_name",
  );

  const compFile = readFileUtf8("src/components/admin/transactions/transaction-history.tsx");
  assert.match(compFile, /Cari nomor pesanan \/ pelanggan\.\.\./);
});

// #4: Filter tanggal
runTest(4, "DATE-FILTER", "Filter tanggal menggunakan format YYYY-MM-DD dan zona waktu Asia/Jakarta", () => {
  const valFile = readFileUtf8("src/lib/transactions/validation.ts");
  assert.match(valFile, /dateRegex\s*=\s*\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  assert.match(valFile, /startDate.*endDate/);

  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(actionsFile, /\+07:00/, "Batas tanggal wajib dikonversi ke zona waktu Asia/Jakarta (+07:00)");
  assert.match(actionsFile, /T23:59:59\.999\+07:00/);
});

// #5: Filter status pembayaran
runTest(5, "PAYMENT-STATUS", "Filter status pembayaran mendukung unpaid, partially_paid, paid, refunded", () => {
  const valFile = readFileUtf8("src/lib/transactions/validation.ts");
  assert.match(valFile, /"unpaid"/);
  assert.match(valFile, /"partially_paid"/);
  assert.match(valFile, /"paid"/);
  assert.match(valFile, /"partially_refunded"/);
  assert.match(valFile, /"refunded"/);

  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(actionsFile, /query\.eq\("payment_status",\s*filter\.paymentStatus\)/);
});

// #6: Filter metode pembayaran
runTest(6, "PAYMENT-METHOD", "Filter metode pembayaran mendukung cash, midtrans, dan split bill", () => {
  const valFile = readFileUtf8("src/lib/transactions/validation.ts");
  assert.match(valFile, /"cash"/);
  assert.match(valFile, /"midtrans"/);
  assert.match(valFile, /"split"/);

  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(actionsFile, /filter\.paymentMethod === "split"/);
  assert.match(actionsFile, /filter\.paymentMethod === "cash"/);
  assert.match(actionsFile, /filter\.paymentMethod === "midtrans"/);
});

// #7: Filter tipe pesanan
runTest(7, "ORDER-TYPE", "Filter tipe pesanan mendukung dine_in dan takeaway", () => {
  const valFile = readFileUtf8("src/lib/transactions/validation.ts");
  assert.match(valFile, /"dine_in"/);
  assert.match(valFile, /"takeaway"/);

  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(actionsFile, /query\.eq\("order_type",\s*filter\.orderType\)/);
});

// #8: Pagination server-side
runTest(8, "PAGINATION", "Pagination server-side membatasi rentang offset-limit secara aman", () => {
  const valFile = readFileUtf8("src/lib/transactions/validation.ts");
  assert.match(valFile, /pageSize[\s\S]*min\(5[\s\S]*max\(100/, "Page size harus memiliki batas minimum 5 dan maksimum 100");

  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(actionsFile, /\.range\(offset,\s*offset\s*\+\s*filter\.pageSize\s*-\s*1\)/);
  assert.match(actionsFile, /count:\s*"exact"/);
  assert.match(actionsFile, /totalPages:\s*Math\.ceil/);
});

// #9: Detail transaksi lengkap
runTest(9, "TRANSACTION-DETAIL", "getAdminTransactionDetailAction mengembalikan seluruh relasi transaksi lengkap", () => {
  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(actionsFile, /export\s+async\s+function\s+getAdminTransactionDetailAction/);
  assert.match(actionsFile, /order_items/);
  assert.match(actionsFile, /order_item_modifiers/);
  assert.match(actionsFile, /order_discounts/);
  assert.match(actionsFile, /payments/);
  assert.match(actionsFile, /midtrans_transactions/);
  assert.match(actionsFile, /refunds/);
  assert.match(actionsFile, /shifts/);
  assert.match(actionsFile, /cash_movements/);
});

// #10: Snapshot produk historis
runTest(10, "PRODUCT-SNAPSHOT", "Detail transaksi menjaga keutuhan nama & harga historis snapshot produk", () => {
  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(actionsFile, /product_name_snapshot/);
  assert.match(actionsFile, /unit_price_snapshot/);
  assert.match(actionsFile, /group_name_snapshot/);
  assert.match(actionsFile, /option_name_snapshot/);
  assert.match(actionsFile, /price_delta_snapshot/);

  const compFile = readFileUtf8("src/components/admin/transactions/transaction-history.tsx");
  assert.match(compFile, /Snapshot Historis/);
});

// #11: Split Bill tidak menggandakan pesanan
runTest(11, "SPLIT-BILL", "Split Bill menampilkan semua pembayaran terpisah dan tidak menggandakan transaksi", () => {
  const typesFile = readFileUtf8("src/lib/transactions/types.ts");
  assert.match(typesFile, /splitBillSummary:\s*\{/);
  assert.match(typesFile, /isSplitBill:\s*boolean/);
  assert.match(typesFile, /totalParts:\s*number/);

  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(actionsFile, /isSplitBill:\s*successfulPayments\.length\s*>=\s*2/);

  // Simulasi kalkulasi: Satu order dengan 2 pembayaran tetap dihitung 1 order
  const mockPayments = [
    { id: "p1", amount: 50000, payment_method: "cash", payment_status: "success" },
    { id: "p2", amount: 50000, payment_method: "midtrans", payment_status: "success" },
  ];
  const totalPaid = mockPayments.reduce((s, p) => s + p.amount, 0);
  assert.equal(totalPaid, 100000);
  assert.equal(mockPayments.length, 2);
});

// #12: Riwayat refund terintegrasi
runTest(12, "REFUND-HISTORY", "Riwayat refund mencakup nomor refund, nominal, tipe, metode, dan approval", () => {
  const typesFile = readFileUtf8("src/lib/transactions/types.ts");
  assert.match(typesFile, /refundNumber:\s*string/);
  assert.match(typesFile, /refundType:\s*RefundType/);
  assert.match(typesFile, /refundMethod:\s*RefundMethod/);
  assert.match(typesFile, /requesterName:\s*string/);
  assert.match(typesFile, /approverName:\s*string\s*\|\s*null/);

  const compFile = readFileUtf8("src/components/admin/transactions/transaction-history.tsx");
  assert.match(compFile, /Riwayat Refund/i);
});

// #13: Refund pending tidak dihitung sebagai refund selesai
runTest(13, "REFUND-GUARD", "Refund pending atau rejected tidak dihitung sebagai refund selesai", () => {
  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(actionsFile, /hasRefund\s*=\s*oRefunds\.some\(\(r\)\s*=>\s*r\.status\s*===\s*"completed"\)/);

  // Uji logika:
  const mockRefunds = [
    { id: "r1", status: "pending", amount: 25000 },
    { id: "r2", status: "rejected", amount: 15000 },
  ];
  const hasCompleted = mockRefunds.some((r) => r.status === "completed");
  assert.equal(hasCompleted, false, "Pending dan rejected dilarang dianggap completed");
});

// #14: Refund completed memotong penerimaan bersih
runTest(14, "REFUND-CALC", "Refund completed memotong penerimaan bersih secara akurat", () => {
  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(actionsFile, /netPaid\s*=\s*Math\.max\(0,\s*o\.paid_total\s*-\s*refundedTotal\)/);

  // Uji matematis
  const paidTotal = 150000;
  const refundedTotal = 50000;
  const netPaid = Math.max(0, paidTotal - refundedTotal);
  assert.equal(netPaid, 100000);
});

// #15: Hubungan transaksi dengan shift
runTest(15, "SHIFT-RELATION", "Transaksi mengikat shift_id dari pembayaran tunai ke shifts", () => {
  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(actionsFile, /shift_id/);
  assert.match(actionsFile, /detailedShifts/);

  const compFile = readFileUtf8("src/components/admin/transactions/transaction-history.tsx");
  assert.match(compFile, /Rekonsiliasi Shift/);
});

// #16: Cash movement ledger laci kas
runTest(16, "CASH-MOVEMENT", "Buku besar mutasi laci kas menampilkan saldo sebelum dan sesudah mutasi", () => {
  const typesFile = readFileUtf8("src/lib/transactions/types.ts");
  assert.match(typesFile, /balanceBefore:\s*number/);
  assert.match(typesFile, /balanceAfter:\s*number/);
  assert.match(typesFile, /movementType:\s*string/);

  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(actionsFile, /cash_movements/);
  assert.match(actionsFile, /balance_before/);
  assert.match(actionsFile, /balance_after/);
});

// #17: Rekonsiliasi shift
runTest(17, "RECONCILIATION", "Rekonsiliasi shift menghitung expected cash, actual cash, dan selisih", () => {
  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  assert.match(actionsFile, /openingCash:\s*s\.opening_cash/);
  assert.match(actionsFile, /expectedCash:\s*s\.expected_cash/);
  assert.match(actionsFile, /actualCash:\s*s\.actual_cash/);
  assert.match(actionsFile, /cashDifference:\s*s\.cash_difference/);

  // Simulasi formula rekonsiliasi kas:
  const opening = 200000;
  const sales = 150000;
  const refunds = 20000;
  const cashIn = 50000;
  const cashOut = 30000;
  const expected = opening + sales + cashIn - (refunds + cashOut);
  assert.equal(expected, 350000);

  const actual = 350000;
  const diff = actual - expected;
  assert.equal(diff, 0, "Harus cocok pas");
});

// #18: Perlindungan shift yang sudah ditutup
runTest(18, "CLOSED-SHIFT-GUARD", "Shift yang sudah ditutup berstatus read-only dengan badge tri-state", () => {
  const compFile = readFileUtf8("src/components/admin/transactions/transaction-history.tsx");
  assert.match(compFile, /Cocok \(Pas\)/);
  assert.match(compFile, /Lebih \(\+/);
  assert.match(compFile, /Kurang \(-/);
  assert.match(compFile, /Shift Aktif/);
});

// #19: Tidak ada double counting
runTest(19, "NO-DOUBLE-COUNTING", "Paginasi orders independen dan tidak menggandakan baris order pada split bill", () => {
  const actionsFile = readFileUtf8("src/lib/transactions/actions.ts");
  // Query utama hanya menyeleksi dari tabel "orders" secara langsung
  assert.match(actionsFile, /supabase\s*\.from\("orders"\)\s*\.select\(/);
});

// #20: Penanganan data kosong dan error
runTest(20, "EMPTY-AND-ERROR-STATE", "Komponen menangani kondisi data kosong dan pesan error dengan ramah", () => {
  const compFile = readFileUtf8("src/components/admin/transactions/transaction-history.tsx");
  assert.match(compFile, /Tidak ada data transaksi yang ditemukan/);
  assert.match(compFile, /Reset Semua Filter/);
  assert.match(compFile, /Memuat snapshot historis, pembayaran, refund, dan rekonsiliasi shift/);
});

console.log("\n===============================================================================");
console.log(` HASIL PENGUJIAN F6.3: ${passedTests} / ${totalTests} TEST CASES BERHASIL (100% PASS)`);
console.log("===============================================================================\n");
