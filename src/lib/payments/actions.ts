"use server";

import { revalidatePath } from "next/cache";
import { getAdminActor, getCashierActor } from "@/lib/auth/session";
import type {
  PaymentActionResult,
  PaymentProcessingResult,
  ReceiptData,
  RefundProcessingResult,
} from "@/lib/payments/types";
import {
  createSnapPaymentSchema,
  fieldErrorsFrom,
  firstZodError,
  manualPaymentSchema,
  processRefundSchema,
} from "@/lib/payments/validation";
import { createSnapPayment } from "@/lib/midtrans/service";
import { reconcileActiveMidtransPayment } from "@/lib/midtrans/reconcile";
import type { CreateSnapTransactionResult } from "@/lib/midtrans/types";
import type { MidtransSplitBillType } from "@/types/database";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Order } from "@/types/database";

function formatSafePaymentError(rawMessage?: string): string {
  if (!rawMessage) return "Gagal memproses pembayaran di sistem kasir.";

  // Bersihkan Postgres code prefix jika ada (misal "P0001: ")
  const clean = rawMessage.replace(/^[A-Z0-9]+:\s*/i, "").trim();

  // Daftar error bisnis database yang aman dan perlu dipahami oleh kasir
  if (
    clean.includes("Pesanan belum difinalisasi") ||
    clean.includes("sudah dibatalkan") ||
    clean.includes("sudah lunas") ||
    clean.includes("melebihi sisa tagihan") ||
    clean.includes("kurang dari nominal pembayaran") ||
    clean.includes("kembalian tunai tidak valid") ||
    clean.includes("Idempotency key") ||
    clean.includes("Kunci idempotensi") ||
    clean.includes("Relasi pesanan berubah") ||
    clean.includes("tidak didukung") ||
    clean.includes("tidak valid") ||
    clean.includes("tidak ditemukan") ||
    clean.includes("tidak aktif") ||
    clean.includes("dinonaktifkan") ||
    clean.includes("Hanya admin atau kasir")
  ) {
    return clean;
  }

  // Fallback aman untuk technical internal SQL errors (mencegah database detail leakage)
  return "Terjadi kendala pada sistem pembayaran kasir. Silakan coba kembali atau hubungi administrator.";
}

/**
 * Memproses transaksi pembayaran manual di kasir POS (Cash, QRIS Manual, Bank Transfer).
 *
 * Persyaratan Keamanan F2.1:
 * 1. Hanya Admin dan Kasir aktif yang berhak memproses pembayaran.
 * 2. Pesanan wajib sudah difinalisasi (is_finalized = true).
 * 3. Pesanan yang sudah dibatalkan atau sudah lunas ditolak.
 * 4. Nominal pembayaran tidak boleh melebihi sisa tagihan (grand_total - paid_total).
 * 5. Eksekusi database dilakukan secara atomik via RPC PostgreSQL process_pos_payment_manual
 *    dengan row-level locking (SELECT FOR UPDATE) untuk mencegah race condition.
 * 6. Idempotensi global mencegah duplikasi pembayaran saat retry koneksi.
 */
export async function processPosManualPaymentAction(
  rawInput: unknown,
): Promise<PaymentActionResult<PaymentProcessingResult>> {
  // 1. Validasi Otorisasi Staf: Hanya Kasir atau Admin aktif
  const cashierActor = await getCashierActor();
  if (!cashierActor.ok) {
    return { ok: false, message: cashierActor.message };
  }

  // 2. Validasi Skema Input Zod
  const parsed = manualPaymentSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const input = parsed.data;

  // 3. Buat Klien Supabase Terautentikasi (Membawa JWT Kasir Aktif)
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  // 4. Validasi Pra-kondisi di Server Side (Jangan Percayai Browser Input)
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("*")
    .eq("id", input.orderId)
    .maybeSingle<Order>();

  if (orderErr || !order) {
    return { ok: false, message: "Pesanan tidak ditemukan di database." };
  }

  if (!order.is_finalized) {
    return {
      ok: false,
      message: "Pesanan belum difinalisasi. Finalisasi pesanan terlebih dahulu sebelum memproses pembayaran.",
    };
  }

  if (order.status === "cancelled") {
    return {
      ok: false,
      message: `Pesanan ${order.order_number} sudah dibatalkan dan tidak dapat menerima pembayaran.`,
    };
  }

  if (order.status === "paid" || order.payment_status === "paid") {
    return {
      ok: false,
      message: `Pesanan ${order.order_number} sudah lunas sebelumnya.`,
    };
  }

  const remainingBalance = order.grand_total - order.paid_total;
  if (input.amount > remainingBalance) {
    return {
      ok: false,
      message: `Nominal pembayaran (Rp ${input.amount.toLocaleString("id-ID")}) melebihi sisa tagihan (Rp ${remainingBalance.toLocaleString("id-ID")}).`,
    };
  }

  // 5. Eksekusi RPC Atomik process_pos_payment_manual
  const { data: rpcResult, error: rpcErr } = await supabase.rpc(
    "process_pos_payment_manual",
    {
      p_order_id: input.orderId,
      p_payment_method: input.paymentMethod,
      p_payment_source: input.paymentSource,
      p_amount: input.amount,
      p_cash_received: input.cashReceived ?? null,
      p_change_amount: input.changeAmount ?? 0,
      p_reference_number: input.referenceNumber ?? null,
      p_idempotency_key: input.idempotencyKey,
      p_notes: input.notes ?? null,
    },
  );

  if (rpcErr) {
    return {
      ok: false,
      message: formatSafePaymentError(rpcErr.message),
    };
  }

  const result = rpcResult as unknown as PaymentProcessingResult;

  // 6. Revalidasi Halaman POS
  revalidatePath("/pos");
  revalidatePath("/admin");

  const successMessage = result.is_settled
    ? `Pembayaran berhasil! Pesanan ${result.order_number} LUNAS. Nomor antrean: ${result.queue_number ?? "-"}.`
    : `Pembayaran parsial berhasil! Sisa tagihan Rp ${(result.grand_total - result.paid_total).toLocaleString("id-ID")}.`;

  return {
    ok: true,
    message: result.idempotent_replay
      ? `Transaksi idempoten: Pembayaran ${result.order_number} sudah tercatat sebelumnya.`
      : successMessage,
    data: result,
  };
}

/**
 * Memproses permintaan pengembalian dana (refund) pesanan.
 *
 * Persyaratan Keamanan F2.4:
 * 1. Hanya Admin aktif yang berhak memproses refund.
 * 2. Idempotensi ketat: komparasi orderId, amount, paymentId, refundType, refundMethod, reason.
 * 3. Eksekusi atomik via RPC process_order_refund_atomic.
 * 4. Metode Midtrans dicatat pending dan membutuhkan konfirmasi gateway server-side.
 */
export async function processOrderRefundAction(
  rawInput: unknown,
): Promise<PaymentActionResult<RefundProcessingResult>> {
  // 1. Otorisasi Admin Aktif
  const adminActor = await getAdminActor();
  if (!adminActor.ok) {
    return { ok: false, message: adminActor.message };
  }

  // 2. Validasi Skema Zod
  const parsed = processRefundSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const input = parsed.data;

  // 3. Klien Supabase Terautentikasi (Membawa JWT Admin)
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  // 4. Eksekusi RPC Atomik process_order_refund_atomic
  const { data: rpcResult, error: rpcErr } = await supabase.rpc(
    "process_order_refund_atomic",
    {
      p_order_id: input.orderId,
      p_amount: input.amount,
      p_refund_type: input.refundType,
      p_refund_method: input.refundMethod,
      p_reason: input.reason,
      p_payment_id: input.paymentId ?? null,
      p_idempotency_key: input.idempotencyKey,
    },
  );

  if (rpcErr) {
    return {
      ok: false,
      message: formatSafePaymentError(rpcErr.message),
    };
  }

  const result = rpcResult as unknown as RefundProcessingResult;

  // 5. Revalidasi Jalur Tampilan Terkait
  revalidatePath("/pos");
  revalidatePath("/pos/floor");
  revalidatePath("/admin/tables");
  revalidatePath("/admin");

  const successMsg =
    result.status === "pending"
      ? `Permintaan refund ${result.refund_number} (Rp ${result.amount.toLocaleString("id-ID")}) dicatat sebagai pending. Menunggu konfirmasi gateway.`
      : `Pengembalian dana ${result.refund_number} (Rp ${result.amount.toLocaleString("id-ID")}) berhasil diproses.`;

  return {
    ok: true,
    message: result.is_duplicate
      ? `Transaksi idempoten: Refund ${result.refund_number} telah diproses sebelumnya.`
      : successMsg,
    data: result,
  };
}

/**
 * Mengonfirmasi transaksi refund Midtrans yang berstatus pending setelah menerima
 * respons sukses dari Midtrans API atau verifikasi webhook HMAC-SHA512.
 *
 * Persyaratan Keamanan F2.4:
 * 1. Dipanggil hanya oleh server-side context dengan service_role client.
 * 2. Hanya Admin yang dapat memicu konfirmasi ini dari server action.
 * 3. RPC confirm_midtrans_refund_atomic memiliki privilege eksklusif service_role.
 */
export async function confirmMidtransRefundAction(rawInput: {
  refundId: string;
  gatewayRefundId: string;
  expectedAmount?: number;
  gatewayPayload?: Record<string, unknown>;
}): Promise<PaymentActionResult<RefundProcessingResult>> {
  // 1. Otorisasi Admin
  const adminActor = await getAdminActor();
  if (!adminActor.ok) {
    return { ok: false, message: adminActor.message };
  }

  if (!rawInput.refundId || !rawInput.gatewayRefundId) {
    return {
      ok: false,
      message: "ID refund dan Gateway refund ID wajib disertakan.",
    };
  }

  // 2. Klien Supabase Admin (Service Role)
  const adminClient = createSupabaseAdminClient();
  if (!adminClient) {
    return {
      ok: false,
      message: "Koneksi database admin (service_role) tidak tersedia.",
    };
  }

  // 3. Eksekusi RPC confirm_midtrans_refund_atomic
  const { data: rpcResult, error: rpcErr } = await adminClient.rpc(
    "confirm_midtrans_refund_atomic",
    {
      p_refund_id: rawInput.refundId,
      p_gateway_refund_id: rawInput.gatewayRefundId.trim(),
      p_expected_amount: rawInput.expectedAmount ?? null,
      p_gateway_payload: rawInput.gatewayPayload ?? {},
    },
  );

  if (rpcErr) {
    return {
      ok: false,
      message: formatSafePaymentError(rpcErr.message),
    };
  }

  const result = rpcResult as unknown as RefundProcessingResult;

  revalidatePath("/pos");
  revalidatePath("/pos/floor");
  revalidatePath("/admin");

  return {
    ok: true,
    message: `Refund Midtrans ${result.refund_number} berhasil dikonfirmasi oleh gateway.`,
    data: result,
  };
}

/**
 * Mengambil data struk pesanan digital (58mm/80mm) yang tervalidasi untuk kasir dan admin.
 */
export async function getOrderReceiptDataAction(
  orderId: string,
): Promise<PaymentActionResult<ReceiptData>> {
  // 1. Otorisasi Kasir atau Admin
  const cashierActor = await getCashierActor();
  if (!cashierActor.ok) {
    return { ok: false, message: cashierActor.message };
  }

  if (!orderId || typeof orderId !== "string") {
    return { ok: false, message: "ID pesanan tidak valid." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  const { data: rpcResult, error: rpcErr } = await supabase.rpc(
    "get_order_receipt_data",
    {
      p_order_id: orderId,
    },
  );

  if (rpcErr) {
    return {
      ok: false,
      message: formatSafePaymentError(rpcErr.message),
    };
  }

  if (!rpcResult) {
    return {
      ok: false,
      message: "Data struk pesanan tidak ditemukan.",
    };
  }

  return {
    ok: true,
    message: "Data struk berhasil dimuat.",
    data: rpcResult as unknown as ReceiptData,
  };
}

/**
 * Membuat transaksi Midtrans Snap token di server untuk kasir POS.
 *
 * Persyaratan Keamanan F2.2 & TAHAP 3:
 * 1. Hanya Admin dan Kasir aktif yang berhak memicu pembayaran online.
 * 2. Pesanan wajib sudah difinalisasi (is_finalized = true).
 * 3. Token Snap dibuat di sisi server melalui createSnapPayment tanpa mengekspos Server Key.
 * 4. Kunci idempotensi unik per sesi pembayaran mencegah duplikasi reservasi gateway.
 */
export async function createPosMidtransSnapAction(
  rawInput: unknown,
): Promise<PaymentActionResult<CreateSnapTransactionResult>> {
  // 1. Otorisasi Kasir atau Admin
  const cashierActor = await getCashierActor();
  if (!cashierActor.ok) {
    return { ok: false, message: cashierActor.message };
  }

  // 2. Validasi Skema Zod
  const parsed = createSnapPaymentSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const input = parsed.data;

  // 3. Klien Supabase Terautentikasi
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  // 4. Validasi Pra-kondisi Pesanan
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("*")
    .eq("id", input.orderId)
    .maybeSingle<Order>();

  if (orderErr || !order) {
    return { ok: false, message: "Pesanan tidak ditemukan di database." };
  }

  if (!order.is_finalized) {
    return {
      ok: false,
      message:
        "Pesanan belum difinalisasi. Finalisasi pesanan terlebih dahulu sebelum memproses pembayaran.",
    };
  }

  if (order.status === "cancelled") {
    return {
      ok: false,
      message: `Pesanan ${order.order_number} sudah dibatalkan dan tidak dapat menerima pembayaran.`,
    };
  }

  if (order.status === "paid" || order.payment_status === "paid") {
    return {
      ok: false,
      message: `Pesanan ${order.order_number} sudah lunas sebelumnya.`,
    };
  }

  const remainingBalance = order.grand_total - order.paid_total;
  if (input.grossAmount > remainingBalance) {
    return {
      ok: false,
      message: `Nominal transaksi (Rp ${input.grossAmount.toLocaleString("id-ID")}) melebihi sisa tagihan (Rp ${remainingBalance.toLocaleString("id-ID")}).`,
    };
  }

  // 5. Eksekusi Service Midtrans Snap di Server-Side
  const snapResult = await createSnapPayment({
    orderId: order.id,
    orderNumber: order.order_number,
    grossAmount: input.grossAmount,
    idempotencyKey: input.idempotencyKey,
    customerName: order.customer_name,
    isSplitBill: input.isSplitBill,
    splitBillType: (input.splitBillType ?? undefined) as MidtransSplitBillType | undefined,
    itemAllocations: input.itemAllocations ?? undefined,
  });

  if (!snapResult.ok) {
    return {
      ok: false,
      message: snapResult.error || "Gagal membuat transaksi Midtrans Snap.",
    };
  }

  return {
    ok: true,
    message: "Transaksi Midtrans Snap berhasil dibuat.",
    data: snapResult,
  };
}

/**
 * Mengambil status pembayaran terkini dari pesanan untuk verifikasi terpercaya (polling / refresh).
 * Jika pesanan belum lunas dan terdapat transaksi Midtrans, melakukan rekonsiliasi aktif
 * langsung ke Midtrans Core API menggunakan Server Key resmi.
 */
export async function getOrderPaymentStatusAction(
  orderId: string,
): Promise<
  PaymentActionResult<{
    orderId: string;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    paidTotal: number;
    grandTotal: number;
    remainingBalance: number;
    isSettled: boolean;
    queueNumber?: string | null;
    activeSnapToken?: string | null;
    activeMidtransOrderId?: string | null;
    midtransStatus?: string | null;
    reconciliationMessage?: string | null;
  }>
> {
  const cashierActor = await getCashierActor();
  if (!cashierActor.ok) {
    return { ok: false, message: cashierActor.message };
  }

  if (!orderId || typeof orderId !== "string") {
    return { ok: false, message: "ID pesanan tidak valid." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  const { data: order, error } = await supabase
    .from("orders")
    .select("id, order_number, status, payment_status, paid_total, grand_total, queue_number")
    .eq("id", orderId)
    .maybeSingle<{
      id: string;
      order_number: string;
      status: string;
      payment_status: string;
      paid_total: number;
      grand_total: number;
      queue_number: string | null;
    }>();

  if (error || !order) {
    return { ok: false, message: "Pesanan tidak ditemukan." };
  }

  const isInitialSettled = order.payment_status === "paid" || order.status === "paid";

  // Ambil transaksi Midtrans terakhir jika ada (untuk token Snap & info rekonsiliasi)
  let activeSnapToken: string | null = null;
  let activeMidtransOrderId: string | null = null;
  let midtransStatus: string | null = null;
  let reconciliationMessage: string | null = null;

  const adminClient = createSupabaseAdminClient();
  if (adminClient) {
    const { data: latestMidtransTx } = await adminClient
      .from("midtrans_transactions")
      .select("midtrans_order_id, snap_token, lifecycle_status, payment_expires_at")
      .eq("order_id", orderId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestMidtransTx) {
      activeMidtransOrderId = latestMidtransTx.midtrans_order_id;
      // Sediakan token untuk dibuka ulang jika masih aktif/pending
      if (
        latestMidtransTx.lifecycle_status === "token_created" ||
        latestMidtransTx.lifecycle_status === "pending"
      ) {
        activeSnapToken = latestMidtransTx.snap_token;
      }
    }
  }

  // Jika pesanan belum berstatus lunas dan terdapat transaksi Midtrans, lakukan rekonsiliasi aktif
  let currentSettled = isInitialSettled;
  let currentPaidTotal = order.paid_total;
  let currentStatus = order.status;
  let currentPaymentStatus = order.payment_status;

  if (!currentSettled && activeMidtransOrderId) {
    const reconcileResult = await reconcileActiveMidtransPayment({ orderId });
    if (reconcileResult.ok) {
      midtransStatus = reconcileResult.midtransStatus ?? null;
      reconciliationMessage = reconcileResult.message ?? null;

      if (reconcileResult.isSettled) {
        // Ambil data pesanan segar setelah mutasi settlement atomik di PostgreSQL
        const { data: refreshedOrder } = await supabase
          .from("orders")
          .select("id, order_number, status, payment_status, paid_total, grand_total, queue_number")
          .eq("id", orderId)
          .maybeSingle();

        if (refreshedOrder) {
          currentSettled =
            refreshedOrder.payment_status === "paid" || refreshedOrder.status === "paid";
          currentPaidTotal = refreshedOrder.paid_total;
          currentStatus = refreshedOrder.status;
          currentPaymentStatus = refreshedOrder.payment_status;
        }
      }
    } else {
      reconciliationMessage = reconcileResult.error ?? null;
    }
  }

  const remainingBalance = Math.max(0, order.grand_total - currentPaidTotal);

  return {
    ok: true,
    message: currentSettled ? "Pesanan lunas terverifikasi." : "Pesanan belum lunas.",
    data: {
      orderId: order.id,
      orderNumber: order.order_number,
      status: currentStatus,
      paymentStatus: currentPaymentStatus,
      paidTotal: currentPaidTotal,
      grandTotal: order.grand_total,
      remainingBalance,
      isSettled: currentSettled,
      queueNumber: order.queue_number,
      activeSnapToken,
      activeMidtransOrderId,
      midtransStatus,
      reconciliationMessage,
    },
  };
}


