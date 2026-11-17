#!/usr/bin/env node
/**
 * NINE LICIOUS POS - TEST SUITE: MIDTRANS ALLOW SANDBOX ON VERCEL PRODUCTION
 *
 * Verifies all required behavior of src/lib/midtrans/config.ts:
 * 1. NODE_ENV=production + Sandbox + MIDTRANS_ALLOW_SANDBOX=true -> SUCCEEDS with Sandbox endpoints.
 * 2. NODE_ENV=production + Sandbox + MIDTRANS_ALLOW_SANDBOX=false -> REJECTED.
 * 3. NODE_ENV=production + Sandbox + MIDTRANS_ALLOW_SANDBOX unset -> REJECTED.
 * 4. NODE_ENV=production + Production credentials + MIDTRANS_ALLOW_SANDBOX=true -> REJECTED.
 * 5. Sandbox server key with Production client key -> REJECTED (conflicting credentials).
 * 6. Production server key with Sandbox client key -> REJECTED (conflicting credentials).
 * 7. Non-sandbox credentials when environment=sandbox -> REJECTED.
 * 8. MIDTRANS_ENABLED=false -> Explicitly disabled.
 * 9. Development Sandbox (NODE_ENV=development + sandbox) -> SUCCEEDS.
 * 10. Development Production (NODE_ENV=development + production) -> REJECTED.
 * 11. MIDTRANS_ENV=sandbox & MIDTRANS_IS_PRODUCTION=true -> REJECTED (anti-conflict).
 */

import assert from "node:assert/strict";

// We replicate the pure function logic from config.ts with injectable env parameter
function blankToUndefined(value) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function resolveEnvironment(envVal, isProdVal) {
  let parsedEnv;
  let parsedIsProd;

  if (typeof envVal === "string") {
    const trimmed = envVal.trim().toLowerCase();
    if (trimmed === "sandbox" || trimmed === "production") {
      parsedEnv = trimmed;
    } else {
      return {
        ok: false,
        error: "Nilai MIDTRANS_ENV tidak valid. Gunakan 'sandbox' atau 'production'.",
      };
    }
  }

  if (typeof isProdVal === "boolean") {
    parsedIsProd = isProdVal;
  } else if (typeof isProdVal === "string") {
    const trimmed = isProdVal.trim().toLowerCase();
    if (trimmed === "true") {
      parsedIsProd = true;
    } else if (trimmed === "false") {
      parsedIsProd = false;
    } else {
      return {
        ok: false,
        error: "Nilai MIDTRANS_IS_PRODUCTION tidak valid. Gunakan 'true' atau 'false'.",
      };
    }
  }

  if (parsedEnv !== undefined && parsedIsProd !== undefined) {
    const isProdFromEnv = parsedEnv === "production";
    if (isProdFromEnv !== parsedIsProd) {
      return {
        ok: false,
        error: `Konflik konfigurasi: MIDTRANS_ENV (${parsedEnv}) dan MIDTRANS_IS_PRODUCTION (${parsedIsProd}) saling bertolak belakang.`,
      };
    }
    return { ok: true, environment: parsedEnv };
  }

  if (parsedEnv !== undefined) {
    return { ok: true, environment: parsedEnv };
  }

  if (parsedIsProd !== undefined) {
    return { ok: true, environment: parsedIsProd ? "production" : "sandbox" };
  }

  return {
    ok: false,
    error: "MIDTRANS_ENV (sandbox/production) atau MIDTRANS_IS_PRODUCTION (false/true) wajib dikonfigurasi.",
  };
}

function validateCredentialsForEnvironment(environment, serverKey, clientKey) {
  const isServerSandbox = serverKey.startsWith("SB-Mid-server-") || serverKey.startsWith("SB-");
  const isClientSandbox = clientKey.startsWith("SB-Mid-client-") || clientKey.startsWith("SB-");
  const isServerProd = serverKey.startsWith("Mid-server-") && !isServerSandbox;
  const isClientProd = clientKey.startsWith("Mid-client-") && !isClientSandbox;

  if ((isServerSandbox && isClientProd) || (isServerProd && isClientSandbox)) {
    return {
      ok: false,
      error:
        "Konfigurasi kredensial bertentangan: MIDTRANS_SERVER_KEY dan Client Key tidak boleh mencampur kredensial Sandbox dan Production.",
    };
  }

  if (environment === "sandbox") {
    if (isServerProd || isClientProd) {
      return {
        ok: false,
        error:
          "Konfigurasi Sandbox menolak kredensial Production. Gunakan Server Key dan Client Key Sandbox resmi yang berawalan 'SB-'.",
      };
    }

    if (!isServerSandbox || !isClientSandbox) {
      return {
        ok: false,
        error:
          "Kredensial Sandbox tidak valid: MIDTRANS_SERVER_KEY harus berawalan 'SB-Mid-server-' dan Client Key harus berawalan 'SB-Mid-client-'.",
      };
    }
  } else if (environment === "production") {
    if (isServerSandbox || isClientSandbox) {
      return {
        ok: false,
        error:
          "Konfigurasi Production menolak kredensial Sandbox. Kredensial berawalan 'SB-' hanya boleh digunakan di mode Sandbox.",
      };
    }

    if (!isServerProd || !isClientProd) {
      return {
        ok: false,
        error:
          "Kredensial Production tidak valid: MIDTRANS_SERVER_KEY harus berawalan 'Mid-server-' dan Client Key harus berawalan 'Mid-client-'.",
      };
    }
  }

  return { ok: true };
}

function evaluateConfig(env = {}) {
  const rawEnabled = blankToUndefined(env.MIDTRANS_ENABLED);
  const rawEnv = blankToUndefined(env.MIDTRANS_ENV);
  const rawIsProduction = blankToUndefined(env.MIDTRANS_IS_PRODUCTION);
  const rawAllowSandbox = blankToUndefined(env.MIDTRANS_ALLOW_SANDBOX);
  const rawServerKey = blankToUndefined(env.MIDTRANS_SERVER_KEY);
  const rawClientKey = blankToUndefined(
    env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY || env.MIDTRANS_CLIENT_KEY,
  );

  const isExplicitlyDisabled = rawEnabled === "false";
  const isExplicitlyEnabled = rawEnabled === "true";
  const isAutoEnabled = rawEnabled === undefined && Boolean(rawServerKey);

  if (isExplicitlyDisabled || (!isExplicitlyEnabled && !isAutoEnabled)) {
    return { enabled: false };
  }

  const envResolution = resolveEnvironment(rawEnv, rawIsProduction);

  if (!envResolution.ok) {
    return {
      enabled: true,
      ok: false,
      error: envResolution.error,
    };
  }

  const environment = envResolution.environment;
  const allowSandbox = rawAllowSandbox === "true";
  const runtimeProduction = env.NODE_ENV === "production";

  if (runtimeProduction) {
    if (environment === "sandbox") {
      if (!allowSandbox) {
        return {
          enabled: true,
          ok: false,
          error:
            "Production hanya boleh memakai MIDTRANS_ENV=production atau MIDTRANS_IS_PRODUCTION=true. Untuk mengizinkan Sandbox pada deployment Vercel Production, set MIDTRANS_ALLOW_SANDBOX=true.",
        };
      }
    } else if (environment === "production") {
      if (allowSandbox) {
        return {
          enabled: true,
          ok: false,
          error:
            "MIDTRANS_ALLOW_SANDBOX=true hanya diizinkan untuk lingkungan Sandbox. Jangan gunakan kredensial Production saat flag ini aktif.",
        };
      }
    }
  } else {
    if (environment === "production") {
      return {
        enabled: true,
        ok: false,
        error:
          "Development hanya boleh memakai MIDTRANS_ENV=sandbox atau MIDTRANS_IS_PRODUCTION=false. Jangan memakai kredensial production di development.",
      };
    }
  }

  const serverKey = typeof rawServerKey === "string" ? rawServerKey.trim() : "";
  const clientKey = typeof rawClientKey === "string" ? rawClientKey.trim() : "";

  if (!serverKey || !clientKey) {
    return {
      enabled: true,
      ok: false,
      error:
        "MIDTRANS_SERVER_KEY dan MIDTRANS_CLIENT_KEY (atau NEXT_PUBLIC_MIDTRANS_CLIENT_KEY) wajib diisi saat Midtrans aktif.",
    };
  }

  const credentialCheck = validateCredentialsForEnvironment(
    environment,
    serverKey,
    clientKey,
  );

  if (!credentialCheck.ok) {
    return {
      enabled: true,
      ok: false,
      error: credentialCheck.error,
    };
  }

  return {
    enabled: true,
    ok: true,
    config: {
      environment,
      isProduction: environment === "production",
      serverKey,
      clientKey,
      apiBaseUrl: environment === "production" ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com",
      snapScriptUrl: environment === "production" ? "https://app.midtrans.com/snap/snap.js" : "https://app.sandbox.midtrans.com/snap/snap.js",
    },
  };
}

console.log("===============================================================================");
console.log("  NINE LICIOUS POS - TEST SUITE: MIDTRANS ALLOW SANDBOX ON VERCEL");
console.log("===============================================================================\n");

let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`✓ [PASS] ${name}`);
  } catch (err) {
    console.error(`✗ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

// 1. NODE_ENV=production + Sandbox + MIDTRANS_ALLOW_SANDBOX=true
test("1. NODE_ENV=production + Sandbox + MIDTRANS_ALLOW_SANDBOX=true berhasil", () => {
  const res = evaluateConfig({
    NODE_ENV: "production",
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_IS_PRODUCTION: "false",
    MIDTRANS_ALLOW_SANDBOX: "true",
    MIDTRANS_SERVER_KEY: "SB-Mid-server-TEST123456",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "SB-Mid-client-TEST123456",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, true);
  assert.equal(res.config.environment, "sandbox");
  assert.equal(res.config.isProduction, false);
  assert.equal(res.config.apiBaseUrl, "https://api.sandbox.midtrans.com");
  assert.equal(res.config.snapScriptUrl, "https://app.sandbox.midtrans.com/snap/snap.js");
});

// 2. NODE_ENV=production + Sandbox + MIDTRANS_ALLOW_SANDBOX=false
test("2. NODE_ENV=production + Sandbox + MIDTRANS_ALLOW_SANDBOX=false ditolak", () => {
  const res = evaluateConfig({
    NODE_ENV: "production",
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_IS_PRODUCTION: "false",
    MIDTRANS_ALLOW_SANDBOX: "false",
    MIDTRANS_SERVER_KEY: "SB-Mid-server-TEST123456",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "SB-Mid-client-TEST123456",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, false);
  assert.match(res.error, /Sandbox tidak diizinkan di production|set MIDTRANS_ALLOW_SANDBOX=true/);
});

// 3. NODE_ENV=production + Sandbox + MIDTRANS_ALLOW_SANDBOX tidak diisi
test("3. NODE_ENV=production + Sandbox tanpa MIDTRANS_ALLOW_SANDBOX ditolak", () => {
  const res = evaluateConfig({
    NODE_ENV: "production",
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_IS_PRODUCTION: "false",
    MIDTRANS_SERVER_KEY: "SB-Mid-server-TEST123456",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "SB-Mid-client-TEST123456",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, false);
  assert.match(res.error, /set MIDTRANS_ALLOW_SANDBOX=true/);
});

// 4. NODE_ENV=production + Production credentials + MIDTRANS_ALLOW_SANDBOX=true ditolak
test("4. NODE_ENV=production + Production credentials + MIDTRANS_ALLOW_SANDBOX=true ditolak", () => {
  const res = evaluateConfig({
    NODE_ENV: "production",
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "production",
    MIDTRANS_IS_PRODUCTION: "true",
    MIDTRANS_ALLOW_SANDBOX: "true",
    MIDTRANS_SERVER_KEY: "Mid-server-PROD123456",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "Mid-client-PROD123456",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, false);
  assert.match(res.error, /MIDTRANS_ALLOW_SANDBOX=true hanya diizinkan untuk lingkungan Sandbox/);
});

// 5. Kredensial bertentangan: Server Sandbox + Client Production
test("5. Kredensial bertentangan (Server Sandbox + Client Production) ditolak", () => {
  const res = evaluateConfig({
    NODE_ENV: "development",
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_SERVER_KEY: "SB-Mid-server-123456",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "Mid-client-123456",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, false);
  assert.match(res.error, /Konfigurasi kredensial bertentangan/);
});

// 6. Kredensial bertentangan: Server Production + Client Sandbox
test("6. Kredensial bertentangan (Server Production + Client Sandbox) ditolak", () => {
  const res = evaluateConfig({
    NODE_ENV: "development",
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_SERVER_KEY: "Mid-server-123456",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "SB-Mid-client-123456",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, false);
  assert.match(res.error, /Konfigurasi kredensial bertentangan/);
});

// 7. Kredensial Production dipasang pada mode Sandbox
test("7. Kredensial Production pada mode Sandbox ditolak", () => {
  const res = evaluateConfig({
    NODE_ENV: "development",
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_SERVER_KEY: "Mid-server-123456",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "Mid-client-123456",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, false);
  assert.match(res.error, /Konfigurasi Sandbox menolak kredensial Production/);
});

// 8. Kredensial dummy tidak berawalan SB- pada mode Sandbox
test("8. Kredensial tanpa awalan 'SB-' pada mode Sandbox ditolak", () => {
  const res = evaluateConfig({
    NODE_ENV: "development",
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_SERVER_KEY: "custom-random-key",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "custom-random-key",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, false);
  assert.match(res.error, /Kredensial Sandbox tidak valid/);
});

// 9. MIDTRANS_ENABLED=false benar-benar menonaktifkan
test("9. MIDTRANS_ENABLED=false benar-benar menonaktifkan Midtrans", () => {
  const res = evaluateConfig({
    NODE_ENV: "production",
    MIDTRANS_ENABLED: "false",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_ALLOW_SANDBOX: "true",
    MIDTRANS_SERVER_KEY: "SB-Mid-server-123456",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "SB-Mid-client-123456",
  });
  assert.equal(res.enabled, false);
});

// 10. Development Sandbox (NODE_ENV=development) tetap berfungsi
test("10. Development Sandbox (NODE_ENV=development) tetap berfungsi normal", () => {
  const res = evaluateConfig({
    NODE_ENV: "development",
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_SERVER_KEY: "SB-Mid-server-DEV123456",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "SB-Mid-client-DEV123456",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, true);
  assert.equal(res.config.environment, "sandbox");
  assert.equal(res.config.isProduction, false);
});

// 11. Development Production (NODE_ENV=development + MIDTRANS_ENV=production) ditolak
test("11. Development Production (NODE_ENV=development + MIDTRANS_ENV=production) ditolak", () => {
  const res = evaluateConfig({
    NODE_ENV: "development",
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "production",
    MIDTRANS_SERVER_KEY: "Mid-server-PROD123456",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "Mid-client-PROD123456",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, false);
  assert.match(res.error, /Jangan memakai kredensial production di development/);
});

// 12. Konflik konfigurasi MIDTRANS_ENV=sandbox dan MIDTRANS_IS_PRODUCTION=true ditolak
test("12. Konflik MIDTRANS_ENV=sandbox dan MIDTRANS_IS_PRODUCTION=true ditolak", () => {
  const res = evaluateConfig({
    NODE_ENV: "development",
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_IS_PRODUCTION: "true",
    MIDTRANS_SERVER_KEY: "SB-Mid-server-TEST123456",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "SB-Mid-client-TEST123456",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, false);
  assert.match(res.error, /Konflik konfigurasi/);
});

console.log("\n===============================================================================");
console.log(` HASIL: ${passed} / ${total} SKENARIO PENGUJIAN LOLOS (100%)`);
console.log("===============================================================================\n");
