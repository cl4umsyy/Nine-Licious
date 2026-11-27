"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logAudit } from "@/lib/auth/audit";
import { getCashierActor } from "@/lib/auth/session";
import { computeAdditionalOrderMap } from "@/lib/kds/transitions";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { OrderKind, OrderType } from "@/types/database";
import {
  isMissingServingSchemaError,
  isOrderPendingServing,
  mergePendingServingOrdersById,
  validateOrderServingConfirmation,
  type ConfirmOrderServedResultData,
  type PendingServingBoardData,
  type PendingServingItem,
  type PendingServingOrder,
} from "./serving";

const orderIdSchema = z.string().uuid("ID pesanan tidak valid.");

const MIGRATION_REQUIRED_MESSAGE =
  "Migrasi konfirmasi penyajian (20261118000100_order_serving_confirmation.sql) belum dijalankan di Supabase. Jalankan migrasi tersebut untuk mencatat waktu & petugas penyajian.";

export type ServingActionResult<T = undefined> =
  | { ok: true; message: string; data?: T }
  | { ok: false; message: string };

type RawServingOrderRow = {
  id: string;
  order_number: string;
  queue_number: string | null;
  order_type: OrderType;
  order_kind?: OrderKind;
  table_id: string | null;
  dining_session_id: string | null;
  status: string;
  payment_status: string;
  kds_status: string | null;
  grand_total: number;
  paid_total: number;
  served_at?: string | null;
  created_at: string;
  updated_at: string;
  dining_tables: { name: string } | Array<{ name: string }> | null;
};

type RawServingItemRow = {
  id: string;
  order_id: string;
  product_name_snapshot: string;
  quantity: number;
  notes: string | null;
  created_at: string;
};

type RawServingModifierRow = {
  id: string;
  order_item_id: string;
  group_name_snapshot: string;
  option_name_snapshot: string;
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

type RpcConfirmServedResponse = {
  order_id: string;
  order_number: string;
  queue_number: string | null;
  order_type: OrderType;
  table_id: string | null;
  dining_session_id: string | null;
  served_at: string;
  served_by: string;
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
 * Mengambil daftar pesanan yang sudah berstatus `ready` di KDS dan menunggu
 * konfirmasi penyajian oleh kasir/admin di halaman POS.
 */
export async function getPendingServingOrdersAction(): Promise<
  ServingActionResult<PendingServingBoardData>
> {
  const actor = await getCashierActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi Supabase belum dikonfigurasi." };
  }

  let schemaReady = true;
  let migrationNotice: string | null = null;
  let rawOrders: RawServingOrderRow[] = [];

  const primaryQuery = await supabase
    .from("orders")
    .select(
      "id, order_number, queue_number, order_type, order_kind, table_id, dining_session_id, status, payment_status, kds_status, grand_total, paid_total, served_at, created_at, updated_at, dining_tables(name)",
    )
    .eq("status", "paid")
    .eq("kds_status", "ready")
    .is("served_at", null)
    .order("updated_at", { ascending: true });

  if (primaryQuery.error) {
    if (isMissingServingSchemaError(primaryQuery.error)) {
      schemaReady = false;
      migrationNotice = MIGRATION_REQUIRED_MESSAGE;

      const fallbackQuery = await supabase
        .from("orders")
        .select(
          "id, order_number, queue_number, order_type, order_kind, table_id, dining_session_id, status, payment_status, kds_status, grand_total, paid_total, created_at, updated_at, dining_tables(name)",
        )
        .eq("status", "paid")
        .eq("kds_status", "ready")
        .order("updated_at", { ascending: true });

      if (fallbackQuery.error) {
        console.error(
          "[pos-serving] Gagal memuat daftar menunggu disajikan:",
          fallbackQuery.error.message,
        );
        return {
          ok: false,
          message: "Gagal memuat daftar pesanan menunggu disajikan.",
        };
      }

      rawOrders = (fallbackQuery.data ?? []) as RawServingOrderRow[];
    } else {
      console.error(
        "[pos-serving] Gagal memuat daftar menunggu disajikan:",
        primaryQuery.error.message,
      );
      return {
        ok: false,
        message: "Gagal memuat daftar pesanan menunggu disajikan.",
      };
    }
  } else {
    rawOrders = (primaryQuery.data ?? []) as RawServingOrderRow[];
  }

  const eligibleOrders = rawOrders.filter((row) =>
    isOrderPendingServing({
      status: row.status,
      payment_status: row.payment_status,
      kds_status: row.kds_status,
      served_at: row.served_at ?? null,
      grand_total: Number(row.grand_total) || 0,
      paid_total: Number(row.paid_total) || 0,
    }),
  );

  const orderIds = eligibleOrders.map((row) => row.id);
  const diningSessionIds = Array.from(
    new Set(
      eligibleOrders
        .map((row) => row.dining_session_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  const [itemsRes, sessionOrdersRes] = await Promise.all([
    orderIds.length > 0
      ? supabase
          .from("order_items")
          .select("id, order_id, product_name_snapshot, quantity, notes, created_at")
          .in("order_id", orderIds)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as RawServingItemRow[], error: null }),
    diningSessionIds.length > 0
      ? supabase
          .from("orders")
          .select("id, dining_session_id, order_type, created_at")
          .in("dining_session_id", diningSessionIds)
          .neq("status", "cancelled")
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as RawSessionOrderRow[], error: null }),
  ]);

  if (itemsRes.error) {
    console.error(
      "[pos-serving] Gagal memuat item pesanan siap saji:",
      itemsRes.error.message,
    );
    return {
      ok: false,
      message: "Gagal memuat rincian item pesanan menunggu disajikan.",
    };
  }

  const rawItems = (itemsRes.data ?? []) as RawServingItemRow[];
  const itemIds = rawItems.map((item) => item.id);

  const modifiersRes =
    itemIds.length > 0
      ? await supabase
          .from("order_item_modifiers")
          .select("id, order_item_id, group_name_snapshot, option_name_snapshot")
          .in("order_item_id", itemIds)
      : { data: [] as RawServingModifierRow[], error: null };

  const modifiersByItemId = new Map<string, string[]>();
  for (const mod of (modifiersRes.data ?? []) as RawServingModifierRow[]) {
    const list = modifiersByItemId.get(mod.order_item_id) ?? [];
    list.push(`${mod.group_name_snapshot}: ${mod.option_name_snapshot}`);
    modifiersByItemId.set(mod.order_item_id, list);
  }

  const itemsByOrderId = new Map<string, PendingServingItem[]>();
  for (const item of rawItems) {
    const list = itemsByOrderId.get(item.order_id) ?? [];
    list.push({
      id: item.id,
      productName: item.product_name_snapshot,
      quantity: item.quantity,
      notes: item.notes,
      modifiers: modifiersByItemId.get(item.id) ?? [],
    });
    itemsByOrderId.set(item.order_id, list);
  }

  const additionalOrderMap = computeAdditionalOrderMap(
    (sessionOrdersRes.data ?? []) as RawSessionOrderRow[],
  );

  // Ambil waktu persis saat dapur menandai pesanan siap (`ready`)
  const readyAtByOrderId = new Map<string, string>();
  const admin = createSupabaseAdminClient();
  if (admin && orderIds.length > 0) {
    const { data: auditRows, error: auditError } = await admin
      .from("audit_logs")
      .select("entity_id, details, created_at")
      .eq("action", "kds.status_updated")
      .in("entity_id", orderIds)
      .order("created_at", { ascending: true });

    if (!auditError && auditRows) {
      for (const row of auditRows as RawKdsAuditRow[]) {
        if (!row.entity_id) continue;
        if (
          row.details?.next_kds_status === "ready" &&
          !readyAtByOrderId.has(row.entity_id)
        ) {
          readyAtByOrderId.set(row.entity_id, row.created_at);
        }
      }
    }
  }

  const pendingOrders: PendingServingOrder[] = eligibleOrders.map((row) => {
    const items = itemsByOrderId.get(row.id) ?? [];
    const totalItemCount = items.reduce((sum, item) => sum + item.quantity, 0);
    const sessionMeta = additionalOrderMap.get(row.id);

    return {
      id: row.id,
      orderNumber: row.order_number,
      queueNumber: row.queue_number,
      orderType: row.order_type,
      orderKind: row.order_kind ?? "standard",
      tableId: row.table_id,
      tableName: extractTableName(row.dining_tables),
      diningSessionId: row.dining_session_id,
      isAdditionalOrder: sessionMeta?.isAdditionalOrder ?? false,
      sessionOrderIndex: sessionMeta?.sessionOrderIndex ?? 1,
      kdsStatus: "ready",
      readyAt: readyAtByOrderId.get(row.id) ?? row.updated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items,
      totalItemCount,
    };
  });

  return {
    ok: true,
    message: "Daftar pesanan menunggu disajikan berhasil dimuat.",
    data: {
      orders: mergePendingServingOrdersById(pendingOrders),
      syncedAt: new Date().toISOString(),
      schemaReady,
      migrationNotice,
    },
  };
}

/**
 * Mengonfirmasi bahwa pesanan berstatus `ready` telah diambil & disajikan kepada pelanggan.
 *
 * Jaminan keamanan & integritas:
 * - Hanya admin dan kasir (`getCashierActor` + RPC role check; `kitchen` ditolak).
 * - Update atomik (`confirm_order_served_atomic` dengan FOR UPDATE, atau conditional update).
 * - HANYA mengisi `served_at`, `served_by`, dan `updated_at` — tidak mengubah
 *   `status`, `payment_status`, `kds_status`, `dining_sessions`, atau `dining_tables`.
 * - Tidak menutup sesi meja (tetap terbuka sampai kasir menutup sesi lewat F2.3).
 */
export async function confirmOrderServedAction(
  rawOrderId: string,
): Promise<ServingActionResult<ConfirmOrderServedResultData>> {
  const actor = await getCashierActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const parsed = orderIdSchema.safeParse(rawOrderId);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "ID pesanan tidak valid.",
    };
  }

  const orderId = parsed.data;
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi Supabase belum dikonfigurasi." };
  }

  // 1. Prioritaskan RPC atomik (row-level FOR UPDATE + audit log dalam 1 transaksi)
  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "confirm_order_served_atomic",
    { p_order_id: orderId },
  );

  if (!rpcError && rpcData) {
    const res = rpcData as RpcConfirmServedResponse;
    revalidatePath("/pos");
    revalidatePath("/pos/orders");
    revalidatePath("/pos/floor");
    revalidatePath("/kitchen");
    revalidatePath("/queue");
    revalidatePath("/admin/tables");

    return {
      ok: true,
      message: `Pesanan ${res.queue_number ? `${res.queue_number} (#${res.order_number})` : `#${res.order_number}`} berhasil ditandai sudah disajikan.`,
      data: {
        orderId: res.order_id,
        orderNumber: res.order_number,
        queueNumber: res.queue_number,
        orderType: res.order_type,
        tableId: res.table_id,
        diningSessionId: res.dining_session_id,
        servedAt: res.served_at,
        servedBy: res.served_by,
        servedByName:
          actor.session.profile.full_name || actor.session.profile.username,
      },
    };
  }

  // 2. Jika RPC belum dipasang di Supabase (hanya kode PGRST202 / 42883), fallback ke update atomik kondisional (RLS-enforced)
  const isMissingRpc =
    rpcError?.code === "PGRST202" || rpcError?.code === "42883";

  if (!isMissingRpc) {
    return {
      ok: false,
      message:
        rpcError?.message ||
        "Gagal menyimpan konfirmasi penyajian pesanan.",
    };
  }

  const { data: currentOrder, error: fetchError } = await supabase
    .from("orders")
    .select(
      "id, order_number, queue_number, order_type, table_id, dining_session_id, status, payment_status, kds_status, grand_total, paid_total, served_at",
    )
    .eq("id", orderId)
    .maybeSingle<{
      id: string;
      order_number: string;
      queue_number: string | null;
      order_type: OrderType;
      table_id: string | null;
      dining_session_id: string | null;
      status: string;
      payment_status: string;
      kds_status: string | null;
      grand_total: number;
      paid_total: number;
      served_at: string | null;
    }>();

  if (fetchError) {
    if (isMissingServingSchemaError(fetchError)) {
      return { ok: false, message: MIGRATION_REQUIRED_MESSAGE };
    }
    return {
      ok: false,
      message: "Gagal memverifikasi status pesanan sebelum konfirmasi.",
    };
  }

  if (!currentOrder) {
    return { ok: false, message: "Pesanan tidak ditemukan." };
  }

  const validation = validateOrderServingConfirmation({
    order_number: currentOrder.order_number,
    status: currentOrder.status,
    payment_status: currentOrder.payment_status,
    kds_status: currentOrder.kds_status,
    served_at: currentOrder.served_at,
    grand_total: Number(currentOrder.grand_total) || 0,
    paid_total: Number(currentOrder.paid_total) || 0,
  });

  if (!validation.ok) {
    return { ok: false, message: validation.message };
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from("orders")
    .update({
      served_at: nowIso,
      served_by: actor.session.profile.id,
      updated_at: nowIso,
    })
    .eq("id", orderId)
    .eq("status", "paid")
    .in("payment_status", ["paid", "partially_refunded"])
    .eq("kds_status", "ready")
    .is("served_at", null)
    .select(
      "id, order_number, queue_number, order_type, table_id, dining_session_id, served_at, served_by",
    )
    .maybeSingle<{
      id: string;
      order_number: string;
      queue_number: string | null;
      order_type: OrderType;
      table_id: string | null;
      dining_session_id: string | null;
      served_at: string;
      served_by: string;
    }>();

  if (updateError) {
    if (isMissingServingSchemaError(updateError)) {
      return { ok: false, message: MIGRATION_REQUIRED_MESSAGE };
    }
    console.error("[pos-serving] Gagal update served_at:", updateError.message);
    return {
      ok: false,
      message: "Gagal menyimpan konfirmasi penyajian. Silakan coba lagi.",
    };
  }

  if (!updated) {
    return {
      ok: false,
      message: `Pesanan #${currentOrder.order_number} sudah dikonfirmasi atau statusnya baru saja berubah.`,
    };
  }

  await logAudit({
    action: "order.served_confirmed",
    userId: actor.session.profile.id,
    username: actor.session.profile.username,
    entity: "order",
    entityId: updated.id,
    details: {
      order_number: updated.order_number,
      queue_number: updated.queue_number,
      order_type: updated.order_type,
      table_id: updated.table_id,
      dining_session_id: updated.dining_session_id,
      served_at: updated.served_at,
      served_by: updated.served_by,
      actor_role: actor.session.profile.role,
    },
  });

  revalidatePath("/pos");
  revalidatePath("/pos/orders");
  revalidatePath("/pos/floor");
  revalidatePath("/kitchen");
  revalidatePath("/queue");
  revalidatePath("/admin/tables");

  return {
    ok: true,
    message: `Pesanan ${updated.queue_number ? `${updated.queue_number} (#${updated.order_number})` : `#${updated.order_number}`} berhasil ditandai sudah disajikan.`,
    data: {
      orderId: updated.id,
      orderNumber: updated.order_number,
      queueNumber: updated.queue_number,
      orderType: updated.order_type,
      tableId: updated.table_id,
      diningSessionId: updated.dining_session_id,
      servedAt: updated.served_at,
      servedBy: updated.served_by,
      servedByName:
        actor.session.profile.full_name || actor.session.profile.username,
    },
  };
}
