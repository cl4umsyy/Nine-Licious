"use server";

import { getAdminActor } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  AdminTransactionDetail,
  AdminTransactionListItem,
  PaginatedTransactionsResult,
  TransactionActionResult,
  TransactionFilterInput,
} from "./types";
import {
  fieldErrorsFrom,
  firstZodError,
  transactionFilterSchema,
} from "./validation";
import type {
  Order,
  OrderDiscount,
  OrderItem,
  OrderItemModifier,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentRecordStatus,
  PaymentSource,
  PaymentStatus,
  RefundMethod,
  RefundRecordStatus,
  RefundType,
  ShiftStatus,
} from "@/types/database";

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RawShiftWithCashier = {
  id: string;
  cashier_id: string;
  opened_at: string;
  closed_at: string | null;
  status: ShiftStatus;
  opening_cash: number;
  expected_cash: number;
  actual_cash: number | null;
  cash_difference: number | null;
  notes: string | null;
  cashier?: { id: string; full_name: string; username: string } | null;
};

type RawPaymentWithProfile = {
  id: string;
  order_id: string;
  payment_method: PaymentMethod;
  payment_source: PaymentSource;
  amount: number;
  cash_received: number | null;
  change_amount: number;
  reference_number: string | null;
  payment_status: PaymentRecordStatus;
  shift_id: string | null;
  notes: string | null;
  created_at: string;
  profiles?: { full_name: string; username: string } | null;
};

type RawRefundWithProfiles = {
  id: string;
  order_id: string;
  payment_id: string | null;
  refund_number: string;
  gateway_refund_id: string | null;
  refund_type: RefundType;
  refund_method: RefundMethod;
  amount: number;
  reason: string;
  status: RefundRecordStatus;
  created_at: string;
  approved_at: string | null;
  requester?: { full_name: string; username: string } | null;
  approver?: { full_name: string; username: string } | null;
};

type RawMidtransRow = {
  id: string;
  order_id: string;
  midtrans_order_id: string;
  gross_amount: number;
  payment_type: string;
  lifecycle_status: string;
  settled_at: string | null;
  attempt_number: number;
  is_split_bill: boolean;
};

type RawCashMovementWithCreator = {
  id: string;
  shift_id: string | null;
  movement_type: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  reason: string;
  payment_id: string | null;
  refund_id: string | null;
  created_at: string;
  creator?: { full_name: string; username: string } | null;
};

/**
 * Mengambil daftar transaksi administratif dengan filter terpadu,
 * pencarian nomor pesanan/pelanggan, dan paginasi server-side.
 */
export async function getAdminTransactionsAction(
  rawInput?: TransactionFilterInput,
): Promise<TransactionActionResult<PaginatedTransactionsResult>> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const parsed = transactionFilterSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const filter = parsed.data;
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  // 1. Jika filter shiftId aktif, cari ID pesanan yang terhubung ke shift tersebut
  let shiftOrderIds: string[] | null = null;
  if (filter.shiftId && filter.shiftId !== "all") {
    const { data: pData, error: pErr } = await supabase
      .from("payments")
      .select("order_id")
      .eq("shift_id", filter.shiftId);

    if (pErr) {
      return { ok: false, message: `Gagal memfilter shift: ${pErr.message}` };
    }
    shiftOrderIds = Array.from(new Set((pData || []).map((p) => p.order_id)));
    if (shiftOrderIds.length === 0) {
      // Tidak ada pesanan untuk shift ini
      return {
        ok: true,
        message: "Data transaksi berhasil dimuat.",
        data: {
          items: [],
          totalCount: 0,
          page: filter.page,
          pageSize: filter.pageSize,
          totalPages: 0,
          metricSummary: {
            totalTransactions: 0,
            totalAmountSum: 0,
            paidAmountSum: 0,
            totalRefundedSum: 0,
          },
        },
      };
    }
  }

  // 2. Jika filter paymentMethod aktif, cari order_id yang sesuai
  let methodOrderIds: string[] | null = null;
  if (filter.paymentMethod && filter.paymentMethod !== "all") {
    const { data: paymentsAll, error: pmErr } = await supabase
      .from("payments")
      .select("order_id, payment_method, payment_status")
      .in("payment_status", ["success", "refunded"]);

    if (pmErr) {
      return { ok: false, message: `Gagal memfilter metode bayar: ${pmErr.message}` };
    }

    const paymentsByOrder = new Map<string, string[]>();
    for (const p of paymentsAll || []) {
      const list = paymentsByOrder.get(p.order_id) || [];
      list.push(p.payment_method);
      paymentsByOrder.set(p.order_id, list);
    }

    const matchedIds: string[] = [];
    for (const [oId, methods] of paymentsByOrder.entries()) {
      const distinctMethods = Array.from(new Set(methods));
      if (filter.paymentMethod === "split") {
        if (methods.length >= 2) {
          matchedIds.push(oId);
        }
      } else if (filter.paymentMethod === "cash") {
        if (distinctMethods.includes("cash") && methods.length === 1) {
          matchedIds.push(oId);
        }
      } else if (filter.paymentMethod === "midtrans") {
        if (distinctMethods.includes("midtrans") && methods.length === 1) {
          matchedIds.push(oId);
        }
      }
    }

    methodOrderIds = matchedIds;
    if (methodOrderIds.length === 0) {
      return {
        ok: true,
        message: "Data transaksi berhasil dimuat.",
        data: {
          items: [],
          totalCount: 0,
          page: filter.page,
          pageSize: filter.pageSize,
          totalPages: 0,
          metricSummary: {
            totalTransactions: 0,
            totalAmountSum: 0,
            paidAmountSum: 0,
            totalRefundedSum: 0,
          },
        },
      };
    }
  }

  // 3. Bangun query orders
  let query = supabase
    .from("orders")
    .select(
      "id, order_number, queue_number, queue_date, business_date, order_type, table_id, customer_name, status, payment_status, kds_status, grand_total, paid_total, refunded_total, created_by, created_at, updated_at",
      { count: "exact" },
    );

  // Filter Tanggal Asia/Jakarta
  if (filter.startDate) {
    query = query.gte("created_at", `${filter.startDate}T00:00:00+07:00`);
  }
  if (filter.endDate) {
    query = query.lte("created_at", `${filter.endDate}T23:59:59.999+07:00`);
  }

  // Filter Status
  if (filter.orderStatus && filter.orderStatus !== "all") {
    query = query.eq("status", filter.orderStatus);
  }
  if (filter.paymentStatus && filter.paymentStatus !== "all") {
    query = query.eq("payment_status", filter.paymentStatus);
  }

  // Filter Tipe Pesanan
  if (filter.orderType && filter.orderType !== "all") {
    query = query.eq("order_type", filter.orderType);
  }

  // Filter Kasir
  if (filter.cashierId && filter.cashierId !== "all") {
    query = query.eq("created_by", filter.cashierId);
  }

  // Filter gabungan Shift & Payment Method Order IDs
  let combinedAllowedIds: string[] | null = null;
  if (shiftOrderIds !== null && methodOrderIds !== null) {
    const shiftSet = new Set(shiftOrderIds);
    combinedAllowedIds = methodOrderIds.filter((id) => shiftSet.has(id));
  } else if (shiftOrderIds !== null) {
    combinedAllowedIds = shiftOrderIds;
  } else if (methodOrderIds !== null) {
    combinedAllowedIds = methodOrderIds;
  }

  if (combinedAllowedIds !== null) {
    if (combinedAllowedIds.length === 0) {
      return {
        ok: true,
        message: "Data transaksi berhasil dimuat.",
        data: {
          items: [],
          totalCount: 0,
          page: filter.page,
          pageSize: filter.pageSize,
          totalPages: 0,
          metricSummary: {
            totalTransactions: 0,
            totalAmountSum: 0,
            paidAmountSum: 0,
            totalRefundedSum: 0,
          },
        },
      };
    }
    query = query.in("id", combinedAllowedIds);
  }

  // Pencarian Nomor Pesanan atau Nama Pelanggan
  if (filter.search && filter.search.trim()) {
    const s = filter.search.trim();
    query = query.or(`order_number.ilike.%${s}%,customer_name.ilike.%${s}%`);
  }

  // Eksekusi Paginasi Server-side
  const offset = (filter.page - 1) * filter.pageSize;
  query = query
    .order("created_at", { ascending: false })
    .range(offset, offset + filter.pageSize - 1);

  const { data: rawOrders, count: totalCount, error: ordersErr } = await query;

  if (ordersErr) {
    return { ok: false, message: `Gagal memuat transaksi: ${ordersErr.message}` };
  }

  const orders = (rawOrders || []) as Order[];
  const orderIds = orders.map((o) => o.id);

  if (orderIds.length === 0) {
    return {
      ok: true,
      message: "Data transaksi berhasil dimuat.",
      data: {
        items: [],
        totalCount: totalCount ?? 0,
        page: filter.page,
        pageSize: filter.pageSize,
        totalPages: Math.ceil((totalCount ?? 0) / filter.pageSize),
        metricSummary: {
          totalTransactions: 0,
          totalAmountSum: 0,
          paidAmountSum: 0,
          totalRefundedSum: 0,
        },
      },
    };
  }

  // 4. Batch query child relations untuk halaman saat ini
  const tableIds = Array.from(
    new Set(orders.map((o) => o.table_id).filter(Boolean)),
  ) as string[];

  const cashierIds = Array.from(
    new Set(orders.map((o) => o.created_by).filter(Boolean)),
  ) as string[];

  const [tablesRes, cashiersRes, itemsRes, paymentsRes, refundsRes] =
    await Promise.all([
      tableIds.length > 0
        ? supabase.from("dining_tables").select("id, name").in("id", tableIds)
        : Promise.resolve({ data: [] }),
      cashierIds.length > 0
        ? supabase
            .from("profiles")
            .select("id, full_name, username")
            .in("id", cashierIds)
        : Promise.resolve({ data: [] }),
      supabase
        .from("order_items")
        .select("id, order_id, product_name_snapshot, quantity")
        .in("order_id", orderIds),
      supabase
        .from("payments")
        .select(
          "id, order_id, payment_method, payment_status, shift_id, shifts(status)",
        )
        .in("order_id", orderIds),
      supabase
        .from("refunds")
        .select("id, order_id, status, amount")
        .in("order_id", orderIds),
    ]);

  const tableNameMap = new Map<string, string>();
  for (const t of (tablesRes.data || []) as { id: string; name: string }[]) {
    tableNameMap.set(t.id, t.name);
  }

  const cashierMap = new Map<
    string,
    { full_name: string; username: string }
  >();
  for (const c of (cashiersRes.data || []) as {
    id: string;
    full_name: string;
    username: string;
  }[]) {
    cashierMap.set(c.id, { full_name: c.full_name, username: c.username });
  }

  const itemsByOrder = new Map<
    string,
    Array<{ product_name_snapshot: string; quantity: number }>
  >();
  for (const it of (itemsRes.data || []) as Array<{
    order_id: string;
    product_name_snapshot: string;
    quantity: number;
  }>) {
    const list = itemsByOrder.get(it.order_id) || [];
    list.push(it);
    itemsByOrder.set(it.order_id, list);
  }

  const paymentsByOrder = new Map<
    string,
    Array<{
      payment_method: string;
      payment_status: string;
      shift_id: string | null;
      shift_status: string | null;
    }>
  >();
  for (const p of (paymentsRes.data || []) as Array<{
    order_id: string;
    payment_method: string;
    payment_status: string;
    shift_id: string | null;
    shifts?: { status: string } | Array<{ status: string }> | null;
  }>) {
    const list = paymentsByOrder.get(p.order_id) || [];
    let sStatus: string | null = null;
    if (p.shifts) {
      sStatus = Array.isArray(p.shifts) ? p.shifts[0]?.status ?? null : p.shifts.status;
    }
    list.push({
      payment_method: p.payment_method,
      payment_status: p.payment_status,
      shift_id: p.shift_id,
      shift_status: sStatus,
    });
    paymentsByOrder.set(p.order_id, list);
  }

  const refundsByOrder = new Map<
    string,
    Array<{ id: string; status: string; amount: number }>
  >();
  for (const r of (refundsRes.data || []) as Array<{
    id: string;
    order_id: string;
    status: string;
    amount: number;
  }>) {
    const list = refundsByOrder.get(r.order_id) || [];
    list.push(r);
    refundsByOrder.set(r.order_id, list);
  }

  // 5. Susun List Items & Hitung Metrik Halaman
  let totalAmountSum = 0;
  let paidAmountSum = 0;
  let totalRefundedSum = 0;

  const items: AdminTransactionListItem[] = orders.map((o) => {
    const oItems = itemsByOrder.get(o.id) || [];
    const totalItemCount = oItems.reduce((acc, it) => acc + it.quantity, 0);

    // Buat ringkasan produk
    let itemSummary = "-";
    if (oItems.length > 0) {
      const firstTwo = oItems.slice(0, 2).map(
        (it) => `${it.product_name_snapshot} (x${it.quantity})`,
      );
      if (oItems.length > 2) {
        itemSummary = `${firstTwo.join(", ")} +${oItems.length - 2} lainnya`;
      } else {
        itemSummary = firstTwo.join(", ");
      }
    }

    const oPayments = paymentsByOrder.get(o.id) || [];
    const successfulPayments = oPayments.filter(
      (p) => p.payment_status === "success" || p.payment_status === "refunded",
    );

    let paymentMethod: "cash" | "midtrans" | "split" | "unpaid" = "unpaid";
    const distinctMethods = Array.from(
      new Set(successfulPayments.map((p) => p.payment_method)),
    );

    if (successfulPayments.length >= 2) {
      paymentMethod = "split";
    } else if (distinctMethods.length === 1) {
      paymentMethod = distinctMethods[0] === "cash" ? "cash" : "midtrans";
    }

    const oRefunds = refundsByOrder.get(o.id) || [];
    const hasRefund = oRefunds.some((r) => r.status === "completed");
    const refundedTotal = o.refunded_total ?? 0;
    const netPaid = Math.max(0, o.paid_total - refundedTotal);

    totalAmountSum += o.grand_total;
    paidAmountSum += o.paid_total;
    totalRefundedSum += refundedTotal;

    const cashierInfo = o.created_by ? cashierMap.get(o.created_by) : null;
    const firstShiftPayment = oPayments.find((p) => p.shift_id);

    return {
      id: o.id,
      orderNumber: o.order_number,
      queueNumber: o.queue_number ?? null,
      queueDate: o.queue_date ?? null,
      businessDate: o.business_date,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
      orderType: o.order_type as OrderType,
      tableId: o.table_id,
      tableName: o.table_id ? tableNameMap.get(o.table_id) ?? null : null,
      customerName: o.customer_name,
      status: o.status as OrderStatus,
      paymentStatus: o.payment_status as PaymentStatus,
      kdsStatus: o.kds_status,
      grandTotal: o.grand_total,
      paidTotal: o.paid_total,
      refundedTotal,
      netPaid,
      paymentMethod,
      paymentMethodsList: distinctMethods,
      itemSummary,
      totalItemCount,
      cashierId: o.created_by,
      cashierName: cashierInfo?.full_name ?? "Sistem POS",
      cashierUsername: cashierInfo?.username ?? "system",
      shiftId: firstShiftPayment?.shift_id ?? null,
      shiftStatus: (firstShiftPayment?.shift_status as ShiftStatus) ?? null,
      hasRefund,
    };
  });

  return {
    ok: true,
    message: "Data transaksi berhasil dimuat.",
    data: {
      items,
      totalCount: totalCount ?? 0,
      page: filter.page,
      pageSize: filter.pageSize,
      totalPages: Math.ceil((totalCount ?? 0) / filter.pageSize),
      metricSummary: {
        totalTransactions: totalCount ?? 0,
        totalAmountSum,
        paidAmountSum,
        totalRefundedSum,
      },
    },
  };
}

/**
 * Mengambil detail lengkap satu transaksi untuk modal audit administratif:
 * mencakup pesanan, snapshot produk historis, diskon, pembayaran (split bill),
 * riwayat refund F2.4, dan integrasi rekonsiliasi shift F5.
 */
export async function getAdminTransactionDetailAction(
  orderId: string,
): Promise<TransactionActionResult<AdminTransactionDetail>> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  if (!orderId || !uuidRegex.test(orderId)) {
    return { ok: false, message: "ID pesanan tidak valid." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  // 1. Ambil data pesanan
  const { data: rawOrder, error: oErr } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle<Order>();

  if (oErr || !rawOrder) {
    return { ok: false, message: "Pesanan tidak ditemukan." };
  }

  // 2. Ambil data relasi paralel
  const [
    itemsRes,
    discountsRes,
    paymentsRes,
    midtransRes,
    refundsRes,
    tableRes,
    cashierRes,
  ] = await Promise.all([
    supabase
      .from("order_items")
      .select("*")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true }),
    supabase
      .from("order_discounts")
      .select("*")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true }),
    supabase
      .from("payments")
      .select("*, profiles!payments_created_by_fkey(full_name, username)")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true }),
    supabase
      .from("midtrans_transactions")
      .select("*")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true }),
    supabase
      .from("refunds")
      .select(
        "*, requester:profiles!refunds_requested_by_fkey(full_name, username), approver:profiles!refunds_approved_by_fkey(full_name, username)",
      )
      .eq("order_id", orderId)
      .order("created_at", { ascending: true }),
    rawOrder.table_id
      ? supabase
          .from("dining_tables")
          .select("name")
          .eq("id", rawOrder.table_id)
          .maybeSingle<{ name: string }>()
      : Promise.resolve({ data: null, error: null }),
    rawOrder.created_by
      ? supabase
          .from("profiles")
          .select("full_name, username")
          .eq("id", rawOrder.created_by)
          .maybeSingle<{ full_name: string; username: string }>()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const rawItems = (itemsRes.data || []) as OrderItem[];
  const itemIds = rawItems.map((it) => it.id);

  // Ambil modifiers untuk item pesanan
  const modifiersRes =
    itemIds.length > 0
      ? await supabase
          .from("order_item_modifiers")
          .select("*")
          .in("order_item_id", itemIds)
      : { data: [] as OrderItemModifier[], error: null };

  const modifiersByItem = new Map<string, OrderItemModifier[]>();
  for (const m of (modifiersRes.data || []) as OrderItemModifier[]) {
    const list = modifiersByItem.get(m.order_item_id) || [];
    list.push(m);
    modifiersByItem.set(m.order_item_id, list);
  }

  // 3. Kumpulkan shift IDs dari payments & cash movements
  const payments = (paymentsRes.data || []) as RawPaymentWithProfile[];
  const shiftIds = Array.from(
    new Set(payments.map((p) => p.shift_id).filter(Boolean)),
  ) as string[];

  // Ambil cash movements terkait order, payments, atau refunds
  const paymentIds = payments.map((p) => p.id);
  const refunds = (refundsRes.data || []) as RawRefundWithProfiles[];
  const refundIds = refunds.map((r) => r.id);

  let movementsQuery = supabase
    .from("cash_movements")
    .select("*, creator:profiles!cash_movements_created_by_fkey(full_name, username)")
    .order("created_at", { ascending: true });

  if (paymentIds.length > 0 || refundIds.length > 0) {
    movementsQuery = movementsQuery.or(
      `order_id.eq.${orderId},payment_id.in.(${paymentIds.join(",") || "00000000-0000-0000-0000-000000000000"}),refund_id.in.(${refundIds.join(",") || "00000000-0000-0000-0000-000000000000"})`,
    );
  } else {
    movementsQuery = movementsQuery.eq("order_id", orderId);
  }

  const movementsRes = await movementsQuery;
  const rawMovements = (movementsRes.data || []) as RawCashMovementWithCreator[];

  // Jika ada shift_id pada cash_movements yang belum masuk shiftIds
  for (const mov of rawMovements) {
    if (mov.shift_id && !shiftIds.includes(mov.shift_id)) {
      shiftIds.push(mov.shift_id);
    }
  }

  // 4. Ambil data shifts terkait & hitung rekonsiliasi
  let detailedShifts: AdminTransactionDetail["shifts"] = [];
  if (shiftIds.length > 0) {
    const { data: shiftsData } = await supabase
      .from("shifts")
      .select("*, cashier:profiles!shifts_cashier_id_fkey(id, full_name, username)")
      .in("id", shiftIds);

    const { data: shiftMovementsData } = await supabase
      .from("cash_movements")
      .select("shift_id, movement_type, amount")
      .in("shift_id", shiftIds);

    const movementsByShift = new Map<string, Array<{ movement_type: string; amount: number }>>();
    for (const sm of shiftMovementsData || []) {
      if (sm.shift_id) {
        const list = movementsByShift.get(sm.shift_id) || [];
        list.push(sm);
        movementsByShift.set(sm.shift_id, list);
      }
    }

    detailedShifts = ((shiftsData || []) as RawShiftWithCashier[]).map((s) => {
      const sMovs = movementsByShift.get(s.id) || [];
      let cashSales = 0;
      let cashRefunds = 0;
      let cashIn = 0;
      let cashOut = 0;

      for (const m of sMovs) {
        if (m.movement_type === "cash_sale") cashSales += m.amount;
        else if (m.movement_type === "cash_refund") cashRefunds += m.amount;
        else if (m.movement_type === "cash_in") cashIn += m.amount;
        else if (m.movement_type === "cash_out") cashOut += m.amount;
      }

      let reconciliationStatus: "match" | "over" | "short" | "open" = "open";
      if (s.status === "closed") {
        const diff = s.cash_difference ?? 0;
        if (diff === 0) reconciliationStatus = "match";
        else if (diff > 0) reconciliationStatus = "over";
        else reconciliationStatus = "short";
      }

      return {
        id: s.id,
        cashierId: s.cashier_id,
        cashierName: s.cashier?.full_name ?? "Kasir",
        cashierUsername: s.cashier?.username ?? "-",
        openedAt: s.opened_at,
        closedAt: s.closed_at,
        status: s.status,
        openingCash: s.opening_cash,
        cashSales,
        cashRefunds,
        cashIn,
        cashOut,
        expectedCash: s.expected_cash,
        actualCash: s.actual_cash,
        cashDifference: s.cash_difference,
        reconciliationStatus,
        notes: s.notes,
      };
    });
  }

  // 5. Midtrans map untuk informasi referensi pembayaran
  const midtransMap = new Map<string, RawMidtransRow>();
  for (const mt of (midtransRes.data || []) as RawMidtransRow[]) {
    midtransMap.set(mt.order_id, mt);
  }

  // 6. Susun Rincian Produk
  const items = rawItems.map((it) => {
    const itemMods = modifiersByItem.get(it.id) || [];
    return {
      id: it.id,
      productId: it.product_id,
      productName: it.product_name_snapshot,
      productSku: it.product_sku_snapshot,
      unitPrice: it.unit_price_snapshot,
      quantity: it.quantity,
      notes: it.notes,
      modifierTotal: it.modifier_total,
      subtotal: it.subtotal,
      discountAmount: it.discount_amount,
      lineTotal: it.line_total,
      kitchenStation: it.kitchen_station,
      modifiers: itemMods.map((m) => ({
        id: m.id,
        groupName: m.group_name_snapshot,
        optionName: m.option_name_snapshot,
        priceDelta: m.price_delta_snapshot,
      })),
    };
  });

  // 7. Susun Rincian Diskon
  const discounts = ((discountsRes.data || []) as OrderDiscount[]).map((d) => ({
    id: d.id,
    name: d.name,
    scope: d.scope,
    discountType: d.discount_type,
    discountRate: d.discount_rate,
    discountAmount: d.discount_amount,
    reason: d.reason,
    approvedAt: d.approved_at,
  }));

  // 8. Susun Rincian Pembayaran & Split Bill
  const successfulPayments = payments.filter(
    (p) => p.payment_status === "success" || p.payment_status === "refunded",
  );
  const totalPaid = successfulPayments.reduce((acc, p) => acc + p.amount, 0);
  const remainingBalance = Math.max(0, rawOrder.grand_total - totalPaid);

  const parsedPayments = payments.map((p) => {
    let mtDetails: AdminTransactionDetail["payments"][number]["midtransDetails"] = null;
    if (p.payment_method === "midtrans") {
      const mt = midtransMap.get(orderId);
      if (mt) {
        mtDetails = {
          id: mt.id,
          midtransOrderId: mt.midtrans_order_id,
          grossAmount: mt.gross_amount,
          paymentType: mt.payment_type,
          lifecycleStatus: mt.lifecycle_status,
          settledAt: mt.settled_at,
          attemptNumber: mt.attempt_number,
          isSplitBill: mt.is_split_bill,
        };
      }
    }

    return {
      id: p.id,
      paymentMethod: p.payment_method,
      paymentSource: p.payment_source,
      amount: p.amount,
      cashReceived: p.cash_received,
      changeAmount: p.change_amount,
      referenceNumber: p.reference_number,
      paymentStatus: p.payment_status,
      shiftId: p.shift_id,
      cashierName: p.profiles?.full_name ?? "Kasir",
      notes: p.notes,
      createdAt: p.created_at,
      midtransDetails: mtDetails,
    };
  });

  const methodsUsed = Array.from(
    new Set(successfulPayments.map((p) => p.payment_method)),
  );

  // 9. Susun Rincian Refund
  const parsedRefunds = refunds.map((r) => ({
    id: r.id,
    refundNumber: r.refund_number,
    paymentId: r.payment_id,
    amount: r.amount,
    refundType: r.refund_type,
    refundMethod: r.refund_method,
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
    approvedAt: r.approved_at,
    requesterName: r.requester?.full_name ?? "Kasir",
    approverName: r.approver?.full_name ?? null,
    gatewayRefundId: r.gateway_refund_id ?? null,
  }));

  // 10. Susun Rincian Cash Movements
  const parsedMovements = rawMovements.map((m) => ({
    id: m.id,
    shiftId: m.shift_id,
    movementType: m.movement_type,
    amount: m.amount,
    balanceBefore: m.balance_before,
    balanceAfter: m.balance_after,
    reason: m.reason,
    paymentId: m.payment_id,
    refundId: m.refund_id,
    createdByName: m.creator?.full_name ?? "Sistem",
    createdAt: m.created_at,
  }));

  return {
    ok: true,
    message: "Detail transaksi berhasil dimuat.",
    data: {
      order: {
        id: rawOrder.id,
        orderNumber: rawOrder.order_number,
        queueNumber: rawOrder.queue_number ?? null,
        queueDate: rawOrder.queue_date ?? null,
        businessDate: rawOrder.business_date,
        orderType: rawOrder.order_type as OrderType,
        tableId: rawOrder.table_id,
        tableName: tableRes.data?.name ?? null,
        customerName: rawOrder.customer_name,
        status: rawOrder.status as OrderStatus,
        paymentStatus: rawOrder.payment_status as PaymentStatus,
        kdsStatus: rawOrder.kds_status,
        cashierId: rawOrder.created_by,
        cashierName: cashierRes.data?.full_name ?? "Sistem POS",
        cashierUsername: cashierRes.data?.username ?? "system",
        createdAt: rawOrder.created_at,
        updatedAt: rawOrder.updated_at,
        servedAt: rawOrder.served_at ?? null,
        servedBy: rawOrder.served_by ?? null,
        cancelledAt: rawOrder.cancelled_at ?? null,
        cancelReason: rawOrder.cancel_reason ?? null,
        notes: rawOrder.notes,
        subtotal: rawOrder.subtotal,
        discountProductTotal: rawOrder.discount_product_total,
        discountOrderTotal: rawOrder.discount_order_total,
        discountManualTotal: rawOrder.discount_manual_total,
        discountTotal: rawOrder.discount_total,
        taxPercent: Number(rawOrder.tax_percent),
        taxTotal: rawOrder.tax_total,
        serviceChargePercent: Number(rawOrder.service_charge_percent),
        serviceTotal: rawOrder.service_total,
        grandTotal: rawOrder.grand_total,
        paidTotal: rawOrder.paid_total,
        refundedTotal: rawOrder.refunded_total ?? 0,
        remainingBalance,
      },
      items,
      discounts,
      payments: parsedPayments,
      splitBillSummary: {
        isSplitBill: successfulPayments.length >= 2,
        totalParts: successfulPayments.length,
        totalPaid,
        remainingBalance,
        methodsUsed,
      },
      refunds: parsedRefunds,
      shifts: detailedShifts,
      cashMovements: parsedMovements,
    },
  };
}
