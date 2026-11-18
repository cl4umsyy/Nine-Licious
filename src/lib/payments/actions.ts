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
import {
  formatSafeReceiptError,
  normalizeReceiptWidth,
} from "@/lib/payments/receipt";
import type {
  Order,
  OrderDiscount,
  OrderItem,
  OrderItemModifier,
  Payment,
  Refund,
  RestaurantSettings,
} from "@/types/database";

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
 * Fallback read-only builder untuk data struk ketika RPC `get_order_receipt_data`
 * mengalami error (mis. bug PL/pgSQL `record "v_table" is not assigned yet` pada
 * pesanan Takeaway dimana `table_id IS NULL`).
 *
 * Strictly READ-ONLY: tidak pernah membuat atau mengubah transaksi pembayaran.
 */
async function buildOrderReceiptDataFallback(
  supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>,
  orderId: string,
): Promise<ReceiptData | null> {
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle<Order>();

  if (orderErr || !order) {
    return null;
  }

  const [
    settingsRes,
    tableRes,
    itemsRes,
    discountsRes,
    paymentsRes,
    refundsRes,
  ] = await Promise.all([
    supabase
      .from("restaurant_settings")
      .select("name, address, phone, logo_url, receipt_header, receipt_footer, receipt_width")
      .eq("id", 1)
      .maybeSingle<
        Pick<
          RestaurantSettings,
          | "name"
          | "address"
          | "phone"
          | "logo_url"
          | "receipt_header"
          | "receipt_footer"
          | "receipt_width"
        >
      >(),
    order.table_id
      ? supabase
          .from("dining_tables")
          .select("name")
          .eq("id", order.table_id)
          .maybeSingle<{ name: string }>()
      : Promise.resolve({ data: null as { name: string } | null, error: null }),
    supabase
      .from("order_items")
      .select("*")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true }),
    supabase
      .from("order_discounts")
      .select("*")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true }),
    supabase
      .from("payments")
      .select("*")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true }),
    supabase
      .from("refunds")
      .select("*")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true }),
  ]);

  const items = (itemsRes.data ?? []) as OrderItem[];
  const discounts = (discountsRes.data ?? []) as OrderDiscount[];
  const payments = (paymentsRes.data ?? []) as Payment[];
  const refunds = (refundsRes.data ?? []) as Refund[];

  const itemIds = items.map((item) => item.id);
  let modifiers: OrderItemModifier[] = [];
  if (itemIds.length > 0) {
    const { data: modRows } = await supabase
      .from("order_item_modifiers")
      .select("*")
      .in("order_item_id", itemIds)
      .order("created_at", { ascending: true });
    modifiers = (modRows ?? []) as OrderItemModifier[];
  }

  // Ambil nama staf (pembuat pesanan / approver diskon / approver refund) secara read-only
  const profileIds = Array.from(
    new Set(
      [
        order.created_by,
        ...discounts.map((d) => d.approved_by),
        ...refunds.map((r) => r.approved_by),
      ].filter((id): id is string => Boolean(id)),
    ),
  );

  const profileNames = new Map<string, string>();
  if (profileIds.length > 0) {
    const profileClient = createSupabaseAdminClient() ?? supabase;
    const { data: profileRows } = await profileClient
      .from("profiles")
      .select("id, full_name")
      .in("id", profileIds);
    for (const row of (profileRows ?? []) as Array<{
      id: string;
      full_name: string;
    }>) {
      profileNames.set(row.id, row.full_name);
    }
  }

  const modifiersByItem = new Map<
    string,
    Array<{ group_name: string; option_name: string; price_delta: number }>
  >();
  for (const mod of modifiers) {
    const arr = modifiersByItem.get(mod.order_item_id) ?? [];
    arr.push({
      group_name: mod.group_name_snapshot,
      option_name: mod.option_name_snapshot,
      price_delta: Number(mod.price_delta_snapshot) || 0,
    });
    modifiersByItem.set(mod.order_item_id, arr);
  }

  const completedRefundTotal = refunds
    .filter((r) => r.status === "completed")
    .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const pendingRefundTotal = refunds
    .filter((r) => r.status === "pending")
    .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

  const settings = settingsRes.data;
  const paidTotal = Number(order.paid_total) || 0;

  return {
    restaurant: {
      name: settings?.name || "Nine Licious",
      address: settings?.address ?? null,
      phone: settings?.phone ?? null,
      logo_url: settings?.logo_url ?? null,
      receipt_header: settings?.receipt_header ?? null,
      receipt_footer: settings?.receipt_footer ?? null,
      receipt_width: normalizeReceiptWidth(settings?.receipt_width),
    },
    order: {
      id: order.id,
      order_number: order.order_number,
      order_type: order.order_type,
      table_name: tableRes.data?.name ?? null,
      customer_name: order.customer_name ?? null,
      status: order.status,
      payment_status: order.payment_status,
      queue_number: order.queue_number ?? null,
      queue_date: order.queue_date ?? null,
      cashier_name:
        (order.created_by ? profileNames.get(order.created_by) : null) ??
        "Kasir",
      created_at: order.created_at,
      subtotal: Number(order.subtotal) || 0,
      discount_product_total: Number(order.discount_product_total) || 0,
      discount_order_total: Number(order.discount_order_total) || 0,
      discount_manual_total: Number(order.discount_manual_total) || 0,
      discount_total: Number(order.discount_total) || 0,
      tax_percent: Number(order.tax_percent) || 0,
      tax_total: Number(order.tax_total) || 0,
      service_charge_percent: Number(order.service_charge_percent) || 0,
      service_total: Number(order.service_total) || 0,
      grand_total: Number(order.grand_total) || 0,
      paid_total: paidTotal,
      refunded_total: completedRefundTotal,
      pending_refund_total: pendingRefundTotal,
      net_paid: paidTotal - completedRefundTotal,
    },
    items: items.map((item) => ({
      id: item.id,
      product_id: item.product_id,
      product_name: item.product_name_snapshot,
      product_sku: item.product_sku_snapshot,
      unit_price: Number(item.unit_price_snapshot) || 0,
      quantity: Number(item.quantity) || 0,
      notes: item.notes ?? null,
      modifier_total: Number(item.modifier_total) || 0,
      subtotal: Number(item.subtotal) || 0,
      discount_amount: Number(item.discount_amount) || 0,
      line_total: Number(item.line_total) || 0,
      kitchen_station: item.kitchen_station ?? null,
      modifiers: modifiersByItem.get(item.id) ?? [],
    })),
    discounts: discounts.map((d) => ({
      id: d.id,
      name: d.name,
      scope: d.scope,
      discount_type: d.discount_type,
      discount_rate: Number(d.discount_rate) || 0,
      discount_amount: Number(d.discount_amount) || 0,
      reason: d.reason ?? null,
      approved_by: d.approved_by ?? null,
      approved_at: d.approved_at ?? null,
      approver_name: d.approved_by
        ? (profileNames.get(d.approved_by) ?? null)
        : null,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      payment_method: p.payment_method,
      payment_source: p.payment_source,
      amount: Number(p.amount) || 0,
      cash_received: p.cash_received !== null ? Number(p.cash_received) : null,
      change_amount: Number(p.change_amount) || 0,
      payment_status: p.payment_status,
      reference_number: p.reference_number ?? null,
      created_at: p.created_at,
    })),
    refunds: refunds.map((r) => ({
      id: r.id,
      refund_number: r.refund_number,
      gateway_refund_id: r.gateway_refund_id ?? null,
      refund_type: r.refund_type,
      refund_method: r.refund_method,
      amount: Number(r.amount) || 0,
      reason: r.reason,
      status: r.status,
      created_at: r.created_at,
      approver_name: r.approved_by
        ? (profileNames.get(r.approved_by) ?? null)
        : null,
    })),
  };
}

/**
 * Mengambil data struk pesanan digital (58mm/80mm) yang tervalidasi untuk kasir dan admin.
 * Strictly read-only — tidak pernah membuat pembayaran baru atau mengubah status pesanan.
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

  if (!rpcErr && rpcResult) {
    return {
      ok: true,
      message: "Data struk berhasil dimuat.",
      data: rpcResult as unknown as ReceiptData,
    };
  }

  // Jika RPC gagal (mis. `55000: record "v_table" is not assigned yet` pada pesanan Takeaway),
  // gunakan fallback read-only langsung dari tabel agar struk tetap tampil tanpa error palsu.
  if (rpcErr) {
    console.warn(
      "[receipt] RPC get_order_receipt_data fallback dipicu:",
      rpcErr.code,
      rpcErr.message,
    );
  }

  try {
    const fallbackData = await buildOrderReceiptDataFallback(supabase, orderId);
    if (fallbackData) {
      return {
        ok: true,
        message: "Data struk berhasil dimuat.",
        data: fallbackData,
      };
    }
  } catch (fallbackErr: unknown) {
    console.error(
      "[receipt] Gagal memuat fallback data struk:",
      fallbackErr instanceof Error ? fallbackErr.message : fallbackErr,
    );
  }

  if (rpcErr) {
    return {
      ok: false,
      message: formatSafeReceiptError(rpcErr.message),
    };
  }

  return {
    ok: false,
    message: "Data struk pesanan tidak ditemukan.",
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

      if (
        reconcileResult.isSettled ||
        reconcileResult.midtransStatus === "settlement" ||
        reconcileResult.midtransStatus === "capture"
      ) {
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
          order.queue_number = refreshedOrder.queue_number;
        }

        if (currentSettled) {
          revalidatePath("/pos");
          revalidatePath("/pos/orders");
          revalidatePath("/kitchen");
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


