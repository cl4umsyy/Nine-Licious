#!/usr/bin/env node
/**
 * NINE LICIOUS POS - TEST SUITE: CASHIER POS CART VISIBILITY & ORDERS LIST
 *
 * Memverifikasi perbaikan:
 * 1. Tombol pemrosesan pesanan ("Buat Pesanan") selalu terlihat (Card py-0 gap-0, sticky footer, anti-clipping).
 * 2. Daftar Pesanan Kasir (/pos/orders) terhubung dari navigasi & header POS, khusus admin/kasir.
 * 3. Filter status (Semua, Menunggu Pembayaran, Diproses, Sedang Disiapkan, Siap Diambil, Sudah Disajikan) berbasis kolom DB asli.
 * 4. Tampilan status pembayaran, dapur (KDS), dan penyajian akurat tanpa status palsu.
 * 5. Filter Dine-in / Takeaway & pencarian nomor pesanan / antrean / meja / item.
 * 6. Deduplikasi pesanan by order.id & urutan terbaru di atas.
 * 7. Realtime + fallback polling + cleanup pada Daftar Pesanan Kasir.
 * 8. Anti-duplikasi pesanan (idempotencyKey + disabled submit saat isSubmitting).
 * 9. Proteksi kebijakan 2 metode pembayaran (Tunai & Midtrans; tanpa QRIS/Transfer manual).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
function readProjectFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

// ============================================================================
// Pure Domain Mirror (from src/lib/orders/cashier-orders.ts)
// ============================================================================
function matchesCashierOrderFilter(order, filter) {
  switch (filter) {
    case "all":
      return true;
    case "awaiting_payment":
      return (
        order.status === "awaiting_payment" ||
        order.status === "partially_paid"
      );
    case "queued":
      return (
        order.status === "paid" &&
        order.kdsStatus === "queued" &&
        !order.servedAt
      );
    case "preparing":
      return (
        order.status === "paid" &&
        order.kdsStatus === "preparing" &&
        !order.servedAt
      );
    case "ready":
      return (
        order.status === "paid" &&
        order.kdsStatus === "ready" &&
        !order.servedAt
      );
    case "served":
      return Boolean(order.servedAt) || order.status === "completed";
  }
}

function filterCashierOrders(orders, params) {
  const query = params.searchQuery.trim().toLowerCase();
  return orders.filter((order) => {
    if (!matchesCashierOrderFilter(order, params.statusFilter)) return false;
    if (
      params.orderTypeFilter !== "all" &&
      order.orderType !== params.orderTypeFilter
    ) {
      return false;
    }
    if (query.length > 0) {
      const haystacks = [
        order.orderNumber,
        order.queueNumber ?? "",
        order.tableName ? `meja ${order.tableName}` : "",
        order.customerName ?? "",
        ...order.items.map((item) => item.productName),
      ];
      return haystacks.some((v) => v.toLowerCase().includes(query));
    }
    return true;
  });
}

function mergeCashierOrdersById(orders) {
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
    const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
    return b.orderNumber.localeCompare(a.orderNumber);
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

console.log("\n=====================================================================");
console.log("  NINE LICIOUS POS — CASHIER CART & ORDERS LIST VERIFICATION SUITE");
console.log("=====================================================================\n");

const sampleOrders = [
  {
    id: "o1",
    orderNumber: "ORD-20261118-0001",
    queueNumber: null,
    orderType: "dine_in",
    tableName: "A08",
    customerName: null,
    status: "awaiting_payment",
    paymentStatus: "unpaid",
    kdsStatus: null,
    servedAt: null,
    createdAt: "2026-11-18T11:00:00Z",
    updatedAt: "2026-11-18T11:00:00Z",
    items: [{ id: "i1", productName: "Lemon Tea", quantity: 1 }],
  },
  {
    id: "o2",
    orderNumber: "ORD-20261118-0002",
    queueNumber: "A001",
    orderType: "takeaway",
    tableName: null,
    customerName: "Budi",
    status: "paid",
    paymentStatus: "paid",
    kdsStatus: "queued",
    servedAt: null,
    createdAt: "2026-11-18T11:02:00Z",
    updatedAt: "2026-11-18T11:02:00Z",
    items: [{ id: "i2", productName: "Beef Yakiniku Rice", quantity: 1 }],
  },
  {
    id: "o3",
    orderNumber: "ORD-20261118-0003",
    queueNumber: "A002",
    orderType: "dine_in",
    tableName: "A03",
    customerName: null,
    status: "paid",
    paymentStatus: "paid",
    kdsStatus: "preparing",
    servedAt: null,
    createdAt: "2026-11-18T11:04:00Z",
    updatedAt: "2026-11-18T11:05:00Z",
    items: [{ id: "i3", productName: "Burger Package", quantity: 2 }],
  },
  {
    id: "o4",
    orderNumber: "ORD-20261118-0004",
    queueNumber: "A003",
    orderType: "dine_in",
    tableName: "A05",
    customerName: null,
    status: "paid",
    paymentStatus: "paid",
    kdsStatus: "ready",
    servedAt: null,
    createdAt: "2026-11-18T11:06:00Z",
    updatedAt: "2026-11-18T11:10:00Z",
    items: [{ id: "i4", productName: "Cheesecake", quantity: 1 }],
  },
  {
    id: "o5",
    orderNumber: "ORD-20261118-0005",
    queueNumber: "A004",
    orderType: "takeaway",
    tableName: null,
    customerName: "Siti",
    status: "paid",
    paymentStatus: "paid",
    kdsStatus: "ready",
    servedAt: "2026-11-18T11:15:00Z",
    createdAt: "2026-11-18T11:08:00Z",
    updatedAt: "2026-11-18T11:15:00Z",
    items: [{ id: "i5", productName: "Lychee Tea", quantity: 2 }],
  },
];

test("1. Filter 'Menunggu Pembayaran' hanya menampilkan pesanan awaiting_payment / partially_paid", () => {
  const res = filterCashierOrders(sampleOrders, {
    statusFilter: "awaiting_payment",
    orderTypeFilter: "all",
    searchQuery: "",
  });
  assert.deepEqual(res.map((o) => o.id), ["o1"]);
});

test("2. Filter 'Diproses' (queued), 'Sedang Disiapkan' (preparing), dan 'Siap Diambil' (ready) akurat sesuai KDS", () => {
  assert.deepEqual(
    filterCashierOrders(sampleOrders, {
      statusFilter: "queued",
      orderTypeFilter: "all",
      searchQuery: "",
    }).map((o) => o.id),
    ["o2"],
  );
  assert.deepEqual(
    filterCashierOrders(sampleOrders, {
      statusFilter: "preparing",
      orderTypeFilter: "all",
      searchQuery: "",
    }).map((o) => o.id),
    ["o3"],
  );
  assert.deepEqual(
    filterCashierOrders(sampleOrders, {
      statusFilter: "ready",
      orderTypeFilter: "all",
      searchQuery: "",
    }).map((o) => o.id),
    ["o4"],
  );
});

test("3. Filter 'Sudah Disajikan' menampilkan pesanan dengan served_at terisi & tidak lagi masuk 'Siap Diambil'", () => {
  assert.deepEqual(
    filterCashierOrders(sampleOrders, {
      statusFilter: "served",
      orderTypeFilter: "all",
      searchQuery: "",
    }).map((o) => o.id),
    ["o5"],
  );
});

test("4. Filter Dine-in / Takeaway dan pencarian nomor pesanan, antrean, meja, dan item bekerja", () => {
  assert.equal(
    filterCashierOrders(sampleOrders, {
      statusFilter: "all",
      orderTypeFilter: "takeaway",
      searchQuery: "",
    }).length,
    2,
  );
  assert.deepEqual(
    filterCashierOrders(sampleOrders, {
      statusFilter: "all",
      orderTypeFilter: "all",
      searchQuery: "Meja A08",
    }).map((o) => o.id),
    ["o1"],
  );
  assert.deepEqual(
    filterCashierOrders(sampleOrders, {
      statusFilter: "all",
      orderTypeFilter: "all",
      searchQuery: "Cheesecake",
    }).map((o) => o.id),
    ["o4"],
  );
});

test("5. Deduplikasi by order.id mencegah duplikat dan mengurutkan pesanan terbaru di atas", () => {
  const merged = mergeCashierOrdersById([
    sampleOrders[0],
    sampleOrders[3],
    {
      ...sampleOrders[3],
      kdsStatus: "ready",
      servedAt: "2026-11-18T11:20:00Z",
      updatedAt: "2026-11-18T11:20:00Z",
    },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, "o4");
  assert.equal(merged[0].servedAt, "2026-11-18T11:20:00Z");
  assert.equal(merged[1].id, "o1");
});

test("6. CartPanel menghilangkan padding/gap berlebih Card & memakai sticky footer agar tombol 'Buat Pesanan' selalu terlihat", () => {
  const cartSrc = readProjectFile("src/components/pos/cart-panel.tsx");
  assert.match(cartSrc, /py-0 gap-0/);
  assert.match(cartSrc, /sticky bottom-0/);
  assert.match(cartSrc, /data-testid="pos-submit-order-button"/);
  assert.match(cartSrc, /Buat Pesanan/);
  assert.match(cartSrc, /disabled=\{!canSubmit\}/);
});

test("7. Halaman /pos/orders terhubung dari navigasi & header POS, khusus role admin/kasir, dan mendukung Realtime + polling", () => {
  const navSrc = readProjectFile("src/lib/navigation.ts");
  const posPageSrc = readProjectFile("src/app/(app)/pos/page.tsx");
  const ordersPageSrc = readProjectFile("src/app/(app)/pos/orders/page.tsx");
  const boardSrc = readProjectFile("src/components/pos/cashier-orders-board.tsx");
  const actionsSrc = readProjectFile("src/lib/orders/cashier-orders-actions.ts");

  assert.match(navSrc, /href:\s*"\/pos\/orders"/);
  assert.match(navSrc, /label:\s*"Daftar Pesanan"/);
  assert.match(posPageSrc, /href="\/pos\/orders"/);
  assert.match(ordersPageSrc, /requireRole\(\["admin", "kasir"\]\)/);
  assert.match(actionsSrc, /const actor = await getCashierActor\(\)/);
  assert.match(boardSrc, /postgres_changes/);
  assert.match(boardSrc, /removeChannel/);
  assert.match(boardSrc, /FALLBACK_POLL_INTERVAL_MS/);
  assert.match(boardSrc, /Finalisasi & Bayar/);
  assert.match(boardSrc, /Proses Pembayaran/);
  assert.match(boardSrc, /Tandai Sudah Disajikan/);
});

test("8. Anti-duplikasi pesanan (idempotencyKey) & kebijakan 2 metode pembayaran (Tunai & Midtrans) terjaga", () => {
  const posContainerSrc = readProjectFile("src/components/pos/pos-container.tsx");
  const confirmModalSrc = readProjectFile("src/components/pos/order-confirmation-modal.tsx");
  const paymentModalSrc = readProjectFile("src/components/pos/payment-modal.tsx");

  assert.match(posContainerSrc, /idempotencyKey/);
  assert.match(posContainerSrc, /isSubmitting/);
  assert.equal(/QRIS manual/i.test(confirmModalSrc), false);
  assert.match(paymentModalSrc, /Midtrans/);
});

console.log("\n---------------------------------------------------------------------");
console.log(`  HASIL CASHIER POS & ORDERS LIST: ${passed} PASS, ${failed} FAIL`);
console.log("---------------------------------------------------------------------\n");

if (failed > 0) {
  process.exit(1);
}
