import type { MidtransLifecycleStatus } from "@/types/database";

/**
 * Status lifecycle Midtrans yang dianggap masih mereservasi nominal tagihan,
 * selaras 100% dengan fungsi SQL `calculate_active_gateway_reserved_amount`.
 */
export const ACTIVE_RESERVATION_LIFECYCLE_STATUSES: readonly MidtransLifecycleStatus[] = [
  "initiated",
  "token_created",
  "pending",
  "capture_challenge",
  "reconciliation_required",
] as const;

export const CANCELLABLE_LIFECYCLE_STATUSES: readonly MidtransLifecycleStatus[] = [
  "initiated",
  "token_created",
  "pending",
] as const;

export type ActiveMidtransReservationInfo = {
  id: string;
  midtransOrderId: string;
  grossAmount: number;
  lifecycleStatus: MidtransLifecycleStatus;
  midtransTransactionStatus: string | null;
  snapToken: string | null;
  paymentExpiresAt: string;
  isExpired: boolean;
  canReopenSnap: boolean;
  canCancel: boolean;
};

export type OrderPaymentAvailability = {
  grandTotal: number;
  paidTotal: number;
  remainingBalance: number;
  reservedAmount: number;
  availableForCashAmount: number;
  isFullyReservedByGateway: boolean;
};

export function isMidtransTransactionExpired(
  paymentExpiresAt: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!paymentExpiresAt) return false;
  const expiresMs = Date.parse(paymentExpiresAt);
  if (Number.isNaN(expiresMs)) return false;
  return expiresMs <= nowMs;
}

export function canReopenMidtransSnap(params: {
  snapToken: string | null | undefined;
  lifecycleStatus: string | null | undefined;
  paymentExpiresAt: string | null | undefined;
  nowMs?: number;
}): boolean {
  if (!params.snapToken) return false;
  if (
    params.lifecycleStatus !== "token_created" &&
    params.lifecycleStatus !== "pending"
  ) {
    return false;
  }
  return !isMidtransTransactionExpired(params.paymentExpiresAt, params.nowMs);
}

export function canCancelMidtransReservation(
  lifecycleStatus: string | null | undefined,
): boolean {
  return (
    typeof lifecycleStatus === "string" &&
    (CANCELLABLE_LIFECYCLE_STATUSES as readonly string[]).includes(
      lifecycleStatus,
    )
  );
}

export function computeOrderPaymentAvailability(params: {
  grandTotal: number;
  paidTotal: number;
  reservedAmount: number;
}): OrderPaymentAvailability {
  const grandTotal = Math.max(0, Math.round(Number(params.grandTotal) || 0));
  const paidTotal = Math.max(0, Math.round(Number(params.paidTotal) || 0));
  const remainingBalance = Math.max(0, grandTotal - paidTotal);
  const reservedAmount = Math.max(0, Math.round(Number(params.reservedAmount) || 0));
  const availableForCashAmount = Math.max(0, remainingBalance - reservedAmount);

  return {
    grandTotal,
    paidTotal,
    remainingBalance,
    reservedAmount,
    availableForCashAmount,
    isFullyReservedByGateway:
      remainingBalance > 0 && availableForCashAmount === 0 && reservedAmount > 0,
  };
}
