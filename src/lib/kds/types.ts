import type { KdsStatus, OrderType } from "@/types/database";

/**
 * Non-financial, non-PII modifier representation for Kitchen Display System (KDS).
 * Intentionally excludes price_delta_snapshot and any billing metadata.
 */
export type KdsTicketModifier = {
  id: string;
  groupName: string;
  optionName: string;
};

/**
 * Non-financial, non-PII order item representation for KDS.
 * Intentionally excludes unit_price_snapshot, subtotal, discount_amount, and line_total.
 */
export type KdsTicketItem = {
  id: string;
  productName: string;
  quantity: number;
  notes: string | null;
  kitchenStation: string;
  modifiers: KdsTicketModifier[];
};

/**
 * Active KDS ticket representing a paid order currently in kitchen workflow.
 * Strictly excludes financial totals, payment methods, and customer PII.
 */
export type KdsTicket = {
  id: string;
  orderNumber: string;
  queueNumber: string | null;
  orderType: OrderType;
  tableName: string | null;
  diningSessionId: string | null;
  isAdditionalOrder: boolean;
  sessionOrderIndex: number;
  kdsStatus: KdsStatus;
  orderNotes: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  readyAt: string | null;
  items: KdsTicketItem[];
  stations: string[];
};

/**
 * Non-financial alert shown to kitchen staff when a paid order is terminated
 * via full refund (refunds.kitchen_notified_at).
 */
export type KdsRefundAlert = {
  refundId: string;
  orderId: string;
  orderNumber: string;
  queueNumber: string | null;
  orderType: OrderType;
  tableName: string | null;
  reason: string;
  notifiedAt: string;
};

export type KdsStatusFilter = "all" | KdsStatus;
export type KdsOrderTypeFilter = "all" | OrderType;
export type KdsStationFilter = "all" | string;
export type KdsTicketUrgency = "normal" | "warning" | "overdue";

export type KdsBoardData = {
  tickets: KdsTicket[];
  refundAlerts: KdsRefundAlert[];
  availableStations: string[];
  syncedAt: string;
};

export type KdsActionResult<T = undefined> =
  | { ok: true; message: string; data?: T }
  | { ok: false; message: string };

export type UpdateKdsStatusResultData = {
  orderId: string;
  orderNumber: string;
  previousStatus: KdsStatus;
  kdsStatus: KdsStatus;
  updatedAt: string;
};
