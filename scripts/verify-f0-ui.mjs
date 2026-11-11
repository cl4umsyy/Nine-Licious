#!/usr/bin/env node
/**
 * Verifikasi F0 melalui aplikasi Nine Licious yang berjalan.
 *
 * Memeriksa:
 * - login UI untuk Admin, Kasir, dan Kitchen;
 * - redirect halaman sesuai role dan blokir lintas role;
 * - logout;
 * - rate limiting login;
 * - audit log login/logout dan manajemen pengguna;
 * - pembuatan, reset password, nonaktifkan, dan aktifkan pengguna oleh admin.
 *
 * Akun uji sementara `f0.verify` dibuat lalu dihapus kembali. Lima akun awal
 * tidak diubah. Jalankan dev server di port 3100 sebelum script ini.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";
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
const baseUrl = process.env.VERIFY_BASE_URL ?? "http://localhost:3100";
const chromePath =
  process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const testUsername = "f0.verify";
const testFullName = "F0 Verifikasi";
const testEmail = `${testUsername}@saji.app`;
const probeUsername = "ratelimit.probe";
const testRole = process.env.VERIFY_TEST_ROLE === "kitchen" ? "kitchen" : "kasir";
const testHome = testRole === "kitchen" ? "/kitchen" : "/pos";
const testRoleLabel = testRole === "kitchen" ? "Staf Dapur" : "Kasir";
const initialTestPassword = `${randomBytes(24).toString("base64url")}a9`;
const resetTestPassword = `${randomBytes(24).toString("base64url")}a9`;

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

function createAnonClient() {
  return createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function directSignIn(email, password) {
  const client = createAnonClient();
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.user) {
    await client.auth.signOut().catch(() => {});
    return { ok: false, error: error?.message ?? "tidak ada user" };
  }

  await client.auth.signOut().catch(() => {});
  return { ok: true, user: data.user };
}

async function loginViaUi(page, username, password) {
  await page.goto("/login");
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Masuk ke Nine Licious" }).click();
}

async function expectPath(page, pathname, timeout = 30_000) {
  await page.waitForURL((url) => url.pathname === pathname, { timeout });
}

async function logout(page) {
  await page.getByRole("button", { name: "Menu pengguna" }).click();
  await page.getByRole("button", { name: "Keluar" }).click();
  await expectPath(page, "/login");
}

async function openUserRow(page, username) {
  const row = page.locator("tr", { hasText: username }).first();
  await row.waitFor({ state: "visible" });
  return row;
}

async function chooseUserAction(page, username, actionName) {
  const row = await openUserRow(page, username);
  await row.getByRole("button", { name: /Aksi untuk/ }).click();
  await page.getByRole("menuitem", { name: actionName }).click();
}

async function main() {
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error(
      "Konfigurasi Supabase belum lengkap. Pastikan NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, dan SUPABASE_SERVICE_ROLE_KEY terisi di .env.local. Service role hanya dipakai di server.",
    );
    process.exitCode = 1;
    return;
  }

  if (!existsSync(chromePath)) {
    console.error(`Chrome tidak ditemukan di ${chromePath}.`);
    process.exitCode = 1;
    return;
  }

  for (const accountData of accounts) {
    if (!accountData.username || !accountData.password) {
      console.error(`Kredensial ${accountData.label} belum lengkap.`);
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

  const { data: existingTestProfile } = await admin
    .from("profiles")
    .select("id, username")
    .eq("username", testUsername)
    .maybeSingle();

  if (existingTestProfile) {
    console.error(
      `Akun uji ${testUsername} sudah ada. Hapus secara manual atau gunakan nama lain; script tidak menghapus akun yang sudah ada.`,
    );
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
  });

  let testUserId = null;

  try {
    const adminContext = await browser.newContext({ baseURL: baseUrl });
    const adminPage = await adminContext.newPage();
    adminPage.setDefaultTimeout(30_000);
    adminPage.setDefaultNavigationTimeout(60_000);

    console.log("");
    console.log("== Branding ==");

    await adminPage.goto("/login");
    const loginTitle = await adminPage.title();
    const loginText = await adminPage.locator("body").innerText();
    const loginBrandOk =
      loginTitle.includes("Nine Licious") &&
      loginText.includes("Masuk ke Nine Licious") &&
      !/\bSaji\b/.test(loginText);

    if (loginBrandOk) {
      pass("Branding halaman login", "judul dan teks Nine Licious");
    } else {
      fail("Branding halaman login", `title=${JSON.stringify(loginTitle)}`);
    }

    console.log("");
    console.log("== Login dan redirect role ==");

    await loginViaUi(
      adminPage,
      accounts[0].username,
      accounts[0].password,
    );
    await expectPath(adminPage, "/admin");
    pass("Login Admin", "/admin");

    const adminText = await adminPage.locator("body").innerText();
    const adminBrandOk =
      adminText.includes("Nine Licious") && !/\bSaji\b/.test(adminText);

    if (adminBrandOk) {
      pass("Branding dashboard admin", "sidebar dan nama restoran");
    } else {
      fail("Branding dashboard admin", "teks Nine Licious tidak lengkap");
    }

    await adminPage.goto("/pos");
    await expectPath(adminPage, "/pos");
    pass("Admin dapat membuka /pos", "/pos");

    await adminPage.goto("/kitchen");
    await expectPath(adminPage, "/kitchen");
    pass("Admin dapat membuka /kitchen", "/kitchen");

    await adminPage.goto("/queue");
    const queueTitle = await adminPage.title();
    const queueText = await adminPage.locator("body").innerText();
    const queueBrandOk =
      queueTitle.includes("Nine Licious") &&
      queueText.includes("Nine Licious") &&
      !/\bSaji\b/.test(queueText);

    if (queueBrandOk) {
      pass("Branding papan antrean", "judul dan footer Nine Licious");
    } else {
      fail("Branding papan antrean", `title=${JSON.stringify(queueTitle)}`);
    }

    await adminPage.goto("/admin/users");
    await expectPath(adminPage, "/admin/users");
    pass("Admin dapat membuka /admin/users", "/admin/users");

    console.log("");
    console.log("== Manajemen pengguna ==");

    await adminPage.getByRole("button", { name: "Tambah pengguna" }).click();
    const createDialog = adminPage.getByRole("dialog");
    await createDialog.getByLabel("Nama lengkap").fill(testFullName);
    await createDialog.getByLabel("Username").fill(testUsername);

    if (testRole === "kitchen") {
      await createDialog.getByLabel("Peran").click();
      await adminPage.getByRole("option", { name: testRoleLabel }).click();
    }

    await createDialog.getByLabel("Password", { exact: true }).fill(initialTestPassword);
    await createDialog
      .getByLabel("Konfirmasi password")
      .fill(initialTestPassword);
    await createDialog.getByRole("button", { name: "Buat pengguna" }).click();
    await openUserRow(adminPage, testUsername);
    pass("Admin membuat pengguna baru", `${testUsername} (${testRole})`);

    const { data: createdProfile } = await admin
      .from("profiles")
      .select("id, username, role, is_active")
      .eq("username", testUsername)
      .maybeSingle();

    if (
      createdProfile &&
      createdProfile.role === testRole &&
      createdProfile.is_active === true
    ) {
      testUserId = createdProfile.id;
      pass(
        "Profil pengguna baru tersimpan",
        `${createdProfile.id} | role=${testRole}`,
      );
    } else {
      fail(
        "Profil pengguna baru tersimpan",
        createdProfile ? `role=${createdProfile.role}, aktif=${createdProfile.is_active}` : "profil tidak ditemukan",
      );
    }

    if (testUserId) {
      const initialLogin = await directSignIn(testEmail, initialTestPassword);

      if (initialLogin.ok) {
        pass("Login pengguna baru", "password awal diterima");
      } else {
        fail("Login pengguna baru", initialLogin.error);
      }
    }

    await chooseUserAction(adminPage, testUsername, "Reset password");
    const resetDialog = adminPage.getByRole("dialog");
    await resetDialog
      .getByLabel("Password baru")
      .fill(resetTestPassword);
    await resetDialog
      .getByLabel("Konfirmasi password")
      .fill(resetTestPassword);
    await resetDialog.getByRole("button", { name: "Reset password" }).click();
    await resetDialog.waitFor({ state: "hidden" });
    pass("Admin mereset password", testUsername);

    const resetLogin = await directSignIn(testEmail, resetTestPassword);

    if (resetLogin.ok) {
      pass("Login dengan password hasil reset", "password baru diterima");
    } else {
      fail("Login dengan password hasil reset", resetLogin.error);
    }

    await chooseUserAction(adminPage, testUsername, "Nonaktifkan");
    const deactivateDialog = adminPage.getByRole("dialog");
    await deactivateDialog
      .getByRole("button", { name: "Nonaktifkan pengguna" })
      .click();
    await deactivateDialog.waitFor({ state: "hidden" });

    const { data: inactiveProfile } = await admin
      .from("profiles")
      .select("is_active")
      .eq("username", testUsername)
      .maybeSingle();

    if (inactiveProfile?.is_active === false) {
      pass("Admin menonaktifkan pengguna", "is_active=false");
    } else {
      fail("Admin menonaktifkan pengguna", `is_active=${inactiveProfile?.is_active}`);
    }

    const inactiveContext = await browser.newContext({ baseURL: baseUrl });
    const inactivePage = await inactiveContext.newPage();
    inactivePage.setDefaultTimeout(30_000);
    inactivePage.setDefaultNavigationTimeout(60_000);
    await loginViaUi(inactivePage, testUsername, resetTestPassword);
    const inactiveError = inactivePage.getByText(
      /Username atau password salah\.|Akun ini tidak dapat digunakan\./,
    );
    const inactiveErrorShown = await inactiveError
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const inactivePath = new URL(inactivePage.url()).pathname;

    if (inactiveErrorShown && inactivePath === "/login") {
      pass(
        "Akun nonaktif ditolak saat login",
        "tetap di /login dengan pesan error",
      );
    } else {
      fail(
        "Akun nonaktif ditolak saat login",
        `path=${inactivePath}, error=${inactiveErrorShown}`,
      );
    }

    await inactiveContext.close();

    await chooseUserAction(adminPage, testUsername, "Aktifkan");
    const activateDialog = adminPage.getByRole("dialog");
    await activateDialog
      .getByRole("button", { name: "Aktifkan pengguna" })
      .click();
    await activateDialog.waitFor({ state: "hidden" });

    const { data: activeProfile } = await admin
      .from("profiles")
      .select("is_active")
      .eq("username", testUsername)
      .maybeSingle();

    if (activeProfile?.is_active === true) {
      pass("Admin mengaktifkan kembali pengguna", "is_active=true");
    } else {
      fail("Admin mengaktifkan kembali pengguna", `is_active=${activeProfile?.is_active}`);
    }

    const reactivatedContext = await browser.newContext({ baseURL: baseUrl });
    const reactivatedPage = await reactivatedContext.newPage();
    reactivatedPage.setDefaultTimeout(30_000);
    reactivatedPage.setDefaultNavigationTimeout(60_000);
    await loginViaUi(reactivatedPage, testUsername, resetTestPassword);
    await expectPath(reactivatedPage, testHome);
    pass("Login pengguna aktif setelah reaktivasi", testHome);
    await logout(reactivatedPage);
    await reactivatedContext.close();

    const adminRow = await openUserRow(adminPage, accounts[0].username);
    await adminRow.getByRole("button", { name: /Aksi untuk/ }).click();
    const selfItem = adminPage.getByRole("menuitem", {
      name: "Akun Anda sendiri",
    });
    const selfProtected = await selfItem.isVisible().catch(() => false);
    const deactivateSelf = await adminPage
      .getByRole("menuitem", { name: "Nonaktifkan" })
      .isVisible()
      .catch(() => false);

    if (selfProtected && !deactivateSelf) {
      pass("Admin tidak dapat menonaktifkan akun sendiri", "menu dinonaktifkan");
    } else {
      fail("Admin tidak dapat menonaktifkan akun sendiri", "menu tidak sesuai");
    }

    await adminPage.keyboard.press("Escape");
    await logout(adminPage);
    pass("Logout Admin", "/login");
    await adminContext.close();

    console.log("");
    console.log("== Login Kasir dan Kitchen ==");

    const kasirContext = await browser.newContext({ baseURL: baseUrl });
    const kasirPage = await kasirContext.newPage();
    kasirPage.setDefaultTimeout(30_000);
    kasirPage.setDefaultNavigationTimeout(60_000);
    await loginViaUi(kasirPage, accounts[1].username, accounts[1].password);
    await expectPath(kasirPage, "/pos");
    pass("Login Kasir 1", "/pos");

    await kasirPage.goto("/admin");
    await expectPath(kasirPage, "/unauthorized");
    pass("Kasir ditolak dari /admin", "/unauthorized");

    await kasirPage.goto("/kitchen");
    await expectPath(kasirPage, "/unauthorized");
    pass("Kasir ditolak dari /kitchen", "/unauthorized");

    await kasirPage.goto("/admin/users");
    await expectPath(kasirPage, "/unauthorized");
    pass("Kasir ditolak dari /admin/users", "/unauthorized");
    await logout(kasirPage);
    await kasirContext.close();

    const kasir2Context = await browser.newContext({ baseURL: baseUrl });
    const kasir2Page = await kasir2Context.newPage();
    kasir2Page.setDefaultTimeout(30_000);
    kasir2Page.setDefaultNavigationTimeout(60_000);
    await loginViaUi(kasir2Page, accounts[2].username, accounts[2].password);
    await expectPath(kasir2Page, "/pos");
    pass("Login Kasir 2", "/pos");
    await logout(kasir2Page);
    await kasir2Context.close();

    const kitchenContext = await browser.newContext({ baseURL: baseUrl });
    const kitchenPage = await kitchenContext.newPage();
    kitchenPage.setDefaultTimeout(30_000);
    kitchenPage.setDefaultNavigationTimeout(60_000);
    await loginViaUi(
      kitchenPage,
      accounts[3].username,
      accounts[3].password,
    );
    await expectPath(kitchenPage, "/kitchen");
    pass("Login Kitchen 1", "/kitchen");

    await kitchenPage.goto("/pos");
    await expectPath(kitchenPage, "/unauthorized");
    pass("Kitchen ditolak dari /pos", "/unauthorized");

    await kitchenPage.goto("/admin");
    await expectPath(kitchenPage, "/unauthorized");
    pass("Kitchen ditolak dari /admin", "/unauthorized");

    await kitchenPage.goto("/admin/users");
    await expectPath(kitchenPage, "/unauthorized");
    pass("Kitchen ditolak dari /admin/users", "/unauthorized");
    await logout(kitchenPage);
    await kitchenContext.close();

    const kitchen2Context = await browser.newContext({ baseURL: baseUrl });
    const kitchen2Page = await kitchen2Context.newPage();
    kitchen2Page.setDefaultTimeout(30_000);
    kitchen2Page.setDefaultNavigationTimeout(60_000);
    await loginViaUi(
      kitchen2Page,
      accounts[4].username,
      accounts[4].password,
    );
    await expectPath(kitchen2Page, "/kitchen");
    pass("Login Kitchen 2", "/kitchen");
    await logout(kitchen2Page);
    await kitchen2Context.close();

    console.log("");
    console.log("== Rate limiting ==");

    const rateTestStartedAt = new Date().toISOString();

    const { error: rateCleanupError } = await admin
      .from("login_attempts")
      .delete()
      .in("username", [probeUsername, testUsername]);

    if (rateCleanupError) {
      fail("Persiapan rate limiting", rateCleanupError.message);
    } else {
      pass("Persiapan rate limiting", "login_attempts uji dibersihkan");
    }

    const rateContext = await browser.newContext({ baseURL: baseUrl });
    const ratePage = await rateContext.newPage();
    ratePage.setDefaultTimeout(30_000);
    ratePage.setDefaultNavigationTimeout(60_000);
    await ratePage.goto("/login");

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await ratePage.locator("#username").fill(probeUsername);
      await ratePage.locator("#password").fill("wrong-password-123");
      await ratePage.getByRole("button", { name: "Masuk ke Nine Licious" }).click();
      await ratePage
        .getByText("Username atau password salah.")
        .waitFor({ state: "visible" });
    }

    await ratePage
      .getByRole("button", { name: "Masuk ke Nine Licious" })
      .waitFor({ state: "visible" });

    const { count: failedAttempts, error: failedAttemptsError } = await admin
      .from("login_attempts")
      .select("id", { count: "exact", head: true })
      .eq("username", probeUsername)
      .eq("success", false);

    if (!failedAttemptsError && failedAttempts === 5) {
      pass(
        "Lima percobaan gagal tercatat",
        `${failedAttempts} baris login_attempts`,
      );
    } else {
      fail(
        "Lima percobaan gagal tercatat",
        failedAttemptsError?.message ?? `${failedAttempts ?? 0} baris`,
      );
    }

    await ratePage.locator("#username").fill(probeUsername);
    await ratePage.locator("#password").fill("wrong-password-123");
    await ratePage.getByRole("button", { name: "Masuk ke Nine Licious" }).click();
    const lockedMessage = ratePage.getByText(/Terlalu banyak percobaan masuk/);
    await lockedMessage.waitFor({ state: "visible" });

    if (await lockedMessage.isVisible()) {
      pass("Percobaan keenam dikunci", "lockout 15 menit aktif");
    } else {
      fail("Percobaan keenam dikunci", "pesan lockout tidak tampil");
    }

    await rateContext.close();

    console.log("");
    console.log("== Audit log ==");

    const { data: auditRows, error: auditError } = await admin
      .from("audit_logs")
      .select("action, username, details, created_at")
      .order("created_at", { ascending: false })
      .limit(300);

    if (auditError) {
      fail("Membaca audit_logs", auditError.message);
    } else {
      const rows = auditRows ?? [];
      const hasActionForUser = (action, username) =>
        rows.some(
          (row) => row.action === action && row.username === username,
        );
      const hasTargetAction = (action, target) =>
        rows.some(
          (row) =>
            row.action === action &&
            row.details &&
            row.details.target_username === target,
        );

      for (const accountData of accounts) {
        const loginOk = hasActionForUser("auth.login", accountData.username);
        const logoutOk = hasActionForUser("auth.logout", accountData.username);

        if (loginOk && logoutOk) {
          pass(
            `Audit login/logout ${accountData.label}`,
            "auth.login + auth.logout",
          );
        } else {
          fail(
            `Audit login/logout ${accountData.label}`,
            `login=${loginOk}, logout=${logoutOk}`,
          );
        }
      }

      const failedCount = rows.filter(
        (row) =>
          row.action === "auth.login_failed" &&
          row.username === probeUsername &&
          row.created_at >= rateTestStartedAt,
      ).length;
      const lockedCount = rows.filter(
        (row) =>
          row.action === "auth.login_locked" &&
          row.username === probeUsername &&
          row.created_at >= rateTestStartedAt,
      ).length;

      if (failedCount >= 5 && lockedCount >= 1) {
        pass(
          "Audit rate limiting",
          `failed=${failedCount}, locked=${lockedCount}`,
        );
      } else {
        fail(
          "Audit rate limiting",
          `failed=${failedCount}, locked=${lockedCount}`,
        );
      }

      const userAuditActions = [
        "user.create",
        "user.password_reset",
        "user.deactivate",
        "user.activate",
      ];
      const missingUserAudit = userAuditActions.filter(
        (action) => !hasTargetAction(action, testUsername),
      );

      if (missingUserAudit.length === 0) {
        pass(
          "Audit manajemen pengguna",
          userAuditActions.join(", "),
        );
      } else {
        fail(
          "Audit manajemen pengguna",
          `missing=${missingUserAudit.join(",")}`,
        );
      }
    }

    const { data: finalProfiles } = await admin
      .from("profiles")
      .select("username, last_login_at")
      .in(
        "username",
        accounts.map((accountData) => accountData.username),
      );

    const missingLastLogin = accounts.filter((accountData) => {
      const profile = (finalProfiles ?? []).find(
        (item) => item.username === accountData.username,
      );
      return !profile?.last_login_at;
    });

    if (missingLastLogin.length === 0) {
      pass("last_login_at diperbarui", "5 akun");
    } else {
      fail(
        "last_login_at diperbarui",
        `missing=${missingLastLogin.map((item) => item.username).join(",")}`,
      );
    }
  } finally {
    if (!testUserId) {
      const { data: leftoverProfile } = await admin
        .from("profiles")
        .select("id")
        .eq("username", testUsername)
        .maybeSingle();

      if (leftoverProfile) {
        testUserId = leftoverProfile.id;
      }
    }

    if (testUserId) {
      const { error: deleteError } = await admin.auth.admin.deleteUser(testUserId);

      if (deleteError) {
        console.error(
          `[verify-f0-ui] Gagal menghapus akun uji: ${deleteError.message}`,
        );
      }
    }

    const { error: attemptsDeleteError } = await admin
      .from("login_attempts")
      .delete()
      .in("username", [probeUsername, testUsername]);

    if (attemptsDeleteError) {
      console.error(
        `[verify-f0-ui] Gagal membersihkan login_attempts uji: ${attemptsDeleteError.message}`,
      );
    }

    await browser.close();
  }

  const { data: leftoverTestProfile } = await admin
    .from("profiles")
    .select("id")
    .eq("username", testUsername)
    .maybeSingle();

  if (leftoverTestProfile) {
    fail("Cleanup akun uji", "profil f0.verify masih ada");
  } else {
    pass("Cleanup akun uji", "f0.verify dihapus");
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
  console.error(`Verifikasi UI gagal: ${error.message ?? error}`);
  process.exitCode = 1;
});
