"use server";

import type { z } from "zod";
import { revalidatePath } from "next/cache";
import { getCashierActor } from "@/lib/auth/session";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatOnDutyCashierLabel } from "./format";
import {
  closeShiftSchema,
  openShiftSchema,
  recordCashMovementSchema,
  type CashMovement,
  type GlobalActiveShiftStatus,
  type Shift,
  type ShiftActionResult,
  type ShiftStatus,
  type ShiftSummary,
  type ShiftWithCashier,
} from "./types";

type RawGlobalShiftRow = {
  id: string;
  cashier_id: string;
  opened_at: string;
  cashier?:
    | { full_name?: string | null; username?: string | null }
    | Array<{ full_name?: string | null; username?: string | null }>
    | null;
};

type RpcGlobalShiftStatus = {
  has_active_shift?: boolean;
  shift_id?: string | null;
  cashier_id?: string | null;
  cashier_name?: string | null;
  cashier_username?: string | null;
  opened_at?: string | null;
  is_owned_by_caller?: boolean;
};

function extractJoinedCashier(
  relation: RawGlobalShiftRow["cashier"],
): { full_name: string | null; username: string | null } {
  const row = Array.isArray(relation) ? relation[0] : relation;
  return {
    full_name: row?.full_name?.trim() || null,
    username: row?.username?.trim() || null,
  };
}

function formatOpenShiftErrorMessage(
  rawMessage: string,
  code?: string,
  fallbackStatus?: GlobalActiveShiftStatus | null,
): string {
  const prefix = "SHIFT_OCCUPIED_BY_OTHER_CASHIER:";
  if (rawMessage.includes(prefix)) {
    return rawMessage.slice(rawMessage.indexOf(prefix) + prefix.length).trim();
  }
  if (
    code === "23505" ||
    rawMessage.includes("idx_shifts_single_global_active")
  ) {
    if (fallbackStatus?.hasActiveShift && !fallbackStatus.isOwnedByCurrentUser) {
      const label = formatOnDutyCashierLabel(
        fallbackStatus.cashierName,
        fallbackStatus.cashierUsername,
      );
      return `Tidak dapat membuka shift baru karena saat ini sudah ada shift aktif yang sedang digunakan oleh ${label}. Tutup shift tersebut terlebih dahulu.`;
    }
    return "Tidak dapat membuka shift baru karena masih terdapat shift kasir yang sedang aktif. Tutup shift aktif terlebih dahulu.";
  }
  return rawMessage;
}

async function readGlobalActiveShiftStatus(
  supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>,
  currentUserId: string,
): Promise<GlobalActiveShiftStatus> {
  const emptyStatus: GlobalActiveShiftStatus = {
    hasActiveShift: false,
    shiftId: null,
    cashierId: null,
    cashierName: null,
    cashierUsername: null,
    openedAt: null,
    isOwnedByCurrentUser: false,
  };

  // 1. Gunakan adminClient jika tersedia agar status non-finansial dapat dibaca
  //    lintas kasir tanpa melonggarkan RLS finansial pada tabel shifts.
  const adminClient = createSupabaseAdminClient();
  if (adminClient) {
    const { data, error } = await adminClient
      .from("shifts")
      .select(
        "id, cashier_id, opened_at, cashier:profiles!shifts_cashier_id_fkey(full_name, username)",
      )
      .eq("status", "open")
      .order("opened_at", { ascending: true })
      .limit(1);

    if (!error && Array.isArray(data)) {
      if (data.length > 0) {
        const row = data[0] as unknown as RawGlobalShiftRow;
        const joined = extractJoinedCashier(row.cashier);
        return {
          hasActiveShift: true,
          shiftId: row.id,
          cashierId: row.cashier_id,
          cashierName: joined.full_name,
          cashierUsername: joined.username,
          openedAt: row.opened_at,
          isOwnedByCurrentUser: row.cashier_id === currentUserId,
        };
      }
      return emptyStatus;
    }
  }

  // 2. Coba RPC SECURITY DEFINER non-finansial (jika migrasi sudah terpasang)
  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "get_active_global_shift_status",
  );
  if (!rpcError && rpcData && typeof rpcData === "object") {
    const res = rpcData as RpcGlobalShiftStatus;
    if (res.has_active_shift) {
      return {
        hasActiveShift: true,
        shiftId: res.shift_id ?? null,
        cashierId: res.cashier_id ?? null,
        cashierName: res.cashier_name ?? null,
        cashierUsername: res.cashier_username ?? null,
        openedAt: res.opened_at ?? null,
        isOwnedByCurrentUser: res.cashier_id === currentUserId,
      };
    }
    return emptyStatus;
  }

  // 3. Fallback session client (minimal mendeteksi shift milik sendiri / admin)
  const { data: fallbackRows } = await supabase
    .from("shifts")
    .select(
      "id, cashier_id, opened_at, cashier:profiles!shifts_cashier_id_fkey(full_name, username)",
    )
    .eq("status", "open")
    .order("opened_at", { ascending: true })
    .limit(1);

  if (Array.isArray(fallbackRows) && fallbackRows.length > 0) {
    const row = fallbackRows[0] as unknown as RawGlobalShiftRow;
    const joined = extractJoinedCashier(row.cashier);
    return {
      hasActiveShift: true,
      shiftId: row.id,
      cashierId: row.cashier_id,
      cashierName: joined.full_name,
      cashierUsername: joined.username,
      openedAt: row.opened_at,
      isOwnedByCurrentUser: row.cashier_id === currentUserId,
    };
  }

  return emptyStatus;
}

function firstZodError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Validasi data shift gagal.";
}

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}

/**
 * Membuka shift kasir secara atomik menggunakan RPC open_shift_atomic.
 * Kasir hanya dapat membuka shift untuk dirinya sendiri.
 * Admin dapat membuka shift atas nama kasir lain dengan menentukan cashierId.
 */
export async function openShiftAction(
  rawInput: unknown,
): Promise<ShiftActionResult<Shift>> {
  const actorRes = await getCashierActor();
  if (!actorRes.ok) {
    return { ok: false, message: actorRes.message };
  }
  const { session } = actorRes;

  const parsed = openShiftSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const { openingCash, notes, cashierId } = parsed.data;

  // Kasir dilarang membuka shift atas nama kasir lain
  if (cashierId && cashierId !== session.profile.id && session.profile.role !== "admin") {
    return {
      ok: false,
      message: "Hanya admin yang dapat membuka shift atas nama kasir lain.",
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  const targetCashierId =
    session.profile.role === "admin" && cashierId ? cashierId : null;
  const effectiveTargetCashierId = targetCashierId || session.profile.id;

  // Guard server-side: pastikan tidak ada shift aktif lain secara global
  const globalStatus = await readGlobalActiveShiftStatus(
    supabase,
    session.profile.id,
  );
  if (globalStatus.hasActiveShift) {
    if (globalStatus.cashierId === effectiveTargetCashierId) {
      return {
        ok: false,
        message: `Kasir masih memiliki shift aktif yang belum ditutup (Shift ID: ${globalStatus.shiftId}). Tutup shift terlebih dahulu.`,
      };
    }
    const holderLabel = formatOnDutyCashierLabel(
      globalStatus.cashierName,
      globalStatus.cashierUsername,
    );
    return {
      ok: false,
      message: `Tidak dapat membuka shift baru karena saat ini sudah ada shift aktif yang sedang digunakan oleh ${holderLabel}. Tutup shift tersebut terlebih dahulu.`,
    };
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "open_shift_atomic",
    {
      p_opening_cash: openingCash,
      p_notes: notes || null,
      p_cashier_id: targetCashierId,
    },
  );

  if (rpcError) {
    const latestStatus = await readGlobalActiveShiftStatus(
      supabase,
      session.profile.id,
    );
    return {
      ok: false,
      message: formatOpenShiftErrorMessage(
        rpcError.message,
        rpcError.code,
        latestStatus,
      ),
    };
  }

  revalidatePath("/pos");
  revalidatePath("/pos/orders");
  revalidatePath("/pos/floor");
  revalidatePath("/pos/shift");
  revalidatePath("/admin/shifts");

  return {
    ok: true,
    message: "Shift kasir berhasil dibuka.",
    data: rpcData as unknown as Shift,
  };
}

/**
 * Mengambil status non-finansial shift aktif global agar setiap akun kasir
 * dan admin mengetahui apakah sistem sedang dikunci oleh shift kasir lain.
 */
export async function getGlobalActiveShiftStatusAction(): Promise<
  ShiftActionResult<GlobalActiveShiftStatus>
> {
  const actorRes = await getCashierActor();
  if (!actorRes.ok) {
    return { ok: false, message: actorRes.message };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  const status = await readGlobalActiveShiftStatus(
    supabase,
    actorRes.session.profile.id,
  );
  return {
    ok: true,
    message: status.hasActiveShift
      ? "Shift aktif global ditemukan."
      : "Tidak ada shift aktif global.",
    data: status,
  };
}

/**
 * Mengambil informasi shift aktif milik kasir saat ini.
 * Jika kasirId ditentukan (khusus admin), mengambil shift aktif kasir tersebut.
 */
export async function getActiveShiftAction(
  cashierId?: string,
): Promise<ShiftActionResult<ShiftWithCashier | null>> {
  const actorRes = await getCashierActor();
  if (!actorRes.ok) {
    return { ok: false, message: actorRes.message };
  }
  const { session } = actorRes;

  if (cashierId && cashierId !== session.profile.id && session.profile.role !== "admin") {
    return {
      ok: false,
      message: "Anda tidak berhak melihat shift kasir lain.",
    };
  }

  const targetCashierId = cashierId || session.profile.id;

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  const { data, error } = await supabase
    .from("shifts")
    .select("*, cashier:profiles!shifts_cashier_id_fkey(id, full_name, username)")
    .eq("cashier_id", targetCashierId)
    .eq("status", "open")
    .maybeSingle();

  if (error) {
    return { ok: false, message: error.message };
  }

  return {
    ok: true,
    message: data ? "Shift aktif ditemukan." : "Tidak ada shift aktif.",
    data: (data as unknown as ShiftWithCashier) || null,
  };
}

/**
 * Mengambil seluruh shift kasir yang saat ini sedang aktif (status = 'open').
 * Digunakan oleh antarmuka admin dan modal refund untuk memilih laci kasir.
 */
export async function getAllActiveShiftsAction(): Promise<
  ShiftActionResult<ShiftWithCashier[]>
> {
  const actorRes = await getCashierActor();
  if (!actorRes.ok) {
    return { ok: false, message: actorRes.message };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  const { data, error } = await supabase
    .from("shifts")
    .select("*, cashier:profiles!shifts_cashier_id_fkey(id, full_name, username)")
    .eq("status", "open")
    .order("opened_at", { ascending: false });

  if (error) {
    return { ok: false, message: error.message };
  }

  return {
    ok: true,
    message: "Daftar shift aktif berhasil dimuat.",
    data: (data as unknown as ShiftWithCashier[]) || [],
  };
}

/**
 * Menghitung ringkasan keuangan shift (penjualan tunai, refund, kas masuk/keluar, expected cash).
 */
export async function getShiftSummaryAction(
  shiftId?: string,
): Promise<ShiftActionResult<ShiftSummary>> {
  const actorRes = await getCashierActor();
  if (!actorRes.ok) {
    return { ok: false, message: actorRes.message };
  }
  const { session } = actorRes;

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  let targetShift: ShiftWithCashier | null = null;

  if (shiftId) {
    const { data: sData, error: sErr } = await supabase
      .from("shifts")
      .select("*, cashier:profiles!shifts_cashier_id_fkey(id, full_name, username)")
      .eq("id", shiftId)
      .maybeSingle();

    if (sErr || !sData) {
      return { ok: false, message: "Shift tidak ditemukan." };
    }
    targetShift = sData as unknown as ShiftWithCashier;
  } else {
    const { data: sData, error: sErr } = await supabase
      .from("shifts")
      .select("*, cashier:profiles!shifts_cashier_id_fkey(id, full_name, username)")
      .eq("cashier_id", session.profile.id)
      .eq("status", "open")
      .maybeSingle();

    if (sErr || !sData) {
      return { ok: false, message: "Tidak ada shift aktif untuk kasir ini." };
    }
    targetShift = sData as unknown as ShiftWithCashier;
  }

  // Validasi hak akses kasir
  if (
    session.profile.role !== "admin" &&
    targetShift.cashier_id !== session.profile.id
  ) {
    return {
      ok: false,
      message: "Anda tidak berhak melihat ringkasan shift kasir lain.",
    };
  }

  // Ambil seluruh pergerakan kas untuk shift ini
  const { data: movements, error: mErr } = await supabase
    .from("cash_movements")
    .select("movement_type, amount")
    .eq("shift_id", targetShift.id);

  if (mErr) {
    return { ok: false, message: mErr.message };
  }

  let totalCashSales = 0;
  let totalCashRefunds = 0;
  let totalCashIn = 0;
  let totalCashOut = 0;

  for (const m of movements || []) {
    if (m.movement_type === "cash_sale") {
      totalCashSales += m.amount;
    } else if (m.movement_type === "cash_refund") {
      totalCashRefunds += m.amount;
    } else if (m.movement_type === "cash_in") {
      totalCashIn += m.amount;
    } else if (m.movement_type === "cash_out") {
      totalCashOut += m.amount;
    }
  }

  const summary: ShiftSummary = {
    shift: targetShift,
    cashier: targetShift.cashier,
    openingCash: targetShift.opening_cash,
    totalCashSales,
    totalCashRefunds,
    totalCashIn,
    totalCashOut,
    expectedCash: targetShift.expected_cash,
    actualCash: targetShift.actual_cash,
    cashDifference: targetShift.cash_difference,
    movementsCount: (movements || []).length,
  };

  return {
    ok: true,
    message: "Ringkasan shift berhasil dimuat.",
    data: summary,
  };
}

/**
 * Menutup shift kasir dan melakukan rekonsiliasi kas secara atomik.
 */
export async function closeShiftAction(
  rawInput: unknown,
): Promise<ShiftActionResult<Shift>> {
  const actorRes = await getCashierActor();
  if (!actorRes.ok) {
    return { ok: false, message: actorRes.message };
  }
  const { session } = actorRes;

  const parsed = closeShiftSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const { shiftId, actualCash, notes } = parsed.data;

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  // Jika bukan admin, pastikan shift milik kasir yang login
  if (session.profile.role !== "admin") {
    const { data: shiftCheck } = await supabase
      .from("shifts")
      .select("cashier_id, status")
      .eq("id", shiftId)
      .maybeSingle();

    if (!shiftCheck || shiftCheck.cashier_id !== session.profile.id) {
      return {
        ok: false,
        message: "Anda tidak berhak menutup shift milik kasir lain.",
      };
    }
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "close_shift_atomic",
    {
      p_shift_id: shiftId,
      p_actual_cash: actualCash,
      p_notes: notes || null,
    },
  );

  if (rpcError) {
    return { ok: false, message: rpcError.message };
  }

  revalidatePath("/pos");
  revalidatePath("/pos/orders");
  revalidatePath("/pos/floor");
  revalidatePath("/pos/shift");
  revalidatePath("/admin/shifts");

  return {
    ok: true,
    message: "Shift kasir berhasil ditutup dan direkonsiliasi.",
    data: rpcData as unknown as Shift,
  };
}

/**
 * Mencatat kas masuk atau kas keluar manual secara atomik ke laci kas.
 */
export async function recordCashMovementAction(
  rawInput: unknown,
): Promise<ShiftActionResult<CashMovement>> {
  const actorRes = await getCashierActor();
  if (!actorRes.ok) {
    return { ok: false, message: actorRes.message };
  }
  const { session } = actorRes;

  const parsed = recordCashMovementSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const { shiftId, movementType, amount, reason } = parsed.data;

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  // Jika kasir, pastikan shift adalah miliknya
  if (session.profile.role !== "admin") {
    const { data: shiftCheck } = await supabase
      .from("shifts")
      .select("cashier_id, status")
      .eq("id", shiftId)
      .maybeSingle();

    if (!shiftCheck || shiftCheck.cashier_id !== session.profile.id) {
      return {
        ok: false,
        message: "Anda tidak berhak mencatat mutasi pada shift kasir lain.",
      };
    }
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "record_cash_movement_atomic",
    {
      p_shift_id: shiftId,
      p_movement_type: movementType,
      p_amount: amount,
      p_reason: reason,
    },
  );

  if (rpcError) {
    return { ok: false, message: rpcError.message };
  }

  revalidatePath("/pos");
  revalidatePath("/pos/orders");
  revalidatePath("/pos/floor");
  revalidatePath("/pos/shift");
  revalidatePath("/admin/shifts");

  const successMessage =
    movementType === "cash_in"
      ? `Kas masuk sebesar Rp ${amount.toLocaleString("id-ID")} berhasil dicatat.`
      : `Kas keluar sebesar Rp ${amount.toLocaleString("id-ID")} berhasil dicatat.`;

  return {
    ok: true,
    message: successMessage,
    data: rpcData as unknown as CashMovement,
  };
}

/**
 * Mengambil riwayat mutasi kas fisik untuk shift tertentu.
 */
export async function getCashMovementsAction(
  shiftId: string,
): Promise<ShiftActionResult<CashMovement[]>> {
  const actorRes = await getCashierActor();
  if (!actorRes.ok) {
    return { ok: false, message: actorRes.message };
  }
  const { session } = actorRes;

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  // Validasi kepemilikan shift bagi non-admin
  if (session.profile.role !== "admin") {
    const { data: shiftCheck } = await supabase
      .from("shifts")
      .select("cashier_id")
      .eq("id", shiftId)
      .maybeSingle();

    if (!shiftCheck || shiftCheck.cashier_id !== session.profile.id) {
      return {
        ok: false,
        message: "Anda tidak berhak melihat mutasi kas shift kasir lain.",
      };
    }
  }

  const { data, error } = await supabase
    .from("cash_movements")
    .select("*, creator:profiles!cash_movements_created_by_fkey(full_name, username)")
    .eq("shift_id", shiftId)
    .order("created_at", { ascending: false });

  if (error) {
    return { ok: false, message: error.message };
  }

  return {
    ok: true,
    message: "Riwayat mutasi kas berhasil dimuat.",
    data: (data as unknown as CashMovement[]) || [],
  };
}

/**
 * Mengambil riwayat shift kasir (aktif maupun tertutup).
 * Kasir hanya dapat melihat riwayat miliknya sendiri.
 * Admin dapat memfilter berdasarkan cashierId atau melihat seluruh riwayat.
 */
export async function getShiftHistoryAction(options?: {
  cashierId?: string;
  status?: ShiftStatus;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}): Promise<ShiftActionResult<ShiftWithCashier[]>> {
  const actorRes = await getCashierActor();
  if (!actorRes.ok) {
    return { ok: false, message: actorRes.message };
  }
  const { session } = actorRes;

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  const limit = Math.min(Math.max(1, options?.limit || 50), 100);
  const offset = Math.max(0, options?.offset || 0);

  let query = supabase
    .from("shifts")
    .select("*, cashier:profiles!shifts_cashier_id_fkey(id, full_name, username)")
    .order("opened_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (session.profile.role !== "admin") {
    // Kasir hanya melihat shift miliknya
    query = query.eq("cashier_id", session.profile.id);
  } else if (options?.cashierId) {
    // Admin filter spesifik kasir
    query = query.eq("cashier_id", options.cashierId);
  }

  if (options?.status) {
    query = query.eq("status", options.status);
  }

  if (options?.startDate) {
    query = query.gte("opened_at", options.startDate);
  }

  if (options?.endDate) {
    query = query.lte("opened_at", options.endDate);
  }

  const { data, error } = await query;

  if (error) {
    return { ok: false, message: error.message };
  }

  return {
    ok: true,
    message: "Riwayat shift berhasil dimuat.",
    data: (data as unknown as ShiftWithCashier[]) || [],
  };
}
