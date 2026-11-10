import { z } from "zod";
import { USER_ROLES } from "@/lib/auth/roles";

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Username minimal 3 karakter.")
  .max(32, "Username maksimal 32 karakter.")
  .regex(
    /^[a-z0-9._-]+$/,
    "Username hanya boleh berisi huruf kecil, angka, titik, garis bawah, atau tanda hubung.",
  );

const strongPasswordSchema = z
  .string()
  .min(8, "Password minimal 8 karakter.")
  .max(72, "Password maksimal 72 karakter.")
  .regex(/[A-Za-z]/, "Password harus mengandung huruf.")
  .regex(/[0-9]/, "Password harus mengandung angka.");

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Username wajib diisi."),
  password: z.string().min(1, "Password wajib diisi."),
});

export const createUserSchema = z
  .object({
    username: usernameSchema,
    fullName: z
      .string()
      .trim()
      .min(2, "Nama lengkap minimal 2 karakter.")
      .max(80, "Nama lengkap maksimal 80 karakter."),
    role: z.enum(USER_ROLES),
    password: strongPasswordSchema,
    confirmPassword: z.string().min(1, "Konfirmasi password wajib diisi."),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "Konfirmasi password tidak sama.",
  });

export const resetPasswordSchema = z
  .object({
    password: strongPasswordSchema,
    confirmPassword: z.string().min(1, "Konfirmasi password wajib diisi."),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "Konfirmasi password tidak sama.",
  });

export function firstZodError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Data yang dikirim tidak valid.";
}
