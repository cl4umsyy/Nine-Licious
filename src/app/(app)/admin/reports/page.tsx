import { PageHeader } from "@/components/page-header";
import { ReportsDashboard } from "@/components/admin/reports/reports-dashboard";
import { requireRole } from "@/lib/auth/guards";
import { getComprehensiveReportAction } from "@/lib/reports/actions";
import { getJakartaDateToday } from "@/lib/reports/calculations";
import type { ComprehensiveReportData } from "@/lib/reports/types";

export const dynamic = "force-dynamic";

export default async function AdminReportsPage() {
  await requireRole(["admin"]);

  const today = getJakartaDateToday();
  const reportRes = await getComprehensiveReportAction({
    startDate: today,
    endDate: today,
  });

  const fallbackData: ComprehensiveReportData = {
    period: {
      startDate: today,
      endDate: today,
    },
    sales: {
      period: { startDate: today, endDate: today },
      grossSales: 0,
      subtotal: 0,
      totalDiscount: 0,
      totalTax: 0,
      totalServiceCharge: 0,
      netSales: 0,
      totalRefund: 0,
      totalReceipts: 0,
      paidOrdersCount: 0,
      averageOrderValue: 0,
      dailyBreakdown: [],
    },
    payments: {
      period: { startDate: today, endDate: today },
      totalCash: 0,
      totalMidtrans: 0,
      cashTransactionCount: 0,
      midtransTransactionCount: 0,
      totalSplitBillReceipts: 0,
      splitBillOrdersCount: 0,
      totalPayments: 0,
      totalTransactions: 0,
      methodsBreakdown: [],
    },
    products: {
      period: { startDate: today, endDate: today },
      topProducts: [],
      categoryBreakdown: [
        { categoryName: "Food", quantitySold: 0, totalRevenue: 0, revenuePercentage: 0 },
        { categoryName: "Drinks", quantitySold: 0, totalRevenue: 0, revenuePercentage: 0 },
        { categoryName: "Desserts", quantitySold: 0, totalRevenue: 0, revenuePercentage: 0 },
        { categoryName: "Packages", quantitySold: 0, totalRevenue: 0, revenuePercentage: 0 },
      ],
      totalItemsSold: 0,
      totalProductsRevenue: 0,
    },
    refunds: {
      period: { startDate: today, endDate: today },
      totalRefundAmount: 0,
      totalRefundCount: 0,
      fullRefundTotal: 0,
      fullRefundCount: 0,
      partialRefundTotal: 0,
      partialRefundCount: 0,
      refundsByMethod: [],
      refundItems: [],
    },
  };

  const initialData = reportRes.ok && reportRes.data ? reportRes.data : fallbackData;

  return (
    <div className="flex flex-col flex-1 min-h-0 space-y-4">
      <PageHeader
        title="Laporan &amp; Analitik Operasional"
        description="Ringkasan performa finansial, saluran pembayaran Tunai &amp; Midtrans, serta kontribusi menu terlaris."
      />

      <ReportsDashboard
        initialData={initialData}
        defaultStartDate={today}
        defaultEndDate={today}
      />
    </div>
  );
}
