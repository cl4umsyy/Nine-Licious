#!/usr/bin/env node
/**
 * Reset password akun staf (kasir, kitchen, admin) Nine Licious melalui Supabase Auth Admin API.
 *
 * Prinsip keamanan:
 * - hanya memperbarui akun yang SUDAH ADA di tabel profiles;
 * - password baru diminta secara tersembunyi (*) dan tidak pernah dicetak di log/terminal;
 * - service role key hanya dibaca dari environment lokal;
 * - setiap reset dicatat ke tabel audit_logs.
 *
 * Pemakaian:
 *   node scripts/reset-user-password.mjs --username kasir1
 *   node scripts/reset-user-password.mjs --username kasir2
 *   node scripts/reset-user-password.mjs --username kitchen1
 *   node scripts/reset-user-password.mjs --username kitchen2
 *   node scripts/reset-user-password.mjs --username kasir1 --check
 *
 * Opsi:
 *   --username X   username target (wajib, contoh: kasir1, kasir2, kitchen1, kitchen2, admin)
 *   --check        validasi target tanpa mengubah password
 *   --reactivate   aktifkan kembali profil dan buka ban auth bila nonaktif
 *   production     memakai environment production (letakkan setelah argumen)
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

loadEnvConfig(process.cwd(), !isProduction);

const setupEnvPath = resolve(process.cwd(), ".env.setup.local");

if (existsSync(setupEnvPath)) {
  try {
    process.loadEnvFile(setupEnvPath);
  } catch (error) {
    console.warn(
      `[reset-user] Peringatan: gagal membaca .env.setup.local: ${error.message}`,
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
      "Terminal tidak interaktif. Jalankan langsung di terminal lokal (PowerShell/CMD) untuk memasukkan password.",
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
    fail("Password harus mengandung kombinasi huruf dan angka.");
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

  const rawUsername = readOption("--username") ?? args.find((a) => !a.startsWith("-"));

  if (!rawUsername) {
    fail(
      "Username target wajib ditentukan.\nContoh: node scripts/reset-user-password.mjs --username kasir1",
    );
  }

  const username = rawUsername.trim().toLowerCase();

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
    fail(`Gagal membaca tabel profiles: ${profileError.message}.`);
  }

  if (!profile) {
    fail(
      `Pengguna "${username}" tidak ditemukan di database. Pastikan username sudah benar.`,
    );
  }

  const { data: authData, error: authError } =
    await admin.auth.admin.getUserById(profile.id);

  if (authError || !authData.user) {
    fail(
      `Auth user untuk profil "${username}" tidak ditemukan di Supabase Auth.`,
    );
  }

  const authUser = authData.user;
  const expectedEmail = `${username}@saji.app`;

  if ((authUser.email ?? "").toLowerCase() !== expectedEmail) {
    fail(
      `Auth user "${profile.id}" memakai email ${JSON.stringify(authUser.email)}, bukan ${JSON.stringify(expectedEmail)}. Reset dibatalkan.`,
    );
  }

  const bannedUntil = authUser.banned_until
    ? new Date(authUser.banned_until).getTime()
    : 0;
  const authBanned = bannedUntil > Date.now();
  const needsReactivation = profile.is_active !== true || authBanned;

  console.log(`[reset-user] Target: ${profile.full_name} (@${profile.username}) [${profile.role}]`);
  console.log(`  User ID: ${profile.id}`);
  console.log(`  Email  : ${authUser.email}`);
  console.log(
    `  Status : ${profile.is_active ? "aktif" : "nonaktif"}${
      authBanned ? " (auth dibanned)" : ""
    }`,
  );

  if (checkOnly) {
    console.log("[reset-user] Mode --check: target valid, tidak ada perubahan yang dilakukan.");
    return;
  }

  let password = process.env.USER_NEW_PASSWORD ?? "";

  if (!password) {
    password = await promptHidden(`Password baru untuk @${profile.username}: `);
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
        `Password berhasil direset, tetapi gagal mengaktifkan profil: ${profileUpdateError.message}.`,
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
      source: "scripts/reset-user-password.mjs",
      environment: isProduction ? "production" : "development",
      reactivated,
    },
  });

  if (auditError) {
    console.warn(
      `[reset-user] Peringatan: audit log gagal ditulis (${auditError.message}).`,
    );
  }

  console.log("");
  console.log(`[reset-user] Password @${profile.username} (${profile.full_name}) BERHASIL direset.`);
  console.log(`  Role  : ${profile.role}`);
  console.log(`  Audit : ${auditError ? "gagal dicatat" : "tercatat di audit_logs"}`);
  console.log("");
  console.log("[reset-user] Simpan password baru di tempat yang aman.");
}

main().catch((error) => {
  console.error(`[reset-user] ${error.message ?? error}`);
  process.exitCode = 1;
});
