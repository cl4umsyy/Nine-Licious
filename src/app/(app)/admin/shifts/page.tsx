import { PageHeader } from "@/components/page-header";
import {
  AdminShiftManager,
  type CashierProfile,
} from "@/components/admin/shifts/admin-shift-manager";
import { requireRole } from "@/lib/auth/guards";
import {
  getAllActiveShiftsAction,
  getShiftHistoryAction,
} from "@/lib/shifts/actions";
import type { ShiftWithCashier } from "@/lib/shifts/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function AdminShiftsPage() {
  await requireRole(["admin"]);

  const supabase = await createSupabaseServerClient();
  let activeShifts: ShiftWithCashier[] = [];
  let allShifts: ShiftWithCashier[] = [];
  let cashiers: CashierProfile[] = [];

  const [activeRes, histRes, cashiersRes] = await Promise.all([
    getAllActiveShiftsAction(),
    getShiftHistoryAction({ limit: 100 }),
    supabase
      ? supabase
          .from("profiles")
          .select("id, full_name, username, is_active")
          .eq("role", "kasir")
          .order("full_name", { ascending: true })
      : Promise.resolve({ data: [] }),
  ]);

  if (activeRes.ok && activeRes.data) {
    activeShifts = activeRes.data;
  }

  if (histRes.ok && histRes.data) {
    allShifts = histRes.data;
  }

  if (cashiersRes?.data) {
    cashiers = cashiersRes.data as CashierProfile[];
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 space-y-4">
      <PageHeader
        title="Manajemen Shift & Kas Drawer"
        description="Monitoring sesi kasir aktif, pergerakan uang fisik laci kas, audit rekonsiliasi, dan pelacakan selisih."
      />

      <AdminShiftManager
        activeShifts={activeShifts}
        allShifts={allShifts}
        cashiers={cashiers}
      />
    </div>
  );
}
