import type {
  ModifierGroup,
  ModifierOption,
  Order,
  OrderDiscount,
  OrderItem,
  OrderItemModifier,
  Product,
} from "@/types/database";

export type ModifierOptionWithGroup = ModifierOption & {
  groupName: string;
};

export type ProductModifierGroupWithDetails = ModifierGroup & {
  options: ModifierOption[];
};

export type ProductWithModifiers = Product & {
  categoryName?: string;
  modifierGroups: ProductModifierGroupWithDetails[];
};

export type CartItemModifier = {
  optionId: string;
  groupId: string;
  groupName: string;
  name: string;
  priceDelta: number;
};

export type CartItem = {
  id: string; // client temporary item id
  productId: string;
  productName: string;
  productSku?: string | null;
  photoUrl?: string | null;
  unitPrice: number;
  quantity: number;
  notes?: string;
  modifiers: CartItemModifier[];
  kitchenStation?: string | null;
};

export type CartCalculation = {
  itemsCount: number;
  subtotal: number;
  taxPercent: number;
  taxTotal: number;
  serviceChargePercent: number;
  serviceTotal: number;
  grandTotal: number;
};

export type OrderItemWithModifiers = OrderItem & {
  modifiers: OrderItemModifier[];
};

export type OrderWithDetails = Order & {
  items: OrderItemWithModifiers[];
  discounts?: OrderDiscount[];
  tableName?: string | null;
  zoneName?: string | null;
};

export type DiningSessionOrderSummary = {
  id: string;
  order_number: string;
  status: string;
  payment_status: string;
  kds_status?: string | null;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  service_total: number;
  grand_total: number;
  paid_total: number;
  remaining_balance: number;
  created_at: string;
};

export type DiningSessionSummary = {
  table_id: string;
  table_name: string;
  table_status: string;
  has_active_session: boolean;
  session_id?: string;
  opened_at?: string;
  total_orders: number;
  unpaid_orders_count: number;
  uncompleted_orders_count: number;
  completed_orders_count: number;
  reserved_allocations_count?: number;
  pending_midtrans_transactions_count?: number;
  processing_webhooks_count?: number;
  session_subtotal: number;
  session_discount_total: number;
  session_tax_total: number;
  session_service_total: number;
  session_grand_total: number;
  session_paid_total: number;
  session_remaining_balance: number;
  can_close_session: boolean;
  blocking_reason?: string | null;
  orders: DiningSessionOrderSummary[];
};


