import type {
  KdsStatus,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentRecordStatus,
  PaymentSource,
  PaymentStatus,
  RefundMethod,
  RefundRecordStatus,
  RefundType,
  ShiftStatus,
} from "@/types/database";

export type TransactionPaymentMethodFilter =
  | "all"
  | "cash"
  | "midtrans"
  | "split";

export type AdminTransactionListItem = {
  id: string;
  orderNumber: string;
  queueNumber: string | null;
  queueDate: string | null;
  businessDate: string;
  createdAt: string;
  updatedAt: string;
  orderType: OrderType;
  tableId: string | null;
  tableName: string | null;
  customerName: string | null;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  kdsStatus: KdsStatus | null;
  grandTotal: number;
  paidTotal: number;
  refundedTotal: number;
  netPaid: number;
  paymentMethod: "cash" | "midtrans" | "split" | "unpaid";
  paymentMethodsList: string[];
  itemSummary: string;
  totalItemCount: number;
  cashierId: string | null;
  cashierName: string;
  cashierUsername: string;
  shiftId: string | null;
  shiftStatus: ShiftStatus | null;
  hasRefund: boolean;
};

export type AdminTransactionDetail = {
  order: {
    id: string;
    orderNumber: string;
    queueNumber: string | null;
    queueDate: string | null;
    businessDate: string;
    orderType: OrderType;
    tableId: string | null;
    tableName: string | null;
    customerName: string | null;
    status: OrderStatus;
    paymentStatus: PaymentStatus;
    kdsStatus: KdsStatus | null;
    cashierId: string | null;
    cashierName: string;
    cashierUsername: string;
    createdAt: string;
    updatedAt: string;
    servedAt: string | null;
    servedBy: string | null;
    cancelledAt: string | null;
    cancelReason: string | null;
    notes: string | null;
    subtotal: number;
    discountProductTotal: number;
    discountOrderTotal: number;
    discountManualTotal: number;
    discountTotal: number;
    taxPercent: number;
    taxTotal: number;
    serviceChargePercent: number;
    serviceTotal: number;
    grandTotal: number;
    paidTotal: number;
    refundedTotal: number;
    remainingBalance: number;
  };
  items: Array<{
    id: string;
    productId: string;
    productName: string; // Snapshot historis
    productSku: string | null;
    unitPrice: number;
    quantity: number;
    notes: string | null;
    modifierTotal: number;
    subtotal: number;
    discountAmount: number;
    lineTotal: number;
    kitchenStation: string | null;
    modifiers: Array<{
      id: string;
      groupName: string;
      optionName: string;
      priceDelta: number;
    }>;
  }>;
  discounts: Array<{
    id: string;
    name: string;
    scope: string;
    discountType: string;
    discountRate: number;
    discountAmount: number;
    reason: string | null;
    approvedAt: string | null;
  }>;
  payments: Array<{
    id: string;
    paymentMethod: PaymentMethod;
    paymentSource: PaymentSource;
    amount: number;
    cashReceived: number | null;
    changeAmount: number;
    referenceNumber: string | null;
    paymentStatus: PaymentRecordStatus;
    shiftId: string | null;
    cashierName: string;
    notes: string | null;
    createdAt: string;
    midtransDetails?: {
      id: string;
      midtransOrderId: string;
      grossAmount: number;
      paymentType: string;
      lifecycleStatus: string;
      settledAt: string | null;
      attemptNumber: number;
      isSplitBill: boolean;
    } | null;
  }>;
  splitBillSummary: {
    isSplitBill: boolean;
    totalParts: number;
    totalPaid: number;
    remainingBalance: number;
    methodsUsed: string[];
  };
  refunds: Array<{
    id: string;
    refundNumber: string;
    paymentId: string | null;
    amount: number;
    refundType: RefundType;
    refundMethod: RefundMethod;
    reason: string;
    status: RefundRecordStatus;
    createdAt: string;
    approvedAt: string | null;
    requesterName: string;
    approverName: string | null;
    gatewayRefundId: string | null;
  }>;
  shifts: Array<{
    id: string;
    cashierId: string;
    cashierName: string;
    cashierUsername: string;
    openedAt: string;
    closedAt: string | null;
    status: ShiftStatus;
    openingCash: number;
    cashSales: number;
    cashRefunds: number;
    cashIn: number;
    cashOut: number;
    expectedCash: number;
    actualCash: number | null;
    cashDifference: number | null;
    reconciliationStatus: "match" | "over" | "short" | "open";
    notes: string | null;
  }>;
  cashMovements: Array<{
    id: string;
    shiftId: string | null;
    movementType: string;
    amount: number;
    balanceBefore: number;
    balanceAfter: number;
    reason: string;
    paymentId: string | null;
    refundId: string | null;
    createdByName: string;
    createdAt: string;
  }>;
};

export type TransactionFilterInput = {
  search?: string;
  startDate?: string;
  endDate?: string;
  paymentStatus?: PaymentStatus | "all";
  orderStatus?: OrderStatus | "all";
  paymentMethod?: TransactionPaymentMethodFilter;
  orderType?: OrderType | "all";
  cashierId?: string | "all";
  shiftId?: string | "all";
  page?: number;
  pageSize?: number;
};

export type PaginatedTransactionsResult = {
  items: AdminTransactionListItem[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  metricSummary: {
    totalTransactions: number;
    totalAmountSum: number;
    paidAmountSum: number;
    totalRefundedSum: number;
  };
};

export type TransactionActionResult<T = unknown> =
  | {
      ok: true;
      message: string;
      data: T;
    }
  | {
      ok: false;
      message: string;
      fieldErrors?: Record<string, string>;
    };
