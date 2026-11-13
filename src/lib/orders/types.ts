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

