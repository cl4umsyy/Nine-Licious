import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isUserRole, type UserRole } from "@/lib/auth/roles";
import type { Profile } from "@/types/database";

export type AuthenticatedSession = {
  status: "authenticated";
  user: User;
  profile: Profile;
};

export type SessionState =
  | { status: "unconfigured" }
  | { status: "anonymous" }
  | {
      status: "invalid";
      user: User;
      reason: "profile-missing" | "inactive" | "invalid-role";
    }
  | AuthenticatedSession;

type ProfileRow = {
  id: string;
  username: string;
  full_name: string;
  role: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

function toProfile(row: ProfileRow): Profile | null {
  if (!isUserRole(row.role)) {
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    role: row.role,
    is_active: row.is_active,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Reads the current Supabase session and its profile. This is intentionally
 * done on every request: it is the source of truth for authorization, not
 * the JWT role claim alone.
 */
export async function getSessionState(): Promise<SessionState> {
  let supabase: SupabaseClient | null;

  try {
    supabase = await createSupabaseServerClient();
  } catch (error) {
    console.error("[auth] Gagal membuat Supabase client:", error);
    return { status: "unconfigured" };
  }

  if (!supabase) {
    return { status: "unconfigured" };
  }

  let user: User | null = null;

  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {
    return { status: "anonymous" };
  }

  if (!user) {
    return { status: "anonymous" };
  }

  const { data, error } = await supabase
    .from("profiles")
    .select(
      "id, username, full_name, role, is_active, last_login_at, created_at, updated_at",
    )
    .eq("id", user.id)
    .maybeSingle<ProfileRow>();

  if (error || !data) {
    return { status: "invalid", user, reason: "profile-missing" };
  }

  const profile = toProfile(data);

  if (!profile) {
    return { status: "invalid", user, reason: "invalid-role" };
  }

  if (!profile.is_active) {
    return { status: "invalid", user, reason: "inactive" };
  }

  return { status: "authenticated", user, profile };
}

/**
 * Server action friendly admin check. Returns a result instead of redirecting
 * so the caller can render a form error.
 */
export async function getAdminActor(): Promise<
  | { ok: true; session: AuthenticatedSession }
  | { ok: false; message: string }
> {
  const state = await getSessionState();

  if (state.status !== "authenticated") {
    return {
      ok: false,
      message: "Sesi Anda tidak valid. Silakan masuk kembali.",
    };
  }

  if (state.profile.role !== "admin") {
    return {
      ok: false,
      message: "Hanya admin yang dapat melakukan tindakan ini.",
    };
  }

  return { ok: true, session: state };
}

/**
 * Server action friendly cashier or admin check. Returns a result instead of
 * redirecting so the caller can render a friendly error state.
 */
export async function getCashierActor(): Promise<
  | { ok: true; session: AuthenticatedSession }
  | { ok: false; message: string }
> {
  const state = await getSessionState();

  if (state.status !== "authenticated") {
    return {
      ok: false,
      message: "Sesi Anda tidak valid. Silakan masuk kembali.",
    };
  }

  if (state.profile.role !== "admin" && state.profile.role !== "kasir") {
    return {
      ok: false,
      message: "Hanya admin dan kasir yang dapat melakukan tindakan ini.",
    };
  }

  return { ok: true, session: state };
}

export function isRoleAllowed(
  role: UserRole,
  allowed: UserRole | UserRole[],
): boolean {
  return Array.isArray(allowed) ? allowed.includes(role) : allowed === role;
}
