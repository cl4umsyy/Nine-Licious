"use server";

import { revalidatePath } from "next/cache";
import { getAdminActor, getCashierActor } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  Order,
  OrderReplacement,
  OrderType,
  Payment,
  Refund,
  RefundCorrection,
  RefundEvidence,
  RefundItem,
  RefundPayoutAllocation,
  RefundPayoutMethod,
} from "@/types/database";
import {
  buildOrderItemBaselines,
  isWithinRefund24HourWindow,
  resolveEffectiveReplacementStatus,
  type CanonicalOrderItemInput,
  type HistoricalRefundClaimRow,
} from "./calculations";
import type {
  OpenShiftOption,
  OrderRefundContextData,
  RefundActionResult,
  RefundDetailData,
  RefundListItem,
  RefundQueueSummary,
} from "./types";
import {
  approveOrderRefundSchema,
  attachRefundEvidenceSchema,
  cancelOrderRefundSchema,
  completeRefundManualFallbackSchema,
  fieldErrorsFrom,
  firstZodError,
  recordRefundCorrectionSchema,
  rejectOrderRefundSchema,
  requestOrderRefundSchema,
  requestRefundEvidenceSchema,
} from "./validation";

function revalidateRefundRelatedPaths(): void {
  revalidatePath("/pos");
  revalidatePath("/pos/orders");
  revalidatePath("/pos/floor");
  revalidatePath("/pos/shift");
  revalidatePath("/kitchen");
  revalidatePath("/admin");
  revalidatePath("/admin/transactions");
  revalidatePath("/admin/reports");
  revalidatePath("/admin/inventory");
  revalidatePath("/admin/shifts");
  revalidatePath("/admin/tables");
  revalidatePath("/admin/audit");
}

function formatRefundRpcError(rawMessage: string): string {
  const msg = (rawMessage || "").trim();
  if (!msg) return "Terjadi kesalahan saat memproses permintaan refund.";
  if (msg.includes("Could not find the function")) {
    return "Fungsi refund terbaru (R1-R5) belum tersedia di database.";
  }
  return msg;
}

function derivePayoutMethodFromPayment(
  paymentMethod: string,
  paymentSource: string,
): RefundPayoutMethod {
  if (
    paymentMethod === "midtrans" ||
    paymentSource === "midtrans_snap" ||
    paymentSource === "qris_midtrans"
  ) {
    return "midtrans";
  }
  if (paymentMethod === "cash") return "cash";
  return "transfer";
}

function extractTableName(
  rel: { name: string } | Array<{ name: string }> | null | undefined,
): string | null {
  if (!rel) return null;
  if (Array.isArray(rel)) return rel[0]?.name ?? null;
  return rel.name ?? null;
}

/**
 * Mengambil konteks lengkap pengajuan refund untuk satu transaksi pesanan
 * (baseline item, klaim kumulatif A.3, sisa pembayaran Split Bill, & shift kasir aktif).
 */
export async function getOrderRefundContextAction(
  orderId: string,
): Promise<RefundActionResult<OrderRefundContextData>> {
  const actor = await getCashierActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) {
    return { ok: false, message: "ID pesanan tidak valid." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi database tidak tersedia." };
  }

  const [orderRes, itemsRes, paymentsRes, refundsRes, shiftsRes] =
    await Promise.all([
      supabase
        .from("orders")
        .select("*, dining_tables(name)")
        .eq("id", orderId)
        .maybeSingle<
          Order & {
            dining_tables?: { name: string } | Array<{ name: string }> | null;
          }
        >(),
      supabase
        .from("order_items")
        .select(
          "id, product_name_snapshot, unit_price_snapshot, quantity, subtotal, discount_amount, created_at",
        )
        .eq("order_id", orderId)
        .order("created_at", { ascending: true }),
      supabase
        .from("payments")
        .select("*")
        .eq("order_id", orderId)
        .in("payment_status", ["success", "refunded"])
        .order("created_at", { ascending: true }),
      supabase
        .from("refunds")
        .select("*")
        .eq("order_id", orderId)
        .order("created_at", { ascending: true }),
      supabase
        .from("shifts")
        .select(
          "id, cashier_id, opened_at, expected_cash, status, cashier:profiles!shifts_cashier_id_fkey(full_name, username)",
        )
        .eq("status", "open")
        .order("opened_at", { ascending: false }),
    ]);

  if (orderRes.error || !orderRes.data) {
    return { ok: false, message: "Pesanan tidak ditemukan." };
  }

  const order = orderRes.data;
  const orderKind = order.order_kind ?? "standard";
  const refunds = (refundsRes.data ?? []) as Refund[];
  const refundIds = refunds.map((r) => r.id);

  const [refundItemsRes, allocsRes] =
    refundIds.length > 0
      ? await Promise.all([
          supabase
            .from("refund_items")
            .select("*")
            .in("refund_id", refundIds),
          supabase
            .from("refund_payout_allocations")
            .select("*")
            .in("refund_id", refundIds),
        ])
      : [
          { data: [] as RefundItem[] },
          { data: [] as RefundPayoutAllocation[] },
        ];

  const refundMap = new Map(refunds.map((r) => [r.id, r]));
  const priorClaims: HistoricalRefundClaimRow[] = (
    (refundItemsRes.data ?? []) as RefundItem[]
  ).map((ri) => {
    const parent = refundMap.get(ri.refund_id);
    return {
      order_item_id: ri.order_item_id,
      quantity: ri.quantity,
      net_item_amount: ri.net_item_amount,
      service_charge_amount: ri.service_charge_amount,
      tax_amount: ri.tax_amount,
      refund_amount: ri.refund_amount,
      compensation_percentage: ri.compensation_percentage,
      is_full_item_refund: ri.is_full_item_refund,
      approval_status: parent?.approval_status,
      payout_status: parent?.payout_status,
      resolution_type: parent?.resolution_type,
    };
  });

  const allocs = (allocsRes.data ?? []) as RefundPayoutAllocation[];
  const allocsByRefundId = new Map<string, RefundPayoutAllocation[]>();
  const reservedOrCompletedByPaymentId = new Map<string, number>();

  for (const a of allocs) {
    const list = allocsByRefundId.get(a.refund_id) ?? [];
    list.push(a);
    allocsByRefundId.set(a.refund_id, list);

    const parent = refundMap.get(a.refund_id);
    if (
      parent &&
      parent.approval_status !== "rejected" &&
      parent.approval_status !== "cancelled" &&
      a.payout_status !== "failed"
    ) {
      reservedOrCompletedByPaymentId.set(
        a.payment_id,
        (reservedOrCompletedByPaymentId.get(a.payment_id) ?? 0) +
          (Number(a.amount) || 0),
      );
    }
  }

  // Hitung legacy refunds yang belum punya refund_payout_allocations
  for (const r of refunds) {
    if (
      r.payment_id &&
      r.resolution_type !== "replacement" &&
      r.approval_status !== "rejected" &&
      r.approval_status !== "cancelled" &&
      r.payout_status !== "failed" &&
      !allocsByRefundId.has(r.id)
    ) {
      reservedOrCompletedByPaymentId.set(
        r.payment_id,
        (reservedOrCompletedByPaymentId.get(r.payment_id) ?? 0) +
          (Number(r.amount) || 0),
      );
    }
  }

  let pendingRefundTotal = 0;
  for (const r of refunds) {
    if (
      r.resolution_type !== "replacement" &&
      (r.approval_status === "pending_approval" ||
        r.approval_status === "approved") &&
      (r.payout_status === "not_required" ||
        r.payout_status === "pending" ||
        r.payout_status === "processing" ||
        r.payout_status === "reconciliation_required") &&
      r.status === "pending"
    ) {
      const rAllocs = allocsByRefundId.get(r.id);
      if (rAllocs && rAllocs.length > 0) {
        pendingRefundTotal += rAllocs
          .filter((a) =>
            ["pending", "processing", "reconciliation_required"].includes(
              a.payout_status,
            ),
          )
          .reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
      } else {
        pendingRefundTotal += Number(r.amount) || 0;
      }
    }
  }

  const paidTotal = Number(order.paid_total) || 0;
  const refundedTotal = Number(order.refunded_total) || 0;
  const availableRefundable = Math.max(
    0,
    paidTotal - (refundedTotal + pendingRefundTotal),
  );

  const windowCheck = isWithinRefund24HourWindow(order.paid_at ?? null);
  let ineligibilityReason: string | null = null;

  if (orderKind !== "standard") {
    ineligibilityReason =
      "Pesanan pengganti (replacement) tidak dapat diajukan refund kembali.";
  } else if (
    order.status === "partially_paid" ||
    order.payment_status === "partially_paid"
  ) {
    ineligibilityReason =
      "Pesanan berstatus bayar sebagian belum memenuhi syarat pengajuan refund.";
  } else if (order.status !== "paid" && order.status !== "completed") {
    ineligibilityReason = `Hanya pesanan berstatus lunas (paid/completed) yang dapat diajukan refund (status saat ini: ${order.status}).`;
  } else if (!order.paid_at) {
    ineligibilityReason =
      "Pesanan belum memiliki timestamp pelunasan (paid_at) yang valid.";
  } else if (!windowCheck.within24Hours) {
    ineligibilityReason =
      "Batas waktu pengajuan refund maksimal 24 jam sejak transaksi lunas telah terlampaui.";
  }

  const baselines = buildOrderItemBaselines({
    order: {
      subtotal: Number(order.subtotal) || 0,
      discount_product_total: Number(order.discount_product_total) || 0,
      discount_order_total: Number(order.discount_order_total) || 0,
      discount_manual_total: Number(order.discount_manual_total) || 0,
      service_total: Number(order.service_total) || 0,
      tax_total: Number(order.tax_total) || 0,
      kds_status: order.kds_status,
    },
    orderItems: (itemsRes.data ?? []) as CanonicalOrderItemInput[],
    priorRefundItems: priorClaims,
  });

  const paymentOptions = ((paymentsRes.data ?? []) as Payment[]).map((p) => {
    const used = reservedOrCompletedByPaymentId.get(p.id) ?? 0;
    return {
      id: p.id,
      paymentMethod: p.payment_method,
      paymentSource: p.payment_source,
      suggestedPayoutMethod: derivePayoutMethodFromPayment(
        p.payment_method,
        p.payment_source,
      ),
      amount: Number(p.amount) || 0,
      paymentStatus: p.payment_status,
      alreadyRefundedOrReserved: used,
      remainingRefundable: Math.max(0, (Number(p.amount) || 0) - used),
      createdAt: p.created_at,
      referenceNumber: p.reference_number ?? null,
    };
  });

  type RawShiftRow = {
    id: string;
    cashier_id: string;
    opened_at: string;
    expected_cash: number;
    status: "open" | "closed";
    cashier?:
      | { full_name: string; username: string }
      | Array<{ full_name: string; username: string }>
      | null;
  };

  const openShifts: OpenShiftOption[] = (
    (shiftsRes.data ?? []) as RawShiftRow[]
  ).map((s) => {
    const cObj = Array.isArray(s.cashier) ? s.cashier[0] : s.cashier;
    return {
      id: s.id,
      cashierId: s.cashier_id,
      cashierName: cObj?.full_name ?? "Kasir",
      cashierUsername: cObj?.username ?? "-",
      openedAt: s.opened_at,
      expectedCash: Number(s.expected_cash) || 0,
      status: s.status,
    };
  });

  return {
    ok: true,
    message: "Konteks pengajuan refund berhasil dimuat.",
    data: {
      order: {
        id: order.id,
        orderNumber: order.order_number,
        orderType: order.order_type,
        orderKind,
        status: order.status,
        paymentStatus: order.payment_status,
        kdsStatus: order.kds_status,
        tableName: extractTableName(order.dining_tables),
        customerName: order.customer_name ?? null,
        subtotal: Number(order.subtotal) || 0,
        discountProductTotal: Number(order.discount_product_total) || 0,
        discountOrderTotal: Number(order.discount_order_total) || 0,
        discountManualTotal: Number(order.discount_manual_total) || 0,
        discountTotal: Number(order.discount_total) || 0,
        serviceTotal: Number(order.service_total) || 0,
        taxTotal: Number(order.tax_total) || 0,
        grandTotal: Number(order.grand_total) || 0,
        paidTotal,
        refundedTotal,
        pendingRefundTotal,
        availableRefundable,
        paidAt: order.paid_at ?? null,
        within24Hours: windowCheck.within24Hours,
        hoursSincePaid: windowCheck.hoursSincePaid,
        isEligibleForNewRequest: ineligibilityReason === null,
        ineligibilityReason,
      },
      items: baselines,
      payments: paymentOptions,
      openShifts,
    },
  };
}

/**
 * Mengambil daftar pengajuan refund/replacement untuk manajemen Kasir & Admin.
 */
export async function getRefundManagementListAction(filter?: {
  approvalStatus?: string;
  resolutionType?: string;
  search?: string;
}): Promise<
  RefundActionResult<{ items: RefundListItem[]; summary: RefundQueueSummary }>
> {
  const actor = await getCashierActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi database tidak tersedia." };
  }

  let query = supabase
    .from("refunds")
    .select(
      "*, orders!inner(order_number, order_type, dining_tables(name)), requester:profiles!refunds_requested_by_fkey(full_name, username), reviewer:profiles!refunds_reviewed_by_fkey(full_name, username)",
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (filter?.approvalStatus && filter.approvalStatus !== "all") {
    query = query.eq("approval_status", filter.approvalStatus);
  }
  if (filter?.resolutionType && filter.resolutionType !== "all") {
    query = query.eq("resolution_type", filter.resolutionType);
  }

  const { data: rawRows, error } = await query;
  if (error) {
    return {
      ok: false,
      message: `Gagal memuat daftar pengajuan refund: ${error.message}`,
    };
  }

  type RawJoinedRefund = Refund & {
    orders?:
      | {
          order_number: string;
          order_type: OrderType;
          dining_tables?: { name: string } | Array<{ name: string }> | null;
        }
      | Array<{
          order_number: string;
          order_type: OrderType;
          dining_tables?: { name: string } | Array<{ name: string }> | null;
        }>
      | null;
    requester?:
      | { full_name: string; username: string }
      | Array<{ full_name: string; username: string }>
      | null;
    reviewer?:
      | { full_name: string; username: string }
      | Array<{ full_name: string; username: string }>
      | null;
  };

  const rows = (rawRows ?? []) as RawJoinedRefund[];
  const refundIds = rows.map((r) => r.id);

  const [evidenceRes, replacementsRes] =
    refundIds.length > 0
      ? await Promise.all([
          supabase
            .from("refund_evidence")
            .select("refund_id")
            .in("refund_id", refundIds),
          supabase
            .from("order_replacements")
            .select("refund_id, status, replacement_order_id")
            .in("refund_id", refundIds),
        ])
      : [{ data: [] as Array<{ refund_id: string }> }, { data: [] }];

  const evidenceCounts = new Map<string, number>();
  for (const ev of (evidenceRes.data ?? []) as Array<{ refund_id: string }>) {
    evidenceCounts.set(
      ev.refund_id,
      (evidenceCounts.get(ev.refund_id) ?? 0) + 1,
    );
  }

  const repMap = new Map<
    string,
    { status: OrderReplacement["status"]; replacementOrderId: string | null }
  >();
  const repOrderIds: string[] = [];
  for (const rep of (replacementsRes.data ?? []) as Array<{
    refund_id: string;
    status: OrderReplacement["status"];
    replacement_order_id: string | null;
  }>) {
    repMap.set(rep.refund_id, {
      status: rep.status,
      replacementOrderId: rep.replacement_order_id,
    });
    if (rep.replacement_order_id) repOrderIds.push(rep.replacement_order_id);
  }

  const repOrderMap = new Map<
    string,
    { orderNumber: string; kds_status: string | null; served_at: string | null }
  >();
  if (repOrderIds.length > 0) {
    const { data: repOrders } = await supabase
      .from("orders")
      .select("id, order_number, kds_status, served_at")
      .in("id", repOrderIds);
    for (const ro of (repOrders ?? []) as Array<{
      id: string;
      order_number: string;
      kds_status: string | null;
      served_at: string | null;
    }>) {
      repOrderMap.set(ro.id, {
        orderNumber: ro.order_number,
        kds_status: ro.kds_status,
        served_at: ro.served_at,
      });
    }
  }

  const searchLower = (filter?.search ?? "").trim().toLowerCase();

  let items: RefundListItem[] = rows.map((r) => {
    const ordObj = Array.isArray(r.orders) ? r.orders[0] : r.orders;
    const reqObj = Array.isArray(r.requester) ? r.requester[0] : r.requester;
    const revObj = Array.isArray(r.reviewer) ? r.reviewer[0] : r.reviewer;
    const repInfo = repMap.get(r.id);
    const repOrd = repInfo?.replacementOrderId
      ? repOrderMap.get(repInfo.replacementOrderId)
      : undefined;

    return {
      id: r.id,
      refundNumber: r.refund_number,
      orderId: r.order_id,
      orderNumber: ordObj?.order_number ?? "-",
      tableName: extractTableName(ordObj?.dining_tables),
      orderType: ordObj?.order_type ?? "takeaway",
      resolutionType: r.resolution_type ?? "partial_refund",
      reasonCategory: r.reason_category ?? "other",
      approvalStatus: r.approval_status ?? "pending_approval",
      payoutStatus: r.payout_status ?? "not_required",
      payoutMethod: r.payout_method ?? null,
      refundMethod: r.refund_method,
      amount: Number(r.amount) || 0,
      reason: r.reason,
      chronology: r.chronology ?? null,
      rejectionReason: r.rejection_reason ?? null,
      cancellationReason: r.cancellation_reason ?? null,
      requestedBy: r.requested_by,
      requesterName: reqObj?.full_name ?? "Staf",
      requesterUsername: reqObj?.username ?? "-",
      reviewedBy: r.reviewed_by ?? null,
      reviewerName: revObj?.full_name ?? null,
      reviewedAt: r.reviewed_at ?? null,
      payoutCompletedAt: r.payout_completed_at ?? null,
      gatewayRefundId: r.gateway_refund_id ?? null,
      payoutReference: r.payout_reference ?? null,
      shiftId: r.shift_id ?? null,
      parentRefundId: r.parent_refund_id ?? null,
      evidenceCount: evidenceCounts.get(r.id) ?? 0,
      replacementStatus: repInfo
        ? resolveEffectiveReplacementStatus(repInfo.status, repOrd)
        : null,
      replacementOrderNumber: repOrd?.orderNumber ?? null,
      createdAt: r.created_at,
    };
  });

  if (searchLower) {
    items = items.filter(
      (item) =>
        item.refundNumber.toLowerCase().includes(searchLower) ||
        item.orderNumber.toLowerCase().includes(searchLower) ||
        item.requesterName.toLowerCase().includes(searchLower) ||
        item.reason.toLowerCase().includes(searchLower),
    );
  }

  const summary: RefundQueueSummary = {
    totalCount: items.length,
    pendingApprovalCount: items.filter(
      (i) => i.approvalStatus === "pending_approval",
    ).length,
    midtransPendingCount: items.filter(
      (i) =>
        i.approvalStatus === "approved" &&
        ["pending", "processing", "reconciliation_required"].includes(
          i.payoutStatus,
        ),
    ).length,
    replacementActiveCount: items.filter(
      (i) =>
        i.resolutionType === "replacement" &&
        i.replacementStatus !== null &&
        ["pending_approval", "in_kitchen", "ready"].includes(
          i.replacementStatus,
        ),
    ).length,
    completedFinancialTotal: items
      .filter(
        (i) =>
          i.resolutionType !== "replacement" && i.payoutStatus === "completed",
      )
      .reduce((sum, i) => sum + i.amount, 0),
  };

  return {
    ok: true,
    message: "Daftar pengajuan refund berhasil dimuat.",
    data: { items, summary },
  };
}

/**
 * Mengambil detail penuh satu pengajuan refund (item breakdown, Split Bill allocations,
 * koreksi under/over-refund, signed URL bukti foto/video, dan shift kasir aktif).
 */
export async function getRefundDetailAction(
  refundId: string,
): Promise<RefundActionResult<RefundDetailData>> {
  const actor = await getCashierActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  if (!refundId || !/^[0-9a-f-]{36}$/i.test(refundId)) {
    return { ok: false, message: "ID refund tidak valid." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi database tidak tersedia." };
  }

  const { data: refundRow, error: rErr } = await supabase
    .from("refunds")
    .select(
      "*, orders!inner(order_number, order_type, status, paid_total, refunded_total, dining_tables(name)), requester:profiles!refunds_requested_by_fkey(full_name, username), reviewer:profiles!refunds_reviewed_by_fkey(full_name, username)",
    )
    .eq("id", refundId)
    .maybeSingle();

  if (rErr || !refundRow) {
    return { ok: false, message: "Detail pengajuan refund tidak ditemukan." };
  }

  type RawDetailRefund = Refund & {
    orders: {
      order_number: string;
      order_type: OrderType;
      status: Order["status"];
      paid_total: number;
      refunded_total?: number;
      dining_tables?: { name: string } | Array<{ name: string }> | null;
    };
    requester?: { full_name: string; username: string } | null;
    reviewer?: { full_name: string; username: string } | null;
  };

  const r = refundRow as RawDetailRefund;

  const [
    itemsRes,
    allocsRes,
    corrRes,
    evRes,
    repRes,
    orderContextRes,
  ] = await Promise.all([
    supabase
      .from("refund_items")
      .select("*")
      .eq("refund_id", r.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("refund_payout_allocations")
      .select("*, payments(payment_method, payment_source)")
      .eq("refund_id", r.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("refund_corrections")
      .select("*")
      .eq("refund_id", r.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("refund_evidence")
      .select("*")
      .eq("refund_id", r.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("order_replacements")
      .select("*")
      .eq("refund_id", r.id)
      .maybeSingle<OrderReplacement>(),
    getOrderRefundContextAction(r.order_id),
  ]);

  let repOrderNumber: string | null = null;
  let repOrderProgress: {
    kds_status: string | null;
    served_at: string | null;
  } | null = null;
  if (repRes.data?.replacement_order_id) {
    const { data: ro } = await supabase
      .from("orders")
      .select("order_number, kds_status, served_at")
      .eq("id", repRes.data.replacement_order_id)
      .maybeSingle<{
        order_number: string;
        kds_status: string | null;
        served_at: string | null;
      }>();
    repOrderNumber = ro?.order_number ?? null;
    repOrderProgress = ro ?? null;
  }

  const evidenceRows = (evRes.data ?? []) as RefundEvidence[];
  const signedEvidence = await Promise.all(
    evidenceRows.map(async (ev) => {
      const { data: signed } = await supabase.storage
        .from("refund-evidence")
        .createSignedUrl(ev.file_path, 300);
      return {
        id: ev.id,
        filePath: ev.file_path,
        fileName: ev.file_name,
        fileType: ev.file_type,
        fileSize: Number(ev.file_size) || 0,
        evidenceKind: ev.evidence_kind,
        notes: ev.notes ?? null,
        signedUrl: signed?.signedUrl ?? null,
        createdAt: ev.created_at,
      };
    }),
  );

  type RawAllocJoin = RefundPayoutAllocation & {
    payments?:
      | { payment_method: Payment["payment_method"]; payment_source: Payment["payment_source"] }
      | Array<{ payment_method: Payment["payment_method"]; payment_source: Payment["payment_source"] }>
      | null;
  };

  return {
    ok: true,
    message: "Detail pengajuan refund berhasil dimuat.",
    data: {
      id: r.id,
      refundNumber: r.refund_number,
      orderId: r.order_id,
      orderNumber: r.orders.order_number,
      tableName: extractTableName(r.orders.dining_tables),
      orderType: r.orders.order_type,
      resolutionType: r.resolution_type ?? "partial_refund",
      reasonCategory: r.reason_category ?? "other",
      approvalStatus: r.approval_status ?? "pending_approval",
      payoutStatus: r.payout_status ?? "not_required",
      payoutMethod: r.payout_method ?? null,
      refundMethod: r.refund_method,
      amount: Number(r.amount) || 0,
      reason: r.reason,
      chronology: r.chronology ?? null,
      rejectionReason: r.rejection_reason ?? null,
      cancellationReason: r.cancellation_reason ?? null,
      requestedBy: r.requested_by,
      requesterName: r.requester?.full_name ?? "Staf",
      requesterUsername: r.requester?.username ?? "-",
      reviewedBy: r.reviewed_by ?? null,
      reviewerName: r.reviewer?.full_name ?? null,
      reviewedAt: r.reviewed_at ?? null,
      payoutCompletedAt: r.payout_completed_at ?? null,
      gatewayRefundId: r.gateway_refund_id ?? null,
      payoutReference: r.payout_reference ?? null,
      shiftId: r.shift_id ?? null,
      parentRefundId: r.parent_refund_id ?? null,
      evidenceCount: signedEvidence.length,
      replacementStatus: repRes.data
        ? resolveEffectiveReplacementStatus(
            repRes.data.status,
            repOrderProgress,
          )
        : null,
      replacementOrderNumber: repOrderNumber,
      createdAt: r.created_at,
      subtotalAmount: Number(r.subtotal_amount) || 0,
      discountAmount: Number(r.discount_amount) || 0,
      serviceChargeAmount: Number(r.service_charge_amount) || 0,
      taxAmount: Number(r.tax_amount) || 0,
      referenceServiceChargeAmount:
        Number(r.reference_service_charge_amount) || 0,
      referenceTaxAmount: Number(r.reference_tax_amount) || 0,
      roundingAdjustment: Number(r.rounding_adjustment) || 0,
      receiptVerified: Boolean(r.receipt_verified),
      orderPaidTotal: Number(r.orders.paid_total) || 0,
      orderRefundedTotal: Number(r.orders.refunded_total) || 0,
      orderStatus: r.orders.status,
      items: ((itemsRes.data ?? []) as RefundItem[]).map((ri) => ({
        id: ri.id,
        orderItemId: ri.order_item_id,
        productName: ri.product_name_snapshot,
        quantity: ri.quantity,
        unitPrice: ri.unit_price,
        subtotalAmount: ri.subtotal_amount,
        discountAmount: ri.discount_amount,
        orderDiscountShare: ri.order_discount_share,
        netItemAmount: ri.net_item_amount,
        serviceChargeAmount: ri.service_charge_amount,
        taxAmount: ri.tax_amount,
        referenceServiceChargeAmount: ri.reference_service_charge_amount,
        referenceTaxAmount: ri.reference_tax_amount,
        compensationSeverity: ri.compensation_severity,
        compensationPercentage: ri.compensation_percentage,
        isFullItemRefund: ri.is_full_item_refund,
        refundAmount: ri.refund_amount,
        kdsStatusSnapshot: ri.kds_status_snapshot,
        inventoryAction: ri.inventory_action,
        reason: ri.reason ?? null,
      })),
      allocations: ((allocsRes.data ?? []) as RawAllocJoin[]).map((al) => {
        const payObj = Array.isArray(al.payments)
          ? al.payments[0]
          : al.payments;
        return {
          id: al.id,
          paymentId: al.payment_id,
          paymentMethod: payObj?.payment_method ?? null,
          paymentSource: payObj?.payment_source ?? null,
          payoutMethod: al.payout_method,
          amount: al.amount,
          payoutStatus: al.payout_status,
          gatewayRefundId: al.gateway_refund_id ?? null,
          payoutReference: al.payout_reference ?? null,
          payoutCompletedAt: al.payout_completed_at ?? null,
        };
      }),
      corrections: ((corrRes.data ?? []) as RefundCorrection[]).map((c) => ({
        id: c.id,
        correctionType: c.correction_type,
        expectedAmount: c.expected_amount,
        actualAmount: c.actual_amount,
        differenceAmount: c.difference_amount,
        supplementalRefundId: c.supplemental_refund_id ?? null,
        followUpStatus: c.follow_up_status,
        followUpNotes: c.follow_up_notes ?? null,
        reason: c.reason,
        createdAt: c.created_at,
      })),
      evidence: signedEvidence,
      paymentsOnOrder: orderContextRes.ok ? orderContextRes.data.payments : [],
      openShifts: orderContextRes.ok ? orderContextRes.data.openShifts : [],
    },
  };
}

/**
 * Mengajukan komplain/refund/replacement melalui `request_order_refund_atomic`.
 * - Kasir HANYA boleh mengajukan (`pending_approval`), p_auto_approve dipaksa false.
 * - Admin dapat mengajukan sekaligus menyetujui sendiri jika p_auto_approve = true.
 */
export async function requestOrderRefundAction(
  rawInput: unknown,
): Promise<RefundActionResult<Record<string, unknown>>> {
  const actor = await getCashierActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const parsed = requestOrderRefundSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const input = parsed.data;
  const isAdmin = actor.session.profile.role === "admin";
  if (input.autoApprove && !isAdmin) {
    return {
      ok: false,
      message:
        "Akses ditolak: Kasir hanya dapat mengajukan refund (`pending_approval`) dan tidak dapat menyetujui langsung.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi database tidak tersedia." };
  }

  const rpcItems = input.items.map((it) => ({
    order_item_id: it.orderItemId,
    quantity: it.quantity,
    compensation_severity: it.compensationSeverity ?? "heavy",
    inventory_action: it.inventoryAction ?? undefined,
    reason: it.reason ?? undefined,
  }));

  const rpcAllocations =
    input.payoutAllocations && input.payoutAllocations.length > 0
      ? input.payoutAllocations.map((al) => ({
          payment_id: al.paymentId,
          amount: al.amount,
          payout_method: al.payoutMethod,
        }))
      : null;

  const { data, error } = await supabase.rpc("request_order_refund_atomic", {
    p_order_id: input.orderId,
    p_resolution_type: input.resolutionType,
    p_reason_category: input.reasonCategory,
    p_reason: input.reason,
    p_chronology: input.chronology,
    p_items: rpcItems,
    p_preferred_payout_method: input.preferredPayoutMethod ?? null,
    p_payment_id: input.paymentId ?? null,
    p_receipt_verified: input.receiptVerified,
    p_duplicate_payment_amount: input.duplicatePaymentAmount ?? null,
    p_auto_approve: isAdmin ? Boolean(input.autoApprove) : false,
    p_payout_allocations: isAdmin ? rpcAllocations : null,
    p_shift_id: isAdmin ? (input.shiftId ?? null) : null,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) {
    return { ok: false, message: formatRefundRpcError(error.message) };
  }

  revalidateRefundRelatedPaths();
  const res = (data ?? {}) as Record<string, unknown>;
  const approvedNow = res.approval_status === "approved";

  return {
    ok: true,
    message: approvedNow
      ? `Pengajuan ${String(res.refund_number ?? "")} berhasil dibuat dan disetujui Admin.`
      : `Pengajuan ${String(res.refund_number ?? "")} berhasil dikirim ke antrean persetujuan Admin.`,
    data: res,
  };
}

/**
 * Melampirkan metadata bukti foto/video yang baru diunggah kasir/admin ke private bucket
 * `refund-evidence` menggunakan `attach_refund_evidence_atomic`.
 */
export async function attachRefundEvidenceAction(
  rawInput: unknown,
): Promise<RefundActionResult<Record<string, unknown>>> {
  const actor = await getCashierActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const parsed = attachRefundEvidenceSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const input = parsed.data;
  if (!input.filePath.startsWith(`${actor.session.user.id}/`)) {
    return {
      ok: false,
      message:
        "Path bukti tidak sesuai dengan folder pemilik unggahan yang terautentikasi.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi database tidak tersedia." };
  }

  const { data, error } = await supabase.rpc("attach_refund_evidence_atomic", {
    p_refund_id: input.refundId,
    p_file_path: input.filePath,
    p_file_name: input.fileName,
    p_file_type: input.fileType,
    p_file_size: input.fileSize,
    p_notes: input.notes ?? null,
  });

  if (error) {
    return { ok: false, message: formatRefundRpcError(error.message) };
  }

  revalidateRefundRelatedPaths();
  return {
    ok: true,
    message: "Bukti komplain berhasil dilampirkan.",
    data: (data ?? {}) as Record<string, unknown>,
  };
}

/**
 * Menyetujui pengajuan refund/replacement melalui `approve_order_refund_atomic` (ADMIN ONLY).
 */
export async function approveOrderRefundAction(
  rawInput: unknown,
): Promise<RefundActionResult<Record<string, unknown>>> {
  const adminActor = await getAdminActor();
  if (!adminActor.ok) {
    return { ok: false, message: adminActor.message };
  }

  const parsed = approveOrderRefundSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi database tidak tersedia." };
  }

  const rpcAllocations =
    input.payoutAllocations && input.payoutAllocations.length > 0
      ? input.payoutAllocations.map((al) => ({
          payment_id: al.paymentId,
          amount: al.amount,
          payout_method: al.payoutMethod,
        }))
      : null;

  const { data, error } = await supabase.rpc("approve_order_refund_atomic", {
    p_refund_id: input.refundId,
    p_payout_allocations: rpcAllocations,
    p_shift_id: input.shiftId ?? null,
    p_approval_notes: input.approvalNotes ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
  });

  if (error) {
    return { ok: false, message: formatRefundRpcError(error.message) };
  }

  revalidateRefundRelatedPaths();
  const res = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    message: `Pengajuan ${String(res.refund_number ?? "")} berhasil disetujui.`,
    data: res,
  };
}

/**
 * Menolak pengajuan refund dengan alasan wajib melalui `reject_order_refund_atomic` (ADMIN ONLY).
 */
export async function rejectOrderRefundAction(
  rawInput: unknown,
): Promise<RefundActionResult<Record<string, unknown>>> {
  const adminActor = await getAdminActor();
  if (!adminActor.ok) {
    return { ok: false, message: adminActor.message };
  }

  const parsed = rejectOrderRefundSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi database tidak tersedia." };
  }

  const { data, error } = await supabase.rpc("reject_order_refund_atomic", {
    p_refund_id: parsed.data.refundId,
    p_rejection_reason: parsed.data.rejectionReason,
    p_idempotency_key: parsed.data.idempotencyKey ?? null,
  });

  if (error) {
    return { ok: false, message: formatRefundRpcError(error.message) };
  }

  revalidateRefundRelatedPaths();
  const res = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    message: `Pengajuan ${String(res.refund_number ?? "")} telah ditolak.`,
    data: res,
  };
}

/**
 * Membatalkan pengajuan refund melalui `cancel_order_refund_atomic`.
 * - Kasir hanya dapat membatalkan pengajuan `pending_approval` miliknya sendiri.
 * - Admin dapat membatalkan pengajuan `pending_approval` maupun `approved` yang belum dicairkan/dikirim Midtrans.
 */
export async function cancelOrderRefundAction(
  rawInput: unknown,
): Promise<RefundActionResult<Record<string, unknown>>> {
  const actor = await getCashierActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const parsed = cancelOrderRefundSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi database tidak tersedia." };
  }

  const { data, error } = await supabase.rpc("cancel_order_refund_atomic", {
    p_refund_id: parsed.data.refundId,
    p_cancellation_reason: parsed.data.cancellationReason,
    p_idempotency_key: parsed.data.idempotencyKey ?? null,
  });

  if (error) {
    return { ok: false, message: formatRefundRpcError(error.message) };
  }

  revalidateRefundRelatedPaths();
  const res = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    message: `Pengajuan ${String(res.refund_number ?? "")} berhasil dibatalkan.`,
    data: res,
  };
}

/**
 * Admin meminta bukti tambahan kepada kasir melalui `request_refund_evidence_atomic`.
 */
export async function requestRefundEvidenceAction(
  rawInput: unknown,
): Promise<RefundActionResult<Record<string, unknown>>> {
  const adminActor = await getAdminActor();
  if (!adminActor.ok) {
    return { ok: false, message: adminActor.message };
  }

  const parsed = requestRefundEvidenceSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi database tidak tersedia." };
  }

  const { data, error } = await supabase.rpc("request_refund_evidence_atomic", {
    p_refund_id: parsed.data.refundId,
    p_note: parsed.data.note,
  });

  if (error) {
    return { ok: false, message: formatRefundRpcError(error.message) };
  }

  revalidateRefundRelatedPaths();
  return {
    ok: true,
    message: "Permintaan bukti tambahan berhasil dikirim ke kasir pengaju.",
    data: (data ?? {}) as Record<string, unknown>,
  };
}

/**
 * Admin menyelesaikan fallback transfer bank manual untuk alokasi Midtrans yang pending/failed/reconciliation_required.
 */
export async function completeRefundManualFallbackAction(
  rawInput: unknown,
): Promise<RefundActionResult<Record<string, unknown>>> {
  const adminActor = await getAdminActor();
  if (!adminActor.ok) {
    return { ok: false, message: adminActor.message };
  }

  const parsed = completeRefundManualFallbackSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi database tidak tersedia." };
  }

  const { data, error } = await supabase.rpc(
    "complete_refund_manual_fallback_atomic",
    {
      p_refund_id: parsed.data.refundId,
      p_allocation_id: parsed.data.allocationId ?? null,
      p_payout_reference: parsed.data.payoutReference,
      p_reason: parsed.data.reason,
      p_idempotency_key: parsed.data.idempotencyKey ?? null,
    },
  );

  if (error) {
    return { ok: false, message: formatRefundRpcError(error.message) };
  }

  revalidateRefundRelatedPaths();
  return {
    ok: true,
    message:
      "Pencairan refund dengan transfer bank manual pengganti berhasil diselesaikan.",
    data: (data ?? {}) as Record<string, unknown>,
  };
}

/**
 * Admin mencatat koreksi refund (`under_refund` / `over_refund`) tanpa mengubah
 * baris refund historis yang sudah selesai melalui `record_refund_correction_atomic`.
 */
export async function recordRefundCorrectionAction(
  rawInput: unknown,
): Promise<RefundActionResult<Record<string, unknown>>> {
  const adminActor = await getAdminActor();
  if (!adminActor.ok) {
    return { ok: false, message: adminActor.message };
  }

  const parsed = recordRefundCorrectionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi database tidak tersedia." };
  }

  const { data, error } = await supabase.rpc(
    "record_refund_correction_atomic",
    {
      p_refund_id: parsed.data.refundId,
      p_expected_amount: parsed.data.expectedAmount,
      p_actual_amount: parsed.data.actualAmount,
      p_reason: parsed.data.reason,
      p_create_supplemental_refund: parsed.data.createSupplementalRefund,
      p_supplemental_method: parsed.data.supplementalMethod,
      p_shift_id: parsed.data.shiftId ?? null,
      p_follow_up_notes: parsed.data.followUpNotes ?? null,
      p_idempotency_key: parsed.data.idempotencyKey,
    },
  );

  if (error) {
    return { ok: false, message: formatRefundRpcError(error.message) };
  }

  revalidateRefundRelatedPaths();
  return {
    ok: true,
    message: "Koreksi pembukuan refund berhasil dicatat secara permanen.",
    data: (data ?? {}) as Record<string, unknown>,
  };
}
