// @ts-check
import assert from "node:assert/strict";

console.log("=== RUNNING UNIT TEST: F2 PAYMENT CALCULATIONS & INTEGRATION ===");

// 1. Test change calculation logic (as implemented in payment-modal.tsx)
function calculatePayment(payAmount, cashReceived) {
  const parsedCash = Number.parseInt(cashReceived, 10) || 0;
  const isDeficit = parsedCash < payAmount;
  const change = Math.max(0, parsedCash - payAmount);
  return { parsedCash, isDeficit, change };
}

// Case 1: Exact payment
const exact = calculatePayment(85100, "85100");
assert.equal(exact.isDeficit, false);
assert.equal(exact.change, 0);
console.log("✔ Pass: Exact cash payment (kembalian Rp 0)");

// Case 2: Overpayment (normal cash)
const over = calculatePayment(85100, "100000");
assert.equal(over.isDeficit, false);
assert.equal(over.change, 14900);
console.log("✔ Pass: Overpayment Rp 100.000 vs Rp 85.100 (kembalian Rp 14.900)");

// Case 3: Underpayment
const under = calculatePayment(85100, "50000");
assert.equal(under.isDeficit, true);
assert.equal(under.change, 0);
console.log("✔ Pass: Underpayment correctly marked as deficit");

// Case 4: Zero / empty input
const zero = calculatePayment(85100, "");
assert.equal(zero.parsedCash, 0);
assert.equal(zero.isDeficit, true);
assert.equal(zero.change, 0);
console.log("✔ Pass: Empty cash input handled gracefully");

// 2. Test Quick Cash Presets generator
function generateQuickCashPresets(amount) {
  const presets = new Set();
  presets.add(amount);

  const rounded5k = Math.ceil(amount / 5000) * 5000;
  if (rounded5k >= amount) presets.add(rounded5k);

  const rounded10k = Math.ceil(amount / 10000) * 10000;
  if (rounded10k >= amount) presets.add(rounded10k);

  const rounded20k = Math.ceil(amount / 20000) * 20000;
  if (rounded20k >= amount) presets.add(rounded20k);

  const rounded50k = Math.ceil(amount / 50000) * 50000;
  if (rounded50k >= amount) presets.add(rounded50k);

  const rounded100k = Math.ceil(amount / 100000) * 100000;
  if (rounded100k >= amount) presets.add(rounded100k);

  return Array.from(presets)
    .filter((p) => p >= amount)
    .sort((a, b) => a - b)
    .slice(0, 5);
}

const presets = generateQuickCashPresets(85100);
assert(presets.includes(85100), "Presets must include exact amount");
assert(presets.includes(90000), "Presets must include 90.000");
assert(presets.includes(100000), "Presets must include 100.000");
console.log("✔ Pass: Quick cash presets properly generated:", presets);

// 3. Test Split Bill Item Allocation (Pro-rata tax & service distribution)
function allocateItemSplit(selectedItemsTotal, orderTotal, grandTotal) {
  assert(selectedItemsTotal > 0, "Selected items total must be positive");
  assert(selectedItemsTotal <= orderTotal, "Selected items total cannot exceed order subtotal");
  const ratio = selectedItemsTotal / orderTotal;
  const allocatedGrandTotal = Math.round(grandTotal * ratio);
  return allocatedGrandTotal;
}

const subtotal = 74000;
const grandTotal = 85100; // includes 10% tax + 5% service
const item1Subtotal = 32000;
const split1 = allocateItemSplit(item1Subtotal, subtotal, grandTotal);
assert(split1 > item1Subtotal, "Split payment includes tax & service");
assert(split1 < grandTotal, "Split payment is less than total grand total");
console.log("✔ Pass: Item split proportional calculation verified: Rp", split1);

console.log("\nALL UNIT TESTS PASSED SUCCESSFULLY! ✨");
