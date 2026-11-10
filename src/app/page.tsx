import { redirect } from "next/navigation";
import { ROLE_HOME } from "@/lib/auth/roles";
import { getSessionState } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const state = await getSessionState();

  if (state.status === "authenticated") {
    redirect(ROLE_HOME[state.profile.role]);
  }

  redirect("/login");
}
