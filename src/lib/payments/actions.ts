"use server";

import { revalidatePath } from "next/cache";
import { getCashierActor } from "@/lib/auth/session";
import type {
  PaymentActionResult,
  PaymentProcessingResult,
} from "@/lib/payments/types";
import {
  fieldErrorsFrom,
  firstZodError,
  manualPaymentSchema,
} from "@/lib/payments/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
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
