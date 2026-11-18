"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Loader2,
  Printer,
  Receipt,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
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
import {
  formatReceiptOrderTypeLabel,
  formatReceiptPaymentMethodLabel,
  normalizeReceiptWidth,
  type ReceiptPaperWidth,
} from "@/lib/payments/receipt";
import type { ReceiptData } from "@/lib/payments/types";
import { cn } from "@/lib/utils";

export type ReceiptModalProps = {
  orderId: string | null;
  isOpen: boolean;
  onClose: () => void;
};

const WIB_DATETIME_FORMATTER = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatReceiptDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return `${WIB_DATETIME_FORMATTER.format(date)} WIB`;
}

export function ReceiptModal({
  orderId,
  isOpen,
  onClose,
}: ReceiptModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md p-0 overflow-hidden print:border-0 print:shadow-none print:max-w-none">
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paperWidth, setPaperWidth] = useState<ReceiptPaperWidth>(58);
  const [reloadCounter, setReloadCounter] = useState(0);

  useEffect(() => {
    let active = true;

    getOrderReceiptDataAction(orderId)
      .then((res) => {
        if (!active) return;
        setIsLoading(false);
        if (res.ok) {
          setData(res.data);
          setLoadError(null);
          setPaperWidth(normalizeReceiptWidth(res.data.restaurant.receipt_width));
        } else {
          setData(null);
          setLoadError(res.message);
          toast.error(res.message);
        }
      })
      .catch((err) => {
        if (!active) return;
        setIsLoading(false);
        setData(null);
        const msg =
          err instanceof Error
            ? err.message
            : "Gagal memuat data struk pesanan. Status pembayaran Anda tetap aman.";
        setLoadError(msg);
        toast.error(msg);
      });

    return () => {
      active = false;
    };
  }, [orderId, reloadCounter]);

  const handleRetryLoad = useCallback(() => {
    setIsLoading(true);
    setLoadError(null);
    setReloadCounter((c) => c + 1);
  }, []);

  const handlePrint = () => {
    if (!data) return;
    try {
      window.print();
    } catch {
      toast.error(
        "Gagal membuka dialog cetak browser. Pastikan fitur pencetakan browser aktif dan tidak diblokir.",
      );
    }
  };

  const totalChange =
    data?.payments.reduce((acc, p) => acc + (p.change_amount || 0), 0) ?? 0;
  const manualDiscounts =
    data?.discounts.filter((d) => d.scope === "manual") ?? [];

  return (
    <>
      <DialogHeader className="p-4 pb-3 border-b bg-muted/20 print:hidden">
        <div className="flex items-start justify-between gap-3 pr-6">
          <div>
            <DialogTitle className="flex items-center gap-2 font-display text-base">
              <Receipt className="size-4 text-primary" />
              Struk Pembayaran Digital
            </DialogTitle>
            <DialogDescription className="text-xs mt-0.5">
              Preview & cetak struk thermal 58mm / 80mm
            </DialogDescription>
          </div>

          {data ? (
            <div className="inline-flex items-center rounded-lg border border-border bg-background p-0.5 text-[11px] font-semibold">
              <button
                type="button"
                onClick={() => setPaperWidth(58)}
                className={cn(
                  "rounded-md px-2 py-1 transition-colors",
                  paperWidth === 58
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                58mm
              </button>
              <button
                type="button"
                onClick={() => setPaperWidth(80)}
                className={cn(
                  "rounded-md px-2 py-1 transition-colors",
                  paperWidth === 80
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                80mm
              </button>
            </div>
          ) : null}
        </div>
      </DialogHeader>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center p-10 gap-2.5 text-muted-foreground print:hidden">
          <Loader2 className="size-6 animate-spin text-primary" />
          <p className="text-xs font-medium">Memuat rincian transaksi struk...</p>
        </div>
      ) : loadError || !data ? (
        <div className="p-6 text-center space-y-3 print:hidden">
          <div className="mx-auto grid size-11 place-items-center rounded-2xl bg-destructive/10 text-destructive">
            <AlertCircle className="size-5" />
          </div>
          <div className="space-y-1">
            <h4 className="font-display text-sm font-bold text-foreground">
              Data Struk Belum Dapat Dimuat
            </h4>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {loadError ||
                "Gagal memuat rincian struk. Status pembayaran yang sudah lunas tetap tersimpan aman di sistem."}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRetryLoad}
            className="gap-1.5 rounded-xl text-xs font-semibold"
          >
            <RefreshCw className="size-3.5" />
            Muat Ulang Struk
          </Button>
        </div>
      ) : (
        <div className="max-h-[72vh] overflow-y-auto bg-muted/20 p-4 print:max-h-none print:overflow-visible print:bg-white print:p-0">
          <div
            id="receipt-print-area"
            data-receipt-width={paperWidth}
            className={cn(
              "mx-auto rounded-xl border border-border/80 bg-white p-4 font-mono text-[11px] leading-relaxed text-black shadow-2xs select-text print:rounded-none print:border-0 print:shadow-none",
              paperWidth === 58 ? "max-w-[270px]" : "max-w-[350px]",
            )}
          >
            {/* Header Restoran */}
            <div className="text-center space-y-0.5">
              <h3 className="font-bold text-sm tracking-wide">
                {data.restaurant.name}
              </h3>
              {data.restaurant.address ? (
                <p className="text-neutral-600 text-[10px]">
                  {data.restaurant.address}
                </p>
              ) : null}
              {data.restaurant.phone ? (
                <p className="text-neutral-600 text-[10px]">
                  Telp: {data.restaurant.phone}
                </p>
              ) : null}
              {data.restaurant.receipt_header ? (
                <p className="text-[10px] italic text-neutral-600 pt-1">
                  {data.restaurant.receipt_header}
                </p>
              ) : null}
            </div>

            <Separator className="my-3 border-dashed border-neutral-400" />

            {/* Info Pesanan */}
            <div className="space-y-1 text-[10px]">
              <div className="flex justify-between gap-2">
                <span>No. Pesanan:</span>
                <span className="font-bold text-right">
                  {data.order.order_number}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Waktu:</span>
                <span className="text-right">
                  {formatReceiptDateTime(data.order.created_at)}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Tipe:</span>
                <span className="text-right font-medium">
                  {formatReceiptOrderTypeLabel(
                    data.order.order_type,
                    data.order.table_name,
                  )}
                </span>
              </div>
              {data.order.customer_name ? (
                <div className="flex justify-between gap-2">
                  <span>Pelanggan:</span>
                  <span className="text-right">{data.order.customer_name}</span>
                </div>
              ) : null}
              {data.order.queue_number ? (
                <div className="flex justify-between gap-2 font-bold text-primary print:text-black">
                  <span>No. Antrean:</span>
                  <span className="text-xs">{data.order.queue_number}</span>
                </div>
              ) : null}
              <div className="flex justify-between gap-2">
                <span>Kasir:</span>
                <span className="text-right">{data.order.cashier_name}</span>
              </div>
            </div>

            <Separator className="my-3 border-dashed border-neutral-400" />

            {/* Line Items */}
            <div className="space-y-2">
              {data.items.map((item) => (
                <div key={item.id} className="space-y-0.5">
                  <div className="flex justify-between items-start gap-2">
                    <span className="font-medium">
                      {item.quantity}x {item.product_name}
                    </span>
                    <span className="shrink-0">
                      Rp {item.line_total.toLocaleString("id-ID")}
                    </span>
                  </div>
                  {item.modifiers.length > 0 ? (
                    <div className="pl-3 text-[10px] text-neutral-600">
                      {item.modifiers.map((m, mIdx) => (
                        <div key={mIdx} className="flex justify-between gap-2">
                          <span>+ {m.option_name}</span>
                          {m.price_delta > 0 ? (
                            <span>
                              Rp {m.price_delta.toLocaleString("id-ID")}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {item.notes ? (
                    <div className="pl-3 text-[9px] text-neutral-600 italic">
                      Catatan: {item.notes}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>

            <Separator className="my-3 border-dashed border-neutral-400" />

            {/* Ringkasan Biaya */}
            <div className="space-y-1 text-[10px]">
              <div className="flex justify-between">
                <span>Subtotal:</span>
                <span>Rp {data.order.subtotal.toLocaleString("id-ID")}</span>
              </div>

              {data.order.discount_product_total > 0 ? (
                <div className="flex justify-between text-neutral-600">
                  <span>Diskon Produk:</span>
                  <span>
                    -Rp{" "}
                    {data.order.discount_product_total.toLocaleString("id-ID")}
                  </span>
                </div>
              ) : null}

              {data.order.discount_order_total > 0 ? (
                <div className="flex justify-between text-neutral-600">
                  <span>Diskon Pesanan:</span>
                  <span>
                    -Rp {data.order.discount_order_total.toLocaleString("id-ID")}
                  </span>
                </div>
              ) : null}

              {data.order.discount_manual_total > 0 ? (
                <div className="space-y-0.5">
                  <div className="flex justify-between text-neutral-600">
                    <span>Diskon Manual:</span>
                    <span>
                      -Rp{" "}
                      {data.order.discount_manual_total.toLocaleString("id-ID")}
                    </span>
                  </div>
                  {manualDiscounts.map((md) => (
                    <div
                      key={md.id}
                      className="pl-3 text-[9px] text-neutral-600 italic"
                    >
                      Alasan: {md.reason ?? "-"}{" "}
                      {md.approver_name ? `(ACC: ${md.approver_name})` : ""}
                    </div>
                  ))}
                </div>
              ) : null}

              {data.order.service_total > 0 ? (
                <div className="flex justify-between">
                  <span>
                    Service Charge ({data.order.service_charge_percent}%):
                  </span>
                  <span>
                    Rp {data.order.service_total.toLocaleString("id-ID")}
                  </span>
                </div>
              ) : null}

              {data.order.tax_total > 0 ? (
                <div className="flex justify-between">
                  <span>Pajak ({data.order.tax_percent}%):</span>
                  <span>Rp {data.order.tax_total.toLocaleString("id-ID")}</span>
                </div>
              ) : null}

              <div className="flex justify-between pt-1.5 font-bold text-xs border-t border-dashed border-neutral-400">
                <span>GRAND TOTAL:</span>
                <span>Rp {data.order.grand_total.toLocaleString("id-ID")}</span>
              </div>
            </div>

            <Separator className="my-3 border-dashed border-neutral-400" />

            {/* Detail Pembayaran */}
            <div className="space-y-1 text-[10px]">
              <span className="font-bold">Rincian Pembayaran:</span>
              {data.payments.map((p) => (
                <div key={p.id} className="flex justify-between gap-2">
                  <span>
                    {formatReceiptPaymentMethodLabel(
                      p.payment_method,
                      p.payment_source,
                    )}
                    {p.payment_status === "refunded" ? " (DIREFUND)" : ""}
                    {p.cash_received && p.cash_received > p.amount
                      ? ` (Diterima Rp ${p.cash_received.toLocaleString("id-ID")})`
                      : ""}
                  </span>
                  <span className="shrink-0">
                    Rp {p.amount.toLocaleString("id-ID")}
                  </span>
                </div>
              ))}
              {totalChange > 0 ? (
                <div className="flex justify-between text-neutral-600">
                  <span>Kembalian Tunai:</span>
                  <span>Rp {totalChange.toLocaleString("id-ID")}</span>
                </div>
              ) : null}
              <div className="flex justify-between font-bold pt-1 border-t border-dashed border-neutral-400">
                <span>TOTAL DIBAYAR:</span>
                <span>Rp {data.order.paid_total.toLocaleString("id-ID")}</span>
              </div>
            </div>

            {/* Detail Refund Jika Ada */}
            {data.refunds.length > 0 ? (
              <>
                <Separator className="my-3 border-dashed border-neutral-400" />
                <div className="space-y-1 text-[10px] text-destructive print:text-black">
                  <span className="font-bold flex items-center gap-1">
                    <RotateCcw className="size-3" />
                    Rincian Pengembalian Dana (Refund):
                  </span>
                  {data.refunds.map((r) => (
                    <div key={r.id} className="flex justify-between gap-2">
                      <span>
                        {r.refund_number} ({r.refund_method.toUpperCase()}
                        {r.status === "pending" ? " · PENDING" : ""})
                      </span>
                      <span className="shrink-0">
                        -Rp {r.amount.toLocaleString("id-ID")}
                      </span>
                    </div>
                  ))}

                  <div className="flex justify-between pt-1 font-bold text-xs border-t border-dashed border-neutral-400 text-primary print:text-black">
                    <span>NET DITERIMA (NET PAID):</span>
                    <span>
                      Rp {data.order.net_paid.toLocaleString("id-ID")}
                    </span>
                  </div>
                </div>
              </>
            ) : null}

            {/* Footer */}
            {data.restaurant.receipt_footer ? (
              <div className="mt-4 text-center text-[10px] text-neutral-600 italic">
                {data.restaurant.receipt_footer}
              </div>
            ) : null}
            <div className="mt-2 text-center text-[9px] text-neutral-600">
              Terima kasih atas kunjungan Anda
            </div>
          </div>
        </div>
      )}

      <DialogFooter className="mx-0 mb-0 p-3 border-t bg-muted/20 gap-2 sm:justify-end print:hidden">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onClose}
          className="rounded-xl"
        >
          Tutup
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={handlePrint}
          disabled={!data || isLoading}
          className="rounded-xl"
        >
          <Printer className="mr-1.5 size-3.5" />
          Cetak Struk ({paperWidth}mm)
        </Button>
      </DialogFooter>
    </>
  );
}
