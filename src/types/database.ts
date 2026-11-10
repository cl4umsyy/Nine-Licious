import type { UserRole } from "@/lib/auth/roles";

export type Profile = {
  id: string;
  username: string;
  full_name: string;
  role: UserRole;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

export type RestaurantSettings = {
  id: number;
  name: string;
  logo_url: string | null;
  address: string | null;
  phone: string | null;
  receipt_header: string | null;
  receipt_footer: string | null;
  tax_percent: number;
  service_charge_percent: number;
  receipt_width: 58 | 80;
  operating_hours: Record<string, unknown>;
  holidays: unknown[];
  created_at: string;
  updated_at: string;
};

export type AuditLog = {
  id: number;
  user_id: string | null;
  username: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  details: Record<string, unknown>;
  ip_hash: string | null;
  created_at: string;
};

export type LoginAttempt = {
  id: number;
  username: string;
  ip_hash: string | null;
  success: boolean;
  created_at: string;
};
