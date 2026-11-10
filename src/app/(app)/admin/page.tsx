import Link from "next/link";
import {
  ArrowRight,
  ChefHat,
  CircleCheck,
  Clock3,
  Database,
  MonitorPlay,
  ReceiptText,
  Settings2,
  ShieldCheck,
  ShoppingCart,
  UserPlus,
  Users,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { requireRole } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { APP_ENVIRONMENT_LABELS } from "@/lib/constants";
import { getAppEnvironment, getSessionIdleMinutes } from "@/lib/env";
import { getMidtransConfigState } from "@/lib/midtrans/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type ProfileSummary = {
  role: string;
  is_active: boolean;
};

type SettingsSummary = {
  name: string;
  tax_percent: number;
  service_charge_percent: number;
};

const PHASES = [
  { label: "F0 · Fondasi & autentikasi", status: "selesai" },
  { label: "F1 · Menu, meja, dan POS", status: "berikutnya" },
  { label: "F2 · Pembayaran & struk", status: "rencana" },
  { label: "F3 · Dapur & antrean", status: "rencana" },
  { label: "F4 · Stok & bahan baku", status: "rencana" },
  { label: "F5 · Shift & kas", status: "rencana" },
  { label: "F6 · Laporan & audit lanjutan", status: "rencana" },
];

function greeting(): string {
  const hour = new Date().getHours();

  if (hour < 11) return "Selamat pagi";
  if (hour < 15) return "Selamat siang";
  if (hour < 19) return "Selamat sore";
  return "Selamat malam";
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 2,
  }).format(value);
}

export default async function AdminDashboardPage() {
  const session = await requireRole("admin");
  const supabase = await createSupabaseServerClient();

  let profiles: ProfileSummary[] = [];
  let settings: SettingsSummary | null = null;
  let dataIssue: string | null = null;

  if (supabase) {
    const [profilesResult, settingsResult] = await Promise.all([
      supabase.from("profiles").select("role, is_active"),
      supabase
        .from("restaurant_settings")
        .select("name, tax_percent, service_charge_percent")
        .eq("id", 1)
        .maybeSingle<SettingsSummary>(),
    ]);

    if (profilesResult.error) {
      dataIssue =
        "Data pengguna belum dapat dibaca. Pastikan migrasi database sudah dijalankan.";
    } else {
      profiles = (profilesResult.data ?? []) as ProfileSummary[];
    }

    if (settingsResult.error) {
      dataIssue =
        dataIssue ??
        "Pengaturan restoran belum dapat dibaca. Jalankan migrasi database.";
    } else {
      settings = settingsResult.data ?? null;
    }
  }

  const activeStaff = profiles.filter((profile) => profile.is_active).length;
  const adminCount = profiles.filter(
    (profile) => profile.is_active && profile.role === "admin",
  ).length;
  const kasirCount = profiles.filter(
    (profile) => profile.is_active && profile.role === "kasir",
  ).length;
  const kitchenCount = profiles.filter(
    (profile) => profile.is_active && profile.role === "kitchen",
  ).length;

  const dateLabel = new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());

  const firstName = session.profile.full_name.split(" ")[0] ?? "Admin";
  const idleMinutes = getSessionIdleMinutes();
  const environment = getAppEnvironment();
  const midtrans = getMidtransConfigState();
  const midtransReady = midtrans.enabled && midtrans.ok;
  const midtransDetail = !midtrans.enabled
    ? "Belum diaktifkan; isi kredensial pada F2"
    : midtrans.ok
      ? `Konfigurasi ${midtrans.config.environment === "production" ? "Production" : "Sandbox"} siap; webhook diverifikasi pada F2`
      : midtrans.error;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Ringkasan admin"
        title={`${greeting()}, ${firstName}`}
        description={`${dateLabel} · ${settings?.name ?? "Nine Licious"} · ${ROLE_LABELS[session.profile.role]}`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/queue" target="_blank" rel="noreferrer">
              <MonitorPlay />
              Papan antrean
            </Link>
          </Button>
        }
      />

      {dataIssue ? (
        <Alert>
          <Database />
          <AlertTitle>Data belum lengkap</AlertTitle>
          <AlertDescription>{dataIssue}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="border-primary/15 bg-primary text-primary-foreground">
        <CardContent className="flex flex-col gap-5 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-2xl">
            <Badge
              variant="secondary"
              className="border-primary-foreground/15 bg-primary-foreground/10 text-primary-foreground"
            >
              <CircleCheck />
              F0 · Fondasi selesai
            </Badge>
            <h2 className="mt-3 font-display text-2xl font-semibold tracking-[-0.02em]">
              Fondasi autentikasi dan peran sudah aktif.
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-primary-foreground/70">
              Login, pembatasan percobaan masuk, sesi idle, audit log, dan
              pengelolaan pengguna sudah berjalan. Modul transaksi dimulai pada
              F1.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary" size="sm">
              <Link href="/admin/users">
                <UserPlus />
                Kelola pengguna
              </Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
            >
              <Link href="/pos">
                Buka POS
                <ArrowRight />
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <CardDescription>Staf aktif</CardDescription>
            <CardTitle className="font-display text-2xl">
              {activeStaff}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                / {profiles.length} akun
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="size-3.5 text-primary" />
            {adminCount} admin · {kasirCount} kasir · {kitchenCount} dapur
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Pajak</CardDescription>
            <CardTitle className="font-display text-2xl">
              {settings ? `${formatPercent(settings.tax_percent)}%` : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ReceiptText className="size-3.5 text-primary" />
            Dihitung setelah diskon
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Service charge</CardDescription>
            <CardTitle className="font-display text-2xl">
              {settings
                ? `${formatPercent(settings.service_charge_percent)}%`
                : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Settings2 className="size-3.5 text-primary" />
            Dapat diubah di pengaturan
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Sesi idle</CardDescription>
            <CardTitle className="font-display text-2xl">
              {idleMinutes} menit
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock3 className="size-3.5 text-primary" />
            Lingkungan {APP_ENVIRONMENT_LABELS[environment]}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Kesiapan sistem</CardTitle>
            <CardDescription>
              Pemeriksaan cepat fondasi F0.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              {
                label: "Autentikasi username dan peran",
                detail: "Admin, kasir, dan staf dapur",
                ready: true,
              },
              {
                label: "Audit log aktivitas",
                detail: "Login, logout, dan perubahan pengguna",
                ready: true,
              },
              {
                label: "Service role hanya di server",
                detail: "Tidak pernah dikirim ke browser",
                ready: true,
              },
              {
                label: "Pengaturan restoran",
                detail: settings
                  ? "Pajak dan service charge tersedia"
                  : "Jalankan migrasi database",
                ready: Boolean(settings),
              },
              {
                label: "Midtrans Sandbox / Production",
                detail: midtransDetail,
                ready: midtransReady,
              },
            ].map((item) => (
              <div key={item.label} className="flex items-start gap-3">
                <span
                  className={
                    item.ready
                      ? "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-success/10 text-success"
                      : "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
                  }
                >
                  <CircleCheck className="size-3.5" />
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {item.label}
                  </p>
                  <p className="text-xs text-muted-foreground">{item.detail}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Peta fase</CardTitle>
            <CardDescription>
              Fitur PRD dikerjakan bertahap tanpa melewati fondasi.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {PHASES.map((phase) => (
              <div
                key={phase.label}
                className="flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className={
                      phase.status === "selesai"
                        ? "size-2 rounded-full bg-success"
                        : phase.status === "berikutnya"
                          ? "size-2 rounded-full bg-brand-accent"
                          : "size-2 rounded-full bg-border"
                    }
                  />
                  <span className="text-sm text-foreground">{phase.label}</span>
                </div>
                <Badge
                  variant={phase.status === "selesai" ? "secondary" : "outline"}
                  className="text-[0.6rem]"
                >
                  {phase.status}
                </Badge>
              </div>
            ))}
            <Separator className="my-1" />
            <div className="grid grid-cols-2 gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/pos">
                  <ShoppingCart />
                  Modul kasir
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/kitchen">
                  <ChefHat />
                  Modul dapur
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-dashed">
        <CardContent className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Semua aktivitas istimewa dicatat di audit log. Refund nantinya
              hanya dapat dibuat dan disetujui oleh admin; kasir hanya melihat
              statusnya.
            </p>
          </div>
          <Badge variant="outline" className="shrink-0">
            F0 stabil
          </Badge>
        </CardContent>
      </Card>
    </div>
  );
}
