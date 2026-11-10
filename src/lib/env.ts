import { z } from "zod";

const publicSupabaseSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
});

export type SupabasePublicConfig = {
  url: string;
  anonKey: string;
};

export type AppEnvironment = "development" | "production";

/**
 * Returns the public Supabase configuration, or null when the project has not
 * been configured yet. Keeping this lazy lets the app boot in "setup" mode
 * without a Supabase project.
 */
export function getSupabaseConfig(): SupabasePublicConfig | null {
  const parsed = publicSupabaseSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });

  if (!parsed.success) {
    return null;
  }

  return {
    url: parsed.data.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: parsed.data.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseConfig() !== null;
}

export function getAppEnvironment(): AppEnvironment {
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

export function getSessionIdleMinutes(): number {
  const parsed = Number.parseInt(
    process.env.SESSION_IDLE_MINUTES ?? "30",
    10,
  );

  if (!Number.isFinite(parsed)) {
    return 30;
  }

  return Math.min(Math.max(parsed, 5), 480);
}

export function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}
