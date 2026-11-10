#!/usr/bin/env node
/**
 * Verifikasi F0 tanpa mengubah data operasional.
 *
 * Memeriksa:
 * - lima akun awal ada di Supabase Auth dan profiles;
 * - UUID auth = UUID profile, role sesuai, akun aktif dan email terkonfirmasi;
 * - login langsung ke Supabase Auth berhasil untuk kelima akun;
 * - RLS anon, kasir, dan admin;
 * - audit log bootstrap akun awal;
 * - tidak ada duplikat username/email.
 *
 * Script ini hanya membaca data dan membuat sesi auth sementara. Tidak membuat
 * transaksi dan tidak mengubah profil.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

const setupEnvPath = resolve(process.cwd(), ".env.setup.local");

if (existsSync(setupEnvPath)) {
  process.loadEnvFile(setupEnvPath);
}

loadEnvConfig(process.cwd(), true);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const results = [];

function record(status, name, detail = "") {
  results.push({ status, name, detail });
  console.log(`${status} | ${name}${detail ? ` | ${detail}` : ""}`);
}

function pass(name, detail) {
  record("PASS", name, detail);
}

function fail(name, detail) {
  record("FAIL", name, detail);
}

function account(label, role, prefix) {
  return {
    label,
    role,
    username: (process.env[`${prefix}_USERNAME`] ?? "").trim().toLowerCase(),
    password: process.env[`${prefix}_PASSWORD`] ?? "",
  };
}

const accounts = [
  account("Admin", "admin", "SETUP_ADMIN"),
  account("Kasir 1", "kasir", "SETUP_KASIR1"),
  account("Kasir 2", "kasir", "SETUP_KASIR2"),
  account("Kitchen 1", "kitchen", "SETUP_KITCHEN1"),
  account("Kitchen 2", "kitchen", "SETUP_KITCHEN2"),
];

function usernameToEmail(username) {
  return `${username}@saji.app`;
}

function createAnonClient() {
  return createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function signIn(accountData) {
  const client = createAnonClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: usernameToEmail(accountData.username),
    password: accountData.password,
  });

  if (error || !data.user) {
    await client.auth.signOut().catch(() => {});
    return { ok: false, error: error?.message ?? "tidak ada user" };
  }

  return { ok: true, client, user: data.user };
}

async function main() {
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error(
      "NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, dan SUPABASE_SERVICE_ROLE_KEY wajib tersedia.",
    );
    process.exitCode = 1;
    return;
  }

  for (const accountData of accounts) {
    if (!accountData.username || !accountData.password) {
      console.error(
        `Kredensial ${accountData.label} belum lengkap di environment/.env.setup.local.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data: authData, error: authError } =
    await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });

  if (authError) {
    fail("Membaca Supabase Auth", authError.message);
    process.exitCode = 1;
    return;
  }

  const { data: profiles, error: profileError } = await admin
    .from("profiles")
    .select("id, username, full_name, role, is_active")
    .order("username");

  if (profileError) {
    fail("Membaca tabel profiles", profileError.message);
    process.exitCode = 1;
    return;
  }

  const authByEmail = new Map(
    authData.users
      .filter((user) => user.email)
      .map((user) => [user.email.toLowerCase(), user]),
  );
  const profilesByUsername = new Map(
    (profiles ?? []).map((profile) => [profile.username, profile]),
  );

  console.log("");
  console.log("== Akun dan profil ==");

  const accountProfiles = new Map();

  for (const accountData of accounts) {
    const email = usernameToEmail(accountData.username);
    const authUser = authByEmail.get(email);
    const profile = profilesByUsername.get(accountData.username);
    const ok =
      Boolean(authUser) &&
      Boolean(profile) &&
      profile.id === authUser.id &&
      profile.role === accountData.role &&
      profile.is_active === true &&
      Boolean(authUser.email_confirmed_at);

    if (ok) {
      accountProfiles.set(accountData.username, profile);
      pass(
        `${accountData.label} (${accountData.role})`,
        `${profile.id} | auth+profile sinkron`,
      );
    } else {
      fail(
        `${accountData.label} (${accountData.role})`,
        `auth=${authUser ? "ok" : "missing"}, profile=${profile ? "ok" : "missing"}, role=${profile?.role ?? "-"}, aktif=${profile?.is_active ?? "-"}`,
      );
    }
  }

  console.log("");
  console.log("== Login Supabase Auth ==");

  const sessions = new Map();

  for (const accountData of accounts) {
    const session = await signIn(accountData);

    if (!session.ok) {
      fail(`Login ${accountData.label}`, session.error);
      continue;
    }

    const profile = accountProfiles.get(accountData.username);
    const role = session.user.app_metadata?.role;
    const ok = session.user.id === profile?.id && role === accountData.role;

    if (ok) {
      pass(
        `Login ${accountData.label}`,
        `${session.user.id} | role=${role}`,
      );
      sessions.set(accountData.username, session);
    } else {
      fail(
        `Login ${accountData.label}`,
        `uuid/role tidak sesuai: uuid=${session.user.id}, role=${role ?? "-"}`,
      );
    }
  }

  console.log("");
  console.log("== RLS ==");

  const anon = createAnonClient();
  const { data: anonProfiles, error: anonProfilesError } = await anon
    .from("profiles")
    .select("id")
    .limit(1);

  if (anonProfilesError) {
    pass(
      "Anon tidak dapat membaca profiles",
      `ditolak (${anonProfilesError.code ?? anonProfilesError.message})`,
    );
  } else if ((anonProfiles ?? []).length === 0) {
    pass("Anon tidak dapat membaca profiles", "0 baris");
  } else {
    fail("Anon tidak dapat membaca profiles", `${anonProfiles.length} baris terbaca`);
  }

  const kasirSession = sessions.get(accounts[1].username);
  const adminSession = sessions.get(accounts[0].username);

  if (kasirSession) {
    const { data: visibleProfiles, error: visibleError } = await kasirSession.client
      .from("profiles")
      .select("id, username, role");

    if (
      !visibleError &&
      (visibleProfiles ?? []).length === 1 &&
      visibleProfiles[0].id === kasirSession.user.id
    ) {
      pass(
        "Kasir hanya membaca profil sendiri",
        `${visibleProfiles[0].username} | ${visibleProfiles.length} baris`,
      );
    } else {
      fail(
        "Kasir hanya membaca profil sendiri",
        visibleError?.message ?? `${visibleProfiles?.length ?? 0} baris`,
      );
    }

    const { data: kasirAudit, error: kasirAuditError } = await kasirSession.client
      .from("audit_logs")
      .select("id")
      .limit(5);

    if (kasirAuditError) {
      pass(
        "Kasir tidak dapat membaca audit_logs",
        `ditolak (${kasirAuditError.code ?? kasirAuditError.message})`,
      );
    } else if ((kasirAudit ?? []).length === 0) {
      pass("Kasir tidak dapat membaca audit_logs", "0 baris");
    } else {
      fail("Kasir tidak dapat membaca audit_logs", `${kasirAudit.length} baris terbaca`);
    }

  }

  if (adminSession) {
    const { data: adminProfiles, error: adminProfilesError } =
      await adminSession.client
        .from("profiles")
        .select("id, username, role")
        .order("username");

    if (
      !adminProfilesError &&
      (adminProfiles ?? []).length >= accounts.length
    ) {
      pass(
        "Admin dapat membaca semua profiles",
        `${adminProfiles.length} baris`,
      );
    } else {
      fail(
        "Admin dapat membaca semua profiles",
        adminProfilesError?.message ?? `${adminProfiles?.length ?? 0} baris`,
      );
    }

    const { data: adminAudit, error: adminAuditError } = await adminSession.client
      .from("audit_logs")
      .select("id, action, username")
      .eq("action", "accounts.bootstrap");

    if (!adminAuditError && (adminAudit ?? []).length >= accounts.length) {
      pass(
        "Admin dapat membaca audit_logs",
        `${adminAudit.length} audit bootstrap`,
      );
    } else {
      fail(
        "Admin dapat membaca audit_logs",
        adminAuditError?.message ?? `${adminAudit?.length ?? 0} baris`,
      );
    }
  }

  console.log("");
  console.log("== Audit dan duplikasi ==");

  const { data: bootstrapAudits, error: bootstrapAuditError } = await admin
    .from("audit_logs")
    .select("username, action, entity_id, details")
    .eq("action", "accounts.bootstrap");

  if (bootstrapAuditError) {
    fail("Audit bootstrap akun awal", bootstrapAuditError.message);
  } else {
    const auditedUsernames = new Set(
      (bootstrapAudits ?? []).map((entry) => entry.username),
    );
    const missing = accounts
      .map((accountData) => accountData.username)
      .filter((username) => !auditedUsernames.has(username));

    if (missing.length === 0 && (bootstrapAudits ?? []).length >= accounts.length) {
      pass(
        "Audit bootstrap akun awal",
        `${bootstrapAudits.length} entri untuk 5 akun`,
      );
    } else {
      fail(
        "Audit bootstrap akun awal",
        `missing=${missing.join(",") || "-"}, total=${bootstrapAudits?.length ?? 0}`,
      );
    }
  }

  const expectedEmails = accounts.map((accountData) =>
    usernameToEmail(accountData.username),
  );
  const matchingAuthUsers = authData.users.filter((user) =>
    user.email ? expectedEmails.includes(user.email.toLowerCase()) : false,
  );
  const profileCounts = accounts.map(
    (accountData) => profilesByUsername.get(accountData.username)?.id,
  );

  if (
    matchingAuthUsers.length === accounts.length &&
    new Set(matchingAuthUsers.map((user) => user.id)).size === accounts.length &&
    new Set(profileCounts).size === accounts.length &&
    profileCounts.every(Boolean)
  ) {
    pass("Tidak ada duplikasi akun", "5 auth user dan 5 profile unik");
  } else {
    fail(
      "Tidak ada duplikasi akun",
      `auth=${matchingAuthUsers.length}, profile=${new Set(profileCounts).size}`,
    );
  }

  for (const session of sessions.values()) {
    await session.client.auth.signOut().catch(() => {});
  }

  const failures = results.filter((result) => result.status === "FAIL").length;
  const passes = results.filter((result) => result.status === "PASS").length;

  console.log("");
  console.log(`Ringkasan: ${passes} PASS, ${failures} FAIL.`);

  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Verifikasi gagal: ${error.message ?? error}`);
  process.exitCode = 1;
});
