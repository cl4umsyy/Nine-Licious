import type {
  CompensationSeverity,
  KdsStatus,
  OrderReplacement,
  RefundApprovalStatus,
  RefundInventoryAction,
  RefundPayoutStatus,
  RefundReasonCategory,
  RefundResolutionType,
} from "@/types/database";
import type {
  BreakdownPreviewItem,
  RefundBaselineItem,
  RefundBreakdownPreview,
} from "./types";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export function isWithinRefund24HourWindow(
  paidAt: string | null | undefined,
  nowMs = Date.now(),
): { within24Hours: boolean; hoursSincePaid: number | null } {
  if (!paidAt) {
    return { within24Hours: false, hoursSincePaid: null };
  }
  const paidMs = Date.parse(paidAt);
  if (Number.isNaN(paidMs)) {
    return { within24Hours: false, hoursSincePaid: null };
  }
  const diffMs = Math.max(0, nowMs - paidMs);
  const hoursSincePaid = Math.round((diffMs / (60 * 60 * 1000)) * 10) / 10;
  return {
    within24Hours: diffMs <= TWENTY_FOUR_HOURS_MS,
    hoursSincePaid,
  };
}

/**
 * Menyelaraskan status tampilan tiket replacement dengan progres aktual order
 * pengganti di KDS (`kds_status`) dan konfirmasi penyajian kasir (`served_at`).
 */
export function resolveEffectiveReplacementStatus(
  rawStatus: OrderReplacement["status"],
  repOrder?: { kds_status?: string | null; served_at?: string | null } | null,
): OrderReplacement["status"] {
  if (rawStatus === "rejected" || rawStatus === "cancelled") {
    return rawStatus;
  }
  if (repOrder?.served_at) {
    return "completed";
  }
  if (
    repOrder?.kds_status === "ready" &&
    (rawStatus === "in_kitchen" || rawStatus === "approved")
  ) {
    return "ready";
  }
  return rawStatus;
}

export function getDefaultInventoryAction(params: {
  resolutionType: RefundResolutionType;
  reasonCategory: RefundReasonCategory;
  kdsStatus: KdsStatus | null;
}): RefundInventoryAction {
  if (params.resolutionType === "replacement") {
    return "replace";
  }
  if (
    params.kdsStatus === "queued" &&
    (params.reasonCategory === "stock_unavailable" ||
      params.reasonCategory === "long_waiting_time")
  ) {
    return "restock";
  }
  if (
    params.reasonCategory === "food_quality" ||
    params.reasonCategory === "wrong_order"
  ) {
    return "waste";
  }
  return "none";
}

export type CanonicalOrderItemInput = {
  id: string;
  product_name_snapshot: string;
  unit_price_snapshot: number;
  quantity: number;
  subtotal: number;
  discount_amount: number;
  created_at: string;
};

export type HistoricalRefundClaimRow = {
  order_item_id: string;
  quantity: number;
  net_item_amount: number;
  service_charge_amount: number;
  tax_amount: number;
  refund_amount: number;
  compensation_percentage: number;
  is_full_item_refund: boolean;
  approval_status?: RefundApprovalStatus;
  payout_status?: RefundPayoutStatus;
  resolution_type?: RefundResolutionType;
};

/**
 * Menghitung baseline komponen DPP, diskon order, service charge, dan pajak
 * setiap order_item secara deterministik identik dengan SQL
 * `calculate_refund_breakdown_internal` pada migration R4.
 */
export function buildOrderItemBaselines(params: {
  order: {
    subtotal: number;
    discount_product_total: number;
    discount_order_total: number;
    discount_manual_total: number;
    service_total: number;
    tax_total: number;
    kds_status: KdsStatus | null;
  };
  orderItems: CanonicalOrderItemInput[];
  priorRefundItems: HistoricalRefundClaimRow[];
}): RefundBaselineItem[] {
  const sortedItems = [...params.orderItems].sort((a, b) => {
    const timeDiff = Date.parse(a.created_at) - Date.parse(b.created_at);
    if (!Number.isNaN(timeDiff) && timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  });

  const orderNetLineTotal = Math.max(
    1,
    Math.round(params.order.subtotal) -
      Math.round(params.order.discount_product_total),
  );
  const orderNonProductDiscount =
    Math.round(params.order.discount_order_total) +
    Math.round(params.order.discount_manual_total);
  const totalService = Math.round(params.order.service_total);
  const totalTax = Math.round(params.order.tax_total);

  let runNet = 0;
  let runOrderDisc = 0;
  let runService = 0;
  let runTax = 0;

  // Agregasi klaim terdahulu yang valid (abaikan rejected, cancelled, failed payout, replacement Rp 0)
  const claimsMap = new Map<
    string,
    {
      priorRefundTotal: number;
      priorDppClaimed: number;
      priorServiceRefunded: number;
      priorTaxRefunded: number;
      priorFullQty: number;
      priorHasFull: boolean;
    }
  >();

  for (const claim of params.priorRefundItems) {
    if (
      claim.approval_status === "rejected" ||
      claim.approval_status === "cancelled" ||
      claim.payout_status === "failed" ||
      claim.resolution_type === "replacement"
    ) {
      continue;
    }

    const curr = claimsMap.get(claim.order_item_id) ?? {
      priorRefundTotal: 0,
      priorDppClaimed: 0,
      priorServiceRefunded: 0,
      priorTaxRefunded: 0,
      priorFullQty: 0,
      priorHasFull: false,
    };

    curr.priorRefundTotal += Math.round(Number(claim.refund_amount) || 0);
    curr.priorDppClaimed += Math.round(Number(claim.net_item_amount) || 0);
    curr.priorServiceRefunded += Math.round(
      Number(claim.service_charge_amount) || 0,
    );
    curr.priorTaxRefunded += Math.round(Number(claim.tax_amount) || 0);
    if (claim.is_full_item_refund) {
      curr.priorFullQty += Math.round(Number(claim.quantity) || 0);
    }
    if (claim.is_full_item_refund || claim.compensation_percentage === 100) {
      curr.priorHasFull = true;
    }

    claimsMap.set(claim.order_item_id, curr);
  }

  const totalRows = sortedItems.length;
  const kdsSnap: KdsStatus | null =
    params.order.kds_status === "queued" ||
    params.order.kds_status === "preparing" ||
    params.order.kds_status === "ready"
      ? params.order.kds_status
      : null;

  return sortedItems.map((oi, index) => {
    const subtotal = Math.round(oi.subtotal);
    const prodDisc = Math.round(oi.discount_amount);
    runNet += Math.max(0, subtotal - prodDisc);

    let tDisc: number;
    let tSvc: number;
    let tTax: number;

    if (index === totalRows - 1) {
      tDisc = orderNonProductDiscount;
      tSvc = totalService;
      tTax = totalTax;
    } else {
      const w = Math.min(1, runNet / orderNetLineTotal);
      tDisc = Math.round(orderNonProductDiscount * w);
      tSvc = Math.round(totalService * w);
      tTax = Math.round(totalTax * w);
    }

    const bDisc = Math.max(0, tDisc - runOrderDisc);
    const bSvc = Math.max(0, tSvc - runService);
    const bTax = Math.max(0, tTax - runTax);

    runOrderDisc = tDisc;
    runService = tSvc;
    runTax = tTax;

    const bDpp = Math.max(0, subtotal - prodDisc - bDisc);
    const bFullTotal = bDpp + bSvc + bTax;

    const claims = claimsMap.get(oi.id) ?? {
      priorRefundTotal: 0,
      priorDppClaimed: 0,
      priorServiceRefunded: 0,
      priorTaxRefunded: 0,
      priorFullQty: 0,
      priorHasFull: false,
    };

    const remainingQuantity = Math.max(0, oi.quantity - claims.priorFullQty);
    const remainingFullTotal = Math.max(
      0,
      bFullTotal - claims.priorRefundTotal,
    );
    const remainingDpp = Math.max(0, bDpp - claims.priorDppClaimed);
    const isExhausted =
      claims.priorRefundTotal >= bFullTotal ||
      claims.priorFullQty >= oi.quantity ||
      (claims.priorHasFull && oi.quantity === 1);

    return {
      orderItemId: oi.id,
      productName: oi.product_name_snapshot,
      quantity: oi.quantity,
      unitPrice: Math.round(oi.unit_price_snapshot),
      subtotal,
      productDiscount: prodDisc,
      orderDiscountShare: bDisc,
      netDpp: bDpp,
      serviceShare: bSvc,
      taxShare: bTax,
      fullTotal: bFullTotal,
      priorRefundTotal: claims.priorRefundTotal,
      priorDppClaimed: claims.priorDppClaimed,
      priorServiceRefunded: claims.priorServiceRefunded,
      priorTaxRefunded: claims.priorTaxRefunded,
      priorFullQty: claims.priorFullQty,
      priorHasFull: claims.priorHasFull,
      remainingQuantity,
      remainingFullTotal,
      remainingDpp,
      isExhausted,
      kdsStatus: kdsSnap,
    };
  });
}

export function calculateRefundBreakdownPreview(params: {
  baselines: RefundBaselineItem[];
  availableRefundable: number;
  resolutionType: RefundResolutionType;
  reasonCategory: RefundReasonCategory;
  duplicatePaymentAmount?: number | null;
  selectedItems: Array<{
    orderItemId: string;
    quantity: number;
    compensationSeverity?: CompensationSeverity;
    reason?: string | null;
  }>;
}): RefundBreakdownPreview {
  const {
    baselines,
    availableRefundable,
    resolutionType,
    reasonCategory,
    duplicatePaymentAmount,
    selectedItems,
  } = params;

  if (
    reasonCategory === "payment_issue" &&
    typeof duplicatePaymentAmount === "number" &&
    duplicatePaymentAmount > 0
  ) {
    if (resolutionType === "replacement") {
      return {
        subtotalAmount: 0,
        discountAmount: 0,
        serviceChargeAmount: 0,
        taxAmount: 0,
        referenceServiceChargeAmount: 0,
        referenceTaxAmount: 0,
        roundingAdjustment: 0,
        totalRefundAmount: 0,
        availableRefundable,
        items: [],
        validationError:
          "Masalah pembayaran ganda tidak dapat menggunakan penyelesaian Replacement.",
      };
    }

    const amt = Math.round(duplicatePaymentAmount);
    const error =
      amt > availableRefundable
        ? `Nominal pembayaran ganda (Rp ${amt.toLocaleString("id-ID")}) melebihi sisa saldo refundable (Rp ${availableRefundable.toLocaleString("id-ID")}).`
        : null;

    return {
      subtotalAmount: amt,
      discountAmount: 0,
      serviceChargeAmount: 0,
      taxAmount: 0,
      referenceServiceChargeAmount: 0,
      referenceTaxAmount: 0,
      roundingAdjustment: 0,
      totalRefundAmount: amt,
      availableRefundable,
      items: [],
      validationError: error,
    };
  }

  if (selectedItems.length === 0) {
    return {
      subtotalAmount: 0,
      discountAmount: 0,
      serviceChargeAmount: 0,
      taxAmount: 0,
      referenceServiceChargeAmount: 0,
      referenceTaxAmount: 0,
      roundingAdjustment: 0,
      totalRefundAmount: 0,
      availableRefundable,
      items: [],
      validationError: "Pilih minimal satu item pesanan.",
    };
  }

  const baselineMap = new Map(baselines.map((b) => [b.orderItemId, b]));

  let totalSubtotal = 0;
  let totalDiscount = 0;
  let totalService = 0;
  let totalTax = 0;
  let totalRefService = 0;
  let totalRefTax = 0;
  let totalRefund = 0;
  let validationError: string | null = null;
  const previewItems: BreakdownPreviewItem[] = [];

  for (const sel of selectedItems) {
    const base = baselineMap.get(sel.orderItemId);
    if (!base) {
      validationError = "Item pesanan tidak ditemukan pada transaksi.";
      break;
    }

    const reqQty = Math.round(sel.quantity);
    if (reqQty <= 0) {
      validationError = `Kuantitas untuk "${base.productName}" harus minimal 1.`;
      break;
    }

    let severity: CompensationSeverity = sel.compensationSeverity ?? "heavy";
    let pct: 0 | 25 | 50 | 100 = 100;

    if (resolutionType === "replacement") {
      severity = "none";
      pct = 0;
    } else if (
      reasonCategory === "wrong_order" ||
      reasonCategory === "food_quality"
    ) {
      pct = severity === "light" ? 25 : severity === "medium" ? 50 : 100;
    } else {
      severity = "heavy";
      pct = 100;
    }

    if (
      base.priorRefundTotal >= base.fullTotal ||
      base.priorFullQty >= base.quantity ||
      (base.priorHasFull && base.quantity === 1) ||
      ((pct === 25 || pct === 50) && base.priorDppClaimed >= base.netDpp)
    ) {
      validationError = `Item "${base.productName}" sudah mencapai batas kompensasi 100% dan tidak dapat diajukan lagi.`;
      break;
    }

    if (reqQty > base.quantity - base.priorFullQty) {
      validationError = `Kuantitas "${base.productName}" (${reqQty}) melebihi sisa porsi (${base.quantity - base.priorFullQty}).`;
      break;
    }

    const reqSubtotal = Math.round((base.subtotal / base.quantity) * reqQty);
    const reqProdDisc = Math.round(
      (base.productDiscount / base.quantity) * reqQty,
    );
    const reqOrderDisc = Math.round(
      (base.orderDiscountShare / base.quantity) * reqQty,
    );
    const reqDpp = Math.round((base.netDpp / base.quantity) * reqQty);
    const reqSvcRef = Math.round((base.serviceShare / base.quantity) * reqQty);
    const reqTaxRef = Math.round((base.taxShare / base.quantity) * reqQty);

    let subOut = 0;
    let prodDiscOut = 0;
    let orderDiscOut = 0;
    let dppOut = 0;
    let svcOut = 0;
    let taxOut = 0;
    let amtOut = 0;
    let isFullItem = false;

    if (pct === 0) {
      subOut = 0;
      prodDiscOut = 0;
      orderDiscOut = 0;
      dppOut = 0;
      svcOut = 0;
      taxOut = 0;
      amtOut = 0;
      isFullItem = false;
    } else if (pct === 25 || pct === 50) {
      // Aturan A.2: kompensasi 25%/50% murni dari nilai DPP bersih tanpa service/pajak
      subOut = Math.round((reqSubtotal * pct) / 100);
      prodDiscOut = Math.round((reqProdDisc * pct) / 100);
      orderDiscOut = Math.round((reqOrderDisc * pct) / 100);
      dppOut = Math.round((reqDpp * pct) / 100);
      svcOut = 0;
      taxOut = 0;

      const remDppCap = Math.max(0, base.netDpp - base.priorDppClaimed);
      if (dppOut > remDppCap) {
        if (dppOut - remDppCap <= 1 && remDppCap > 0) {
          dppOut = remDppCap;
        } else {
          validationError = `Total kompensasi untuk "${base.productName}" melampaui nilai bersih maksimum item (Rp ${base.netDpp.toLocaleString("id-ID")}).`;
          break;
        }
      }
      amtOut = dppOut;
      isFullItem = base.priorDppClaimed + dppOut >= base.netDpp;
    } else {
      const remDppCap = Math.max(0, base.netDpp - base.priorDppClaimed);
      const remSvcCap = Math.max(
        0,
        base.serviceShare - base.priorServiceRefunded,
      );
      const remTaxCap = Math.max(0, base.taxShare - base.priorTaxRefunded);
      const remTotalCap = Math.max(
        0,
        base.fullTotal - base.priorRefundTotal,
      );

      if (reqQty === base.quantity - base.priorFullQty) {
        subOut = Math.min(reqSubtotal, base.subtotal);
        prodDiscOut = Math.min(reqProdDisc, base.productDiscount);
        orderDiscOut = Math.min(reqOrderDisc, base.orderDiscountShare);
        dppOut = remDppCap;
        svcOut = remSvcCap;
        taxOut = remTaxCap;
      } else {
        subOut = reqSubtotal;
        prodDiscOut = reqProdDisc;
        orderDiscOut = reqOrderDisc;
        dppOut = Math.min(reqDpp, remDppCap);
        svcOut = Math.min(reqSvcRef, remSvcCap);
        taxOut = Math.min(reqTaxRef, remTaxCap);
      }

      amtOut = Math.min(remTotalCap, dppOut + svcOut + taxOut);
      isFullItem = true;
    }

    if (base.priorRefundTotal + amtOut > base.fullTotal) {
      validationError = `Akumulasi refund untuk "${base.productName}" melampaui total item.`;
      break;
    }

    totalSubtotal += subOut;
    totalDiscount += prodDiscOut + orderDiscOut;
    totalService += svcOut;
    totalTax += taxOut;
    totalRefService += reqSvcRef;
    totalRefTax += reqTaxRef;
    totalRefund += amtOut;

    previewItems.push({
      orderItemId: base.orderItemId,
      productName: base.productName,
      quantity: reqQty,
      unitPrice: base.unitPrice,
      subtotalAmount: subOut,
      discountAmount: prodDiscOut,
      orderDiscountShare: orderDiscOut,
      netItemAmount: dppOut,
      serviceChargeAmount: svcOut,
      taxAmount: taxOut,
      referenceServiceChargeAmount: reqSvcRef,
      referenceTaxAmount: reqTaxRef,
      roundingAdjustment: 0,
      compensationSeverity: severity,
      compensationPercentage: pct,
      isFullItemRefund: isFullItem,
      refundAmount: amtOut,
      reason: sel.reason?.trim() || null,
    });
  }

  let totalRounding = 0;
  if (
    !validationError &&
    resolutionType === "full_refund" &&
    totalRefund !== availableRefundable &&
    availableRefundable > 0
  ) {
    const residual = availableRefundable - totalRefund;
    if (
      Math.abs(residual) <= Math.max(50, previewItems.length * 5)
    ) {
      totalRounding = residual;
      totalRefund = availableRefundable;
    }
  }

  if (!validationError && resolutionType !== "replacement") {
    if (totalRefund <= 0) {
      validationError = "Hasil perhitungan nominal refund bernilai Rp 0.";
    } else if (totalRefund > availableRefundable) {
      validationError = `Total refund (Rp ${totalRefund.toLocaleString("id-ID")}) melebihi sisa refundable (Rp ${availableRefundable.toLocaleString("id-ID")}).`;
    } else if (
      resolutionType === "full_refund" &&
      totalRefund !== availableRefundable
    ) {
      validationError = `Full Refund harus mencakup seluruh sisa dana refundable (Rp ${availableRefundable.toLocaleString("id-ID")}). Pilih seluruh item tersisa atau gunakan Partial Refund.`;
    }
  }

  return {
    subtotalAmount: totalSubtotal,
    discountAmount: totalDiscount,
    serviceChargeAmount: totalService,
    taxAmount: totalTax,
    referenceServiceChargeAmount: totalRefService,
    referenceTaxAmount: totalRefTax,
    roundingAdjustment: totalRounding,
    totalRefundAmount: totalRefund,
    availableRefundable,
    items: previewItems,
    validationError,
  };
}
