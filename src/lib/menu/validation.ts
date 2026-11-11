import { z } from "zod";
import { KITCHEN_STATIONS } from "@/lib/menu/constants";

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

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Slug minimal 2 karakter.")
  .max(40, "Slug maksimal 40 karakter.")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Slug hanya boleh berisi huruf kecil, angka, dan tanda hubung.",
  );

const colorSchema = z
  .string()
  .trim()
  .refine(
    (value) => value === "" || /^#[0-9A-Fa-f]{6}$/.test(value),
    "Warna harus memakai format #RRGGBB.",
  )
  .transform((value) => (value === "" ? null : value));

export const categorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Nama kategori minimal 2 karakter.")
    .max(60, "Nama kategori maksimal 60 karakter."),
  slug: slugSchema,
  color: colorSchema,
  sortOrder: integerField(0, 9999, "Urutan harus berupa angka 0–9999."),
  isActive: z.boolean(),
});

export const productSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Nama produk minimal 2 karakter.")
    .max(80, "Nama produk maksimal 80 karakter."),
  categoryId: uuidSchema,
  price: integerField(
    0,
    999_999_999,
    "Harga harus berupa angka rupiah tanpa desimal.",
  ),
  sku: z
    .string()
    .trim()
    .max(32, "SKU maksimal 32 karakter.")
    .transform((value) => value.toUpperCase())
    .refine(
      (value) => value === "" || /^[A-Z0-9._-]{2,32}$/.test(value),
      "SKU hanya boleh berisi huruf, angka, titik, garis bawah, atau tanda hubung (2–32 karakter).",
    )
    .transform((value) => (value === "" ? null : value)),
  description: z
    .string()
    .trim()
    .max(500, "Deskripsi maksimal 500 karakter.")
    .transform((value) => (value === "" ? null : value)),
  isActive: z.boolean(),
  isAvailable: z.boolean(),
  kitchenStation: z
    .string()
    .trim()
    .refine(
      (value) =>
        value === "" ||
        (KITCHEN_STATIONS as readonly string[]).includes(value),
      "Stasiun dapur tidak valid.",
    )
    .transform((value) => (value === "" ? null : value)),
  sortOrder: integerField(0, 9999, "Urutan harus berupa angka 0–9999."),
  modifierGroupIds: z
    .array(uuidSchema)
    .max(30, "Maksimal 30 grup modifier per produk."),
});

export const modifierGroupSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Nama grup modifier minimal 2 karakter.")
      .max(60, "Nama grup modifier maksimal 60 karakter."),
    selectionType: z.enum(["single", "multiple"]),
    isRequired: z.boolean(),
    minSelect: integerField(0, 20, "Minimum pilihan harus 0–20."),
    maxSelect: integerField(1, 20, "Maksimum pilihan harus 1–20."),
    sortOrder: integerField(0, 9999, "Urutan harus berupa angka 0–9999."),
    isActive: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.maxSelect < value.minSelect) {
      ctx.addIssue({
        code: "custom",
        path: ["maxSelect"],
        message: "Maksimum pilihan tidak boleh lebih kecil dari minimum.",
      });
    }

    if (value.selectionType === "single" && value.maxSelect !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["maxSelect"],
        message: "Grup pilihan tunggal wajib memiliki maksimum 1 pilihan.",
      });
    }

    if (value.selectionType === "single" && value.minSelect > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["minSelect"],
        message: "Grup pilihan tunggal hanya boleh memiliki minimum 0 atau 1.",
      });
    }

    if (value.isRequired && value.minSelect < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["minSelect"],
        message: "Grup wajib harus memiliki minimum minimal 1 pilihan.",
      });
    }

    if (!value.isRequired && value.minSelect !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["minSelect"],
        message: "Grup opsional harus memiliki minimum 0 pilihan.",
      });
    }
  });

export const modifierOptionSchema = z.object({
  groupId: uuidSchema,
  name: z
    .string()
    .trim()
    .min(2, "Nama opsi minimal 2 karakter.")
    .max(60, "Nama opsi maksimal 60 karakter."),
  priceDelta: integerField(
    0,
    999_999_999,
    "Selisih harga harus berupa angka rupiah tanpa desimal.",
  ),
  sortOrder: integerField(0, 9999, "Urutan harus berupa angka 0–9999."),
  isActive: z.boolean(),
});

export const menuIdSchema = uuidSchema;

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
