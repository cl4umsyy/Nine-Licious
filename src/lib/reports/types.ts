import type { z } from "zod";
import type { dateRangeFilterSchema } from "./validation";

export type DateRangeFilterInput = z.input<typeof dateRangeFilterSchema>;

export type ReportActionErrorCode =
  | "UNAUTHORIZED"
  | "VALIDATION_ERROR"
  | "DATABASE_ERROR"
  | "INTERNAL_ERROR";

export type ReportActionResult<T = undefined> = {
  ok: boolean;
  message: string;
  code?: ReportActionErrorCode;
  data?: T;
  fieldErrors?: Record<string, string>;
};

export type DailySalesBreakdown = {
  date: string; // YYYY-MM-DD (Asia/Jakarta)
  grossSales: number;
  subtotal: number;
  totalDiscount: number;
  totalTax: number;
  totalServiceCharge: number;
  netSales: number;
  totalRefund: number;
  paidOrdersCount: number;
};

export type SalesReportData = {
  period: {
    startDate: string;
    endDate: string;
  };
  grossSales: number;
  subtotal: number;
  totalDiscount: number;
  totalTax: number;
  totalServiceCharge: number;
  netSales: number;
  totalRefund: number;
  totalReceipts: number;
  paidOrdersCount: number;
  averageOrderValue: number;
  dailyBreakdown: DailySalesBreakdown[];
};

export type PaymentMethodSummary = {
  method: string;
  source: string;
  label: string;
  totalAmount: number;
  transactionCount: number;
};

export type PaymentMethodReportData = {
  period: {
    startDate: string;
    endDate: string;
  };
  totalCash: number;
  totalMidtrans: number;
  cashTransactionCount: number;
  midtransTransactionCount: number;
  totalSplitBillReceipts: number;
  splitBillOrdersCount: number;
  totalPayments: number;
  totalTransactions: number;
  methodsBreakdown: PaymentMethodSummary[];
};

export type TopProductItem = {
  productId: string;
  productName: string;
  sku: string | null;
  categoryName: string;
  quantitySold: number;
  totalRevenue: number;
};

export type CategoryPerformanceItem = {
  categoryName: string;
  quantitySold: number;
  totalRevenue: number;
  revenuePercentage: number;
};

export type ProductPerformanceReportData = {
  period: {
    startDate: string;
    endDate: string;
  };
  topProducts: TopProductItem[];
  categoryBreakdown: CategoryPerformanceItem[];
  totalItemsSold: number;
  totalProductsRevenue: number;
};

export type RefundMethodBreakdown = {
  method: string;
  label: string;
  totalAmount: number;
  count: number;
};

export type RefundReportItem = {
  id: string;
  refundNumber: string;
  orderId: string;
  amount: number;
  reason: string;
  refundType: "full" | "partial";
  resolutionType?: "full_refund" | "partial_refund" | "replacement";
  reasonCategory?: string;
  approvalStatus?: string;
  payoutStatus?: string;
  refundMethod: string;
  status: string;
  approvedAt: string | null;
  createdAt: string;
};

export type RefundReportData = {
  period: {
    startDate: string;
    endDate: string;
  };
  totalRefundAmount: number;
  totalRefundCount: number;
  fullRefundTotal: number;
  fullRefundCount: number;
  partialRefundTotal: number;
  partialRefundCount: number;
  refundsByMethod: RefundMethodBreakdown[];
  refundItems: RefundReportItem[];
};

export type ComprehensiveReportData = {
  period: {
    startDate: string;
    endDate: string;
  };
  sales: SalesReportData;
  payments: PaymentMethodReportData;
  products: ProductPerformanceReportData;
  refunds: RefundReportData;
};
