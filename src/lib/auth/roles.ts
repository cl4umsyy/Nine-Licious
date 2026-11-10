export const USER_ROLES = ["admin", "kasir", "kitchen"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Admin",
  kasir: "Kasir",
  kitchen: "Staf Dapur",
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin: "Akses penuh ke seluruh modul Saji.",
  kasir: "Transaksi, meja, pembayaran, dan shift.",
  kitchen: "Antrean pesanan dan status masak.",
};

export const ROLE_HOME: Record<UserRole, string> = {
  admin: "/admin",
  kasir: "/pos",
  kitchen: "/kitchen",
};

export function isUserRole(value: unknown): value is UserRole {
  return (
    typeof value === "string" &&
    (USER_ROLES as readonly string[]).includes(value)
  );
}

export function roleFromAppMetadata(
  appMetadata: Record<string, unknown> | null | undefined,
): UserRole | null {
  if (!appMetadata) {
    return null;
  }

  const role = appMetadata.role;
  return isUserRole(role) ? role : null;
}

export function canAccessPath(pathname: string, role: UserRole): boolean {
  if (pathname === "/unauthorized") {
    return true;
  }

  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    return role === "admin";
  }

  if (pathname === "/pos" || pathname.startsWith("/pos/")) {
    return role === "admin" || role === "kasir";
  }

  if (pathname === "/kitchen" || pathname.startsWith("/kitchen/")) {
    return role === "admin" || role === "kitchen";
  }

  if (pathname === "/queue" || pathname.startsWith("/queue/")) {
    return true;
  }

  return true;
}

/**
 * Only allow internal, role-appropriate redirect targets after login.
 */
export function safeNextPath(
  next: string | null | undefined,
  role: UserRole,
): string {
  const fallback = ROLE_HOME[role];

  if (!next || !next.startsWith("/") || next.startsWith("//")) {
    return fallback;
  }

  try {
    const parsed = new URL(next, "http://saji.local");

    if (parsed.origin !== "http://saji.local") {
      return fallback;
    }

    if (parsed.pathname === "/login" || parsed.pathname === "/") {
      return fallback;
    }

    if (!canAccessPath(parsed.pathname, role)) {
      return fallback;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
