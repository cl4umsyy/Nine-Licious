import "server-only";

import { getMidtransConfigState } from "./config";
import type {
  CreateSnapTransactionParams,
  CreateSnapTransactionResult,
} from "./types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const DEFAULT_EXPIRY_MINUTES = 15;

/**
 * Creates a Midtrans Snap transaction for an order or split bill allocation.
 *
 * Sequence:
 * 1. Checks server-side Midtrans configuration.
 * 2. Invokes atomic DB RPC `create_midtrans_snap_transaction` to lock order and record reservation.
 * 3. Calls Midtrans Snap API.
 * 4. Updates record with snap_token and snap_redirect_url on success.
 * 5. Returns token and payment URL to caller.
 */
export async function createSnapPayment(
  params: CreateSnapTransactionParams,
): Promise<CreateSnapTransactionResult> {
  const configState = getMidtransConfigState();

  if (!configState.enabled) {
    return {
      ok: false,
      error: "Integrasi Midtrans tidak aktif pada konfigurasi server restoran.",
    };
  }

  if (!configState.ok) {
    console.error("[midtrans-service] Konfigurasi Midtrans tidak valid:", configState.error);
    return {
      ok: false,
      error: configState.error,
    };
  }

  const config = configState.config;

  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    return {
      ok: false,
      error: "Koneksi database tidak tersedia.",
    };
  }

  const expiryMinutes = params.expiryMinutes ?? DEFAULT_EXPIRY_MINUTES;
  const now = new Date();
  const snapPageExpiresAt = new Date(now.getTime() + expiryMinutes * 60 * 1000).toISOString();
  const paymentExpiresAt = snapPageExpiresAt; // Mengikuti parameter expiry Snap

  // 1. Catat transaksi dan reservasi ke DB secara atomik
  const { data: dbResult, error: dbError } = await supabase.rpc(
    "create_midtrans_snap_transaction",
    {
      p_order_id: params.orderId,
      p_gross_amount: Math.round(params.grossAmount),
      p_idempotency_key: params.idempotencyKey,
      p_snap_page_expires_at: snapPageExpiresAt,
      p_payment_expires_at: paymentExpiresAt,
      p_is_split_bill: params.isSplitBill ?? false,
      p_split_bill_type: params.splitBillType ?? null,
      p_item_allocations: params.itemAllocations ?? null,
    },
  );

  if (dbError || !dbResult) {
    return {
      ok: false,
      error: dbError?.message ?? "Gagal mencatat reservasi transaksi gateway ke database.",
    };
  }

  const txId = dbResult.midtrans_transaction_id;
  const midtransOrderId = dbResult.midtrans_order_id;
  const grossAmount = dbResult.gross_amount;

  if (dbResult.idempotent_replay) {
    return {
      ok: true,
      midtransTransactionId: txId,
      midtransOrderId,
      grossAmount,
      idempotentReplay: true,
    };
  }

  // 2. Siapkan payload Snap API Midtrans
  const authHeader = `Basic ${Buffer.from(`${config.serverKey}:`).toString("base64")}`;

  const snapPayload = {
    transaction_details: {
      order_id: midtransOrderId,
      gross_amount: grossAmount,
    },
    customer_details: {
      first_name: params.customerName || "Pelanggan Nine Licious",
      email: params.customerEmail || undefined,
      phone: params.customerPhone || undefined,
    },
    expiry: {
      unit: "minutes",
      duration: expiryMinutes,
    },
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let snapResponse: Response;
    try {
      snapResponse = await fetch(`${config.apiBaseUrl}/snap/v1/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(snapPayload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    let responseBody: {
      token?: string;
      redirect_url?: string;
      error_messages?: string[];
      status_message?: string;
    } | null = null;
    try {
      responseBody = await snapResponse.json();
    } catch {
      responseBody = null;
    }

    if (!snapResponse.ok || !responseBody?.token) {
      // Tandai kegagalan di DB tanpa menghilangkan reservasi jika status in-flight
      const adminClient = createSupabaseAdminClient();
      if (adminClient) {
        await adminClient
          .from("midtrans_transactions")
          .update({
            lifecycle_status: "pre_request_aborted",
            sanitized_response: { error: responseBody, status: snapResponse.status },
          })
          .eq("id", txId);

        // Lepas alokasi item jika gagal membuat token
        await adminClient
          .from("order_allocations")
          .update({ allocation_status: "released" })
          .eq("midtrans_transaction_id", txId);
      }

      let errorMessage = "Gagal membuat transaksi di Midtrans API.";
      if (snapResponse.status === 401) {
        errorMessage = "Autentikasi Midtrans gagal. Server Key ditolak oleh Midtrans API.";
      } else if (responseBody?.error_messages && Array.isArray(responseBody.error_messages)) {
        errorMessage = `Midtrans API error: ${responseBody.error_messages.join(", ")}`;
      } else if (responseBody?.status_message) {
        errorMessage = `Midtrans API error: ${responseBody.status_message}`;
      } else if (snapResponse.status >= 500) {
        errorMessage = `Layanan Midtrans Snap sedang mengalami gangguan (HTTP ${snapResponse.status}). Coba beberapa saat lagi.`;
      }

      console.error("[midtrans-service] Snap API response error:", snapResponse.status, errorMessage);

      return {
        ok: false,
        error: errorMessage,
      };
    }

    // 3. Simpan token & URL ke database via RPC resmi
    const adminClient = createSupabaseAdminClient();
    if (adminClient) {
      await adminClient.rpc("update_midtrans_snap_details", {
        p_midtrans_transaction_id: txId,
        p_snap_token: responseBody.token,
        p_snap_redirect_url: responseBody.redirect_url,
      });
    }

    return {
      ok: true,
      midtransTransactionId: txId,
      midtransOrderId,
      snapToken: responseBody.token,
      snapRedirectUrl: responseBody.redirect_url,
      grossAmount,
    };
  } catch (networkError: unknown) {
    const isTimeout = networkError instanceof Error && networkError.name === "AbortError";
    const errorMsg = isTimeout
      ? "Koneksi ke Midtrans Snap API mengalami batas waktu (timeout 10 detik). Periksa jaringan internet."
      : "Koneksi ke Midtrans mengalami gangguan. Transaksi masuk ke tahap rekonsiliasi.";

    console.error("[midtrans-service] Network error saat createSnapPayment:", errorMsg);

    // Network timeout: status harus menjadi reconciliation_required
    const adminClient = createSupabaseAdminClient();
    if (adminClient) {
      await adminClient
        .from("midtrans_transactions")
        .update({
          lifecycle_status: "reconciliation_required",
          sanitized_response: {
            error: isTimeout ? "Request timeout" : networkError instanceof Error ? networkError.message : "Network error",
          },
        })
        .eq("id", txId);
    }

    return {
      ok: false,
      error: errorMsg,
    };
  }
}

