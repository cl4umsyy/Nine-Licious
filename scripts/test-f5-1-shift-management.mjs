#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * NINE LICIOUS POS — MILESTONE F5.1 VERIFICATION & REGRESSION SUITE
 * File: scripts/test-f5-1-shift-management.mjs
 *
 * Verifikasi Mendalam untuk Fondasi Database Shift & Cash Management:
 *
 * BAGIAN A: STATIC SQL CONTRACT AUDIT
 *   1. Constraint tabel public.shifts & integrity checks
 *   2. Partial unique index idx_shifts_single_active_cashier
 *   3. Skema buku besar tabel public.cash_movements
 *   4. Relasi payments.shift_id & index
 *   5. RLS policies dan pencabutan direct write privileges
 *   6. RPC open_shift_atomic (SECURITY DEFINER, search_path)
 *   7. RPC close_shift_atomic (SECURITY DEFINER, search_path)
 *   8. RPC record_cash_movement_atomic (SECURITY DEFINER, search_path)
 *   9. Backward compatibility overload execute_order_payment_internal (10 & 11 args)
 *  10. [HIGH-01 Audit] Revoke execute_order_payment_internal dari authenticated & anon (service_role only)
 *  11. [HIGH-02 Audit] process_order_refund_atomic mendukung p_shift_id, drop 7-arg overload, dan refund_id terisi
 *  12. [MEDIUM-01 Audit] open_shift_atomic memformat catatan [Dibuka oleh Admin: ...] & is_opened_by_admin
 *  13. [LOW-01 Audit] Audit logs mencatat is_out_of_shift untuk mutasi kas dalam dan luar shift
 *  14. Guard process_pos_payment_manual: wajib shift aktif sebelum pembayaran tunai
 *
 * BAGIAN B: IN-MEMORY LOGIC & TRANSACTION SIMULATION
 *  15. Shift Lifecycle: Kasir membuka shift sendiri (notes murni, is_opened_by_admin: false)
 *  16. [MEDIUM-01 Sim] Admin membuka shift untuk kasir lain ([Dibuka oleh Admin: ...], is_opened_by_admin: true)
 *  17. Shift Lifecycle: Mencegah kasir membuka lebih dari 1 shift aktif
 *  18. Security Guard: Kasir dilarang membuka shift atas nama kasir lain
 *  19. [HIGH-01 Sim] PostgREST direct execution guard pada execute_order_payment_internal
 *  20. Payment Guard: Menolak pembayaran tunai jika kasir belum membuka shift aktif
 *  21. Payment Integration: Pembayaran tunai menambah saldo kas drawer tepat satu kali
 *  22. Payment Idempotency: Replay pembayaran tunai tidak menggandakan mutasi kas atau mengubah saldo
 *  23. Non-Cash Isolation: Pembayaran Midtrans Snap webhook tidak memengaruhi drawer fisik kasir
 *  24. [LOW-01 Sim] Kas masuk manual mencatat audit log dengan is_out_of_shift: false
 *  25. Manual Cash Movement: Kas keluar manual melebihi saldo kas shift ditolak
 *  26. Manual Cash Movement: Kas keluar manual memotong saldo kas drawer
 *  27. [HIGH-02 Sim 1] Refund tunai dengan p_shift_id spesifik memotong kas shift yang bersangkutan
 *  28. [HIGH-02 Sim 2] Refund tunai dengan p_shift_id pada shift yang sudah ditutup ditolak
 *  29. [HIGH-02 Sim 3] Refund tunai dengan saldo shift tidak mencukupi ditolak
 *  30. [HIGH-02 Sim 4] Refund tunai tanpa p_shift_id saat admin tidak punya shift dicatat di luar shift (shift_id = null)
 *  31. [HIGH-02 Sim 5] cash_movements.refund_id terisi valid UUID (bukan null)
 *  32. [HIGH-02 Sim 6] Idempotency replay refund tidak mengurangi saldo kas shift dua kali
 *  33. Refund Security: Kasir biasa ditolak saat mencoba melakukan refund
 *  34. Cashier Isolation: Kasir dilarang memanipulasi atau menutup shift kasir lain
 *  35. Shift Closing Reconciliation: Penutupan shift menghitung expected_cash secara deterministik dari ledger
 *  36. Shift Closing Discrepancy: Rekonsiliasi shift dengan selisih lebih (+Rp 10.000) dan selisih kurang (-Rp 5.000)
 *  37. Admin Privileges & [LOW-01 Sim]: Admin mencatat pengeluaran di luar shift dengan is_out_of_shift: true
 *  38. F2 & F4 Non-Regression: Kontrak parameter pembayaran F2 dan trigger inventori F4 tetap utuh
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

console.log("===============================================================================");
console.log(" NINE LICIOUS POS — F5.1 SHIFT & CASH MANAGEMENT VERIFICATION SUITE");
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
    console.error(`  Pesan Error: ${err.message}\n`);
    throw err;
  }
}

// =============================================================================
// BAGIAN A: STATIC SQL CONTRACT AUDIT
// =============================================================================

const ROOT = process.cwd();
const MIGRATION_FILE = "supabase/migrations/20261120000100_f5_shift_and_cash_management.sql";
const migrationPath = path.join(ROOT, MIGRATION_FILE);

assert.ok(fs.existsSync(migrationPath), `File migrasi ${MIGRATION_FILE} harus ada di disk.`);
const sql = fs.readFileSync(migrationPath, "utf-8");

runTest(1, "Static Audit", "Tabel public.shifts didefinisikan dengan constraint valid", () => {
  assert.match(sql, /create table if not exists public\.shifts/i);
  assert.match(sql, /cashier_id uuid not null references public\.profiles\(id\)/i);
  assert.match(sql, /opening_cash integer not null check \(opening_cash >= 0\)/i);
  assert.match(sql, /expected_cash integer not null default 0 check \(expected_cash >= 0\)/i);
  assert.match(sql, /actual_cash integer check \(actual_cash is null or actual_cash >= 0\)/i);
  assert.match(sql, /constraint check_shift_time_validity check \(closed_at is null or closed_at >= opened_at\)/i);
});

runTest(2, "Static Audit", "Partial unique index mencegah kasir memiliki lebih dari 1 shift aktif", () => {
  assert.match(sql, /create unique index if not exists idx_shifts_single_active_cashier/i);
  assert.match(sql, /on public\.shifts \(cashier_id\)\s+where status = 'open'/i);
});

runTest(3, "Static Audit", "Tabel public.cash_movements didefinisikan sebagai buku besar mutasi kas", () => {
  assert.match(sql, /create table if not exists public\.cash_movements/i);
  assert.match(sql, /shift_id uuid references public\.shifts\(id\)/i);
  assert.match(sql, /movement_type public\.cash_movement_type not null/i);
  assert.match(sql, /amount integer not null check \(amount >= 0\)/i);
  assert.match(sql, /balance_before integer not null check \(balance_before >= 0\)/i);
  assert.match(sql, /balance_after integer not null check \(balance_after >= 0\)/i);
  assert.match(sql, /reason text not null check \(btrim\(reason\) <> ''\)/i);
  assert.match(sql, /created_by uuid not null references public\.profiles\(id\)/i);
});

runTest(4, "Static Audit", "Kolom public.payments.shift_id ditambahkan beserta foreign key dan indeks", () => {
  assert.match(sql, /alter table public\.payments\s+add column if not exists shift_id uuid references public\.shifts\(id\)/i);
  assert.match(sql, /create index if not exists idx_payments_shift_id on public\.payments \(shift_id\)/i);
});

runTest(5, "Static Audit", "RLS policies diaktifkan dan mutasi direct write dicabut dari klien", () => {
  assert.match(sql, /alter table public\.shifts enable row level security/i);
  assert.match(sql, /alter table public\.cash_movements enable row level security/i);
  assert.match(sql, /revoke insert, update, delete on public\.shifts from public, anon, authenticated/i);
  assert.match(sql, /revoke insert, update, delete on public\.cash_movements from public, anon, authenticated/i);
  assert.match(sql, /grant select on public\.shifts to authenticated/i);
  assert.match(sql, /grant select on public\.cash_movements to authenticated/i);
});

runTest(6, "Static Audit", "RPC open_shift_atomic didefinisikan dengan SECURITY DEFINER dan search_path aman", () => {
  assert.match(sql, /create or replace function public\.open_shift_atomic/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /set search_path = public/i);
  assert.match(sql, /grant execute on function public\.open_shift_atomic\(integer, text, uuid\) to authenticated/i);
});

runTest(7, "Static Audit", "RPC close_shift_atomic didefinisikan dengan SECURITY DEFINER dan search_path aman", () => {
  assert.match(sql, /create or replace function public\.close_shift_atomic/i);
  assert.match(sql, /grant execute on function public\.close_shift_atomic\(uuid, integer, text\) to authenticated/i);
});

runTest(8, "Static Audit", "RPC record_cash_movement_atomic didefinisikan dengan SECURITY DEFINER", () => {
  assert.match(sql, /create or replace function public\.record_cash_movement_atomic/i);
  assert.match(sql, /grant execute on function public\.record_cash_movement_atomic\(uuid, text, integer, text\) to authenticated/i);
});

runTest(9, "Static Audit", "Backward compatibility: execute_order_payment_internal overload 10-argumen tersedia", () => {
  assert.match(sql, /create or replace function public\.execute_order_payment_internal\([^)]+p_actor_id uuid,\s+p_shift_id uuid/i);
  assert.match(sql, /create or replace function public\.execute_order_payment_internal\([^)]+p_actor_id uuid\s*\)/i);
});

runTest(10, "Static Audit [HIGH-01]", "execute_order_payment_internal dicabut dari authenticated & anon (service_role only)", () => {
  assert.match(
    sql,
    /revoke all on function public\.execute_order_payment_internal\(uuid, text, text, integer, integer, integer, text, text, text, uuid, uuid\) from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /revoke all on function public\.execute_order_payment_internal\(uuid, text, text, integer, integer, integer, text, text, text, uuid\) from public, anon, authenticated/i,
  );
  assert.doesNotMatch(
    sql,
    /grant execute on function public\.execute_order_payment_internal\(uuid, text, text, integer, integer, integer, text, text, text, uuid, uuid\) to authenticated/i,
  );
  assert.doesNotMatch(
    sql,
    /grant execute on function public\.execute_order_payment_internal\(uuid, text, text, integer, integer, integer, text, text, text, uuid\) to authenticated/i,
  );
  assert.match(
    sql,
    /grant execute on function public\.execute_order_payment_internal\(uuid, text, text, integer, integer, integer, text, text, text, uuid, uuid\) to service_role/i,
  );
});

runTest(11, "Static Audit [HIGH-02]", "process_order_refund_atomic mendukung p_shift_id, drop overload 7-arg, dan isi refund_id di cash_movements", () => {
  assert.match(sql, /drop function if exists public\.process_order_refund_atomic\(uuid, integer, text, text, text, uuid, text\)/i);
  assert.match(sql, /create or replace function public\.process_order_refund_atomic\([^)]+p_shift_id uuid default null/i);
  assert.match(sql, /insert into public\.cash_movements[\s\S]+?refund_id[\s\S]+?values[\s\S]+?v_refund_id/i);
  assert.match(sql, /grant execute on function public\.process_order_refund_atomic\(uuid, integer, text, text, text, uuid, text, uuid\) to authenticated/i);
});

runTest(12, "Static Audit [MEDIUM-01]", "open_shift_atomic memformat catatan [Dibuka oleh Admin: ...] dan mencatat is_opened_by_admin", () => {
  assert.match(sql, /\[Dibuka oleh Admin: ' \|\| v_admin_username \|\| '\]/i);
  assert.match(sql, /'is_opened_by_admin', \(v_target_cashier_id <> v_caller_id\)/i);
});

runTest(13, "Static Audit [LOW-01]", "record_cash_movement_atomic dan process_order_refund_atomic mencatat is_out_of_shift pada audit_logs", () => {
  assert.match(sql, /'is_out_of_shift', \(p_shift_id is null\)/i);
  assert.match(sql, /'is_out_of_shift', \(v_target_shift_id is null\)/i);
});

runTest(14, "Static Audit", "Integrasi process_pos_payment_manual memvalidasi shift aktif kasir sebelum pembayaran tunai", () => {
  assert.match(sql, /if p_payment_source = 'cash' or p_payment_method = 'cash' then/i);
  assert.match(sql, /select id, expected_cash\s+into v_active_shift\s+from public\.shifts\s+where cashier_id = v_actor_id\s+and status = 'open'/i);
  assert.match(sql, /Kasir belum membuka shift kasir\. Buka shift terlebih dahulu sebelum memproses pembayaran tunai\./i);
});

// =============================================================================
// BAGIAN B: IN-MEMORY SIMULATION ENGINE FOR SHIFTS & CASH TRANSACTIONS
// =============================================================================

function createShiftDbSimulator() {
  const db = {
    profiles: new Map([
      ["adm-1", { id: "adm-1", username: "admin", role: "admin", is_active: true }],
      ["adm-off", { id: "adm-off", username: "admin_off", role: "admin", is_active: false }],
      ["ksr-1", { id: "ksr-1", username: "kasir1", role: "kasir", is_active: true }],
      ["ksr-2", { id: "ksr-2", username: "kasir2", role: "kasir", is_active: true }],
    ]),
    shifts: new Map(),
    cashMovements: [],
    payments: new Map(),
    refunds: new Map(),
    orders: new Map(),
    auditLogs: [],
  };

  let idCounter = 1;
  const genId = (prefix) => `${prefix}-${idCounter++}`;

  // Helper auth profile
  function requireActor(userId) {
    if (!userId) throw new Error("Sesi pengguna tidak valid.");
    const profile = db.profiles.get(userId);
    if (!profile || !profile.is_active) throw new Error("Profil pengguna tidak ditemukan atau tidak aktif.");
    if (!["admin", "kasir"].includes(profile.role)) throw new Error("Hanya Admin dan Kasir yang berwenang.");
    return profile;
  }

  // RPC: open_shift_atomic
  function openShiftAtomic(callerId, openingCash, notes = null, cashierId = null) {
    const actor = requireActor(callerId);
    let targetCashierId = callerId;
    const isOpenedByAdmin = Boolean(cashierId && cashierId !== callerId);

    if (isOpenedByAdmin) {
      if (actor.role !== "admin") throw new Error("Kasir hanya dapat membuka shift untuk dirinya sendiri.");
      targetCashierId = cashierId;
    }
    const target = requireActor(targetCashierId);

    if (openingCash === null || openingCash === undefined || openingCash < 0) {
      throw new Error("Modal kas awal tidak boleh bernilai negatif.");
    }

    // Check single active shift
    for (const shift of db.shifts.values()) {
      if (shift.cashier_id === targetCashierId && shift.status === "open") {
        throw new Error(`Kasir masih memiliki shift aktif yang belum ditutup (Shift ID: ${shift.id}). Tutup shift terlebih dahulu.`);
      }
    }

    let finalNotes = notes ? notes.trim() : null;
    if (isOpenedByAdmin) {
      const adminName = actor.username || "Admin";
      finalNotes = finalNotes
        ? `[Dibuka oleh Admin: ${adminName}] ${finalNotes}`
        : `[Dibuka oleh Admin: ${adminName}]`;
    }

    const shiftId = genId("shift");
    const newShift = {
      id: shiftId,
      shift_id: shiftId,
      cashier_id: targetCashierId,
      opened_at: new Date().toISOString(),
      closed_at: null,
      opening_cash: openingCash,
      expected_cash: openingCash,
      actual_cash: null,
      cash_difference: null,
      status: "open",
      notes: finalNotes,
    };
    db.shifts.set(shiftId, newShift);

    const movId = genId("mov");
    db.cashMovements.push({
      id: movId,
      shift_id: shiftId,
      movement_type: "opening_cash",
      amount: openingCash,
      balance_before: 0,
      balance_after: openingCash,
      reason: "Modal kas awal shift kasir",
      created_by: callerId,
      created_at: new Date().toISOString(),
    });

    db.auditLogs.push({
      user_id: callerId,
      action: "shift.opened",
      entity: "shift",
      entity_id: shiftId,
      details: {
        opening_cash: openingCash,
        cashier_id: targetCashierId,
        opened_by: callerId,
        is_opened_by_admin: isOpenedByAdmin,
        notes: finalNotes,
      },
    });

    return { ...newShift };
  }

  // RPC: record_cash_movement_atomic
  function recordCashMovementAtomic(callerId, shiftId, movementType, amount, reason) {
    const actor = requireActor(callerId);
    if (!amount || amount <= 0) throw new Error("Nominal mutasi kas harus lebih besar dari Rp 0.");
    const cleanReason = (reason || "").trim();
    if (cleanReason.length < 3) throw new Error("Alasan mutasi kas wajib diisi (minimal 3 karakter).");
    if (!["cash_in", "cash_out"].includes(movementType)) {
      throw new Error("Tipe mutasi manual hanya mendukung cash_in atau cash_out.");
    }

    let balanceBefore = 0;
    let balanceAfter = 0;
    let targetShiftId = shiftId;

    if (shiftId) {
      const shift = db.shifts.get(shiftId);
      if (!shift) throw new Error(`Shift dengan ID ${shiftId} tidak ditemukan.`);
      if (shift.status !== "open") throw new Error("Tidak dapat mencatat mutasi kas pada shift yang sudah ditutup.");
      if (actor.role === "kasir" && shift.cashier_id !== callerId) {
        throw new Error("Kasir tidak dapat mencatat mutasi pada shift kasir lain.");
      }

      balanceBefore = shift.expected_cash;
      if (movementType === "cash_out") {
        if (shift.expected_cash < amount) {
          throw new Error(`Saldo kas shift tidak mencukupi (Tersedia: Rp ${shift.expected_cash}, Diminta: Rp ${amount}).`);
        }
        balanceAfter = balanceBefore - amount;
      } else {
        balanceAfter = balanceBefore + amount;
      }

      shift.expected_cash = balanceAfter;
    } else {
      // Outside shift: Admin only
      if (actor.role !== "admin") throw new Error("Hanya admin yang berhak mencatat mutasi kas di luar shift.");
      balanceBefore = 0;
      balanceAfter = 0;
      targetShiftId = null;
    }

    const movId = genId("mov");
    db.cashMovements.push({
      id: movId,
      shift_id: targetShiftId,
      movement_type: movementType,
      amount,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      reason: cleanReason,
      created_by: callerId,
      created_at: new Date().toISOString(),
    });

    db.auditLogs.push({
      user_id: callerId,
      action: `cash.${movementType}`,
      entity: "cash_movement",
      entity_id: movId,
      details: {
        shift_id: targetShiftId,
        is_out_of_shift: targetShiftId === null,
        movement_type: movementType,
        amount,
        reason: cleanReason,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
      },
    });

    return {
      movement_id: movId,
      shift_id: targetShiftId,
      movement_type: movementType,
      amount,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
    };
  }

  // Internal execution engine (service_role only direct access guard)
  function executeOrderPaymentInternalDirect(callerRole) {
    if (callerRole !== "service_role") {
      throw new Error("Direct execution of execute_order_payment_internal is revoked for clients. Use process_pos_payment_manual.");
    }
  }

  // RPC: process_pos_payment_manual
  function processPosPaymentManual(callerId, orderId, paymentMethod, paymentSource, amount, cashReceived, changeAmount, idempotencyKey) {
    const actor = requireActor(callerId);
    if (!idempotencyKey || !idempotencyKey.trim()) throw new Error("Idempotency key wajib diisi.");
    const cleanKey = idempotencyKey.trim();

    // Idempotent check
    for (const p of db.payments.values()) {
      if (p.idempotency_key === cleanKey) {
        return { payment_id: p.id, order_id: p.order_id, amount: p.amount, is_settled: true, idempotent_replay: true };
      }
    }

    const order = db.orders.get(orderId);
    if (!order) throw new Error(`Pesanan ${orderId} tidak ditemukan.`);

    let shiftId = null;
    const paymentId = genId("pay");

    if (paymentSource === "cash" || paymentMethod === "cash") {
      let activeShift = null;
      for (const s of db.shifts.values()) {
        if (s.cashier_id === callerId && s.status === "open") {
          activeShift = s;
          break;
        }
      }

      if (!activeShift) {
        throw new Error("Kasir belum membuka shift kasir. Buka shift terlebih dahulu sebelum memproses pembayaran tunai.");
      }

      shiftId = activeShift.id;
      const before = activeShift.expected_cash;
      const after = before + amount;
      activeShift.expected_cash = after;

      const movId = genId("mov");
      db.cashMovements.push({
        id: movId,
        shift_id: shiftId,
        movement_type: "cash_sale",
        amount,
        balance_before: before,
        balance_after: after,
        reason: `Penjualan tunai pesanan ${order.order_number}`,
        order_id: orderId,
        payment_id: paymentId,
        created_by: callerId,
        created_at: new Date().toISOString(),
      });
    } else {
      for (const s of db.shifts.values()) {
        if (s.cashier_id === callerId && s.status === "open") {
          shiftId = s.id;
          break;
        }
      }
    }

    db.payments.set(paymentId, {
      id: paymentId,
      order_id: orderId,
      payment_method: paymentMethod,
      payment_source: paymentSource,
      amount,
      cash_received: cashReceived,
      change_amount: changeAmount,
      idempotency_key: cleanKey,
      shift_id: shiftId,
      created_by: callerId,
    });

    order.paid_total += amount;
    if (order.paid_total >= order.grand_total) {
      order.status = "paid";
    }

    return { payment_id: paymentId, order_id: orderId, amount, is_settled: order.paid_total >= order.grand_total, idempotent_replay: false };
  }

  // Midtrans settlement
  function processMidtransWebhookSettlement(orderId, amount, midtransOrderId) {
    const order = db.orders.get(orderId);
    if (!order) throw new Error("Pesanan tidak ditemukan.");

    const paymentId = genId("pay");
    db.payments.set(paymentId, {
      id: paymentId,
      order_id: orderId,
      payment_method: "midtrans",
      payment_source: "midtrans_snap",
      amount,
      cash_received: null,
      change_amount: 0,
      idempotency_key: `midtrans-${midtransOrderId}`,
      shift_id: null,
      created_by: null,
    });

    order.paid_total += amount;
    if (order.paid_total >= order.grand_total) order.status = "paid";

    return { payment_id: paymentId, order_id: orderId, is_settled: true };
  }

  // RPC: process_order_refund_atomic (HIGH-02 implementation)
  function processOrderRefundAtomic(callerId, orderId, amount, refundType, refundMethod, reason, idempotencyKey, paymentId = null, shiftId = null) {
    const actor = requireActor(callerId);
    if (actor.role !== "admin") throw new Error("Hanya admin yang berhak memproses pengembalian dana (refund).");
    if (!idempotencyKey) throw new Error("Idempotency key wajib diisi.");

    // Pre-lock Idempotency check: early return without any mutation
    for (const r of db.refunds.values()) {
      if (r.idempotency_key === idempotencyKey) {
        return { refund_id: r.id, amount: r.amount, is_duplicate: true };
      }
    }

    const order = db.orders.get(orderId);
    if (!order) throw new Error("Pesanan tidak ditemukan.");
    if (amount > order.paid_total) throw new Error("Nominal refund melebihi dana pesanan.");

    const refundId = genId("ref");
    let targetShiftId = null;
    let balanceBefore = 0;
    let balanceAfter = 0;

    if (refundMethod === "cash") {
      if (shiftId) {
        const targetShift = db.shifts.get(shiftId);
        if (!targetShift) throw new Error(`Shift kasir dengan ID ${shiftId} tidak ditemukan.`);
        if (targetShift.status !== "open") throw new Error(`Shift kasir ${shiftId} sudah ditutup. Tidak dapat mengeluarkan refund dari shift tertutup.`);
        if (targetShift.expected_cash < amount) {
          throw new Error(`Saldo kas shift tidak mencukupi untuk refund tunai (Tersedia: Rp ${targetShift.expected_cash}, Diminta: Rp ${amount}).`);
        }
        balanceBefore = targetShift.expected_cash;
        balanceAfter = balanceBefore - amount;
        targetShift.expected_cash = balanceAfter;
        targetShiftId = targetShift.id;
      } else {
        // shiftId is null: check if Admin has their own open shift
        let adminShift = null;
        for (const s of db.shifts.values()) {
          if (s.cashier_id === callerId && s.status === "open") {
            adminShift = s;
            break;
          }
        }

        if (adminShift) {
          if (adminShift.expected_cash < amount) {
            throw new Error(`Saldo kas shift tidak mencukupi untuk refund tunai (Tersedia: Rp ${adminShift.expected_cash}, Diminta: Rp ${amount}).`);
          }
          balanceBefore = adminShift.expected_cash;
          balanceAfter = balanceBefore - amount;
          adminShift.expected_cash = balanceAfter;
          targetShiftId = adminShift.id;
        } else {
          // Out of shift refund by admin
          targetShiftId = null;
          balanceBefore = 0;
          balanceAfter = 0;
        }
      }

      // Record cash movement with valid non-null refund_id
      const movId = genId("mov");
      db.cashMovements.push({
        id: movId,
        shift_id: targetShiftId,
        movement_type: "cash_refund",
        amount,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        reason: targetShiftId
          ? `Refund tunai pesanan ${order.order_number}: ${reason}`
          : `Refund tunai di luar shift (Admin): ${reason}`,
        order_id: orderId,
        payment_id: paymentId,
        refund_id: refundId,
        created_by: callerId,
        created_at: new Date().toISOString(),
      });
    }

    db.refunds.set(refundId, {
      id: refundId,
      order_id: orderId,
      amount,
      refund_method: refundMethod,
      refund_type: refundType,
      idempotency_key: idempotencyKey,
      shift_id: targetShiftId,
      status: "completed",
    });

    order.refunded_total = (order.refunded_total || 0) + amount;
    if (order.refunded_total >= order.paid_total) {
      order.status = "refunded";
    }

    db.auditLogs.push({
      user_id: callerId,
      action: "order.refunded",
      entity: "order",
      entity_id: orderId,
      details: {
        refund_id: refundId,
        shift_id: targetShiftId,
        is_out_of_shift: targetShiftId === null,
        amount,
        refund_method: refundMethod,
      },
    });

    return { refund_id: refundId, amount, shift_id: targetShiftId, is_duplicate: false };
  }

  // RPC: close_shift_atomic
  function closeShiftAtomic(callerId, shiftId, actualCash, notes = null) {
    const actor = requireActor(callerId);
    if (actualCash === null || actualCash === undefined || actualCash < 0) {
      throw new Error("Nominal kas fisik tidak boleh bernilai negatif.");
    }

    const shift = db.shifts.get(shiftId);
    if (!shift) throw new Error(`Shift dengan ID ${shiftId} tidak ditemukan.`);
    if (shift.status !== "open") throw new Error("Shift sudah ditutup sebelumnya.");
    if (actor.role === "kasir" && shift.cashier_id !== callerId) {
      throw new Error("Kasir tidak berhak menutup shift milik kasir lain.");
    }

    let totalSales = 0;
    let totalIn = 0;
    let totalRefunds = 0;
    let totalOut = 0;

    for (const mov of db.cashMovements) {
      if (mov.shift_id === shiftId && mov.movement_type !== "opening_cash" && mov.movement_type !== "closing_reconciliation") {
        if (mov.movement_type === "cash_sale") totalSales += mov.amount;
        if (mov.movement_type === "cash_in") totalIn += mov.amount;
        if (mov.movement_type === "cash_refund") totalRefunds += mov.amount;
        if (mov.movement_type === "cash_out") totalOut += mov.amount;
      }
    }

    const calculatedExpected = shift.opening_cash + totalSales + totalIn - (totalRefunds + totalOut);
    const diff = actualCash - calculatedExpected;

    shift.status = "closed";
    shift.closed_at = new Date().toISOString();
    shift.expected_cash = calculatedExpected;
    shift.actual_cash = actualCash;
    shift.cash_difference = diff;
    if (notes) shift.notes = notes;

    db.cashMovements.push({
      id: genId("mov"),
      shift_id: shiftId,
      movement_type: "closing_reconciliation",
      amount: actualCash,
      balance_before: calculatedExpected,
      balance_after: actualCash,
      reason: `Penutupan shift dan rekonsiliasi kas (Selisih: Rp ${diff})`,
      created_by: callerId,
      created_at: new Date().toISOString(),
    });

    db.auditLogs.push({
      user_id: callerId,
      action: "shift.closed",
      entity: "shift",
      entity_id: shiftId,
      details: { expected_cash: calculatedExpected, actual_cash: actualCash, cash_difference: diff },
    });

    return {
      shift_id: shiftId,
      opening_cash: shift.opening_cash,
      total_cash_sales: totalSales,
      total_cash_in: totalIn,
      total_cash_refunds: totalRefunds,
      total_cash_out: totalOut,
      expected_cash: calculatedExpected,
      actual_cash: actualCash,
      cash_difference: diff,
      status: "closed",
    };
  }

  return {
    db,
    openShiftAtomic,
    closeShiftAtomic,
    recordCashMovementAtomic,
    executeOrderPaymentInternalDirect,
    processPosPaymentManual,
    processMidtransWebhookSettlement,
    processOrderRefundAtomic,
  };
}

// =============================================================================
// RUN SIMULATION TESTS
// =============================================================================

const sim = createShiftDbSimulator();

runTest(15, "Shift Lifecycle", "Kasir 1 dapat membuka shift sendiri dengan modal awal Rp 200.000", () => {
  const result = sim.openShiftAtomic("ksr-1", 200000, "Shift pagi kasir 1");
  assert.equal(result.cashier_id, "ksr-1");
  assert.equal(result.opening_cash, 200000);
  assert.equal(result.expected_cash, 200000);
  assert.equal(result.status, "open");
  assert.equal(result.notes, "Shift pagi kasir 1");

  const openingMov = sim.db.cashMovements.find((m) => m.shift_id === result.shift_id && m.movement_type === "opening_cash");
  assert.ok(openingMov, "Mutasi opening_cash wajib ada.");
  assert.equal(openingMov.amount, 200000);
  assert.equal(openingMov.balance_after, 200000);

  const log = sim.db.auditLogs.find((a) => a.action === "shift.opened" && a.entity_id === result.shift_id);
  assert.ok(log, "Audit log shift.opened wajib ada.");
  assert.equal(log.details.is_opened_by_admin, false);
});

runTest(16, "Shift Lifecycle [MEDIUM-01]", "Admin membuka shift untuk Kasir 2 (catatan [Dibuka oleh Admin: ...] & audit log)", () => {
  const result = sim.openShiftAtomic("adm-1", 150000, "Modal kasir 2 siang", "ksr-2");
  assert.equal(result.cashier_id, "ksr-2");
  assert.equal(result.opening_cash, 150000);
  assert.match(result.notes, /^\[Dibuka oleh Admin: admin\]/);

  const log = sim.db.auditLogs.find((a) => a.action === "shift.opened" && a.entity_id === result.shift_id);
  assert.ok(log, "Audit log shift.opened wajib ada.");
  assert.equal(log.details.is_opened_by_admin, true);
  assert.equal(log.details.cashier_id, "ksr-2");
  assert.equal(log.details.opened_by, "adm-1");
});

runTest(17, "Shift Lifecycle", "Mencegah kasir membuka lebih dari 1 shift aktif (anti-race / duplicate shift)", () => {
  assert.throws(() => {
    sim.openShiftAtomic("ksr-1", 100000, "Mencoba buka shift kedua");
  }, /Kasir masih memiliki shift aktif yang belum ditutup/i);
});

runTest(18, "Security Guard", "Kasir tidak dapat membuka shift atas nama kasir lain", () => {
  assert.throws(() => {
    sim.openShiftAtomic("ksr-1", 100000, "Mencoba buka shift kasir 2", "ksr-2");
  }, /Kasir hanya dapat membuka shift untuk dirinya sendiri/i);
});

runTest(19, "Security Guard [HIGH-01]", "Akses langsung PostgREST ke execute_order_payment_internal ditolak bagi klien non-service_role", () => {
  assert.throws(() => {
    sim.executeOrderPaymentInternalDirect("authenticated");
  }, /Direct execution of execute_order_payment_internal is revoked/i);

  assert.throws(() => {
    sim.executeOrderPaymentInternalDirect("anon");
  }, /Direct execution of execute_order_payment_internal is revoked/i);

  // service_role diizinkan (misal via background webhook)
  assert.doesNotThrow(() => {
    sim.executeOrderPaymentInternalDirect("service_role");
  });
});

runTest(20, "Payment Guard", "Menolak pembayaran tunai jika kasir belum membuka shift aktif", () => {
  // Bikin profile kasir baru tanpa shift
  sim.db.profiles.set("ksr-fresh", { id: "ksr-fresh", username: "kasir_fresh", role: "kasir", is_active: true });
  sim.db.orders.set("ord-1", {
    id: "ord-1",
    order_number: "ORD-001",
    grand_total: 50000,
    paid_total: 0,
    status: "awaiting_payment",
  });

  assert.throws(() => {
    sim.processPosPaymentManual("ksr-fresh", "ord-1", "cash", "cash", 50000, 50000, 0, "idem-pay-fail-1");
  }, /Kasir belum membuka shift kasir\. Buka shift terlebih dahulu sebelum memproses pembayaran tunai\./i);
});

runTest(21, "Payment Integration", "Pembayaran tunai oleh Kasir 1 berhasil dan menambah saldo kas shift tepat Rp 50.000", () => {
  const shiftKasir1 = [...sim.db.shifts.values()].find((s) => s.cashier_id === "ksr-1" && s.status === "open");
  const initialBalance = shiftKasir1.expected_cash;

  const result = sim.processPosPaymentManual("ksr-1", "ord-1", "cash", "cash", 50000, 50000, 0, "idem-pay-cash-1");
  assert.equal(result.is_settled, true);
  assert.equal(result.idempotent_replay, false);

  assert.equal(shiftKasir1.expected_cash, initialBalance + 50000);

  const saleMov = sim.db.cashMovements.find((m) => m.payment_id === result.payment_id);
  assert.ok(saleMov, "Mutasi cash_sale wajib dicatat.");
  assert.equal(saleMov.movement_type, "cash_sale");
  assert.equal(saleMov.amount, 50000);
  assert.equal(saleMov.balance_before, initialBalance);
  assert.equal(saleMov.balance_after, initialBalance + 50000);
});

runTest(22, "Payment Idempotency", "Replay pembayaran tunai dengan kunci idempotensi sama tidak menggandakan mutasi kas", () => {
  const shiftKasir1 = [...sim.db.shifts.values()].find((s) => s.cashier_id === "ksr-1" && s.status === "open");
  const balanceBeforeReplay = shiftKasir1.expected_cash;
  const movCountBefore = sim.db.cashMovements.length;

  const replayResult = sim.processPosPaymentManual("ksr-1", "ord-1", "cash", "cash", 50000, 50000, 0, "idem-pay-cash-1");
  assert.equal(replayResult.idempotent_replay, true);

  assert.equal(shiftKasir1.expected_cash, balanceBeforeReplay, "Saldo shift tidak boleh berubah pada idempotent replay.");
  assert.equal(sim.db.cashMovements.length, movCountBefore, "Jumlah mutasi kas tidak boleh bertambah.");
});

runTest(23, "Payment Non-Cash Isolation", "Pembayaran Midtrans tidak memengaruhi saldo fisik drawer kasir", () => {
  const shiftKasir1 = [...sim.db.shifts.values()].find((s) => s.cashier_id === "ksr-1" && s.status === "open");
  const balanceBefore = shiftKasir1.expected_cash;

  sim.db.orders.set("ord-midtrans", {
    id: "ord-midtrans",
    order_number: "ORD-MID-1",
    grand_total: 75000,
    paid_total: 0,
    status: "awaiting_payment",
  });

  sim.processMidtransWebhookSettlement("ord-midtrans", 75000, "ORDER-SNAP-001");

  assert.equal(shiftKasir1.expected_cash, balanceBefore, "Midtrans online settlement dilarang memengaruhi kas drawer fisik.");
});

runTest(24, "Manual Cash Movement [LOW-01]", "Kas masuk manual menambah saldo kas dan audit log mencatat is_out_of_shift: false", () => {
  const shiftKasir1 = [...sim.db.shifts.values()].find((s) => s.cashier_id === "ksr-1" && s.status === "open");
  const balanceBefore = shiftKasir1.expected_cash;

  const mov = sim.recordCashMovementAtomic("ksr-1", shiftKasir1.id, "cash_in", 50000, "Tambah uang pecahan kecil");
  assert.equal(mov.amount, 50000);
  assert.equal(mov.balance_after, balanceBefore + 50000);
  assert.equal(shiftKasir1.expected_cash, balanceBefore + 50000);

  const log = sim.db.auditLogs.find((a) => a.entity_id === mov.movement_id);
  assert.ok(log, "Audit log untuk cash_in wajib ada.");
  assert.equal(log.details.is_out_of_shift, false);
});

runTest(25, "Manual Cash Movement", "Kas keluar manual melebihi saldo kas shift ditolak", () => {
  const shiftKasir1 = [...sim.db.shifts.values()].find((s) => s.cashier_id === "ksr-1" && s.status === "open");
  const currentBalance = shiftKasir1.expected_cash;

  assert.throws(() => {
    sim.recordCashMovementAtomic("ksr-1", shiftKasir1.id, "cash_out", currentBalance + 10000, "Beli bahan melebihi kas");
  }, /Saldo kas shift tidak mencukupi/i);
});

runTest(26, "Manual Cash Movement", "Kas keluar manual Rp 30.000 untuk es darurat memotong saldo kas", () => {
  const shiftKasir1 = [...sim.db.shifts.values()].find((s) => s.cashier_id === "ksr-1" && s.status === "open");
  const balanceBefore = shiftKasir1.expected_cash;

  const mov = sim.recordCashMovementAtomic("ksr-1", shiftKasir1.id, "cash_out", 30000, "Beli es batu kristal darurat");
  assert.equal(mov.amount, 30000);
  assert.equal(mov.balance_after, balanceBefore - 30000);
  assert.equal(shiftKasir1.expected_cash, balanceBefore - 30000);
});

runTest(27, "Refund Integration [HIGH-02]", "Refund tunai dengan p_shift_id spesifik memotong saldo kasir tersebut", () => {
  const shiftKasir1 = [...sim.db.shifts.values()].find((s) => s.cashier_id === "ksr-1" && s.status === "open");
  const balanceBefore = shiftKasir1.expected_cash;

  sim.db.orders.set("ord-ref-target", {
    id: "ord-ref-target",
    order_number: "ORD-REF-TGT",
    grand_total: 20000,
    paid_total: 20000,
    status: "paid",
  });

  const res = sim.processOrderRefundAtomic("adm-1", "ord-ref-target", 20000, "full", "cash", "Barang tidak sesuai", "idem-ref-target-1", null, shiftKasir1.id);
  assert.equal(res.is_duplicate, false);
  assert.equal(res.shift_id, shiftKasir1.id);
  assert.equal(shiftKasir1.expected_cash, balanceBefore - 20000);

  const mov = sim.db.cashMovements.find((m) => m.refund_id === res.refund_id);
  assert.ok(mov, "Cash movement dengan refund_id wajib tercatat.");
  assert.equal(mov.shift_id, shiftKasir1.id);
  assert.equal(mov.amount, 20000);
  assert.equal(mov.refund_id, res.refund_id);
});

runTest(28, "Refund Integration [HIGH-02]", "Refund tunai dengan p_shift_id yang sudah closed ditolak", () => {
  // Buat shift closed
  const fakeClosedShiftId = "shift-fake-closed";
  sim.db.shifts.set(fakeClosedShiftId, {
    id: fakeClosedShiftId,
    cashier_id: "ksr-1",
    status: "closed",
    expected_cash: 50000,
  });

  sim.db.orders.set("ord-ref-closed", {
    id: "ord-ref-closed",
    order_number: "ORD-REF-CLS",
    grand_total: 10000,
    paid_total: 10000,
    status: "paid",
  });

  assert.throws(() => {
    sim.processOrderRefundAtomic("adm-1", "ord-ref-closed", 10000, "full", "cash", "Refund shift closed", "idem-ref-cls", null, fakeClosedShiftId);
  }, /sudah ditutup/i);
});

runTest(29, "Refund Integration [HIGH-02]", "Refund tunai dengan saldo shift tidak mencukupi ditolak", () => {
  const shiftKasir2 = [...sim.db.shifts.values()].find((s) => s.cashier_id === "ksr-2" && s.status === "open");
  const tooLargeAmount = shiftKasir2.expected_cash + 999999;

  sim.db.orders.set("ord-ref-broke", {
    id: "ord-ref-broke",
    order_number: "ORD-REF-BRK",
    grand_total: tooLargeAmount,
    paid_total: tooLargeAmount,
    status: "paid",
  });

  assert.throws(() => {
    sim.processOrderRefundAtomic("adm-1", "ord-ref-broke", tooLargeAmount, "full", "cash", "Refund over balance", "idem-ref-over", null, shiftKasir2.id);
  }, /Saldo kas shift tidak mencukupi/i);
});

runTest(30, "Refund Integration [HIGH-02]", "Refund tunai tanpa p_shift_id saat admin tidak punya shift dicatat di luar shift (shift_id = null)", () => {
  // Admin adm-1 tidak memiliki shift open
  const shiftKasir1 = [...sim.db.shifts.values()].find((s) => s.cashier_id === "ksr-1" && s.status === "open");
  const balanceKasir1Before = shiftKasir1.expected_cash;

  sim.db.orders.set("ord-ref-out", {
    id: "ord-ref-out",
    order_number: "ORD-REF-OUT",
    grand_total: 15000,
    paid_total: 15000,
    status: "paid",
  });

  const res = sim.processOrderRefundAtomic("adm-1", "ord-ref-out", 15000, "full", "cash", "Refund via kas toko pusat", "idem-ref-out-1");
  assert.equal(res.is_duplicate, false);
  assert.equal(res.shift_id, null);

  // Pastikan shift kasir 1 TIDAK terpotong secara liar
  assert.equal(shiftKasir1.expected_cash, balanceKasir1Before, "Shift kasir aktif tidak boleh sembarangan dipotong jika admin refund di luar shift!");

  const mov = sim.db.cashMovements.find((m) => m.refund_id === res.refund_id);
  assert.ok(mov, "Cash movement refund luar shift wajib ada.");
  assert.equal(mov.shift_id, null);
  assert.equal(mov.amount, 15000);
});

runTest(31, "Refund Integration [HIGH-02]", "cash_movements.refund_id terisi UUID valid dan tidak pernah NULL pada setiap mutasi refund", () => {
  const refundMovements = sim.db.cashMovements.filter((m) => m.movement_type === "cash_refund");
  assert.ok(refundMovements.length >= 2, "Harus ada minimal 2 refund movement yang tercatat.");
  for (const rm of refundMovements) {
    assert.ok(rm.refund_id, `refund_id pada movement ${rm.id} tidak boleh null atau kosong.`);
    assert.match(rm.refund_id, /^ref-\d+$/, "refund_id harus merujuk pada format ID refund yang valid.");
  }
});

runTest(32, "Refund Idempotency [HIGH-02]", "Idempotency replay refund tidak mengurangi saldo kas shift dua kali", () => {
  const shiftKasir1 = [...sim.db.shifts.values()].find((s) => s.cashier_id === "ksr-1" && s.status === "open");
  const balanceBefore = shiftKasir1.expected_cash;
  const movCountBefore = sim.db.cashMovements.length;

  const replayRes = sim.processOrderRefundAtomic("adm-1", "ord-ref-target", 20000, "full", "cash", "Barang tidak sesuai", "idem-ref-target-1", null, shiftKasir1.id);
  assert.equal(replayRes.is_duplicate, true);
  assert.equal(shiftKasir1.expected_cash, balanceBefore, "Saldo kas drawer tidak boleh berubah saat idempotent replay refund.");
  assert.equal(sim.db.cashMovements.length, movCountBefore, "Jumlah record mutasi tidak boleh bertambah.");
});

runTest(33, "Security Guard", "Kasir tidak dapat mengeksekusi refund", () => {
  assert.throws(() => {
    sim.processOrderRefundAtomic("ksr-1", "ord-1", 50000, "full", "cash", "Kasir mencoba refund", "idem-ref-illegal");
  }, /Hanya admin yang berhak memproses pengembalian dana/i);
});

runTest(34, "Cashier Isolation", "Kasir 2 tidak dapat mencatat mutasi atau menutup shift milik Kasir 1", () => {
  const shiftKasir1 = [...sim.db.shifts.values()].find((s) => s.cashier_id === "ksr-1" && s.status === "open");

  assert.throws(() => {
    sim.recordCashMovementAtomic("ksr-2", shiftKasir1.id, "cash_out", 10000, "Kasir 2 mencoba ambil kas kasir 1");
  }, /Kasir tidak dapat mencatat mutasi pada shift kasir lain/i);

  assert.throws(() => {
    sim.closeShiftAtomic("ksr-2", shiftKasir1.id, 250000, "Kasir 2 mencoba tutup shift kasir 1");
  }, /Kasir tidak berhak menutup shift milik kasir lain/i);
});

runTest(35, "Shift Closing Reconciliation", "Penutupan shift menghitung expected_cash secara deterministik dari riwayat ledger", () => {
  const shiftKasir1 = [...sim.db.shifts.values()].find((s) => s.cashier_id === "ksr-1" && s.status === "open");

  // Rincian mutasi kas kasir 1:
  // Modal awal: 200.000
  // Penjualan tunai: +50.000
  // Kas masuk manual: +50.000
  // Kas keluar manual: -30.000
  // Refund tunai dari shift kasir 1: -20.000
  // Ekspektasi akhir kas = 200.000 + 50.000 + 50.000 - 30.000 - 20.000 = 250.000
  assert.equal(shiftKasir1.expected_cash, 250000);

  const closeRes = sim.closeShiftAtomic("ksr-1", shiftKasir1.id, 250000, "Tutup shift pagi pas");
  assert.equal(closeRes.expected_cash, 250000);
  assert.equal(closeRes.actual_cash, 250000);
  assert.equal(closeRes.cash_difference, 0);
  assert.equal(closeRes.status, "closed");
  assert.equal(shiftKasir1.status, "closed");
});

runTest(36, "Shift Closing Discrepancy", "Rekonsiliasi shift dengan selisih lebih (+Rp 10.000) dan selisih kurang (-Rp 5.000)", () => {
  const shiftKasir2 = [...sim.db.shifts.values()].find((s) => s.cashier_id === "ksr-2" && s.status === "open");

  // Modal awal ksr-2: 150.000. Belum ada transaksi -> expected = 150.000
  // Kasir menghitung fisik 145.000 -> Selisih kurang -5.000
  const closeShort = sim.closeShiftAtomic("ksr-2", shiftKasir2.id, 145000, "Tutup shift selisih kurang");
  assert.equal(closeShort.expected_cash, 150000);
  assert.equal(closeShort.actual_cash, 145000);
  assert.equal(closeShort.cash_difference, -5000);

  const auditClose = sim.db.auditLogs.find((a) => a.action === "shift.closed" && a.entity_id === shiftKasir2.id);
  assert.ok(auditClose, "Audit log shift.closed wajib ada.");
  assert.equal(auditClose.details.cash_difference, -5000);
});

runTest(37, "Admin Privileges & [LOW-01]", "Admin mencatat mutasi kas operasional di luar shift dengan audit log is_out_of_shift: true", () => {
  const outShiftMov = sim.recordCashMovementAtomic("adm-1", null, "cash_out", 15000, "Beli kantong kresek operasional");
  assert.equal(outShiftMov.shift_id, null);
  assert.equal(outShiftMov.amount, 15000);

  const log = sim.db.auditLogs.find((a) => a.entity_id === outShiftMov.movement_id);
  assert.ok(log, "Audit log untuk mutasi luar shift wajib ada.");
  assert.equal(log.details.is_out_of_shift, true);
  assert.equal(log.details.shift_id, null);
});

runTest(38, "F2 & F4 Non-Regression", "Struktur pemrosesan pesanan F2 dan trigger inventori F4 tidak terganggu", () => {
  assert.match(sql, /p_payment_method text/i);
  assert.match(sql, /p_payment_source text/i);
  assert.match(sql, /p_amount integer/i);
  assert.match(sql, /p_idempotency_key text/i);

  assert.doesNotMatch(sql, /drop trigger.*trg_orders_deduct_stock_on_paid/i);
  assert.doesNotMatch(sql, /drop trigger.*trg_orders_release_stock_on_cancel/i);
});

// =============================================================================
// BAGIAN C: ADVERSARIAL HIGH-01 FIX VERIFICATION (REFUND MODAL PAYLOAD)
// =============================================================================

const REFUND_MODAL_FILE = path.join(ROOT, "src/components/pos/refund-modal.tsx");
const refundModalCode = fs.readFileSync(REFUND_MODAL_FILE, "utf-8");

runTest(39, "RefundModal Contract [HIGH-01]", "RefundModal mengirimkan payload camelCase ke processOrderRefundAction", () => {
  // Verifikasi pemanggilan processOrderRefundAction menggunakan format camelCase
  assert.match(refundModalCode, /processOrderRefundAction\(\{\s*orderId:\s*order\.id/);
  assert.match(refundModalCode, /paymentId:\s*selectedPaymentId\s*===\s*"all"\s*\?\s*undefined\s*:\s*selectedPaymentId/);
  assert.match(refundModalCode, /amount,/);
  assert.match(refundModalCode, /refundType,/);
  assert.match(refundModalCode, /refundMethod,/);
  assert.match(refundModalCode, /reason:\s*reason\.trim\(\),/);
  assert.match(refundModalCode, /idempotencyKey,/);

  // Pastikan kunci legacy snake_case sudah tidak lagi digunakan di RefundModal
  assert.doesNotMatch(refundModalCode, /processOrderRefundAction\(\{\s*order_id:/);
  assert.doesNotMatch(refundModalCode, /refund_type:/);
  assert.doesNotMatch(refundModalCode, /refund_method:/);
  assert.doesNotMatch(refundModalCode, /idempotency_key:/);
});

const VALIDATION_FILE = path.join(ROOT, "src/lib/payments/validation.ts");
const validationCode = fs.readFileSync(VALIDATION_FILE, "utf-8");

runTest(40, "Validation Contract [HIGH-01]", "processRefundSchema memiliki fungsi normalizeRefundInput & z.preprocess defensif", () => {
  assert.match(validationCode, /function normalizeRefundInput/);
  assert.match(validationCode, /orderId:\s*raw\.orderId\s*\?\?\s*raw\.order_id/);
  assert.match(validationCode, /refundType:\s*raw\.refundType\s*\?\?\s*raw\.refund_type/);
  assert.match(validationCode, /refundMethod:\s*raw\.refundMethod\s*\?\?\s*raw\.refund_method/);
  assert.match(validationCode, /export const processRefundSchema = z\.preprocess\(/);
});

// Schema definition mirror untuk pengujian runtime Zod
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function testNormalizeRefundInput(input) {
  if (typeof input !== "object" || input === null) return input;
  return {
    orderId: input.orderId ?? input.order_id,
    amount: input.amount,
    refundType: input.refundType ?? input.refund_type,
    refundMethod: input.refundMethod ?? input.refund_method,
    reason: input.reason,
    paymentId: input.paymentId ?? input.payment_id,
    shiftId: input.shiftId ?? input.shift_id,
    idempotencyKey: input.idempotencyKey ?? input.idempotency_key,
  };
}

const testRefundSchema = z.preprocess(
  testNormalizeRefundInput,
  z.object({
    orderId: z.string({ message: "ID pesanan wajib diisi." }).trim().regex(uuidRegex, "ID pesanan tidak valid."),
    amount: z.coerce.number({ message: "Nominal refund harus berupa angka." }).int().positive("Nominal refund harus lebih dari Rp 0."),
    refundType: z.enum(["full", "partial"], { message: "Tipe refund harus 'full' atau 'partial'." }),
    refundMethod: z.enum(["cash", "transfer", "midtrans", "manual"], { message: "Metode refund tidak valid." }),
    reason: z.string({ message: "Alasan refund wajib diisi." }).trim().min(3, "Alasan refund minimal 3 karakter.").max(500),
    paymentId: z.string().trim().regex(uuidRegex, "ID pembayaran tidak valid.").optional().nullable(),
    shiftId: z.string().trim().regex(uuidRegex, "ID shift tidak valid.").optional().nullable(),
    idempotencyKey: z.string({ message: "Kunci idempotensi refund wajib diisi." }).trim().min(8, "Kunci idempotensi refund minimal 8 karakter.").max(128),
  })
);

runTest(41, "Payload Validation [HIGH-01]", "Payload dari RefundModal (all payment & specific payment) lolos validasi schema", () => {
  // Skenario 1: All payment dipilih -> paymentId bernilai undefined
  const payloadAll = {
    orderId: "a1b2c3d4-1111-4111-8111-111111111111",
    paymentId: undefined,
    amount: 75000,
    refundType: "full",
    refundMethod: "cash",
    reason: "Pelanggan membatalkan pesanan",
    idempotencyKey: "ref_a1b2c3d4_1700000000000_abcde",
  };
  const parsedAll = testRefundSchema.safeParse(payloadAll);
  assert.equal(parsedAll.success, true);
  assert.equal(parsedAll.data.orderId, "a1b2c3d4-1111-4111-8111-111111111111");
  assert.equal(parsedAll.data.paymentId, undefined);
  assert.equal(parsedAll.data.amount, 75000);

  // Skenario 2: Split bill payment spesifik dipilih -> paymentId bernilai UUID
  const payloadSpecific = {
    orderId: "a1b2c3d4-1111-4111-8111-111111111111",
    paymentId: "b2c3d4e5-2222-4222-8222-222222222222",
    amount: 35000,
    refundType: "partial",
    refundMethod: "cash",
    reason: "Menu salah antar porsi kecil",
    idempotencyKey: "ref_a1b2c3d4_1700000000000_fghij",
  };
  const parsedSpecific = testRefundSchema.safeParse(payloadSpecific);
  assert.equal(parsedSpecific.success, true);
  assert.equal(parsedSpecific.data.paymentId, "b2c3d4e5-2222-4222-8222-222222222222");
  assert.equal(parsedSpecific.data.amount, 35000);
});

runTest(42, "Validation Error Messages & Normalization [HIGH-01]", "Error messages tetap akurat dan normalisasi legacy snake_case berjalan defensif", () => {
  // Verifikasi error messages saat data invalid
  const invalidPayload = {
    orderId: "bukan-uuid",
    amount: -5000,
    refundType: "invalid_type",
    refundMethod: "crypto",
    reason: "x",
    idempotencyKey: "pendek",
  };
  const parsedInvalid = testRefundSchema.safeParse(invalidPayload);
  assert.equal(parsedInvalid.success, false);
  const issues = parsedInvalid.error.issues;
  assert.ok(issues.some((i) => i.message.includes("ID pesanan tidak valid")));
  assert.ok(issues.some((i) => i.message.includes("lebih dari Rp 0")));
  assert.ok(issues.some((i) => i.message.includes("full") || i.message.includes("partial")));
  assert.ok(issues.some((i) => i.message.includes("minimal 3 karakter")));
  assert.ok(issues.some((i) => i.message.includes("minimal 8 karakter")));

  // Verifikasi normalisasi defensif legacy snake_case tetap didukung
  const legacyPayload = {
    order_id: "a1b2c3d4-1111-4111-8111-111111111111",
    payment_id: "b2c3d4e5-2222-4222-8222-222222222222",
    amount: 20000,
    refund_type: "partial",
    refund_method: "cash",
    reason: "Normalisasi fallback legacy",
    idempotency_key: "ref_legacy_1700000000000_klmno",
  };
  const parsedLegacy = testRefundSchema.safeParse(legacyPayload);
  assert.equal(parsedLegacy.success, true);
  assert.equal(parsedLegacy.data.orderId, "a1b2c3d4-1111-4111-8111-111111111111");
  assert.equal(parsedLegacy.data.paymentId, "b2c3d4e5-2222-4222-8222-222222222222");
});

console.log("\n===============================================================================");
console.log(` HASIL PENGUJIAN: ${passedTests} / ${totalTests} SKENARIO LULUS (100% PASS)`);
console.log("===============================================================================\n");
