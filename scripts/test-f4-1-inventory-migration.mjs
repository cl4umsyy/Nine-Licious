#!/usr/bin/env node
/**
 * NINE LICIOUS POS — F4.1 VERIFICATION SUITE: INVENTORY MIGRATION, RPC, TRIGGER & SECURITY
 *
 * Memverifikasi kontrak SQL, integritas logika, idempotensi, keamanan RBAC/RLS,
 * pencegahan deadlock, dan isolasi pembayaran pada:
 *   supabase/migrations/20261119000100_f4_inventory_stock.sql
 *
 * Skenario uji (14 grup komprehensif):
 *  1. Pengurangan stok sesuai resep (termasuk presisi desimal numeric(12,3)).
 *  2. Beberapa produk berbeda dengan bahan baku sama -> diagregasi & dikunci urut ingredient_id ASC.
 *  3. Produk tanpa resep -> dilewati aman tanpa error dan tanpa mutasi palsu.
 *  4. Pesanan dengan beberapa baris item (termasuk produk sama dengan modifier berbeda).
 *  5. Split bill -> tidak memotong saat partially_paid, memotong tepat sekali saat final -> paid.
 *  6. Webhook Midtrans duplikat & retry pembayaran -> idempoten, tidak pernah double deduction.
 *  7. Refund penuh -> TIDAK otomatis mengembalikan stok; admin memakai manual_in dengan alasan wajib.
 *  8. Stok tidak mencukupi -> stok boleh menjadi negatif, pembayaran tetap sukses;
 *     galat tak terduga di trigger diisolasi subtransaksi & tidak membatalkan pembayaran.
 *  9. Penyesuaian manual (`manual_in`, `manual_out`, `stock_opname`) + anti-negatif manual_out
 *     + tolak opname tanpa perubahan + tolak bahan arsip + idempotency key.
 * 10. Validasi alasan wajib (kosong / whitespace / < 3 karakter ditolak) & validasi angka NaN/Infinity.
 * 11. RBAC & RLS -> hanya admin aktif dapat baca stok/resep/mutasi & panggil RPC penyesuaian;
 *     kasir, kitchen, anon, inactive admin, dan service_role (tanpa auth.uid) ditolak.
 * 12. Proteksi mutasi langsung `current_stock` -> ditolak guard trigger kecuali melalui RPC/internal.
 * 13. Audit log -> `inventory.stock_adjusted`, `inventory.sale_deducted`, dan `inventory.sale_deduction_failed`.
 * 14. Audit Kontrak SQL & Keamanan Statis pada file migrasi 20261119000100_f4_inventory_stock.sql
 *     (DDL, FK on delete restrict, constraints, partial unique index, RLS, grants, SECURITY DEFINER,
 *      search_path, zero demo seed, dan zero modifikasi tabel/RPC F0–F3).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MIGRATION_PATH = "supabase/migrations/20261119000100_f4_inventory_stock.sql";
const migrationSql = fs.readFileSync(path.join(ROOT, MIGRATION_PATH), "utf-8");

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

// ============================================================================
// In-Memory PostgreSQL Simulator mirroring 20261119000100_f4_inventory_stock.sql
// ============================================================================
function createInventoryDbSimulator() {
  const db = {
    profiles: new Map([
      ["adm-1", { id: "adm-1", username: "admin", role: "admin", is_active: true }],
      ["adm-off", { id: "adm-off", username: "admin_off", role: "admin", is_active: false }],
      ["ksr-1", { id: "ksr-1", username: "kasir1", role: "kasir", is_active: true }],
      ["kch-1", { id: "kch-1", username: "kitchen1", role: "kitchen", is_active: true }],
    ]),
    ingredients: new Map(),
    recipes: [],
    orders: new Map(),
    orderItems: [],
    stockMovements: [],
    auditLogs: [],
    lockOrderLog: [],
    allowStockMutationGuc: "off",
    injectDeductionCrashForOrderId: null,
  };

  function isAdmin(userId) {
    if (!userId) return false;
    const p = db.profiles.get(userId);
    return Boolean(p && p.is_active && p.role === "admin");
  }

  // Mirrors RLS SELECT policies on ingredients, recipes, stock_movements
  function selectWithRls(table, actorRole, userId) {
    if (actorRole === "anon") {
      throw new Error(`permission denied for table ${table}`);
    }
    if (actorRole === "authenticated") {
      if (!isAdmin(userId)) {
        return []; // RLS hides all rows from kasir/kitchen/inactive
      }
    }
    if (table === "ingredients") return Array.from(db.ingredients.values());
    if (table === "recipes") return [...db.recipes];
    if (table === "stock_movements") return [...db.stockMovements];
    throw new Error(`unknown table ${table}`);
  }

  // Mirrors guard trigger protect_ingredient_current_stock_direct_mutation
  function insertIngredient({ id, name, sku = null, unit, current_stock = 0, min_stock = 0, is_active = true }) {
    if (Number(current_stock) !== 0 && db.allowStockMutationGuc !== "on") {
      throw new Error(
        "Stok awal bahan baku wajib 0 saat pembuatan master. Gunakan RPC adjust_ingredient_stock_atomic.",
      );
    }
    const row = {
      id,
      name,
      sku,
      unit,
      current_stock: round3(current_stock),
      min_stock: round3(min_stock),
      is_active,
    };
    db.ingredients.set(id, row);
    return row;
  }

  function directUpdateIngredientStock(actorRole, ingredientId, newStock) {
    if (actorRole === "anon" || actorRole === "authenticated") {
      throw new Error("permission denied for table ingredients");
    }
    const row = db.ingredients.get(ingredientId);
    if (!row) throw new Error("Bahan baku tidak ditemukan.");
    if (round3(newStock) !== row.current_stock && db.allowStockMutationGuc !== "on") {
      throw new Error(
        "Perubahan current_stock secara langsung dilarang. Semua mutasi stok wajib melalui RPC adjust_ingredient_stock_atomic atau pengurangan stok penjualan otomatis.",
      );
    }
    row.current_stock = round3(newStock);
  }

  function addRecipe({ product_id, ingredient_id, quantity_required }) {
    if (!(quantity_required > 0)) {
      throw new Error("recipes_quantity_positive_check violated");
    }
    if (db.recipes.some((r) => r.product_id === product_id && r.ingredient_id === ingredient_id)) {
      throw new Error("recipes_product_ingredient_unique violated");
    }
    db.recipes.push({
      id: `rcp-${db.recipes.length + 1}`,
      product_id,
      ingredient_id,
      quantity_required: round3(quantity_required),
    });
  }

  // Mirrors public.adjust_ingredient_stock_atomic
  function adjustIngredientStockAtomic({
    callerRole = "authenticated",
    authUid,
    ingredientId,
    movementType,
    quantity,
    reason,
    idempotencyKey = null,
  }) {
    if (callerRole !== "authenticated") {
      throw new Error("permission denied for function adjust_ingredient_stock_atomic");
    }
    if (!authUid) {
      throw new Error("Autentikasi sesi admin diperlukan untuk melakukan penyesuaian stok.");
    }
    const profile = db.profiles.get(authUid);
    if (!profile || !profile.is_active || profile.role !== "admin") {
      throw new Error("Hanya admin aktif yang berhak melakukan penyesuaian stok bahan baku.");
    }
    if (!ingredientId) throw new Error("ID bahan baku tidak valid.");
    if (!["manual_in", "manual_out", "stock_opname"].includes(movementType)) {
      throw new Error("Jenis penyesuaian stok tidak valid.");
    }
    const cleanReason = String(reason ?? "").trim();
    if (cleanReason.length < 3 || cleanReason.length > 500) {
      throw new Error("Alasan penyesuaian stok wajib diisi (minimal 3 karakter, maksimal 500 karakter).");
    }
    if (quantity === null || quantity === undefined || !Number.isFinite(Number(quantity))) {
      throw new Error("Jumlah penyesuaian stok tidak valid.");
    }
    if (Math.abs(Number(quantity)) > 999999999) {
      throw new Error("Jumlah penyesuaian stok melebihi batas maksimum yang diizinkan.");
    }
    const qty = round3(quantity);
    if ((movementType === "manual_in" || movementType === "manual_out") && qty <= 0) {
      throw new Error(`Jumlah untuk ${movementType} harus lebih besar dari 0.`);
    }
    if (movementType === "stock_opname" && qty < 0) {
      throw new Error("Stok aktual pada stock_opname tidak boleh negatif.");
    }

    const cleanKey = idempotencyKey ? String(idempotencyKey).trim() : null;
    if (cleanKey && (cleanKey.length < 8 || cleanKey.length > 128)) {
      throw new Error("Format idempotency_key tidak valid.");
    }

    const ingredient = db.ingredients.get(ingredientId);
    if (!ingredient) throw new Error("Bahan baku tidak ditemukan.");

    if (cleanKey) {
      const existing = db.stockMovements.find((m) => m.idempotency_key === cleanKey);
      if (existing) {
        if (existing.ingredient_id !== ingredientId || existing.movement_type !== movementType) {
          throw new Error("idempotency_key sudah digunakan untuk bahan baku atau jenis penyesuaian berbeda.");
        }
        return {
          movement_id: existing.id,
          ingredient_id: ingredient.id,
          movement_type: existing.movement_type,
          quantity_delta: existing.quantity_delta,
          stock_before: existing.stock_before,
          stock_after: existing.stock_after,
          is_low_stock: existing.stock_after <= ingredient.min_stock,
          idempotent_replay: true,
        };
      }
    }

    if (!ingredient.is_active) {
      throw new Error(`Bahan baku "${ingredient.name}" sedang nonaktif (diarsipkan).`);
    }

    const stockBefore = ingredient.current_stock;
    let delta;
    let stockAfter;

    if (movementType === "manual_in") {
      delta = qty;
      stockAfter = round3(stockBefore + delta);
    } else if (movementType === "manual_out") {
      delta = -qty;
      stockAfter = round3(stockBefore + delta);
      if (stockAfter < 0) {
        throw new Error("Pengurangan stok manual melebihi stok saat ini.");
      }
    } else {
      stockAfter = qty;
      delta = round3(stockAfter - stockBefore);
      if (delta === 0) {
        throw new Error("Stok hasil opname sama dengan stok saat ini.");
      }
    }

    db.allowStockMutationGuc = "on";
    ingredient.current_stock = stockAfter;
    db.allowStockMutationGuc = "off";

    const movement = {
      id: `mov-${db.stockMovements.length + 1}`,
      ingredient_id: ingredient.id,
      movement_type: movementType,
      quantity_delta: delta,
      stock_before: stockBefore,
      stock_after: stockAfter,
      order_id: null,
      reason: cleanReason,
      idempotency_key: cleanKey,
      created_by: authUid,
    };
    db.stockMovements.push(movement);

    db.auditLogs.push({
      action: "inventory.stock_adjusted",
      user_id: authUid,
      username: profile.username,
      entity: "ingredient",
      entity_id: ingredient.id,
      details: {
        movement_id: movement.id,
        movement_type: movementType,
        quantity_delta: delta,
        stock_before: stockBefore,
        stock_after: stockAfter,
        reason: cleanReason,
        is_low_stock: stockAfter <= ingredient.min_stock,
      },
    });

    return {
      movement_id: movement.id,
      ingredient_id: ingredient.id,
      movement_type: movementType,
      quantity_delta: delta,
      stock_before: stockBefore,
      stock_after: stockAfter,
      is_low_stock: stockAfter <= ingredient.min_stock,
      idempotent_replay: false,
    };
  }

  // Mirrors public.deduct_order_stock_internal
  function deductOrderStockInternal(orderId) {
    if (db.injectDeductionCrashForOrderId === orderId) {
      throw new Error("SIMULATED_INVENTORY_TRANSIENT_ERROR");
    }

    const order = db.orders.get(orderId);
    if (!order) return { ok: false, reason: "order_not_found", deducted_count: 0 };
    if (order.payment_status !== "paid" || ["cancelled", "refunded"].includes(order.status)) {
      return { ok: true, skipped: true, deducted_count: 0 };
    }

    // Aggregate requirements across order_items JOIN recipes JOIN active ingredients
    const aggMap = new Map();
    for (const item of db.orderItems.filter((oi) => oi.order_id === orderId && oi.quantity > 0)) {
      const productRecipes = db.recipes.filter((r) => r.product_id === item.product_id);
      for (const r of productRecipes) {
        const ing = db.ingredients.get(r.ingredient_id);
        if (!ing || !ing.is_active) continue;
        const prev = aggMap.get(r.ingredient_id) || 0;
        aggMap.set(r.ingredient_id, round3(prev + r.quantity_required * item.quantity));
      }
    }

    // Deterministic locking order: ORDER BY ingredient_id ASC
    const sortedIds = Array.from(aggMap.keys()).sort((a, b) => a.localeCompare(b));
    const lockedThisCall = [];
    let deductedCount = 0;
    let skippedExistingCount = 0;
    const lowStockIds = [];
    const negativeStockIds = [];

    for (const ingredientId of sortedIds) {
      const totalRequired = aggMap.get(ingredientId);
      if (!(totalRequired > 0)) continue;

      lockedThisCall.push(ingredientId);
      const ingredient = db.ingredients.get(ingredientId);
      if (!ingredient || !ingredient.is_active) continue;

      // Insert-first idempotent guard: ON CONFLICT (order_id, ingredient_id) WHERE movement_type='sale_deduction'
      const duplicate = db.stockMovements.find(
        (m) =>
          m.order_id === order.id &&
          m.ingredient_id === ingredient.id &&
          m.movement_type === "sale_deduction",
      );
      if (duplicate) {
        skippedExistingCount += 1;
        continue;
      }

      const stockBefore = ingredient.current_stock;
      const delta = -totalRequired;
      const stockAfter = round3(stockBefore + delta);

      const movement = {
        id: `mov-${db.stockMovements.length + 1}`,
        ingredient_id: ingredient.id,
        movement_type: "sale_deduction",
        quantity_delta: delta,
        stock_before: stockBefore,
        stock_after: stockAfter,
        order_id: order.id,
        reason: `Pengurangan stok otomatis dari pesanan lunas #${order.order_number}`,
        idempotency_key: null,
        created_by: order.created_by,
      };
      db.stockMovements.push(movement);

      db.allowStockMutationGuc = "on";
      ingredient.current_stock = stockAfter;
      db.allowStockMutationGuc = "off";

      deductedCount += 1;
      if (stockAfter <= ingredient.min_stock) lowStockIds.push(ingredient.id);
      if (stockAfter < 0) negativeStockIds.push(ingredient.id);
    }

    if (lockedThisCall.length > 0) {
      db.lockOrderLog.push({ orderId, lockedIngredientIds: lockedThisCall });
    }

    if (deductedCount > 0) {
      db.auditLogs.push({
        action: "inventory.sale_deducted",
        user_id: order.created_by,
        username: null,
        entity: "order",
        entity_id: order.id,
        details: {
          order_id: order.id,
          order_number: order.order_number,
          deducted_count: deductedCount,
          low_stock_ingredient_ids: lowStockIds,
          negative_stock_ingredient_ids: negativeStockIds,
        },
      });
    }

    return {
      ok: true,
      order_id: order.id,
      deducted_count: deductedCount,
      skipped_existing_count: skippedExistingCount,
      low_stock_ingredient_ids: lowStockIds,
      negative_stock_ingredient_ids: negativeStockIds,
    };
  }

  // Mirrors AFTER UPDATE OF payment_status ON public.orders trigger with isolated subtransaction
  function updateOrderPaymentStatus(orderId, nextPaymentStatus, nextOrderStatus) {
    const order = db.orders.get(orderId);
    if (!order) throw new Error("Order not found");
    const oldPaymentStatus = order.payment_status;

    order.payment_status = nextPaymentStatus;
    if (nextOrderStatus) order.status = nextOrderStatus;

    // Trigger WHEN (old.payment_status is distinct from 'paid' and new.payment_status = 'paid')
    if (oldPaymentStatus !== "paid" && nextPaymentStatus === "paid") {
      // Subtransaction isolation (BEGIN ... EXCEPTION WHEN OTHERS)
      const snapshotMovementsLen = db.stockMovements.length;
      const snapshotStocks = new Map(
        Array.from(db.ingredients.entries()).map(([k, v]) => [k, v.current_stock]),
      );
      try {
        deductOrderStockInternal(order.id);
      } catch (err) {
        // Roll back ONLY stock subtransaction, NOT the payment settlement!
        db.stockMovements.length = snapshotMovementsLen;
        for (const [k, val] of snapshotStocks.entries()) {
          db.ingredients.get(k).current_stock = val;
        }
        db.allowStockMutationGuc = "off";
        db.auditLogs.push({
          action: "inventory.sale_deduction_failed",
          user_id: order.created_by,
          username: null,
          entity: "order",
          entity_id: order.id,
          details: {
            order_id: order.id,
            order_number: order.order_number,
            error_message: err.message,
          },
        });
      }
    }

    return order;
  }

  return {
    db,
    selectWithRls,
    insertIngredient,
    directUpdateIngredientStock,
    addRecipe,
    adjustIngredientStockAtomic,
    deductOrderStockInternal,
    updateOrderPaymentStatus,
  };
}

// ============================================================================
// TEST RUNNER
// ============================================================================
let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err instanceof Error ? err.stack || err.message : String(err)}`);
    failed += 1;
  }
}

console.log("\n=== NINE LICIOUS POS — F4.1 INVENTORY MIGRATION & SECURITY TEST SUITE ===\n");

runTest("1. Pengurangan stok sesuai resep (termasuk presisi desimal numeric(12,3))", () => {
  const sim = createInventoryDbSimulator();
  sim.insertIngredient({ id: "ing-beras", name: "Beras", unit: "kg", min_stock: 1 });
  sim.insertIngredient({ id: "ing-telur", name: "Telur", unit: "pcs", min_stock: 10 });
  sim.adjustIngredientStockAtomic({
    authUid: "adm-1",
    ingredientId: "ing-beras",
    movementType: "manual_in",
    quantity: 5,
    reason: "Stok awal pembelian beras",
  });
  sim.adjustIngredientStockAtomic({
    authUid: "adm-1",
    ingredientId: "ing-telur",
    movementType: "manual_in",
    quantity: 30,
    reason: "Stok awal telur ayam",
  });

  sim.addRecipe({ product_id: "prod-nasgor", ingredient_id: "ing-beras", quantity_required: 0.15 });
  sim.addRecipe({ product_id: "prod-nasgor", ingredient_id: "ing-telur", quantity_required: 1 });

  sim.db.orders.set("ord-1", {
    id: "ord-1",
    order_number: "ORD-20261119-0001",
    status: "awaiting_payment",
    payment_status: "unpaid",
    created_by: "ksr-1",
  });
  sim.db.orderItems.push({ order_id: "ord-1", product_id: "prod-nasgor", quantity: 3 });

  sim.updateOrderPaymentStatus("ord-1", "paid", "paid");

  assert.equal(sim.db.ingredients.get("ing-beras").current_stock, 4.55);
  assert.equal(sim.db.ingredients.get("ing-telur").current_stock, 27);
  const saleMovs = sim.db.stockMovements.filter((m) => m.movement_type === "sale_deduction");
  assert.equal(saleMovs.length, 2);
});

runTest("2. Beberapa produk berbeda dengan bahan baku sama -> agregasi + lock urutan ingredient_id ASC", () => {
  const sim = createInventoryDbSimulator();
  sim.insertIngredient({ id: "ing-z-beras", name: "Beras", unit: "g", min_stock: 500 });
  sim.insertIngredient({ id: "ing-a-ayam", name: "Ayam Fillet", unit: "g", min_stock: 500 });
  sim.insertIngredient({ id: "ing-m-minyak", name: "Minyak Goreng", unit: "ml", min_stock: 200 });

  for (const [id, qty] of [
    ["ing-z-beras", 2000],
    ["ing-a-ayam", 1000],
    ["ing-m-minyak", 1000],
  ]) {
    sim.adjustIngredientStockAtomic({
      authUid: "adm-1",
      ingredientId: id,
      movementType: "manual_in",
      quantity: qty,
      reason: "Stok awal dapur",
    });
  }

  // Produk 1: Nasi Goreng (beras 150g + minyak 20ml)
  sim.addRecipe({ product_id: "prod-1", ingredient_id: "ing-z-beras", quantity_required: 150 });
  sim.addRecipe({ product_id: "prod-1", ingredient_id: "ing-m-minyak", quantity_required: 20 });
  // Produk 2: Ayam Geprek (beras 150g + ayam 120g + minyak 30ml)
  sim.addRecipe({ product_id: "prod-2", ingredient_id: "ing-z-beras", quantity_required: 150 });
  sim.addRecipe({ product_id: "prod-2", ingredient_id: "ing-a-ayam", quantity_required: 120 });
  sim.addRecipe({ product_id: "prod-2", ingredient_id: "ing-m-minyak", quantity_required: 30 });

  sim.db.orders.set("ord-2", {
    id: "ord-2",
    order_number: "ORD-20261119-0002",
    status: "awaiting_payment",
    payment_status: "unpaid",
    created_by: "ksr-1",
  });
  sim.db.orderItems.push({ order_id: "ord-2", product_id: "prod-1", quantity: 2 });
  sim.db.orderItems.push({ order_id: "ord-2", product_id: "prod-2", quantity: 3 });

  sim.updateOrderPaymentStatus("ord-2", "paid", "paid");

  // Beras: 150*2 + 150*3 = 750g -> 2000 - 750 = 1250
  assert.equal(sim.db.ingredients.get("ing-z-beras").current_stock, 1250);
  // Ayam: 120*3 = 360g -> 1000 - 360 = 640
  assert.equal(sim.db.ingredients.get("ing-a-ayam").current_stock, 640);
  // Minyak: 20*2 + 30*3 = 130ml -> 1000 - 130 = 870
  assert.equal(sim.db.ingredients.get("ing-m-minyak").current_stock, 870);

  // Urutan penguncian WAJIB deterministik ascending (anti-deadlock)
  assert.deepEqual(sim.db.lockOrderLog[0].lockedIngredientIds, [
    "ing-a-ayam",
    "ing-m-minyak",
    "ing-z-beras",
  ]);
});

runTest("3. Produk tanpa resep dilewati secara aman tanpa error & tanpa mutasi palsu", () => {
  const sim = createInventoryDbSimulator();
  sim.db.orders.set("ord-3", {
    id: "ord-3",
    order_number: "ORD-20261119-0003",
    status: "awaiting_payment",
    payment_status: "unpaid",
    created_by: "ksr-1",
  });
  sim.db.orderItems.push({ order_id: "ord-3", product_id: "prod-air-mineral", quantity: 4 });

  sim.updateOrderPaymentStatus("ord-3", "paid", "paid");
  assert.equal(sim.db.orders.get("ord-3").payment_status, "paid");
  assert.equal(sim.db.stockMovements.length, 0);
  assert.equal(sim.db.auditLogs.length, 0);
});

runTest("4. Pesanan dengan beberapa baris item (termasuk produk sama dengan modifier berbeda)", () => {
  const sim = createInventoryDbSimulator();
  sim.insertIngredient({ id: "ing-kopi", name: "Biji Kopi", unit: "g", min_stock: 100 });
  sim.adjustIngredientStockAtomic({
    authUid: "adm-1",
    ingredientId: "ing-kopi",
    movementType: "manual_in",
    quantity: 500,
    reason: "Stok biji kopi",
  });
  sim.addRecipe({ product_id: "prod-latte", ingredient_id: "ing-kopi", quantity_required: 18 });

  sim.db.orders.set("ord-4", {
    id: "ord-4",
    order_number: "ORD-20261119-0004",
    status: "awaiting_payment",
    payment_status: "unpaid",
    created_by: "ksr-1",
  });
  // Baris 1: Latte Less Sugar x2, Baris 2: Latte Normal x1, Baris 3: Produk tanpa resep x1
  sim.db.orderItems.push({ order_id: "ord-4", product_id: "prod-latte", quantity: 2 });
  sim.db.orderItems.push({ order_id: "ord-4", product_id: "prod-latte", quantity: 1 });
  sim.db.orderItems.push({ order_id: "ord-4", product_id: "prod-tanpa-resep", quantity: 1 });

  sim.updateOrderPaymentStatus("ord-4", "paid", "paid");
  // Total kopi: 18 * (2 + 1) = 54g -> 500 - 54 = 446g dalam tepat 1 baris stock_movements
  assert.equal(sim.db.ingredients.get("ing-kopi").current_stock, 446);
  const saleMovs = sim.db.stockMovements.filter(
    (m) => m.order_id === "ord-4" && m.movement_type === "sale_deduction",
  );
  assert.equal(saleMovs.length, 1);
  assert.equal(saleMovs[0].quantity_delta, -54);
});

runTest("5. Split bill -> tidak memotong saat partially_paid, baru memotong tepat sekali saat lunas (paid)", () => {
  const sim = createInventoryDbSimulator();
  sim.insertIngredient({ id: "ing-gula", name: "Gula Pasir", unit: "g", min_stock: 100 });
  sim.adjustIngredientStockAtomic({
    authUid: "adm-1",
    ingredientId: "ing-gula",
    movementType: "manual_in",
    quantity: 300,
    reason: "Stok awal gula",
  });
  sim.addRecipe({ product_id: "prod-tea", ingredient_id: "ing-gula", quantity_required: 25 });

  sim.db.orders.set("ord-5", {
    id: "ord-5",
    order_number: "ORD-20261119-0005",
    status: "awaiting_payment",
    payment_status: "unpaid",
    created_by: "ksr-1",
  });
  sim.db.orderItems.push({ order_id: "ord-5", product_id: "prod-tea", quantity: 2 });

  // Pembayaran parsial 1 (split bill) -> stok BELUM boleh berkurang
  sim.updateOrderPaymentStatus("ord-5", "partially_paid", "partially_paid");
  assert.equal(sim.db.ingredients.get("ing-gula").current_stock, 300);

  // Pelunasan akhir (Tunai / Midtrans) -> stok baru berkurang 50g
  sim.updateOrderPaymentStatus("ord-5", "paid", "paid");
  assert.equal(sim.db.ingredients.get("ing-gula").current_stock, 250);
});

runTest("6. Webhook duplikat & retry pembayaran -> idempoten, tidak pernah double deduction", () => {
  const sim = createInventoryDbSimulator();
  sim.insertIngredient({ id: "ing-susu", name: "Susu UHT", unit: "ml", min_stock: 200 });
  sim.adjustIngredientStockAtomic({
    authUid: "adm-1",
    ingredientId: "ing-susu",
    movementType: "manual_in",
    quantity: 1000,
    reason: "Stok susu UHT",
  });
  sim.addRecipe({ product_id: "prod-milk", ingredient_id: "ing-susu", quantity_required: 200 });

  sim.db.orders.set("ord-6", {
    id: "ord-6",
    order_number: "ORD-20261119-0006",
    status: "awaiting_payment",
    payment_status: "unpaid",
    created_by: "ksr-1",
  });
  sim.db.orderItems.push({ order_id: "ord-6", product_id: "prod-milk", quantity: 1 });

  // Pertama kali settlement
  sim.updateOrderPaymentStatus("ord-6", "paid", "paid");
  assert.equal(sim.db.ingredients.get("ing-susu").current_stock, 800);

  // Simulasi webhook duplikat / retry update / panggilan ulang deduct_order_stock_internal
  sim.updateOrderPaymentStatus("ord-6", "paid", "paid");
  const replay = sim.deductOrderStockInternal("ord-6");
  assert.equal(replay.deducted_count, 0);
  assert.equal(replay.skipped_existing_count, 1);
  assert.equal(sim.db.ingredients.get("ing-susu").current_stock, 800);
});

runTest("7. Refund penuh TIDAK otomatis mengembalikan stok; admin memakai manual_in dengan alasan wajib", () => {
  const sim = createInventoryDbSimulator();
  sim.insertIngredient({ id: "ing-keju", name: "Keju Slice", unit: "pcs", min_stock: 5 });
  sim.adjustIngredientStockAtomic({
    authUid: "adm-1",
    ingredientId: "ing-keju",
    movementType: "manual_in",
    quantity: 20,
    reason: "Stok awal keju",
  });
  sim.addRecipe({ product_id: "prod-burger", ingredient_id: "ing-keju", quantity_required: 2 });

  sim.db.orders.set("ord-7", {
    id: "ord-7",
    order_number: "ORD-20261119-0007",
    status: "awaiting_payment",
    payment_status: "unpaid",
    created_by: "ksr-1",
  });
  sim.db.orderItems.push({ order_id: "ord-7", product_id: "prod-burger", quantity: 1 });

  sim.updateOrderPaymentStatus("ord-7", "paid", "paid");
  assert.equal(sim.db.ingredients.get("ing-keju").current_stock, 18);

  // Refund penuh terjadi -> stok TETAP 18 (tidak otomatis kembali)
  sim.updateOrderPaymentStatus("ord-7", "refunded", "refunded");
  assert.equal(sim.db.ingredients.get("ing-keju").current_stock, 18);

  // Jika bahan masih layak pakai, admin mencatat manual_in secara eksplisit dengan alasan
  const restock = sim.adjustIngredientStockAtomic({
    authUid: "adm-1",
    ingredientId: "ing-keju",
    movementType: "manual_in",
    quantity: 2,
    reason: "Pengembalian manual keju belum dimasak pasca refund ORD-20261119-0007",
  });
  assert.equal(restock.stock_after, 20);
});

runTest("8. Stok tidak mencukupi -> stok boleh negatif; kegagalan tak terduga tidak membatalkan pembayaran", () => {
  const sim = createInventoryDbSimulator();
  sim.insertIngredient({ id: "ing-daging", name: "Daging Sapi", unit: "g", min_stock: 500 });
  sim.adjustIngredientStockAtomic({
    authUid: "adm-1",
    ingredientId: "ing-daging",
    movementType: "manual_in",
    quantity: 100,
    reason: "Sisa stok daging",
  });
  sim.addRecipe({ product_id: "prod-beef", ingredient_id: "ing-daging", quantity_required: 150 });

  sim.db.orders.set("ord-8a", {
    id: "ord-8a",
    order_number: "ORD-20261119-0008",
    status: "awaiting_payment",
    payment_status: "unpaid",
    created_by: "ksr-1",
  });
  sim.db.orderItems.push({ order_id: "ord-8a", product_id: "prod-beef", quantity: 2 });

  // Stok 100g - 300g = -200g -> pembayaran tetap LUNAS!
  sim.updateOrderPaymentStatus("ord-8a", "paid", "paid");
  assert.equal(sim.db.orders.get("ord-8a").payment_status, "paid");
  assert.equal(sim.db.ingredients.get("ing-daging").current_stock, -200);

  // Simulasi error tak terduga saat pemotongan stok -> transaksi pembayaran TETAP SUKSES & audit failure tercatat
  sim.db.orders.set("ord-8b", {
    id: "ord-8b",
    order_number: "ORD-20261119-0009",
    status: "awaiting_payment",
    payment_status: "unpaid",
    created_by: "ksr-1",
  });
  sim.db.orderItems.push({ order_id: "ord-8b", product_id: "prod-beef", quantity: 1 });
  sim.db.injectDeductionCrashForOrderId = "ord-8b";

  sim.updateOrderPaymentStatus("ord-8b", "paid", "paid");
  assert.equal(sim.db.orders.get("ord-8b").payment_status, "paid");
  assert.equal(sim.db.ingredients.get("ing-daging").current_stock, -200);
  assert.ok(
    sim.db.auditLogs.some(
      (a) => a.action === "inventory.sale_deduction_failed" && a.entity_id === "ord-8b",
    ),
  );
});

runTest("9. Penyesuaian manual (manual_in, manual_out, stock_opname) + idempotency + guard arsip", () => {
  const sim = createInventoryDbSimulator();
  sim.insertIngredient({ id: "ing-tepung", name: "Tepung Terigu", unit: "kg", min_stock: 2 });

  // manual_in + idempotency replay
  const r1 = sim.adjustIngredientStockAtomic({
    authUid: "adm-1",
    ingredientId: "ing-tepung",
    movementType: "manual_in",
    quantity: 10,
    reason: "Belanja mingguan supplier",
    idempotencyKey: "adj-key-0001",
  });
  assert.equal(r1.stock_after, 10);
  assert.equal(r1.idempotent_replay, false);

  const r1Replay = sim.adjustIngredientStockAtomic({
    authUid: "adm-1",
    ingredientId: "ing-tepung",
    movementType: "manual_in",
    quantity: 10,
    reason: "Belanja mingguan supplier",
    idempotencyKey: "adj-key-0001",
  });
  assert.equal(r1Replay.idempotent_replay, true);
  assert.equal(sim.db.ingredients.get("ing-tepung").current_stock, 10);

  // manual_out valid
  const r2 = sim.adjustIngredientStockAtomic({
    authUid: "adm-1",
    ingredientId: "ing-tepung",
    movementType: "manual_out",
    quantity: 2.5,
    reason: "Tepung basah / rusak di gudang",
  });
  assert.equal(r2.stock_after, 7.5);
  assert.equal(r2.quantity_delta, -2.5);

  // manual_out melebihi stok -> DITOLAK
  assert.throws(() => {
    sim.adjustIngredientStockAtomic({
      authUid: "adm-1",
      ingredientId: "ing-tepung",
      movementType: "manual_out",
      quantity: 8,
      reason: "Pengeluaran berlebih",
    });
  }, /melebihi stok/);

  // stock_opname -> menyetel stok aktual 1.5 kg (memicu is_low_stock = true)
  const r3 = sim.adjustIngredientStockAtomic({
    authUid: "adm-1",
    ingredientId: "ing-tepung",
    movementType: "stock_opname",
    quantity: 1.5,
    reason: "Stock opname akhir pekan",
  });
  assert.equal(r3.stock_after, 1.5);
  assert.equal(r3.quantity_delta, -6);
  assert.equal(r3.is_low_stock, true);

  // stock_opname delta 0 -> DITOLAK
  assert.throws(() => {
    sim.adjustIngredientStockAtomic({
      authUid: "adm-1",
      ingredientId: "ing-tepung",
      movementType: "stock_opname",
      quantity: 1.5,
      reason: "Opname tanpa perubahan",
    });
  }, /sama dengan stok/);

  // Bahan nonaktif (diarsipkan) -> DITOLAK
  sim.db.ingredients.get("ing-tepung").is_active = false;
  assert.throws(() => {
    sim.adjustIngredientStockAtomic({
      authUid: "adm-1",
      ingredientId: "ing-tepung",
      movementType: "manual_in",
      quantity: 5,
      reason: "Coba ubah bahan nonaktif",
    });
  }, /nonaktif/);
});

runTest("10. Validasi alasan wajib & tolak nilai numerik invalid (NaN / Infinity / <= 0)", () => {
  const sim = createInventoryDbSimulator();
  sim.insertIngredient({ id: "ing-garam", name: "Garam", unit: "g", min_stock: 50 });

  for (const badReason of ["", "  ", "ok", null]) {
    assert.throws(() => {
      sim.adjustIngredientStockAtomic({
        authUid: "adm-1",
        ingredientId: "ing-garam",
        movementType: "manual_in",
        quantity: 100,
        reason: badReason,
      });
    }, /Alasan penyesuaian stok wajib diisi/);
  }

  for (const badQty of [NaN, Infinity, -Infinity, null]) {
    assert.throws(() => {
      sim.adjustIngredientStockAtomic({
        authUid: "adm-1",
        ingredientId: "ing-garam",
        movementType: "manual_in",
        quantity: badQty,
        reason: "Restock garam",
      });
    }, /tidak valid/);
  }

  // Tidak boleh memalsukan movement_type = 'sale_deduction' lewat RPC penyesuaian
  assert.throws(() => {
    sim.adjustIngredientStockAtomic({
      authUid: "adm-1",
      ingredientId: "ing-garam",
      movementType: "sale_deduction",
      quantity: 10,
      reason: "Percobaan manipulasi",
    });
  }, /Jenis penyesuaian stok tidak valid/);
});

runTest("11. RBAC & RLS -> hanya admin aktif dapat akses stok/resep/mutasi & panggil RPC", () => {
  const sim = createInventoryDbSimulator();
  sim.insertIngredient({ id: "ing-cabai", name: "Cabai Rawit", unit: "g", min_stock: 100 });

  // RLS SELECT check
  assert.equal(sim.selectWithRls("ingredients", "authenticated", "adm-1").length, 1);
  assert.equal(sim.selectWithRls("ingredients", "authenticated", "ksr-1").length, 0);
  assert.equal(sim.selectWithRls("ingredients", "authenticated", "kch-1").length, 0);
  assert.equal(sim.selectWithRls("ingredients", "authenticated", "adm-off").length, 0);
  assert.throws(() => sim.selectWithRls("ingredients", "anon", null), /permission denied/);
  assert.throws(() => sim.selectWithRls("stock_movements", "anon", null), /permission denied/);

  // RPC execution check
  for (const [role, uid] of [
    ["authenticated", "ksr-1"],
    ["authenticated", "kch-1"],
    ["authenticated", "adm-off"],
    ["authenticated", null],
    ["anon", null],
    ["service_role", null],
  ]) {
    assert.throws(() => {
      sim.adjustIngredientStockAtomic({
        callerRole: role,
        authUid: uid,
        ingredientId: "ing-cabai",
        movementType: "manual_in",
        quantity: 100,
        reason: "Percobaan akses tidak sah",
      });
    });
  }
});

runTest("12. Proteksi mutasi langsung current_stock ditolak untuk client maupun direct UPDATE", () => {
  const sim = createInventoryDbSimulator();
  sim.insertIngredient({ id: "ing-bawang", name: "Bawang Merah", unit: "g", min_stock: 100 });

  // Insert dengan stok awal != 0 secara langsung -> ditolak
  assert.throws(() => {
    sim.insertIngredient({
      id: "ing-bypass",
      name: "Bahan Bypass",
      unit: "g",
      current_stock: 500,
    });
  }, /Stok awal bahan baku wajib 0/);

  // Direct UPDATE dari authenticated/anon -> ditolak grant
  assert.throws(() => sim.directUpdateIngredientStock("authenticated", "ing-bawang", 999), /permission denied/);
  assert.throws(() => sim.directUpdateIngredientStock("anon", "ing-bawang", 999), /permission denied/);

  // Direct UPDATE dari service_role tanpa RPC -> ditolak guard trigger!
  assert.throws(() => sim.directUpdateIngredientStock("service_role", "ing-bawang", 999), /dilarang/);
});

runTest("13. Audit log lengkap untuk penyesuaian manual dan pengurangan penjualan", () => {
  const sim = createInventoryDbSimulator();
  sim.insertIngredient({ id: "ing-teh", name: "Daun Teh", unit: "g", min_stock: 50 });
  sim.adjustIngredientStockAtomic({
    authUid: "adm-1",
    ingredientId: "ing-teh",
    movementType: "manual_in",
    quantity: 100,
    reason: "Pembelian daun teh baru",
  });
  sim.addRecipe({ product_id: "prod-teh", ingredient_id: "ing-teh", quantity_required: 10 });
  sim.db.orders.set("ord-13", {
    id: "ord-13",
    order_number: "ORD-20261119-0013",
    status: "awaiting_payment",
    payment_status: "unpaid",
    created_by: "ksr-1",
  });
  sim.db.orderItems.push({ order_id: "ord-13", product_id: "prod-teh", quantity: 6 });
  sim.updateOrderPaymentStatus("ord-13", "paid", "paid");

  const adjAudit = sim.db.auditLogs.find((a) => a.action === "inventory.stock_adjusted");
  const saleAudit = sim.db.auditLogs.find((a) => a.action === "inventory.sale_deducted");
  assert.ok(adjAudit && adjAudit.username === "admin" && adjAudit.details.reason === "Pembelian daun teh baru");
  assert.ok(
    saleAudit &&
      saleAudit.entity_id === "ord-13" &&
      saleAudit.details.deducted_count === 1 &&
      saleAudit.details.low_stock_ingredient_ids.includes("ing-teh"),
  );
});

runTest("14. Audit Kontrak SQL & Keamanan Statis pada 20261119000100_f4_inventory_stock.sql", () => {
  // 1. Tiga tabel wajib dibuat
  assert.match(migrationSql, /create table if not exists public\.ingredients\b/i);
  assert.match(migrationSql, /create table if not exists public\.recipes\b/i);
  assert.match(migrationSql, /create table if not exists public\.stock_movements\b/i);

  // 2. Constraint integritas & anti-konflik ON DELETE RESTRICT
  assert.match(migrationSql, /order_id uuid references public\.orders \(id\) on delete restrict/i);
  assert.match(migrationSql, /ingredient_id uuid not null references public\.ingredients \(id\) on delete restrict/i);
  assert.match(migrationSql, /stock_after = \(stock_before \+ quantity_delta\)/i);
  assert.match(migrationSql, /movement_type in \('sale_deduction', 'manual_in', 'manual_out', 'stock_opname'\)/i);

  // 3. Partial unique index anti-double-deduction & idempotency
  assert.match(
    migrationSql,
    /create unique index if not exists stock_movements_sale_order_ingredient_unique_idx/i,
  );
  assert.match(
    migrationSql,
    /create unique index if not exists stock_movements_idempotency_key_unique_idx/i,
  );

  // 4. RLS aktif & hanya admin untuk SELECT; tidak ada izin tulis langsung untuk authenticated/anon
  for (const tbl of ["ingredients", "recipes", "stock_movements"]) {
    assert.ok(
      migrationSql.includes(`alter table public.${tbl} enable row level security;`),
      `RLS harus aktif pada ${tbl}`,
    );
    assert.ok(
      migrationSql.includes(`revoke all on public.${tbl} from public, anon;`),
      `Akses public/anon harus dicabut pada ${tbl}`,
    );
    assert.ok(
      migrationSql.includes(`revoke insert, update, delete, truncate on public.${tbl} from authenticated;`),
      `Izin mutasi langsung authenticated harus dicabut pada ${tbl}`,
    );
  }
  assert.match(migrationSql, /using \(public\.is_admin\(\)\)/i);

  // 5. Semua fungsi SECURITY DEFINER menggunakan set search_path = public, pg_temp
  const secDefCount = (migrationSql.match(/security definer/gi) || []).length;
  const searchPathCount = (migrationSql.match(/set search_path = public, pg_temp/gi) || []).length;
  assert.equal(secDefCount, 4, "Harus ada tepat 4 fungsi SECURITY DEFINER");
  assert.equal(searchPathCount, secDefCount, "Setiap fungsi SECURITY DEFINER wajib set search_path = public, pg_temp");

  // 6. Least-privilege grants pada adjust_ingredient_stock_atomic & fungsi internal
  assert.ok(
    migrationSql.includes(
      "revoke all on function public.adjust_ingredient_stock_atomic(uuid, text, numeric, text, text) from service_role;",
    ),
  );
  assert.ok(
    migrationSql.includes(
      "grant execute on function public.adjust_ingredient_stock_atomic(uuid, text, numeric, text, text) to authenticated;",
    ),
  );
  assert.ok(
    migrationSql.includes("revoke all on function public.deduct_order_stock_internal(uuid) from authenticated;"),
  );

  // 7. Proteksi current_stock reset GUC kembali ke 'off' setelah update
  assert.ok(migrationSql.includes("perform set_config('nine_licious.allow_stock_mutation', 'on', true);"));
  assert.ok(migrationSql.includes("perform set_config('nine_licious.allow_stock_mutation', 'off', true);"));

  // 8. Penguncian deterministik & insert-first anti-double-deduction & subtransaksi fail-safe
  assert.ok(migrationSql.includes("order by r.ingredient_id asc"));
  assert.ok(migrationSql.includes("on conflict (order_id, ingredient_id)"));
  assert.ok(migrationSql.includes("do nothing"));
  assert.ok(migrationSql.includes("returning id into v_inserted_id"));
  assert.ok(migrationSql.includes("when (old.payment_status is distinct from 'paid' and new.payment_status = 'paid')"));
  assert.ok(migrationSql.includes("when others then"));

  // 9. Tidak ada seed/demo data stok dan tidak mengubah tabel/fungsi F0–F3
  assert.ok(
    !/insert into public\.(ingredients|recipes|orders|payments|dining_tables|products)/i.test(
      migrationSql,
    ),
    "Migrasi F4.1 dilarang memasukkan data contoh/demo",
  );
  assert.ok(
    !/alter table public\.(orders|payments|refunds|dining_sessions|dining_tables|products)/i.test(
      migrationSql,
    ),
    "Migrasi F4.1 tidak boleh mengubah struktur tabel F0–F3",
  );
});

console.log(`\nRingkasan F4.1: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
