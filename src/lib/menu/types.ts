import type {
  MenuCategory,
  ModifierGroup,
  ModifierOption,
  Product,
} from "@/types/database";

export type CategoryWithCount = MenuCategory & { product_count: number };

export type ProductWithModifiers = Product & {
  modifier_group_ids: string[];
};

export type ModifierGroupWithOptions = ModifierGroup & {
  options: ModifierOption[];
};
