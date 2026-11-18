import type {
  DiningSessionOrderSummary,
  DiningSessionSummary,
} from "@/lib/orders/types";

export type SessionClosureEvaluation = {
  canClose: boolean;
  blockingReason: string | null;
  /**
   * Pesanan lunas (status='paid', payment_status='paid') yang dapat otomatis
   * diselesaikan melalui complete_pos_order sebelum close_dining_session_atomic.
   */
  paidOrdersToComplete: DiningSessionOrderSummary[];
  /**
   * Pesanan lunas yang mendapat refund sebagian (status='paid',
   * payment_status='partially_refunded', paid_total >= grand_total).
   */
  partiallyRefundedPaidOrdersToComplete: DiningSessionOrderSummary[];
  /**
   * Pesanan berstatus 'completed' yang masih memiliki kds_status aktif.
   */
  completedOrdersWithActiveKds: DiningSessionOrderSummary[];
};

const ACTIVE_KDS_STATUSES = new Set(["queued", "preparing", "ready"]);
const TERMINAL_CLOSED_ORDER_STATUSES = new Set(["cancelled", "refunded"]);
const UNPAID_ORDER_STATUSES = new Set(["awaiting_payment", "partially_paid"]);
const UNPAID_PAYMENT_STATUSES = new Set(["unpaid", "partially_paid"]);

/**
 * Format UUID sesi kunjungan menjadi nomor sesi ringkas yang mudah dibaca kasir.
 */
export function formatSessionCode(sessionId?: string | null): string {
  if (!sessionId) return "-";
  const clean = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
  return clean ? `SES-${clean}` : "-";
}

/**
 * Mengevaluasi kelayakan penutupan sesi meja secara ketat berdasarkan
 * seluruh pesanan, pembayaran, split bill, gateway Midtrans, dan refund.
 *
 * Aturan utama:
 * 1. Sesi harus aktif (has_active_session === true & session_status !== 'closed').
 * 2. Tidak boleh ada pesanan berstatus awaiting_payment / partially_paid.
 * 3. Tidak boleh ada pesanan aktif dengan payment_status unpaid / partially_paid
 *    atau sisa tagihan (grand_total - paid_total) > 0 — termasuk jika ada refund.
 * 4. Total sisa tagihan sesi harus 0.
 * 5. Tidak boleh ada alokasi split bill berstatus reserved.
 * 6. Tidak boleh ada transaksi Midtrans non-terminal atau webhook sedang diproses.
 * 7. Tidak boleh ada permohonan refund berstatus pending.
 * 8. Pesanan yang seluruh tagihannya sudah lunas (status='paid', remaining=0)
 *    diperbolehkan untuk otomatis ditandai 'completed' saat kasir menutup sesi meja.
 */
export function evaluateDiningSessionClosure(
  summary: DiningSessionSummary,
): SessionClosureEvaluation {
  const emptyResult: SessionClosureEvaluation = {
    canClose: false,
    blockingReason: null,
    paidOrdersToComplete: [],
    partiallyRefundedPaidOrdersToComplete: [],
    completedOrdersWithActiveKds: [],
  };

  if (!summary.has_active_session || !summary.session_id) {
    return {
      ...emptyResult,
      blockingReason: "Meja tidak memiliki sesi kunjungan aktif.",
    };
  }

  if (summary.session_status && summary.session_status !== "open") {
    return {
      ...emptyResult,
      blockingReason: `Sesi kunjungan sudah ditutup (status: ${summary.session_status}).`,
    };
  }

  const orders = Array.isArray(summary.orders) ? summary.orders : [];

  // 1. Cek pesanan belum lunas (awaiting_payment / partially_paid)
  const unpaidOrders = orders.filter((o) => {
    if (TERMINAL_CLOSED_ORDER_STATUSES.has(o.status)) return false;
    const grandTotal = Number(o.grand_total) || 0;
    const paidTotal = Number(o.paid_total) || 0;
    const remaining = Math.max(0, grandTotal - paidTotal);
    return (
      UNPAID_ORDER_STATUSES.has(o.status) ||
      UNPAID_PAYMENT_STATUSES.has(o.payment_status) ||
      remaining > 0
    );
  });

  if ((summary.unpaid_orders_count ?? 0) > 0 || unpaidOrders.length > 0) {
    const count = Math.max(summary.unpaid_orders_count ?? 0, unpaidOrders.length);
    const totalRemaining = Math.max(
      Number(summary.session_remaining_balance) || 0,
      unpaidOrders.reduce(
        (sum, o) => sum + Math.max(0, (Number(o.grand_total) || 0) - (Number(o.paid_total) || 0)),
        0,
      ),
    );
    const remainingSuffix =
      totalRemaining > 0
        ? ` (sisa tagihan Rp ${totalRemaining.toLocaleString("id-ID")})`
        : "";
    return {
      ...emptyResult,
      blockingReason: `Sesi belum dapat ditutup: masih terdapat ${count} pesanan yang belum lunas${remainingSuffix}.`,
    };
  }

  // 2. Cek agregat sisa tagihan sesi
  const sessionRemaining = Math.max(
    Number(summary.session_remaining_balance) || 0,
    (Number(summary.session_grand_total) || 0) - (Number(summary.session_paid_total) || 0),
  );
  if (sessionRemaining > 0) {
    return {
      ...emptyResult,
      blockingReason: `Sesi belum dapat ditutup: masih terdapat sisa tagihan sebesar Rp ${sessionRemaining.toLocaleString("id-ID")}.`,
    };
  }

  // 3. Cek alokasi split bill reserved
  if ((summary.reserved_allocations_count ?? 0) > 0) {
    return {
      ...emptyResult,
      blockingReason:
        "Sesi belum dapat ditutup: terdapat alokasi pembayaran split bill yang masih berstatus reserved.",
    };
  }

  // 4. Cek transaksi Midtrans non-terminal
  if ((summary.pending_midtrans_transactions_count ?? 0) > 0) {
    return {
      ...emptyResult,
      blockingReason:
        "Sesi belum dapat ditutup: terdapat transaksi Midtrans yang masih menunggu penyelesaian.",
    };
  }

  // 5. Cek webhook Midtrans in-flight
  if ((summary.processing_webhooks_count ?? 0) > 0) {
    return {
      ...emptyResult,
      blockingReason:
        "Sesi belum dapat ditutup: terdapat notifikasi pembayaran Midtrans yang sedang diproses.",
    };
  }

  // 6. Cek permohonan refund pending
  if ((summary.pending_refund_count ?? 0) > 0) {
    return {
      ...emptyResult,
      blockingReason:
        "Sesi belum dapat ditutup: masih terdapat permohonan refund yang berstatus pending.",
    };
  }

  // 7. Identifikasi pesanan lunas yang masih berstatus 'paid' atau memiliki KDS aktif
  const paidOrdersToComplete: DiningSessionOrderSummary[] = [];
  const partiallyRefundedPaidOrdersToComplete: DiningSessionOrderSummary[] = [];
  const completedOrdersWithActiveKds: DiningSessionOrderSummary[] = [];

  for (const order of orders) {
    if (order.status === "paid") {
      if (order.payment_status === "paid") {
        paidOrdersToComplete.push(order);
      } else if (
        order.payment_status === "partially_refunded" &&
        (Number(order.paid_total) || 0) >= (Number(order.grand_total) || 0)
      ) {
        partiallyRefundedPaidOrdersToComplete.push(order);
      } else {
        // Guard proteksi tambahan jika status/payment_status tidak konsisten
        return {
          ...emptyResult,
          blockingReason: `Sesi belum dapat ditutup: pesanan #${order.order_number} memiliki status pembayaran yang belum tuntas (${order.payment_status}).`,
        };
      }
    } else if (
      order.status === "completed" &&
      order.kds_status &&
      ACTIVE_KDS_STATUSES.has(order.kds_status)
    ) {
      completedOrdersWithActiveKds.push(order);
    }
  }

  return {
    canClose: true,
    blockingReason: null,
    paidOrdersToComplete,
    partiallyRefundedPaidOrdersToComplete,
    completedOrdersWithActiveKds,
  };
}
