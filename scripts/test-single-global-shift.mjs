#!/usr/bin/env node
/**
 * NINE LICIOUS POS — SINGLE GLOBAL ACTIVE SHIFT REGRESSION & RACE TEST SUITE
 * File: scripts/test-single-global-shift.mjs
 *
 * Memvalidasi secara deterministik aturan:
 *   "Nine Licious hanya boleh memiliki SATU shift kasir aktif secara global pada satu waktu."
 *
 * Cakupan pengujian:
 * 1. Kasir 1 buka shift -> Kasir 2 ditolak membuka shift + informasi kasir aktif akurat (non-finansial)
 * 2. Kasir 2 buka shift (setelah shift sebelumnya tutup) -> Kasir 1 ditolak membuka shift
 * 3. Cross-cashier isolation: kasir non-aktif ditolak membuat pesanan, append item, pembayaran tunai,
 *    tutup shift, mutasi kas, maupun spoofing shiftId kasir aktif
 * 4. Simulasi race condition (Promise.all): 2 kasir membuka shift bersamaan secara paralel ->
 *    hanya 1 berhasil, 1 ditolak oleh advisory lock + unique index global
 * 5. Reopen after close: setelah shift aktif ditutup sah, kasir lain langsung dapat membuka shift baru
 * 6. Admin management guard: admin tetap bisa memonitor, audit detail, menutup shift,
 *    tetap diblokir jika membuka shift ke-2 saat masih ada shift open, dan bisa membuka setelah tutup
 * 7. Audit kontrak SQL migration (20261127000100), Server Actions, UI POS/Orders/Shift/Admin, dan Realtime
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ts = await import("typescript");
const require = createRequire(import.meta.url);
const ROOT = process.cwd();

const USER_ADMIN_1 = "11111111-1111-4111-8111-111111111111";
const USER_KASIR_1 = "22222222-2222-4222-8222-222222222222";
const USER_KASIR_2 = "33333333-3333-4333-8333-333333333333";
const PRODUCT_1 = "aaaa1111-1111-4111-8111-111111111111";
const TABLE_1 = "bbbb1111-1111-4111-8111-111111111111";

let seq = 1;
function nextUuid(prefix = "9") {
  const hex = seq.toString(16).padStart(12, "0");
  seq += 1;
  return `${prefix.repeat(8)}-0000-4000-8000-${hex}`;
}

const actorStorage = new AsyncLocalStorage();
let fallbackActor = {
  id: USER_KASIR_1,
  role: "kasir",
  full_name: "Kasir Satu",
  username: "kasir1",
  is_active: true,
};

function getActor() {
  return actorStorage.getStore() || fallbackActor;
}

async function runAs(profile, fn) {
  return actorStorage.run({ ...profile }, fn);
}

const db = {
  profiles: [
    { id: USER_ADMIN_1, role: "admin", full_name: "Admin Utama", username: "admin1", is_active: true },
    { id: USER_KASIR_1, role: "kasir", full_name: "Kasir Satu", username: "kasir1", is_active: true },
    { id: USER_KASIR_2, role: "kasir", full_name: "Kasir Dua", username: "kasir2", is_active: true },
  ],
  shifts: [],
  cash_movements: [],
  orders: [],
  order_items: [],
  payments: [],
  audit_logs: [],
  dining_tables: [
    { id: TABLE_1, name: "A05", capacity: 4, status: "available", is_active: true },
  ],
  products: [
    {
      id: PRODUCT_1,
      name: "Chicken Katsu Rice",
      sku: "FD-001",
      price: 32000,
      is_active: true,
      is_available: true,
      kitchen_station: "kitchen",
    },
  ],
  modifier_groups: [],
  modifier_options: [],
  product_modifier_groups: [],
  restaurant_settings: [{ id: 1, tax_percent: 10, service_charge_percent: 5 }],
  discounts: [],
  order_discounts: [],
  dining_sessions: [],
};

// Simulasi pg_advisory_xact_lock + precheck barrier untuk menguji race condition
let raceBarrier = null;
let rpcMutex = Promise.resolve();
let forceNullAdminClient = false;

function withSerializedRpc(work) {
  const next = rpcMutex.then(work, work);
  rpcMutex = next.catch(() => {});
  return next;
}

function resetDb() {
  seq = 1;
  db.shifts = [];
  db.cash_movements = [];
  db.orders = [];
  db.order_items = [];
  db.payments = [];
  db.audit_logs = [];
  db.dining_tables[0].status = "available";
  raceBarrier = null;
}

function makeQuery(tableName, bypassRls = false) {
  const actor = getActor();
  const filters = [];
  let op = "select";
  let selectOpts = {};
  let updatePatch = null;
  let insertPayload = null;
  const orderBys = [];
  let limitCount = null;
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

  async function execute() {
    // Saat simulasi race condition aktif pada precheck tabel shifts (bypassRls), tahan dua eksekusi
    // agar keduanya lolos SELECT precheck aplikasi secara bersamaan dan bentrok di lock RPC/index DB.
    if (
      raceBarrier &&
      tableName === "shifts" &&
      op === "select" &&
      bypassRls &&
      filters.some((f) => f.type === "eq" && f.col === "status" && f.val === "open") &&
      filters.length === 1
    ) {
      await raceBarrier();
    }

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
        inserted.push({ ...created });
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
    // Simulasi RLS shifts_select_policy: kasir hanya melihat miliknya sendiri via client session
    if (!bypassRls && tableName === "shifts" && actor.role !== "admin") {
      rows = rows.filter((s) => s.cashier_id === actor.id);
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
    range() {
      return builder;
    },
    single() {
      singleMode = "single";
      return builder;
    },
    maybeSingle() {
      singleMode = "maybeSingle";
      return builder;
    },
    then(resolve, reject) {
      return execute().then(resolve, reject);
    },
  };

  return builder;
}

async function rpcHandler(fnName, args = {}) {
  const actor = getActor();

  if (fnName === "get_active_global_shift_status") {
    if (!["admin", "kasir"].includes(actor.role)) {
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
        is_owned_by_caller: openShift.cashier_id === actor.id,
      },
      error: null,
    };
  }

  if (fnName === "open_shift_atomic") {
    return withSerializedRpc(async () => {
      if (!["admin", "kasir"].includes(actor.role)) {
        return { data: null, error: { message: "Hanya Admin dan Kasir yang dapat membuka shift." } };
      }
      const targetCashierId = args.p_cashier_id || actor.id;
      if (targetCashierId !== actor.id && actor.role !== "admin") {
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
        const ownerName = activeProf
          ? `${activeProf.full_name} (@${activeProf.username})`
          : "kasir lain";
        return {
          data: null,
          error: {
            code: "23505",
            message: `SHIFT_OCCUPIED_BY_OTHER_CASHIER: Shift kasir aktif sedang digunakan oleh ${ownerName}. Tutup shift tersebut terlebih dahulu.`,
          },
        };
      }

      const shiftId = nextUuid("b");
      let shiftNotes = args.p_notes || null;
      if (targetCashierId !== actor.id) {
        const prefix = `[Dibuka oleh Admin: ${actor.username}]`;
        shiftNotes = shiftNotes ? `${prefix} ${shiftNotes}` : prefix;
      }
      const row = {
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
      db.shifts.push(row);
      db.cash_movements.push({
        id: nextUuid("c"),
        shift_id: shiftId,
        movement_type: "opening_cash",
        amount: args.p_opening_cash,
        balance_before: 0,
        balance_after: args.p_opening_cash,
        reason: "Modal kas awal shift kasir",
        created_by: actor.id,
        created_at: new Date().toISOString(),
      });
      return { data: { ...row }, error: null };
    });
  }

  if (fnName === "close_shift_atomic") {
    const shift = db.shifts.find((s) => s.id === args.p_shift_id);
    if (!shift) return { data: null, error: { message: "Shift tidak ditemukan." } };
    if (shift.status !== "open") {
      return { data: null, error: { message: `Shift sudah ditutup sebelumnya pada ${shift.closed_at}.` } };
    }
    if (actor.role === "kasir" && shift.cashier_id !== actor.id) {
      return { data: null, error: { message: "Kasir tidak berhak menutup shift milik kasir lain." } };
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
      created_by: actor.id,
      created_at: new Date().toISOString(),
    });
    return { data: { ...shift }, error: null };
  }

  if (fnName === "record_cash_movement_atomic") {
    const shift = db.shifts.find((s) => s.id === args.p_shift_id);
    if (!shift) return { data: null, error: { message: "Shift tidak ditemukan." } };
    if (shift.status !== "open") {
      return { data: null, error: { message: "Tidak dapat mencatat mutasi kas pada shift yang sudah ditutup." } };
    }
    if (actor.role === "kasir" && shift.cashier_id !== actor.id) {
      return { data: null, error: { message: "Kasir tidak dapat mencatat mutasi pada shift kasir lain." } };
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
      created_by: actor.id,
      created_at: new Date().toISOString(),
    };
    db.cash_movements.push(mov);
    return { data: mov, error: null };
  }

  if (fnName === "create_pos_order_atomic") {
    const ownShift = db.shifts.find(
      (s) => s.cashier_id === actor.id && s.status === "open" && s.closed_at === null,
    );
    if (!ownShift) {
      return {
        data: null,
        error: { message: "SHIFT_NOT_OPEN: Shift kasir belum dibuka atau sudah ditutup." },
      };
    }
    const orderId = nextUuid("d");
    const pOrder = args.p_order || {};
    const orderRow = {
      id: orderId,
      order_number: `ORD-SINGLE-${seq}`,
      order_type: pOrder.order_type || "takeaway",
      status: "awaiting_payment",
      payment_status: "unpaid",
      is_finalized: true,
      subtotal: pOrder.subtotal,
      discount_total: 0,
      tax_total: pOrder.tax_total,
      service_total: pOrder.service_total,
      grand_total: pOrder.grand_total,
      paid_total: 0,
      created_by: actor.id,
      created_at: new Date().toISOString(),
    };
    db.orders.push(orderRow);
    return { data: { id: orderId, order_number: orderRow.order_number, is_additional_order: false, is_duplicate: false }, error: null };
  }

  if (fnName === "append_order_items_atomic") {
    const ownShift = db.shifts.find(
      (s) => s.cashier_id === actor.id && s.status === "open" && s.closed_at === null,
    );
    if (!ownShift) {
      return { data: null, error: { message: "SHIFT_NOT_OPEN: Shift kasir belum dibuka atau sudah ditutup." } };
    }
    return { data: { order_id: args.p_order_id }, error: null };
  }

  if (fnName === "process_pos_payment_manual") {
    const order = db.orders.find((o) => o.id === args.p_order_id);
    if (!order) return { data: null, error: { message: "Pesanan tidak ditemukan." } };
    let shiftId = null;
    if (args.p_payment_source === "cash") {
      const ownShift = db.shifts.find((s) => s.cashier_id === actor.id && s.status === "open");
      if (!ownShift) {
        return {
          data: null,
          error: { message: "Kasir belum membuka shift kasir. Buka shift terlebih dahulu sebelum memproses pembayaran tunai." },
        };
      }
      shiftId = ownShift.id;
      ownShift.expected_cash += args.p_amount;
    }
    const paymentId = nextUuid("p");
    order.paid_total += args.p_amount;
    order.payment_status = "paid";
    order.status = "paid";
    db.payments.push({ id: paymentId, order_id: order.id, shift_id: shiftId, amount: args.p_amount });
    return {
      data: {
        payment_id: paymentId,
        order_id: order.id,
        order_number: order.order_number,
        amount: args.p_amount,
        paid_total: order.paid_total,
        grand_total: order.grand_total,
        is_settled: true,
        shift_id: shiftId,
      },
      error: null,
    };
  }

  return { data: null, error: { message: `Unhandled rpc ${fnName}` } };
}

const supabaseSessionMock = {
  from: (t) => makeQuery(t, false),
  rpc: rpcHandler,
};

const supabaseAdminMock = {
  from: (t) => makeQuery(t, true),
  rpc: rpcHandler,
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
      const actor = getActor();
      if (!["admin", "kasir"].includes(actor.role)) {
        return { ok: false, message: "Hanya admin dan kasir yang dapat melakukan tindakan ini." };
      }
      return {
        ok: true,
        session: {
          status: "authenticated",
          user: { id: actor.id },
          profile: { ...actor },
        },
      };
    },
    getAdminActor: async () => {
      const actor = getActor();
      if (actor.role !== "admin") {
        return { ok: false, message: "Hanya admin yang dapat melakukan tindakan ini." };
      }
      return {
        ok: true,
        session: {
          status: "authenticated",
          user: { id: actor.id },
          profile: { ...actor },
        },
      };
    },
  },
  "@/lib/supabase/server": {
    createSupabaseServerClient: async () => supabaseSessionMock,
  },
  "@/lib/supabase/admin": {
    createSupabaseAdminClient: () =>
      forceNullAdminClient ? null : supabaseAdminMock,
  },
  "@/lib/midtrans/reconcile": {
    reconcileActiveMidtransPayment: async () => ({
      ok: true,
      isSettled: false,
      midtransStatus: "pending",
      reservationReleased: false,
      message: "ok",
    }),
  },
  "@/lib/midtrans/reservation": {
    getOrderMidtransReservationState: async () => ({
      ok: true,
      reservedAmount: 0,
      hasActiveTransaction: false,
      activeTransaction: null,
    }),
  },
  "@/lib/orders/inventory-validation": {
    validateOrderInventoryAvailability: async () => ({ ok: true }),
    reserveOrderStockStrict: async () => ({ ok: true }),
    releaseOrderStockStrict: async () => {},
  },
  "@/lib/orders/dining-session": {
    resolveOpenDiningSession: async () => ({ ok: true, sessionId: nextUuid("s") }),
  },
  "@/lib/orders/status-rules": {
    canPayOrder: () => true,
  },
  "@/lib/kds/routing": {
    buildOrderLinePreparationPlan: () => ({
      needsKitchen: true,
      stationStatus: { kitchen: "pending", bar: "none", dessert: "none" },
      lineItems: [],
    }),
  },
  "@/lib/menu/format": {
    formatRupiah: (n) => `Rp ${Number(n || 0).toLocaleString("id-ID")}`,
  },
};

const moduleCache = new Map();

function resolveTsFile(specifier) {
  let targetPath = specifier;
  if (specifier.startsWith("@/")) {
    targetPath = path.join(ROOT, "src", specifier.slice(2));
  }
  const candidates = [
    targetPath,
    `${targetPath}.ts`,
    `${targetPath}.tsx`,
    path.join(targetPath, "index.ts"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function loadTsModule(specifier) {
  if (Object.prototype.hasOwnProperty.call(moduleMocks, specifier)) {
    return moduleMocks[specifier];
  }
  if (!specifier.startsWith("@/") && !path.isAbsolute(specifier)) {
    return require(specifier);
  }
  const filePath = resolveTsFile(specifier);
  if (!filePath) throw new Error(`Cannot resolve module ${specifier}`);
  if (moduleCache.has(filePath)) return moduleCache.get(filePath).exports;

  const source = fs.readFileSync(filePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filePath,
  });

  const mod = { exports: {} };
  moduleCache.set(filePath, mod);

  const localRequire = (child) => {
    if (Object.prototype.hasOwnProperty.call(moduleMocks, child)) return moduleMocks[child];
    if (child.startsWith("./") || child.startsWith("../")) {
      const abs = path.resolve(path.dirname(filePath), child);
      return loadTsModule(abs);
    }
    return loadTsModule(child);
  };

  const fn = vm.runInThisContext(
    `(function(exports, require, module, __filename, __dirname) {\n${compiled.outputText}\n})`,
    { filename: filePath },
  );
  fn(mod.exports, localRequire, mod, filePath, path.dirname(filePath));
  return mod.exports;
}

const shiftsActions = loadTsModule("@/lib/shifts/actions");
const ordersActions = loadTsModule("@/lib/orders/actions");
const paymentsActions = loadTsModule("@/lib/payments/actions");

let passed = 0;
let total = 0;

async function testCase(name, fn) {
  total += 1;
  resetDb();
  try {
    await fn();
    passed += 1;
    console.log(`✓ [PASS] ${name}`);
  } catch (err) {
    console.error(`✗ [FAIL] ${name}`);
    console.error("  Error:", err?.stack || err);
    process.exitCode = 1;
  }
}

console.log("===============================================================================");
console.log(" NINE LICIOUS POS — SINGLE GLOBAL ACTIVE SHIFT REGRESSION & RACE SUITE");
console.log("===============================================================================\n");

await testCase("1. Kasir 1 buka shift -> Kasir 2 ditolak membuka shift & melihat lock Kasir 1", async () => {
  const kasir1 = db.profiles.find((p) => p.id === USER_KASIR_1);
  const kasir2 = db.profiles.find((p) => p.id === USER_KASIR_2);

  const k1Open = await runAs(kasir1, () => shiftsActions.openShiftAction({ openingCash: 250000 }));
  assert.equal(k1Open.ok, true, k1Open.message);
  assert.equal(db.shifts.filter((s) => s.status === "open").length, 1);

  const statusForK1 = await runAs(kasir1, () => shiftsActions.getGlobalActiveShiftStatusAction());
  assert.equal(statusForK1.ok, true);
  assert.equal(statusForK1.data.hasActiveShift, true);
  assert.equal(statusForK1.data.isOwnedByCurrentUser, true);
  assert.equal(statusForK1.data.cashierName, "Kasir Satu");

  const statusForK2 = await runAs(kasir2, () => shiftsActions.getGlobalActiveShiftStatusAction());
  assert.equal(statusForK2.ok, true);
  assert.equal(statusForK2.data.hasActiveShift, true);
  assert.equal(statusForK2.data.isOwnedByCurrentUser, false);
  assert.equal(statusForK2.data.cashierName, "Kasir Satu");
  // Pastikan status non-finansial tidak membocorkan nominal kas ke kasir lain
  assert.equal("openingCash" in statusForK2.data, false);
  assert.equal("expectedCash" in statusForK2.data, false);

  // Verifikasi juga jalur fallback RPC get_active_global_shift_status (ketika adminClient null)
  forceNullAdminClient = true;
  try {
    const rpcFallbackK2 = await runAs(kasir2, () =>
      shiftsActions.getGlobalActiveShiftStatusAction(),
    );
    assert.equal(rpcFallbackK2.ok, true);
    assert.equal(rpcFallbackK2.data.hasActiveShift, true);
    assert.equal(rpcFallbackK2.data.isOwnedByCurrentUser, false);
    assert.equal(rpcFallbackK2.data.cashierName, "Kasir Satu");
  } finally {
    forceNullAdminClient = false;
  }

  const k2Open = await runAs(kasir2, () => shiftsActions.openShiftAction({ openingCash: 100000 }));
  assert.equal(k2Open.ok, false);
  assert.match(k2Open.message, /Kasir Satu/);
  assert.match(k2Open.message, /sedang digunakan oleh/i);
  assert.equal(db.shifts.filter((s) => s.status === "open").length, 1);
});

await testCase("2. Kasir 2 buka shift -> Kasir 1 ditolak membuka shift & melihat lock Kasir 2", async () => {
  const kasir1 = db.profiles.find((p) => p.id === USER_KASIR_1);
  const kasir2 = db.profiles.find((p) => p.id === USER_KASIR_2);

  const k2Open = await runAs(kasir2, () => shiftsActions.openShiftAction({ openingCash: 300000 }));
  assert.equal(k2Open.ok, true, k2Open.message);

  const k1Open = await runAs(kasir1, () => shiftsActions.openShiftAction({ openingCash: 150000 }));
  assert.equal(k1Open.ok, false);
  assert.match(k1Open.message, /Kasir Dua/);
  assert.match(k1Open.message, /sedang digunakan oleh/i);
  assert.equal(db.shifts.filter((s) => s.status === "open").length, 1);

  const statusForK1 = await runAs(kasir1, () => shiftsActions.getGlobalActiveShiftStatusAction());
  assert.equal(statusForK1.ok, true);
  assert.equal(statusForK1.data.isOwnedByCurrentUser, false);
  assert.equal(statusForK1.data.cashierName, "Kasir Dua");
});

await testCase("3. Cross-cashier enforcement: Kasir 1 ditolak transaksi, pembayaran tunai, mutasi, & tutup shift Kasir 2", async () => {
  const kasir1 = db.profiles.find((p) => p.id === USER_KASIR_1);
  const kasir2 = db.profiles.find((p) => p.id === USER_KASIR_2);

  const k2Open = await runAs(kasir2, () => shiftsActions.openShiftAction({ openingCash: 500000 }));
  assert.equal(k2Open.ok, true);
  const k2ShiftId = k2Open.data.id;

  // Buat 1 order sah atas nama Kasir 2
  const validOrder = await runAs(kasir2, () =>
    ordersActions.createPosOrderAction({
      orderType: "takeaway",
      idempotencyKey: "k2-valid-order-0001",
      items: [{ productId: PRODUCT_1, quantity: 1 }],
    }),
  );
  assert.equal(validOrder.ok, true, validOrder.message);
  const orderId = validOrder.data.id;

  await runAs(kasir1, async () => {
    const createOwn = await ordersActions.createPosOrderAction({
      orderType: "takeaway",
      idempotencyKey: "k1-blocked-0001",
      items: [{ productId: PRODUCT_1, quantity: 1 }],
    });
    assert.equal(createOwn.ok, false);
    assert.equal(createOwn.errorCode, "SHIFT_NOT_OPEN");

    const createSpoof = await ordersActions.createPosOrderAction({
      orderType: "takeaway",
      shiftId: k2ShiftId,
      idempotencyKey: "k1-spoof-0002",
      items: [{ productId: PRODUCT_1, quantity: 1 }],
    });
    assert.equal(createSpoof.ok, false);
    assert.equal(createSpoof.errorCode, "SHIFT_NOT_OPEN");

    const appendSpoof = await ordersActions.appendOrderItemsAction({
      orderId,
      shiftId: k2ShiftId,
      items: [{ productId: PRODUCT_1, quantity: 1 }],
    });
    assert.equal(appendSpoof.ok, false);
    assert.equal(appendSpoof.errorCode, "SHIFT_NOT_OPEN");

    const paySpoof = await paymentsActions.processPosManualPaymentAction({
      orderId,
      shiftId: k2ShiftId,
      paymentMethod: "cash",
      paymentSource: "cash",
      amount: 37120,
      cashReceived: 40000,
      changeAmount: 2880,
      idempotencyKey: "pay-k1-spoof-0001",
    });
    assert.equal(paySpoof.ok, false);

    const closeSpoof = await shiftsActions.closeShiftAction({
      shiftId: k2ShiftId,
      actualCash: 500000,
    });
    assert.equal(closeSpoof.ok, false);

    const moveSpoof = await shiftsActions.recordCashMovementAction({
      shiftId: k2ShiftId,
      movementType: "cash_out",
      amount: 100000,
      reason: "Ambil kas ilegal",
    });
    assert.equal(moveSpoof.ok, false);

    const summarySpoof = await shiftsActions.getShiftSummaryAction(k2ShiftId);
    assert.equal(summarySpoof.ok, false);
  });

  // Pastikan shift Kasir 2 masih open & saldonya tidak berubah sama sekali
  assert.equal(db.shifts[0].status, "open");
  assert.equal(db.shifts[0].expected_cash, 500000);
  assert.equal(db.payments.length, 0);
});

await testCase("4. Concurrency race test (Promise.all): 2 kasir membuka shift bersamaan -> hanya 1 berhasil", async () => {
  const kasir1 = db.profiles.find((p) => p.id === USER_KASIR_1);
  const kasir2 = db.profiles.find((p) => p.id === USER_KASIR_2);

  // Sinkronkan kedua goroutine/promise di precheck agar keduanya masuk RPC open_shift_atomic pada saat bersamaan
  let arrived = 0;
  let releaseBarrier;
  const barrierPromise = new Promise((resolve) => {
    releaseBarrier = resolve;
  });
  raceBarrier = async () => {
    arrived += 1;
    if (arrived >= 2) {
      releaseBarrier();
      raceBarrier = null;
    } else {
      await barrierPromise;
    }
  };

  const [res1, res2] = await Promise.all([
    runAs(kasir1, () => shiftsActions.openShiftAction({ openingCash: 200000 })),
    runAs(kasir2, () => shiftsActions.openShiftAction({ openingCash: 300000 })),
  ]);

  const successes = [res1, res2].filter((r) => r.ok);
  const failures = [res1, res2].filter((r) => !r.ok);

  assert.equal(successes.length, 1, `Harusnya tepat 1 berhasil, dapat: ${JSON.stringify([res1, res2])}`);
  assert.equal(failures.length, 1, "Harusnya tepat 1 ditolak oleh advisory lock & unique index.");
  assert.match(failures[0].message, /sedang digunakan oleh/i);
  assert.equal(db.shifts.filter((s) => s.status === "open").length, 1);
});

await testCase("5. Reopen after close: setelah Kasir 1 tutup shift sah, Kasir 2 bisa membuka shift baru", async () => {
  const kasir1 = db.profiles.find((p) => p.id === USER_KASIR_1);
  const kasir2 = db.profiles.find((p) => p.id === USER_KASIR_2);

  const open1 = await runAs(kasir1, () => shiftsActions.openShiftAction({ openingCash: 200000 }));
  assert.equal(open1.ok, true);

  const blocked2 = await runAs(kasir2, () => shiftsActions.openShiftAction({ openingCash: 250000 }));
  assert.equal(blocked2.ok, false);

  const close1 = await runAs(kasir1, () =>
    shiftsActions.closeShiftAction({ shiftId: open1.data.id, actualCash: 200000 }),
  );
  assert.equal(close1.ok, true, close1.message);
  assert.equal(close1.data.status, "closed");

  const statusAfterClose = await runAs(kasir2, () => shiftsActions.getGlobalActiveShiftStatusAction());
  assert.equal(statusAfterClose.ok, true);
  assert.equal(statusAfterClose.data.hasActiveShift, false);

  const open2 = await runAs(kasir2, () => shiftsActions.openShiftAction({ openingCash: 250000 }));
  assert.equal(open2.ok, true, open2.message);
  assert.equal(open2.data.cashier_id, USER_KASIR_2);
  assert.equal(db.shifts.filter((s) => s.status === "open").length, 1);
  assert.equal(db.shifts.length, 2);
});

await testCase("6. Admin Shift Management: monitoring, guard 1 shift global, close & reopen untuk kasir lain", async () => {
  const admin = db.profiles.find((p) => p.id === USER_ADMIN_1);
  const kasir1 = db.profiles.find((p) => p.id === USER_KASIR_1);

  await runAs(kasir1, async () => {
    const res = await shiftsActions.openShiftAction({ openingCash: 350000 });
    assert.equal(res.ok, true);
  });

  await runAs(admin, async () => {
    const activeAll = await shiftsActions.getAllActiveShiftsAction();
    assert.equal(activeAll.ok, true);
    assert.equal(activeAll.data.length, 1);

    const openSecond = await shiftsActions.openShiftAction({
      cashierId: USER_KASIR_2,
      openingCash: 100000,
    });
    assert.equal(openSecond.ok, false);
    assert.match(openSecond.message, /Kasir Satu/);

    const detail = await shiftsActions.getShiftSummaryAction(activeAll.data[0].id);
    assert.equal(detail.ok, true);
    assert.equal(detail.data.openingCash, 350000);

    const closeRes = await shiftsActions.closeShiftAction({
      shiftId: activeAll.data[0].id,
      actualCash: 350000,
      notes: "Audit penutupan shift oleh Admin",
    });
    assert.equal(closeRes.ok, true, closeRes.message);

    const openK2After = await shiftsActions.openShiftAction({
      cashierId: USER_KASIR_2,
      openingCash: 400000,
    });
    assert.equal(openK2After.ok, true, openK2After.message);
    assert.equal(openK2After.data.cashier_id, USER_KASIR_2);
  });
});

await testCase("7. Audit Kontrak SQL Migration (20261127000100), Server Actions, UI POS/Orders/Shift/Admin & Realtime", async () => {
  const sql = fs.readFileSync(
    path.join(ROOT, "supabase/migrations/20261127000100_enforce_single_global_active_shift.sql"),
    "utf8",
  );
  assert.match(sql, /PREFLIGHT_MULTIPLE_OPEN_SHIFTS/);
  assert.match(sql, /drop index if exists public\.idx_shifts_single_active_cashier/i);
  assert.match(
    sql,
    /create unique index if not exists idx_shifts_single_global_active\s+on public\.shifts \(\(1\)\)\s+where \(status = 'open'\)/i,
  );
  assert.match(sql, /pg_catalog\.pg_advisory_xact_lock\(91500501\)/);
  assert.match(sql, /SHIFT_OCCUPIED_BY_OTHER_CASHIER/);
  assert.match(sql, /when unique_violation then/i);
  assert.match(sql, /create or replace function public\.get_active_global_shift_status\(\)/i);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /alter publication supabase_realtime add table public\.shifts/i);

  // Pastikan RPC non-finansial tidak me-return kolom saldo kas
  const rpcSection = sql.slice(
    sql.indexOf("create or replace function public.get_active_global_shift_status"),
    sql.indexOf("create or replace function public.open_shift_atomic"),
  );
  assert.doesNotMatch(rpcSection, /opening_cash|expected_cash|actual_cash|cash_difference/i);

  const actionsSrc = fs.readFileSync(path.join(ROOT, "src/lib/shifts/actions.ts"), "utf8");
  assert.match(actionsSrc, /export async function getGlobalActiveShiftStatusAction/);
  assert.match(actionsSrc, /revalidatePath\("\/pos\/floor"\)/);

  const posPage = fs.readFileSync(path.join(ROOT, "src/app/(app)/pos/page.tsx"), "utf8");
  const posOrdersPage = fs.readFileSync(path.join(ROOT, "src/app/(app)/pos/orders/page.tsx"), "utf8");
  const posShiftPage = fs.readFileSync(path.join(ROOT, "src/app/(app)/pos/shift/page.tsx"), "utf8");
  const adminShiftsPage = fs.readFileSync(path.join(ROOT, "src/app/(app)/admin/shifts/page.tsx"), "utf8");

  for (const [name, src] of [
    ["pos/page.tsx", posPage],
    ["pos/orders/page.tsx", posOrdersPage],
    ["pos/shift/page.tsx", posShiftPage],
    ["admin/shifts/page.tsx", adminShiftsPage],
  ]) {
    assert.match(src, /export const dynamic = "force-dynamic"/, `${name} harus force-dynamic`);
  }

  assert.match(posPage, /GlobalShiftSyncListener/);
  assert.match(posPage, /Shift Digunakan oleh/);
  assert.match(posOrdersPage, /GlobalShiftSyncListener/);
  assert.match(posOrdersPage, /Shift Digunakan oleh/);

  const shiftManager = fs.readFileSync(path.join(ROOT, "src/components/pos/shift/shift-manager.tsx"), "utf8");
  assert.match(shiftManager, /GlobalShiftSyncListener/);
  assert.match(shiftManager, /broadcastGlobalShiftChanged/);
  assert.match(shiftManager, /Shift Kasir Sedang Digunakan/);

  const adminShiftManager = fs.readFileSync(path.join(ROOT, "src/components/admin/shifts/admin-shift-manager.tsx"), "utf8");
  assert.match(adminShiftManager, /GlobalShiftSyncListener/);
  assert.match(adminShiftManager, /broadcastGlobalShiftChanged/);
  assert.match(adminShiftManager, /Terkunci: 1 Shift Aktif Global/);

  const cartPanel = fs.readFileSync(path.join(ROOT, "src/components/pos/cart-panel.tsx"), "utf8");
  assert.match(cartPanel, /Shift Digunakan Kasir Lain/);

  const paymentModal = fs.readFileSync(path.join(ROOT, "src/components/pos/payment-modal.tsx"), "utf8");
  assert.match(paymentModal, /Shift Dipakai Kasir Lain/);
});

console.log(`\n${passed}/${total} SINGLE GLOBAL ACTIVE SHIFT TESTS PASSED.`);
if (passed !== total) process.exit(1);
