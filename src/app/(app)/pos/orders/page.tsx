import Link from "next/link";
import { AlertCircle, ArrowLeft, MapPin, Wallet } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { CashierOrdersBoard } from "@/components/pos/cashier-orders-board";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireRole } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/auth/roles";
import type { CashierOrdersBoardData } from "@/lib/orders/cashier-orders";
import { getCashierOrdersAction } from "@/lib/orders/cashier-orders-actions";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Shift } from "@/types/database";

export const dynamic = "force-dynamic";

export default async function CashierOrdersPage() {
  const session = await requireRole(["admin", "kasir"]);
  const supabase = await createSupabaseServerClient();

  let activeShift: Shift | null = null;
  if (supabase) {
    const { data: shiftData } = await supabase
      .from("shifts")
      .select("*")
      .eq("cashier_id", session.profile.id)
      .eq("status", "open")
      .maybeSingle();
    activeShift = (shiftData as unknown as Shift) || null;
  }

  const result = await getCashierOrdersAction();

  const initialData: CashierOrdersBoardData =
    result.ok && result.data
      ? result.data
      : {
          orders: [],
          syncedAt: new Date().toISOString(),
          servingSchemaReady: true,
        };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Operasional Kasir"
        title="Daftar Pesanan Kasir"
        description="Pantau status pembayaran, progres dapur (KDS), dan penyajian pesanan Dine-in maupun Takeaway secara real-time."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-9 rounded-xl px-3.5 text-xs font-semibold"
            >
              <Link href="/pos">
                <ArrowLeft className="mr-1.5 size-3.5" />
                Kembali ke POS
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-9 rounded-xl px-3.5 text-xs font-semibold"
            >
              <Link href="/pos/floor">
                <MapPin className="mr-1.5 size-3.5 text-primary" />
                Denah Meja
              </Link>
            </Button>
            <Button
              asChild
              variant={activeShift ? "outline" : "default"}
              size="sm"
              className={`h-9 px-3 text-xs font-semibold rounded-xl ${
                !activeShift ? "bg-amber-600 hover:bg-amber-700 text-white font-bold" : ""
              }`}
            >
              <Link href="/pos/shift">
                <Wallet className="size-3.5 mr-1.5" />
                {activeShift ? "Shift Aktif" : "Buka Shift"}
              </Link>
            </Button>
            <Badge
              variant="outline"
              className="h-9 rounded-xl px-3.5 text-xs font-semibold"
            >
              {ROLE_LABELS[session.profile.role]}
            </Badge>
          </div>
        }
      />

      {!activeShift && (
        <div className="flex items-center justify-between p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-2xl text-amber-900 text-xs sm:text-sm shrink-0">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="size-4 shrink-0 text-amber-600" />
            <span>
              <strong>Shift Kasir Belum Dibuka:</strong> Anda belum membuka shift kasir hari ini. Pembayaran tunai dinonaktifkan hingga shift dibuka.
            </span>
          </div>
          <Button
            asChild
            size="sm"
            variant="outline"
            className="h-7.5 px-3 text-xs font-bold border-amber-600 text-amber-700 hover:bg-amber-500/20 rounded-xl shrink-0 ml-3"
          >
            <Link href="/pos/shift">Buka Shift Kasir Sekarang</Link>
          </Button>
        </div>
      )}

      <CashierOrdersBoard
        initialData={initialData}
        userRole={session.profile.role}
        currentUserId={session.profile.id}
        initialError={result.ok ? null : result.message}
        activeShift={activeShift}
      />
    </div>
  );
}
