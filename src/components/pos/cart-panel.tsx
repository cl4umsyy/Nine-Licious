"use client";

import {
  ChevronRight,
  FileText,
  LoaderCircle,
  MapPin,
  Minus,
  Percent,
  Plus,
  ShoppingBag,
  Tag,
  Trash2,
  User,
  UtensilsCrossed,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { CartCalculationWithDiscounts } from "@/lib/discounts/types";
import { formatRupiah } from "@/lib/menu/format";
import { calculateItemSubtotal } from "@/lib/orders/calculations";
import type { CartItem } from "@/lib/orders/types";
import type { DiningTable, OrderType } from "@/types/database";

export type CartPanelProps = {
  cart: CartItem[];
  orderType: OrderType;
  selectedTable: DiningTable | null;
  activeOrderNumber?: string | null;
  customerName: string;
  orderNotes: string;
  isSubmitting: boolean;
  totals: CartCalculationWithDiscounts;
  selectedOrderPromoName?: string | null;
  hasManualDiscount?: boolean;
  onOpenDiscountModal: () => void;
  onOrderTypeChange: (type: OrderType) => void;
  onOpenTableModal: () => void;
  onCustomerNameChange: (name: string) => void;
  onOrderNotesChange: (notes: string) => void;
  onUpdateQuantity: (cartItemId: string, delta: number) => void;
  onRemoveItem: (cartItemId: string) => void;
  onClearCart: () => void;
  onSubmitOrder: () => void;
};

export function CartPanel({
  cart,
  orderType,
  selectedTable,
  activeOrderNumber,
  customerName,
  orderNotes,
  isSubmitting,
  totals,
  selectedOrderPromoName,
  hasManualDiscount,
  onOpenDiscountModal,
  onOrderTypeChange,
  onOpenTableModal,
  onCustomerNameChange,
  onOrderNotesChange,
  onUpdateQuantity,
  onRemoveItem,
  onClearCart,
  onSubmitOrder,
}: CartPanelProps) {
  const isDineIn = orderType === "dine_in";
  const canSubmit =
    cart.length > 0 && (!isDineIn || selectedTable !== null) && !isSubmitting;

  return (
    <Card className="flex flex-col h-full border-border/80 shadow-sm overflow-hidden bg-card">
      {/* Header: Order Type Switcher & Table Indicator */}
      <CardHeader className="p-4 pb-3 border-b bg-muted/20 space-y-3 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShoppingBag className="size-4 text-primary" />
            <h2 className="font-display font-bold text-base">Keranjang Pesanan</h2>
          </div>
          <Badge variant="outline" className="text-xs h-6 px-2">
            {totals.itemsCount} item
          </Badge>
        </div>

        {/* Order Type Buttons */}
        <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-muted/60 border">
          <Button
            type="button"
            variant={isDineIn ? "default" : "ghost"}
            size="sm"
            onClick={() => onOrderTypeChange("dine_in")}
            className={`h-8 text-xs font-semibold rounded-lg ${
              isDineIn ? "bg-primary text-primary-foreground shadow-sm" : ""
            }`}
          >
            <UtensilsCrossed className="size-3.5 mr-1.5" />
            Dine-in
          </Button>

          <Button
            type="button"
            variant={!isDineIn ? "default" : "ghost"}
            size="sm"
            onClick={() => onOrderTypeChange("takeaway")}
            className={`h-8 text-xs font-semibold rounded-lg ${
              !isDineIn ? "bg-primary text-primary-foreground shadow-sm" : ""
            }`}
          >
            <ShoppingBag className="size-3.5 mr-1.5" />
            Takeaway
          </Button>
        </div>

        {/* Dine-in Table Selector OR Takeaway Customer Input */}
        {isDineIn ? (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenTableModal}
              className={`w-full justify-between h-9 text-xs font-medium border ${
                selectedTable
                  ? "border-primary/40 bg-brand-soft/20 text-foreground"
                  : "border-dashed border-amber-500/50 text-amber-900 bg-amber-50/50 dark:text-amber-200 dark:bg-amber-950/30"
              }`}
            >
              <div className="flex items-center gap-1.5 truncate">
                <MapPin className="size-3.5 text-primary shrink-0" />
                {selectedTable ? (
                  <span className="truncate">
                    Meja: <strong className="font-bold text-primary">{selectedTable.name}</strong> ({selectedTable.capacity} orang)
                  </span>
                ) : (
                  <span>Pilih Meja Dine-in (Wajib)</span>
                )}
              </div>
              <ChevronRight className="size-4 text-muted-foreground shrink-0" />
            </Button>
          </div>
        ) : (
          <div className="space-y-1">
            <div className="relative">
              <User className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Nama Pelanggan (opsional)"
                value={customerName}
                onChange={(e) => onCustomerNameChange(e.target.value)}
                className="pl-8 h-8 text-xs"
                maxLength={80}
              />
            </div>
          </div>
        )}

        {/* Optional Order Notes */}
        <div className="relative">
          <FileText className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Catatan pesanan keseluruhan (opsional)"
            value={orderNotes}
            onChange={(e) => onOrderNotesChange(e.target.value)}
            className="pl-8 h-8 text-xs"
            maxLength={200}
          />
        </div>

        {/* Active Order Banner if Appending Items */}
        {isDineIn && activeOrderNumber && (
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-2 text-xs flex items-center justify-between text-amber-800 dark:text-amber-300">
            <span className="font-medium truncate mr-1">
              Mode Tambah Item: <strong>#{activeOrderNumber}</strong>
            </span>
            <Badge variant="outline" className="text-[10px] h-4 shrink-0 border-amber-400">
              Belum Lunas
            </Badge>
          </div>
        )}

        {/* Additional Order Banner if Table is Occupied */}
        {isDineIn && !activeOrderNumber && selectedTable?.status === "occupied" && (
          <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 p-2 text-xs flex items-center justify-between text-rose-800 dark:text-rose-300">
            <span className="font-medium truncate mr-1">
              Mode: <strong>Pesanan Tambahan</strong> (Sesi Meja {selectedTable.name})
            </span>
            <Badge variant="outline" className="text-[10px] h-4 shrink-0 border-rose-400">
              Terisi
            </Badge>
          </div>
        )}
      </CardHeader>

      {/* Cart Items List */}
      <CardContent className="flex-1 overflow-y-auto p-4 space-y-3">
        {cart.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-6 text-muted-foreground space-y-2">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted/60 text-muted-foreground/60">
              <ShoppingBag className="size-6" />
            </div>
            <p className="font-semibold text-sm">Keranjang masih kosong</p>
            <p className="text-xs max-w-[200px]">
              Pilih menu dari katalog di sebelah kiri untuk menyusun pesanan.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {cart.map((item) => {
              const itemSubtotal = calculateItemSubtotal(item);
              const appliedItemDiscount = totals.appliedDiscounts.find(
                (d) => d.scope === "product" && d.clientItemId === item.id,
              );

              return (
                <div
                  key={item.id}
                  className="group flex flex-col p-3 rounded-xl border bg-card/60 hover:bg-muted/20 transition-all text-xs space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-0.5 flex-1 min-w-0">
                      <div className="font-bold text-sm text-foreground truncate">
                        {item.productName}
                      </div>
                      <div className="text-muted-foreground font-medium">
                        {formatRupiah(item.unitPrice)}
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      {appliedItemDiscount ? (
                        <div>
                          <div className="line-through text-muted-foreground text-[11px]">
                            {formatRupiah(itemSubtotal)}
                          </div>
                          <div className="font-bold text-sm text-primary font-mono">
                            {formatRupiah(itemSubtotal - appliedItemDiscount.discountAmount)}
                          </div>
                        </div>
                      ) : (
                        <div className="font-bold text-sm text-primary font-mono">
                          {formatRupiah(itemSubtotal)}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Modifiers List */}
                  {item.modifiers.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {item.modifiers.map((mod) => (
                        <span
                          key={mod.optionId}
                          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground border"
                        >
                          {mod.name}
                          {mod.priceDelta > 0 && ` (+${formatRupiah(mod.priceDelta)})`}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Product Promo Badge */}
                  {appliedItemDiscount && (
                    <div className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold">
                      <Percent className="size-3" />
                      <span>
                        Diskon: {appliedItemDiscount.name} (-{formatRupiah(appliedItemDiscount.discountAmount)})
                      </span>
                    </div>
                  )}

                  {/* Special Notes */}
                  {item.notes && (
                    <p className="text-[11px] italic text-muted-foreground bg-muted/40 p-1.5 rounded">
                      &ldquo;{item.notes}&rdquo;
                    </p>
                  )}

                  {/* Stepper & Delete */}
                  <div className="flex items-center justify-between pt-1">
                    <button
                      type="button"
                      onClick={() => onRemoveItem(item.id)}
                      className="text-muted-foreground hover:text-destructive p-1 rounded transition-colors"
                      aria-label="Hapus item"
                    >
                      <Trash2 className="size-3.5" />
                    </button>

                    <div className="flex items-center border rounded-lg bg-background">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => onUpdateQuantity(item.id, -1)}
                      >
                        <Minus className="size-3" />
                      </Button>
                      <span className="w-7 text-center font-bold text-xs font-mono">
                        {item.quantity}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => onUpdateQuantity(item.id, 1)}
                      >
                        <Plus className="size-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {/* Footer: Order Calculation & Submit Action */}
      <CardFooter className="flex-col p-4 border-t bg-muted/20 space-y-3 shrink-0">
        {/* Diskon & Promo Quick Button */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenDiscountModal}
          className={`w-full justify-between h-8 text-xs font-medium border ${
            totals.discountTotal > 0
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-border/80 text-foreground"
          }`}
        >
          <div className="flex items-center gap-1.5 truncate">
            <Tag className="size-3.5 text-primary shrink-0" />
            <span className="truncate">
              {totals.discountTotal > 0 ? (
                <>
                  Diskon Aktif:{" "}
                  <strong>-{formatRupiah(totals.discountTotal)}</strong>
                  {selectedOrderPromoName && ` (${selectedOrderPromoName})`}
                  {hasManualDiscount && " [Manual]"}
                </>
              ) : (
                "Pilih Promo & Diskon Manual"
              )}
            </span>
          </div>
          <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
        </Button>

        <div className="w-full space-y-1.5 text-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Subtotal</span>
            <span className="font-mono font-medium">
              {formatRupiah(totals.subtotal)}
            </span>
          </div>

          {/* Rincian Diskon Produk */}
          {totals.discountProductTotal > 0 && (
            <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
              <span>Diskon Menu</span>
              <span className="font-mono font-medium">
                -{formatRupiah(totals.discountProductTotal)}
              </span>
            </div>
          )}

          {/* Rincian Diskon Promo Pesanan */}
          {totals.discountOrderTotal > 0 && (
            <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
              <span>Promo Pesanan {selectedOrderPromoName && `(${selectedOrderPromoName})`}</span>
              <span className="font-mono font-medium">
                -{formatRupiah(totals.discountOrderTotal)}
              </span>
            </div>
          )}

          {/* Rincian Diskon Manual */}
          {totals.discountManualTotal > 0 && (
            <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
              <span>Diskon Manual [Admin]</span>
              <span className="font-mono font-medium">
                -{formatRupiah(totals.discountManualTotal)}
              </span>
            </div>
          )}

          {/* Total Diskon & Dasar Kena Pajak jika diskon > 0 */}
          {totals.discountTotal > 0 && (
            <>
              <div className="flex items-center justify-between text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                <span>Total Diskon</span>
                <span className="font-mono">
                  -{formatRupiah(totals.discountTotal)}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-0.5">
                <span>Dasar Kena Pajak (Taxable Base)</span>
                <span className="font-mono">
                  {formatRupiah(totals.taxableBase)}
                </span>
              </div>
            </>
          )}

          <div className="flex items-center justify-between text-muted-foreground">
            <span>Pajak ({totals.taxPercent}%)</span>
            <span className="font-mono font-medium">
              {formatRupiah(totals.taxTotal)}
            </span>
          </div>

          <div className="flex items-center justify-between text-muted-foreground">
            <span>Service Charge ({totals.serviceChargePercent}%)</span>
            <span className="font-mono font-medium">
              {formatRupiah(totals.serviceTotal)}
            </span>
          </div>

          <Separator className="my-1.5" />

          <div className="flex items-center justify-between text-sm font-bold">
            <span>Grand Total</span>
            <span className="font-display text-base text-primary">
              {formatRupiah(totals.grandTotal)}
            </span>
          </div>
        </div>

        {/* Warning if Dine-in without Table */}
        {isDineIn && !selectedTable && cart.length > 0 && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400 font-medium text-center">
            Pilih meja terlebih dahulu untuk menyelesaikan pesanan Dine-in.
          </p>
        )}

        {/* Buttons */}
        <div className="w-full flex items-center gap-2">
          {cart.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClearCart}
              disabled={isSubmitting}
              className="text-xs px-2.5 text-muted-foreground hover:text-destructive"
            >
              Reset
            </Button>
          )}

          <Button
            type="button"
            size="lg"
            disabled={!canSubmit}
            onClick={onSubmitOrder}
            className="flex-1 font-bold text-sm h-11 bg-primary text-primary-foreground shadow hover:bg-primary/95"
          >
            {isSubmitting ? (
              <>
                <LoaderCircle className="size-4 mr-2 animate-spin" />
                {activeOrderNumber ? "Menambahkan Item..." : "Menyimpan Pesanan..."}
              </>
            ) : activeOrderNumber ? (
              `Tambah ke #${activeOrderNumber} (+${formatRupiah(totals.grandTotal)})`
            ) : (
              `Simpan Pesanan (${formatRupiah(totals.grandTotal)})`
            )}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
