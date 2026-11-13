import { z } from "zod";

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const discountIdSchema = z
  .string()
  .trim()
  .regex(uuidRegex, "ID diskon tidak valid.");

export const saveDiscountSchema = z
  .object({
    id: z.string().trim().regex(uuidRegex, "ID diskon tidak valid.").optional().nullable(),
    name: z
      .string()
      .trim()
      .min(2, "Nama promo minimal 2 karakter.")
      .max(80, "Nama promo maksimal 80 karakter."),
    scope: z.enum(["product", "order"], {
      message: "Cakupan diskon harus 'product' atau 'order'.",
    }),
    discountType: z.enum(["percentage", "fixed"], {
      message: "Tipe diskon harus 'percentage' atau 'fixed'.",
    }),
    discountValue: z.coerce
      .number({ message: "Nilai diskon harus berupa angka." })
      .positive("Nilai diskon harus lebih dari 0."),
    appliesToCategoryId: z
      .string()
      .trim()
      .regex(uuidRegex, "ID kategori tidak valid.")
      .optional()
      .nullable(),
    appliesToProductId: z
      .string()
      .trim()
      .regex(uuidRegex, "ID produk tidak valid.")
      .optional()
      .nullable(),
    minOrderAmount: z.coerce
      .number({ message: "Minimal belanja harus berupa angka." })
      .int("Minimal belanja harus bilangan bulat.")
      .min(0, "Minimal belanja tidak boleh negatif.")
      .default(0),
    maxDiscountAmount: z.coerce
      .number({ message: "Batas maksimal diskon harus berupa angka." })
      .int("Batas maksimal diskon harus bilangan bulat.")
      .positive("Batas maksimal diskon harus lebih dari 0.")
      .optional()
      .nullable(),
    isActive: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    // 1. Validasi persentase
    if (data.discountType === "percentage" && data.discountValue > 100) {
      ctx.addIssue({
        code: "custom",
        path: ["discountValue"],
        message: "Persentase diskon tidak boleh melebihi 100%.",
      });
    }

    // 2. Validasi fixed rupiah wajib bilangan bulat
    if (data.discountType === "fixed" && !Number.isInteger(data.discountValue)) {
      ctx.addIssue({
        code: "custom",
        path: ["discountValue"],
        message: "Nominal diskon rupiah harus berupa bilangan bulat.",
      });
    }

    // 3. Validasi scope order tidak boleh memiliki target produk atau kategori
    if (data.scope === "order") {
      if (data.appliesToCategoryId) {
        ctx.addIssue({
          code: "custom",
          path: ["appliesToCategoryId"],
          message: "Promo pesanan (order) tidak boleh dibatasi ke kategori tertentu.",
        });
      }
      if (data.appliesToProductId) {
        ctx.addIssue({
          code: "custom",
          path: ["appliesToProductId"],
          message: "Promo pesanan (order) tidak boleh dibatasi ke produk tertentu.",
        });
      }
    }

    // 4. Validasi scope product tidak boleh menargetkan kategori dan produk sekaligus
    if (data.scope === "product") {
      if (data.appliesToCategoryId && data.appliesToProductId) {
        ctx.addIssue({
          code: "custom",
          path: ["appliesToProductId"],
          message: "Pilih salah satu target: Kategori ATAU Produk spesifik, tidak keduanya.",
        });
      }
    }
  });

export const requestDiscountApprovalSchema = z
  .object({
    adminEmail: z
      .string()
      .trim()
      .email("Format email Admin tidak valid."),
    adminPassword: z
      .string()
      .min(1, "Kata sandi Admin wajib diisi."),
    discountType: z.enum(["percentage", "fixed"], {
      message: "Tipe diskon harus 'percentage' atau 'fixed'.",
    }),
    discountValue: z.coerce
      .number({ message: "Nilai diskon harus berupa angka." })
      .positive("Nilai diskon harus lebih dari 0."),
    reason: z
      .string()
      .trim()
      .min(3, "Alasan diskon manual minimal 3 karakter.")
      .max(300, "Alasan diskon manual maksimal 300 karakter."),
    idempotencyKey: z
      .string()
      .trim()
      .min(8, "Kunci idempotensi keranjang tidak valid."),
  })
  .superRefine((data, ctx) => {
    if (data.discountType === "percentage" && data.discountValue > 100) {
      ctx.addIssue({
        code: "custom",
        path: ["discountValue"],
        message: "Persentase diskon manual tidak boleh melebihi 100%.",
      });
    }
  });

export const finalizeOrderSchema = z.object({
  orderId: discountIdSchema,
});

export const unfinalizeOrderSchema = z.object({
  orderId: discountIdSchema,
  reason: z
    .string()
    .trim()
    .min(3, "Alasan pembukaan kembali pesanan minimal 3 karakter.")
    .max(300, "Alasan pembukaan kembali pesanan maksimal 300 karakter."),
});

export function firstZodError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Validasi data gagal.";
}

export function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}

