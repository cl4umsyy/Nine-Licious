"use server";

/**
 * NINE LICIOUS POS — AUDIT EXPLORER SERVER ACTIONS
 * File: src/lib/audit/actions.ts
 *
 * Mengelola inspeksi log audit administratif (read-only):
 * 1. Paginasi server-side dan filter komprehensif.
 * 2. Masking otomatis data sensitif (password, token, credential).
 * 3. Otorisasi ketat admin (getAdminActor) & RLS session client.
 * 4. Ekspor log audit ke CSV dengan UTF-8 BOM & sanitasi formula injection.
 */

import { type UserRole } from "@/lib/auth/roles";
import { getAdminActor } from "@/lib/auth/session";
import type {
  AuditActionResult,
  AuditFilterInput,
  AuditLogItem,
  PaginatedAuditLogsResult,
} from "@/lib/audit/types";
import { auditFilterSchema } from "@/lib/audit/validation";
import {
  buildCsvDocument,
  formatJakartaDateTime,
} from "@/lib/export/csv";
import type { CsvExportResult } from "@/lib/export/types";
import { getJakartaDateToday } from "@/lib/reports/calculations";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "secret",
  "api_key",
  "apikey",
  "pin",
  "credential",
  "authorization",
  "private_key",
  "access_token",
  "refresh_token",
]);

/**
 * Masking rekursif properti sensitif pada objek JSON
 */
function maskSensitiveDetails(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(maskSensitiveDetails);

  const res: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      res[k] = "***MASKED***";
    } else if (typeof v === "object" && v !== null) {
      res[k] = maskSensitiveDetails(v);
    } else {
      res[k] = v;
    }
  }
  return res;
}

type RawAuditRow = {
  id: number;
  user_id: string | null;
  username: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  details: Record<string, unknown> | null;
  ip_hash: string | null;
  created_at: string;
};

/**
 * Mengambil log audit administratif dengan filter terpadu dan paginasi server-side
 */
export async function getAdminAuditLogsAction(
  rawInput?: AuditFilterInput,
): Promise<AuditActionResult<PaginatedAuditLogsResult>> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const parsed = auditFilterSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message || "Parameter filter audit tidak valid.",
    };
  }

  const filter = parsed.data;
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  // 1. Jika filter role diaktifkan, cari user_id dengan role tersebut dari tabel profiles
  let roleUserIds: string[] | null = null;
  if (filter.role && filter.role !== "all") {
    const { data: profs, error: pErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("role", filter.role);

    if (pErr) {
      return { ok: false, message: `Gagal memfilter role: ${pErr.message}` };
    }
    roleUserIds = (profs || []).map((p) => p.id);
    if (roleUserIds.length === 0) {
      return {
        ok: true,
        message: "Data log audit berhasil dimuat.",
        data: {
          items: [],
          totalCount: 0,
          page: filter.page,
          pageSize: filter.pageSize,
          totalPages: 0,
          summary: {
            totalEvents: 0,
            distinctUsers: 0,
            distinctActions: 0,
          },
        },
      };
    }
  }

  // 2. Bangun query audit_logs
  let query = supabase
    .from("audit_logs")
    .select("id, user_id, username, action, entity, entity_id, details, ip_hash, created_at", {
      count: "exact",
    });

  if (filter.startDate) {
    query = query.gte("created_at", `${filter.startDate}T00:00:00+07:00`);
  }
  if (filter.endDate) {
    query = query.lte("created_at", `${filter.endDate}T23:59:59.999+07:00`);
  }
  if (filter.action && filter.action !== "all") {
    query = query.eq("action", filter.action);
  }
  if (filter.entity && filter.entity !== "all") {
    query = query.eq("entity", filter.entity);
  }
  if (roleUserIds) {
    query = query.in("user_id", roleUserIds);
  }
  if (filter.search && filter.search.trim()) {
    const s = filter.search.trim();
    query = query.or(`username.ilike.%${s}%,entity_id.ilike.%${s}%,action.ilike.%${s}%`);
  }

  // Paginasi
  const offset = (filter.page - 1) * filter.pageSize;
  query = query
    .order("created_at", { ascending: false })
    .range(offset, offset + filter.pageSize - 1);

  const { data: rawRows, count: totalCount, error: logsErr } = await query;
  if (logsErr) {
    return { ok: false, message: `Gagal memuat log audit: ${logsErr.message}` };
  }

  const logs = (rawRows || []) as RawAuditRow[];

  // 3. Ambil data profil actor yang terkait untuk melengkapi nama & role
  const userIds = Array.from(new Set(logs.map((l) => l.user_id).filter(Boolean))) as string[];
  const profileMap = new Map<string, { full_name: string; role: UserRole; username: string }>();

  if (userIds.length > 0) {
    const { data: profData } = await supabase
      .from("profiles")
      .select("id, full_name, role, username")
      .in("id", userIds);

    for (const p of profData || []) {
      profileMap.set(p.id, {
        full_name: p.full_name,
        role: p.role as UserRole,
        username: p.username,
      });
    }
  }

  // 4. Format dan bersihkan log
  const items: AuditLogItem[] = logs.map((l) => {
    const prof = l.user_id ? profileMap.get(l.user_id) : null;
    return {
      id: l.id,
      userId: l.user_id,
      username: prof?.username || l.username || "system",
      userFullName: prof?.full_name || null,
      userRole: prof?.role || (l.user_id ? "unknown" : "system"),
      action: l.action,
      entity: l.entity,
      entityId: l.entity_id,
      details: (maskSensitiveDetails(l.details || {}) as Record<string, unknown>) || {},
      ipHash: l.ip_hash,
      createdAt: l.created_at,
    };
  });

  const distinctUsers = new Set(items.map((i) => i.username)).size;
  const distinctActions = new Set(items.map((i) => i.action)).size;

  return {
    ok: true,
    message: "Data log audit berhasil dimuat.",
    data: {
      items,
      totalCount: totalCount ?? 0,
      page: filter.page,
      pageSize: filter.pageSize,
      totalPages: Math.ceil((totalCount ?? 0) / filter.pageSize),
      summary: {
        totalEvents: totalCount ?? 0,
        distinctUsers,
        distinctActions,
      },
    },
  };
}

/**
 * Ekspor Log Audit ke file CSV
 */
export async function exportAuditLogsCsvAction(
  rawInput?: AuditFilterInput,
): Promise<CsvExportResult> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, message: actor.message };
  }

  const parsed = auditFilterSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, message: "Parameter filter audit tidak valid." };
  }

  const filter = parsed.data;
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Klien database tidak tersedia." };
  }

  let roleUserIds: string[] | null = null;
  if (filter.role && filter.role !== "all") {
    const { data: profs } = await supabase
      .from("profiles")
      .select("id")
      .eq("role", filter.role);
    roleUserIds = (profs || []).map((p) => p.id);
  }

  let query = supabase
    .from("audit_logs")
    .select("id, user_id, username, action, entity, entity_id, details, ip_hash, created_at")
    .order("created_at", { ascending: false })
    .limit(5000);

  if (filter.startDate) {
    query = query.gte("created_at", `${filter.startDate}T00:00:00+07:00`);
  }
  if (filter.endDate) {
    query = query.lte("created_at", `${filter.endDate}T23:59:59.999+07:00`);
  }
  if (filter.action && filter.action !== "all") {
    query = query.eq("action", filter.action);
  }
  if (filter.entity && filter.entity !== "all") {
    query = query.eq("entity", filter.entity);
  }
  if (roleUserIds) {
    query = query.in("user_id", roleUserIds);
  }
  if (filter.search && filter.search.trim()) {
    const s = filter.search.trim();
    query = query.or(`username.ilike.%${s}%,entity_id.ilike.%${s}%,action.ilike.%${s}%`);
  }

  const { data: rawRows, error } = await query;
  if (error) {
    return { ok: false, message: `Gagal memuat log audit: ${error.message}` };
  }

  const logs = (rawRows || []) as RawAuditRow[];
  const userIds = Array.from(new Set(logs.map((l) => l.user_id).filter(Boolean))) as string[];
  const profileMap = new Map<string, { full_name: string; role: string; username: string }>();

  if (userIds.length > 0) {
    const { data: profData } = await supabase
      .from("profiles")
      .select("id, full_name, role, username")
      .in("id", userIds);

    for (const p of profData || []) {
      profileMap.set(p.id, p);
    }
  }

  const headers = [
    "ID Log",
    "Waktu Aktivitas",
    "Nama Pengguna",
    "Username",
    "Role",
    "Jenis Aktivitas (Action)",
    "Entitas Terkait",
    "ID Record (Entity ID)",
    "Ringkasan Detail",
    "IP Hash",
  ];

  const rows = logs.map((l) => {
    const prof = l.user_id ? profileMap.get(l.user_id) : null;
    const masked = maskSensitiveDetails(l.details || {}) as Record<string, unknown>;
    const detailSummary = JSON.stringify(masked);

    return [
      l.id,
      formatJakartaDateTime(l.created_at),
      prof?.full_name || "Sistem / Anon",
      prof?.username || l.username || "-",
      prof?.role || (l.user_id ? "unknown" : "system"),
      l.action,
      l.entity || "-",
      l.entity_id || "-",
      detailSummary,
      l.ip_hash || "-",
    ];
  });

  const filename = `audit-logs-${getJakartaDateToday()}.csv`;
  const csvContent = buildCsvDocument(headers, rows);

  return {
    ok: true,
    message: "Log audit berhasil diekspor ke CSV.",
    filename,
    csvContent,
  };
}
