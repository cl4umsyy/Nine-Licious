import "server-only";

import { getMidtransConfigState } from "./config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type MidtransStatusResponse = {
  status_code: string;
  status_message?: string;
  transaction_id?: string;
  order_id: string;
  gross_amount: string;
  payment_type?: string;
  transaction_time?: string;
  transaction_status: string;
  fraud_status?: string;
  [key: string]: unknown;
};

export type CheckStatusResult = {
  ok: boolean;
  status?: MidtransStatusResponse;
  isTerminal?: boolean;
  error?: string;
  httpStatus?: number;
};

const MIDTRANS_CORE_TIMEOUT_MS = 10_000;

export type CancelTransactionResult = {
  ok: boolean;
  isCancelled?: boolean;
  status?: MidtransStatusResponse;
  error?: string;
  httpStatus?: number;
};

/**
 * Fetches transaction status from Midtrans Core API with explicit timeout protection.
 */
export async function getMidtransStatus(orderId: string): Promise<CheckStatusResult> {
  const configState = getMidtransConfigState();

  if (!configState.enabled) {
    return { ok: false, error: "Konfigurasi Midtrans tidak aktif." };
  }

  if (!configState.ok) {
    return { ok: false, error: configState.error };
  }

  const config = configState.config;

  const authHeader = `Basic ${Buffer.from(`${config.serverKey}:`).toString("base64")}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MIDTRANS_CORE_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.apiBaseUrl}/v2/${encodeURIComponent(orderId)}/status`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authHeader,
      },
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => null)) as MidtransStatusResponse | null;
    const bodyStatusCode = body?.status_code ? String(body.status_code).trim() : "";

    // Midtrans Core API v2 dapat mengembalikan HTTP 200 dengan body { status_code: "404" }
    // ketika pelanggan membuka Snap tetapi belum pernah memilih metode bayar.
    if (bodyStatusCode === "404" || response.status === 404) {
      return {
        ok: false,
        httpStatus: 404,
        error: body?.status_message || "Transaction doesn't exist.",
      };
    }

    // Midtrans mengembalikan status_code "200", "201", "202", serta "407" khusus saat transaksi expire.
    const isValidStatusCode =
      !bodyStatusCode ||
      ["200", "201", "202"].includes(bodyStatusCode) ||
      (bodyStatusCode === "407" &&
        String(body?.transaction_status || "").trim().toLowerCase() === "expire");

    if (!body || !response.ok || !isValidStatusCode) {
      const parsedCode = Number.parseInt(bodyStatusCode, 10);
      const effectiveStatus =
        Number.isFinite(parsedCode) && parsedCode >= 400
          ? parsedCode
          : response.status;
      return {
        ok: false,
        httpStatus: effectiveStatus,
        error: body?.status_message || `HTTP ${effectiveStatus}`,
      };
    }

    const terminalStatuses = ["settlement", "expire", "cancel", "deny"];
    const isTerminal = terminalStatuses.includes(body.transaction_status);

    return {
      ok: true,
      status: body,
      isTerminal,
      httpStatus: response.status,
    };
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: isTimeout
        ? "Koneksi ke Midtrans Core API melebihi batas waktu (timeout)."
        : err instanceof Error
          ? err.message
          : "Network error while checking status",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Cancels a Midtrans transaction via POST /v2/{order_id}/cancel with timeout protection.
 */
export async function cancelMidtransTransaction(orderId: string): Promise<CancelTransactionResult> {
  const configState = getMidtransConfigState();

  if (!configState.enabled) {
    return { ok: false, error: "Konfigurasi Midtrans tidak aktif." };
  }

  if (!configState.ok) {
    return { ok: false, error: configState.error };
  }

  const config = configState.config;

  const authHeader = `Basic ${Buffer.from(`${config.serverKey}:`).toString("base64")}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MIDTRANS_CORE_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.apiBaseUrl}/v2/${encodeURIComponent(orderId)}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: authHeader,
      },
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => null)) as MidtransStatusResponse | null;
    const bodyStatusCode = body?.status_code ? String(body.status_code).trim() : "";

    if (bodyStatusCode === "404" || response.status === 404) {
      return {
        ok: false,
        httpStatus: 404,
        error: body?.status_message || "Transaction doesn't exist.",
      };
    }

    if (!body || !response.ok) {
      return {
        ok: false,
        httpStatus: response.status,
        error: body?.status_message || `HTTP ${response.status}`,
      };
    }

    const isCancelled = bodyStatusCode === "200" && body.transaction_status === "cancel";

    if (isCancelled) {
      // Perbarui status lokal di DB secara atomik dan lepas alokasi reserved
      const adminClient = createSupabaseAdminClient();
      if (adminClient) {
        const nowIso = new Date().toISOString();
        const sanitizedBody = Object.fromEntries(
          Object.entries(body).filter(([k]) => k !== "signature_key"),
        );

        const { data: tx } = await adminClient
          .from("midtrans_transactions")
          .update({
            lifecycle_status: "cancelled",
            midtrans_transaction_status: "cancel",
            sanitized_response: sanitizedBody,
            updated_at: nowIso,
          })
          .eq("midtrans_order_id", orderId)
          .in("lifecycle_status", ["initiated", "token_created", "pending", "reconciliation_required"])
          .select("id")
          .maybeSingle();

        if (tx) {
          await adminClient
            .from("order_allocations")
            .update({
              allocation_status: "released",
              updated_at: nowIso,
            })
            .eq("midtrans_transaction_id", tx.id)
            .eq("allocation_status", "reserved");
        }
      }
    }

    return {
      ok: isCancelled,
      isCancelled,
      status: body,
      httpStatus: response.status,
      error: !isCancelled
        ? body?.status_message || `Midtrans menolak pembatalan (status: ${body.transaction_status || bodyStatusCode}).`
        : undefined,
    };
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: isTimeout
        ? "Koneksi ke Midtrans Core API melebihi batas waktu (timeout)."
        : err instanceof Error
          ? err.message
          : "Network error while cancelling transaction",
    };
  } finally {
    clearTimeout(timeout);
  }
}

