import "server-only";

import { getMidtransConfig } from "./config";
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
  const config = getMidtransConfig();

  if (!config) {
    return { ok: false, error: "Konfigurasi Midtrans tidak aktif." };
  }

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

    if (!response.ok) {
      return {
        ok: false,
        httpStatus: response.status,
        error: body?.status_message || `HTTP ${response.status}`,
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
  const config = getMidtransConfig();

  if (!config) {
    return { ok: false, error: "Konfigurasi Midtrans tidak aktif." };
  }

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
      // Perbarui status lokal di DB
      const adminClient = createSupabaseAdminClient();
      if (adminClient) {
        await adminClient
          .from("midtrans_transactions")
          .update({
            lifecycle_status: "cancelled",
            midtrans_transaction_status: "cancel",
            sanitized_response: body,
          })
          .eq("midtrans_order_id", orderId);

        // Lepas alokasi item jika ada
        const { data: tx } = await adminClient
          .from("midtrans_transactions")
          .select("id")
          .eq("midtrans_order_id", orderId)
          .single();

        if (tx) {
          await adminClient
            .from("order_allocations")
            .update({ allocation_status: "released" })
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

