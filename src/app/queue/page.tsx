import Link from "next/link";
import { Clock3, LogIn, MonitorPlay, ShieldCheck } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default function QueuePage() {
  const timeLabel = new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta",
  }).format(new Date());

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <BrandMark href="/queue" />
          <Button asChild variant="outline" size="sm">
            <Link href="/login">
              <LogIn />
              Masuk staf
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-8 sm:px-6 sm:py-10">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="flex items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-brand-accent">
              <MonitorPlay className="size-3.5" />
              Papan publik
            </p>
            <h1 className="mt-1.5 font-display text-3xl font-semibold tracking-[-0.03em] text-foreground sm:text-4xl">
              Antrean pesanan
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Pantau status pesanan yang sedang disiapkan. Halaman ini tidak
              menampilkan nama pelanggan, nomor telepon, atau data pembayaran.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
            <Clock3 className="size-3.5 text-primary" />
            <span className="tabular">Diperbarui {timeLabel} WIB</span>
          </div>
        </div>

        <div className="mt-8 flex flex-1 items-center justify-center">
          <div className="w-full max-w-lg rounded-2xl border border-dashed border-border bg-card px-6 py-14 text-center shadow-[0_1px_2px_rgba(28,35,33,0.03)]">
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-brand-soft text-primary">
              <MonitorPlay className="size-6" />
            </div>
            <h2 className="mt-4 font-display text-xl font-semibold text-foreground">
              Belum ada pesanan aktif
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Antrean akan muncul di sini setelah kasir mengirim pesanan ke
              dapur. Layar ini aman dibiarkan terbuka di area pelanggan.
            </p>
            <Badge variant="outline" className="mt-5">
              <ShieldCheck />
              Tanpa data pribadi pelanggan
            </Badge>
          </div>
        </div>
      </main>

      <footer className="border-t border-border px-4 py-4 text-center text-[0.65rem] text-muted-foreground sm:px-6">
        Saji POS · Papan antrean publik · Waktu Indonesia Barat
      </footer>
    </div>
  );
}
