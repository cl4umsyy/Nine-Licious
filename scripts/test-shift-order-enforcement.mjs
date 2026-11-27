#!/usr/bin/env node
/**
 * NINE LICIOUS POS — SHIFT & ORDER ENFORCEMENT TEST SUITE
 *
 * Covers ALL 15 comprehensive scenarios (including 12 mandatory prompt tests + regression):
 *  1. Kasir tanpa shift aktif mencoba membuat pesanan (UI lock + banner + CTA Buka Shift Sekarang).
 *  2. Kasir tanpa shift aktif memanggil Server Action createPosOrderAction langsung (takeaway & dine_in) -> DITOLAK.
 *  3. Kasir tanpa shift aktif mencoba pesanan tambahan (occupied table) & appendOrderItemsAction -> DITOLAK.
 *  4. Kasir membuka shift -> pembuatan pesanan baru (takeaway & dine_in), tambahan, kas masuk/keluar, detail shift & rekonsiliasi -> BERHASIL.
 *  5. Kasir menutup shift -> pesanan berikutnya DITOLAK; Kasir membuka shift baru (#2) -> pesanan kembali BERHASIL.
 *  6. Kasir mencoba membayar tunai tanpa shift aktif -> DITOLAK.
 *  7. Kasir dengan shift aktif dapat melakukan pembayaran tunai -> BERHASIL & mutasi kas tercatat.
 *  8. Pembayaran Midtrans dari pesanan lama tetap dapat diselesaikan setelah shift ditutup (Snap + rekonsiliasi settlement).
 *  9. Admin tetap bisa membuka shift (untuk diri sendiri & untuk kasir lain) + lihat riwayat shift.
 * 10. Admin tetap bisa menutup shift (untuk diri sendiri & untuk kasir lain, backend & UI).
 * 11. Admin tetap bisa mengakses halaman Kelola Shift (/admin/shifts & /pos/shift).
 * 12. Kasir tidak bisa mengakses fungsi administrasi khusus admin.
 * 13. Shift yang sudah ditutup tidak bisa dimodifikasi via pemanggilan Server Action langsung.
 * 14. Kegagalan validasi shift tidak menghasilkan order, dining session, alokasi, atau reservasi stok (+ SQL triggers check).
 * 15. Kasir mencoba membuat/menambah pesanan atau bayar dengan spoofed shift_id/shiftId milik kasir lain -> DITOLAK.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();

const USER_KASIR_1 = "11111111-1111-4111-8111-111111111111";
const USER_KASIR_2 = "22222222-2222-4222-8222-222222222222";
const USER_ADMIN_1 = "33333333-3333-4333-8333-333333333333";
const PRODUCT_1 = "44444444-4444-4444-8444-444444444444";
const TABLE_1 = "55555555-5555-4555-8555-555555555555";
const TABLE_OCCUPIED = "66666666-6666-4666-8666-666666666666";
const INGREDIENT_1 = "77777777-7777-4777-8777-777777777777";
const EXISTING_ORDER_1 = "88888888-8888-4888-8888-888888888888";

let currentActor = {
  id: USER_KASIR_1,
  username: "kasir1",
  full_name: "Kasir Satu",
  role: "kasir",
  is_active: true,
};

const db = {
  profiles: [],
  shifts: [],
  cash_movements: [],
  orders: [],
  order_items: [],
  order_item_modifiers: [],
  order_discounts: [],
  dining_tables: [],
  dining_sessions: [],
  products: [],
  modifier_options: [],
  product_modifier_groups: [],
  modifier_groups: [],
  recipes: [],
  ingredients: [],
  ingredient_reservations: [],
  order_allocations: [],
  payments: [],
  midtrans_transactions: [],
  restaurant_settings: [],
  audit_logs: [],
  createOrderRpcCalls: 0,
  appendOrderRpcCalls: 0,
  cashPaymentRpcCalls: 0,
  createSnapCalls: 0,
};

let seqCounter = 0;
function nextUuid(prefixChar = "a") {
  seqCounter += 1;
  const tail = String(seqCounter).padStart(12, "0");
  return `${prefixChar.repeat(8)}-0000-4000-8000-${tail}`;
}

function resetDb() {
  seqCounter = 0;
  db.profiles = [
    { id: USER_KASIR_1, username: "kasir1", full_name: "Kasir Satu", role: "kasir", is_active: true },
    { id: USER_KASIR_2, username: "kasir2", full_name: "Kasir Dua", role: "kasir", is_active: true },
    { id: USER_ADMIN_1, username: "admin1", full_name: "Admin Utama", role: "admin", is_active: true },
  ];
  db.shifts = [];
  db.cash_movements = [];
  db.orders = [];
  db.order_items = [];
  db.order_item_modifiers = [];
  db.order_discounts = [];
  db.dining_tables = [
    { id: TABLE_1, name: "A01", status: "empty", is_active: true, capacity: 4 },
    { id: TABLE_OCCUPIED, name: "A02", status: "occupied", is_active: true, capacity: 4 },
  ];
  db.dining_sessions = [
    { id: "session-occupied-1", table_id: TABLE_OCCUPIED, status: "open", opened_by: USER_KASIR_1 },
  ];
  db.products = [
    {
      id: PRODUCT_1,
      name: "Classic Waffle",
      sku: "NL-001",
      price: 28000,
      is_active: true,
      is_available: true,
      kitchen_station: "kitchen",
    },
  ];
  db.modifier_options = [];
  db.product_modifier_groups = [];
  db.modifier_groups = [];
  db.recipes = [
    { product_id: PRODUCT_1, ingredient_id: INGREDIENT_1, quantity_required: 100 },
  ];
  db.ingredients = [
    {
      id: INGREDIENT_1,
      name: "Tepung Terigu",
      unit: "g",
      current_stock: 5000,
      reserved_stock: 0,
      is_active: true,
    },
  ];
  db.ingredient_reservations = [];
  db.order_allocations = [];
  db.payments = [];
  db.midtrans_transactions = [];
  db.restaurant_settings = [{ id: 1, tax_percent: 10, service_charge_percent: 5 }];
  db.audit_logs = [];
  db.createOrderRpcCalls = 0;
  db.appendOrderRpcCalls = 0;
  db.cashPaymentRpcCalls = 0;
  db.createSnapCalls = 0;

  currentActor = { ...db.profiles[0] };
}

function makeQuery(tableName, bypassRls = false) {
  const filters = [];
  let op = "select";
  let selectOpts = {};
  let updatePatch = null;
  let insertPayload = null;
  const orderBys = [];
  let limitCount = null;
  let rangeSpan = null;
  let singleMode = null;

  function applyFilters(rows) {
    return rows.filter((row) =>
      filters.every((f) => {
        if (f.type === "eq") return row[f.col] === f.val;
        if (f.type === "neq") return row[f.col] !== f.val;
        if (f.type === "in") return Array.isArray(f.val) && f.val.includes(row[f.col]);
        if (f.type === "is") return (row[f.col] ?? null) === f.val;
        if (f.type === "gte") return String(row[f.col] ?? "") >= String(f.val);
        if (f.type === "lte") return String(row[f.col] ?? "") <= String(f.val);
        return true;
      }),
    );
  }

  function hydrate(row) {
    const copy = { ...row };
    if (tableName === "shifts") {
      const prof = db.profiles.find((p) => p.id === row.cashier_id);
      copy.cashier = prof
        ? { id: prof.id, full_name: prof.full_name, username: prof.username }
        : null;
    }
    if (tableName === "orders") {
      const tbl = db.dining_tables.find((t) => t.id === row.table_id);
      copy.dining_tables = tbl ? { name: tbl.name } : null;
    }
    return copy;
  }

  function execute() {
    const table = db[tableName];
    if (!table) {
      return { data: null, count: 0, error: { message: `Unknown table ${tableName}` } };
    }

    if (op === "insert") {
      const rows = Array.isArray(insertPayload) ? insertPayload : [insertPayload];
      const inserted = [];
      for (const r of rows) {
        const created = { id: r.id || nextUuid("9"), created_at: new Date().toISOString(), ...r };
        table.push(created);
        inserted.push(created);
      }
      if (singleMode === "single" || singleMode === "maybeSingle") {
        return { data: inserted[0] ?? null, error: null };
      }
      return { data: inserted, error: null };
    }

    if (op === "update") {
      const matched = applyFilters(table);
      const updated = [];
      for (const row of matched) {
        Object.assign(row, updatePatch);
        updated.push({ ...row });
      }
      if (singleMode === "single" || singleMode === "maybeSingle") {
        return { data: updated[0] ?? null, error: null };
      }
      return { data: updated, error: null };
    }

    let rows = table;
    if (!bypassRls && tableName === "shifts" && currentActor.role !== "admin") {
      rows = rows.filter((s) => s.cashier_id === currentActor.id);
    }

    let result = applyFilters(rows).map(hydrate);
    for (let i = orderBys.length - 1; i >= 0; i--) {
      const { col, ascending } = orderBys[i];
      result.sort((a, b) => {
        const va = a[col] ?? "";
        const vb = b[col] ?? "";
        if (va < vb) return ascending ? -1 : 1;
        if (va > vb) return ascending ? 1 : -1;
        return 0;
      });
    }

    const totalCount = result.length;
    if (rangeSpan) {
      result = result.slice(rangeSpan.from, rangeSpan.to + 1);
    }
    if (typeof limitCount === "number") {
      result = result.slice(0, limitCount);
    }

    if (selectOpts?.head) {
      return { data: null, count: totalCount, error: null };
    }
    if (singleMode === "single" || singleMode === "maybeSingle") {
      return { data: result[0] ?? null, count: result[0] ? 1 : 0, error: null };
    }
    return { data: result, count: totalCount, error: null };
  }

  const builder = {
    select(_cols, opts = {}) {
      selectOpts = opts || {};
      return builder;
    },
    insert(payload) {
      op = "insert";
      insertPayload = payload;
      return builder;
    },
    update(patch) {
      op = "update";
      updatePatch = patch;
      return builder;
    },
    eq(col, val) {
      filters.push({ type: "eq", col, val });
      return builder;
    },
    neq(col, val) {
      filters.push({ type: "neq", col, val });
      return builder;
    },
    in(col, val) {
      filters.push({ type: "in", col, val });
      return builder;
    },
    is(col, val) {
      filters.push({ type: "is", col, val });
      return builder;
    },
    gte(col, val) {
      filters.push({ type: "gte", col, val });
      return builder;
    },
    lte(col, val) {
      filters.push({ type: "lte", col, val });
      return builder;
    },
    order(col, opts = {}) {
      orderBys.push({ col, ascending: opts.ascending !== false });
      return builder;
    },
    limit(n) {
      limitCount = n;
      return builder;
    },
    range(from, to) {
      rangeSpan = { from, to };
      return builder;
    },
    maybeSingle() {
      singleMode = "maybeSingle";
      return Promise.resolve(execute());
    },
    single() {
      singleMode = "single";
      return Promise.resolve(execute());
    },
    then(onFulfilled, onRejected) {
      return Promise.resolve(execute()).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

function reserveStockInMock(orderId) {
  const items = db.order_items.filter((it) => it.order_id === orderId);
  for (const item of items) {
    const recs = db.recipes.filter((r) => r.product_id === item.product_id);
    for (const r of recs) {
      const need = r.quantity_required * item.quantity;
      const ing = db.ingredients.find((i) => i.id === r.ingredient_id);
      if (!ing) continue;
      if (ing.current_stock - ing.reserved_stock < need) {
        return { ok: false, message: `Stok ${ing.name} tidak mencukupi.` };
      }
      ing.reserved_stock += need;
      db.ingredient_reservations.push({
        id: nextUuid("e"),
        order_id: orderId,
        ingredient_id: ing.id,
        quantity: need,
        status: "active",
      });
    }
  }
  return { ok: true };
}

const supabaseMock = {
  from: (tableName) => makeQuery(tableName, false),
  rpc: async (fnName, args = {}) => {
    if (fnName === "get_active_global_shift_status") {
      if (!["admin", "kasir"].includes(currentActor.role)) {
        return { data: null, error: { message: "Hanya admin dan kasir yang dapat memeriksa status shift aktif." } };
      }
      const openShift = db.shifts.find((s) => s.status === "open");
      if (!openShift) {
        return {
          data: {
            has_active_shift: false,
            shift_id: null,
            cashier_id: null,
            cashier_name: null,
            cashier_username: null,
            opened_at: null,
            is_owned_by_caller: false,
          },
          error: null,
        };
      }
      const prof = db.profiles.find((p) => p.id === openShift.cashier_id);
      return {
        data: {
          has_active_shift: true,
          shift_id: openShift.id,
          cashier_id: openShift.cashier_id,
          cashier_name: prof?.full_name ?? null,
          cashier_username: prof?.username ?? null,
          opened_at: openShift.opened_at,
          is_owned_by_caller: openShift.cashier_id === currentActor.id,
        },
        error: null,
      };
    }

    if (fnName === "open_shift_atomic") {
      if (!["admin", "kasir"].includes(currentActor.role)) {
        return { data: null, error: { message: "Hanya Admin dan Kasir yang dapat membuka shift." } };
      }
      const targetCashierId = args.p_cashier_id || currentActor.id;
      if (targetCashierId !== currentActor.id && currentActor.role !== "admin") {
        return { data: null, error: { message: "Kasir hanya dapat membuka shift untuk dirinya sendiri." } };
      }
      const existingAnyOpen = db.shifts.find((s) => s.status === "open");
      if (existingAnyOpen) {
        if (existingAnyOpen.cashier_id === targetCashierId) {
          return {
            data: null,
            error: {
              message: `Kasir masih memiliki shift aktif yang belum ditutup (Shift ID: ${existingAnyOpen.id}). Tutup shift terlebih dahulu.`,
            },
          };
        }
        const activeProf = db.profiles.find((p) => p.id === existingAnyOpen.cashier_id);
        return {
          data: null,
          error: {
            code: "23505",
            message: `SHIFT_OCCUPIED_BY_OTHER_CASHIER: Shift kasir aktif sedang digunakan oleh ${activeProf?.full_name || "kasir lain"}. Tutup shift tersebut terlebih dahulu.`,
          },
        };
      }
      const shiftId = nextUuid("b");
      let shiftNotes = args.p_notes || null;
      if (targetCashierId !== currentActor.id) {
        const prefix = `[Dibuka oleh Admin: ${currentActor.username}]`;
        shiftNotes = shiftNotes ? `${prefix} ${shiftNotes}` : prefix;
      }
      const shiftRow = {
        id: shiftId,
        cashier_id: targetCashierId,
        opened_at: new Date().toISOString(),
        closed_at: null,
        opening_cash: args.p_opening_cash,
        expected_cash: args.p_opening_cash,
        actual_cash: null,
        cash_difference: null,
        status: "open",
        notes: shiftNotes,
      };
      db.shifts.push(shiftRow);
      db.cash_movements.push({
        id: nextUuid("c"),
        shift_id: shiftId,
        movement_type: "opening_cash",
        amount: args.p_opening_cash,
        balance_before: 0,
        balance_after: args.p_opening_cash,
        reason: "Modal kas awal shift kasir",
        created_by: currentActor.id,
        created_at: new Date().toISOString(),
      });
      return { data: shiftRow, error: null };
    }

    if (fnName === "close_shift_atomic") {
      const shift = db.shifts.find((s) => s.id === args.p_shift_id);
      if (!shift) {
        return { data: null, error: { message: "Shift tidak ditemukan." } };
      }
      if (shift.status !== "open") {
        return {
          data: null,
          error: { message: `Shift sudah ditutup sebelumnya pada ${shift.closed_at}.` },
        };
      }
      if (currentActor.role === "kasir" && shift.cashier_id !== currentActor.id) {
        return {
          data: null,
          error: { message: "Kasir tidak berhak menutup shift milik kasir lain." },
        };
      }
      const diff = args.p_actual_cash - shift.expected_cash;
      shift.status = "closed";
      shift.closed_at = new Date().toISOString();
      shift.actual_cash = args.p_actual_cash;
      shift.cash_difference = diff;
      if (args.p_notes) shift.notes = args.p_notes;
      db.cash_movements.push({
        id: nextUuid("c"),
        shift_id: shift.id,
        movement_type: "closing_reconciliation",
        amount: args.p_actual_cash,
        balance_before: shift.expected_cash,
        balance_after: args.p_actual_cash,
        reason: diff === 0 ? "Penutupan shift: Kas seimbang (Pas)" : `Selisih ${diff}`,
        created_by: currentActor.id,
        created_at: new Date().toISOString(),
      });
      return { data: { ...shift }, error: null };
    }

    if (fnName === "record_cash_movement_atomic") {
      if (args.p_shift_id) {
        const shift = db.shifts.find((s) => s.id === args.p_shift_id);
        if (!shift) return { data: null, error: { message: "Shift tidak ditemukan." } };
        if (shift.status !== "open") {
          return {
            data: null,
            error: { message: "Tidak dapat mencatat mutasi kas pada shift yang sudah ditutup." },
          };
        }
        if (currentActor.role === "kasir" && shift.cashier_id !== currentActor.id) {
          return {
            data: null,
            error: { message: "Kasir tidak dapat mencatat mutasi pada shift kasir lain." },
          };
        }
        const before = shift.expected_cash;
        const after = args.p_movement_type === "cash_out" ? before - args.p_amount : before + args.p_amount;
        if (after < 0) return { data: null, error: { message: "Saldo kas shift tidak mencukupi." } };
        shift.expected_cash = after;
        const mov = {
          id: nextUuid("c"),
          shift_id: shift.id,
          movement_type: args.p_movement_type,
          amount: args.p_amount,
          balance_before: before,
          balance_after: after,
          reason: args.p_reason,
          created_by: currentActor.id,
          created_at: new Date().toISOString(),
        };
        db.cash_movements.push(mov);
        return { data: mov, error: null };
      } else {
        if (currentActor.role !== "admin") {
          return {
            data: null,
            error: { message: "Hanya admin yang berhak mencatat mutasi kas di luar shift." },
          };
        }
        return { data: { shift_id: null }, error: null };
      }
    }

    if (fnName === "create_pos_order_atomic") {
      db.createOrderRpcCalls += 1;
      const activeShift = db.shifts.find(
        (s) => s.cashier_id === currentActor.id && s.status === "open" && s.closed_at === null,
      );
      if (!activeShift) {
        return {
          data: null,
          error: {
            message:
              "SHIFT_NOT_OPEN: Shift kasir belum dibuka atau sudah ditutup.",
          },
        };
      }
      const pOrder = args.p_order || {};
      const orderId = nextUuid("f");
      const orderNumber = `ORD-20261125-${String(db.orders.length + 1).padStart(4, "0")}`;
      let sessionId = null;
      let isAdditional = false;
      if (pOrder.order_type === "dine_in") {
        const tbl = db.dining_tables.find((t) => t.id === pOrder.table_id);
        if (!tbl) return { data: null, error: { message: "Meja tidak ditemukan." } };
        if (tbl.status === "occupied") {
          const openSess = db.dining_sessions.find(
            (s) => s.table_id === tbl.id && s.status === "open",
          );
          if (!openSess) return { data: null, error: { message: "Sesi aktif tidak ditemukan." } };
          sessionId = openSess.id;
          isAdditional = true;
        } else {
          const newSess = {
            id: nextUuid("d"),
            table_id: tbl.id,
            status: "open",
            opened_by: currentActor.id,
          };
          db.dining_sessions.push(newSess);
          sessionId = newSess.id;
        }
        tbl.status = "awaiting_payment";
      }

      const orderRow = {
        id: orderId,
        order_number: orderNumber,
        order_type: pOrder.order_type,
        table_id: pOrder.table_id || null,
        dining_session_id: sessionId,
        status: "awaiting_payment",
        payment_status: "unpaid",
        is_finalized: false,
        subtotal: pOrder.subtotal,
        discount_total: 0,
        tax_percent: pOrder.tax_percent,
        tax_total: pOrder.tax_total,
        service_charge_percent: pOrder.service_charge_percent,
        service_total: pOrder.service_total,
        grand_total: pOrder.grand_total,
        paid_total: 0,
        idempotency_key: pOrder.idempotency_key || null,
        created_by: currentActor.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      db.orders.push(orderRow);
      for (const it of args.p_items || []) {
        db.order_items.push({
          id: nextUuid("1"),
          order_id: orderId,
          product_id: it.product_id,
          product_name_snapshot: it.product_name_snapshot,
          quantity: it.quantity,
          subtotal: it.subtotal,
          line_total: it.line_total,
        });
      }
      reserveStockInMock(orderId);
      return {
        data: { id: orderId, order_number: orderNumber, is_additional_order: isAdditional, is_duplicate: false },
        error: null,
      };
    }

    if (fnName === "append_order_items_atomic") {
      db.appendOrderRpcCalls += 1;
      const activeShift = db.shifts.find(
        (s) => s.cashier_id === currentActor.id && s.status === "open" && s.closed_at === null,
      );
      if (!activeShift) {
        return {
          data: null,
          error: { message: "SHIFT_NOT_OPEN: Shift kasir belum dibuka atau sudah ditutup." },
        };
      }
      const order = db.orders.find((o) => o.id === args.p_order_id);
      if (!order) return { data: null, error: { message: "Pesanan tidak ditemukan." } };
      for (const it of args.p_items || []) {
        db.order_items.push({
          id: nextUuid("1"),
          order_id: order.id,
          product_id: it.product_id,
          product_name_snapshot: it.product_name_snapshot,
          quantity: it.quantity,
          subtotal: it.subtotal,
          line_total: it.line_total,
        });
      }
      order.subtotal += args.p_subtotal_delta;
      order.tax_total += args.p_tax_delta;
      order.service_total += args.p_service_delta;
      order.grand_total += args.p_grand_total_delta;
      reserveStockInMock(order.id);
      return { data: { order_id: order.id }, error: null };
    }

    if (fnName === "reserve_order_stock_internal") {
      const res = reserveStockInMock(args.p_order_id);
      return res.ok ? { data: null, error: null } : { data: null, error: { message: res.message } };
    }

    if (fnName === "process_pos_payment_manual") {
      db.cashPaymentRpcCalls += 1;
      const order = db.orders.find((o) => o.id === args.p_order_id);
      if (!order) return { data: null, error: { message: "Pesanan tidak ditemukan." } };

      let shiftId = null;
      if (args.p_payment_source === "cash") {
        const activeShift = db.shifts.find(
          (s) => s.cashier_id === currentActor.id && s.status === "open",
        );
        if (!activeShift) {
          return {
            data: null,
            error: {
              message:
                "Kasir belum membuka shift kasir. Buka shift terlebih dahulu sebelum memproses pembayaran tunai.",
            },
          };
        }
        shiftId = activeShift.id;
        const before = activeShift.expected_cash;
        activeShift.expected_cash += args.p_amount;
        db.cash_movements.push({
          id: nextUuid("c"),
          shift_id: shiftId,
          movement_type: "cash_sale",
          amount: args.p_amount,
          balance_before: before,
          balance_after: activeShift.expected_cash,
          reason: `Penjualan tunai pesanan ${order.order_number}`,
          order_id: order.id,
          created_by: currentActor.id,
          created_at: new Date().toISOString(),
        });
      }

      const paymentId = nextUuid("p");
      order.paid_total += args.p_amount;
      const settled = order.paid_total >= order.grand_total;
      if (settled) {
        order.status = "paid";
        order.payment_status = "paid";
        order.queue_number = "A001";
        order.kds_status = "queued";
      }
      db.payments.push({
        id: paymentId,
        order_id: order.id,
        payment_method: args.p_payment_method,
        payment_source: args.p_payment_source,
        amount: args.p_amount,
        payment_status: "success",
        shift_id: shiftId,
        created_by: currentActor.id,
        created_at: new Date().toISOString(),
      });
      return {
        data: {
          payment_id: paymentId,
          order_id: order.id,
          order_number: order.order_number,
          amount: args.p_amount,
          paid_total: order.paid_total,
          grand_total: order.grand_total,
          is_settled: settled,
          queue_number: settled ? order.queue_number : null,
          shift_id: shiftId,
          idempotent_replay: false,
        },
        error: null,
      };
    }

    return { data: null, error: { message: `Unhandled rpc ${fnName}` } };
  },
};

const supabaseAdminMock = {
  from: (tableName) => makeQuery(tableName, true),
  rpc: supabaseMock.rpc,
};

const moduleMocks = {
  "server-only": {},
  "next/cache": { revalidatePath: () => {} },
  "@/lib/auth/audit": {
    logAudit: async (entry) => {
      db.audit_logs.push(entry);
    },
  },
  "@/lib/auth/session": {
    getCashierActor: async () => {
      if (!["admin", "kasir"].includes(currentActor.role)) {
        return { ok: false, message: "Hanya admin dan kasir yang dapat melakukan tindakan ini." };
      }
      return {
        ok: true,
        session: {
          status: "authenticated",
          user: { id: currentActor.id },
          profile: { ...currentActor },
        },
      };
    },
    getAdminActor: async () => {
      if (currentActor.role !== "admin") {
        return { ok: false, message: "Hanya admin yang dapat melakukan tindakan ini." };
      }
      return {
        ok: true,
        session: {
          status: "authenticated",
          user: { id: currentActor.id },
          profile: { ...currentActor },
        },
      };
    },
  },
  "@/lib/supabase/admin": {
    createSupabaseAdminClient: () => supabaseAdminMock,
  },
  "@/lib/supabase/server": {
    createSupabaseServerClient: async () => supabaseMock,
  },
  "@/lib/midtrans/reconcile": {
    reconcileActiveMidtransPayment: async ({ orderId }) => {
      const order = db.orders.find((o) => o.id === orderId);
      const tx = db.midtrans_transactions.find((t) => t.order_id === orderId);
      if (order && tx) {
        tx.lifecycle_status = "settlement";
        order.paid_total = order.grand_total;
        order.payment_status = "paid";
        order.status = "paid";
        order.queue_number = "A007";
        order.kds_status = "queued";
      }
      return {
        ok: true,
        isSettled: true,
        midtransStatus: "settlement",
        reservationReleased: false,
        message: "Pembayaran Midtrans terkonfirmasi settlement.",
      };
    },
    verifyAndReleaseGatewayBeforeOrderCancel: async () => ({
      ok: true,
      isPaid: false,
    }),
  },
  "@/lib/midtrans/service": {
    createSnapPayment: async (params) => {
      db.createSnapCalls += 1;
      const mid = `${params.orderNumber}-A1`;
      const tx = {
        id: nextUuid("2"),
        order_id: params.orderId,
        midtrans_order_id: mid,
        gross_amount: params.grossAmount,
        lifecycle_status: "token_created",
        snap_token: "mock-snap-token-123",
        payment_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        created_at: new Date().toISOString(),
      };
      db.midtrans_transactions.push(tx);
      db.order_allocations.push({
        id: nextUuid("3"),
        order_id: params.orderId,
        midtrans_transaction_id: tx.id,
        allocation_status: "reserved",
        allocated_final_amount: params.grossAmount,
      });
      return {
        ok: true,
        snapToken: tx.snap_token,
        midtransOrderId: mid,
        redirectUrl: "https://app.sandbox.midtrans.com/snap/v2/vtweb/mock",
      };
    },
  },
};

const canonicalPathMocks = new Map();
for (const [specifier] of Object.entries(moduleMocks)) {
  if (specifier.startsWith("@/")) {
    const resolved = path.normalize(path.join(ROOT, "src", specifier.slice(2) + ".ts"));
    canonicalPathMocks.set(resolved, specifier);
  }
}

const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (Object.prototype.hasOwnProperty.call(moduleMocks, request)) return request;
  if (request.startsWith("@/")) {
    const base = path.join(ROOT, "src", request.slice(2));
    for (const candidate of [base + ".ts", base + ".tsx", path.join(base, "index.ts")]) {
      const normalized = path.normalize(candidate);
      if (fs.existsSync(normalized)) return normalized;
    }
  }
  if (request.startsWith(".") && parent && (parent.filename.endsWith(".ts") || parent.filename.endsWith(".tsx"))) {
    const base = path.resolve(path.dirname(parent.filename), request);
    for (const candidate of [base + ".ts", base + ".tsx", path.join(base, "index.ts")]) {
      const normalized = path.normalize(candidate);
      if (fs.existsSync(normalized)) return normalized;
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(moduleMocks, request)) {
    return moduleMocks[request];
  }
  const resolved = Module._resolveFilename(request, parent, isMain);
  const mockKey = canonicalPathMocks.get(path.normalize(resolved));
  if (mockKey && Object.prototype.hasOwnProperty.call(moduleMocks, mockKey)) {
    return moduleMocks[mockKey];
  }
  return originalLoad.call(this, request, parent, isMain);
};

Module._extensions[".ts"] = function (mod, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  return mod._compile(outputText, filename);
};

const require = Module.createRequire(import.meta.url);
const ordersActions = require(path.join(ROOT, "src/lib/orders/actions.ts"));
const shiftsActions = require(path.join(ROOT, "src/lib/shifts/actions.ts"));
const paymentsActions = require(path.join(ROOT, "src/lib/payments/actions.ts"));

let total = 0;
let passed = 0;

async function testCase(title, fn) {
  total += 1;
  resetDb();
  await fn();
  console.log(`PASS #${String(total).padStart(2, "0")}: ${title}`);
  passed += 1;
}

// 1. UI Lock & Notification when Shift Not Open
await testCase("1. Kasir tanpa shift aktif diblokir di UI (/pos, ProductCatalog, CartPanel)", async () => {
  const posPage = fs.readFileSync(path.join(ROOT, "src/app/(app)/pos/page.tsx"), "utf8");
  const posContainer = fs.readFileSync(path.join(ROOT, "src/components/pos/pos-container.tsx"), "utf8");
  const catalog = fs.readFileSync(path.join(ROOT, "src/components/pos/product-catalog.tsx"), "utf8");
  const cartPanel = fs.readFileSync(path.join(ROOT, "src/components/pos/cart-panel.tsx"), "utf8");

  assert.match(posPage, /Shift Kasir Belum Dibuka/);
  assert.match(posPage, /Buka Shift Sekarang/);
  assert.match(posPage, /href="\/pos\/shift"/);
  assert.match(posPage, /sebelum memilih produk, membuat pesanan/);
  assert.match(posContainer, /hasActiveShift\s*=\s*Boolean\(activeShift && activeShift\.status === "open"\)/);
  assert.match(posContainer, /disabledByShift=\{!hasActiveShift\}/);
  assert.match(posContainer, /hasActiveShift=\{hasActiveShift\}/);
  assert.match(catalog, /disabled=\{!isClickable\}/);
  assert.match(catalog, /Pemilihan menu dikunci sampai shift kasir dibuka/);
  assert.match(cartPanel, /canSubmit\s*=\s*hasActiveShift\s*&&/);
  assert.match(cartPanel, /Buka Shift Terlebih Dahulu/);
  assert.match(cartPanel, /disabled=\{!canSubmit\}/);
});

// 2. Direct Server Action Call without Active Shift Rejected
await testCase("2. Kasir tanpa shift aktif memanggil Server Action createPosOrderAction langsung (takeaway & dine_in) -> DITOLAK", async () => {
  const res = await ordersActions.createPosOrderAction({
    orderType: "takeaway",
    idempotencyKey: "idem-no-shift-0001",
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });

  assert.equal(res.ok, false);
  assert.equal(res.errorCode, "SHIFT_NOT_OPEN");
  assert.match(res.message, /Shift kasir belum dibuka/i);

  const dineInRes = await ordersActions.createPosOrderAction({
    orderType: "dine_in",
    tableId: TABLE_1,
    idempotencyKey: "idem-no-shift-dinein-0001",
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });

  assert.equal(dineInRes.ok, false);
  assert.equal(dineInRes.errorCode, "SHIFT_NOT_OPEN");
  assert.equal(db.createOrderRpcCalls, 0);
});

// 3. Additional Order & Append Items without Active Shift Rejected
await testCase("3. Kasir tanpa shift aktif mencoba pesanan tambahan (occupied table) & appendOrderItemsAction -> DITOLAK", async () => {
  db.orders.push({
    id: EXISTING_ORDER_1,
    order_number: "ORD-20261125-0001",
    order_type: "dine_in",
    table_id: TABLE_OCCUPIED,
    dining_session_id: "session-occupied-1",
    status: "awaiting_payment",
    payment_status: "unpaid",
    is_finalized: false,
    subtotal: 28000,
    discount_total: 0,
    tax_percent: 10,
    tax_total: 2800,
    service_charge_percent: 5,
    service_total: 1400,
    grand_total: 32200,
    paid_total: 0,
  });

  const additionalRes = await ordersActions.createPosOrderAction({
    orderType: "dine_in",
    tableId: TABLE_OCCUPIED,
    idempotencyKey: "idem-add-no-shift-0001",
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(additionalRes.ok, false);
  assert.equal(additionalRes.errorCode, "SHIFT_NOT_OPEN");

  const appendViaCreateRes = await ordersActions.createPosOrderAction({
    orderType: "dine_in",
    tableId: TABLE_OCCUPIED,
    existingOrderId: EXISTING_ORDER_1,
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(appendViaCreateRes.ok, false);
  assert.equal(appendViaCreateRes.errorCode, "SHIFT_NOT_OPEN");

  const directAppendRes = await ordersActions.appendOrderItemsAction({
    orderId: EXISTING_ORDER_1,
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(directAppendRes.ok, false);
  assert.equal(directAppendRes.errorCode, "SHIFT_NOT_OPEN");
  assert.equal(db.appendOrderRpcCalls, 0);
});

// 4. Kasir Opens Shift -> New Order, Additional Order, Cash In/Out, Detail & Reconciliation Succeed
await testCase("4. Kasir membuka shift -> pembuatan pesanan, kas masuk/keluar, detail shift & tutup rekonsiliasi BERHASIL", async () => {
  const openRes = await shiftsActions.openShiftAction({ openingCash: 250000 });
  assert.equal(openRes.ok, true, openRes.message);
  const shiftId = openRes.data.id;

  const orderRes = await ordersActions.createPosOrderAction({
    orderType: "dine_in",
    tableId: TABLE_1,
    idempotencyKey: "idem-open-shift-0001",
    items: [{ productId: PRODUCT_1, quantity: 2 }],
  });
  assert.equal(orderRes.ok, true, orderRes.message);
  assert.equal(db.orders.length, 1);
  assert.equal(db.ingredient_reservations.length, 1);
  assert.equal(db.audit_logs.at(-1).details.shift_id, shiftId);

  const appendRes = await ordersActions.appendOrderItemsAction({
    orderId: orderRes.data.id,
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(appendRes.ok, true, appendRes.message);
  assert.equal(db.audit_logs.at(-1).details.shift_id, shiftId);

  // Kasir mencatat kas masuk & kas keluar pada shift miliknya
  const cashInRes = await shiftsActions.recordCashMovementAction({
    shiftId,
    movementType: "cash_in",
    amount: 50000,
    reason: "Tambah uang kembalian pecahan kecil",
  });
  assert.equal(cashInRes.ok, true, cashInRes.message);

  const cashOutRes = await shiftsActions.recordCashMovementAction({
    shiftId,
    movementType: "cash_out",
    amount: 20000,
    reason: "Beli es batu operasional",
  });
  assert.equal(cashOutRes.ok, true, cashOutRes.message);

  const summaryRes = await shiftsActions.getShiftSummaryAction(shiftId);
  assert.equal(summaryRes.ok, true, summaryRes.message);
  assert.equal(summaryRes.data.shift.expected_cash, 280000);

  const movementsRes = await shiftsActions.getCashMovementsAction(shiftId);
  assert.equal(movementsRes.ok, true, movementsRes.message);
  assert.equal(movementsRes.data.length, 3); // opening_cash, cash_in, cash_out

  // Kasir menutup shift dengan rekonsiliasi fisik (selisih +5000 dengan catatan)
  const closeRes = await shiftsActions.closeShiftAction({
    shiftId,
    actualCash: 285000,
    notes: "Kelebihan uang receh Rp 5.000",
  });
  assert.equal(closeRes.ok, true, closeRes.message);
  assert.equal(closeRes.data.status, "closed");
  assert.equal(closeRes.data.actual_cash, 285000);
  assert.equal(closeRes.data.cash_difference, 5000);
});

// 5. Kasir Closes Shift -> Next Order Rejected -> Opens New Shift -> Orders Succeed Again
await testCase("5. Kasir menutup shift -> pesanan DITOLAK; membuka shift baru (#2) -> pesanan kembali BERHASIL", async () => {
  const openRes = await shiftsActions.openShiftAction({ openingCash: 200000 });
  assert.equal(openRes.ok, true);

  const firstOrder = await ordersActions.createPosOrderAction({
    orderType: "takeaway",
    idempotencyKey: "idem-before-close-0001",
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(firstOrder.ok, true);

  const closeRes = await shiftsActions.closeShiftAction({
    shiftId: openRes.data.id,
    actualCash: 200000,
    notes: "Selesai shift",
  });
  assert.equal(closeRes.ok, true, closeRes.message);
  assert.equal(db.shifts[0].status, "closed");

  const orderAfterClose = await ordersActions.createPosOrderAction({
    orderType: "takeaway",
    idempotencyKey: "idem-after-close-0001",
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(orderAfterClose.ok, false);
  assert.equal(orderAfterClose.errorCode, "SHIFT_NOT_OPEN");

  const appendAfterClose = await ordersActions.appendOrderItemsAction({
    orderId: firstOrder.data.id,
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(appendAfterClose.ok, false);
  assert.equal(appendAfterClose.errorCode, "SHIFT_NOT_OPEN");

  // Buka shift baru (#2) -> pembuatan pesanan harus kembali berhasil
  const reopenRes = await shiftsActions.openShiftAction({ openingCash: 300000 });
  assert.equal(reopenRes.ok, true, reopenRes.message);
  assert.notEqual(reopenRes.data.id, openRes.data.id);

  const orderInNewShift = await ordersActions.createPosOrderAction({
    orderType: "takeaway",
    idempotencyKey: "idem-new-shift-0002",
    items: [{ productId: PRODUCT_1, quantity: 2 }],
  });
  assert.equal(orderInNewShift.ok, true, orderInNewShift.message);
  assert.equal(db.audit_logs.at(-1).details.shift_id, reopenRes.data.id);
});

// 6. Cash Payment without Active Shift Rejected
await testCase("6. Kasir mencoba membayar tunai tanpa shift aktif -> DITOLAK", async () => {
  db.orders.push({
    id: EXISTING_ORDER_1,
    order_number: "ORD-20261125-0002",
    order_type: "takeaway",
    status: "awaiting_payment",
    payment_status: "unpaid",
    is_finalized: true,
    grand_total: 32200,
    paid_total: 0,
  });
  db.ingredient_reservations.push({
    id: "res-existing-1",
    order_id: EXISTING_ORDER_1,
    ingredient_id: INGREDIENT_1,
    quantity: 100,
    status: "active",
  });

  const payRes = await paymentsActions.processPosManualPaymentAction({
    orderId: EXISTING_ORDER_1,
    paymentMethod: "cash",
    paymentSource: "cash",
    amount: 32200,
    cashReceived: 50000,
    changeAmount: 17800,
    idempotencyKey: "pay-cash-no-shift-0001",
  });
  assert.equal(payRes.ok, false);
  assert.match(payRes.message, /shift/i);
  assert.equal(db.orders[0].payment_status, "unpaid");
});

// 7. Cash Payment with Active Shift Succeeds & Follows Cashier's Shift
await testCase("7. Kasir dengan shift aktif dapat membayar tunai & transaksi mengikuti shift aktifnya", async () => {
  const openRes = await shiftsActions.openShiftAction({ openingCash: 300000 });
  assert.equal(openRes.ok, true);

  const orderRes = await ordersActions.createPosOrderAction({
    orderType: "takeaway",
    idempotencyKey: "idem-cash-with-shift-0001",
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(orderRes.ok, true);
  const createdOrder = db.orders.find((o) => o.id === orderRes.data.id);
  createdOrder.is_finalized = true;

  const payRes = await paymentsActions.processPosManualPaymentAction({
    orderId: createdOrder.id,
    paymentMethod: "cash",
    paymentSource: "cash",
    amount: createdOrder.grand_total,
    cashReceived: 50000,
    changeAmount: 50000 - createdOrder.grand_total,
    idempotencyKey: "pay-cash-with-shift-0001",
  });
  assert.equal(payRes.ok, true, payRes.message);
  assert.equal(payRes.data.shift_id, openRes.data.id);
  assert.equal(db.payments[0].shift_id, openRes.data.id);
  assert.equal(db.shifts[0].expected_cash, 300000 + createdOrder.grand_total);
});

// 8. Midtrans Flow Remains Functional & Separated from Shift Requirement
await testCase("8. Pembayaran Midtrans tetap berjalan tanpa shift aktif (aturan order & payment terpisah)", async () => {
  const openRes = await shiftsActions.openShiftAction({ openingCash: 100000 });
  const orderRes = await ordersActions.createPosOrderAction({
    orderType: "takeaway",
    idempotencyKey: "idem-midtrans-separate-0001",
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(orderRes.ok, true);
  db.orders[0].is_finalized = true;

  // Close shift before customer completes Midtrans payment
  await shiftsActions.closeShiftAction({
    shiftId: openRes.data.id,
    actualCash: 100000,
  });

  const snapRes = await paymentsActions.createPosMidtransSnapAction({
    orderId: orderRes.data.id,
    grossAmount: db.orders[0].grand_total,
    idempotencyKey: "snap-after-close-0001",
    isSplitBill: false,
  });
  assert.equal(snapRes.ok, true, snapRes.message);
  assert.equal(db.createSnapCalls, 1);

  // Midtrans settlement pada pesanan lama tetap bisa diselesaikan meski shift kasir sudah ditutup
  const settleRes = await paymentsActions.getOrderPaymentStatusAction(orderRes.data.id);
  assert.equal(settleRes.ok, true, settleRes.message);
  assert.equal(settleRes.data.isSettled, true);
  assert.equal(settleRes.data.status, "paid");
  assert.equal(settleRes.data.paymentStatus, "paid");
  assert.equal(db.orders[0].kds_status, "queued");
});

// 9 & 10. Admin Can Still Open & Close Shift (Self + Another Cashier)
await testCase("9 & 10. Admin tetap bisa membuka dan menutup shift (milik sendiri maupun milik kasir lain)", async () => {
  currentActor = { ...db.profiles.find((p) => p.id === USER_ADMIN_1) };

  // Admin membuka shift untuk Kasir 1
  const openKasirShift = await shiftsActions.openShiftAction({
    cashierId: USER_KASIR_1,
    openingCash: 250000,
    notes: "Shift pagi disiapkan Admin",
  });
  assert.equal(openKasirShift.ok, true, openKasirShift.message);
  assert.equal(openKasirShift.data.cashier_id, USER_KASIR_1);
  assert.match(openKasirShift.data.notes, /\[Dibuka oleh Admin: admin1\]/);

  // Aturan Single Global Active Shift: Admin tidak boleh membuka shift kedua saat shift Kasir 1 masih open
  const blockedSecondShift = await shiftsActions.openShiftAction({
    openingCash: 150000,
    notes: "Shift Admin ganda",
  });
  assert.equal(blockedSecondShift.ok, false);
  assert.match(blockedSecondShift.message, /sedang digunakan oleh/i);

  // Admin menutup shift Kasir 1 terlebih dahulu
  const closeKasirShift = await shiftsActions.closeShiftAction({
    shiftId: openKasirShift.data.id,
    actualCash: 250000,
    notes: "Ditutup oleh admin",
  });
  assert.equal(closeKasirShift.ok, true, closeKasirShift.message);
  assert.equal(closeKasirShift.data.status, "closed");

  // Setelah shift sebelumnya ditutup, Admin bisa membuka shift baru (milik Admin)
  const openAdminOwnShift = await shiftsActions.openShiftAction({
    openingCash: 150000,
    notes: "Shift Admin",
  });
  assert.equal(openAdminOwnShift.ok, true, openAdminOwnShift.message);
  assert.equal(openAdminOwnShift.data.cashier_id, USER_ADMIN_1);

  // Admin menutup shift miliknya sendiri
  const closeAdminOwnShift = await shiftsActions.closeShiftAction({
    shiftId: openAdminOwnShift.data.id,
    actualCash: 150000,
  });
  assert.equal(closeAdminOwnShift.ok, true, closeAdminOwnShift.message);
  assert.equal(closeAdminOwnShift.data.status, "closed");

  // Admin tetap dapat memantau riwayat semua shift seluruh kasir
  const historyRes = await shiftsActions.getShiftHistoryAction();
  assert.equal(historyRes.ok, true, historyRes.message);
  assert.equal(historyRes.data.length, 2);

  // Admin /admin/shifts UI also supports closing active cashier shift
  const adminManagerSrc = fs.readFileSync(
    path.join(ROOT, "src/components/admin/shifts/admin-shift-manager.tsx"),
    "utf8",
  );
  assert.match(adminManagerSrc, /closeShiftAction/);
  assert.match(adminManagerSrc, /Tutup Shift Kasir \(Admin\)/);
});

// 11. Admin Still Accesses Shift Pages
await testCase("11. Admin tetap bisa mengakses halaman Kelola Shift (/admin/shifts & /pos/shift)", async () => {
  const adminShiftPage = fs.readFileSync(path.join(ROOT, "src/app/(app)/admin/shifts/page.tsx"), "utf8");
  const posShiftPage = fs.readFileSync(path.join(ROOT, "src/app/(app)/pos/shift/page.tsx"), "utf8");
  assert.match(adminShiftPage, /requireRole\(\["admin"\]\)/);
  assert.match(adminShiftPage, /AdminShiftManager/);
  assert.match(posShiftPage, /requireRole\(\["admin", "kasir"\]\)/);
});

// 12. Kasir Cannot Access Admin-Only Shift Functions
await testCase("12. Kasir tidak bisa mengakses fungsi administrasi yang hanya boleh digunakan Admin", async () => {
  currentActor = { ...db.profiles.find((p) => p.id === USER_ADMIN_1) };
  const adminOpenedForK2 = await shiftsActions.openShiftAction({
    cashierId: USER_KASIR_2,
    openingCash: 400000,
  });
  assert.equal(adminOpenedForK2.ok, true);

  currentActor = { ...db.profiles.find((p) => p.id === USER_KASIR_1) };

  const tryOpenK2 = await shiftsActions.openShiftAction({
    cashierId: USER_KASIR_2,
    openingCash: 100000,
  });
  assert.equal(tryOpenK2.ok, false);

  const tryCloseK2 = await shiftsActions.closeShiftAction({
    shiftId: adminOpenedForK2.data.id,
    actualCash: 400000,
  });
  assert.equal(tryCloseK2.ok, false);

  const trySummaryK2 = await shiftsActions.getShiftSummaryAction(adminOpenedForK2.data.id);
  assert.equal(trySummaryK2.ok, false);

  const tryMovementsK2 = await shiftsActions.getCashMovementsAction(adminOpenedForK2.data.id);
  assert.equal(tryMovementsK2.ok, false);

  const tryMoveK2 = await shiftsActions.recordCashMovementAction({
    shiftId: adminOpenedForK2.data.id,
    movementType: "cash_in",
    amount: 50000,
    reason: "Akses ilegal kasir",
  });
  assert.equal(tryMoveK2.ok, false);

  const tryActiveK2 = await shiftsActions.getActiveShiftAction(USER_KASIR_2);
  assert.equal(tryActiveK2.ok, false);

  const adminShiftPage = fs.readFileSync(path.join(ROOT, "src/app/(app)/admin/shifts/page.tsx"), "utf8");
  assert.doesNotMatch(adminShiftPage, /requireRole\(.*"kasir".*\)/);
});

// 13. Closed Shift Is Immutable via Direct Server Action Calls
await testCase("13. Shift yang sudah ditutup tidak bisa dimodifikasi melalui Server Action langsung", async () => {
  const openRes = await shiftsActions.openShiftAction({ openingCash: 200000 });
  const closeRes = await shiftsActions.closeShiftAction({
    shiftId: openRes.data.id,
    actualCash: 200000,
  });
  assert.equal(closeRes.ok, true);

  const reCloseRes = await shiftsActions.closeShiftAction({
    shiftId: openRes.data.id,
    actualCash: 999999,
    notes: "Coba ubah shift tutup",
  });
  assert.equal(reCloseRes.ok, false);

  const moveOnClosedRes = await shiftsActions.recordCashMovementAction({
    shiftId: openRes.data.id,
    movementType: "cash_in",
    amount: 50000,
    reason: "Mutasi ilegal setelah tutup",
  });
  assert.equal(moveOnClosedRes.ok, false);
  assert.equal(db.shifts[0].actual_cash, 200000);
  assert.equal(db.shifts[0].expected_cash, 200000);
});

// 14. Failed Shift Validation Produces ZERO Orders, Sessions, Reservations, or Allocations
await testCase("14. Kegagalan validasi shift tidak menghasilkan order, dining session, alokasi, atau reservasi stok (+ SQL triggers check)", async () => {
  // Tanpa shift aktif:
  const res1 = await ordersActions.createPosOrderAction({
    orderType: "dine_in",
    tableId: TABLE_1,
    idempotencyKey: "idem-zero-artifacts-0001",
    items: [{ productId: PRODUCT_1, quantity: 3 }],
  });
  assert.equal(res1.ok, false);
  assert.equal(db.orders.length, 0);
  assert.equal(db.order_items.length, 0);
  assert.equal(db.ingredient_reservations.length, 0);
  assert.equal(db.order_allocations.length, 0);
  assert.equal(db.dining_sessions.length, 1); // only pre-seeded TABLE_OCCUPIED session
  assert.equal(db.dining_tables[0].status, "empty");
  assert.equal(db.ingredients[0].reserved_stock, 0);

  // Setelah shift ditutup:
  const openRes = await shiftsActions.openShiftAction({ openingCash: 100000 });
  await shiftsActions.closeShiftAction({ shiftId: openRes.data.id, actualCash: 100000 });

  const res2 = await ordersActions.createPosOrderAction({
    orderType: "dine_in",
    tableId: TABLE_1,
    idempotencyKey: "idem-zero-artifacts-0002",
    items: [{ productId: PRODUCT_1, quantity: 3 }],
  });
  assert.equal(res2.ok, false);
  assert.equal(db.orders.length, 0);
  assert.equal(db.order_items.length, 0);
  assert.equal(db.ingredient_reservations.length, 0);
  assert.equal(db.order_allocations.length, 0);
  assert.equal(db.ingredients[0].reserved_stock, 0);

  // Verifikasi SQL migration trigger hardening tersedia & non-invasif ke Midtrans/service_role
  const migrationSql = fs.readFileSync(
    path.join(ROOT, "supabase/migrations/20261125000100_require_active_shift_for_pos_orders.sql"),
    "utf8",
  );
  assert.match(migrationSql, /assert_active_cashier_shift_for_order_mutation/);
  assert.match(migrationSql, /trg_dining_sessions_require_active_shift/);
  assert.match(migrationSql, /trg_orders_require_active_shift/);
  assert.match(migrationSql, /trg_order_items_require_active_shift/);
  assert.match(migrationSql, /status = 'open'/);
  assert.match(migrationSql, /if v_actor_id is null then\s*return new;/);
});

// 15. Spoofed shift_id / shiftId Owned by Another Cashier Rejected Across Orders & Payments
await testCase("15. Kasir mencoba mengirim shift_id/shiftId milik kasir lain -> DITOLAK di server & tidak dipercaya", async () => {
  // Admin membuka shift milik Kasir 2
  currentActor = { ...db.profiles.find((p) => p.id === USER_ADMIN_1) };
  const shiftK2Res = await shiftsActions.openShiftAction({
    cashierId: USER_KASIR_2,
    openingCash: 400000,
  });
  assert.equal(shiftK2Res.ok, true, shiftK2Res.message);
  const shiftK2Id = shiftK2Res.data.id;

  // Kasir 1 tanpa shift aktif mencoba meminjam shift_id milik Kasir 2 -> DITOLAK
  currentActor = { ...db.profiles.find((p) => p.id === USER_KASIR_1) };
  const spoofNoOwnShift = await ordersActions.createPosOrderAction({
    orderType: "takeaway",
    shift_id: shiftK2Id,
    idempotencyKey: "idem-spoof-no-own-0001",
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(spoofNoOwnShift.ok, false);
  assert.equal(spoofNoOwnShift.errorCode, "SHIFT_NOT_OPEN");
  assert.equal(db.createOrderRpcCalls, 0);

  // Kasir 1 tanpa shift aktif mencoba membuka shift bersamaan saat Kasir 2 aktif -> DITOLAK oleh single global active shift
  const blockedConcurrentK1 = await shiftsActions.openShiftAction({ openingCash: 250000 });
  assert.equal(blockedConcurrentK1.ok, false);
  assert.match(blockedConcurrentK1.message, /sedang digunakan oleh/i);

  // Admin menutup shift Kasir 2 terlebih dahulu sebelum Kasir 1 dapat membuka shift miliknya
  currentActor = { ...db.profiles.find((p) => p.id === USER_ADMIN_1) };
  const closeK2BeforeK1 = await shiftsActions.closeShiftAction({
    shiftId: shiftK2Id,
    actualCash: 400000,
  });
  assert.equal(closeK2BeforeK1.ok, true, closeK2BeforeK1.message);

  // Kasir 1 membuka shift miliknya sendiri setelah shift Kasir 2 ditutup, lalu mencoba spoofing shift_id/shiftId Kasir 2 -> TETAP DITOLAK
  currentActor = { ...db.profiles.find((p) => p.id === USER_KASIR_1) };
  const shiftK1Res = await shiftsActions.openShiftAction({ openingCash: 250000 });
  assert.equal(shiftK1Res.ok, true, shiftK1Res.message);
  const shiftK1Id = shiftK1Res.data.id;

  const spoofWithOwnShiftSnake = await ordersActions.createPosOrderAction({
    orderType: "takeaway",
    shift_id: shiftK2Id,
    idempotencyKey: "idem-spoof-snake-0001",
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(spoofWithOwnShiftSnake.ok, false);
  assert.equal(spoofWithOwnShiftSnake.errorCode, "SHIFT_OWNERSHIP_MISMATCH");
  assert.equal(db.orders.length, 0);

  const spoofWithOwnShiftCamel = await ordersActions.createPosOrderAction({
    orderType: "takeaway",
    shiftId: shiftK2Id,
    idempotencyKey: "idem-spoof-camel-0001",
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(spoofWithOwnShiftCamel.ok, false);
  assert.equal(spoofWithOwnShiftCamel.errorCode, "SHIFT_OWNERSHIP_MISMATCH");

  const spoofInvalidFormat = await ordersActions.createPosOrderAction({
    orderType: "takeaway",
    shift_id: "shift-palsu-bukan-uuid",
    idempotencyKey: "idem-spoof-invalid-0001",
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(spoofInvalidFormat.ok, false);
  assert.equal(spoofInvalidFormat.errorCode, "SHIFT_OWNERSHIP_MISMATCH");
  assert.equal(db.createOrderRpcCalls, 0);

  // Pesanan sah milik Kasir 1 dengan shiftId miliknya sendiri BERHASIL
  const validOrderRes = await ordersActions.createPosOrderAction({
    orderType: "takeaway",
    shiftId: shiftK1Id,
    idempotencyKey: "idem-valid-own-shift-0001",
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(validOrderRes.ok, true, validOrderRes.message);
  const createdOrder = db.orders[0];
  createdOrder.is_finalized = true;

  // appendOrderItemsAction dengan spoofed shift_id Kasir 2 DITOLAK
  const spoofAppend = await ordersActions.appendOrderItemsAction({
    orderId: createdOrder.id,
    shift_id: shiftK2Id,
    items: [{ productId: PRODUCT_1, quantity: 1 }],
  });
  assert.equal(spoofAppend.ok, false);
  assert.equal(spoofAppend.errorCode, "SHIFT_OWNERSHIP_MISMATCH");
  assert.equal(db.appendOrderRpcCalls, 0);

  // Pembayaran tunai & manual QRIS dengan spoofed shift_id Kasir 2 DITOLAK
  const spoofCashPay = await paymentsActions.processPosManualPaymentAction({
    orderId: createdOrder.id,
    shiftId: shiftK2Id,
    paymentMethod: "cash",
    paymentSource: "cash",
    amount: createdOrder.grand_total,
    cashReceived: 50000,
    changeAmount: 50000 - createdOrder.grand_total,
    idempotencyKey: "pay-spoof-cash-0001",
  });
  assert.equal(spoofCashPay.ok, false);
  assert.match(spoofCashPay.message, /bukan milik shift aktif/i);

  const spoofQrisPay = await paymentsActions.processPosManualPaymentAction({
    orderId: createdOrder.id,
    shift_id: shiftK2Id,
    paymentMethod: "qris",
    paymentSource: "qris_manual",
    amount: createdOrder.grand_total,
    referenceNumber: "QRIS-SPOOF-1",
    idempotencyKey: "pay-spoof-qris-0001",
  });
  assert.equal(spoofQrisPay.ok, false);
  assert.match(spoofQrisPay.message, /bukan milik shift aktif/i);
  assert.equal(db.cashPaymentRpcCalls, 0);
});

console.log(`\nALL ${passed}/${total} SHIFT & ORDER ENFORCEMENT TESTS PASSED 100%.`);
