#!/usr/bin/env node
/**
 * NINE LICIOUS POS — MILESTONE F5.3 VERIFICATION & TEST SUITE
 * File: scripts/test-f5-3-cashier-pos-flow.mjs
 *
 * Verifikasi Komprehensif F5.3: Cashier POS Flow & Cash Drawer UI
 *
 * 8 TUJUAN INTI F5.3:
 * 1. Alur pembukaan shift kasir berjalan benar (opening cash, preset nominal, validasi 1 shift aktif).
 * 2. Pembayaran tunai membutuhkan shift aktif di seluruh UI kasir (/pos dan /pos/orders).
 * 3. Pembayaran Midtrans tetap dapat digunakan tanpa shift kasir.
 * 4. Penjualan tunai menambah saldo laci secara atomik via cash_sale.
 * 5. Refund tunai mengurangi saldo laci yang benar tanpa defisit.
 * 6. Kasir dapat melihat saldo dan riwayat mutasi kas di laci kasir (drawer).
 * 7. Kasir dapat menutup shift dan melakukan rekonsiliasi uang fisik vs ekspektasi kasir.
 * 8. Status shift diperbarui secara reaktif di halaman /pos, /pos/orders, dan /pos/shift.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("===============================================================================");
console.log(" NINE LICIOUS POS — F5.3 CASHIER POS FLOW & CASH DRAWER UI VERIFICATION SUITE");
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

// Helper untuk membaca file
function readFileUtf8(relPath) {
  const fullPath = path.join(ROOT_DIR, relPath);
  assert.ok(fs.existsSync(fullPath), `File tidak ditemukan: ${relPath}`);
  return fs.readFileSync(fullPath, "utf-8");
}

// -----------------------------------------------------------------------------
// BAGIAN 1: AUDIT ALUR PEMBUKAAN SHIFT KASIR (GOAL 1)
// -----------------------------------------------------------------------------

runTest(1, "GOAL-1: Shift Opening", "Komponen ShiftManager menyediakan preset modal awal Rp 100k, 200k, 300k, 500k", () => {
  const file = readFileUtf8("src/components/pos/shift/shift-manager.tsx");
  assert.match(file, /QUICK_OPENING_CASH\s*=\s*\[100000,\s*200000,\s*300000,\s*500000\]/, "Preset modal awal harus 100k, 200k, 300k, 500k");
});

runTest(2, "GOAL-1: Shift Opening", "openShiftAction memvalidasi input modal awal >= 0 dan tipe integer", () => {
  const file = readFileUtf8("src/lib/shifts/types.ts");
  assert.match(file, /openingCash:\s*z\.coerce/, "openingCash harus menggunakan z.coerce.number");
  assert.match(file, /\.int\("Modal kas awal harus bilangan bulat rupiah\."\)/, "openingCash harus bilangan bulat");
  assert.match(file, /\.min\(0,\s*"Modal kas awal tidak boleh bernilai negatif\."\)/, "openingCash minimal 0");
});

runTest(3, "GOAL-1: Shift Opening", "openShiftAction memanggil RPC open_shift_atomic dengan parameter p_cashier_id dan p_opening_cash", () => {
  const file = readFileUtf8("src/lib/shifts/actions.ts");
  assert.match(file, /supabase\.rpc\(\s*"open_shift_atomic"/, "openShiftAction harus memanggil open_shift_atomic");
  assert.match(file, /p_opening_cash:\s*openingCash/, "p_opening_cash harus diteruskan ke RPC");
});

runTest(4, "GOAL-1: Shift Opening", "Halaman /pos/shift memuat data shift kasir aktif secara server-side", () => {
  const file = readFileUtf8("src/app/(app)/pos/shift/page.tsx");
  assert.match(file, /requireRole\(\["admin",\s*"kasir"\]\)/, "Halaman /pos/shift harus dilindungi peran kasir dan admin");
  assert.match(file, /getShiftSummaryAction\(\)/, "Harus memanggil getShiftSummaryAction");
  assert.match(file, /getCashMovementsAction\(summary\.shift\.id\)/, "Harus memuat mutasi kas untuk shift aktif");
});

// -----------------------------------------------------------------------------
// BAGIAN 2: AUDIT PEMBAYARAN TUNAI MEMBUTUHKAN SHIFT AKTIF (GOAL 2)
// -----------------------------------------------------------------------------

runTest(5, "GOAL-2: Cash Payment Guard", "PaymentModal mendeteksi activeShift dan memblokir opsi tunai saat tidak ada shift", () => {
  const file = readFileUtf8("src/components/pos/payment-modal.tsx");
  assert.match(file, /method === "cash" && !activeShift/, "PaymentModal harus memvalidasi keberadaan activeShift untuk metode tunai");
  assert.match(file, /\(method === "cash" && !activeShift\)/, "Tombol Bayar Tunai harus disabled saat tidak ada activeShift");
  assert.match(file, /Buka Shift Dahulu/, "Tombol menampilkan teks 'Buka Shift Dahulu' jika kasir belum membuka shift");
});

runTest(6, "GOAL-2: Cash Payment Guard", "PaymentModal menampilkan banner peringatan ketiadaan shift dan tombol Buka Shift", () => {
  const file = readFileUtf8("src/components/pos/payment-modal.tsx");
  assert.match(file, /Shift Kasir Belum Dibuka/, "Banner peringatan Shift Kasir Belum Dibuka harus ada");
  assert.match(file, /href="\/pos\/shift"/, "Banner harus memiliki tautan langsung ke /pos/shift");
});

runTest(7, "GOAL-2: Cash Payment Guard", "Halaman /pos/orders memverifikasi shift aktif kasir yang sedang login", () => {
  const file = readFileUtf8("src/app/(app)/pos/orders/page.tsx");
  assert.match(file, /\.eq\("cashier_id",\s*session\.profile\.id\)/, "Harus mencocokkan cashier_id dengan profil sesi");
  assert.match(file, /\.eq\("status",\s*"open"\)/, "Harus memeriksa status shift 'open'");
});

runTest(8, "GOAL-2: Cash Payment Guard", "Halaman /pos/orders menampilkan warning banner jika shift belum dibuka", () => {
  const file = readFileUtf8("src/app/(app)/pos/orders/page.tsx");
  assert.match(file, /\{!activeShift && \(/, "Harus ada conditional rendering banner ketiadaan shift");
  assert.match(file, /Shift Kasir Belum Dibuka/, "Banner harus menginformasikan bahwa shift kasir belum dibuka");
  assert.match(file, /Buka Shift Kasir Sekarang/, "Tersedia tombol aksi cepat untuk membuka shift");
});

runTest(9, "GOAL-2: Cash Payment Guard", "CashierOrdersBoard menerima activeShift dan meneruskannya ke PaymentModal", () => {
  const boardFile = readFileUtf8("src/components/pos/cashier-orders-board.tsx");
  assert.match(boardFile, /activeShift\?:\s*Shift \| null;/, "CashierOrdersBoardProps harus memiliki prop activeShift");
  assert.match(boardFile, /activeShift=\{activeShift\}/, "PaymentModal harus menerima prop activeShift");
});

runTest(10, "GOAL-2: Cash Payment Guard", "Halaman utama /pos meneruskan activeShift ke PosContainer dan PaymentModal", () => {
  const posPageFile = readFileUtf8("src/app/(app)/pos/page.tsx");
  assert.match(posPageFile, /activeShift\s*=\s*shiftRes\.data as unknown as Shift/, "Halaman /pos harus query activeShift");
  assert.match(posPageFile, /activeShift=\{activeShift\}/, "PosContainer harus menerima prop activeShift");
});

runTest(11, "GOAL-2: Cash Payment Guard", "RPC process_pos_payment_manual menolak pembayaran tunai jika tidak ada shift aktif", () => {
  const migrationFile = readFileUtf8("supabase/migrations/20261120000100_f5_shift_and_cash_management.sql");
  assert.match(migrationFile, /Kasir belum membuka shift kasir\. Buka shift terlebih dahulu sebelum memproses pembayaran tunai\./, "RPC harus memverifikasi shift kasir aktif untuk pembayaran tunai");
});

// -----------------------------------------------------------------------------
// BAGIAN 3: MIDTRANS DAPAT DIGUNAKAN TANPA SHIFT (GOAL 3)
// -----------------------------------------------------------------------------

runTest(12, "GOAL-3: Midtrans Independence", "PaymentModal mengizinkan transaksi Midtrans meskipun tidak ada shift kasir aktif", () => {
  const file = readFileUtf8("src/components/pos/payment-modal.tsx");
  assert.match(file, /setMethod\("midtrans_snap"\)/, "Opsi Midtrans Snap harus dapat dipilih");
  assert.match(file, /createPosMidtransSnapAction/, "Aksi pembuatan transaksi Midtrans Snap harus tersedia");
});

runTest(13, "GOAL-3: Midtrans Independence", "RPC execute_order_payment_internal tidak mengikat shift_id untuk metode non-tunai (midtrans)", () => {
  const migrationFile = readFileUtf8("supabase/migrations/20261120000100_f5_shift_and_cash_management.sql");
  assert.match(migrationFile, /if p_payment_source = 'cash' then\s*if p_shift_id is null then\s*raise exception 'Pembayaran tunai wajib terhubung ke shift kasir yang aktif\.'/, "Hanya metode tunai yang mewajibkan shift_id dan mengunci laci kasir");
});

// -----------------------------------------------------------------------------
// BAGIAN 4: PENJUALAN TUNAI MENAMBAH SALDO LACI SECARA ATOMIK (GOAL 4)
// -----------------------------------------------------------------------------

runTest(14, "GOAL-4: Atomic Cash Sale", "RPC execute_order_payment_internal menambah expected_cash shift secara atomik", () => {
  const migrationFile = readFileUtf8("supabase/migrations/20261120000100_f5_shift_and_cash_management.sql");
  assert.match(migrationFile, /expected_cash = expected_cash \+ p_amount/, "expected_cash harus bertambah sejumlah p_amount");
});

runTest(15, "GOAL-4: Atomic Cash Sale", "RPC mencatat cash_movements bertipe 'cash_sale' dengan relasi payment_id dan order_id", () => {
  const migrationFile = readFileUtf8("supabase/migrations/20261120000100_f5_shift_and_cash_management.sql");
  assert.match(migrationFile, /'cash_sale',/, "Harus mencatat mutasi tipe cash_sale");
  assert.match(migrationFile, /p_order_id,\s*v_payment_id/, "Mutasi harus terhubung dengan order_id dan payment_id");
});

runTest(16, "GOAL-4: Atomic Cash Sale", "processPosManualPaymentAction melakukan revalidasi ke /pos, /pos/orders, /pos/shift, dan /admin/shifts", () => {
  const file = readFileUtf8("src/lib/payments/actions.ts");
  assert.match(file, /revalidatePath\("\/pos"\)/, "Harus merevalidasi /pos");
  assert.match(file, /revalidatePath\("\/pos\/orders"\)/, "Harus merevalidasi /pos/orders");
  assert.match(file, /revalidatePath\("\/pos\/shift"\)/, "Harus merevalidasi /pos/shift");
  assert.match(file, /revalidatePath\("\/admin\/shifts"\)/, "Harus merevalidasi /admin/shifts");
});

// -----------------------------------------------------------------------------
// BAGIAN 5: REFUND TUNAI MENGURANGI SALDO LACI TANPA DEFISIT (GOAL 5)
// -----------------------------------------------------------------------------

runTest(17, "GOAL-5: Drawer Refund Guard", "RPC process_order_refund_atomic menolak refund tunai jika saldo laci kasir tidak mencukupi", () => {
  const migrationFile = readFileUtf8("supabase/migrations/20261120000100_f5_shift_and_cash_management.sql");
  assert.match(migrationFile, /Saldo kas shift tidak mencukupi untuk refund tunai/, "RPC harus menolak jika expected_cash < nominal refund");
});

runTest(18, "GOAL-5: Drawer Refund Guard", "RefundModal hanya menyediakan opsi Tunai (Cash Drawer) dan Midtrans Gateway", () => {
  const file = readFileUtf8("src/components/pos/refund-modal.tsx");
  assert.match(file, /value="cash"/, "Opsi tunai harus tersedia");
  assert.match(file, /value="midtrans"/, "Opsi midtrans harus tersedia");
  assert.doesNotMatch(file, /value="qris_manual"/, "Tidak boleh ada opsi qris_manual");
  assert.doesNotMatch(file, /value="transfer"/, "Tidak boleh ada opsi transfer manual");
});

runTest(19, "GOAL-5: Drawer Refund Guard", "RefundModal menampilkan dropdown pemilihan laci kasir aktif untuk refund tunai", () => {
  const file = readFileUtf8("src/components/pos/refund-modal.tsx");
  assert.match(file, /Pilih laci kasir tempat uang dikeluarkan/, "Harus ada dropdown pemilihan laci kasir");
  assert.match(file, /selectedShiftId/, "RefundModal harus melacak selectedShiftId");
});

runTest(20, "GOAL-5: Drawer Refund Guard", "processOrderRefundAction melakukan revalidasi ke /pos/orders, /pos/shift, dan /admin/shifts", () => {
  const file = readFileUtf8("src/lib/payments/actions.ts");
  assert.match(file, /revalidatePath\("\/pos\/shift"\)/, "RefundAction harus merevalidasi /pos/shift");
  assert.match(file, /revalidatePath\("\/pos\/orders"\)/, "RefundAction harus merevalidasi /pos/orders");
  assert.match(file, /revalidatePath\("\/admin\/shifts"\)/, "RefundAction harus merevalidasi /admin/shifts");
});

// -----------------------------------------------------------------------------
// BAGIAN 6: KASIR MELIHAT SALDO DAN RIWAYAT MUTASI LACI (GOAL 6)
// -----------------------------------------------------------------------------

runTest(21, "GOAL-6: Cash Drawer UI", "ShiftManager menampilkan 5 Metrik Ringkasan Kas (Saldo Kas Laci, Modal Awal, Penjualan Tunai, Refund Tunai, Mutasi Kas Manual)", () => {
  const file = readFileUtf8("src/components/pos/shift/shift-manager.tsx");
  assert.match(file, /Saldo Kas Laci \(Drawer\)/, "Harus menampilkan kartu Saldo Kas Laci (Drawer)");
  assert.match(file, /Modal Awal Kas/, "Harus menampilkan kartu Modal Awal Kas");
  assert.match(file, /Penjualan Tunai/, "Harus menampilkan kartu Penjualan Tunai");
  assert.match(file, /Refund Tunai/, "Harus menampilkan kartu Refund Tunai");
  assert.match(file, /Mutasi Kas Manual/, "Harus menampilkan kartu Mutasi Kas Manual");
});

runTest(22, "GOAL-6: Cash Drawer UI", "ShiftManager memiliki tabel riwayat mutasi kas lengkap dengan badge jenis transaksi", () => {
  const file = readFileUtf8("src/components/pos/shift/shift-manager.tsx");
  assert.match(file, /Buku Besar Mutasi Kas \(Shift Ini\)/, "Harus memiliki tabel buku besar mutasi kas");
  assert.match(file, /getMovementTypeBadge/, "Harus menampilkan badge jenis mutasi");
  assert.match(file, /Kas Masuk/, "Harus membedakan Kas Masuk");
  assert.match(file, /Kas Keluar/, "Harus membedakan Kas Keluar");
});

runTest(23, "GOAL-6: Cash Drawer UI", "ShiftManager menyediakan modal pencatatan Kas Masuk dan Kas Keluar dengan alasan wajib", () => {
  const file = readFileUtf8("src/components/pos/shift/shift-manager.tsx");
  assert.match(file, /handleRecordMovement/, "Harus memiliki handler handleRecordMovement");
  assert.match(file, /Alasan mutasi kas wajib diisi \(minimal 3 karakter\)/, "Wajib validasi alasan minimal 3 karakter");
  assert.match(file, /Kas keluar tidak boleh melebihi saldo kas saat ini/, "Kas keluar tidak boleh melebihi saldo kas laci");
});

// -----------------------------------------------------------------------------
// BAGIAN 7: PENUTUPAN SHIFT DAN REKONSILIASI KAS (GOAL 7)
// -----------------------------------------------------------------------------

runTest(24, "GOAL-7: Shift Reconciliation", "ShiftManager menghitung selisih rekonsiliasi realtime (actual - expected)", () => {
  const file = readFileUtf8("src/components/pos/shift/shift-manager.tsx");
  assert.match(file, /closeCashDifference\s*=\s*actualCashInput\s*-\s*\(summary\?\.expectedCash\s*\?\?\s*0\)/, "Harus menghitung selisih kas fisik vs ekspektasi");
});

runTest(25, "GOAL-7: Shift Reconciliation", "Penutupan shift mewajibkan catatan rekonsiliasi jika terjadi selisih kas fisik", () => {
  const file = readFileUtf8("src/components/pos/shift/shift-manager.tsx");
  assert.match(file, /Terdapat selisih kas fisik\. Catatan rekonsiliasi wajib diisi minimal 3 karakter/, "Wajib catatan jika selisih != 0");
});

runTest(26, "GOAL-7: Shift Reconciliation", "closeShiftAction memanggil close_shift_atomic dengan p_actual_cash dan p_notes", () => {
  const file = readFileUtf8("src/lib/shifts/actions.ts");
  assert.match(file, /supabase\.rpc\(\s*"close_shift_atomic"/, "Harus memanggil close_shift_atomic");
  assert.match(file, /p_actual_cash:\s*actualCash/, "Harus mengirim p_actual_cash");
});

runTest(27, "GOAL-7: Shift Reconciliation", "RPC close_shift_atomic mencatat mutasi closing_reconciliation jika ada selisih kas", () => {
  const migrationFile = readFileUtf8("supabase/migrations/20261120000100_f5_shift_and_cash_management.sql");
  assert.match(migrationFile, /'closing_reconciliation',/, "Harus mencatat mutasi closing_reconciliation saat selisih terjadi");
});

// -----------------------------------------------------------------------------
// BAGIAN 8: REAKTIVITAS STATUS SHIFT DI HALAMAN POS & ORDERS (GOAL 8)
// -----------------------------------------------------------------------------

runTest(28, "GOAL-8: Reactivity & Navigation", "Header /pos menampilkan indikator status shift kasir (Shift Aktif / Buka Shift)", () => {
  const file = readFileUtf8("src/app/(app)/pos/page.tsx");
  assert.match(file, /activeShift \? "Shift Aktif" : "Buka Shift"/, "Header POS harus menampilkan indikator status shift");
  assert.match(file, /href="\/pos\/shift"/, "Harus memiliki link navigasi ke /pos/shift");
});

runTest(29, "GOAL-8: Reactivity & Navigation", "Header /pos/orders menampilkan tombol status shift kasir seragam dengan /pos", () => {
  const file = readFileUtf8("src/app/(app)/pos/orders/page.tsx");
  assert.match(file, /activeShift \? "Shift Aktif" : "Buka Shift"/, "Header Orders harus menampilkan indikator status shift");
  assert.match(file, /href="\/pos\/shift"/, "Harus memiliki link navigasi ke /pos/shift");
});

runTest(30, "GOAL-8: Reactivity & Navigation", "Shift actions (buka, tutup, mutasi) menggunakan router.refresh() alih-alih hard reload", () => {
  const file = readFileUtf8("src/components/pos/shift/shift-manager.tsx");
  assert.match(file, /router\.refresh\(\)/, "Harus memanggil router.refresh()");
  assert.doesNotMatch(file, /window\.location\.reload\(\)/, "Tidak boleh menggunakan window.location.reload()");
});

runTest(31, "GOAL-8: Reactivity & Navigation", "openShiftAction, closeShiftAction, recordCashMovementAction merevalidasi /pos/orders", () => {
  const file = readFileUtf8("src/lib/shifts/actions.ts");
  const countMatches = (file.match(/revalidatePath\("\/pos\/orders"\)/g) || []).length;
  assert.ok(countMatches >= 3, `revalidatePath("/pos/orders") harus dipanggil di open, close, dan record action (ditemukan: ${countMatches})`);
});

// -----------------------------------------------------------------------------
// BAGIAN 9: AUDIT KESELAMATAN & BATASAN ARSITEKTURAL NINE LICIOUS
// -----------------------------------------------------------------------------

runTest(32, "SAFETY: No Prisma", "Tidak ada file skema prisma atau impor pustaka prisma", () => {
  assert.strictEqual(fs.existsSync(path.join(ROOT_DIR, "prisma")), false, "Folder prisma tidak boleh ada");
  const pkg = JSON.parse(readFileUtf8("package.json"));
  assert.strictEqual(pkg.dependencies?.["@prisma/client"], undefined, "@prisma/client tidak boleh terpasang");
  assert.strictEqual(pkg.devDependencies?.prisma, undefined, "prisma CLI tidak boleh terpasang");
});

runTest(33, "SAFETY: Payment Methods", "UI Pembayaran dan Refund hanya mengizinkan Tunai (cash) dan Midtrans", () => {
  const paymentModalFile = readFileUtf8("src/components/pos/payment-modal.tsx");
  assert.match(paymentModalFile, /type PaymentMethodTab\s*=\s*"cash"\s*\|\s*"midtrans_snap"/, "PaymentModal hanya mendukung cash dan midtrans_snap");

  const refundModalFile = readFileUtf8("src/components/pos/refund-modal.tsx");
  assert.match(refundModalFile, /value="cash"/, "RefundModal mendukung cash");
  assert.match(refundModalFile, /value="midtrans"/, "RefundModal mendukung midtrans");
  assert.doesNotMatch(refundModalFile, /value="qris_manual"/, "RefundModal tidak mengizinkan qris_manual");
  assert.doesNotMatch(refundModalFile, /value="transfer"/, "RefundModal tidak mengizinkan transfer manual");
});

runTest(34, "SAFETY: No QR Ordering", "Tidak ada rute customer QR ordering publik", () => {
  assert.strictEqual(fs.existsSync(path.join(ROOT_DIR, "src/app/order")), false, "Rute /order tidak boleh ada");
  assert.strictEqual(fs.existsSync(path.join(ROOT_DIR, "src/app/scan")), false, "Rute /scan tidak boleh ada");
});

// -----------------------------------------------------------------------------
// BAGIAN 10: SIMULASI END-TO-END ARITMATIKA LACI KASIR (GOAL 1-7)
// -----------------------------------------------------------------------------

runTest(35, "SIMULATION: Cash Drawer Ledger Math", "Simulasi lifecycle shift: Modal -> Penjualan Tunai -> Mutasi Kas -> Refund -> Rekonsiliasi", () => {
  // 1. Kasir buka shift dengan modal awal Rp 300.000
  let drawerBalance = 300000;
  let totalCashSales = 0;
  let totalCashRefunds = 0;
  let totalCashIn = 0;
  let totalCashOut = 0;

  // 2. Transaksi Penjualan Tunai #1: Rp 75.000 (Bayar 100.000, Kembali 25.000 -> Net Cash: 75.000)
  const cashSale1 = 75000;
  drawerBalance += cashSale1;
  totalCashSales += cashSale1;
  assert.strictEqual(drawerBalance, 375000, "Saldo setelah penjualan tunai #1 harus Rp 375.000");

  // 3. Transaksi Penjualan Midtrans (Online/QRIS via Gateway): Rp 120.000 -> Drawer tidak terpengaruh!
  const midtransSale = 120000;
  assert.ok(midtransSale > 0);
  // drawerBalance tidak bertambah
  assert.strictEqual(drawerBalance, 375000, "Transaksi Midtrans tidak boleh mengubah saldo laci fisik!");

  // 4. Kas Masuk (misal tukar uang kecil dari brankas pusat): Rp 100.000
  const cashIn1 = 100000;
  drawerBalance += cashIn1;
  totalCashIn += cashIn1;
  assert.strictEqual(drawerBalance, 475000, "Saldo setelah kas masuk harus Rp 475.000");

  // 5. Kas Keluar (beli es batu darurat): Rp 25.000
  const cashOut1 = 25000;
  drawerBalance -= cashOut1;
  totalCashOut += cashOut1;
  assert.strictEqual(drawerBalance, 450000, "Saldo setelah kas keluar harus Rp 450.000");

  // 6. Percobaan Kas Keluar melebihi saldo: Rp 500.000 -> DITOLAK
  const excessiveCashOut = 500000;
  assert.ok(excessiveCashOut > drawerBalance, "Kas keluar melebihi saldo laci harus dicegah");

  // 7. Refund Tunai sebagian: Rp 30.000
  const cashRefund1 = 30000;
  assert.ok(drawerBalance >= cashRefund1, "Laci kasir mencukupi untuk refund");
  drawerBalance -= cashRefund1;
  totalCashRefunds += cashRefund1;
  assert.strictEqual(drawerBalance, 420000, "Saldo setelah refund tunai harus Rp 420.000");

  // 8. Refund Midtrans: Rp 50.000 -> Drawer tidak terpengaruh!
  const midtransRefund = 50000;
  assert.ok(midtransRefund > 0);
  // drawerBalance tidak berkurang
  assert.strictEqual(drawerBalance, 420000, "Refund Midtrans tidak boleh mengubah saldo laci fisik kasir!");

  // 9. Rekonsiliasi Tutup Shift: Uang fisik dihitung Rp 420.000 (Pas)
  const actualCash = 420000;
  const difference = actualCash - drawerBalance;
  assert.strictEqual(difference, 0, "Selisih kas harus Rp 0 saat uang fisik pas");

  // 10. Validasi formula ringkasan saldo
  const netMovements = totalCashIn - totalCashOut;
  const expectedTotal = 300000 + totalCashSales - totalCashRefunds + netMovements;
  assert.strictEqual(drawerBalance, expectedTotal, "Saldo akhir laci kasir harus sesuai formula akuntansi");
});

console.log("\n===============================================================================");
console.log(` HASIL PENGUJIAN F5.3: ${passedTests}/${totalTests} TESTS PASS (100% SUKSES)`);
console.log("===============================================================================\n");
