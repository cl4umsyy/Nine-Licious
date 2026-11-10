import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

export type MidtransSignatureInput = {
  orderId: string;
  statusCode: string;
  grossAmount: string;
  signatureKey: string;
  serverKey: string;
};

/**
 * Verifies the Midtrans notification signature:
 *
 * SHA512(order_id + status_code + gross_amount + server_key)
 *
 * The values must be used exactly as sent by Midtrans (gross_amount is a
 * decimal string, not a parsed number). A valid signature is necessary but not
 * sufficient: the webhook handler must also re-fetch the transaction status
 * from Midtrans before changing payment state.
 */
export function verifyMidtransSignature({
  orderId,
  statusCode,
  grossAmount,
  signatureKey,
  serverKey,
}: MidtransSignatureInput): boolean {
  if (!orderId || !statusCode || !grossAmount || !signatureKey || !serverKey) {
    return false;
  }

  const expected = createHash("sha512")
    .update(`${orderId}${statusCode}${grossAmount}${serverKey}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(signatureKey.toLowerCase(), "utf8");

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}
