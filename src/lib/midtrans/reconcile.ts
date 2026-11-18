import "server-only";

import { getMidtransConfigState } from "./config";
import { getMidtransStatus, type MidtransStatusResponse } from "./recovery";
import { parseMidtransGrossAmount } from "./signature";
import { isMidtransPaidStatus } from "./status";
import {
  settleVerifiedMidtransStatus,
  type MidtransStatusSettlementPayload,
} from "./webhook";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type ReconcileOrderResult = {
  ok: boolean;
  isSettled: boolean;
  midtransStatus?: string;
  statusCode?: string;
  orderNumber?: string;
  error?: string;
  message?: string;
};

/**
 * Parameter untuk rekonsiliasi aktif pembayaran Midtrans.
 */
export type ReconcileActiveMidtransParams = {
  orderId: string;
};

/**
 * Melakukan rekonsiliasi aktif status transaksi Midtrans langsung ke Midtrans Core API
 * (`GET /v2/{order_id}/status`) menggunakan Server Key resmi melalui HTTPS Basic Auth.
 *
 * Alur Kerja Keamanan:
 * 1. Ambil transaksi Midtrans terakhir untuk orderId internal dari tabel midtrans_transactions.
 * 2. Periksa status langsung ke Midtrans Core API (Sandbox/Production sesuai config, tanpa fallback).
 * 3. Validasi ketat:
 *    - order_id === midtrans_order_id lokal
 *    - gross_amount string persis === gross_amount lokal (tanpa float drift)
 *    - currency === "IDR"
 *    - status_code valid
 *    - transaction_status & fraud_status
 * 4. Karena respons berasal langsung dari Midtrans Core API over HTTPS + Basic Auth Server Key,
 *    mutasi settlement dieksekusi melalui `settleVerifiedMidtransStatus()` (RPC atomik & idempoten
 *    `execute_midtrans_webhook_settlement`), BUKAN melempar `signature_key` respons GET Status
 *    ke validator HTTP webhook eksternal.
 * 5. Jika status terminal gagal (expire, cancel, deny), perbarui status terminal & lepas reservasi.
 * 6. Jika status pending, perbarui lifecycle lokal menjadi pending.
 */
export async function reconcileActiveMidtransPayment({
  orderId,
}: ReconcileActiveMidtransParams): Promise<ReconcileOrderResult> {
  const configState = getMidtransConfigState();
  if (!configState.enabled) {
    return {
      ok: false,
      isSettled: false,
      error: "Integrasi Midtrans tidak aktif di server.",
    };
  }
  if (!configState.ok) {
    return {
      ok: false,
      isSettled: false,
      error: configState.error,
    };
  }

  const adminClient = createSupabaseAdminClient();
  if (!adminClient) {
    return {
      ok: false,
      isSettled: false,
      error: "Koneksi database admin service_role tidak tersedia.",
    };
  }

  // 1. Ambil pesanan lokal
  const { data: order, error: orderErr } = await adminClient
    .from("orders")
    .select("id, order_number, status, payment_status, grand_total, paid_total")
    .eq("id", orderId)
    .maybeSingle();

  if (orderErr || !order) {
    return {
      ok: false,
      isSettled: false,
      error: "Pesanan tidak ditemukan di database.",
    };
  }

  // Jika pesanan di database sudah lunas sebelumnya, kembalikan lunas (fast-path idempoten)
  if (order.payment_status === "paid" || order.status === "paid") {
    return {
      ok: true,
      isSettled: true,
      orderNumber: order.order_number,
      message: "Pesanan sudah berstatus lunas di database.",
    };
  }

  // 2. Ambil transaksi Midtrans terakhir untuk pesanan ini
  const { data: latestMidtransTx, error: txErr } = await adminClient
    .from("midtrans_transactions")
    .select(
      "id, midtrans_order_id, gross_amount, lifecycle_status, snap_token, snap_redirect_url",
    )
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (txErr || !latestMidtransTx || !latestMidtransTx.midtrans_order_id) {
    return {
      ok: true,
      isSettled: false,
      orderNumber: order.order_number,
      midtransStatus: "uncreated",
      message: "Belum ada transaksi Midtrans yang dibuat untuk pesanan ini.",
    };
  }

  const midtransOrderId = latestMidtransTx.midtrans_order_id;

  // 3. Periksa status langsung ke Midtrans Core API (HTTPS + Basic Auth ServerKey)
  const statusCheck = await getMidtransStatus(midtransOrderId);

  if (!statusCheck.ok) {
    // Tangani HTTP 404 dari Midtrans (transaksi belum dibuat/dipilih metode bayar di Snap)
    if (statusCheck.httpStatus === 404) {
      return {
        ok: true,
        isSettled: false,
        orderNumber: order.order_number,
        midtransStatus: "uncreated_or_pending",
        message:
          "Transaksi belum diproses di Midtrans. Menunggu pelanggan memilih metode pembayaran.",
      };
    }

    return {
      ok: false,
      isSettled: false,
      orderNumber: order.order_number,
      error: statusCheck.error || "Gagal menghubungi API status Midtrans.",
    };
  }

  const midtransData: MidtransStatusResponse | undefined = statusCheck.status;
  if (!midtransData) {
    return {
      ok: false,
      isSettled: false,
      orderNumber: order.order_number,
      error: "Respons status Midtrans tidak memiliki payload transaksi.",
    };
  }

  // 4. Validasi Keamanan Payload Respons Midtrans Core API
  // a. Validasi kesesuaian order_id
  if (midtransData.order_id !== midtransOrderId) {
    return {
      ok: false,
      isSettled: false,
      orderNumber: order.order_number,
      error: `Order ID Midtrans tidak cocok: diharapkan ${midtransOrderId}, diterima ${midtransData.order_id}.`,
    };
  }

  // b. Validasi ketat gross_amount (string eksak tanpa floating-point drift)
  const reportedGrossNumeric = parseMidtransGrossAmount(
    midtransData.gross_amount,
  );
  if (
    reportedGrossNumeric === null ||
    reportedGrossNumeric !== latestMidtransTx.gross_amount
  ) {
    return {
      ok: false,
      isSettled: false,
      orderNumber: order.order_number,
      error: `Nominal transaksi Midtrans (${midtransData.gross_amount}) tidak cocok dengan tagihan lokal (${latestMidtransTx.gross_amount}).`,
    };
  }

  // c. Validasi mata uang (wajib IDR)
  const reportedCurrency =
    typeof midtransData.currency === "string"
      ? midtransData.currency.trim().toUpperCase()
      : "IDR";
  if (reportedCurrency !== "IDR") {
    return {
      ok: false,
      isSettled: false,
      orderNumber: order.order_number,
      error: `Mata uang tidak didukung: ${reportedCurrency}.`,
    };
  }

  // d. Validasi status_code
  const statusCode =
    typeof midtransData.status_code === "string"
      ? midtransData.status_code.trim()
      : "";
  if (!statusCode) {
    return {
      ok: false,
      isSettled: false,
      orderNumber: order.order_number,
      error: "Respons status Midtrans tidak memiliki status_code yang valid.",
    };
  }

  const rawStatus = (midtransData.transaction_status || "").trim().toLowerCase();
  const fraudStatus = (midtransData.fraud_status || "").trim().toLowerCase();

  // Sanitasi payload dari signature_key sebelum diteruskan ke settlement engine
  const sanitizedStatusFields = Object.fromEntries(
    Object.entries(midtransData).filter(([k]) => k !== "signature_key"),
  );

  const verifiedPayload: MidtransStatusSettlementPayload = {
    ...sanitizedStatusFields,
    order_id: midtransOrderId,
    status_code: statusCode,
    gross_amount: midtransData.gross_amount,
    transaction_status: rawStatus,
    fraud_status: fraudStatus,
    currency: reportedCurrency,
    transaction_id: midtransData.transaction_id,
    payment_type: midtransData.payment_type,
  };

  // 5. Pemetaan Status & Penanganan Rekonsiliasi
  const isPaid = isMidtransPaidStatus(rawStatus, fraudStatus);

  if (isPaid) {
    const settleResult = await settleVerifiedMidtransStatus(verifiedPayload);

    if (!settleResult.ok && settleResult.processingResult === "failed") {
      return {
        ok: false,
        isSettled: false,
        orderNumber: order.order_number,
        midtransStatus: rawStatus,
        error:
          settleResult.error ||
          "Gagal memproses settlement pembayaran ke database.",
      };
    }

    // Ambil ulang status pesanan & transaksi segar dari DB untuk memverifikasi pelunasan
    const [{ data: refreshedOrder }, { data: refreshedTx }] = await Promise.all([
      adminClient
        .from("orders")
        .select("status, payment_status, paid_total")
        .eq("id", orderId)
        .maybeSingle(),
      adminClient
        .from("midtrans_transactions")
        .select("lifecycle_status")
        .eq("id", latestMidtransTx.id)
        .maybeSingle(),
    ]);

    const isOrderFullySettled =
      refreshedOrder?.payment_status === "paid" ||
      refreshedOrder?.status === "paid";
    const isTxSettled = refreshedTx?.lifecycle_status === "settled";

    return {
      ok: true,
      isSettled: isOrderFullySettled,
      orderNumber: order.order_number,
      midtransStatus: rawStatus,
      statusCode,
      message: isOrderFullySettled
        ? "Pembayaran Midtrans berhasil diverifikasi dan pesanan telah lunas."
        : isTxSettled
          ? "Pembayaran bagian Midtrans berhasil diverifikasi (split bill tercatat)."
          : "Pembayaran terverifikasi di Midtrans, menunggu pembaruan database.",
    };
  }

  // Jika status terminal gagal (expire, cancel, deny):
  if (["expire", "cancel", "deny"].includes(rawStatus)) {
    const terminalResult = await settleVerifiedMidtransStatus(verifiedPayload);
    if (!terminalResult.ok && terminalResult.processingResult === "failed") {
      return {
        ok: false,
        isSettled: false,
        orderNumber: order.order_number,
        midtransStatus: rawStatus,
        statusCode,
        error:
          terminalResult.error ||
          `Gagal mencatat status terminal Midtrans (${rawStatus}).`,
      };
    }

    return {
      ok: true,
      isSettled: false,
      orderNumber: order.order_number,
      midtransStatus: rawStatus,
      statusCode,
      message: `Transaksi Midtrans telah berakhir dengan status: ${rawStatus}.`,
    };
  }

  // Jika status pending:
  if (rawStatus === "pending") {
    await adminClient
      .from("midtrans_transactions")
      .update({
        lifecycle_status: "pending",
        midtrans_transaction_status: "pending",
        sanitized_response: sanitizedStatusFields,
        updated_at: new Date().toISOString(),
      })
      .eq("id", latestMidtransTx.id);

    return {
      ok: true,
      isSettled: false,
      orderNumber: order.order_number,
      midtransStatus: "pending",
      statusCode,
      message: "Pembayaran masih menunggu penyelesaian dari pelanggan.",
    };
  }

  // Status lainnya (mis. challenge)
  return {
    ok: true,
    isSettled: false,
    orderNumber: order.order_number,
    midtransStatus: rawStatus,
    statusCode,
    message: `Status transaksi Midtrans: ${rawStatus}.`,
  };
}
