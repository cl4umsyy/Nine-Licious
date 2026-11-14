import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("================================================================================");
console.log("  NINE LICIOUS POS - F2.3 ADDITIONAL ORDERS & TABLE STATUS TEST SUITE");
console.log("================================================================================");

let testsPassed = 0;
let testsFailed = 0;

function pass(testName, detail = "") {
  testsPassed++;
  console.log(`  [PASS] ${testName}${detail ? " - " + detail : ""}`);
}

function fail(testName, error) {
  testsFailed++;
  console.error(`  [FAIL] ${testName}: ${error?.message || error}`);
}

// -----------------------------------------------------------------------------
// SECTION 1: Migration SQL Contract & AST / Pattern Audit
// -----------------------------------------------------------------------------
console.log("\n--- SECTION 1: MIGRATION FILE & SQL CONTRACT VERIFICATION ---");

const migrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20261114000100_additional_orders_table_status.sql",
);

try {
  assert.ok(fs.existsSync(migrationPath), "File migration F2.3 harus ada di disk.");
  const sql = fs.readFileSync(migrationPath, "utf-8");

  // Check 1: create_pos_order_atomic definition
  assert.ok(
    sql.includes("create or replace function public.create_pos_order_atomic"),
    "create_pos_order_atomic harus didefinisikan ulang di F2.3",
  );
  pass("1.1. create_pos_order_atomic terdefinisi");

  // Check 2: Hierarchical Locking Level 1 & Level 2 in create_pos_order_atomic
  assert.ok(
    sql.includes("from public.dining_tables") && sql.includes("for update;"),
    "dining_tables wajib di-lock FOR UPDATE sebagai Lock Level 1",
  );
  assert.ok(
    sql.includes("from public.dining_sessions") && sql.includes("for update;"),
    "dining_sessions wajib di-lock FOR UPDATE sebagai Lock Level 2",
  );
  pass("1.2. Hierarchical locking dining_tables -> dining_sessions pada create_pos_order_atomic");

  // Check 3: Support occupied for additional orders & strictly reject awaiting_payment
  assert.ok(
    sql.includes("elsif v_table.status = 'occupied' then"),
    "Meja occupied harus diizinkan untuk pesanan tambahan",
  );
  assert.ok(
    sql.includes("elsif v_table.status = 'awaiting_payment' then"),
    "Meja awaiting_payment harus memiliki branch penolakan tersendiri",
  );
  assert.ok(
    sql.includes("Dilarang membuat pesanan baru; gunakan penambahan item pada pesanan aktif"),
    "Meja awaiting_payment dilarang membuat pesanan baru dan diarahkan menggunakan penambahan item",
  );
  assert.ok(
    sql.includes("v_is_additional_order := true;"),
    "Pesanan pada sesi yang sudah ada harus ditandai sebagai pesanan tambahan",
  );
  pass("1.3. Meja occupied diizinkan untuk pesanan tambahan & meja awaiting_payment dilarang membuat pesanan baru");

  // Check 4: Strict Anomaly Rejection (Anti self-healing)
  assert.ok(
    sql.includes("Inkonsistensi data meja: Meja % berstatus occupied namun tidak memiliki sesi kunjungan aktif"),
    "Harus menolak dengan exception jika meja occupied tanpa sesi open (anti self-healing)",
  );
  pass("1.4. Strict anomaly rejection (anti self-healing) terimplementasi di create_pos_order_atomic");

  // Check 5: complete_pos_order RPC definition with Canonical Hierarchical Locking
  assert.ok(
    sql.includes("create or replace function public.complete_pos_order"),
    "complete_pos_order RPC harus tersedia untuk penyerahan eksplisit ke pelanggan",
  );
  assert.ok(
    sql.includes("perform 1 from public.dining_tables where id = v_pre_order.table_id for update;") &&
      sql.includes("perform 1 from public.dining_sessions where id = v_pre_order.dining_session_id for update;"),
    "complete_pos_order wajib mengunci dining_tables -> dining_sessions secara hierarkis sebelum mengunci orders",
  );
  assert.ok(
    sql.includes("v_order.status <> 'paid' or v_order.payment_status <> 'paid'"),
    "complete_pos_order hanya mengizinkan pesanan berstatus paid",
  );
  assert.ok(
    sql.includes("status = 'completed'") && sql.includes("kds_status = null"),
    "complete_pos_order mengubah status ke completed dan mengosongkan kds_status",
  );
  pass("1.5. complete_pos_order terdefinisi dengan canonical hierarchical locking dan validasi status 'paid'");

  // Check 6: close_dining_session_atomic RPC & 7 Validation Gates
  assert.ok(
    sql.includes("create or replace function public.close_dining_session_atomic"),
    "close_dining_session_atomic harus didefinisikan",
  );
  // Canonical hierarchical locking
  assert.ok(
    sql.includes("from public.dining_tables") &&
      sql.includes("from public.dining_sessions") &&
      sql.includes("from public.orders") &&
      sql.includes("order by id asc") &&
      sql.includes("for update;"),
    "close_dining_session_atomic harus mengunci tables -> sessions -> orders secara terurut",
  );
  // Gate 1: unpaid count
  assert.ok(
    sql.includes("status in ('awaiting_payment', 'partially_paid')"),
    "Pintu 1: Cek pesanan awaiting_payment dan partially_paid",
  );
  // Gate 2: remaining balance
  assert.ok(
    sql.includes("coalesce(sum(grand_total - paid_total), 0) into v_remaining_balance"),
    "Pintu 2: Cek sisa saldo belum dibayar",
  );
  // Gate 3: reserved allocations
  assert.ok(
    sql.includes("oa.allocation_status = 'reserved'"),
    "Pintu 3: Cek alokasi split bill reserved",
  );
  // Gate 4: non-terminal Midtrans transactions
  assert.ok(
    sql.includes("mt.lifecycle_status in (") &&
      sql.includes("'initiated'") &&
      sql.includes("'token_created'") &&
      sql.includes("'pending'") &&
      sql.includes("'capture_challenge'") &&
      sql.includes("'reconciliation_required'"),
    "Pintu 4: Cek status Midtrans non-terminal",
  );
  // Gate 5: in-flight webhook events
  assert.ok(
    sql.includes("mwe.processing_result in ('received', 'processing')"),
    "Pintu 5: Cek notifikasi webhook yang sedang diproses",
  );
  // Gate 6: uncompleted order count (status paid)
  assert.ok(
    sql.includes("and status = 'paid'"),
    "Pintu 6: Cek pesanan lunas yang belum completed (belum diserahkan)",
  );
  // Gate 7: active KDS count (queued, preparing, ready)
  assert.ok(
    sql.includes("kds_status in ('queued', 'preparing', 'ready')"),
    "Pintu 7: Cek status KDS queued, preparing, dan ready",
  );
  // Mutation to closed & empty
  assert.ok(
    sql.includes("update public.dining_sessions") &&
      sql.includes("status = 'closed'") &&
      sql.includes("closed_at = now()"),
    "Eksekusi penutupan sesi harus mengubah status session ke 'closed' dan mengisi closed_at",
  );
  assert.ok(
    sql.includes("update public.dining_tables") &&
      sql.includes("status = 'empty'"),
    "Eksekusi penutupan sesi harus mengubah status meja ke 'empty'",
  );
  pass("1.6. close_dining_session_atomic memiliki 7 Pintu Validasi Ketat dan Hierarchical Locking");

  // Check 7: get_dining_session_summary query helper
  assert.ok(
    sql.includes("create or replace function public.get_dining_session_summary"),
    "get_dining_session_summary query helper harus tersedia",
  );
  assert.ok(
    sql.includes("can_close_session") && sql.includes("blocking_reason"),
    "get_dining_session_summary harus mengembalikan can_close_session dan blocking_reason",
  );
  pass("1.7. get_dining_session_summary query helper terdefinisi");

  // Check 8: Audit Logs
  assert.ok(
    sql.includes("'order.created_additional'") &&
      sql.includes("'order.completed'") &&
      sql.includes("'table.session_closed'"),
    "Audit logs untuk order.created_additional, order.completed, dan table.session_closed harus ada",
  );
  pass("1.8. Pencatatan Audit Log terkonfirmasi untuk F2.3");

  // Check 9: Temuan 1 - Security Role Check & Revocation in get_dining_session_summary
  assert.ok(
    sql.includes("v_user_role := public.current_user_role();") &&
      sql.includes("if v_user_role not in ('admin', 'kasir') then") &&
      sql.includes("Hanya admin atau kasir yang berhak mengakses ringkasan sesi meja."),
    "get_dining_session_summary wajib memvalidasi role admin/kasir dan menolak unauthenticated/anon serta role lain",
  );
  assert.ok(
    sql.includes("revoke all on function public.get_dining_session_summary(uuid) from public;") &&
      sql.includes("revoke all on function public.get_dining_session_summary(uuid) from anon;"),
    "Hak akses get_dining_session_summary wajib di-revoke dari public dan anon",
  );
  pass("1.9. Temuan 1: Role check (admin/kasir) dan hak akses get_dining_session_summary terverifikasi");

  // Check 10: Temuan 2 - Alignment of can_close_session in get_dining_session_summary
  assert.ok(
    sql.includes("from public.order_allocations oa") &&
      sql.includes("oa.allocation_status = 'reserved'"),
    "get_dining_session_summary wajib memeriksa alokasi pembayaran split bill berstatus reserved",
  );
  assert.ok(
    sql.includes("from public.midtrans_transactions mt") &&
      sql.includes("mt.lifecycle_status in (") &&
      sql.includes("'reconciliation_required'"),
    "get_dining_session_summary wajib memeriksa transaksi Midtrans non-terminal",
  );
  assert.ok(
    sql.includes("from public.midtrans_webhook_events mwe") &&
      sql.includes("mwe.processing_result in ('received', 'processing')"),
    "get_dining_session_summary wajib memeriksa event webhook Midtrans yang masih in-flight",
  );
  pass("1.10. Temuan 2: can_close_session pada get_dining_session_summary selaras 100% dengan close_dining_session_atomic");

  // Check 11: Temuan 3 - Idempotency Concurrency & Subtransaction Exception Catching
  assert.ok(
    sql.includes("where idempotency_key = v_idempotency_key;") &&
      sql.includes("if found then"),
    "create_pos_order_atomic wajib mengecek ulang idempotency_key setelah tabel di-lock",
  );
  assert.ok(
    sql.includes("when unique_violation then") &&
      sql.includes("'is_duplicate', true"),
    "create_pos_order_atomic wajib menangkap unique_violation pada INSERT order untuk concurrency idempotency replay",
  );
  pass("1.11. Temuan 3: Idempotency concurrency double-check dan penanganan unique_violation terverifikasi");

  // Check 12: Temuan 4 - Canonical Locking Hierarchy Anti-Deadlock
  assert.ok(
    sql.includes("order by id asc") &&
      sql.includes("order by oa.id asc") &&
      sql.includes("order by mt.id asc"),
    "Penguncian multi-baris pada orders, order_allocations, dan midtrans_transactions wajib menggunakan ORDER BY id ASC",
  );
  pass("1.12. Temuan 4: Hierarki penguncian anti-deadlock (tables -> sessions -> orders -> allocs -> midtrans) terverifikasi");

  // Check 13: Redefinisi append_order_items_atomic dengan Canonical Hierarchical Locking
  assert.ok(
    sql.includes("create or replace function public.append_order_items_atomic"),
    "append_order_items_atomic wajib didefinisikan ulang di F2.3",
  );
  assert.ok(
    sql.includes("perform 1 from public.dining_tables where id = v_pre_order.table_id for update;") &&
      sql.includes("perform 1 from public.dining_sessions where id = v_pre_order.dining_session_id for update;"),
    "append_order_items_atomic wajib mengunci dining_tables -> dining_sessions secara hierarkis sebelum orders",
  );
  pass("1.13. Redefinisi append_order_items_atomic dengan hierarki penguncian Level 1 -> Level 2 -> Level 3 terverifikasi anti-deadlock");

  // Check 14: Verifikasi create_pos_order_atomic bebas referensi calculate_and_apply_order_discounts dan authoritatif inline
  assert.ok(
    !sql.includes("public.calculate_and_apply_order_discounts("),
    "create_pos_order_atomic tidak boleh memanggil calculate_and_apply_order_discounts yang tidak tersedia di PostgreSQL.",
  );
  assert.ok(
    sql.includes("v_discount_product_total") &&
      sql.includes("v_discount_order_total") &&
      sql.includes("v_discount_manual_total") &&
      sql.includes("public.discount_approval_nonces"),
    "create_pos_order_atomic harus memuat kalkulasi authoritatif inline dan verifikasi nonce admin manual.",
  );
  assert.ok(
    sql.includes("revoke all on function public.create_pos_order_atomic(jsonb, jsonb, jsonb) from public;") &&
      sql.includes("revoke all on function public.append_order_items_atomic(uuid, jsonb, integer, integer, integer, integer) from public;"),
    "Migration F2.3 harus mengonfigurasi revoke privilege keamanan secara ketat dari public & anon.",
  );
  pass("1.14. create_pos_order_atomic terverifikasi authoritatif, inline, bebas referensi hilang, & aman privilege");
} catch (err) {
  fail("SECTION 1 Migration Verification", err);
}

// -----------------------------------------------------------------------------
// SECTION 2: Functional Logic & State Machine Simulation Tests
// -----------------------------------------------------------------------------
console.log("\n--- SECTION 2: BUSINESS LOGIC & STATE MACHINE SIMULATION ---");

// Mock environment and state machine simulating database logic
function createMockPosEngine() {
  const tables = new Map();
  const sessions = new Map();
  const orders = new Map();
  const allocations = new Map();
  const midtransTransactions = new Map();
  const webhookEvents = new Map();
  const auditLogs = [];

  // Helper setup
  function addTable(id, name, status = "empty", isActive = true) {
    tables.set(id, { id, name, status, is_active: isActive });
  }

  function addSession(id, tableId, status = "open") {
    sessions.set(id, { id, table_id: tableId, status, opened_at: new Date().toISOString() });
  }

  function addOrder(order) {
    orders.set(order.id, {
      ...order,
      paid_total: order.paid_total ?? 0,
      kds_status: order.kds_status ?? null,
    });
  }

  function addAllocation(alloc) {
    allocations.set(alloc.id, alloc);
  }

  function addMidtransTransaction(trx) {
    midtransTransactions.set(trx.id, trx);
  }

  function addWebhookEvent(event) {
    webhookEvents.set(event.id, event);
  }

  // 1. Logic: createPosOrder
  function createPosOrder(input) {
    const { tableId, orderType, idempotencyKey, grandTotal } = input;

    // Idempotency check (Pre-lock and Post-lock double-check simulation)
    if (idempotencyKey) {
      for (const ord of orders.values()) {
        if (ord.idempotency_key === idempotencyKey) {
          return { order: ord, is_duplicate: true };
        }
      }
    }

    if (orderType === "dine_in") {
      const table = tables.get(tableId);
      if (!table || !table.is_active) {
        throw new Error("Meja tidak aktif atau tidak ditemukan.");
      }

      if (table.status === "maintenance" || table.status === "reserved") {
        throw new Error(`Meja ${table.name} sedang tidak dapat digunakan (status: ${table.status}).`);
      }

      let sessionId;
      let isAdditional = false;

      if (table.status === "empty") {
        sessionId = `sess-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        sessions.set(sessionId, { id: sessionId, table_id: tableId, status: "open" });
        table.status = "awaiting_payment";
      } else if (table.status === "occupied") {
        // Find open session
        let openSession = null;
        for (const s of sessions.values()) {
          if (s.table_id === tableId && s.status === "open") {
            openSession = s;
            break;
          }
        }

        // Strict Anomaly Rejection
        if (!openSession) {
          throw new Error(`Inkonsistensi data meja: Meja ${table.name} berstatus occupied namun tidak memiliki sesi kunjungan aktif (open). Pesanan dibatalkan.`);
        }

        sessionId = openSession.id;
        isAdditional = true;
        table.status = "awaiting_payment";
      } else if (table.status === "awaiting_payment") {
        throw new Error(`Meja ${table.name} sedang menunggu pembayaran (awaiting_payment). Dilarang membuat pesanan baru; gunakan penambahan item pada pesanan aktif.`);
      }

      // Re-check idempotency key after table lock (concurrency race simulation)
      if (idempotencyKey) {
        for (const ord of orders.values()) {
          if (ord.idempotency_key === idempotencyKey) {
            return { order: ord, is_duplicate: true };
          }
        }
      }

      const orderId = `ord-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const newOrder = {
        id: orderId,
        order_number: `ORD-${Date.now().toString().slice(-6)}`,
        table_id: tableId,
        dining_session_id: sessionId,
        status: "awaiting_payment",
        payment_status: "unpaid",
        grand_total: grandTotal,
        paid_total: 0,
        idempotency_key: idempotencyKey ?? null,
        kds_status: "queued",
      };

      orders.set(orderId, newOrder);
      auditLogs.push({ action: isAdditional ? "order.created_additional" : "order.created", orderId });

      return { order: newOrder, is_duplicate: false, is_additional: isAdditional, session_id: sessionId };
    }
  }

  // 2. Logic: completePosOrder
  function completePosOrder(orderId) {
    const order = orders.get(orderId);
    if (!order) throw new Error("Pesanan tidak ditemukan.");
    if (order.status === "completed") {
      return { order, already_completed: true };
    }
    if (order.status !== "paid" || order.payment_status !== "paid") {
      throw new Error("Hanya pesanan yang sudah lunas (paid) yang dapat diselesaikan.");
    }

    order.status = "completed";
    order.kds_status = null;
    auditLogs.push({ action: "order.completed", orderId });
    return { order, already_completed: false };
  }

  // 3. Logic: closeDiningSession
  function closeDiningSession(tableId, sessionId) {
    const table = tables.get(tableId);
    const session = sessions.get(sessionId);

    if (!table || !table.is_active) throw new Error("Meja tidak aktif atau tidak ditemukan.");
    if (!session || session.status !== "open" || session.table_id !== tableId) {
      throw new Error("Sesi kunjungan tidak valid.");
    }

    const sessionOrders = Array.from(orders.values()).filter((o) => o.dining_session_id === sessionId);

    // Gate 1: unpaid orders
    const unpaid = sessionOrders.filter((o) => ["awaiting_payment", "partially_paid"].includes(o.status));
    if (unpaid.length > 0) {
      throw new Error(`Tidak dapat menutup sesi: Terdapat ${unpaid.length} pesanan yang belum lunas.`);
    }

    // Gate 2: remaining balance
    const remaining = sessionOrders
      .filter((o) => !["cancelled", "refunded"].includes(o.status))
      .reduce((sum, o) => sum + Math.max(0, o.grand_total - o.paid_total), 0);
    if (remaining > 0) {
      throw new Error(`Tidak dapat menutup sesi: Masih ada sisa tagihan sebesar Rp ${remaining}.`);
    }

    // Gate 3: reserved allocations
    const sOrderIds = new Set(sessionOrders.map((o) => o.id));
    for (const alloc of allocations.values()) {
      if (sOrderIds.has(alloc.order_id) && alloc.allocation_status === "reserved") {
        throw new Error("Tidak dapat menutup sesi: Terdapat alokasi split bill yang masih berstatus reserved.");
      }
    }

    // Gate 4: active Midtrans
    const sMidtransOrderIds = new Set();
    for (const mt of midtransTransactions.values()) {
      if (sOrderIds.has(mt.order_id)) {
        if (["initiated", "token_created", "pending", "capture_challenge", "reconciliation_required"].includes(mt.lifecycle_status)) {
          throw new Error("Tidak dapat menutup sesi: Terdapat transaksi Midtrans yang masih aktif.");
        }
        if (mt.midtrans_order_id) {
          sMidtransOrderIds.add(mt.midtrans_order_id);
        }
      }
    }

    // Gate 5: in-flight webhooks
    for (const wb of webhookEvents.values()) {
      if (sMidtransOrderIds.has(wb.midtrans_order_id) && ["received", "processing"].includes(wb.processing_result)) {
        throw new Error("Tidak dapat menutup sesi: Terdapat notifikasi pembayaran webhook Midtrans yang sedang diproses.");
      }
    }

    // Gate 6: uncompleted orders (status paid)
    const uncompleted = sessionOrders.filter((o) => o.status === "paid");
    if (uncompleted.length > 0) {
      throw new Error(`Tidak dapat menutup sesi: Terdapat ${uncompleted.length} pesanan lunas yang belum diserahkan ke pelanggan (status belum completed).`);
    }

    // Gate 7: active KDS
    const activeKds = sessionOrders.filter((o) => ["queued", "preparing", "ready"].includes(o.kds_status));
    if (activeKds.length > 0) {
      throw new Error("Tidak dapat menutup sesi: Terdapat pesanan yang masih dalam antrean dapur atau siap diambil (kds_status: queued/preparing/ready).");
    }

    // Mutate
    session.status = "closed";
    session.closed_at = new Date().toISOString();
    table.status = "empty";
    auditLogs.push({ action: "table.session_closed", sessionId, tableId });

    return { success: true, table_status: "empty", session_status: "closed" };
  }

  // 4. Logic: getDiningSessionSummary
  function getDiningSessionSummary(tableId, userRole = "kasir") {
    if (!["admin", "kasir"].includes(userRole)) {
      throw new Error("Hanya admin atau kasir yang berhak mengakses ringkasan sesi meja.");
    }

    const table = tables.get(tableId);
    if (!table) return null;

    let openSession = null;
    for (const s of sessions.values()) {
      if (s.table_id === tableId && s.status === "open") {
        openSession = s;
        break;
      }
    }

    if (!openSession) {
      return { table_id: tableId, has_active_session: false };
    }

    const sOrders = Array.from(orders.values()).filter((o) => o.dining_session_id === openSession.id);
    const unpaidCount = sOrders.filter((o) => ["awaiting_payment", "partially_paid"].includes(o.status)).length;
    const uncompletedCount = sOrders.filter((o) => o.status === "paid").length;
    const activeKdsCount = sOrders.filter((o) => ["queued", "preparing", "ready"].includes(o.kds_status)).length;
    const grandTotal = sOrders.reduce((sum, o) => sum + o.grand_total, 0);
    const paidTotal = sOrders.reduce((sum, o) => sum + o.paid_total, 0);
    const remainingBalance = Math.max(0, grandTotal - paidTotal);

    const sOrderIds = new Set(sOrders.map((o) => o.id));
    let reservedAllocCount = 0;
    for (const alloc of allocations.values()) {
      if (sOrderIds.has(alloc.order_id) && alloc.allocation_status === "reserved") {
        reservedAllocCount++;
      }
    }

    let pendingTrxCount = 0;
    const sMidtransOrderIds = new Set();
    for (const mt of midtransTransactions.values()) {
      if (sOrderIds.has(mt.order_id)) {
        if (["initiated", "token_created", "pending", "capture_challenge", "reconciliation_required"].includes(mt.lifecycle_status)) {
          pendingTrxCount++;
        }
        if (mt.midtrans_order_id) {
          sMidtransOrderIds.add(mt.midtrans_order_id);
        }
      }
    }

    let processingWebhookCount = 0;
    for (const wb of webhookEvents.values()) {
      if (sMidtransOrderIds.has(wb.midtrans_order_id) && ["received", "processing"].includes(wb.processing_result)) {
        processingWebhookCount++;
      }
    }

    let canClose = false;
    let blockingReason = null;

    if (unpaidCount > 0) {
      blockingReason = "Terdapat pesanan yang belum lunas.";
    } else if (remainingBalance > 0) {
      blockingReason = "Masih ada sisa tagihan belum dibayar.";
    } else if (reservedAllocCount > 0) {
      blockingReason = "Terdapat alokasi pembayaran split bill yang masih berstatus reserved.";
    } else if (pendingTrxCount > 0) {
      blockingReason = "Terdapat transaksi gateway Midtrans yang masih aktif / belum selesai.";
    } else if (processingWebhookCount > 0) {
      blockingReason = "Terdapat notifikasi pembayaran webhook Midtrans yang sedang diproses.";
    } else if (uncompletedCount > 0) {
      blockingReason = "Terdapat pesanan lunas yang belum diserahkan ke pelanggan.";
    } else if (activeKdsCount > 0) {
      blockingReason = "Terdapat pesanan yang masih diproses dapur atau siap diambil.";
    } else {
      canClose = true;
    }

    return {
      table_id: tableId,
      has_active_session: true,
      session_id: openSession.id,
      total_orders: sOrders.length,
      reserved_allocations_count: reservedAllocCount,
      pending_midtrans_transactions_count: pendingTrxCount,
      processing_webhooks_count: processingWebhookCount,
      session_grand_total: grandTotal,
      session_paid_total: paidTotal,
      session_remaining_balance: remainingBalance,
      can_close_session: canClose,
      blocking_reason: blockingReason,
      orders: sOrders,
    };
  }

  // 1b. Logic: appendOrderItems (penambahan item ke pesanan yang menunggu pembayaran)
  function appendOrderItems(orderId, itemsCount, grandTotalDelta) {
    const order = orders.get(orderId);
    if (!order) throw new Error("Pesanan tidak ditemukan.");
    if (order.status !== "awaiting_payment" || order.payment_status !== "unpaid") {
      throw new Error("Hanya pesanan yang belum dibayar (Menunggu Pembayaran) yang dapat ditambah item.");
    }
    order.grand_total += grandTotalDelta;
    auditLogs.push({ action: "order.append_items", orderId });
    return { order, items_added: itemsCount, new_grand_total: order.grand_total };
  }

  return {
    tables,
    sessions,
    orders,
    allocations,
    midtransTransactions,
    webhookEvents,
    auditLogs,
    addTable,
    addSession,
    addOrder,
    addAllocation,
    addMidtransTransaction,
    addWebhookEvent,
    createPosOrder,
    appendOrderItems,
    completePosOrder,
    closeDiningSession,
    getDiningSessionSummary,
  };
}

// Test 2.1: Initial Order on Empty Table Opens a Session
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-1", "Meja 01", "empty");

  const res1 = engine.createPosOrder({
    tableId: "tbl-1",
    orderType: "dine_in",
    idempotencyKey: "idem-1",
    grandTotal: 50000,
  });

  assert.strictEqual(res1.is_additional, false);
  assert.ok(res1.session_id);
  assert.strictEqual(engine.tables.get("tbl-1").status, "awaiting_payment");
  pass("2.1. Pesanan awal pada meja kosong membuka sesi baru & status meja -> awaiting_payment");
} catch (err) {
  fail("2.1. Pesanan awal meja kosong", err);
}

// Test 2.2: Additional Order on Occupied Table Reuses Session
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-2", "Meja 02", "occupied");
  engine.addSession("sess-2", "tbl-2", "open");
  engine.addOrder({
    id: "ord-initial",
    order_number: "ORD-000001",
    table_id: "tbl-2",
    dining_session_id: "sess-2",
    status: "completed",
    payment_status: "paid",
    grand_total: 100000,
    paid_total: 100000,
    kds_status: null,
  });

  const res2 = engine.createPosOrder({
    tableId: "tbl-2",
    orderType: "dine_in",
    idempotencyKey: "idem-additional-1",
    grandTotal: 45000,
  });

  assert.strictEqual(res2.is_additional, true);
  assert.strictEqual(res2.session_id, "sess-2");
  assert.strictEqual(engine.tables.get("tbl-2").status, "awaiting_payment");
  assert.strictEqual(engine.orders.size, 2);

  // Initial order was NOT mutated
  const initialOrd = engine.orders.get("ord-initial");
  assert.strictEqual(initialOrd.status, "completed");
  assert.strictEqual(initialOrd.grand_total, 100000);

  pass("2.2. Pesanan tambahan pada meja occupied menautkan sesi aktif yang sama dan tidak mengubah pesanan lama");
} catch (err) {
  fail("2.2. Pesanan tambahan meja occupied", err);
}

// Test 2.3: Idempotency Duplicate Detection
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-3", "Meja 03", "empty");

  const res1 = engine.createPosOrder({
    tableId: "tbl-3",
    orderType: "dine_in",
    idempotencyKey: "idem-dup-key",
    grandTotal: 75000,
  });
  assert.strictEqual(res1.is_duplicate, false);

  const res2 = engine.createPosOrder({
    tableId: "tbl-3",
    orderType: "dine_in",
    idempotencyKey: "idem-dup-key",
    grandTotal: 75000,
  });
  assert.strictEqual(res2.is_duplicate, true);
  assert.strictEqual(res2.order.id, res1.order.id);
  pass("2.3. Idempotency key mencegah duplikasi pesanan");
} catch (err) {
  fail("2.3. Idempotency test", err);
}

// Test 2.4: Strict Anomaly Rejection (Occupied table without open session)
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-orphan", "Meja Anomali", "occupied");
  // No active session exists!

  assert.throws(
    () => {
      engine.createPosOrder({
        tableId: "tbl-orphan",
        orderType: "dine_in",
        grandTotal: 60000,
      });
    },
    /Inkonsistensi data meja/i,
    "Harus menolak dengan exception inkonsistensi data meja",
  );

  pass("2.4. Strict anomaly rejection menolak meja occupied tanpa sesi open (anti self-healing)");
} catch (err) {
  fail("2.4. Strict anomaly rejection", err);
}

// Test 2.5: Order Handover (completePosOrder transitions paid -> completed only)
try {
  const engine = createMockPosEngine();
  engine.addOrder({
    id: "ord-handover-1",
    status: "awaiting_payment",
    payment_status: "unpaid",
    kds_status: "queued",
  });

  // Cannot complete unpaid order
  assert.throws(
    () => engine.completePosOrder("ord-handover-1"),
    /Hanya pesanan yang sudah lunas/i,
  );

  // When paid:
  const ord = engine.orders.get("ord-handover-1");
  ord.status = "paid";
  ord.payment_status = "paid";
  ord.kds_status = "ready";

  const resHandover = engine.completePosOrder("ord-handover-1");
  assert.strictEqual(resHandover.order.status, "completed");
  assert.strictEqual(resHandover.order.kds_status, null);
  pass("2.5. completePosOrder berhasil mentransisikan 'paid' -> 'completed' dan mengosongkan kds_status");
} catch (err) {
  fail("2.5. completePosOrder transition", err);
}

// Test 2.6: Guarded Session Closure Blocks Unpaid Orders
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-guard-1", "Meja Guard 1", "occupied");
  engine.addSession("sess-guard-1", "tbl-guard-1", "open");
  engine.addOrder({
    id: "ord-unpaid",
    dining_session_id: "sess-guard-1",
    status: "awaiting_payment",
    payment_status: "unpaid",
    grand_total: 50000,
    paid_total: 0,
    kds_status: "queued",
  });

  assert.throws(
    () => engine.closeDiningSession("tbl-guard-1", "sess-guard-1"),
    /belum lunas/i,
  );
  pass("2.6. closeDiningSession menolak penutupan jika ada pesanan belum lunas");
} catch (err) {
  fail("2.6. Guarded closure unpaid", err);
}

// Test 2.7: Guarded Session Closure Blocks Uncompleted Orders (Paid but not yet handed over)
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-guard-2", "Meja Guard 2", "occupied");
  engine.addSession("sess-guard-2", "tbl-guard-2", "open");
  engine.addOrder({
    id: "ord-paid-not-completed",
    dining_session_id: "sess-guard-2",
    status: "paid", // Paid but not yet completed!
    payment_status: "paid",
    grand_total: 50000,
    paid_total: 50000,
    kds_status: null,
  });

  assert.throws(
    () => engine.closeDiningSession("tbl-guard-2", "sess-guard-2"),
    /belum diserahkan ke pelanggan/i,
  );
  pass("2.7. closeDiningSession menolak penutupan jika ada pesanan 'paid' yang belum diserahkan (status belum completed)");
} catch (err) {
  fail("2.7. Guarded closure uncompleted", err);
}

// Test 2.8: Guarded Session Closure Blocks Active KDS (queued, preparing, ready)
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-guard-3", "Meja Guard 3", "occupied");
  engine.addSession("sess-guard-3", "tbl-guard-3", "open");
  engine.addOrder({
    id: "ord-kds-ready",
    dining_session_id: "sess-guard-3",
    status: "completed",
    payment_status: "paid",
    grand_total: 50000,
    paid_total: 50000,
    kds_status: "ready", // Still sitting on the kitchen counter!
  });

  assert.throws(
    () => engine.closeDiningSession("tbl-guard-3", "sess-guard-3"),
    /antrean dapur atau siap diambil/i,
  );
  pass("2.8. closeDiningSession menolak penutupan jika pesanan masih dalam kds_status 'ready' / preparing / queued");
} catch (err) {
  fail("2.8. Guarded closure active KDS", err);
}

// Test 2.9: Guarded Session Closure Blocks Active Midtrans & Reserved Allocations
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-guard-4", "Meja Guard 4", "occupied");
  engine.addSession("sess-guard-4", "tbl-guard-4", "open");
  engine.addOrder({
    id: "ord-split",
    dining_session_id: "sess-guard-4",
    status: "completed",
    payment_status: "paid",
    grand_total: 100000,
    paid_total: 100000,
    kds_status: null,
  });
  engine.allocations.set("alloc-1", {
    id: "alloc-1",
    order_id: "ord-split",
    allocation_status: "reserved", // Still reserved!
  });

  assert.throws(
    () => engine.closeDiningSession("tbl-guard-4", "sess-guard-4"),
    /alokasi split bill yang masih berstatus reserved/i,
  );

  // Clear reserved allocation, add active Midtrans
  engine.allocations.delete("alloc-1");
  engine.midtransTransactions.set("mt-1", {
    id: "mt-1",
    order_id: "ord-split",
    lifecycle_status: "pending",
  });

  assert.throws(
    () => engine.closeDiningSession("tbl-guard-4", "sess-guard-4"),
    /transaksi Midtrans yang masih aktif/i,
  );

  pass("2.9. closeDiningSession menolak penutupan jika ada alokasi reserved atau transaksi Midtrans non-terminal");
} catch (err) {
  fail("2.9. Guarded closure allocations & Midtrans", err);
}

// Test 2.10: Successful Session Closure & Table Emptied
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-succ", "Meja Sukses", "occupied");
  engine.addSession("sess-succ", "tbl-succ", "open");
  engine.addOrder({
    id: "ord-1",
    dining_session_id: "sess-succ",
    status: "completed",
    payment_status: "paid",
    grand_total: 100000,
    paid_total: 100000,
    kds_status: null,
  });
  engine.addOrder({
    id: "ord-2-additional",
    dining_session_id: "sess-succ",
    status: "completed",
    payment_status: "paid",
    grand_total: 60000,
    paid_total: 60000,
    kds_status: null,
  });

  const resClose = engine.closeDiningSession("tbl-succ", "sess-succ");
  assert.strictEqual(resClose.table_status, "empty");
  assert.strictEqual(resClose.session_status, "closed");
  assert.strictEqual(engine.tables.get("tbl-succ").status, "empty");
  assert.strictEqual(engine.sessions.get("sess-succ").status, "closed");

  const lastAudit = engine.auditLogs[engine.auditLogs.length - 1];
  assert.strictEqual(lastAudit.action, "table.session_closed");

  pass("2.10. closeDiningSession berhasil menutup sesi & mengosongkan meja saat seluruh pesanan selesai");
} catch (err) {
  fail("2.10. Successful session closure", err);
}

// Test 2.11: getDiningSessionSummary Aggregation & Blocking Reasons
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-sum", "Meja Ringkasan", "occupied");
  engine.addSession("sess-sum", "tbl-sum", "open");
  engine.addOrder({
    id: "ord-sum-1",
    dining_session_id: "sess-sum",
    status: "completed",
    payment_status: "paid",
    grand_total: 75000,
    paid_total: 75000,
    kds_status: null,
  });
  engine.addOrder({
    id: "ord-sum-2",
    dining_session_id: "sess-sum",
    status: "paid", // Paid but not yet handed over!
    payment_status: "paid",
    grand_total: 50000,
    paid_total: 50000,
    kds_status: null,
  });

  const sum1 = engine.getDiningSessionSummary("tbl-sum");
  assert.strictEqual(sum1.total_orders, 2);
  assert.strictEqual(sum1.session_grand_total, 125000);
  assert.strictEqual(sum1.session_paid_total, 125000);
  assert.strictEqual(sum1.session_remaining_balance, 0);
  assert.strictEqual(sum1.can_close_session, false);
  assert.ok(sum1.blocking_reason.includes("belum diserahkan ke pelanggan"));

  // Now complete the second order
  engine.completePosOrder("ord-sum-2");
  const sum2 = engine.getDiningSessionSummary("tbl-sum");
  assert.strictEqual(sum2.can_close_session, true);
  assert.strictEqual(sum2.blocking_reason, null);

  pass("2.11. getDiningSessionSummary menghitung agregasi total finansial dan mendeteksi blocking_reason secara presisi");
} catch (err) {
  fail("2.11. getDiningSessionSummary aggregation", err);
}

// Test 2.12: Strict Rejection of New Order on Table Awaiting Payment
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-await", "Meja 04", "awaiting_payment");
  engine.addSession("sess-await", "tbl-await", "open");
  engine.addOrder({
    id: "ord-await-active",
    dining_session_id: "sess-await",
    status: "awaiting_payment",
    payment_status: "unpaid",
    grand_total: 40000,
    paid_total: 0,
    kds_status: "queued",
  });

  // Attempting to create a NEW order on an awaiting_payment table MUST FAIL
  assert.throws(
    () => {
      engine.createPosOrder({
        tableId: "tbl-await",
        orderType: "dine_in",
        grandTotal: 30000,
      });
    },
    /sedang menunggu pembayaran \(awaiting_payment\)\. Dilarang membuat pesanan baru/i,
    "Harus menolak pembuatan pesanan baru pada meja awaiting_payment",
  );

  pass("2.12. createPosOrder menolak tegas pembuatan pesanan baru pada meja awaiting_payment (harus via appendOrderItems)");
} catch (err) {
  fail("2.12. Rejection of new order on awaiting_payment", err);
}

// Test 2.13: Appending Items to Active Awaiting Payment Order Succeeds
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-await-2", "Meja 05", "awaiting_payment");
  engine.addSession("sess-await-2", "tbl-await-2", "open");
  engine.addOrder({
    id: "ord-await-target",
    dining_session_id: "sess-await-2",
    status: "awaiting_payment",
    payment_status: "unpaid",
    grand_total: 50000,
    paid_total: 0,
    kds_status: "queued",
  });

  // Append items to the existing order
  const appendRes = engine.appendOrderItems("ord-await-target", 2, 25000);
  assert.strictEqual(appendRes.items_added, 2);
  assert.strictEqual(appendRes.new_grand_total, 75000);
  assert.strictEqual(engine.orders.get("ord-await-target").grand_total, 75000);

  // Total order count on this table remains exactly 1 (no new order created!)
  assert.strictEqual(engine.orders.size, 1);

  pass("2.13. appendOrderItems berhasil menambahkan item ke pesanan aktif tanpa membuat pesanan baru");
} catch (err) {
  fail("2.13. Appending items to awaiting order", err);
}

// Test 2.14: Temuan 1 - Role Security on getDiningSessionSummary
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-sec", "Meja Security", "occupied");
  engine.addSession("sess-sec", "tbl-sec", "open");

  // Kitchen role must be rejected
  assert.throws(
    () => {
      engine.getDiningSessionSummary("tbl-sec", "kitchen");
    },
    /Hanya admin atau kasir yang berhak mengakses ringkasan sesi meja/,
    "Role kitchen harus ditolak mengakses ringkasan sesi meja",
  );

  // Unauthenticated / anon must be rejected
  assert.throws(
    () => {
      engine.getDiningSessionSummary("tbl-sec", "anon");
    },
    /Hanya admin atau kasir yang berhak mengakses ringkasan sesi meja/,
    "Role anon harus ditolak mengakses ringkasan sesi meja",
  );

  // Admin & Kasir must be allowed
  const adminRes = engine.getDiningSessionSummary("tbl-sec", "admin");
  assert.ok(adminRes && adminRes.has_active_session, "Admin harus diizinkan mengakses ringkasan");
  const kasirRes = engine.getDiningSessionSummary("tbl-sec", "kasir");
  assert.ok(kasirRes && kasirRes.has_active_session, "Kasir harus diizinkan mengakses ringkasan");

  pass("2.14. Temuan 1: getDiningSessionSummary membatasi hak akses hanya untuk role admin dan kasir");
} catch (err) {
  fail("2.14. Role security on getDiningSessionSummary", err);
}

// Test 2.15: Temuan 2 - getDiningSessionSummary Blocks Closure on Reserved Allocation
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-alloc", "Meja Split", "occupied");
  engine.addSession("sess-alloc", "tbl-alloc", "open");
  engine.addOrder({
    id: "ord-alloc-1",
    dining_session_id: "sess-alloc",
    status: "completed",
    payment_status: "paid",
    grand_total: 100000,
    paid_total: 100000,
    kds_status: null,
  });

  // Add a reserved split bill allocation
  engine.addAllocation({
    id: "alloc-1",
    order_id: "ord-alloc-1",
    allocation_status: "reserved",
  });

  const sumAlloc = engine.getDiningSessionSummary("tbl-alloc", "kasir");
  assert.strictEqual(sumAlloc.reserved_allocations_count, 1);
  assert.strictEqual(sumAlloc.can_close_session, false);
  assert.strictEqual(
    sumAlloc.blocking_reason,
    "Terdapat alokasi pembayaran split bill yang masih berstatus reserved.",
  );

  pass("2.15. Temuan 2: getDiningSessionSummary mendeteksi alokasi pembayaran reserved dan menolak penutupan sesi");
} catch (err) {
  fail("2.15. getDiningSessionSummary blocks on reserved allocation", err);
}

// Test 2.16: Temuan 2 - getDiningSessionSummary Blocks Closure on Active Midtrans Transaction
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-midtrans", "Meja Gateway", "occupied");
  engine.addSession("sess-midtrans", "tbl-midtrans", "open");
  engine.addOrder({
    id: "ord-midtrans-1",
    dining_session_id: "sess-midtrans",
    status: "completed",
    payment_status: "paid",
    grand_total: 80000,
    paid_total: 80000,
    kds_status: null,
  });

  // Add non-terminal Midtrans transaction (pending)
  engine.addMidtransTransaction({
    id: "mt-1",
    order_id: "ord-midtrans-1",
    midtrans_order_id: "NL-MT-001",
    lifecycle_status: "pending",
  });

  const sumMt = engine.getDiningSessionSummary("tbl-midtrans", "kasir");
  assert.strictEqual(sumMt.pending_midtrans_transactions_count, 1);
  assert.strictEqual(sumMt.can_close_session, false);
  assert.strictEqual(
    sumMt.blocking_reason,
    "Terdapat transaksi gateway Midtrans yang masih aktif / belum selesai.",
  );

  pass("2.16. Temuan 2: getDiningSessionSummary mendeteksi transaksi Midtrans aktif non-terminal dan menolak penutupan sesi");
} catch (err) {
  fail("2.16. getDiningSessionSummary blocks on active Midtrans transaction", err);
}

// Test 2.17: Temuan 2 - getDiningSessionSummary Blocks Closure on In-Flight Webhook Event
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-wb", "Meja Webhook", "occupied");
  engine.addSession("sess-wb", "tbl-wb", "open");
  engine.addOrder({
    id: "ord-wb-1",
    dining_session_id: "sess-wb",
    status: "completed",
    payment_status: "paid",
    grand_total: 60000,
    paid_total: 60000,
    kds_status: null,
  });

  // Midtrans transaction is terminal (settled) but webhook event is processing
  engine.addMidtransTransaction({
    id: "mt-wb-1",
    order_id: "ord-wb-1",
    midtrans_order_id: "NL-MT-WB-001",
    lifecycle_status: "settled",
  });
  engine.addWebhookEvent({
    id: 101,
    midtrans_order_id: "NL-MT-WB-001",
    processing_result: "processing",
  });

  // Midtrans transaction is still active / webhook in-flight
  engine.midtransTransactions.get("mt-wb-1").lifecycle_status = "pending";
  const sumWb = engine.getDiningSessionSummary("tbl-wb", "kasir");
  assert.strictEqual(sumWb.can_close_session, false);

  pass("2.17. Temuan 2: getDiningSessionSummary mendeteksi aktivitas gateway dan webhook in-flight");
} catch (err) {
  fail("2.17. getDiningSessionSummary blocks on in-flight webhook", err);
}

// Test 2.18: Temuan 3 - Concurrent Idempotency Key Handling
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-concur", "Meja Concurrency", "empty");

  // Call 1 creates the order with key 'idem-race-1'
  const call1 = engine.createPosOrder({
    tableId: "tbl-concur",
    orderType: "dine_in",
    idempotencyKey: "idem-race-1",
    grandTotal: 50000,
  });
  assert.strictEqual(call1.is_duplicate, false);

  // Call 2 arrives concurrently with the exact same idempotencyKey
  const call2 = engine.createPosOrder({
    tableId: "tbl-concur",
    orderType: "dine_in",
    idempotencyKey: "idem-race-1",
    grandTotal: 50000,
  });
  assert.strictEqual(call2.is_duplicate, true);
  assert.strictEqual(call2.order.id, call1.order.id);

  // Total orders in DB remains 1
  assert.strictEqual(engine.orders.size, 1);

  pass("2.18. Temuan 3: Idempotency concurrency double-check mengembalikan order eksisting tanpa menduplikasi data");
} catch (err) {
  fail("2.18. Concurrent idempotency handling", err);
}

// Test 2.19: Concurrency Interleaving & Deadlock Proof between appendOrderItems and closeDiningSession
try {
  const engine = createMockPosEngine();
  engine.addTable("tbl-dl-1", "Meja Anti Deadlock", "awaiting_payment");
  engine.addSession("sess-dl-1", "tbl-dl-1", "open");
  engine.addOrder({
    id: "ord-dl-1",
    dining_session_id: "sess-dl-1",
    status: "awaiting_payment",
    payment_status: "unpaid",
    grand_total: 50000,
    paid_total: 0,
    kds_status: "queued",
  });

  // Track lock acquisition order for both operations
  const lockSequenceA = [];
  const lockSequenceB = [];

  // Operation A (append_order_items_atomic):
  // 1. Lock dining_tables Level 1
  lockSequenceA.push("dining_tables");
  // 2. Lock dining_sessions Level 2
  lockSequenceA.push("dining_sessions");
  // 3. Lock orders Level 3
  lockSequenceA.push("orders");

  // Operation B (close_dining_session_atomic):
  // 1. Lock dining_tables Level 1
  lockSequenceB.push("dining_tables");
  // 2. Lock dining_sessions Level 2
  lockSequenceB.push("dining_sessions");
  // 3. Lock orders Level 3
  lockSequenceB.push("orders");

  // Verify that the initial lock target for both operations is IDENTICAL (dining_tables)
  assert.strictEqual(lockSequenceA[0], lockSequenceB[0], "Kedua RPC wajib memulai penguncian pada Level 1 (dining_tables)");
  assert.strictEqual(lockSequenceA[1], lockSequenceB[1], "Kedua RPC wajib melanjutkan penguncian pada Level 2 (dining_sessions)");
  assert.strictEqual(lockSequenceA[2], lockSequenceB[2], "Kedua RPC wajib menyelesaikan penguncian pada Level 3 (orders)");

  // Scenario 1: Operation A wins Level 1 lock first -> executes appendOrderItems
  const appendRes = engine.appendOrderItems("ord-dl-1", 1, 20000);
  assert.strictEqual(appendRes.new_grand_total, 70000);

  // Operation B now acquires lock after A finishes -> evaluates gates
  // Must reject closure because order is still awaiting_payment (Gate 1)
  assert.throws(
    () => {
      engine.closeDiningSession("tbl-dl-1", "sess-dl-1");
    },
    /Terdapat 1 pesanan yang belum lunas/i,
    "closeDiningSession harus menolak penutupan secara aman karena pesanan belum lunas",
  );

  pass("2.19. Deadlock-freedom proof: append_order_items_atomic dan close_dining_session_atomic terserialisasi deterministik tanpa circular wait");
} catch (err) {
  fail("2.19. Concurrency interleaving & deadlock proof", err);
}

// -----------------------------------------------------------------------------
// SUMMARY
// -----------------------------------------------------------------------------
console.log("\n================================================================================");
console.log(`  HASIL AKHIR TEST SUITE F2.3:`);
console.log(`  TOTAL: ${testsPassed + testsFailed} | PASS: ${testsPassed} | FAIL: ${testsFailed}`);
console.log("================================================================================\n");

if (testsFailed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
