#!/usr/bin/env node
/**
 * Setup akun awal Saji POS: 1 admin, 2 kasir, dan 2 kitchen staff.
 *
 * Script ini memakai Supabase Auth Admin API dan tabel profiles. Sifatnya
 * idempoten:
 *
 * - akun yang belum ada akan dibuat;
 * - akun yang sudah ada tidak diubah dan tidak diduplikasi;
 * - profil yang hilang untuk auth user yang sudah ada akan dilengkapi;
 * - role/status yang tidak sesuai dilaporkan sebagai kegagalan, bukan diubah.
 *
 * Kredensial dibaca dari environment, tanpa nilai default:
 *   SETUP_ADMIN_USERNAME / SETUP_ADMIN_FULL_NAME / SETUP_ADMIN_PASSWORD
 *   SETUP_KASIR1_* / SETUP_KASIR2_*
 *   SETUP_KITCHEN1_* / SETUP_KITCHEN2_*
 *
 * Script juga memuat .env.setup.local bila ada. File itu tidak dibaca oleh
 * aplikasi Next.js.
 *
 * Development:
 *   npm run setup:accounts
 *
 * Production:
 *   npm run setup:accounts -- production
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

const isProduction =
  process.env.NODE_ENV === "production" ||
  process.argv
    .slice(2)
    .some((argument) => argument === "production" || argument === "--production");

const setupEnvPath = resolve(process.cwd(), ".env.setup.local");
let setupEnvLoaded = false;

if (existsSync(setupEnvPath)) {
  try {
    process.loadEnvFile(setupEnvPath);
    setupEnvLoaded = true;
  } catch (error) {
    console.warn(
      `[setup-accounts] Gagal membaca .env.setup.local: ${error.message}`,
    );
  }
}

const { loadedEnvFiles } = loadEnvConfig(process.cwd(), !isProduction);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ACCOUNT_SPECS = [
  {
    label: "Admin",
    role: "admin",
    usernameEnv: "SETUP_ADMIN_USERNAME",
    nameEnv: "SETUP_ADMIN_FULL_NAME",
    passwordEnv: "SETUP_ADMIN_PASSWORD",
  },
  {
    label: "Kasir 1",
    role: "kasir",
    usernameEnv: "SETUP_KASIR1_USERNAME",
    nameEnv: "SETUP_KASIR1_FULL_NAME",
    passwordEnv: "SETUP_KASIR1_PASSWORD",
  },
  {
    label: "Kasir 2",
    role: "kasir",
    usernameEnv: "SETUP_KASIR2_USERNAME",
    nameEnv: "SETUP_KASIR2_FULL_NAME",
    passwordEnv: "SETUP_KASIR2_PASSWORD",
  },
  {
    label: "Kitchen 1",
    role: "kitchen",
    usernameEnv: "SETUP_KITCHEN1_USERNAME",
    nameEnv: "SETUP_KITCHEN1_FULL_NAME",
    passwordEnv: "SETUP_KITCHEN1_PASSWORD",
  },
  {
    label: "Kitchen 2",
    role: "kitchen",
    usernameEnv: "SETUP_KITCHEN2_USERNAME",
    nameEnv: "SETUP_KITCHEN2_FULL_NAME",
    passwordEnv: "SETUP_KITCHEN2_PASSWORD",
  },
];

function usernameToEmail(username) {
  return `${username}@saji.app`;
}

function readAccounts() {
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

  if (!anonKey) {
    errors.push("NEXT_PUBLIC_SUPABASE_ANON_KEY wajib diisi.");
  }

  const accounts = ACCOUNT_SPECS.map((spec) => {
    const username = (process.env[spec.usernameEnv] ?? "").trim().toLowerCase();
    const fullName = (process.env[spec.nameEnv] ?? "").trim();
    const password = process.env[spec.passwordEnv] ?? "";

    if (!username) {
      errors.push(`${spec.usernameEnv} wajib diisi.`);
    } else if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
      errors.push(
        `${spec.usernameEnv} harus 3-32 karakter dan hanya berisi huruf kecil, angka, titik, garis bawah, atau tanda hubung.`,
      );
    }

    if (!fullName) {
      errors.push(`${spec.nameEnv} wajib diisi.`);
    } else if (fullName.length < 2 || fullName.length > 80) {
      errors.push(`${spec.nameEnv} harus 2-80 karakter.`);
    }

    if (!password) {
      errors.push(`${spec.passwordEnv} wajib diisi.`);
    } else if (password.length < 8 || password.length > 72) {
      errors.push(`${spec.passwordEnv} harus 8-72 karakter.`);
    } else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      errors.push(`${spec.passwordEnv} harus mengandung huruf dan angka.`);
    }

    return {
      ...spec,
      username,
      fullName,
      password,
      email: username ? usernameToEmail(username) : "",
    };
  });

  const seen = new Set();

  for (const account of accounts) {
    if (!account.username) {
      continue;
    }

    if (seen.has(account.username)) {
      errors.push(
        `Username ${account.username} dipakai lebih dari satu akun. Gunakan username unik.`,
      );
    }

    seen.add(account.username);
  }

  return { accounts, errors };
}

async function listAllUsers(admin) {
  const perPage = 1000;
  const users = [];
  let page = 1;

  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });

    if (error) {
      throw error;
    }

    users.push(...data.users);

    if (data.users.length < perPage) {
      break;
    }

    page += 1;
  }

  return users;
}

async function loadProfiles(admin) {
  const { data, error } = await admin
    .from("profiles")
    .select("id, username, full_name, role, is_active");

  if (error) {
    throw new Error(
      `Gagal membaca tabel profiles (${error.message}). Pastikan migrasi F0 sudah dijalankan.`,
    );
  }

  return data ?? [];
}

async function writeAudit(admin, entry) {
  const { error } = await admin.from("audit_logs").insert({
    user_id: entry.userId,
    username: entry.username,
    action: entry.action,
    entity: "profile",
    entity_id: entry.userId,
    details: {
      target_username: entry.username,
      target_role: entry.role,
      target_name: entry.fullName,
      source: "scripts/setup-accounts.mjs",
      environment: isProduction ? "production" : "development",
      created_auth: entry.createdAuth,
      linked_profile: entry.linkedProfile,
    },
  });

  if (error) {
    console.warn(
      `[setup-accounts] Peringatan: audit log ${entry.username} gagal ditulis (${error.message}).`,
    );
  }
}

async function main() {
  const envLabel = isProduction ? "production" : "development";
  const envFiles =
    loadedEnvFiles.map((file) => file.path).join(", ") || "(tidak ada file env)";

  console.log(`[setup-accounts] Lingkungan: ${envLabel}`);
  console.log(`[setup-accounts] File env: ${envFiles}`);
  console.log(
    `[setup-accounts] Kredensial setup: ${setupEnvLoaded ? ".env.setup.local" : "environment shell"}`,
  );

  const { accounts, errors } = readAccounts();

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`[setup-accounts] ${error}`);
    }

    console.error(
      "[setup-accounts] Tidak ada akun yang dibuat. Lengkapi environment lalu jalankan ulang.",
    );
    process.exitCode = 1;
    return;
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  let authUsers;
  let profiles;

  try {
    authUsers = await listAllUsers(admin);
    profiles = await loadProfiles(admin);
  } catch (error) {
    console.error(`[setup-accounts] ${error.message ?? error}`);
    process.exitCode = 1;
    return;
  }

  const authByEmail = new Map(
    authUsers
      .filter((user) => user.email)
      .map((user) => [user.email.toLowerCase(), user]),
  );
  const authById = new Map(authUsers.map((user) => [user.id, user]));
  const profilesByUsername = new Map(
    profiles.map((profile) => [profile.username, profile]),
  );
  const profilesById = new Map(
    profiles.map((profile) => [profile.id, profile]),
  );

  const results = [];

  for (const account of accounts) {
    const profileByUsername = profilesByUsername.get(account.username);
    const authUserByEmail = authByEmail.get(account.email);

    if (profileByUsername) {
      const authUser = authById.get(profileByUsername.id);

      if (!authUser) {
        errors.push(
          `Profil ${account.username} ada, tetapi auth user dengan UUID ${profileByUsername.id} tidak ditemukan. Tidak diubah.`,
        );
        results.push({ account, status: "FAIL", userId: profileByUsername.id });
        continue;
      }

      if (authUser.email?.toLowerCase() !== account.email) {
        errors.push(
          `Profil ${account.username} terhubung ke auth user dengan email berbeda. Tidak diubah.`,
        );
        results.push({ account, status: "FAIL", userId: authUser.id });
        continue;
      }

      if (
        profileByUsername.role !== account.role ||
        profileByUsername.is_active !== true
      ) {
        errors.push(
          `Akun ${account.username} sudah ada tetapi role/status tidak sesuai (role=${profileByUsername.role}, aktif=${profileByUsername.is_active}). Tidak diubah.`,
        );
        results.push({ account, status: "FAIL", userId: authUser.id });
        continue;
      }

      results.push({ account, status: "SKIP", userId: authUser.id });
      continue;
    }

    if (authUserByEmail) {
      const existingProfile = profilesById.get(authUserByEmail.id);

      if (existingProfile) {
        errors.push(
          `Auth user ${account.email} sudah terhubung ke profil ${existingProfile.username}, bukan ${account.username}. Tidak diubah.`,
        );
        results.push({
          account,
          status: "FAIL",
          userId: authUserByEmail.id,
        });
        continue;
      }

      const { error: profileError } = await admin.from("profiles").insert({
        id: authUserByEmail.id,
        username: account.username,
        full_name: account.fullName,
        role: account.role,
        is_active: true,
      });

      if (profileError) {
        errors.push(
          `Gagal melengkapi profil ${account.username}: ${profileError.message}`,
        );
        results.push({
          account,
          status: "FAIL",
          userId: authUserByEmail.id,
        });
        continue;
      }

      await writeAudit(admin, {
        userId: authUserByEmail.id,
        username: account.username,
        role: account.role,
        fullName: account.fullName,
        action: "accounts.bootstrap.profile_link",
        createdAuth: false,
        linkedProfile: true,
      });

      results.push({
        account,
        status: "LINKED",
        userId: authUserByEmail.id,
      });
      continue;
    }

    const { data: created, error: createError } = await admin.auth.admin.createUser(
      {
        email: account.email,
        password: account.password,
        email_confirm: true,
        app_metadata: { role: account.role },
        user_metadata: {
          username: account.username,
          full_name: account.fullName,
        },
      },
    );

    if (createError || !created.user) {
      errors.push(
        `Gagal membuat akun ${account.username}: ${createError?.message ?? "tidak ada data pengguna"}`,
      );
      results.push({ account, status: "FAIL", userId: null });
      continue;
    }

    const userId = created.user.id;
    const { error: profileError } = await admin.from("profiles").upsert(
      {
        id: userId,
        username: account.username,
        full_name: account.fullName,
        role: account.role,
        is_active: true,
      },
      { onConflict: "id" },
    );

    if (profileError) {
      const { error: rollbackError } = await admin.auth.admin.deleteUser(userId);
      errors.push(
        `Gagal menyimpan profil ${account.username}: ${profileError.message}.${
          rollbackError
            ? ` Rollback akun baru juga gagal: ${rollbackError.message}`
            : " Akun baru dibatalkan."
        }`,
      );
      results.push({ account, status: "FAIL", userId: null });
      continue;
    }

    await writeAudit(admin, {
      userId,
      username: account.username,
      role: account.role,
      fullName: account.fullName,
      action: "accounts.bootstrap",
      createdAuth: true,
      linkedProfile: false,
    });

    results.push({ account, status: "CREATED", userId });
  }

  const finalUsers = await listAllUsers(admin);
  const finalProfiles = await loadProfiles(admin);
  const finalAuthByEmail = new Map(
    finalUsers
      .filter((user) => user.email)
      .map((user) => [user.email.toLowerCase(), user]),
  );
  const finalProfilesByUsername = new Map(
    finalProfiles.map((profile) => [profile.username, profile]),
  );

  console.log("");
  console.log("[setup-accounts] Hasil:");

  let verificationFailures = 0;

  for (const account of accounts) {
    const authUser = finalAuthByEmail.get(account.email);
    const profile = finalProfilesByUsername.get(account.username);
    const result = results.find((item) => item.account.username === account.username);
    const ok =
      Boolean(authUser) &&
      Boolean(profile) &&
      profile.id === authUser.id &&
      profile.role === account.role &&
      profile.is_active === true &&
      Boolean(authUser.email_confirmed_at);

    if (!ok) {
      verificationFailures += 1;
    }

    console.log(
      [
        ok ? "PASS" : "FAIL",
        account.label,
        account.username,
        account.role,
        profile?.id ?? "-",
        authUser ? "auth:ok" : "auth:missing",
        profile ? "profile:ok" : "profile:missing",
        result?.status ?? "UNKNOWN",
      ].join(" | "),
    );
  }

  const createdCount = results.filter((item) => item.status === "CREATED").length;
  const linkedCount = results.filter((item) => item.status === "LINKED").length;
  const skippedCount = results.filter((item) => item.status === "SKIP").length;

  console.log("");
  console.log(
    `[setup-accounts] Dibuat: ${createdCount}, profil dilengkapi: ${linkedCount}, dilewati: ${skippedCount}, error: ${errors.length + verificationFailures}.`,
  );

  if (errors.length > 0 || verificationFailures > 0) {
    console.error(
      "[setup-accounts] Verifikasi gagal. Periksa pesan di atas; akun yang sudah ada tidak diubah.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    "[setup-accounts] Semua akun awal siap. Password tidak ditampilkan.",
  );
}

main().catch((error) => {
  console.error(`[setup-accounts] Gagal: ${error.message ?? error}`);
  process.exitCode = 1;
});
