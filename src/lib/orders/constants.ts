import type { OrderStatus, OrderType, PaymentStatus } from "@/types/database";

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  dine_in: "Dine-in",
  takeaway: "Takeaway",
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  awaiting_payment: "Menunggu Pembayaran",
  partially_paid: "Sebagian Dibayar",
  paid: "Lunas",
  completed: "Selesai",
  cancelled: "Dibatalkan",
  refunded: "Refund",
};

export const ORDER_STATUS_BADGES: Record<
  OrderStatus,
  { variant: "default" | "secondary" | "destructive" | "outline"; className: string }
> = {
  awaiting_payment: {
    variant: "outline",
    className: "border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
  },
  partially_paid: {
    variant: "outline",
    className: "border-blue-400 bg-blue-50 text-blue-900 dark:bg-blue-950/60 dark:text-blue-200",
  },
  paid: {
    variant: "outline",
    className: "border-emerald-400 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200",
  },
  completed: {
    variant: "secondary",
    className: "border-zinc-300 bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
  },
  cancelled: {
    variant: "destructive",
    className: "border-rose-400 bg-rose-50 text-rose-900 dark:bg-rose-950/60 dark:text-rose-200",
  },
  refunded: {
    variant: "outline",
    className: "border-purple-400 bg-purple-50 text-purple-900 dark:bg-purple-950/60 dark:text-purple-200",
  },
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: "Belum Dibayar",
  partially_paid: "Sebagian",
  paid: "Lunas",
  partially_refunded: "Refund Sebagian",
  refunded: "Refund Penuh",
};

export const DEFAULT_CANCEL_REASONS = [
  "Pelanggan batal memesan",
  "Salah input meja atau jenis pesanan",
  "Menu yang diinginkan mendadak habis",
  "Waktu tunggu terlalu lama",
  "Input dobel/duplikasi kasir",
  "Alasan lainnya",
] as const;

