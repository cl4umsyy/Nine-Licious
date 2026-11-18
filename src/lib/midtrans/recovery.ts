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

export type CancelTransactionResult = {
  ok: boolean;
  isCancelled?: boolean;
  status?: MidtransStatusResponse;
  error?: string;
};

/**
 * Fetches transaction status from Midtrans Core API.
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

  try {
    const response = await fetch(`${config.apiBaseUrl}/v2/${encodeURIComponent(orderId)}/status`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authHeader,
      },
    });

    const body: MidtransStatusResponse = await response.json();
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

    if (
      !response.ok ||
      (bodyStatusCode && !["200", "201", "202"].includes(bodyStatusCode))
    ) {
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
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Network error while checking status",
    };
  }
}

/**
 * Cancels a Midtrans transaction via POST /v2/{order_id}/cancel.
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

  try {
    const response = await fetch(`${config.apiBaseUrl}/v2/${encodeURIComponent(orderId)}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: authHeader,
      },
    });

    const body: MidtransStatusResponse = await response.json();

    if (!response.ok) {
      return {
        ok: false,
        error: body?.status_message || `HTTP ${response.status}`,
      };
    }

    const isCancelled = body.status_code === "200" && body.transaction_status === "cancel";

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
          .in("lifecycle_status", ["initiated", "token_created", "pending"])
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
      ok: true,
      isCancelled,
      status: body,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Network error while cancelling transaction",
    };
  }
}

