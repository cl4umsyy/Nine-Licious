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
