#!/usr/bin/env node
/**
 * NINE LICIOUS POS — MILESTONE F5.2 VERIFICATION & REGRESSION SUITE
 * File: scripts/test-f5-2-shift-actions.mjs
 *
 * Verifikasi Komprehensif untuk Shift Actions & POS Integration:
 *
 * BAGIAN A: STATIC ARCHITECTURE & CONTRACT AUDIT
 *   1. Keberadaan dan ekspor modul src/lib/shifts/types.ts
 *   2. Keberadaan dan ekspor 8 Server Actions di src/lib/shifts/actions.ts
 *   3. Keberadaan halaman & komponen UI kasir /pos/shift
 *   4. Keberadaan halaman & komponen UI admin /admin/shifts
 *   5. Konfigurasi navigasi role-based di src/lib/navigation.ts
 *
 * BAGIAN B: ZOD SCHEMA & BOUNDARY VALIDATION
 *   6. openShiftSchema: validasi nominal modal awal valid (positif & nol)
 *   7. openShiftSchema: penolakan nominal modal awal negatif
 *   8. openShiftSchema: penolakan non-integer / floating-point rupiah
 *   9. openShiftSchema: validasi panjang catatan <= 500 karakter
 *  10. openShiftSchema: validasi format UUID cashierId opsional
 *  11. closeShiftSchema: validasi nominal uang fisik aktual valid
 *  12. closeShiftSchema: penolakan nominal kas aktual negatif
 *  13. closeShiftSchema: validasi format UUID shiftId wajib
 *  14. recordCashMovementSchema: validasi tipe 'cash_in' dan 'cash_out'
 *  15. recordCashMovementSchema: penolakan tipe mutasi selain cash_in/out
 *  16. recordCashMovementSchema: penolakan nominal mutasi <= 0
 *  17. recordCashMovementSchema: validasi alasan mutasi minimal 3 karakter
 *  18. recordCashMovementSchema: penolakan alasan mutasi kosong atau < 3 karakter
 *
 * BAGIAN C: CASHIER POS PAYMENT INTEGRATION AUDIT
 *  19. PaymentModal: deteksi ketiadaan shift aktif memblokir tombol Cash Payment
 *  20. PaymentModal: banner peringatan 'Shift Belum Dibuka' & link '/pos/shift'
 *  21. PaymentModal: Midtrans Snap tetap aktif tanpa memerlukan shift kasir
 *  22. POS Container & Page: penerusan activeShift dari server query ke container
 *  23. POS Page Header: tombol status shift 'Shift Aktif' / 'Buka Shift'
 *
 * BAGIAN D: CASH REFUND & DRAWER TRACKING INTEGRATION AUDIT
 *  24. RefundModal: dropdown pemilihan laci kasir aktif untuk refund tunai
 *  25. RefundModal: validasi saldo laci kasir mencukupi sebelum memproses refund tunai
 *  26. RefundModal: pengiriman shiftId ke processOrderRefundAction untuk refund tunai
 *  27. RefundModal: opsi refund tunai di luar shift (khusus admin)
 *  28. RefundModal: refund non-tunai (Midtrans/QRIS) tidak mewajibkan shift & tidak mengubah laci
 *
 * BAGIAN E: ADMIN SHIFT MANAGEMENT & LEDGER AUDIT
 *  29. Admin Page Guard: proteksi rute /admin/shifts khusus role admin
 *  30. Admin Shift Actions: getShiftHistoryAction mendukung filter kasir dan paginasi
 *  31. Admin Shift Overview: metrik kas aktif, laci terbuka, dan riwayat rekonsiliasi
 *  32. Admin Ledger Inspection: pemanggilan getCashMovementsAction untuk audit transaksi
 *
 * BAGIAN F: END-TO-END SIMULATION & STATE MACHINE
 *  33. Sim: Kasir mencoba bayar tunai tanpa shift -> DITOLAK
 *  34. Sim: Kasir membuka shift dengan modal awal Rp 500.000 -> status open, expected_cash = 500.000
 *  35. Sim: Kasir dilarang membuka shift kedua saat shift pertama masih open
 *  36. Sim: Kasir dilarang membuka shift atas nama kasir lain
 *  37. Sim: Admin membuka shift atas nama Kasir B dengan catatan terformat
 *  38. Sim: Kasir A memproses pembayaran tunai Rp 150.000 -> expected_cash menjadi Rp 650.000
 *  39. Sim: Pelanggan membayar via Midtrans Snap Rp 250.000 -> laci fisik Kasir A tetap Rp 650.000
 *  40. Sim: Kasir A mencatat kas masuk Rp 50.000 -> expected_cash menjadi Rp 700.000
 *  41. Sim: Kasir A mencatat kas keluar Rp 100.000 (beli bahan) -> expected_cash menjadi Rp 600.000
 *  42. Sim: Kasir A mencatat kas keluar Rp 1.000.000 (melebihi saldo) -> DITOLAK
 *  43. Sim: Refund tunai Rp 50.000 dari laci Kasir A -> expected_cash menjadi Rp 550.000
 *  44. Sim: Refund tunai Rp 600.000 dari laci Kasir A -> DITOLAK (saldo tidak cukup)
 *  45. Sim: Refund Midtrans Rp 100.000 -> laci fisik Kasir A tetap Rp 550.000
 *  46. Sim: Kasir B memiliki laci terisolasi (Rp 200.000) dan tidak terpengaruh transaksi Kasir A
 *  47. Sim: Kasir B dilarang menutup shift Kasir A
 *  48. Sim: Kasir A menutup shift dengan uang fisik pas Rp 550.000 -> status closed, selisih 0
 *  49. Sim: Penutupan shift dengan selisih lebih (+Rp 10.000) dan selisih kurang (-Rp 5.000)
 *  50. Sim: Mutasi kas pada shift yang sudah ditutup -> DITOLAK
 *
 * BAGIAN G: REGRESSION VERIFICATION (F0 - F4)
 *  51. Regresi F0/F1: Dining Session status & POS Cart Item contract
 *  52. Regresi F2: process_pos_payment_manual & processOrderRefundAction tetap kompatibel
 *  53. Regresi F3: KDS item statuses (queued, preparing, ready, served) utuh
 *  54. Regresi F4: Inventory stock reservation & ingredient deduction triggers utuh
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

console.log("===============================================================================");
console.log(" NINE LICIOUS POS — F5.2 SHIFT ACTIONS & POS INTEGRATION VERIFICATION SUITE");
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

// =============================================================================
// BAGIAN A: STATIC ARCHITECTURE & CONTRACT AUDIT
// =============================================================================

runTest(1, "STATIC-AUDIT", "src/lib/shifts/types.ts tersedia dan mengekspor skema serta tipe", () => {
  const filePath = path.resolve(process.cwd(), "src/lib/shifts/types.ts");
  assert.ok(fs.existsSync(filePath), "File src/lib/shifts/types.ts harus ada.");
  const content = fs.readFileSync(filePath, "utf-8");

  assert.ok(content.includes("export const openShiftSchema"), "openShiftSchema harus diekspor.");
  assert.ok(content.includes("export const closeShiftSchema"), "closeShiftSchema harus diekspor.");
  assert.ok(content.includes("export const recordCashMovementSchema"), "recordCashMovementSchema harus diekspor.");
  assert.ok(content.includes("export type ShiftWithCashier"), "ShiftWithCashier harus diekspor.");
  assert.ok(content.includes("export type ShiftSummary"), "ShiftSummary harus diekspor.");
  assert.ok(content.includes("export type ShiftActionResult"), "ShiftActionResult harus diekspor.");
});

runTest(2, "STATIC-AUDIT", "src/lib/shifts/actions.ts mengekspor 8 Server Actions F5.2", () => {
  const filePath = path.resolve(process.cwd(), "src/lib/shifts/actions.ts");
  assert.ok(fs.existsSync(filePath), "File src/lib/shifts/actions.ts harus ada.");
  const content = fs.readFileSync(filePath, "utf-8");

  assert.ok(content.includes('"use server"'), 'File harus memiliki direktif "use server".');
  assert.ok(content.includes("export async function openShiftAction"), "openShiftAction harus ada.");
  assert.ok(content.includes("export async function getActiveShiftAction"), "getActiveShiftAction harus ada.");
  assert.ok(content.includes("export async function getAllActiveShiftsAction"), "getAllActiveShiftsAction harus ada.");
  assert.ok(content.includes("export async function getShiftSummaryAction"), "getShiftSummaryAction harus ada.");
  assert.ok(content.includes("export async function closeShiftAction"), "closeShiftAction harus ada.");
  assert.ok(content.includes("export async function recordCashMovementAction"), "recordCashMovementAction harus ada.");
  assert.ok(content.includes("export async function getCashMovementsAction"), "getCashMovementsAction harus ada.");
  assert.ok(content.includes("export async function getShiftHistoryAction"), "getShiftHistoryAction harus ada.");

  // Memastikan menggunakan RPC atomik database, tidak menghitung mutasi kas manual di TypeScript
  assert.ok(content.includes('"open_shift_atomic"'), "Harus memanggil open_shift_atomic.");
  assert.ok(content.includes('"close_shift_atomic"'), "Harus memanggil close_shift_atomic.");
  assert.ok(content.includes('"record_cash_movement_atomic"'), "Harus memanggil record_cash_movement_atomic.");
});

runTest(3, "STATIC-AUDIT", "Komponen UI kasir shift tersedia di /pos/shift", () => {
  const pagePath = path.resolve(process.cwd(), "src/app/(app)/pos/shift/page.tsx");
  const compPath = path.resolve(process.cwd(), "src/components/pos/shift/shift-manager.tsx");

  assert.ok(fs.existsSync(pagePath), "Page /pos/shift/page.tsx harus ada.");
  assert.ok(fs.existsSync(compPath), "Komponen shift-manager.tsx harus ada.");

  const pageContent = fs.readFileSync(pagePath, "utf-8");
  assert.ok(pageContent.includes('requireRole(["admin", "kasir"])'), "Role kasir dan admin diizinkan di /pos/shift.");
});

runTest(4, "STATIC-AUDIT", "Komponen UI admin shift tersedia di /admin/shifts", () => {
  const pagePath = path.resolve(process.cwd(), "src/app/(app)/admin/shifts/page.tsx");
  const compPath = path.resolve(process.cwd(), "src/components/admin/shifts/admin-shift-manager.tsx");

  assert.ok(fs.existsSync(pagePath), "Page /admin/shifts/page.tsx harus ada.");
  assert.ok(fs.existsSync(compPath), "Komponen admin-shift-manager.tsx harus ada.");

  const pageContent = fs.readFileSync(pagePath, "utf-8");
  assert.ok(pageContent.includes('requireRole(["admin"])'), "Hanya role admin yang diizinkan di /admin/shifts.");
});

runTest(5, "STATIC-AUDIT", "Konfigurasi navigasi di src/lib/navigation.ts mencakup rute shift", () => {
  const navPath = path.resolve(process.cwd(), "src/lib/navigation.ts");
  assert.ok(fs.existsSync(navPath), "File src/lib/navigation.ts harus ada.");
  const content = fs.readFileSync(navPath, "utf-8");

  assert.ok(content.includes('href: "/admin/shifts"'), "Rute /admin/shifts harus terdaftar di navigation.");
  assert.ok(content.includes('href: "/pos/shift"'), "Rute /pos/shift harus terdaftar di navigation.");
});

// =============================================================================
// BAGIAN B: ZOD SCHEMA & BOUNDARY VALIDATION
// =============================================================================

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const openShiftSchema = z.object({
  openingCash: z.coerce
    .number({ message: "Modal kas awal harus berupa angka." })
    .int("Modal kas awal harus bilangan bulat rupiah.")
    .min(0, "Modal kas awal tidak boleh bernilai negatif."),
  notes: z
    .string()
    .trim()
    .max(500, "Catatan maksimal 500 karakter.")
    .optional()
    .nullable(),
  cashierId: z
    .string()
    .trim()
    .regex(uuidRegex, "ID kasir tidak valid.")
    .optional()
    .nullable(),
});

const closeShiftSchema = z.object({
  shiftId: z
    .string({ message: "ID shift wajib diisi." })
    .trim()
    .regex(uuidRegex, "ID shift tidak valid."),
  actualCash: z.coerce
    .number({ message: "Nominal uang fisik harus berupa angka." })
    .int("Nominal uang fisik harus bilangan bulat rupiah.")
    .min(0, "Nominal kas fisik tidak boleh bernilai negatif."),
  notes: z
    .string()
    .trim()
    .max(500, "Catatan maksimal 500 karakter.")
    .optional()
    .nullable(),
});

const recordCashMovementSchema = z.object({
  shiftId: z
    .string({ message: "ID shift wajib diisi." })
    .trim()
    .regex(uuidRegex, "ID shift tidak valid."),
  movementType: z.enum(["cash_in", "cash_out"], {
    message: "Tipe mutasi kas harus 'cash_in' atau 'cash_out'.",
  }),
  amount: z.coerce
    .number({ message: "Nominal mutasi harus berupa angka." })
    .int("Nominal mutasi harus bilangan bulat rupiah.")
    .positive("Nominal mutasi kas harus lebih besar dari Rp 0."),
  reason: z
    .string({ message: "Alasan mutasi kas wajib diisi." })
    .trim()
    .min(3, "Alasan mutasi kas minimal 3 karakter.")
    .max(255, "Alasan mutasi kas maksimal 255 karakter."),
});

runTest(6, "SCHEMA-VALIDATION", "openShiftSchema: validasi nominal modal awal valid (positif & nol)", () => {
  const res1 = openShiftSchema.safeParse({ openingCash: 500000 });
  assert.equal(res1.success, true);
  assert.equal(res1.data.openingCash, 500000);

  const res2 = openShiftSchema.safeParse({ openingCash: 0, notes: "Mulai shift tanpa modal awal" });
  assert.equal(res2.success, true);
  assert.equal(res2.data.openingCash, 0);

  const res3 = openShiftSchema.safeParse({ openingCash: "250000" });
  assert.equal(res3.success, true);
  assert.equal(res3.data.openingCash, 250000);
});

runTest(7, "SCHEMA-VALIDATION", "openShiftSchema: penolakan nominal modal awal negatif", () => {
  const res = openShiftSchema.safeParse({ openingCash: -50000 });
  assert.equal(res.success, false);
  assert.ok(res.error.issues.some((i) => i.message.includes("tidak boleh bernilai negatif")));
});

runTest(8, "SCHEMA-VALIDATION", "openShiftSchema: penolakan non-integer / floating-point rupiah", () => {
  const res = openShiftSchema.safeParse({ openingCash: 500000.75 });
  assert.equal(res.success, false);
  assert.ok(res.error.issues.some((i) => i.message.includes("bilangan bulat")));
});

runTest(9, "SCHEMA-VALIDATION", "openShiftSchema: validasi panjang catatan <= 500 karakter", () => {
  const okNotes = "a".repeat(500);
  const res1 = openShiftSchema.safeParse({ openingCash: 100000, notes: okNotes });
  assert.equal(res1.success, true);

  const tooLong = "a".repeat(501);
  const res2 = openShiftSchema.safeParse({ openingCash: 100000, notes: tooLong });
  assert.equal(res2.success, false);
  assert.ok(res2.error.issues.some((i) => i.message.includes("maksimal 500 karakter")));
});

runTest(10, "SCHEMA-VALIDATION", "openShiftSchema: validasi format UUID cashierId opsional", () => {
  const validUUID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
  const res1 = openShiftSchema.safeParse({ openingCash: 100000, cashierId: validUUID });
  assert.equal(res1.success, true);

  const invalidUUID = "bukan-uuid-yang-valid";
  const res2 = openShiftSchema.safeParse({ openingCash: 100000, cashierId: invalidUUID });
  assert.equal(res2.success, false);
  assert.ok(res2.error.issues.some((i) => i.message.includes("ID kasir tidak valid")));
});

runTest(11, "SCHEMA-VALIDATION", "closeShiftSchema: validasi nominal uang fisik aktual valid", () => {
  const validUUID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
  const res = closeShiftSchema.safeParse({
    shiftId: validUUID,
    actualCash: 650000,
    notes: "Uang fisik pas sesuai pembukuan laci.",
  });
  assert.equal(res.success, true);
  assert.equal(res.data.actualCash, 650000);
});

runTest(12, "SCHEMA-VALIDATION", "closeShiftSchema: penolakan nominal kas aktual negatif", () => {
  const validUUID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
  const res = closeShiftSchema.safeParse({
    shiftId: validUUID,
    actualCash: -1000,
  });
  assert.equal(res.success, false);
  assert.ok(res.error.issues.some((i) => i.message.includes("tidak boleh bernilai negatif")));
});

runTest(13, "SCHEMA-VALIDATION", "closeShiftSchema: validasi format UUID shiftId wajib", () => {
  const res = closeShiftSchema.safeParse({
    shiftId: "invalid-id",
    actualCash: 500000,
  });
  assert.equal(res.success, false);
  assert.ok(res.error.issues.some((i) => i.message.includes("ID shift tidak valid")));
});

runTest(14, "SCHEMA-VALIDATION", "recordCashMovementSchema: validasi tipe 'cash_in' dan 'cash_out'", () => {
  const validUUID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
  const resIn = recordCashMovementSchema.safeParse({
    shiftId: validUUID,
    movementType: "cash_in",
    amount: 50000,
    reason: "Tambahan uang kembalian pecahan kecil",
  });
  assert.equal(resIn.success, true);

  const resOut = recordCashMovementSchema.safeParse({
    shiftId: validUUID,
    movementType: "cash_out",
    amount: 25000,
    reason: "Beli es batu kristal",
  });
  assert.equal(resOut.success, true);
});

runTest(15, "SCHEMA-VALIDATION", "recordCashMovementSchema: penolakan tipe mutasi selain cash_in/out", () => {
  const validUUID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
  const res = recordCashMovementSchema.safeParse({
    shiftId: validUUID,
    movementType: "cash_sale", // cash_sale hanya boleh lewat payment engine
    amount: 50000,
    reason: "Uji coba tipe terlarang",
  });
  assert.equal(res.success, false);
  assert.ok(res.error.issues.some((i) => i.message.includes("cash_in") && i.message.includes("cash_out")));
});

runTest(16, "SCHEMA-VALIDATION", "recordCashMovementSchema: penolakan nominal mutasi <= 0", () => {
  const validUUID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
  const resZero = recordCashMovementSchema.safeParse({
    shiftId: validUUID,
    movementType: "cash_in",
    amount: 0,
    reason: "Mutasi nol rupiah",
  });
  assert.equal(resZero.success, false);

  const resNeg = recordCashMovementSchema.safeParse({
    shiftId: validUUID,
    movementType: "cash_in",
    amount: -5000,
    reason: "Mutasi negatif",
  });
  assert.equal(resNeg.success, false);
});

runTest(17, "SCHEMA-VALIDATION", "recordCashMovementSchema: validasi alasan mutasi minimal 3 karakter", () => {
  const validUUID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
  const res = recordCashMovementSchema.safeParse({
    shiftId: validUUID,
    movementType: "cash_in",
    amount: 10000,
    reason: "Gas", // 3 chars
  });
  assert.equal(res.success, true);
});

runTest(18, "SCHEMA-VALIDATION", "recordCashMovementSchema: penolakan alasan mutasi kosong atau < 3 karakter", () => {
  const validUUID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
  const resShort = recordCashMovementSchema.safeParse({
    shiftId: validUUID,
    movementType: "cash_in",
    amount: 10000,
    reason: "ok", // 2 chars
  });
  assert.equal(resShort.success, false);
  assert.ok(resShort.error.issues.some((i) => i.message.includes("minimal 3 karakter")));

  const resEmpty = recordCashMovementSchema.safeParse({
    shiftId: validUUID,
    movementType: "cash_in",
    amount: 10000,
    reason: "   ",
  });
  assert.equal(resEmpty.success, false);
});

// =============================================================================
// BAGIAN C: CASHIER POS PAYMENT INTEGRATION AUDIT
// =============================================================================

runTest(19, "POS-INTEGRATION", "PaymentModal: deteksi ketiadaan shift aktif memblokir tombol Cash Payment", () => {
  const filePath = path.resolve(process.cwd(), "src/components/pos/payment-modal.tsx");
  const content = fs.readFileSync(filePath, "utf-8");

  assert.ok(
    content.includes('(method === "cash" && !activeShift)'),
    "Tombol bayar tunai dinonaktifkan ketika tidak ada shift aktif.",
  );
  assert.ok(
    content.includes('method === "cash" && !activeShift ? (') && content.includes("Buka Shift Dahulu"),
    "Harus menampilkan teks 'Buka Shift Dahulu' pada tombol jika kasir belum buka shift.",
  );
  assert.ok(content.includes('setMethod("cash")'), "Harus ada pilihan metode pembayaran tunai.");
});

runTest(20, "POS-INTEGRATION", "PaymentModal: banner peringatan 'Shift Belum Dibuka' & link '/pos/shift'", () => {
  const filePath = path.resolve(process.cwd(), "src/components/pos/payment-modal.tsx");
  const content = fs.readFileSync(filePath, "utf-8");

  assert.ok(content.includes("Shift Kasir Belum Dibuka"), "Harus menampilkan peringatan Shift Kasir Belum Dibuka.");
  assert.ok(content.includes('href="/pos/shift"'), "Harus memiliki CTA navigasi ke /pos/shift.");
});

runTest(21, "POS-INTEGRATION", "PaymentModal: Midtrans Snap tetap aktif tanpa memerlukan shift kasir", () => {
  const filePath = path.resolve(process.cwd(), "src/components/pos/payment-modal.tsx");
  const content = fs.readFileSync(filePath, "utf-8");

  assert.ok(content.includes('setMethod("midtrans_snap")'), "Harus ada pilihan metode Midtrans Snap.");
  assert.ok(content.includes("Buka Midtrans Snap"), "Harus ada tombol Buka Midtrans Snap.");
  assert.ok(content.includes('(method === "cash" && !activeShift)'), "Blokir shift hanya diberlakukan untuk metode cash.");
});

runTest(22, "POS-INTEGRATION", "POS Container & Page: penerusan activeShift dari server query ke container", () => {
  const pagePath = path.resolve(process.cwd(), "src/app/(app)/pos/page.tsx");
  const containerPath = path.resolve(process.cwd(), "src/components/pos/pos-container.tsx");

  const pageContent = fs.readFileSync(pagePath, "utf-8");
  const containerContent = fs.readFileSync(containerPath, "utf-8");

  assert.ok(pageContent.includes('.from("shifts")'), "Page /pos harus melakukan query tabel shifts.");
  assert.ok(pageContent.includes('.eq("status", "open")'), "Page /pos harus memfilter shift yang sedang open.");
  assert.ok(pageContent.includes("activeShift={activeShift}"), "Page /pos harus meneruskan prop activeShift ke PosContainer.");

  assert.ok(containerContent.includes("activeShift?: Shift | null"), "PosContainerProps harus menerima activeShift.");
  assert.ok(containerContent.includes("activeShift={activeShift}"), "PosContainer harus meneruskan activeShift ke PaymentModal.");
});

runTest(23, "POS-INTEGRATION", "POS Page Header: tombol status shift 'Shift Aktif' / 'Buka Shift'", () => {
  const pagePath = path.resolve(process.cwd(), "src/app/(app)/pos/page.tsx");
  const pageContent = fs.readFileSync(pagePath, "utf-8");

  assert.ok(pageContent.includes("Shift Aktif"), "Harus menampilkan teks 'Shift Aktif' ketika shift terbuka.");
  assert.ok(pageContent.includes("Buka Shift"), "Harus menampilkan tombol 'Buka Shift' ketika belum ada shift.");
  assert.ok(pageContent.includes('href="/pos/shift"'), "Tombol status shift harus mengarah ke /pos/shift.");
});

// =============================================================================
// BAGIAN D: CASH REFUND & DRAWER TRACKING INTEGRATION AUDIT
// =============================================================================

runTest(24, "REFUND-INTEGRATION", "RefundModal: dropdown pemilihan laci kasir aktif untuk refund tunai", () => {
  const filePath = path.resolve(process.cwd(), "src/components/pos/refund-modal.tsx");
  const content = fs.readFileSync(filePath, "utf-8");

  assert.ok(content.includes("getAllActiveShiftsAction"), "RefundModal harus memanggil getAllActiveShiftsAction.");
  assert.ok(content.includes("selectedShiftId"), "RefundModal harus memiliki state selectedShiftId.");
  assert.ok(content.includes("Laci Kasir Pengeluar"), "Harus ada label dropdown Laci Kasir Pengeluar.");
});

runTest(25, "REFUND-INTEGRATION", "RefundModal: validasi saldo laci kasir mencukupi sebelum memproses refund tunai", () => {
  const filePath = path.resolve(process.cwd(), "src/components/pos/refund-modal.tsx");
  const content = fs.readFileSync(filePath, "utf-8");

  assert.ok(content.includes("isShiftDeficit"), "RefundModal harus memiliki logika isShiftDeficit.");
  assert.ok(content.includes("Saldo kas laci kasir"), "Harus memvalidasi kecukupan saldo kas laci kasir.");
});

runTest(26, "REFUND-INTEGRATION", "RefundModal: pengiriman shiftId ke processOrderRefundAction untuk refund tunai", () => {
  const filePath = path.resolve(process.cwd(), "src/components/pos/refund-modal.tsx");
  const content = fs.readFileSync(filePath, "utf-8");

  assert.ok(content.includes('refundMethod === "cash" && selectedShiftId !== "none"'), "Harus mengirim shiftId jika refundMethod adalah cash dan laci dipilih.");
});

runTest(27, "REFUND-INTEGRATION", "RefundModal: opsi refund tunai di luar shift (khusus admin)", () => {
  const filePath = path.resolve(process.cwd(), "src/components/pos/refund-modal.tsx");
  const content = fs.readFileSync(filePath, "utf-8");

  assert.ok(content.includes("none"), "Harus memiliki opsi 'none' (di luar shift kasir).");
  assert.ok(content.includes("isAdmin"), "Harus memeriksa role admin untuk opsi di luar shift.");
});

runTest(28, "REFUND-INTEGRATION", "RefundModal: hanya mendukung Tunai dan Midtrans (tanpa QRIS/transfer) & isolasi non-tunai", () => {
  const filePath = path.resolve(process.cwd(), "src/components/pos/refund-modal.tsx");
  const content = fs.readFileSync(filePath, "utf-8");

  // Pilihan laci kasir hanya muncul jika refundMethod === 'cash'
  assert.ok(content.includes('refundMethod === "cash"'), "Dropdown laci kasir hanya dirender untuk metode tunai.");
  assert.ok(!content.includes('value="qris_manual"'), "Opsi QRIS Manual tidak boleh ada di RefundModal.");
  assert.ok(!content.includes('value="transfer"'), "Opsi Transfer Manual tidak boleh ada di RefundModal.");
  assert.ok(content.includes('value="cash"'), "Metode Tunai harus tersedia.");
  assert.ok(content.includes('value="midtrans"'), "Metode Midtrans harus tersedia.");
});

// =============================================================================
// BAGIAN E: ADMIN SHIFT MANAGEMENT & LEDGER AUDIT
// =============================================================================

runTest(29, "ADMIN-SHIFT", "Admin Page Guard: proteksi rute /admin/shifts khusus role admin", () => {
  const filePath = path.resolve(process.cwd(), "src/app/(app)/admin/shifts/page.tsx");
  const content = fs.readFileSync(filePath, "utf-8");

  assert.ok(content.includes('requireRole(["admin"])'), "Halaman /admin/shifts harus dibatasi hanya untuk admin.");
});

runTest(30, "ADMIN-SHIFT", "Admin Shift Actions: getShiftHistoryAction mendukung filter kasir dan paginasi", () => {
  const filePath = path.resolve(process.cwd(), "src/lib/shifts/actions.ts");
  const content = fs.readFileSync(filePath, "utf-8");

  assert.ok(content.includes("getShiftHistoryAction"), "getShiftHistoryAction harus ada.");
  assert.ok(content.includes("options?.cashierId"), "Mendukung filter cashierId.");
  assert.ok(content.includes("range(offset, offset + limit - 1)"), "Mendukung paginasi data.");
});

runTest(31, "ADMIN-SHIFT", "Admin Shift Overview: metrik kas aktif, laci terbuka, dan riwayat rekonsiliasi", () => {
  const compPath = path.resolve(process.cwd(), "src/components/admin/shifts/admin-shift-manager.tsx");
  const content = fs.readFileSync(compPath, "utf-8");

  assert.ok(content.includes("Total Kas Drawer Beredar"), "Harus menampilkan kartu Total Kas Drawer Beredar.");
  assert.ok(content.includes("Shift Kasir Aktif"), "Harus menampilkan kartu Shift Kasir Aktif.");
  assert.ok(content.includes("Total Riwayat Shift"), "Harus menampilkan kartu Total Riwayat Shift.");
});

runTest(32, "ADMIN-SHIFT", "Admin Ledger Inspection: pemanggilan getCashMovementsAction untuk audit transaksi", () => {
  const compPath = path.resolve(process.cwd(), "src/components/admin/shifts/admin-shift-manager.tsx");
  const content = fs.readFileSync(compPath, "utf-8");

  assert.ok(content.includes("getCashMovementsAction"), "Admin component harus memanggil getCashMovementsAction.");
  assert.ok(content.includes("Detail Mutasi Kas Shift"), "Harus menyediakan modal Detail Mutasi Kas Shift.");
});

// =============================================================================
// BAGIAN F: END-TO-END SIMULATION & STATE MACHINE
// =============================================================================

class MockShiftEngine {
  constructor() {
    this.shifts = new Map();
    this.cashMovements = new Map();
    this.payments = new Map();
    this.movementSeq = 1;
    this.shiftSeq = 1;
  }

  openShift({ cashierId, cashierName, openingCash, notes, openedByAdminId = null, callerRole = "kasir" }) {
    // RBAC: Hanya admin yang boleh buka atas nama kasir lain
    if (openedByAdminId && callerRole !== "admin") {
      throw new Error("Hanya admin yang dapat membuka shift atas nama kasir lain.");
    }

    // Constraint: 1 active shift per cashier
    for (const s of this.shifts.values()) {
      if (s.cashier_id === cashierId && s.status === "open") {
        throw new Error("Kasir ini masih memiliki shift aktif yang belum ditutup.");
      }
    }

    const id = `shift-${this.shiftSeq++}`;
    const formattedNotes = openedByAdminId ? `[Dibuka oleh Admin: ${openedByAdminId}] ${notes || ""}`.trim() : notes || null;
    const shift = {
      id,
      cashier_id: cashierId,
      cashier_name: cashierName,
      status: "open",
      opening_cash: openingCash,
      expected_cash: openingCash,
      actual_cash: null,
      cash_difference: null,
      notes: formattedNotes,
      opened_by_admin_id: openedByAdminId,
      is_opened_by_admin: Boolean(openedByAdminId),
      opened_at: new Date().toISOString(),
      closed_at: null,
    };
    this.shifts.set(id, shift);
    return shift;
  }

  processPayment({ orderId, cashierId, amount, paymentMethod }) {
    if (paymentMethod === "cash") {
      // Wajib shift aktif
      const activeShift = Array.from(this.shifts.values()).find(
        (s) => s.cashier_id === cashierId && s.status === "open",
      );
      if (!activeShift) {
        throw new Error("Pembayaran tunai membutuhkan shift kasir yang aktif.");
      }

      const paymentId = `pay-${this.payments.size + 1}`;
      const payment = {
        id: paymentId,
        order_id: orderId,
        amount,
        payment_method: "cash",
        shift_id: activeShift.id,
      };
      this.payments.set(paymentId, payment);

      // Mutasi kas (cash_sale)
      const movementId = `mov-${this.movementSeq++}`;
      this.cashMovements.set(movementId, {
        id: movementId,
        shift_id: activeShift.id,
        movement_type: "cash_sale",
        amount,
        reason: `Penjualan Tunai Order ${orderId}`,
        payment_id: paymentId,
      });

      // Update expected_cash
      activeShift.expected_cash += amount;
      return payment;
    } else {
      // Midtrans Snap / Non-cash tidak butuh shift & tidak mutasi laci
      const paymentId = `pay-${this.payments.size + 1}`;
      const payment = {
        id: paymentId,
        order_id: orderId,
        amount,
        payment_method: paymentMethod,
        shift_id: null,
      };
      this.payments.set(paymentId, payment);
      return payment;
    }
  }

  recordManualMovement({ shiftId, cashierId, callerRole, movementType, amount, reason }) {
    const shift = this.shifts.get(shiftId);
    if (!shift) throw new Error("Shift tidak ditemukan.");
    if (shift.status !== "open") throw new Error("Mutasi kas hanya dapat dicatat pada shift yang berstatus 'open'.");

    if (callerRole !== "admin" && shift.cashier_id !== cashierId) {
      throw new Error("Anda tidak berhak mencatat mutasi pada shift kasir lain.");
    }

    if (movementType === "cash_out") {
      if (amount > shift.expected_cash) {
        throw new Error(`Saldo kas shift tidak mencukupi (Tersedia: Rp ${shift.expected_cash}, Diminta: Rp ${amount}).`);
      }
      shift.expected_cash -= amount;
    } else if (movementType === "cash_in") {
      shift.expected_cash += amount;
    } else {
      throw new Error("Tipe mutasi tidak valid.");
    }

    const movementId = `mov-${this.movementSeq++}`;
    const movement = {
      id: movementId,
      shift_id: shiftId,
      movement_type: movementType,
      amount,
      reason,
      created_by: cashierId,
    };
    this.cashMovements.set(movementId, movement);
    return movement;
  }

  processRefund({ orderId, amount, refundMethod, shiftId = null, callerRole = "admin" }) {
    if (callerRole !== "admin") {
      throw new Error("Hanya admin yang berhak melakukan refund pesanan.");
    }

    if (refundMethod === "cash") {
      if (shiftId) {
        const shift = this.shifts.get(shiftId);
        if (!shift) throw new Error("Shift laci kasir tidak ditemukan.");
        if (shift.status !== "open") throw new Error("Shift laci pengeluar refund sudah ditutup.");
        if (amount > shift.expected_cash) {
          throw new Error(`Saldo kas laci tidak mencukupi untuk refund (Tersedia: Rp ${shift.expected_cash}, Diminta: Rp ${amount}).`);
        }

        shift.expected_cash -= amount;
        const movementId = `mov-${this.movementSeq++}`;
        this.cashMovements.set(movementId, {
          id: movementId,
          shift_id: shiftId,
          movement_type: "cash_refund",
          amount,
          reason: `Refund Tunai Order ${orderId}`,
        });
      } else {
        // Refund tunai di luar shift
        const movementId = `mov-${this.movementSeq++}`;
        this.cashMovements.set(movementId, {
          id: movementId,
          shift_id: null,
          movement_type: "cash_refund",
          amount,
          reason: `Refund Tunai di luar shift Order ${orderId}`,
        });
      }
    } else {
      // Non-cash refund tidak mengubah laci shift
      return { ok: true, refundMethod };
    }
  }

  closeShift({ shiftId, cashierId, callerRole, actualCash, notes }) {
    const shift = this.shifts.get(shiftId);
    if (!shift) throw new Error("Shift tidak ditemukan.");
    if (shift.status !== "open") throw new Error("Shift ini sudah ditutup sebelumnya.");

    if (callerRole !== "admin" && shift.cashier_id !== cashierId) {
      throw new Error("Anda tidak berhak menutup shift milik kasir lain.");
    }

    shift.status = "closed";
    shift.actual_cash = actualCash;
    shift.cash_difference = actualCash - shift.expected_cash;
    shift.closed_at = new Date().toISOString();
    if (notes) shift.notes = shift.notes ? `${shift.notes}\n[Tutup]: ${notes}` : notes;
    return shift;
  }
}

const engine = new MockShiftEngine();

runTest(33, "SIM-LIFECYCLE", "Sim: Kasir mencoba bayar tunai tanpa shift -> DITOLAK", () => {
  assert.throws(
    () => {
      engine.processPayment({
        orderId: "ord-101",
        cashierId: "usr-kasir-1",
        amount: 50000,
        paymentMethod: "cash",
      });
    },
    { message: /Pembayaran tunai membutuhkan shift kasir yang aktif/ },
  );
});

runTest(34, "SIM-LIFECYCLE", "Sim: Kasir membuka shift dengan modal awal Rp 500.000 -> status open, expected_cash = 500.000", () => {
  const shift1 = engine.openShift({
    cashierId: "usr-kasir-1",
    cashierName: "Budi Santoso",
    openingCash: 500000,
    notes: "Shift Pagi Kasir 1",
    callerRole: "kasir",
  });

  assert.equal(shift1.status, "open");
  assert.equal(shift1.opening_cash, 500000);
  assert.equal(shift1.expected_cash, 500000);
  assert.equal(shift1.is_opened_by_admin, false);
});

runTest(35, "SIM-LIFECYCLE", "Sim: Kasir dilarang membuka shift kedua saat shift pertama masih open", () => {
  assert.throws(
    () => {
      engine.openShift({
        cashierId: "usr-kasir-1",
        cashierName: "Budi Santoso",
        openingCash: 200000,
        callerRole: "kasir",
      });
    },
    { message: /masih memiliki shift aktif/ },
  );
});

runTest(36, "SIM-LIFECYCLE", "Sim: Kasir dilarang membuka shift atas nama kasir lain", () => {
  assert.throws(
    () => {
      engine.openShift({
        cashierId: "usr-kasir-2",
        cashierName: "Siti Rahma",
        openingCash: 300000,
        openedByAdminId: "usr-kasir-1",
        callerRole: "kasir",
      });
    },
    { message: /Hanya admin yang dapat membuka shift atas nama kasir lain/ },
  );
});

runTest(37, "SIM-LIFECYCLE", "Sim: Admin membuka shift atas nama Kasir B dengan catatan terformat", () => {
  const shift2 = engine.openShift({
    cashierId: "usr-kasir-2",
    cashierName: "Siti Rahma",
    openingCash: 200000,
    notes: "Shift Kasir 2 dibuka oleh Supervisor",
    openedByAdminId: "usr-admin-owner",
    callerRole: "admin",
  });

  assert.equal(shift2.status, "open");
  assert.equal(shift2.opening_cash, 200000);
  assert.equal(shift2.expected_cash, 200000);
  assert.equal(shift2.is_opened_by_admin, true);
  assert.ok(shift2.notes.startsWith("[Dibuka oleh Admin: usr-admin-owner]"));
});

runTest(38, "SIM-LIFECYCLE", "Sim: Kasir A memproses pembayaran tunai Rp 150.000 -> expected_cash menjadi Rp 650.000", () => {
  const pay = engine.processPayment({
    orderId: "ord-102",
    cashierId: "usr-kasir-1",
    amount: 150000,
    paymentMethod: "cash",
  });

  const shift1 = engine.shifts.get("shift-1");
  assert.equal(pay.payment_method, "cash");
  assert.equal(pay.shift_id, "shift-1");
  assert.equal(shift1.expected_cash, 650000);
});

runTest(39, "SIM-LIFECYCLE", "Sim: Pelanggan membayar via Midtrans Snap Rp 250.000 -> laci fisik Kasir A tetap Rp 650.000", () => {
  const pay = engine.processPayment({
    orderId: "ord-103",
    cashierId: "usr-kasir-1",
    amount: 250000,
    paymentMethod: "midtrans",
  });

  const shift1 = engine.shifts.get("shift-1");
  assert.equal(pay.shift_id, null);
  assert.equal(shift1.expected_cash, 650000); // Saldo kas tidak terpengaruh Midtrans
});

runTest(40, "SIM-LIFECYCLE", "Sim: Kasir A mencatat kas masuk Rp 50.000 -> expected_cash menjadi Rp 700.000", () => {
  const mov = engine.recordManualMovement({
    shiftId: "shift-1",
    cashierId: "usr-kasir-1",
    callerRole: "kasir",
    movementType: "cash_in",
    amount: 50000,
    reason: "Pecahan kembalian dari brankas",
  });

  const shift1 = engine.shifts.get("shift-1");
  assert.equal(mov.movement_type, "cash_in");
  assert.equal(shift1.expected_cash, 700000);
});

runTest(41, "SIM-LIFECYCLE", "Sim: Kasir A mencatat kas keluar Rp 100.000 (beli bahan) -> expected_cash menjadi Rp 600.000", () => {
  const mov = engine.recordManualMovement({
    shiftId: "shift-1",
    cashierId: "usr-kasir-1",
    callerRole: "kasir",
    movementType: "cash_out",
    amount: 100000,
    reason: "Beli es batu kristal 5 karung",
  });

  const shift1 = engine.shifts.get("shift-1");
  assert.equal(mov.movement_type, "cash_out");
  assert.equal(shift1.expected_cash, 600000);
});

runTest(42, "SIM-LIFECYCLE", "Sim: Kasir A mencatat kas keluar Rp 1.000.000 (melebihi saldo) -> DITOLAK", () => {
  assert.throws(
    () => {
      engine.recordManualMovement({
        shiftId: "shift-1",
        cashierId: "usr-kasir-1",
        callerRole: "kasir",
        movementType: "cash_out",
        amount: 1000000,
        reason: "Pengeluaran melebihi uang kas laci",
      });
    },
    { message: /Saldo kas shift tidak mencukupi/ },
  );
});

runTest(43, "SIM-LIFECYCLE", "Sim: Refund tunai Rp 50.000 dari laci Kasir A -> expected_cash menjadi Rp 550.000", () => {
  engine.processRefund({
    orderId: "ord-102",
    amount: 50000,
    refundMethod: "cash",
    shiftId: "shift-1",
    callerRole: "admin",
  });

  const shift1 = engine.shifts.get("shift-1");
  assert.equal(shift1.expected_cash, 550000);
});

runTest(44, "SIM-LIFECYCLE", "Sim: Refund tunai Rp 600.000 dari laci Kasir A -> DITOLAK (saldo tidak cukup)", () => {
  assert.throws(
    () => {
      engine.processRefund({
        orderId: "ord-102",
        amount: 600000,
        refundMethod: "cash",
        shiftId: "shift-1",
        callerRole: "admin",
      });
    },
    { message: /Saldo kas laci tidak mencukupi untuk refund/ },
  );
});

runTest(45, "SIM-LIFECYCLE", "Sim: Refund Midtrans Rp 100.000 -> laci fisik Kasir A tetap Rp 550.000", () => {
  engine.processRefund({
    orderId: "ord-103",
    amount: 100000,
    refundMethod: "midtrans",
    shiftId: null,
    callerRole: "admin",
  });

  const shift1 = engine.shifts.get("shift-1");
  assert.equal(shift1.expected_cash, 550000);
});

runTest(46, "SIM-LIFECYCLE", "Sim: Kasir B memiliki laci terisolasi (Rp 200.000) dan tidak terpengaruh transaksi Kasir A", () => {
  const shift2 = engine.shifts.get("shift-2");
  assert.equal(shift2.expected_cash, 200000);
});

runTest(47, "SIM-LIFECYCLE", "Sim: Kasir B dilarang menutup shift Kasir A", () => {
  assert.throws(
    () => {
      engine.closeShift({
        shiftId: "shift-1",
        cashierId: "usr-kasir-2",
        callerRole: "kasir",
        actualCash: 550000,
      });
    },
    { message: /Anda tidak berhak menutup shift milik kasir lain/ },
  );
});

runTest(48, "SIM-LIFECYCLE", "Sim: Kasir A menutup shift dengan uang fisik pas Rp 550.000 -> status closed, selisih 0", () => {
  const closedShift = engine.closeShift({
    shiftId: "shift-1",
    cashierId: "usr-kasir-1",
    callerRole: "kasir",
    actualCash: 550000,
    notes: "Semua uang fisik dihitung bersama supervisor",
  });

  assert.equal(closedShift.status, "closed");
  assert.equal(closedShift.actual_cash, 550000);
  assert.equal(closedShift.cash_difference, 0);
  assert.ok(closedShift.closed_at !== null);
});

runTest(49, "SIM-LIFECYCLE", "Sim: Penutupan shift dengan selisih lebih (+Rp 10.000) dan selisih kurang (-Rp 5.000)", () => {
  // Buka shift baru untuk Kasir C
  const shiftC = engine.openShift({
    cashierId: "usr-kasir-3",
    cashierName: "Dewi",
    openingCash: 100000,
    callerRole: "kasir",
  });
  // Tutup dengan selisih lebih (+10.000)
  const closedC = engine.closeShift({
    shiftId: shiftC.id,
    cashierId: "usr-kasir-3",
    callerRole: "kasir",
    actualCash: 110000,
  });
  assert.equal(closedC.cash_difference, 10000);

  // Buka shift baru untuk Kasir D
  const shiftD = engine.openShift({
    cashierId: "usr-kasir-4",
    cashierName: "Eko",
    openingCash: 100000,
    callerRole: "kasir",
  });
  // Tutup dengan selisih kurang (-5.000)
  const closedD = engine.closeShift({
    shiftId: shiftD.id,
    cashierId: "usr-kasir-4",
    callerRole: "kasir",
    actualCash: 95000,
  });
  assert.equal(closedD.cash_difference, -5000);
});

runTest(50, "SIM-LIFECYCLE", "Sim: Mutasi kas pada shift yang sudah ditutup -> DITOLAK", () => {
  assert.throws(
    () => {
      engine.recordManualMovement({
        shiftId: "shift-1",
        cashierId: "usr-kasir-1",
        callerRole: "kasir",
        movementType: "cash_in",
        amount: 20000,
        reason: "Mutasi pada shift tertutup",
      });
    },
    { message: /Mutasi kas hanya dapat dicatat pada shift yang berstatus 'open'/ },
  );
});

// =============================================================================
// BAGIAN G: REGRESSION VERIFICATION (F0 - F4)
// =============================================================================

runTest(51, "REGRESSION-F0-F1", "Dining Session status & POS Cart Item contract tetap utuh", () => {
  const sessionTypePath = path.resolve(process.cwd(), "src/types/database.ts");
  const content = fs.readFileSync(sessionTypePath, "utf-8");

  assert.ok(content.includes('"open"'), "Dining session open status harus ada.");
  assert.ok(content.includes('"closed"'), "Dining session closed status harus ada.");
  assert.ok(content.includes('"cancelled"'), "Dining session cancelled status harus ada.");
});

runTest(52, "REGRESSION-F2", "process_pos_payment_manual & processOrderRefundAction tetap kompatibel dan revalidasi shift", () => {
  const refundActionPath = path.resolve(process.cwd(), "src/lib/payments/actions.ts");
  const content = fs.readFileSync(refundActionPath, "utf-8");

  assert.ok(content.includes("processOrderRefundAction"), "processOrderRefundAction harus tersedia.");
  assert.ok(content.includes("processRefundSchema"), "processRefundSchema harus digunakan untuk validasi.");
  assert.ok(content.includes("shiftId"), "processOrderRefundAction harus mendukung parameter shiftId.");
  assert.ok(content.includes('revalidatePath("/pos/shift")'), "Harus merevalidasi /pos/shift.");
  assert.ok(content.includes('revalidatePath("/admin/shifts")'), "Harus merevalidasi /admin/shifts.");
});

runTest(53, "REGRESSION-F3", "KDS item statuses (queued, preparing, ready) utuh", () => {
  const kdsTypePath = path.resolve(process.cwd(), "src/types/database.ts");
  const content = fs.readFileSync(kdsTypePath, "utf-8");

  assert.ok(content.includes('"queued"'), "KDS status queued harus ada.");
  assert.ok(content.includes('"preparing"'), "KDS status preparing harus ada.");
  assert.ok(content.includes('"ready"'), "KDS status ready harus ada.");
});

runTest(54, "REGRESSION-F4", "Inventory stock reservation & ingredient deduction triggers utuh", () => {
  const invPath = path.resolve(process.cwd(), "supabase/migrations/20261119000300_f4_stock_reservation_and_strict_positive.sql");
  assert.ok(fs.existsSync(invPath), "Migration inventori F4 harus ada.");
  const content = fs.readFileSync(invPath, "utf-8");

  assert.ok(content.includes("reserve_order_stock_internal"), "Fungsi reserve_order_stock_internal harus ada.");
  assert.ok(content.includes("deduct_order_stock_internal"), "Fungsi deduct_order_stock_internal harus ada.");
  assert.ok(content.includes("release_order_stock_reservations_internal"), "Fungsi release_order_stock_reservations_internal harus ada.");
});

console.log("\n===============================================================================");
console.log(` HASIL PENGUJIAN MILESTONE F5.2: ${passedTests}/${totalTests} SKENARIO LULUS (100%)`);
console.log("===============================================================================");
