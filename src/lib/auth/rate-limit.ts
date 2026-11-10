import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const WINDOW_MINUTES = 15;
const MAX_FAILURES = 5;
const WINDOW_MS = WINDOW_MINUTES * 60 * 1000;

export type LoginRateLimitResult =
  | { status: "allowed" }
  | { status: "locked"; retryAfterMinutes: number }
  | { status: "error"; message: string };

type AttemptRow = { created_at: string };

function getLatest(rows: AttemptRow[] | null): number | null {
  if (!rows || rows.length === 0) {
    return null;
  }

  return Math.max(...rows.map((row) => new Date(row.created_at).getTime()));
}

/**
 * Counts recent failures by username and by IP hash. Five failures within
 * fifteen minutes locks the login flow for fifteen minutes from the most
 * recent failure.
 */
export async function checkLoginRateLimit(
  username: string,
  ipHash: string | null,
): Promise<LoginRateLimitResult> {
  const admin = createSupabaseAdminClient();

  if (!admin) {
    return {
      status: "error",
      message:
        "Konfigurasi server Supabase belum lengkap. Hubungi admin restoran.",
    };
  }

  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  const usernameQuery = admin
    .from("login_attempts")
    .select("created_at")
    .eq("username", username)
    .eq("success", false)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_FAILURES);

  const ipQuery = ipHash
    ? admin
        .from("login_attempts")
        .select("created_at")
        .eq("ip_hash", ipHash)
        .eq("success", false)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(MAX_FAILURES)
    : Promise.resolve({ data: [] as AttemptRow[], error: null });

  const [byUsername, byIp] = await Promise.all([usernameQuery, ipQuery]);

  if (byUsername.error || byIp.error) {
    console.error(
      "[auth] Gagal memeriksa login_attempts:",
      byUsername.error?.message ?? byIp.error?.message,
    );

    return {
      status: "error",
      message:
        "Layanan login belum siap. Pastikan migrasi database sudah dijalankan.",
    };
  }

  const usernameFailures = (byUsername.data ?? []) as AttemptRow[];
  const ipFailures = (byIp.data ?? []) as AttemptRow[];

  const locked =
    usernameFailures.length >= MAX_FAILURES || ipFailures.length >= MAX_FAILURES;

  if (!locked) {
    return { status: "allowed" };
  }

  const latest =
    getLatest(usernameFailures) ?? getLatest(ipFailures) ?? Date.now();
  const remainingMs = latest + WINDOW_MS - Date.now();
  const retryAfterMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));

  return { status: "locked", retryAfterMinutes };
}

export async function recordLoginAttempt(input: {
  username: string;
  ipHash: string | null;
  success: boolean;
}): Promise<void> {
  const admin = createSupabaseAdminClient();

  if (!admin) {
    return;
  }

  const { error } = await admin.from("login_attempts").insert({
    username: input.username,
    ip_hash: input.ipHash,
    success: input.success,
  });

  if (error) {
    console.error("[auth] Gagal mencatat login attempt:", error.message);
  }
}
