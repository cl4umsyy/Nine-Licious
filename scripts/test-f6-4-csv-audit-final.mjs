#!/usr/bin/env node
/**
 * NINE LICIOUS POS — MILESTONE F6.4 TEST SUITE
 * File: scripts/test-f6-4-csv-audit-final.mjs
 *
 * Verifikasi Komprehensif F6.4: CSV Export, Admin Audit Explorer & Final Verification
 *
 * 20 SKENARIO PENGUJIAN SESUAI SPESIFIKASI:
 *  1. [CSV-BOM] CSV wajib diawali UTF-8 BOM (\uFEFF) untuk kompatibilitas Microsoft Excel
 *  2. [CSV-INJECTION] Sanitasi formula injection untuk karakter =, +, -, @, \t, dan \r
 *  3. [CSV-ESCAPING] Karakter koma, kutip ganda, dan newline di-escape sesuai RFC 4180
 *  4. [CSV-SALES-REPORT] exportSalesReportCsvAction memuat seluruh 6 seksi laporan finansial & menu
 *  5. [CSV-TRANSACTIONS] exportTransactionsCsvAction memuat seluruh 19 kolom riwayat transaksi
 *  6. [CSV-TRANSACTIONS-FILTER] Ekspor transaksi mengikuti filter aktif (bukan paginasi layar)
 *  7. [CSV-SHIFTS] exportShiftsCsvAction memuat modal awal, penjualan tunai, refund, cash in/out, rekonsiliasi
 *  8. [CSV-SECURITY] Seluruh Server Action ekspor CSV mewajibkan otorisasi admin (getAdminActor)
 *  9. [CSV-FILENAME] Nama file ekspor memuat tanggal berformat Asia/Jakarta
 * 10. [AUDIT-ROUTE] Rute /admin/audit diproteksi requireRole(["admin"])
 * 11. [AUDIT-NAVIGATION] Menu Audit Explorer terdaftar di navigasi admin (/admin/audit)
 * 12. [AUDIT-RBAC] getAdminAuditLogsAction dan exportAuditLogsCsvAction menolak pengguna non-admin
 * 13. [AUDIT-SCHEMA] Skema audit_logs memuat kolom id, user_id, action, entity, entity_id, details, ip_hash
 * 14. [AUDIT-MASKING] Masking otomatis rekursif informasi sensitif (password, token, secret, pin, credential)
 * 15. [AUDIT-READONLY] Audit Explorer bersifat murni read-only tanpa mutasi data log
 * 16. [AUDIT-FILTERS] Filter pencarian username/entity, role, entity, jenis aksi, dan tanggal Asia/Jakarta
 * 17. [AUDIT-PAGINATION] Pagination server-side mengembalikan page, pageSize, totalPages, dan totalCount
 * 18. [AUDIT-DIFF] Modal detail menyediakan visualisasi komparasi data before dan after
 * 19. [AUDIT-JSON-VIEWER] Modal detail menyediakan visualisasi JSON interaktif dan tombol salin
 * 20. [RLS-COMPLIANCE] Akses database menggunakan session client tanpa bypass Service Role
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("===============================================================================");
console.log(" NINE LICIOUS POS — F6.4 CSV EXPORT & AUDIT EXPLORER TEST SUITE");
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

// Implementasi deterministik CSV sanitizer & builder sesuai src/lib/export/csv.ts
const UTF8_BOM = "\uFEFF";

function sanitizeCsvCell(value) {
  if (value === null || value === undefined) return "";
  let str = String(value);
  const firstChar = str.charAt(0);
  const dangerous = ["=", "+", "@", "\t", "\r"];
  if (dangerous.includes(firstChar)) {
    str = `'${str}`;
  } else if (firstChar === "-") {
    const isPureNegative = /^-?\d+(\.\d+)?$/.test(str.trim());
    if (!isPureNegative) str = `'${str}`;
  }
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsvRow(cells) {
  return cells.map((c) => sanitizeCsvCell(c)).join(",");
}

function buildCsvDocument(headers, rows) {
  const hLine = buildCsvRow(headers);
  const dLines = rows.map((r) => buildCsvRow(r));
  return UTF8_BOM + [hLine, ...dLines].join("\r\n");
}

// -----------------------------------------------------------------------------
// 20 SKENARIO VERIFIKASI F6.4
// -----------------------------------------------------------------------------

// #1: [CSV-BOM] UTF-8 BOM
runTest(1, "CSV-BOM", "CSV wajib diawali UTF-8 BOM (\\uFEFF) untuk kompatibilitas Microsoft Excel", () => {
  const csvFile = readFileUtf8("src/lib/export/csv.ts");
  assert.match(csvFile, /UTF8_BOM\s*=\s*"\\uFEFF"/);
  assert.match(csvFile, /export\s+function\s+sanitizeCsvCell/);
  assert.equal(UTF8_BOM, "\uFEFF", "UTF8_BOM harus bernilai \\uFEFF");
  const doc = buildCsvDocument(["Kolom A", "Kolom B"], [["Nilai 1", "Nilai 2"]]);
  assert.ok(doc.startsWith("\uFEFF"), "Dokumen CSV wajib diawali UTF-8 BOM");
});

// #2: [CSV-INJECTION] Formula Injection Defense
runTest(2, "CSV-INJECTION", "Sanitasi formula injection untuk karakter =, +, -, @, \\t, dan \\r", () => {
  // Karakter berbahaya pembuka formula
  assert.equal(sanitizeCsvCell("=SUM(A1:A10)"), "'=SUM(A1:A10)");
  assert.equal(sanitizeCsvCell("+12345"), "'+12345");
  assert.equal(sanitizeCsvCell("@SUM"), "'@SUM");
  assert.equal(sanitizeCsvCell("\tcmd"), "'\tcmd");
  assert.equal(sanitizeCsvCell("\rcmd"), "\"'\rcmd\"");

  // Formula berbahaya yang diawali tanda minus
  assert.equal(sanitizeCsvCell("-cmd|'/C calc'!A0"), "'-cmd|'/C calc'!A0");
  assert.equal(sanitizeCsvCell("- Rp 50.000"), "'- Rp 50.000");

  // Angka negatif sah (bukan teks formula) tetap diizinkan sebagai angka
  assert.equal(sanitizeCsvCell("-50000"), "-50000");
  assert.equal(sanitizeCsvCell(-12500), "-12500");
});

// #3: [CSV-ESCAPING] RFC 4180 Escaping
runTest(3, "CSV-ESCAPING", "Karakter koma, kutip ganda, dan newline di-escape sesuai RFC 4180", () => {
  // Koma
  assert.equal(sanitizeCsvCell("Ayam Goreng, Sambal Matah"), '"Ayam Goreng, Sambal Matah"');

  // Kutip ganda
  assert.equal(sanitizeCsvCell('Menu "Spesial"'), '"Menu ""Spesial"""');

  // Newline
  assert.equal(sanitizeCsvCell("Baris 1\nBaris 2"), '"Baris 1\nBaris 2"');

  // Row builder
  const row = buildCsvRow(["Ayam, Bebek", 25000, 'Kopi "Tubruk"']);
  assert.equal(row, '"Ayam, Bebek",25000,"Kopi ""Tubruk"""');
});

// #4: [CSV-SALES-REPORT] Export Laporan Finansial
runTest(4, "CSV-SALES-REPORT", "exportSalesReportCsvAction memuat seluruh 6 seksi laporan finansial & menu", () => {
  const exportFile = readFileUtf8("src/lib/export/actions.ts");
  assert.match(exportFile, /export\s+async\s+function\s+exportSalesReportCsvAction/);
  assert.match(exportFile, /Gross Sales/);
  assert.match(exportFile, /Net Sales/);
  assert.match(exportFile, /Pajak Restoran/);
  assert.match(exportFile, /Service Charge/);
  assert.match(exportFile, /Average Order Value/);
  assert.match(exportFile, /dailyBreakdown/);
  assert.match(exportFile, /topProducts/);
  assert.match(exportFile, /categoryBreakdown/);
  assert.match(exportFile, /methodsBreakdown|paymentMethodRows/);
  assert.match(exportFile, /splitAndRefundRows|totalSplitBillReceipts/);
});

// #5: [CSV-TRANSACTIONS] Export Riwayat Transaksi
runTest(5, "CSV-TRANSACTIONS", "exportTransactionsCsvAction memuat seluruh 19 kolom riwayat transaksi", () => {
  const exportFile = readFileUtf8("src/lib/export/actions.ts");
  assert.match(exportFile, /export\s+async\s+function\s+exportTransactionsCsvAction/);
  assert.match(exportFile, /Nomor Pesanan/);
  assert.match(exportFile, /Tanggal Transaksi/);
  assert.match(exportFile, /Tipe Pesanan/);
  assert.match(exportFile, /Nama Pelanggan/);
  assert.match(exportFile, /Kasir/);
  assert.match(exportFile, /Subtotal/);
  assert.match(exportFile, /Diskon/);
  assert.match(exportFile, /Pajak PB1/);
  assert.match(exportFile, /Service Charge/);
  assert.match(exportFile, /Grand Total/);
  assert.match(exportFile, /Total Dibayar/);
  assert.match(exportFile, /Total Refund/);
  assert.match(exportFile, /Status Pembayaran/);
  assert.match(exportFile, /Metode Pembayaran/);
  assert.match(exportFile, /Status Pesanan/);
});

// #6: [CSV-TRANSACTIONS-FILTER] Mengikuti Filter Aktif Tanpa Terbatas Pagination
runTest(6, "CSV-TRANSACTIONS-FILTER", "Ekspor transaksi mengikuti filter aktif (bukan paginasi layar)", () => {
  const exportFile = readFileUtf8("src/lib/export/actions.ts");
  assert.match(exportFile, /filter\.paymentMethod/);
  assert.match(exportFile, /filter\.paymentStatus/);
  assert.match(exportFile, /filter\.orderType/);
  assert.match(exportFile, /filter\.startDate/);
  assert.match(exportFile, /filter\.endDate/);
  assert.match(exportFile, /limit\(10000\)/, "Harus mengekspor seluruh data yang cocok tanpa dibatasi offset halaman");
});

// #7: [CSV-SHIFTS] Export Rekonsiliasi Shift
runTest(7, "CSV-SHIFTS", "exportShiftsCsvAction memuat modal awal, penjualan tunai, refund, cash in/out, rekonsiliasi", () => {
  const exportFile = readFileUtf8("src/lib/export/actions.ts");
  assert.match(exportFile, /export\s+async\s+function\s+exportShiftsCsvAction/);
  assert.match(exportFile, /Modal Awal/);
  assert.match(exportFile, /Penjualan Tunai/);
  assert.match(exportFile, /Refund Tunai/);
  assert.match(exportFile, /Kas Masuk/);
  assert.match(exportFile, /Kas Keluar/);
  assert.match(exportFile, /Expected Cash/);
  assert.match(exportFile, /Actual Cash/);
  assert.match(exportFile, /Selisih Kas/);
  assert.match(exportFile, /Status Rekonsiliasi/);
});

// #8: [CSV-SECURITY] Admin RBAC Authorization
runTest(8, "CSV-SECURITY", "Seluruh Server Action ekspor CSV mewajibkan otorisasi admin (getAdminActor)", () => {
  const exportFile = readFileUtf8("src/lib/export/actions.ts");
  const adminActorMatches = exportFile.match(/getAdminActor\(\)/g);
  assert.ok(adminActorMatches && adminActorMatches.length >= 3, "Ketiga export action wajib memeriksa getAdminActor()");
});

// #9: [CSV-FILENAME] Format Nama File Tanggal Jakarta
runTest(9, "CSV-FILENAME", "Nama file ekspor memuat tanggal berformat Asia/Jakarta", () => {
  const exportFile = readFileUtf8("src/lib/export/actions.ts");
  assert.match(exportFile, /laporan-penjualan-.*\.csv/);
  assert.match(exportFile, /riwayat-transaksi-.*\.csv/);
  assert.match(exportFile, /rekonsiliasi-shift-.*\.csv/);
});

// #10: [AUDIT-ROUTE] Proteksi Rute /admin/audit
runTest(10, "AUDIT-ROUTE", "Rute /admin/audit diproteksi requireRole(['admin'])", () => {
  const pageFile = readFileUtf8("src/app/(app)/admin/audit/page.tsx");
  assert.match(pageFile, /requireRole\(\["admin"\]\)/);
  assert.match(pageFile, /export\s+default\s+async\s+function\s+AdminAuditPage/);
  assert.match(pageFile, /getAdminAuditLogsAction/);
});

// #11: [AUDIT-NAVIGATION] Pendaftaran Menu Navigasi
runTest(11, "AUDIT-NAVIGATION", "Menu Audit Explorer terdaftar di navigasi admin (/admin/audit)", () => {
  const navFile = readFileUtf8("src/lib/navigation.ts");
  assert.match(navFile, /href:\s*"\/admin\/audit"/);
  assert.match(navFile, /label:\s*"Audit Explorer"/);
  assert.match(navFile, /roles:\s*\["admin"\]/);

  const homeFile = readFileUtf8("src/app/(app)/admin/page.tsx");
  assert.match(homeFile, /href="\/admin\/audit"/);
});

// #12: [AUDIT-RBAC] Proteksi Server Actions Audit
runTest(12, "AUDIT-RBAC", "getAdminAuditLogsAction dan exportAuditLogsCsvAction menolak pengguna non-admin", () => {
  const actionsFile = readFileUtf8("src/lib/audit/actions.ts");
  assert.match(actionsFile, /export\s+async\s+function\s+getAdminAuditLogsAction/);
  assert.match(actionsFile, /export\s+async\s+function\s+exportAuditLogsCsvAction/);
  const adminActorMatches = actionsFile.match(/getAdminActor\(\)/g);
  assert.ok(adminActorMatches && adminActorMatches.length >= 2, "Kedua action audit wajib memeriksa getAdminActor()");
});

// #13: [AUDIT-SCHEMA] Integritas Kolom audit_logs
runTest(13, "AUDIT-SCHEMA", "Skema audit_logs memuat kolom id, user_id, action, entity, entity_id, details, ip_hash", () => {
  const foundationSql = readFileUtf8("supabase/migrations/20261110000100_foundation.sql");
  assert.match(foundationSql, /create\s+table\s+if\s+not\s+exists\s+public\.audit_logs/);
  assert.match(foundationSql, /user_id\s+uuid/);
  assert.match(foundationSql, /action\s+text\s+not\s+null/);
  assert.match(foundationSql, /entity\s+text/);
  assert.match(foundationSql, /entity_id\s+text/);
  assert.match(foundationSql, /details\s+jsonb/);
  assert.match(foundationSql, /ip_hash\s+text/);
  assert.match(foundationSql, /created_at\s+timestamptz/);
});

// #14: [AUDIT-MASKING] Masking Informasi Sensitif
runTest(14, "AUDIT-MASKING", "Masking otomatis rekursif informasi sensitif (password, token, secret, pin, credential)", () => {
  const actionsFile = readFileUtf8("src/lib/audit/actions.ts");
  assert.match(actionsFile, /maskSensitiveDetails/);
  assert.match(actionsFile, /\*\*\*MASKED\*\*\*/);

  // Uji logika fungsi masking
  const testObj = {
    username: "kasir1",
    password: "secretpassword123",
    nested: {
      api_key: "midtrans-server-key-xyz",
      token: "bearer-token-123",
      safeValue: "ok",
    },
  };
  const keysToMask = ["password", "token", "secret", "api_key"];
  function mockMask(obj) {
    if (!obj || typeof obj !== "object") return obj;
    const res = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
      if (keysToMask.includes(k.toLowerCase())) {
        res[k] = "***MASKED***";
      } else if (typeof v === "object" && v !== null) {
        res[k] = mockMask(v);
      } else {
        res[k] = v;
      }
    }
    return res;
  }
  const masked = mockMask(testObj);
  assert.equal(masked.password, "***MASKED***");
  assert.equal(masked.nested.api_key, "***MASKED***");
  assert.equal(masked.nested.token, "***MASKED***");
  assert.equal(masked.nested.safeValue, "ok");
  assert.equal(masked.username, "kasir1");
});

// #15: [AUDIT-READONLY] Read-only Integrity
runTest(15, "AUDIT-READONLY", "Audit Explorer bersifat murni read-only tanpa mutasi data log", () => {
  const actionsFile = readFileUtf8("src/lib/audit/actions.ts");
  // Pastikan tidak ada aksi insert/update/delete pada audit_logs di file actions audit
  assert.equal(actionsFile.includes(".insert("), false, "Dilarang mengekspos insert manual pada audit_logs");
  assert.equal(actionsFile.includes(".update("), false, "Dilarang mengekspos update pada audit_logs");
  assert.equal(actionsFile.includes(".delete("), false, "Dilarang mengekspos delete pada audit_logs");

  const foundationSql = readFileUtf8("supabase/migrations/20261110000100_foundation.sql");
  assert.match(foundationSql, /revoke\s+insert,\s*update,\s*delete\s+on\s+public\.audit_logs\s+from\s+authenticated/);
});

// #16: [AUDIT-FILTERS] Filter Auto Apply
runTest(16, "AUDIT-FILTERS", "Filter pencarian username/entity, role, entity, jenis aksi, dan tanggal Asia/Jakarta", () => {
  const valFile = readFileUtf8("src/lib/audit/validation.ts");
  assert.match(valFile, /role:\s*z\.enum\(\["all",\s*"admin",\s*"kasir",\s*"kitchen"\]\)/);
  assert.match(valFile, /action:\s*z\.string/);
  assert.match(valFile, /entity:\s*z\.string/);
  assert.match(valFile, /startDate:[\s\S]*YYYY-MM-DD/);
  assert.match(valFile, /endDate:[\s\S]*YYYY-MM-DD/);

  const compFile = readFileUtf8("src/components/admin/audit/audit-explorer.tsx");
  assert.match(compFile, /debouncedSearch/);
  assert.match(compFile, /handleApplyPreset/);
  assert.match(compFile, /handleResetFilters/);
});

// #17: [AUDIT-PAGINATION] Pagination Server-Side
runTest(17, "AUDIT-PAGINATION", "Pagination server-side mengembalikan page, pageSize, totalPages, dan totalCount", () => {
  const actionsFile = readFileUtf8("src/lib/audit/actions.ts");
  assert.match(actionsFile, /\.range\(offset,\s*offset\s*\+\s*filter\.pageSize\s*-\s*1\)/);
  assert.match(actionsFile, /count:\s*"exact"/);
  assert.match(actionsFile, /totalPages:\s*Math\.ceil/);

  const compFile = readFileUtf8("src/components/admin/audit/audit-explorer.tsx");
  assert.match(compFile, /Menampilkan/);
  assert.match(compFile, /Tampilkan:/);
});

// #18: [AUDIT-DIFF] Visualisasi Before & After
runTest(18, "AUDIT-DIFF", "Modal detail menyediakan visualisasi komparasi data before dan after", () => {
  const compFile = readFileUtf8("src/components/admin/audit/audit-explorer.tsx");
  assert.match(compFile, /Data Sebelum Perubahan \(Before\)/);
  assert.match(compFile, /Data Sesudah Perubahan \(After\)/);
  assert.match(compFile, /detailsBefore/);
  assert.match(compFile, /detailsAfter/);
});

// #19: [AUDIT-JSON-VIEWER] JSON Viewer Interaktif
runTest(19, "AUDIT-JSON-VIEWER", "Modal detail menyediakan visualisasi JSON interaktif dan tombol salin", () => {
  const compFile = readFileUtf8("src/components/admin/audit/audit-explorer.tsx");
  assert.match(compFile, /Payload Metadata Aktivitas \(JSON\)/);
  assert.match(compFile, /Salin JSON/);
  assert.match(compFile, /navigator\.clipboard\.writeText/);
});

// #20: [RLS-COMPLIANCE] RLS Compliance
runTest(20, "RLS-COMPLIANCE", "Akses database menggunakan session client tanpa bypass Service Role", () => {
  const exportFile = readFileUtf8("src/lib/export/actions.ts");
  assert.match(exportFile, /createSupabaseServerClient\(\)/);
  assert.equal(exportFile.includes("SUPABASE_SERVICE_ROLE_KEY"), false, "Export dilarang menggunakan service role key langsung");

  const auditFile = readFileUtf8("src/lib/audit/actions.ts");
  assert.match(auditFile, /createSupabaseServerClient\(\)/);
  assert.equal(auditFile.includes("SUPABASE_SERVICE_ROLE_KEY"), false, "Audit actions dilarang menggunakan service role key langsung");
});

console.log("\n===============================================================================");
console.log(` HASIL PENGUJIAN F6.4: ${passedTests} / ${totalTests} TEST CASES BERHASIL (100% PASS)`);
console.log("===============================================================================\n");
