"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/auth/audit";
import { getAdminActor } from "@/lib/auth/session";
import {
  createUserSchema,
  firstZodError,
  resetPasswordSchema,
} from "@/lib/auth/validation";
import { normalizeUsername, usernameToEmail } from "@/lib/auth/username";
import type { UserRole } from "@/lib/auth/roles";
import type { UserActionState } from "@/lib/auth/action-types";

type TargetProfile = {
  id: string;
  username: string;
  full_name: string;
  role: string;
  is_active: boolean;
};

function fieldErrorsFrom(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!errors[key]) {
      errors[key] = issue.message;
    }
  }

  return errors;
}

export async function createUserAction(
  _previousState: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  const actor = await getAdminActor();

  if (!actor.ok) {
    return { status: "error", message: actor.message };
  }

  const parsed = createUserSchema.safeParse({
    username: String(formData.get("username") ?? ""),
    fullName: String(formData.get("fullName") ?? ""),
    role: String(formData.get("role") ?? ""),
    password: String(formData.get("password") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const admin = createSupabaseAdminClient();

  if (!admin) {
    return {
      status: "error",
      message: "Konfigurasi service role Supabase belum tersedia.",
    };
  }

  const username = normalizeUsername(parsed.data.username);
  const role = parsed.data.role as UserRole;

  const { data: existing } = await admin
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle<{ id: string }>();

  if (existing) {
    return {
      status: "error",
      message: "Username sudah digunakan.",
      fieldErrors: { username: "Username sudah digunakan." },
    };
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: usernameToEmail(username),
    password: parsed.data.password,
    email_confirm: true,
    app_metadata: { role },
    user_metadata: {
      username,
      full_name: parsed.data.fullName,
    },
  });

  if (createError || !created.user) {
    const message = createError?.message ?? "Tidak ada data pengguna.";

    if (/already|registered|exists/i.test(message)) {
      return {
        status: "error",
        message: "Username atau email sudah digunakan.",
        fieldErrors: { username: "Username sudah digunakan." },
      };
    }

    console.error("[users] Gagal membuat pengguna:", message);

    return {
      status: "error",
      message: "Gagal membuat pengguna. Silakan coba lagi.",
    };
  }

  const { error: profileError } = await admin.from("profiles").upsert(
    {
      id: created.user.id,
      username,
      full_name: parsed.data.fullName,
      role,
      is_active: true,
    },
    { onConflict: "id" },
  );

  if (profileError) {
    console.error("[users] Gagal menyimpan profil:", profileError.message);
    await admin.auth.admin.deleteUser(created.user.id);

    return {
      status: "error",
      message: "Gagal menyimpan profil pengguna. Silakan coba lagi.",
    };
  }

  await logAudit({
    action: "user.create",
    userId: actor.session.user.id,
    username: actor.session.profile.username,
    entity: "profile",
    entityId: created.user.id,
    details: {
      target_username: username,
      target_role: role,
      target_name: parsed.data.fullName,
    },
  });

  revalidatePath("/admin/users");

  return {
    status: "success",
    message: `Pengguna ${parsed.data.fullName} berhasil dibuat.`,
  };
}

export async function resetPasswordAction(
  _previousState: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  const actor = await getAdminActor();

  if (!actor.ok) {
    return { status: "error", message: actor.message };
  }

  const userId = String(formData.get("userId") ?? "");
  const parsed = resetPasswordSchema.safeParse({
    password: String(formData.get("password") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: firstZodError(parsed.error),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }

  const admin = createSupabaseAdminClient();

  if (!admin) {
    return {
      status: "error",
      message: "Konfigurasi service role Supabase belum tersedia.",
    };
  }

  const { data: target } = await admin
    .from("profiles")
    .select("id, username, full_name, role, is_active")
    .eq("id", userId)
    .maybeSingle<TargetProfile>();

  if (!target) {
    return { status: "error", message: "Pengguna tidak ditemukan." };
  }

  const { error } = await admin.auth.admin.updateUserById(userId, {
    password: parsed.data.password,
  });

  if (error) {
    console.error("[users] Gagal mereset password:", error.message);

    return {
      status: "error",
      message: "Gagal mereset password. Silakan coba lagi.",
    };
  }

  await logAudit({
    action: "user.password_reset",
    userId: actor.session.user.id,
    username: actor.session.profile.username,
    entity: "profile",
    entityId: userId,
    details: { target_username: target.username },
  });

  return {
    status: "success",
    message: `Password ${target.full_name} berhasil direset.`,
  };
}

export async function setUserActiveAction(
  _previousState: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  const actor = await getAdminActor();

  if (!actor.ok) {
    return { status: "error", message: actor.message };
  }

  const userId = String(formData.get("userId") ?? "");
  const activeValue = String(formData.get("active") ?? "");
  const active = activeValue === "true";

  if (!userId || (activeValue !== "true" && activeValue !== "false")) {
    return { status: "error", message: "Permintaan tidak valid." };
  }

  if (!active && userId === actor.session.user.id) {
    return {
      status: "error",
      message: "Anda tidak dapat menonaktifkan akun Anda sendiri.",
    };
  }

  const admin = createSupabaseAdminClient();

  if (!admin) {
    return {
      status: "error",
      message: "Konfigurasi service role Supabase belum tersedia.",
    };
  }

  const { data: target } = await admin
    .from("profiles")
    .select("id, username, full_name, role, is_active")
    .eq("id", userId)
    .maybeSingle<TargetProfile>();

  if (!target) {
    return { status: "error", message: "Pengguna tidak ditemukan." };
  }

  if (target.is_active === active) {
    return {
      status: "success",
      message: "Status pengguna tidak berubah.",
    };
  }

  if (!active && target.role === "admin") {
    const { count, error } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin")
      .eq("is_active", true);

    if (error) {
      return {
        status: "error",
        message: "Gagal memeriksa admin aktif. Silakan coba lagi.",
      };
    }

    if ((count ?? 0) <= 1) {
      return {
        status: "error",
        message:
          "Admin aktif terakhir tidak dapat dinonaktifkan. Aktifkan admin lain terlebih dahulu.",
      };
    }
  }

  const { error: authError } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: active ? "none" : "876000h",
  });

  if (authError) {
    console.error("[users] Gagal memperbarui status auth:", authError.message);

    return {
      status: "error",
      message: "Gagal memperbarui status pengguna. Silakan coba lagi.",
    };
  }

  const { error: profileError } = await admin
    .from("profiles")
    .update({ is_active: active })
    .eq("id", userId);

  if (profileError) {
    await admin.auth.admin.updateUserById(userId, {
      ban_duration: target.is_active ? "none" : "876000h",
    });

    console.error(
      "[users] Gagal memperbarui status profil:",
      profileError.message,
    );

    return {
      status: "error",
      message: "Gagal memperbarui status pengguna. Silakan coba lagi.",
    };
  }

  await logAudit({
    action: active ? "user.activate" : "user.deactivate",
    userId: actor.session.user.id,
    username: actor.session.profile.username,
    entity: "profile",
    entityId: userId,
    details: {
      target_username: target.username,
      target_role: target.role,
      previous_active: target.is_active,
    },
  });

  revalidatePath("/admin/users");

  return {
    status: "success",
    message: active
      ? `${target.full_name} berhasil diaktifkan.`
      : `${target.full_name} berhasil dinonaktifkan.`,
  };
}
