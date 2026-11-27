import type {
  CompensationSeverity,
  KdsStatus,
  OrderReplacementStatus,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentRecordStatus,
  PaymentSource,
  PaymentStatus,
  RefundAllocationPayoutStatus,
  RefundApprovalStatus,
  RefundCorrectionFollowUpStatus,
  RefundCorrectionType,
  RefundInventoryAction,
  RefundPayoutMethod,
  RefundPayoutStatus,
  RefundReasonCategory,
  RefundResolutionType,
  ShiftStatus,
} from "@/types/database";

export const REFUND_RESOLUTION_TYPES: readonly RefundResolutionType[] = [
  "full_refund",
  "partial_refund",
  "replacement",
] as const;

export const REFUND_REASON_CATEGORIES: readonly RefundReasonCategory[] = [
  "stock_unavailable",
  "wrong_order",
  "missing_item",
  "food_quality",
  "long_waiting_time",
  "payment_issue",
  "other",
] as const;

export const COMPENSATION_SEVERITIES: readonly CompensationSeverity[] = [
  "light",
  "medium",
  "heavy",
] as const;

export const REFUND_INVENTORY_ACTIONS = ["none", "waste", "restock"] as const;

export const ALLOWED_EVIDENCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const;

export const MAX_EVIDENCE_FILE_SIZE_BYTES = 52_428_800; // 50 MB

export const REFUND_RESOLUTION_LABELS: Record<RefundResolutionType, string> = {
  full_refund: "Full Refund",
  partial_refund: "Partial Refund / Kompensasi",
  replacement: "Replacement (Buat Ulang Menu)",
};

export const REFUND_REASON_CATEGORY_LABELS: Record<
  RefundReasonCategory,
  string
> = {
  stock_unavailable: "Stok / Bahan Habis",
  wrong_order: "Menu Salah / Tidak Sesuai",
  missing_item: "Item Kurang / Tidak Terkirim",
  food_quality: "Kualitas Makanan Bermasalah",
  long_waiting_time: "Waktu Tunggu Terlalu Lama",
  payment_issue: "Masalah Pembayaran / Bayar Ganda",
  other: "Lainnya",
};

export const COMPENSATION_SEVERITY_LABELS: Record<
  CompensationSeverity,
  string
> = {
  none: "Replacement (Rp 0)",
  light: "Ringan (25% DPP)",
  medium: "Sedang (50% DPP)",
  heavy: "Berat / Batal Item (100% + Pajak/Service)",
};

export const APPROVAL_STATUS_LABELS: Record<RefundApprovalStatus, string> = {
  pending_approval: "Menunggu Persetujuan Admin",
  approved: "Disetujui Admin",
  rejected: "Ditolak Admin",
  cancelled: "Dibatalkan",
};

export const PAYOUT_STATUS_LABELS: Record<RefundPayoutStatus, string> = {
  not_required: "Belum / Tidak Perlu Pencairan",
  pending: "Menunggu Pencairan Gateway",
  processing: "Sedang Diproses Midtrans",
  completed: "Selesai Dicairkan",
  failed: "Pencairan Gagal",
  reconciliation_required: "Perlu Rekonsiliasi Manual",
};

export const INVENTORY_ACTION_LABELS: Record<RefundInventoryAction, string> = {
  none: "Tidak Ada Mutasi Stok",
  waste: "Catat Waste (Sudah Dimasak)",
  restock: "Restock Bahan (Belum Diproduksi)",
  replace: "Ganti Menu (Replacement + Waste)",
};

export const REPLACEMENT_STATUS_LABELS: Record<OrderReplacementStatus, string> = {
  pending_approval: "Menunggu Approval",
  approved: "Disetujui",
  rejected: "Ditolak",
  cancelled: "Dibatalkan",
  in_kitchen: "Diproses Dapur",
  ready: "Siap Disajikan",
  completed: "Selesai Disajikan",
};

export type RefundBaselineItem = {
  orderItemId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  productDiscount: number;
  orderDiscountShare: number;
  netDpp: number;
  serviceShare: number;
  taxShare: number;
  fullTotal: number;
  priorRefundTotal: number;
  priorDppClaimed: number;
  priorServiceRefunded: number;
  priorTaxRefunded: number;
  priorFullQty: number;
  priorHasFull: boolean;
  remainingQuantity: number;
  remainingFullTotal: number;
  remainingDpp: number;
  isExhausted: boolean;
  kdsStatus: KdsStatus | null;
};

export type RefundPaymentSourceOption = {
  id: string;
  paymentMethod: PaymentMethod;
  paymentSource: PaymentSource;
  suggestedPayoutMethod: RefundPayoutMethod;
  amount: number;
  paymentStatus: PaymentRecordStatus;
  alreadyRefundedOrReserved: number;
  remainingRefundable: number;
  createdAt: string;
  referenceNumber: string | null;
};

export type OpenShiftOption = {
  id: string;
  cashierId: string;
  cashierName: string;
  cashierUsername: string;
  openedAt: string;
  expectedCash: number;
  status: ShiftStatus;
};

export type BreakdownPreviewItem = {
  orderItemId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  subtotalAmount: number;
  discountAmount: number;
  orderDiscountShare: number;
  netItemAmount: number;
  serviceChargeAmount: number;
  taxAmount: number;
  referenceServiceChargeAmount: number;
  referenceTaxAmount: number;
  roundingAdjustment: number;
  compensationSeverity: CompensationSeverity;
  compensationPercentage: 0 | 25 | 50 | 100;
  isFullItemRefund: boolean;
  refundAmount: number;
  reason: string | null;
};

export type RefundBreakdownPreview = {
  subtotalAmount: number;
  discountAmount: number;
  serviceChargeAmount: number;
  taxAmount: number;
  referenceServiceChargeAmount: number;
  referenceTaxAmount: number;
  roundingAdjustment: number;
  totalRefundAmount: number;
  availableRefundable: number;
  items: BreakdownPreviewItem[];
  validationError: string | null;
};

export type OrderRefundContextData = {
  order: {
    id: string;
    orderNumber: string;
    orderType: OrderType;
    orderKind: "standard" | "replacement";
    status: OrderStatus;
    paymentStatus: PaymentStatus;
    kdsStatus: KdsStatus | null;
    tableName: string | null;
    customerName: string | null;
    subtotal: number;
    discountProductTotal: number;
    discountOrderTotal: number;
    discountManualTotal: number;
    discountTotal: number;
    serviceTotal: number;
    taxTotal: number;
    grandTotal: number;
    paidTotal: number;
    refundedTotal: number;
    pendingRefundTotal: number;
    availableRefundable: number;
    paidAt: string | null;
    within24Hours: boolean;
    hoursSincePaid: number | null;
    isEligibleForNewRequest: boolean;
    ineligibilityReason: string | null;
  };
  items: RefundBaselineItem[];
  payments: RefundPaymentSourceOption[];
  openShifts: OpenShiftOption[];
};

export type RefundQueueSummary = {
  totalCount: number;
  pendingApprovalCount: number;
  midtransPendingCount: number;
  replacementActiveCount: number;
  completedFinancialTotal: number;
};

export type RefundListItem = {
  id: string;
  refundNumber: string;
  orderId: string;
  orderNumber: string;
  tableName: string | null;
  orderType: OrderType;
  resolutionType: RefundResolutionType;
  reasonCategory: RefundReasonCategory;
  approvalStatus: RefundApprovalStatus;
  payoutStatus: RefundPayoutStatus;
  payoutMethod: string | null;
  refundMethod: string;
  amount: number;
  reason: string;
  chronology: string | null;
  rejectionReason: string | null;
  cancellationReason: string | null;
  requestedBy: string;
  requesterName: string;
  requesterUsername: string;
  reviewedBy: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  payoutCompletedAt: string | null;
  gatewayRefundId: string | null;
  payoutReference: string | null;
  shiftId: string | null;
  parentRefundId: string | null;
  evidenceCount: number;
  replacementStatus: OrderReplacementStatus | null;
  replacementOrderNumber: string | null;
  createdAt: string;
};

export type RefundDetailData = RefundListItem & {
  subtotalAmount: number;
  discountAmount: number;
  serviceChargeAmount: number;
  taxAmount: number;
  referenceServiceChargeAmount: number;
  referenceTaxAmount: number;
  roundingAdjustment: number;
  receiptVerified: boolean;
  orderPaidTotal: number;
  orderRefundedTotal: number;
  orderStatus: OrderStatus;
  items: Array<{
    id: string;
    orderItemId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    subtotalAmount: number;
    discountAmount: number;
    orderDiscountShare: number;
    netItemAmount: number;
    serviceChargeAmount: number;
    taxAmount: number;
    referenceServiceChargeAmount: number;
    referenceTaxAmount: number;
    compensationSeverity: CompensationSeverity;
    compensationPercentage: number;
    isFullItemRefund: boolean;
    refundAmount: number;
    kdsStatusSnapshot: KdsStatus | null;
    inventoryAction: RefundInventoryAction;
    reason: string | null;
  }>;
  allocations: Array<{
    id: string;
    paymentId: string;
    paymentMethod: PaymentMethod | null;
    paymentSource: PaymentSource | null;
    payoutMethod: RefundPayoutMethod;
    amount: number;
    payoutStatus: RefundAllocationPayoutStatus;
    gatewayRefundId: string | null;
    payoutReference: string | null;
    payoutCompletedAt: string | null;
  }>;
  corrections: Array<{
    id: string;
    correctionType: RefundCorrectionType;
    expectedAmount: number;
    actualAmount: number;
    differenceAmount: number;
    supplementalRefundId: string | null;
    followUpStatus: RefundCorrectionFollowUpStatus;
    followUpNotes: string | null;
    reason: string;
    createdAt: string;
  }>;
  evidence: Array<{
    id: string;
    filePath: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    evidenceKind: "photo" | "video";
    notes: string | null;
    signedUrl: string | null;
    createdAt: string;
  }>;
  paymentsOnOrder: RefundPaymentSourceOption[];
  openShifts: OpenShiftOption[];
};

export type RefundActionResult<T = undefined> =
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
