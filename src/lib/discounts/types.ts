import type {
  Discount,
  DiscountScope,
  DiscountType,
} from "@/types/database";

export type DiscountWithTargets = Discount & {
  categoryName?: string | null;
  productName?: string | null;
};

export type DiscountFormData = {
  id?: string;
  name: string;
  scope: "product" | "order";
  discountType: DiscountType;
  discountValue: number;
  appliesToCategoryId?: string | null;
  appliesToProductId?: string | null;
  minOrderAmount?: number;
  maxDiscountAmount?: number | null;
  isActive?: boolean;
};

export type DiscountActionResult<T = unknown> =
  | {
      ok: true;
      message: string;
      data?: T;
    }
  | {
      ok: false;
      message: string;
      fieldErrors?: Record<string, string>;
    };

export type ManualDiscountApprovalRequest = {
  adminEmail: string;
  adminPassword: string;
  discountType: DiscountType;
  discountValue: number;
  reason: string;
  idempotencyKey: string;
};

export type ManualDiscountApprovalData = {
  nonce: string;
  approverId: string;
  approverName: string;
  discountType: DiscountType;
  discountValue: number;
  reason: string;
  expiresAt: string;
};

export type AppliedCartDiscount = {
  scope: DiscountScope;
  clientItemId?: string;
  orderItemId?: string;
  discountId?: string;
  name: string;
  discountType: DiscountType;
  discountRate: number;
  discountAmount: number;
  approvalNonce?: string;
  reason?: string;
  approverName?: string;
};

export type CartCalculationWithDiscounts = {
  itemsCount: number;
  subtotal: number;
  discountProductTotal: number;
  discountOrderTotal: number;
  discountManualTotal: number;
  discountTotal: number;
  taxableBase: number;
  taxPercent: number;
  taxTotal: number;
  serviceChargePercent: number;
  serviceTotal: number;
  grandTotal: number;
  appliedDiscounts: AppliedCartDiscount[];
};
