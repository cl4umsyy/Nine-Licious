import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();

// ============================================================================
// In-Memory Stateful Postgres + Midtrans Core API Sandbox Mock
// ============================================================================
const db = {
  orders: [],
  order_items: [],
  order_item_modifiers: [],
  order_discounts: [],
  dining_tables: [],
  midtrans_transactions: [],
  order_allocations: [],
  ingredient_reservations: [],
  payments: [],
  refunds: [],
  audit_logs: [],
  restaurant_settings: [{ id: 1, name: "Nine Licious", receipt_width: 58 }],
  profiles: [{ id: "user-kasir-1", full_name: "Kasir Satu" }],
  cashPaymentRpcCalls: 0,
  receiptRpcCalls: 0,
  cancelRpcCalls: 0,
  finalizeRpcCalls: 0,
  unfinalizeRpcCalls: 0,
  refundRpcCalls: 0,
  stockReleaseRpcCalls: 0,
  createSnapCalls: 0,
  cancelMidtransApiCalls: [],
};

const midtransMockResponses = new Map();

function resetDb() {
  db.orders = [];
  db.order_items = [];
  db.order_item_modifiers = [];
  db.order_discounts = [];
  db.dining_tables = [];
  db.midtrans_transactions = [];
  db.order_allocations = [];
  db.ingredient_reservations = [];
  db.payments = [];
  db.refunds = [];
  db.audit_logs = [];
  db.cashPaymentRpcCalls = 0;
  db.receiptRpcCalls = 0;
  db.cancelRpcCalls = 0;
  db.finalizeRpcCalls = 0;
  db.unfinalizeRpcCalls = 0;
  db.refundRpcCalls = 0;
  db.stockReleaseRpcCalls = 0;
  db.createSnapCalls = 0;
  db.cancelMidtransApiCalls = [];
  midtransMockResponses.clear();
}

globalThis.fetch = async (url, init = {}) => {
  const urlStr = String(url);
  const method = (init.method || "GET").toUpperCase();
  const match = urlStr.match(/\/v2\/([^/]+)\/(status|cancel)$/);
  assert.ok(match, `Unexpected Midtrans URL in test: ${urlStr}`);
  const midtransOrderId = decodeURIComponent(match[1]);
  const endpoint = match[2];
  const mock = midtransMockResponses.get(midtransOrderId);

  if (endpoint === "cancel" && method === "POST") {
    db.cancelMidtransApiCalls.push(midtransOrderId);
    if (!mock || mock.mode === "timeout") {
      const err = new Error("Aborted timeout");
      err.name = "AbortError";
      throw err;
    }
    if (mock.cancelFail) {
      return {
        ok: false,
        status: 412,
        json: async () => ({
          status_code: "412",
          status_message: "Merchant cannot modify transaction status",
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status_code: "200",
        status_message: "Success, transaction is canceled",
        order_id: midtransOrderId,
        transaction_status: "cancel",
        gross_amount: mock.gross_amount || "32200.00",
      }),
    };
  }

  if (!mock || mock.mode === "404") {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status_code: "404",
        status_message: "Transaction doesn't exist.",
      }),
    };
  }
  if (mock.mode === "timeout") {
    const err = new Error("Request timeout");
    err.name = "AbortError";
    throw err;
  }
  if (mock.mode === "http_error") {
    return {
      ok: false,
      status: mock.status || 500,
      json: async () => ({
        status_code: String(mock.status || 500),
        status_message: "Midtrans internal error",
      }),
    };
  }

  return {
    ok: true,
    status: 200,
    json: async () => ({
      status_code: mock.status_code || "200",
      status_message: "Success, transaction found",
      order_id: midtransOrderId,
      gross_amount: mock.gross_amount,
      currency: mock.currency || "IDR",
      transaction_status: mock.transaction_status,
      fraud_status: mock.fraud_status || "accept",
      transaction_id: mock.transaction_id || `gw-tx-${midtransOrderId}`,
      payment_type: mock.payment_type || "qris",
    }),
  };
};

function makeQuery(tableName) {
  const filters = [];
  let op = "select";
  let selectOpts = {};
  let updatePatch = null;
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
        if (f.type === "not") {
          if (f.op === "is" && f.val === null) return row[f.col] !== null && row[f.col] !== undefined;
          if (f.op === "in") {
            const inner = String(f.val).replace(/^\(|\)$/g, "").split(",").map((s) => s.trim());
            return !inner.includes(String(row[f.col] ?? ""));
          }
        }
        return true;
      }),
    );
  }

  function hydrateRelations(row) {
    const copy = { ...row };
    if (tableName === "orders") {
      const tbl = db.dining_tables.find((t) => t.id === row.table_id);
      copy.dining_tables = tbl ? { name: tbl.name } : null;
      copy.order_items = db.order_items
        .filter((it) => it.order_id === row.id)
        .map((it) => ({ quantity: it.quantity }));
    }
    if (tableName === "refunds") {
      const ord = db.orders.find((o) => o.id === row.order_id);
      if (ord) {
        const tbl = db.dining_tables.find((t) => t.id === ord.table_id);
        copy.orders = {
          status: ord.status,
          order_number: ord.order_number,
          queue_number: ord.queue_number,
          order_type: ord.order_type,
          dining_tables: tbl ? { name: tbl.name } : null,
        };
      } else {
        copy.orders = null;
      }
    }
    return copy;
  }

  function execute() {
    const table = db[tableName];
    if (!table) return { data: null, count: 0, error: { message: `Unknown table ${tableName}` } };

    if (op === "update") {
      const matched = applyFilters(table);
      const updated = [];
      for (const row of matched) {
        Object.assign(row, updatePatch);
        updated.push({ ...row });
      }
      if (singleMode === "maybeSingle" || singleMode === "single") {
        return { data: updated[0] ?? null, count: updated.length, error: null };
      }
      return { data: updated, count: updated.length, error: null };
    }

    let result = applyFilters(table).map(hydrateRelations);
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
    if (singleMode === "maybeSingle" || singleMode === "single") {
      return { data: result[0] ?? null, count: result[0] ? 1 : 0, error: null };
    }
    return { data: result, count: totalCount, error: null };
  }

  const builder = {
    select(_cols, opts = {}) {
      selectOpts = opts || {};
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
    not(col, opStr, val) {
      filters.push({ type: "not", col, op: opStr, val });
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

const supabaseMock = {
  from: (tableName) => makeQuery(tableName),
  rpc: async (fnName, args = {}) => {
    if (fnName === "cancel_pos_order") {
      db.cancelRpcCalls += 1;
      const order = db.orders.find((o) => o.id === args.p_order_id);
      if (!order) return { data: null, error: { message: "Pesanan tidak ditemukan." } };
      if (!["awaiting_payment", "partially_paid"].includes(order.status) || Number(order.paid_total) > 0) {
        return { data: null, error: { message: "ORDER_NOT_CANCELLABLE" } };
      }
      const activeGateway = db.midtrans_transactions.filter(
        (tx) =>
          tx.order_id === order.id &&
          ["initiated", "token_created", "pending", "capture_challenge", "reconciliation_required"].includes(
            tx.lifecycle_status,
          ),
      );
      if (activeGateway.length > 0) {
        return { data: null, error: { message: "ACTIVE_GATEWAY_TRANSACTIONS" } };
      }
      order.status = "cancelled";
      order.cancel_reason = args.p_cancel_reason;
      order.cancelled_at = new Date().toISOString();
      order.kds_status = null;
      order.queue_number = null;
      for (const res of db.ingredient_reservations) {
        if (res.order_id === order.id && res.status === "active") {
          res.status = "released";
        }
      }
      return { data: { order_id: order.id, status: "cancelled" }, error: null };
    }

    if (fnName === "release_order_stock_reservations_internal") {
      db.stockReleaseRpcCalls += 1;
      for (const res of db.ingredient_reservations) {
        if (res.order_id === args.p_order_id && res.status === "active") {
          res.status = "released";
        }
      }
      return { data: true, error: null };
    }

    if (fnName === "finalize_pos_order") {
      db.finalizeRpcCalls += 1;
      const order = db.orders.find((o) => o.id === args.p_order_id);
      if (!order || order.status !== "awaiting_payment" || order.payment_status !== "unpaid") {
        return { data: null, error: { message: "Hanya pesanan belum lunas yang dapat difinalisasi." } };
      }
      order.is_finalized = true;
      return { data: { order_id: order.id, is_finalized: true }, error: null };
    }

    if (fnName === "unfinalize_pos_order") {
      db.unfinalizeRpcCalls += 1;
      const order = db.orders.find((o) => o.id === args.p_order_id);
      if (!order || !order.is_finalized || order.payment_status !== "unpaid") {
        return { data: null, error: { message: "Tidak dapat unfinalize" } };
      }
      order.is_finalized = false;
      return { data: { order_id: order.id, is_finalized: false }, error: null };
    }

    if (fnName === "process_pos_payment_manual") {
      db.cashPaymentRpcCalls += 1;
      const order = db.orders.find((o) => o.id === args.p_order_id);
      if (!order || order.status === "cancelled" || order.status === "paid") {
        return { data: null, error: { message: "ORDER_NOT_PAYABLE" } };
      }
      const amt = Number(args.p_amount || 0);
      order.paid_total = Number(order.paid_total) + amt;
      if (order.paid_total >= order.grand_total) {
        order.status = "paid";
        order.payment_status = "paid";
        order.kds_status = "queued";
        order.queue_number = order.queue_number || "A099";
        for (const res of db.ingredient_reservations) {
          if (res.order_id === order.id && res.status === "active") res.status = "fulfilled";
        }
      } else {
        order.status = "partially_paid";
        order.payment_status = "partially_paid";
      }
      return {
        data: {
          payment_id: "pay-manual-1",
          order_id: order.id,
          order_number: order.order_number,
          amount: amt,
          payment_status: "success",
          paid_total: order.paid_total,
          grand_total: order.grand_total,
          is_settled: order.payment_status === "paid",
        },
        error: null,
      };
    }

    if (fnName === "process_order_refund_atomic") {
      db.refundRpcCalls += 1;
      return { data: null, error: { message: "REFUND_MOCK" } };
    }

    if (fnName === "get_order_receipt_data") {
      db.receiptRpcCalls += 1;
      const order = db.orders.find((o) => o.id === args.p_order_id);
      if (!order) return { data: null, error: { message: "Not found" } };
      return {
        data: {
          restaurant: db.restaurant_settings[0],
          order: {
            id: order.id,
            order_number: order.order_number,
            order_type: order.order_type || "takeaway",
            table_name: null,
            customer_name: order.customer_name || null,
            status: order.status,
            payment_status: order.payment_status,
            queue_number: order.queue_number,
            queue_date: order.queue_date || null,
            cashier_name: "Kasir Satu",
            created_at: order.created_at,
            subtotal: order.grand_total,
            discount_product_total: 0,
            discount_order_total: 0,
            discount_manual_total: 0,
            discount_total: 0,
            tax_percent: 0,
            tax_total: 0,
            service_charge_percent: 0,
            service_total: 0,
            grand_total: order.grand_total,
            paid_total: order.paid_total,
            refunded_total: 0,
            pending_refund_total: 0,
            net_paid: order.paid_total,
          },
          items: db.order_items.filter((i) => i.order_id === order.id),
          discounts: [],
          payments: db.payments.filter((p) => p.order_id === order.id),
          refunds: [],
        },
        error: null,
      };
    }

    return { data: null, error: { message: `Unhandled rpc ${fnName}` } };
  },
};

// ============================================================================
// Production TypeScript Module Loader
// ============================================================================
const moduleMocks = {
  "server-only": {},
  "next/cache": { revalidatePath: () => {} },
  "@/lib/auth/audit": {
    logAudit: async (entry) => {
      db.audit_logs.push(entry);
    },
  },
  "@/lib/auth/session": {
    getCashierActor: async () => ({
      ok: true,
      session: {
        user: { id: "user-kasir-1" },
        profile: { id: "user-kasir-1", username: "kasir1", role: "kasir" },
      },
    }),
    getAdminActor: async () => ({
      ok: true,
      session: {
        user: { id: "user-admin-1" },
        profile: { id: "user-admin-1", username: "admin1", role: "admin" },
      },
    }),
    getKitchenActor: async () => ({
      ok: true,
      session: {
        user: { id: "user-kitchen-1" },
        profile: { id: "user-kitchen-1", username: "kitchen1", role: "kitchen" },
      },
    }),
  },
  "@/lib/supabase/admin": {
    createSupabaseAdminClient: () => supabaseMock,
  },
  "@/lib/supabase/server": {
    createSupabaseServerClient: async () => supabaseMock,
  },
  "@/lib/midtrans/config": {
    getMidtransConfigState: () => ({
      enabled: true,
      ok: true,
      config: {
        environment: "sandbox",
        isProduction: false,
        serverKey: "SB-Mid-server-TESTKEY",
        clientKey: "SB-Mid-client-TESTKEY",
        apiBaseUrl: "https://api.sandbox.midtrans.com",
        snapScriptUrl: "https://app.sandbox.midtrans.com/snap/snap.js",
      },
    }),
  },
  "@/lib/midtrans/service": {
    createSnapPayment: async (params) => {
      db.createSnapCalls += 1;
      const attempt =
        db.midtrans_transactions.filter((t) => t.order_id === params.orderId).length + 1;
      const midtransOrderId = `${params.orderNumber}-A${attempt}`;
      const newTx = {
        id: `tx-${attempt}-${Date.now()}`,
        order_id: params.orderId,
        midtrans_order_id: midtransOrderId,
        attempt_number: attempt,
        gross_amount: params.grossAmount,
        lifecycle_status: "token_created",
        midtrans_transaction_status: null,
        snap_token: `snap-token-A${attempt}`,
        snap_redirect_url: `https://app.sandbox.midtrans.com/snap/v2/vtweb/A${attempt}`,
        payment_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        sanitized_response: null,
        created_at: new Date().toISOString(),
      };
      db.midtrans_transactions.push(newTx);
      db.order_allocations.push({
        id: `alloc-${attempt}-${Date.now()}`,
        order_id: params.orderId,
        midtrans_transaction_id: newTx.id,
        allocation_status: "reserved",
        allocated_final_amount: params.grossAmount,
      });
      return {
        ok: true,
        midtransTransactionId: newTx.id,
        midtransOrderId,
        snapToken: newTx.snap_token,
        snapRedirectUrl: newTx.snap_redirect_url,
        grossAmount: params.grossAmount,
      };
    },
  },
  "@/lib/midtrans/webhook": {
    settleVerifiedMidtransStatus: async (payload) => {
      const tx = db.midtrans_transactions.find((t) => t.midtrans_order_id === payload.order_id);
      if (!tx) return { ok: false, fingerprint: "fp", processingResult: "failed", error: "tx not found" };
      const order = db.orders.find((o) => o.id === tx.order_id);
      if (!order) return { ok: false, fingerprint: "fp", processingResult: "failed", error: "order not found" };

      if (
        payload.transaction_status === "settlement" ||
        (payload.transaction_status === "capture" && payload.fraud_status === "accept")
      ) {
        if (order.status === "cancelled" || order.status === "refunded") {
          tx.lifecycle_status = "reconciliation_required";
          tx.midtrans_transaction_status = payload.transaction_status;
          tx.sanitized_response = payload;
          return {
            ok: true,
            fingerprint: "fp",
            orderId: order.id,
            midtransOrderId: tx.midtrans_order_id,
            transactionStatus: payload.transaction_status,
            processingResult: "reconciliation_flagged",
          };
        }
        tx.lifecycle_status = "settled";
        tx.midtrans_transaction_status = payload.transaction_status;
        tx.sanitized_response = payload;
        order.status = "paid";
        order.payment_status = "paid";
        order.paid_total = order.grand_total;
        order.queue_number = order.queue_number || "A101";
        order.kds_status = order.kds_status || "queued";
        db.payments.push({
          id: `pay-gw-${Date.now()}`,
          order_id: order.id,
          payment_method: "midtrans",
          payment_source: "midtrans_snap",
          amount: order.grand_total,
          cash_received: null,
          change_amount: 0,
          payment_status: "success",
          created_at: new Date().toISOString(),
        });
        for (const alloc of db.order_allocations) {
          if (alloc.midtrans_transaction_id === tx.id) alloc.allocation_status = "settled";
        }
        for (const res of db.ingredient_reservations) {
          if (res.order_id === order.id && res.status === "active") res.status = "fulfilled";
        }
        return {
          ok: true,
          fingerprint: "fp",
          orderId: order.id,
          midtransOrderId: tx.midtrans_order_id,
          transactionStatus: payload.transaction_status,
          processingResult: "processed",
        };
      }

      if (["expire", "cancel", "deny"].includes(payload.transaction_status)) {
        tx.lifecycle_status =
          payload.transaction_status === "expire"
            ? "expired"
            : payload.transaction_status === "cancel"
              ? "cancelled"
              : "denied";
        tx.midtrans_transaction_status = payload.transaction_status;
        for (const alloc of db.order_allocations) {
          if (alloc.midtrans_transaction_id === tx.id && alloc.allocation_status === "reserved") {
            alloc.allocation_status = "released";
          }
        }
        for (const res of db.ingredient_reservations) {
          if (res.order_id === order.id && res.status === "active") {
            res.status = "released";
          }
        }
        return {
          ok: true,
          fingerprint: "fp",
          orderId: order.id,
          midtransOrderId: tx.midtrans_order_id,
          transactionStatus: payload.transaction_status,
          processingResult: "processed",
        };
      }

      return { ok: false, fingerprint: "fp", processingResult: "failed", error: "unsupported" };
    },
  },
  "@/lib/midtrans/status": {
    isMidtransPaidStatus: (txStatus, fraudStatus) => {
      const s = (txStatus || "").toLowerCase();
      const f = (fraudStatus || "").toLowerCase();
      return s === "settlement" || (s === "capture" && f === "accept");
    },
  },
  "@/lib/orders/serving": {
    isMissingServingSchemaError: () => false,
  },
  "@/lib/orders/calculations": {
    calculateCartTotals: () => ({}),
  },
  "@/lib/orders/session-closure": {
    evaluateDiningSessionClosure: () => ({ canClose: true, blockingReason: null }),
  },
  "@/lib/orders/inventory-validation": {
    validateOrderInventoryAvailability: async () => ({ ok: true }),
  },
};

const canonicalPathMocks = new Map([
  [path.normalize(path.join(ROOT, "src/lib/midtrans/config.ts")), "@/lib/midtrans/config"],
  [path.normalize(path.join(ROOT, "src/lib/midtrans/service.ts")), "@/lib/midtrans/service"],
  [path.normalize(path.join(ROOT, "src/lib/midtrans/webhook.ts")), "@/lib/midtrans/webhook"],
  [path.normalize(path.join(ROOT, "src/lib/midtrans/status.ts")), "@/lib/midtrans/status"],
  [path.normalize(path.join(ROOT, "src/lib/auth/audit.ts")), "@/lib/auth/audit"],
  [path.normalize(path.join(ROOT, "src/lib/auth/session.ts")), "@/lib/auth/session"],
  [path.normalize(path.join(ROOT, "src/lib/supabase/admin.ts")), "@/lib/supabase/admin"],
  [path.normalize(path.join(ROOT, "src/lib/supabase/server.ts")), "@/lib/supabase/server"],
  [path.normalize(path.join(ROOT, "src/lib/orders/serving.ts")), "@/lib/orders/serving"],
]);

const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "server-only" || request === "next/cache") {
    return request;
  }
  if (request.startsWith("@/")) {
    const resolvedBase = path.join(ROOT, "src", request.slice(2));
    for (const candidate of [resolvedBase + ".ts", resolvedBase + ".tsx", path.join(resolvedBase, "index.ts")]) {
      const normalized = path.normalize(candidate);
      if (fs.existsSync(normalized)) return normalized;
    }
  }
  if (request.startsWith(".") && parent && (parent.filename.endsWith(".ts") || parent.filename.endsWith(".tsx"))) {
    const dir = path.dirname(parent.filename);
    const resolvedBase = path.resolve(dir, request);
    for (const candidate of [resolvedBase + ".ts", resolvedBase + ".tsx", path.join(resolvedBase, "index.ts")]) {
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
  const canonicalMockKey = canonicalPathMocks.get(path.normalize(resolved));
  if (canonicalMockKey && Object.prototype.hasOwnProperty.call(moduleMocks, canonicalMockKey)) {
    return moduleMocks[canonicalMockKey];
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
const paymentsActions = require(path.join(ROOT, "src/lib/payments/actions.ts"));
const discountsActions = require(path.join(ROOT, "src/lib/discounts/actions.ts"));
const kdsActions = require(path.join(ROOT, "src/lib/kds/actions.ts"));
const kdsTransitions = require(path.join(ROOT, "src/lib/kds/transitions.ts"));
const transactionsActions = require(path.join(ROOT, "src/lib/transactions/actions.ts"));
const staleCleanup = require(path.join(ROOT, "src/lib/midtrans/stale-cleanup.ts"));
const cronRoute = require(path.join(ROOT, "src/app/api/cron/midtrans-cleanup/route.ts"));

const UUID1 = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const UUID3 = "33333333-3333-4333-8333-333333333333";

let passed = 0;
let total = 0;

async function testCase(title, fn) {
  total += 1;
  resetDb();
  await fn();
  console.log(`PASS #${total}: ${title}`);
  passed += 1;
}

function seedMidtransOrder({
  id = UUID1,
  orderNumber = "ORD-20261117-0005",
  status = "awaiting_payment",
  paymentStatus = "unpaid",
  isFinalized = true,
  paidTotal = 0,
  grandTotal = 32200,
  txLifecycle = "token_created",
  expiresAt = "2026-11-17T02:52:09.055+00:00",
  createdAt = "2026-11-17T02:36:44.000+00:00",
  withStockRes = true,
} = {}) {
  db.orders.push({
    id,
    order_number: orderNumber,
    order_type: "takeaway",
    table_id: null,
    dining_session_id: null,
    status,
    payment_status: paymentStatus,
    is_finalized: isFinalized,
    grand_total: grandTotal,
    paid_total: paidTotal,
    queue_number: null,
    kds_status: null,
    served_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  });
  db.order_items.push({
    id: `item-${id}`,
    order_id: id,
    product_id: "prod-1",
    product_name_snapshot: "Waffle Signature",
    quantity: 2,
    kitchen_station: "kitchen",
    line_total: grandTotal,
    created_at: createdAt,
  });
  if (withStockRes) {
    db.ingredient_reservations.push({
      id: `sres-${id}`,
      order_id: id,
      status: status === "paid" ? "fulfilled" : "active",
    });
  }
  if (txLifecycle !== null) {
    const mid = `${orderNumber}-A1`;
    db.midtrans_transactions.push({
      id: `tx-${id}`,
      order_id: id,
      midtrans_order_id: mid,
      attempt_number: 1,
      gross_amount: grandTotal,
      lifecycle_status: txLifecycle,
      midtrans_transaction_status: txLifecycle === "pending" ? "pending" : null,
      snap_token: "snap-123",
      payment_expires_at: expiresAt,
      created_at: createdAt,
    });
    db.order_allocations.push({
      id: `alloc-${id}`,
      order_id: id,
      midtrans_transaction_id: `tx-${id}`,
      allocation_status: "reserved",
      allocated_final_amount: grandTotal,
    });
    return mid;
  }
  return null;
}

// ============================================================================
// ALL 14 MANDATORY TEST SCENARIOS
// ============================================================================

await testCase("1. Order Midtrans expire -> 'Batalkan Midtrans & Lepas Reservasi' cancels order, releases stock & allocs", async () => {
  const mid = seedMidtransOrder();
  midtransMockResponses.set(mid, { mode: "status", transaction_status: "expire", gross_amount: "32200.00", status_code: "407" });

  const res = await paymentsActions.cancelActiveMidtransReservationAction(UUID1);
  assert.equal(res.ok, true, res.message);
  assert.equal(res.data.orderCancelled, true);
  assert.equal(db.orders[0].status, "cancelled");
  assert.equal(db.orders[0].payment_status, "unpaid");
  assert.equal(db.ingredient_reservations[0].status, "released");
  assert.equal(db.order_allocations[0].allocation_status, "released");
  assert.equal(db.cashPaymentRpcCalls, 0);
  assert.equal(db.receiptRpcCalls, 0);
});

await testCase("2. Order Midtrans cancel -> safely cancels order & releases stock", async () => {
  const mid = seedMidtransOrder();
  midtransMockResponses.set(mid, { mode: "status", transaction_status: "cancel", gross_amount: "32200.00", status_code: "202" });

  const res = await paymentsActions.cancelActiveMidtransReservationAction(UUID1);
  assert.equal(res.ok, true, res.message);
  assert.equal(res.data.orderCancelled, true);
  assert.equal(db.orders[0].status, "cancelled");
  assert.equal(db.ingredient_reservations[0].status, "released");
  assert.equal(db.order_allocations[0].allocation_status, "released");
});

await testCase("3. Order Midtrans deny -> safely cancels order & releases stock", async () => {
  const mid = seedMidtransOrder();
  midtransMockResponses.set(mid, { mode: "status", transaction_status: "deny", gross_amount: "32200.00", status_code: "202" });

  const res = await paymentsActions.cancelActiveMidtransReservationAction(UUID1);
  assert.equal(res.ok, true, res.message);
  assert.equal(res.data.orderCancelled, true);
  assert.equal(db.orders[0].status, "cancelled");
  assert.equal(db.ingredient_reservations[0].status, "released");
});

await testCase("4. Order Midtrans pending -> release_to_cash refuses, while Batalkan Midtrans & Lepas Reservasi tries Midtrans /cancel first (and fails closed if gateway rejects)", async () => {
  const mid = seedMidtransOrder({
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    txLifecycle: "pending",
  });

  // Switching to cash without cancelling must still be blocked cleanly
  midtransMockResponses.set(mid, { mode: "status", transaction_status: "pending", gross_amount: "32200.00", status_code: "201" });
  const resSwitchCash = await paymentsActions.cancelActiveMidtransReservationAction(UUID1, {
    mode: "release_to_cash",
  });
  assert.equal(resSwitchCash.ok, false);
  assert.equal(resSwitchCash.errorCode, "PENDING_GATEWAY");
  assert.equal(db.orders[0].status, "awaiting_payment");
  assert.equal(db.ingredient_reservations[0].status, "active");
  assert.equal(db.order_allocations[0].allocation_status, "reserved");
  assert.equal(db.cancelMidtransApiCalls.length, 0);

  // Clicking "Batalkan Midtrans & Lepas Reservasi" when Midtrans rejects cancel (e.g. 412 / unsupported) -> FAIL CLOSED
  midtransMockResponses.set(mid, {
    mode: "status",
    transaction_status: "pending",
    gross_amount: "32200.00",
    status_code: "201",
    cancelFail: true,
  });
  const resCancelRejected = await paymentsActions.cancelActiveMidtransReservationAction(UUID1);
  assert.equal(resCancelRejected.ok, false);
  assert.deepEqual(db.cancelMidtransApiCalls, [mid]);
  assert.equal(db.orders[0].status, "awaiting_payment");
  assert.equal(db.ingredient_reservations[0].status, "active");
  assert.equal(db.order_allocations[0].allocation_status, "reserved");

  // Clicking "Batalkan Midtrans & Lepas Reservasi" when Midtrans Cancel API succeeds -> cancels order & releases stock
  midtransMockResponses.set(mid, {
    mode: "status",
    transaction_status: "pending",
    gross_amount: "32200.00",
    status_code: "201",
    cancelFail: false,
  });
  const resOfficial = await paymentsActions.cancelActiveMidtransReservationAction(UUID1);
  assert.equal(resOfficial.ok, true, resOfficial.message);
  assert.equal(resOfficial.data.orderCancelled, true);
  assert.deepEqual(db.cancelMidtransApiCalls, [mid, mid]);
  assert.equal(db.orders[0].status, "cancelled");
  assert.equal(db.ingredient_reservations[0].status, "released");
  assert.equal(db.order_allocations[0].allocation_status, "released");
});

await testCase("5. Order Midtrans settlement -> blocks cancellation, reconciles paid, allows KDS & receipt", async () => {
  const mid = seedMidtransOrder({ txLifecycle: "pending" });
  midtransMockResponses.set(mid, { mode: "status", transaction_status: "settlement", fraud_status: "accept", gross_amount: "32200.00", status_code: "200" });

  const cancelRes = await paymentsActions.cancelActiveMidtransReservationAction(UUID1);
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.data.wasAlreadySettled, true);
  assert.equal(cancelRes.data.orderCancelled, false);
  assert.equal(db.orders[0].status, "paid");
  assert.equal(db.orders[0].payment_status, "paid");
  assert.equal(db.ingredient_reservations[0].status, "fulfilled");
  assert.equal(db.cancelRpcCalls, 0);
});

await testCase("6. Order with unknown/timeout gateway -> FAIL-CLOSED (preserves order & stock reservation)", async () => {
  const mid = seedMidtransOrder({ txLifecycle: "pending" });
  midtransMockResponses.set(mid, { mode: "timeout" });

  const res = await paymentsActions.cancelActiveMidtransReservationAction(UUID1);
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, "GATEWAY_UNREACHABLE");
  assert.equal(db.orders[0].status, "awaiting_payment");
  assert.equal(db.ingredient_reservations[0].status, "active");
  assert.equal(db.order_allocations[0].allocation_status, "reserved");
  assert.equal(db.cancelRpcCalls, 0);
});

await testCase("7. Stale unpaid order without active Midtrans tx -> NOT auto-cancelled by age in cleanup, yet manual cashier cancel succeeds", async () => {
  seedMidtransOrder({
    orderNumber: "ORD-20261114-0001",
    txLifecycle: null,
    createdAt: "2026-11-14T01:00:00.000Z",
  });

  const cleanupRes = await staleCleanup.runSafeStaleMidtransCleanup({ dryRun: false });
  assert.equal(cleanupRes.ok, true);
  assert.equal(cleanupRes.counts.no_midtrans_history_manual_review, 1);
  assert.equal(db.orders[0].status, "awaiting_payment", "Age alone MUST NOT auto-cancel");

  const manualCancel = await ordersActions.cancelPosOrderAction(UUID1, "Pelanggan batal manual");
  assert.equal(manualCancel.ok, true);
  assert.equal(db.orders[0].status, "cancelled");
  assert.equal(db.ingredient_reservations[0].status, "released");
});

await testCase("8. Cancelled order with lingering active stock reservation -> idempotently repaired by cleanup & repeat cancel", async () => {
  seedMidtransOrder({
    status: "cancelled",
    paymentStatus: "unpaid",
    txLifecycle: null,
    withStockRes: true,
  });
  db.order_allocations.push({
    id: "alloc-lingering",
    order_id: UUID1,
    allocation_status: "reserved",
    allocated_final_amount: 32200,
  });

  const cleanupRes = await staleCleanup.runSafeStaleMidtransCleanup({ dryRun: false });
  assert.equal(cleanupRes.ok, true);
  assert.equal(cleanupRes.counts.cancelled_anomaly_repaired, 1);
  assert.equal(db.ingredient_reservations[0].status, "released");
  assert.equal(db.order_allocations[0].allocation_status, "released");
});

await testCase("9. Cancelled, unpaid, refunded, unfinalized orders NEVER enter KDS columns or inflate receipt queue count", async () => {
  // Paid target order in KDS
  seedMidtransOrder({
    id: UUID1,
    orderNumber: "ORD-PAID-NEW",
    status: "paid",
    paymentStatus: "paid",
    paidTotal: 32200,
    txLifecycle: null,
    createdAt: "2026-11-25T09:00:00.000Z",
  });
  db.orders[0].kds_status = "queued";
  db.orders[0].queue_number = "A002";

  // Earlier cancelled order with stale kds_status/queue_number anomaly
  seedMidtransOrder({
    id: UUID2,
    orderNumber: "ORD-CANCELLED-ANOMALY",
    status: "cancelled",
    paymentStatus: "unpaid",
    txLifecycle: null,
    createdAt: "2026-11-25T08:00:00.000Z",
  });
  db.orders[1].kds_status = "preparing";
  db.orders[1].queue_number = "A001";

  // Earlier unpaid order
  seedMidtransOrder({
    id: UUID3,
    orderNumber: "ORD-UNPAID-ANOMALY",
    status: "awaiting_payment",
    paymentStatus: "unpaid",
    txLifecycle: null,
    createdAt: "2026-11-25T08:30:00.000Z",
  });

  const kdsBoard = await kdsActions.getKdsBoardDataAction();
  assert.equal(kdsBoard.ok, true);
  assert.equal(kdsBoard.data.tickets.length, 1);
  assert.equal(kdsBoard.data.tickets[0].id, UUID1);
  assert.equal(kdsTransitions.isOrderVisibleInKds(db.orders[1]), false);
  assert.equal(kdsTransitions.validateKdsTransition({ orderStatus: "cancelled", currentStatus: "queued", nextStatus: "preparing" }).ok, false);

  const remainingForPaid = await paymentsActions.calculateRemainingQueueItems(supabaseMock, {
    id: UUID1,
    created_at: db.orders[0].created_at,
  });
  assert.equal(remainingForPaid, 0, "Cancelled/unpaid orders MUST NOT inflate queue count");
});

await testCase("10. Reopened cancelled order cannot repay, append, finalize, unfinalize, refund, or issue fake paid receipt", async () => {
  seedMidtransOrder({
    status: "cancelled",
    paymentStatus: "unpaid",
    isFinalized: true,
    txLifecycle: null,
  });

  const cashRes = await paymentsActions.processPosManualPaymentAction({
    orderId: UUID1,
    paymentMethod: "cash",
    paymentSource: "cash",
    amount: 32200,
    cashReceived: 32200,
    changeAmount: 0,
    idempotencyKey: "k-cash",
  });
  assert.equal(cashRes.ok, false);
  assert.equal(db.cashPaymentRpcCalls, 0);

  const snapRes = await paymentsActions.createPosMidtransSnapAction({
    orderId: UUID1,
    grossAmount: 32200,
    idempotencyKey: "k-snap",
    isSplitBill: false,
  });
  assert.equal(snapRes.ok, false);

  const finRes = await discountsActions.finalizeOrderAction({ orderId: UUID1 });
  assert.equal(finRes.ok, false);
  assert.equal(db.finalizeRpcCalls, 0);

  const unfinRes = await discountsActions.unfinalizeOrderAction({ orderId: UUID1, reason: "Tes unfinalize" });
  assert.equal(unfinRes.ok, false);
  assert.equal(db.unfinalizeRpcCalls, 0);

  const appendRes = await ordersActions.appendOrderItemsAction({
    orderId: UUID1,
    items: [{ productId: UUID2, quantity: 1 }],
  });
  assert.equal(appendRes.ok, false);

  const refundRes = await paymentsActions.processOrderRefundAction({
    orderId: UUID1,
    amount: 1000,
    refundType: "partial",
    refundMethod: "cash",
    reason: "Tes refund",
    idempotencyKey: "k-ref",
  });
  assert.equal(refundRes.ok, false);
  assert.equal(db.refundRpcCalls, 0);

  const receiptRes = await paymentsActions.getOrderReceiptDataAction(UUID1);
  assert.equal(receiptRes.ok, false);
  assert.equal(receiptRes.errorCode, "ORDER_CANCELLED");
  assert.match(receiptRes.message, /DIBATALKAN/);
  assert.equal(db.receiptRpcCalls, 0);
});

await testCase("11. Repeated cancellation clicks are strictly idempotent without errors or data corruption", async () => {
  const mid = seedMidtransOrder();
  midtransMockResponses.set(mid, { mode: "404" });

  const first = await paymentsActions.cancelActiveMidtransReservationAction(UUID1);
  const second = await paymentsActions.cancelActiveMidtransReservationAction(UUID1);
  const third = await ordersActions.cancelPosOrderAction(UUID1, "Klik berulang");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, true);
  assert.equal(first.data.orderCancelled, true);
  assert.equal(second.data.orderCancelled, true);
  assert.equal(db.cancelRpcCalls, 1, "SQL cancel RPC should only execute once");
  assert.equal(db.orders[0].status, "cancelled");
  assert.equal(db.ingredient_reservations[0].status, "released");
});

await testCase("12. Safe cleanup handles mixed stale orders batch + cron auth protection", async () => {
  const mExp = seedMidtransOrder({ id: UUID1, orderNumber: "ORD-EXPIRED", expiresAt: "2026-11-17T01:00:00Z" });
  const mSet = seedMidtransOrder({ id: UUID2, orderNumber: "ORD-SETTLED", txLifecycle: "pending" });
  const mTim = seedMidtransOrder({ id: UUID3, orderNumber: "ORD-TIMEOUT", txLifecycle: "pending" });

  midtransMockResponses.set(mExp, { mode: "404" });
  midtransMockResponses.set(mSet, { mode: "status", transaction_status: "settlement", fraud_status: "accept", gross_amount: "32200.00", status_code: "200" });
  midtransMockResponses.set(mTim, { mode: "timeout" });

  // Dry run mutates NOTHING
  const dry = await staleCleanup.runSafeStaleMidtransCleanup({ dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.counts.terminal_safe_to_cancel, 1);
  assert.equal(dry.counts.settlement_reconciled, 1);
  assert.equal(dry.counts.unknown_or_timeout_fail_closed, 1);
  assert.equal(db.orders.every((o) => o.status === "awaiting_payment"), true);

  // Execute mode reconciles settled, cancels verified expired-404, keeps timeout untouched
  const exec = await staleCleanup.runSafeStaleMidtransCleanup({ dryRun: false });
  assert.equal(exec.ok, true);
  assert.equal(db.orders.find((o) => o.id === UUID1).status, "cancelled");
  assert.equal(db.orders.find((o) => o.id === UUID2).status, "paid");
  assert.equal(db.orders.find((o) => o.id === UUID3).status, "awaiting_payment");
  assert.equal(db.ingredient_reservations.find((r) => r.order_id === UUID3).status, "active");

  // Cron route security check (unconfigured -> 503, wrong bearer -> 401)
  delete process.env.CRON_SECRET;
  const res503 = await cronRoute.GET(new Request("http://localhost/api/cron/midtrans-cleanup"));
  assert.equal(res503.status, 503);
  process.env.CRON_SECRET = "super-secret-cron-token";
  const res401 = await cronRoute.GET(new Request("http://localhost/api/cron/midtrans-cleanup", { headers: { Authorization: "Bearer wrong" } }));
  assert.equal(res401.status, 401);
});

await testCase("13. Valid active unpaid order (unexpired 404 or pending) remains intact & payable", async () => {
  const mid = seedMidtransOrder({
    expiresAt: new Date(Date.now() + 12 * 60_000).toISOString(),
  });
  midtransMockResponses.set(mid, { mode: "404" });

  const cleanup = await staleCleanup.runSafeStaleMidtransCleanup({ dryRun: false });
  assert.equal(cleanup.counts.unexpired_404_active, 1);
  assert.equal(db.orders[0].status, "awaiting_payment");
  assert.equal(db.ingredient_reservations[0].status, "active");

  // Switching explicitly via release_to_cash allows Cash payment cleanly
  const releaseRes = await paymentsActions.cancelActiveMidtransReservationAction(UUID1, { mode: "release_to_cash" });
  assert.equal(releaseRes.ok, true);
  assert.equal(releaseRes.data.orderCancelled, false);

  const cashRes = await paymentsActions.processPosManualPaymentAction({
    orderId: UUID1,
    paymentMethod: "cash",
    paymentSource: "cash",
    amount: 32200,
    cashReceived: 35000,
    changeAmount: 2800,
    idempotencyKey: "k-valid-cash",
  });
  assert.equal(cashRes.ok, true);
  assert.equal(db.orders[0].status, "paid");
});

await testCase("14. Already paid order normally enters KDS queued & transitions without disruption", async () => {
  seedMidtransOrder({
    status: "paid",
    paymentStatus: "paid",
    paidTotal: 32200,
    txLifecycle: null,
  });
  db.orders[0].kds_status = "queued";
  db.orders[0].queue_number = "A005";
  db.payments.push({
    id: "pay-1",
    order_id: UUID1,
    payment_method: "cash",
    payment_source: "cash",
    amount: 32200,
    cash_received: 32200,
    change_amount: 0,
    payment_status: "success",
    created_at: new Date().toISOString(),
  });

  const kdsBoard = await kdsActions.getKdsBoardDataAction();
  assert.equal(kdsBoard.ok, true);
  assert.equal(kdsBoard.data.tickets.length, 1);
  assert.equal(kdsBoard.data.tickets[0].kdsStatus, "queued");

  const receiptRes = await paymentsActions.getOrderReceiptDataAction(UUID1);
  assert.equal(receiptRes.ok, true);
  assert.equal(receiptRes.data.order.payment_status, "paid");
});

await testCase("15. Admin transaction sales gross metric excludes cancelled & unpaid orders + UI cancel returns to order list cleanly", async () => {
  seedMidtransOrder({
    id: UUID1,
    orderNumber: "ORD-PAID-METRIC",
    status: "paid",
    paymentStatus: "paid",
    grandTotal: 50000,
    paidTotal: 50000,
    txLifecycle: null,
    createdAt: "2026-11-25T10:00:00.000Z",
  });
  seedMidtransOrder({
    id: UUID2,
    orderNumber: "ORD-CANCELLED-METRIC",
    status: "cancelled",
    paymentStatus: "unpaid",
    grandTotal: 32200,
    paidTotal: 0,
    txLifecycle: null,
    createdAt: "2026-11-25T10:01:00.000Z",
  });
  seedMidtransOrder({
    id: UUID3,
    orderNumber: "ORD-UNPAID-METRIC",
    status: "awaiting_payment",
    paymentStatus: "unpaid",
    grandTotal: 25000,
    paidTotal: 0,
    txLifecycle: null,
    createdAt: "2026-11-25T10:02:00.000Z",
  });

  const txRes = await transactionsActions.getAdminTransactionsAction({ page: 1, pageSize: 20 });
  assert.equal(txRes.ok, true, txRes.message);
  assert.equal(txRes.data.metricSummary.totalAmountSum, 50000, "Cancelled & unpaid awaiting_payment MUST NOT inflate Gross Sales metric");
  assert.equal(txRes.data.metricSummary.paidAmountSum, 50000);

  const paymentModalSrc = fs.readFileSync(path.join(ROOT, "src/components/pos/payment-modal.tsx"), "utf8");
  const boardSrc = fs.readFileSync(path.join(ROOT, "src/components/pos/cashier-orders-board.tsx"), "utf8");
  const posSrc = fs.readFileSync(path.join(ROOT, "src/components/pos/pos-container.tsx"), "utf8");
  assert.match(paymentModalSrc, /onOrderCancelled\?\.\(order\.id\)/);
  assert.match(boardSrc, /onOrderCancelled=\{\(\)\s*=>/);
  assert.match(posSrc, /onOrderCancelled=\{\(\)\s*=>/);
});

console.log(`\nALL ${passed}/${total} MANDATORY SCENARIO TESTS PASSED 100%.`);
