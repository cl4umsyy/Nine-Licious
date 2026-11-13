"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { CartPanel } from "@/components/pos/cart-panel";
import {
  DiscountModal,
  type ManualDiscountState,
} from "@/components/pos/discount-modal";
import { ModifierModal } from "@/components/pos/modifier-modal";
import { OrderCancelModal } from "@/components/pos/order-cancel-modal";
import { OrderConfirmationModal } from "@/components/pos/order-confirmation-modal";
import { ProductCatalog } from "@/components/pos/product-catalog";
import { TableSelectModal } from "@/components/pos/table-select-modal";
import { calculateCartTotalsWithDiscounts } from "@/lib/discounts/calculations";
import {
  createPosOrderAction,
  getActiveOrderForTableAction,
} from "@/lib/orders/actions";
import type {
  CartItem,
  OrderWithDetails,
  ProductWithModifiers,
} from "@/lib/orders/types";
import type {
  DiningTable,
  Discount,
  MenuCategory,
  TableZone,
} from "@/types/database";

export type PosContainerProps = {
  products: ProductWithModifiers[];
  categories: MenuCategory[];
  tables: DiningTable[];
  zones: TableZone[];
  taxPercent: number;
  serviceChargePercent: number;
  discounts?: Discount[];
  userRole?: string;
};

export function PosContainer({
  products,
  categories,
  tables,
  zones,
  taxPercent,
  serviceChargePercent,
  discounts = [],
  userRole = "kasir",
}: PosContainerProps) {
  // Cart & Order State
  const [cart, setCart] = useState<CartItem[]>([]);
  const [orderType, setOrderType] = useState<"dine_in" | "takeaway">("dine_in");
  const [selectedTable, setSelectedTable] = useState<DiningTable | null>(() => {
    // Default to first empty table if available
    return tables.find((t) => t.is_active && t.status === "empty") ?? null;
  });
  const [activeTableOrder, setActiveTableOrder] =
    useState<OrderWithDetails | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [orderNotes, setOrderNotes] = useState("");

  // Discount States
  const [selectedOrderPromo, setSelectedOrderPromo] =
    useState<Discount | null>(null);
  const [manualDiscount, setManualDiscount] =
    useState<ManualDiscountState | null>(null);
  const [isDiscountModalOpen, setIsDiscountModalOpen] = useState(false);

  // M-2: Idempotency key generated per submission attempt, preserved across retries
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() =>
    crypto.randomUUID(),
  );

  const refreshIdempotencyKey = () => {
    setIdempotencyKey(crypto.randomUUID());
  };

  const handleCartModification = () => {
    refreshIdempotencyKey();
    if (manualDiscount) {
      setManualDiscount(null);
      toast.warning(
        "Isi keranjang berubah. Diskon manual perlu otorisasi ulang dari Admin.",
      );
    }
  };

  // Modal States
  const [modifierProduct, setModifierProduct] =
    useState<ProductWithModifiers | null>(null);
  const [isTableModalOpen, setIsTableModalOpen] = useState(false);
  const [confirmedOrder, setConfirmedOrder] =
    useState<OrderWithDetails | null>(null);
  const [orderToCancel, setOrderToCancel] =
    useState<OrderWithDetails | null>(null);

  const [isSubmitting, startSubmitting] = useTransition();

  // Map category IDs for product discounts
  const productCategoryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of products) {
      if (p.category_id) {
        map.set(p.id, p.category_id);
      }
    }
    return map;
  }, [products]);

  // Authoritative calculations with multi-tiered discounts
  const totals = useMemo(() => {
    return calculateCartTotalsWithDiscounts({
      cart,
      taxPercent,
      serviceChargePercent,
      availableDiscounts: discounts,
      selectedOrderPromo,
      manualDiscount,
      productCategoryMap,
    });
  }, [
    cart,
    taxPercent,
    serviceChargePercent,
    discounts,
    selectedOrderPromo,
    manualDiscount,
    productCategoryMap,
  ]);

  // Handle selecting a product from catalog
  const handleSelectProduct = (product: ProductWithModifiers) => {
    const activeModifiers = product.modifierGroups.filter((g) => g.is_active);

    // If product has active modifier groups, open the modifier modal
    if (activeModifiers.length > 0) {
      setModifierProduct(product);
    } else {
      handleAddDirectProduct(product);
    }
  };

  const handleAddDirectProduct = (product: ProductWithModifiers) => {
    handleCartModification();
    setCart((prev) => {
      const existingIndex = prev.findIndex(
        (item) => item.productId === product.id && item.modifiers.length === 0,
      );

      if (existingIndex > -1) {
        const copy = [...prev];
        copy[existingIndex] = {
          ...copy[existingIndex],
          quantity: copy[existingIndex].quantity + 1,
        };
        return copy;
      }

      const newItem: CartItem = {
        id: `${product.id}-${Date.now()}`,
        productId: product.id,
        productName: product.name,
        productSku: product.sku,
        photoUrl: product.photo_url,
        unitPrice: product.price,
        quantity: 1,
        modifiers: [],
        kitchenStation: product.kitchen_station,
      };

      return [...prev, newItem];
    });

    toast.success(`Ditambahkan: ${product.name}`);
  };

  const handleAddToCart = (item: CartItem) => {
    handleCartModification();
    setCart((prev) => [...prev, item]);
    toast.success(`Ditambahkan: ${item.productName}`);
  };

  const handleUpdateQuantity = (cartItemId: string, delta: number) => {
    handleCartModification();
    setCart((prev) =>
      prev
        .map((item) => {
          if (item.id === cartItemId) {
            const nextQty = item.quantity + delta;
            return nextQty > 0 ? { ...item, quantity: nextQty } : null;
          }
          return item;
        })
        .filter((item): item is CartItem => item !== null),
    );
  };

  const handleRemoveItem = (cartItemId: string) => {
    handleCartModification();
    setCart((prev) => prev.filter((item) => item.id !== cartItemId));
  };

  const handleClearCart = () => {
    setCart([]);
    setSelectedOrderPromo(null);
    setManualDiscount(null);
    setCustomerName("");
    setOrderNotes("");
    refreshIdempotencyKey();
  };

  // Handle table selection with automatic detection of unpaid active orders
  const handleSelectTable = async (table: DiningTable) => {
    setSelectedTable(table);

    if (table.status === "awaiting_payment") {
      const res = await getActiveOrderForTableAction(table.id);
      if (res.ok && res.data) {
        setActiveTableOrder(res.data);
        toast.info(
          `Meja ${table.name} memiliki pesanan aktif #${res.data.order_number}. Item akan ditambahkan ke pesanan ini.`,
        );
      } else {
        setActiveTableOrder(null);
      }
    } else {
      setActiveTableOrder(null);
    }
  };

  const handleOrderTypeChange = (type: "dine_in" | "takeaway") => {
    setOrderType(type);
    if (type === "takeaway") {
      setActiveTableOrder(null);
    }
  };

  // Submit Order Action
  const handleSubmitOrder = () => {
    if (cart.length === 0 || isSubmitting) return;

    if (orderType === "dine_in" && !selectedTable) {
      toast.error("Pilih meja terlebih dahulu untuk pesanan Dine-in.");
      setIsTableModalOpen(true);
      return;
    }

    startSubmitting(async () => {
      // Siapkan payload diskon
      const discountsPayload = totals.appliedDiscounts.map((d) => ({
        scope: d.scope,
        clientItemId: d.clientItemId || null,
        discountId: d.discountId || null,
        name: d.name,
        discountType: d.discountType,
        discountRate: d.discountRate,
        approvalNonce: d.approvalNonce || null,
        reason: d.reason || null,
      }));

      const payload = {
        orderType,
        tableId: orderType === "dine_in" ? selectedTable?.id : null,
        customerName: orderType === "takeaway" ? customerName.trim() : null,
        notes: orderNotes.trim() || null,
        idempotencyKey: !activeTableOrder ? idempotencyKey : undefined,
        existingOrderId: activeTableOrder?.id,
        items: cart.map((item) => ({
          clientItemId: item.id,
          productId: item.productId,
          quantity: item.quantity,
          notes: item.notes || null,
          modifierOptionIds: item.modifiers.map((m) => m.optionId),
        })),
        discounts: !activeTableOrder ? discountsPayload : [],
      };

      const result = await createPosOrderAction(payload);

      if (result.ok && result.data) {
        toast.success(
          result.message ||
            `Pesanan ${result.data.order_number} berhasil disimpan.`,
        );
        setConfirmedOrder(result.data);
        handleClearCart();
        setActiveTableOrder(null);
      } else {
        toast.error(result.message || "Gagal menyimpan pesanan.");
      }
    });
  };

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[1fr_380px] xl:grid-cols-[1fr_420px] h-[calc(100vh-140px)] min-h-[580px]">
        {/* Left: Product Catalog */}
        <div className="h-full overflow-hidden flex flex-col">
          <ProductCatalog
            products={products}
            categories={categories}
            onSelectProduct={handleSelectProduct}
          />
        </div>

        {/* Right: Cart Panel */}
        <div className="h-full overflow-hidden flex flex-col">
          <CartPanel
            cart={cart}
            orderType={orderType}
            selectedTable={selectedTable}
            activeOrderNumber={activeTableOrder?.order_number}
            customerName={customerName}
            orderNotes={orderNotes}
            isSubmitting={isSubmitting}
            totals={totals}
            selectedOrderPromoName={selectedOrderPromo?.name}
            hasManualDiscount={manualDiscount !== null}
            onOpenDiscountModal={() => setIsDiscountModalOpen(true)}
            onOrderTypeChange={handleOrderTypeChange}
            onOpenTableModal={() => setIsTableModalOpen(true)}
            onCustomerNameChange={setCustomerName}
            onOrderNotesChange={setOrderNotes}
            onUpdateQuantity={handleUpdateQuantity}
            onRemoveItem={handleRemoveItem}
            onClearCart={handleClearCart}
            onSubmitOrder={handleSubmitOrder}
          />
        </div>
      </div>

      {/* Modals */}
      <DiscountModal
        isOpen={isDiscountModalOpen}
        onClose={() => setIsDiscountModalOpen(false)}
        cartSubtotal={totals.subtotal}
        availableDiscounts={discounts}
        selectedOrderPromo={selectedOrderPromo}
        onSelectOrderPromo={setSelectedOrderPromo}
        manualDiscount={manualDiscount}
        onApplyManualDiscount={setManualDiscount}
        idempotencyKey={idempotencyKey}
      />

      <ModifierModal
        product={modifierProduct}
        isOpen={modifierProduct !== null}
        onClose={() => setModifierProduct(null)}
        onAddToCart={handleAddToCart}
      />

      <TableSelectModal
        isOpen={isTableModalOpen}
        onClose={() => setIsTableModalOpen(false)}
        tables={tables}
        zones={zones}
        selectedTableId={selectedTable?.id}
        onSelectTable={handleSelectTable}
      />

      <OrderConfirmationModal
        order={confirmedOrder}
        isOpen={confirmedOrder !== null}
        onClose={() => setConfirmedOrder(null)}
        userRole={userRole}
        onOrderUpdated={(updated) => setConfirmedOrder(updated)}
        onOpenCancel={(order) => {
          setConfirmedOrder(null);
          setOrderToCancel(order);
        }}
      />

      <OrderCancelModal
        order={orderToCancel}
        isOpen={orderToCancel !== null}
        onClose={() => setOrderToCancel(null)}
        onSuccess={() => {
          setOrderToCancel(null);
          setActiveTableOrder(null);
        }}
      />
    </>
  );
}
