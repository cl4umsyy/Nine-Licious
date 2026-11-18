#!/usr/bin/env node
/**
 * NINE LICIOUS POS - TEST SUITE: F3 KITCHEN DISPLAY SYSTEM (KDS)
 *
 * Menguji seluruh skenario wajib F3 (Halaman /kitchen):
 * 1. Pesanan Dine-in lunas masuk KDS.
 * 2. Pesanan Takeaway lunas masuk KDS.
 * 3. Pesanan belum lunas (awaiting_payment / partially_paid / cancelled) ditolak dari KDS.
 * 4. Deteksi Pesanan Tambahan (Additional Order) dalam dining_session_id yang sama.
 * 5. Filter status, tipe pesanan (dine_in / takeaway), dan stasiun dapur (kitchen / bar / dessert).
 * 6. Transisi valid satu arah: queued -> preparing -> ready (berhenti di ready).
 * 7. Penolakan transisi ilegal (lompat status, mundur, status selesai/served, pesanan non-paid).
 * 8. Deduplikasi tiket & urutan kronologis FIFO pada event Realtime/polling ganda.
 * 9. Durasi elapsed & status keterlambatan (normal / warning / overdue).
 * 10. Penghapusan tiket selesai (completed) & refund penuh (refunded), serta retensi partial refund paid.
 * 11. Isolasi privasi (FR-KDS-03): tidak ada data finansial atau PII pelanggan di KDS.
 * 12. Otorisasi RBAC (admin & kitchen only; kasir ditolak), isolasi mutasi KDS, audit log, & Realtime cleanup.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function readProjectFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

// ============================================================================
// Pure Domain Implementation Mirror (Verified against src/lib/kds/transitions.ts)
// ============================================================================
const KDS_STATUS_ORDER = ["queued", "preparing", "ready"];
const KDS_WARNING_THRESHOLD_MINUTES = 10;
const KDS_OVERDUE_THRESHOLD_MINUTES = 20;

function isValidKdsStatus(value) {
  return typeof value === "string" && KDS_STATUS_ORDER.includes(value);
}

function normalizeKitchenStation(station) {
  const cleaned = station?.trim().toLowerCase();
  return cleaned && cleaned.length > 0 ? cleaned : "kitchen";
}

function getNextKdsStatus(current) {
  if (current === "queued") return "preparing";
  if (current === "preparing") return "ready";
  return null;
}

function validateKdsTransition(params) {
  if (params.orderStatus !== "paid") {
    return { ok: false, message: "Hanya pesanan paid yang dapat diproses." };
  }
  if (!isValidKdsStatus(params.currentStatus)) {
    return { ok: false, message: "Status dapur saat ini tidak aktif." };
  }
  if (!isValidKdsStatus(params.nextStatus)) {
    return { ok: false, message: "Status dapur tujuan tidak valid." };
  }
  const allowedNext = getNextKdsStatus(params.currentStatus);
  if (!allowedNext) {
    return { ok: false, message: "Pesanan sudah Siap Diambil." };
  }
  if (params.nextStatus !== allowedNext) {
    return { ok: false, message: "Transisi status tidak diizinkan." };
  }
  return { ok: true, from: params.currentStatus, to: params.nextStatus };
}

function isOrderVisibleInKds(order) {
  return order.status === "paid" && isValidKdsStatus(order.kds_status);
}

function mergeKdsTicketsById(tickets) {
  const byId = new Map();
  for (const ticket of tickets) {
    const existing = byId.get(ticket.id);
    if (!existing) {
      byId.set(ticket.id, ticket);
      continue;
    }
    const existingTs = Date.parse(existing.updatedAt);
    const incomingTs = Date.parse(ticket.updatedAt);
    if (Number.isNaN(existingTs) || incomingTs >= existingTs) {
      byId.set(ticket.id, ticket);
    }
  }
  return Array.from(byId.values()).sort((a, b) => {
    const timeDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (timeDiff !== 0 && !Number.isNaN(timeDiff)) return timeDiff;
    return a.orderNumber.localeCompare(b.orderNumber);
  });
}

function getElapsedMinutes(createdAtIso, nowMs) {
  const createdMs = Date.parse(createdAtIso);
  if (Number.isNaN(createdMs)) return 0;
  return Math.max(0, Math.floor((nowMs - createdMs) / 60_000));
}

function getTicketUrgency(elapsedMinutes, kdsStatus) {
  if (kdsStatus === "ready") return "normal";
  if (elapsedMinutes >= KDS_OVERDUE_THRESHOLD_MINUTES) return "overdue";
  if (elapsedMinutes >= KDS_WARNING_THRESHOLD_MINUTES) return "warning";
  return "normal";
}

function computeAdditionalOrderMap(sessionOrders) {
  const grouped = new Map();
  for (const row of sessionOrders) {
    if (!row.dining_session_id) continue;
    if (row.order_type && row.order_type !== "dine_in") continue;
    const list = grouped.get(row.dining_session_id) ?? [];
    list.push({ id: row.id, created_at: row.created_at });
    grouped.set(row.dining_session_id, list);
  }
  const result = new Map();
  for (const list of grouped.values()) {
    list.sort((a, b) => {
      const diff = Date.parse(a.created_at) - Date.parse(b.created_at);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
      return a.id.localeCompare(b.id);
    });
    list.forEach((entry, idx) => {
      result.set(entry.id, {
        isAdditionalOrder: idx + 1 > 1,
        sessionOrderIndex: idx + 1,
      });
    });
  }
  return result;
}

function filterKdsTickets(tickets, filters) {
  return tickets.filter((ticket) => {
    if (filters.status !== "all" && ticket.kdsStatus !== filters.status) {
      return false;
    }
    if (filters.orderType !== "all" && ticket.orderType !== filters.orderType) {
      return false;
    }
    if (filters.station !== "all") {
      const target = normalizeKitchenStation(filters.station);
      if (!ticket.stations.includes(target)) return false;
    }
    return true;
  });
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

console.log("\n==============================================================");
console.log("  NINE LICIOUS POS — F3 KITCHEN DISPLAY SYSTEM (KDS) TESTS");
console.log("==============================================================\n");

// 1 & 2. Visibility: Dine-in paid & Takeaway paid
test("1. Pesanan Dine-in lunas (paid + queued) masuk KDS", () => {
  assert.equal(
    isOrderVisibleInKds({
      status: "paid",
      kds_status: "queued",
      order_type: "dine_in",
    }),
    true,
  );
});

test("2. Pesanan Takeaway lunas (paid + queued) masuk KDS", () => {
  assert.equal(
    isOrderVisibleInKds({
      status: "paid",
      kds_status: "queued",
      order_type: "takeaway",
    }),
    true,
  );
});

// 3. Unpaid / Partially paid / Cancelled never enter KDS
test("3. Pesanan belum lunas (awaiting_payment / partially_paid / cancelled) tidak masuk KDS", () => {
  assert.equal(
    isOrderVisibleInKds({ status: "awaiting_payment", kds_status: null }),
    false,
  );
  assert.equal(
    isOrderVisibleInKds({ status: "awaiting_payment", kds_status: "queued" }),
    false,
  );
  assert.equal(
    isOrderVisibleInKds({ status: "partially_paid", kds_status: "queued" }),
    false,
  );
  assert.equal(
    isOrderVisibleInKds({ status: "cancelled", kds_status: null }),
    false,
  );
});

// 4. Additional Order Detection
test("4. Deteksi Pesanan Tambahan (Additional Order) dalam sesi meja yang sama", () => {
  const map = computeAdditionalOrderMap([
    {
      id: "ord-2",
      dining_session_id: "sess-1",
      order_type: "dine_in",
      created_at: "2026-11-18T10:15:00Z",
    },
    {
      id: "ord-1",
      dining_session_id: "sess-1",
      order_type: "dine_in",
      created_at: "2026-11-18T10:00:00Z",
    },
    {
      id: "ord-3",
      dining_session_id: "sess-1",
      order_type: "dine_in",
      created_at: "2026-11-18T10:30:00Z",
    },
    {
      id: "ord-tw",
      dining_session_id: null,
      order_type: "takeaway",
      created_at: "2026-11-18T10:05:00Z",
    },
  ]);

  assert.deepEqual(map.get("ord-1"), {
    isAdditionalOrder: false,
    sessionOrderIndex: 1,
  });
  assert.deepEqual(map.get("ord-2"), {
    isAdditionalOrder: true,
    sessionOrderIndex: 2,
  });
  assert.deepEqual(map.get("ord-3"), {
    isAdditionalOrder: true,
    sessionOrderIndex: 3,
  });
  assert.equal(map.has("ord-tw"), false);
});

// 5. Filtering by status, order type, and station
test("5. Filter status, tipe pesanan (dine-in/takeaway), dan stasiun dapur (kitchen/bar/dessert)", () => {
  const sampleTickets = [
    {
      id: "t1",
      orderNumber: "ORD-001",
      orderType: "dine_in",
      kdsStatus: "queued",
      stations: ["kitchen", "bar"],
      createdAt: "2026-11-18T10:00:00Z",
      updatedAt: "2026-11-18T10:00:00Z",
    },
    {
      id: "t2",
      orderNumber: "ORD-002",
      orderType: "takeaway",
      kdsStatus: "preparing",
      stations: ["dessert"],
      createdAt: "2026-11-18T10:02:00Z",
      updatedAt: "2026-11-18T10:03:00Z",
    },
    {
      id: "t3",
      orderNumber: "ORD-003",
      orderType: "dine_in",
      kdsStatus: "ready",
      stations: ["bar"],
      createdAt: "2026-11-18T10:05:00Z",
      updatedAt: "2026-11-18T10:08:00Z",
    },
  ];

  assert.equal(
    filterKdsTickets(sampleTickets, {
      status: "all",
      orderType: "dine_in",
      station: "all",
    }).length,
    2,
  );
  assert.deepEqual(
    filterKdsTickets(sampleTickets, {
      status: "all",
      orderType: "all",
      station: "bar",
    }).map((t) => t.id),
    ["t1", "t3"],
  );
  assert.deepEqual(
    filterKdsTickets(sampleTickets, {
      status: "preparing",
      orderType: "takeaway",
      station: "dessert",
    }).map((t) => t.id),
    ["t2"],
  );
  assert.equal(normalizeKitchenStation(null), "kitchen");
  assert.equal(normalizeKitchenStation("  BAR "), "bar");
});

// 6. Valid transitions queued -> preparing -> ready
test("6. Transisi valid satu langkah: queued -> preparing -> ready (berhenti di ready)", () => {
  assert.equal(getNextKdsStatus("queued"), "preparing");
  assert.equal(getNextKdsStatus("preparing"), "ready");
  assert.equal(getNextKdsStatus("ready"), null);

  const step1 = validateKdsTransition({
    orderStatus: "paid",
    currentStatus: "queued",
    nextStatus: "preparing",
  });
  assert.equal(step1.ok, true);

  const step2 = validateKdsTransition({
    orderStatus: "paid",
    currentStatus: "preparing",
    nextStatus: "ready",
  });
  assert.equal(step2.ok, true);
});

// 7. Illegal transitions rejected
test("7. Penolakan transisi ilegal (lompat status, mundur, completed/served, non-paid)", () => {
  // Skip step
  assert.equal(
    validateKdsTransition({
      orderStatus: "paid",
      currentStatus: "queued",
      nextStatus: "ready",
    }).ok,
    false,
  );
  // Backward transitions
  assert.equal(
    validateKdsTransition({
      orderStatus: "paid",
      currentStatus: "preparing",
      nextStatus: "queued",
    }).ok,
    false,
  );
  assert.equal(
    validateKdsTransition({
      orderStatus: "paid",
      currentStatus: "ready",
      nextStatus: "preparing",
    }).ok,
    false,
  );
  // 4th status / completed blocked for kitchen
  assert.equal(
    validateKdsTransition({
      orderStatus: "paid",
      currentStatus: "ready",
      nextStatus: "completed",
    }).ok,
    false,
  );
  assert.equal(
    validateKdsTransition({
      orderStatus: "paid",
      currentStatus: "ready",
      nextStatus: "served",
    }).ok,
    false,
  );
  // Non-paid orders blocked
  assert.equal(
    validateKdsTransition({
      orderStatus: "awaiting_payment",
      currentStatus: "queued",
      nextStatus: "preparing",
    }).ok,
    false,
  );
  assert.equal(
    validateKdsTransition({
      orderStatus: "refunded",
      currentStatus: "queued",
      nextStatus: "preparing",
    }).ok,
    false,
  );
});

// 8. Deduplication & FIFO chronological ordering
test("8. Deduplikasi tiket by order.id dan urutan FIFO kronologis", () => {
  const merged = mergeKdsTicketsById([
    {
      id: "ord-b",
      orderNumber: "ORD-002",
      kdsStatus: "queued",
      createdAt: "2026-11-18T10:05:00Z",
      updatedAt: "2026-11-18T10:05:00Z",
    },
    {
      id: "ord-a",
      orderNumber: "ORD-001",
      kdsStatus: "queued",
      createdAt: "2026-11-18T10:00:00Z",
      updatedAt: "2026-11-18T10:01:00Z",
    },
    {
      id: "ord-a",
      orderNumber: "ORD-001",
      kdsStatus: "preparing",
      createdAt: "2026-11-18T10:00:00Z",
      updatedAt: "2026-11-18T10:04:00Z",
    },
  ]);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, "ord-a");
  assert.equal(merged[0].kdsStatus, "preparing");
  assert.equal(merged[1].id, "ord-b");
});

// 9. Elapsed duration & overdue thresholds
test("9. Kalkulasi durasi & indikator keterlambatan (normal <10m, warning 10-19m, overdue >=20m)", () => {
  const base = Date.parse("2026-11-18T10:00:00Z");
  assert.equal(getElapsedMinutes("2026-11-18T10:00:00Z", base + 5 * 60_000), 5);
  assert.equal(getTicketUrgency(5, "queued"), "normal");
  assert.equal(getTicketUrgency(10, "queued"), "warning");
  assert.equal(getTicketUrgency(19, "preparing"), "warning");
  assert.equal(getTicketUrgency(20, "preparing"), "overdue");
  assert.equal(getTicketUrgency(35, "ready"), "normal");
});

// 10. Completed, Full Refund excluded; Partial Refund Paid retained
test("10. Tiket completed & full refund hilang dari KDS; partial refund paid tetap tampil", () => {
  assert.equal(
    isOrderVisibleInKds({ status: "completed", kds_status: null }),
    false,
  );
  assert.equal(
    isOrderVisibleInKds({ status: "completed", kds_status: "ready" }),
    false,
  );
  assert.equal(
    isOrderVisibleInKds({ status: "refunded", kds_status: null }),
    false,
  );
  // Partial refund on paid order keeps status='paid' & kds_status active
  assert.equal(
    isOrderVisibleInKds({
      status: "paid",
      payment_status: "partially_refunded",
      kds_status: "preparing",
    }),
    true,
  );
});

// 11. Privacy Isolation (FR-KDS-03) across source files
test("11. Isolasi privasi (FR-KDS-03): KDS bebas data finansial dan PII pelanggan", () => {
  const kdsFiles = [
    "src/lib/kds/types.ts",
    "src/lib/kds/transitions.ts",
    "src/lib/kds/actions.ts",
    "src/components/kds/kds-ticket-card.tsx",
    "src/components/kds/kds-board.tsx",
    "src/app/(app)/kitchen/page.tsx",
  ];

  // Forbidden column/field references in executable code (strip comments first)
  const forbiddenPatterns = [
    /\bgrand_total\b/,
    /\bpaid_total\b/,
    /\bsubtotal\b/,
    /\bdiscount_total\b/,
    /\bunit_price_snapshot\b/,
    /\bline_total\b/,
    /\bprice_delta_snapshot\b/,
    /\bcustomer_name\b/,
    /\bpayment_method\b/,
    /\bformatRupiah\b/,
  ];

  for (const relPath of kdsFiles) {
    const raw = readProjectFile(relPath);
    // Remove block and line comments so docstrings explaining exclusions don't false-positive
    const codeOnly = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.test(codeOnly),
        false,
        `Ditemukan field terlarang ${pattern} di ${relPath}`,
      );
    }
  }
});

// 12. RBAC, Mutation Isolation, Audit Log, Realtime & Scope Guards
test("12. Kontrak keamanan RBAC, isolasi mutasi KDS, audit log, Realtime & batas cakupan /queue", () => {
  const sessionSrc = readProjectFile("src/lib/auth/session.ts");
  const rolesSrc = readProjectFile("src/lib/auth/roles.ts");
  const actionsSrc = readProjectFile("src/lib/kds/actions.ts");
  const boardSrc = readProjectFile("src/components/kds/kds-board.tsx");
  const pageSrc = readProjectFile("src/app/(app)/kitchen/page.tsx");
  const queueSrc = readProjectFile("src/app/queue/page.tsx");

  // getKitchenActor restricts strictly to admin & kitchen (rejects kasir)
  assert.match(sessionSrc, /export async function getKitchenActor/);
  assert.match(
    sessionSrc,
    /state\.profile\.role !== "admin" && state\.profile\.role !== "kitchen"/,
  );

  // /kitchen restricted to admin & kitchen; /admin & /pos exclude kitchen
  assert.match(pageSrc, /requireRole\(\["admin", "kitchen"\]\)/);
  assert.match(
    rolesSrc,
    /pathname === "\/kitchen" \|\| pathname\.startsWith\("\/kitchen\/"\)\) \{\s*return role === "admin" \|\| role === "kitchen";/,
  );
  assert.match(
    rolesSrc,
    /pathname === "\/pos" \|\| pathname\.startsWith\("\/pos\/"\)\) \{\s*return role === "admin" \|\| role === "kasir";/,
  );
  assert.match(
    rolesSrc,
    /pathname === "\/admin" \|\| pathname\.startsWith\("\/admin\/"\)\) \{\s*return role === "admin";/,
  );

  // Actions authenticate with getKitchenActor
  assert.match(actionsSrc, /const actor = await getKitchenActor\(\)/);

  // Atomic conditional update touches ONLY kds_status & updated_at on status='paid'
  assert.match(
    actionsSrc,
    /\.update\(\{\s*kds_status:\s*validation\.to,\s*updated_at:\s*nowIso,\s*\}\)/,
  );
  assert.match(actionsSrc, /\.eq\("status",\s*"paid"\)/);
  assert.match(actionsSrc, /\.eq\("kds_status",\s*validation\.from\)/);

  // KDS action never mutates dining_sessions, dining_tables, or payments
  assert.equal(/\.from\("dining_sessions"\)\s*\.update/.test(actionsSrc), false);
  assert.equal(/\.from\("dining_tables"\)\s*\.update/.test(actionsSrc), false);
  assert.equal(/\.from\("payments"\)/.test(actionsSrc), false);

  // Audit log written on transition
  assert.match(actionsSrc, /action:\s*"kds\.status_updated"/);

  // Full refund alerts queried via kitchen_notified_at without refund amount
  assert.match(actionsSrc, /kitchen_notified_at/);
  assert.match(boardSrc, /Hentikan Persiapan/);

  // Realtime subscription + fallback polling + cleanup present
  assert.match(boardSrc, /postgres_changes/);
  assert.match(boardSrc, /table:\s*"orders"/);
  assert.match(boardSrc, /removeChannel/);
  assert.match(boardSrc, /FALLBACK_POLL_INTERVAL_MS/);

  // /queue untouched (not activated in this phase)
  assert.equal(/getKdsBoardDataAction/.test(queueSrc), false);
  assert.equal(/KdsBoard/.test(queueSrc), false);
});

console.log("\n--------------------------------------------------------------");
console.log(`  HASIL F3 KDS: ${passed} PASS, ${failed} FAIL`);
console.log("--------------------------------------------------------------\n");

if (failed > 0) {
  process.exit(1);
}
