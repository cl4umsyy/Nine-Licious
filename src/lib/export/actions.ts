"use server";

/**
 * NINE LICIOUS POS — CSV EXPORT SERVER ACTIONS
 * File: src/lib/export/actions.ts
 *
 * Mengimplementasikan ekspor CSV administratif untuk:
 * 1. Laporan Finansial & Performa Menu (F6.1 - F6.2)
 * 2. Riwayat Transaksi Lengkap (F6.3)
 * 3. Rekonsiliasi Shift & Buku Besar Kas Fisik (F5.4)
 *
 * Kepatuhan Keamanan & Standar:
 * - UTF-8 BOM (\uFEFF) untuk kompatibilitas penuh Microsoft Excel.
 * - Sanitasi Formula Injection (OWASP CSV Injection).
 * - Otorisasi ketat Admin (getAdminActor) dan penggunaan RLS session client.
 * - Format tanggal Asia/Jakarta (+07:00).
 */

import { getAdminActor } from "@/lib/auth/session";
import {
  buildCsvDocument,
  buildMultiSectionCsv,
  formatJakartaDateTime,
} from "@/lib/export/csv";
import type { CsvExportResult } from "@/lib/export/types";
import { getComprehensiveReportAction } from "@/lib/reports/actions";
import { getJakartaDateToday } from "@/lib/reports/calculations";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { TransactionFilterInput } from "@/lib/transactions/types";
import { transactionFilterSchema } from "@/lib/transactions/validation";

/**
 * Helper format rupiah tanpa desimal
 */
function toRupiah(amount: number): string {
  return `Rp ${Math.round(amount).toLocaleString("id-ID")}`;
}

// =============================================================================
// 1. EXPORT LAPORAN FINANSIAL, PRODUK, PEMBAYARAN, & REFUND
// =============================================================================
export async function exportSalesReportCsvAction(options?: {
  startDate?: string;
  endDate?: string;
}): Promise<CsvExportResult> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const s = options?.startDate || getJakartaDateToday();
  const e = options?.endDate || getJakartaDateToday();

  const reportRes = await getComprehensiveReportAction({
    startDate: s,
    endDate: e,
  });

  if (!reportRes.ok || !reportRes.data) {
    return {
      ok: false,
      message: reportRes.message || "Gagal memuat data laporan untuk diekspor.",
    };
  }

  const data = reportRes.data;

  // Seksi 1: Ringkasan Penjualan & KPI
  const salesSummaryRows = [
    ["Gross Sales (Penjualan Kotor)", toRupiah(data.sales.grossSales), "Total sebelum potongan diskon"],
    ["Total Diskon Promo", `-${toRupiah(data.sales.totalDiscount)}`, "Potongan harga produk dan pesanan"],
    ["Net Sales (Penjualan Bersih)", toRupiah(data.sales.netSales), "Gross dikurangi diskon"],
    ["Pajak Restoran (PB1 10%)", toRupiah(data.sales.totalTax), "Pajak daerah restoran"],
    ["Service Charge (5%)", toRupiah(data.sales.totalServiceCharge), "Biaya layanan operasional"],
    ["Total Penerimaan Bersih (Receipts)", toRupiah(data.sales.totalReceipts), "Penerimaan lunas setelah potong refund"],
    ["Total Pengembalian (Refund)", `-${toRupiah(data.sales.totalRefund)}`, "Total pengembalian dana selesai"],
    ["Jumlah Pesanan Lunas", data.sales.paidOrdersCount, "Pesanan berstatus paid / completed"],
    ["Average Order Value (AOV)", toRupiah(data.sales.averageOrderValue), "Rata-rata nilai per transaksi lunas"],
  ];

  // Seksi 2: Penjualan Harian
  const dailySalesRows = data.sales.dailyBreakdown.map((d) => [
    d.date,
    d.paidOrdersCount,
    toRupiah(d.grossSales),
    `-${toRupiah(d.totalDiscount)}`,
    toRupiah(d.netSales),
    toRupiah(d.totalTax),
    toRupiah(d.totalServiceCharge),
    `-${toRupiah(d.totalRefund)}`,
  ]);

  // Seksi 3: Performa Produk Terlaris
  const productRows = data.products.topProducts.map((p, idx) => [
    idx + 1,
    p.productName,
    p.sku || "-",
    p.categoryName,
    p.quantitySold,
    toRupiah(p.totalRevenue),
  ]);

  // Seksi 4: Performa Kategori Menu
  const categoryRows = data.products.categoryBreakdown.map((c) => [
    c.categoryName,
    c.quantitySold,
    toRupiah(c.totalRevenue),
    `${c.revenuePercentage.toFixed(1)}%`,
  ]);

  // Seksi 5: Metode Pembayaran
  const cashPct = data.payments.totalPayments > 0 ? (data.payments.totalCash / data.payments.totalPayments) * 100 : 0;
  const mtPct = data.payments.totalPayments > 0 ? (data.payments.totalMidtrans / data.payments.totalPayments) * 100 : 0;

  const paymentMethodRows = [
    ["Tunai (Cash Drawer)", data.payments.cashTransactionCount, toRupiah(data.payments.totalCash), `${cashPct.toFixed(1)}%`],
    ["Midtrans Gateway", data.payments.midtransTransactionCount, toRupiah(data.payments.totalMidtrans), `${mtPct.toFixed(1)}%`],
  ];

  // Seksi 6: Split Bill & Refund
  const splitAndRefundRows = [
    ["Pesanan Menggunakan Split Bill", data.payments.splitBillOrdersCount, "Pesanan yang dibayar > 1 pembayaran"],
    ["Total Penerimaan Split Bill", toRupiah(data.payments.totalSplitBillReceipts), "Penerimaan kumulatif split bill"],
    ["Jumlah Transaksi Refund", data.refunds.totalRefundCount, "Transaksi yang memiliki refund completed"],
    ["Total Pengembalian Dana (Refund)", `-${toRupiah(data.refunds.totalRefundAmount)}`, "Dana dikembalikan ke pelanggan"],
    ["Refund Penuh (Full Refund)", toRupiah(data.refunds.fullRefundTotal), `${data.refunds.fullRefundCount} transaksi`],
    ["Refund Sebagian (Partial Refund)", toRupiah(data.refunds.partialRefundTotal), `${data.refunds.partialRefundCount} transaksi`],
  ];

  const csvContent = buildMultiSectionCsv([
    {
      title: `Laporan Penjualan Nine Licious (${s} s/d ${e})`,
      headers: ["Metrik Penjualan", "Nilai", "Keterangan"],
      rows: salesSummaryRows,
    },
    {
      title: "Rincian Penjualan Harian",
      headers: ["Tanggal", "Pesanan Lunas", "Gross Sales", "Diskon", "Net Sales", "Pajak (PB1)", "Service", "Refund"],
      rows: dailySalesRows,
    },
    {
      title: "Peringkat Produk Terlaris",
      headers: ["Peringkat", "Nama Produk", "SKU", "Kategori", "Qty Terjual", "Total Pendapatan"],
      rows: productRows,
    },
    {
      title: "Kontribusi Kategori Menu",
      headers: ["Kategori", "Qty Terjual", "Total Penjualan", "Kontribusi (%)"],
      rows: categoryRows,
    },
    {
      title: "Rincian Metode Pembayaran",
      headers: ["Metode Pembayaran", "Jumlah Transaksi", "Total Penerimaan", "Persentase (%)"],
      rows: paymentMethodRows,
    },
    {
      title: "Analisis Split Bill dan Refund",
      headers: ["Metrik Khusus", "Nilai / Jumlah", "Keterangan"],
      rows: splitAndRefundRows,
    },
  ]);

  const filename = `laporan-penjualan-${s}-sd-${e}.csv`;

  return {
    ok: true,
    message: "Laporan berhasil diekspor ke CSV.",
    filename,
    csvContent,
  };
}

// =============================================================================
// 2. EXPORT RIWAYAT TRANSAKSI LENGKAP (MENGIKUTI FILTER AKTIF)
// =============================================================================
export async function exportTransactionsCsvAction(
  rawFilter?: TransactionFilterInput,
): Promise<CsvExportResult> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const parsed = transactionFilterSchema.safeParse(rawFilter ?? {});
  if (!parsed.success) {
    return { ok: false, message: "Parameter filter transaksi tidak valid." };
  }

  const filter = parsed.data;
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  // 1. Filter shiftId jika ada
  let shiftOrderIds: string[] | null = null;
  if (filter.shiftId && filter.shiftId !== "all") {
    const { data: pData } = await supabase
      .from("payments")
      .select("order_id")
      .eq("shift_id", filter.shiftId);
    shiftOrderIds = Array.from(new Set((pData || []).map((p) => p.order_id)));
    if (shiftOrderIds.length === 0) {
      return {
        ok: true,
        filename: `riwayat-transaksi-${getJakartaDateToday()}.csv`,
        csvContent: buildCsvDocument(
          ["Nomor Pesanan", "Tanggal", "Tipe", "Meja", "Antrean", "Pelanggan", "Kasir", "Subtotal", "Diskon", "Pajak", "Service", "Grand Total", "Dibayar", "Refund", "Status Bayar", "Metode", "Status Pesanan"],
          [],
        ),
      };
    }
  }

  // 2. Filter paymentMethod jika ada
  let methodOrderIds: string[] | null = null;
  if (filter.paymentMethod && filter.paymentMethod !== "all") {
    const { data: paymentsAll } = await supabase
      .from("payments")
      .select("order_id, payment_method, payment_status")
      .in("payment_status", ["success", "refunded"]);

    const paymentsByOrder = new Map<string, string[]>();
    for (const p of paymentsAll || []) {
      const list = paymentsByOrder.get(p.order_id) || [];
      list.push(p.payment_method);
      paymentsByOrder.set(p.order_id, list);
    }

    const matchedIds: string[] = [];
    for (const [oId, methods] of paymentsByOrder.entries()) {
      const distinct = Array.from(new Set(methods));
      if (filter.paymentMethod === "split") {
        if (methods.length >= 2) matchedIds.push(oId);
      } else if (filter.paymentMethod === "cash") {
        if (distinct.includes("cash") && methods.length === 1) matchedIds.push(oId);
      } else if (filter.paymentMethod === "midtrans") {
        if (distinct.includes("midtrans") && methods.length === 1) matchedIds.push(oId);
      }
    }
    methodOrderIds = matchedIds;
    if (methodOrderIds.length === 0) {
      return {
        ok: true,
        filename: `riwayat-transaksi-${getJakartaDateToday()}.csv`,
        csvContent: buildCsvDocument(
          ["Nomor Pesanan", "Tanggal", "Tipe", "Meja", "Antrean", "Pelanggan", "Kasir", "Subtotal", "Diskon", "Pajak", "Service", "Grand Total", "Dibayar", "Refund", "Status Bayar", "Metode", "Status Pesanan"],
          [],
        ),
      };
    }
  }

  // 3. Query orders dengan server-side chunking (CHUNK_SIZE = 1000, MAX = 10000)
  const CHUNK_SIZE = 1000;
  const MAX_EXPORT_LIMIT = 10000;
  const db = supabase;

  function buildOrdersQuery() {
    let q = db
      .from("orders")
      .select(
        "id, order_number, queue_number, business_date, order_type, table_id, customer_name, status, payment_status, subtotal, discount_total, tax_total, service_total, grand_total, paid_total, refunded_total, notes, created_by, created_at",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .limit(10000);

    if (filter.startDate) {
      q = q.gte("created_at", `${filter.startDate}T00:00:00+07:00`);
    }
    if (filter.endDate) {
      q = q.lte("created_at", `${filter.endDate}T23:59:59.999+07:00`);
    }
    if (filter.orderStatus && filter.orderStatus !== "all") {
      q = q.eq("status", filter.orderStatus);
    }
    if (filter.paymentStatus && filter.paymentStatus !== "all") {
      q = q.eq("payment_status", filter.paymentStatus);
    }
    if (filter.orderType && filter.orderType !== "all") {
      q = q.eq("order_type", filter.orderType);
    }
    if (filter.cashierId && filter.cashierId !== "all") {
      q = q.eq("created_by", filter.cashierId);
    }
    if (shiftOrderIds) {
      q = q.in("id", shiftOrderIds);
    }
    if (methodOrderIds) {
      q = q.in("id", methodOrderIds);
    }
    if (filter.search && filter.search.trim()) {
      const s = filter.search.trim();
      q = q.or(`order_number.ilike.%${s}%,customer_name.ilike.%${s}%`);
    }
    return q;
  }

  // Ambil batch pertama beserta total count pencocokan filter
  const { data: firstChunk, count: totalCount, error: firstErr } = await buildOrdersQuery().range(
    0,
    Math.min(CHUNK_SIZE, MAX_EXPORT_LIMIT) - 1,
  );
  if (firstErr) {
    return { ok: false, message: `Gagal memuat transaksi: ${firstErr.message}` };
  }

  const allOrders = [...(firstChunk || [])];
  const totalMatching = totalCount ?? allOrders.length;
  const isTruncated = totalMatching > MAX_EXPORT_LIMIT;
  const targetCount = Math.min(totalMatching, MAX_EXPORT_LIMIT);

  // Ambil chunk berikutnya jika total data melebihi CHUNK_SIZE
  while (allOrders.length < targetCount) {
    const from = allOrders.length;
    const to = Math.min(from + CHUNK_SIZE - 1, targetCount - 1);
    const { data: nextChunk, error: nextErr } = await buildOrdersQuery().range(from, to);
    if (nextErr) {
      return { ok: false, message: `Gagal memuat batch transaksi (${from}-${to}): ${nextErr.message}` };
    }
    if (!nextChunk || nextChunk.length === 0) break;
    allOrders.push(...nextChunk);
  }

  const orders = allOrders;
  const orderIds = orders.map((o) => o.id);

  // Ambil profil kasir & meja pendukung
  const cashierIds = Array.from(new Set(orders.map((o) => o.created_by).filter(Boolean)));
  const tableIds = Array.from(new Set(orders.map((o) => o.table_id).filter(Boolean)));

  const [profilesRes, tablesRes, paymentsRes] = await Promise.all([
    cashierIds.length > 0
      ? supabase.from("profiles").select("id, full_name, username").in("id", cashierIds)
      : { data: [] },
    tableIds.length > 0
      ? supabase.from("tables").select("id, table_number").in("id", tableIds)
      : { data: [] },
    orderIds.length > 0
      ? supabase.from("payments").select("order_id, payment_method, payment_status").in("order_id", orderIds)
      : { data: [] },
  ]);

  const cashierMap = new Map<string, { full_name: string; username: string }>();
  for (const c of profilesRes.data || []) {
    cashierMap.set(c.id, { full_name: c.full_name, username: c.username });
  }

  const tableMap = new Map<string, string>();
  for (const t of tablesRes.data || []) {
    tableMap.set(t.id, t.table_number);
  }

  const paymentsMap = new Map<string, string[]>();
  for (const p of paymentsRes.data || []) {
    if (p.payment_status === "success" || p.payment_status === "refunded") {
      const list = paymentsMap.get(p.order_id) || [];
      list.push(p.payment_method);
      paymentsMap.set(p.order_id, list);
    }
  }

  const headers = [
    "Nomor Pesanan",
    "Tanggal Transaksi",
    "Tipe Pesanan",
    "Meja",
    "Nomor Antrean",
    "Nama Pelanggan",
    "Kasir",
    "Username Kasir",
    "Subtotal",
    "Diskon",
    "Pajak PB1",
    "Service Charge",
    "Grand Total",
    "Total Dibayar",
    "Total Refund",
    "Status Pembayaran",
    "Metode Pembayaran",
    "Status Pesanan",
    "Catatan",
  ];

  const rows = orders.map((o) => {
    const c = o.created_by ? cashierMap.get(o.created_by) : null;
    const tNum = o.table_id ? tableMap.get(o.table_id) || "-" : "-";
    const pMethods = paymentsMap.get(o.id) || [];
    let methodLabel = "-";
    if (pMethods.length >= 2) {
      methodLabel = "Split Bill";
    } else if (pMethods.length === 1) {
      methodLabel = pMethods[0] === "cash" ? "Tunai" : "Midtrans";
    }

    return [
      o.order_number,
      formatJakartaDateTime(o.created_at),
      o.order_type === "dine_in" ? "Dine-In" : "Takeaway",
      tNum,
      o.queue_number || "-",
      o.customer_name || "Pelanggan Umum",
      c?.full_name || "Kasir",
      c?.username ? `@${c.username}` : "-",
      o.subtotal,
      o.discount_total,
      o.tax_total,
      o.service_total,
      o.grand_total,
      o.paid_total,
      o.refunded_total,
      o.payment_status,
      methodLabel,
      o.status,
      o.notes || "-",
    ];
  });

  const filename = `riwayat-transaksi-${getJakartaDateToday()}.csv`;
  let csvContent = buildCsvDocument(headers, rows);

  if (isTruncated) {
    const notice = `# PERHATIAN: Data dibatasi ${MAX_EXPORT_LIMIT.toLocaleString("id-ID")} transaksi pertama dari total ${totalMatching.toLocaleString("id-ID")} transaksi yang cocok.`;
    csvContent = csvContent.replace(/^\uFEFF/, `\uFEFF${notice}\r\n`);
  }

  return {
    ok: true,
    message: isTruncated
      ? `Ekspor dibatasi ${MAX_EXPORT_LIMIT.toLocaleString("id-ID")} transaksi pertama (Total pencocokan: ${totalMatching.toLocaleString("id-ID")}). Gunakan filter tanggal atau kasir untuk mempersempit.`
      : `Riwayat ${orders.length.toLocaleString("id-ID")} transaksi berhasil diekspor ke CSV.`,
    filename,
    csvContent,
    totalMatching,
    exportedCount: orders.length,
    isTruncated,
  };
}

// =============================================================================
// 3. EXPORT REKONSILIASI SHIFT & KAS LACI (MENGIKUTI FILTER AKTIF)
// =============================================================================
export async function exportShiftsCsvAction(options?: {
  cashierId?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
}): Promise<CsvExportResult> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  let query = supabase
    .from("shifts")
    .select("*, cashier:profiles!shifts_cashier_id_fkey(id, full_name, username)")
    .order("opened_at", { ascending: false })
    .limit(5000);

  if (options?.cashierId && options.cashierId !== "all") {
    query = query.eq("cashier_id", options.cashierId);
  }
  if (options?.status && options.status !== "all") {
    query = query.eq("status", options.status);
  }
  if (options?.startDate) {
    query = query.gte("opened_at", `${options.startDate}T00:00:00+07:00`);
  }
  if (options?.endDate) {
    query = query.lte("opened_at", `${options.endDate}T23:59:59.999+07:00`);
  }

  const { data: rawShifts, error: sErr } = await query;
  if (sErr) {
    return { ok: false, message: `Gagal memuat shift: ${sErr.message}` };
  }

  const shifts = rawShifts || [];
  const shiftIds = shifts.map((s) => s.id);

  // Agregasi mutasi kas untuk setiap shift
  const { data: movements } =
    shiftIds.length > 0
      ? await supabase
          .from("cash_movements")
          .select("shift_id, movement_type, amount")
          .in("shift_id", shiftIds)
      : { data: [] };

  const movementTotals = new Map<
    string,
    { sales: number; refunds: number; in: number; out: number }
  >();

  for (const m of movements || []) {
    if (!m.shift_id) continue;
    const current = movementTotals.get(m.shift_id) || {
      sales: 0,
      refunds: 0,
      in: 0,
      out: 0,
    };
    if (m.movement_type === "cash_sale") current.sales += m.amount;
    else if (m.movement_type === "cash_refund") current.refunds += m.amount;
    else if (m.movement_type === "cash_in") current.in += m.amount;
    else if (m.movement_type === "cash_out") current.out += m.amount;
    movementTotals.set(m.shift_id, current);
  }

  const headers = [
    "ID Shift",
    "Nama Kasir",
    "Username Kasir",
    "Waktu Buka Shift",
    "Waktu Tutup Shift",
    "Status Shift",
    "Modal Awal",
    "Penjualan Tunai",
    "Refund Tunai",
    "Kas Masuk (In)",
    "Kas Keluar (Out)",
    "Expected Cash (Sistem)",
    "Actual Cash (Fisik)",
    "Selisih Kas",
    "Status Rekonsiliasi",
    "Catatan Penutupan",
  ];

  const rows = shifts.map((s) => {
    const mv = movementTotals.get(s.id) || { sales: 0, refunds: 0, in: 0, out: 0 };
    let recStatus = "Aktif";
    if (s.status === "closed") {
      const diff = s.cash_difference ?? 0;
      if (diff === 0) recStatus = "Cocok (Pas)";
      else if (diff > 0) recStatus = `Lebih (+${diff})`;
      else recStatus = `Kurang (${diff})`;
    }

    return [
      s.id,
      s.cashier?.full_name || "Kasir",
      s.cashier?.username ? `@${s.cashier.username}` : "-",
      formatJakartaDateTime(s.opened_at),
      s.closed_at ? formatJakartaDateTime(s.closed_at) : "Sedang Aktif",
      s.status === "open" ? "Aktif" : "Ditutup",
      s.opening_cash,
      mv.sales,
      mv.refunds,
      mv.in,
      mv.out,
      s.expected_cash,
      s.actual_cash !== null ? s.actual_cash : "-",
      s.cash_difference !== null ? s.cash_difference : "-",
      recStatus,
      s.notes || "-",
    ];
  });

  const filename = `rekonsiliasi-shift-${getJakartaDateToday()}.csv`;
  const csvContent = buildCsvDocument(headers, rows);

  return {
    ok: true,
    message: "Data rekonsiliasi shift berhasil diekspor ke CSV.",
    filename,
    csvContent,
  };
}
