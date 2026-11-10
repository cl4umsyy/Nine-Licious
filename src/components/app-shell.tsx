"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowUpRight,
  ChevronDown,
  LogOut,
  Menu,
  MonitorPlay,
} from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { EnvironmentBadge } from "@/components/environment-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { logoutAction } from "@/lib/auth/actions";
import { ROLE_HOME, ROLE_LABELS } from "@/lib/auth/roles";
import type { AppEnvironment } from "@/lib/env";
import { navItemsForRole, pageMetaForPath } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import type { Profile } from "@/types/database";

type ShellProfile = Pick<
  Profile,
  "id" | "username" | "full_name" | "role"
>;

type AppShellProps = {
  profile: ShellProfile;
  environment: AppEnvironment;
  children: React.ReactNode;
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function SidebarContent({
  profile,
  onNavigate,
}: {
  profile: ShellProfile;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const items = navItemsForRole(profile.role);

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 py-5">
        <BrandMark href={ROLE_HOME[profile.role]} />
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        <p className="px-2 pb-2 text-[0.6rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Menu kerja
        </p>
        {items.map((item) => {
          const active =
            pathname === item.href ||
            pathname.startsWith(`${item.href}/`);

          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.description}
              target={item.newTab ? "_blank" : undefined}
              rel={item.newTab ? "noreferrer" : undefined}
              onClick={onNavigate}
              className={cn(
                "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                active
                  ? "bg-brand-soft font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <item.icon
                className={cn(
                  "size-4 shrink-0",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span className="truncate">{item.label}</span>
              {item.newTab ? (
                <ArrowUpRight className="ml-auto size-3.5 opacity-50" />
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-4">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-semibold text-primary">
            {initials(profile.full_name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {profile.full_name}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              @{profile.username} · {ROLE_LABELS[profile.role]}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AppShell({ profile, environment, children }: AppShellProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const meta = pageMetaForPath(pathname);
  const title =
    meta?.label ??
    (pathname === "/unauthorized" ? "Akses dibatasi" : "Saji POS");

  return (
    <div className="min-h-dvh bg-background lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="sticky top-0 hidden h-dvh border-r border-border bg-sidebar lg:block">
        <SidebarContent profile={profile} />
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background px-3 sm:px-5">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="lg:hidden"
                aria-label="Buka menu"
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-72 bg-sidebar p-0"
              showCloseButton={false}
            >
              <SheetHeader className="sr-only">
                <SheetTitle>Menu Saji POS</SheetTitle>
                <SheetDescription>Navigasi utama aplikasi.</SheetDescription>
              </SheetHeader>
              <SidebarContent
                profile={profile}
                onNavigate={() => setMobileOpen(false)}
              />
            </SheetContent>
          </Sheet>

          <div className="min-w-0">
            <p className="truncate font-heading text-sm font-semibold text-foreground">
              {title}
            </p>
            <p className="hidden text-[0.7rem] text-muted-foreground sm:block">
              {meta?.description ?? "Saji POS"}
            </p>
          </div>

          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            <EnvironmentBadge environment={environment} />
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex"
            >
              <Link href="/queue" target="_blank" rel="noreferrer">
                <MonitorPlay />
                <span className="hidden md:inline">Papan antrean</span>
              </Link>
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-lg p-1 pr-1.5 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
                  aria-label="Menu pengguna"
                >
                  <span className="grid size-8 place-items-center rounded-full bg-brand-soft text-[0.7rem] font-semibold text-primary">
                    {initials(profile.full_name)}
                  </span>
                  <span className="hidden max-w-28 truncate text-sm font-medium text-foreground md:block">
                    {profile.full_name.split(" ")[0]}
                  </span>
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <span className="block truncate text-sm font-medium text-foreground">
                    {profile.full_name}
                  </span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    @{profile.username} · {ROLE_LABELS[profile.role]}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href={ROLE_HOME[profile.role]}>
                    <MonitorPlay />
                    Halaman utama
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/queue" target="_blank" rel="noreferrer">
                    <ArrowUpRight />
                    Buka papan antrean
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <form action={logoutAction}>
                  <button
                    type="submit"
                    className="relative flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-destructive outline-hidden select-none hover:bg-destructive/10 focus-visible:bg-destructive/10"
                  >
                    <LogOut className="size-4" />
                    Keluar
                  </button>
                </form>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
