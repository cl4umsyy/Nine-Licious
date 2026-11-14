import assert from "node:assert/strict";

console.log("=== NINE LICIOUS POS - F2.2 CUMULATIVE ALLOCATION ALGORITHM TEST ===");

// Implementasi murni algoritma matematika F2.2
function calculateCumulativeItemAllocations(params) {
  const { order, orderItems, historicalAllocations, requestedItems, isTerminalPayment = false } = params;

  if (requestedItems.length === 0) {
    throw new Error("Daftar item yang diajukan tidak boleh kosong.");
  }

  const orderNetLineTotal = order.subtotal - order.discountProductTotal;
  const orderNonProductDiscount = order.discountOrderTotal + order.discountManualTotal;
  const orderServiceTotal = order.serviceTotal;
  const orderTaxTotal = order.taxTotal;
  const orderGrandTotal = order.grandTotal;

  if (orderNetLineTotal <= 0) {
    throw new Error("Total net line pesanan tidak valid untuk alokasi split bill.");
  }

  let cumNetLine = historicalAllocations.reduce((sum, a) => sum + a.allocatedLineSubtotal, 0);
  let cumDisc = historicalAllocations.reduce((sum, a) => sum + a.allocatedDiscountShare, 0);
  let cumServ = historicalAllocations.reduce((sum, a) => sum + a.allocatedServiceShare, 0);
  let cumTax = historicalAllocations.reduce((sum, a) => sum + a.allocatedTaxShare, 0);

  const itemMap = new Map(orderItems.map((item) => [item.id, item]));
  const sortedRequests = [...requestedItems].sort((a, b) => a.orderItemId.localeCompare(b.orderItemId));

  const calculatedItems = [];

  for (let i = 0; i < sortedRequests.length; i++) {
    const req = sortedRequests[i];
    const orderItem = itemMap.get(req.orderItemId);

    if (!orderItem) {
      throw new Error(`Item pesanan dengan ID ${req.orderItemId} tidak ditemukan.`);
    }

    if (req.allocatedQuantity <= 0 || req.allocatedQuantity > orderItem.quantity) {
      throw new Error(`Kuantitas alokasi tidak valid untuk item ${orderItem.product_name_snapshot}.`);
    }

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

  if (isTerminalPayment) {
    const currentBatchCalculatedSum = calculatedItems.reduce((sum, item) => sum + item.allocatedFinalAmount, 0);
    const previousAllocatedSum = historicalAllocations.reduce((sum, a) => sum + a.allocatedFinalAmount, 0);
    const residualDiff = (orderGrandTotal - previousAllocatedSum) - currentBatchCalculatedSum;

    if (residualDiff !== 0 && calculatedItems.length > 0) {
      const lastIndex = calculatedItems.length - 1;
      calculatedItems[lastIndex].allocatedRoundingAdjustment += residualDiff;
      calculatedItems[lastIndex].allocatedFinalAmount += residualDiff;
    }
  }

  // Verifikasi Financial Invariant pada seluruh item
  for (const item of calculatedItems) {
    const expectedFinal = item.allocatedLineSubtotal - item.allocatedDiscountShare + item.allocatedServiceShare + item.allocatedTaxShare + item.allocatedRoundingAdjustment;
    assert.strictEqual(item.allocatedFinalAmount, expectedFinal, "Financial Invariant harus terpenuhi!");
  }

  const grossTotal = calculatedItems.reduce((sum, item) => sum + item.allocatedFinalAmount, 0);

  return {
    items: calculatedItems,
    grossTotal,
    isTerminalPayment,
  };
}

// Data Uji
const mockOrder = {
  subtotal: 90000,
  discountProductTotal: 10000,
  discountOrderTotal: 8000,
  discountManualTotal: 2000,
  discountTotal: 20000,
  serviceTotal: 3500,
  taxTotal: 7350,
  grandTotal: 80850,
  paidTotal: 0,
};

const mockOrderItems = [
  {
    id: "item-1",
    order_id: "order-1",
    product_id: "prod-1",
    product_name_snapshot: "Nasi Goreng Spesial",
    unit_price_snapshot: 30000,
    quantity: 2,
    subtotal: 60000,
    discount_amount: 10000,
    line_total: 50000,
  },
  {
    id: "item-2",
    order_id: "order-1",
    product_id: "prod-2",
    product_name_snapshot: "Es Teh Manis",
    unit_price_snapshot: 10000,
    quantity: 3,
    subtotal: 30000,
    discount_amount: 0,
    line_total: 30000,
  },
];

// Test 1: Full simultaneous
console.log("Test 1: Full allocation (all items)...");
const fullAlloc = calculateCumulativeItemAllocations({
  order: mockOrder,
  orderItems: mockOrderItems,
  historicalAllocations: [],
  requestedItems: [
    { orderItemId: "item-1", allocatedQuantity: 2 },
    { orderItemId: "item-2", allocatedQuantity: 3 },
  ],
  isTerminalPayment: true,
});
assert.strictEqual(fullAlloc.grossTotal, mockOrder.grandTotal);
console.log(`✓ Full allocation: Rp ${fullAlloc.grossTotal.toLocaleString()} === Rp ${mockOrder.grandTotal.toLocaleString()}`);

// Test 2: Split 2 Pelanggan (Step by step)
console.log("Test 2: Split 2 Pelanggan (Bertahap)...");
const trx1 = calculateCumulativeItemAllocations({
  order: mockOrder,
  orderItems: mockOrderItems,
  historicalAllocations: [],
  requestedItems: [
    { orderItemId: "item-1", allocatedQuantity: 2 },
  ],
  isTerminalPayment: false,
});

const trx2 = calculateCumulativeItemAllocations({
  order: mockOrder,
  orderItems: mockOrderItems,
  historicalAllocations: trx1.items,
  requestedItems: [
    { orderItemId: "item-2", allocatedQuantity: 3 },
  ],
  isTerminalPayment: true,
});

const total2 = trx1.grossTotal + trx2.grossTotal;
assert.strictEqual(total2, mockOrder.grandTotal);
console.log(`✓ Split 2 bertahap: Trx 1 (Rp ${trx1.grossTotal.toLocaleString()}) + Trx 2 (Rp ${trx2.grossTotal.toLocaleString()}) = Rp ${total2.toLocaleString()} (Selisih 0)`);

// Test 3: Partial Quantity 3 Steps
console.log("Test 3: Partial Quantity (3 transaksi pecahan)...");
const step1 = calculateCumulativeItemAllocations({
  order: mockOrder,
  orderItems: mockOrderItems,
  historicalAllocations: [],
  requestedItems: [{ orderItemId: "item-1", allocatedQuantity: 1 }],
  isTerminalPayment: false,
});

const step2 = calculateCumulativeItemAllocations({
  order: mockOrder,
  orderItems: mockOrderItems,
  historicalAllocations: step1.items,
  requestedItems: [
    { orderItemId: "item-1", allocatedQuantity: 1 },
    { orderItemId: "item-2", allocatedQuantity: 1 },
  ],
  isTerminalPayment: false,
});

const step3 = calculateCumulativeItemAllocations({
  order: mockOrder,
  orderItems: mockOrderItems,
  historicalAllocations: [...step1.items, ...step2.items],
  requestedItems: [{ orderItemId: "item-2", allocatedQuantity: 2 }],
  isTerminalPayment: true,
});

const total3 = step1.grossTotal + step2.grossTotal + step3.grossTotal;
assert.strictEqual(total3, mockOrder.grandTotal);
console.log(`✓ 3-Step Partial: Step 1 (Rp ${step1.grossTotal.toLocaleString()}) + Step 2 (Rp ${step2.grossTotal.toLocaleString()}) + Step 3 (Rp ${step3.grossTotal.toLocaleString()}) = Rp ${total3.toLocaleString()} (Selisih 0)`);

console.log("=== ALL CUMULATIVE ALLOCATION TESTS PASSED 100% ===");
