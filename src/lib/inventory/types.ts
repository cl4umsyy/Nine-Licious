import type {
  IngredientUnit,
  ManualStockMovementType,
  StockMovementType,
  StockStatus,
} from "./constants";

export type Ingredient = {
  id: string;
  name: string;
  sku: string | null;
  unit: IngredientUnit;
  current_stock: number;
  reserved_stock?: number;
  available_stock?: number;
  min_stock: number;
  is_active: boolean;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type IngredientReservation = {
  id: string;
  order_id: string;
  ingredient_id: string;
  quantity_reserved: number;
  status: "active" | "fulfilled" | "released";
  created_at: string;
  updated_at: string;
  ingredient_name?: string;
  ingredient_unit?: IngredientUnit;
};

export type RecipeItem = {
  id: string;
  product_id: string;
  ingredient_id: string;
  quantity_required: number;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  ingredient_name?: string;
  ingredient_sku?: string | null;
  ingredient_unit?: IngredientUnit;
  ingredient_current_stock?: number;
  ingredient_reserved_stock?: number;
  ingredient_available_stock?: number;
  ingredient_min_stock?: number;
  ingredient_is_active?: boolean;
};

export type ProductWithRecipe = {
  product_id: string;
  product_name: string;
  product_sku: string | null;
  category_id: string;
  category_name: string | null;
  is_active: boolean;
  is_available: boolean;
  recipe_items: RecipeItem[];
  has_inactive_ingredient: boolean;
};

export type StockMovement = {
  id: string;
  ingredient_id: string;
  movement_type: StockMovementType;
  quantity_delta: number;
  stock_before: number;
  stock_after: number;
  order_id: string | null;
  reason: string;
  idempotency_key: string | null;
  created_by: string | null;
  created_at: string;
  ingredient_name?: string;
  ingredient_unit?: IngredientUnit;
  order_number?: string | null;
  actor_username?: string | null;
};

export type LowStockAlert = {
  ingredient_id: string;
  ingredient_name: string;
  sku: string | null;
  unit: IngredientUnit;
  current_stock: number;
  reserved_stock?: number;
  available_stock?: number;
  min_stock: number;
  deficit: number;
  status: Exclude<StockStatus, "safe">;
  is_negative: boolean;
};

export type IngredientUsageRow = {
  ingredient_id: string;
  ingredient_name: string;
  sku: string | null;
  unit: IngredientUnit;
  is_active: boolean;
  current_stock: number;
  min_stock: number;
  stock_status: StockStatus;
  sale_deducted_total: number;
  manual_in_total: number;
  manual_out_total: number;
  opname_net_delta: number;
  net_change: number;
  movement_count: number;
  sale_order_count: number;
};

export type LinkedProductRecipeInfo = {
  recipe_id: string;
  product_id: string;
  product_name: string;
  product_is_active: boolean;
  quantity_required: number;
};

export type StockAdjustmentResultData = {
  movement_id: string;
  ingredient_id: string;
  ingredient_name: string;
  unit: IngredientUnit;
  movement_type: ManualStockMovementType;
  quantity_delta: number;
  stock_before: number;
  stock_after: number;
  current_stock?: number;
  reserved_stock?: number;
  available_stock?: number;
  min_stock: number;
  is_low_stock: boolean;
  reason: string;
  idempotent_replay: boolean;
  created_at: string;
};

export type IngredientUsageReportData = {
  startDate: string;
  endDate: string;
  rows: IngredientUsageRow[];
  movements: StockMovement[];
  lowStockAlerts: LowStockAlert[];
  totals: {
    totalMovements: number;
    totalIngredientsTracked: number;
    totalLowStockCount: number;
    totalOutOfStockCount: number;
  };
};

export type InventoryActionErrorCode =
  | "UNAUTHORIZED"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "DUPLICATE"
  | "INACTIVE_INGREDIENT"
  | "INGREDIENT_IN_USE_REQUIRES_CONFIRMATION"
  | "MIGRATION_REQUIRED"
  | "DATABASE_ERROR";

export type InventoryActionResult<T = undefined> = {
  ok: boolean;
  message: string;
  code?: InventoryActionErrorCode;
  data?: T;
  fieldErrors?: Record<string, string>;
};
