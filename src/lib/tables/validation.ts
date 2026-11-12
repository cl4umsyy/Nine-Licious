import { z } from "zod";
import {
  FLOOR_PLAN_HEIGHT,
  FLOOR_PLAN_WIDTH,
  tableDimensions,
} from "@/lib/tables/constants";

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "ID tidak valid.",
  );

function integerField(
  min: number,
  max: number,
  message: string,
): z.ZodType<number, string> {
  return z
    .string()
    .trim()
    .min(1, message)
    .regex(/^\d+$/, message)
    .transform((value) => Number(value))
    .refine((value) => value >= min && value <= max, message);
}

export const zoneSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Nama area minimal 2 karakter.")
    .max(40, "Nama area maksimal 40 karakter."),
  sortOrder: integerField(0, 9999, "Urutan harus berupa angka 0–9999."),
  isActive: z.boolean(),
});

export const diningTableSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Nama meja minimal 1 karakter.")
      .max(40, "Nama meja maksimal 40 karakter."),
    zoneId: uuidSchema,
    capacity: integerField(1, 50, "Kapasitas harus 1–50 orang."),
    positionX: integerField(
      0,
      FLOOR_PLAN_WIDTH,
      `Posisi X harus 0–${FLOOR_PLAN_WIDTH}.`,
    ),
    positionY: integerField(
      0,
      FLOOR_PLAN_HEIGHT,
      `Posisi Y harus 0–${FLOOR_PLAN_HEIGHT}.`,
    ),
    shape: z.enum(["rectangle", "round"]),
    isActive: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const size = tableDimensions(value.capacity, value.shape);

    if (value.positionX + size.width > FLOOR_PLAN_WIDTH) {
      ctx.addIssue({
        code: "custom",
        path: ["positionX"],
        message: "Posisi meja melewati batas kanan denah.",
      });
    }

    if (value.positionY + size.height > FLOOR_PLAN_HEIGHT) {
      ctx.addIssue({
        code: "custom",
        path: ["positionY"],
        message: "Posisi meja melewati batas bawah denah.",
      });
    }
  });

export const tablePositionSchema = z.object({
  id: uuidSchema,
  x: z.coerce
    .number()
    .int("Posisi X harus berupa bilangan bulat.")
    .min(0, "Posisi X tidak valid.")
    .max(FLOOR_PLAN_WIDTH, `Posisi X maksimal ${FLOOR_PLAN_WIDTH}.`),
  y: z.coerce
    .number()
    .int("Posisi Y harus berupa bilangan bulat.")
    .min(0, "Posisi Y tidak valid.")
    .max(FLOOR_PLAN_HEIGHT, `Posisi Y maksimal ${FLOOR_PLAN_HEIGHT}.`),
});

export const tablePositionsSchema = z
  .array(tablePositionSchema)
  .min(1, "Tidak ada posisi meja yang disimpan.")
  .max(200, "Maksimal 200 meja per area.");

export const tableIdSchema = uuidSchema;

export function formBoolean(value: FormDataEntryValue | null): boolean {
  return value === "true" || value === "on" || value === "1";
}

export function fieldErrorsFrom(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!errors[key]) {
      errors[key] = issue.message;
    }
  }

  return errors;
}

export function firstZodError(error: {
  issues: Array<{ message: string }>;
}): string {
  return error.issues[0]?.message ?? "Data tidak valid.";
}
