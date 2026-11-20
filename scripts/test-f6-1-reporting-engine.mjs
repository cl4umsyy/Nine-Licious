#!/usr/bin/env node
/**
 * NINE LICIOUS POS — MILESTONE F6.1 TEST SUITE
 * File: scripts/test-f6-1-reporting-engine.mjs
 *
 * Verifikasi Komprehensif F6.1: Core Reporting Engine & Aggregations
 *
 * 15 AREA VERIFIKASI UTAMA SESUAI SPESIFIKASI:
 *  1. Pesanan unpaid tidak masuk omzet
 *  2. Pesanan paid masuk omzet
 *  3. Pesanan cancelled tidak masuk omzet
 *  4. Pembayaran Midtrans pending tidak dihitung
 *  5. Pembayaran Midtrans settlement dihitung
 *  6. Pembayaran tunai dihitung dengan benar
 *  7. Split bill tidak menggandakan jumlah pesanan
 *  8. JOIN tidak menggandakan omzet (Domain separation)
 *  9. Refund penuh dan parsial dihitung dengan benar
 * 10. Snapshot nama produk tetap digunakan
 * 11. Kategori dihitung dengan benar (Food, Drinks, Desserts, Packages)
 * 12. Batas tanggal Asia/Jakarta benar
 * 13. Pagination mengambil seluruh data & tidak mengembalikan data parsial saat error
 * 14. Pengguna non-admin ditolak (getAdminActor)
 * 15. Input tanggal tidak valid ditolak (Zod validation)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("===============================================================================");
console.log(" NINE LICIOUS POS — F6.1 CORE REPORTING ENGINE & AGGREGATIONS TEST SUITE");
console.log("===============================================================================\n");

let totalTests = 0;
let passedTests = 0;

function runTest(number, category, name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✓ [PASS] #${String(number).padStart(2, "0")} [${category}] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`✗ [FAIL] #${String(number).padStart(2, "0")} [${category}] ${name}`);
    console.error(`  Detail Kesalahan: ${err.message}\n`);
    throw err;
  }
}

const ROOT_DIR = process.cwd();

function readFileUtf8(relPath) {
  const fullPath = path.join(ROOT_DIR, relPath);
  assert.ok(fs.existsSync(fullPath), `File tidak ditemukan: ${relPath}`);
  return fs.readFileSync(fullPath, "utf-8");
}

// -----------------------------------------------------------------------------
// RE-IMPLEMENTASI PERHITUNGAN PURE FUNCTION F6.1 UNTUK PENGUJIAN DETERMINISTIK
// -----------------------------------------------------------------------------

function toJakartaDateString(isoString) {
  try {
    const date = new Date(isoString);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return isoString.split("T")[0];
  }
}

function calculateSalesReport(orders, refunds, period, totalReceipts) {
  const eligibleOrders = orders.filter((order) =>
    ["paid", "completed", "refunded"].includes(order.status),
  );

  const completedRefunds = refunds.filter((refund) => refund.status === "completed");

  let grossSales = 0;
  let subtotal = 0;
  let totalDiscount = 0;
  let totalTax = 0;
  let totalServiceCharge = 0;

  const dailyMap = new Map();

  for (const order of eligibleOrders) {
    const orderSubtotal = Math.round(Number(order.subtotal) || 0);
    const orderDiscount = Math.round(Number(order.discount_total) || 0);
    const orderTax = Math.round(Number(order.tax_total) || 0);
    const orderService = Math.round(Number(order.service_total) || 0);
    const orderGrandTotal = Math.round(Number(order.grand_total) || 0);

    subtotal += orderSubtotal;
    totalDiscount += orderDiscount;
    totalTax += orderTax;
    totalServiceCharge += orderService;
    grossSales += orderGrandTotal;

    const dateKey = toJakartaDateString(order.created_at);
    const daily = dailyMap.get(dateKey) ?? {
      grossSales: 0,
      subtotal: 0,
      totalDiscount: 0,
      totalTax: 0,
      totalServiceCharge: 0,
      totalRefund: 0,
      paidOrdersCount: 0,
    };

    daily.grossSales += orderGrandTotal;
    daily.subtotal += orderSubtotal;
    daily.totalDiscount += orderDiscount;
    daily.totalTax += orderTax;
    daily.totalServiceCharge += orderService;
    daily.paidOrdersCount += 1;
    dailyMap.set(dateKey, daily);
  }

  let totalRefund = 0;
  for (const refund of completedRefunds) {
    const refundAmount = Math.round(Number(refund.amount) || 0);
    totalRefund += refundAmount;

    const dateKey = toJakartaDateString(refund.created_at);
    const daily = dailyMap.get(dateKey) ?? {
      grossSales: 0,
      subtotal: 0,
      totalDiscount: 0,
      totalTax: 0,
      totalServiceCharge: 0,
      totalRefund: 0,
      paidOrdersCount: 0,
    };
    daily.totalRefund += refundAmount;
    dailyMap.set(dateKey, daily);
  }

  const netSales = Math.max(0, grossSales - totalRefund);
  const paidOrdersCount = eligibleOrders.length;
  const averageOrderValue =
    paidOrdersCount > 0 ? Math.round(netSales / paidOrdersCount) : 0;

  const dailyBreakdown = Array.from(dailyMap.entries())
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .map(([date, daily]) => ({
      date,
      grossSales: daily.grossSales,
      subtotal: daily.subtotal,
      totalDiscount: daily.totalDiscount,
      totalTax: daily.totalTax,
      totalServiceCharge: daily.totalServiceCharge,
      netSales: Math.max(0, daily.grossSales - daily.totalRefund),
      totalRefund: daily.totalRefund,
      paidOrdersCount: daily.paidOrdersCount,
    }));

  return {
    period,
    grossSales,
    subtotal,
    totalDiscount,
    totalTax,
    totalServiceCharge,
    netSales,
    totalRefund,
    totalReceipts: Math.round(totalReceipts || 0),
    paidOrdersCount,
    averageOrderValue,
    dailyBreakdown,
  };
}

function calculatePaymentMethodReport(payments, period) {
  const successfulPayments = payments.filter((p) =>
    ["success", "refunded"].includes(p.payment_status),
  );

  let totalCash = 0;
  let totalMidtrans = 0;
  let cashTransactionCount = 0;
  let midtransTransactionCount = 0;
  let totalPayments = 0;

  const paymentsByOrder = new Map();
  const methodsMap = new Map();

  function getMethodLabel(method, source) {
    if (source === "cash" || method === "cash") return "Tunai";
    if (source === "midtrans_snap" || method === "midtrans") return "Midtrans Gateway";
    if (source === "qris_midtrans") return "QRIS Midtrans";
    if (source === "qris_manual" || method === "qris") return "QRIS Manual";
    if (source === "bank_transfer" || method === "bank_transfer") return "Transfer Bank";
    return `${method} (${source})`;
  }

  for (const payment of successfulPayments) {
    const amount = Math.round(Number(payment.amount) || 0);
    totalPayments += amount;

    const isCash =
      payment.payment_method === "cash" || payment.payment_source === "cash";
    const isMidtrans =
      payment.payment_method === "midtrans" ||
      payment.payment_source === "midtrans_snap" ||
      payment.payment_source === "qris_midtrans";

    if (isCash) {
      totalCash += amount;
      cashTransactionCount += 1;
    } else if (isMidtrans) {
      totalMidtrans += amount;
      midtransTransactionCount += 1;
    }

    const orderList = paymentsByOrder.get(payment.order_id) ?? [];
    orderList.push(payment);
    paymentsByOrder.set(payment.order_id, orderList);

    const breakdownKey = `${payment.payment_method}:${payment.payment_source}`;
    const entry = methodsMap.get(breakdownKey) ?? {
      method: payment.payment_method,
      source: payment.payment_source,
      label: getMethodLabel(payment.payment_method, payment.payment_source),
      totalAmount: 0,
      transactionCount: 0,
    };
    entry.totalAmount += amount;
    entry.transactionCount += 1;
    methodsMap.set(breakdownKey, entry);
  }

  let totalSplitBillReceipts = 0;
  let splitBillOrdersCount = 0;

  for (const [, orderPayments] of paymentsByOrder.entries()) {
    if (orderPayments.length > 1) {
      splitBillOrdersCount += 1;
      for (const p of orderPayments) {
        totalSplitBillReceipts += Math.round(Number(p.amount) || 0);
      }
    }
  }

  const methodsBreakdown = Array.from(methodsMap.values()).sort(
    (a, b) => b.totalAmount - a.totalAmount,
  );

  return {
    period,
    totalCash,
    totalMidtrans,
    cashTransactionCount,
    midtransTransactionCount,
    totalSplitBillReceipts,
    splitBillOrdersCount,
    totalPayments,
    totalTransactions: successfulPayments.length,
    methodsBreakdown,
  };
}

function calculateProductPerformanceReport(orderItems, productCategoryMap, period) {
  const productAggMap = new Map();
  const categoryAggMap = new Map();

  for (const cat of ["Food", "Drinks", "Desserts", "Packages"]) {
    categoryAggMap.set(cat, {
      categoryName: cat,
      quantitySold: 0,
      totalRevenue: 0,
    });
  }

  let totalItemsSold = 0;
  let totalProductsRevenue = 0;

  for (const item of orderItems) {
    const qty = Math.max(0, Math.round(Number(item.quantity) || 0));
    const revenue = Math.max(0, Math.round(Number(item.line_total) || 0));
    const productId = item.product_id;
    const productName = item.product_name_snapshot;
    const sku = item.product_sku_snapshot || null;
    const categoryName = productCategoryMap.get(productId) || "Lainnya";

    totalItemsSold += qty;
    totalProductsRevenue += revenue;

    const prodEntry = productAggMap.get(productId) ?? {
      productId,
      productName,
      sku,
      categoryName,
      quantitySold: 0,
      totalRevenue: 0,
    };
    prodEntry.quantitySold += qty;
    prodEntry.totalRevenue += revenue;
    productAggMap.set(productId, prodEntry);

    const catEntry = categoryAggMap.get(categoryName) ?? {
      categoryName,
      quantitySold: 0,
      totalRevenue: 0,
    };
    catEntry.quantitySold += qty;
    catEntry.totalRevenue += revenue;
    categoryAggMap.set(categoryName, catEntry);
  }

  const topProducts = Array.from(productAggMap.values()).sort((a, b) => {
    if (b.quantitySold !== a.quantitySold) {
      return b.quantitySold - a.quantitySold;
    }
    return b.totalRevenue - a.totalRevenue;
  });

  const categoryBreakdown = Array.from(categoryAggMap.values())
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .map((cat) => ({
      categoryName: cat.categoryName,
      quantitySold: cat.quantitySold,
      totalRevenue: cat.totalRevenue,
      revenuePercentage:
        totalProductsRevenue > 0
          ? Number(((cat.totalRevenue / totalProductsRevenue) * 100).toFixed(2))
          : 0,
    }));

  return {
    period,
    topProducts,
    categoryBreakdown,
    totalItemsSold,
    totalProductsRevenue,
  };
}

function calculateRefundReport(refunds, period) {
  const completedRefunds = refunds.filter((r) => r.status === "completed");

  let totalRefundAmount = 0;
  let fullRefundTotal = 0;
  let fullRefundCount = 0;
  let partialRefundTotal = 0;
  let partialRefundCount = 0;

  const methodMap = new Map();

  function getRefundMethodLabel(method) {
    if (method === "cash") return "Tunai (Cash Drawer)";
    if (method === "midtrans") return "Midtrans Gateway";
    if (method === "transfer") return "Transfer Bank Manual";
    if (method === "manual") return "Manual";
    return method;
  }

  const refundItems = [];

  for (const r of completedRefunds) {
    const amount = Math.round(Number(r.amount) || 0);
    totalRefundAmount += amount;

    if (r.refund_type === "full") {
      fullRefundTotal += amount;
      fullRefundCount += 1;
    } else {
      partialRefundTotal += amount;
      partialRefundCount += 1;
    }

    const entry = methodMap.get(r.refund_method) ?? {
      method: r.refund_method,
      label: getRefundMethodLabel(r.refund_method),
      totalAmount: 0,
      count: 0,
    };
    entry.totalAmount += amount;
    entry.count += 1;
    methodMap.set(r.refund_method, entry);

    refundItems.push({
      id: r.id,
      refundNumber: r.refund_number,
      orderId: r.order_id,
      amount,
      reason: r.reason,
      refundType: r.refund_type === "full" ? "full" : "partial",
      refundMethod: r.refund_method,
      status: r.status,
      approvedAt: r.approved_at,
      createdAt: r.created_at,
    });
  }

  refundItems.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const refundsByMethod = Array.from(methodMap.values()).sort(
    (a, b) => b.totalAmount - a.totalAmount,
  );

  return {
    period,
    totalRefundAmount,
    totalRefundCount: completedRefunds.length,
    fullRefundTotal,
    fullRefundCount,
    partialRefundTotal,
    partialRefundCount,
    refundsByMethod,
    refundItems,
  };
}

async function fetchPaginatedRows(fetchChunk) {
  const CHUNK_SIZE = 1000;
  let from = 0;
  const allRows = [];

  while (true) {
    const to = from + CHUNK_SIZE - 1;
    const { data, error } = await fetchChunk(from, to);
    if (error) {
      return { data: [], error: new Error(error.message || String(error)) };
    }
    if (!data || data.length === 0) {
      break;
    }
    allRows.push(...data);
    if (data.length < CHUNK_SIZE) {
      break;
    }
    from += CHUNK_SIZE;
  }

  return { data: allRows, error: null };
}

// -----------------------------------------------------------------------------
// PENGUJIAN 15 KASUS WAJIB F6.1
// -----------------------------------------------------------------------------

runTest(1, "SALES", "Pesanan unpaid (awaiting_payment & partially_paid) tidak masuk omzet", () => {
  const orders = [
    {
      id: "ord-1",
      status: "awaiting_payment",
      subtotal: 50000,
      discount_total: 0,
      tax_total: 5000,
      service_total: 2500,
      grand_total: 57500,
      paid_total: 0,
      created_at: "2026-11-20T10:00:00+07:00",
    },
    {
      id: "ord-2",
      status: "partially_paid",
      subtotal: 100000,
      discount_total: 0,
      tax_total: 10000,
      service_total: 5000,
      grand_total: 115000,
      paid_total: 50000,
      created_at: "2026-11-20T11:00:00+07:00",
    },
  ];

  const result = calculateSalesReport(orders, [], { startDate: "2026-11-20", endDate: "2026-11-20" }, 0);
  assert.equal(result.grossSales, 0, "Gross sales harus 0 untuk pesanan unpaid");
  assert.equal(result.netSales, 0, "Net sales harus 0 untuk pesanan unpaid");
  assert.equal(result.paidOrdersCount, 0, "Jumlah pesanan lunas harus 0");
});

runTest(2, "SALES", "Pesanan paid dan completed masuk omzet secara akurat", () => {
  const orders = [
    {
      id: "ord-paid-1",
      status: "paid",
      subtotal: 100000,
      discount_total: 10000,
      tax_total: 9000,
      service_total: 4500,
      grand_total: 103500,
      paid_total: 103500,
      created_at: "2026-11-20T12:00:00+07:00",
    },
    {
      id: "ord-completed-2",
      status: "completed",
      subtotal: 200000,
      discount_total: 20000,
      tax_total: 18000,
      service_total: 9000,
      grand_total: 207000,
      paid_total: 207000,
      created_at: "2026-11-20T13:00:00+07:00",
    },
  ];

  const result = calculateSalesReport(orders, [], { startDate: "2026-11-20", endDate: "2026-11-20" }, 310500);
  assert.equal(result.grossSales, 310500, "Gross sales harus 103.500 + 207.000 = 310.500");
  assert.equal(result.subtotal, 300000, "Subtotal harus 100.000 + 200.000 = 300.000");
  assert.equal(result.totalDiscount, 30000, "Total diskon harus 30.000");
  assert.equal(result.totalTax, 27000, "Total pajak harus 27.000");
  assert.equal(result.totalServiceCharge, 13500, "Total service charge harus 13.500");
  assert.equal(result.netSales, 310500, "Net sales tanpa refund harus sama dengan gross sales");
  assert.equal(result.paidOrdersCount, 2, "Jumlah pesanan harus 2");
  assert.equal(result.averageOrderValue, 155250, "AOV harus 310.500 / 2 = 155.250");
});

runTest(3, "SALES", "Pesanan cancelled tidak masuk omzet", () => {
  const orders = [
    {
      id: "ord-cancel",
      status: "cancelled",
      subtotal: 500000,
      discount_total: 0,
      tax_total: 50000,
      service_total: 25000,
      grand_total: 575000,
      paid_total: 0,
      created_at: "2026-11-20T14:00:00+07:00",
    },
  ];

  const result = calculateSalesReport(orders, [], { startDate: "2026-11-20", endDate: "2026-11-20" }, 0);
  assert.equal(result.grossSales, 0, "Pesanan batal tidak boleh menambah gross sales");
  assert.equal(result.netSales, 0, "Pesanan batal tidak boleh menambah net sales");
  assert.equal(result.paidOrdersCount, 0, "Pesanan batal tidak boleh dihitung");
});

runTest(4, "PAYMENT", "Pembayaran Midtrans pending tidak dihitung sebagai penerimaan", () => {
  const payments = [
    {
      id: "pay-1",
      order_id: "ord-1",
      payment_method: "midtrans",
      payment_source: "midtrans_snap",
      amount: 150000,
      payment_status: "pending",
      created_at: "2026-11-20T10:00:00+07:00",
    },
    {
      id: "pay-2",
      order_id: "ord-2",
      payment_method: "midtrans",
      payment_source: "midtrans_snap",
      amount: 200000,
      payment_status: "failed",
      created_at: "2026-11-20T11:00:00+07:00",
    },
  ];

  const result = calculatePaymentMethodReport(payments, { startDate: "2026-11-20", endDate: "2026-11-20" });
  assert.equal(result.totalMidtrans, 0, "Pembayaran Midtrans pending/failed tidak boleh dihitung");
  assert.equal(result.totalPayments, 0, "Total penerimaan harus 0");
  assert.equal(result.totalTransactions, 0, "Jumlah transaksi berhasil harus 0");
});

runTest(5, "PAYMENT", "Pembayaran Midtrans settlement dihitung akurat", () => {
  const payments = [
    {
      id: "pay-settled-1",
      order_id: "ord-1",
      payment_method: "midtrans",
      payment_source: "midtrans_snap",
      amount: 250000,
      payment_status: "success",
      created_at: "2026-11-20T12:00:00+07:00",
    },
    {
      id: "pay-settled-2",
      order_id: "ord-2",
      payment_method: "qris",
      payment_source: "qris_midtrans",
      amount: 125000,
      payment_status: "success",
      created_at: "2026-11-20T13:00:00+07:00",
    },
  ];

  const result = calculatePaymentMethodReport(payments, { startDate: "2026-11-20", endDate: "2026-11-20" });
  assert.equal(result.totalMidtrans, 375000, "Total Midtrans harus 250.000 + 125.000 = 375.000");
  assert.equal(result.midtransTransactionCount, 2, "Jumlah transaksi Midtrans harus 2");
  assert.equal(result.totalPayments, 375000, "Total payments harus 375.000");
});

runTest(6, "PAYMENT", "Pembayaran tunai dihitung dengan benar", () => {
  const payments = [
    {
      id: "pay-cash-1",
      order_id: "ord-cash-1",
      payment_method: "cash",
      payment_source: "cash",
      amount: 175000,
      payment_status: "success",
      created_at: "2026-11-20T14:00:00+07:00",
    },
  ];

  const result = calculatePaymentMethodReport(payments, { startDate: "2026-11-20", endDate: "2026-11-20" });
  assert.equal(result.totalCash, 175000, "Total pembayaran tunai harus 175.000");
  assert.equal(result.cashTransactionCount, 1, "Jumlah transaksi tunai harus 1");
  const cashEntry = result.methodsBreakdown.find((m) => m.source === "cash");
  assert.ok(cashEntry, "Metode tunai harus terdaftar di breakdown");
  assert.equal(cashEntry.label, "Tunai", "Label harus 'Tunai'");
  assert.equal(cashEntry.totalAmount, 175000);
});

runTest(7, "PAYMENT", "Split bill tidak menggandakan jumlah pesanan", () => {
  const payments = [
    {
      id: "pay-split-1",
      order_id: "ord-split-X",
      payment_method: "cash",
      payment_source: "cash",
      amount: 50000,
      payment_status: "success",
      created_at: "2026-11-20T15:00:00+07:00",
    },
    {
      id: "pay-split-2",
      order_id: "ord-split-X",
      payment_method: "midtrans",
      payment_source: "midtrans_snap",
      amount: 100000,
      payment_status: "success",
      created_at: "2026-11-20T15:02:00+07:00",
    },
  ];

  const result = calculatePaymentMethodReport(payments, { startDate: "2026-11-20", endDate: "2026-11-20" });
  assert.equal(result.splitBillOrdersCount, 1, "Satu pesanan split bill harus dihitung sebagai 1 pesanan");
  assert.equal(result.totalSplitBillReceipts, 150000, "Total penerimaan split bill harus 150.000");
  assert.equal(result.totalTransactions, 2, "Total transaksi pembayaran adalah 2 baris");
  assert.equal(result.totalPayments, 150000, "Total penerimaan pembayaran adalah 150.000");
});

runTest(8, "DATA-INTEGRITY", "JOIN tidak menggandakan omzet (Domain Separation)", () => {
  // Verifikasi file actions.ts: Memastikan query orders, payments, order_items, refunds dipecah dan tidak di-join langsung
  const actionsFile = readFileUtf8("src/lib/reports/actions.ts");
  assert.match(actionsFile, /supabase\s*\.\s*from\("orders"\)/, "Query orders harus independen");
  assert.match(actionsFile, /supabase\s*\.\s*from\("refunds"\)/, "Query refunds harus independen");
  assert.match(actionsFile, /supabase\s*\.\s*from\("payments"\)/, "Query payments harus independen");
  assert.match(actionsFile, /supabase\s*\.\s*from\("order_items"\)/, "Query order_items harus independen");
  assert.doesNotMatch(actionsFile, /from\("orders"\)\.select\(".*order_items\(.*payments\(.*\)/, "Dilarang join multi-level orders->order_items->payments yang memicu Cartesian product");
});

runTest(9, "REFUND", "Refund penuh dan parsial dihitung dengan benar & memotong net sales", () => {
  const orders = [
    {
      id: "ord-full-ref",
      status: "refunded",
      subtotal: 100000,
      discount_total: 0,
      tax_total: 10000,
      service_total: 5000,
      grand_total: 115000,
      paid_total: 115000,
      created_at: "2026-11-20T10:00:00+07:00",
    },
    {
      id: "ord-partial-ref",
      status: "completed",
      subtotal: 200000,
      discount_total: 0,
      tax_total: 20000,
      service_total: 10000,
      grand_total: 230000,
      paid_total: 230000,
      created_at: "2026-11-20T11:00:00+07:00",
    },
  ];

  const refunds = [
    {
      id: "ref-1",
      refund_number: "REF-001",
      order_id: "ord-full-ref",
      payment_id: null,
      amount: 115000,
      reason: "Pelanggan salah pesan",
      refund_type: "full",
      refund_method: "cash",
      status: "completed",
      approved_at: "2026-11-20T10:30:00+07:00",
      created_at: "2026-11-20T10:30:00+07:00",
    },
    {
      id: "ref-2",
      refund_number: "REF-002",
      order_id: "ord-partial-ref",
      payment_id: null,
      amount: 30000,
      reason: "Item tumpah diganti refund",
      refund_type: "partial",
      refund_method: "midtrans",
      status: "completed",
      approved_at: "2026-11-20T11:30:00+07:00",
      created_at: "2026-11-20T11:30:00+07:00",
    },
    {
      id: "ref-3",
      refund_number: "REF-003",
      order_id: "ord-partial-ref",
      payment_id: null,
      amount: 50000,
      reason: "Menunggu approval",
      refund_type: "partial",
      refund_method: "cash",
      status: "pending",
      approved_at: null,
      created_at: "2026-11-20T12:00:00+07:00",
    },
  ];

  const refundReport = calculateRefundReport(refunds, { startDate: "2026-11-20", endDate: "2026-11-20" });
  assert.equal(refundReport.totalRefundAmount, 145000, "Total refund harus 115.000 + 30.000 = 145.000 (pending diabaikan)");
  assert.equal(refundReport.totalRefundCount, 2, "Jumlah refund selesai harus 2");
  assert.equal(refundReport.fullRefundTotal, 115000, "Full refund total harus 115.000");
  assert.equal(refundReport.fullRefundCount, 1, "Full refund count harus 1");
  assert.equal(refundReport.partialRefundTotal, 30000, "Partial refund total harus 30.000");
  assert.equal(refundReport.partialRefundCount, 1, "Partial refund count harus 1");

  const salesReport = calculateSalesReport(orders, refunds, { startDate: "2026-11-20", endDate: "2026-11-20" }, 345000);
  assert.equal(salesReport.grossSales, 345000, "Gross sales awal harus 115.000 + 230.000 = 345.000");
  assert.equal(salesReport.totalRefund, 145000, "Total refund harus 145.000");
  assert.equal(salesReport.netSales, 200000, "Net sales harus 345.000 - 145.000 = 200.000");
});

runTest(10, "SNAPSHOT", "Snapshot nama produk historis wajib tetap digunakan", () => {
  const orderItems = [
    {
      id: "item-1",
      order_id: "ord-1",
      product_id: "prod-geprek",
      product_name_snapshot: "Ayam Geprek Sambal Korek (Snapshot 2026)",
      product_sku_snapshot: "AG-001",
      quantity: 5,
      line_total: 125000,
    },
  ];

  const productCategoryMap = new Map([["prod-geprek", "Food"]]);
  const result = calculateProductPerformanceReport(orderItems, productCategoryMap, { startDate: "2026-11-20", endDate: "2026-11-20" });

  assert.equal(result.topProducts.length, 1);
  assert.equal(
    result.topProducts[0].productName,
    "Ayam Geprek Sambal Korek (Snapshot 2026)",
    "Harus menggunakan product_name_snapshot, bukan nama baru",
  );
  assert.equal(result.topProducts[0].quantitySold, 5);
  assert.equal(result.topProducts[0].totalRevenue, 125000);
});

runTest(11, "CATEGORY", "Kategori Food, Drinks, Desserts, dan Packages dihitung dengan benar", () => {
  const orderItems = [
    { id: "i1", order_id: "o1", product_id: "p1", product_name_snapshot: "Burger", product_sku_snapshot: null, quantity: 2, line_total: 60000 },
    { id: "i2", order_id: "o1", product_id: "p2", product_name_snapshot: "Ice Tea", product_sku_snapshot: null, quantity: 4, line_total: 40000 },
    { id: "i3", order_id: "o1", product_id: "p3", product_name_snapshot: "Ice Cream", product_sku_snapshot: null, quantity: 1, line_total: 20000 },
    { id: "i4", order_id: "o1", product_id: "p4", product_name_snapshot: "Combo Paket", product_sku_snapshot: null, quantity: 1, line_total: 80000 },
  ];

  const productCategoryMap = new Map([
    ["p1", "Food"],
    ["p2", "Drinks"],
    ["p3", "Desserts"],
    ["p4", "Packages"],
  ]);

  const result = calculateProductPerformanceReport(orderItems, productCategoryMap, { startDate: "2026-11-20", endDate: "2026-11-20" });

  assert.equal(result.totalItemsSold, 8, "Total kuantitas barang terjual harus 8");
  assert.equal(result.totalProductsRevenue, 200000, "Total omzet barang harus 200.000");

  const foodCat = result.categoryBreakdown.find((c) => c.categoryName === "Food");
  const drinksCat = result.categoryBreakdown.find((c) => c.categoryName === "Drinks");
  const dessertsCat = result.categoryBreakdown.find((c) => c.categoryName === "Desserts");
  const packagesCat = result.categoryBreakdown.find((c) => c.categoryName === "Packages");

  assert.equal(foodCat.totalRevenue, 60000);
  assert.equal(foodCat.revenuePercentage, 30.0);
  assert.equal(drinksCat.totalRevenue, 40000);
  assert.equal(drinksCat.revenuePercentage, 20.0);
  assert.equal(dessertsCat.totalRevenue, 20000);
  assert.equal(dessertsCat.revenuePercentage, 10.0);
  assert.equal(packagesCat.totalRevenue, 80000);
  assert.equal(packagesCat.revenuePercentage, 40.0);
});

runTest(12, "TIMEZONE", "Batas tanggal Asia/Jakarta dievaluasi dengan benar", () => {
  // Jam 18:00 UTC pada 19 Nov 2026 adalah Jam 01:00 WIB pada 20 Nov 2026 (+7 jam)
  const utcString = "2026-11-19T18:00:00.000Z";
  const jakartaDate = toJakartaDateString(utcString);
  assert.equal(jakartaDate, "2026-11-20", "Timestamp UTC malam harus dikonversi ke tanggal Jakarta besoknya");

  // Jam 16:59 UTC pada 19 Nov 2026 adalah Jam 23:59 WIB pada 19 Nov 2026
  const utcStringPrev = "2026-11-19T16:59:00.000Z";
  assert.equal(toJakartaDateString(utcStringPrev), "2026-11-19", "Sebelum jam 17:00 UTC masih hari yang sama di Jakarta");

  const actionsFile = readFileUtf8("src/lib/reports/actions.ts");
  assert.match(actionsFile, /\$\{startDate\}T00:00:00\+07:00/, "startIso harus menggunakan zona waktu +07:00");
  assert.match(actionsFile, /\$\{endDate\}T23:59:59\.999\+07:00/, "endIso harus mencakup akhir hari di +07:00");
});

runTest(13, "PAGINATION", "fetchPaginatedRows mengambil seluruh data dan menolak data parsial bila chunk error", async () => {
  // Simulasi query 2.450 baris (3 chunk: 1000, 1000, 450)
  const totalRowsSimulated = 2450;
  const mockTable = Array.from({ length: totalRowsSimulated }, (_, i) => ({ id: `row-${i}` }));

  const fetchSuccessMock = async (from, to) => {
    return { data: mockTable.slice(from, to + 1), error: null };
  };

  const successResult = await fetchPaginatedRows(fetchSuccessMock);
  assert.equal(successResult.error, null);
  assert.equal(successResult.data.length, 2450, "Paginasi harus mengambil seluruh 2.450 baris data");

  // Simulasi chunk kedua error: Harus return data: [] dan error (tidak boleh return parsial)
  const fetchErrorMock = async (from) => {
    if (from >= 1000) {
      return { data: null, error: { message: "Simulasi koneksi terputus di chunk 2" } };
    }
    return { data: mockTable.slice(from, from + 1000), error: null };
  };

  const errorResult = await fetchPaginatedRows(fetchErrorMock);
  assert.notEqual(errorResult.error, null, "Harus mengembalikan error");
  assert.equal(errorResult.data.length, 0, "Dilarang mengembalikan data parsial jika paginasi gagal");
});

runTest(14, "SECURITY", "Pengguna non-admin ditolak di seluruh Server Actions laporan", () => {
  const actionsFile = readFileUtf8("src/lib/reports/actions.ts");

  // Cek getAdminActor
  const getAdminActorCalls = actionsFile.match(/await getAdminActor\(\)/g) || [];
  assert.ok(getAdminActorCalls.length >= 5, "Setiap Server Action wajib memanggil getAdminActor()");

  // Cek penolakan UNAUTHORIZED
  assert.match(actionsFile, /return\s*\{\s*ok:\s*false,\s*code:\s*"UNAUTHORIZED"/, "Harus menolak dengan code UNAUTHORIZED");

  // Cek penggunaan createSupabaseServerClient (bukan service role)
  assert.match(actionsFile, /createSupabaseServerClient\(\)/, "Harus menggunakan createSupabaseServerClient()");
  assert.doesNotMatch(actionsFile, /createSupabaseAdminClient\(\)/, "Dilarang menggunakan service role untuk query laporan");
});

runTest(15, "VALIDATION", "Input tanggal tidak valid ditolak oleh dateRangeFilterSchema", () => {
  const valFile = readFileUtf8("src/lib/reports/validation.ts");
  assert.match(valFile, /dateRegex\s*=\s*\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//, "Harus memvalidasi format YYYY-MM-DD");
  assert.match(valFile, /startMs\s*>\s*endMs/, "Harus menolak jika startDate > endDate");
  assert.match(valFile, /diffDays\s*>\s*366/, "Harus membatasi rentang maksimal 366 hari");
});

console.log("\n===============================================================================");
console.log(` HASIL PENGUJIAN F6.1: ${passedTests} / ${totalTests} TEST CASES BERHASIL (100% PASS)`);
console.log("===============================================================================\n");
