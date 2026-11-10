import { AUTH_EMAIL_DOMAIN } from "@/lib/constants";

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function usernameToEmail(username: string): string {
  return `${normalizeUsername(username)}@${AUTH_EMAIL_DOMAIN}`;
}

export function emailToUsername(email: string | null | undefined): string {
  if (!email) {
    return "";
  }

  return email.split("@")[0] ?? "";
}
