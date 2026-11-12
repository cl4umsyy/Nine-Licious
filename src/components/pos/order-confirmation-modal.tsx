"use client";

import {
  Ban,
  Clock,
  CreditCard,
  MapPin,
  PlusCircle,
  ShoppingBag,
  UtensilsCrossed,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { formatRupiah } from "@/lib/menu/format";
import {
  ORDER_STATUS_BADGES,
  ORDER_STATUS_LABELS,
  ORDER_TYPE_LABELS,
} from "@/lib/orders/constants";
import type { OrderWithDetails } from "@/lib/orders/types";

export type OrderConfirmationModalProps = {
  order: OrderWithDetails | null;
  isOpen: boolean;
  onClose: () => void;
  onOpenCancel: (order: OrderWithDetails) => void;
};

export function OrderConfirmationModal({
  order,
  isOpen,
  onClose,
  onOpenCancel,
}: OrderConfirmationModalProps) {
  if (!order) return null;

  const isDineIn = order.order_type === "dine_in";
  const badgeConfig = ORDER_STATUS_BADGES[order.status];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0 overflow-hidden sm:max-w-xl">
        {/* Header */}
        <DialogHeader className="p-5 pb-4 border-b bg-muted/20">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">
              <Clock className="size-6" />
            </div>
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <DialogTitle className="text-lg font-bold font-display">
                  Pesanan Tersimpan
                </DialogTitle>
                <Badge
                  variant={badgeConfig.variant}
                  className={`text-[11px] font-semibold h-5 px-2 ${badgeConfig.className}`}
                >
                  {ORDER_STATUS_LABELS[order.status]}
                </Badge>
              </div>
              <DialogDescription className="text-xs">
                Nomor: <strong className="font-mono text-foreground font-bold">{order.order_number}</strong>
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Metadata Cards */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="p-3 rounded-xl border bg-muted/30 space-y-1">
              <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
                {isDineIn ? (
                  <UtensilsCrossed className="size-3 text-primary" />
                ) : (
                  <ShoppingBag className="size-3 text-primary" />
                )}
                Tipe Pesanan
              </span>
              <p className="font-bold text-foreground">
                {ORDER_TYPE_LABELS[order.order_type]}
              </p>
            </div>

            <div className="p-3 rounded-xl border bg-muted/30 space-y-1">
              <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
                <MapPin className="size-3 text-primary" />
                Lokasi / Meja
              </span>
              <p className="font-bold text-foreground">
                {isDineIn
                  ? order.tableName || "Meja Dine-in"
                  : order.customer_name || "Pelanggan Takeaway"}
              </p>
            </div>
          </div>

          {/* Items Summary */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Daftar Menu ({order.items.length})
            </h4>

            <div className="rounded-xl border divide-y bg-card text-xs">
              {order.items.map((item) => (
                <div key={item.id} className="p-3 flex items-start justify-between gap-3">
                  <div className="space-y-1 flex-1">
                    <div className="font-semibold text-foreground">
                      <span className="font-bold text-primary mr-1.5">
                        {item.quantity}x
                      </span>
                      {item.product_name_snapshot}
                    </div>

                    {item.modifiers.length > 0 && (
                      <div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                        {item.modifiers.map((m) => (
                          <span
                            key={m.id}
                            className="bg-muted px-1.5 py-0.5 rounded border"
                          >
                            {m.option_name_snapshot}
                          </span>
                        ))}
                      </div>
                    )}

                    {item.notes && (
                      <p className="text-[11px] italic text-muted-foreground">
                        &ldquo;{item.notes}&rdquo;
                      </p>
                    )}
                  </div>

                  <span className="font-bold text-foreground font-mono shrink-0">
                    {formatRupiah(item.line_total)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Pricing Breakdown */}
          <div className="rounded-xl border p-3.5 bg-muted/20 space-y-2 text-xs">
            <div className="flex items-center justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span className="font-mono">{formatRupiah(order.subtotal)}</span>
            </div>
            <div className="flex items-center justify-between text-muted-foreground">
              <span>Pajak ({order.tax_percent}%)</span>
              <span className="font-mono">{formatRupiah(order.tax_total)}</span>
            </div>
            <div className="flex items-center justify-between text-muted-foreground">
              <span>Service Charge ({order.service_charge_percent}%)</span>
              <span className="font-mono">{formatRupiah(order.service_total)}</span>
            </div>
            <Separator className="my-1" />
            <div className="flex items-center justify-between font-bold text-sm">
              <span>Total Tagihan</span>
              <span className="text-base text-primary font-display font-bold">
                {formatRupiah(order.grand_total)}
              </span>
            </div>
          </div>

          {/* Handoff F2 Notice & Disabled Payment Placeholder */}
          <div className="rounded-xl border border-dashed border-primary/30 p-4 bg-brand-soft/20 space-y-2">
            <div className="flex items-center gap-2">
              <CreditCard className="size-4 text-primary" />
              <h5 className="font-bold text-xs text-foreground">
                Handoff ke Sistem Pembayaran (F2)
              </h5>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Pesanan ini sudah tersimpan dengan ID <span className="font-mono font-medium">{order.id}</span> dan status <strong>Menunggu Pembayaran</strong>. Integrasi pembayaran (Tunai, QRIS Manual, Midtrans) serta pembuatan nomor antrean & tiket KDS akan aktif pada milestone F2.
            </p>
            <Button
              type="button"
              disabled
              className="w-full h-9 text-xs font-semibold cursor-not-allowed opacity-60"
            >
              <CreditCard className="size-3.5 mr-1.5" />
              Proses Pembayaran (Tersedia pada F2)
            </Button>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="p-4 border-t bg-muted/20 flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenCancel(order)}
            className="text-xs text-destructive hover:bg-destructive/10 hover:text-destructive font-medium"
          >
            <Ban className="size-3.5 mr-1.5" />
            Batalkan Pesanan
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={onClose}
            className="text-xs font-semibold"
          >
            <PlusCircle className="size-3.5 mr-1.5" />
            Selesai / Pesanan Baru
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
