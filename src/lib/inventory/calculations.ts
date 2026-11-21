import {
  INVENTORY_LIMITS,
  type IngredientUnit,
  type StockStatus,
} from "./constants";
import type {
  Ingredient,
  IngredientUsageRow,
  LowStockAlert,
  StockMovement,
} from "./types";

const MILLI_SCALE = 1000;

/**
 * Mengonversi angka atau string desimal menjadi integer mili-unit (skala x1000)
 * tanpa galat presisi IEEE-754 floating point.
 * Konsisten dengan tipe PostgreSQL `numeric(12, 3)`.
 */
export function toMilliUnits(value: number | string | null | undefined): number {
  if (value === null || value === undefined) {
    throw new Error("Nilai kuantitas tidak boleh kosong (null atau undefined).");
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Nilai kuantitas tidak valid (harus angka terhingga).");
    }
    const fixed = value.toFixed(INVENTORY_LIMITS.MAX_DECIMAL_PLACES);
    return parseFixedDecimalToMilli(fixed);
  }

  if (typeof value !== "string") {
    throw new Error(`Format angka desimal tidak valid: "${String(value)}".`);
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error("Nilai kuantitas tidak boleh berupa string kosong.");
  }
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new Error(`Format angka desimal tidak valid: "${value}".`);
  }

  return parseFixedDecimalToMilli(trimmed);
}

function parseFixedDecimalToMilli(raw: string): number {
  const negative = raw.startsWith("-");
  const unsigned =
    raw.startsWith("-") || raw.startsWith("+") ? raw.slice(1) : raw;
  const [intPartRaw, fracPartRaw = ""] = unsigned.split(".");
  const intPart = Number.parseInt(intPartRaw || "0", 10);

  if (!Number.isSafeInteger(intPart)) {
    throw new Error("Nilai kuantitas melebihi batas aman integer.");
  }

  // Ambil hingga 4 digit desimal untuk pembulatan half-up yang konsisten dengan Postgres ROUND(numeric, 3)
  const padded = fracPartRaw.padEnd(4, "0");
  const baseFrac = Number.parseInt(padded.slice(0, 3), 10);
  const fourthDigit = Number.parseInt(padded.charAt(3), 10);
  const roundedFrac = fourthDigit >= 5 ? baseFrac + 1 : baseFrac;

  const totalMilli = intPart * MILLI_SCALE + roundedFrac;
  if (!Number.isSafeInteger(totalMilli)) {
    throw new Error("Hasil konversi mili-unit melebihi batas aman.");
  }

  return negative && totalMilli !== 0 ? -totalMilli : totalMilli;
}

/**
 * Mengonversi integer mili-unit kembali ke angka desimal maksimal 3 digit.
 */
export function fromMilliUnits(milli: number): number {
  if (!Number.isSafeInteger(milli)) {
    throw new Error("Nilai mili-unit harus berupa integer aman.");
  }
  if (milli === 0) return 0;
  return milli / MILLI_SCALE;
}

/**
 * Membulatkan nilai ke 3 angka di belakang koma (selaras numeric(12,3)).
 */
export function roundQuantity3(
  value: number | string | null | undefined,
): number {
  return fromMilliUnits(toMilliUnits(value));
}

/**
 * Memformat angka stok dengan format Indonesia hingga 3 digit desimal tanpa nol berlebih.
 */
export function formatStockQuantity(
  value: number | string,
  unit?: IngredientUnit,
): string {
  const rounded = roundQuantity3(value);
  const formatted = new Intl.NumberFormat("id-ID", {
    minimumFractionDigits: 0,
    maximumFractionDigits: INVENTORY_LIMITS.MAX_DECIMAL_PLACES,
  }).format(rounded);
  return unit ? `${formatted} ${unit}` : formatted;
}

export type RecipeRequirementInput = {
  ingredient_id: string;
  quantity_required: number | string;
};

export type IngredientNeed = {
  ingredient_id: string;
  quantity_required: number;
};

/**
 * Menghitung kebutuhan bahan baku untuk 1 produk dengan jumlah porsi tertentu.
 * Memakai aritmetika mili-unit agar 0.15 * 3 = 0.45 tepat (bukan 0.44999999999999996).
 */
export function calculateProductIngredientNeeds(
  recipeLines: readonly RecipeRequirementInput[],
  productQuantity: number,
): IngredientNeed[] {
  if (!Number.isInteger(productQuantity) || productQuantity <= 0) {
    return [];
  }

  const aggMilli = new Map<string, number>();

  for (const line of recipeLines) {
    const reqMilli = toMilliUnits(line.quantity_required);
    if (reqMilli <= 0) continue;

    const lineNeedMilli = reqMilli * productQuantity;
    const prev = aggMilli.get(line.ingredient_id) ?? 0;
    aggMilli.set(line.ingredient_id, prev + lineNeedMilli);
  }

  return Array.from(aggMilli.entries())
    .filter(([, milli]) => milli > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ingredient_id, milli]) => ({
      ingredient_id,
      quantity_required: fromMilliUnits(milli),
    }));
}

export type OrderItemForStockInput = {
  product_id: string;
  quantity: number;
};

/**
 * Mengagregasikan kebutuhan bahan baku dari beberapa produk/item dalam satu pesanan.
 * - Produk tanpa resep dilewati dengan aman.
 * - Bila `ingredientsById` diberikan, bahan baku nonaktif (`is_active === false`)
 *   dilewati agar identik 100% dengan fungsi SQL `deduct_order_stock_internal`.
 * - Hasil diurutkan deterministik berdasarkan `ingredient_id ASC`.
 */
export function aggregateOrderIngredientNeeds(
  orderItems: readonly OrderItemForStockInput[],
  recipesByProduct: ReadonlyMap<string, readonly RecipeRequirementInput[]>,
  ingredientsById?: ReadonlyMap<string, { is_active: boolean }>,
): IngredientNeed[] {
  const aggMilli = new Map<string, number>();

  for (const item of orderItems) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      continue;
    }

    const recipeLines = recipesByProduct.get(item.product_id);
    if (!recipeLines || recipeLines.length === 0) {
      continue;
    }

    for (const line of recipeLines) {
      if (ingredientsById) {
        const ing = ingredientsById.get(line.ingredient_id);
        if (!ing || !ing.is_active) {
          continue;
        }
      }

      const reqMilli = toMilliUnits(line.quantity_required);
      if (reqMilli <= 0) continue;

      const prev = aggMilli.get(line.ingredient_id) ?? 0;
      aggMilli.set(line.ingredient_id, prev + reqMilli * item.quantity);
    }
  }

  return Array.from(aggMilli.entries())
    .filter(([, milli]) => milli > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ingredient_id, milli]) => ({
      ingredient_id,
      quantity_required: fromMilliUnits(milli),
    }));
}

/**
 * Menghitung stok yang tersedia untuk dipesan/digunakan.
 * Formula: Math.max(0, current_stock - (reserved_stock ?? 0))
 */
export function calculateAvailableStock(
  currentStock: number | string,
  reservedStock?: number | string,
): number {
  const currentMilli = toMilliUnits(currentStock);
  const reservedMilli =
    reservedStock !== undefined ? toMilliUnits(reservedStock) : 0;
  const availableMilli = Math.max(0, currentMilli - reservedMilli);
  return fromMilliUnits(availableMilli);
}

/**
 * Menentukan status stok bahan baku:
 * Menggunakan stok tersedia (current_stock - reserved_stock):
 * - `out_of_stock` : available_stock <= 0
 * - `low_stock`    : available_stock > 0 dan available_stock <= min_stock
 * - `safe`         : available_stock > min_stock
 */
export function getStockStatus(
  currentStock: number | string,
  minStock: number | string,
  reservedStock?: number | string,
): StockStatus {
  const currentMilli = toMilliUnits(currentStock);
  const minMilli = toMilliUnits(minStock);
  const reservedMilli =
    reservedStock !== undefined ? toMilliUnits(reservedStock) : 0;
  const availableMilli = Math.max(0, currentMilli - reservedMilli);

  if (availableMilli <= 0) {
    return "out_of_stock";
  }

  if (availableMilli <= minMilli) {
    return "low_stock";
  }

  return "safe";
}

/**
 * Selaras 100% dengan partial index `ingredients_low_stock_idx` di F4:
 * bahan baku aktif dianggap perlu perhatian stok rendah bila stok tersedia <= min_stock.
 */
export function isLowStock(
  currentStock: number | string,
  minStock: number | string,
  reservedStock?: number | string,
): boolean {
  const currentMilli = toMilliUnits(currentStock);
  const minMilli = toMilliUnits(minStock);
  const reservedMilli =
    reservedStock !== undefined ? toMilliUnits(reservedStock) : 0;
  const availableMilli = Math.max(0, currentMilli - reservedMilli);
  return availableMilli <= minMilli;
}

/**
 * Membangun daftar peringatan stok rendah/habis untuk bahan baku aktif.
 * Diurutkan dari yang paling kritis: negatif/habis dulu, lalu stok tersedia terkecil, lalu nama.
 */
export function buildLowStockAlerts(
  ingredients: readonly Pick<
    Ingredient,
    "id" | "name" | "sku" | "unit" | "current_stock" | "min_stock" | "is_active" | "reserved_stock"
  >[],
): LowStockAlert[] {
  const alerts: LowStockAlert[] = [];

  for (const ing of ingredients) {
    if (!ing.is_active) continue;

    const currentMilli = toMilliUnits(ing.current_stock);
    const minMilli = toMilliUnits(ing.min_stock);
    const reservedMilli =
      ing.reserved_stock !== undefined ? toMilliUnits(ing.reserved_stock) : 0;
    const availableMilli = Math.max(0, currentMilli - reservedMilli);

    if (availableMilli > minMilli && availableMilli > 0) {
      continue;
    }

    const status: Exclude<StockStatus, "safe"> =
      availableMilli <= 0 ? "out_of_stock" : "low_stock";
    const effectiveNetMilli = currentMilli - reservedMilli;
    const deficitMilli = Math.max(0, minMilli - effectiveNetMilli);

    alerts.push({
      ingredient_id: ing.id,
      ingredient_name: ing.name,
      sku: ing.sku,
      unit: ing.unit,
      current_stock: fromMilliUnits(currentMilli),
      reserved_stock: fromMilliUnits(reservedMilli),
      available_stock: fromMilliUnits(availableMilli),
      min_stock: fromMilliUnits(minMilli),
      deficit: fromMilliUnits(deficitMilli),
      status,
      is_negative: currentMilli < 0,
    });
  }

  return alerts.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === "out_of_stock" ? -1 : 1;
    }
    const aAvailable = a.available_stock ?? a.current_stock;
    const bAvailable = b.available_stock ?? b.current_stock;
    const diff = toMilliUnits(aAvailable) - toMilliUnits(bAvailable);
    if (diff !== 0) return diff;
    return a.ingredient_name.localeCompare(b.ingredient_name, "id-ID");
  });
}

export type StockOpnameDeltaResult = {
  stock_before: number;
  stock_after: number;
  delta: number;
  has_change: boolean;
  direction: "increase" | "decrease" | "none";
};

/**
 * Menghitung delta stock opname secara eksak (skala mili-unit).
 * Menolak target stok aktual negatif sesuai kontrak RPC `adjust_ingredient_stock_atomic`.
 */
export function calculateStockOpnameDelta(
  currentStock: number | string,
  actualCountedStock: number | string,
): StockOpnameDeltaResult {
  const beforeMilli = toMilliUnits(currentStock);
  const afterMilli = toMilliUnits(actualCountedStock);

  if (afterMilli < 0) {
    throw new Error("Stok aktual pada stock opname tidak boleh negatif.");
  }

  const deltaMilli = afterMilli - beforeMilli;

  return {
    stock_before: fromMilliUnits(beforeMilli),
    stock_after: fromMilliUnits(afterMilli),
    delta: fromMilliUnits(deltaMilli),
    has_change: deltaMilli !== 0,
    direction:
      deltaMilli > 0 ? "increase" : deltaMilli < 0 ? "decrease" : "none",
  };
}

/**
 * Mengagregasikan laporan pemakaian bahan baku dari daftar `stock_movements`.
 * - `sale_deducted_total` disimpan sebagai angka positif (total pemakaian penjualan).
 * - `manual_out_total` disimpan sebagai angka positif (total pengeluaran manual/waste).
 * - `manual_in_total` disimpan sebagai angka positif (total restock/masuk manual).
 * - `opname_net_delta` bertanda (+/-) sesuai selisih opname.
 * - `net_change` = jumlah seluruh `quantity_delta` dalam periode.
 */
export function aggregateIngredientUsageReport(
  movements: readonly Pick<
    StockMovement,
    "ingredient_id" | "movement_type" | "quantity_delta" | "order_id"
  >[],
  ingredientsById: ReadonlyMap<
    string,
    Pick<
      Ingredient,
      "id" | "name" | "sku" | "unit" | "is_active" | "current_stock" | "min_stock"
    >
  >,
): IngredientUsageRow[] {
  type Accumulator = {
    saleDeductedMilli: number;
    manualInMilli: number;
    manualOutMilli: number;
    opnameNetMilli: number;
    netChangeMilli: number;
    movementCount: number;
    saleOrderIds: Set<string>;
  };

  const accMap = new Map<string, Accumulator>();

  for (const mov of movements) {
    let acc = accMap.get(mov.ingredient_id);
    if (!acc) {
      acc = {
        saleDeductedMilli: 0,
        manualInMilli: 0,
        manualOutMilli: 0,
        opnameNetMilli: 0,
        netChangeMilli: 0,
        movementCount: 0,
        saleOrderIds: new Set<string>(),
      };
      accMap.set(mov.ingredient_id, acc);
    }

    const deltaMilli = toMilliUnits(mov.quantity_delta);
    acc.netChangeMilli += deltaMilli;
    acc.movementCount += 1;

    switch (mov.movement_type) {
      case "sale_deduction":
        acc.saleDeductedMilli += Math.abs(deltaMilli);
        if (mov.order_id) {
          acc.saleOrderIds.add(mov.order_id);
        }
        break;
      case "manual_in":
        acc.manualInMilli += Math.abs(deltaMilli);
        break;
      case "manual_out":
        acc.manualOutMilli += Math.abs(deltaMilli);
        break;
      case "stock_opname":
        acc.opnameNetMilli += deltaMilli;
        break;
    }
  }

  const rows: IngredientUsageRow[] = [];

  for (const [ingredientId, acc] of accMap.entries()) {
    const ing = ingredientsById.get(ingredientId);
    if (!ing) continue;

    rows.push({
      ingredient_id: ing.id,
      ingredient_name: ing.name,
      sku: ing.sku,
      unit: ing.unit,
      is_active: ing.is_active,
      current_stock: roundQuantity3(ing.current_stock),
      min_stock: roundQuantity3(ing.min_stock),
      stock_status: getStockStatus(ing.current_stock, ing.min_stock),
      sale_deducted_total: fromMilliUnits(acc.saleDeductedMilli),
      manual_in_total: fromMilliUnits(acc.manualInMilli),
      manual_out_total: fromMilliUnits(acc.manualOutMilli),
      opname_net_delta: fromMilliUnits(acc.opnameNetMilli),
      net_change: fromMilliUnits(acc.netChangeMilli),
      movement_count: acc.movementCount,
      sale_order_count: acc.saleOrderIds.size,
    });
  }

  return rows.sort((a, b) => {
    const usageDiff =
      toMilliUnits(b.sale_deducted_total) - toMilliUnits(a.sale_deducted_total);
    if (usageDiff !== 0) return usageDiff;
    return a.ingredient_name.localeCompare(b.ingredient_name, "id-ID");
  });
}
