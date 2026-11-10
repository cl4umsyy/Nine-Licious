import Link from "next/link";
import {
  ArrowRight,
  ChefHat,
  CircleCheck,
  Clock3,
  CookingPot,
  MonitorPlay,
  ShoppingCart,
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

const KITCHEN_FLOW = [
  "Pesanan baru masuk dari kasir secara real-time",
  "Status berubah dari baru, diproses, siap, hingga disajikan",
  "Estimasi waktu dan catatan khusus terlihat jelas",
  "Dapur hanya melihat item yang relevan",
];

export default async function KitchenPage() {
  const session = await requireRole(["admin", "kitchen"]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Modul dapur"
        title="Antrean pesanan"
        description="Layar dapur untuk memantau pesanan masuk dan status masak. Modul ini diaktifkan pada F3 setelah alur transaksi F1–F2 selesai."
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
              <ChefHat className="size-5" />
            </div>
            <CardTitle className="mt-2 font-display text-xl">
              Dapur siap menerima alur F3
            </CardTitle>
            <CardDescription className="max-w-xl leading-relaxed">
              Fondasi akun staf dapur sudah tersedia. Layar antrean akan
              menampilkan pesanan aktif tanpa membuka data pelanggan atau
              pembayaran.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Alur yang akan hadir
            </p>
            <ul className="space-y-2">
              {KITCHEN_FLOW.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 rounded-lg bg-muted/50 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground"
                >
                  <CookingPot className="mt-0.5 size-3.5 shrink-0 text-primary" />
                  {item}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock3 className="size-4 text-brand-accent" />
                Status layar
              </CardTitle>
              <CardDescription>
                Belum ada pesanan pada fase fondasi.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-8 text-center">
                <ChefHat className="mx-auto size-8 text-muted-foreground/60" />
                <p className="mt-2 text-sm font-medium text-foreground">
                  Antrean masih kosong
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Pesanan akan muncul setelah modul kasir aktif.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CircleCheck className="size-4 text-success" />
                Akses dapur
              </CardTitle>
              <CardDescription>
                Staf dapur hanya dapat membuka halaman dapur dan papan antrean.
                Perubahan status pesanan akan diaudit pada F3.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/queue" target="_blank" rel="noreferrer">
                  <MonitorPlay />
                  Papan antrean
                </Link>
              </Button>
              {session.profile.role === "admin" ? (
                <Button asChild variant="ghost" size="sm">
                  <Link href="/pos">
                    <ShoppingCart />
                    Modul kasir
                    <ArrowRight />
                  </Link>
                </Button>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
