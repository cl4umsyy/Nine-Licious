"use server";

import { z } from "zod";
import { getCashierActor } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  KdsStatus,
  Order,
  OrderDiscount,
  OrderItem,
  OrderItemModifier,
  OrderKind,
  OrderStatus,
  OrderType,
  PaymentStatus,
} from "@/types/database";
import {
  mergeCashierOrdersById,
  type CashierOrderItemSummary,
  type CashierOrderListItem,
  type CashierOrdersBoardData,
} from "./cashier-orders";
import { isMissingServingSchemaError } from "./serving";
import type { OrderItemWithModifiers, OrderWithDetails } from "./types";

const orderIdSchema = z.string().uuid("ID pesanan tidak valid.");
const ACTIVE_LOOKBACK_HOURS = 48;

export type CashierOrdersActionResult<T = undefined> =
  | { ok: true; message: string; data?: T }
  | { ok: false; message: string };

type RawCashierOrderRow = {
  id: string;
  order_number: string;
  queue_number: string | null;
  order_type: OrderType;
  order_kind?: OrderKind;
  parent_order_id?: string | null;
  table_id: string | null;
  dining_session_id: string | null;
  customer_name: string | null;
  status: OrderStatus;
  payment_status: PaymentStatus;
  kds_status: KdsStatus | null;
  is_finalized: boolean;
  grand_total: number;
  paid_total: number;
  served_at?: string | null;
  served_by?: string | null;
  created_at: string;
  updated_at: string;
  dining_tables: { name: string } | Array<{ name: string }> | null;
};

type RawCashierItemRow = {
  id: string;
  order_id: string;
  product_name_snapshot: string;
  quantity: number;
  notes: string | null;
  created_at: string;
};

type RawCashierModifierRow = {
  id: string;
  order_item_id: string;
  group_name_snapshot: string;
  option_name_snapshot: string;
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
 * Mengambil daftar pesanan kasir terbaru & aktif langsung dari database Supabase
 * (hanya untuk role `admin` dan `kasir`).
 */
export async function getCashierOrdersAction(): Promise<
  CashierOrdersActionResult<CashierOrdersBoardData>
> {
  const actor = await getCashierActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi Supabase belum dikonfigurasi." };
  }

  const cutoffIso = new Date(
    Date.now() - ACTIVE_LOOKBACK_HOURS * 60 * 60 * 1000,
  ).toISOString();

  let servingSchemaReady = true;
  let rawOrders: RawCashierOrderRow[] = [];

  const primaryQuery = await supabase
    .from("orders")
    .select(
      "id, order_number, queue_number, order_type, order_kind, parent_order_id, table_id, dining_session_id, customer_name, status, payment_status, kds_status, is_finalized, grand_total, paid_total, served_at, served_by, created_at, updated_at, dining_tables(name)",
    )
    .or(
      `created_at.gte.${cutoffIso},status.in.(awaiting_payment,partially_paid,paid)`,
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (primaryQuery.error) {
    if (isMissingServingSchemaError(primaryQuery.error)) {
      servingSchemaReady = false;
      const fallbackQuery = await supabase
        .from("orders")
        .select(
          "id, order_number, queue_number, order_type, order_kind, parent_order_id, table_id, dining_session_id, customer_name, status, payment_status, kds_status, is_finalized, grand_total, paid_total, created_at, updated_at, dining_tables(name)",
        )
        .or(
          `created_at.gte.${cutoffIso},status.in.(awaiting_payment,partially_paid,paid)`,
        )
        .order("created_at", { ascending: false })
        .limit(100);

      if (fallbackQuery.error) {
        console.error(
          "[cashier-orders] Gagal memuat daftar pesanan:",
          fallbackQuery.error.message,
        );
        return { ok: false, message: "Gagal memuat daftar pesanan kasir." };
      }

      rawOrders = (fallbackQuery.data ?? []) as RawCashierOrderRow[];
    } else {
      console.error(
        "[cashier-orders] Gagal memuat daftar pesanan:",
        primaryQuery.error.message,
      );
      return { ok: false, message: "Gagal memuat daftar pesanan kasir." };
    }
  } else {
    rawOrders = (primaryQuery.data ?? []) as RawCashierOrderRow[];
  }

  const orderIds = rawOrders.map((row) => row.id);

  const itemsRes =
    orderIds.length > 0
      ? await supabase
          .from("order_items")
          .select("id, order_id, product_name_snapshot, quantity, notes, created_at")
          .in("order_id", orderIds)
          .order("created_at", { ascending: true })
      : { data: [] as RawCashierItemRow[], error: null };

  if (itemsRes.error) {
    console.error(
      "[cashier-orders] Gagal memuat item pesanan:",
      itemsRes.error.message,
    );
    return { ok: false, message: "Gagal memuat rincian item pesanan." };
  }

  const rawItems = (itemsRes.data ?? []) as RawCashierItemRow[];
  const itemIds = rawItems.map((item) => item.id);

  const modifiersRes =
    itemIds.length > 0
      ? await supabase
          .from("order_item_modifiers")
          .select("id, order_item_id, group_name_snapshot, option_name_snapshot")
          .in("order_item_id", itemIds)
      : { data: [] as RawCashierModifierRow[], error: null };

  const modifiersByItemId = new Map<string, string[]>();
  for (const mod of (modifiersRes.data ?? []) as RawCashierModifierRow[]) {
    const list = modifiersByItemId.get(mod.order_item_id) ?? [];
    list.push(`${mod.group_name_snapshot}: ${mod.option_name_snapshot}`);
    modifiersByItemId.set(mod.order_item_id, list);
  }

  const itemsByOrderId = new Map<string, CashierOrderItemSummary[]>();
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

  const list: CashierOrderListItem[] = rawOrders.map((row) => {
    const items = itemsByOrderId.get(row.id) ?? [];
    const totalItemCount = items.reduce((sum, item) => sum + item.quantity, 0);
    const grandTotal = Number(row.grand_total) || 0;
    const paidTotal = Number(row.paid_total) || 0;

    return {
      id: row.id,
      orderNumber: row.order_number,
      queueNumber: row.queue_number,
      orderType: row.order_type,
      orderKind: row.order_kind ?? "standard",
      parentOrderId: row.parent_order_id ?? null,
      tableId: row.table_id,
      tableName: extractTableName(row.dining_tables),
      diningSessionId: row.dining_session_id,
      customerName: row.customer_name,
      status: row.status,
      paymentStatus: row.payment_status,
      kdsStatus: row.kds_status,
      isFinalized: Boolean(row.is_finalized),
      grandTotal,
      paidTotal,
      remainingBalance: Math.max(0, grandTotal - paidTotal),
      servedAt: row.served_at ?? null,
      servedBy: row.served_by ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items,
      totalItemCount,
    };
  });

  return {
    ok: true,
    message: "Daftar pesanan kasir berhasil dimuat.",
    data: {
      orders: mergeCashierOrdersById(list),
      syncedAt: new Date().toISOString(),
      servingSchemaReady,
    },
  };
}

/**
 * Mengambil detail lengkap pesanan untuk membuka modal konfirmasi/finalisasi/pembayaran
 * langsung dari Daftar Pesanan Kasir.
 */
export async function getCashierOrderDetailsAction(
  rawOrderId: string,
): Promise<CashierOrdersActionResult<OrderWithDetails>> {
  const actor = await getCashierActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const parsed = orderIdSchema.safeParse(rawOrderId);
  if (!parsed.success) {
    return { ok: false, message: "ID pesanan tidak valid." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi Supabase belum dikonfigurasi." };
  }

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("*, dining_tables(name)")
    .eq("id", parsed.data)
    .maybeSingle<
      Order & {
        dining_tables?: { name: string } | Array<{ name: string }> | null;
      }
    >();

  if (orderError || !order) {
    return { ok: false, message: "Detail pesanan tidak ditemukan." };
  }

  const [itemsRes, discountsRes] = await Promise.all([
    supabase
      .from("order_items")
      .select("*")
      .eq("order_id", order.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("order_discounts")
      .select("*")
      .eq("order_id", order.id)
      .order("created_at", { ascending: true }),
  ]);

  const items = (itemsRes.data ?? []) as OrderItem[];
  const itemIds = items.map((i) => i.id);

  let modifiers: OrderItemModifier[] = [];
  if (itemIds.length > 0) {
    const { data: modsData } = await supabase
      .from("order_item_modifiers")
      .select("*")
      .in("order_item_id", itemIds);
    modifiers = (modsData ?? []) as OrderItemModifier[];
  }

  const itemsWithModifiers: OrderItemWithModifiers[] = items.map((item) => ({
    ...item,
    modifiers: modifiers.filter((m) => m.order_item_id === item.id),
  }));

  return {
    ok: true,
    message: "Detail pesanan berhasil dimuat.",
    data: {
      ...order,
      tableName: extractTableName(order.dining_tables),
      items: itemsWithModifiers,
      discounts: (discountsRes.data ?? []) as OrderDiscount[],
    },
  };
}
