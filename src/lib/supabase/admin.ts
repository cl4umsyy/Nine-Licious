import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "@/lib/env";

let adminClient: SupabaseClient | null = null;

/**
 * Server-only Supabase client with the service role key.
 *
 * Only use this for privileged operations that cannot be expressed through
 * RLS: creating auth users, resetting passwords, recording auth audit events
 * and handling payment webhooks. Never import this module from a Client
 * Component.
 */
export function createSupabaseAdminClient(): SupabaseClient | null {
  const config = getSupabaseConfig();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!config || !serviceRoleKey) {
    return null;
  }

  if (!adminClient) {
    adminClient = createClient(config.url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  return adminClient;
}
