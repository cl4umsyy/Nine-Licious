import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { CashierShiftManager } from "@/components/pos/shift/shift-manager";
import { Button } from "@/components/ui/button";
import { requireRole } from "@/lib/auth/guards";
import {
  getCashMovementsAction,
  getGlobalActiveShiftStatusAction,
  getShiftHistoryAction,
  getShiftSummaryAction,
} from "@/lib/shifts/actions";
import type {
  CashMovement,
  GlobalActiveShiftStatus,
  ShiftSummary,
  ShiftWithCashier,
} from "@/lib/shifts/types";

export const dynamic = "force-dynamic";

export default async function PosShiftPage() {
  const session = await requireRole(["admin", "kasir"]);

  let summary: ShiftSummary | null = null;
  let movements: CashMovement[] = [];
  let history: ShiftWithCashier[] = [];
  let globalShiftStatus: GlobalActiveShiftStatus | null = null;

  const [summaryRes, globalStatusRes, histRes] = await Promise.all([
    getShiftSummaryAction(),
    getGlobalActiveShiftStatusAction(),
    getShiftHistoryAction({ limit: 20 }),
  ]);

  if (globalStatusRes.ok && globalStatusRes.data) {
    globalShiftStatus = globalStatusRes.data;
  }

  if (summaryRes.ok && summaryRes.data) {
    summary = summaryRes.data;
    const movRes = await getCashMovementsAction(summary.shift.id);
    if (movRes.ok && movRes.data) {
      movements = movRes.data;
    }
  }

  if (histRes.ok && histRes.data) {
    history = histRes.data;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 space-y-4">
      <PageHeader
        title="Kelola Shift & Kas Drawer"
        description="Pencatatan modal awal kasir, mutasi kas fisik, dan rekonsiliasi penutupan shift."
        actions={
          <div className="flex items-center gap-2">
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-8.5 px-3 text-xs font-semibold rounded-xl"
            >
              <Link href="/pos">
                <ArrowLeft className="size-3.5 mr-1.5" />
                Kembali ke POS
              </Link>
            </Button>
          </div>
        }
      />

      <CashierShiftManager
        currentCashier={{
          id: session.profile.id,
          full_name: session.profile.full_name,
          username: session.profile.username,
          role: session.profile.role,
        }}
        initialSummary={summary}
        initialMovements={movements}
        initialHistory={history}
        initialGlobalShiftStatus={globalShiftStatus}
      />
    </div>
  );
}
