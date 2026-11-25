/**
 * Shared order status rules for cancellation, payment eligibility, and receipt issuance.
 * Used uniformly across both Server Actions and Client Components so every POS/Admin
 * screen enforces the exact same transition guards.
 */

export type OrderStatusCheckInput = {
  status?: string | null;
  payment_status?: string | null;
  paymentStatus?: string | null;
  paid_total?: number | null;
  paidTotal?: number | null;
};

/**
 * Checks whether an order may be cancelled via `cancelPosOrderAction`.
 * Allowed strictly for unpaid orders (`awaiting_payment` / `partially_paid` with zero paid_total).
 * Paid, completed, refunded, or already cancelled orders are rejected.
 */
export function canCancelOrder(order: OrderStatusCheckInput | null | undefined): boolean {
  if (!order) return false;
  const status = order.status ?? "";
  const paymentStatus = order.payment_status ?? order.paymentStatus ?? "";
  const paidTotal = Number(order.paid_total ?? order.paidTotal ?? 0);

  if (status !== "awaiting_payment" && status !== "partially_paid") {
    return false;
  }
  if (paymentStatus !== "unpaid" && paymentStatus !== "partially_paid") {
    return false;
  }
  if (paidTotal > 0) {
    return false;
  }
  return true;
}

/**
 * Checks whether an order may accept any new payment (Cash, Midtrans Snap, Split Bill).
 * Cancelled, refunded, completed, or already-paid orders can never be paid.
 */
export function canPayOrder(order: OrderStatusCheckInput | null | undefined): boolean {
  if (!order) return false;
  const status = order.status ?? "";
  const paymentStatus = order.payment_status ?? order.paymentStatus ?? "";

  if (status !== "awaiting_payment" && status !== "partially_paid") {
    return false;
  }
  if (paymentStatus !== "unpaid" && paymentStatus !== "partially_paid") {
    return false;
  }
  return true;
}

/**
 * Checks whether an order may legitimately display/print a payment receipt.
 * Cancelled, unpaid, pending, or expired orders without recorded payment cannot produce a receipt.
 */
export function canShowReceiptForOrder(order: OrderStatusCheckInput | null | undefined): boolean {
  if (!order) return false;
  const status = order.status ?? "";
  const paymentStatus = order.payment_status ?? order.paymentStatus ?? "";
  const paidTotal = Number(order.paid_total ?? order.paidTotal ?? 0);

  if (status === "cancelled") {
    return false;
  }
  if (paidTotal <= 0 || paymentStatus === "unpaid") {
    return false;
  }
  return true;
}

/**
 * Checks whether an order is in a closed terminal non-payable state (cancelled or refunded).
 */
export function isOrderCancelledOrRefunded(order: OrderStatusCheckInput | null | undefined): boolean {
  if (!order) return false;
  const status = order.status ?? "";
  const paymentStatus = order.payment_status ?? order.paymentStatus ?? "";
  return status === "cancelled" || status === "refunded" || paymentStatus === "refunded";
}
