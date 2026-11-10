#!/usr/bin/env node
/**
 * Bootstrap admin pertama Nine Licious.
 *
 * Script ini operasional: tidak membuat akun contoh dan tidak membuat data
 * transaksi. Jalankan setelah migrasi F0 selesai.
 *
 * Development:
 *   npm run create:admin
 *
 * Production:
 *   npm run create:admin -- production
 *
 * Kredensial wajib diberikan lewat environment, tanpa nilai default:
 *   ADMIN_USERNAME, ADMIN_FULL_NAME, ADMIN_PASSWORD
 *
 * Contoh PowerShell:
 *   $env:ADMIN_USERNAME="pemilik"
 *   $env:ADMIN_FULL_NAME="Nama Pemilik"
 *   $env:ADMIN_PASSWORD="PasswordKuat123"
 *   npm run create:admin
 */

import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

const isProduction =
  process.env.NODE_ENV === "production" ||
  process.argv
    .slice(2)
    .some((argument) => argument === "production" || argument === "--production");
const { loadedEnvFiles } = loadEnvConfig(process.cwd(), !isProduction);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const username = (process.env.ADMIN_USERNAME ?? "").trim().toLowerCase();
const fullName = (process.env.ADMIN_FULL_NAME ?? "").trim();
const password = process.env.ADMIN_PASSWORD ?? "";

function validate() {
  const errors = [];

  if (!supabaseUrl) {
    errors.push("NEXT_PUBLIC_SUPABASE_URL wajib diisi.");
  } else {
    try {
      const parsedUrl = new URL(supabaseUrl);

      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
        errors.push("NEXT_PUBLIC_SUPABASE_URL harus memakai http atau https.");
      }
    } catch {
      errors.push("NEXT_PUBLIC_SUPABASE_URL bukan URL yang valid.");
    }
  }

  if (!serviceRoleKey) {
    errors.push("SUPABASE_SERVICE_ROLE_KEY wajib diisi.");
  }

  if (!username) {
    errors.push("ADMIN_USERNAME wajib diisi.");
  } else if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    errors.push(
      "ADMIN_USERNAME harus 3-32 karakter dan hanya berisi huruf kecil, angka, titik, garis bawah, atau tanda hubung.",
    );
  }

  if (!fullName) {
    errors.push("ADMIN_FULL_NAME wajib diisi.");
  } else if (fullName.length < 2 || fullName.length > 80) {
    errors.push("ADMIN_FULL_NAME harus 2-80 karakter.");
  }

  if (!password) {
    errors.push("ADMIN_PASSWORD wajib diisi.");
  } else if (password.length < 8 || password.length > 72) {
    errors.push("ADMIN_PASSWORD harus 8-72 karakter.");
  } else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    errors.push("ADMIN_PASSWORD harus mengandung huruf dan angka.");
  }

  if (!anonKey) {
    console.warn(
      "[create-admin] Peringatan: NEXT_PUBLIC_SUPABASE_ANON_KEY belum diisi. Aplikasi belum bisa dipakai login.",
    );
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`[create-admin] ${error}`);
    }
    process.exitCode = 1;
    return false;
  }

  return true;
}

async function main() {
  const envLabel = isProduction ? "production" : "development";
  const envFiles = loadedEnvFiles.map((file) => file.path).join(", ") || "(tidak ada file env)";

  console.log(`[create-admin] Lingkungan: ${envLabel}`);
  console.log(`[create-admin] File env: ${envFiles}`);

  if (!validate()) {
    console.error(
      "[create-admin] Tidak ada akun yang dibuat. Lengkapi environment lalu jalankan ulang.",
    );
    return;
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data: existingProfile, error: profileLookupError } = await admin
    .from("profiles")
    .select("id, username")
    .eq("username", username)
    .maybeSingle();

  if (profileLookupError) {
    throw new Error(
      `Gagal membaca tabel profiles (${profileLookupError.message}). Pastikan migrasi F0 sudah dijalankan di project Supabase yang benar.`,
    );
  }

  const email = `${username}@saji.app`;
  let userId;

  if (existingProfile) {
    const { data: existingUser, error: getUserError } =
      await admin.auth.admin.getUserById(existingProfile.id);

    if (getUserError || !existingUser.user) {
      throw new Error(
        `Profil ${username} ada, tetapi akun auth tidak ditemukan. Periksa konsistensi database.`,
      );
    }

    const { data, error } = await admin.auth.admin.updateUserById(
      existingProfile.id,
      {
        email,
        password,
        email_confirm: true,
        ban_duration: "none",
        app_metadata: {
          ...existingUser.user.app_metadata,
          role: "admin",
        },
        user_metadata: {
          ...existingUser.user.user_metadata,
          username,
          full_name: fullName,
        },
      },
    );

    if (error || !data.user) {
      throw new Error(
        `Gagal memperbarui akun admin: ${error?.message ?? "tidak ada data pengguna"}`,
      );
    }

    userId = data.user.id;
    console.log(`[create-admin] Akun admin diperbarui: ${username}`);
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: "admin" },
      user_metadata: {
        username,
        full_name: fullName,
      },
    });

    if (error || !data.user) {
      throw new Error(
        `Gagal membuat akun admin: ${error?.message ?? "tidak ada data pengguna"}`,
      );
    }

    userId = data.user.id;
    console.log(`[create-admin] Akun admin dibuat: ${username}`);
  }

  const { error: profileError } = await admin.from("profiles").upsert(
    {
      id: userId,
      username,
      full_name: fullName,
      role: "admin",
      is_active: true,
    },
    { onConflict: "id" },
  );

  if (profileError) {
    throw new Error(`Gagal menyimpan profil admin: ${profileError.message}`);
  }

  const { error: auditError } = await admin.from("audit_logs").insert({
    user_id: userId,
    username,
    action: "admin.bootstrap",
    entity: "profile",
    entity_id: userId,
    details: {
      target_username: username,
      target_role: "admin",
      target_name: fullName,
      source: "scripts/create-admin.mjs",
      environment: isProduction ? "production" : "development",
    },
  });

  if (auditError) {
    console.warn(
      `[create-admin] Peringatan: audit log gagal ditulis (${auditError.message}).`,
    );
  }

  console.log("");
  console.log("[create-admin] Selesai. Admin siap dipakai:");
  console.log(`  Username : ${username}`);
  console.log("  Password : (tidak ditampilkan)");
  console.log(`  Email    : ${email}`);
  console.log("");
  console.log(
    "[create-admin] Segera simpan password di tempat aman dan ganti bila diperlukan.",
  );
}

main().catch((error) => {
  console.error(`[create-admin] Gagal: ${error.message ?? error}`);
  process.exitCode = 1;
});
