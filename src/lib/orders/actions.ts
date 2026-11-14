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
  DiningSessionOrderSummary,
  DiningSessionSummary,
  OrderItemWithModifiers,
  OrderWithDetails,
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

  // 6. Validasi Meja & Kunjungan Dine-in (F2.3)
  let targetTableId: string | null = null;
  let tableNameSnapshot: string | null = null;
  let tableStatusSnapshot: string | null = null;

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

    // F2.3: Aturan Status Meja:
    // - empty: order baru & sesi baru diizinkan.
    // - occupied: order tambahan pada sesi aktif diizinkan.
    // - awaiting_payment: dilarang membuat order baru (harus melalui appendOrderItemsAction).
    // - maintenance / reserved: ditolak.
    if (table.status === "awaiting_payment") {
      return {
        ok: false,
        message: `Meja "${table.name}" sedang menunggu pembayaran (awaiting_payment). Dilarang membuat pesanan baru; gunakan penambahan item pada pesanan aktif.`,
      };
    }

    const statusVal = table.status as string;
    if (statusVal === "maintenance") {
      return {
        ok: false,
        message: `Meja "${table.name}" sedang dalam perbaikan (maintenance).`,
      };
    }
    if (statusVal === "reserved") {
      return {
        ok: false,
        message: `Meja "${table.name}" sudah dipesan (reserved).`,
      };
    }

    tableNameSnapshot = table.name;
    tableStatusSnapshot = table.status;
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

        // F2.3: Meja awaiting_payment dilarang membuat order baru
        if (tableStatusSnapshot === "awaiting_payment") {
          return {
            ok: false,
            message: `Meja ${tableNameSnapshot ?? "ini"} sedang menunggu pembayaran (awaiting_payment). Dilarang membuat pesanan baru; gunakan penambahan item pada pesanan aktif.`,
          };
        }

        // F2.3 Strict Anomaly Rejection: jika meja occupied tetapi tidak memiliki sesi dining aktif
        if (tableStatusSnapshot === "occupied" && !existingSession) {
          return {
            ok: false,
            message: `Inkonsistensi data meja: Meja ${tableNameSnapshot ?? "ini"} (status: occupied) tidak memiliki sesi dining aktif.`,
          };
        }

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

  // Panggil fungsi tersimpan cancel_pos_order resmi (p_order_id, p_cancel_reason)
  const { data: rpcData, error: rpcError } = await context.supabase.rpc(
    "cancel_pos_order",
    {
      p_order_id: parsed.data.orderId,
      p_cancel_reason: parsed.data.reason,
    },
  );

  if (rpcError) {
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

/**
 * F2.3: Konfirmasi penyerahan pesanan (paid -> completed).
 * Dilakukan secara eksplisit oleh kasir/admin saat pesanan selesai diserahkan ke pelanggan.
 * Mencegah status paid diubah secara otomatis oleh sistem saat penutupan sesi.
 */
export async function completePosOrderAction(
  orderId: string,
): Promise<OrderActionResult> {
  const contextResult = await getActionContext();
  if (!contextResult.ok) return contextResult.result;

  const { context } = contextResult;

  if (!orderId || typeof orderId !== "string") {
    return { ok: false, message: "ID pesanan tidak valid." };
  }

  // Coba jalankan RPC atomik complete_pos_order
  const { data: rpcData, error: rpcError } = await context.supabase.rpc(
    "complete_pos_order",
    { p_order_id: orderId },
  );

  if (!rpcError && rpcData) {
    await logAudit({
      action: "order.completed",
      userId: context.actor.user.id,
      username: context.actor.profile.username,
      entity: "order",
      entityId: orderId,
      details: { order_id: orderId },
    });

    revalidatePath("/pos");
    revalidatePath("/pos/floor");
    revalidatePath("/orders");
    revalidatePath("/kds");

    const fullOrder = await fetchFullOrderDetails(context.supabase, orderId);

    return {
      ok: true,
      message: "Pesanan berhasil diserahkan ke pelanggan dan diselesaikan.",
      data: fullOrder ?? undefined,
    };
  }

  // Fallback jika RPC belum ada di database
  if (
    rpcError?.code === "PGRST202" ||
    rpcError?.message?.includes("complete_pos_order")
  ) {
    const { data: order, error: orderError } = await context.supabase
      .from("orders")
      .select("*")
      .eq("id", orderId)
      .maybeSingle<Order>();

    if (orderError || !order) {
      return { ok: false, message: "Pesanan tidak ditemukan." };
    }

    if (order.status === "completed") {
      return {
        ok: true,
        message: `Pesanan ${order.order_number} sudah berstatus selesai.`,
      };
    }

    if (order.status !== "paid" || order.payment_status !== "paid") {
      return {
        ok: false,
        message: "Hanya pesanan yang sudah lunas (paid) yang dapat diselesaikan.",
      };
    }

    const { error: updateError } = await context.supabase
      .from("orders")
      .update({
        status: "completed",
        kds_status: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId);

    if (updateError) {
      return { ok: false, message: "Gagal memperbarui status penyelesaian pesanan." };
    }

    await logAudit({
      action: "order.completed",
      userId: context.actor.user.id,
      username: context.actor.profile.username,
      entity: "order",
      entityId: orderId,
      details: { order_number: order.order_number },
    });

    revalidatePath("/pos");
    revalidatePath("/pos/floor");
    revalidatePath("/orders");
    revalidatePath("/kds");

    const fullOrder = await fetchFullOrderDetails(context.supabase, orderId);

    return {
      ok: true,
      message: `Pesanan ${order.order_number} berhasil diselesaikan.`,
      data: fullOrder ?? undefined,
    };
  }

  return {
    ok: false,
    message: rpcError?.message || "Gagal mengonfirmasi penyelesaian pesanan.",
  };
}

/**
 * F2.3: Menutup sesi kunjungan meja secara atomik (close_dining_session_atomic).
 * Menjalankan 7 pintu validasi proteksi sebelum mengubah status sesi 'closed' dan meja 'empty'.
 */
export async function closeDiningSessionAction(
  tableId: string,
  sessionId: string,
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  const contextResult = await getActionContext();
  if (!contextResult.ok) return { ok: false, message: contextResult.result.message ?? "Autentikasi gagal." };

  const { context } = contextResult;

  if (!tableId || !sessionId) {
    return { ok: false, message: "ID meja dan sesi kunjungan wajib diisi." };
  }

  // Coba jalankan RPC close_dining_session_atomic
  const { data: rpcData, error: rpcError } = await context.supabase.rpc(
    "close_dining_session_atomic",
    {
      p_table_id: tableId,
      p_session_id: sessionId,
    },
  );

  if (!rpcError && rpcData) {
    await logAudit({
      action: "table.session_closed",
      userId: context.actor.user.id,
      username: context.actor.profile.username,
      entity: "dining_session",
      entityId: sessionId,
      details: { table_id: tableId, session_id: sessionId },
    });

    revalidatePath("/pos");
    revalidatePath("/pos/floor");
    revalidatePath("/tables");

    return {
      ok: true,
      message: "Sesi kunjungan berhasil ditutup. Meja kini berstatus kosong.",
      data: rpcData,
    };
  }

  // Fallback jika RPC belum ada di database
  if (
    rpcError?.code === "PGRST202" ||
    rpcError?.message?.includes("close_dining_session_atomic")
  ) {
    // 7 Pintu Validasi Ketat di fallback
    const { data: ordersData, error: ordersError } = await context.supabase
      .from("orders")
      .select("id, order_number, status, payment_status, kds_status, grand_total, paid_total")
      .eq("dining_session_id", sessionId);

    if (ordersError) {
      return { ok: false, message: "Gagal memverifikasi pesanan pada sesi ini." };
    }

    const orders = ordersData ?? [];

    // Pintu 1: Pesanan belum lunas
    const unpaidOrders = orders.filter((o) =>
      ["awaiting_payment", "partially_paid"].includes(o.status),
    );
    if (unpaidOrders.length > 0) {
      return {
        ok: false,
        message: `Tidak dapat menutup sesi: Terdapat ${unpaidOrders.length} pesanan yang belum lunas.`,
      };
    }

    // Pintu 2: Sisa saldo belum dibayar
    const remainingBalance = orders
      .filter((o) => !["cancelled", "refunded"].includes(o.status))
      .reduce((sum, o) => sum + Math.max(0, (o.grand_total || 0) - (o.paid_total || 0)), 0);

    if (remainingBalance > 0) {
      return {
        ok: false,
        message: `Tidak dapat menutup sesi: Masih ada sisa tagihan sebesar Rp ${remainingBalance.toLocaleString("id-ID")}.`,
      };
    }

    // Pintu 3 & 4: Alokasi split bill reserved & Midtrans non-terminal
    const orderIds = orders.map((o) => o.id);
    if (orderIds.length > 0) {
      const { count: reservedCount } = await context.supabase
        .from("order_allocations")
        .select("id", { count: "exact", head: true })
        .in("order_id", orderIds)
        .eq("allocation_status", "reserved");

      if ((reservedCount ?? 0) > 0) {
        return {
          ok: false,
          message: "Tidak dapat menutup sesi: Terdapat alokasi split bill yang masih berstatus reserved.",
        };
      }

      const { count: pendingTrxCount } = await context.supabase
        .from("midtrans_transactions")
        .select("id", { count: "exact", head: true })
        .in("order_id", orderIds)
        .in("lifecycle_status", [
          "initiated",
          "token_created",
          "pending",
          "capture_challenge",
          "reconciliation_required",
        ]);

      if ((pendingTrxCount ?? 0) > 0) {
        return {
          ok: false,
          message: "Tidak dapat menutup sesi: Terdapat transaksi Midtrans yang masih aktif / belum terminal.",
        };
      }
    }

    // Pintu 6: Pesanan belum diserahkan (status paid)
    const uncompletedOrders = orders.filter((o) => o.status === "paid");
    if (uncompletedOrders.length > 0) {
      return {
        ok: false,
        message: `Tidak dapat menutup sesi: Terdapat ${uncompletedOrders.length} pesanan yang lunas tetapi belum diserahkan ke pelanggan (status belum completed).`,
      };
    }

    // Pintu 7: KDS aktif
    const activeKdsOrders = orders.filter((o) =>
      ["queued", "preparing", "ready"].includes(o.kds_status ?? ""),
    );
    if (activeKdsOrders.length > 0) {
      return {
        ok: false,
        message: "Tidak dapat menutup sesi: Terdapat pesanan yang masih dalam antrean dapur atau siap diambil (kds_status: queued/preparing/ready).",
      };
    }

    // Eksekusi penutupan sesi & pengosongan meja
    const nowIso = new Date().toISOString();
    await context.supabase
      .from("dining_sessions")
      .update({
        status: "closed",
        closed_at: nowIso,
        closed_by: context.actor.user.id,
        updated_at: nowIso,
      })
      .eq("id", sessionId);

    await context.supabase
      .from("dining_tables")
      .update({
        status: "empty",
        updated_at: nowIso,
      })
      .eq("id", tableId);

    await logAudit({
      action: "table.session_closed",
      userId: context.actor.user.id,
      username: context.actor.profile.username,
      entity: "dining_session",
      entityId: sessionId,
      details: { table_id: tableId, orders_count: orders.length },
    });

    revalidatePath("/pos");
    revalidatePath("/pos/floor");
    revalidatePath("/tables");

    return {
      ok: true,
      message: "Sesi kunjungan berhasil ditutup. Meja kini berstatus kosong.",
    };
  }

  return {
    ok: false,
    message: rpcError?.message || "Gagal menutup sesi kunjungan meja.",
  };
}

/**
 * F2.3: Mengambil ringkasan sesi kunjungan aktif meja beserta seluruh pesanannya.
 */
export async function getDiningSessionSummaryAction(
  tableId: string,
): Promise<{ ok: boolean; message?: string; data?: DiningSessionSummary | null }> {
  const contextResult = await getActionContext();
  if (!contextResult.ok) return { ok: false, message: contextResult.result.message ?? "Autentikasi gagal." };

  const { context } = contextResult;

  if (!["admin", "kasir"].includes(context.actor.profile.role)) {
    return {
      ok: false,
      message: "Hanya admin atau kasir yang berhak mengakses ringkasan sesi meja.",
    };
  }

  if (!tableId) {
    return { ok: false, message: "ID meja tidak valid." };
  }

  // Coba RPC get_dining_session_summary
  const { data: rpcData, error: rpcError } = await context.supabase.rpc(
    "get_dining_session_summary",
    { p_table_id: tableId },
  );

  if (!rpcError && rpcData) {
    return { ok: true, data: rpcData as DiningSessionSummary };
  }

  // Fallback query jika RPC belum ada
  if (
    rpcError?.code === "PGRST202" ||
    rpcError?.message?.includes("get_dining_session_summary")
  ) {
    const { data: table } = await context.supabase
      .from("dining_tables")
      .select("id, name, status")
      .eq("id", tableId)
      .maybeSingle<DiningTable>();

    if (!table) {
      return { ok: false, message: "Meja tidak ditemukan." };
    }

    const { data: session } = await context.supabase
      .from("dining_sessions")
      .select("id, status, opened_at")
      .eq("table_id", tableId)
      .eq("status", "open")
      .maybeSingle<DiningSession>();

    if (!session) {
      return {
        ok: true,
        data: {
          table_id: table.id,
          table_name: table.name,
          table_status: table.status,
          has_active_session: false,
          total_orders: 0,
          unpaid_orders_count: 0,
          uncompleted_orders_count: 0,
          completed_orders_count: 0,
          reserved_allocations_count: 0,
          pending_midtrans_transactions_count: 0,
          processing_webhooks_count: 0,
          session_subtotal: 0,
          session_discount_total: 0,
          session_tax_total: 0,
          session_service_total: 0,
          session_grand_total: 0,
          session_paid_total: 0,
          session_remaining_balance: 0,
          can_close_session: false,
          blocking_reason: "Meja tidak memiliki sesi dining aktif.",
          orders: [],
        },
      };
    }

    const { data: ordersData } = await context.supabase
      .from("orders")
      .select(
        "id, order_number, status, payment_status, kds_status, subtotal, discount_total, tax_total, service_total, grand_total, paid_total, created_at",
      )
      .eq("dining_session_id", session.id)
      .order("created_at", { ascending: true });

    const orders: DiningSessionOrderSummary[] = (ordersData ?? []).map((o) => ({
      id: o.id,
      order_number: o.order_number,
      status: o.status,
      payment_status: o.payment_status,
      kds_status: o.kds_status,
      subtotal: Number(o.subtotal) || 0,
      discount_total: Number(o.discount_total) || 0,
      tax_total: Number(o.tax_total) || 0,
      service_total: Number(o.service_total) || 0,
      grand_total: Number(o.grand_total) || 0,
      paid_total: Number(o.paid_total) || 0,
      remaining_balance: Math.max(0, (Number(o.grand_total) || 0) - (Number(o.paid_total) || 0)),
      created_at: o.created_at,
    }));

    const unpaidCount = orders.filter((o) =>
      ["awaiting_payment", "partially_paid"].includes(o.status),
    ).length;
    const uncompletedCount = orders.filter((o) => o.status === "paid").length;
    const completedCount = orders.filter((o) => o.status === "completed").length;
    const activeKdsCount = orders.filter((o) =>
      ["queued", "preparing", "ready"].includes(o.kds_status ?? ""),
    ).length;

    const orderIds = orders.map((o) => o.id);
    let reservedAllocCount = 0;
    let pendingTrxCount = 0;
    let processingWebhookCount = 0;

    if (orderIds.length > 0) {
      const { count: resAllocCount } = await context.supabase
        .from("order_allocations")
        .select("id", { count: "exact", head: true })
        .in("order_id", orderIds)
        .eq("allocation_status", "reserved");
      reservedAllocCount = resAllocCount ?? 0;

      const { data: nonTerminalTrx } = await context.supabase
        .from("midtrans_transactions")
        .select("id, midtrans_order_id")
        .in("order_id", orderIds)
        .in("lifecycle_status", [
          "initiated",
          "token_created",
          "pending",
          "capture_challenge",
          "reconciliation_required",
        ]);
      pendingTrxCount = nonTerminalTrx?.length ?? 0;

      const midtransOrderIds = (nonTerminalTrx ?? []).map((t) => t.midtrans_order_id);
      if (midtransOrderIds.length > 0) {
        const { count: procWbCount } = await context.supabase
          .from("midtrans_webhook_events")
          .select("id", { count: "exact", head: true })
          .in("midtrans_order_id", midtransOrderIds)
          .in("processing_result", ["received", "processing"]);
        processingWebhookCount = procWbCount ?? 0;
      }
    }

    const sessionSubtotal = orders
      .filter((o) => !["cancelled", "refunded"].includes(o.status))
      .reduce((sum, o) => sum + o.subtotal, 0);
    const sessionDiscountTotal = orders
      .filter((o) => !["cancelled", "refunded"].includes(o.status))
      .reduce((sum, o) => sum + o.discount_total, 0);
    const sessionTaxTotal = orders
      .filter((o) => !["cancelled", "refunded"].includes(o.status))
      .reduce((sum, o) => sum + o.tax_total, 0);
    const sessionServiceTotal = orders
      .filter((o) => !["cancelled", "refunded"].includes(o.status))
      .reduce((sum, o) => sum + o.service_total, 0);
    const sessionGrandTotal = orders
      .filter((o) => !["cancelled", "refunded"].includes(o.status))
      .reduce((sum, o) => sum + o.grand_total, 0);
    const sessionPaidTotal = orders
      .filter((o) => !["cancelled", "refunded"].includes(o.status))
      .reduce((sum, o) => sum + o.paid_total, 0);
    const sessionRemainingBalance = Math.max(0, sessionGrandTotal - sessionPaidTotal);

    let canClose = false;
    let blockingReason: string | null = null;

    if (unpaidCount > 0) {
      blockingReason = "Terdapat pesanan yang belum lunas.";
    } else if (sessionRemainingBalance > 0) {
      blockingReason = "Masih ada sisa tagihan belum dibayar.";
    } else if (reservedAllocCount > 0) {
      blockingReason = "Terdapat alokasi pembayaran split bill yang masih berstatus reserved.";
    } else if (pendingTrxCount > 0) {
      blockingReason = "Terdapat transaksi gateway Midtrans yang masih aktif / belum selesai.";
    } else if (processingWebhookCount > 0) {
      blockingReason = "Terdapat notifikasi pembayaran webhook Midtrans yang sedang diproses.";
    } else if (uncompletedCount > 0) {
      blockingReason = "Terdapat pesanan lunas yang belum diserahkan ke pelanggan.";
    } else if (activeKdsCount > 0) {
      blockingReason = "Terdapat pesanan yang masih diproses dapur atau siap diambil.";
    } else {
      canClose = true;
    }

    return {
      ok: true,
      data: {
        table_id: table.id,
        table_name: table.name,
        table_status: table.status,
        has_active_session: true,
        session_id: session.id,
        opened_at: session.opened_at,
        total_orders: orders.length,
        unpaid_orders_count: unpaidCount,
        uncompleted_orders_count: uncompletedCount,
        completed_orders_count: completedCount,
        reserved_allocations_count: reservedAllocCount,
        pending_midtrans_transactions_count: pendingTrxCount,
        processing_webhooks_count: processingWebhookCount,
        session_subtotal: sessionSubtotal,
        session_discount_total: sessionDiscountTotal,
        session_tax_total: sessionTaxTotal,
        session_service_total: sessionServiceTotal,
        session_grand_total: sessionGrandTotal,
        session_paid_total: sessionPaidTotal,
        session_remaining_balance: sessionRemainingBalance,
        can_close_session: canClose,
        blocking_reason: blockingReason,
        orders,
      },
    };
  }

  return {
    ok: false,
    message: rpcError?.message || "Gagal mengambil ringkasan sesi meja.",
  };
}
