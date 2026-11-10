"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getRequestIpHash, logAudit } from "@/lib/auth/audit";
import { checkLoginRateLimit, recordLoginAttempt } from "@/lib/auth/rate-limit";
import { isUserRole, safeNextPath } from "@/lib/auth/roles";
import { normalizeUsername, usernameToEmail } from "@/lib/auth/username";
import { firstZodError, loginSchema } from "@/lib/auth/validation";
import { LAST_SEEN_COOKIE } from "@/lib/constants";
import type { LoginActionState } from "@/lib/auth/action-types";

type ProfileRow = {
  id: string;
  username: string;
  full_name: string;
  role: string;
  is_active: boolean;
};

function lastSeenCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
}

export async function loginAction(
  _previousState: LoginActionState,
  formData: FormData,
): Promise<LoginActionState> {
  const rawUsername = String(formData.get("username") ?? "");
  const parsed = loginSchema.safeParse({
    username: rawUsername,
    password: String(formData.get("password") ?? ""),
  });

  if (!parsed.success) {
    return {
      error: firstZodError(parsed.error),
      values: { username: rawUsername },
    };
  }

  const username = normalizeUsername(parsed.data.username);
  const password = parsed.data.password;
  const next = String(formData.get("next") ?? "");

  let supabase: SupabaseClient | null;

  try {
    supabase = await createSupabaseServerClient();
  } catch (error) {
    console.error("[auth] Gagal membuat Supabase client:", error);
    return {
      error:
        "Layanan autentikasi belum siap. Periksa konfigurasi Supabase di server.",
      values: { username },
    };
  }

  const admin = createSupabaseAdminClient();

  if (!supabase || !admin) {
    return {
      error:
        "Supabase belum dikonfigurasi lengkap. Hubungi admin restoran untuk menyiapkan environment.",
      values: { username },
    };
  }

  const ipHash = await getRequestIpHash();
  const rateLimit = await checkLoginRateLimit(username, ipHash);

  if (rateLimit.status === "error") {
    return { error: rateLimit.message, values: { username } };
  }

  if (rateLimit.status === "locked") {
    await logAudit({
      action: "auth.login_locked",
      username,
      details: { retry_after_minutes: rateLimit.retryAfterMinutes },
    });

    return {
      error: `Terlalu banyak percobaan masuk. Coba lagi dalam ${rateLimit.retryAfterMinutes} menit.`,
      values: { username },
    };
  }

  const signIn = await (async () => {
    try {
      return await supabase.auth.signInWithPassword({
        email: usernameToEmail(username),
        password,
      });
    } catch (error) {
      console.error("[auth] signInWithPassword gagal:", error);
      return null;
    }
  })();

  if (!signIn) {
    return {
      error:
        "Layanan login sedang tidak dapat dihubungi. Coba lagi beberapa saat lagi.",
      values: { username },
    };
  }

  const { data, error } = signIn;

  if (error || !data.user) {
    await recordLoginAttempt({ username, ipHash, success: false });
    await logAudit({
      action: "auth.login_failed",
      username,
      details: { reason: "invalid_credentials" },
    });

    return {
      error: "Username atau password salah.",
      values: { username },
    };
  }

  const authUser = data.user;

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, username, full_name, role, is_active")
    .eq("id", authUser.id)
    .maybeSingle<ProfileRow>();

  if (
    profileError ||
    !profile ||
    !isUserRole(profile.role) ||
    !profile.is_active
  ) {
    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.error("[auth] Gagal membersihkan sesi tidak valid:", error);
    }

    await recordLoginAttempt({ username, ipHash, success: true });
    await logAudit({
      action: "auth.login_blocked",
      userId: authUser.id,
      username,
      details: {
        reason: profileError
          ? "profile_query_failed"
          : !profile
            ? "profile_missing"
            : !profile.is_active
              ? "inactive"
              : "invalid_role",
      },
    });

    return {
      error:
        "Akun ini tidak dapat digunakan. Hubungi admin restoran untuk memeriksa status akun Anda.",
      values: { username },
    };
  }

  const now = new Date().toISOString();

  await admin
    .from("profiles")
    .update({ last_login_at: now })
    .eq("id", authUser.id);

  // Keep the JWT role claim aligned with the authoritative profile role. The
  // proxy uses app_metadata for fast route checks; RLS still uses profiles.
  if (authUser.app_metadata?.role !== profile.role) {
    await admin.auth.admin.updateUserById(authUser.id, {
      app_metadata: { ...authUser.app_metadata, role: profile.role },
    });
  }

  await recordLoginAttempt({ username, ipHash, success: true });
  await logAudit({
    action: "auth.login",
    userId: authUser.id,
    username,
    details: { role: profile.role },
  });

  const cookieStore = await cookies();
  cookieStore.set(LAST_SEEN_COOKIE, String(Date.now()), lastSeenCookieOptions());

  redirect(safeNextPath(next, profile.role));
}

export async function logoutAction(): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();

    if (supabase) {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("username, role")
          .eq("id", user.id)
          .maybeSingle<{ username: string; role: string }>();

        await logAudit({
          action: "auth.logout",
          userId: user.id,
          username: profile?.username ?? null,
          details: { role: profile?.role ?? null },
        });
      }

      await supabase.auth.signOut();
    }
  } catch (error) {
    // Logout must always clear local state and return the user to login, even
    // when Supabase is unreachable.
    console.error("[auth] Logout Supabase gagal:", error);
  }

  const cookieStore = await cookies();
  cookieStore.delete(LAST_SEEN_COOKIE);

  redirect("/login");
}
