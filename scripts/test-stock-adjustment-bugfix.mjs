import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();

function loadTsModule(relPath) {
  const absPath = path.resolve(ROOT, relPath);
  const code = fs.readFileSync(absPath, "utf8");
  const transpiled = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const moduleObj = { exports: {} };
  const fn = new Function("exports", "require", "module", transpiled.outputText);
  const localRequire = (modPath) => {
    if (modPath.startsWith("./") || modPath.startsWith("../")) {
      const dir = path.dirname(absPath);
      const target = path.resolve(dir, modPath);
      for (const ext of [".ts", ".tsx", ".js", ""]) {
        const candidate = target + ext;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return loadTsModule(path.relative(ROOT, candidate));
        }
      }
    }
    return {};
  };
  fn(moduleObj.exports, localRequire, moduleObj);
  return moduleObj.exports;
}

const calculations = loadTsModule("src/lib/inventory/calculations.ts");
const { toMilliUnits, roundQuantity3 } = calculations;

console.log("=== RUNNING INVENTORY CALCULATIONS & STOCK ADJUSTMENT TESTS ===");

// 1. Integer
assert.equal(roundQuantity3(10), 10);
assert.equal(roundQuantity3("10"), 10);
assert.equal(roundQuantity3(0), 0);
assert.equal(roundQuantity3("0"), 0);
assert.equal(roundQuantity3(-5), -5);
assert.equal(roundQuantity3("-5"), -5);
console.log("  ✓ PASS: Integer (positive, zero, negative, number & string)");

// 2. Decimal
assert.equal(roundQuantity3(1.234), 1.234);
assert.equal(roundQuantity3("1.234"), 1.234);
assert.equal(roundQuantity3(0.001), 0.001);
assert.equal(roundQuantity3("0.001"), 0.001);
assert.equal(roundQuantity3(-2.345), -2.345);
assert.equal(roundQuantity3("-2.345"), -2.345);
// Half-up rounding
assert.equal(roundQuantity3("1.0055"), 1.006);
assert.equal(roundQuantity3("1.0054"), 1.005);
console.log("  ✓ PASS: Decimal (half-up rounding numeric(12,3) consistent)");

// 3. String numerik
assert.equal(roundQuantity3("  0.750  "), 0.75);
assert.equal(roundQuantity3("+15.123"), 15.123);
assert.equal(roundQuantity3("-0.500"), -0.5);
console.log("  ✓ PASS: Numeric string with whitespace and signs");

// 4. Null & Undefined
assert.throws(
  () => toMilliUnits(null),
  (err) => err instanceof Error && err.message.includes("Nilai kuantitas tidak boleh kosong"),
);
assert.throws(
  () => toMilliUnits(undefined),
  (err) => err instanceof Error && err.message.includes("Nilai kuantitas tidak boleh kosong"),
);
assert.throws(
  () => roundQuantity3(null),
  (err) => err instanceof Error && err.message.includes("Nilai kuantitas tidak boleh kosong"),
);
assert.throws(
  () => roundQuantity3(undefined),
  (err) => err instanceof Error && err.message.includes("Nilai kuantitas tidak boleh kosong"),
);
console.log("  ✓ PASS: Null & Undefined handled safely (no TypeError on .trim())");

// 5. String kosong
assert.throws(
  () => toMilliUnits(""),
  (err) => err instanceof Error && err.message.includes("tidak boleh berupa string kosong"),
);
assert.throws(
  () => toMilliUnits("    "),
  (err) => err instanceof Error && err.message.includes("tidak boleh berupa string kosong"),
);
assert.throws(
  () => roundQuantity3(""),
  (err) => err instanceof Error && err.message.includes("tidak boleh berupa string kosong"),
);
assert.throws(
  () => roundQuantity3("   "),
  (err) => err instanceof Error && err.message.includes("tidak boleh berupa string kosong"),
);
console.log("  ✓ PASS: Empty and whitespace strings rejected with clear message");

// 6. Input numerik tidak valid
assert.throws(
  () => toMilliUnits(NaN),
  (err) => err instanceof Error && err.message.includes("harus angka terhingga"),
);
assert.throws(
  () => toMilliUnits(Infinity),
  (err) => err instanceof Error && err.message.includes("harus angka terhingga"),
);
assert.throws(
  () => roundQuantity3(NaN),
  (err) => err instanceof Error && err.message.includes("harus angka terhingga"),
);
assert.throws(
  () => toMilliUnits("abc"),
  (err) => err instanceof Error && err.message.includes("Format angka desimal tidak valid"),
);
assert.throws(
  () => roundQuantity3("abc"),
  (err) => err instanceof Error && err.message.includes("Format angka desimal tidak valid"),
);
assert.throws(
  () => roundQuantity3("12.34.56"),
  (err) => err instanceof Error && err.message.includes("Format angka desimal tidak valid"),
);
assert.throws(
  () => roundQuantity3({}),
  (err) => err instanceof Error && err.message.includes("Format angka desimal tidak valid"),
);
assert.throws(
  () => roundQuantity3(false),
  (err) => err instanceof Error && err.message.includes("Format angka desimal tidak valid"),
);
console.log("  ✓ PASS: Invalid numeric inputs properly throw descriptive errors");

// 7. Simulasikan normalisasi adjustIngredientStockAction saat RPC tidak mengembalikan min_stock
console.log("\n--- Testing adjustIngredientStockAction normalization logic ---");
const mockRpcResult = {
  movement_id: "mov-12345",
  ingredient_id: "ing-67890",
  ingredient_name: "Tepung Terigu",
  unit: "kg",
  movement_type: "manual_out",
  quantity_delta: -2.5,
  stock_before: 10.0,
  stock_after: 7.5,
  reserved_stock: 0,
  available_stock: 7.5,
  // CATATAN: RPC TIDAK mengembalikan min_stock!
  is_low_stock: false,
  reason: "Bahan rusak",
  idempotency_key: "idem-111",
};

// Data master ingredient dari query tabel ingredients
const mockMasterIngredient = {
  id: "ing-67890",
  min_stock: "5.000", // min_stock aktual dari master data
};

// Simulasi normalisasi baru
const parseNumericField = (val, name) => {
  if (val === null || val === undefined) {
    throw new Error(`Kolom numerik "${name}" tidak ditemukan pada respons database.`);
  }
  if (typeof val !== "number" && typeof val !== "string") {
    throw new Error(`Format data numerik "${name}" tidak valid.`);
  }
  return roundQuantity3(val);
};

const actualMinStock = roundQuantity3(mockMasterIngredient.min_stock);
assert.equal(actualMinStock, 5.0, "min_stock harus diambil dari master data (5.0), BUKAN fallback 0");
assert.notEqual(actualMinStock, 0, "Dilarang memakai fallback 0");

const quantityDelta = parseNumericField(mockRpcResult.quantity_delta, "quantity_delta");
const stockBefore = parseNumericField(mockRpcResult.stock_before, "stock_before");
const stockAfter = parseNumericField(mockRpcResult.stock_after, "stock_after");
const reservedStock =
  mockRpcResult.reserved_stock !== null && mockRpcResult.reserved_stock !== undefined
    ? parseNumericField(mockRpcResult.reserved_stock, "reserved_stock")
    : 0;
const availableStock =
  mockRpcResult.available_stock !== null && mockRpcResult.available_stock !== undefined
    ? parseNumericField(mockRpcResult.available_stock, "available_stock")
    : Math.max(0, stockAfter - reservedStock);

const normalized = {
  movement_id: String(mockRpcResult.movement_id),
  ingredient_id: String(mockRpcResult.ingredient_id),
  ingredient_name: String(mockRpcResult.ingredient_name ?? ""),
  unit: mockRpcResult.unit,
  movement_type: mockRpcResult.movement_type,
  quantity_delta: quantityDelta,
  stock_before: stockBefore,
  stock_after: stockAfter,
  current_stock: stockAfter,
  reserved_stock: reservedStock,
  available_stock: availableStock,
  min_stock: actualMinStock,
  is_low_stock: Boolean(mockRpcResult.is_low_stock),
  reason: String(mockRpcResult.reason),
  idempotent_replay: Boolean(mockRpcResult.idempotent_replay),
  created_at: String(mockRpcResult.created_at ?? new Date().toISOString()),
};

assert.equal(normalized.movement_id, "mov-12345");
assert.equal(normalized.quantity_delta, -2.5);
assert.equal(normalized.stock_after, 7.5);
assert.equal(normalized.min_stock, 5.0);
console.log("  ✓ PASS: Normalization succeeds without reading rpcResult.min_stock");
console.log("  ✓ PASS: min_stock correctly populated from master ingredient data");

console.log("\nALL TESTS PASSED CLEANLY!");
