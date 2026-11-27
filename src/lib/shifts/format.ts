import type { GlobalActiveShiftStatus } from "./types";

/**
 * Memformat label kasir yang sedang bertugas pada shift aktif global.
 */
export function formatOnDutyCashierLabel(
  name: string | null | undefined,
  username: string | null | undefined,
): string {
  const cleanName = name?.trim() || "";
  const cleanUser = username?.trim() || "";
  if (cleanName && cleanUser && cleanName !== cleanUser) {
    return `${cleanName} (@${cleanUser})`;
  }
  if (cleanName) return cleanName;
  if (cleanUser) return `@${cleanUser}`;
  return "kasir lain";
}

/**
 * Bernilai true apabila saat ini terdapat shift aktif global dan bukan milik
 * pengguna yang sedang login.
 */
export function isShiftLockedByOtherCashier(
  status: GlobalActiveShiftStatus | null | undefined,
): boolean {
  return Boolean(status?.hasActiveShift && !status.isOwnedByCurrentUser);
}
