import { z } from "zod";
import {
  ALLOWED_EVIDENCE_MIME_TYPES,
  COMPENSATION_SEVERITIES,
  MAX_EVIDENCE_FILE_SIZE_BYTES,
  REFUND_INVENTORY_ACTIONS,
  REFUND_REASON_CATEGORIES,
  REFUND_RESOLUTION_TYPES,
} from "./types";

const uuidSchema = z.string().uuid("Format UUID tidak valid.");

export const refundItemSelectionSchema = z
  .object({
    orderItemId: uuidSchema,
    quantity: z.coerce
      .number()
      .int("Kuantitas item harus berupa bilangan bulat.")
      .min(1, "Kuantitas minimal 1.")
      .max(500, "Kuantitas maksimal 500."),
    compensationSeverity: z.enum(COMPENSATION_SEVERITIES).optional(),
    inventoryAction: z.enum(REFUND_INVENTORY_ACTIONS).optional(),
    reason: z
      .string()
      .trim()
      .max(250, "Catatan item maksimal 250 karakter.")
      .optional()
      .nullable(),
  })
  .strict();

export const payoutAllocationInputSchema = z
  .object({
    paymentId: uuidSchema,
    amount: z.coerce
      .number()
      .int("Nominal alokasi harus bilangan bulat rupiah.")
      .min(1, "Nominal alokasi minimal Rp 1.")
      .max(1_000_000_000),
    payoutMethod: z.enum(["cash", "transfer", "midtrans", "manual"]).optional(),
  })
  .strict();

export const requestOrderRefundSchema = z
  .object({
    orderId: uuidSchema,
    resolutionType: z.enum(REFUND_RESOLUTION_TYPES),
    reasonCategory: z.enum(REFUND_REASON_CATEGORIES),
    reason: z
      .string()
      .trim()
      .min(3, "Alasan refund wajib diisi minimal 3 karakter.")
      .max(500, "Alasan refund maksimal 500 karakter."),
    chronology: z
      .string()
      .trim()
      .min(5, "Kronologi komplain wajib diisi minimal 5 karakter.")
      .max(1500, "Kronologi maksimal 1500 karakter."),
    items: z.array(refundItemSelectionSchema).optional().default([]),
    preferredPayoutMethod: z
      .enum(["cash", "transfer", "midtrans", "manual", "mixed"])
      .optional()
      .nullable(),
    paymentId: uuidSchema.optional().nullable(),
    receiptVerified: z.literal(true, {
      error:
        "Verifikasi struk fisik atau digital Nine Licious wajib dicentang terlebih dahulu.",
    }),
    duplicatePaymentAmount: z.coerce
      .number()
      .int("Nominal pembayaran ganda harus berupa bilangan bulat rupiah.")
      .min(1, "Nominal minimal Rp 1.")
      .max(1_000_000_000)
      .optional()
      .nullable(),
    autoApprove: z.boolean().optional().default(false),
    payoutAllocations: z
      .array(payoutAllocationInputSchema)
      .optional()
      .nullable(),
    shiftId: uuidSchema.optional().nullable(),
    idempotencyKey: z
      .string()
      .trim()
      .min(8, "Kunci idempotensi minimal 8 karakter.")
      .max(128, "Kunci idempotensi maksimal 128 karakter."),
  })
  .strict()
  .superRefine((data, ctx) => {
    const isDuplicatePaymentIssue =
      data.reasonCategory === "payment_issue" &&
      typeof data.duplicatePaymentAmount === "number" &&
      data.duplicatePaymentAmount > 0;

    if (
      data.resolutionType === "replacement" &&
      isDuplicatePaymentIssue
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["resolutionType"],
        message:
          "Masalah pembayaran ganda tidak dapat menggunakan penyelesaian Replacement.",
      });
    }

    if (!isDuplicatePaymentIssue && data.items.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "Minimal satu item pesanan wajib dipilih.",
      });
    }
  });

export const approveOrderRefundSchema = z
  .object({
    refundId: uuidSchema,
    payoutAllocations: z
      .array(payoutAllocationInputSchema)
      .optional()
      .nullable(),
    shiftId: uuidSchema.optional().nullable(),
    approvalNotes: z
      .string()
      .trim()
      .max(500, "Catatan persetujuan maksimal 500 karakter.")
      .optional()
      .nullable(),
    idempotencyKey: z
      .string()
      .trim()
      .max(128)
      .optional()
      .nullable(),
  })
  .strict();

export const rejectOrderRefundSchema = z
  .object({
    refundId: uuidSchema,
    rejectionReason: z
      .string()
      .trim()
      .min(3, "Alasan penolakan wajib diisi minimal 3 karakter.")
      .max(500, "Alasan penolakan maksimal 500 karakter."),
    idempotencyKey: z.string().trim().max(128).optional().nullable(),
  })
  .strict();

export const cancelOrderRefundSchema = z
  .object({
    refundId: uuidSchema,
    cancellationReason: z
      .string()
      .trim()
      .min(3, "Alasan pembatalan wajib diisi minimal 3 karakter.")
      .max(500, "Alasan pembatalan maksimal 500 karakter."),
    idempotencyKey: z.string().trim().max(128).optional().nullable(),
  })
  .strict();

export const attachRefundEvidenceSchema = z
  .object({
    refundId: uuidSchema,
    filePath: z
      .string()
      .trim()
      .min(3, "Path file bukti tidak valid.")
      .max(500, "Path file bukti terlalu panjang.")
      .refine((v) => !v.includes(".."), "Path file tidak boleh mengandung traversal '..'."),
    fileName: z
      .string()
      .trim()
      .min(1, "Nama file bukti wajib diisi.")
      .max(255, "Nama file maksimal 255 karakter."),
    fileType: z.enum(ALLOWED_EVIDENCE_MIME_TYPES, {
      error:
        "Format file harus JPG, PNG, WebP, MP4, WebM, atau MOV.",
    }),
    fileSize: z.coerce
      .number()
      .int()
      .min(1, "Ukuran file bukti harus lebih dari 0 byte.")
      .max(
        MAX_EVIDENCE_FILE_SIZE_BYTES,
        "Ukuran file bukti maksimal 50 MB.",
      ),
    notes: z
      .string()
      .trim()
      .max(500, "Catatan bukti maksimal 500 karakter.")
      .optional()
      .nullable(),
  })
  .strict();

export const requestRefundEvidenceSchema = z
  .object({
    refundId: uuidSchema,
    note: z
      .string()
      .trim()
      .min(3, "Catatan permintaan bukti minimal 3 karakter.")
      .max(500, "Catatan permintaan bukti maksimal 500 karakter."),
  })
  .strict();

export const completeRefundManualFallbackSchema = z
  .object({
    refundId: uuidSchema,
    allocationId: uuidSchema.optional().nullable(),
    payoutReference: z
      .string()
      .trim()
      .min(3, "Referensi transfer bank / bukti wajib diisi minimal 3 karakter.")
      .max(120, "Referensi transfer maksimal 120 karakter."),
    reason: z
      .string()
      .trim()
      .min(3, "Alasan penggunaan transfer manual wajib diisi minimal 3 karakter.")
      .max(500, "Alasan maksimal 500 karakter."),
    idempotencyKey: z.string().trim().max(128).optional().nullable(),
  })
  .strict();

export const recordRefundCorrectionSchema = z
  .object({
    refundId: uuidSchema,
    expectedAmount: z.coerce
      .number()
      .int("Nominal seharusnya harus berupa bilangan bulat rupiah.")
      .min(0, "Nominal tidak boleh negatif.")
      .max(1_000_000_000),
    actualAmount: z.coerce
      .number()
      .int("Nominal aktual harus berupa bilangan bulat rupiah.")
      .min(0, "Nominal tidak boleh negatif.")
      .max(1_000_000_000),
    reason: z
      .string()
      .trim()
      .min(3, "Alasan koreksi wajib diisi minimal 3 karakter.")
      .max(500, "Alasan koreksi maksimal 500 karakter."),
    createSupplementalRefund: z.boolean().optional().default(false),
    supplementalMethod: z
      .enum(["cash", "transfer", "midtrans", "manual"])
      .optional()
      .default("cash"),
    shiftId: uuidSchema.optional().nullable(),
    followUpNotes: z
      .string()
      .trim()
      .max(500, "Catatan tindak lanjut maksimal 500 karakter.")
      .optional()
      .nullable(),
    idempotencyKey: z
      .string()
      .trim()
      .min(8, "Kunci idempotensi koreksi minimal 8 karakter.")
      .max(128),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.expectedAmount === data.actualAmount) {
      ctx.addIssue({
        code: "custom",
        path: ["actualAmount"],
        message:
          "Nominal seharusnya dan nominal aktual tidak boleh sama (tidak ada selisih).",
      });
    }
  });

export function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
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
  return error.issues[0]?.message ?? "Data pengajuan refund tidak valid.";
}
