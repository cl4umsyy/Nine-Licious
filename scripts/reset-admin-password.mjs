#!/usr/bin/env node
/**
 * Reset password akun Admin Nine Licious melalui Supabase Auth Admin API.
 *
 * Prinsip keamanan:
 * - hanya memperbarui akun yang SUDAH ADA; tidak pernah membuat akun baru;
 * - menolak profil yang bukan admin atau auth user yang tidak cocok;
 * - password baru diminta secara tersembunyi dan tidak pernah dicetak;
 * - service role key hanya dibaca dari environment dan tidak ditampilkan;
 * - setiap reset dicatat ke audit_logs.
 *
 * Pemakaian:
 *   npm run reset:admin
 *   npm run reset:admin -- --check
 *   npm run reset:admin -- --username admin --reactivate
 *
 * Opsi:
 *   --check        validasi target tanpa mengubah password
 *   --username X   username admin (default: ADMIN_USERNAME,
 *                  SETUP_ADMIN_USERNAME, lalu "admin")
 *   --reactivate   aktifkan kembali profil dan buka ban auth bila nonaktif
 *   production     memakai environment production (letakkan setelah --)
 *
 * Non-interaktif (mis. CI):
 *   ADMIN_NEW_PASSWORD=... npm run reset:admin
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

const args = process.argv.slice(2);
const isProduction =
  process.env.NODE_ENV === "production" ||
  args.includes("production") ||
  args.includes("--production");

const { loadedEnvFiles } = loadEnvConfig(process.cwd(), !isProduction);

const setupEnvPath = resolve(process.cwd(), ".env.setup.local");

if (existsSync(setupEnvPath)) {
  try {
    process.loadEnvFile(setupEnvPath);
  } catch (error) {
    console.warn(
      `[reset-admin] Peringatan: gagal membaca .env.setup.local: ${error.message}`,
    );
  }
}

function fail(message) {
  throw new Error(message);
}

function readOption(name) {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));

  if (inline) {
    return inline.slice(name.length + 1);
  }

  const index = args.indexOf(name);

  if (index === -1) {
    return null;
  }

  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    fail(`Opsi ${name} membutuhkan nilai.`);
  }

  return value;
}

function promptHidden(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    fail(
      "Terminal tidak interaktif. Set ADMIN_NEW_PASSWORD untuk menjalankan tanpa prompt.",
    );
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    let value = "";

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (chunk) => {
      // Abaikan escape sequence (tombol panah, dsb.).
      const text = String(chunk).replace(
        /\u001b\[[0-9;?]*[ -/]*[@-~]/g,
        "",
      );

      for (const character of text) {
        if (character === "\u0003") {
          cleanup();
          stdout.write("\n");
          rejectPromise(new Error("Dibatalkan."));
          return;
        }

        if (character === "\r" || character === "\n") {
          cleanup();
          stdout.write("\n");
          resolvePromise(value);
          return;
        }

        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }

        if (character >= " ") {
          value += character;
          stdout.write("*");
        }
      }
    };

    stdin.on("data", onData);
  });
}

function validatePassword(password) {
  if (!password) {
    fail("Password baru wajib diisi.");
  }

  if (password.length < 8 || password.length > 72) {
    fail("Password harus 8-72 karakter.");
  }

  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    fail("Password harus mengandung huruf dan angka.");
  }
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    fail("NEXT_PUBLIC_SUPABASE_URL wajib diisi di environment.");
  }

  if (!serviceRoleKey) {
    fail("SUPABASE_SERVICE_ROLE_KEY wajib diisi di environment.");
  }

  const username = (
    readOption("--username") ??
    process.env.ADMIN_USERNAME ??
    process.env.SETUP_ADMIN_USERNAME ??
    "admin"
  )
    .trim()
    .toLowerCase();

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    fail(
      "Username harus 3-32 karakter dan hanya berisi huruf kecil, angka, titik, garis bawah, atau tanda hubung.",
    );
  }

  const checkOnly = args.includes("--check");
  const reactivate = args.includes("--reactivate");

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, username, full_name, role, is_active")
    .eq("username", username)
    .maybeSingle();

  if (profileError) {
    fail(
      `Gagal membaca tabel profiles: ${profileError.message}. Pastikan migrasi F0 sudah dijalankan.`,
    );
  }

  if (!profile) {
    fail(
      `Profil "${username}" tidak ditemukan. Script ini tidak membuat akun baru; periksa username admin yang benar.`,
    );
  }

  if (profile.role !== "admin") {
    fail(
      `Akun "${username}" memiliki role "${profile.role}", bukan admin. Reset dibatalkan.`,
    );
  }

  const { data: authData, error: authError } =
    await admin.auth.admin.getUserById(profile.id);

  if (authError || !authData.user) {
    fail(
      `Auth user untuk profil "${username}" tidak ditemukan. Periksa konsistensi database; tidak ada perubahan.`,
    );
  }

  const authUser = authData.user;
  const expectedEmail = `${username}@saji.app`;

  if ((authUser.email ?? "").toLowerCase() !== expectedEmail) {
    fail(
      `Auth user "${profile.id}" memakai email ${JSON.stringify(authUser.email)}, bukan ${JSON.stringify(expectedEmail)}. Reset dibatalkan agar tidak salah akun.`,
    );
  }

  const bannedUntil = authUser.banned_until
    ? new Date(authUser.banned_until).getTime()
    : 0;
  const authBanned = bannedUntil > Date.now();
  const needsReactivation = profile.is_active !== true || authBanned;

  console.log(`[reset-admin] Lingkungan: ${isProduction ? "production" : "development"}`);
  console.log(
    `[reset-admin] File env: ${loadedEnvFiles.map((file) => file.path).join(", ") || "(tidak ada)"}`,
  );
  console.log(
    `[reset-admin] Kredensial setup: ${existsSync(setupEnvPath) ? ".env.setup.local" : "environment shell"}`,
  );
  console.log(`[reset-admin] Target: ${profile.username} (${profile.id})`);

  if (checkOnly) {
    console.log("[reset-admin] Mode --check: tidak ada perubahan.");
    console.log(`  Nama   : ${profile.full_name}`);
    console.log(`  Role   : ${profile.role}`);
    console.log(
      `  Email  : ${authUser.email}${
        authUser.email_confirmed_at ? "" : " (belum dikonfirmasi)"
      }`,
    );
    console.log(
      `  Status : ${profile.is_active ? "aktif" : "nonaktif"}${
        authBanned ? " (auth dibanned)" : ""
      }`,
    );

    if (needsReactivation) {
      console.log(
        "[reset-admin] Catatan: gunakan --reactivate agar akun dapat login kembali.",
      );
    }

    console.log("[reset-admin] Target valid.");
    return;
  }

  let password = process.env.ADMIN_NEW_PASSWORD ?? "";

  if (!password) {
    password = await promptHidden("Password baru admin: ");
    const confirmation = await promptHidden("Ulangi password baru: ");

    if (password !== confirmation) {
      fail("Konfirmasi password tidak sama.");
    }
  }

  validatePassword(password);

  const updatePayload = { password, email_confirm: true };

  if (reactivate) {
    updatePayload.ban_duration = "none";
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(
    profile.id,
    updatePayload,
  );

  if (updateError) {
    fail(`Gagal mereset password: ${updateError.message}`);
  }

  let reactivated = false;

  if (reactivate) {
    const { error: profileUpdateError } = await admin
      .from("profiles")
      .update({ is_active: true })
      .eq("id", profile.id);

    if (profileUpdateError) {
      fail(
        `Password sudah direset, tetapi gagal mengaktifkan profil: ${profileUpdateError.message}. Jalankan ulang dengan --reactivate.`,
      );
    }

    reactivated = needsReactivation;
  }

  const { error: auditError } = await admin.from("audit_logs").insert({
    user_id: profile.id,
    username: profile.username,
    action: "user.password_reset",
    entity: "profile",
    entity_id: profile.id,
    details: {
      target_username: profile.username,
      target_role: profile.role,
      source: "scripts/reset-admin-password.mjs",
      environment: isProduction ? "production" : "development",
      reactivated,
    },
  });

  if (auditError) {
    console.warn(
      `[reset-admin] Peringatan: audit log gagal ditulis (${auditError.message}).`,
    );
  }

  console.log("");
  console.log("[reset-admin] Password admin berhasil direset.");
  console.log(`  Username : ${profile.username}`);
  console.log(`  User ID  : ${profile.id}`);
  console.log(`  Role     : ${profile.role}`);
  console.log(
    `  Status   : ${
      reactivate
        ? "aktif"
        : profile.is_active
          ? "aktif"
          : "nonaktif (gunakan --reactivate agar bisa login)"
    }`,
  );
  console.log(`  Audit    : ${auditError ? "GAGAL ditulis" : "tercatat"}`);
  console.log("");
  console.log(
    "[reset-admin] Password tidak ditampilkan. Simpan password baru di tempat aman.",
  );
}

main().catch((error) => {
  console.error(`[reset-admin] ${error.message ?? error}`);
  process.exitCode = 1;
});
