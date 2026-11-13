import { calculateItemSubtotal } from "@/lib/orders/calculations";
import type { CartItem } from "@/lib/orders/types";
import type { Discount } from "@/types/database";
import type {
  AppliedCartDiscount,
  CartCalculationWithDiscounts,
} from "@/lib/discounts/types";

/**
 * Menghitung rincian total keranjang pesanan beserta diskon berjenjang (F1.4):
 * 1. Diskon Produk (Product Discount): diaplikasikan per item yang cocok.
 * 2. Diskon Pesanan (Order Discount): diaplikasikan ke sisa subtotal setelah diskon produk.
 * 3. Diskon Manual (Manual Discount): diaplikasikan ke sisa setelah diskon produk & order.
 * 4. Pajak & Service Charge: dihitung dari basis kena pajak (Taxable Base).
 * 5. Grand Total = Taxable Base + Pajak + Service Charge.
 *
 * Seluruh perhitungan menggunakan integer rupiah dan pembulatan round standard
 * yang sinkron 100% dengan RPC database create_pos_order_atomic.
 */
export function calculateCartTotalsWithDiscounts({
  cart,
  taxPercent = 10,
  serviceChargePercent = 5,
  availableDiscounts = [],
  selectedOrderPromo = null,
  manualDiscount = null,
  productCategoryMap = new Map<string, string>(), // productId -> categoryId
}: {
  cart: CartItem[];
  taxPercent?: number;
  serviceChargePercent?: number;
  availableDiscounts?: Discount[];
  selectedOrderPromo?: Discount | null;
  manualDiscount?: {
    type: "percentage" | "fixed";
    value: number;
    reason: string;
    nonce: string;
    approverName?: string;
  } | null;
  productCategoryMap?: Map<string, string>;
}): CartCalculationWithDiscounts {
  const itemsCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = cart.reduce(
    (sum, item) => sum + calculateItemSubtotal(item),
    0,
  );

  const safeTaxPercent = Math.max(0, taxPercent);
  const safeServicePercent = Math.max(0, serviceChargePercent);
  const appliedDiscounts: AppliedCartDiscount[] = [];

  let discountProductTotal = 0;

  // 1. Hitung Diskon Produk
  const activeProductDiscounts = availableDiscounts.filter(
    (d) => d.is_active && d.scope === "product",
  );

  for (const item of cart) {
    const itemSubtotal = calculateItemSubtotal(item);
    if (itemSubtotal <= 0) continue;

    const categoryId = productCategoryMap.get(item.productId);

    // Cari promo produk yang cocok untuk item ini (prioritas: target produk spesifik, lalu target kategori, lalu global)
    const matchingDiscount = activeProductDiscounts.find((d) => {
      if (d.applies_to_product_id) {
        return d.applies_to_product_id === item.productId;
      }
      if (d.applies_to_category_id) {
        return categoryId && d.applies_to_category_id === categoryId;
      }
      return true; // berlaku untuk semua produk
    });

    if (matchingDiscount) {
      let itemDiscount = 0;
      if (matchingDiscount.discount_type === "percentage") {
        itemDiscount = Math.round(
          (itemSubtotal * matchingDiscount.discount_value) / 100,
        );
        if (
          matchingDiscount.max_discount_amount &&
          itemDiscount > matchingDiscount.max_discount_amount
        ) {
          itemDiscount = matchingDiscount.max_discount_amount;
        }
      } else {
        itemDiscount = Math.round(matchingDiscount.discount_value);
      }

      // Diskon tidak boleh melebihi subtotal item
      itemDiscount = Math.min(itemDiscount, itemSubtotal);

      if (itemDiscount > 0) {
        discountProductTotal += itemDiscount;
        appliedDiscounts.push({
          scope: "product",
          clientItemId: item.id,
          discountId: matchingDiscount.id,
          name: matchingDiscount.name,
          discountType: matchingDiscount.discount_type,
          discountRate: matchingDiscount.discount_value,
          discountAmount: itemDiscount,
        });
      }
    }
  }

  const subtotalAfterProduct = Math.max(0, subtotal - discountProductTotal);

  // 2. Hitung Diskon Promo Pesanan (Order Scope)
  let discountOrderTotal = 0;
  if (selectedOrderPromo && selectedOrderPromo.is_active && selectedOrderPromo.scope === "order") {
    // Cek syarat minimal pembelian terhadap subtotal sebelum diskon
    if (
      !selectedOrderPromo.min_order_amount ||
      subtotal >= selectedOrderPromo.min_order_amount
    ) {
      let orderPromoAmount = 0;
      if (selectedOrderPromo.discount_type === "percentage") {
        orderPromoAmount = Math.round(
          (subtotalAfterProduct * selectedOrderPromo.discount_value) / 100,
        );
        if (
          selectedOrderPromo.max_discount_amount &&
          orderPromoAmount > selectedOrderPromo.max_discount_amount
        ) {
          orderPromoAmount = selectedOrderPromo.max_discount_amount;
        }
      } else {
        orderPromoAmount = Math.round(selectedOrderPromo.discount_value);
      }

      orderPromoAmount = Math.min(orderPromoAmount, subtotalAfterProduct);

      if (orderPromoAmount > 0) {
        discountOrderTotal = orderPromoAmount;
        appliedDiscounts.push({
          scope: "order",
          discountId: selectedOrderPromo.id,
          name: selectedOrderPromo.name,
          discountType: selectedOrderPromo.discount_type,
          discountRate: selectedOrderPromo.discount_value,
          discountAmount: orderPromoAmount,
        });
      }
    }
  }

  // 3. Hitung Diskon Manual (Manual Scope)
  let discountManualTotal = 0;
  const manualBase = Math.max(0, subtotalAfterProduct - discountOrderTotal);

  if (manualDiscount && manualDiscount.value > 0 && manualBase > 0) {
    let manualAmount = 0;
    if (manualDiscount.type === "percentage") {
      manualAmount = Math.round((manualBase * manualDiscount.value) / 100);
    } else {
      manualAmount = Math.round(manualDiscount.value);
    }

    manualAmount = Math.min(manualAmount, manualBase);

    if (manualAmount > 0) {
      discountManualTotal = manualAmount;
      appliedDiscounts.push({
        scope: "manual",
        name: "Diskon Manual",
        discountType: manualDiscount.type,
        discountRate: manualDiscount.value,
        discountAmount: manualAmount,
        approvalNonce: manualDiscount.nonce,
        reason: manualDiscount.reason,
        approverName: manualDiscount.approverName,
      });
    }
  }

  // 4. Agregasi Akhir
  const discountTotal = Math.min(
    subtotal,
    discountProductTotal + discountOrderTotal + discountManualTotal,
  );
  const taxableBase = Math.max(0, subtotal - discountTotal);
  const taxTotal = Math.round((taxableBase * safeTaxPercent) / 100);
  const serviceTotal = Math.round((taxableBase * safeServicePercent) / 100);
  const grandTotal = taxableBase + taxTotal + serviceTotal;

  return {
    itemsCount,
    subtotal,
    discountProductTotal,
    discountOrderTotal,
    discountManualTotal,
    discountTotal,
    taxableBase,
    taxPercent: safeTaxPercent,
    taxTotal,
    serviceChargePercent: safeServicePercent,
    serviceTotal,
    grandTotal,
    appliedDiscounts,
  };
}

