import { z } from "zod";

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const orderIdSchema = z
  .string()
  .trim()
  .regex(uuidRegex, "ID pesanan tidak valid.");

export const tableIdSchema = z
  .string()
  .trim()
  .regex(uuidRegex, "ID meja tidak valid.");

export const createOrderItemSchema = z.object({
  clientItemId: z.string().trim().optional().nullable(),
  productId: z.string().trim().regex(uuidRegex, "ID produk tidak valid."),
  quantity: z.coerce
    .number()
    .int("Jumlah harus berupa bilangan bulat.")
    .min(1, "Jumlah minimal 1.")
    .max(999, "Jumlah maksimal 999."),
  notes: z
    .string()
    .trim()
    .max(300, "Catatan maksimal 300 karakter.")
    .optional()
    .nullable(),
  modifierOptionIds: z
    .array(z.string().trim().regex(uuidRegex, "ID opsi modifier tidak valid."))
    .default([]),
});

export const createOrderDiscountSchema = z.object({
  scope: z.enum(["product", "order", "manual"], {
    message: "Scope diskon harus 'product', 'order', atau 'manual'.",
  }),
  clientItemId: z.string().trim().optional().nullable(),
  orderItemId: z
    .string()
    .trim()
    .regex(uuidRegex, "ID item tidak valid.")
    .optional()
    .nullable(),
  discountId: z
    .string()
    .trim()
    .regex(uuidRegex, "ID diskon tidak valid.")
    .optional()
    .nullable(),
  name: z.string().trim().optional().nullable(),
  discountType: z.enum(["percentage", "fixed"], {
    message: "Tipe diskon harus 'percentage' atau 'fixed'.",
  }),
  discountRate: z.coerce
    .number({ message: "Nilai diskon harus berupa angka." })
    .positive("Nilai diskon harus lebih dari 0."),
  approvalNonce: z.string().trim().optional().nullable(),
  reason: z
    .string()
    .trim()
    .max(300, "Alasan maksimal 300 karakter.")
    .optional()
    .nullable(),
});

export const createOrderSchema = z
  .object({
    orderType: z.enum(["dine_in", "takeaway"], {
      message: "Tipe pesanan harus 'dine_in' atau 'takeaway'.",
    }),
    tableId: z
      .string()
      .trim()
      .regex(uuidRegex, "ID meja tidak valid.")
      .optional()
      .nullable(),
    customerName: z
      .string()
      .trim()
      .max(80, "Nama pelanggan maksimal 80 karakter.")
      .optional()
      .nullable(),
    notes: z
      .string()
      .trim()
      .max(500, "Catatan pesanan maksimal 500 karakter.")
      .optional()
      .nullable(),
    idempotencyKey: z
      .string()
      .trim()
      .min(8, "Kunci idempotensi terlalu pendek.")
      .max(128, "Kunci idempotensi maksimal 128 karakter.")
      .optional()
      .nullable(),
    existingOrderId: z
      .string()
      .trim()
      .regex(uuidRegex, "ID pesanan lama tidak valid.")
      .optional()
      .nullable(),
    items: z
      .array(createOrderItemSchema)
      .min(1, "Keranjang pesanan tidak boleh kosong.")
      .max(100, "Maksimal 100 jenis item per pesanan."),
    discounts: z.array(createOrderDiscountSchema).default([]),
  })
  .superRefine((data, ctx) => {
    if (data.orderType === "dine_in" && !data.tableId) {
      ctx.addIssue({
        code: "custom",
        path: ["tableId"],
        message: "Meja wajib dipilih untuk pesanan Dine-in.",
      });
    }
  });

export const cancelOrderSchema = z.object({
  orderId: orderIdSchema,
  reason: z
    .string()
    .trim()
    .min(3, "Alasan pembatalan minimal 3 karakter.")
    .max(300, "Alasan pembatalan maksimal 300 karakter."),
});

export const appendOrderItemsSchema = z.object({
  orderId: orderIdSchema,
  items: z
    .array(createOrderItemSchema)
    .min(1, "Minimal satu item untuk ditambahkan ke pesanan.")
    .max(100, "Maksimal 100 jenis item per penambahan."),
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

