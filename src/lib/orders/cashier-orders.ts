import type {
  KdsStatus,
  OrderKind,
  OrderStatus,
  OrderType,
  PaymentStatus,
} from "@/types/database";

export type CashierOrderFilter =
  | "all"
  | "awaiting_payment"
  | "queued"
  | "preparing"
  | "ready"
  | "served";

export type CashierOrderItemSummary = {
  id: string;
  productName: string;
  quantity: number;
  notes: string | null;
  modifiers: string[];
};

export type CashierOrderListItem = {
  id: string;
  orderNumber: string;
  queueNumber: string | null;
  orderType: OrderType;
  orderKind?: OrderKind;
  parentOrderId?: string | null;
  tableId: string | null;
  tableName: string | null;
  diningSessionId: string | null;
  customerName: string | null;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  kdsStatus: KdsStatus | null;
  isFinalized: boolean;
  grandTotal: number;
  paidTotal: number;
  remainingBalance: number;
  servedAt: string | null;
  servedBy: string | null;
  createdAt: string;
  updatedAt: string;
  items: CashierOrderItemSummary[];
  totalItemCount: number;
};

export type CashierOrdersBoardData = {
  orders: CashierOrderListItem[];
  syncedAt: string;
  servingSchemaReady: boolean;
};

export const CASHIER_ORDER_FILTER_LABELS: Record<CashierOrderFilter, string> = {
  all: "Semua",
  awaiting_payment: "Menunggu Pembayaran",
  queued: "Diproses",
  preparing: "Sedang Disiapkan",
  ready: "Siap Diambil",
  served: "Sudah Disajikan",
};

export const CASHIER_ORDER_FILTERS: readonly CashierOrderFilter[] = [
  "all",
  "awaiting_payment",
  "queued",
  "preparing",
  "ready",
  "served",
] as const;

export function getPaymentStatusLabel(paymentStatus: PaymentStatus): string {
  switch (paymentStatus) {
    case "unpaid":
      return "Belum Bayar";
    case "partially_paid":
      return "Sebagian Dibayar";
    case "paid":
      return "Lunas";
    case "partially_refunded":
      return "Refund Sebagian";
    case "refunded":
      return "Direfund Penuh";
  }
}

export function getKitchenStatusLabel(order: {
  status: OrderStatus;
  kdsStatus: KdsStatus | null;
}): string {
  if (order.status === "cancelled") return "Dibatalkan";
  if (order.status === "refunded") return "Dihentikan (Refund)";
  if (order.status === "awaiting_payment" || order.status === "partially_paid") {
    return "Menunggu Lunas";
  }
  if (order.kdsStatus === "queued") return "Pesanan Masuk";
  if (order.kdsStatus === "preparing") return "Sedang Disiapkan";
  if (order.kdsStatus === "ready") return "Siap Diambil";
  if (order.status === "completed") return "Selesai";
  return "—";
}

export function getServingStatusLabel(order: {
  status: OrderStatus;
  kdsStatus: KdsStatus | null;
  servedAt: string | null;
}): string {
  if (order.status === "cancelled") return "Dibatalkan";
  if (order.status === "refunded") return "Direfund Penuh";
  if (order.servedAt) return "Sudah Disajikan";
  if (order.status === "completed") return "Selesai";
  if (order.status === "paid" && order.kdsStatus === "ready") {
    return "Menunggu Disajikan";
  }
  if (order.status === "paid") return "Menunggu Dapur";
  return "Belum Dibayar";
}

/**
 * Matches an order against one of the cashier status filters using
 * strictly real database columns (`status`, `kdsStatus`, `servedAt`).
 */
export function matchesCashierOrderFilter(
  order: Pick<CashierOrderListItem, "status" | "kdsStatus" | "servedAt">,
  filter: CashierOrderFilter,
): boolean {
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

export function filterCashierOrders(
  orders: CashierOrderListItem[],
  params: {
    statusFilter: CashierOrderFilter;
    orderTypeFilter: "all" | OrderType;
    searchQuery: string;
  },
): CashierOrderListItem[] {
  const query = params.searchQuery.trim().toLowerCase();

  return orders.filter((order) => {
    if (!matchesCashierOrderFilter(order, params.statusFilter)) {
      return false;
    }

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
      const matched = haystacks.some((value) =>
        value.toLowerCase().includes(query),
      );
      if (!matched) return false;
    }

    return true;
  });
}

/**
 * Deduplicates orders by `id` (latest `updatedAt` wins) and sorts newest first.
 */
export function mergeCashierOrdersById(
  orders: CashierOrderListItem[],
): CashierOrderListItem[] {
  const byId = new Map<string, CashierOrderListItem>();

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
    const createdDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (createdDiff !== 0 && !Number.isNaN(createdDiff)) {
      return createdDiff;
    }
    return b.orderNumber.localeCompare(a.orderNumber);
  });
}
