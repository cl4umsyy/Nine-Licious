/**
 * NINE LICIOUS POS — AUDIT EXPLORER TYPES
 * File: src/lib/audit/types.ts
 */

import type { UserRole } from "@/lib/auth/roles";

export type AuditLogItem = {
  id: number;
  userId: string | null;
  username: string;
  userFullName: string | null;
  userRole: UserRole | "system" | "unknown";
  action: string;
  entity: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  ipHash: string | null;
  createdAt: string;
};

export type AuditFilterInput = {
  search?: string;
  role?: string;
  action?: string;
  entity?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
};

export type PaginatedAuditLogsResult = {
  items: AuditLogItem[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  summary: {
    totalEvents: number;
    distinctUsers: number;
    distinctActions: number;
  };
};

export type AuditActionResult<T = unknown> = {
  ok: boolean;
  message: string;
  data?: T;
  fieldErrors?: Record<string, string>;
};
