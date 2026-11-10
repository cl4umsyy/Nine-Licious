import "server-only";

import { redirect } from "next/navigation";
import {
  getSessionState,
  isRoleAllowed,
  type AuthenticatedSession,
} from "@/lib/auth/session";
import type { UserRole } from "@/lib/auth/roles";

/**
 * Route guard for Server Components. Redirects anonymous users to login and
 * invalid sessions to a helpful login message.
 */
export async function requireSession(): Promise<AuthenticatedSession> {
  const state = await getSessionState();

  if (state.status === "authenticated") {
    return state;
  }

  if (state.status === "unconfigured") {
    redirect("/login?setup=1");
  }

  if (state.status === "invalid") {
    redirect(`/login?reason=${state.reason}`);
  }

  redirect("/login");
}

export async function requireRole(
  allowed: UserRole | UserRole[],
): Promise<AuthenticatedSession> {
  const session = await requireSession();

  if (!isRoleAllowed(session.profile.role, allowed)) {
    redirect("/unauthorized");
  }

  return session;
}
