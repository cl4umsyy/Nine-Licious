import { z } from "zod";
import type { CashMovement, CashMovementType, Shift, ShiftStatus } from "@/types/database";

export type { CashMovement, CashMovementType, Shift, ShiftStatus };

export type ShiftWithCashier = Shift & {
  cashier: {
    id: string;
    full_name: string;
    username: string;
  };
  opened_by_admin?: {
    id: string;
    full_name: string;
  } | null;
};

export type ShiftSummary = {
  shift: Shift;
  cashier: {
    id: string;
    full_name: string;
    username: string;
  };
  openingCash: number;
  totalCashSales: number;
  totalCashRefunds: number;
  totalCashIn: number;
  totalCashOut: number;
  expectedCash: number;
  actualCash: number | null;
  cashDifference: number | null;
  movementsCount: number;
};

export type ShiftActionResult<T = unknown> = {
  ok: boolean;
  message: string;
  data?: T;
  fieldErrors?: Record<string, string>;
};

/**
 * Status non-finansial shift aktif global (dipakai untuk menampilkan indikator
 * kasir yang sedang bertugas dan mengunci pembukaan shift ganda di semua akun).
 */
export type GlobalActiveShiftStatus = {
  hasActiveShift: boolean;
  shiftId: string | null;
  cashierId: string | null;
  cashierName: string | null;
  cashierUsername: string | null;
  openedAt: string | null;
  isOwnedByCurrentUser: boolean;
};

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const openShiftSchema = z.object({
  openingCash: z.coerce
    .number({ message: "Modal kas awal harus berupa angka." })
    .int("Modal kas awal harus bilangan bulat rupiah.")
    .min(0, "Modal kas awal tidak boleh bernilai negatif."),
  notes: z
    .string()
    .trim()
    .max(500, "Catatan maksimal 500 karakter.")
    .optional()
    .nullable(),
  cashierId: z
    .string()
    .trim()
    .regex(uuidRegex, "ID kasir tidak valid.")
    .optional()
    .nullable(),
});

export type OpenShiftInput = z.infer<typeof openShiftSchema>;

export const closeShiftSchema = z.object({
  shiftId: z
    .string({ message: "ID shift wajib diisi." })
    .trim()
    .regex(uuidRegex, "ID shift tidak valid."),
  actualCash: z.coerce
    .number({ message: "Nominal uang fisik harus berupa angka." })
    .int("Nominal uang fisik harus bilangan bulat rupiah.")
    .min(0, "Nominal kas fisik tidak boleh bernilai negatif."),
  notes: z
    .string()
    .trim()
    .max(500, "Catatan maksimal 500 karakter.")
    .optional()
    .nullable(),
});

export type CloseShiftInput = z.infer<typeof closeShiftSchema>;

export const recordCashMovementSchema = z.object({
  shiftId: z
    .string({ message: "ID shift wajib diisi." })
    .trim()
    .regex(uuidRegex, "ID shift tidak valid."),
  movementType: z.enum(["cash_in", "cash_out"], {
    message: "Tipe mutasi kas harus 'cash_in' atau 'cash_out'.",
  }),
  amount: z.coerce
    .number({ message: "Nominal mutasi harus berupa angka." })
    .int("Nominal mutasi harus bilangan bulat rupiah.")
    .positive("Nominal mutasi kas harus lebih besar dari Rp 0."),
  reason: z
    .string({ message: "Alasan mutasi kas wajib diisi." })
    .trim()
    .min(3, "Alasan mutasi kas minimal 3 karakter.")
    .max(255, "Alasan mutasi kas maksimal 255 karakter."),
});

export type RecordCashMovementInput = z.infer<typeof recordCashMovementSchema>;
