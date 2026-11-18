import type { KdsStatus } from "@/types/database";
import type {
  KdsOrderTypeFilter,
  KdsStationFilter,
  KdsStatusFilter,
  KdsTicket,
  KdsTicketUrgency,
} from "./types";

export const KDS_STATUS_ORDER: readonly KdsStatus[] = [
  "queued",
  "preparing",
  "ready",
] as const;

export const KDS_STATUS_LABELS: Record<KdsStatus, string> = {
  queued: "Pesanan Masuk",
  preparing: "Sedang Disiapkan",
  ready: "Siap Diambil",
};

export const KDS_STATUS_DESCRIPTIONS: Record<KdsStatus, string> = {
  queued: "Pesanan lunas yang baru masuk ke antrean dapur.",
  preparing: "Pesanan yang sedang dimasak atau diracik staf dapur.",
  ready: "Pesanan selesai disiapkan dan menunggu diambil kasir/pelayan.",
};

export const KDS_NEXT_ACTION_LABELS: Record<
  Exclude<KdsStatus, "ready">,
  string
> = {
  queued: "Mulai Siapkan",
  preparing: "Tandai Siap",
};

export const KDS_STATION_LABELS: Record<string, string> = {
  kitchen: "Dapur Utama",
  bar: "Bar & Minuman",
  dessert: "Dessert",
};

export const KDS_WARNING_THRESHOLD_MINUTES = 10;
export const KDS_OVERDUE_THRESHOLD_MINUTES = 20;

export function isValidKdsStatus(value: unknown): value is KdsStatus {
  return (
    typeof value === "string" &&
    (KDS_STATUS_ORDER as readonly string[]).includes(value)
  );
}

export function normalizeKitchenStation(
  station: string | null | undefined,
): string {
  const cleaned = station?.trim().toLowerCase();
  return cleaned && cleaned.length > 0 ? cleaned : "kitchen";
}

export function getKitchenStationLabel(station: string): string {
  const normalized = normalizeKitchenStation(station);
  return (
    KDS_STATION_LABELS[normalized] ??
    normalized.charAt(0).toUpperCase() + normalized.slice(1)
  );
}

/**
 * Returns the single allowed forward transition for kitchen staff.
 * Kitchen stops at `ready`; `completed` is exclusively handled by cashier/admin.
 */
export function getNextKdsStatus(current: KdsStatus): KdsStatus | null {
  if (current === "queued") return "preparing";
  if (current === "preparing") return "ready";
  return null;
}

export type KdsTransitionValidation =
  | { ok: true; from: KdsStatus; to: KdsStatus }
  | { ok: false; message: string };

/**
 * Enforces strict one-step forward transitions:
 *   queued -> preparing -> ready
 * Rejects skipping steps, backward reversals, non-paid orders, and non-KDS statuses.
 */
export function validateKdsTransition(params: {
  orderStatus: string;
  currentStatus: unknown;
  nextStatus: unknown;
}): KdsTransitionValidation {
  if (params.orderStatus !== "paid") {
    return {
      ok: false,
      message:
        "Hanya pesanan berstatus lunas (paid) yang dapat diproses di dapur.",
    };
  }

  if (!isValidKdsStatus(params.currentStatus)) {
    return {
      ok: false,
      message: "Pesanan ini tidak memiliki status antrean dapur yang aktif.",
    };
  }

  if (!isValidKdsStatus(params.nextStatus)) {
    return {
      ok: false,
      message:
        "Status dapur tujuan tidak valid. Staf dapur hanya dapat mengubah status hingga Siap Diambil.",
    };
  }

  const allowedNext = getNextKdsStatus(params.currentStatus);

  if (!allowedNext) {
    return {
      ok: false,
      message:
        "Pesanan sudah berada pada tahap Siap Diambil. Penyelesaian pengambilan dilakukan oleh kasir.",
    };
  }

  if (params.nextStatus !== allowedNext) {
    return {
      ok: false,
      message: `Transisi status tidak diizinkan (${KDS_STATUS_LABELS[params.currentStatus]} -> ${KDS_STATUS_LABELS[params.nextStatus]}). Tahap berikutnya harus ${KDS_STATUS_LABELS[allowedNext]}.`,
    };
  }

  return {
    ok: true,
    from: params.currentStatus,
    to: params.nextStatus,
  };
}

/**
 * Determines whether an order row belongs on the active KDS board.
 * Paid orders with partially_refunded payment_status still have status === "paid",
 * so they remain visible. Unpaid, cancelled, completed, and fully refunded orders
 * are strictly excluded.
 */
export function isOrderVisibleInKds(order: {
  status: string;
  kds_status: string | null | undefined;
  served_at?: string | null;
}): boolean {
  return (
    order.status === "paid" &&
    isValidKdsStatus(order.kds_status) &&
    !order.served_at
  );
}

/**
 * Deduplicates KDS tickets by `order.id` and sorts chronologically (FIFO: oldest first).
 * If duplicate entries exist for the same ID, the one with the latest `updatedAt` wins.
 */
export function mergeKdsTicketsById(tickets: KdsTicket[]): KdsTicket[] {
  const byId = new Map<string, KdsTicket>();

  for (const ticket of tickets) {
    const existing = byId.get(ticket.id);
    if (!existing) {
      byId.set(ticket.id, ticket);
      continue;
    }

    const existingTs = Date.parse(existing.updatedAt);
    const incomingTs = Date.parse(ticket.updatedAt);

    if (Number.isNaN(existingTs) || incomingTs >= existingTs) {
      byId.set(ticket.id, ticket);
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    const timeDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (timeDiff !== 0 && !Number.isNaN(timeDiff)) {
      return timeDiff;
    }
    return a.orderNumber.localeCompare(b.orderNumber);
  });
}

/**
 * Computes elapsed minutes since ticket creation (clamped to >= 0).
 */
export function getElapsedMinutes(
  createdAtIso: string,
  nowMs: number = Date.now(),
): number {
  const createdMs = Date.parse(createdAtIso);
  if (Number.isNaN(createdMs)) return 0;
  return Math.max(0, Math.floor((nowMs - createdMs) / 60_000));
}

/**
 * Evaluates visual urgency based on elapsed time and KDS status.
 * Ready tickets are no longer cooking so they are not flagged as cooking-overdue.
 */
export function getTicketUrgency(
  elapsedMinutes: number,
  kdsStatus: KdsStatus,
): KdsTicketUrgency {
  if (kdsStatus === "ready") {
    return "normal";
  }

  if (elapsedMinutes >= KDS_OVERDUE_THRESHOLD_MINUTES) {
    return "overdue";
  }

  if (elapsedMinutes >= KDS_WARNING_THRESHOLD_MINUTES) {
    return "warning";
  }

  return "normal";
}

/**
 * Formats elapsed duration cleanly in Indonesian for kitchen screens.
 */
export function formatElapsedDuration(
  createdAtIso: string,
  nowMs: number = Date.now(),
): string {
  const createdMs = Date.parse(createdAtIso);
  if (Number.isNaN(createdMs)) return "0 mnt";

  const diffSeconds = Math.max(0, Math.floor((nowMs - createdMs) / 1000));

  if (diffSeconds < 60) {
    return "< 1 mnt";
  }

  const totalMinutes = Math.floor(diffSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} mnt`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}j ${mins}m` : `${hours} jam`;
}

/**
 * Given chronological orders within dining sessions, returns a map of
 * orderId -> { isAdditionalOrder, sessionOrderIndex }.
 * The first order in a dining_session_id has index 1 (isAdditionalOrder: false);
 * subsequent orders in the same dining_session_id have index >= 2 (isAdditionalOrder: true).
 */
export function computeAdditionalOrderMap(
  sessionOrders: Array<{
    id: string;
    dining_session_id: string | null;
    created_at: string;
    order_type?: string;
  }>,
): Map<string, { isAdditionalOrder: boolean; sessionOrderIndex: number }> {
  const grouped = new Map<
    string,
    Array<{ id: string; created_at: string }>
  >();

  for (const row of sessionOrders) {
    if (!row.dining_session_id) continue;
    if (row.order_type && row.order_type !== "dine_in") continue;

    const list = grouped.get(row.dining_session_id) ?? [];
    list.push({ id: row.id, created_at: row.created_at });
    grouped.set(row.dining_session_id, list);
  }

  const result = new Map<
    string,
    { isAdditionalOrder: boolean; sessionOrderIndex: number }
  >();

  for (const list of grouped.values()) {
    list.sort((a, b) => {
      const diff = Date.parse(a.created_at) - Date.parse(b.created_at);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
      return a.id.localeCompare(b.id);
    });

    list.forEach((entry, idx) => {
      const orderIndex = idx + 1;
      result.set(entry.id, {
        isAdditionalOrder: orderIndex > 1,
        sessionOrderIndex: orderIndex,
      });
    });
  }

  return result;
}

/**
 * Filters KDS tickets by status, order type, and kitchen station.
 */
export function filterKdsTickets(
  tickets: KdsTicket[],
  filters: {
    status: KdsStatusFilter;
    orderType: KdsOrderTypeFilter;
    station: KdsStationFilter;
  },
): KdsTicket[] {
  return tickets.filter((ticket) => {
    if (filters.status !== "all" && ticket.kdsStatus !== filters.status) {
      return false;
    }

    if (
      filters.orderType !== "all" &&
      ticket.orderType !== filters.orderType
    ) {
      return false;
    }

    if (filters.station !== "all") {
      const normalizedTarget = normalizeKitchenStation(filters.station);
      if (!ticket.stations.includes(normalizedTarget)) {
        return false;
      }
    }

    return true;
  });
}
