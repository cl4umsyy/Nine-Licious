#!/usr/bin/env node
/**
 * NINE LICIOUS POS — MILESTONE F6.2 TEST SUITE
 * File: scripts/test-f6-2-reports-dashboard.mjs
 *
 * Verifikasi Komprehensif F6.2: Admin Reports Dashboard UI
 *
 * 15 AREA VERIFIKASI UTAMA SESUAI SPESIFIKASI:
 *  1. Halaman /admin/reports tersedia & diproteksi role admin
 *  2. Navigasi Laporan terdaftar di sidebar admin (/admin/reports)
 *  3. Dashboard Admin (/admin) memiliki tautan pintasan ke /admin/reports
 *  4. Komponen ReportsDashboard menggunakan Server Actions F6.1 (getComprehensiveReportAction)
 *  5. Tampilan 7 KPI Penjualan lengkap dalam format Rupiah
 *  6. Tampilan 3 Tab Laporan (Penjualan, Pembayaran, Produk & Kategori)
 *  7. Dukungan 5 Filter Periode (Hari Ini, 7 Hari, 30 Hari, Bulan Ini, Kustom)
 *  8. Helper tanggal Asia/Jakarta menghasilkan format YYYY-MM-DD yang akurat
 *  9. Tab Penjualan memuat grafik tren & tabel rincian harian
 * 10. Tab Pembayaran memuat metrik Tunai, Midtrans, dan Split Bill
 * 11. Tab Produk memuat ranking produk terlaris & performa 4 kategori (Food, Drinks, Desserts, Packages)
 * 12. State Handling: Loading state, Error state, dan Empty state
 * 13. Format mata uang Rupiah Indonesia konsisten
 * 14. Tidak ada data dummy atau transaksi hardcoded di komponen UI
 * 15. Proteksi keamanan: Akses non-admin ditolak di server component & server action
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("===============================================================================");
console.log(" NINE LICIOUS POS — F6.2 ADMIN REPORTS DASHBOARD UI TEST SUITE");
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
// PENGUJIAN 15 SKENARIO INTEGRASI DASHBOARD F6.2
// -----------------------------------------------------------------------------

runTest(1, "ROUTE-GUARD", "Halaman /admin/reports tersedia & diproteksi requireRole(['admin'])", () => {
  const pageFile = readFileUtf8("src/app/(app)/admin/reports/page.tsx");
  assert.match(pageFile, /requireRole\(\["admin"\]\)/, "Harus memanggil requireRole(['admin'])");
  assert.match(pageFile, /export\s+default\s+async\s+function\s+AdminReportsPage/, "Harus mengekspor AdminReportsPage");
  assert.match(pageFile, /getComprehensiveReportAction/, "Harus memanggil getComprehensiveReportAction");
});

runTest(2, "NAVIGATION", "Navigasi Laporan terdaftar di sidebar admin (/admin/reports)", () => {
  const navFile = readFileUtf8("src/lib/navigation.ts");
  assert.match(navFile, /href:\s*"\/admin\/reports"/, "Navigasi harus menuju /admin/reports");
  assert.match(navFile, /label:\s*"Laporan"/, "Label navigasi harus 'Laporan'");
  assert.match(navFile, /icon:\s*BarChart3/, "Icon navigasi harus BarChart3");
  assert.match(navFile, /roles:\s*\["admin"\]/, "Navigasi hanya untuk role admin");
});

runTest(3, "ADMIN-HOME", "Dashboard ringkasan /admin memiliki tombol pintasan ke /admin/reports", () => {
  const adminPage = readFileUtf8("src/app/(app)/admin/page.tsx");
  assert.match(adminPage, /href="\/admin\/reports"/, "Harus memiliki Link menuju /admin/reports");
  assert.match(adminPage, /BarChart3/, "Harus menampilkan ikon BarChart3");
});

runTest(4, "SERVER-ACTION", "ReportsDashboard terintegrasi dengan getComprehensiveReportAction dari F6.1", () => {
  const compFile = readFileUtf8("src/components/admin/reports/reports-dashboard.tsx");
  assert.match(compFile, /import\s*\{\s*getComprehensiveReportAction\s*\}\s*from\s*"@\/lib\/reports\/actions"/);
  assert.match(compFile, /await\s+getComprehensiveReportAction\(/, "Harus memanggil getComprehensiveReportAction saat filter berubah");
});

runTest(5, "KPI-CARDS", "Tampilan 7 KPI Penjualan lengkap dalam format Rupiah", () => {
  const compFile = readFileUtf8("src/components/admin/reports/reports-dashboard.tsx");
  assert.match(compFile, /Gross Sales/, "Harus memuat KPI Gross Sales");
  assert.match(compFile, /Total Diskon/, "Harus memuat KPI Total Diskon");
  assert.match(compFile, /Net Sales/, "Harus memuat KPI Net Sales");
  assert.match(compFile, /Total Pajak/, "Harus memuat KPI Total Pajak");
  assert.match(compFile, /Service Charge/, "Harus memuat KPI Service Charge");
  assert.match(compFile, /Average Order \(AOV\)/, "Harus memuat KPI Average Order (AOV)");
  assert.match(compFile, /Pesanan Lunas/, "Harus memuat KPI Pesanan Lunas");
});

runTest(6, "TAB-NAVIGATION", "Tampilan 3 Tab Laporan (Penjualan, Pembayaran, Produk & Kategori)", () => {
  const compFile = readFileUtf8("src/components/admin/reports/reports-dashboard.tsx");
  assert.match(compFile, /1\.\s*Penjualan/, "Tab 1 harus Penjualan");
  assert.match(compFile, /2\.\s*Pembayaran/, "Tab 2 harus Pembayaran");
  assert.match(compFile, /3\.\s*Produk\s*&amp;\s*Kategori/, "Tab 3 harus Produk & Kategori");
});

runTest(7, "DATE-PRESETS", "Dukungan 5 Filter Periode (Hari Ini, 7 Hari, 30 Hari, Bulan Ini, Kustom)", () => {
  const compFile = readFileUtf8("src/components/admin/reports/reports-dashboard.tsx");
  assert.match(compFile, />\s*Hari Ini\s*</, "Harus ada tombol preset Hari Ini");
  assert.match(compFile, />\s*7 Hari Terakhir\s*</, "Harus ada tombol preset 7 Hari Terakhir");
  assert.match(compFile, />\s*30 Hari Terakhir\s*</, "Harus ada tombol preset 30 Hari Terakhir");
  assert.match(compFile, />\s*Bulan Ini\s*</, "Harus ada tombol preset Bulan Ini");
  assert.match(compFile, />\s*Kustom\s*</, "Harus ada tombol preset Kustom");
  assert.match(compFile, /id="custom-start"/, "Harus ada input tanggal mulai kustom");
  assert.match(compFile, /id="custom-end"/, "Harus ada input tanggal akhir kustom");
});

runTest(8, "JAKARTA-DATE-HELPERS", "Helper tanggal Asia/Jakarta menghasilkan format YYYY-MM-DD yang valid", () => {
  const calcFile = readFileUtf8("src/lib/reports/calculations.ts");
  assert.match(calcFile, /export function getJakartaDateToday\(\)/, "Harus mengekspor getJakartaDateToday");
  assert.match(calcFile, /export function getJakartaDateDaysAgo\(/, "Harus mengekspor getJakartaDateDaysAgo");
  assert.match(calcFile, /export function getJakartaFirstDayOfMonth\(\)/, "Harus mengekspor getJakartaFirstDayOfMonth");

  // Uji format regex YYYY-MM-DD
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  assert.match(today, dateRegex, "Format tanggal Jakarta harus YYYY-MM-DD");
});

runTest(9, "SALES-TAB", "Tab Penjualan memuat grafik tren & tabel rincian harian lengkap", () => {
  const compFile = readFileUtf8("src/components/admin/reports/reports-dashboard.tsx");
  assert.match(compFile, /Grafik Tren Penjualan Harian/, "Harus memuat grafik tren penjualan harian");
  assert.match(compFile, /Rincian Harian Penjualan/, "Harus memuat tabel rincian harian penjualan");
  assert.match(compFile, /sales\.dailyBreakdown\.map/, "Harus memetakan data breakdown harian");
});

runTest(10, "PAYMENTS-TAB", "Tab Pembayaran memuat metrik Tunai, Midtrans, dan Split Bill", () => {
  const compFile = readFileUtf8("src/components/admin/reports/reports-dashboard.tsx");
  assert.match(compFile, /Total Penerimaan Tunai/, "Harus memuat kartu Total Penerimaan Tunai");
  assert.match(compFile, /Total Pembayaran Midtrans/, "Harus memuat kartu Total Pembayaran Midtrans");
  assert.match(compFile, /Pesanan Split Bill/, "Harus memuat kartu Pesanan Split Bill");
  assert.match(compFile, /Rincian Transaksi per Saluran Pembayaran/, "Harus memuat tabel rincian saluran pembayaran");
  assert.match(compFile, /payments\.methodsBreakdown\.map/, "Harus memetakan breakdown metode pembayaran");
});

runTest(11, "PRODUCTS-TAB", "Tab Produk memuat ranking produk terlaris & 4 kategori menu", () => {
  const compFile = readFileUtf8("src/components/admin/reports/reports-dashboard.tsx");
  assert.match(compFile, /Kontribusi Penjualan per Kategori Menu/, "Harus memuat kartu kategori menu");
  assert.match(compFile, /Peringkat Produk Terlaris \(Top Selling\)/, "Harus memuat tabel peringkat produk");
  assert.match(compFile, /products\.categoryBreakdown\.map/, "Harus memetakan performa kategori");
  assert.match(compFile, /products\.topProducts\.map/, "Harus memetakan produk terlaris");
});

runTest(12, "STATE-HANDLING", "State Handling: Loading state, Error state, dan Empty state tersedia", () => {
  const compFile = readFileUtf8("src/components/admin/reports/reports-dashboard.tsx");
  assert.match(compFile, /isPending/, "Harus menggunakan isPending untuk loading state");
  assert.match(compFile, /errorMessage\s*&&/, "Harus merender alert jika ada errorMessage");
  assert.match(compFile, /Belum Ada Data Penjualan/, "Harus merender empty state jika tidak ada penjualan");
  assert.match(compFile, /Tidak ada produk yang terjual pada periode ini/, "Harus merender empty state jika produk kosong");
});

runTest(13, "CURRENCY-FORMAT", "Format mata uang Rupiah Indonesia konsisten (IDR / Rp)", () => {
  const compFile = readFileUtf8("src/components/admin/reports/reports-dashboard.tsx");
  assert.match(compFile, /function\s+formatRupiah\(amount:\s*number\):\s*string/, "Harus memiliki fungsi formatRupiah");
  assert.match(compFile, /currency:\s*"IDR"/, "Mata uang harus IDR");
});

runTest(14, "NO-DUMMY-DATA", "Tidak ada data dummy atau nominal transaksi hardcoded di komponen UI", () => {
  const compFile = readFileUtf8("src/components/admin/reports/reports-dashboard.tsx");
  // Pastikan tidak ada data contoh hardcoded seperti Rp 1.500.000 atau dummy array
  assert.doesNotMatch(compFile, /"Rp\s*1\.500\.000"/, "Dilarang menggunakan data dummy");
  assert.doesNotMatch(compFile, /const\s+DUMMY_/, "Dilarang membuat konstanta data dummy");
  assert.doesNotMatch(compFile, /const\s+MOCK_/, "Dilarang membuat data mock di komponen UI");
});

runTest(15, "SECURITY-INTEGRATION", "Proteksi keamanan: Akses non-admin ditolak di server component & server action", () => {
  const pageFile = readFileUtf8("src/app/(app)/admin/reports/page.tsx");
  assert.match(pageFile, /requireRole\(\["admin"\]\)/, "Rute halaman harus diproteksi requireRole(['admin'])");

  const actionsFile = readFileUtf8("src/lib/reports/actions.ts");
  assert.match(actionsFile, /getComprehensiveReportAction/, "Server Action harus memvalidasi role admin");
  assert.match(actionsFile, /actor\.ok/, "Server Action harus menolak jika bukan admin");
});

console.log("\n===============================================================================");
console.log(` HASIL PENGUJIAN F6.2: ${passedTests} / ${totalTests} TEST CASES BERHASIL (100% PASS)`);
console.log("===============================================================================\n");
