import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runSafeStaleMidtransCleanup } from "@/lib/midtrans/stale-cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorizedCronRequest(request: Request): {
  authorized: boolean;
  configured: boolean;
} {
  const expectedSecret = process.env.CRON_SECRET?.trim();
  if (!expectedSecret) {
    return { authorized: false, configured: false };
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedSecret = match?.[1]?.trim() ?? "";

  const expectedBuf = Buffer.from(expectedSecret, "utf8");
  const providedBuf = Buffer.from(providedSecret, "utf8");
  if (expectedBuf.length !== providedBuf.length) {
    return { authorized: false, configured: true };
  }

  return {
    authorized: timingSafeEqual(expectedBuf, providedBuf),
    configured: true,
  };
}

async function handleCleanup(request: Request, defaultDryRun: boolean) {
  const auth = isAuthorizedCronRequest(request);
  if (!auth.configured) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET belum dikonfigurasi di server." },
      { status: 503 },
    );
  }
  if (!auth.authorized) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized cron invocation." },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const executeParam = url.searchParams.get("execute");
  const maxParam = Number.parseInt(url.searchParams.get("maxOrders") ?? "", 10);

  let dryRun = defaultDryRun;
  if (executeParam === "true") {
    dryRun = false;
  } else if (executeParam === "false") {
    dryRun = true;
  }

  if (request.method === "POST") {
    const body = (await request.json().catch(() => null)) as
      | { dryRun?: unknown; maxOrders?: unknown }
      | null;
    if (body && typeof body.dryRun === "boolean") {
      dryRun = body.dryRun;
    }
    if (body && typeof body.maxOrders === "number" && Number.isFinite(body.maxOrders)) {
      const result = await runSafeStaleMidtransCleanup({
        dryRun,
        maxOrders: body.maxOrders,
      });
      return NextResponse.json(result, { status: result.ok ? 200 : 500 });
    }
  }

  const result = await runSafeStaleMidtransCleanup({
    dryRun,
    maxOrders: Number.isFinite(maxParam) ? maxParam : undefined,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export async function GET(request: Request): Promise<NextResponse> {
  return handleCleanup(request, true);
}

export async function POST(request: Request): Promise<NextResponse> {
  return handleCleanup(request, true);
}
