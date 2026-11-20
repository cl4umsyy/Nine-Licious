import type {
  CategoryPerformanceItem,
  DailySalesBreakdown,
  PaymentMethodReportData,
  PaymentMethodSummary,
  ProductPerformanceReportData,
  RefundMethodBreakdown,
  RefundReportData,
  RefundReportItem,
  SalesReportData,
  TopProductItem,
} from "./types";

export type RawOrderRow = {
  id: string;
  status: string;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  service_total: number;
  grand_total: number;
  paid_total: number;
  created_at: string;
};

export type RawPaymentRow = {
  id: string;
  order_id: string;
  payment_method: string;
  payment_source: string;
  amount: number;
  payment_status: string;
  created_at: string;
};

export type RawOrderItemRow = {
  id: string;
  order_id: string;
  product_id: string;
  product_name_snapshot: string;
  product_sku_snapshot: string | null;
  quantity: number;
  line_total: number;
};

export type RawRefundRow = {
  id: string;
  refund_number: string;
  order_id: string;
  payment_id: string | null;
  amount: number;
  reason: string;
  refund_type: string;
  refund_method: string;
  status: string;
  approved_at: string | null;
  created_at: string;
};

export type ProductCategoryMapping = {
  productId: string;
  categoryName: string;
};

const STANDARD_CATEGORIES = ["Food", "Drinks", "Desserts", "Packages"] as const;

/**
 * Format timestamp ISO ke tanggal lokal Jakarta (YYYY-MM-DD).
 */
export function toJakartaDateString(isoString: string): string {
  try {
    const date = new Date(isoString);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return isoString.split("T")[0] ?? isoString;
  }
}

/**
 * Mendapatkan tanggal hari ini dalam zona waktu Asia/Jakarta (YYYY-MM-DD).
 */
export function getJakartaDateToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Mendapatkan tanggal N hari yang lalu dalam zona waktu Asia/Jakarta (YYYY-MM-DD).
 */
export function getJakartaDateDaysAgo(days: number): string {
  const now = new Date();
  const past = new Date(now.getTime() - days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(past);
}

/**
 * Mendapatkan tanggal hari pertama bulan berjalan dalam zona waktu Asia/Jakarta (YYYY-MM-01).
 */
export function getJakartaFirstDayOfMonth(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return `${year}-${month}-01`;
}

/**
 * Agregasi Laporan Penjualan (Sales Report)
 * - Hanya pesanan berstatus paid, completed, atau refunded yang masuk hitungan.
 * - Pesanan awaiting_payment, partially_paid, dan cancelled DIABAIKAN.
 * - Refund sukses (status = completed) mengurangi netSales.
 * - Angka finansial dijaga dalam integer rupiah.
 */
export function calculateSalesReport(
  orders: RawOrderRow[],
  refunds: RawRefundRow[],
  period: { startDate: string; endDate: string },
  totalReceipts: number,
): SalesReportData {
  const eligibleOrders = orders.filter((order) =>
    ["paid", "completed", "refunded"].includes(order.status),
  );

  const completedRefunds = refunds.filter(
    (refund) => refund.status === "completed",
  );

  let grossSales = 0;
  let subtotal = 0;
  let totalDiscount = 0;
  let totalTax = 0;
  let totalServiceCharge = 0;

  const dailyMap = new Map<
    string,
    {
      grossSales: number;
      subtotal: number;
      totalDiscount: number;
      totalTax: number;
      totalServiceCharge: number;
      totalRefund: number;
      paidOrdersCount: number;
    }
  >();

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

  const dailyBreakdown: DailySalesBreakdown[] = Array.from(
    dailyMap.entries(),
  )
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

/**
 * Agregasi Laporan Metode Pembayaran & Split Bill
 * - Hanya pembayaran berhasil (status = success atau status = refunded) yang dihitung.
 * - Pembayaran pending, failed diabaikan.
 * - Split bill diidentifikasi dari pesanan yang memiliki > 1 pembayaran berhasil.
 * - Satu pesanan dengan beberapa pembayaran tetap dihitung sebagai 1 pesanan split bill.
 */
export function calculatePaymentMethodReport(
  payments: RawPaymentRow[],
  period: { startDate: string; endDate: string },
): PaymentMethodReportData {
  const successfulPayments = payments.filter((p) =>
    ["success", "refunded"].includes(p.payment_status),
  );

  let totalCash = 0;
  let totalMidtrans = 0;
  let cashTransactionCount = 0;
  let midtransTransactionCount = 0;
  let totalPayments = 0;

  const paymentsByOrder = new Map<string, RawPaymentRow[]>();
  const methodsMap = new Map<
    string,
    { method: string; source: string; label: string; totalAmount: number; transactionCount: number }
  >();

  function getMethodLabel(method: string, source: string): string {
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

  const methodsBreakdown: PaymentMethodSummary[] = Array.from(
    methodsMap.values(),
  ).sort((a, b) => b.totalAmount - a.totalAmount);

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

/**
 * Agregasi Performa Produk & Kategori
 * - Wajib menggunakan product_name_snapshot dari order_items.
 * - Menghitung produk terlaris berdasarkan kuantitas & omzet.
 * - Menghitung performa kategori utama: Food, Drinks, Desserts, Packages.
 */
export function calculateProductPerformanceReport(
  orderItems: RawOrderItemRow[],
  productCategoryMap: Map<string, string>,
  period: { startDate: string; endDate: string },
): ProductPerformanceReportData {
  const productAggMap = new Map<
    string,
    {
      productId: string;
      productName: string;
      sku: string | null;
      categoryName: string;
      quantitySold: number;
      totalRevenue: number;
    }
  >();

  const categoryAggMap = new Map<
    string,
    { categoryName: string; quantitySold: number; totalRevenue: number }
  >();

  for (const cat of STANDARD_CATEGORIES) {
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

  const topProducts: TopProductItem[] = Array.from(productAggMap.values()).sort(
    (a, b) => {
      if (b.quantitySold !== a.quantitySold) {
        return b.quantitySold - a.quantitySold;
      }
      return b.totalRevenue - a.totalRevenue;
    },
  );

  const categoryBreakdown: CategoryPerformanceItem[] = Array.from(
    categoryAggMap.values(),
  )
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

/**
 * Agregasi Laporan Refund
 * - Hanya refund berstatus completed yang masuk ke total aktual.
 * - Memisahkan full refund vs partial refund.
 * - Mengelompokkan berdasarkan metode refund.
 */
export function calculateRefundReport(
  refunds: RawRefundRow[],
  period: { startDate: string; endDate: string },
): RefundReportData {
  const completedRefunds = refunds.filter((r) => r.status === "completed");

  let totalRefundAmount = 0;
  let fullRefundTotal = 0;
  let fullRefundCount = 0;
  let partialRefundTotal = 0;
  let partialRefundCount = 0;

  const methodMap = new Map<
    string,
    { method: string; label: string; totalAmount: number; count: number }
  >();

  function getRefundMethodLabel(method: string): string {
    if (method === "cash") return "Tunai (Cash Drawer)";
    if (method === "midtrans") return "Midtrans Gateway";
    if (method === "transfer") return "Transfer Bank Manual";
    if (method === "manual") return "Manual";
    return method;
  }

  const refundItems: RefundReportItem[] = [];

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

  const refundsByMethod: RefundMethodBreakdown[] = Array.from(
    methodMap.values(),
  ).sort((a, b) => b.totalAmount - a.totalAmount);

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
