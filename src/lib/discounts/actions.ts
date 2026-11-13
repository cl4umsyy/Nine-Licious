"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/auth/audit";
import {
  getAdminActor,
  getCashierActor,
  getSessionState,
} from "@/lib/auth/session";
import type {
  DiscountActionResult,
  DiscountWithTargets,
  ManualDiscountApprovalData,
} from "@/lib/discounts/types";
import {
  discountIdSchema,
  fieldErrorsFrom,
  finalizeOrderSchema,
  firstZodError,
  requestDiscountApprovalSchema,
  saveDiscountSchema,
  unfinalizeOrderSchema,
} from "@/lib/discounts/validation";
import { getSupabaseConfig } from "@/lib/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Discount, MenuCategory, Product, Profile } from "@/types/database";

/**
 * Mengambil daftar diskon promo.
 * - Admin: dapat melihat seluruh diskon (aktif maupun nonaktif).
 * - Kasir: hanya dapat melihat diskon aktif.
 * - Kitchen / Publik: ditolak.
 */
export async function getDiscountsAction(): Promise<
  DiscountActionResult<DiscountWithTargets[]>
> {
  const sessionState = await getSessionState();
  if (sessionState.status !== "authenticated") {
    return { ok: false, message: "Sesi tidak valid. Silakan masuk kembali." };
  }

  const role = sessionState.profile.role;
  if (role !== "admin" && role !== "kasir") {
    return { ok: false, message: "Akses ditolak." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Supabase belum dikonfigurasi." };
  }

  let query = supabase.from("discounts").select("*");

  // Kasir hanya boleh membaca diskon aktif
  if (role === "kasir") {
    query = query.eq("is_active", true);
  }

  const { data: discountsData, error: discErr } = await query
    .order("created_at", { ascending: false });

  if (discErr) {
    return { ok: false, message: `Gagal memuat diskon: ${discErr.message}` };
  }

  const rawDiscounts = (discountsData ?? []) as Discount[];

  // Ambil metadata kategori dan produk target untuk tampilan Admin
  const categoryIds = Array.from(
    new Set(rawDiscounts.map((d) => d.applies_to_category_id).filter(Boolean)),
  ) as string[];

  const productIds = Array.from(
    new Set(rawDiscounts.map((d) => d.applies_to_product_id).filter(Boolean)),
  ) as string[];

  const categoryMap = new Map<string, string>();
  if (categoryIds.length > 0) {
    const { data: cats } = await supabase
      .from("menu_categories")
      .select("id, name")
      .in("id", categoryIds);
    for (const c of (cats ?? []) as MenuCategory[]) {
      categoryMap.set(c.id, c.name);
    }
  }

  const productMap = new Map<string, string>();
  if (productIds.length > 0) {
    const { data: prods } = await supabase
      .from("products")
      .select("id, name")
      .in("id", productIds);
    for (const p of (prods ?? []) as Product[]) {
      productMap.set(p.id, p.name);
    }
  }

  const discountsWithTargets: DiscountWithTargets[] = rawDiscounts.map((d) => ({
    ...d,
    categoryName: d.applies_to_category_id
      ? categoryMap.get(d.applies_to_category_id) ?? null
      : null,
    productName: d.applies_to_product_id
      ? productMap.get(d.applies_to_product_id) ?? null
      : null,
  }));

  return {
    ok: true,
    message: "Data diskon berhasil dimuat.",
    data: discountsWithTargets,
  };
}

/**
 * Membuat atau memperbarui master promo diskon (Khusus Admin).
 */
export async function saveDiscountAction(
  rawInput: unknown,
): Promise<DiscountActionResult<Discount>> {
  const adminActor = await getAdminActor();
  if (!adminActor.ok) {
    return { ok: false, message: adminActor.message };
  }

  const parsed = saveDiscountSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Supabase belum dikonfigurasi." };
  }

  const payload = {
    name: input.name,
    scope: input.scope,
    discount_type: input.discountType,
    discount_value: input.discountValue,
    applies_to_category_id: input.scope === "product" ? input.appliesToCategoryId || null : null,
    applies_to_product_id: input.scope === "product" ? input.appliesToProductId || null : null,
    min_order_amount: input.minOrderAmount ?? 0,
    max_discount_amount: input.maxDiscountAmount || null,
    is_active: input.isActive ?? true,
  };

  if (input.id) {
    // Mode Update
    const { data: updated, error } = await supabase
      .from("discounts")
      .update(payload)
      .eq("id", input.id)
      .select()
      .single<Discount>();

    if (error) {
      return { ok: false, message: `Gagal memperbarui diskon: ${error.message}` };
    }

    await logAudit({
      action: "discount.update",
      userId: adminActor.session.user.id,
      entity: "discount",
      entityId: input.id,
      details: {
        name: updated.name,
        scope: updated.scope,
        discount_type: updated.discount_type,
        discount_value: updated.discount_value,
        is_active: updated.is_active,
      },
    });

    revalidatePath("/admin/discounts");
    revalidatePath("/pos");

    return {
      ok: true,
      message: `Promo "${updated.name}" berhasil diperbarui.`,
      data: updated,
    };
  } else {
    // Mode Create
    const { data: created, error } = await supabase
      .from("discounts")
      .insert({
        ...payload,
        created_by: adminActor.session.user.id,
      })
      .select()
      .single<Discount>();

    if (error) {
      return { ok: false, message: `Gagal membuat diskon: ${error.message}` };
    }

    await logAudit({
      action: "discount.create",
      userId: adminActor.session.user.id,
      entity: "discount",
      entityId: created.id,
      details: {
        name: created.name,
        scope: created.scope,
        discount_type: created.discount_type,
        discount_value: created.discount_value,
        is_active: created.is_active,
      },
    });

    revalidatePath("/admin/discounts");
    revalidatePath("/pos");

    return {
      ok: true,
      message: `Promo "${created.name}" berhasil dibuat.`,
      data: created,
    };
  }
}

/**
 * Mengubah status aktif / nonaktif master promo (Khusus Admin).
 */
export async function setDiscountActiveAction(
  discountId: string,
  isActive: boolean,
): Promise<DiscountActionResult> {
  const adminActor = await getAdminActor();
  if (!adminActor.ok) {
    return { ok: false, message: adminActor.message };
  }

  const parsedId = discountIdSchema.safeParse(discountId);
  if (!parsedId.success) {
    return { ok: false, message: "ID promo tidak valid." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Supabase belum dikonfigurasi." };
  }

  const { data: updated, error } = await supabase
    .from("discounts")
    .update({ is_active: isActive })
    .eq("id", parsedId.data)
    .select("id, name, is_active")
    .single<Discount>();

  if (error) {
    return { ok: false, message: `Gagal mengubah status diskon: ${error.message}` };
  }

  await logAudit({
    action: "discount.status",
    userId: adminActor.session.user.id,
    entity: "discount",
    entityId: updated.id,
    details: {
      name: updated.name,
      is_active: updated.is_active,
    },
  });

  revalidatePath("/admin/discounts");
  revalidatePath("/pos");

  return {
    ok: true,
    message: `Promo "${updated.name}" berhasil ${isActive ? "diaktifkan" : "dinonaktifkan"}.`,
  };
}

/**
 * Menghapus master promo diskon (Khusus Admin).
 */
export async function deleteDiscountAction(
  discountId: string,
): Promise<DiscountActionResult> {
  const adminActor = await getAdminActor();
  if (!adminActor.ok) {
    return { ok: false, message: adminActor.message };
  }

  const parsedId = discountIdSchema.safeParse(discountId);
  if (!parsedId.success) {
    return { ok: false, message: "ID promo tidak valid." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Supabase belum dikonfigurasi." };
  }

  // Cek apakah promo pernah digunakan dalam transaksi
  const { count } = await supabase
    .from("order_discounts")
    .select("id", { count: "exact", head: true })
    .eq("discount_id", parsedId.data);

  if (count && count > 0) {
    return {
      ok: false,
      message:
        "Promo ini sudah digunakan dalam transaksi riwayat dan tidak dapat dihapus. Anda dapat menonaktifkannya.",
    };
  }

  const { error } = await supabase
    .from("discounts")
    .delete()
    .eq("id", parsedId.data);

  if (error) {
    return { ok: false, message: `Gagal menghapus diskon: ${error.message}` };
  }

  await logAudit({
    action: "discount.delete",
    userId: adminActor.session.user.id,
    entity: "discount",
    entityId: parsedId.data,
  });

  revalidatePath("/admin/discounts");
  revalidatePath("/pos");

  return {
    ok: true,
    message: "Promo diskon berhasil dihapus.",
  };
}

/**
 * Meminta persetujuan Admin untuk diskon manual (Khusus Kasir / Admin di POS).
 *
 * Persyaratan Keamanan WAJIB (F1.4 Stage 2):
 * 1. Autentikasi ulang Admin via isolated Supabase Auth client (persistSession: false).
 * 2. Session Admin tidak boleh menimpa session Kasir aktif.
 * 3. Tidak ada kata sandi yang disimpan di database, localStorage, React state, atau audit log.
 * 4. Verifikasi profile Admin aktif (role = 'admin', is_active = true).
 * 5. cashier_id diambil murni dari session server terautentikasi.
 * 6. context_ref terikat ketat pada idempotencyKey keranjang saat ini.
 * 7. Nonce single-use dibuat dengan masa berlaku 5 menit menggunakan service_role.
 * 8. Kegagalan autentikasi dicatat ke audit log tanpa mencatat kata sandi.
 */
export async function requestDiscountApprovalAction(
  rawInput: unknown,
): Promise<DiscountActionResult<ManualDiscountApprovalData>> {
  // 1. Dapatkan sesi kasir pemohon dari server session
  const cashierActor = await getCashierActor();
  if (!cashierActor.ok) {
    return { ok: false, message: cashierActor.message };
  }

  const cashierId = cashierActor.session.user.id;

  // 2. Validasi input Zod
  const parsed = requestDiscountApprovalSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const input = parsed.data;

  // 3. Buat Supabase Auth client terisolasi tanpa persistSession
  const config = getSupabaseConfig();
  if (!config) {
    return { ok: false, message: "Konfigurasi Supabase tidak ditemukan." };
  }

  const isolatedClient = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  // 4. Verifikasi kredensial Admin
  const { data: authData, error: authError } =
    await isolatedClient.auth.signInWithPassword({
      email: input.adminEmail,
      password: input.adminPassword,
    });

  if (authError || !authData.user) {
    // Catat audit kegagalan approval (TANPA PASSWORD!)
    await logAudit({
      action: "discount.approval_failed",
      userId: cashierId,
      entity: "discount_approval",
      details: {
        reason: "Kredensial Admin tidak cocok",
        target_admin_email: input.adminEmail,
        discount_type: input.discountType,
        discount_value: input.discountValue,
        idempotency_key: input.idempotencyKey,
      },
    });

    return {
      ok: false,
      message: "Autentikasi Admin gagal. Periksa kembali email dan kata sandi.",
    };
  }

  const adminUserId = authData.user.id;

  // 5. Verifikasi profil Admin di database (role = 'admin', is_active = true)
  const adminDbClient = createSupabaseAdminClient();
  if (!adminDbClient) {
    return { ok: false, message: "Klien admin database tidak tersedia." };
  }

  const { data: adminProfile, error: profileErr } = await adminDbClient
    .from("profiles")
    .select("id, full_name, role, is_active")
    .eq("id", adminUserId)
    .maybeSingle<Profile>();

  if (profileErr || !adminProfile) {
    await logAudit({
      action: "discount.approval_failed",
      userId: cashierId,
      entity: "discount_approval",
      details: {
        reason: "Profil Admin tidak ditemukan",
        target_admin_id: adminUserId,
      },
    });
    return { ok: false, message: "Profil Admin tidak ditemukan di sistem." };
  }

  if (adminProfile.role !== "admin") {
    await logAudit({
      action: "discount.approval_failed",
      userId: cashierId,
      entity: "discount_approval",
      details: {
        reason: "Pengguna bukan berhak akses Admin",
        target_admin_id: adminUserId,
        role: adminProfile.role,
      },
    });
    return {
      ok: false,
      message: "Pengguna tersebut tidak memiliki hak akses Admin.",
    };
  }

  if (!adminProfile.is_active) {
    await logAudit({
      action: "discount.approval_failed",
      userId: cashierId,
      entity: "discount_approval",
      details: {
        reason: "Akun Admin sedang dinonaktifkan",
        target_admin_id: adminUserId,
      },
    });
    return {
      ok: false,
      message: "Akun Admin tersebut saat ini sedang dinonaktifkan.",
    };
  }

  // 6. Buat single-use approval nonce dengan batas kedaluwarsa 5 menit
  const nonce = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const contextRef = `idempotency:${input.idempotencyKey}`;

  // Insert ke discount_approval_nonces dengan service_role
  const { data: nonceRow, error: nonceInsertErr } = await adminDbClient
    .from("discount_approval_nonces")
    .insert({
      nonce,
      approver_id: adminProfile.id,
      cashier_id: cashierId,
      discount_type: input.discountType,
      discount_value: input.discountValue,
      reason: input.reason.trim(),
      context_ref: contextRef,
      expires_at: expiresAt,
      is_used: false,
    })
    .select()
    .single();

  if (nonceInsertErr || !nonceRow) {
    return {
      ok: false,
      message: `Gagal menerbitkan token persetujuan diskon: ${nonceInsertErr?.message}`,
    };
  }

  // 7. Catat audit keberhasilan pemberian approval
  await logAudit({
    action: "discount.approval_granted",
    userId: cashierId,
    entity: "discount_approval_nonce",
    entityId: nonceRow.id,
    details: {
      approver_id: adminProfile.id,
      approver_name: adminProfile.full_name,
      cashier_id: cashierId,
      discount_type: input.discountType,
      discount_value: input.discountValue,
      reason: input.reason.trim(),
      context_ref: contextRef,
      expires_at: expiresAt,
    },
  });

  return {
    ok: true,
    message: `Persetujuan diskon manual berhasil diberikan oleh ${adminProfile.full_name}.`,
    data: {
      nonce,
      approverId: adminProfile.id,
      approverName: adminProfile.full_name,
      discountType: input.discountType,
      discountValue: input.discountValue,
      reason: input.reason.trim(),
      expiresAt,
    },
  };
}

/**
 * Finalisasi Pesanan POS (Mengunci pesanan, item, dan diskon sebelum pembayaran).
 */
export async function finalizeOrderAction(
  rawInput: unknown,
): Promise<DiscountActionResult> {
  const cashierActor = await getCashierActor();
  if (!cashierActor.ok) {
    return { ok: false, message: cashierActor.message };
  }

  const parsed = finalizeOrderSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, message: firstZodError(parsed.error) };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Supabase belum dikonfigurasi." };
  }

  const { data, error } = await supabase.rpc("finalize_pos_order", {
    p_order_id: parsed.data.orderId,
  });

  if (error) {
    return {
      ok: false,
      message: `Gagal memfinalisasi pesanan: ${error.message}`,
    };
  }

  revalidatePath("/pos");
  revalidatePath("/pos/floor");

  return {
    ok: true,
    message: "Pesanan berhasil difinalisasi.",
    data,
  };
}

/**
 * Membuka kembali status finalisasi pesanan (Khusus Admin).
 */
export async function unfinalizeOrderAction(
  rawInput: unknown,
): Promise<DiscountActionResult> {
  const adminActor = await getAdminActor();
  if (!adminActor.ok) {
    return {
      ok: false,
      message: "Hanya Admin yang berhak membuka kembali pesanan final.",
    };
  }

  const parsed = unfinalizeOrderSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, message: firstZodError(parsed.error) };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Supabase belum dikonfigurasi." };
  }

  const { data, error } = await supabase.rpc("unfinalize_pos_order", {
    p_order_id: parsed.data.orderId,
    p_reason: parsed.data.reason.trim(),
  });

  if (error) {
    return {
      ok: false,
      message: `Gagal membuka kembali pesanan: ${error.message}`,
    };
  }

  revalidatePath("/pos");
  revalidatePath("/pos/floor");

  return {
    ok: true,
    message: "Status finalisasi pesanan berhasil dibuka kembali.",
    data,
  };
}

