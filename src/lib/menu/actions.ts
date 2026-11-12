"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { logAudit } from "@/lib/auth/audit";
import {
  getAdminActor,
  type AuthenticatedSession,
} from "@/lib/auth/session";
import {
  PRODUCT_PHOTO_ALLOWED_TYPES,
  PRODUCT_PHOTO_BUCKET,
  PRODUCT_PHOTO_MAX_BYTES,
} from "@/lib/menu/constants";
import { slugify } from "@/lib/menu/format";
import {
  categorySchema,
  fieldErrorsFrom,
  firstZodError,
  formBoolean,
  menuIdSchema,
  modifierGroupSchema,
  modifierOptionSchema,
  productSchema,
} from "@/lib/menu/validation";
import type { MenuActionState } from "@/lib/menu/action-types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type ActionContext = {
  actor: AuthenticatedSession;
  supabase: SupabaseClient;
};

type CategoryRow = {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  sort_order: number;
  is_active: boolean;
};

type ProductRow = {
  id: string;
  name: string;
  photo_path: string | null;
  photo_url: string | null;
};

type ModifierGroupRow = {
  id: string;
  name: string;
  selection_type: string;
  is_required: boolean;
  min_select: number;
  max_select: number;
  sort_order: number;
  is_active: boolean;
};

type ModifierGroupWithOptions = ModifierGroupRow & {
  modifier_options: Array<{ id: string; is_active: boolean }> | null;
};

type ModifierOptionRow = {
  id: string;
  group_id: string;
  name: string;
  is_active: boolean;
};

const productStatusFieldSchema = z.enum(["is_active", "is_available"]);

function errorState(
  message: string,
  fieldErrors?: Record<string, string>,
): MenuActionState {
  return { status: "error", message, fieldErrors };
}

function successState(message: string): MenuActionState {
  return { status: "success", message };
}

async function getActionContext(): Promise<
  { ok: true; context: ActionContext } | { ok: false; state: MenuActionState }
> {
  const actor = await getAdminActor();

  if (!actor.ok) {
    return { ok: false, state: errorState(actor.message) };
  }

  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    return {
      ok: false,
      state: errorState("Supabase belum dikonfigurasi."),
    };
  }

  return {
    ok: true,
    context: { actor: actor.session, supabase },
  };
}

function parseId(value: string): string | null {
  const parsed = menuIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function dbErrorState(
  error: { code?: string; message: string },
  entityLabel: string,
  duplicates: Array<{
    constraint: string;
    field: string;
    message: string;
  }> = [],
): MenuActionState {
  if (error.code === "23505") {
    const duplicate = duplicates.find((item) =>
      error.message.includes(item.constraint),
    );

    if (duplicate) {
      return errorState(duplicate.message, {
        [duplicate.field]: duplicate.message,
      });
    }

    return errorState(`Data ${entityLabel} sudah digunakan.`);
  }

  if (error.code === "23503") {
    return errorState(
      `${entityLabel} masih dipakai data lain dan tidak dapat dihapus.`,
    );
  }

  console.error(`[menu] Gagal memproses ${entityLabel}:`, error.message);

  return errorState(
    `Gagal memproses ${entityLabel}. Silakan coba lagi.`,
  );
}

async function writeAudit(
  context: ActionContext,
  action: string,
  entity: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await logAudit({
    action,
    userId: context.actor.user.id,
    username: context.actor.profile.username,
    entity,
    entityId,
    details,
  });
}

function isFileEntry(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "size" in value &&
    "type" in value
  );
}

function matchesImageSignature(
  bytes: Uint8Array,
  extension: string,
): boolean {
  if (extension === "jpg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  if (extension === "png") {
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }

  if (extension === "webp") {
    return (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }

  return false;
}

async function validateProductPhoto(
  file: File,
): Promise<
  | { ok: true; bytes: Uint8Array; extension: string }
  | { ok: false; message: string }
> {
  if (
    !(PRODUCT_PHOTO_ALLOWED_TYPES as readonly string[]).includes(file.type)
  ) {
    return {
      ok: false,
      message: "Foto harus berupa JPEG, PNG, atau WebP.",
    };
  }

  if (file.size > PRODUCT_PHOTO_MAX_BYTES) {
    return {
      ok: false,
      message: "Ukuran foto maksimal 5 MB.",
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const extension =
    file.type === "image/png"
      ? "png"
      : file.type === "image/webp"
        ? "webp"
        : "jpg";

  if (!matchesImageSignature(bytes, extension)) {
    return {
      ok: false,
      message: "Isi file foto tidak valid.",
    };
  }

  return { ok: true, bytes, extension };
}

async function removeStoredPhoto(path: string): Promise<void> {
  const admin = createSupabaseAdminClient();

  if (!admin) {
    return;
  }

  const { error } = await admin.storage
    .from(PRODUCT_PHOTO_BUCKET)
    .remove([path]);

  if (error) {
    console.error("[menu] Gagal menghapus foto produk:", error.message);
  }
}

async function countActiveOptions(groupId: string): Promise<number | null> {
  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    return null;
  }

  const { count, error } = await supabase
    .from("modifier_options")
    .select("id", { count: "exact", head: true })
    .eq("group_id", groupId)
    .eq("is_active", true);

  if (error) {
    console.error("[menu] Gagal menghitung opsi aktif:", error.message);
    return null;
  }

  return count ?? 0;
}

async function assertGroupHasEnoughOptions(
  groupId: string,
  minimum: number,
  excludedOptionId?: string,
): Promise<MenuActionState | null> {
  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    return errorState("Supabase belum dikonfigurasi.");
  }

  let query = supabase
    .from("modifier_options")
    .select("id", { count: "exact", head: true })
    .eq("group_id", groupId)
    .eq("is_active", true);

  if (excludedOptionId) {
    query = query.neq("id", excludedOptionId);
  }

  const { count, error } = await query;

  if (error) {
    console.error("[menu] Gagal memeriksa opsi aktif:", error.message);
    return errorState("Gagal memeriksa opsi modifier. Silakan coba lagi.");
  }

  if ((count ?? 0) < minimum) {
    return errorState(
      `Grup modifier wajib ini memerlukan minimal ${minimum} opsi aktif. Tambah opsi lain terlebih dahulu.`,
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Kategori
// ---------------------------------------------------------------------------

export async function saveCategoryAction(
  _previousState: MenuActionState,
  formData: FormData,
): Promise<MenuActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const { context } = contextResult;
  const idValue = String(formData.get("id") ?? "").trim();
  const categoryId = idValue ? parseId(idValue) : null;

  if (idValue && !categoryId) {
    return errorState("Kategori tidak valid.");
  }

  const name = String(formData.get("name") ?? "");
  const slugInput = String(formData.get("slug") ?? "").trim();
  const parsed = categorySchema.safeParse({
    name,
    slug: slugInput || slugify(name),
    color: String(formData.get("color") ?? ""),
    sortOrder: String(formData.get("sortOrder") ?? "0"),
    isActive: formBoolean(formData.get("isActive")),
  });

  if (!parsed.success) {
    return errorState(firstZodError(parsed.error), fieldErrorsFrom(parsed.error));
  }

  const payload = {
    name: parsed.data.name,
    slug: parsed.data.slug,
    color: parsed.data.color,
    sort_order: parsed.data.sortOrder,
    is_active: parsed.data.isActive,
  };
  const duplicates = [
    {
      constraint: "menu_categories_name_unique_idx",
      field: "name",
      message: "Nama kategori sudah digunakan.",
    },
    {
      constraint: "menu_categories_slug_unique_idx",
      field: "slug",
      message: "Slug kategori sudah digunakan.",
    },
  ];

  if (categoryId) {
    const { data, error } = await context.supabase
      .from("menu_categories")
      .update(payload)
      .eq("id", categoryId)
      .select("id, name, slug, color, sort_order, is_active")
      .maybeSingle<CategoryRow>();

    if (error) {
      return dbErrorState(error, "kategori", duplicates);
    }

    if (!data) {
      return errorState("Kategori tidak ditemukan atau sudah dihapus.");
    }

    await writeAudit(context, "menu.category.update", "menu_category", data.id, {
      name: data.name,
      slug: data.slug,
      color: data.color,
      sort_order: data.sort_order,
      is_active: data.is_active,
    });

    revalidatePath("/admin/menu");
    return successState(`Kategori ${data.name} berhasil diperbarui.`);
  }

  const { data, error } = await context.supabase
    .from("menu_categories")
    .insert(payload)
    .select("id, name, slug, color, sort_order, is_active")
    .single<CategoryRow>();

  if (error) {
    return dbErrorState(error, "kategori", duplicates);
  }

  await writeAudit(context, "menu.category.create", "menu_category", data.id, {
    name: data.name,
    slug: data.slug,
    color: data.color,
    sort_order: data.sort_order,
    is_active: data.is_active,
  });

  revalidatePath("/admin/menu");
  return successState(`Kategori ${data.name} berhasil dibuat.`);
}

export async function setCategoryActiveAction(
  categoryId: string,
  isActive: boolean,
): Promise<MenuActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(categoryId);

  if (!id || typeof isActive !== "boolean") {
    return errorState("Permintaan tidak valid.");
  }

  const { context } = contextResult;
  const { data, error } = await context.supabase
    .from("menu_categories")
    .update({ is_active: isActive })
    .eq("id", id)
    .select("id, name")
    .maybeSingle<{ id: string; name: string }>();

  if (error) {
    return dbErrorState(error, "status kategori");
  }

  if (!data) {
    return errorState("Kategori tidak ditemukan.");
  }

  await writeAudit(context, "menu.category.status", "menu_category", data.id, {
    name: data.name,
    is_active: isActive,
  });

  revalidatePath("/admin/menu");
  return successState(
    `Kategori ${data.name} ${isActive ? "diaktifkan" : "dinonaktifkan"}.`,
  );
}

export async function moveCategoryAction(
  categoryId: string,
  direction: "up" | "down",
): Promise<MenuActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(categoryId);

  if (!id || (direction !== "up" && direction !== "down")) {
    return errorState("Permintaan tidak valid.");
  }

  const { context } = contextResult;
  const { data, error } = await context.supabase
    .from("menu_categories")
    .select("id, name, sort_order")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    return dbErrorState(error, "urutan kategori");
  }

  const categories = (data ?? []) as Array<{
    id: string;
    name: string;
    sort_order: number;
  }>;
  const index = categories.findIndex((category) => category.id === id);

  if (index === -1) {
    return errorState("Kategori tidak ditemukan.");
  }

  const neighborIndex = direction === "up" ? index - 1 : index + 1;

  if (neighborIndex < 0 || neighborIndex >= categories.length) {
    return successState(
      `Kategori sudah berada di urutan paling ${direction === "up" ? "atas" : "bawah"}.`,
    );
  }

  const current = categories[index];
  const neighbor = categories[neighborIndex];
  let currentOrder = neighbor.sort_order;
  let neighborOrder = current.sort_order;

  if (currentOrder === neighborOrder) {
    currentOrder = (neighborIndex + 1) * 10;
    neighborOrder = (index + 1) * 10;
  }

  const { error: currentError } = await context.supabase
    .from("menu_categories")
    .update({ sort_order: currentOrder })
    .eq("id", current.id);

  if (currentError) {
    return dbErrorState(currentError, "urutan kategori");
  }

  const { error: neighborError } = await context.supabase
    .from("menu_categories")
    .update({ sort_order: neighborOrder })
    .eq("id", neighbor.id);

  if (neighborError) {
    return dbErrorState(neighborError, "urutan kategori");
  }

  await writeAudit(context, "menu.category.reorder", "menu_category", current.id, {
    name: current.name,
    direction,
    swapped_with: neighbor.name,
    sort_order: currentOrder,
  });

  revalidatePath("/admin/menu");
  return successState(`Urutan kategori ${current.name} diperbarui.`);
}

export async function deleteCategoryAction(
  categoryId: string,
): Promise<MenuActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(categoryId);

  if (!id) {
    return errorState("Kategori tidak valid.");
  }

  const { context } = contextResult;
  const { count, error: countError } = await context.supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("category_id", id);

  if (countError) {
    return dbErrorState(countError, "kategori");
  }

  if ((count ?? 0) > 0) {
    return errorState(
      `Kategori masih memiliki ${count} produk. Pindahkan atau hapus produk terlebih dahulu.`,
    );
  }

  const { data, error } = await context.supabase
    .from("menu_categories")
    .delete()
    .eq("id", id)
    .select("id, name")
    .maybeSingle<{ id: string; name: string }>();

  if (error) {
    return dbErrorState(error, "kategori");
  }

  if (!data) {
    return errorState("Kategori tidak ditemukan.");
  }

  await writeAudit(context, "menu.category.delete", "menu_category", data.id, {
    name: data.name,
  });

  revalidatePath("/admin/menu");
  return successState(`Kategori ${data.name} dihapus.`);
}

// ---------------------------------------------------------------------------
// Produk
// ---------------------------------------------------------------------------

async function validateModifierGroupsForProduct(
  supabase: SupabaseClient,
  groupIds: string[],
): Promise<
  | { ok: true; groups: ModifierGroupRow[] }
  | { ok: false; state: MenuActionState }
> {
  if (groupIds.length === 0) {
    return { ok: true, groups: [] };
  }

  const { data, error } = await supabase
    .from("modifier_groups")
    .select(
      "id, name, selection_type, is_required, min_select, max_select, sort_order, is_active, modifier_options(id, is_active)",
    )
    .in("id", groupIds);

  if (error) {
    console.error("[menu] Gagal memvalidasi grup modifier:", error.message);
    return {
      ok: false,
      state: errorState("Gagal memvalidasi grup modifier. Silakan coba lagi."),
    };
  }

  const groups = (data ?? []) as ModifierGroupWithOptions[];

  if (groups.length !== groupIds.length) {
    return {
      ok: false,
      state: errorState(
        "Beberapa grup modifier tidak ditemukan. Muat ulang halaman lalu coba lagi.",
        { modifierGroupIds: "Grup modifier tidak ditemukan." },
      ),
    };
  }

  for (const group of groups) {
    if (!group.is_active) {
      continue;
    }

    const activeOptions = (group.modifier_options ?? []).filter(
      (option) => option.is_active,
    ).length;

    if (group.is_required && activeOptions < group.min_select) {
      return {
        ok: false,
        state: errorState(
          `Grup ${group.name} memerlukan minimal ${group.min_select} opsi aktif, tetapi baru tersedia ${activeOptions}.`,
          {
            modifierGroupIds: `Lengkapi opsi grup ${group.name} terlebih dahulu.`,
          },
        ),
      };
    }
  }

  return { ok: true, groups };
}

export async function saveProductAction(
  _previousState: MenuActionState,
  formData: FormData,
): Promise<MenuActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const { context } = contextResult;
  const idValue = String(formData.get("id") ?? "").trim();
  const productId = idValue ? parseId(idValue) : null;

  if (idValue && !productId) {
    return errorState("Produk tidak valid.");
  }

  const modifierGroupIds = Array.from(
    new Set(
      formData
        .getAll("modifierGroupIds")
        .map((value) => String(value))
        .filter(Boolean),
    ),
  );
  const kitchenStationValue = String(
    formData.get("kitchenStation") ?? "",
  ).trim();
  const parsed = productSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    categoryId: String(formData.get("categoryId") ?? ""),
    price: String(formData.get("price") ?? ""),
    sku: String(formData.get("sku") ?? ""),
    description: String(formData.get("description") ?? ""),
    isActive: formBoolean(formData.get("isActive")),
    isAvailable: formBoolean(formData.get("isAvailable")),
    kitchenStation:
      kitchenStationValue === "none" ? "" : kitchenStationValue,
    sortOrder: String(formData.get("sortOrder") ?? "0"),
    modifierGroupIds,
  });

  if (!parsed.success) {
    return errorState(firstZodError(parsed.error), fieldErrorsFrom(parsed.error));
  }

  const { data: category, error: categoryError } = await context.supabase
    .from("menu_categories")
    .select("id, name")
    .eq("id", parsed.data.categoryId)
    .maybeSingle<{ id: string; name: string }>();

  if (categoryError) {
    return dbErrorState(categoryError, "kategori produk");
  }

  if (!category) {
    return errorState("Kategori produk tidak ditemukan.", {
      categoryId: "Pilih kategori yang masih tersedia.",
    });
  }

  const modifierValidation = await validateModifierGroupsForProduct(
    context.supabase,
    parsed.data.modifierGroupIds,
  );

  if (!modifierValidation.ok) {
    return modifierValidation.state;
  }

  const photoEntry = formData.get("photo");
  const photoFile =
    isFileEntry(photoEntry) && photoEntry.size > 0 ? photoEntry : null;
  const removePhoto = formBoolean(formData.get("removePhoto"));
  const targetProductId = productId ?? randomUUID();
  let uploadedPath: string | null = null;
  let uploadedUrl: string | null = null;

  if (photoFile) {
    const photoValidation = await validateProductPhoto(photoFile);

    if (!photoValidation.ok) {
      return errorState(photoValidation.message, {
        photo: photoValidation.message,
      });
    }

    const admin = createSupabaseAdminClient();

    if (!admin) {
      return errorState(
        "Konfigurasi service role Supabase belum tersedia untuk upload foto.",
      );
    }

    uploadedPath = `products/${targetProductId}/${randomUUID()}.${photoValidation.extension}`;
    const { error: uploadError } = await admin.storage
      .from(PRODUCT_PHOTO_BUCKET)
      .upload(uploadedPath, photoValidation.bytes, {
        contentType: photoFile.type,
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("[menu] Gagal upload foto:", uploadError.message);
      return errorState("Gagal mengunggah foto produk. Silakan coba lagi.");
    }

    const { data: publicUrlData } = admin.storage
      .from(PRODUCT_PHOTO_BUCKET)
      .getPublicUrl(uploadedPath);
    uploadedUrl = publicUrlData.publicUrl;
  }

  const payload: Record<string, unknown> = {
    category_id: parsed.data.categoryId,
    name: parsed.data.name,
    sku: parsed.data.sku,
    price: parsed.data.price,
    description: parsed.data.description,
    is_active: parsed.data.isActive,
    is_available: parsed.data.isAvailable,
    kitchen_station: parsed.data.kitchenStation,
    sort_order: parsed.data.sortOrder,
  };

  if (uploadedPath && uploadedUrl) {
    payload.photo_path = uploadedPath;
    payload.photo_url = uploadedUrl;
  } else if (removePhoto) {
    payload.photo_path = null;
    payload.photo_url = null;
  }

  const duplicates = [
    {
      constraint: "products_sku_unique_idx",
      field: "sku",
      message: "SKU sudah digunakan produk lain.",
    },
  ];

  if (productId) {
    const { data: existing, error: existingError } = await context.supabase
      .from("products")
      .select("id, name, photo_path, photo_url")
      .eq("id", productId)
      .maybeSingle<ProductRow>();

    if (existingError) {
      if (uploadedPath) {
        await removeStoredPhoto(uploadedPath);
      }
      return dbErrorState(existingError, "produk");
    }

    if (!existing) {
      if (uploadedPath) {
        await removeStoredPhoto(uploadedPath);
      }
      return errorState("Produk tidak ditemukan atau sudah dihapus.");
    }

    const { data, error } = await context.supabase
      .from("products")
      .update(payload)
      .eq("id", productId)
      .select("id, name")
      .maybeSingle<{ id: string; name: string }>();

    if (error) {
      if (uploadedPath) {
        await removeStoredPhoto(uploadedPath);
      }
      return dbErrorState(error, "produk", duplicates);
    }

    if (!data) {
      if (uploadedPath) {
        await removeStoredPhoto(uploadedPath);
      }
      return errorState("Produk tidak ditemukan atau sudah dihapus.");
    }

    const { error: deleteRelationsError } = await context.supabase
      .from("product_modifier_groups")
      .delete()
      .eq("product_id", productId);

    if (deleteRelationsError) {
      return dbErrorState(deleteRelationsError, "relasi modifier produk");
    }

    if (parsed.data.modifierGroupIds.length > 0) {
      const { error: insertRelationsError } = await context.supabase
        .from("product_modifier_groups")
        .insert(
          parsed.data.modifierGroupIds.map((groupId, index) => ({
            product_id: productId,
            modifier_group_id: groupId,
            sort_order: (index + 1) * 10,
          })),
        );

      if (insertRelationsError) {
        return dbErrorState(insertRelationsError, "relasi modifier produk");
      }
    }

    if (
      (uploadedPath || removePhoto) &&
      existing.photo_path &&
      existing.photo_path !== uploadedPath
    ) {
      await removeStoredPhoto(existing.photo_path);
    }

    await writeAudit(context, "menu.product.update", "product", data.id, {
      name: data.name,
      category_id: parsed.data.categoryId,
      category_name: category.name,
      price: parsed.data.price,
      sku: parsed.data.sku,
      is_active: parsed.data.isActive,
      is_available: parsed.data.isAvailable,
      kitchen_station: parsed.data.kitchenStation,
      sort_order: parsed.data.sortOrder,
      modifier_group_ids: parsed.data.modifierGroupIds,
      photo_changed: Boolean(uploadedPath),
      photo_removed: removePhoto,
    });

    revalidatePath("/admin/menu");
    return successState(`Produk ${data.name} berhasil diperbarui.`);
  }

  const { data, error } = await context.supabase
    .from("products")
    .insert({ ...payload, id: targetProductId })
    .select("id, name")
    .single<{ id: string; name: string }>();

  if (error) {
    if (uploadedPath) {
      await removeStoredPhoto(uploadedPath);
    }
    return dbErrorState(error, "produk", duplicates);
  }

  if (parsed.data.modifierGroupIds.length > 0) {
    const { error: insertRelationsError } = await context.supabase
      .from("product_modifier_groups")
      .insert(
        parsed.data.modifierGroupIds.map((groupId, index) => ({
          product_id: targetProductId,
          modifier_group_id: groupId,
          sort_order: (index + 1) * 10,
        })),
      );

    if (insertRelationsError) {
      await context.supabase.from("products").delete().eq("id", targetProductId);
      if (uploadedPath) {
        await removeStoredPhoto(uploadedPath);
      }
      return dbErrorState(insertRelationsError, "relasi modifier produk");
    }
  }

  await writeAudit(context, "menu.product.create", "product", data.id, {
    name: data.name,
    category_id: parsed.data.categoryId,
    category_name: category.name,
    price: parsed.data.price,
    sku: parsed.data.sku,
    is_active: parsed.data.isActive,
    is_available: parsed.data.isAvailable,
    kitchen_station: parsed.data.kitchenStation,
    sort_order: parsed.data.sortOrder,
    modifier_group_ids: parsed.data.modifierGroupIds,
    photo_changed: Boolean(uploadedPath),
  });

  revalidatePath("/admin/menu");
  return successState(`Produk ${data.name} berhasil dibuat.`);
}

export async function setProductStatusAction(
  productId: string,
  field: "is_active" | "is_available",
  value: boolean,
): Promise<MenuActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(productId);
  const parsedField = productStatusFieldSchema.safeParse(field);

  if (!id || !parsedField.success || typeof value !== "boolean") {
    return errorState("Permintaan tidak valid.");
  }

  const { context } = contextResult;
  const { data, error } = await context.supabase
    .from("products")
    .update({ [parsedField.data]: value })
    .eq("id", id)
    .select("id, name")
    .maybeSingle<{ id: string; name: string }>();

  if (error) {
    return dbErrorState(error, "status produk");
  }

  if (!data) {
    return errorState("Produk tidak ditemukan.");
  }

  await writeAudit(context, "menu.product.status", "product", data.id, {
    name: data.name,
    field: parsedField.data,
    value,
  });

  revalidatePath("/admin/menu");

  if (parsedField.data === "is_active") {
    return successState(
      `Produk ${data.name} ${value ? "diaktifkan" : "dinonaktifkan"}.`,
    );
  }

  return successState(
    `Produk ${data.name} ditandai ${value ? "tersedia" : "tidak tersedia"}.`,
  );
}

export async function deleteProductAction(
  productId: string,
): Promise<MenuActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(productId);

  if (!id) {
    return errorState("Produk tidak valid.");
  }

  const { context } = contextResult;
  const { data: existing, error: existingError } = await context.supabase
    .from("products")
    .select("id, name, photo_path, photo_url")
    .eq("id", id)
    .maybeSingle<ProductRow>();

  if (existingError) {
    return dbErrorState(existingError, "produk");
  }

  if (!existing) {
    return errorState("Produk tidak ditemukan.");
  }

  const { error } = await context.supabase
    .from("products")
    .delete()
    .eq("id", id);

  if (error) {
    return dbErrorState(error, "produk");
  }

  if (existing.photo_path) {
    await removeStoredPhoto(existing.photo_path);
  }

  await writeAudit(context, "menu.product.delete", "product", existing.id, {
    name: existing.name,
    had_photo: Boolean(existing.photo_path),
  });

  revalidatePath("/admin/menu");
  return successState(`Produk ${existing.name} dihapus.`);
}

// ---------------------------------------------------------------------------
// Grup modifier
// ---------------------------------------------------------------------------

export async function saveModifierGroupAction(
  _previousState: MenuActionState,
  formData: FormData,
): Promise<MenuActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const { context } = contextResult;
  const idValue = String(formData.get("id") ?? "").trim();
  const groupId = idValue ? parseId(idValue) : null;

  if (idValue && !groupId) {
    return errorState("Grup modifier tidak valid.");
  }

  const parsed = modifierGroupSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    selectionType: String(formData.get("selectionType") ?? "single"),
    isRequired: formBoolean(formData.get("isRequired")),
    minSelect: String(formData.get("minSelect") ?? "0"),
    maxSelect: String(formData.get("maxSelect") ?? "1"),
    sortOrder: String(formData.get("sortOrder") ?? "0"),
    isActive: formBoolean(formData.get("isActive")),
  });

  if (!parsed.success) {
    return errorState(firstZodError(parsed.error), fieldErrorsFrom(parsed.error));
  }

  const payload = {
    name: parsed.data.name,
    selection_type: parsed.data.selectionType,
    is_required: parsed.data.isRequired,
    min_select: parsed.data.minSelect,
    max_select: parsed.data.maxSelect,
    sort_order: parsed.data.sortOrder,
    is_active: parsed.data.isActive,
  };
  const duplicates = [
    {
      constraint: "modifier_groups_name_unique_idx",
      field: "name",
      message: "Nama grup modifier sudah digunakan.",
    },
  ];

  if (groupId) {
    const { data: existing, error: existingError } = await context.supabase
      .from("modifier_groups")
      .select(
        "id, name, selection_type, is_required, min_select, max_select, sort_order, is_active",
      )
      .eq("id", groupId)
      .maybeSingle<ModifierGroupRow>();

    if (existingError) {
      return dbErrorState(existingError, "grup modifier");
    }

    if (!existing) {
      return errorState("Grup modifier tidak ditemukan.");
    }

    if (parsed.data.isActive && parsed.data.isRequired) {
      const activeOptions = await countActiveOptions(groupId);

      if (activeOptions === null) {
        return errorState("Gagal memeriksa opsi grup modifier.");
      }

      if (activeOptions < parsed.data.minSelect) {
        return errorState(
          `Grup ini baru memiliki ${activeOptions} opsi aktif. Tambah opsi atau turunkan minimum pilihan menjadi ${activeOptions}.`,
          {
            minSelect: `Minimum pilihan melebihi jumlah opsi aktif (${activeOptions}).`,
          },
        );
      }
    }

    const { data, error } = await context.supabase
      .from("modifier_groups")
      .update(payload)
      .eq("id", groupId)
      .select(
        "id, name, selection_type, is_required, min_select, max_select, sort_order, is_active",
      )
      .maybeSingle<ModifierGroupRow>();

    if (error) {
      return dbErrorState(error, "grup modifier", duplicates);
    }

    if (!data) {
      return errorState("Grup modifier tidak ditemukan.");
    }

    await writeAudit(
      context,
      "menu.modifier_group.update",
      "modifier_group",
      data.id,
      {
        name: data.name,
        selection_type: data.selection_type,
        is_required: data.is_required,
        min_select: data.min_select,
        max_select: data.max_select,
        sort_order: data.sort_order,
        is_active: data.is_active,
      },
    );

    revalidatePath("/admin/menu");
    return successState(`Grup modifier ${data.name} berhasil diperbarui.`);
  }

  const { data, error } = await context.supabase
    .from("modifier_groups")
    .insert(payload)
    .select(
      "id, name, selection_type, is_required, min_select, max_select, sort_order, is_active",
    )
    .single<ModifierGroupRow>();

  if (error) {
    return dbErrorState(error, "grup modifier", duplicates);
  }

  await writeAudit(
    context,
    "menu.modifier_group.create",
    "modifier_group",
    data.id,
    {
      name: data.name,
      selection_type: data.selection_type,
      is_required: data.is_required,
      min_select: data.min_select,
      max_select: data.max_select,
      sort_order: data.sort_order,
      is_active: data.is_active,
    },
  );

  revalidatePath("/admin/menu");
  return successState(`Grup modifier ${data.name} berhasil dibuat.`);
}

export async function setModifierGroupActiveAction(
  groupId: string,
  isActive: boolean,
): Promise<MenuActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(groupId);

  if (!id || typeof isActive !== "boolean") {
    return errorState("Permintaan tidak valid.");
  }

  const { context } = contextResult;
  const { data, error } = await context.supabase
    .from("modifier_groups")
    .update({ is_active: isActive })
    .eq("id", id)
    .select("id, name")
    .maybeSingle<{ id: string; name: string }>();

  if (error) {
    return dbErrorState(error, "status grup modifier");
  }

  if (!data) {
    return errorState("Grup modifier tidak ditemukan.");
  }

  await writeAudit(
    context,
    "menu.modifier_group.status",
    "modifier_group",
    data.id,
    { name: data.name, is_active: isActive },
  );

  revalidatePath("/admin/menu");
  return successState(
    `Grup modifier ${data.name} ${isActive ? "diaktifkan" : "dinonaktifkan"}.`,
  );
}

export async function deleteModifierGroupAction(
  groupId: string,
): Promise<MenuActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(groupId);

  if (!id) {
    return errorState("Grup modifier tidak valid.");
  }

  const { context } = contextResult;
  const { data: existing, error: existingError } = await context.supabase
    .from("modifier_groups")
    .select("id, name")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string }>();

  if (existingError) {
    return dbErrorState(existingError, "grup modifier");
  }

  if (!existing) {
    return errorState("Grup modifier tidak ditemukan.");
  }

  const { error } = await context.supabase
    .from("modifier_groups")
    .delete()
    .eq("id", id);

  if (error) {
    return dbErrorState(error, "grup modifier");
  }

  await writeAudit(
    context,
    "menu.modifier_group.delete",
    "modifier_group",
    existing.id,
    { name: existing.name },
  );

  revalidatePath("/admin/menu");
  return successState(`Grup modifier ${existing.name} dihapus.`);
}

// ---------------------------------------------------------------------------
// Opsi modifier
// ---------------------------------------------------------------------------

export async function saveModifierOptionAction(
  _previousState: MenuActionState,
  formData: FormData,
): Promise<MenuActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const { context } = contextResult;
  const idValue = String(formData.get("id") ?? "").trim();
  const optionId = idValue ? parseId(idValue) : null;

  if (idValue && !optionId) {
    return errorState("Opsi modifier tidak valid.");
  }

  const parsed = modifierOptionSchema.safeParse({
    groupId: String(formData.get("groupId") ?? ""),
    name: String(formData.get("name") ?? ""),
    priceDelta: String(formData.get("priceDelta") ?? "0"),
    sortOrder: String(formData.get("sortOrder") ?? "0"),
    isActive: formBoolean(formData.get("isActive")),
  });

  if (!parsed.success) {
    return errorState(firstZodError(parsed.error), fieldErrorsFrom(parsed.error));
  }

  const { data: group, error: groupError } = await context.supabase
    .from("modifier_groups")
    .select(
        "id, name, selection_type, is_required, min_select, max_select, sort_order, is_active",
      )
    .eq("id", parsed.data.groupId)
    .maybeSingle<ModifierGroupRow>();

  if (groupError) {
    return dbErrorState(groupError, "grup modifier");
  }

  if (!group) {
    return errorState("Grup modifier tidak ditemukan.", {
      groupId: "Pilih grup modifier yang masih tersedia.",
    });
  }

  const payload = {
    group_id: parsed.data.groupId,
    name: parsed.data.name,
    price_delta: parsed.data.priceDelta,
    sort_order: parsed.data.sortOrder,
    is_active: parsed.data.isActive,
  };
  const duplicates = [
    {
      constraint: "modifier_options_group_name_unique_idx",
      field: "name",
      message: "Nama opsi sudah digunakan pada grup ini.",
    },
  ];

  if (optionId) {
    const { data: existing, error: existingError } = await context.supabase
      .from("modifier_options")
      .select("id, group_id, name, is_active")
      .eq("id", optionId)
      .maybeSingle<ModifierOptionRow>();

    if (existingError) {
      return dbErrorState(existingError, "opsi modifier");
    }

    if (!existing) {
      return errorState("Opsi modifier tidak ditemukan.");
    }

    if (existing.group_id !== parsed.data.groupId) {
      return errorState("Opsi tidak dapat dipindahkan ke grup lain.");
    }

    if (
      existing.is_active &&
      !parsed.data.isActive &&
      group.is_active &&
      group.is_required
    ) {
      const enoughOptions = await assertGroupHasEnoughOptions(
        existing.group_id,
        group.min_select,
        existing.id,
      );

      if (enoughOptions) {
        return enoughOptions;
      }
    }

    const { data, error } = await context.supabase
      .from("modifier_options")
      .update(payload)
      .eq("id", optionId)
      .select("id, group_id, name, is_active")
      .maybeSingle<ModifierOptionRow>();

    if (error) {
      return dbErrorState(error, "opsi modifier", duplicates);
    }

    if (!data) {
      return errorState("Opsi modifier tidak ditemukan.");
    }

    await writeAudit(
      context,
      "menu.modifier_option.update",
      "modifier_option",
      data.id,
      {
        name: data.name,
        group_id: data.group_id,
        group_name: group.name,
        price_delta: parsed.data.priceDelta,
        sort_order: parsed.data.sortOrder,
        is_active: data.is_active,
      },
    );

    revalidatePath("/admin/menu");
    return successState(`Opsi ${data.name} berhasil diperbarui.`);
  }

  const { data, error } = await context.supabase
    .from("modifier_options")
    .insert(payload)
    .select("id, group_id, name, is_active")
    .single<ModifierOptionRow>();

  if (error) {
    return dbErrorState(error, "opsi modifier", duplicates);
  }

  await writeAudit(
    context,
    "menu.modifier_option.create",
    "modifier_option",
    data.id,
    {
      name: data.name,
      group_id: data.group_id,
      group_name: group.name,
      price_delta: parsed.data.priceDelta,
      sort_order: parsed.data.sortOrder,
      is_active: data.is_active,
    },
  );

  revalidatePath("/admin/menu");
  return successState(`Opsi ${data.name} berhasil dibuat.`);
}

export async function setModifierOptionActiveAction(
  optionId: string,
  isActive: boolean,
): Promise<MenuActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(optionId);

  if (!id || typeof isActive !== "boolean") {
    return errorState("Permintaan tidak valid.");
  }

  const { context } = contextResult;
  const { data: existing, error: existingError } = await context.supabase
    .from("modifier_options")
    .select("id, group_id, name, is_active")
    .eq("id", id)
    .maybeSingle<ModifierOptionRow>();

  if (existingError) {
    return dbErrorState(existingError, "opsi modifier");
  }

  if (!existing) {
    return errorState("Opsi modifier tidak ditemukan.");
  }

  if (existing.is_active && !isActive) {
    const { data: group } = await context.supabase
      .from("modifier_groups")
      .select(
        "id, name, selection_type, is_required, min_select, max_select, sort_order, is_active",
      )
      .eq("id", existing.group_id)
      .maybeSingle<ModifierGroupRow>();

    if (group && group.is_active && group.is_required) {
      const enoughOptions = await assertGroupHasEnoughOptions(
        existing.group_id,
        group.min_select,
        existing.id,
      );

      if (enoughOptions) {
        return enoughOptions;
      }
    }
  }

  const { data, error } = await context.supabase
    .from("modifier_options")
    .update({ is_active: isActive })
    .eq("id", id)
    .select("id, group_id, name, is_active")
    .maybeSingle<ModifierOptionRow>();

  if (error) {
    return dbErrorState(error, "status opsi modifier");
  }

  if (!data) {
    return errorState("Opsi modifier tidak ditemukan.");
  }

  await writeAudit(
    context,
    "menu.modifier_option.status",
    "modifier_option",
    data.id,
    {
      name: data.name,
      group_id: data.group_id,
      is_active: isActive,
    },
  );

  revalidatePath("/admin/menu");
  return successState(
    `Opsi ${data.name} ${isActive ? "diaktifkan" : "dinonaktifkan"}.`,
  );
}

export async function deleteModifierOptionAction(
  optionId: string,
): Promise<MenuActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(optionId);

  if (!id) {
    return errorState("Opsi modifier tidak valid.");
  }

  const { context } = contextResult;
  const { data: existing, error: existingError } = await context.supabase
    .from("modifier_options")
    .select("id, group_id, name, is_active")
    .eq("id", id)
    .maybeSingle<ModifierOptionRow>();

  if (existingError) {
    return dbErrorState(existingError, "opsi modifier");
  }

  if (!existing) {
    return errorState("Opsi modifier tidak ditemukan.");
  }

  if (existing.is_active) {
    const { data: group } = await context.supabase
      .from("modifier_groups")
      .select(
        "id, name, selection_type, is_required, min_select, max_select, sort_order, is_active",
      )
      .eq("id", existing.group_id)
      .maybeSingle<ModifierGroupRow>();

    if (group && group.is_active && group.is_required) {
      const enoughOptions = await assertGroupHasEnoughOptions(
        existing.group_id,
        group.min_select,
        existing.id,
      );

      if (enoughOptions) {
        return enoughOptions;
      }
    }
  }

  const { error } = await context.supabase
    .from("modifier_options")
    .delete()
    .eq("id", id);

  if (error) {
    return dbErrorState(error, "opsi modifier");
  }

  await writeAudit(
    context,
    "menu.modifier_option.delete",
    "modifier_option",
    existing.id,
    {
      name: existing.name,
      group_id: existing.group_id,
    },
  );

  revalidatePath("/admin/menu");
  return successState(`Opsi ${existing.name} dihapus.`);
}
