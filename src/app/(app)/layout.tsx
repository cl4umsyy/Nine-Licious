import { AppShell } from "@/components/app-shell";
import { requireSession } from "@/lib/auth/guards";
import { getAppEnvironment } from "@/lib/env";

// Protected routes must never be prerendered: they depend on request cookies
// and on Supabase environment variables that may only exist at runtime.
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();

  return (
    <AppShell
      profile={session.profile}
      environment={getAppEnvironment()}
    >
      {children}
    </AppShell>
  );
}
