import "server-only";

import { createHash } from "node:crypto";
import { getMidtransConfig } from "./config";
import { verifyMidtransSignature } from "./signature";
import type { ProcessWebhookResult } from "./types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type MidtransWebhookPayload = {
  order_id: string;
  status_code: string;
  gross_amount: string;
  signature_key: string;
  transaction_id?: string;
  transaction_status: string;
  payment_type?: string;
  fraud_status?: string;
  settlement_time?: string;
  transaction_time?: string;
  currency?: string;
  [key: string]: unknown;
};

/**
 * Menghitung event fingerprint SHA-256 yang identik dengan v_event_fingerprint di migration SQL F2.2:
 * sha256(order_id:status_code:gross_amount:currency:transaction_status:fraud_status:transaction_id)
 */
export function computeMidtransEventFingerprint(payload: {
  order_id?: string;
  status_code?: string;
  gross_amount?: string;
  currency?: string;
  transaction_status?: string;
  fraud_status?: string;
  transaction_id?: string;
}): string {
  const parts = [
    payload.order_id ?? "",
    payload.status_code ?? "",
    payload.gross_amount ?? "",
    payload.currency ?? "IDR",
    payload.transaction_status ?? "",
    payload.fraud_status ?? "",
    payload.transaction_id ?? "",
  ];
  return createHash("sha256").update(parts.join(":")).digest("hex");
}

/**
 * Handles incoming Midtrans notification webhooks.
 *
 * Enforces:
 * 1. Cryptographic SHA-512 signature verification.
 * 2. SHA-256 event fingerprinting and durable recording.
 * 3. Idempotent deduplication (duplicate notifications do not trigger double settlement).
 * 4. Privilege boundary via Supabase Admin Client (service_role only).
 * 5. Sanitized error handling without leaking secrets or sensitive PII.
 */
export async function processMidtransWebhook(
  payload: MidtransWebhookPayload,
): Promise<ProcessWebhookResult> {
  const config = getMidtransConfig();

  if (!config) {
    return {
      ok: false,
      fingerprint: "",
      processingResult: "failed",
      error: "Konfigurasi Midtrans tidak aktif di server.",
    };
  }

  const orderId = payload.order_id;
  const statusCode = payload.status_code;
  const grossAmount = payload.gross_amount;
  const signatureKey = payload.signature_key;
  const transactionId = payload.transaction_id ?? "";
  const transactionStatus = payload.transaction_status;

  if (!orderId || !statusCode || !grossAmount || !transactionStatus) {
    return {
      ok: false,
      fingerprint: "",
      processingResult: "failed",
      error: "Payload webhook Midtrans tidak lengkap.",
    };
  }

  // 1. Hitung fingerprint unik event yang selaras dengan SQL F2.2
  const fingerprint = computeMidtransEventFingerprint({
    order_id: orderId,
    status_code: statusCode,
    gross_amount: grossAmount,
    currency: (payload.currency as string | undefined) || "IDR",
    transaction_status: transactionStatus,
    fraud_status: (payload.fraud_status as string | undefined) || "",
    transaction_id: transactionId,
  });

  // 2. Verifikasi tanda tangan digital
  const isSignatureValid = verifyMidtransSignature({
    orderId,
    statusCode,
    grossAmount,
    signatureKey,
    serverKey: config.serverKey,
  });

  const adminClient = createSupabaseAdminClient();

  if (!adminClient) {
    return {
      ok: false,
      fingerprint,
      processingResult: "failed",
      error: "Koneksi database admin service_role tidak tersedia.",
    };
  }

  // Sanitasi payload (hilangkan informasi sensitif jika ada)
  const sanitizedPayload = Object.fromEntries(
    Object.entries(payload).filter(([k]) => k !== "signature_key"),
  );

  // 3. Simpan event durable ke DB jika signature invalid
  if (!isSignatureValid) {
    await adminClient.from("midtrans_webhook_events").insert({
      event_fingerprint: fingerprint,
      midtrans_order_id: orderId,
      transaction_id: transactionId || null,
      raw_status: transactionStatus,
      processing_result: "failed",
      is_signature_verified: false,
      error_message: "INVALID_SIGNATURE: Signature SHA-512 tidak cocok dengan server key.",
      sanitized_payload: sanitizedPayload,
    });

    return {
      ok: false,
      fingerprint,
      orderId,
      processingResult: "failed",
      error: "Tanda tangan digital webhook tidak valid.",
    };
  }

  // 4. Eksekusi settlement di database via service_role RPC (atomik di dalam PostgreSQL)
  try {
    const { data: settlementResult, error: settlementError } = await adminClient.rpc(
      "execute_midtrans_webhook_settlement",
      {
        p_payload: payload,
      },
    );

    if (settlementError) {
      await adminClient
        .from("midtrans_webhook_events")
        .update({
          processing_result: "failed",
          error_message: settlementError.message,
          processed_at: new Date().toISOString(),
        })
        .eq("event_fingerprint", fingerprint);

      return {
        ok: false,
        fingerprint,
        orderId,
        processingResult: "failed",
        error: settlementError.message,
      };
    }

    const status = settlementResult?.status as string | undefined;

    // 1. Tangani status failed eksplisit dari RPC (validasi mata uang, nominal, pesanan, dsb.)
    if (status === "failed") {
      const errorMsg =
        (settlementResult?.message as string | undefined) ||
        (settlementResult?.error as string | undefined) ||
        "Validasi webhook gagal di database.";

      return {
        ok: false,
        fingerprint,
        orderId,
        midtransOrderId: orderId,
        transactionStatus,
        processingResult: "failed",
        error: errorMsg,
      };
    }

    // 2. Tangani duplikasi event / transaksi sudah settled
    if (status === "already_settled" || status === "ignored_duplicate") {
      const eventFp =
        (settlementResult?.event_fingerprint as string | undefined) ||
        fingerprint;

      // Periksa status rekaman event sebelumnya di database
      const { data: prevEvent } = await adminClient
        .from("midtrans_webhook_events")
        .select("processing_result, error_message")
        .eq("event_fingerprint", eventFp)
        .maybeSingle();

      const prevResult = prevEvent?.processing_result;

      // Event failed akibat kegagalan sebelumnya DILARANG otomatis dianggap sukses sebagai duplikat!
      if (prevResult === "failed") {
        return {
          ok: false,
          fingerprint: eventFp,
          orderId,
          midtransOrderId: orderId,
          transactionStatus,
          processingResult: "failed",
          isDuplicate: true,
          error:
            prevEvent?.error_message ||
            "Webhook event sebelumnya tercatat gagal dan belum berhasil diselesaikan.",
        };
      }

      // Jika sebelumnya ditandai rekonsiliasi manual, pertahankan status rekonsiliasi
      if (prevResult === "reconciliation_flagged") {
        return {
          ok: true,
          fingerprint: eventFp,
          orderId,
          midtransOrderId: orderId,
          transactionStatus,
          processingResult: "reconciliation_flagged",
          isDuplicate: true,
        };
      }

      // Jika sebelumnya processing (misal sedang dievaluasi fraud challenge)
      if (prevResult === "processing") {
        return {
          ok: true,
          fingerprint: eventFp,
          orderId,
          midtransOrderId: orderId,
          transactionStatus,
          processingResult: "processing",
          isDuplicate: true,
        };
      }

      // Jika sebelumnya settled atau terminal_released: duplikat aman diabaikan
      return {
        ok: true,
        fingerprint: eventFp,
        orderId,
        midtransOrderId: orderId,
        transactionStatus,
        processingResult: "ignored_duplicate",
        isDuplicate: true,
      };
    }

    // 3. Tangani webhook out-of-order yang diabaikan (pending setelah terminal/challenge)
    if (
      status === "ignored_terminal_to_pending" ||
      status === "ignored_capture_challenge_to_pending"
    ) {
      return {
        ok: true,
        fingerprint,
        orderId,
        midtransOrderId: orderId,
        transactionStatus,
        processingResult: "ignored_out_of_order",
      };
    }

    // 4. Tangani seluruh varian rekonsiliasi manual
    if (
      status === "reconciliation_required_order_cancelled" ||
      status === "reconciliation_required_amount_mismatch" ||
      status === "reconciliation_required_terminal_settlement" ||
      status === "reconciliation_required_refund" ||
      status === "reconciliation_required_partial_refund" ||
      status === "reconciliation_required_chargeback" ||
      status === "reconciliation_required_partial_chargeback" ||
      Boolean(status?.startsWith("reconciliation_required_")) ||
      status === "already_in_reconciliation"
    ) {
      return {
        ok: true,
        fingerprint,
        orderId,
        midtransOrderId: orderId,
        transactionStatus,
        processingResult: "reconciliation_flagged",
      };
    }

    // 5. Tangani transaksi yang sudah berstatus terminal
    if (status === "already_terminal") {
      return {
        ok: true,
        fingerprint,
        orderId,
        midtransOrderId: orderId,
        transactionStatus,
        processingResult: "terminal_released",
      };
    }

    // 6. Tangani capture challenge dalam evaluasi fraud
    if (status === "capture_challenge") {
      return {
        ok: true,
        fingerprint,
        orderId,
        midtransOrderId: orderId,
        transactionStatus,
        processingResult: "processing",
      };
    }

    // 7. Tangani status sukses resmi dari RPC
    if (status === "success") {
      const lifecycleStatus = settlementResult?.lifecycle_status as string | undefined;

      const finalResult =
        lifecycleStatus === "settlement" || lifecycleStatus === "capture"
          ? "settled"
          : lifecycleStatus === "expire" ||
            lifecycleStatus === "cancel" ||
            lifecycleStatus === "deny"
          ? "terminal_released"
          : "processing";

      return {
        ok: true,
        fingerprint,
        orderId,
        midtransOrderId: orderId,
        transactionStatus,
        processingResult: finalResult,
        isDuplicate: false,
      };
    }

    // 8. Status tidak dikenal dari RPC: DILARANG fallback ke settled!
    const unhandledStatus = String(status);
    await adminClient
      .from("midtrans_webhook_events")
      .update({
        processing_result: "failed",
        error_message: `UNKNOWN_RPC_STATUS: Status respons RPC tidak dikenal (${unhandledStatus})`,
        processed_at: new Date().toISOString(),
      })
      .eq("event_fingerprint", fingerprint);

    return {
      ok: false,
      fingerprint,
      orderId,
      processingResult: "failed",
      error: `Status respons RPC tidak dikenal: ${unhandledStatus}`,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error during settlement";

    await adminClient
      .from("midtrans_webhook_events")
      .update({
        processing_result: "failed",
        error_message: errorMessage,
        processed_at: new Date().toISOString(),
      })
      .eq("event_fingerprint", fingerprint);

    return {
      ok: false,
      fingerprint,
      orderId,
      processingResult: "failed",
      error: errorMessage,
    };
  }
}
