import "server-only";

import { getMidtransConfigState } from "./config";
import { getMidtransStatus } from "./recovery";
import {
  reconcileActiveMidtransPayment,
  verifyAndReleaseGatewayBeforeOrderCancel,
} from "./reconcile";
import {
  ACTIVE_RESERVATION_LIFECYCLE_STATUSES,
  isMidtransTransactionExpired,
} from "./reservation";
import { isMidtransPaidStatus } from "./status";
import { logAudit } from "@/lib/auth/audit";
import { canCancelOrder, isOrderCancelledOrRefunded } from "@/lib/orders/status-rules";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type StaleOrderCategory =
  | "settlement_reconciled"
  | "pending_wait"
  | "terminal_safe_to_cancel"
  | "terminal_split_release_only"
  | "unexpired_404_active"
  | "unknown_or_timeout_fail_closed"
  | "no_midtrans_history_manual_review"
  | "cancelled_anomaly_repaired";

export type StaleOrderItemReport = {
  orderId: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  grandTotal: number;
  paidTotal: number;
  createdAt: string;
  category: StaleOrderCategory;
  gatewayStatuses: string[];
  activeStockReservations: number;
  reservedAllocations: number;
  mutated: boolean;
  detail: string;
};

export type StaleCleanupSummary = {
  ok: boolean;
  dryRun: boolean;
  executedAt: string;
  scannedUnpaidOrders: number;
  scannedCancelledOrders: number;
  counts: Record<StaleOrderCategory, number>;
  mutatedCancelledOrdersCount: number;
  mutatedReconciledOrdersCount: number;
  mutatedRepairedAnomaliesCount: number;
  items: StaleOrderItemReport[];
  error?: string;
};

type CleanupParams = {
  dryRun?: boolean;
  maxOrders?: number;
  actorUserId?: string | null;
  actorUsername?: string | null;
};

function emptyCounts(): Record<StaleOrderCategory, number> {
  return {
    settlement_reconciled: 0,
    pending_wait: 0,
    terminal_safe_to_cancel: 0,
    terminal_split_release_only: 0,
    unexpired_404_active: 0,
    unknown_or_timeout_fail_closed: 0,
    no_midtrans_history_manual_review: 0,
    cancelled_anomaly_repaired: 0,
  };
}

/**
 * Audits and optionally executes safe, Core-API-verified cleanup of stale unpaid orders
 * and anomalous cancelled orders across the database without ever relying on order age alone:
 * - Settlement/capture -> reconciles to `paid`, NEVER cancels.
 * - Pending -> waits / preserves reservation, NEVER auto-cancels.
 * - Unknown / timeout / challenge -> FAIL-CLOSED, preserves state for manual review.
 * - Confirmed expire/cancel/deny or expired 404 (`payment_expires_at <= now`):
 *   * If `paid_total === 0`: atomically cancels order (`cancelled`) & releases stock + allocations.
 *   * If `paid_total > 0` (split bill): releases expired Midtrans allocation without cancelling prior paid payments.
 * - Stale unpaid orders without Midtrans history -> reported ONLY for cashier/admin review.
 */
export async function runSafeStaleMidtransCleanup(
  params: CleanupParams = {},
): Promise<StaleCleanupSummary> {
  const dryRun = params.dryRun ?? true;
  const maxOrders = Math.min(200, Math.max(1, params.maxOrders ?? 50));
  const counts = emptyCounts();
  const items: StaleOrderItemReport[] = [];

  const adminClient = createSupabaseAdminClient();
  if (!adminClient) {
    return {
      ok: false,
      dryRun,
      executedAt: new Date().toISOString(),
      scannedUnpaidOrders: 0,
      scannedCancelledOrders: 0,
      counts,
      mutatedCancelledOrdersCount: 0,
      mutatedReconciledOrdersCount: 0,
      mutatedRepairedAnomaliesCount: 0,
      items,
      error: "Koneksi database admin service_role tidak tersedia.",
    };
  }

  const configState = getMidtransConfigState();
  if (!configState.enabled || !configState.ok) {
    return {
      ok: false,
      dryRun,
      executedAt: new Date().toISOString(),
      scannedUnpaidOrders: 0,
      scannedCancelledOrders: 0,
      counts,
      mutatedCancelledOrdersCount: 0,
      mutatedReconciledOrdersCount: 0,
      mutatedRepairedAnomaliesCount: 0,
      items,
      error: !configState.enabled
        ? "Integrasi Midtrans tidak aktif."
        : configState.error,
    };
  }

  // 1. Paginasi seluruh pesanan belum lunas di database
  type OrderRow = {
    id: string;
    order_number: string;
    order_type: string;
    table_id: string | null;
    dining_session_id: string | null;
    status: string;
    payment_status: string;
    grand_total: number;
    paid_total: number;
    created_at: string;
  };

  const unpaidOrders: OrderRow[] = [];
  const pageSize = 200;
  let from = 0;
  while (unpaidOrders.length < maxOrders) {
    const { data, error } = await adminClient
      .from("orders")
      .select(
        "id, order_number, order_type, table_id, dining_session_id, status, payment_status, grand_total, paid_total, created_at",
      )
      .neq("order_kind", "replacement")
      .in("status", ["awaiting_payment", "partially_paid"])
      .order("created_at", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      return {
        ok: false,
        dryRun,
        executedAt: new Date().toISOString(),
        scannedUnpaidOrders: unpaidOrders.length,
        scannedCancelledOrders: 0,
        counts,
        mutatedCancelledOrdersCount: 0,
        mutatedReconciledOrdersCount: 0,
        mutatedRepairedAnomaliesCount: 0,
        items,
        error: error.message,
      };
    }

    const batch = (data ?? []) as OrderRow[];
    if (batch.length === 0) break;
    unpaidOrders.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  const targetUnpaid = unpaidOrders.slice(0, maxOrders);
  let mutatedCancelledOrdersCount = 0;
  let mutatedReconciledOrdersCount = 0;
  let mutatedRepairedAnomaliesCount = 0;

  for (const order of targetUnpaid) {
    const [{ data: txs }, { count: activeStockCount }, { count: reservedAllocCount }] =
      await Promise.all([
        adminClient
          .from("midtrans_transactions")
          .select(
            "id, midtrans_order_id, lifecycle_status, midtrans_transaction_status, payment_expires_at, gross_amount",
          )
          .eq("order_id", order.id)
          .order("created_at", { ascending: false }),
        adminClient
          .from("ingredient_reservations")
          .select("id", { count: "exact", head: true })
          .eq("order_id", order.id)
          .eq("status", "active"),
        adminClient
          .from("order_allocations")
          .select("id", { count: "exact", head: true })
          .eq("order_id", order.id)
          .eq("allocation_status", "reserved"),
      ]);

    const txRows = (txs ?? []) as Array<{
      id: string;
      midtrans_order_id: string;
      lifecycle_status: string;
      midtrans_transaction_status: string | null;
      payment_expires_at: string;
      gross_amount: number;
    }>;
    const stockResCount = activeStockCount ?? 0;
    const allocResCount = reservedAllocCount ?? 0;

    if (txRows.length === 0) {
      counts.no_midtrans_history_manual_review += 1;
      items.push({
        orderId: order.id,
        orderNumber: order.order_number,
        status: order.status,
        paymentStatus: order.payment_status,
        grandTotal: order.grand_total,
        paidTotal: order.paid_total,
        createdAt: order.created_at,
        category: "no_midtrans_history_manual_review",
        gatewayStatuses: [],
        activeStockReservations: stockResCount,
        reservedAllocations: allocResCount,
        mutated: false,
        detail:
          "Tidak memiliki riwayat transaksi Midtrans; usia order bukan alasan batal otomatis (tinjau manual kasir/admin).",
      });
      continue;
    }

    const activeTxs = txRows.filter((tx) =>
      (ACTIVE_RESERVATION_LIFECYCLE_STATUSES as readonly string[]).includes(tx.lifecycle_status),
    );
    const hasSettledRow = txRows.some((tx) => tx.lifecycle_status === "settled");

    if (hasSettledRow) {
      let mutated = false;
      if (!dryRun) {
        const recRes = await reconcileActiveMidtransPayment({ orderId: order.id });
        mutated = Boolean(recRes.ok && recRes.isSettled);
        if (mutated) mutatedReconciledOrdersCount += 1;
      }
      counts.settlement_reconciled += 1;
      items.push({
        orderId: order.id,
        orderNumber: order.order_number,
        status: order.status,
        paymentStatus: order.payment_status,
        grandTotal: order.grand_total,
        paidTotal: order.paid_total,
        createdAt: order.created_at,
        category: "settlement_reconciled",
        gatewayStatuses: ["db:settled"],
        activeStockReservations: stockResCount,
        reservedAllocations: allocResCount,
        mutated,
        detail: dryRun
          ? "Memiliki transaksi settled lokal; perlu rekonsiliasi ke paid."
          : "Direkonsiliasi ke status pembayaran.",
      });
      continue;
    }

    // Periksa Core API untuk seluruh transaksi non-terminal secara read-only terlebih dahulu
    let foundSettlement = false;
    let foundPending = false;
    let foundPendingPastExpiry = false;
    let foundUnknownOrChallenge = false;
    let foundUnexpired404 = false;
    const gatewayStatuses: string[] = [];

    for (const tx of activeTxs) {
      if (
        tx.lifecycle_status === "capture_challenge" ||
        (tx.lifecycle_status === "reconciliation_required" &&
          tx.midtrans_transaction_status !== null)
      ) {
        foundUnknownOrChallenge = true;
        gatewayStatuses.push(`${tx.midtrans_order_id}:${tx.lifecycle_status}`);
        continue;
      }

      const check = await getMidtransStatus(tx.midtrans_order_id);
      if (!check.ok && check.httpStatus !== 404) {
        foundUnknownOrChallenge = true;
        gatewayStatuses.push(`${tx.midtrans_order_id}:error(${check.error || check.httpStatus})`);
        continue;
      }

      if (check.httpStatus === 404) {
        const expired = isMidtransTransactionExpired(tx.payment_expires_at);
        if (expired) {
          gatewayStatuses.push(`${tx.midtrans_order_id}:404_expired`);
        } else {
          foundUnexpired404 = true;
          gatewayStatuses.push(`${tx.midtrans_order_id}:404_unexpired`);
        }
        continue;
      }

      const gwStatus = (check.status?.transaction_status || "").trim().toLowerCase();
      const gwFraud = (check.status?.fraud_status || "").trim().toLowerCase();
      gatewayStatuses.push(`${tx.midtrans_order_id}:${gwStatus}`);

      if (isMidtransPaidStatus(gwStatus, gwFraud)) {
        foundSettlement = true;
      } else if (gwStatus === "pending") {
        foundPending = true;
        if (isMidtransTransactionExpired(tx.payment_expires_at)) {
          foundPendingPastExpiry = true;
        }
      } else if (!["expire", "cancel", "deny"].includes(gwStatus)) {
        foundUnknownOrChallenge = true;
      }
    }

    if (foundSettlement) {
      let mutated = false;
      if (!dryRun) {
        const recRes = await reconcileActiveMidtransPayment({ orderId: order.id });
        mutated = Boolean(recRes.ok && recRes.isSettled);
        if (mutated) mutatedReconciledOrdersCount += 1;
      }
      counts.settlement_reconciled += 1;
      items.push({
        orderId: order.id,
        orderNumber: order.order_number,
        status: order.status,
        paymentStatus: order.payment_status,
        grandTotal: order.grand_total,
        paidTotal: order.paid_total,
        createdAt: order.created_at,
        category: "settlement_reconciled",
        gatewayStatuses,
        activeStockReservations: stockResCount,
        reservedAllocations: allocResCount,
        mutated,
        detail: dryRun
          ? "Core API melaporkan settlement/capture; wajib direkonsiliasi (dilarang dibatalkan)."
          : "Pembayaran settlement telah direkonsiliasi.",
      });
      continue;
    }

    if (foundUnknownOrChallenge) {
      counts.unknown_or_timeout_fail_closed += 1;
      items.push({
        orderId: order.id,
        orderNumber: order.order_number,
        status: order.status,
        paymentStatus: order.payment_status,
        grandTotal: order.grand_total,
        paidTotal: order.paid_total,
        createdAt: order.created_at,
        category: "unknown_or_timeout_fail_closed",
        gatewayStatuses,
        activeStockReservations: stockResCount,
        reservedAllocations: allocResCount,
        mutated: false,
        detail: "Status gateway tidak diketahui/timeout/challenge (fail-closed, perlu pemeriksaan admin).",
      });
      continue;
    }

    if (foundPending) {
      counts.pending_wait += 1;
      items.push({
        orderId: order.id,
        orderNumber: order.order_number,
        status: order.status,
        paymentStatus: order.payment_status,
        grandTotal: order.grand_total,
        paidTotal: order.paid_total,
        createdAt: order.created_at,
        category: "pending_wait",
        gatewayStatuses,
        activeStockReservations: stockResCount,
        reservedAllocations: allocResCount,
        mutated: false,
        detail: foundPendingPastExpiry
          ? "Masa berlaku Snap terlewati namun Core API masih PENDING; status & reservasi dipertahankan, attempt baru diblokir sampai status terminal atau dibatalkan resmi."
          : "Transaksi Midtrans masih PENDING dalam masa berlaku; status & reservasi dipertahankan (tidak dibatalkan otomatis).",
      });
      continue;
    }

    if (foundUnexpired404) {
      counts.unexpired_404_active += 1;
      items.push({
        orderId: order.id,
        orderNumber: order.order_number,
        status: order.status,
        paymentStatus: order.payment_status,
        grandTotal: order.grand_total,
        paidTotal: order.paid_total,
        createdAt: order.created_at,
        category: "unexpired_404_active",
        gatewayStatuses,
        activeStockReservations: stockResCount,
        reservedAllocations: allocResCount,
        mutated: false,
        detail: "Token Snap masih dalam masa berlaku (belum melewati payment_expires_at).",
      });
      continue;
    }

    // Semua transaksi terkonfirmasi expire/cancel/deny/404-expired!
    if (canCancelOrder(order)) {
      let mutated = false;
      if (!dryRun) {
        const preCheck = await verifyAndReleaseGatewayBeforeOrderCancel({
          orderId: order.id,
          actorUserId: params.actorUserId ?? null,
          actorUsername: params.actorUsername ?? "system-cron",
          allowCancelPendingGateway: false,
          allowUnexpired404Release: false,
        });

        if (preCheck.ok) {
          const { count: paidSuccessCount } = await adminClient
            .from("payments")
            .select("id", { count: "exact", head: true })
            .eq("order_id", order.id)
            .eq("payment_status", "success");

          if ((paidSuccessCount ?? 0) === 0) {
            const nowIso = new Date().toISOString();
            const { data: cancelledOrder } = await adminClient
              .from("orders")
              .update({
                status: "cancelled",
                cancelled_at: nowIso,
                cancel_reason:
                  "Pembersihan otomatis transaksi Midtrans kedaluwarsa/batal",
                updated_at: nowIso,
              })
              .eq("id", order.id)
              .in("status", ["awaiting_payment", "partially_paid"])
              .eq("payment_status", "unpaid")
              .eq("paid_total", 0)
              .select("id")
              .maybeSingle();

            if (cancelledOrder) {
              await Promise.all([
                adminClient.rpc("release_order_stock_reservations_internal", {
                  p_order_id: order.id,
                }),
                adminClient
                  .from("order_allocations")
                  .update({
                    allocation_status: "released",
                    updated_at: nowIso,
                  })
                  .eq("order_id", order.id)
                  .eq("allocation_status", "reserved"),
              ]);

              if (order.order_type === "dine_in" && order.table_id) {
                const { count: remainingOpenOrders } = await adminClient
                  .from("orders")
                  .select("id", { count: "exact", head: true })
                  .neq("order_kind", "replacement")
                  .eq("table_id", order.table_id)
                  .in("status", ["awaiting_payment", "partially_paid", "paid"]);
                if ((remainingOpenOrders ?? 0) === 0) {
                  await adminClient
                    .from("dining_tables")
                    .update({ status: "available", updated_at: nowIso })
                    .eq("id", order.table_id)
                    .eq("status", "occupied");
                }
              }

              await logAudit({
                action: "midtrans.stale_order_cancelled",
                userId: params.actorUserId ?? null,
                username: params.actorUsername ?? "system-cron",
                entity: "order",
                entityId: order.id,
                details: {
                  order_number: order.order_number,
                  gateway_statuses: gatewayStatuses,
                  released_gateway_attempts: preCheck.releasedGatewayCount,
                },
              });

              mutated = true;
              mutatedCancelledOrdersCount += 1;
            }
          }
        }
      }

      counts.terminal_safe_to_cancel += 1;
      items.push({
        orderId: order.id,
        orderNumber: order.order_number,
        status: order.status,
        paymentStatus: order.payment_status,
        grandTotal: order.grand_total,
        paidTotal: order.paid_total,
        createdAt: order.created_at,
        category: "terminal_safe_to_cancel",
        gatewayStatuses:
          gatewayStatuses.length > 0
            ? gatewayStatuses
            : txRows.map((t) => `${t.midtrans_order_id}:${t.lifecycle_status}`),
        activeStockReservations: stockResCount,
        reservedAllocations: allocResCount,
        mutated,
        detail: dryRun
          ? "Seluruh transaksi Midtrans sudah berakhir (expire/cancel/deny/404-expired) dan aman dibatalkan."
          : "Order berhasil dibatalkan aman dan seluruh reservasi dilepas.",
      });
    } else {
      // paid_total > 0 (split bill sebagian dibayar): hanya lepas transaksi Midtrans yang expired
      let mutated = false;
      if (!dryRun && activeTxs.length > 0) {
        const recRes = await reconcileActiveMidtransPayment({ orderId: order.id });
        mutated = Boolean(recRes.ok && recRes.reservationReleased);
      }
      counts.terminal_split_release_only += 1;
      items.push({
        orderId: order.id,
        orderNumber: order.order_number,
        status: order.status,
        paymentStatus: order.payment_status,
        grandTotal: order.grand_total,
        paidTotal: order.paid_total,
        createdAt: order.created_at,
        category: "terminal_split_release_only",
        gatewayStatuses,
        activeStockReservations: stockResCount,
        reservedAllocations: allocResCount,
        mutated,
        detail:
          "Sebagian pembayaran sudah tercatat (split bill); hanya reservasi Midtrans kedaluwarsa yang dilepas tanpa membatalkan pembayaran sebelumnya.",
      });
    }
  }

  // 2. Sapu bersih anomali order `cancelled` yang masih menyisakan reservasi stok / alokasi aktif
  const { data: cancelledOrders } = await adminClient
    .from("orders")
    .select("id, order_number, status, payment_status, grand_total, paid_total, created_at")
    .neq("order_kind", "replacement")
    .eq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(200);

  const cancelledList = (cancelledOrders ?? []) as Array<{
    id: string;
    order_number: string;
    status: string;
    payment_status: string;
    grand_total: number;
    paid_total: number;
    created_at: string;
  }>;

  for (const cOrder of cancelledList) {
    if (!isOrderCancelledOrRefunded(cOrder)) continue;
    const [{ count: resCount }, { count: allocCount }] = await Promise.all([
      adminClient
        .from("ingredient_reservations")
        .select("id", { count: "exact", head: true })
        .eq("order_id", cOrder.id)
        .eq("status", "active"),
      adminClient
        .from("order_allocations")
        .select("id", { count: "exact", head: true })
        .eq("order_id", cOrder.id)
        .eq("allocation_status", "reserved"),
    ]);

    const activeRes = resCount ?? 0;
    const reservedAlloc = allocCount ?? 0;
    if (activeRes === 0 && reservedAlloc === 0) continue;

    let mutated = false;
    if (!dryRun) {
      const nowIso = new Date().toISOString();
      await Promise.all([
        adminClient.rpc("release_order_stock_reservations_internal", {
          p_order_id: cOrder.id,
        }),
        adminClient
          .from("order_allocations")
          .update({ allocation_status: "released", updated_at: nowIso })
          .eq("order_id", cOrder.id)
          .eq("allocation_status", "reserved"),
      ]);
      await logAudit({
        action: "midtrans.cancelled_anomaly_repaired",
        userId: params.actorUserId ?? null,
        username: params.actorUsername ?? "system-cron",
        entity: "order",
        entityId: cOrder.id,
        details: {
          order_number: cOrder.order_number,
          released_stock_reservations: activeRes,
          released_allocations: reservedAlloc,
        },
      });
      mutated = true;
      mutatedRepairedAnomaliesCount += 1;
    }

    counts.cancelled_anomaly_repaired += 1;
    items.push({
      orderId: cOrder.id,
      orderNumber: cOrder.order_number,
      status: cOrder.status,
      paymentStatus: cOrder.payment_status,
      grandTotal: cOrder.grand_total,
      paidTotal: cOrder.paid_total,
      createdAt: cOrder.created_at,
      category: "cancelled_anomaly_repaired",
      gatewayStatuses: [],
      activeStockReservations: activeRes,
      reservedAllocations: reservedAlloc,
      mutated,
      detail: dryRun
        ? "Order cancelled masih menyisakan reservasi aktif yang perlu dilepas."
        : "Reservasi tersisa pada order cancelled berhasil dilepas secara idempoten.",
    });
  }

  return {
    ok: true,
    dryRun,
    executedAt: new Date().toISOString(),
    scannedUnpaidOrders: targetUnpaid.length,
    scannedCancelledOrders: cancelledList.length,
    counts,
    mutatedCancelledOrdersCount,
    mutatedReconciledOrdersCount,
    mutatedRepairedAnomaliesCount,
    items,
  };
}
