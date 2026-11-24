/**
 * Pure formatting & error-handling helpers dedicated strictly to digital receipts.
 * Intentionally separated from payment error handlers so receipt loading or
 * printing failures never display misleading payment-failure messages.
 */

export type ReceiptPaperWidth = 58 | 80;

export function normalizeReceiptWidth(width?: number | null): ReceiptPaperWidth {
  return width === 80 ? 80 : 58;
}

export function formatReceiptPaymentMethodLabel(
  paymentMethod: string,
  paymentSource?: string | null,
): string {
  const source = (paymentSource ?? "").trim().toLowerCase();
  const method = (paymentMethod ?? "").trim().toLowerCase();

  if (source === "qris_midtrans") return "Midtrans (QRIS)";
  if (source === "midtrans_snap" || method === "midtrans") return "Midtrans";
  if (source === "cash" || method === "cash") return "Tunai";
  if (source === "qris_manual" || method === "qris") return "QRIS";
  if (source === "bank_transfer" || method === "bank_transfer") {
    return "Transfer Bank";
  }

  return paymentMethod ? paymentMethod.toUpperCase() : "Lainnya";
}

export function formatReceiptOrderTypeLabel(
  orderType: string,
  tableName?: string | null,
): string {
  if (orderType === "dine_in") {
    return tableName ? `Dine-in · Meja ${tableName}` : "Dine-in";
  }
  if (orderType === "takeaway") {
    return "Takeaway";
  }
  return orderType.toUpperCase();
}

/**
 * Menghitung nomor antrean (posisi antrean dapur) yang ditampilkan pada struk:
 * Posisi Antrean = (jumlah item menu pesanan sebelumnya di dapur KDS yang belum selesai) + 1.
 * Contoh:
 * - 0 item di depan -> 1 antrean
 * - 2 item di depan -> 3 antrean
 * - 4 item di depan -> 5 antrean
 * - 7 item di depan -> 8 antrean
 * Menunjukkan posisi aktual pesanan dalam antrean dapur saat itu,
 * bukan nomor urutan permanen database (mis. A006).
 */
export function formatReceiptQueuePositionLabel(
  remainingQueueItems?: number | null,
  explicitPosition?: number | null,
): string {
  if (
    explicitPosition !== undefined &&
    explicitPosition !== null &&
    !Number.isNaN(Number(explicitPosition)) &&
    Number(explicitPosition) > 0
  ) {
    return `${Math.round(Number(explicitPosition))} antrean`;
  }
  const remaining = Math.max(0, Number(remainingQueueItems) || 0);
  return `${remaining + 1} antrean`;
}

/**
 * Format nomor antrean struk yang mengikuti posisi aktual pesanan pelanggan
 * dalam antrean dapur (KDS) saat itu.
 */
export function formatReceiptQueueNumberLabel(
  remainingQueueItems?: number | null,
  explicitPosition?: number | null,
): string {
  return formatReceiptQueuePositionLabel(remainingQueueItems, explicitPosition);
}

export function formatRemainingQueueLabel(remainingItems?: number | null): string {
  const count = Math.max(0, Number(remainingItems) || 0);
  return `${count}`;
}

export function formatSafeReceiptError(rawMessage?: string): string {
  if (!rawMessage) {
    return "Gagal memuat data struk pesanan. Status pembayaran tetap aman; silakan coba muat ulang atau buka dari Daftar Pesanan.";
  }

  const clean = rawMessage.replace(/^[A-Z0-9]+:\s*/i, "").trim();

  if (
    clean.includes("Hanya admin atau kasir") ||
    clean.includes("ID pesanan tidak valid") ||
    clean.includes("tidak ditemukan") ||
    clean.includes("Klien database tidak tersedia") ||
    clean.includes("Sesi Anda tidak valid")
  ) {
    return clean;
  }

  return "Gagal memuat data struk pesanan. Status pembayaran tetap aman; silakan muat ulang struk atau cetak ulang dari Daftar Pesanan.";
}
