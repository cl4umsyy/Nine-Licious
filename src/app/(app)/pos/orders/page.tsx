import Link from "next/link";
import { AlertCircle, ArrowLeft, MapPin, Wallet } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { CashierOrdersBoard } from "@/components/pos/cashier-orders-board";
import { GlobalShiftSyncListener } from "@/components/pos/shift/global-shift-sync-listener";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireRole } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/auth/roles";
import type { CashierOrdersBoardData } from "@/lib/orders/cashier-orders";
import { getCashierOrdersAction } from "@/lib/orders/cashier-orders-actions";
import { getGlobalActiveShiftStatusAction } from "@/lib/shifts/actions";
import {
  formatOnDutyCashierLabel,
  isShiftLockedByOtherCashier,
} from "@/lib/shifts/format";
import type { GlobalActiveShiftStatus } from "@/lib/shifts/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Shift } from "@/types/database";

export const dynamic = "force-dynamic";

export default async function CashierOrdersPage() {
  const session = await requireRole(["admin", "kasir"]);
  const supabase = await createSupabaseServerClient();

  let activeShift: Shift | null = null;
  let globalShiftStatus: GlobalActiveShiftStatus | null = null;
  const globalShiftRes = await getGlobalActiveShiftStatusAction();
  if (globalShiftRes.ok && globalShiftRes.data) {
    globalShiftStatus = globalShiftRes.data;
  }
  if (supabase) {
    const { data: shiftData } = await supabase
      .from("shifts")
      .select("*")
      .eq("cashier_id", session.profile.id)
      .eq("status", "open")
      .maybeSingle();
    activeShift = (shiftData as unknown as Shift) || null;
  }

  const isLockedByOther =
    !activeShift && isShiftLockedByOtherCashier(globalShiftStatus);
  const shiftButtonLabel = activeShift ? "Shift Aktif" : "Buka Shift";
  const onDutyCashierLabel = formatOnDutyCashierLabel(
    globalShiftStatus?.cashierName,
    globalShiftStatus?.cashierUsername,
  );
  const openedAtLabel = globalShiftStatus?.openedAt
    ? new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(globalShiftStatus.openedAt))
    : null;

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
                !activeShift
                  ? isLockedByOther
                    ? "bg-rose-600 hover:bg-rose-700 text-white font-bold"
                    : "bg-amber-600 hover:bg-amber-700 text-white font-bold"
                  : ""
              }`}
            >
              <Link href="/pos/shift">
                <Wallet className="size-3.5 mr-1.5" />
                {isLockedByOther ? "Shift Digunakan" : shiftButtonLabel}
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

      <GlobalShiftSyncListener channelSuffix="pos-orders" />

      {!activeShift && (
        isLockedByOther ? (
          <div className="flex items-center justify-between p-3.5 bg-rose-500/10 border border-rose-500/30 rounded-2xl text-rose-950 dark:text-rose-100 text-xs sm:text-sm shrink-0">
            <div className="flex items-center gap-2.5">
              <AlertCircle className="size-4 shrink-0 text-rose-600 dark:text-rose-400" />
              <span>
                <strong>Shift Digunakan oleh {onDutyCashierLabel}:</strong>{" "}
                {openedAtLabel ? `Dibuka pukul ${openedAtLabel} WIB. ` : ""}
                Pembayaran tunai dikunci hingga shift aktif ditutup. Pembayaran non-tunai (Midtrans) tetap tersedia.
              </span>
            </div>
            <Button
              asChild
              size="sm"
              variant="outline"
              className="h-7.5 px-3 text-xs font-bold border-rose-600 text-rose-700 hover:bg-rose-500/20 rounded-xl shrink-0 ml-3"
            >
              <Link href="/pos/shift">Lihat Status Shift</Link>
            </Button>
          </div>
        ) : (
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
        )
      )}

      <CashierOrdersBoard
        initialData={initialData}
        userRole={session.profile.role}
        currentUserId={session.profile.id}
        initialError={result.ok ? null : result.message}
        activeShift={activeShift}
        globalShiftStatus={globalShiftStatus}
      />
    </div>
  );
}
