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
 * Memverifikasi tanda tangan digital resmi webhook notifikasi Midtrans:
 *
 * SHA512(order_id + status_code + gross_amount + server_key)
 *
 * Persyaratan Keamanan:
 * 1. Hanya menggunakan Server Key rahasia (bukan Client Key).
 * 2. Nilai order_id, status_code, dan gross_amount dipakai apa adanya sesuai payload Midtrans.
 * 3. Format signature_key wajib 128 karakter heksadesimal SHA-512.
 * 4. Perbandingan dilakukan menggunakan timingSafeEqual untuk mencegah timing attack.
 */
export function verifyMidtransSignature({
  orderId,
  statusCode,
  grossAmount,
  signatureKey,
  serverKey,
}: MidtransSignatureInput): boolean {
  if (
    !orderId ||
    !statusCode ||
    !grossAmount ||
    !signatureKey ||
    !serverKey ||
    typeof orderId !== "string" ||
    typeof statusCode !== "string" ||
    typeof grossAmount !== "string" ||
    typeof signatureKey !== "string" ||
    typeof serverKey !== "string"
  ) {
    return false;
  }

  const trimmedOrderId = orderId.trim();
  const trimmedStatusCode = statusCode.trim();
  const trimmedGross = grossAmount.trim();
  const trimmedSig = signatureKey.trim().toLowerCase();
  const trimmedKey = serverKey.trim();

  if (
    !trimmedOrderId ||
    !trimmedStatusCode ||
    !trimmedGross ||
    !trimmedSig ||
    !trimmedKey
  ) {
    return false;
  }

  // SHA-512 menghasilkan tepat 128 karakter heksadesimal [0-9a-f]
  if (!/^[0-9a-f]{128}$/.test(trimmedSig)) {
    return false;
  }

  const expected = createHash("sha512")
    .update(`${trimmedOrderId}${trimmedStatusCode}${trimmedGross}${trimmedKey}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(trimmedSig, "utf8");

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}
