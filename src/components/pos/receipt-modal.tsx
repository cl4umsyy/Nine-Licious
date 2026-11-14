"use client";

import { useEffect, useState } from "react";
import { Loader2, Printer, Receipt, RotateCcw } from "lucide-react";
import { toast } from "sonner";
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
import { getOrderReceiptDataAction } from "@/lib/payments/actions";
import type { ReceiptData } from "@/lib/payments/types";

export type ReceiptModalProps = {
  orderId: string | null;
  isOpen: boolean;
  onClose: () => void;
};

export function ReceiptModal({
  orderId,
  isOpen,
  onClose,
}: ReceiptModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md p-0 overflow-hidden">
        {isOpen && orderId ? (
          <ReceiptModalContent orderId={orderId} onClose={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ReceiptModalContent({
  orderId,
  onClose,
}: {
  orderId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<ReceiptData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getOrderReceiptDataAction(orderId)
      .then((res) => {
        if (!active) return;
        setIsLoading(false);
        if (res.ok) {
          setData(res.data);
        } else {
          toast.error(res.message);
          onClose();
        }
      })
      .catch((err) => {
        if (!active) return;
        setIsLoading(false);
        toast.error(err instanceof Error ? err.message : "Gagal memuat struk");
        onClose();
      });

    return () => {
      active = false;
    };
  }, [orderId, onClose]);

  const handlePrint = () => {
    window.print();
  };

  const totalChange = data?.payments.reduce((acc, p) => acc + (p.change_amount || 0), 0) ?? 0;
  const manualDiscounts = data?.discounts.filter((d) => d.scope === "manual") ?? [];

  return (
    <>
      <DialogHeader className="p-4 pb-2 border-b bg-muted/20">
        <DialogTitle className="flex items-center gap-2 font-display text-base">
          <Receipt className="size-4 text-primary" />
          Struk Pembayaran Digital
        </DialogTitle>
        <DialogDescription className="text-xs">
          Format cetak thermal printer 58mm / 80mm
        </DialogDescription>
      </DialogHeader>

      {isLoading || !data ? (
        <div className="flex flex-col items-center justify-center p-8 gap-2 text-muted-foreground">
          <Loader2 className="size-6 animate-spin text-primary" />
          <p className="text-xs">Memuat rincian transaksi struk...</p>
        </div>
      ) : (
        <div className="p-5 max-h-[75vh] overflow-y-auto font-mono text-[11px] leading-relaxed text-foreground select-text print:p-0">
          {/* Header Restoran */}
          <div className="text-center space-y-0.5">
            <h3 className="font-bold text-sm tracking-wide">{data.restaurant.name}</h3>
            {data.restaurant.address && <p className="text-muted-foreground text-[10px]">{data.restaurant.address}</p>}
            {data.restaurant.phone && <p className="text-muted-foreground text-[10px]">Telp: {data.restaurant.phone}</p>}
            {data.restaurant.receipt_header && (
              <p className="text-[10px] italic text-muted-foreground pt-1">{data.restaurant.receipt_header}</p>
            )}
          </div>

          <Separator className="my-3 border-dashed" />

          {/* Info Pesanan */}
          <div className="space-y-1 text-[10px]">
            <div className="flex justify-between">
              <span>No. Pesanan:</span>
              <span className="font-bold">{data.order.order_number}</span>
            </div>
            <div className="flex justify-between">
              <span>Waktu:</span>
              <span>{new Date(data.order.created_at).toLocaleString("id-ID")}</span>
            </div>
            <div className="flex justify-between">
              <span>Tipe / Meja:</span>
              <span>
                {data.order.order_type.toUpperCase()}
                {data.order.table_name ? ` · Meja ${data.order.table_name}` : ""}
              </span>
            </div>
            {data.order.queue_number && (
              <div className="flex justify-between font-bold text-primary">
                <span>No. Antrean:</span>
                <span className="text-xs">{data.order.queue_number}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>Kasir:</span>
              <span>{data.order.cashier_name}</span>
            </div>
          </div>

          <Separator className="my-3 border-dashed" />

          {/* Line Items */}
          <div className="space-y-2">
            {data.items.map((item, idx) => (
              <div key={idx} className="space-y-0.5">
                <div className="flex justify-between items-start">
                  <span className="font-medium">
                    {item.quantity}x {item.product_name}
                  </span>
                  <span>Rp {item.line_total.toLocaleString("id-ID")}</span>
                </div>
                {item.modifiers.length > 0 && (
                  <div className="pl-3 text-[10px] text-muted-foreground">
                    {item.modifiers.map((m, mIdx) => (
                      <div key={mIdx} className="flex justify-between">
                        <span>+ {m.option_name}</span>
                        {m.price_delta > 0 && <span>Rp {m.price_delta.toLocaleString("id-ID")}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {item.notes && (
                  <div className="pl-3 text-[9px] text-muted-foreground italic">
                    Catatan: {item.notes}
                  </div>
                )}
              </div>
            ))}
          </div>

          <Separator className="my-3 border-dashed" />

          {/* Ringkasan Biaya */}
          <div className="space-y-1 text-[10px]">
            <div className="flex justify-between">
              <span>Subtotal:</span>
              <span>Rp {data.order.subtotal.toLocaleString("id-ID")}</span>
            </div>

            {data.order.discount_product_total > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Diskon Produk:</span>
                <span>-Rp {data.order.discount_product_total.toLocaleString("id-ID")}</span>
              </div>
            )}

            {data.order.discount_order_total > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Diskon Pesanan:</span>
                <span>-Rp {data.order.discount_order_total.toLocaleString("id-ID")}</span>
              </div>
            )}

            {data.order.discount_manual_total > 0 && (
              <div className="space-y-0.5">
                <div className="flex justify-between text-muted-foreground">
                  <span>Diskon Manual:</span>
                  <span>-Rp {data.order.discount_manual_total.toLocaleString("id-ID")}</span>
                </div>
                {manualDiscounts.map((md, mdIdx) => (
                  <div key={mdIdx} className="pl-3 text-[9px] text-muted-foreground italic">
                    Alasan: {md.reason ?? "-"} {md.approver_name ? `(ACC: ${md.approver_name})` : ""}
                  </div>
                ))}
              </div>
            )}

            {data.order.service_total > 0 && (
              <div className="flex justify-between">
                <span>Service Charge:</span>
                <span>Rp {data.order.service_total.toLocaleString("id-ID")}</span>
              </div>
            )}

            {data.order.tax_total > 0 && (
              <div className="flex justify-between">
                <span>Pajak:</span>
                <span>Rp {data.order.tax_total.toLocaleString("id-ID")}</span>
              </div>
            )}

            <div className="flex justify-between pt-1 font-bold text-xs border-t border-dashed">
              <span>GRAND TOTAL:</span>
              <span>Rp {data.order.grand_total.toLocaleString("id-ID")}</span>
            </div>
          </div>

          <Separator className="my-3 border-dashed" />

          {/* Detail Pembayaran */}
          <div className="space-y-1 text-[10px]">
            <span className="font-bold">Rincian Pembayaran:</span>
            {data.payments.map((p, idx) => (
              <div key={idx} className="flex justify-between">
                <span>
                  {p.payment_method.toUpperCase()}
                  {p.payment_status === "refunded" ? " (DIREFUND)" : ""}
                  {p.cash_received && p.cash_received > p.amount
                    ? ` (Diterima Rp ${p.cash_received.toLocaleString("id-ID")})`
                    : ""}
                </span>
                <span>Rp {p.amount.toLocaleString("id-ID")}</span>
              </div>
            ))}
            {totalChange > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Kembalian Tunai:</span>
                <span>Rp {totalChange.toLocaleString("id-ID")}</span>
              </div>
            )}
            <div className="flex justify-between font-bold pt-1 border-t border-dashed">
              <span>TOTAL DIBAYAR:</span>
              <span>Rp {data.order.paid_total.toLocaleString("id-ID")}</span>
            </div>
          </div>

          {/* Detail Refund Jika Ada */}
          {data.refunds.length > 0 && (
            <>
              <Separator className="my-3 border-dashed" />
              <div className="space-y-1 text-[10px] text-destructive">
                <span className="font-bold flex items-center gap-1">
                  <RotateCcw className="size-3" />
                  Rincian Pengembalian Dana (Refund):
                </span>
                {data.refunds.map((r, idx) => (
                  <div key={idx} className="flex justify-between">
                    <span>
                      {r.refund_number} ({r.refund_method.toUpperCase()}
                      {r.status === "pending" ? " · PENDING" : ""})
                    </span>
                    <span>-Rp {r.amount.toLocaleString("id-ID")}</span>
                  </div>
                ))}

                <div className="flex justify-between pt-1 font-bold text-xs border-t border-dashed text-primary">
                  <span>NET DITERIMA (NET PAID):</span>
                  <span>Rp {data.order.net_paid.toLocaleString("id-ID")}</span>
                </div>
              </div>
            </>
          )}

          {/* Footer */}
          {data.restaurant.receipt_footer && (
            <div className="mt-4 text-center text-[10px] text-muted-foreground italic">
              {data.restaurant.receipt_footer}
            </div>
          )}
          <div className="mt-2 text-center text-[9px] text-muted-foreground">
            Terima kasih atas kunjungan Anda
          </div>
        </div>
      )}

      <DialogFooter className="p-3 border-t bg-muted/20 gap-2 sm:gap-0">
        <Button variant="outline" size="sm" onClick={onClose}>
          Tutup
        </Button>
        <Button variant="default" size="sm" onClick={handlePrint} disabled={!data || isLoading}>
          <Printer className="mr-1.5 size-3.5" />
          Cetak Struk
        </Button>
      </DialogFooter>
    </>
  );
}
