import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const transactionFilterSchema = z
  .object({
    search: z
      .string()
      .trim()
      .max(100, "Kata kunci pencarian maksimal 100 karakter.")
      .optional()
      .default(""),
    startDate: z
      .string()
      .trim()
      .regex(dateRegex, "Format tanggal mulai harus YYYY-MM-DD.")
      .optional()
      .or(z.literal("")),
    endDate: z
      .string()
      .trim()
      .regex(dateRegex, "Format tanggal akhir harus YYYY-MM-DD.")
      .optional()
      .or(z.literal("")),
    paymentStatus: z
      .enum([
        "all",
        "unpaid",
        "partially_paid",
        "paid",
        "partially_refunded",
        "refunded",
      ])
      .optional()
      .default("all"),
    orderStatus: z
      .enum([
        "all",
        "awaiting_payment",
        "partially_paid",
        "paid",
        "completed",
        "cancelled",
        "refunded",
      ])
      .optional()
      .default("all"),
    paymentMethod: z
      .enum(["all", "cash", "midtrans", "split"])
      .optional()
      .default("all"),
    orderType: z.enum(["all", "dine_in", "takeaway"]).optional().default("all"),
    cashierId: z.string().trim().optional().default("all"),
    shiftId: z.string().trim().optional().default("all"),
    page: z.coerce
      .number()
      .int()
      .min(1, "Halaman minimal 1.")
      .optional()
      .default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(5, "Ukuran halaman minimal 5.")
      .max(100, "Ukuran halaman maksimal 100.")
      .optional()
      .default(20),
  })
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return data.startDate <= data.endDate;
      }
      return true;
    },
    {
      message: "Tanggal mulai tidak boleh lebih besar dari tanggal akhir.",
      path: ["startDate"],
    },
  );

export type ValidatedTransactionFilter = z.infer<typeof transactionFilterSchema>;

export function firstZodError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Validasi filter transaksi gagal.";
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
