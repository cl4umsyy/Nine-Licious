/**
 * NINE LICIOUS POS — AUDIT FILTER VALIDATION
 * File: src/lib/audit/validation.ts
 */

import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const auditFilterSchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    role: z.enum(["all", "admin", "kasir", "kitchen"]).default("all"),
    action: z.string().trim().max(100).optional(),
    entity: z.string().trim().max(100).optional(),
    startDate: z
      .string()
      .regex(dateRegex, "Format tanggal mulai harus YYYY-MM-DD.")
      .optional()
      .or(z.literal("")),
    endDate: z
      .string()
      .regex(dateRegex, "Format tanggal akhir harus YYYY-MM-DD.")
      .optional()
      .or(z.literal("")),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(5).max(100).default(20),
  })
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return data.startDate <= data.endDate;
      }
      return true;
    },
    {
      message: "Tanggal mulai tidak boleh melebihi tanggal akhir.",
      path: ["startDate"],
    },
  );
