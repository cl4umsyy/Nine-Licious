"use client";

import { useState, useTransition } from "react";
import {
  AlertCircle,
  Ban,
  CheckCircle,
  Clock,
  CreditCard,
  Lock,
  MapPin,
  PlusCircle,
  ShoppingBag,
  Unlock,
  UtensilsCrossed,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  finalizeOrderAction,
  unfinalizeOrderAction,
} from "@/lib/discounts/actions";
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
  userRole?: string;
  onOrderUpdated?: (order: OrderWithDetails) => void;
};

export function OrderConfirmationModal({
  order,
  isOpen,
  onClose,
  onOpenCancel,
  userRole = "kasir",
  onOrderUpdated,
}: OrderConfirmationModalProps) {
  const [currentOrder, setCurrentOrder] = useState<OrderWithDetails | null>(
    order,
  );
  const [isFinalizeAlertOpen, setIsFinalizeAlertOpen] = useState(false);
  const [isUnfinalizeDialogOpen, setIsUnfinalizeDialogOpen] = useState(false);
  const [unfinalizeReason, setUnfinalizeReason] = useState("");
  const [isProcessing, startTransition] = useTransition();

  // Keep internal state in sync with prop
  if (order && (!currentOrder || currentOrder.id !== order.id)) {
    setCurrentOrder(order);
  }

  if (!currentOrder) return null;

  const isDineIn = currentOrder.order_type === "dine_in";
  const badgeConfig = ORDER_STATUS_BADGES[currentOrder.status];
  const isFinalized = Boolean(currentOrder.is_finalized);
  const isAdmin = userRole === "admin";

  // Handle Finalize
  const handleConfirmFinalize = () => {
    startTransition(async () => {
      const result = await finalizeOrderAction({ orderId: currentOrder.id });
      if (result.ok) {
        toast.success(result.message);
        const updated: OrderWithDetails = {
          ...currentOrder,
          is_finalized: true,
          finalized_at: new Date().toISOString(),
        };
        setCurrentOrder(updated);
        onOrderUpdated?.(updated);
        setIsFinalizeAlertOpen(false);
      } else {
        toast.error(result.message || "Gagal memfinalisasi pesanan.");
      }
    });
  };

  // Handle Unfinalize
  const handleConfirmUnfinalize = () => {
    if (!unfinalizeReason.trim() || unfinalizeReason.trim().length < 3) {
      toast.error("Alasan pembukaan kembali pesanan minimal 3 karakter.");
      return;
    }

    startTransition(async () => {
      const result = await unfinalizeOrderAction({
        orderId: currentOrder.id,
        reason: unfinalizeReason.trim(),
      });

      if (result.ok) {
        toast.success(result.message);
        const updated: OrderWithDetails = {
          ...currentOrder,
          is_finalized: false,
          finalized_at: null,
          finalized_by: null,
        };
        setCurrentOrder(updated);
        onOrderUpdated?.(updated);
        setIsUnfinalizeDialogOpen(false);
        setUnfinalizeReason("");
      } else {
        toast.error(result.message || "Gagal membuka kembali pesanan.");
      }
    });
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0 overflow-hidden sm:max-w-xl">
          {/* Header */}
          <DialogHeader className="p-5 pb-4 border-b bg-muted/20">
            <div className="flex items-center gap-3">
              <div
                className={`flex size-11 items-center justify-center rounded-xl shrink-0 ${
                  isFinalized
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                }`}
              >
                {isFinalized ? (
                  <CheckCircle className="size-6" />
                ) : (
                  <Clock className="size-6" />
                )}
              </div>
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <DialogTitle className="text-lg font-bold font-display">
                    Pesanan #{currentOrder.order_number}
                  </DialogTitle>
                  <Badge
                    variant={badgeConfig.variant}
                    className={`text-[11px] font-semibold h-5 px-2 ${badgeConfig.className}`}
                  >
                    {ORDER_STATUS_LABELS[currentOrder.status]}
                  </Badge>
                  {isFinalized ? (
                    <Badge className="text-[10px] h-5 bg-emerald-600 text-white font-semibold">
                      <Lock className="size-3 mr-1" />
                      Finalized
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] h-5 text-amber-600 border-amber-400">
                      Draft / Terbuka
                    </Badge>
                  )}
                </div>
                <DialogDescription className="text-xs">
                  ID: <span className="font-mono text-muted-foreground">{currentOrder.id}</span>
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
            {/* Finalization Banner */}
            {isFinalized ? (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 flex items-center justify-between text-emerald-800 dark:text-emerald-300">
                <div className="flex items-center gap-2">
                  <Lock className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="font-medium text-[11px]">
                    Pesanan sudah difinalisasi. Penambahan item dan diskon terkunci.
                  </span>
                </div>

                {isAdmin && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setIsUnfinalizeDialogOpen(true)}
                    className="h-7 text-xs border-emerald-500/40 text-emerald-700 dark:text-emerald-300 bg-background/80 hover:bg-background shrink-0"
                  >
                    <Unlock className="size-3 mr-1" />
                    Buka Kembali
                  </Button>
                )}
              </div>
            ) : (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 flex items-center justify-between text-amber-800 dark:text-amber-300">
                <div className="flex items-center gap-2">
                  <AlertCircle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span className="font-medium text-[11px]">
                    Pesanan belum difinalisasi. Finalisasi untuk mengunci item sebelum pembayaran.
                  </span>
                </div>

                <Button
                  type="button"
                  size="sm"
                  onClick={() => setIsFinalizeAlertOpen(true)}
                  className="h-7 text-xs font-bold bg-primary text-primary-foreground shrink-0 shadow-sm"
                >
                  <Lock className="size-3 mr-1" />
                  Finalisasi Sekarang
                </Button>
              </div>
            )}

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
                  {ORDER_TYPE_LABELS[currentOrder.order_type]}
                </p>
              </div>

              <div className="p-3 rounded-xl border bg-muted/30 space-y-1">
                <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
                  <MapPin className="size-3 text-primary" />
                  Lokasi / Meja
                </span>
                <p className="font-bold text-foreground">
                  {isDineIn
                    ? currentOrder.tableName || "Meja Dine-in"
                    : currentOrder.customer_name || "Pelanggan Takeaway"}
                </p>
              </div>
            </div>

            {/* Items Summary */}
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Daftar Menu ({currentOrder.items.length})
              </h4>

              <div className="rounded-xl border divide-y bg-card text-xs">
                {currentOrder.items.map((item) => (
                  <div
                    key={item.id}
                    className="p-3 flex items-start justify-between gap-3"
                  >
                    <div className="space-y-1 flex-1">
                      <div className="font-semibold text-foreground">
                        <span className="font-bold text-primary mr-1.5 font-mono">
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

                    <div className="text-right shrink-0">
                      {item.discount_amount > 0 ? (
                        <div>
                          <div className="line-through text-muted-foreground text-[10px]">
                            {formatRupiah(item.subtotal)}
                          </div>
                          <span className="font-bold text-foreground font-mono">
                            {formatRupiah(item.line_total)}
                          </span>
                        </div>
                      ) : (
                        <span className="font-bold text-foreground font-mono">
                          {formatRupiah(item.line_total)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Pricing Breakdown */}
            <div className="rounded-xl border p-3.5 bg-muted/20 space-y-2 text-xs">
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Subtotal Menu</span>
                <span className="font-mono">{formatRupiah(currentOrder.subtotal)}</span>
              </div>

              {/* Rincian Diskon */}
              {currentOrder.discount_total > 0 && (
                <>
                  {currentOrder.discount_product_total > 0 && (
                    <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
                      <span>Diskon Menu Produk</span>
                      <span className="font-mono font-medium">
                        -{formatRupiah(currentOrder.discount_product_total)}
                      </span>
                    </div>
                  )}

                  {currentOrder.discount_order_total > 0 && (
                    <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
                      <span>Promo Pesanan</span>
                      <span className="font-mono font-medium">
                        -{formatRupiah(currentOrder.discount_order_total)}
                      </span>
                    </div>
                  )}

                  {currentOrder.discount_manual_total > 0 && (
                    <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
                      <span>Diskon Manual [Admin]</span>
                      <span className="font-mono font-medium">
                        -{formatRupiah(currentOrder.discount_manual_total)}
                      </span>
                    </div>
                  )}

                  <div className="flex items-center justify-between font-semibold text-emerald-700 dark:text-emerald-300">
                    <span>Total Diskon</span>
                    <span className="font-mono font-bold">
                      -{formatRupiah(currentOrder.discount_total)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>Dasar Kena Pajak</span>
                    <span className="font-mono">
                      {formatRupiah(
                        Math.max(0, currentOrder.subtotal - currentOrder.discount_total),
                      )}
                    </span>
                  </div>
                </>
              )}

              <div className="flex items-center justify-between text-muted-foreground">
                <span>Pajak ({currentOrder.tax_percent}%)</span>
                <span className="font-mono">{formatRupiah(currentOrder.tax_total)}</span>
              </div>

              <div className="flex items-center justify-between text-muted-foreground">
                <span>Service Charge ({currentOrder.service_charge_percent}%)</span>
                <span className="font-mono">
                  {formatRupiah(currentOrder.service_total)}
                </span>
              </div>

              <Separator className="my-1" />

              <div className="flex items-center justify-between font-bold text-sm">
                <span>Total Tagihan (Grand Total)</span>
                <span className="text-base text-primary font-display font-bold">
                  {formatRupiah(currentOrder.grand_total)}
                </span>
              </div>
            </div>

            {/* Handoff F2 Notice */}
            <div className="rounded-xl border border-dashed border-primary/30 p-4 bg-brand-soft/20 space-y-2">
              <div className="flex items-center gap-2">
                <CreditCard className="size-4 text-primary" />
                <h5 className="font-bold text-xs text-foreground">
                  Handoff ke Sistem Pembayaran (F2)
                </h5>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Status pembayaran: <strong>Belum Lunas ({currentOrder.payment_status})</strong>. Pemrosesan pembayaran tunai, QRIS dinamis, integrasi Midtrans, dan penerbitan struk akan diimplementasikan pada milestone F2.
              </p>
              <Button
                type="button"
                disabled
                className="w-full h-8 text-xs font-semibold cursor-not-allowed opacity-60"
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
              onClick={() => onOpenCancel(currentOrder)}
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

      {/* Alert Dialog Konfirmasi Finalisasi */}
      <AlertDialog
        open={isFinalizeAlertOpen}
        onOpenChange={(open) => !open && !isProcessing && setIsFinalizeAlertOpen(false)}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base font-bold font-display">
              Konfirmasi Finalisasi Pesanan?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed">
              Setelah difinalisasi, seluruh item, modifier, dan diskon pesanan{" "}
              <strong>#{currentOrder.order_number}</strong> akan dikunci. Penambahan item baru tidak dapat dilakukan kecuali pesanan dibuka kembali oleh Admin.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel size="sm" className="text-xs" disabled={isProcessing}>
              Batal
            </AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              disabled={isProcessing}
              onClick={handleConfirmFinalize}
              className="text-xs font-bold bg-primary text-primary-foreground"
            >
              {isProcessing ? "Memfinalisasi..." : "Ya, Finalisasi Pesanan"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dialog Unfinalize (Khusus Admin) */}
      <Dialog
        open={isUnfinalizeDialogOpen}
        onOpenChange={(open) => !open && !isProcessing && setIsUnfinalizeDialogOpen(false)}
      >
        <DialogContent className="max-w-md p-0 overflow-hidden">
          <DialogHeader className="p-5 pb-3 border-b bg-muted/20">
            <div className="flex items-center gap-2">
              <Unlock className="size-5 text-amber-600 dark:text-amber-400" />
              <div>
                <DialogTitle className="text-base font-bold font-display">
                  Buka Kembali Pesanan (Unfinalize)
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Khusus Admin. Alasan pembukaan kembali wajib dicatat untuk audit log.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="p-5 space-y-3 text-xs">
            <div className="space-y-1">
              <Label className="text-xs font-semibold">Alasan Pembukaan Kembali (Wajib)</Label>
              <Input
                type="text"
                placeholder="Contoh: Pelanggan ingin menambah pesanan sebelum bayar"
                value={unfinalizeReason}
                onChange={(e) => setUnfinalizeReason(e.target.value)}
                maxLength={200}
                autoFocus
                className="h-8 text-xs"
              />
            </div>
            <p className="text-[10px] text-muted-foreground leading-tight">
              Aktivitas ini akan dicatat ke dalam audit log sistem dengan identitas akun Admin Anda.
            </p>
          </div>

          <DialogFooter className="p-4 border-t bg-muted/20 flex-row justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isProcessing}
              onClick={() => setIsUnfinalizeDialogOpen(false)}
              className="text-xs"
            >
              Batal
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isProcessing || !unfinalizeReason.trim() || unfinalizeReason.trim().length < 3}
              onClick={handleConfirmUnfinalize}
              className="text-xs font-bold bg-amber-600 text-white hover:bg-amber-700"
            >
              {isProcessing ? "Membuka..." : "Buka Kunci Pesanan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
