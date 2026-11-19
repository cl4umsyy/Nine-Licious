"use server";

import { revalidatePath } from "next/cache";
import { logAudit } from "@/lib/auth/audit";
import {
  getAdminActor,
  type AuthenticatedSession,
} from "@/lib/auth/session";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  aggregateIngredientUsageReport,
  buildLowStockAlerts,
  roundQuantity3,
} from "./calculations";
import type {
  IngredientUnit,
  ManualStockMovementType,
  StockMovementType,
} from "./constants";
import type {
  Ingredient,
  IngredientUsageReportData,
  InventoryActionResult,
  LinkedProductRecipeInfo,
  RecipeItem,
  StockAdjustmentResultData,
  StockMovement,
} from "./types";
import {
  adjustIngredientStockSchema,
  createIngredientSchema,
  deleteRecipeLineSchema,
  fieldErrorsFrom,
  firstZodError,
  saveProductRecipeSchema,
  toggleIngredientActiveSchema,
  updateIngredientSchema,
  usageReportFilterSchema,
  type AdjustIngredientStockInput,
  type CreateIngredientInput,
  type DeleteRecipeLineInput,
  type SaveProductRecipeInput,
  type ToggleIngredientActiveInput,
  type UpdateIngredientInput,
  type UsageReportFilterInput,
} from "./validation";

type RawIngredientRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: IngredientUnit;
  current_stock: number | string;
  reserved_stock?: number | string | null;
  min_stock: number | string;
  is_active: boolean;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type RawRecipeRow = {
  id: string;
  product_id: string;
  ingredient_id: string;
  quantity_required: number | string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type RawStockMovementRow = {
  id: string;
  ingredient_id: string;
  movement_type: StockMovementType;
  quantity_delta: number | string;
  stock_before: number | string;
  stock_after: number | string;
  order_id: string | null;
  reason: string;
  idempotency_key: string | null;
  created_by: string | null;
  created_at: string;
};

type SupabaseErrorLike = {
  code?: string | null;
  message: string;
  details?: string | null;
};

function normalizeIngredient(row: RawIngredientRow): Ingredient {
  const currentStock = roundQuantity3(row.current_stock);
  const reservedStock = roundQuantity3(row.reserved_stock ?? 0);
  const availableStock = Math.max(0, roundQuantity3(currentStock - reservedStock));

  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    unit: row.unit,
    current_stock: currentStock,
    reserved_stock: reservedStock,
    available_stock: availableStock,
    min_stock: roundQuantity3(row.min_stock),
    is_active: row.is_active,
    notes: row.notes,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeRecipeItem(row: RawRecipeRow): RecipeItem {
  return {
    id: row.id,
    product_id: row.product_id,
    ingredient_id: row.ingredient_id,
    quantity_required: roundQuantity3(row.quantity_required),
    notes: row.notes,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeStockMovement(row: RawStockMovementRow): StockMovement {
  return {
    id: row.id,
    ingredient_id: row.ingredient_id,
    movement_type: row.movement_type,
    quantity_delta: roundQuantity3(row.quantity_delta),
    stock_before: roundQuantity3(row.stock_before),
    stock_after: roundQuantity3(row.stock_after),
    order_id: row.order_id,
    reason: row.reason,
    idempotency_key: row.idempotency_key,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

function revalidateInventoryPaths(): void {
  revalidatePath("/admin/inventory");
  revalidatePath("/admin");
}

async function writeInventoryAudit(
  actor: AuthenticatedSession,
  action: string,
  entity: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await logAudit({
    action,
    userId: actor.user.id,
    username: actor.profile.username,
    entity,
    entityId,
    details: {
      ...details,
      actor_role: actor.profile.role,
    },
  });
}

function mapInventoryDbError<T = undefined>(
  error: SupabaseErrorLike,
  contextLabel: string,
): InventoryActionResult<T> {
  const code = (error.code ?? "").trim();
  const msg = error.message ?? "";

  if (
    code === "PGRST205" ||
    code === "42P01" ||
    msg.includes("Could not find the table") ||
    msg.includes("does not exist")
  ) {
    return {
      ok: false,
      code: "MIGRATION_REQUIRED",
      message:
        "Tabel inventori F4 belum tersedia di database. Pastikan migrasi F4.1 (20261119000100_f4_inventory_stock.sql) sudah dijalankan di Supabase.",
    };
  }

  if (
    code === "PGRST202" ||
    code === "42883" ||
    msg.includes("Could not find the function")
  ) {
    return {
      ok: false,
      code: "MIGRATION_REQUIRED",
      message:
        "Fungsi RPC inventori F4 belum tersedia di database. Pastikan migrasi F4.1 (20261119000100_f4_inventory_stock.sql) sudah dijalankan di Supabase.",
    };
  }

  if (code === "42501") {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      message:
        "Akses ditolak. Hanya admin aktif yang berhak mengakses atau mengubah data stok dan resep.",
    };
  }

  if (code === "23505") {
    if (msg.includes("ingredients_active_name_unique_idx")) {
      const duplicateMsg =
        "Nama bahan baku aktif sudah digunakan. Gunakan nama lain atau perbarui bahan yang sudah ada.";
      return {
        ok: false,
        code: "DUPLICATE",
        message: duplicateMsg,
        fieldErrors: { name: duplicateMsg },
      };
    }

    if (msg.includes("ingredients_sku_unique_idx")) {
      const duplicateMsg = "SKU bahan baku sudah digunakan oleh bahan lain.";
      return {
        ok: false,
        code: "DUPLICATE",
        message: duplicateMsg,
        fieldErrors: { sku: duplicateMsg },
      };
    }

    if (msg.includes("recipes_product_ingredient_unique")) {
      return {
        ok: false,
        code: "DUPLICATE",
        message:
          "Bahan baku yang sama tidak boleh ditambahkan lebih dari sekali pada satu resep produk.",
      };
    }

    if (msg.includes("stock_movements_idempotency_key_unique_idx")) {
      return {
        ok: false,
        code: "DUPLICATE",
        message:
          "Permintaan penyesuaian stok dengan kunci idempotensi ini sudah pernah diproses.",
      };
    }

    return {
      ok: false,
      code: "DUPLICATE",
      message: `Data ${contextLabel} sudah digunakan.`,
    };
  }

  if (code === "23503") {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: `Data ${contextLabel} masih terhubung dengan resep atau riwayat mutasi stok dan tidak dapat dihapus permanen.`,
    };
  }

  if (code === "23514") {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: `Data ${contextLabel} tidak memenuhi aturan validasi database. Periksa kembali input Anda.`,
    };
  }

  if (code === "P0001") {
    // Pesan error bisnis eksplisit dari RAISE EXCEPTION di RPC / trigger F4.1
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: msg || `Gagal memproses ${contextLabel}.`,
    };
  }

  console.error(`[inventory] Gagal ${contextLabel}:`, {
    code,
    message: msg,
  });

  return {
    ok: false,
    code: "DATABASE_ERROR",
    message: `Terjadi kendala saat memproses ${contextLabel}. Silakan coba kembali.`,
  };
}

/**
 * 1. Membuat master bahan baku baru (Khusus Admin).
 * Stok awal selalu 0 (dijaga oleh skema Zod & trigger database F4.1);
 * penambahan stok awal wajib dilakukan lewat `adjustIngredientStockAction`.
 */
export async function createIngredientAction(
  input: CreateIngredientInput,
): Promise<InventoryActionResult<Ingredient>> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, code: "UNAUTHORIZED", message: actor.message };
  }

  const parsed = createIngredientSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const adminClient = createSupabaseAdminClient();
  if (!adminClient) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Koneksi database admin tidak tersedia.",
    };
  }

  const { name, sku, unit, minStock, notes } = parsed.data;

  const { data, error } = await adminClient
    .from("ingredients")
    .insert({
      name,
      sku,
      unit,
      current_stock: 0,
      min_stock: minStock,
      is_active: true,
      notes,
      created_by: actor.session.user.id,
    })
    .select("*")
    .single<RawIngredientRow>();

  if (error || !data) {
    return mapInventoryDbError(
      error ?? { message: "Insert bahan baku gagal." },
      "pembuatan bahan baku",
    );
  }

  const ingredient = normalizeIngredient(data);

  await writeInventoryAudit(
    actor.session,
    "inventory.ingredient_created",
    "ingredient",
    ingredient.id,
    {
      name: ingredient.name,
      sku: ingredient.sku,
      unit: ingredient.unit,
      min_stock: ingredient.min_stock,
      notes: ingredient.notes,
    },
  );

  revalidateInventoryPaths();

  return {
    ok: true,
    message: `Bahan baku "${ingredient.name}" berhasil ditambahkan.`,
    data: ingredient,
  };
}

/**
 * 2. Memperbarui metadata bahan baku (Khusus Admin).
 * TIDAK pernah mengubah `current_stock` secara langsung.
 */
export async function updateIngredientAction(
  input: UpdateIngredientInput,
): Promise<InventoryActionResult<Ingredient>> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, code: "UNAUTHORIZED", message: actor.message };
  }

  const parsed = updateIngredientSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const adminClient = createSupabaseAdminClient();
  if (!adminClient) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Koneksi database admin tidak tersedia.",
    };
  }

  const { ingredientId, name, sku, unit, minStock, notes } = parsed.data;

  const { data: existing, error: fetchErr } = await adminClient
    .from("ingredients")
    .select("*")
    .eq("id", ingredientId)
    .maybeSingle<RawIngredientRow>();

  if (fetchErr) {
    return mapInventoryDbError(fetchErr, "pemeriksaan bahan baku");
  }

  if (!existing) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "Bahan baku tidak ditemukan.",
    };
  }

  const { data: updated, error: updateErr } = await adminClient
    .from("ingredients")
    .update({
      name,
      sku,
      unit,
      min_stock: minStock,
      notes,
    })
    .eq("id", ingredientId)
    .select("*")
    .single<RawIngredientRow>();

  if (updateErr || !updated) {
    return mapInventoryDbError(
      updateErr ?? { message: "Pembaruan bahan baku gagal." },
      "pembaruan bahan baku",
    );
  }

  const ingredient = normalizeIngredient(updated);

  await writeInventoryAudit(
    actor.session,
    "inventory.ingredient_updated",
    "ingredient",
    ingredient.id,
    {
      before: {
        name: existing.name,
        sku: existing.sku,
        unit: existing.unit,
        min_stock: roundQuantity3(existing.min_stock),
        notes: existing.notes,
      },
      after: {
        name: ingredient.name,
        sku: ingredient.sku,
        unit: ingredient.unit,
        min_stock: ingredient.min_stock,
        notes: ingredient.notes,
      },
    },
  );

  revalidateInventoryPaths();

  return {
    ok: true,
    message: `Bahan baku "${ingredient.name}" berhasil diperbarui.`,
    data: ingredient,
  };
}

/**
 * 3. Mengarsipkan (soft archive) atau mengaktifkan kembali bahan baku (Khusus Admin).
 * - Tidak pernah menghapus riwayat `recipes` maupun `stock_movements`.
 * - Sebelum mengarsipkan, selalu memeriksa dan mengembalikan daftar produk yang masih
 *   menggunakan bahan baku tersebut; jika ada produk terhubung dan belum dikonfirmasi,
 *   mengembalikan kode `INGREDIENT_IN_USE_REQUIRES_CONFIRMATION` beserta daftar produknya.
 */
export async function toggleIngredientActiveAction(
  input: ToggleIngredientActiveInput,
): Promise<
  InventoryActionResult<{
    ingredient: Ingredient;
    linkedProducts: LinkedProductRecipeInfo[];
  }>
> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, code: "UNAUTHORIZED", message: actor.message };
  }

  const parsed = toggleIngredientActiveSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const adminClient = createSupabaseAdminClient();
  if (!adminClient) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Koneksi database admin tidak tersedia.",
    };
  }

  const { ingredientId, isActive, confirmArchiveWithActiveRecipes } =
    parsed.data;

  const { data: existing, error: fetchErr } = await adminClient
    .from("ingredients")
    .select("*")
    .eq("id", ingredientId)
    .maybeSingle<RawIngredientRow>();

  if (fetchErr) {
    return mapInventoryDbError(fetchErr, "pemeriksaan bahan baku");
  }

  if (!existing) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "Bahan baku tidak ditemukan.",
    };
  }

  // Ambil daftar produk yang masih memakai bahan ini di tabel recipes
  const { data: recipeRows, error: recipeErr } = await adminClient
    .from("recipes")
    .select("id, product_id, quantity_required")
    .eq("ingredient_id", ingredientId);

  if (recipeErr) {
    return mapInventoryDbError(recipeErr, "pemeriksaan resep terkait");
  }

  const rawRecipes = (recipeRows ?? []) as Array<{
    id: string;
    product_id: string;
    quantity_required: number | string;
  }>;

  const productIds = Array.from(new Set(rawRecipes.map((r) => r.product_id)));
  const productMap = new Map<string, { name: string; is_active: boolean }>();

  if (productIds.length > 0) {
    const { data: prodRows, error: prodErr } = await adminClient
      .from("products")
      .select("id, name, is_active")
      .in("id", productIds);

    if (prodErr) {
      return mapInventoryDbError(prodErr, "pemeriksaan produk terkait");
    }

    for (const p of (prodRows ?? []) as Array<{
      id: string;
      name: string;
      is_active: boolean;
    }>) {
      productMap.set(p.id, { name: p.name, is_active: p.is_active });
    }
  }

  const linkedProducts: LinkedProductRecipeInfo[] = rawRecipes
    .map((r) => {
      const prod = productMap.get(r.product_id);
      return {
        recipe_id: r.id,
        product_id: r.product_id,
        product_name: prod?.name ?? "Produk tidak diketahui",
        product_is_active: prod?.is_active ?? false,
        quantity_required: roundQuantity3(r.quantity_required),
      };
    })
    .sort((a, b) => a.product_name.localeCompare(b.product_name, "id-ID"));

  const currentIngredient = normalizeIngredient(existing);

  if (existing.is_active === isActive) {
    return {
      ok: true,
      message: isActive
        ? `Bahan baku "${currentIngredient.name}" sudah dalam status aktif.`
        : `Bahan baku "${currentIngredient.name}" sudah dalam status diarsipkan.`,
      data: {
        ingredient: currentIngredient,
        linkedProducts,
      },
    };
  }

  // Sebelum mengarsipkan bahan yang masih dipakai resep, informasikan daftar produk terkait
  if (!isActive && linkedProducts.length > 0 && !confirmArchiveWithActiveRecipes) {
    const previewNames = linkedProducts
      .slice(0, 3)
      .map((p) => p.product_name)
      .join(", ");
    const extraCount =
      linkedProducts.length > 3 ? ` dan ${linkedProducts.length - 3} produk lainnya` : "";

    return {
      ok: false,
      code: "INGREDIENT_IN_USE_REQUIRES_CONFIRMATION",
      message: `Bahan baku "${currentIngredient.name}" masih digunakan pada ${linkedProducts.length} resep produk (${previewNames}${extraCount}). Konfirmasi pengarsipan jika Anda yakin ingin menonaktifkannya (riwayat resep dan mutasi stok tetap tersimpan).`,
      data: {
        ingredient: currentIngredient,
        linkedProducts,
      },
    };
  }

  const { data: updated, error: updateErr } = await adminClient
    .from("ingredients")
    .update({ is_active: isActive })
    .eq("id", ingredientId)
    .select("*")
    .single<RawIngredientRow>();

  if (updateErr || !updated) {
    return mapInventoryDbError(
      updateErr ?? { message: "Perubahan status bahan baku gagal." },
      "perubahan status bahan baku",
    );
  }

  const ingredient = normalizeIngredient(updated);

  await writeInventoryAudit(
    actor.session,
    isActive
      ? "inventory.ingredient_reactivated"
      : "inventory.ingredient_archived",
    "ingredient",
    ingredient.id,
    {
      ingredient_name: ingredient.name,
      is_active_before: existing.is_active,
      is_active_after: ingredient.is_active,
      linked_product_count: linkedProducts.length,
      linked_products: linkedProducts.map((p) => ({
        product_id: p.product_id,
        product_name: p.product_name,
      })),
    },
  );

  revalidateInventoryPaths();

  return {
    ok: true,
    message: isActive
      ? `Bahan baku "${ingredient.name}" berhasil diaktifkan kembali.`
      : `Bahan baku "${ingredient.name}" berhasil diarsipkan. Riwayat resep dan mutasi stok tetap dipertahankan.`,
    data: {
      ingredient,
      linkedProducts,
    },
  };
}

/**
 * 4. Menyimpan komposisi resep produk (Khusus Admin).
 * - Bahan baku nonaktif DILARANG ditambahkan ke resep baru.
 * - Baris resep lama yang sudah ada dipertahankan ID & riwayatnya jika tetap ada;
 *   penghapusan atau pembaruan dilakukan secara selektif tanpa menyentuh `stock_movements`.
 */
export async function saveProductRecipeAction(
  input: SaveProductRecipeInput,
): Promise<InventoryActionResult<{ productId: string; items: RecipeItem[] }>> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, code: "UNAUTHORIZED", message: actor.message };
  }

  const parsed = saveProductRecipeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const adminClient = createSupabaseAdminClient();
  if (!adminClient) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Koneksi database admin tidak tersedia.",
    };
  }

  const { productId, items } = parsed.data;

  // 1. Pastikan produk ada di tabel products (F1.1)
  const { data: product, error: prodErr } = await adminClient
    .from("products")
    .select("id, name, is_active")
    .eq("id", productId)
    .maybeSingle<{ id: string; name: string; is_active: boolean }>();

  if (prodErr) {
    return mapInventoryDbError(prodErr, "pemeriksaan produk");
  }

  if (!product) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "Produk tidak ditemukan.",
    };
  }

  // 2. Ambil baris resep lama untuk membedakan bahan baru vs bahan lama yang sudah tersimpan
  const { data: existingRows, error: existingErr } = await adminClient
    .from("recipes")
    .select("*")
    .eq("product_id", productId);

  if (existingErr) {
    return mapInventoryDbError(existingErr, "pemeriksaan resep lama");
  }

  const existingRecipes = (existingRows ?? []) as RawRecipeRow[];
  const existingByIngredient = new Map<string, RawRecipeRow>(
    existingRecipes.map((r) => [r.ingredient_id, r]),
  );

  // 3. Verifikasi seluruh ingredient_id ada & bahan nonaktif tidak ditambahkan sebagai item baru
  const requestedIngredientIds = items.map((item) => item.ingredientId);
  if (requestedIngredientIds.length > 0) {
    const { data: ingRows, error: ingErr } = await adminClient
      .from("ingredients")
      .select("id, name, is_active")
      .in("id", requestedIngredientIds);

    if (ingErr) {
      return mapInventoryDbError(ingErr, "verifikasi bahan baku resep");
    }

    const ingMap = new Map<string, { id: string; name: string; is_active: boolean }>(
      ((ingRows ?? []) as Array<{ id: string; name: string; is_active: boolean }>).map(
        (ing) => [ing.id, ing],
      ),
    );

    for (const item of items) {
      const ing = ingMap.get(item.ingredientId);
      if (!ing) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: "Salah satu bahan baku yang dipilih tidak ditemukan.",
        };
      }

      const isAlreadyInRecipe = existingByIngredient.has(item.ingredientId);
      if (!ing.is_active && !isAlreadyInRecipe) {
        return {
          ok: false,
          code: "INACTIVE_INGREDIENT",
          message: `Bahan baku "${ing.name}" sedang nonaktif (diarsipkan) dan tidak boleh ditambahkan ke resep baru.`,
        };
      }
    }
  }

  // 4. Hitung diff: hapus baris yang dilepas, perbarui yang berubah, tambah yang baru
  const requestedSet = new Set(requestedIngredientIds);
  const toDeleteIds = existingRecipes
    .filter((r) => !requestedSet.has(r.ingredient_id))
    .map((r) => r.id);

  if (toDeleteIds.length > 0) {
    const { error: delErr } = await adminClient
      .from("recipes")
      .delete()
      .in("id", toDeleteIds);

    if (delErr) {
      return mapInventoryDbError(delErr, "penghapusan baris resep lama");
    }
  }

  for (const item of items) {
    const existing = existingByIngredient.get(item.ingredientId);

    if (existing) {
      const existingQty = roundQuantity3(existing.quantity_required);
      const existingNotes = existing.notes ?? null;
      if (existingQty !== item.quantityRequired || existingNotes !== item.notes) {
        const { error: updErr } = await adminClient
          .from("recipes")
          .update({
            quantity_required: item.quantityRequired,
            notes: item.notes,
          })
          .eq("id", existing.id);

        if (updErr) {
          return mapInventoryDbError(updErr, "pembaruan baris resep");
        }
      }
    } else {
      const { error: insErr } = await adminClient.from("recipes").insert({
        product_id: productId,
        ingredient_id: item.ingredientId,
        quantity_required: item.quantityRequired,
        notes: item.notes,
        created_by: actor.session.user.id,
      });

      if (insErr) {
        return mapInventoryDbError(insErr, "penambahan baris resep");
      }
    }
  }

  // 5. Muat ulang resep akhir untuk dikembalikan & dicatat ke audit_logs
  const { data: finalRows, error: finalErr } = await adminClient
    .from("recipes")
    .select("*")
    .eq("product_id", productId)
    .order("created_at", { ascending: true });

  if (finalErr) {
    return mapInventoryDbError(finalErr, "pembacaan resep akhir");
  }

  const finalItems = ((finalRows ?? []) as RawRecipeRow[]).map(normalizeRecipeItem);

  await writeInventoryAudit(
    actor.session,
    "inventory.recipe_saved",
    "product",
    product.id,
    {
      product_name: product.name,
      previous_line_count: existingRecipes.length,
      new_line_count: finalItems.length,
      items: finalItems.map((line) => ({
        ingredient_id: line.ingredient_id,
        quantity_required: line.quantity_required,
      })),
    },
  );

  revalidateInventoryPaths();

  return {
    ok: true,
    message: `Resep untuk produk "${product.name}" berhasil disimpan (${finalItems.length} bahan).`,
    data: {
      productId: product.id,
      items: finalItems,
    },
  };
}

/**
 * 5. Menghapus satu baris bahan dari resep produk (Khusus Admin).
 * Tidak pernah menghapus `ingredients` maupun `stock_movements`.
 */
export async function deleteRecipeLineAction(
  input: DeleteRecipeLineInput,
): Promise<InventoryActionResult<{ deletedRecipeId: string; productId: string }>> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, code: "UNAUTHORIZED", message: actor.message };
  }

  const parsed = deleteRecipeLineSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const adminClient = createSupabaseAdminClient();
  if (!adminClient) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Koneksi database admin tidak tersedia.",
    };
  }

  const { recipeId } = parsed.data;

  const { data: existing, error: fetchErr } = await adminClient
    .from("recipes")
    .select("*")
    .eq("id", recipeId)
    .maybeSingle<RawRecipeRow>();

  if (fetchErr) {
    return mapInventoryDbError(fetchErr, "pemeriksaan baris resep");
  }

  if (!existing) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "Baris resep tidak ditemukan.",
    };
  }

  const { error: delErr } = await adminClient
    .from("recipes")
    .delete()
    .eq("id", recipeId);

  if (delErr) {
    return mapInventoryDbError(delErr, "penghapusan baris resep");
  }

  await writeInventoryAudit(
    actor.session,
    "inventory.recipe_line_deleted",
    "recipe",
    existing.id,
    {
      product_id: existing.product_id,
      ingredient_id: existing.ingredient_id,
      quantity_required: roundQuantity3(existing.quantity_required),
    },
  );

  revalidateInventoryPaths();

  return {
    ok: true,
    message: "Bahan berhasil dihapus dari resep produk.",
    data: {
      deletedRecipeId: existing.id,
      productId: existing.product_id,
    },
  };
}

/**
 * 6. Penyesuaian stok manual atomik (Khusus Admin):
 *    - manual_in (restock / pengembalian manual pasca refund)
 *    - manual_out (waste / rusak / tumpah)
 *    - stock_opname (penyetelan ke stok hitung fisik aktual)
 *
 * Keamanan:
 * - Memanggil RPC `adjust_ingredient_stock_atomic` menggunakan `createSupabaseServerClient()`
 *   (konteks JWT authenticated, BUKAN service_role), sehingga otorisasi diverifikasi ganda:
 *   Next.js `getAdminActor()` + PostgreSQL `auth.uid()` + `profiles.role = 'admin'`.
 * - Tidak pernah mengubah `ingredients.current_stock` secara langsung.
 * - Audit log `inventory.stock_adjusted` & buku besar `stock_movements` ditulis atomik di RPC.
 */
export async function adjustIngredientStockAction(
  input: AdjustIngredientStockInput,
): Promise<InventoryActionResult<StockAdjustmentResultData>> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, code: "UNAUTHORIZED", message: actor.message };
  }

  const parsed = adjustIngredientStockSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Klien database sesi tidak tersedia.",
    };
  }

  const { ingredientId, movementType, quantity, reason, idempotencyKey } =
    parsed.data;

  const { data, error } = await supabase.rpc("adjust_ingredient_stock_atomic", {
    p_ingredient_id: ingredientId,
    p_movement_type: movementType,
    p_quantity: quantity,
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    return mapInventoryDbError(error, "penyesuaian stok bahan baku");
  }

  const rpcResult = data as Record<string, unknown> | null;
  if (!rpcResult || typeof rpcResult.movement_id !== "string") {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Respons penyesuaian stok dari database tidak valid.",
    };
  }

  const normalized: StockAdjustmentResultData = {
    movement_id: String(rpcResult.movement_id),
    ingredient_id: String(rpcResult.ingredient_id),
    ingredient_name: String(rpcResult.ingredient_name ?? ""),
    unit: rpcResult.unit as IngredientUnit,
    movement_type: rpcResult.movement_type as ManualStockMovementType,
    quantity_delta: roundQuantity3(rpcResult.quantity_delta as number | string),
    stock_before: roundQuantity3(rpcResult.stock_before as number | string),
    stock_after: roundQuantity3(rpcResult.stock_after as number | string),
    reserved_stock: roundQuantity3(
      (rpcResult.reserved_stock as number | string) ?? 0,
    ),
    available_stock: roundQuantity3(
      (rpcResult.available_stock as number | string) ??
        Math.max(
          0,
          roundQuantity3(rpcResult.stock_after as number | string) -
            roundQuantity3((rpcResult.reserved_stock as number | string) ?? 0),
        ),
    ),
    min_stock: roundQuantity3(rpcResult.min_stock as number | string),
    is_low_stock: Boolean(rpcResult.is_low_stock),
    reason: String(rpcResult.reason ?? reason),
    idempotent_replay: Boolean(rpcResult.idempotent_replay),
    created_at: String(rpcResult.created_at ?? new Date().toISOString()),
  };

  revalidateInventoryPaths();

  return {
    ok: true,
    message: normalized.idempotent_replay
      ? `Penyesuaian stok "${normalized.ingredient_name}" sudah tercatat sebelumnya (idempoten).`
      : `Stok "${normalized.ingredient_name}" berhasil disesuaikan menjadi ${normalized.stock_after} ${normalized.unit}.`,
    data: normalized,
  };
}

/**
 * 7. Mengambil laporan pemakaian bahan baku & riwayat mutasi stok (Khusus Admin).
 * Menggunakan `createSupabaseServerClient()` agar RLS `is_admin()` ikut menegakkan
 * isolasi akses terhadap kasir, kitchen, dan publik.
 */
export async function getIngredientUsageReportAction(
  input: UsageReportFilterInput,
): Promise<InventoryActionResult<IngredientUsageReportData>> {
  const actor = await getAdminActor();
  if (!actor.ok) {
    return { ok: false, code: "UNAUTHORIZED", message: actor.message };
  }

  const parsed = usageReportFilterSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Klien database sesi tidak tersedia.",
    };
  }

  const { startDate, endDate, ingredientId, movementType } = parsed.data;

  // Rentang hari operasional dalam zona waktu Asia/Jakarta (+07:00)
  const startIso = `${startDate}T00:00:00+07:00`;
  const endIso = `${endDate}T23:59:59.999+07:00`;

  let movementsQuery = supabase
    .from("stock_movements")
    .select("*")
    .gte("created_at", startIso)
    .lte("created_at", endIso)
    .order("created_at", { ascending: false });

  if (ingredientId) {
    movementsQuery = movementsQuery.eq("ingredient_id", ingredientId);
  }

  if (movementType) {
    movementsQuery = movementsQuery.eq("movement_type", movementType);
  }

  const [ingredientsRes, movementsRes] = await Promise.all([
    supabase
      .from("ingredients")
      .select("*")
      .order("name", { ascending: true }),
    movementsQuery,
  ]);

  if (ingredientsRes.error) {
    return mapInventoryDbError(
      ingredientsRes.error,
      "pembacaan daftar bahan baku",
    );
  }

  if (movementsRes.error) {
    return mapInventoryDbError(
      movementsRes.error,
      "pembacaan laporan mutasi stok",
    );
  }

  const ingredients = ((ingredientsRes.data ?? []) as RawIngredientRow[]).map(
    normalizeIngredient,
  );
  const ingredientsById = new Map<string, Ingredient>(
    ingredients.map((ing) => [ing.id, ing]),
  );

  const rawMovements = (movementsRes.data ?? []) as RawStockMovementRow[];

  // Perkaya riwayat mutasi dengan nomor pesanan dan username pelaku (read-only)
  const orderIds = Array.from(
    new Set(rawMovements.map((m) => m.order_id).filter(Boolean)),
  ) as string[];
  const actorIds = Array.from(
    new Set(rawMovements.map((m) => m.created_by).filter(Boolean)),
  ) as string[];

  const orderNumberMap = new Map<string, string>();
  const actorUsernameMap = new Map<string, string>();

  const enrichmentQueries: Promise<void>[] = [];

  if (orderIds.length > 0) {
    enrichmentQueries.push(
      Promise.resolve(
        supabase
          .from("orders")
          .select("id, order_number")
          .in("id", orderIds),
      ).then(({ data }) => {
        for (const ord of (data ?? []) as Array<{
          id: string;
          order_number: string;
        }>) {
          orderNumberMap.set(ord.id, ord.order_number);
        }
      }),
    );
  }

  if (actorIds.length > 0) {
    enrichmentQueries.push(
      Promise.resolve(
        supabase
          .from("profiles")
          .select("id, username")
          .in("id", actorIds),
      ).then(({ data }) => {
        for (const p of (data ?? []) as Array<{
          id: string;
          username: string;
        }>) {
          actorUsernameMap.set(p.id, p.username);
        }
      }),
    );
  }

  await Promise.all(enrichmentQueries);

  const movements: StockMovement[] = rawMovements.map((row) => {
    const base = normalizeStockMovement(row);
    const ing = ingredientsById.get(base.ingredient_id);
    return {
      ...base,
      ingredient_name: ing?.name,
      ingredient_unit: ing?.unit,
      order_number: base.order_id
        ? orderNumberMap.get(base.order_id) ?? null
        : null,
      actor_username: base.created_by
        ? actorUsernameMap.get(base.created_by) ?? null
        : null,
    };
  });

  const rows = aggregateIngredientUsageReport(movements, ingredientsById);
  const lowStockAlerts = buildLowStockAlerts(ingredients);

  return {
    ok: true,
    message: "Laporan pemakaian bahan baku berhasil dimuat.",
    data: {
      startDate,
      endDate,
      rows,
      movements,
      lowStockAlerts,
      totals: {
        totalMovements: movements.length,
        totalIngredientsTracked: ingredients.filter((i) => i.is_active).length,
        totalLowStockCount: lowStockAlerts.filter((a) => a.status === "low_stock")
          .length,
        totalOutOfStockCount: lowStockAlerts.filter(
          (a) => a.status === "out_of_stock",
        ).length,
      },
    },
  };
}
