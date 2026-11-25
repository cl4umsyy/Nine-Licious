import type { SupabaseClient } from "@supabase/supabase-js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ActiveShiftCheckResult =
  | { ok: true; shiftId: string }
  | { ok: false; errorCode: string; message: string };

export type SuppliedShiftIdResult =
  | { present: false; shiftId: null }
  | { present: true; valid: true; shiftId: string }
  | { present: true; valid: false; rawValue: unknown };

/**
 * Mengekstrak `shiftId` atau `shift_id` jika client menyertakannya pada payload
 * (agar nilai spoofing milik kasir lain tidak diam-diam diabaikan oleh Zod).
 */
export function extractSuppliedShiftId(rawInput: unknown): SuppliedShiftIdResult {
  if (typeof rawInput !== "object" || rawInput === null) {
    return { present: false, shiftId: null };
  }

  const raw = rawInput as Record<string, unknown>;
  const hasCamel =
    Object.prototype.hasOwnProperty.call(raw, "shiftId") &&
    raw.shiftId !== undefined &&
    raw.shiftId !== null &&
    String(raw.shiftId).trim() !== "";
  const hasSnake =
    Object.prototype.hasOwnProperty.call(raw, "shift_id") &&
    raw.shift_id !== undefined &&
    raw.shift_id !== null &&
    String(raw.shift_id).trim() !== "";

  if (!hasCamel && !hasSnake) {
    return { present: false, shiftId: null };
  }

  if (hasCamel && hasSnake) {
    const camelVal = typeof raw.shiftId === "string" ? raw.shiftId.trim() : "";
    const snakeVal = typeof raw.shift_id === "string" ? raw.shift_id.trim() : "";
    if (!camelVal || !snakeVal || camelVal.toLowerCase() !== snakeVal.toLowerCase()) {
      return { present: true, valid: false, rawValue: raw.shiftId };
    }
  }

  const candidate = hasCamel ? raw.shiftId : raw.shift_id;
  if (typeof candidate !== "string") {
    return { present: true, valid: false, rawValue: candidate };
  }

  const trimmed = candidate.trim();
  if (!UUID_REGEX.test(trimmed)) {
    return { present: true, valid: false, rawValue: candidate };
  }

  return { present: true, valid: true, shiftId: trimmed };
}

/**
 * Memastikan kasir / operator POS memiliki shift aktif berstatus 'open' di database
 * milik user yang sedang login, serta menolak `shift_id`/`shiftId` palsu dari browser.
 */
export async function requireActiveShiftForPosOrder(
  supabase: SupabaseClient,
  cashierId: string,
  rawInput?: unknown,
): Promise<ActiveShiftCheckResult> {
  if (!cashierId) {
    return {
      ok: false,
      errorCode: "SHIFT_NOT_OPEN",
      message:
        "Sesi kasir tidak valid. Buka shift kasir terlebih dahulu sebelum membuat pesanan.",
    };
  }

  const supplied = extractSuppliedShiftId(rawInput);

  const { data: activeShift, error } = await supabase
    .from("shifts")
    .select("id, cashier_id, status, closed_at")
    .eq("cashier_id", cashierId)
    .eq("status", "open")
    .maybeSingle<{
      id: string;
      cashier_id: string;
      status: string;
      closed_at: string | null;
    }>();

  if (error) {
    return {
      ok: false,
      errorCode: "SHIFT_VERIFICATION_FAILED",
      message:
        "Gagal memverifikasi shift kasir aktif. Pastikan shift kasir sudah dibuka sebelum membuat pesanan.",
    };
  }

  if (
    !activeShift ||
    activeShift.cashier_id !== cashierId ||
    activeShift.status !== "open" ||
    activeShift.closed_at !== null
  ) {
    return {
      ok: false,
      errorCode: "SHIFT_NOT_OPEN",
      message:
        "Shift kasir belum dibuka atau sudah ditutup. Buka shift terlebih dahulu sebelum membuat atau menambah pesanan.",
    };
  }

  if (supplied.present) {
    if (!supplied.valid || supplied.shiftId.toLowerCase() !== activeShift.id.toLowerCase()) {
      return {
        ok: false,
        errorCode: "SHIFT_OWNERSHIP_MISMATCH",
        message:
          "Ditolak: ID shift yang dikirim tidak valid atau bukan milik shift aktif Anda.",
      };
    }
  }

  return {
    ok: true,
    shiftId: activeShift.id,
  };
}
