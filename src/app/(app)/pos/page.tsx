import Link from "next/link";
import {
  ArrowRight,
  ChefHat,
  CircleCheck,
  MonitorPlay,
  ReceiptText,
  ShoppingCart,
  UtensilsCrossed,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireRole } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/auth/roles";

const NEXT_STEPS = [
  "Pilih meja dan jumlah tamu",
  "Cari menu dan susun keranjang pesanan",
  "Terapkan diskon sesuai kebijakan restoran",
  "Hitung pajak dan service charge setelah diskon",
  "Pilih pembayaran tunai, QRIS, kartu, atau manual",
];

export default async function PosPage() {
  const session = await requireRole(["admin", "kasir"]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Modul kasir"
        title="POS & transaksi"
        description="Area kerja kasir untuk meja, pesanan, pembayaran, dan shift. Fondasi autentikasi sudah aktif; modul transaksi dikerjakan pada F1."
        actions={
          <Badge variant="outline" className="h-7 px-3">
            {ROLE_LABELS[session.profile.role]} · F0
          </Badge>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card className="border-primary/15">
          <CardHeader>
            <div className="flex size-11 items-center justify-center rounded-xl bg-brand-soft text-primary">
              <ShoppingCart className="size-5" />
            </div>
            <CardTitle className="mt-2 font-display text-xl">
              Modul POS disiapkan pada F1
            </CardTitle>
            <CardDescription className="max-w-xl leading-relaxed">
              Halaman ini sengaja belum menampilkan transaksi. Pada fase
              berikutnya, kasir dapat membuka meja, menambah pesanan, dan
              mengirim tiket ke dapur dari satu layar.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Alur yang akan hadir
            </p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {NEXT_STEPS.map((step) => (
                <li
                  key={step}
                  className="flex items-start gap-2 rounded-lg bg-muted/50 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground"
                >
                  <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-primary" />
                  {step}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UtensilsCrossed className="size-4 text-brand-accent" />
                Fondasi yang sudah aktif
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-sm text-muted-foreground">
              <p className="flex items-center gap-2">
                <CircleCheck className="size-3.5 text-success" />
                Login staf dengan peran admin, kasir, dan dapur
              </p>
              <p className="flex items-center gap-2">
                <CircleCheck className="size-3.5 text-success" />
                Sesi idle dan pembatasan percobaan masuk
              </p>
              <p className="flex items-center gap-2">
                <CircleCheck className="size-3.5 text-success" />
                Audit log aktivitas pengguna
              </p>
              <p className="flex items-center gap-2">
                <CircleCheck className="size-3.5 text-success" />
                Pengaturan pajak dan service charge
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ReceiptText className="size-4 text-brand-accent" />
                Catatan pembayaran
              </CardTitle>
              <CardDescription>
                Midtrans Sandbox disiapkan pada F2. Bila kredensial belum
                tersedia, pembayaran manual tetap dapat dicatat.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" size="sm">
                <Link href="/queue" target="_blank" rel="noreferrer">
                  <MonitorPlay />
                  Lihat papan antrean
                  <ArrowRight />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="border-dashed">
        <CardContent className="flex flex-col gap-2 py-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>
            {session.profile.role === "admin"
              ? "Butuh melihat antrean dapur? Buka modul dapur dari menu samping."
              : "Papan antrean publik dapat dibuka tanpa data pelanggan."}
          </span>
          {session.profile.role === "admin" ? (
            <Button asChild variant="ghost" size="sm">
              <Link href="/kitchen">
                <ChefHat />
                Modul dapur
              </Link>
            </Button>
          ) : (
            <Button asChild variant="ghost" size="sm">
              <Link href="/queue" target="_blank" rel="noreferrer">
                <MonitorPlay />
                Papan antrean
              </Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
