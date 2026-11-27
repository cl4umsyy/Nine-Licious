"use server";

import { getAdminActor } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  calculatePaymentMethodReport,
  calculateProductPerformanceReport,
  calculateRefundReport,
  calculateSalesReport,
  type RawOrderItemRow,
  type RawOrderRow,
  type RawPaymentRow,
  type RawRefundRow,
} from "./calculations";
import type {
  ComprehensiveReportData,
  DateRangeFilterInput,
  PaymentMethodReportData,
  ProductPerformanceReportData,
  RefundReportData,
  ReportActionResult,
  SalesReportData,
} from "./types";
import {
  dateRangeFilterSchema,
  fieldErrorsFrom,
  firstZodError,
} from "./validation";

/**
 * Helper untuk mengambil seluruh baris data secara paginasi chunks
 * agar query tidak terpotong oleh batasan default 1000 baris Supabase/PostgREST.
 * Mengembalikan array kosong dan error jika pagination gagal pada salah satu chunk
 * (tidak pernah mengembalikan angka parsial).
 */
export async function fetchPaginatedRows<T>(
  fetchChunk: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ data: T[]; error: Error | null }> {
  const CHUNK_SIZE = 1000;
  let from = 0;
  const allRows: T[] = [];

  while (true) {
    const to = from + CHUNK_SIZE - 1;
    const { data, error } = await fetchChunk(from, to);
    if (error) {
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error);
      return { data: [], error: new Error(msg) };
    }
    if (!data || data.length === 0) {
      break;
    }
    allRows.push(...data);
    if (data.length < CHUNK_SIZE) {
      break;
    }
    from += CHUNK_SIZE;
  }

  return { data: allRows, error: null };
}

/**
 * 1. SALES REPORT ACTION
 * Mengambil agregasi omzet penjualan, diskon, pajak, service charge,
 * net sales setelah refund, dan AOV.
 */
export async function getSalesReportAction(
  input: DateRangeFilterInput,
): Promise<ReportActionResult<SalesReportData>> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, code: "UNAUTHORIZED", message: actor.message };
  }

  const parsed = dateRangeFilterSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Klien database sesi tidak tersedia.",
    };
  }

  const { startDate, endDate } = parsed.data;
  const startIso = `${startDate}T00:00:00+07:00`;
  const endIso = `${endDate}T23:59:59.999+07:00`;

  // Query 1: Orders dalam rentang waktu (hanya pesanan penjualan standard, bukan replacement Rp 0)
  const ordersResult = await fetchPaginatedRows<RawOrderRow>((from, to) =>
    supabase
      .from("orders")
      .select(
        "id, order_kind, status, subtotal, discount_total, tax_total, service_total, grand_total, paid_total, created_at",
      )
      .neq("order_kind", "replacement")
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .range(from, to),
  );

  if (ordersResult.error) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: `Gagal memuat data pesanan: ${ordersResult.error.message}`,
    };
  }

  // Query 2: Refunds dalam rentang waktu (hanya yang completed)
  const refundsResult = await fetchPaginatedRows<RawRefundRow>((from, to) =>
    supabase
      .from("refunds")
      .select(
        "id, refund_number, order_id, payment_id, amount, reason, refund_type, resolution_type, reason_category, approval_status, payout_status, refund_method, status, approved_at, created_at",
      )
      .neq("resolution_type", "replacement")
      .eq("payout_status", "completed")
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .range(from, to),
  );

  if (refundsResult.error) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: `Gagal memuat data refund: ${refundsResult.error.message}`,
    };
  }

  // Query 3: Payments dalam rentang waktu untuk menghitung total penerimaan fisik/gateway
  const paymentsResult = await fetchPaginatedRows<RawPaymentRow>((from, to) =>
    supabase
      .from("payments")
      .select(
        "id, order_id, payment_method, payment_source, amount, payment_status, created_at",
      )
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .in("payment_status", ["success", "refunded"])
      .range(from, to),
  );

  if (paymentsResult.error) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: `Gagal memuat data pembayaran: ${paymentsResult.error.message}`,
    };
  }

  const totalReceipts = paymentsResult.data.reduce(
    (sum, p) => sum + (Number(p.amount) || 0),
    0,
  );

  const report = calculateSalesReport(
    ordersResult.data,
    refundsResult.data,
    { startDate, endDate },
    totalReceipts,
  );

  return {
    ok: true,
    message: "Laporan penjualan berhasil dimuat.",
    data: report,
  };
}

/**
 * 2. PAYMENT METHOD REPORT ACTION
 * Mengambil agregasi metode pembayaran (Tunai, Midtrans, Split Bill)
 * tanpa menggandakan pesanan yang memiliki beberapa transaksi pembayaran.
 */
export async function getPaymentMethodReportAction(
  input: DateRangeFilterInput,
): Promise<ReportActionResult<PaymentMethodReportData>> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, code: "UNAUTHORIZED", message: actor.message };
  }

  const parsed = dateRangeFilterSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Klien database sesi tidak tersedia.",
    };
  }

  const { startDate, endDate } = parsed.data;
  const startIso = `${startDate}T00:00:00+07:00`;
  const endIso = `${endDate}T23:59:59.999+07:00`;

  const paymentsResult = await fetchPaginatedRows<RawPaymentRow>((from, to) =>
    supabase
      .from("payments")
      .select(
        "id, order_id, payment_method, payment_source, amount, payment_status, created_at",
      )
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .range(from, to),
  );

  if (paymentsResult.error) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: `Gagal memuat data pembayaran: ${paymentsResult.error.message}`,
    };
  }

  const report = calculatePaymentMethodReport(paymentsResult.data, {
    startDate,
    endDate,
  });

  return {
    ok: true,
    message: "Laporan metode pembayaran berhasil dimuat.",
    data: report,
  };
}

/**
 * 3. PRODUCT PERFORMANCE REPORT ACTION
 * Mengambil performa produk terlaris dan kontribusi kategori
 * menggunakan snapshot historis dari order_items.
 */
export async function getProductPerformanceReportAction(
  input: DateRangeFilterInput,
): Promise<ReportActionResult<ProductPerformanceReportData>> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, code: "UNAUTHORIZED", message: actor.message };
  }

  const parsed = dateRangeFilterSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Klien database sesi tidak tersedia.",
    };
  }

  const { startDate, endDate } = parsed.data;
  const startIso = `${startDate}T00:00:00+07:00`;
  const endIso = `${endDate}T23:59:59.999+07:00`;

  // 1. Ambil order_id dari pesanan penjualan standard yang sah (paid, completed, refunded)
  const ordersResult = await fetchPaginatedRows<{ id: string; status: string }>(
    (from, to) =>
      supabase
        .from("orders")
        .select("id, status")
        .neq("order_kind", "replacement")
        .gte("created_at", startIso)
        .lte("created_at", endIso)
        .in("status", ["paid", "completed", "refunded"])
        .range(from, to),
  );

  if (ordersResult.error) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: `Gagal memuat ID pesanan: ${ordersResult.error.message}`,
    };
  }

  const eligibleOrderIds = ordersResult.data.map((o) => o.id);
  if (eligibleOrderIds.length === 0) {
    return {
      ok: true,
      message: "Tidak ada data penjualan pada periode ini.",
      data: calculateProductPerformanceReport([], new Map(), {
        startDate,
        endDate,
      }),
    };
  }

  // 2. Ambil master produk dan kategori untuk mapping kategori
  const [productsRes, categoriesRes] = await Promise.all([
    supabase.from("products").select("id, category_id"),
    supabase.from("menu_categories").select("id, name"),
  ]);

  if (productsRes.error || categoriesRes.error) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Gagal memuat master kategori produk.",
    };
  }

  const categoryNameMap = new Map<string, string>();
  for (const cat of categoriesRes.data ?? []) {
    categoryNameMap.set(cat.id, cat.name);
  }

  const productCategoryMap = new Map<string, string>();
  for (const prod of productsRes.data ?? []) {
    const catName = categoryNameMap.get(prod.category_id) ?? "Lainnya";
    productCategoryMap.set(prod.id, catName);
  }

  // 3. Ambil item pesanan menggunakan batching orderIds untuk menghindari batasan URL parameter
  const BATCH_SIZE = 200;
  const allItems: RawOrderItemRow[] = [];

  for (let i = 0; i < eligibleOrderIds.length; i += BATCH_SIZE) {
    const chunkIds = eligibleOrderIds.slice(i, i + BATCH_SIZE);
    const itemsChunkRes = await fetchPaginatedRows<RawOrderItemRow>((from, to) =>
      supabase
        .from("order_items")
        .select(
          "id, order_id, product_id, product_name_snapshot, product_sku_snapshot, quantity, line_total",
        )
        .in("order_id", chunkIds)
        .range(from, to),
    );

    if (itemsChunkRes.error) {
      return {
        ok: false,
        code: "DATABASE_ERROR",
        message: `Gagal memuat item pesanan: ${itemsChunkRes.error.message}`,
      };
    }

    allItems.push(...itemsChunkRes.data);
  }

  const report = calculateProductPerformanceReport(
    allItems,
    productCategoryMap,
    { startDate, endDate },
  );

  return {
    ok: true,
    message: "Laporan performa produk berhasil dimuat.",
    data: report,
  };
}

/**
 * 4. REFUND REPORT ACTION
 * Mengambil ringkasan dan riwayat pengembalian dana yang telah selesai diproses.
 */
export async function getRefundReportAction(
  input: DateRangeFilterInput,
): Promise<ReportActionResult<RefundReportData>> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, code: "UNAUTHORIZED", message: actor.message };
  }

  const parsed = dateRangeFilterSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Klien database sesi tidak tersedia.",
    };
  }

  const { startDate, endDate } = parsed.data;
  const startIso = `${startDate}T00:00:00+07:00`;
  const endIso = `${endDate}T23:59:59.999+07:00`;

  const refundsResult = await fetchPaginatedRows<RawRefundRow>((from, to) =>
    supabase
      .from("refunds")
      .select(
        "id, refund_number, order_id, payment_id, amount, reason, refund_type, resolution_type, reason_category, approval_status, payout_status, refund_method, status, approved_at, created_at",
      )
      .neq("resolution_type", "replacement")
      .eq("payout_status", "completed")
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .range(from, to),
  );

  if (refundsResult.error) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: `Gagal memuat data refund: ${refundsResult.error.message}`,
    };
  }

  const report = calculateRefundReport(refundsResult.data, {
    startDate,
    endDate,
  });

  return {
    ok: true,
    message: "Laporan refund berhasil dimuat.",
    data: report,
  };
}

/**
 * 5. COMPREHENSIVE REPORT ACTION
 * Mengambil seluruh domain laporan (penjualan, pembayaran, produk, refund)
 * secara paralel untuk efisiensi loading dasbor administratif.
 */
export async function getComprehensiveReportAction(
  input: DateRangeFilterInput,
): Promise<ReportActionResult<ComprehensiveReportData>> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, code: "UNAUTHORIZED", message: actor.message };
  }

  const parsed = dateRangeFilterSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const [salesRes, paymentsRes, productsRes, refundsRes] = await Promise.all([
    getSalesReportAction(input),
    getPaymentMethodReportAction(input),
    getProductPerformanceReportAction(input),
    getRefundReportAction(input),
  ]);

  if (!salesRes.ok || !salesRes.data) {
    return { ok: false, code: salesRes.code, message: salesRes.message };
  }
  if (!paymentsRes.ok || !paymentsRes.data) {
    return { ok: false, code: paymentsRes.code, message: paymentsRes.message };
  }
  if (!productsRes.ok || !productsRes.data) {
    return { ok: false, code: productsRes.code, message: productsRes.message };
  }
  if (!refundsRes.ok || !refundsRes.data) {
    return { ok: false, code: refundsRes.code, message: refundsRes.message };
  }

  return {
    ok: true,
    message: "Laporan komprehensif berhasil dimuat.",
    data: {
      period: parsed.data,
      sales: salesRes.data,
      payments: paymentsRes.data,
      products: productsRes.data,
      refunds: refundsRes.data,
    },
  };
}
