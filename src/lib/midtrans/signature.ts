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
 * Menghitung tanda tangan digital resmi Midtrans:
 *
 *   SHA512(order_id + status_code + gross_amount + server_key)
 *
 * Menggunakan nilai string mentah tanpa separator tambahan dan tanpa konversi float/Rupiah.
 */
export function computeMidtransSignature(params: {
  orderId: string;
  statusCode: string;
  grossAmount: string;
  serverKey: string;
}): string {
  return createHash("sha512")
    .update(
      `${params.orderId.trim()}${params.statusCode.trim()}${params.grossAmount.trim()}${params.serverKey.trim()}`,
    )
    .digest("hex");
}

/**
 * Memverifikasi tanda tangan digital resmi webhook notifikasi Midtrans:
 *
 *   SHA512(order_id + status_code + gross_amount + server_key)
 *
 * Persyaratan Keamanan:
 * 1. Hanya menggunakan Server Key rahasia (bukan Client Key).
 * 2. Nilai order_id, status_code, dan gross_amount dipakai apa adanya sesuai payload Midtrans.
 * 3. Format signature_key wajib 128 karakter heksadesimal SHA-512.
 * 4. Perbandingan dilakukan menggunakan timingSafeEqual untuk mencegah timing attack.
 * 5. Tidak pernah mencetak serverKey maupun signatureKey ke log.
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

  const expected = computeMidtransSignature({
    orderId: trimmedOrderId,
    statusCode: trimmedStatusCode,
    grossAmount: trimmedGross,
    serverKey: trimmedKey,
  });

  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(trimmedSig, "utf8");

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

/**
 * Memverifikasi signature webhook menggunakan Server Key resmi (dan optional
 * MIDTRANS_SIGNATURE_KEY jika akun Midtrans mengonfigurasi Signature Secret Key terpisah).
 * Tidak pernah menerima signature kosong/invalid dan tidak pernah fallback ke Production.
 */
export function verifyMidtransWebhookSignature(params: {
  orderId: string;
  statusCode: string;
  grossAmount: string;
  signatureKey: string;
  serverKey: string;
  additionalSignatureKey?: string | null;
}): boolean {
  const matchesServerKey = verifyMidtransSignature({
    orderId: params.orderId,
    statusCode: params.statusCode,
    grossAmount: params.grossAmount,
    signatureKey: params.signatureKey,
    serverKey: params.serverKey,
  });

  if (matchesServerKey) {
    return true;
  }

  const altKey =
    typeof params.additionalSignatureKey === "string"
      ? params.additionalSignatureKey.trim()
      : "";

  if (!altKey || altKey === params.serverKey.trim()) {
    return false;
  }

  return verifyMidtransSignature({
    orderId: params.orderId,
    statusCode: params.statusCode,
    grossAmount: params.grossAmount,
    signatureKey: params.signatureKey,
    serverKey: altKey,
  });
}

/**
 * Mem-parsing string `gross_amount` Midtrans IDR (misal "43700.00" atau "43700")
 * secara ketat tanpa risiko floating-point drift.
 * Menolak format Rupiah ("Rp 43.700"), desimal non-nol ("43700.50"), angka negatif, atau NaN.
 */
export function parseMidtransGrossAmount(rawGrossAmount: unknown): number | null {
  if (typeof rawGrossAmount !== "string") {
    return null;
  }

  const trimmed = rawGrossAmount.trim();
  const match = /^(\d+)(?:\.(0+))?$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const integerValue = Number(match[1]);
  if (!Number.isSafeInteger(integerValue) || integerValue <= 0) {
    return null;
  }

  return integerValue;
}
