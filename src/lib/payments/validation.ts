import { z } from "zod";

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const manualPaymentSchema = z
  .object({
    orderId: z
      .string()
      .trim()
      .regex(uuidRegex, "ID pesanan tidak valid."),
    paymentMethod: z.enum(["cash", "qris", "bank_transfer"], {
      message: "Metode pembayaran harus 'cash', 'qris', atau 'bank_transfer'.",
    }),
    paymentSource: z.enum(["cash", "qris_manual", "bank_transfer"], {
      message: "Sumber pembayaran harus 'cash', 'qris_manual', atau 'bank_transfer'.",
    }),
    amount: z.coerce
      .number({ message: "Nominal pembayaran harus berupa angka." })
      .int("Nominal pembayaran harus bilangan bulat rupiah.")
      .positive("Nominal pembayaran harus lebih besar dari 0."),
    cashReceived: z.coerce
      .number({ message: "Uang diterima harus berupa angka." })
      .int("Uang diterima harus bilangan bulat rupiah.")
      .positive("Uang diterima harus lebih besar dari 0.")
      .optional()
      .nullable(),
    changeAmount: z.coerce
      .number({ message: "Kembalian harus berupa angka." })
      .int("Kembalian harus bilangan bulat rupiah.")
      .min(0, "Kembalian tidak boleh negatif.")
      .default(0),
    referenceNumber: z
      .string()
      .trim()
      .max(100, "Nomor referensi maksimal 100 karakter.")
      .optional()
      .nullable(),
    idempotencyKey: z
      .string({ message: "Kunci idempotensi pembayaran wajib diisi." })
      .trim()
      .min(8, "Kunci idempotensi pembayaran minimal 8 karakter.")
      .max(128, "Kunci idempotensi pembayaran maksimal 128 karakter."),
    notes: z
      .string()
      .trim()
      .max(255, "Catatan pembayaran maksimal 255 karakter.")
      .optional()
      .nullable(),
  })
  .superRefine((data, ctx) => {
    // 1. Validasi kesesuaian metode dan sumber
    if (data.paymentMethod === "cash" && data.paymentSource !== "cash") {
      ctx.addIssue({
        code: "custom",
        path: ["paymentSource"],
        message: "Metode pembayaran tunai (cash) hanya dapat menggunakan sumber 'cash'.",
      });
    }

    if (data.paymentMethod === "qris" && data.paymentSource !== "qris_manual") {
      ctx.addIssue({
        code: "custom",
        path: ["paymentSource"],
        message: "Untuk pembayaran manual kasir, QRIS hanya mendukung sumber 'qris_manual'.",
      });
    }

    if (data.paymentMethod === "bank_transfer" && data.paymentSource !== "bank_transfer") {
      ctx.addIssue({
        code: "custom",
        path: ["paymentSource"],
        message: "Metode transfer bank hanya dapat menggunakan sumber 'bank_transfer'.",
      });
    }

    // 2. Validasi integritas pembayaran tunai
    if (data.paymentSource === "cash") {
      if (data.cashReceived === null || data.cashReceived === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["cashReceived"],
          message: "Uang tunai yang diterima wajib diisi untuk pembayaran tunai.",
        });
      } else if (data.cashReceived < data.amount) {
        ctx.addIssue({
          code: "custom",
          path: ["cashReceived"],
          message: `Uang tunai yang diterima (Rp ${data.cashReceived.toLocaleString("id-ID")}) kurang dari nominal pembayaran (Rp ${data.amount.toLocaleString("id-ID")}).`,
        });
      } else {
        const expectedChange = data.cashReceived - data.amount;
        if (data.changeAmount !== expectedChange) {
          ctx.addIssue({
            code: "custom",
            path: ["changeAmount"],
            message: `Kembalian tunai tidak cocok. Seharusnya Rp ${expectedChange.toLocaleString("id-ID")}.`,
          });
        }
      }
    }

    // 3. Validasi integritas pembayaran non-tunai
    if (data.paymentSource !== "cash") {
      if (data.cashReceived !== null && data.cashReceived !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["cashReceived"],
          message: "Pembayaran non-tunai tidak boleh menyertakan uang tunai diterima.",
        });
      }
      if (data.changeAmount !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["changeAmount"],
          message: "Pembayaran non-tunai tidak boleh memiliki kembalian.",
        });
      }
    }
  });

export function firstZodError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Validasi data pembayaran gagal.";
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

