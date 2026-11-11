export const PRODUCT_PHOTO_BUCKET = "product-photos";
export const PRODUCT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PRODUCT_PHOTO_ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const KITCHEN_STATIONS = ["kitchen", "bar", "dessert"] as const;

export const KITCHEN_STATION_LABELS: Record<
  (typeof KITCHEN_STATIONS)[number],
  string
> = {
  kitchen: "Dapur utama",
  bar: "Bar",
  dessert: "Dessert",
};

export const MODIFIER_SELECTION_LABELS = {
  single: "Pilihan tunggal",
  multiple: "Pilihan ganda",
} as const;
