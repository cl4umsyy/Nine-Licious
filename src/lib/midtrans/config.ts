import "server-only";

export type MidtransEnvironment = "sandbox" | "production";

function blankToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

type ResolveEnvResult =
  | { ok: true; environment: MidtransEnvironment }
  | { ok: false; error: string };

function resolveEnvironment(
  envVal: unknown,
  isProdVal: unknown,
): ResolveEnvResult {
  let parsedEnv: MidtransEnvironment | undefined;
  let parsedIsProd: boolean | undefined;

  // 1. Parsing MIDTRANS_ENV jika diisi
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

  // 2. Parsing MIDTRANS_IS_PRODUCTION jika diisi
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

  // 3. Validasi konflik jika kedua variabel terdefinisi
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

  // 4. Jika hanya salah satu variabel yang diisi
  if (parsedEnv !== undefined) {
    return { ok: true, environment: parsedEnv };
  }

  if (parsedIsProd !== undefined) {
    return { ok: true, environment: parsedIsProd ? "production" : "sandbox" };
  }

  // 5. Jika kedua variabel tidak diisi
  return {
    ok: false,
    error:
      "MIDTRANS_ENV (sandbox/production) atau MIDTRANS_IS_PRODUCTION (false/true) wajib dikonfigurasi.",
  };
}

/**
 * Validasi ketat kredensial Midtrans:
 * - Sandbox mewajibkan pasangan Server Key 'SB-Mid-server-' dan Client Key 'SB-Mid-client-'.
 * - Production mewajibkan pasangan Server Key 'Mid-server-' dan Client Key 'Mid-client-'.
 * - Kredensial tidak boleh dicampur (misal server Sandbox tapi client Production).
 */
function validateCredentialsForEnvironment(
  environment: MidtransEnvironment,
  serverKey: string,
  clientKey: string,
): { ok: true } | { ok: false; error: string } {
  const isServerSandbox = serverKey.startsWith("SB-Mid-server-") || serverKey.startsWith("SB-");
  const isClientSandbox = clientKey.startsWith("SB-Mid-client-") || clientKey.startsWith("SB-");
  const isServerProd = serverKey.startsWith("Mid-server-") && !isServerSandbox;
  const isClientProd = clientKey.startsWith("Mid-client-") && !isClientSandbox;

  // 1. Deteksi konflik pasangan kredensial (misal server Sandbox tapi client Production)
  if ((isServerSandbox && isClientProd) || (isServerProd && isClientSandbox)) {
    return {
      ok: false,
      error:
        "Konfigurasi kredensial bertentangan: MIDTRANS_SERVER_KEY dan Client Key tidak boleh mencampur kredensial Sandbox dan Production.",
    };
  }

  // 2. Validasi kesesuaian kredensial dengan environment yang dipilih
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

export type MidtransConfig = {
  environment: MidtransEnvironment;
  isProduction: boolean;
  serverKey: string;
  clientKey: string;
  apiBaseUrl: string;
  snapScriptUrl: string;
};

export type MidtransConfigState =
  | { enabled: false }
  | { enabled: true; ok: true; config: MidtransConfig }
  | { enabled: true; ok: false; error: string };

const API_BASE_URL: Record<MidtransEnvironment, string> = {
  sandbox: "https://api.sandbox.midtrans.com",
  production: "https://api.midtrans.com",
};

const SNAP_SCRIPT_URL: Record<MidtransEnvironment, string> = {
  sandbox: "https://app.sandbox.midtrans.com/snap/snap.js",
  production: "https://app.midtrans.com/snap/snap.js",
};

/**
 * Midtrans configuration is server-only. The server key must never reach the
 * browser, and the environment must match the runtime:
 *
 * - development may only use Sandbox;
 * - production may only use Production, KECUALI jika MIDTRANS_ALLOW_SANDBOX=true
 *   secara eksplisit disetel untuk mengizinkan testing Sandbox di deployment Vercel.
 *
 * Payment status must never be changed from a client callback. F2 must verify
 * the Midtrans webhook signature and re-fetch the transaction status before
 * marking an order as paid.
 */
export function getMidtransConfigState(): MidtransConfigState {
  const rawEnabled = blankToUndefined(process.env.MIDTRANS_ENABLED);
  const rawEnv = blankToUndefined(process.env.MIDTRANS_ENV);
  const rawIsProduction = blankToUndefined(process.env.MIDTRANS_IS_PRODUCTION);
  const rawAllowSandbox = blankToUndefined(process.env.MIDTRANS_ALLOW_SANDBOX);
  const rawServerKey = blankToUndefined(process.env.MIDTRANS_SERVER_KEY);
  const rawClientKey = blankToUndefined(
    process.env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY || process.env.MIDTRANS_CLIENT_KEY,
  );

  // Jika MIDTRANS_ENABLED tidak didefinisikan secara eksplisit, aktifkan jika MIDTRANS_SERVER_KEY ada
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
  const runtimeProduction = process.env.NODE_ENV === "production";

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
    // Development runtime (NODE_ENV !== "production")
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
      apiBaseUrl: API_BASE_URL[environment],
      snapScriptUrl: SNAP_SCRIPT_URL[environment],
    },
  };
}

export function getMidtransConfig(): MidtransConfig | null {
  const state = getMidtransConfigState();
  return state.enabled && state.ok ? state.config : null;
}
