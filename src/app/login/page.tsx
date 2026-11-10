import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CircleCheck,
  CircleExclamationPoint,
  Clock3,
  UtensilsCrossed,
} from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { LoginForm } from "@/components/auth/login-form";
import { SetupNotice } from "@/components/auth/setup-notice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { logoutAction } from "@/lib/auth/actions";
import { safeNextPath } from "@/lib/auth/roles";
import { getSessionState } from "@/lib/auth/session";
import { APP_ENVIRONMENT_LABELS } from "@/lib/constants";
import { getAppEnvironment, getSessionIdleMinutes } from "@/lib/env";
import { isSupabaseAdminConfigured } from "@/lib/supabase/admin-config";

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const REASON_MESSAGES: Record<string, string> = {
  inactive:
    "Akun Anda sedang tidak aktif. Hubungi admin restoran untuk mengaktifkannya kembali.",
  "profile-missing":
    "Profil akun tidak ditemukan atau tidak aktif. Hubungi admin restoran untuk memeriksa data pengguna.",
  "invalid-role":
    "Peran akun tidak dikenali. Hubungi admin restoran untuk memperbaiki hak akses.",
  unavailable:
    "Layanan autentikasi sedang tidak dapat dihubungi. Coba lagi beberapa saat lagi.",
};

const FEATURES = [
  "Pesanan dan meja dalam satu alur",
  "Pembayaran tunai, QRIS, dan kartu",
  "Antrean dapur yang selalu sinkron",
  "Stok, shift, dan laporan yang dapat diaudit",
];

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const configured = isSupabaseAdminConfigured();
  const rawNext = typeof params.next === "string" ? params.next : "";
  const next = rawNext.slice(0, 500);
  const reason = typeof params.reason === "string" ? params.reason : "";
  const idleMinutes = getSessionIdleMinutes();
  const environment = getAppEnvironment();

  let sessionInvalid = false;

  if (configured) {
    const state = await getSessionState();

    if (state.status === "authenticated") {
      redirect(safeNextPath(next || null, state.profile.role));
    }

    sessionInvalid = state.status === "invalid";
  }

  const reasonMessage =
    reason === "idle"
      ? `Sesi berakhir karena tidak ada aktivitas selama ${idleMinutes} menit. Silakan masuk kembali.`
      : REASON_MESSAGES[reason] ?? "";

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-primary p-10 text-primary-foreground lg:flex lg:flex-col lg:justify-between">
        <div
          className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full border border-primary-foreground/10"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -bottom-32 -left-24 size-96 rounded-full border border-primary-foreground/10"
          aria-hidden="true"
        />

        <BrandMark tone="inverse" href="/login" className="relative z-10" />

        <div className="relative z-10 max-w-lg py-12">
          <p className="flex items-center gap-2 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-brand-accent">
            <UtensilsCrossed className="size-3.5" />
            Rapi dari dapur ke meja
          </p>
          <h1 className="mt-4 font-display text-[2.6rem] font-semibold leading-[1.08] tracking-[-0.03em]">
            Satu tempat untuk seluruh layanan restoran.
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-primary-foreground/70">
            Nine Licious menyatukan pesanan, pembayaran, dapur, stok, dan laporan agar
            setiap tim bekerja dari data yang sama.
          </p>

          <ul className="mt-8 space-y-2.5">
            {FEATURES.map((feature) => (
              <li
                key={feature}
                className="flex items-center gap-2.5 text-sm text-primary-foreground/85"
              >
                <CircleCheck className="size-4 shrink-0 text-brand-accent" />
                {feature}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative z-10 flex items-center gap-2 text-[0.7rem] text-primary-foreground/50">
          <Clock3 className="size-3.5" />
          Sesi otomatis berakhir setelah {idleMinutes} menit tanpa aktivitas.
        </div>
      </aside>

      <div className="flex min-h-dvh flex-col bg-background">
        <div className="flex items-center justify-between px-5 py-5 lg:hidden">
          <BrandMark href="/login" />
          <Link
            href="/queue"
            className="text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            Papan antrean
          </Link>
        </div>

        <div className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
          <div className="w-full max-w-md">
            <div className="mb-6">
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-brand-accent">
                Selamat datang
              </p>
              <h2 className="mt-1.5 font-display text-3xl font-semibold tracking-[-0.025em] text-foreground">
                Masuk ke Nine Licious
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Gunakan akun staf yang diberikan admin restoran. Tidak ada
                pendaftaran mandiri.
              </p>
            </div>

            <div className="space-y-4">
              {reasonMessage ? (
                <Alert>
                  <CircleExclamationPoint />
                  <AlertTitle>Sesi sebelumnya berakhir</AlertTitle>
                  <AlertDescription>{reasonMessage}</AlertDescription>
                </Alert>
              ) : null}

              {sessionInvalid ? (
                <Alert variant="destructive">
                  <CircleExclamationPoint />
                  <AlertTitle>Sesi lama tidak dapat digunakan</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p>
                      Akun pada sesi ini tidak memiliki profil aktif. Bersihkan
                      sesi lama, lalu masuk kembali.
                    </p>
                    <form action={logoutAction}>
                      <Button type="submit" variant="outline" size="sm">
                        Bersihkan sesi lama
                      </Button>
                    </form>
                  </AlertDescription>
                </Alert>
              ) : null}

              {configured ? <LoginForm next={next} /> : <SetupNotice />}
            </div>

            <div className="mt-7 flex items-center justify-between gap-3 border-t border-border pt-4 text-[0.7rem] text-muted-foreground">
              <span>Butuh bantuan? Hubungi admin restoran.</span>
              <Link
                href="/queue"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Papan antrean publik
              </Link>
            </div>
          </div>
        </div>

        <footer className="px-5 py-4 text-center text-[0.65rem] text-muted-foreground">
          © 2026 Nine Licious · Antarmuka terang · Lingkungan{" "}
          {APP_ENVIRONMENT_LABELS[environment]}
        </footer>
      </div>
    </div>
  );
}
