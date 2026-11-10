import { NextResponse, type NextRequest } from "next/server";
import {
  copyCookies,
  updateSupabaseSession,
} from "@/lib/supabase/proxy";
import {
  canAccessPath,
  roleFromAppMetadata,
  ROLE_HOME,
} from "@/lib/auth/roles";
import { getSessionIdleMinutes } from "@/lib/env";
import { isSupabaseAdminConfigured } from "@/lib/supabase/admin-config";
import { LAST_SEEN_COOKIE } from "@/lib/constants";

const PUBLIC_PATHS = new Set(["/login", "/queue"]);

function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith("/queue/") ||
    pathname.startsWith("/_next/")
  );
}

function redirectWithSessionCookies(
  request: NextRequest,
  sessionResponse: NextResponse,
  path: string,
): NextResponse {
  const response = NextResponse.redirect(new URL(path, request.url));
  copyCookies(sessionResponse, response);
  return response;
}

function setLastSeen(response: NextResponse): NextResponse {
  response.cookies.set(LAST_SEEN_COOKIE, String(Date.now()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });

  return response;
}

function clearSupabaseCookies(
  request: NextRequest,
  response: NextResponse,
): void {
  for (const cookie of request.cookies.getAll()) {
    if (
      cookie.name.startsWith("sb-") &&
      cookie.name.includes("auth-token")
    ) {
      response.cookies.set(cookie.name, "", {
        path: "/",
        maxAge: 0,
      });
    }
  }

  response.cookies.set(LAST_SEEN_COOKIE, "", {
    path: "/",
    maxAge: 0,
  });
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const configured = isSupabaseAdminConfigured();

  if (!configured) {
    if (isPublicPath(pathname)) {
      return NextResponse.next();
    }

    return NextResponse.redirect(new URL("/login?setup=1", request.url));
  }

  const session = await updateSupabaseSession(request);
  const { user, response } = session;
  const role = user
    ? roleFromAppMetadata(user.app_metadata as Record<string, unknown>)
    : null;

  if (!user) {
    if (isPublicPath(pathname)) {
      return response;
    }

    const loginPath =
      pathname === "/"
        ? "/login"
        : `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;

    return redirectWithSessionCookies(request, response, loginPath);
  }

  // /login handles its own redirect after validating the profile. Redirecting
  // here as well can loop when the profile is missing or inactive.
  if (pathname === "/login" || pathname.startsWith("/queue")) {
    return response;
  }

  const lastSeenRaw = request.cookies.get(LAST_SEEN_COOKIE)?.value;
  const lastSeen = Number(lastSeenRaw);

  if (
    Number.isFinite(lastSeen) &&
    Date.now() - lastSeen > getSessionIdleMinutes() * 60_000
  ) {
    const idleResponse = redirectWithSessionCookies(
      request,
      response,
      "/login?reason=idle",
    );
    clearSupabaseCookies(request, idleResponse);
    return idleResponse;
  }

  if (pathname === "/") {
    if (role) {
      return setLastSeen(
        redirectWithSessionCookies(request, response, ROLE_HOME[role]),
      );
    }

    return setLastSeen(response);
  }

  if (role && !canAccessPath(pathname, role)) {
    return setLastSeen(
      redirectWithSessionCookies(
        request,
        response,
        `/unauthorized?from=${encodeURIComponent(pathname)}`,
      ),
    );
  }

  return setLastSeen(response);
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|icon.svg|.*\\..*).*)",
  ],
};
