export const APP_NAME = "Nine Licious";
export const APP_DESCRIPTION =
  "Point of sale restoran untuk pesanan, pembayaran, dapur, stok, dan laporan.";

// Domain email sintetis dan nama cookie dipertahankan agar akun serta sesi yang
// sudah ada tetap kompatibel. Keduanya adalah identifier internal, bukan
// branding yang ditampilkan ke pengguna.
export const AUTH_EMAIL_DOMAIN = "saji.app";
export const LAST_SEEN_COOKIE = "saji_last_seen";

export const APP_ENVIRONMENT_LABELS = {
  development: "Development",
  production: "Produksi",
} as const;
