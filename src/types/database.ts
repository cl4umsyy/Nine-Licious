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

export type KitchenStation = "kitchen" | "bar" | "dessert";

export type MenuCategory = {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type Product = {
  id: string;
  category_id: string;
  name: string;
  sku: string | null;
  price: number;
  photo_url: string | null;
  photo_path: string | null;
  description: string | null;
  is_active: boolean;
  is_available: boolean;
  kitchen_station: KitchenStation | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type ModifierSelectionType = "single" | "multiple";

export type ModifierGroup = {
  id: string;
  name: string;
  selection_type: ModifierSelectionType;
  is_required: boolean;
  min_select: number;
  max_select: number;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type ModifierOption = {
  id: string;
  group_id: string;
  name: string;
  price_delta: number;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type ProductModifierGroup = {
  product_id: string;
  modifier_group_id: string;
  sort_order: number;
  created_at: string;
};
