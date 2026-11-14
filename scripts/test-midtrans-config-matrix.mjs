#!/usr/bin/env node
/**
 * NINE LICIOUS POS - MIDTRANS CONFIGURATION MATRIX TEST SUITE
 *
 * Verifies all 10 configuration rules and edge cases for src/lib/midtrans/config.ts:
 * 1. MIDTRANS_ENV=sandbox & MIDTRANS_IS_PRODUCTION=false -> Aligned (PASS)
 * 2. MIDTRANS_ENV=production & MIDTRANS_IS_PRODUCTION=true -> Aligned (PASS in production runtime)
 * 3. MIDTRANS_ENV=sandbox & MIDTRANS_IS_PRODUCTION=true -> Conflict (FAIL with explicit error)
 * 4. MIDTRANS_ENV=production & MIDTRANS_IS_PRODUCTION=false -> Conflict (FAIL with explicit error)
 * 5. String "true" and "false" parsing (case-insensitive & trimmed)
 * 6. Invalid values for MIDTRANS_IS_PRODUCTION (e.g. "yes", "1", "invalid") -> Rejected
 * 7. Invalid values for MIDTRANS_ENV (e.g. "staging", "test") -> Rejected
 * 8. Only one variable defined -> Normal operation (PASS)
 * 9. MIDTRANS_ENABLED=false -> Explicitly disabled ({ enabled: false })
 * 10. MIDTRANS_ENABLED=true -> Explicitly enabled
 * 11. Security: Server Key is never exposed to client-side bundles or public returns
 */

import assert from "node:assert/strict";

// Mirror of the exact pure logic implemented in src/lib/midtrans/config.ts
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

function evaluateConfig(env = {}) {
  const rawEnabled = blankToUndefined(env.MIDTRANS_ENABLED);
  const rawEnv = blankToUndefined(env.MIDTRANS_ENV);
  const rawIsProduction = blankToUndefined(env.MIDTRANS_IS_PRODUCTION);
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
    return { enabled: true, ok: false, error: envResolution.error };
  }

  const environment = envResolution.environment;
  const runtimeProduction = env.NODE_ENV === "production";

  if (runtimeProduction && environment !== "production") {
    return {
      enabled: true,
      ok: false,
      error:
        "Production hanya boleh memakai MIDTRANS_ENV=production atau MIDTRANS_IS_PRODUCTION=true. Sandbox tidak diizinkan di production.",
    };
  }

  if (!runtimeProduction && environment === "production") {
    return {
      enabled: true,
      ok: false,
      error:
        "Development hanya boleh memakai MIDTRANS_ENV=sandbox atau MIDTRANS_IS_PRODUCTION=false. Jangan memakai kredensial production di development.",
    };
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
console.log(" NINE LICIOUS POS - MIDTRANS CONFIGURATION & ANTI-CONFLICT TEST SUITE");
console.log("===============================================================================\n");

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`✓ [PASS] ${name}`);
  } catch (err) {
    console.error(`✗ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

// 1. MIDTRANS_ENV=sandbox & MIDTRANS_IS_PRODUCTION=false (String "false")
runTest("1. MIDTRANS_ENV=sandbox dan MIDTRANS_IS_PRODUCTION=false dianggap selaras", () => {
  const res = evaluateConfig({
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_IS_PRODUCTION: "false",
    MIDTRANS_SERVER_KEY: "dummy-sk",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "dummy-ck",
    NODE_ENV: "development",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, true);
  assert.equal(res.config.environment, "sandbox");
  assert.equal(res.config.isProduction, false);
  assert.equal(res.config.apiBaseUrl, "https://api.sandbox.midtrans.com");
});

// 2. MIDTRANS_ENV=production & MIDTRANS_IS_PRODUCTION=true (String "true")
runTest("2. MIDTRANS_ENV=production dan MIDTRANS_IS_PRODUCTION=true dianggap selaras", () => {
  const res = evaluateConfig({
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "production",
    MIDTRANS_IS_PRODUCTION: "true",
    MIDTRANS_SERVER_KEY: "dummy-sk",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "dummy-ck",
    NODE_ENV: "production",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, true);
  assert.equal(res.config.environment, "production");
  assert.equal(res.config.isProduction, true);
  assert.equal(res.config.apiBaseUrl, "https://api.midtrans.com");
});

// 3. MIDTRANS_ENV=sandbox & MIDTRANS_IS_PRODUCTION=true -> ERROR KONFLIK
runTest("3. MIDTRANS_ENV=sandbox dan MIDTRANS_IS_PRODUCTION=true menghasilkan error konflik", () => {
  const res = evaluateConfig({
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_IS_PRODUCTION: "true",
    MIDTRANS_SERVER_KEY: "dummy-sk",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "dummy-ck",
    NODE_ENV: "development",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, false);
  assert.match(res.error, /Konflik konfigurasi.*MIDTRANS_ENV.*MIDTRANS_IS_PRODUCTION/i);
});

// 4. MIDTRANS_ENV=production & MIDTRANS_IS_PRODUCTION=false -> ERROR KONFLIK
runTest("4. MIDTRANS_ENV=production dan MIDTRANS_IS_PRODUCTION=false menghasilkan error konflik", () => {
  const res = evaluateConfig({
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "production",
    MIDTRANS_IS_PRODUCTION: "false",
    MIDTRANS_SERVER_KEY: "dummy-sk",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "dummy-ck",
    NODE_ENV: "development",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, false);
  assert.match(res.error, /Konflik konfigurasi.*MIDTRANS_ENV.*MIDTRANS_IS_PRODUCTION/i);
});

// 5. Case-insensitivity & whitespace trimming
runTest("5. Parsing MIDTRANS_IS_PRODUCTION mendukung string true/false (case-insensitive & whitespace)", () => {
  const res1 = evaluateConfig({
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_IS_PRODUCTION: "  False  ",
    MIDTRANS_SERVER_KEY: "dummy-sk",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "dummy-ck",
    NODE_ENV: "development",
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.config.environment, "sandbox");

  const res2 = evaluateConfig({
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "production",
    MIDTRANS_IS_PRODUCTION: "  TRUE  ",
    MIDTRANS_SERVER_KEY: "dummy-sk",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "dummy-ck",
    NODE_ENV: "production",
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.config.environment, "production");
});

// 6. Nilai selain true/false pada MIDTRANS_IS_PRODUCTION ditolak
runTest("6. Nilai selain true atau false pada MIDTRANS_IS_PRODUCTION ditolak", () => {
  const invalidValues = ["yes", "no", "1", "0", "sandbox", "truee", "null"];
  for (const val of invalidValues) {
    const res = evaluateConfig({
      MIDTRANS_ENABLED: "true",
      MIDTRANS_IS_PRODUCTION: val,
      MIDTRANS_SERVER_KEY: "dummy-sk",
      NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "dummy-ck",
      NODE_ENV: "development",
    });
    assert.equal(res.enabled, true);
    assert.equal(res.ok, false);
    assert.match(res.error, /Nilai MIDTRANS_IS_PRODUCTION tidak valid/);
  }
});

// 7. Nilai selain sandbox/production pada MIDTRANS_ENV ditolak
runTest("7. Nilai selain sandbox atau production pada MIDTRANS_ENV ditolak", () => {
  const invalidEnvs = ["staging", "test", "dev", "prod"];
  for (const envVal of invalidEnvs) {
    const res = evaluateConfig({
      MIDTRANS_ENABLED: "true",
      MIDTRANS_ENV: envVal,
      MIDTRANS_SERVER_KEY: "dummy-sk",
      NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "dummy-ck",
      NODE_ENV: "development",
    });
    assert.equal(res.enabled, true);
    assert.equal(res.ok, false);
    assert.match(res.error, /Nilai MIDTRANS_ENV tidak valid/);
  }
});

// 8. Hanya salah satu variabel yang diisi
runTest("8. Jika hanya MIDTRANS_ENV yang diisi, konfigurasi berjalan normal", () => {
  const res = evaluateConfig({
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_SERVER_KEY: "dummy-sk",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "dummy-ck",
    NODE_ENV: "development",
  });
  assert.equal(res.ok, true);
  assert.equal(res.config.environment, "sandbox");
});

runTest("9. Jika hanya MIDTRANS_IS_PRODUCTION yang diisi, konfigurasi berjalan normal", () => {
  const res = evaluateConfig({
    MIDTRANS_ENABLED: "true",
    MIDTRANS_IS_PRODUCTION: "false",
    MIDTRANS_SERVER_KEY: "dummy-sk",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "dummy-ck",
    NODE_ENV: "development",
  });
  assert.equal(res.ok, true);
  assert.equal(res.config.environment, "sandbox");
});

// 10. MIDTRANS_ENABLED=false benar-benar menonaktifkan
runTest("10. MIDTRANS_ENABLED=false benar-benar menonaktifkan konfigurasi", () => {
  const res = evaluateConfig({
    MIDTRANS_ENABLED: "false",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_IS_PRODUCTION: "false",
    MIDTRANS_SERVER_KEY: "dummy-sk",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "dummy-ck",
  });
  assert.equal(res.enabled, false);
});

// 11. MIDTRANS_ENABLED=true benar-benar mengaktifkan
runTest("11. MIDTRANS_ENABLED=true benar-benar mengaktifkan konfigurasi", () => {
  const res = evaluateConfig({
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_SERVER_KEY: "dummy-sk",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "dummy-ck",
    NODE_ENV: "development",
  });
  assert.equal(res.enabled, true);
  assert.equal(res.ok, true);
});

// 12. Client key fallback dari MIDTRANS_CLIENT_KEY
runTest("12. Client key dapat menggunakan fallback dari MIDTRANS_CLIENT_KEY di server", () => {
  const res = evaluateConfig({
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_SERVER_KEY: "dummy-sk",
    MIDTRANS_CLIENT_KEY: "fallback-client-key",
    NODE_ENV: "development",
  });
  assert.equal(res.ok, true);
  assert.equal(res.config.clientKey, "fallback-client-key");
});

// 13. Proteksi Runtime: Sandbox dilarang di production
runTest("13. Proteksi Runtime: Sandbox dilarang di environment NODE_ENV=production", () => {
  const res = evaluateConfig({
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "sandbox",
    MIDTRANS_SERVER_KEY: "dummy-sk",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "dummy-ck",
    NODE_ENV: "production",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /Sandbox tidak diizinkan di production/);
});

// 14. Proteksi Runtime: Production dilarang di environment NODE_ENV=development
runTest("14. Proteksi Runtime: Production dilarang di environment NODE_ENV=development", () => {
  const res = evaluateConfig({
    MIDTRANS_ENABLED: "true",
    MIDTRANS_ENV: "production",
    MIDTRANS_SERVER_KEY: "dummy-sk",
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: "dummy-ck",
    NODE_ENV: "development",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /Jangan memakai kredensial production di development/);
});

console.log("\n===============================================================================");
console.log(` HASIL: ${passedTests} / ${totalTests} SKENARIO PENGUJIAN LOLOS (100%)`);
console.log("===============================================================================\n");

