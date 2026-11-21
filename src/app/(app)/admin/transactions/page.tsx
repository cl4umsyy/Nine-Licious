import { PageHeader } from "@/components/page-header";
import {
  TransactionHistory,
  type CashierProfile,
} from "@/components/admin/transactions/transaction-history";
import { requireRole } from "@/lib/auth/guards";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAdminTransactionsAction } from "@/lib/transactions/actions";
import type { PaginatedTransactionsResult } from "@/lib/transactions/types";

export const dynamic = "force-dynamic";

export default async function AdminTransactionsPage() {
  await requireRole(["admin"]);

  const supabase = await createSupabaseServerClient();
  let initialData: PaginatedTransactionsResult = {
    items: [],
    totalCount: 0,
    page: 1,
    pageSize: 20,
    totalPages: 0,
    metricSummary: {
      totalTransactions: 0,
      totalAmountSum: 0,
      paidAmountSum: 0,
      totalRefundedSum: 0,
    },
  };

  let cashiers: CashierProfile[] = [];

  const [txRes, cashiersRes] = await Promise.all([
    getAdminTransactionsAction({ page: 1, pageSize: 20 }),
    supabase
      ? supabase
          .from("profiles")
          .select("id, full_name, username")
          .in("role", ["admin", "kasir"])
          .eq("is_active", true)
          .order("full_name", { ascending: true })
      : Promise.resolve({ data: [] }),
  ]);

  if (txRes.ok && txRes.data) {
    initialData = txRes.data;
  }

  if (cashiersRes?.data) {
    cashiers = cashiersRes.data as CashierProfile[];
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 space-y-4">
      <PageHeader
        title="Riwayat Transaksi & Audit"
        description="Pencarian riwayat pesanan, audit rincian pembayaran & split bill, penelusuran refund, dan rekonsiliasi laci shift kasir."
      />

      <TransactionHistory initialData={initialData} cashiers={cashiers} />
    </div>
  );
}
