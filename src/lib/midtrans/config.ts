import "server-only";

import { z } from "zod";

const midtransEnvironmentSchema = z.enum(["sandbox", "production"]);

function blankToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const midtransEnvSchema = z.object({
  MIDTRANS_ENABLED: z.preprocess(
    blankToUndefined,
    z.enum(["true", "false"]).default("false"),
  ),
  MIDTRANS_ENV: z.preprocess(
    blankToUndefined,
    midtransEnvironmentSchema.optional(),
  ),
  MIDTRANS_SERVER_KEY: z.preprocess(
    blankToUndefined,
    z.string().trim().optional(),
  ),
  NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: z.preprocess(
    blankToUndefined,
    z.string().trim().optional(),
  ),
});

export type MidtransEnvironment = z.infer<typeof midtransEnvironmentSchema>;

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
 * - production may only use Production.
 *
 * Payment status must never be changed from a client callback. F2 must verify
 * the Midtrans webhook signature and re-fetch the transaction status before
 * marking an order as paid.
 */
export function getMidtransConfigState(): MidtransConfigState {
  const parsed = midtransEnvSchema.safeParse({
    MIDTRANS_ENABLED: process.env.MIDTRANS_ENABLED,
    MIDTRANS_ENV: process.env.MIDTRANS_ENV,
    MIDTRANS_SERVER_KEY: process.env.MIDTRANS_SERVER_KEY,
    NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: process.env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY,
  });

  if (!parsed.success) {
    return {
      enabled: true,
      ok: false,
      error: "Konfigurasi Midtrans tidak valid. Periksa variabel environment.",
    };
  }

  if (parsed.data.MIDTRANS_ENABLED !== "true") {
    return { enabled: false };
  }

  const environment = parsed.data.MIDTRANS_ENV;

  if (!environment) {
    return {
      enabled: true,
      ok: false,
      error: "MIDTRANS_ENV wajib diisi dengan sandbox atau production.",
    };
  }

  const runtimeProduction = process.env.NODE_ENV === "production";

  if (runtimeProduction && environment !== "production") {
    return {
      enabled: true,
      ok: false,
      error:
        "Production hanya boleh memakai MIDTRANS_ENV=production. Sandbox tidak diizinkan di production.",
    };
  }

  if (!runtimeProduction && environment === "production") {
    return {
      enabled: true,
      ok: false,
      error:
        "Development hanya boleh memakai MIDTRANS_ENV=sandbox. Jangan memakai kredensial production di development.",
    };
  }

  const serverKey = parsed.data.MIDTRANS_SERVER_KEY;
  const clientKey = parsed.data.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY;

  if (!serverKey || !clientKey) {
    return {
      enabled: true,
      ok: false,
      error:
        "MIDTRANS_SERVER_KEY dan NEXT_PUBLIC_MIDTRANS_CLIENT_KEY wajib diisi saat Midtrans aktif.",
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
