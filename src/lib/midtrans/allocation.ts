import type { OrderItem } from "@/types/database";

export type OrderFinancials = {
  subtotal: number;
  discountProductTotal: number;
  discountOrderTotal: number;
  discountManualTotal: number;
  discountTotal: number;
  serviceTotal: number;
  taxTotal: number;
  grandTotal: number;
  paidTotal: number;
};

export type HistoricalAllocation = {
  allocatedLineSubtotal: number;
  allocatedDiscountShare: number;
  allocatedServiceShare: number;
  allocatedTaxShare: number;
  allocatedRoundingAdjustment?: number;
  allocatedFinalAmount: number;
};

export type ItemAllocationRequest = {
  orderItemId: string;
  allocatedQuantity: number;
};

export type CalculatedItemAllocation = {
  orderItemId: string;
  allocatedQuantity: number;
  allocatedLineSubtotal: number;
  allocatedDiscountShare: number;
  allocatedServiceShare: number;
  allocatedTaxShare: number;
  allocatedRoundingAdjustment: number;
  allocatedFinalAmount: number;
};

export type CumulativeAllocationResult = {
  items: CalculatedItemAllocation[];
  grossTotal: number;
  isTerminalPayment: boolean;
};

/**
 * Calculates cumulative proportional allocation across transactions.
 *
 * Guarantees that:
 * 1. Every rupiah of discount, service, tax, and line total is allocated without independent rounding drift.
 * 2. Intermediate allocations use continuous incremental delta calculation based on historical allocations.
 * 3. Terminal payment absorbs any remaining residual components so that the sum of all allocations exactly equals grand_total.
 */
export function calculateCumulativeItemAllocations(params: {
  order: OrderFinancials;
  orderItems: OrderItem[];
  historicalAllocations: HistoricalAllocation[];
  requestedItems: ItemAllocationRequest[];
  isTerminalPayment?: boolean;
}): CumulativeAllocationResult {
  const { order, orderItems, historicalAllocations, requestedItems, isTerminalPayment = false } = params;

  if (requestedItems.length === 0) {
    throw new Error("Daftar item yang diajukan tidak boleh kosong.");
  }

  // 1. Hitung total master order
  const orderNetLineTotal = order.subtotal - order.discountProductTotal;
  const orderNonProductDiscount = order.discountOrderTotal + order.discountManualTotal;
  const orderServiceTotal = order.serviceTotal;
  const orderTaxTotal = order.taxTotal;
  const orderGrandTotal = order.grandTotal;

  if (orderNetLineTotal <= 0) {
    throw new Error("Total net line pesanan tidak valid untuk alokasi split bill.");
  }

  // 2. Akumulasi alokasi historis terdahulu (settled + active reserved)
  let cumNetLine = historicalAllocations.reduce((sum, a) => sum + a.allocatedLineSubtotal, 0);
  let cumDisc = historicalAllocations.reduce((sum, a) => sum + a.allocatedDiscountShare, 0);
  let cumServ = historicalAllocations.reduce((sum, a) => sum + a.allocatedServiceShare, 0);
  let cumTax = historicalAllocations.reduce((sum, a) => sum + a.allocatedTaxShare, 0);

  const itemMap = new Map(orderItems.map((item) => [item.id, item]));
  const sortedRequests = [...requestedItems].sort((a, b) => a.orderItemId.localeCompare(b.orderItemId));

  const calculatedItems: CalculatedItemAllocation[] = [];

  for (let i = 0; i < sortedRequests.length; i++) {
    const req = sortedRequests[i];
    const orderItem = itemMap.get(req.orderItemId);

    if (!orderItem) {
      throw new Error(`Item pesanan dengan ID ${req.orderItemId} tidak ditemukan.`);
    }

    if (req.allocatedQuantity <= 0 || req.allocatedQuantity > orderItem.quantity) {
      throw new Error(`Kuantitas alokasi tidak valid untuk item ${orderItem.product_name_snapshot}.`);
    }

    // Dekomposisi kuantitas parsial
    const itemSubtotal = Math.round((orderItem.subtotal / orderItem.quantity) * req.allocatedQuantity);
    const itemProductDiscount = Math.round((orderItem.discount_amount / orderItem.quantity) * req.allocatedQuantity);
    const itemNetLine = itemSubtotal - itemProductDiscount;

    cumNetLine += itemNetLine;
    const weight = cumNetLine / orderNetLineTotal;

    const targetDisc = Math.round(orderNonProductDiscount * weight);
    const targetServ = Math.round(orderServiceTotal * weight);
    const targetTax = Math.round(orderTaxTotal * weight);

    const discShare = targetDisc - cumDisc;
    const servShare = targetServ - cumServ;
    const taxShare = targetTax - cumTax;

    cumDisc = targetDisc;
    cumServ = targetServ;
    cumTax = targetTax;

    const finalAmount = itemNetLine - discShare + servShare + taxShare;

    calculatedItems.push({
      orderItemId: req.orderItemId,
      allocatedQuantity: req.allocatedQuantity,
      allocatedLineSubtotal: itemNetLine,
      allocatedDiscountShare: discShare,
      allocatedServiceShare: servShare,
      allocatedTaxShare: taxShare,
      allocatedRoundingAdjustment: 0,
      allocatedFinalAmount: finalAmount,
    });
  }

  // Jika pembayaran terakhir, serap residual akhir terhadap sisa tagihan pesanan
  if (isTerminalPayment) {
    const targetRemainingGross = orderGrandTotal - order.paidTotal;

    const currentBatchCalculatedSum = calculatedItems.reduce((sum, item) => sum + item.allocatedFinalAmount, 0);
    const residualDiff = targetRemainingGross - currentBatchCalculatedSum;

    if (residualDiff !== 0 && calculatedItems.length > 0) {
      const lastIndex = calculatedItems.length - 1;
      calculatedItems[lastIndex].allocatedRoundingAdjustment += residualDiff;
      calculatedItems[lastIndex].allocatedFinalAmount += residualDiff;
    }
  }

  const grossTotal = calculatedItems.reduce((sum, item) => sum + item.allocatedFinalAmount, 0);

  return {
    items: calculatedItems,
    grossTotal,
    isTerminalPayment,
  };
}
