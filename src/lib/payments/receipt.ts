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

/**
 * Menentukan apakah pesanan kandidat berada sebelum pesanan target dalam
 * urutan pemrosesan dapur Kitchen Display System (KDS).
 *
 * Aturan Urutan Pemrosesan KDS:
 * 1. Pesanan target sendiri (id yang sama) tidak pernah berada di depan dirinya sendiri.
 * 2. Hanya tiket yang aktif di antrean dapur ('preparing' atau 'queued') yang dihitung.
 *    Tiket 'ready', 'completed', 'cancelled', atau sudah disajikan ('served_at' terisi) TIDAK dihitung.
 * 3. Jika target order sudah selesai (ready atau sudah disajikan), sisa antrean dapur adalah 0.
 * 4. Urutan Status KDS:
 *    - Tiket berstatus 'preparing' (sedang dimasak/diracik) SELALU diproses sebelum tiket 'queued'
 *      (menunggu dimasak), terlepas dari created_at masing-masing.
 * 5. Jika kedua tiket berstatus sama ('preparing' vs 'preparing' ATAU 'queued' vs 'queued'):
 *    - Urutkan berdasarkan nomor antrean harian jika keduanya memiliki queue_number:
 *      * Tanggal antrean (queue_date) lebih awal diproses lebih dulu.
 *      * Jika tanggal antrean sama, urutkan berdasarkan nilai numerik queue_number (mis. A005 < A009).
 *    - Jika salah satu tidak memiliki queue_number, fallback ke waktu masuk (created_at FIFO).
 *    - Tie-breaker berdasarkan order_number.
 */
export function isOrderBeforeInKds(
  candidate: {
    id: string;
    kds_status?: string | null;
    created_at: string;
    queue_date?: string | null;
    queue_number?: string | null;
    order_number?: string | null;
  },
  target: {
    id: string;
    kds_status?: string | null;
    created_at: string;
    queue_date?: string | null;
    queue_number?: string | null;
    order_number?: string | null;
    served_at?: string | null;
  },
): boolean {
  if (candidate.id === target.id) {
    return false;
  }

  if (candidate.kds_status !== "preparing" && candidate.kds_status !== "queued") {
    return false;
  }

  if (target.served_at || target.kds_status === "ready") {
    return false;
  }

  const candidateStatus = candidate.kds_status === "preparing" ? "preparing" : "queued";
  const targetStatus = target.kds_status === "preparing" ? "preparing" : "queued";

  if (candidateStatus === "preparing" && targetStatus === "queued") {
    return true;
  }
  if (candidateStatus === "queued" && targetStatus === "preparing") {
    return false;
  }

  if (candidate.queue_number && target.queue_number) {
    if (candidate.queue_date && target.queue_date && candidate.queue_date !== target.queue_date) {
      return candidate.queue_date < target.queue_date;
    }

    const candNumMatch = candidate.queue_number.match(/\d+/);
    const targetNumMatch = target.queue_number.match(/\d+/);

    if (candNumMatch && targetNumMatch) {
      const candNum = parseInt(candNumMatch[0], 10);
      const targetNum = parseInt(targetNumMatch[0], 10);
      if (!Number.isNaN(candNum) && !Number.isNaN(targetNum) && candNum !== targetNum) {
        return candNum < targetNum;
      }
    }

    const qCmp = candidate.queue_number.localeCompare(target.queue_number);
    if (qCmp !== 0) {
      return qCmp < 0;
    }
  }

  const candCreatedMs = Date.parse(candidate.created_at);
  const targetCreatedMs = Date.parse(target.created_at);

  if (!Number.isNaN(candCreatedMs) && !Number.isNaN(targetCreatedMs) && candCreatedMs !== targetCreatedMs) {
    return candCreatedMs < targetCreatedMs;
  }

  const candOrdNum = candidate.order_number ?? "";
  const targetOrdNum = target.order_number ?? "";
  return candOrdNum.localeCompare(targetOrdNum) < 0;
}

/**
 * Menghitung jumlah pesanan/tiket KDS aktif yang berada sebelum pesanan target.
 * Setiap satu tiket pesanan dihitung sebagai 1 antrean, terlepas dari berapa banyak
 * baris item atau kuantitas menu di dalam pesanan tersebut.
 */
export function aggregateKdsPriorItems(
  activeOrders: Array<{
    id: string;
    order_number?: string | null;
    queue_number?: string | null;
    queue_date?: string | null;
    kds_status?: string | null;
    created_at: string;
    order_items?: Array<{ quantity: number }> | null;
  }>,
  targetOrder: {
    id: string;
    order_number?: string | null;
    queue_number?: string | null;
    queue_date?: string | null;
    kds_status?: string | null;
    created_at: string;
    served_at?: string | null;
  },
): number {
  let count = 0;

  for (const ord of activeOrders) {
    if (isOrderBeforeInKds(ord, targetOrder)) {
      count += 1;
    }
  }

  return count;
}

export const aggregateKdsPriorOrders = aggregateKdsPriorItems;

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
