import "server-only";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type AuditEntry = {
  action: string;
  userId?: string | null;
  username?: string | null;
  entity?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown>;
};

function getIpAddress(headerStore: Headers): string | null {
  const forwarded = headerStore.get("x-forwarded-for");

  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  return headerStore.get("x-real-ip");
}

function getIpSalt(): string {
  return (
    process.env.AUDIT_IP_SALT ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    "nine-licious-local-development"
  );
}

export async function getRequestIpHash(): Promise<string | null> {
  const headerStore = await headers();
  const ip = getIpAddress(headerStore);

  if (!ip) {
    return null;
  }

  return createHash("sha256")
    .update(`${getIpSalt()}:${ip}`)
    .digest("hex");
}

/**
 * Writes an audit event with the service-role client. Audit failures must never
 * break the user's action, so errors are logged server-side only.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  const admin = createSupabaseAdminClient();

  if (!admin) {
    console.warn(`[audit] ${entry.action}: Supabase admin client belum siap.`);
    return;
  }

  const ipHash = await getRequestIpHash();

  const { error } = await admin.from("audit_logs").insert({
    user_id: entry.userId ?? null,
    username: entry.username ?? null,
    action: entry.action,
    entity: entry.entity ?? null,
    entity_id: entry.entityId ?? null,
    details: entry.details ?? {},
    ip_hash: ipHash,
  });

  if (error) {
    console.error(`[audit] Gagal menulis ${entry.action}:`, error.message);
  }
}
