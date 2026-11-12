import type { CartCalculation, CartItem } from "@/lib/orders/types";

/**
 * Menghitung subtotal satu item keranjang:
 * (harga produk + total selisih harga modifier) * jumlah
 */
export function calculateItemSubtotal(item: CartItem): number {
  const modifierTotal = item.modifiers.reduce(
    (sum, mod) => sum + mod.priceDelta,
    0,
  );
  const unitWithModifiers = Math.max(0, item.unitPrice + modifierTotal);
  return unitWithModifiers * item.quantity;
}

/**
 * Menghitung rincian pembayaran keranjang pesanan sesuai aturan PRD Bagian 8:
 * - Subtotal = jumlah subtotal seluruh baris item
 * - Pajak = round(subtotal * (taxPercent / 100))
 * - Service charge = round(subtotal * (serviceChargePercent / 100))
 * - Grand Total = subtotal + pajak + service charge
 */
export function calculateCartTotals(
  items: CartItem[],
  taxPercent: number = 10,
  serviceChargePercent: number = 5,
): CartCalculation {
  const itemsCount = items.reduce((acc, item) => acc + item.quantity, 0);

  const subtotal = items.reduce(
    (acc, item) => acc + calculateItemSubtotal(item),
    0,
  );

  const safeTaxPercent = Math.max(0, taxPercent);
  const safeServicePercent = Math.max(0, serviceChargePercent);

  const taxTotal = Math.round((subtotal * safeTaxPercent) / 100);
  const serviceTotal = Math.round((subtotal * safeServicePercent) / 100);
  const grandTotal = subtotal + taxTotal + serviceTotal;

  return {
    itemsCount,
    subtotal,
    taxPercent: safeTaxPercent,
    taxTotal,
    serviceChargePercent: safeServicePercent,
    serviceTotal,
    grandTotal,
  };
}

