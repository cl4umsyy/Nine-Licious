"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/auth/audit";
import {
  getCashierActor,
  type AuthenticatedSession,
} from "@/lib/auth/session";
import type { OrderActionResult } from "@/lib/orders/action-types";
import { calculateCartTotals } from "@/lib/orders/calculations";
import type {
  CartItem,
  OrderWithDetails,
  OrderItemWithModifiers,
} from "@/lib/orders/types";
import {
  appendOrderItemsSchema,
  cancelOrderSchema,
  createOrderSchema,
  fieldErrorsFrom,
  firstZodError,
  tableIdSchema,
} from "@/lib/orders/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  DiningSession,
  DiningTable,
  ModifierGroup,
  ModifierOption,
  Order,
  OrderDiscount,
  OrderItem,
  OrderItemModifier,
  Product,
} from "@/types/database";

type ActionContext = {
  actor: AuthenticatedSession;
  supabase: SupabaseClient;
};

async function getActionContext(): Promise<
  { ok: true; context: ActionContext } | { ok: false; result: OrderActionResult }
> {
  const actor = await getCashierActor();

  if (!actor.ok) {
    return { ok: false, result: { ok: false, message: actor.message } };
  }

  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    return {
      ok: false,
      result: { ok: false, message: "Supabase belum dikonfigurasi." },
    };
  }

  return {
    ok: true,
    context: { actor: actor.session, supabase },
  };
}

function revalidatePosPaths(): void {
  revalidatePath("/pos");
  revalidatePath("/pos/floor");
  revalidatePath("/admin/tables");
}

/**
 * Helper untuk mengambil detail pesanan lengkap beserta item dan modifier.
 */
async function fetchFullOrderDetails(
  supabase: SupabaseClient,
  orderId: string,
  tableNameFallback?: string | null,
): Promise<OrderWithDetails | null> {
  const { data: order } = await supabase
    .from("orders")
    .select("*, dining_tables(name)")
    .eq("id", orderId)
    .maybeSingle<Order & { dining_tables?: { name: string } | null }>();

  if (!order) return null;

  const { data: itemsData } = await supabase
    .from("order_items")
    .select("*")
    .eq("order_id", orderId);

  const items = (itemsData ?? []) as OrderItem[];
  const itemIds = items.map((i) => i.id);

  const modifiersByItem = new Map<string, OrderItemModifier[]>();
  if (itemIds.length > 0) {
    const { data: modsData } = await supabase
      .from("order_item_modifiers")
      .select("*")
      .in("order_item_id", itemIds);

    for (const mod of (modsData ?? []) as OrderItemModifier[]) {
      const list = modifiersByItem.get(mod.order_item_id) ?? [];
      list.push(mod);
      modifiersByItem.set(mod.order_item_id, list);
    }
  }

  const itemsWithMods: OrderItemWithModifiers[] = items.map((i) => ({
    ...i,
    modifiers: modifiersByItem.get(i.id) ?? [],
  }));

  const { data: discountsData } = await supabase
    .from("order_discounts")
    .select("*")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });

  const { dining_tables, ...orderClean } = order;

  return {
    ...orderClean,
    items: itemsWithMods,
    discounts: (discountsData ?? []) as OrderDiscount[],
    tableName: dining_tables?.name ?? tableNameFallback ?? null,
  };
}

/**
 * Membuat pesanan baru dari POS atau menambah item ke pesanan yang belum lunas.
 * H-1: Menggunakan atomic PostgreSQL RPC create_pos_order_atomic.
 * M-1: Validasi server-side agar meja occupied ditolak.
 */
export async function createPosOrderAction(
  rawInput: unknown,
): Promise<OrderActionResult> {
  const contextResult = await getActionContext();
  if (!contextResult.ok) return contextResult.result;

  const { context } = contextResult;

  // 1. Validasi Zod
  const parsed = createOrderSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const input = parsed.data;

  // H-2: Jika ada existingOrderId, delegasikan langsung ke penambahan item
  if (input.existingOrderId) {
    return appendOrderItemsAction({
      orderId: input.existingOrderId,
      items: input.items,
    });
  }

  // 2. Cek Idempotency Key (jika disediakan)
  if (input.idempotencyKey) {
    const { data: existingOrder } = await context.supabase
      .from("orders")
      .select("*")
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle<Order>();

    if (existingOrder) {
      const fullExisting = await fetchFullOrderDetails(
        context.supabase,
        existingOrder.id,
      );
      return {
        ok: true,
        message: `Pesanan ${existingOrder.order_number} sudah tersimpan sebelumnya.`,
        data: fullExisting ?? {
          ...existingOrder,
          items: [],
        },
      };
    }
  }

  // 3. Baca pengaturan restoran (pajak & service charge)
  let taxPercent = 10;
  let serviceChargePercent = 5;

  const { data: settings } = await context.supabase
    .from("restaurant_settings")
    .select("tax_percent, service_charge_percent")
    .eq("id", 1)
    .maybeSingle<{
      tax_percent: number;
      service_charge_percent: number;
    }>();

  if (settings) {
    taxPercent = Number(settings.tax_percent) || 0;
    serviceChargePercent = Number(settings.service_charge_percent) || 0;
  }

  // 4. Validasi Produk & Ketersediaan
  const productIds = Array.from(new Set(input.items.map((i) => i.productId)));
  const { data: productsData, error: productsError } = await context.supabase
    .from("products")
    .select("id, name, sku, price, is_active, is_available, kitchen_station")
    .in("id", productIds);

  if (productsError) {
    return {
      ok: false,
      message: "Gagal mengambil data produk menu.",
    };
  }

  const products = (productsData ?? []) as Product[];
  const productMap = new Map(products.map((p) => [p.id, p]));

  for (const item of input.items) {
    const product = productMap.get(item.productId);
    if (!product || !product.is_active) {
      return {
        ok: false,
        message: "Terdapat produk yang tidak aktif atau tidak ditemukan.",
      };
    }
    if (!product.is_available) {
      return {
        ok: false,
        message: `Produk "${product.name}" sedang tidak tersedia / habis.`,
      };
    }
  }

  // 5. Validasi Aturan Modifier per Produk
  const optionIds = Array.from(
    new Set(input.items.flatMap((i) => i.modifierOptionIds ?? [])),
  );

  let optionMap = new Map<string, ModifierOption>();
  if (optionIds.length > 0) {
    const { data: optionsData, error: optionsError } = await context.supabase
      .from("modifier_options")
      .select("id, group_id, name, price_delta, is_active")
      .in("id", optionIds);

    if (optionsError) {
      return {
        ok: false,
        message: "Gagal mengambil data modifier pilihan.",
      };
    }

    const options = (optionsData ?? []) as ModifierOption[];
    optionMap = new Map(options.map((o) => [o.id, o]));
  }

  // Ambil relasi grup modifier untuk produk yang dipesan
  const { data: pmgData } = await context.supabase
    .from("product_modifier_groups")
    .select("product_id, modifier_group_id")
    .in("product_id", productIds);

  const groupIds = Array.from(
    new Set((pmgData ?? []).map((pmg) => pmg.modifier_group_id)),
  );

  let groupMap = new Map<string, ModifierGroup>();
  if (groupIds.length > 0) {
    const { data: groupsData } = await context.supabase
      .from("modifier_groups")
      .select(
        "id, name, selection_type, is_required, min_select, max_select, is_active",
      )
      .in("id", groupIds);

    const groups = (groupsData ?? []) as ModifierGroup[];
    groupMap = new Map(groups.map((g) => [g.id, g]));
  }

  const productGroupsMap = new Map<string, string[]>();
  for (const pmg of pmgData ?? []) {
    const existing = productGroupsMap.get(pmg.product_id) ?? [];
    existing.push(pmg.modifier_group_id);
    productGroupsMap.set(pmg.product_id, existing);
  }

  // Validasi setiap item terhadap aturan grup modifier
  for (const item of input.items) {
    const product = productMap.get(item.productId)!;
    const applicableGroupIds = productGroupsMap.get(item.productId) ?? [];

    for (const gId of applicableGroupIds) {
      const group = groupMap.get(gId);
      if (!group || !group.is_active) continue;

      const selectedInGroup = (item.modifierOptionIds ?? []).filter((optId) => {
        const opt = optionMap.get(optId);
        return opt && opt.group_id === gId && opt.is_active;
      });

      if (group.is_required && selectedInGroup.length === 0) {
        return {
          ok: false,
          message: `Produk "${product.name}" mewajibkan pilihan pada grup modifier "${group.name}".`,
        };
      }

      if (selectedInGroup.length < group.min_select) {
        return {
          ok: false,
          message: `Modifier "${group.name}" pada "${product.name}" minimal memilih ${group.min_select} opsi.`,
        };
      }

      if (selectedInGroup.length > group.max_select) {
        return {
          ok: false,
          message: `Modifier "${group.name}" pada "${product.name}" maksimal memilih ${group.max_select} opsi.`,
        };
      }
    }
  }

  // 6. Validasi Meja & Kunjungan Dine-in (M-1)
  let targetTableId: string | null = null;
  let tableNameSnapshot: string | null = null;

  if (input.orderType === "dine_in") {
    targetTableId = input.tableId!;

    const { data: table, error: tableError } = await context.supabase
      .from("dining_tables")
      .select("id, name, status, is_active")
      .eq("id", targetTableId)
      .maybeSingle<DiningTable>();

    if (tableError || !table || !table.is_active) {
      return {
        ok: false,
        message: "Meja yang dipilih tidak aktif atau tidak ditemukan.",
      };
    }

    // M-1: Validasi meja occupied tidak dapat digunakan untuk membuat pesanan baru
    if (table.status === "occupied") {
      return {
        ok: false,
        message: `Meja "${table.name}" sedang terisi (occupied). Pesanan baru tidak dapat dibuat untuk meja yang sedang terisi.`,
      };
    }

    tableNameSnapshot = table.name;
  }

  // 7. Hitung Rincian Total Keranjang
  const cartItems: CartItem[] = input.items.map((item, index) => {
    const product = productMap.get(item.productId)!;
    const itemModifiers = (item.modifierOptionIds ?? []).map((optId) => {
      const opt = optionMap.get(optId)!;
      const group = groupMap.get(opt.group_id);
      return {
        optionId: opt.id,
        groupId: opt.group_id,
        groupName: group?.name ?? "Modifier",
        name: opt.name,
        priceDelta: opt.price_delta,
      };
    });

    return {
      id: `item-${index}`,
      productId: product.id,
      productName: product.name,
      productSku: product.sku,
      unitPrice: product.price,
      quantity: item.quantity,
      notes: item.notes ?? undefined,
      modifiers: itemModifiers,
      kitchenStation: product.kitchen_station,
    };
  });

  const totals = calculateCartTotals(cartItems, taxPercent, serviceChargePercent);

  // Siapkan payload atomic untuk RPC
  const itemsPayload = cartItems.map((cItem, idx) => {
    const modifierTotal = cItem.modifiers.reduce(
      (sum, m) => sum + m.priceDelta,
      0,
    );
    const subtotal = (cItem.unitPrice + modifierTotal) * cItem.quantity;

    return {
      client_item_id: input.items[idx]?.clientItemId || cItem.id,
      product_id: cItem.productId,
      product_name_snapshot: cItem.productName,
      product_sku_snapshot: cItem.productSku ?? null,
      unit_price_snapshot: cItem.unitPrice,
      quantity: cItem.quantity,
      notes: cItem.notes ?? null,
      modifier_total: modifierTotal,
      subtotal,
      line_total: subtotal,
      kitchen_station: cItem.kitchenStation ?? null,
      modifiers: cItem.modifiers.map((mod) => ({
        modifier_option_id: mod.optionId,
        group_name_snapshot: mod.groupName,
        option_name_snapshot: mod.name,
        price_delta_snapshot: mod.priceDelta,
      })),
    };
  });

  const discountsPayload = (input.discounts ?? []).map((d) => ({
    scope: d.scope,
    client_item_id: d.clientItemId || null,
    order_item_id: d.orderItemId || null,
    discount_id: d.discountId || null,
    name: d.name || null,
    discount_type: d.discountType,
    discount_rate: d.discountRate,
    approval_nonce: d.approvalNonce || null,
    reason: d.reason || null,
  }));

  const orderPayload = {
    order_type: input.orderType,
    table_id: targetTableId,
    customer_name: input.customerName ? input.customerName.trim() : null,
    subtotal: totals.subtotal,
    tax_percent: totals.taxPercent,
    tax_total: totals.taxTotal,
    service_charge_percent: totals.serviceChargePercent,
    service_total: totals.serviceTotal,
    grand_total: totals.grandTotal,
    idempotency_key: input.idempotencyKey || null,
    notes: input.notes ? input.notes.trim() : null,
  };

  // 8. Eksekusi Atomic RPC (H-1 & F1.4 3-parameter)
  const { data: rpcData, error: rpcError } = await context.supabase.rpc(
    "create_pos_order_atomic",
    {
      p_order: orderPayload,
      p_items: itemsPayload,
      p_discounts: discountsPayload,
    },
  );

  let finalOrderId: string | null = null;
  let finalOrderNumber = "";

  if (!rpcError && rpcData) {
    const res = rpcData as {
      id: string;
      order_number: string;
      is_duplicate?: boolean;
    };
    finalOrderId = res.id;
    finalOrderNumber = res.order_number;

    if (res.is_duplicate) {
      const fullExisting = await fetchFullOrderDetails(
        context.supabase,
        res.id,
        tableNameSnapshot,
      );
      return {
        ok: true,
        message: `Pesanan ${res.order_number} sudah tersimpan sebelumnya.`,
        data: fullExisting ?? undefined,
      };
    }
  } else {
    // Jika RPC belum ada di remote DB (PGRST202), jalankan fallback dengan rollback kompensasi
    if (
      rpcError?.code === "PGRST202" ||
      rpcError?.message.includes("create_pos_order_atomic")
    ) {
      let targetSessionId: string | null = null;

      if (input.orderType === "dine_in" && targetTableId) {
        const { data: existingSession } = await context.supabase
          .from("dining_sessions")
          .select("id, status")
          .eq("table_id", targetTableId)
          .eq("status", "open")
          .maybeSingle<DiningSession>();

        if (existingSession) {
          targetSessionId = existingSession.id;
        } else {
          const { data: newSession, error: sessionError } = await context.supabase
            .from("dining_sessions")
            .insert({
              table_id: targetTableId,
              status: "open",
              opened_by: context.actor.user.id,
            })
            .select("id")
            .single<{ id: string }>();

          if (sessionError || !newSession) {
            return {
              ok: false,
              message: "Gagal membuka sesi kunjungan dine-in untuk meja ini.",
            };
          }

          targetSessionId = newSession.id;
        }

        await context.supabase
          .from("dining_tables")
          .update({ status: "awaiting_payment" })
          .eq("id", targetTableId);
      }

      const { data: createdOrder, error: insertError } = await context.supabase
        .from("orders")
        .insert({
          ...orderPayload,
          dining_session_id: targetSessionId,
          status: "awaiting_payment",
          payment_status: "unpaid",
          discount_product_total: 0,
          discount_order_total: 0,
          discount_manual_total: 0,
          discount_total: 0,
          paid_total: 0,
          created_by: context.actor.user.id,
        })
        .select("*")
        .single<Order>();

      if (insertError || !createdOrder) {
        return {
          ok: false,
          message: "Gagal menyimpan pesanan ke database. Silakan coba lagi.",
        };
      }

      finalOrderId = createdOrder.id;
      finalOrderNumber = createdOrder.order_number;

      // Insert items & rollback jika gagal
      let insertItemFailed = false;
      for (const itemP of itemsPayload) {
        const { data: insertedItem, error: itemError } = await context.supabase
          .from("order_items")
          .insert({
            order_id: createdOrder.id,
            product_id: itemP.product_id,
            product_name_snapshot: itemP.product_name_snapshot,
            product_sku_snapshot: itemP.product_sku_snapshot,
            unit_price_snapshot: itemP.unit_price_snapshot,
            quantity: itemP.quantity,
            notes: itemP.notes,
            modifier_total: itemP.modifier_total,
            subtotal: itemP.subtotal,
            discount_amount: 0,
            line_total: itemP.line_total,
            kitchen_station: itemP.kitchen_station,
          })
          .select("id")
          .single<{ id: string }>();

        if (itemError || !insertedItem) {
          insertItemFailed = true;
          break;
        }

        if (itemP.modifiers.length > 0) {
          const modRows = itemP.modifiers.map((m) => ({
            order_item_id: insertedItem.id,
            modifier_option_id: m.modifier_option_id,
            group_name_snapshot: m.group_name_snapshot,
            option_name_snapshot: m.option_name_snapshot,
            price_delta_snapshot: m.price_delta_snapshot,
          }));

          const { error: modError } = await context.supabase
            .from("order_item_modifiers")
            .insert(modRows);

          if (modError) {
            insertItemFailed = true;
            break;
          }
        }
      }

      if (insertItemFailed) {
        // Rollback kompensasi
        await context.supabase.from("orders").delete().eq("id", createdOrder.id);
        return {
          ok: false,
          message:
            "Terjadi kesalahan saat menyimpan item pesanan. Seluruh proses dibatalkan.",
        };
      }
    } else {
      return {
        ok: false,
        message: rpcError?.message || "Gagal menyimpan pesanan.",
      };
    }
  }

  // 9. Audit Log
  await logAudit({
    action: "order.create",
    userId: context.actor.user.id,
    username: context.actor.profile.username,
    entity: "order",
    entityId: finalOrderId!,
    details: {
      order_number: finalOrderNumber,
      order_type: input.orderType,
      table_id: targetTableId,
      table_name: tableNameSnapshot,
      grand_total: totals.grandTotal,
      item_count: cartItems.length,
      status: "awaiting_payment",
    },
  });

  revalidatePosPaths();

  const fullOrderDetails = await fetchFullOrderDetails(
    context.supabase,
    finalOrderId!,
    tableNameSnapshot,
  );

  return {
    ok: true,
    message: `Pesanan ${finalOrderNumber} berhasil dibuat (Menunggu Pembayaran).`,
    data: fullOrderDetails ?? undefined,
  };
}

/**
 * Menambahkan item ke pesanan yang belum dibayar (awaiting_payment).
 * FR-POS-08 & H-2: Menggunakan atomic RPC append_order_items_atomic.
 */
export async function appendOrderItemsAction(
  rawInput: unknown,
): Promise<OrderActionResult> {
  const contextResult = await getActionContext();
  if (!contextResult.ok) return contextResult.result;

  const { context } = contextResult;

  const parsed = appendOrderItemsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const input = parsed.data;

  // 1. Ambil & validasi pesanan target
  const { data: existingOrder, error: orderError } = await context.supabase
    .from("orders")
    .select("*")
    .eq("id", input.orderId)
    .maybeSingle<Order>();

  if (orderError || !existingOrder) {
    return { ok: false, message: "Pesanan tidak ditemukan." };
  }

  if (
    existingOrder.status !== "awaiting_payment" ||
    existingOrder.payment_status !== "unpaid"
  ) {
    return {
      ok: false,
      message:
        "Hanya pesanan yang belum dibayar (Menunggu Pembayaran) yang dapat ditambah item.",
    };
  }

  if (existingOrder.is_finalized) {
    return {
      ok: false,
      message: "Pesanan sudah difinalisasi dan tidak dapat ditambah item baru.",
    };
  }

  // 2. Validasi Produk & Ketersediaan
  const productIds = Array.from(new Set(input.items.map((i) => i.productId)));
  const { data: productsData, error: productsError } = await context.supabase
    .from("products")
    .select("id, name, sku, price, is_active, is_available, kitchen_station")
    .in("id", productIds);

  if (productsError) {
    return { ok: false, message: "Gagal mengambil data produk menu." };
  }

  const products = (productsData ?? []) as Product[];
  const productMap = new Map(products.map((p) => [p.id, p]));

  for (const item of input.items) {
    const product = productMap.get(item.productId);
    if (!product || !product.is_active) {
      return {
        ok: false,
        message: "Terdapat produk yang tidak aktif atau tidak ditemukan.",
      };
    }
    if (!product.is_available) {
      return {
        ok: false,
        message: `Produk "${product.name}" sedang tidak tersedia / habis.`,
      };
    }
  }

  // 3. Validasi Aturan Modifier per Produk
  const optionIds = Array.from(
    new Set(input.items.flatMap((i) => i.modifierOptionIds ?? [])),
  );

  let optionMap = new Map<string, ModifierOption>();
  if (optionIds.length > 0) {
    const { data: optionsData, error: optionsError } = await context.supabase
      .from("modifier_options")
      .select("id, group_id, name, price_delta, is_active")
      .in("id", optionIds);

    if (optionsError) {
      return { ok: false, message: "Gagal mengambil data modifier pilihan." };
    }

    const options = (optionsData ?? []) as ModifierOption[];
    optionMap = new Map(options.map((o) => [o.id, o]));
  }

  const { data: pmgData } = await context.supabase
    .from("product_modifier_groups")
    .select("product_id, modifier_group_id")
    .in("product_id", productIds);

  const groupIds = Array.from(
    new Set((pmgData ?? []).map((pmg) => pmg.modifier_group_id)),
  );

  let groupMap = new Map<string, ModifierGroup>();
  if (groupIds.length > 0) {
    const { data: groupsData } = await context.supabase
      .from("modifier_groups")
      .select(
        "id, name, selection_type, is_required, min_select, max_select, is_active",
      )
      .in("id", groupIds);

    const groups = (groupsData ?? []) as ModifierGroup[];
    groupMap = new Map(groups.map((g) => [g.id, g]));
  }

  const productGroupsMap = new Map<string, string[]>();
  for (const pmg of pmgData ?? []) {
    const existing = productGroupsMap.get(pmg.product_id) ?? [];
    existing.push(pmg.modifier_group_id);
    productGroupsMap.set(pmg.product_id, existing);
  }

  for (const item of input.items) {
    const product = productMap.get(item.productId)!;
    const applicableGroupIds = productGroupsMap.get(item.productId) ?? [];

    for (const gId of applicableGroupIds) {
      const group = groupMap.get(gId);
      if (!group || !group.is_active) continue;

      const selectedInGroup = (item.modifierOptionIds ?? []).filter((optId) => {
        const opt = optionMap.get(optId);
        return opt && opt.group_id === gId && opt.is_active;
      });

      if (group.is_required && selectedInGroup.length === 0) {
        return {
          ok: false,
          message: `Produk "${product.name}" mewajibkan pilihan pada grup modifier "${group.name}".`,
        };
      }

      if (selectedInGroup.length < group.min_select) {
        return {
          ok: false,
          message: `Modifier "${group.name}" pada "${product.name}" minimal memilih ${group.min_select} opsi.`,
        };
      }

      if (selectedInGroup.length > group.max_select) {
        return {
          ok: false,
          message: `Modifier "${group.name}" pada "${product.name}" maksimal memilih ${group.max_select} opsi.`,
        };
      }
    }
  }

  // 4. Hitung Delta Subtotal, Pajak, Service Charge, Grand Total
  let subtotalDelta = 0;
  const itemsPayload = input.items.map((item) => {
    const product = productMap.get(item.productId)!;
    const itemMods = (item.modifierOptionIds ?? []).map((optId) => {
      const opt = optionMap.get(optId)!;
      const group = groupMap.get(opt.group_id);
      return {
        modifier_option_id: opt.id,
        group_name_snapshot: group?.name ?? "Modifier",
        option_name_snapshot: opt.name,
        price_delta_snapshot: opt.price_delta,
      };
    });

    const modifierTotal = itemMods.reduce((s, m) => s + m.price_delta_snapshot, 0);
    const lineTotal = (product.price + modifierTotal) * item.quantity;
    subtotalDelta += lineTotal;

    return {
      product_id: product.id,
      product_name_snapshot: product.name,
      product_sku_snapshot: product.sku ?? null,
      unit_price_snapshot: product.price,
      quantity: item.quantity,
      notes: item.notes ?? null,
      modifier_total: modifierTotal,
      subtotal: lineTotal,
      line_total: lineTotal,
      kitchen_station: product.kitchen_station ?? null,
      modifiers: itemMods,
    };
  });

  const taxPercent = Number(existingOrder.tax_percent) || 0;
  const serviceChargePercent = Number(existingOrder.service_charge_percent) || 0;
  const taxDelta = Math.round((subtotalDelta * taxPercent) / 100);
  const serviceDelta = Math.round((subtotalDelta * serviceChargePercent) / 100);
  const grandTotalDelta = subtotalDelta + taxDelta + serviceDelta;

  // 5. Eksekusi Atomic RPC (H-2)
  const { error: rpcError } = await context.supabase.rpc(
    "append_order_items_atomic",
    {
      p_order_id: existingOrder.id,
      p_items: itemsPayload,
      p_subtotal_delta: subtotalDelta,
      p_tax_delta: taxDelta,
      p_service_delta: serviceDelta,
      p_grand_total_delta: grandTotalDelta,
    },
  );

  if (rpcError) {
    if (
      rpcError.code === "PGRST202" ||
      rpcError.message.includes("append_order_items_atomic")
    ) {
      // Fallback manual execution
      for (const itemP of itemsPayload) {
        const { data: insertedItem, error: itemError } = await context.supabase
          .from("order_items")
          .insert({
            order_id: existingOrder.id,
            product_id: itemP.product_id,
            product_name_snapshot: itemP.product_name_snapshot,
            product_sku_snapshot: itemP.product_sku_snapshot,
            unit_price_snapshot: itemP.unit_price_snapshot,
            quantity: itemP.quantity,
            notes: itemP.notes,
            modifier_total: itemP.modifier_total,
            subtotal: itemP.subtotal,
            discount_amount: 0,
            line_total: itemP.line_total,
            kitchen_station: itemP.kitchen_station,
          })
          .select("id")
          .single<{ id: string }>();

        if (itemError || !insertedItem) {
          return { ok: false, message: "Gagal menambahkan item ke pesanan." };
        }

        if (itemP.modifiers.length > 0) {
          const modRows = itemP.modifiers.map((m) => ({
            order_item_id: insertedItem.id,
            modifier_option_id: m.modifier_option_id,
            group_name_snapshot: m.group_name_snapshot,
            option_name_snapshot: m.option_name_snapshot,
            price_delta_snapshot: m.price_delta_snapshot,
          }));
          await context.supabase.from("order_item_modifiers").insert(modRows);
        }
      }

      await context.supabase
        .from("orders")
        .update({
          subtotal: existingOrder.subtotal + subtotalDelta,
          tax_total: existingOrder.tax_total + taxDelta,
          service_total: existingOrder.service_total + serviceDelta,
          grand_total: existingOrder.grand_total + grandTotalDelta,
        })
        .eq("id", existingOrder.id);
    } else {
      return {
        ok: false,
        message: rpcError.message || "Gagal menambahkan item ke pesanan.",
      };
    }
  }

  // 6. Audit Log
  await logAudit({
    action: "order.append_items",
    userId: context.actor.user.id,
    username: context.actor.profile.username,
    entity: "order",
    entityId: existingOrder.id,
    details: {
      order_number: existingOrder.order_number,
      appended_items_count: itemsPayload.length,
      subtotal_delta: subtotalDelta,
      grand_total_delta: grandTotalDelta,
      new_grand_total: existingOrder.grand_total + grandTotalDelta,
    },
  });

  revalidatePosPaths();

  const fullOrder = await fetchFullOrderDetails(context.supabase, existingOrder.id);

  return {
    ok: true,
    message: `Berhasil menambahkan item ke pesanan ${existingOrder.order_number}.`,
    data: fullOrder ?? undefined,
  };
}

/**
 * Membatalkan pesanan yang belum dibayar dengan alasan wajib.
 */
export async function cancelPosOrderAction(
  orderId: string,
  reason: string,
): Promise<OrderActionResult> {
  const contextResult = await getActionContext();
  if (!contextResult.ok) return contextResult.result;

  const { context } = contextResult;

  const parsed = cancelOrderSchema.safeParse({ orderId, reason });
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  // Panggil fungsi tersimpan cancel_pos_order jika tersedia
  const { data: rpcData, error: rpcError } = await context.supabase.rpc(
    "cancel_pos_order",
    {
      p_order_id: parsed.data.orderId,
      p_cancel_reason: parsed.data.reason,
    },
  );

  if (rpcError) {
    // Jika function belum ada di remote DB (PGRST202), gunakan query update langsung
    if (
      rpcError.code === "PGRST202" ||
      rpcError.message.includes("cancel_pos_order")
    ) {
      const { data: existingOrder } = await context.supabase
        .from("orders")
        .select("*")
        .eq("id", parsed.data.orderId)
        .maybeSingle<Order>();

      if (!existingOrder) {
        return { ok: false, message: "Pesanan tidak ditemukan." };
      }

      if (
        existingOrder.status !== "awaiting_payment" ||
        existingOrder.payment_status !== "unpaid"
      ) {
        return {
          ok: false,
          message:
            "Hanya pesanan yang belum dibayar (Menunggu Pembayaran) yang dapat dibatalkan.",
        };
      }

      const { data: updatedOrder, error: updateError } = await context.supabase
        .from("orders")
        .update({
          status: "cancelled",
          cancelled_by: context.actor.user.id,
          cancelled_at: new Date().toISOString(),
          cancel_reason: parsed.data.reason,
        })
        .eq("id", parsed.data.orderId)
        .select("*")
        .single<Order>();

      if (updateError || !updatedOrder) {
        return { ok: false, message: "Gagal membatalkan pesanan." };
      }

      // Evaluasi meja jika dine-in
      if (
        existingOrder.order_type === "dine_in" &&
        existingOrder.dining_session_id
      ) {
        const { count } = await context.supabase
          .from("orders")
          .select("id", { count: "exact", head: true })
          .eq("dining_session_id", existingOrder.dining_session_id)
          .in("status", ["awaiting_payment", "partially_paid", "paid"])
          .neq("id", existingOrder.id);

        if ((count ?? 0) === 0) {
          await context.supabase
            .from("dining_sessions")
            .update({
              status: "cancelled",
              closed_at: new Date().toISOString(),
              closed_by: context.actor.user.id,
            })
            .eq("id", existingOrder.dining_session_id);

          if (existingOrder.table_id) {
            await context.supabase
              .from("dining_tables")
              .update({ status: "empty" })
              .eq("id", existingOrder.table_id);
          }
        }
      }

      await logAudit({
        action: "order.cancel",
        userId: context.actor.user.id,
        username: context.actor.profile.username,
        entity: "order",
        entityId: updatedOrder.id,
        details: {
          order_number: updatedOrder.order_number,
          reason: parsed.data.reason,
          order_type: updatedOrder.order_type,
          table_id: updatedOrder.table_id,
        },
      });

      revalidatePosPaths();
      return {
        ok: true,
        message: `Pesanan ${updatedOrder.order_number} berhasil dibatalkan.`,
      };
    }

    return {
      ok: false,
      message: rpcError.message || "Gagal membatalkan pesanan.",
    };
  }

  // Sukses via RPC
  await logAudit({
    action: "order.cancel",
    userId: context.actor.user.id,
    username: context.actor.profile.username,
    entity: "order",
    entityId: parsed.data.orderId,
    details: {
      reason: parsed.data.reason,
      rpc_result: rpcData,
    },
  });

  revalidatePosPaths();
  return {
    ok: true,
    message: "Pesanan berhasil dibatalkan.",
  };
}

/**
 * Mengambil pesanan aktif belum lunas untuk suatu meja.
 */
export async function getActiveOrderForTableAction(
  tableId: string,
): Promise<OrderActionResult> {
  const contextResult = await getActionContext();
  if (!contextResult.ok) return contextResult.result;

  const { context } = contextResult;

  const validTableId = tableIdSchema.safeParse(tableId);
  if (!validTableId.success) {
    return { ok: false, message: "ID meja tidak valid." };
  }

  const { data: orderData, error: orderError } = await context.supabase
    .from("orders")
    .select("*")
    .eq("table_id", validTableId.data)
    .eq("status", "awaiting_payment")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<Order>();

  if (orderError) {
    return { ok: false, message: "Gagal mengambil data pesanan meja." };
  }

  if (!orderData) {
    return {
      ok: false,
      message: "Tidak ada pesanan aktif yang menunggu pembayaran di meja ini.",
    };
  }

  const fullOrder = await fetchFullOrderDetails(context.supabase, orderData.id);

  return {
    ok: true,
    data: fullOrder ?? {
      ...orderData,
      items: [],
    },
  };
}
