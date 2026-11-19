/**
 * Konstanta domain F4 — Stok dan Bahan Baku.
 * Selaras 100% dengan constraint CHECK pada migrasi
 * `supabase/migrations/20261119000100_f4_inventory_stock.sql`.
 */

export const INGREDIENT_UNITS = [
  "g",
  "kg",
  "ml",
  "l",
  "pcs",
  "pack",
  "porsi",
  "sachet",
] as const;

export type IngredientUnit = (typeof INGREDIENT_UNITS)[number];

export const INGREDIENT_UNIT_LABELS: Record<IngredientUnit, string> = {
  g: "Gram (g)",
  kg: "Kilogram (kg)",
  ml: "Mililiter (ml)",
  l: "Liter (l)",
  pcs: "Pieces (pcs)",
  pack: "Pack",
  porsi: "Porsi",
  sachet: "Sachet",
};

export const STOCK_MOVEMENT_TYPES = [
  "sale_deduction",
  "manual_in",
  "manual_out",
  "stock_opname",
] as const;

export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const MANUAL_STOCK_MOVEMENT_TYPES = [
  "manual_in",
  "manual_out",
  "stock_opname",
] as const;

export type ManualStockMovementType =
  (typeof MANUAL_STOCK_MOVEMENT_TYPES)[number];

export const STOCK_MOVEMENT_LABELS: Record<StockMovementType, string> = {
  sale_deduction: "Pengurangan Penjualan",
  manual_in: "Stok Masuk Manual",
  manual_out: "Stok Keluar Manual",
  stock_opname: "Stock Opname",
};

export const STOCK_MOVEMENT_DESCRIPTIONS: Record<StockMovementType, string> = {
  sale_deduction: "Otomatis saat pesanan lunas sesuai resep produk.",
  manual_in: "Penambahan stok dari pembelian, restock, atau pengembalian manual.",
  manual_out: "Pengurangan stok manual (rusak, tumpah, kedaluwarsa, atau waste).",
  stock_opname: "Penyesuaian saldo mengikuti hasil hitung fisik aktual.",
};

export const STOCK_STATUSES = ["safe", "low_stock", "out_of_stock"] as const;

export type StockStatus = (typeof STOCK_STATUSES)[number];

export const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  safe: "Tersedia",
  low_stock: "Stok Rendah",
  out_of_stock: "Habis",
};

/**
 * Batas presisi & panjang kolom sesuai constraint database F4.1:
 * - numeric(12, 3) -> maksimal 9 digit bulat + 3 digit desimal.
 */
export const INVENTORY_LIMITS = {
  NAME_MIN: 2,
  NAME_MAX: 80,
  SKU_MIN: 2,
  SKU_MAX: 32,
  SKU_REGEX: /^[A-Za-z0-9._-]{2,32}$/,
  INGREDIENT_NOTES_MAX: 500,
  RECIPE_NOTES_MAX: 300,
  REASON_MIN: 3,
  REASON_MAX: 500,
  IDEMPOTENCY_KEY_MIN: 8,
  IDEMPOTENCY_KEY_MAX: 128,
  MAX_QUANTITY: 999_999_999,
  MAX_DECIMAL_PLACES: 3,
  MAX_RECIPE_LINES_PER_PRODUCT: 100,
  MAX_REPORT_RANGE_DAYS: 366,
} as const;
