export type MidtransTransactionStatus = string;

/**
 * Midtrans considers a card payment paid only when transaction_status is
 * `capture` with fraud_status `accept`, or when it is already `settlement`.
 * For other payment methods the paid state is `settlement`.
 *
 * This helper must only be used after the webhook signature is verified and
 * the transaction status has been re-fetched from Midtrans.
 */
export function isMidtransPaidStatus(
  transactionStatus: MidtransTransactionStatus,
  fraudStatus?: string | null,
): boolean {
  if (transactionStatus === "settlement") {
    return true;
  }

  return transactionStatus === "capture" && fraudStatus === "accept";
}
