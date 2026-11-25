"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logAudit } from "@/lib/auth/audit";
import { getKitchenActor } from "@/lib/auth/session";
import { isMissingServingSchemaError } from "@/lib/orders/serving";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { KdsStatus, OrderType } from "@/types/database";
import {
  computeAdditionalOrderMap,
  isOrderVisibleInKds,
  isValidKdsStatus,
  KDS_STATUS_LABELS,
  mergeKdsTicketsById,
  normalizeKitchenStation,
  validateKdsTransition,
} from "./transitions";
import type {
  KdsActionResult,
  KdsBoardData,
  KdsRefundAlert,
  KdsTicket,
  KdsTicketItem,
  KdsTicketModifier,
  UpdateKdsStatusResultData,
} from "./types";

const REFUND_ALERT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 jam terakhir
const DEFAULT_KITCHEN_STATIONS = ["kitchen", "bar", "dessert"] as const;

const updateKdsStatusSchema = z.object({
  orderId: z.string().uuid("ID pesanan tidak valid."),
  expectedStatus: z.enum(["queued", "preparing"]),
  nextStatus: z.enum(["preparing", "ready"]),
});

type RawKdsOrderRow = {
  id: string;
  order_number: string;
  queue_number: string | null;
  order_type: OrderType;
  table_id: string | null;
  dining_session_id: string | null;
  status: string;
  kds_status: string | null;
  served_at?: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  dining_tables:
    | { name: string }
    | Array<{ name: string }>
    | null;
};

type RawKdsOrderItemRow = {
  id: string;
  order_id: string;
  product_name_snapshot: string;
  quantity: number;
  notes: string | null;
  kitchen_station: string | null;
  created_at: string;
};

type RawKdsOrderItemModifierRow = {
  id: string;
  order_item_id: string;
  group_name_snapshot: string;
  option_name_snapshot: string;
  created_at: string;
};

type RawSessionOrderRow = {
  id: string;
  dining_session_id: string | null;
  order_type: string;
  created_at: string;
};

type RawKdsAuditRow = {
  entity_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

type RawRefundAlertRow = {
  id: string;
  order_id: string;
  reason: string;
  kitchen_notified_at: string | null;
  orders:
    | {
        status?: string;
        order_number: string;
        queue_number: string | null;
        order_type: OrderType;
        dining_tables: { name: string } | Array<{ name: string }> | null;
      }
    | Array<{
        status?: string;
        order_number: string;
        queue_number: string | null;
        order_type: OrderType;
        dining_tables: { name: string } | Array<{ name: string }> | null;
      }>
    | null;
};

function extractTableName(
  relation: { name: string } | Array<{ name: string }> | null | undefined,
): string | null {
  if (!relation) return null;
  if (Array.isArray(relation)) {
    return relation[0]?.name ?? null;
  }
  return relation.name ?? null;
}

/**
 * Loads active Kitchen Display System (KDS) tickets and recent full-refund
 * termination alerts.
 *
 * Security & Privacy guarantees (FR-KDS-03):
 * - Requires authenticated `kitchen` or `admin` role (`kasir` is rejected).
 * - Never selects or returns financial columns (`subtotal`, `grand_total`,
 *   `paid_total`, `unit_price_snapshot`, `line_total`, `price_delta_snapshot`,
 *   `amount`, `payment_method`) or customer PII (`customer_name`, phone).
 */
export async function getKdsBoardDataAction(): Promise<
  KdsActionResult<KdsBoardData>
> {
  const actor = await getKitchenActor();

  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    return {
      ok: false,
      message: "Koneksi Supabase belum dikonfigurasi.",
    };
  }

  // 1. Fetch active paid orders in KDS workflow (strictly non-financial, non-PII projection).
  //    Exclude orders already confirmed as served (`served_at IS NULL`), with graceful fallback
  //    if the serving migration has not been applied yet.
  let rawOrderRows: RawKdsOrderRow[] = [];
  const primaryOrdersQuery = await supabase
    .from("orders")
    .select(
      "id, order_number, queue_number, order_type, table_id, dining_session_id, status, kds_status, served_at, notes, created_at, updated_at, dining_tables(name)",
    )
    .eq("status", "paid")
    .in("kds_status", ["queued", "preparing", "ready"])
    .is("served_at", null)
    .order("created_at", { ascending: true });

  if (primaryOrdersQuery.error) {
    if (isMissingServingSchemaError(primaryOrdersQuery.error)) {
      const fallbackOrdersQuery = await supabase
        .from("orders")
        .select(
          "id, order_number, queue_number, order_type, table_id, dining_session_id, status, kds_status, notes, created_at, updated_at, dining_tables(name)",
        )
        .eq("status", "paid")
        .in("kds_status", ["queued", "preparing", "ready"])
        .order("created_at", { ascending: true });

      if (fallbackOrdersQuery.error) {
        console.error(
          "[kds] Gagal memuat antrean pesanan:",
          fallbackOrdersQuery.error.message,
        );
        return {
          ok: false,
          message: "Gagal memuat daftar pesanan dapur. Silakan muat ulang.",
        };
      }
      rawOrderRows = (fallbackOrdersQuery.data ?? []) as RawKdsOrderRow[];
    } else {
      console.error(
        "[kds] Gagal memuat antrean pesanan:",
        primaryOrdersQuery.error.message,
      );
      return {
        ok: false,
        message: "Gagal memuat daftar pesanan dapur. Silakan muat ulang.",
      };
    }
  } else {
    rawOrderRows = (primaryOrdersQuery.data ?? []) as RawKdsOrderRow[];
  }

  const activeOrders = rawOrderRows.filter((row) =>
    isOrderVisibleInKds({
      status: row.status,
      kds_status: row.kds_status,
      served_at: row.served_at ?? null,
    }),
  );

  const orderIds = activeOrders.map((row) => row.id);
  const diningSessionIds = Array.from(
    new Set(
      activeOrders
        .map((row) => row.dining_session_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  // 2. Fetch order items (strictly non-financial projection) & session order chronology
  const [itemsResult, sessionOrdersResult] = await Promise.all([
    orderIds.length > 0
      ? supabase
          .from("order_items")
          .select(
            "id, order_id, product_name_snapshot, quantity, notes, kitchen_station, created_at",
          )
          .in("order_id", orderIds)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as RawKdsOrderItemRow[], error: null }),
    diningSessionIds.length > 0
      ? supabase
          .from("orders")
          .select("id, dining_session_id, order_type, created_at")
          .in("dining_session_id", diningSessionIds)
          .not("status", "in", "(cancelled,refunded)")
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as RawSessionOrderRow[], error: null }),
  ]);

  if (itemsResult.error) {
    console.error("[kds] Gagal memuat item pesanan:", itemsResult.error.message);
    return {
      ok: false,
      message: "Gagal memuat detail item pesanan dapur.",
    };
  }

  const rawItems = (itemsResult.data ?? []) as RawKdsOrderItemRow[];
  const itemIds = rawItems.map((item) => item.id);

  // 3. Fetch modifiers (strictly non-financial projection)
  const modifiersResult =
    itemIds.length > 0
      ? await supabase
          .from("order_item_modifiers")
          .select(
            "id, order_item_id, group_name_snapshot, option_name_snapshot, created_at",
          )
          .in("order_item_id", itemIds)
          .order("created_at", { ascending: true })
      : { data: [] as RawKdsOrderItemModifierRow[], error: null };

  if (modifiersResult.error) {
    console.error(
      "[kds] Gagal memuat modifier item:",
      modifiersResult.error.message,
    );
  }

  const modifiersByItemId = new Map<string, KdsTicketModifier[]>();
  for (const mod of (modifiersResult.data ?? []) as RawKdsOrderItemModifierRow[]) {
    const list = modifiersByItemId.get(mod.order_item_id) ?? [];
    list.push({
      id: mod.id,
      groupName: mod.group_name_snapshot,
      optionName: mod.option_name_snapshot,
    });
    modifiersByItemId.set(mod.order_item_id, list);
  }

  const itemsByOrderId = new Map<string, KdsTicketItem[]>();
  const stationSet = new Set<string>(DEFAULT_KITCHEN_STATIONS);

  for (const item of rawItems) {
    const normalizedStation = normalizeKitchenStation(item.kitchen_station);
    stationSet.add(normalizedStation);

    const list = itemsByOrderId.get(item.order_id) ?? [];
    list.push({
      id: item.id,
      productName: item.product_name_snapshot,
      quantity: item.quantity,
      notes: item.notes,
      kitchenStation: normalizedStation,
      modifiers: modifiersByItemId.get(item.id) ?? [],
    });
    itemsByOrderId.set(item.order_id, list);
  }

  const additionalOrderMap = computeAdditionalOrderMap(
    (sessionOrdersResult.data ?? []) as RawSessionOrderRow[],
  );

  // 4. Read operational step timestamps (startedAt / readyAt) and recent full-refund
  //    termination alerts via admin client with strict non-financial projection.
  //    (audit_logs and refunds RLS exclude role `kitchen` to protect sensitive financial/audit data.)
  const startedAtByOrderId = new Map<string, string>();
  const readyAtByOrderId = new Map<string, string>();
  let refundAlerts: KdsRefundAlert[] = [];

  const admin = createSupabaseAdminClient();
  if (admin) {
    const alertCutoffIso = new Date(
      Date.now() - REFUND_ALERT_WINDOW_MS,
    ).toISOString();

    const [auditRes, refundRes] = await Promise.all([
      orderIds.length > 0
        ? admin
            .from("audit_logs")
            .select("entity_id, details, created_at")
            .eq("action", "kds.status_updated")
            .in("entity_id", orderIds)
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: [] as RawKdsAuditRow[], error: null }),
      admin
        .from("refunds")
        .select(
          "id, order_id, reason, kitchen_notified_at, orders(status, order_number, queue_number, order_type, dining_tables(name))",
        )
        .eq("refund_type", "full")
        .not("kitchen_notified_at", "is", null)
        .gte("kitchen_notified_at", alertCutoffIso)
        .order("kitchen_notified_at", { ascending: false })
        .limit(10),
    ]);

    if (!auditRes.error && auditRes.data) {
      for (const row of auditRes.data as RawKdsAuditRow[]) {
        if (!row.entity_id) continue;
        const nextStatus = row.details?.next_kds_status;
        if (nextStatus === "preparing" && !startedAtByOrderId.has(row.entity_id)) {
          startedAtByOrderId.set(row.entity_id, row.created_at);
        }
        if (nextStatus === "ready" && !readyAtByOrderId.has(row.entity_id)) {
          readyAtByOrderId.set(row.entity_id, row.created_at);
        }
      }
    }

    if (!refundRes.error && refundRes.data) {
      refundAlerts = (refundRes.data as RawRefundAlertRow[])
        .filter((row) => {
          if (!row.kitchen_notified_at) return false;
          const orderObj = Array.isArray(row.orders)
            ? row.orders[0]
            : row.orders;
          return orderObj?.status !== "cancelled";
        })
        .map((row) => {
          const orderObj = Array.isArray(row.orders)
            ? row.orders[0]
            : row.orders;
          return {
            refundId: row.id,
            orderId: row.order_id,
            orderNumber: orderObj?.order_number ?? "Pesanan",
            queueNumber: orderObj?.queue_number ?? null,
            orderType: orderObj?.order_type ?? "takeaway",
            tableName: extractTableName(orderObj?.dining_tables),
            reason: row.reason,
            notifiedAt: row.kitchen_notified_at as string,
          };
        });
    }
  }

  // 5. Assemble sanitized KDS tickets & deduplicate by order.id
  const rawTickets: KdsTicket[] = activeOrders
    .filter((row): row is RawKdsOrderRow & { kds_status: KdsStatus } =>
      isValidKdsStatus(row.kds_status),
    )
    .map((row) => {
      const items = itemsByOrderId.get(row.id) ?? [];
      const stations = Array.from(
        new Set(items.map((item) => item.kitchenStation)),
      );
      const sessionMeta = additionalOrderMap.get(row.id);

      return {
        id: row.id,
        orderNumber: row.order_number,
        queueNumber: row.queue_number,
        orderType: row.order_type,
        tableName: extractTableName(row.dining_tables),
        diningSessionId: row.dining_session_id,
        isAdditionalOrder: sessionMeta?.isAdditionalOrder ?? false,
        sessionOrderIndex: sessionMeta?.sessionOrderIndex ?? 1,
        kdsStatus: row.kds_status,
        orderNotes: row.notes,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: startedAtByOrderId.get(row.id) ?? null,
        readyAt: readyAtByOrderId.get(row.id) ?? null,
        items,
        stations: stations.length > 0 ? stations : ["kitchen"],
      };
    });

  const tickets = mergeKdsTicketsById(rawTickets);

  return {
    ok: true,
    message: "Data antrean dapur berhasil dimuat.",
    data: {
      tickets,
      refundAlerts,
      availableStations: Array.from(stationSet),
      syncedAt: new Date().toISOString(),
    },
  };
}

/**
 * Advances a paid order's KDS status by strictly one forward step:
 *   queued -> preparing -> ready
 *
 * Security & Integrity guarantees:
 * - Only `kitchen` or `admin` may invoke (`kasir` is rejected).
 * - Never touches `status`, `payment_status`, `paid_total`, `dining_sessions`,
 *   or `dining_tables`.
 * - Atomic conditional update prevents race conditions & double-clicks.
 * - Writes an immutable `kds.status_updated` entry to `audit_logs`.
 */
export async function updateKdsStatusAction(rawInput: {
  orderId: string;
  expectedStatus: KdsStatus;
  nextStatus: KdsStatus;
}): Promise<KdsActionResult<UpdateKdsStatusResultData>> {
  const actor = await getKitchenActor();

  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const parsed = updateKdsStatusSchema.safeParse(rawInput);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]?.message;
    return {
      ok: false,
      message:
        firstIssue ??
        "Permintaan perubahan status dapur tidak valid.",
    };
  }

  const admin = createSupabaseAdminClient();

  if (!admin) {
    return {
      ok: false,
      message:
        "Konfigurasi server belum lengkap untuk memperbarui status dapur.",
    };
  }

  // 1. Read minimal order state for explicit validation & clear feedback
  const { data: currentOrder, error: fetchError } = await admin
    .from("orders")
    .select("id, order_number, status, kds_status")
    .eq("id", parsed.data.orderId)
    .maybeSingle<{
      id: string;
      order_number: string;
      status: string;
      kds_status: string | null;
    }>();

  if (fetchError || !currentOrder) {
    return {
      ok: false,
      message: "Pesanan tidak ditemukan atau sudah tidak tersedia.",
    };
  }

  if (currentOrder.status !== "paid") {
    return {
      ok: false,
      message:
        currentOrder.status === "refunded"
          ? `Pesanan #${currentOrder.order_number} telah dibatalkan (refund penuh) dan tidak perlu diproses.`
          : currentOrder.status === "completed"
            ? `Pesanan #${currentOrder.order_number} sudah diselesaikan oleh kasir.`
            : `Pesanan #${currentOrder.order_number} belum berstatus lunas.`,
    };
  }

  if (currentOrder.kds_status !== parsed.data.expectedStatus) {
    const currentLabel = isValidKdsStatus(currentOrder.kds_status)
      ? KDS_STATUS_LABELS[currentOrder.kds_status]
      : "tidak aktif";
    return {
      ok: false,
      message: `Status pesanan #${currentOrder.order_number} sudah diperbarui menjadi "${currentLabel}". Layar akan disinkronkan ulang.`,
    };
  }

  const validation = validateKdsTransition({
    orderStatus: currentOrder.status,
    currentStatus: currentOrder.kds_status,
    nextStatus: parsed.data.nextStatus,
  });

  if (!validation.ok) {
    return { ok: false, message: validation.message };
  }

  // 2. Atomic conditional update: ONLY `kds_status` and `updated_at`
  const nowIso = new Date().toISOString();
  const { data: updated, error: updateError } = await admin
    .from("orders")
    .update({
      kds_status: validation.to,
      updated_at: nowIso,
    })
    .eq("id", parsed.data.orderId)
    .eq("status", "paid")
    .eq("kds_status", validation.from)
    .select("id, order_number, kds_status, updated_at")
    .maybeSingle<{
      id: string;
      order_number: string;
      kds_status: KdsStatus;
      updated_at: string;
    }>();

  if (updateError) {
    console.error("[kds] Gagal memperbarui kds_status:", updateError.message);
    return {
      ok: false,
      message: "Gagal memperbarui status pesanan dapur. Silakan coba lagi.",
    };
  }

  if (!updated) {
    return {
      ok: false,
      message: `Status pesanan #${currentOrder.order_number} baru saja berubah oleh proses lain. Silakan muat ulang.`,
    };
  }

  // 3. Immutable audit trail
  await logAudit({
    action: "kds.status_updated",
    userId: actor.session.profile.id,
    username: actor.session.profile.username,
    entity: "order",
    entityId: updated.id,
    details: {
      order_number: updated.order_number,
      previous_kds_status: validation.from,
      next_kds_status: validation.to,
      actor_role: actor.session.profile.role,
    },
  });

  revalidatePath("/kitchen");

  return {
    ok: true,
    message: `Pesanan #${updated.order_number} diperbarui ke "${KDS_STATUS_LABELS[updated.kds_status]}".`,
    data: {
      orderId: updated.id,
      orderNumber: updated.order_number,
      previousStatus: validation.from,
      kdsStatus: updated.kds_status,
      updatedAt: updated.updated_at,
    },
  };
}
