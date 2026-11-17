import "server-only";

import { createHash } from "node:crypto";
import { getMidtransConfig } from "./config";
import { getMidtransStatus, type MidtransStatusResponse } from "./recovery";
import { isMidtransPaidStatus } from "./status";
import { processMidtransWebhook, type MidtransWebhookPayload } from "./webhook";
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
 * Melakukan rekonsiliasi aktif status transaksi Midtrans langsung ke Midtrans Core API.
 *
 * Alur Kerja:
 * 1. Ambil transaksi Midtrans terakhir untuk orderId internal dari tabel midtrans_transactions.
 * 2. Periksa status langsung ke Midtrans Core API menggunakan Server Key resmi.
 * 3. Validasi order_id, gross_amount, currency, transaction_status, dan fraud_status.
 * 4. Jika settlement (atau capture + fraud_status accept), mutasikan status ke database melalui
 *    handler settlement aman yang idempoten (processMidtransWebhook / execute_midtrans_webhook_settlement).
 * 5. Jika status terminal gagal (expire, cancel, deny), perbarui status transaksi lokal dan lepas reservasi.
 * 6. Jika status pending, perbarui lifecycle lokal menjadi pending.
 * 7. Kembalikan status terkini dan terverifikasi ke pemanggil.
 */
export async function reconcileActiveMidtransPayment({
  orderId,
}: ReconcileActiveMidtransParams): Promise<ReconcileOrderResult> {
  const config = getMidtransConfig();
  if (!config) {
    return {
      ok: false,
      isSettled: false,
      error: "Konfigurasi Midtrans tidak aktif di server.",
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
    .select("id, midtrans_order_id, gross_amount, lifecycle_status, snap_token, snap_redirect_url")
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

  // 3. Periksa status langsung ke Midtrans Core API
  const statusCheck = await getMidtransStatus(midtransOrderId);

  if (!statusCheck.ok) {
    // Tangani HTTP 404 dari Midtrans (transaksi belum dibuat/dipilih metode bayar di Snap)
    if (statusCheck.httpStatus === 404) {
      return {
        ok: true,
        isSettled: false,
        orderNumber: order.order_number,
        midtransStatus: "uncreated_or_pending",
        message: "Transaksi belum diproses di Midtrans. Menunggu pelanggan memilih metode pembayaran.",
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

  // 4. Validasi Keamanan Payload Respons Midtrans
  // a. Validasi kesesuaian order_id
  if (midtransData.order_id !== midtransOrderId) {
    return {
      ok: false,
      isSettled: false,
      orderNumber: order.order_number,
      error: `Order ID Midtrans tidak cocok: diharapkan ${midtransOrderId}, diterima ${midtransData.order_id}.`,
    };
  }

  // b. Validasi kesesuaian gross_amount
  const reportedGrossNumeric = Math.round(Number.parseFloat(midtransData.gross_amount));
  if (reportedGrossNumeric !== latestMidtransTx.gross_amount) {
    return {
      ok: false,
      isSettled: false,
      orderNumber: order.order_number,
      error: `Nominal transaksi Midtrans (${reportedGrossNumeric}) tidak cocok dengan tagihan lokal (${latestMidtransTx.gross_amount}).`,
    };
  }

  // c. Validasi mata uang (wajib IDR)
  const reportedCurrency = typeof midtransData.currency === "string" ? midtransData.currency.trim().toUpperCase() : "IDR";
  if (reportedCurrency !== "IDR") {
    return {
      ok: false,
      isSettled: false,
      orderNumber: order.order_number,
      error: `Mata uang tidak didukung: ${reportedCurrency}.`,
    };
  }

  const rawStatus = (midtransData.transaction_status || "").trim().toLowerCase();
  const fraudStatus = (midtransData.fraud_status || "").trim().toLowerCase();

  // Pastikan signature_key ada untuk verifikasi webhook yang sah
  // Jika Midtrans API mengembalikan signature_key, gunakan apa adanya.
  // Jika signature_key tidak disertakan oleh SDK/endpoint tertentu, hitung signature resmi:
  // SHA512(order_id + status_code + gross_amount + server_key)
  let signatureKey = typeof midtransData.signature_key === "string" ? midtransData.signature_key.trim() : "";
  if (!signatureKey && midtransData.status_code && midtransData.gross_amount) {
    signatureKey = createHash("sha512")
      .update(`${midtransOrderId}${midtransData.status_code}${midtransData.gross_amount}${config.serverKey}`)
      .digest("hex");
  }

  const webhookPayload: MidtransWebhookPayload = {
    ...midtransData,
    order_id: midtransOrderId,
    status_code: midtransData.status_code,
    gross_amount: midtransData.gross_amount,
    signature_key: signatureKey,
    transaction_status: rawStatus,
    fraud_status: fraudStatus,
    currency: reportedCurrency,
    transaction_id: midtransData.transaction_id,
  };

  // 5. Pemetaan Status & Penanganan Rekonsiliasi
  const isPaid = isMidtransPaidStatus(rawStatus, fraudStatus);

  if (isPaid) {
    // Eksekusi settlement atomik via domain handler processMidtransWebhook
    const webhookResult = await processMidtransWebhook(webhookPayload);

    if (!webhookResult.ok && webhookResult.processingResult === "failed") {
      return {
        ok: false,
        isSettled: false,
        orderNumber: order.order_number,
        midtransStatus: rawStatus,
        error: webhookResult.error || "Gagal memproses settlement pembayaran ke database.",
      };
    }

    // Ambil ulang status pesanan segar dari DB untuk memverifikasi pelunasan
    const { data: refreshedOrder } = await adminClient
      .from("orders")
      .select("status, payment_status, paid_total")
      .eq("id", orderId)
      .maybeSingle();

    const isNowSettled =
      refreshedOrder?.payment_status === "paid" || refreshedOrder?.status === "paid";

    return {
      ok: true,
      isSettled: isNowSettled,
      orderNumber: order.order_number,
      midtransStatus: rawStatus,
      statusCode: midtransData.status_code,
      message: isNowSettled
        ? "Pembayaran Midtrans berhasil diverifikasi dan diselesaikan."
        : "Pembayaran terverifikasi di Midtrans, menunggu pembaruan database.",
    };
  }

  // Jika status terminal gagal (expire, cancel, deny):
  if (["expire", "cancel", "deny"].includes(rawStatus)) {
    // Kirimkan ke webhook handler agar status terminal dan pelepasan alokasi dicatat di database
    await processMidtransWebhook(webhookPayload);

    return {
      ok: true,
      isSettled: false,
      orderNumber: order.order_number,
      midtransStatus: rawStatus,
      statusCode: midtransData.status_code,
      message: `Transaksi Midtrans telah berakhir dengan status: ${rawStatus}.`,
    };
  }

  // Jika status pending:
  if (rawStatus === "pending") {
    // Perbarui lifecycle lokal transaksi menjadi pending jika belum
    await adminClient
      .from("midtrans_transactions")
      .update({
        lifecycle_status: "pending",
        midtrans_transaction_status: "pending",
        sanitized_response: midtransData,
        updated_at: new Date().toISOString(),
      })
      .eq("id", latestMidtransTx.id);

    return {
      ok: true,
      isSettled: false,
      orderNumber: order.order_number,
      midtransStatus: "pending",
      statusCode: midtransData.status_code,
      message: "Pembayaran masih menunggu penyelesaian dari pelanggan.",
    };
  }

  // Status lainnya
  return {
    ok: true,
    isSettled: false,
    orderNumber: order.order_number,
    midtransStatus: rawStatus,
    statusCode: midtransData.status_code,
    message: `Status transaksi Midtrans: ${rawStatus}.`,
  };
}
