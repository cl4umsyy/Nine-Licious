import Link from "next/link";
import { ArrowLeft, MapPin } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { CashierOrdersBoard } from "@/components/pos/cashier-orders-board";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireRole } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/auth/roles";
import type { CashierOrdersBoardData } from "@/lib/orders/cashier-orders";
import { getCashierOrdersAction } from "@/lib/orders/cashier-orders-actions";

export const dynamic = "force-dynamic";

export default async function CashierOrdersPage() {
  const session = await requireRole(["admin", "kasir"]);
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
            <Badge
              variant="outline"
              className="h-9 rounded-xl px-3.5 text-xs font-semibold"
            >
              {ROLE_LABELS[session.profile.role]}
            </Badge>
          </div>
        }
      />

      <CashierOrdersBoard
        initialData={initialData}
        userRole={session.profile.role}
        initialError={result.ok ? null : result.message}
      />
    </div>
  );
}
