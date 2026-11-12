import type { TableShape, TableStatus } from "@/types/database";

/**
 * Kanvas virtual denah. Posisi meja disimpan dalam koordinat kanvas ini lalu
 * diskalakan ke lebar layar oleh komponen denah.
 */
export const FLOOR_PLAN_WIDTH = 1200;
export const FLOOR_PLAN_HEIGHT = 800;
export const FLOOR_PLAN_GRID = 10;

export const TABLE_SHAPES: readonly TableShape[] = ["rectangle", "round"];

export const TABLE_SHAPE_LABELS: Record<TableShape, string> = {
  rectangle: "Persegi panjang",
  round: "Bulat",
};

export const TABLE_STATUSES: readonly TableStatus[] = [
  "empty",
  "awaiting_payment",
  "occupied",
];

export const TABLE_STATUS_LABELS: Record<TableStatus, string> = {
  empty: "Kosong",
  awaiting_payment: "Menunggu Pembayaran",
  occupied: "Terisi",
};

export const TABLE_STATUS_DESCRIPTIONS: Record<TableStatus, string> = {
  empty: "Tidak ada kunjungan dine-in aktif.",
  awaiting_payment:
    "Ada kunjungan aktif dengan minimal satu pesanan yang belum lunas.",
  occupied:
    "Semua pesanan aktif dalam kunjungan sudah lunas; pelanggan masih di meja.",
};

export type TableDimensions = {
  width: number;
  height: number;
};

/**
 * Ukuran visual meja diturunkan dari kapasitas dan bentuk agar meja besar
 * terlihat lebih besar tanpa menambah kolom ukuran manual.
 */
export function tableDimensions(
  capacity: number,
  shape: TableShape,
): TableDimensions {
  const safeCapacity = Math.min(Math.max(capacity, 1), 12);
  const base = 72 + safeCapacity * 4;

  if (shape === "round") {
    return { width: base, height: base };
  }

  return { width: base + 28, height: Math.round(base * 0.72) };
}

export function clampToFloorPlan(
  x: number,
  y: number,
  capacity: number,
  shape: TableShape,
): { x: number; y: number } {
  const size = tableDimensions(capacity, shape);

  return {
    x: Math.min(Math.max(x, 0), FLOOR_PLAN_WIDTH - size.width),
    y: Math.min(Math.max(y, 0), FLOOR_PLAN_HEIGHT - size.height),
  };
}

export function snapToGrid(value: number): number {
  return Math.round(value / FLOOR_PLAN_GRID) * FLOOR_PLAN_GRID;
}
