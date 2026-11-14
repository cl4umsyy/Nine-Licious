import { NextResponse } from "next/server";
import { getMidtransConfig } from "@/lib/midtrans/config";
import { verifyMidtransSignature } from "@/lib/midtrans/signature";
import {
  processMidtransWebhook,
  type MidtransWebhookPayload,
} from "@/lib/midtrans/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Midtrans HTTP Notification Webhook Handler.
 *
 * Persyaratan Keamanan:
 * 1. Hanya menerima metode POST.
 * 2. Parsing JSON aman (tolak JSON invalid & payload tidak lengkap dengan HTTP 400).
 * 3. Validasi digital signature SHA-512 menggunakan Midtrans Server Key sebelum mempercayai payload.
 * 4. Panggil domain handler processMidtransWebhook() setelah validasi signature.
 * 5. Exception ditangani secara eksplisit tanpa mengekspos rahasia internal atau stack trace.
 * 6. Respons HTTP sesuai kebijakan retry Midtrans:
 *    - HTTP 200 OK untuk ok: true (settled, duplicate, out-of-order, reconciliation_flagged)
 *      agar Midtrans berhenti mengulang pengiriman.
 *    - HTTP 500 / 401 / 400 untuk ok: false (error validasi, RPC error, failure)
 *      agar Midtrans melakukan retry sesuai jadwal gateway.
 */
export async function POST(request: Request): Promise<NextResponse> {
  // 1. Parsing JSON aman
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON payload." },
      { status: 400 },
    );
  }

  // 2. Validasi kelengkapan struktur dasar payload
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { ok: false, error: "Payload must be a JSON object." },
      { status: 400 },
    );
  }

  const rawPayload = body as Record<string, unknown>;
  const orderId = typeof rawPayload.order_id === "string" ? rawPayload.order_id.trim() : "";
  const statusCode = typeof rawPayload.status_code === "string" ? rawPayload.status_code.trim() : "";
  const grossAmount = typeof rawPayload.gross_amount === "string" ? rawPayload.gross_amount.trim() : "";
  const signatureKey = typeof rawPayload.signature_key === "string" ? rawPayload.signature_key.trim() : "";
  const transactionStatus =
    typeof rawPayload.transaction_status === "string" ? rawPayload.transaction_status.trim() : "";

  if (!orderId || !statusCode || !grossAmount || !signatureKey || !transactionStatus) {
    return NextResponse.json(
      { ok: false, error: "Incomplete Midtrans notification payload." },
      { status: 400 },
    );
  }

  // 3. Ambil konfigurasi gateway server-only
  const config = getMidtransConfig();
  if (!config) {
    return NextResponse.json(
      { ok: false, error: "Midtrans gateway is not configured or disabled." },
      { status: 503 },
    );
  }

  // 4. Verifikasi digital signature SHA-512 dengan Server Key resmi sebelum memanggil domain handler
  const isSignatureValid = verifyMidtransSignature({
    orderId,
    statusCode,
    grossAmount,
    signatureKey,
    serverKey: config.serverKey,
  });

  if (!isSignatureValid) {
    return NextResponse.json(
      { ok: false, error: "Invalid Midtrans signature." },
      { status: 401 },
    );
  }

  // 5. Serahkan ke domain handler pemrosesan webhook & settlement dengan explicit try/catch
  try {
    const result = await processMidtransWebhook(rawPayload as unknown as MidtransWebhookPayload);

    // 6. Tanggapi sesuai hasil pemrosesan dan kebijakan retry Midtrans
    if (result.ok) {
      // Return HTTP 200 OK agar Midtrans mencatat pengiriman sukses & menghentikan retry
      return NextResponse.json(
        {
          ok: true,
          status: result.processingResult,
          orderId: result.orderId,
          isDuplicate: result.isDuplicate ?? false,
        },
        { status: 200 },
      );
    }

    // Jika result.ok === false, return HTTP 500 agar Midtrans menjadwalkan retry otomatis
    return NextResponse.json(
      {
        ok: false,
        status: result.processingResult,
        error: result.error || "Gagal memproses webhook Midtrans.",
      },
      { status: 500 },
    );
  } catch {
    // Tangani exception tak terduga secara eksplisit tanpa membocorkan rahasia atau stack trace
    return NextResponse.json(
      {
        ok: false,
        status: "failed",
        error: "Internal server error during webhook processing.",
      },
      { status: 500 },
    );
  }
}

// Tolak metode selain POST
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { ok: false, error: "Method not allowed. Midtrans webhook requires POST." },
    { status: 405 },
  );
}
