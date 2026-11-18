import type { KdsStatus, OrderStatus, OrderType, PaymentStatus } from "@/types/database";

export type PendingServingItem = {
  id: string;
  productName: string;
  quantity: number;
  notes: string | null;
  modifiers: string[];
};

export type PendingServingOrder = {
  id: string;
  orderNumber: string;
  queueNumber: string | null;
  orderType: OrderType;
  tableId: string | null;
  tableName: string | null;
  diningSessionId: string | null;
  isAdditionalOrder: boolean;
  sessionOrderIndex: number;
  kdsStatus: "ready";
  readyAt: string;
  createdAt: string;
  updatedAt: string;
  items: PendingServingItem[];
  totalItemCount: number;
};

export type PendingServingBoardData = {
  orders: PendingServingOrder[];
  syncedAt: string;
  schemaReady: boolean;
  migrationNotice?: string | null;
};

export type ConfirmOrderServedResultData = {
  orderId: string;
  orderNumber: string;
  queueNumber: string | null;
  orderType: OrderType;
  tableId: string | null;
  diningSessionId: string | null;
  servedAt: string;
  servedBy: string;
};

export type OrderServingCandidate = {
  id?: string;
  order_number?: string;
  status: OrderStatus | string;
  payment_status: PaymentStatus | string;
  kds_status: KdsStatus | string | null | undefined;
  served_at?: string | null;
  grand_total?: number | null;
  paid_total?: number | null;
};

const SETTLED_PAYMENT_STATUSES = new Set(["paid", "partially_refunded"]);

/**
 * Returns true ONLY when an order is paid, marked `ready` by kitchen,
 * and has NOT yet been confirmed as served.
 */
export function isOrderPendingServing(order: OrderServingCandidate): boolean {
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

export type ServingValidationResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Validates whether a cashier/admin can confirm serving for a given order.
 * Enforces:
 * - Not already served
 * - Not refunded, cancelled, or completed
 * - Fully paid (paid or partially_refunded with paid_total >= grand_total)
 * - KDS status is strictly `ready`
 */
export function validateOrderServingConfirmation(
  order: OrderServingCandidate,
): ServingValidationResult {
  const label = order.order_number ? `#${order.order_number}` : "ini";

  if (order.served_at) {
    return {
      ok: false,
      message: `Pesanan ${label} sudah pernah dikonfirmasi disajikan sebelumnya.`,
    };
  }

  if (order.status === "refunded") {
    return {
      ok: false,
      message: `Pesanan ${label} telah direfund penuh dan tidak dapat dikonfirmasi disajikan.`,
    };
  }

  if (order.status === "cancelled") {
    return {
      ok: false,
      message: `Pesanan ${label} telah dibatalkan dan tidak dapat dikonfirmasi disajikan.`,
    };
  }

  if (order.status === "completed") {
    return {
      ok: false,
      message: `Pesanan ${label} sudah berstatus selesai.`,
    };
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
    return {
      ok: false,
      message: `Pesanan ${label} belum lunas dan tidak dapat dikonfirmasi penyajiannya.`,
    };
  }

  if (order.kds_status !== "ready") {
    return {
      ok: false,
      message: `Pesanan ${label} belum berstatus Siap Diambil dari dapur (status saat ini: ${order.kds_status ?? "tidak aktif"}).`,
    };
  }

  return { ok: true };
}

/**
 * Deduplicates pending-serving orders by `id` and sorts chronologically by `readyAt`
 * ascending (FIFO: pesanan yang lebih lama siap tampil lebih dulu).
 */
export function mergePendingServingOrdersById(
  orders: PendingServingOrder[],
): PendingServingOrder[] {
  const byId = new Map<string, PendingServingOrder>();

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
    const readyDiff = Date.parse(a.readyAt) - Date.parse(b.readyAt);
    if (readyDiff !== 0 && !Number.isNaN(readyDiff)) {
      return readyDiff;
    }
    return a.orderNumber.localeCompare(b.orderNumber);
  });
}

/**
 * Detects PostgreSQL/PostgREST errors indicating that the serving confirmation
 * migration (`20261118000100_order_serving_confirmation.sql`) has not yet been
 * applied to Supabase.
 */
export function isMissingServingSchemaError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const msg = (error.message ?? "").toLowerCase();

  if (code === "42703" || code === "PGRST204" || code === "PGRST202" || code === "42883") {
    return true;
  }

  const isMissingObjectMessage =
    msg.includes("does not exist") || msg.includes("could not find");
  const targetsServingSchema =
    msg.includes("served_at") ||
    msg.includes("served_by") ||
    msg.includes("confirm_order_served_atomic");

  return isMissingObjectMessage && targetsServingSchema;
}
