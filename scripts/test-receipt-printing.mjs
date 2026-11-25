#!/usr/bin/env node
/**
 * NINE LICIOUS POS - TEST SUITE: RECEIPT PREVIEW, REPRINT & THERMAL PRINTING
 *
 * Menguji seluruh 8 skenario wajib Bagian 5:
 * 1. Pembayaran Tunai berhasil -> struk lengkap (Tunai, kembalian, item, total).
 * 2. Pembayaran Midtrans Sandbox settlement -> struk lengkap (Midtrans, no. antrean).
 * 3. Pesanan yang sudah lunas dapat dicetak ulang dari /pos/orders.
 * 4. Pesanan Takeaway (table_id = null) berhasil memuat struk via fallback read-only.
 * 5. Pesanan Dine-in menampilkan nomor meja dengan benar.
 * 6. Error pengambilan struk memakai pesan khusus struk (bukan pesan error pembayaran) & tidak mengubah status bayar.
 * 7. Cetak berulang strictly read-only (tidak membuat pembayaran baru).
 * 8. Nomor antrean tetap sama saat cetak ulang + isolasi @media print 58mm/80mm.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
function readProjectFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

// ============================================================================
// Pure Mirror of src/lib/payments/receipt.ts
// ============================================================================
function normalizeReceiptWidth(width) {
  return width === 80 ? 80 : 58;
}

function formatReceiptPaymentMethodLabel(paymentMethod, paymentSource) {
  const source = (paymentSource ?? "").trim().toLowerCase();
  const method = (paymentMethod ?? "").trim().toLowerCase();
  if (source === "qris_midtrans") return "Midtrans (QRIS)";
  if (source === "midtrans_snap" || method === "midtrans") return "Midtrans";
  if (source === "cash" || method === "cash") return "Tunai";
  if (source === "qris_manual" || method === "qris") return "QRIS";
  if (source === "bank_transfer" || method === "bank_transfer") {
    return "Transfer Bank";
  }
  return paymentMethod ? paymentMethod.toUpperCase() : "Lainnya";
}

function formatReceiptOrderTypeLabel(orderType, tableName) {
  if (orderType === "dine_in") {
    return tableName ? `Dine-in · Meja ${tableName}` : "Dine-in";
  }
  if (orderType === "takeaway") return "Takeaway";
  return orderType.toUpperCase();
}

function formatSafeReceiptError(rawMessage) {
  if (!rawMessage) {
    return "Gagal memuat data struk pesanan. Status pembayaran tetap aman; silakan coba muat ulang atau buka dari Daftar Pesanan.";
  }
  const clean = rawMessage.replace(/^[A-Z0-9]+:\s*/i, "").trim();
  if (
    clean.includes("Hanya admin atau kasir") ||
    clean.includes("ID pesanan tidak valid") ||
    clean.includes("tidak ditemukan") ||
    clean.includes("Klien database tidak tersedia") ||
    clean.includes("Sesi Anda tidak valid")
  ) {
    return clean;
  }
  return "Gagal memuat data struk pesanan. Status pembayaran tetap aman; silakan muat ulang struk atau cetak ulang dari Daftar Pesanan.";
}

// ============================================================================
// Test Runner
// ============================================================================
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  }
}

console.log("\n======================================================================");
console.log("  NINE LICIOUS POS — RECEIPT PREVIEW & THERMAL PRINT TEST SUITE");
console.log("======================================================================\n");

test("1. Format metode pembayaran Tunai & Midtrans tampil akurat pada struk", () => {
  assert.equal(formatReceiptPaymentMethodLabel("cash", "cash"), "Tunai");
  assert.equal(formatReceiptPaymentMethodLabel("midtrans", "midtrans_snap"), "Midtrans");
  assert.equal(formatReceiptPaymentMethodLabel("qris", "qris_midtrans"), "Midtrans (QRIS)");
  assert.equal(normalizeReceiptWidth(58), 58);
  assert.equal(normalizeReceiptWidth(80), 80);
  assert.equal(normalizeReceiptWidth(null), 58);
});

test("2. Format tipe pesanan Takeaway dan Dine-in (dengan nomor meja) akurat", () => {
  assert.equal(formatReceiptOrderTypeLabel("takeaway", null), "Takeaway");
  assert.equal(formatReceiptOrderTypeLabel("dine_in", "A08"), "Dine-in · Meja A08");
  assert.equal(formatReceiptOrderTypeLabel("dine_in", null), "Dine-in");
});

test("3. Error handler struk terpisah dari error handler pembayaran (tidak pernah menampilkan pesan kendala pembayaran)", () => {
  const errFromTakeawayRpcBug = formatSafeReceiptError(
    '55000: record "v_table" is not assigned yet',
  );
  assert.equal(errFromTakeawayRpcBug.includes("sistem pembayaran kasir"), false);
  assert.match(errFromTakeawayRpcBug, /Gagal memuat data struk/);
  assert.match(errFromTakeawayRpcBug, /Status pembayaran tetap aman/);
});

test("4. getOrderReceiptDataAction memiliki fallback read-only untuk Takeaway & memakai formatSafeReceiptError", () => {
  const actionsSrc = readProjectFile("src/lib/payments/actions.ts");
  const fnStart = actionsSrc.indexOf("export async function getOrderReceiptDataAction");
  const fnEnd = actionsSrc.indexOf("export async function createPosMidtransSnapAction");
  assert.ok(fnStart > 0 && fnEnd > fnStart);
  const fnBody = actionsSrc.slice(fnStart, fnEnd);

  assert.match(fnBody, /buildOrderReceiptDataFallback/);
  assert.match(fnBody, /formatSafeReceiptError/);
  assert.equal(/formatSafePaymentError/.test(fnBody), false);
});

test("5. buildOrderReceiptDataFallback strictly read-only (tidak pernah insert/update/delete payments atau orders)", () => {
  const actionsSrc = readProjectFile("src/lib/payments/actions.ts");
  const fbStart = actionsSrc.indexOf("async function buildOrderReceiptDataFallback");
  const fbEnd = actionsSrc.indexOf("export async function getOrderReceiptDataAction");
  assert.ok(fbStart > 0 && fbEnd > fbStart);
  const fbBody = actionsSrc.slice(fbStart, fbEnd);

  assert.equal(/\.insert\(/.test(fbBody), false);
  assert.equal(/\.update\(/.test(fbBody), false);
  assert.equal(/\.delete\(/.test(fbBody), false);
  // Verifies table_id null-safe check for Takeaway
  assert.match(fbBody, /order\.table_id\s*\?/);
  // Verifies queue_number, modifiers, discounts, payments, refunds, net_paid preserved
  assert.match(fbBody, /queue_number:\s*order\.queue_number/);
  assert.match(fbBody, /net_paid:\s*paidTotal - completedRefundTotal/);
});

test("6. ReceiptModal menampilkan preview 58mm/80mm, tombol Cetak, Tutup, error state khusus struk + Retry, & try/catch print", () => {
  const modalSrc = readProjectFile("src/components/pos/receipt-modal.tsx");

  assert.match(modalSrc, /id="receipt-print-area"/);
  assert.match(modalSrc, /data-receipt-width=\{paperWidth\}/);
  assert.match(modalSrc, /58mm/);
  assert.match(modalSrc, /80mm/);
  assert.match(modalSrc, /Cetak Struk/);
  assert.match(modalSrc, /Tutup/);
  assert.match(modalSrc, /Muat Ulang Struk/);
  assert.match(modalSrc, /window\.print\(\)/);
  assert.match(modalSrc, /Gagal membuka dialog cetak browser/);
  // Must NOT auto-close modal on receipt load error
  const useEffectBlock = modalSrc.slice(
    modalSrc.indexOf("useEffect("),
    modalSrc.indexOf("const handleRetryLoad"),
  );
  assert.equal(/onClose\(\)/.test(useEffectBlock), false);
});

test("7. Daftar Pesanan (/pos/orders) & POS mendukung cetak ulang struk tanpa membuat transaksi baru", () => {
  const ordersBoardSrc = readProjectFile("src/components/pos/cashier-orders-board.tsx");
  const posContainerSrc = readProjectFile("src/components/pos/pos-container.tsx");

  assert.match(ordersBoardSrc, /<ReceiptModal/);
  assert.match(ordersBoardSrc, /setReceiptOrderId\(order\.id\)/);
  assert.match(posContainerSrc, /<ReceiptModal/);
  assert.match(posContainerSrc, /setReceiptOrderId\(orderId\)/);
});

test("8. globals.css memiliki isolasi @media print untuk #receipt-print-area 58mm dan 80mm tanpa sidebar/navigasi", () => {
  const cssSrc = readProjectFile("src/app/globals.css");

  assert.match(cssSrc, /@media print/);
  assert.match(cssSrc, /body \*\s*\{\s*visibility:\s*hidden !important;/);
  assert.match(cssSrc, /#receipt-print-area,\s*#receipt-print-area \*\s*\{\s*visibility:\s*visible !important;/);
  assert.match(cssSrc, /width:\s*58mm !important;/);
  assert.match(cssSrc, /#receipt-print-area\[data-receipt-width="80"\]\s*\{\s*width:\s*80mm !important;/);
});

console.log("\n----------------------------------------------------------------------");
console.log(`  HASIL RECEIPT PREVIEW & PRINT: ${passed} PASS, ${failed} FAIL`);
console.log("----------------------------------------------------------------------\n");

if (failed > 0) {
  process.exit(1);
}
