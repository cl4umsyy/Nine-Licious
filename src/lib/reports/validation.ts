import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const dateRangeFilterSchema = z
  .object({
    startDate: z
      .string({ error: "Tanggal mulai wajib diisi." })
      .trim()
      .regex(dateRegex, "Format tanggal mulai harus YYYY-MM-DD.")
      .refine(
        (val) => !isNaN(Date.parse(`${val}T00:00:00Z`)),
        "Tanggal mulai tidak valid.",
      ),
    endDate: z
      .string({ error: "Tanggal akhir wajib diisi." })
      .trim()
      .regex(dateRegex, "Format tanggal akhir harus YYYY-MM-DD.")
      .refine(
        (val) => !isNaN(Date.parse(`${val}T00:00:00Z`)),
        "Tanggal akhir tidak valid.",
      ),
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
    if (diffDays > 366) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "Rentang tanggal laporan maksimal 366 hari.",
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
  return error.issues[0]?.message ?? "Parameter tanggal tidak valid.";
}
