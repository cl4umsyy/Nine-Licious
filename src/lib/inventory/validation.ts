import { z } from "zod";
import {
  INGREDIENT_UNITS,
  INVENTORY_LIMITS,
  MANUAL_STOCK_MOVEMENT_TYPES,
  STOCK_MOVEMENT_TYPES,
} from "./constants";
import { roundQuantity3 } from "./calculations";

export const inventoryUuidSchema = z
  .string()
  .trim()
  .uuid("Format ID tidak valid.");

function hasAtMostThreeDecimals(val: number): boolean {
  // Hindari kesalahan float dengan membandingkan nilai yang sudah dibulatkan ke 3 desimal
  const scaled = val * 1000;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

const finiteQuantitySchema = z
  .number({
    error: "Jumlah harus berupa angka yang valid.",
  })
  .refine((v) => Number.isFinite(v), "Jumlah harus berupa angka terhingga.")
  .refine(
    (v) => Math.abs(v) <= INVENTORY_LIMITS.MAX_QUANTITY,
    `Jumlah tidak boleh melebihi ${INVENTORY_LIMITS.MAX_QUANTITY.toLocaleString("id-ID")}.`,
  )
  .refine(
    hasAtMostThreeDecimals,
    `Maksimal ${INVENTORY_LIMITS.MAX_DECIMAL_PLACES} angka di belakang koma.`,
  );

const optionalTrimmedSkuSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((val) => {
    if (val === null || val === undefined) return null;
    const trimmed = val.trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine(
    (val) => val === null || INVENTORY_LIMITS.SKU_REGEX.test(val),
    `SKU harus ${INVENTORY_LIMITS.SKU_MIN}–${INVENTORY_LIMITS.SKU_MAX} karakter (huruf, angka, titik, garis bawah, atau tanda hubung).`,
  );

const optionalIngredientNotesSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((val) => {
    if (val === null || val === undefined) return null;
    const trimmed = val.trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine(
    (val) => val === null || val.length <= INVENTORY_LIMITS.INGREDIENT_NOTES_MAX,
    `Catatan maksimal ${INVENTORY_LIMITS.INGREDIENT_NOTES_MAX} karakter.`,
  );

const optionalRecipeNotesSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((val) => {
    if (val === null || val === undefined) return null;
    const trimmed = val.trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine(
    (val) => val === null || val.length <= INVENTORY_LIMITS.RECIPE_NOTES_MAX,
    `Catatan resep maksimal ${INVENTORY_LIMITS.RECIPE_NOTES_MAX} karakter.`,
  );

/**
 * Skema pembuatan bahan baku baru.
 * Sengaja TIDAK menerima field `current_stock` / `currentStock` agar
 * semua stok awal selalu 0 dan penambahan stok wajib lewat RPC penyesuaian stok.
 */
export const createIngredientSchema = z
  .object({
    name: z
      .string({ error: "Nama bahan baku wajib diisi." })
      .trim()
      .min(
        INVENTORY_LIMITS.NAME_MIN,
        `Nama bahan baku minimal ${INVENTORY_LIMITS.NAME_MIN} karakter.`,
      )
      .max(
        INVENTORY_LIMITS.NAME_MAX,
        `Nama bahan baku maksimal ${INVENTORY_LIMITS.NAME_MAX} karakter.`,
      ),
    sku: optionalTrimmedSkuSchema.optional().default(null),
    unit: z.enum(INGREDIENT_UNITS, {
      error: "Satuan bahan baku tidak valid.",
    }),
    minStock: finiteQuantitySchema
      .refine((v) => v >= 0, "Batas stok minimum tidak boleh negatif.")
      .transform((v) => roundQuantity3(v)),
    notes: optionalIngredientNotesSchema.optional().default(null),
  })
  .strict();

export type CreateIngredientInput = z.input<typeof createIngredientSchema>;

/**
 * Skema pembaruan metadata bahan baku.
 * Dilarang menerima `current_stock` / `currentStock` (.strict() menolak field tak dikenal).
 */
export const updateIngredientSchema = z
  .object({
    ingredientId: inventoryUuidSchema,
    name: z
      .string({ error: "Nama bahan baku wajib diisi." })
      .trim()
      .min(
        INVENTORY_LIMITS.NAME_MIN,
        `Nama bahan baku minimal ${INVENTORY_LIMITS.NAME_MIN} karakter.`,
      )
      .max(
        INVENTORY_LIMITS.NAME_MAX,
        `Nama bahan baku maksimal ${INVENTORY_LIMITS.NAME_MAX} karakter.`,
      ),
    sku: optionalTrimmedSkuSchema.optional().default(null),
    unit: z.enum(INGREDIENT_UNITS, {
      error: "Satuan bahan baku tidak valid.",
    }),
    minStock: finiteQuantitySchema
      .refine((v) => v >= 0, "Batas stok minimum tidak boleh negatif.")
      .transform((v) => roundQuantity3(v)),
    notes: optionalIngredientNotesSchema.optional().default(null),
  })
  .strict();

export type UpdateIngredientInput = z.input<typeof updateIngredientSchema>;

/**
 * Skema arsip / aktifkan kembali bahan baku (soft archive).
 */
export const toggleIngredientActiveSchema = z
  .object({
    ingredientId: inventoryUuidSchema,
    isActive: z.boolean({
      error: "Status aktif bahan baku harus berupa boolean.",
    }),
    confirmArchiveWithActiveRecipes: z.boolean().optional().default(false),
  })
  .strict();

export type ToggleIngredientActiveInput = z.input<
  typeof toggleIngredientActiveSchema
>;

export const recipeLineInputSchema = z
  .object({
    ingredientId: inventoryUuidSchema,
    quantityRequired: finiteQuantitySchema
      .refine((v) => v > 0, "Takaran bahan pada resep harus lebih besar dari 0.")
      .transform((v) => roundQuantity3(v)),
    notes: optionalRecipeNotesSchema.optional().default(null),
  })
  .strict();

/**
 * Skema simpan resep produk (mendukung beberapa bahan sekaligus, anti duplikat bahan).
 */
export const saveProductRecipeSchema = z
  .object({
    productId: inventoryUuidSchema,
    items: z
      .array(recipeLineInputSchema)
      .max(
        INVENTORY_LIMITS.MAX_RECIPE_LINES_PER_PRODUCT,
        `Maksimal ${INVENTORY_LIMITS.MAX_RECIPE_LINES_PER_PRODUCT} bahan baku per produk.`,
      ),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.items.forEach((item, index) => {
      if (seen.has(item.ingredientId)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "ingredientId"],
          message: "Bahan baku yang sama tidak boleh ditambahkan lebih dari sekali pada satu resep.",
        });
      }
      seen.add(item.ingredientId);
    });
  });

export type SaveProductRecipeInput = z.input<typeof saveProductRecipeSchema>;

export const deleteRecipeLineSchema = z
  .object({
    recipeId: inventoryUuidSchema,
  })
  .strict();

export type DeleteRecipeLineInput = z.input<typeof deleteRecipeLineSchema>;

const optionalIdempotencyKeySchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((val) => {
    if (val === null || val === undefined) return null;
    const trimmed = val.trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine(
    (val) =>
      val === null ||
      (val.length >= INVENTORY_LIMITS.IDEMPOTENCY_KEY_MIN &&
        val.length <= INVENTORY_LIMITS.IDEMPOTENCY_KEY_MAX),
    `Idempotency key harus ${INVENTORY_LIMITS.IDEMPOTENCY_KEY_MIN}–${INVENTORY_LIMITS.IDEMPOTENCY_KEY_MAX} karakter.`,
  );

/**
 * Skema penyesuaian stok manual (diproses lewat RPC `adjust_ingredient_stock_atomic`).
 */
export const adjustIngredientStockSchema = z
  .object({
    ingredientId: inventoryUuidSchema,
    movementType: z.enum(MANUAL_STOCK_MOVEMENT_TYPES, {
      error: "Jenis penyesuaian stok harus manual_in, manual_out, atau stock_opname.",
    }),
    quantity: finiteQuantitySchema.transform((v) => roundQuantity3(v)),
    reason: z
      .string({ error: "Alasan penyesuaian stok wajib diisi." })
      .trim()
      .min(
        INVENTORY_LIMITS.REASON_MIN,
        `Alasan penyesuaian stok wajib diisi minimal ${INVENTORY_LIMITS.REASON_MIN} karakter.`,
      )
      .max(
        INVENTORY_LIMITS.REASON_MAX,
        `Alasan penyesuaian stok maksimal ${INVENTORY_LIMITS.REASON_MAX} karakter.`,
      ),
    idempotencyKey: optionalIdempotencyKeySchema.optional().default(null),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      (data.movementType === "manual_in" || data.movementType === "manual_out") &&
      data.quantity <= 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["quantity"],
        message: "Jumlah penyesuaian stok masuk/keluar harus lebih besar dari 0.",
      });
    }

    if (data.movementType === "stock_opname" && data.quantity < 0) {
      ctx.addIssue({
        code: "custom",
        path: ["quantity"],
        message: "Stok aktual pada stock opname tidak boleh negatif.",
      });
    }
  });

export type AdjustIngredientStockInput = z.input<
  typeof adjustIngredientStockSchema
>;

function isValidIsoCalendarDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [yStr, mStr, dStr] = dateStr.split("-");
  const y = Number.parseInt(yStr, 10);
  const m = Number.parseInt(mStr, 10);
  const d = Number.parseInt(dStr, 10);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

const isoDateSchema = z
  .string({ error: "Tanggal wajib diisi." })
  .trim()
  .refine(
    isValidIsoCalendarDate,
    "Format tanggal tidak valid. Gunakan format YYYY-MM-DD.",
  );

/**
 * Skema filter laporan pemakaian bahan baku.
 */
export const usageReportFilterSchema = z
  .object({
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    ingredientId: z
      .union([inventoryUuidSchema, z.null(), z.undefined(), z.literal("")])
      .transform((v) => (!v ? null : v))
      .optional()
      .default(null),
    movementType: z
      .union([
        z.enum(STOCK_MOVEMENT_TYPES),
        z.null(),
        z.undefined(),
        z.literal(""),
      ])
      .transform((v) => (!v ? null : v))
      .optional()
      .default(null),
  })
  .strict()
  .superRefine((data, ctx) => {
    const startMs = Date.parse(`${data.startDate}T00:00:00Z`);
    const endMs = Date.parse(`${data.endDate}T00:00:00Z`);

    if (startMs > endMs) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "Tanggal akhir tidak boleh lebih awal dari tanggal mulai.",
      });
      return;
    }

    const diffDays = Math.round((endMs - startMs) / 86_400_000) + 1;
    if (diffDays > INVENTORY_LIMITS.MAX_REPORT_RANGE_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: `Rentang laporan maksimal ${INVENTORY_LIMITS.MAX_REPORT_RANGE_DAYS} hari.`,
      });
    }
  });

export type UsageReportFilterInput = z.input<typeof usageReportFilterSchema>;

export function fieldErrorsFrom(
  error: z.ZodError,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_form";
    if (!fields[key]) {
      fields[key] = issue.message;
    }
  }
  return fields;
}

export function firstZodError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Data yang dikirim tidak valid.";
}
