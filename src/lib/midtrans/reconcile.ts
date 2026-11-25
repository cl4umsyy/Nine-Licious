import "server-only";

import { getMidtransConfigState } from "./config";
import {
  cancelMidtransTransaction,
  getMidtransStatus,
  type MidtransStatusResponse,
} from "./recovery";
import { isMidtransTransactionExpired } from "./reservation";
import { parseMidtransGrossAmount } from "./signature";
import { isMidtransPaidStatus } from "./status";
import {
  settleVerifiedMidtransStatus,
  type MidtransStatusSettlementPayload,
} from "./webhook";
import { logAudit } from "@/lib/auth/audit";
import { canCancelOrder } from "@/lib/orders/status-rules";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { MidtransLifecycleStatus } from "@/types/database";

export type ReconcileOrderResult = {
  ok: boolean;
  isSettled: boolean;
  reconciliationFlagged?: boolean;
  reservationReleased?: boolean;
  midtransStatus?: string;
  statusCode?: string;
  orderNumber?: string;
  error?: string;
  message?: string;
};

export type ReconcileActiveMidtransParams = {
  orderId: string;
};

type MidtransTxRow = {
  id: string;
  midtrans_order_id: string;
  attempt_number: number | null;
  gross_amount: number;
  lifecycle_status: MidtransLifecycleStatus;
  midtrans_transaction_status: string | null;
  snap_token: string | null;
  snap_redirect_url: string | null;
  payment_expires_at: string;
  sanitized_response: unknown;
  created_at: string;
};

const NON_TERMINAL_GATEWAY_STATUSES = [
  "initiated",
  "token_created",
  "pending",
  "capture_challenge",
  "reconciliation_required",
] as const;

const TERMINAL_GATEWAY_STATUSES = [
  "expired",
  "cancelled",
  "denied",
  "pre_request_aborted",
] as const;

const RECOVERABLE_UNSETTLED_STATUSES = [
  "initiated",
  "token_created",
  "pending",
] as const;

function isQuarantinedReconciliationRow(tx: MidtransTxRow): boolean {
  if (tx.lifecycle_status === "capture_challenge") return true;
  if (tx.lifecycle_status !== "reconciliation_required") return false;
  // If Core API timeout happened during createSnapPayment, midtrans_transaction_status is null.
  // Any populated gateway status or amount anomaly must stay quarantined for admin review.
  return tx.midtrans_transaction_status !== null;
}

type ValidatedGatewayStatus =
  | {
      ok: true;
      rawStatus: string;
      fraudStatus: string;
      statusCode: string;
      isPaid: boolean;
      sanitizedFields: Record<string, unknown>;
      verifiedPayload: MidtransStatusSettlementPayload;
    }
  | {
      ok: false;
      error: string;
    };

function validateMidtransCoreResponse(
  midtransData: MidtransStatusResponse,
  tx: MidtransTxRow,
): ValidatedGatewayStatus {
  const midtransOrderId = tx.midtrans_order_id;

  if (midtransData.order_id !== midtransOrderId) {
    return {
      ok: false,
      error: `Order ID Midtrans tidak cocok: diharapkan ${midtransOrderId}, diterima ${midtransData.order_id}.`,
    };
  }

  const reportedGrossNumeric = parseMidtransGrossAmount(midtransData.gross_amount);
  if (
    reportedGrossNumeric === null ||
    reportedGrossNumeric !== Number(tx.gross_amount)
  ) {
    return {
      ok: false,
      error: `Nominal transaksi Midtrans (${midtransData.gross_amount}) tidak cocok dengan tagihan lokal (${tx.gross_amount}).`,
    };
  }

  const reportedCurrency =
    typeof midtransData.currency === "string"
      ? midtransData.currency.trim().toUpperCase()
      : "IDR";
  if (reportedCurrency !== "IDR") {
    return {
      ok: false,
      error: `Mata uang tidak didukung: ${reportedCurrency}.`,
    };
  }

  const statusCode =
    typeof midtransData.status_code === "string"
      ? midtransData.status_code.trim()
      : "";
  if (!statusCode) {
    return {
      ok: false,
      error: "Respons status Midtrans tidak memiliki status_code yang valid.",
    };
  }

  const rawStatus = (midtransData.transaction_status || "").trim().toLowerCase();
  const fraudStatus = (midtransData.fraud_status || "").trim().toLowerCase();

  if (rawStatus === "settlement" && fraudStatus && fraudStatus !== "accept") {
    return {
      ok: false,
      error: `Status fraud transaksi Midtrans (${fraudStatus}) tidak valid untuk settlement.`,
    };
  }

  const transactionId =
    typeof midtransData.transaction_id === "string"
      ? midtransData.transaction_id.trim()
      : "";
  const isPaid = isMidtransPaidStatus(rawStatus, fraudStatus);

  if (isPaid && !transactionId) {
    return {
      ok: false,
      error: "Respons status Midtrans tidak memiliki transaction_id yang valid.",
    };
  }

  const existingTxId =
    typeof tx.sanitized_response === "object" &&
    tx.sanitized_response !== null &&
    "transaction_id" in tx.sanitized_response &&
    typeof (tx.sanitized_response as { transaction_id?: unknown }).transaction_id === "string"
      ? (tx.sanitized_response as { transaction_id: string }).transaction_id.trim()
      : null;

  if (existingTxId && transactionId && existingTxId !== transactionId) {
    return {
      ok: false,
      error: `Transaction ID Midtrans (${transactionId}) tidak cocok dengan catatan lokal (${existingTxId}).`,
    };
  }

  const sanitizedFields = Object.fromEntries(
    Object.entries(midtransData).filter(([k]) => k !== "signature_key"),
  );

  const verifiedPayload: MidtransStatusSettlementPayload = {
    ...sanitizedFields,
    order_id: midtransOrderId,
    status_code: statusCode,
    gross_amount: midtransData.gross_amount,
    transaction_status: rawStatus,
    fraud_status: fraudStatus,
    currency: reportedCurrency,
    transaction_id: transactionId,
    payment_type: midtransData.payment_type,
  };

  return {
    ok: true,
    rawStatus,
    fraudStatus,
    statusCode,
    isPaid,
    sanitizedFields,
    verifiedPayload,
  };
}

/**
 * Releases any orphaned `order_allocations` rows stuck in `reserved` status when
 * their parent `midtrans_transactions` row is already terminal.
 */
async function releaseOrphanedTerminalAllocations(
  adminClient: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  orderId: string,
  allTxs: MidtransTxRow[],
): Promise<boolean> {
  const terminalIds = allTxs
    .filter((tx) => (TERMINAL_GATEWAY_STATUSES as readonly string[]).includes(tx.lifecycle_status))
    .map((tx) => tx.id);

  if (terminalIds.length === 0) return false;

  const { data: released } = await adminClient
    .from("order_allocations")
    .update({
      allocation_status: "released",
      updated_at: new Date().toISOString(),
    })
    .eq("order_id", orderId)
    .eq("allocation_status", "reserved")
    .in("midtrans_transaction_id", terminalIds)
    .select("id");

  return Boolean(released && released.length > 0);
}

async function releaseExpired404Transaction(params: {
  adminClient: NonNullable<ReturnType<typeof createSupabaseAdminClient>>;
  tx: MidtransTxRow;
  orderId: string;
  orderNumber: string;
  actorUserId?: string | null;
  actorUsername?: string | null;
  reason: string;
  nextLifecycle?: "expired" | "cancelled";
}): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const nextLifecycle = params.nextLifecycle ?? "expired";
  const nextRaw = nextLifecycle === "expired" ? "expire" : "cancel";

  const { data: updatedTx } = await params.adminClient
    .from("midtrans_transactions")
    .update({
      lifecycle_status: nextLifecycle,
      midtrans_transaction_status: nextRaw,
      updated_at: nowIso,
    })
    .eq("id", params.tx.id)
    .in("lifecycle_status", ["initiated", "token_created", "pending", "reconciliation_required"])
    .select("id")
    .maybeSingle();

  if (!updatedTx) return false;

  await params.adminClient
    .from("order_allocations")
    .update({
      allocation_status: "released",
      updated_at: nowIso,
    })
    .eq("midtrans_transaction_id", updatedTx.id)
    .eq("allocation_status", "reserved");

  await logAudit({
    action: nextLifecycle === "expired" ? "midtrans.reservation_expired" : "midtrans.reservation_cancelled",
    userId: params.actorUserId ?? null,
    username: params.actorUsername ?? null,
    entity: "order",
    entityId: params.orderId,
    details: {
      order_number: params.orderNumber,
      midtrans_order_id: params.tx.midtrans_order_id,
      gross_amount: params.tx.gross_amount,
      reason: params.reason,
    },
  });

  return true;
}

/**
 * Melakukan rekonsiliasi aktif status transaksi Midtrans langsung ke Midtrans Core API
 * (`GET /v2/{order_id}/status`) untuk SELURUH attempt belum terminal pada pesanan ini.
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

  if (
    order.status === "paid" ||
    order.status === "completed" ||
    order.payment_status === "paid"
  ) {
    return {
      ok: true,
      isSettled: true,
      orderNumber: order.order_number,
      message: "Pesanan sudah berstatus lunas di database.",
    };
  }

  // Ambil SELURUH attempt Midtrans milik pesanan (bukan hanya 1 row terbaru)
  const { data: allTxRows, error: txErr } = await adminClient
    .from("midtrans_transactions")
    .select(
      "id, midtrans_order_id, attempt_number, gross_amount, lifecycle_status, midtrans_transaction_status, snap_token, snap_redirect_url, payment_expires_at, sanitized_response, created_at",
    )
    .eq("order_id", orderId)
    .order("attempt_number", { ascending: false })
    .order("created_at", { ascending: false });

  const allTxs = (allTxRows ?? []) as MidtransTxRow[];

  if (txErr || allTxs.length === 0) {
    return {
      ok: true,
      isSettled: false,
      orderNumber: order.order_number,
      midtransStatus: "uncreated",
      message: "Belum ada transaksi Midtrans yang dibuat untuk pesanan ini.",
    };
  }

  // Bersihkan orphaned allocations jika ada transaksi terminal yang masih menyisakan alokasi reserved
  const cleanedOrphans = await releaseOrphanedTerminalAllocations(adminClient, orderId, allTxs);

  const nonTerminalTxs = allTxs.filter(
    (tx) =>
      tx.midtrans_order_id &&
      (NON_TERMINAL_GATEWAY_STATUSES as readonly string[]).includes(tx.lifecycle_status) &&
      !isQuarantinedReconciliationRow(tx),
  );

  const quarantinedTxs = allTxs.filter((tx) => isQuarantinedReconciliationRow(tx));

  if (nonTerminalTxs.length === 0) {
    if (quarantinedTxs.length > 0) {
      return {
        ok: true,
        isSettled: false,
        reconciliationFlagged: true,
        orderNumber: order.order_number,
        midtransStatus: quarantinedTxs[0].lifecycle_status,
        message:
          "Pesanan memiliki transaksi Midtrans dalam karantina evaluasi/rekonsiliasi admin.",
      };
    }

    const latest = allTxs[0];
    return {
      ok: true,
      isSettled: false,
      reservationReleased: cleanedOrphans,
      orderNumber: order.order_number,
      midtransStatus: latest.lifecycle_status,
      message: `Transaksi Midtrans sebelumnya berstatus ${latest.lifecycle_status}.`,
    };
  }

  let hasPendingAttempt = false;
  let pendingStatusCode: string | undefined;
  let hasActiveUnexpired404 = false;
  let releasedAny = cleanedOrphans;
  let lastTerminalRawStatus: string | undefined;
  let lastTerminalStatusCode: string | undefined;
  let lastError: string | undefined;

  // Evaluasi SELURUH attempt non-terminal agar tidak ada settlement pada attempt lama yang terlewat
  for (const tx of nonTerminalTxs) {
    const statusCheck = await getMidtransStatus(tx.midtrans_order_id);

    if (!statusCheck.ok) {
      if (statusCheck.httpStatus === 404) {
        const expired = isMidtransTransactionExpired(tx.payment_expires_at);
        if (expired || order.status === "cancelled" || order.status === "refunded") {
          const released = await releaseExpired404Transaction({
            adminClient,
            tx,
            orderId: order.id,
            orderNumber: order.order_number,
            nextLifecycle: expired ? "expired" : "cancelled",
            reason:
              order.status === "cancelled"
                ? "reconcile_cancelled_order_404_cleanup"
                : "reconcile_expired_snap_404_released",
          });
          if (released) {
            releasedAny = true;
            lastTerminalRawStatus = expired ? "expire" : "cancel";
          }
        } else {
          hasActiveUnexpired404 = true;
        }
        continue;
      }

      lastError = statusCheck.error || "Gagal menghubungi API status Midtrans.";
      continue;
    }

    const midtransData = statusCheck.status;
    if (!midtransData) {
      lastError = "Respons status Midtrans tidak memiliki payload transaksi.";
      continue;
    }

    const validated = validateMidtransCoreResponse(midtransData, tx);
    if (!validated.ok) {
      lastError = validated.error;
      continue;
    }

    // 1. Jika ditemukan settlement / capture+accept: proses segera (atau flag jika order cancelled)
    if (validated.isPaid) {
      const settleResult = await settleVerifiedMidtransStatus(validated.verifiedPayload);

      if (settleResult.processingResult === "reconciliation_flagged") {
        return {
          ok: true,
          isSettled: false,
          reconciliationFlagged: true,
          orderNumber: order.order_number,
          midtransStatus: validated.rawStatus,
          statusCode: validated.statusCode,
          message:
            order.status === "cancelled"
              ? "Pesanan berstatus DIBATALKAN dan tidak dapat diaktifkan kembali. Pembayaran settlement dari Midtrans telah ditandai untuk rekonsiliasi/refund manual admin."
              : "Transaksi Midtrans terdeteksi namun memerlukan rekonsiliasi manual admin.",
        };
      }

      if (!settleResult.ok && settleResult.processingResult === "failed") {
        return {
          ok: false,
          isSettled: false,
          orderNumber: order.order_number,
          midtransStatus: validated.rawStatus,
          error:
            settleResult.error ||
            "Gagal memproses settlement pembayaran ke database.",
        };
      }

      const [{ data: refreshedOrder }, { data: refreshedTx }] = await Promise.all([
        adminClient
          .from("orders")
          .select("status, payment_status, paid_total")
          .eq("id", orderId)
          .maybeSingle(),
        adminClient
          .from("midtrans_transactions")
          .select("lifecycle_status")
          .eq("id", tx.id)
          .maybeSingle(),
      ]);

      if (refreshedOrder?.status === "cancelled") {
        return {
          ok: true,
          isSettled: false,
          reconciliationFlagged: true,
          orderNumber: order.order_number,
          midtransStatus: validated.rawStatus,
          statusCode: validated.statusCode,
          message:
            "Pesanan berstatus DIBATALKAN. Pembayaran tidak dapat mengaktifkan pesanan kembali; ditandai untuk rekonsiliasi admin.",
        };
      }

      const isOrderFullySettled = Boolean(
        (refreshedOrder?.payment_status === "paid" ||
          refreshedOrder?.status === "paid") &&
          Number(refreshedOrder?.paid_total) >= Number(order.grand_total),
      );
      const isTxSettled = refreshedTx?.lifecycle_status === "settled";

      return {
        ok: true,
        isSettled: isOrderFullySettled,
        orderNumber: order.order_number,
        midtransStatus: validated.rawStatus,
        statusCode: validated.statusCode,
        message: isOrderFullySettled
          ? "Pembayaran Midtrans berhasil diverifikasi dan pesanan telah lunas."
          : isTxSettled
            ? "Pembayaran bagian Midtrans berhasil diverifikasi (split bill tercatat)."
            : "Pembayaran terverifikasi di Midtrans, menunggu pembaruan database.",
      };
    }

    // 2. Status terminal gagal (expire / cancel / deny)
    if (["expire", "cancel", "deny"].includes(validated.rawStatus)) {
      const terminalResult = await settleVerifiedMidtransStatus(validated.verifiedPayload);
      if (!terminalResult.ok && terminalResult.processingResult === "failed") {
        lastError =
          terminalResult.error ||
          `Gagal mencatat status terminal Midtrans (${validated.rawStatus}).`;
        continue;
      }
      releasedAny = true;
      lastTerminalRawStatus = validated.rawStatus;
      lastTerminalStatusCode = validated.statusCode;
      continue;
    }

    // 3. Status pending -> pertahankan reservasi & status lokal
    if (validated.rawStatus === "pending") {
      hasPendingAttempt = true;
      pendingStatusCode = validated.statusCode;
      await adminClient
        .from("midtrans_transactions")
        .update({
          lifecycle_status: "pending",
          midtrans_transaction_status: "pending",
          sanitized_response: validated.sanitizedFields,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tx.id);
      continue;
    }

    // 4. Status lain (mis. capture challenge)
    if (validated.rawStatus === "capture") {
      await adminClient
        .from("midtrans_transactions")
        .update({
          lifecycle_status: "capture_challenge",
          midtrans_transaction_status: "capture",
          sanitized_response: validated.sanitizedFields,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tx.id);
    }
  }

  if (hasPendingAttempt) {
    return {
      ok: true,
      isSettled: false,
      orderNumber: order.order_number,
      midtransStatus: "pending",
      statusCode: pendingStatusCode,
      message: "Pembayaran masih menunggu penyelesaian dari pelanggan.",
    };
  }

  if (lastError) {
    return {
      ok: false,
      isSettled: false,
      orderNumber: order.order_number,
      error: lastError,
    };
  }

  if (hasActiveUnexpired404) {
    return {
      ok: true,
      isSettled: false,
      reservationReleased: releasedAny,
      orderNumber: order.order_number,
      midtransStatus: "uncreated_or_pending",
      message:
        "Transaksi belum dipilih metode pembayarannya di Snap. Menunggu pelanggan menyelesaikan atau batalkan untuk pindah ke Tunai.",
    };
  }

  if (releasedAny) {
    return {
      ok: true,
      isSettled: false,
      reservationReleased: true,
      orderNumber: order.order_number,
      midtransStatus: lastTerminalRawStatus ?? "expire",
      statusCode: lastTerminalStatusCode,
      message: `Transaksi Midtrans telah berakhir (${lastTerminalRawStatus ?? "expire"}) dan reservasi dilepas.`,
    };
  }

  return {
    ok: true,
    isSettled: false,
    orderNumber: order.order_number,
    midtransStatus: quarantinedTxs[0]?.lifecycle_status ?? "unknown",
    message: "Pemeriksaan status Midtrans selesai.",
  };
}

export type GatewayPreCancelVerificationResult =
  | {
      ok: true;
      message: string;
      releasedGatewayCount: number;
    }
  | {
      ok: false;
      blockedBySettlement?: boolean;
      blockedByPending?: boolean;
      pendingMidtransOrderIds?: string[];
      requiresAdminReconciliation?: boolean;
      isGatewayUnreachable?: boolean;
      message: string;
    };

/**
 * Verifies and safely clears all gateway Midtrans attempts before cancelling an unpaid order:
 * - Refuses cancellation immediately if order is not cancellable (`canCancelOrder`) or has payments.
 * - Verifies EVERY non-terminal Midtrans attempt in Phase 1 before mutating anything (fail-closed):
 *   * settlement/capture+accept -> BLOCKS cancel, reconciles payment, keeps order paid!
 *   * timeout/API error -> FAILS-CLOSED, preserves order, gateway rows & stock reservations.
 *   * pending -> if `allowCancelPendingGateway` is false, blocks & keeps pending (`blockedByPending: true`);
 *     if `allowCancelPendingGateway` is true, calls `POST /v2/{id}/cancel` and proceeds only if confirmed `cancel`.
 *   * expire/cancel/deny or expired-404 (or unstarted 404 when `allowUnexpired404Release !== false`) -> updates terminal state & releases allocations cleanly with audit log.
 */
export async function verifyAndReleaseGatewayBeforeOrderCancel(params: {
  orderId: string;
  actorUserId?: string | null;
  actorUsername?: string | null;
  allowCancelPendingGateway?: boolean;
  allowUnexpired404Release?: boolean;
}): Promise<GatewayPreCancelVerificationResult> {
  const allowCancelPendingGateway = params.allowCancelPendingGateway ?? true;
  const allowUnexpired404Release = params.allowUnexpired404Release ?? true;

  const adminClient = createSupabaseAdminClient();
  if (!adminClient) {
    return {
      ok: false,
      message: "Koneksi database admin tidak tersedia untuk verifikasi gateway sebelum pembatalan.",
    };
  }

  const { data: order, error: orderErr } = await adminClient
    .from("orders")
    .select("id, order_number, status, payment_status, paid_total, grand_total")
    .eq("id", params.orderId)
    .maybeSingle();

  if (orderErr || !order) {
    return { ok: false, message: "Pesanan tidak ditemukan di database." };
  }

  if (order.status === "cancelled") {
    await adminClient
      .from("order_allocations")
      .update({
        allocation_status: "released",
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", order.id)
      .eq("allocation_status", "reserved");
    return { ok: true, message: "Pesanan sudah berstatus dibatalkan.", releasedGatewayCount: 0 };
  }

  if (!canCancelOrder(order)) {
    return {
      ok: false,
      message: `Pesanan #${order.order_number} berstatus ${order.status} (${order.payment_status}) dan tidak dapat dibatalkan.`,
    };
  }

  const { data: existingPayments } = await adminClient
    .from("payments")
    .select("id")
    .eq("order_id", order.id)
    .eq("payment_status", "success")
    .limit(1);

  if (existingPayments && existingPayments.length > 0) {
    return {
      ok: false,
      message: `Pesanan #${order.order_number} sudah memiliki catatan pembayaran sukses dan harus melalui alur Refund Admin.`,
    };
  }

  const { data: txRows } = await adminClient
    .from("midtrans_transactions")
    .select(
      "id, midtrans_order_id, attempt_number, gross_amount, lifecycle_status, midtrans_transaction_status, snap_token, snap_redirect_url, payment_expires_at, sanitized_response, created_at",
    )
    .eq("order_id", order.id)
    .order("attempt_number", { ascending: false })
    .order("created_at", { ascending: false });

  const allTxs = (txRows ?? []) as MidtransTxRow[];

  if (allTxs.some((tx) => tx.lifecycle_status === "settled")) {
    await reconcileActiveMidtransPayment({ orderId: order.id });
    return {
      ok: false,
      blockedBySettlement: true,
      message: `Pembatalan ditolak: Pesanan #${order.order_number} memiliki transaksi Midtrans yang sudah settled.`,
    };
  }

  await releaseOrphanedTerminalAllocations(adminClient, order.id, allTxs);

  const activeTxs = allTxs.filter((tx) =>
    (NON_TERMINAL_GATEWAY_STATUSES as readonly string[]).includes(tx.lifecycle_status),
  );

  if (activeTxs.some((tx) => isQuarantinedReconciliationRow(tx))) {
    return {
      ok: false,
      requiresAdminReconciliation: true,
      message: `Pembatalan ditolak: Pesanan #${order.order_number} memiliki transaksi gateway yang memerlukan evaluasi rekonsiliasi admin terlebih dahulu.`,
    };
  }

  type PlannedTxAction =
    | { kind: "404"; tx: MidtransTxRow; expired: boolean }
    | { kind: "pending"; tx: MidtransTxRow }
    | { kind: "terminal"; tx: MidtransTxRow; validated: Extract<ValidatedGatewayStatus, { ok: true }> };

  const planned: PlannedTxAction[] = [];

  // Phase 1: Verifikasi seluruh attempt aktif ke Midtrans Core API sebelum mutasi apa pun (fail-closed)
  for (const tx of activeTxs) {
    if (
      !(RECOVERABLE_UNSETTLED_STATUSES as readonly string[]).includes(tx.lifecycle_status) &&
      tx.lifecycle_status !== "reconciliation_required"
    ) {
      continue;
    }

    const statusCheck = await getMidtransStatus(tx.midtrans_order_id);

    if (!statusCheck.ok && statusCheck.httpStatus !== 404) {
      return {
        ok: false,
        isGatewayUnreachable: true,
        message: `Gagal memverifikasi status Midtrans (${tx.midtrans_order_id}): ${statusCheck.error || "Gangguan API"}. Pembatalan dibatalkan demi keamanan (fail-closed).`,
      };
    }

    if (statusCheck.httpStatus === 404) {
      const expired = isMidtransTransactionExpired(tx.payment_expires_at);
      if (!allowUnexpired404Release && !expired) {
        return {
          ok: false,
          message: `Token Snap (${tx.midtrans_order_id}) belum melewati batas kedaluwarsa dan belum berstatus terminal di Midtrans.`,
        };
      }
      planned.push({ kind: "404", tx, expired });
      continue;
    }

    const midtransData = statusCheck.status;
    if (!midtransData) {
      return {
        ok: false,
        isGatewayUnreachable: true,
        message: `Respons status Midtrans (${tx.midtrans_order_id}) kosong. Pembatalan ditolak demi keamanan.`,
      };
    }

    const validated = validateMidtransCoreResponse(midtransData, tx);
    if (!validated.ok) {
      return {
        ok: false,
        requiresAdminReconciliation: true,
        message: `Validasi status Midtrans (${tx.midtrans_order_id}) gagal: ${validated.error}`,
      };
    }

    if (validated.isPaid) {
      await reconcileActiveMidtransPayment({ orderId: order.id });
      return {
        ok: false,
        blockedBySettlement: true,
        message: `Pembatalan ditolak: Transaksi Midtrans ${tx.midtrans_order_id} SUDAH LUNAS (settlement/capture). Pembayaran telah disinkronkan ke sistem.`,
      };
    }

    if (validated.rawStatus === "capture") {
      await adminClient
        .from("midtrans_transactions")
        .update({
          lifecycle_status: "capture_challenge",
          midtrans_transaction_status: "capture",
          sanitized_response: validated.sanitizedFields,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tx.id);

      return {
        ok: false,
        requiresAdminReconciliation: true,
        message: `Pembatalan ditolak: Transaksi Midtrans ${tx.midtrans_order_id} sedang dalam tinjauan fraud (challenge).`,
      };
    }

    if (validated.rawStatus === "pending") {
      planned.push({ kind: "pending", tx });
      continue;
    }

    if (["expire", "cancel", "deny"].includes(validated.rawStatus)) {
      planned.push({ kind: "terminal", tx, validated });
      continue;
    }

    return {
      ok: false,
      requiresAdminReconciliation: true,
      message: `Status transaksi Midtrans (${tx.midtrans_order_id}: ${validated.rawStatus}) tidak mengizinkan pembatalan otomatis.`,
    };
  }

  const pendingPlans = planned.filter(
    (p): p is Extract<PlannedTxAction, { kind: "pending" }> => p.kind === "pending",
  );

  if (pendingPlans.length > 0 && !allowCancelPendingGateway) {
    const pendingIds = pendingPlans.map((p) => p.tx.midtrans_order_id);
    return {
      ok: false,
      blockedByPending: true,
      pendingMidtransOrderIds: pendingIds,
      message: `Transaksi Midtrans (${pendingIds.join(", ")}) masih berstatus PENDING di gateway (menunggu pelanggan). Jangan menganggap pembayaran batal sebelum kedaluwarsa atau dibatalkan resmi di Midtrans.`,
    };
  }

  // Phase 2: Eksekusi pembatalan / pelepasan yang telah terkonfirmasi aman
  let releasedCount = 0;

  for (const plan of planned) {
    if (plan.kind === "404") {
      const released = await releaseExpired404Transaction({
        adminClient,
        tx: plan.tx,
        orderId: order.id,
        orderNumber: order.order_number,
        actorUserId: params.actorUserId ?? null,
        actorUsername: params.actorUsername ?? null,
        nextLifecycle: plan.expired ? "expired" : "cancelled",
        reason: plan.expired
          ? "order_cancel_expired_snap_404_released"
          : "order_cancel_unstarted_snap_404_released",
      });
      if (released) releasedCount += 1;
    } else if (plan.kind === "pending") {
      const cancelRes = await cancelMidtransTransaction(plan.tx.midtrans_order_id);
      if (!cancelRes.ok || !cancelRes.isCancelled) {
        const recAfterCancelFail = await reconcileActiveMidtransPayment({ orderId: order.id });
        if (recAfterCancelFail.isSettled) {
          return {
            ok: false,
            blockedBySettlement: true,
            message: `Pembatalan dihentikan: Transaksi Midtrans ${plan.tx.midtrans_order_id} ternyata sudah LUNAS (settlement). Pembayaran telah disinkronkan.`,
          };
        }
        return {
          ok: false,
          isGatewayUnreachable: !cancelRes.httpStatus,
          message:
            cancelRes.error ||
            `Midtrans menolak pembatalan transaksi pending ${plan.tx.midtrans_order_id}. Pembatalan pesanan dibatalkan (fail-closed).`,
        };
      }

      await logAudit({
        action: "midtrans.reservation_cancelled",
        userId: params.actorUserId ?? null,
        username: params.actorUsername ?? null,
        entity: "order",
        entityId: order.id,
        details: {
          order_number: order.order_number,
          midtrans_order_id: plan.tx.midtrans_order_id,
          gross_amount: plan.tx.gross_amount,
          reason: "order_cancel_pending_gateway_confirmed",
        },
      });
      releasedCount += 1;
    } else if (plan.kind === "terminal") {
      const terminalRes = await settleVerifiedMidtransStatus(plan.validated.verifiedPayload);
      if (!terminalRes.ok && terminalRes.processingResult === "failed") {
        return {
          ok: false,
          message:
            terminalRes.error ||
            `Gagal menyimpan status terminal Midtrans (${plan.validated.rawStatus}) untuk ${plan.tx.midtrans_order_id}.`,
        };
      }
      releasedCount += 1;
    }
  }

  // Final idempotent cleanup of any residual reserved allocations on this cancelled order
  await adminClient
    .from("order_allocations")
    .update({
      allocation_status: "released",
      updated_at: new Date().toISOString(),
    })
    .eq("order_id", order.id)
    .eq("allocation_status", "reserved");

  return {
    ok: true,
    message: "Seluruh transaksi gateway telah diverifikasi dan dilepas sebelum pembatalan pesanan.",
    releasedGatewayCount: releasedCount,
  };
}
