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
  refunded_total?: number;
  idempotency_key: string | null;
  business_date: string;
  queue_number?: string | null;
  queue_date?: string | null;
  is_finalized: boolean;
  finalized_at: string | null;
  finalized_by: string | null;
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

export type DiscountScope = "product" | "order" | "manual";

export type DiscountType = "percentage" | "fixed";

export type Discount = {
  id: string;
  name: string;
  scope: "product" | "order";
  discount_type: DiscountType;
  discount_value: number;
  applies_to_category_id: string | null;
  applies_to_product_id: string | null;
  min_order_amount: number;
  max_discount_amount: number | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type DiscountApprovalNonce = {
  id: string;
  nonce: string;
  approver_id: string;
  cashier_id: string;
  discount_type: DiscountType;
  discount_value: number;
  reason: string;
  context_ref: string | null;
  is_used: boolean;
  used_at: string | null;
  used_in_order_id: string | null;
  expires_at: string;
  created_at: string;
};

export type OrderDiscount = {
  id: string;
  order_id: string;
  discount_id: string | null;
  order_item_id: string | null;
  scope: DiscountScope;
  name: string;
  discount_type: DiscountType;
  discount_rate: number;
  discount_amount: number;
  reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
};

export type PaymentMethod = "cash" | "qris" | "bank_transfer" | "midtrans";

export type PaymentSource =
  | "cash"
  | "qris_manual"
  | "qris_midtrans"
  | "bank_transfer"
  | "midtrans_snap";

export type PaymentRecordStatus = "pending" | "success" | "failed" | "refunded";

export type Payment = {
  id: string;
  order_id: string;
  payment_method: PaymentMethod;
  payment_source: PaymentSource;
  amount: number;
  cash_received: number | null;
  change_amount: number;
  reference_number: string | null;
  payment_status: PaymentRecordStatus;
  idempotency_key: string | null;
  notes: string | null;
  paid_total_after?: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type MidtransLifecycleStatus =
  | "initiated"
  | "pre_request_aborted"
  | "token_created"
  | "pending"
  | "capture_challenge"
  | "settled"
  | "reconciliation_required"
  | "expired"
  | "cancelled"
  | "denied";

export type MidtransSplitBillType = "custom_amount" | "by_item";

export type MidtransTransaction = {
  id: string;
  order_id: string;
  midtrans_order_id: string;
  gross_amount: number;
  payment_type: string;
  snap_token: string | null;
  snap_redirect_url: string | null;
  lifecycle_status: MidtransLifecycleStatus;
  midtrans_transaction_status: string | null;
  idempotency_key: string;
  payload_fingerprint: string;
  attempt_number: number;
  is_split_bill: boolean;
  split_bill_type: MidtransSplitBillType | null;
  snap_page_expires_at: string;
  payment_expires_at: string;
  settled_at: string | null;
  sanitized_response: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AllocationType = "full" | "custom_amount" | "by_item";

export type AllocationStatus = "reserved" | "settled" | "released";

export type OrderAllocation = {
  id: string;
  order_id: string;
  allocation_type: AllocationType;
  order_item_id: string | null;
  allocated_quantity: number | null;
  allocated_line_subtotal: number;
  allocated_discount_share: number;
  allocated_service_share: number;
  allocated_tax_share: number;
  allocated_rounding_adjustment: number;
  allocated_final_amount: number;
  midtrans_transaction_id: string | null;
  payment_id: string | null;
  allocation_status: AllocationStatus;
  created_at: string;
  updated_at: string;
};

export type OrderAllocationEvent = {
  id: number;
  allocation_id: string;
  order_id: string;
  from_status: AllocationStatus | null;
  to_status: AllocationStatus;
  transition_reason: string;
  payment_id: string | null;
  midtrans_transaction_id: string | null;
  event_metadata: Record<string, unknown>;
  actor_id: string | null;
  created_at: string;
};

export type WebhookProcessingResult =
  | "received"
  | "processing"
  | "settled"
  | "ignored_duplicate"
  | "ignored_out_of_order"
  | "reconciliation_flagged"
  | "terminal_released"
  | "failed";

export type MidtransWebhookEvent = {
  id: number;
  event_fingerprint: string;
  midtrans_order_id: string;
  transaction_id: string | null;
  raw_status: string;
  received_at: string;
  processed_at: string | null;
  processing_result: WebhookProcessingResult;
  is_signature_verified: boolean;
  is_duplicate: boolean;
  delivery_attempts: number;
  last_delivery_at: string;
  error_message: string | null;
  sanitized_payload: Record<string, unknown>;
};

export type RefundType = "full" | "partial";

export type RefundMethod = "cash" | "transfer" | "midtrans" | "manual";

export type RefundRecordStatus = "pending" | "approved" | "rejected" | "completed";

export type Refund = {
  id: string;
  order_id: string;
  payment_id: string | null;
  refund_number: string;
  gateway_refund_id?: string | null;
  refund_type: RefundType;
  refund_method: RefundMethod;
  amount: number;
  reason: string;
  status: RefundRecordStatus;
  requested_by: string;
  approved_by: string | null;
  approved_at: string | null;
  kitchen_notified_at: string | null;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};



