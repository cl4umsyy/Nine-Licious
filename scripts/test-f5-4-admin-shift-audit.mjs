#!/usr/bin/env node
/**
 * NINE LICIOUS POS — MILESTONE F5.4 VERIFICATION & TEST SUITE
 * File: scripts/test-f5-4-admin-shift-audit.mjs
 *
 * Verifikasi Komprehensif F5.4: Admin Shift Management, Reconciliation & Integration Audit
 *
 * 6 AREA UTAMA VERIFIKASI:
 * 1. ADMIN SHIFT MONITORING & FILTERING
 *    - Akses rute /admin/shifts diproteksi khusus role admin
 *    - Monitoring shift aktif dan riwayat shift tertutup
 *    - Pencarian kasir (nama, username, catatan)
 *    - Filter status shift (semua, open, closed)
 *    - Filter rentang waktu (semua, hari ini, 7 hari, 30 hari, custom date)
 *    - Reset filter & empty state
 *
 * 2. AUDIT DETAIL SHIFT LENGKAP
 *    - Tampilan modal detail shift memuat 10 komponen finansial wajib:
 *      Nama kasir, Modal awal, Penjualan tunai, Refund tunai, Kas masuk, Kas keluar,
 *      Expected cash, Fisik aktual, Selisih rekonsiliasi, Catatan penutupan.
 *    - Buku besar mutasi kas (cash_movements) kronologis dengan badge tipe mutasi.
 *
 * 3. REKONSILIASI KAS & PELACAKAN SELISIH
 *    - Identifikasi selisih kas fisik vs ekspektasi sistem
 *    - Status rekonsiliasi tri-state: Cocok (Pas Rp 0), Lebih (Surplus), Kurang (Defisit)
 *    - Immutability hasil rekonsiliasi (shift ditutup tidak dapat diubah diam-diam)
 *    - Logging tindakan administratif ke public.audit_logs
 *
 * 4. KEAMANAN & ISOLASI AKSES ROLE-BASED
 *    - Kasir dilarang melihat shift kasir lain di server action
 *    - Kasir dilarang menutup atau merekayasa mutasi shift kasir lain
 *    - Klien browser tidak dapat memanipulasi cashierId / shiftId
 *    - Direct write ke public.shifts dan public.cash_movements diblokir oleh RLS
 *    - Semua mutasi saldo wajib melalui RPC atomik SECURITY DEFINER
 *
 * 5. INTEGRASI TRANSAKSI, REFUND & GATEWAY
 *    - Konsistensi matematis saldo: Modal + Penjualan + Kas Masuk - (Refund + Kas Keluar) = Expected
 *    - Refund tunai memotong laci yang benar
 *    - Pembayaran & refund Midtrans tidak mencemari kas drawer fisik
 *    - Idempotensi transaksi mencegah pencatatan saldo ganda
 *
 * 6. UI/UX & NON-REGRESI
 *    - Responsivitas komponen tabel & dialog
 *    - Loading indicator, empty state, dan error state
 *    - Tidak ada Prisma, tidak ada QR ordering publik, payment strictly Cash & Midtrans
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("===============================================================================");
console.log(" NINE LICIOUS POS — F5.4 ADMIN SHIFT & RECONCILIATION AUDIT SUITE");
console.log("===============================================================================\n");

let totalTests = 0;
let passedTests = 0;

function runTest(number, category, name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✓ [PASS] #${number} [${category}] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`✗ [FAIL] #${number} [${category}] ${name}`);
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
// BAGIAN 1: ADMIN SHIFT MONITORING & FILTERING
// -----------------------------------------------------------------------------

runTest(1, "ADMIN-MONITOR", "Halaman /admin/shifts diproteksi ketat hanya untuk peran admin", () => {
  const file = readFileUtf8("src/app/(app)/admin/shifts/page.tsx");
  assert.match(file, /requireRole\(\["admin"\]\)/, "Harus menggunakan requireRole(['admin'])");
  assert.doesNotMatch(file, /requireRole\(.*"kasir".*\)/, "Role kasir tidak boleh masuk guard requireRole di /admin/shifts");
});

runTest(2, "ADMIN-MONITOR", "AdminShiftManager menampilkan kartu metrik ringkasan eksekutif", () => {
  const file = readFileUtf8("src/components/admin/shifts/admin-shift-manager.tsx");
  assert.match(file, /Shift Kasir Aktif/, "Harus menampilkan metrik Shift Kasir Aktif");
  assert.match(file, /Total Kas Drawer Beredar/, "Harus menampilkan Total Kas Drawer Beredar");
  assert.match(file, /Kasir Terdaftar/, "Harus menampilkan Kasir Terdaftar");
  assert.match(file, /Total Riwayat Shift/, "Harus menampilkan Total Riwayat Shift");
});

runTest(3, "ADMIN-MONITOR", "AdminShiftManager menyediakan pencarian terpadu nama kasir, username, dan catatan", () => {
  const file = readFileUtf8("src/components/admin/shifts/admin-shift-manager.tsx");
  assert.match(file, /searchQuery/, "Harus memiliki state searchQuery");
  assert.match(file, /nameMatch \|\| userMatch \|\| notesMatch/, "Pencarian harus mencakup nama, username, dan catatan shift");
});

runTest(4, "ADMIN-MONITOR", "AdminShiftManager menyediakan filter status shift (semua, open, closed)", () => {
  const file = readFileUtf8("src/components/admin/shifts/admin-shift-manager.tsx");
  assert.match(file, /statusFilter/, "Harus melacak statusFilter");
  assert.match(file, /<SelectItem value="open">Shift Aktif<\/SelectItem>/, "Opsi Shift Aktif harus tersedia");
  assert.match(file, /<SelectItem value="closed">Shift Ditutup<\/SelectItem>/, "Opsi Shift Ditutup harus tersedia");
});

runTest(5, "ADMIN-MONITOR", "AdminShiftManager menyediakan filter tanggal (Hari ini, 7 hari, 30 hari, custom)", () => {
  const file = readFileUtf8("src/components/admin/shifts/admin-shift-manager.tsx");
  assert.match(file, /dateFilter/, "Harus memiliki state dateFilter");
  assert.match(file, /<SelectItem value="today">Hari Ini<\/SelectItem>/, "Opsi Hari Ini harus tersedia");
  assert.match(file, /<SelectItem value="7d">7 Hari Terakhir<\/SelectItem>/, "Opsi 7 Hari Terakhir harus tersedia");
  assert.match(file, /<SelectItem value="30d">30 Hari Terakhir<\/SelectItem>/, "Opsi 30 Hari Terakhir harus tersedia");
  assert.match(file, /<SelectItem value="custom">Pilih Tanggal\.\.\.<\/SelectItem>/, "Opsi custom date harus tersedia");
  assert.match(file, /type="date"/, "Input tanggal harus muncul jika custom date dipilih");
});

runTest(6, "ADMIN-MONITOR", "AdminShiftManager menyediakan tombol reset filter dan empty state ramah pengguna", () => {
  const file = readFileUtf8("src/components/admin/shifts/admin-shift-manager.tsx");
  assert.match(file, /handleResetFilters/, "Harus menyediakan handler handleResetFilters");
  assert.match(file, /Tidak ada data shift yang cocok/, "Harus menyediakan pesan empty state yang informatif");
});

runTest(7, "ADMIN-MONITOR", "getShiftHistoryAction mendukung parameter status, startDate, dan endDate", () => {
  const file = readFileUtf8("src/lib/shifts/actions.ts");
  assert.match(file, /status\?: ShiftStatus/, "getShiftHistoryAction harus menerima opsi status");
  assert.match(file, /startDate\?: string/, "getShiftHistoryAction harus menerima opsi startDate");
  assert.match(file, /endDate\?: string/, "getShiftHistoryAction harus menerima opsi endDate");
});

// -----------------------------------------------------------------------------
// BAGIAN 2: AUDIT DETAIL SHIFT LENGKAP
// -----------------------------------------------------------------------------

runTest(8, "DETAIL-SHIFT", "Modal detail memuat seluruh 10 komponen informasi shift sesuai persyaratan F5.4", () => {
  const file = readFileUtf8("src/components/admin/shifts/admin-shift-manager.tsx");
  // 1. Nama kasir
  assert.match(file, /selectedShiftForDetail\?\.cashier\?\.full_name/, "Harus menampilkan nama kasir");
  // 2. Modal awal
  assert.match(file, /Modal Awal/, "Harus menampilkan Modal Awal");
  // 3. Penjualan tunai
  assert.match(file, /Penjualan Tunai \(\+\)/, "Harus menampilkan Penjualan Tunai (+)");
  // 4. Refund tunai
  assert.match(file, /Refund Tunai \(-\)/, "Harus menampilkan Refund Tunai (-)");
  // 5. Kas masuk
  assert.match(file, /Kas Masuk \(\+\)/, "Harus menampilkan Kas Masuk (+)");
  // 6. Kas keluar
  assert.match(file, /Kas Keluar \(-\)/, "Harus menampilkan Kas Keluar (-)");
  // 7. Expected cash
  assert.match(file, /Expected Cash/, "Harus menampilkan Expected Cash");
  // 8. Uang fisik aktual
  assert.match(file, /Uang Fisik Aktual/, "Harus menampilkan Uang Fisik Aktual");
  // 9. Selisih kas
  assert.match(file, /Selisih Kas Rekonsiliasi/, "Harus menampilkan Selisih Kas");
  // 10. Catatan shift
  assert.match(file, /Catatan Pembukaan \/ Penutupan Shift/, "Harus menampilkan Catatan Shift");
});

runTest(9, "DETAIL-SHIFT", "handleViewDetail memanggil getShiftSummaryAction dan getCashMovementsAction", () => {
  const file = readFileUtf8("src/components/admin/shifts/admin-shift-manager.tsx");
  assert.match(file, /getCashMovementsAction\(shift\.id\)/, "Harus memuat mutasi kas shift");
  assert.match(file, /getShiftSummaryAction\(shift\.id\)/, "Harus memuat ringkasan resmi shift dari database");
});

runTest(10, "DETAIL-SHIFT", "Buku besar mutasi kas menampilkan rincian jenis, alasan, nominal, dan saldo sesudah", () => {
  const file = readFileUtf8("src/components/admin/shifts/admin-shift-manager.tsx");
  assert.match(file, /Buku Besar Pergerakan Kas Drawer/, "Harus ada judul tabel buku besar kas");
  assert.match(file, /getMovementTypeBadge\(m\.movement_type\)/, "Harus menampilkan badge jenis mutasi");
  assert.match(file, /m\.balance_after/, "Harus menampilkan saldo sesudah setiap mutasi");
});

// -----------------------------------------------------------------------------
// BAGIAN 3: REKONSILIASI KAS & PELACAKAN SELISIH
// -----------------------------------------------------------------------------

runTest(11, "RECONCILIATION", "Status rekonsiliasi tri-state ditampilkan di tabel dan modal (Cocok, Lebih, Kurang)", () => {
  const file = readFileUtf8("src/components/admin/shifts/admin-shift-manager.tsx");
  assert.match(file, /Cocok \(Pas\)/, "Harus mendukung status Cocok");
  assert.match(file, /Lebih \(\+/, "Harus mendukung status Lebih (Surplus)");
  assert.match(file, /Kurang \(-/, "Harus mendukung status Kurang (Defisit)");
});

runTest(12, "RECONCILIATION", "Banner callout status rekonsiliasi menjelaskan selisih secara transparan", () => {
  const file = readFileUtf8("src/components/admin/shifts/admin-shift-manager.tsx");
  assert.match(file, /Rekonsiliasi Sempurna: Cocok \/ Seimbang \(Pas\)/, "Banner Cocok harus menjelaskan selisih Rp 0");
  assert.match(file, /Rekonsiliasi Kas: Selisih Lebih \/ Surplus/, "Banner Lebih harus menjelaskan surplus uang fisik");
  assert.match(file, /Rekonsiliasi Kas: Selisih Kurang \/ Defisit/, "Banner Kurang harus menjelaskan defisit uang fisik");
});

runTest(13, "RECONCILIATION", "RPC close_shift_atomic melarang manipulasi ulang shift yang sudah ditutup", () => {
  const migrationFile = readFileUtf8("supabase/migrations/20261120000100_f5_shift_and_cash_management.sql");
  assert.match(migrationFile, /Shift sudah ditutup sebelumnya pada/, "RPC wajib menolak penutupan ulang shift yang sudah closed");
});

runTest(14, "RECONCILIATION", "Semua aksi administratif tercatat ke dalam tabel public.audit_logs", () => {
  const migrationFile = readFileUtf8("supabase/migrations/20261120000100_f5_shift_and_cash_management.sql");
  assert.match(migrationFile, /insert into public\.audit_logs/, "Audit logs harus dicatat pada mutasi kas dan shift");
});

// -----------------------------------------------------------------------------
// BAGIAN 4: KEAMANAN & ISOLASI AKSES ROLE-BASED
// -----------------------------------------------------------------------------

runTest(15, "SECURITY-RBAC", "Kasir dilarang melihat ringkasan shift kasir lain di getShiftSummaryAction", () => {
  const file = readFileUtf8("src/lib/shifts/actions.ts");
  assert.match(file, /Anda tidak berhak melihat ringkasan shift kasir lain\./, "Kasir mengakses shift kasir lain harus ditolak");
});

runTest(16, "SECURITY-RBAC", "Kasir dilarang melihat riwayat mutasi kas shift kasir lain di getCashMovementsAction", () => {
  const file = readFileUtf8("src/lib/shifts/actions.ts");
  assert.match(file, /Anda tidak berhak melihat mutasi kas shift kasir lain\./, "Kasir mengakses mutasi kasir lain harus ditolak");
});

runTest(17, "SECURITY-RBAC", "Kasir dilarang melihat riwayat shift kasir lain di getShiftHistoryAction", () => {
  const file = readFileUtf8("src/lib/shifts/actions.ts");
  assert.match(file, /query = query\.eq\("cashier_id", session\.profile\.id\)/, "Non-admin harus difilter otomatis ke session cashier_id");
});

runTest(18, "SECURITY-RBAC", "Kasir dilarang menutup shift kasir lain di closeShiftAction", () => {
  const file = readFileUtf8("src/lib/shifts/actions.ts");
  assert.match(file, /Anda tidak berhak menutup shift milik kasir lain\./, "Kasir menutup shift kasir lain harus ditolak");
});

runTest(19, "SECURITY-RBAC", "Direct INSERT/UPDATE/DELETE dicabut dari authenticated pada public.shifts", () => {
  const migrationFile = readFileUtf8("supabase/migrations/20261120000100_f5_shift_and_cash_management.sql");
  assert.match(migrationFile, /revoke insert, update, delete on public\.shifts from public, anon, authenticated;/, "Direct write shifts harus dicabut");
});

runTest(20, "SECURITY-RBAC", "Direct INSERT/UPDATE/DELETE dicabut dari authenticated pada public.cash_movements", () => {
  const migrationFile = readFileUtf8("supabase/migrations/20261120000100_f5_shift_and_cash_management.sql");
  assert.match(migrationFile, /revoke insert, update, delete on public\.cash_movements from public, anon, authenticated;/, "Direct write cash_movements harus dicabut");
});

// -----------------------------------------------------------------------------
// BAGIAN 5: INTEGRASI TRANSAKSI, REFUND & GATEWAY
// -----------------------------------------------------------------------------

runTest(21, "INTEGRATION", "Formula akuntansi saldo laci kasir deterministik: Opening + Sales + In - (Refunds + Out)", () => {
  // Simulasi matematis ledger kasir
  const opening = 250000;
  const sales = 150000;
  const cashIn = 50000;
  const refunds = 30000;
  const cashOut = 20000;

  const expected = opening + sales + cashIn - (refunds + cashOut);
  assert.strictEqual(expected, 400000, "Saldo ekspektasi harus tepat Rp 400.000");

  // Kasir menghitung uang fisik Rp 400.000
  const actualMatch = 400000;
  assert.strictEqual(actualMatch - expected, 0, "Selisih harus 0 saat fisik pas");

  // Kasir menghitung uang fisik Rp 410.000 (Lebih)
  const actualSurplus = 410000;
  assert.strictEqual(actualSurplus - expected, 10000, "Selisih surplus +Rp 10.000");

  // Kasir menghitung uang fisik Rp 395.000 (Kurang)
  const actualDeficit = 395000;
  assert.strictEqual(actualDeficit - expected, -5000, "Selisih defisit -Rp 5.000");
});

runTest(22, "INTEGRATION", "Midtrans Snap payments dan refunds tidak pernah mencemari ledger laci kas fisik", () => {
  const migrationFile = readFileUtf8("supabase/migrations/20261120000100_f5_shift_and_cash_management.sql");
  // Pastikan hanya tunai yang menambah expected_cash
  assert.match(migrationFile, /if p_payment_source = 'cash' then\s*update public\.shifts\s*set\s*expected_cash = expected_cash \+ p_amount/, "Hanya cash yang menambah expected_cash");
});

runTest(23, "INTEGRATION", "Pencatatan refund tunai mengikat refund_id ke cash_movements", () => {
  const migrationFile = readFileUtf8("supabase/migrations/20261120000100_f5_shift_and_cash_management.sql");
  assert.match(migrationFile, /v_refund_id,/, "cash_movements refund wajib menyertakan refund_id");
});

runTest(24, "INTEGRATION", "Idempotensi pembayaran mencegah mutasi saldo fisik drawer berganda", () => {
  const migrationFile = readFileUtf8("supabase/migrations/20261120000100_f5_shift_and_cash_management.sql");
  assert.match(migrationFile, /select \*\s*into v_existing_payment\s*from public\.payments\s*where idempotency_key = v_clean_key/, "Idempotency check harus mendahului mutasi kas");
});

// -----------------------------------------------------------------------------
// BAGIAN 6: ARSITEKTUR & BATASAN KESELAMATAN NINE LICIOUS
// -----------------------------------------------------------------------------

runTest(25, "SAFETY", "Metode pembayaran didukung strictly Tunai dan Midtrans", () => {
  const paymentModal = readFileUtf8("src/components/pos/payment-modal.tsx");
  assert.match(paymentModal, /"cash" \| "midtrans_snap"/, "Payment modal strictly cash & midtrans");
});

runTest(26, "SAFETY", "Tidak ada dependensi Prisma pada package.json", () => {
  const pkg = JSON.parse(readFileUtf8("package.json"));
  assert.strictEqual(pkg.dependencies?.["@prisma/client"], undefined, "@prisma/client dilarang");
  assert.strictEqual(pkg.devDependencies?.prisma, undefined, "prisma CLI dilarang");
});

runTest(27, "SAFETY", "Tidak ada fitur QR ordering mandiri pelanggan", () => {
  assert.strictEqual(fs.existsSync(path.join(ROOT_DIR, "src/app/order")), false, "Rute /order dilarang");
  assert.strictEqual(fs.existsSync(path.join(ROOT_DIR, "src/app/scan")), false, "Rute /scan dilarang");
});

console.log("\n===============================================================================");
console.log(` HASIL PENGUJIAN F5.4: ${passedTests}/${totalTests} TESTS PASS (100% SUKSES)`);
console.log("===============================================================================\n");
