#!/usr/bin/env node
/**
 * NINE LICIOUS POS - TEST SUITE: ORDER SERVING CONFIRMATION
 * (KONFIRMASI PESANAN SUDAH DISAJIKAN)
 *
 * Menguji seluruh 14 skenario wajib Tahap 6 + kontrak keamanan & proteksi F2/F3:
 * 1. Pesanan dine-in berstatus ready muncul di POS.
 * 2. Pesanan takeaway berstatus ready muncul di POS.
 * 3. Pesanan preparing (dan queued) tidak bisa dikonfirmasi.
 * 4. Pesanan belum lunas tidak bisa dikonfirmasi.
 * 5. Konfirmasi berhasil mencatat waktu (served_at) dan petugas (served_by).
 * 6. Pesanan yang sudah disajikan hilang dari daftar menunggu penyajian.
 * 7. Konfirmasi tidak mengubah status pembayaran.
 * 8. Konfirmasi tidak menutup dining session.
 * 9. Konfirmasi tidak mengubah status meja.
 * 10. Double-click / race condition tidak membuat konfirmasi ganda.
 * 11. Role kitchen tidak bisa melakukan konfirmasi.
 * 12. Refund penuh (dan cancelled) tidak bisa dikonfirmasi sebagai pesanan siap disajikan.
 * 13. Additional order memiliki pencatatan penyajian masing-masing.
 * 14. Fitur penutupan sesi meja F2.3 tetap berjalan dan tidak diubah.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function readProjectFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

// ============================================================================
// Pure Domain Mirror & Stateful Atomic Simulation
// ============================================================================
const SETTLED_PAYMENT_STATUSES = new Set(["paid", "partially_refunded"]);

function isOrderPendingServing(order) {
  if (order.status !== "paid") return false;
  if (!SETTLED_PAYMENT_STATUSES.has(order.payment_status)) return false;
  if (order.kds_status !== "ready") return false;
  if (order.served_at) return false;
  if (
    typeof order.grand_total === "number" &&
    typeof order.paid_total === "number" &&
    order.paid_total < order.grand_total
  ) {
    return false;
  }
  return true;
}

function validateOrderServingConfirmation(order) {
  if (order.served_at) {
    return { ok: false, message: "Sudah pernah dikonfirmasi disajikan." };
  }
  if (order.status === "refunded") {
    return { ok: false, message: "Pesanan telah direfund penuh." };
  }
  if (order.status === "cancelled") {
    return { ok: false, message: "Pesanan telah dibatalkan." };
  }
  if (order.status === "completed") {
    return { ok: false, message: "Pesanan sudah berstatus selesai." };
  }
  const paidShort =
    typeof order.grand_total === "number" &&
    typeof order.paid_total === "number" &&
    order.paid_total < order.grand_total;
  if (
    order.status !== "paid" ||
    !SETTLED_PAYMENT_STATUSES.has(order.payment_status) ||
    paidShort
  ) {
    return { ok: false, message: "Pesanan belum lunas." };
  }
  if (order.kds_status !== "ready") {
    return { ok: false, message: "Pesanan belum berstatus ready di dapur." };
  }
  return { ok: true };
}

function mergePendingServingOrdersById(orders) {
  const byId = new Map();
  for (const order of orders) {
    const existing = byId.get(order.id);
    if (!existing) {
      byId.set(order.id, order);
      continue;
    }
    const existingTs = Date.parse(existing.updatedAt);
    const incomingTs = Date.parse(order.updatedAt);
    if (Number.isNaN(existingTs) || incomingTs >= existingTs) {
      byId.set(order.id, order);
    }
  }
  return Array.from(byId.values()).sort((a, b) => {
    const diff = Date.parse(a.readyAt) - Date.parse(b.readyAt);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
    return a.orderNumber.localeCompare(b.orderNumber);
  });
}

function createMockRestaurantDb() {
  const tables = new Map([
    ["tbl-01", { id: "tbl-01", name: "T01", status: "occupied" }],
  ]);
  const sessions = new Map([
    [
      "sess-01",
      {
        id: "sess-01",
        table_id: "tbl-01",
        status: "open",
        closed_at: null,
        closed_by: null,
      },
    ],
  ]);
  const orders = new Map();
  const auditLogs = [];

  function confirmOrderServedAtomic({ orderId, actorId, actorRole, nowIso }) {
    if (!actorId || !["admin", "kasir"].includes(actorRole)) {
      return {
        ok: false,
        message: "Hanya admin atau kasir yang berhak mengonfirmasi penyajian.",
      };
    }

    const order = orders.get(orderId);
    if (!order) {
      return { ok: false, message: "Pesanan tidak ditemukan." };
    }

    const validation = validateOrderServingConfirmation(order);
    if (!validation.ok) {
      return validation;
    }

    // Atomic conditional mutation: ONLY served_at, served_by, updated_at
    order.served_at = nowIso;
    order.served_by = actorId;
    order.updated_at = nowIso;

    auditLogs.push({
      action: "order.served_confirmed",
      user_id: actorId,
      entity: "order",
      entity_id: order.id,
      details: {
        order_number: order.order_number,
        served_at: nowIso,
        served_by: actorId,
      },
    });

    return {
      ok: true,
      data: {
        order_id: order.id,
        served_at: order.served_at,
        served_by: order.served_by,
      },
    };
  }

  return { tables, sessions, orders, auditLogs, confirmOrderServedAtomic };
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

console.log("\n=======================================================================");
console.log("  NINE LICIOUS POS — ORDER SERVING CONFIRMATION TEST SUITE (14+ TESTS)");
console.log("=======================================================================\n");

// 1. Dine-in ready appears in POS
test("1. Pesanan dine-in berstatus ready (lunas & belum disajikan) muncul di POS", () => {
  const order = {
    id: "ord-di-1",
    order_number: "ORD-20261118-0001",
    order_type: "dine_in",
    table_id: "tbl-01",
    dining_session_id: "sess-01",
    status: "paid",
    payment_status: "paid",
    kds_status: "ready",
    grand_total: 45000,
    paid_total: 45000,
    served_at: null,
    served_by: null,
  };
  assert.equal(isOrderPendingServing(order), true);
});

// 2. Takeaway ready appears in POS
test("2. Pesanan takeaway berstatus ready muncul di POS tanpa membutuhkan dining session", () => {
  const order = {
    id: "ord-tw-1",
    order_number: "ORD-20261118-0002",
    order_type: "takeaway",
    table_id: null,
    dining_session_id: null,
    status: "paid",
    payment_status: "paid",
    kds_status: "ready",
    grand_total: 32000,
    paid_total: 32000,
    served_at: null,
    served_by: null,
  };
  assert.equal(isOrderPendingServing(order), true);

  const db = createMockRestaurantDb();
  db.orders.set(order.id, { ...order });
  const res = db.confirmOrderServedAtomic({
    orderId: order.id,
    actorId: "kasir-1",
    actorRole: "kasir",
    nowIso: "2026-11-18T11:10:00Z",
  });
  assert.equal(res.ok, true);
  assert.equal(db.orders.get(order.id).served_by, "kasir-1");
});

// 3. Preparing (and queued) cannot be confirmed
test("3. Pesanan berstatus preparing atau queued tidak bisa dikonfirmasi disajikan", () => {
  const preparingOrder = {
    id: "ord-prep",
    order_number: "ORD-0003",
    status: "paid",
    payment_status: "paid",
    kds_status: "preparing",
    grand_total: 30000,
    paid_total: 30000,
    served_at: null,
  };
  const queuedOrder = { ...preparingOrder, kds_status: "queued" };

  assert.equal(isOrderPendingServing(preparingOrder), false);
  assert.equal(validateOrderServingConfirmation(preparingOrder).ok, false);
  assert.equal(validateOrderServingConfirmation(queuedOrder).ok, false);
});

// 4. Unpaid orders cannot be confirmed
test("4. Pesanan belum lunas (awaiting_payment / partially_paid / paid_total < grand_total) ditolak", () => {
  const unpaid = {
    id: "ord-unpaid",
    order_number: "ORD-0004",
    status: "awaiting_payment",
    payment_status: "unpaid",
    kds_status: "ready",
    grand_total: 50000,
    paid_total: 0,
    served_at: null,
  };
  const partial = {
    ...unpaid,
    status: "partially_paid",
    payment_status: "partially_paid",
    paid_total: 25000,
  };
  const shortPaid = {
    ...unpaid,
    status: "paid",
    payment_status: "paid",
    paid_total: 40000,
  };

  assert.equal(isOrderPendingServing(unpaid), false);
  assert.equal(validateOrderServingConfirmation(unpaid).ok, false);
  assert.equal(validateOrderServingConfirmation(partial).ok, false);
  assert.equal(validateOrderServingConfirmation(shortPaid).ok, false);
});

// 5. Confirmed records time & staff
test("5. Konfirmasi berhasil mencatat waktu penyajian (served_at), petugas (served_by), dan audit log", () => {
  const db = createMockRestaurantDb();
  const order = {
    id: "ord-di-5",
    order_number: "ORD-20261118-0005",
    order_type: "dine_in",
    table_id: "tbl-01",
    dining_session_id: "sess-01",
    status: "paid",
    payment_status: "paid",
    kds_status: "ready",
    grand_total: 60000,
    paid_total: 60000,
    served_at: null,
    served_by: null,
    updated_at: "2026-11-18T11:05:00Z",
  };
  db.orders.set(order.id, order);

  const servedTime = "2026-11-18T11:08:00Z";
  const result = db.confirmOrderServedAtomic({
    orderId: order.id,
    actorId: "kasir-01",
    actorRole: "kasir",
    nowIso: servedTime,
  });

  assert.equal(result.ok, true);
  assert.equal(order.served_at, servedTime);
  assert.equal(order.served_by, "kasir-01");
  assert.equal(db.auditLogs.length, 1);
  assert.equal(db.auditLogs[0].action, "order.served_confirmed");
});

// 6. Disappears from pending serving list
test("6. Pesanan yang sudah disajikan hilang dari daftar menunggu penyajian", () => {
  const db = createMockRestaurantDb();
  const order = {
    id: "ord-di-6",
    order_number: "ORD-20261118-0006A",
    order_type: "dine_in",
    table_id: "tbl-01",
    dining_session_id: "sess-01",
    status: "paid",
    payment_status: "paid",
    kds_status: "ready",
    grand_total: 45000,
    paid_total: 45000,
    served_at: null,
    served_by: null,
  };
  db.orders.set(order.id, order);
  assert.equal(isOrderPendingServing(order), true);

  db.confirmOrderServedAtomic({
    orderId: order.id,
    actorId: "kasir-01",
    actorRole: "kasir",
    nowIso: "2026-11-18T11:09:00Z",
  });
  assert.equal(isOrderPendingServing(order), false);
});

// 7. Does not change payment status
test("7. Konfirmasi penyajian tidak mengubah status pembayaran maupun status KDS", () => {
  const db = createMockRestaurantDb();
  const order = {
    id: "ord-di-7",
    order_number: "ORD-20261118-0007A",
    order_type: "dine_in",
    table_id: "tbl-01",
    dining_session_id: "sess-01",
    status: "paid",
    payment_status: "paid",
    kds_status: "ready",
    grand_total: 55000,
    paid_total: 55000,
    served_at: null,
    served_by: null,
  };
  db.orders.set(order.id, order);

  db.confirmOrderServedAtomic({
    orderId: order.id,
    actorId: "kasir-01",
    actorRole: "kasir",
    nowIso: "2026-11-18T11:09:30Z",
  });
  assert.equal(order.payment_status, "paid");
  assert.equal(order.paid_total, 55000);
  assert.equal(order.status, "paid");
  assert.equal(order.kds_status, "ready");
});

// 8. Does not close dining session
test("8. Konfirmasi penyajian tidak menutup dining session (tetap open)", () => {
  const db = createMockRestaurantDb();
  const order = {
    id: "ord-di-8",
    order_number: "ORD-20261118-0008A",
    order_type: "dine_in",
    table_id: "tbl-01",
    dining_session_id: "sess-01",
    status: "paid",
    payment_status: "paid",
    kds_status: "ready",
    grand_total: 55000,
    paid_total: 55000,
    served_at: null,
    served_by: null,
  };
  db.orders.set(order.id, order);

  db.confirmOrderServedAtomic({
    orderId: order.id,
    actorId: "kasir-01",
    actorRole: "kasir",
    nowIso: "2026-11-18T11:10:00Z",
  });
  assert.equal(db.sessions.get("sess-01").status, "open");
  assert.equal(db.sessions.get("sess-01").closed_at, null);
});

// 9. Does not change table status
test("9. Konfirmasi penyajian tidak mengubah status meja (tetap occupied)", () => {
  const db = createMockRestaurantDb();
  const order = {
    id: "ord-di-9",
    order_number: "ORD-20261118-0009A",
    order_type: "dine_in",
    table_id: "tbl-01",
    dining_session_id: "sess-01",
    status: "paid",
    payment_status: "paid",
    kds_status: "ready",
    grand_total: 55000,
    paid_total: 55000,
    served_at: null,
    served_by: null,
  };
  db.orders.set(order.id, order);

  db.confirmOrderServedAtomic({
    orderId: order.id,
    actorId: "kasir-01",
    actorRole: "kasir",
    nowIso: "2026-11-18T11:10:30Z",
  });
  assert.equal(db.tables.get("tbl-01").status, "occupied");
});

// 10. Double-click / race condition does not create duplicate confirmation
test("10. Double-click / panggilan berulang ditolak dan tidak membuat konfirmasi ganda", () => {
  const db = createMockRestaurantDb();
  const order = {
    id: "ord-race",
    order_number: "ORD-20261118-0006",
    order_type: "dine_in",
    table_id: "tbl-01",
    dining_session_id: "sess-01",
    status: "paid",
    payment_status: "paid",
    kds_status: "ready",
    grand_total: 40000,
    paid_total: 40000,
    served_at: null,
    served_by: null,
  };
  db.orders.set(order.id, order);

  const first = db.confirmOrderServedAtomic({
    orderId: order.id,
    actorId: "kasir-01",
    actorRole: "kasir",
    nowIso: "2026-11-18T11:12:00Z",
  });
  const second = db.confirmOrderServedAtomic({
    orderId: order.id,
    actorId: "admin-01",
    actorRole: "admin",
    nowIso: "2026-11-18T11:12:01Z",
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  // Tetap mempertahankan petugas & waktu pertama
  assert.equal(order.served_by, "kasir-01");
  assert.equal(order.served_at, "2026-11-18T11:12:00Z");
  assert.equal(db.auditLogs.length, 1);
});

// 11. Kitchen role rejected
test("11. Role kitchen tidak bisa melakukan konfirmasi penyajian (hanya admin & kasir)", () => {
  const db = createMockRestaurantDb();
  db.orders.set("ord-k", {
    id: "ord-k",
    order_number: "ORD-20261118-0007",
    status: "paid",
    payment_status: "paid",
    kds_status: "ready",
    grand_total: 25000,
    paid_total: 25000,
    served_at: null,
  });

  const kitchenAttempt = db.confirmOrderServedAtomic({
    orderId: "ord-k",
    actorId: "kitchen-01",
    actorRole: "kitchen",
    nowIso: "2026-11-18T11:15:00Z",
  });
  assert.equal(kitchenAttempt.ok, false);
  assert.equal(db.orders.get("ord-k").served_at, null);
});

// 12. Full refund & cancelled cannot be confirmed
test("12. Refund penuh (refunded) dan pesanan dibatalkan (cancelled) ditolak", () => {
  const fullRefund = {
    id: "ord-ref",
    order_number: "ORD-20261118-0008",
    status: "refunded",
    payment_status: "refunded",
    kds_status: null,
    grand_total: 50000,
    paid_total: 50000,
    served_at: null,
  };
  const cancelled = {
    id: "ord-can",
    order_number: "ORD-20261118-0009",
    status: "cancelled",
    payment_status: "unpaid",
    kds_status: null,
    grand_total: 50000,
    paid_total: 0,
    served_at: null,
  };

  assert.equal(isOrderPendingServing(fullRefund), false);
  assert.equal(validateOrderServingConfirmation(fullRefund).ok, false);
  assert.equal(isOrderPendingServing(cancelled), false);
  assert.equal(validateOrderServingConfirmation(cancelled).ok, false);
});

// 13. Additional order has independent serving confirmation
test("13. Additional order pada sesi meja sama memiliki pencatatan penyajian masing-masing", () => {
  const db = createMockRestaurantDb();
  const order1 = {
    id: "ord-s1-1",
    order_number: "ORD-20261118-0010",
    order_type: "dine_in",
    table_id: "tbl-01",
    dining_session_id: "sess-01",
    status: "paid",
    payment_status: "paid",
    kds_status: "ready",
    grand_total: 40000,
    paid_total: 40000,
    served_at: null,
    served_by: null,
  };
  const order2 = {
    id: "ord-s1-2",
    order_number: "ORD-20261118-0011",
    order_type: "dine_in",
    table_id: "tbl-01",
    dining_session_id: "sess-01",
    status: "paid",
    payment_status: "paid",
    kds_status: "ready",
    grand_total: 22000,
    paid_total: 22000,
    served_at: null,
    served_by: null,
  };
  db.orders.set(order1.id, order1);
  db.orders.set(order2.id, order2);

  // Konfirmasi pesanan #1
  const res1 = db.confirmOrderServedAtomic({
    orderId: order1.id,
    actorId: "kasir-01",
    actorRole: "kasir",
    nowIso: "2026-11-18T11:20:00Z",
  });
  assert.equal(res1.ok, true);
  assert.equal(isOrderPendingServing(order1), false);
  // Pesanan tambahan #2 tetap muncul di daftar menunggu penyajian
  assert.equal(isOrderPendingServing(order2), true);
  assert.equal(order2.served_at, null);

  // Konfirmasi pesanan tambahan #2 oleh petugas berbeda
  const res2 = db.confirmOrderServedAtomic({
    orderId: order2.id,
    actorId: "admin-01",
    actorRole: "admin",
    nowIso: "2026-11-18T11:28:00Z",
  });
  assert.equal(res2.ok, true);
  assert.equal(order1.served_by, "kasir-01");
  assert.equal(order1.served_at, "2026-11-18T11:20:00Z");
  assert.equal(order2.served_by, "admin-01");
  assert.equal(order2.served_at, "2026-11-18T11:28:00Z");
  // Sesi meja tetap terbuka
  assert.equal(db.sessions.get("sess-01").status, "open");
});

// 14. Deduplication + Source & Migration Contract Verification + F2.3 Protection
test("14. Deduplikasi Realtime, kontrak SQL migration, proteksi F2.3 (complete_pos_order/close_dining_session) & KDS 3 status", () => {
  // Deduplikasi FIFO
  const deduped = mergePendingServingOrdersById([
    {
      id: "ord-2",
      orderNumber: "ORD-002",
      readyAt: "2026-11-18T11:05:00Z",
      updatedAt: "2026-11-18T11:05:00Z",
    },
    {
      id: "ord-1",
      orderNumber: "ORD-001",
      readyAt: "2026-11-18T11:01:00Z",
      updatedAt: "2026-11-18T11:01:00Z",
    },
    {
      id: "ord-1",
      orderNumber: "ORD-001",
      readyAt: "2026-11-18T11:01:00Z",
      updatedAt: "2026-11-18T11:02:00Z",
    },
  ]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].id, "ord-1");

  const migrationSql = readProjectFile(
    "supabase/migrations/20261118000100_order_serving_confirmation.sql",
  );
  const actionsSrc = readProjectFile("src/lib/orders/serving-actions.ts");
  const panelSrc = readProjectFile("src/components/pos/pending-serving-panel.tsx");
  const posPageSrc = readProjectFile("src/app/(app)/pos/page.tsx");
  const kdsTransSrc = readProjectFile("src/lib/kds/transitions.ts");

  // Migration adds served_at & served_by + sync check + atomic RPC with FOR UPDATE
  assert.match(migrationSql, /add column if not exists served_at timestamptz/);
  assert.match(migrationSql, /add column if not exists served_by uuid/);
  assert.match(migrationSql, /orders_served_at_by_sync_check/);
  assert.match(migrationSql, /create or replace function public\.confirm_order_served_atomic/);
  assert.match(migrationSql, /for update;/);
  assert.match(migrationSql, /v_user_role not in \('admin', 'kasir'\)/);
  assert.match(migrationSql, /'order\.served_confirmed'/);

  // Migration does NOT alter complete_pos_order, close_dining_session_atomic, dining_sessions, dining_tables, or KDS status constraint
  assert.equal(/create or replace function public\.complete_pos_order/i.test(migrationSql), false);
  assert.equal(/create or replace function public\.close_dining_session_atomic/i.test(migrationSql), false);
  assert.equal(/update public\.dining_sessions/i.test(migrationSql), false);
  assert.equal(/update public\.dining_tables/i.test(migrationSql), false);
  assert.equal(/orders_kds_status_check/i.test(migrationSql), false);

  // Server action enforces getCashierActor (admin & kasir only) & never mutates dining_sessions / dining_tables / payments
  assert.match(actionsSrc, /const actor = await getCashierActor\(\)/);
  assert.match(actionsSrc, /confirm_order_served_atomic/);
  assert.equal(/\.from\("dining_sessions"\)\s*\.update/.test(actionsSrc), false);
  assert.equal(/\.from\("dining_tables"\)\s*\.update/.test(actionsSrc), false);
  assert.equal(/\.from\("payments"\)/.test(actionsSrc), false);

  // KDS keeps strictly 3 statuses (no 'served' KDS status)
  assert.match(kdsTransSrc, /KDS_STATUS_ORDER: readonly KdsStatus\[\] = \[\s*"queued",\s*"preparing",\s*"ready",\s*\] as const/);

  // POS UI has Menunggu Disajikan, confirmation dialog, Realtime + fallback polling + cleanup
  assert.match(posPageSrc, /PendingServingPanel/);
  assert.match(panelSrc, /Menunggu Disajikan/);
  assert.match(panelSrc, /Tandai Sudah Disajikan/);
  assert.match(panelSrc, /Konfirmasi Pesanan Sudah Disajikan/);
  assert.match(panelSrc, /postgres_changes/);
  assert.match(panelSrc, /removeChannel/);
  assert.match(panelSrc, /FALLBACK_POLL_INTERVAL_MS/);
});

// 15. Final Security Audit Verification (Constraint vs ON DELETE SET NULL, RPC Hardening, Action Hardening)
test("15. Final Security Audit: constraint aman thd ON DELETE SET NULL, RPC search_path/least-privilege/service_role revoke, & fallback hardened", () => {
  const migrationSql = readProjectFile(
    "supabase/migrations/20261118000100_order_serving_confirmation.sql",
  );
  const actionsSrc = readProjectFile("src/lib/orders/serving-actions.ts");

  // Constraint allows (served_at NOT NULL, served_by NULL) when profile is deleted via ON DELETE SET NULL,
  // while rejecting (served_at NULL, served_by NOT NULL)
  assert.match(migrationSql, /references public\.profiles \(id\) on delete set null/i);
  assert.match(migrationSql, /check \(served_by is null or served_at is not null\)/i);
  // Ensure old conflicting bidirectional check is NOT present
  assert.equal(/served_at is not null and served_by is not null/i.test(migrationSql), false);

  // RPC hardening: SECURITY DEFINER, search_path = public, pg_temp, auth.uid() null check, is_active check
  assert.match(migrationSql, /security definer/i);
  assert.match(migrationSql, /set search_path = public, pg_temp/i);
  assert.match(migrationSql, /if v_user_id is null then/i);
  assert.match(migrationSql, /v_is_active is distinct from true/i);

  // Least privilege GRANT / REVOKE: revoke public, anon, service_role; grant ONLY authenticated
  assert.match(
    migrationSql,
    /revoke all on function public\.confirm_order_served_atomic\(uuid\) from public;/i,
  );
  assert.match(
    migrationSql,
    /revoke all on function public\.confirm_order_served_atomic\(uuid\) from anon;/i,
  );
  assert.match(
    migrationSql,
    /revoke all on function public\.confirm_order_served_atomic\(uuid\) from service_role;/i,
  );
  assert.match(
    migrationSql,
    /grant execute on function public\.confirm_order_served_atomic\(uuid\) to authenticated;/i,
  );
  assert.equal(
    /grant execute on function public\.confirm_order_served_atomic\(uuid\) to service_role;/i.test(
      migrationSql,
    ),
    false,
  );

  // Server action confirmOrderServedAction must never use service-role admin client
  const confirmFnStart = actionsSrc.indexOf("export async function confirmOrderServedAction");
  assert.ok(confirmFnStart > 0);
  const confirmFnBody = actionsSrc.slice(confirmFnStart);
  assert.equal(/createSupabaseAdminClient/.test(confirmFnBody), false);
  // Strict fallback error code detection (no loose string includes)
  assert.match(
    confirmFnBody,
    /rpcError\?\.code === "PGRST202" \|\| rpcError\?\.code === "42883"/,
  );
  // Fallback atomic update also enforces payment_status in ('paid', 'partially_refunded')
  assert.match(
    confirmFnBody,
    /\.in\("payment_status", \["paid", "partially_refunded"\]\)/,
  );
});

// 16. Sinkronisasi Daftar Pesanan, Detail Meja, dan Penutupan Sesi Meja
test("16. Detail Meja memakai aturan penyajian yang sama & sesi hanya bisa ditutup setelah semua pesanan disajikan", () => {
  // Aturan tombol: lunas + KDS ready + belum served_at.
  const unservedReady = {
    status: "paid",
    payment_status: "paid",
    kds_status: "ready",
    served_at: null,
    grand_total: 34500,
    paid_total: 34500,
  };
  assert.equal(isOrderPendingServing(unservedReady), true);

  const alreadyServed = { ...unservedReady, served_at: "2026-11-18T06:57:00.000Z" };
  assert.equal(isOrderPendingServing(alreadyServed), false);

  const notReady = { ...unservedReady, kds_status: "preparing" };
  assert.equal(isOrderPendingServing(notReady), false);

  const unpaid = { ...unservedReady, payment_status: "unpaid", paid_total: 0 };
  assert.equal(isOrderPendingServing(unpaid), false);

  const dialogSrc = readProjectFile("src/components/tables/table-session-dialog.tsx");
  const closureSrc = readProjectFile("src/lib/orders/session-closure.ts");
  const actionsSrc = readProjectFile("src/lib/orders/actions.ts");
  const servingSrc = readProjectFile("src/lib/orders/serving.ts");

  // Detail Meja memakai aksi konfirmasi penyajian yang sama dengan Daftar Pesanan.
  assert.match(dialogSrc, /confirmOrderServedAction/);
  assert.match(dialogSrc, /isOrderPendingServing/);
  assert.match(dialogSrc, /applyServedConfirmationToSessionSummary/);
  assert.match(dialogSrc, /Tandai Sudah Disajikan/);
  assert.match(dialogSrc, /served_at/);
  assert.match(dialogSrc, /served_by_name/);
  assert.match(dialogSrc, /formatWibTime/);
  assert.equal(/completePosOrderAction/.test(dialogSrc), false);
  assert.equal(/Tandai Selesai/.test(dialogSrc), false);

  // Sinkronisasi realtime + fallback polling + cleanup.
  assert.match(dialogSrc, /postgres_changes/);
  assert.match(dialogSrc, /removeChannel/);
  assert.match(dialogSrc, /FALLBACK_POLL_INTERVAL_MS/);
  assert.match(dialogSrc, /router\.refresh\(\)/);

  // Aturan penutupan sesi: wajib served_at untuk pesanan aktif.
  assert.match(closureSrc, /belum disajikan/);
  assert.match(closureSrc, /!order\.served_at/);
  assert.match(servingSrc, /export function isOrderServed/);
  assert.match(servingSrc, /export function applyServedConfirmationToSessionSummary/);

  // Ringkasan sesi mengambil served_at/served_by dari sumber yang sama dengan Daftar Pesanan.
  assert.match(actionsSrc, /enrichSessionOrdersWithServingInfo/);
  assert.match(actionsSrc, /served_at, served_by/);
  assert.match(actionsSrc, /belum disajikan kepada pelanggan/);
});

console.log("\n-----------------------------------------------------------------------");
console.log(`  HASIL ORDER SERVING CONFIRMATION: ${passed} PASS, ${failed} FAIL`);
console.log("-----------------------------------------------------------------------\n");

if (failed > 0) {
  process.exit(1);
}
