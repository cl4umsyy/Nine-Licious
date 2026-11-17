"use client";

import { useMemo, useState, useTransition } from "react";
import { ChevronRight, ShoppingBag, Utensils } from "lucide-react";
import { toast } from "sonner";
import { CartPanel } from "@/components/pos/cart-panel";
import {
  DiscountModal,
  type ManualDiscountState,
} from "@/components/pos/discount-modal";
import { ModifierModal } from "@/components/pos/modifier-modal";
import { OrderCancelModal } from "@/components/pos/order-cancel-modal";
import { OrderConfirmationModal } from "@/components/pos/order-confirmation-modal";
import { PaymentModal } from "@/components/pos/payment-modal";
import { ProductCatalog } from "@/components/pos/product-catalog";
import { ReceiptModal } from "@/components/pos/receipt-modal";
import { TableSelectModal } from "@/components/pos/table-select-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { calculateCartTotalsWithDiscounts } from "@/lib/discounts/calculations";
import { formatRupiah } from "@/lib/menu/format";
import {
  createPosOrderAction,
  getActiveOrderForTableAction,
} from "@/lib/orders/actions";
import type {
  CartItem,
  OrderWithDetails,
  ProductWithModifiers,
} from "@/lib/orders/types";
import { cn } from "@/lib/utils";
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
  const [paymentOrder, setPaymentOrder] =
    useState<OrderWithDetails | null>(null);
  const [receiptOrderId, setReceiptOrderId] =
    useState<string | null>(null);
  const [orderToCancel, setOrderToCancel] =
    useState<OrderWithDetails | null>(null);
  const [mobileTab, setMobileTab] = useState<"catalog" | "cart">("catalog");

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

  // Handle table selection with automatic detection of unpaid active orders or additional orders
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
        toast.error(
          `Tidak ditemukan pesanan aktif belum lunas pada Meja ${table.name}. Silakan pilih meja kembali.`,
        );
      }
    } else if (table.status === "occupied") {
      setActiveTableOrder(null);
      toast.info(
        `Meja ${table.name} sedang terisi (occupied). Pesanan ini akan diproses sebagai Pesanan Tambahan pada sesi aktif meja.`,
      );
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

    if (
      orderType === "dine_in" &&
      selectedTable?.status === "awaiting_payment" &&
      !activeTableOrder
    ) {
      toast.error(
        `Meja "${selectedTable.name}" sedang menunggu pembayaran. Tidak dapat membuat pesanan baru; silakan pilih meja kembali untuk menambahkan item ke pesanan aktif.`,
      );
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
      {/* Mobile Tab Switcher */}
      <div className="flex lg:hidden items-center justify-between p-1 bg-muted/60 rounded-xl border mb-3">
        <button
          type="button"
          onClick={() => setMobileTab("catalog")}
          className={cn(
            "flex-1 py-2 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5",
            mobileTab === "catalog"
              ? "bg-card text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Utensils className="size-3.5" />
          Katalog Menu ({products.length})
        </button>
        <button
          type="button"
          onClick={() => setMobileTab("cart")}
          className={cn(
            "flex-1 py-2 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5",
            mobileTab === "cart"
              ? "bg-card text-primary shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <ShoppingBag className="size-3.5" />
          Keranjang
          {totals.itemsCount > 0 && (
            <Badge
              variant="default"
              className="text-[10px] h-4.5 px-1.5 bg-primary text-primary-foreground font-mono"
            >
              {totals.itemsCount}
            </Badge>
          )}
        </button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col lg:grid lg:grid-cols-[1fr_380px] xl:grid-cols-[1fr_420px] gap-3">
        {/* Left: Product Catalog */}
        <div
          className={cn(
            "h-full min-h-0 overflow-hidden flex flex-col",
            mobileTab !== "catalog" && "hidden lg:flex",
          )}
        >
          <ProductCatalog
            products={products}
            categories={categories}
            onSelectProduct={handleSelectProduct}
          />
        </div>

        {/* Right: Cart Panel */}
        <div
          className={cn(
            "h-full min-h-0 overflow-hidden flex flex-col",
            mobileTab !== "cart" && "hidden lg:flex",
          )}
        >
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

      {/* Mobile Floating Cart Summary Button */}
      {mobileTab === "catalog" && cart.length > 0 && (
        <div className="lg:hidden fixed bottom-4 left-4 right-4 z-40">
          <Button
            type="button"
            onClick={() => setMobileTab("cart")}
            className="w-full h-12 shadow-lg bg-primary text-primary-foreground font-bold text-sm rounded-2xl flex items-center justify-between px-4"
          >
            <div className="flex items-center gap-2">
              <Badge
                variant="secondary"
                className="bg-primary-foreground/20 text-primary-foreground text-xs font-mono"
              >
                {totals.itemsCount} item
              </Badge>
              <span>Lihat Keranjang</span>
            </div>
            <div className="flex items-center gap-1 font-mono">
              <span>{formatRupiah(totals.grandTotal)}</span>
              <ChevronRight className="size-4" />
            </div>
          </Button>
        </div>
      )}

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
        onOrderUpdated={(updated) => {
          setConfirmedOrder(updated);
          if (paymentOrder?.id === updated.id) {
            setPaymentOrder(updated);
          }
        }}
        onOpenCancel={(order) => {
          setConfirmedOrder(null);
          setOrderToCancel(order);
        }}
        onOpenPayment={(order) => {
          setConfirmedOrder(null);
          setPaymentOrder(order);
        }}
        onOpenReceipt={(orderId) => {
          setReceiptOrderId(orderId);
        }}
      />

      <PaymentModal
        order={paymentOrder}
        isOpen={paymentOrder !== null}
        onClose={() => {
          if (paymentOrder) {
            setConfirmedOrder(paymentOrder);
          }
          setPaymentOrder(null);
        }}
        onPaymentSuccess={(orderId, isSettled) => {
          setPaymentOrder(null);
          if (isSettled) {
            setConfirmedOrder(null);
            setReceiptOrderId(orderId);
          } else {
            toast.info("Pembayaran parsial berhasil dicatat.");
            if (paymentOrder) {
              setConfirmedOrder(paymentOrder);
            }
          }
        }}
      />

      <ReceiptModal
        orderId={receiptOrderId}
        isOpen={receiptOrderId !== null}
        onClose={() => setReceiptOrderId(null)}
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
