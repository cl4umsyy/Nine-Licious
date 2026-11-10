import "server-only";

import { getSupabaseConfig } from "@/lib/env";

/**
 * F0 needs the service role for username-based auth, audit logs, rate
 * limiting, and admin user management. Treat a missing server key as setup
 * mode instead of letting users reach a half-configured application.
 *
 * This lives outside `env.ts` so the service-role variable is never referenced
 * by a module that can be imported into a Client Component.
 */
export function isSupabaseAdminConfigured(): boolean {
  return (
    getSupabaseConfig() !== null &&
    Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
}
