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

export type TableShape = "rectangle" | "round";

export type TableStatus = "empty" | "awaiting_payment" | "occupied";

export type TableZone = {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type DiningTable = {
  id: string;
  zone_id: string;
  name: string;
  capacity: number;
  position_x: number;
  position_y: number;
  shape: TableShape;
  status: TableStatus;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type FloorPlan = {
  zone_id: string;
  published_at: string | null;
  published_by: string | null;
  created_at: string;
  updated_at: string;
};

export type OrderType = "dine_in" | "takeaway";

export type OrderStatus =
  | "awaiting_payment"
  | "partially_paid"
  | "paid"
  | "completed"
  | "cancelled"
  | "refunded";

export type PaymentStatus =
  | "unpaid"
  | "partially_paid"
  | "paid"
  | "partially_refunded"
  | "refunded";

export type KdsStatus = "queued" | "preparing" | "ready";

export type DiningSessionStatus = "open" | "closed" | "cancelled";

export type DiningSession = {
  id: string;
  table_id: string;
  status: DiningSessionStatus;
  opened_at: string;
  closed_at: string | null;
  opened_by: string | null;
  closed_by: string | null;
  created_at: string;
  updated_at: string;
};

export type Order = {
  id: string;
  order_number: string;
  order_type: OrderType;
  table_id: string | null;
  dining_session_id: string | null;
  status: OrderStatus;
  payment_status: PaymentStatus;
  kds_status: KdsStatus | null;
  customer_name: string | null;
  subtotal: number;
  discount_product_total: number;
  discount_order_total: number;
  discount_manual_total: number;
  discount_total: number;
  tax_percent: number;
  tax_total: number;
  service_charge_percent: number;
  service_total: number;
  grand_total: number;
  paid_total: number;
  idempotency_key: string | null;
  business_date: string;
  created_by: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type OrderItem = {
  id: string;
  order_id: string;
  product_id: string;
  product_name_snapshot: string;
  product_sku_snapshot: string | null;
  unit_price_snapshot: number;
  quantity: number;
  notes: string | null;
  modifier_total: number;
  subtotal: number;
  discount_amount: number;
  line_total: number;
  kitchen_station: string | null;
  created_at: string;
  updated_at: string;
};

export type OrderItemModifier = {
  id: string;
  order_item_id: string;
  modifier_option_id: string;
  group_name_snapshot: string;
  option_name_snapshot: string;
  price_delta_snapshot: number;
  created_at: string;
};

