import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseConfig } from "@/lib/env";

export type SupabaseProxySession =
  | {
      configured: false;
      user: null;
      supabase: null;
      response: NextResponse;
    }
  | {
      configured: true;
      user: User | null;
      supabase: SupabaseClient;
      response: NextResponse;
    };

/**
 * Refreshes the Supabase auth cookie for a Proxy request and returns the
 * current user. The response must be returned (or its cookies copied to a
 * redirect) so refreshed tokens reach the browser.
 */
export async function updateSupabaseSession(
  request: NextRequest,
): Promise<SupabaseProxySession> {
  const config = getSupabaseConfig();

  if (!config) {
    return {
      configured: false,
      user: null,
      supabase: null,
      response: NextResponse.next({ request }),
    };
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });

        response = NextResponse.next({ request });

        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  let user: User | null = null;

  try {
    const {
      data: { user: currentUser },
    } = await supabase.auth.getUser();
    user = currentUser;
  } catch (error) {
    // A Supabase outage must not turn every route into a 500. Treat the
    // request as anonymous; the login page will show a helpful message.
    console.error("[proxy] Gagal memeriksa sesi Supabase:", error);
  }

  return {
    configured: true,
    user,
    supabase,
    response,
  };
}

/**
 * Copies Set-Cookie headers from the Supabase refresh response to a redirect
 * response so refreshed sessions survive navigation redirects.
 */
export function copyCookies(from: NextResponse, to: NextResponse): void {
  from.cookies.getAll().forEach((cookie) => {
    to.cookies.set(cookie);
  });
}
