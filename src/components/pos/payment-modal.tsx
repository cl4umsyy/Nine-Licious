"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  AlertCircle,
  Banknote,
  Building2,
  CheckCircle,
  Clock,
  CreditCard,
  ExternalLink,
  Loader2,
  QrCode,
  RefreshCw,
  ScanLine,
  Split,
} from "lucide-react";
import { toast } from "sonner";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { formatRupiah } from "@/lib/menu/format";
import { calculateCumulativeItemAllocations } from "@/lib/midtrans/allocation";
import type { OrderWithDetails } from "@/lib/orders/types";
import {
  createPosMidtransSnapAction,
  getOrderPaymentStatusAction,
  processPosManualPaymentAction,
} from "@/lib/payments/actions";

declare global {
  interface Window {
    snap?: {
      pay: (
        token: string,
        callbacks: {
          onSuccess?: (result: unknown) => void;
          onPending?: (result: unknown) => void;
          onError?: (result: unknown) => void;
          onClose?: () => void;
        },
      ) => void;
    };
  }
}

export type PaymentMethodTab = "cash" | "midtrans_snap" | "qris_manual" | "bank_transfer";
export type SplitMode = "full" | "custom_amount" | "by_item";

export type PaymentModalProps = {
  order: OrderWithDetails | null;
  isOpen: boolean;
  onClose: () => void;
  onPaymentSuccess: (orderId: string, isSettled: boolean) => void;
};

export function PaymentModal({
  order,
  isOpen,
  onClose,
  onPaymentSuccess,
}: PaymentModalProps) {
  const [midtransWaiting, setMidtransWaiting] = useState(false);
  const [method, setMethod] = useState<PaymentMethodTab>("cash");
  const [splitMode, setSplitMode] = useState<SplitMode>("full");

  const remainingBalance = useMemo(() => {
    if (!order) return 0;
    return Math.max(0, order.grand_total - (order.paid_total || 0));
  }, [order]);

  const [customAmount, setCustomAmount] = useState<number>(0);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [cashReceived, setCashReceived] = useState<string>("");
  const [referenceNumber, setReferenceNumber] = useState<string>("");
  const [paymentNotes, setPaymentNotes] = useState<string>("");
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());
  const [activeSnapToken, setActiveSnapToken] = useState<string | null>(null);
  const [prevOrderId, setPrevOrderId] = useState<string | null>(null);

  // Inisialisasi/reset state saat pesanan baru dibuka (pola resmi React: adjusting state on prop change)
  if (order && isOpen && order.id !== prevOrderId) {
    setPrevOrderId(order.id);
    const rem = Math.max(0, order.grand_total - (order.paid_total || 0));
    setCustomAmount(rem);
    setCashReceived(rem.toString());
    setSelectedItemIds(new Set());
    setReferenceNumber("");
    setPaymentNotes("");
    setIdempotencyKey(crypto.randomUUID());
    setMethod("cash");
    setSplitMode("full");
    setMidtransWaiting(false);
    setActiveSnapToken(null);
  } else if (!isOpen && prevOrderId !== null) {
    setPrevOrderId(null);
    setMidtransWaiting(false);
    setActiveSnapToken(null);
  }

  return (
    <Dialog
      open={isOpen}
      modal={!midtransWaiting}
      onOpenChange={(open) => {
        if (!open && !midtransWaiting) {
          onClose();
        }
      }}
    >
      <DialogContent
        className="max-w-xl max-h-[90vh] flex flex-col p-0 overflow-hidden"
        onPointerDownOutside={(e) => {
          if (midtransWaiting) {
            e.preventDefault();
          }
        }}
        onInteractOutside={(e) => {
          if (midtransWaiting) {
            e.preventDefault();
          }
        }}
      >
        {isOpen && order ? (
          <PaymentModalContent
            key={order.id}
            order={order}
            onClose={onClose}
            onPaymentSuccess={onPaymentSuccess}
            method={method}
            setMethod={setMethod}
            splitMode={splitMode}
            setSplitMode={setSplitMode}
            remainingBalance={remainingBalance}
            customAmount={customAmount}
            setCustomAmount={setCustomAmount}
            selectedItemIds={selectedItemIds}
            setSelectedItemIds={setSelectedItemIds}
            cashReceived={cashReceived}
            setCashReceived={setCashReceived}
            referenceNumber={referenceNumber}
            setReferenceNumber={setReferenceNumber}
            paymentNotes={paymentNotes}
            setPaymentNotes={setPaymentNotes}
            idempotencyKey={idempotencyKey}
            midtransWaiting={midtransWaiting}
            setMidtransWaiting={setMidtransWaiting}
            activeSnapToken={activeSnapToken}
            setActiveSnapToken={setActiveSnapToken}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PaymentModalContent({
  order,
  onClose,
  onPaymentSuccess,
  method,
  setMethod,
  splitMode,
  setSplitMode,
  remainingBalance,
  customAmount,
  setCustomAmount,
  selectedItemIds,
  setSelectedItemIds,
  cashReceived,
  setCashReceived,
  referenceNumber,
  setReferenceNumber,
  paymentNotes,
  setPaymentNotes,
  idempotencyKey,
  midtransWaiting,
  setMidtransWaiting,
  activeSnapToken,
  setActiveSnapToken,
}: {
  order: OrderWithDetails;
  onClose: () => void;
  onPaymentSuccess: (orderId: string, isSettled: boolean) => void;
  method: PaymentMethodTab;
  setMethod: (m: PaymentMethodTab) => void;
  splitMode: SplitMode;
  setSplitMode: (s: SplitMode) => void;
  remainingBalance: number;
  customAmount: number;
  setCustomAmount: (n: number) => void;
  selectedItemIds: Set<string>;
  setSelectedItemIds: (s: Set<string>) => void;
  cashReceived: string;
  setCashReceived: (s: string) => void;
  referenceNumber: string;
  setReferenceNumber: (s: string) => void;
  paymentNotes: string;
  setPaymentNotes: (s: string) => void;
  idempotencyKey: string;
  midtransWaiting: boolean;
  setMidtransWaiting: (waiting: boolean) => void;
  activeSnapToken: string | null;
  setActiveSnapToken: (token: string | null) => void;
}) {
  // State proses transaksi & Midtrans
  const [isSubmitting, startTransition] = useTransition();
  const [isVerifyingMidtrans, setIsVerifyingMidtrans] = useState(false);

  // Muat script Midtrans Snap secara dinamis untuk environment sandbox
  useEffect(() => {
    const clientKey = process.env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY;
    if (!clientKey) return;

    const scriptId = "midtrans-snap-script";
    if (!document.getElementById(scriptId)) {
      const script = document.createElement("script");
      script.id = scriptId;
      script.src = "https://app.sandbox.midtrans.com/snap/snap.js";
      script.setAttribute("data-client-key", clientKey);
      script.async = true;
      document.body.appendChild(script);
    }
  }, []);

  // Helper kalkulasi alokasi split bill by item sesuai engine F2.2
  const itemAllocationCalculation = useMemo(() => {
    if (splitMode !== "by_item" || selectedItemIds.size === 0) return null;

    const selectedItemsList = order.items.filter((it) => selectedItemIds.has(it.id));
    if (selectedItemsList.length === 0) return null;

    try {
      const isTerminal = selectedItemIds.size === order.items.length;

      return calculateCumulativeItemAllocations({
        order: {
          subtotal: order.subtotal,
          discountProductTotal: order.discount_product_total || 0,
          discountOrderTotal: order.discount_order_total || 0,
          discountManualTotal: order.discount_manual_total || 0,
          discountTotal: order.discount_total || 0,
          serviceTotal: order.service_total || 0,
          taxTotal: order.tax_total || 0,
          grandTotal: order.grand_total,
          paidTotal: order.paid_total || 0,
        },
        orderItems: order.items,
        historicalAllocations: [],
        requestedItems: selectedItemsList.map((it) => ({
          orderItemId: it.id,
          allocatedQuantity: it.quantity,
        })),
        isTerminalPayment: isTerminal,
      });
    } catch {
      return null;
    }
  }, [splitMode, order, selectedItemIds]);

  // Hitung nominal efektif yang harus dibayar berdasarkan mode split
  const payAmount = useMemo(() => {
    if (splitMode === "full") {
      return remainingBalance;
    }
    if (splitMode === "custom_amount") {
      return Math.min(Math.max(1, customAmount || 0), remainingBalance);
    }
    if (splitMode === "by_item") {
      if (selectedItemIds.size === 0) return 0;
      if (itemAllocationCalculation) {
        return Math.min(itemAllocationCalculation.grossTotal, remainingBalance);
      }
      const selectedSubtotal = order.items
        .filter((it) => selectedItemIds.has(it.id))
        .reduce((sum, it) => sum + it.line_total, 0);

      if (order.subtotal <= 0) return selectedSubtotal;

      const taxRate = order.tax_percent / 100;
      const serviceRate = order.service_charge_percent / 100;
      const effectiveTotal = Math.round(selectedSubtotal * (1 + taxRate + serviceRate));

      return Math.min(Math.max(1, effectiveTotal), remainingBalance);
    }
    return remainingBalance;
  }, [splitMode, remainingBalance, customAmount, selectedItemIds, itemAllocationCalculation, order.items, order.subtotal, order.tax_percent, order.service_charge_percent]);

  // Kalkulasi kembalian tunai
  const parsedCashReceived = parseInt(cashReceived, 10) || 0;
  const changeAmount = method === "cash" ? Math.max(0, parsedCashReceived - payAmount) : 0;
  const isCashDeficit = method === "cash" && parsedCashReceived < payAmount;

  // Preset uang pecahan cepat
  const quickCashPresets = useMemo(() => {
    const presets = new Set<number>();
    presets.add(payAmount); // Uang pas

    const denominations = [20000, 50000, 100000, 200000];
    for (const d of denominations) {
      if (d > payAmount) {
        presets.add(d);
      }
    }

    // Pembulatan ke atas pecahan 50.000 terdekat jika nominal tinggi
    const next50k = Math.ceil(payAmount / 50000) * 50000;
    if (next50k > payAmount) presets.add(next50k);

    const next100k = Math.ceil(payAmount / 100000) * 100000;
    if (next100k > payAmount) presets.add(next100k);

    return Array.from(presets).sort((a, b) => a - b).slice(0, 5);
  }, [payAmount]);

  // Eksekusi Pembayaran Tunai & Manual (F2.1)
  const handleProcessManualPayment = () => {
    if (isSubmitting || midtransWaiting) return;

    if (!order.is_finalized) {
      toast.error("Pesanan belum difinalisasi. Mohon finalisasi pesanan terlebih dahulu.");
      return;
    }

    if (splitMode === "by_item" && selectedItemIds.size === 0) {
      toast.error("Pilih minimal satu item untuk pembayaran split bill.");
      return;
    }

    if (method === "cash" && isCashDeficit) {
      toast.error(
        `Uang tunai diterima kurang dari nominal tagihan (Kurang ${formatRupiah(payAmount - parsedCashReceived)}).`,
      );
      return;
    }

    startTransition(async () => {
      let paymentSource: "cash" | "qris_manual" | "bank_transfer" = "cash";
      let paymentMethod: "cash" | "qris" | "bank_transfer" = "cash";

      if (method === "cash") {
        paymentMethod = "cash";
        paymentSource = "cash";
      } else if (method === "qris_manual") {
        paymentMethod = "qris";
        paymentSource = "qris_manual";
      } else if (method === "bank_transfer") {
        paymentMethod = "bank_transfer";
        paymentSource = "bank_transfer";
      }

      const payload = {
        orderId: order.id,
        paymentMethod,
        paymentSource,
        amount: payAmount,
        cashReceived: method === "cash" ? parsedCashReceived : null,
        changeAmount: method === "cash" ? changeAmount : 0,
        referenceNumber: referenceNumber.trim() || null,
        idempotencyKey,
        notes: paymentNotes.trim() || null,
      };

      const result = await processPosManualPaymentAction(payload);

      if (result.ok && result.data) {
        toast.success(result.message);
        onPaymentSuccess(order.id, result.data.is_settled);
      } else {
        toast.error(result.message || "Gagal memproses pembayaran.");
      }
    });
  };

  // Eksekusi Midtrans Snap Sandbox (F2.2 & TAHAP 3)
  const handleOpenMidtransSnap = () => {
    if (isSubmitting || midtransWaiting) return;

    if (!order.is_finalized) {
      toast.error("Pesanan belum difinalisasi.");
      return;
    }

    if (splitMode === "by_item" && selectedItemIds.size === 0) {
      toast.error("Pilih minimal satu item untuk pembayaran split bill.");
      return;
    }

    startTransition(async () => {
      let itemAllocationsPayload:
        | Array<{
            order_item_id: string;
            allocated_quantity: number;
            allocated_line_subtotal: number;
            allocated_discount_share: number;
            allocated_service_share: number;
            allocated_tax_share: number;
            allocated_final_amount: number;
          }>
        | undefined = undefined;

      let effectiveGross = payAmount;

      if (splitMode === "by_item" && itemAllocationCalculation) {
        effectiveGross = itemAllocationCalculation.grossTotal;
        itemAllocationsPayload = itemAllocationCalculation.items.map((it) => ({
          order_item_id: it.orderItemId,
          allocated_quantity: it.allocatedQuantity,
          allocated_line_subtotal: it.allocatedLineSubtotal,
          allocated_discount_share: it.allocatedDiscountShare,
          allocated_service_share: it.allocatedServiceShare,
          allocated_tax_share: it.allocatedTaxShare,
          allocated_final_amount: it.allocatedFinalAmount,
        }));
      }

      // 1. Minta Snap Token dari server (Server Action)
      const result = await createPosMidtransSnapAction({
        orderId: order.id,
        grossAmount: effectiveGross,
        idempotencyKey,
        isSplitBill: splitMode !== "full",
        splitBillType: splitMode === "by_item" ? "by_item" : splitMode === "custom_amount" ? "custom_amount" : null,
        itemAllocations: itemAllocationsPayload ?? null,
      });

      if (!result.ok || !result.data?.snapToken) {
        toast.error(result.message || "Gagal membuat transaksi Midtrans Snap.");
        return;
      }

      const { snapToken } = result.data;
      setActiveSnapToken(snapToken);

      // 2. Buka popup Midtrans Snap di browser
      triggerSnapPopup(snapToken);
    });
  };

  // Helper untuk membuka popup Midtrans Snap menggunakan token aktif
  const triggerSnapPopup = (snapToken: string) => {
    if (!window.snap) {
      toast.error("Skrip Midtrans Snap belum siap di browser. Silakan muat ulang halaman.");
      return;
    }

    setMidtransWaiting(true);
    window.snap.pay(snapToken, {
      onSuccess: () => {
        setMidtransWaiting(false);
        toast.success("Pembayaran Midtrans berhasil diselesaikan.");
        checkServerPaymentStatus();
      },
      onPending: () => {
        setMidtransWaiting(false);
        toast.info("Pembayaran menunggu penyelesaian pelanggan.");
        checkServerPaymentStatus();
      },
      onError: () => {
        setMidtransWaiting(false);
        toast.error("Terjadi kegagalan pada transaksi Midtrans.");
      },
      onClose: () => {
        // Sesuai aturan: Jangan menganggap berhasil hanya karena popup ditutup.
        // Tetap verifikasi status aktual dari server/webhook via rekonsiliasi aktif.
        setMidtransWaiting(false);
        toast.info("Popup ditutup. Memeriksa status verifikasi server...");
        checkServerPaymentStatus();
      },
    });
  };

  // Verifikasi status pembayaran tepercaya dari server dengan rekonsiliasi aktif
  const checkServerPaymentStatus = async () => {
    if (isVerifyingMidtrans) return;
    setIsVerifyingMidtrans(true);
    try {
      const res = await getOrderPaymentStatusAction(order.id);
      setIsVerifyingMidtrans(false);
      if (res.ok && res.data) {
        if (res.data.activeSnapToken && !activeSnapToken) {
          setActiveSnapToken(res.data.activeSnapToken);
        }
        if (res.data.isSettled) {
          toast.success(`Pesanan #${res.data.orderNumber} LUNAS terverifikasi!`);
          setMidtransWaiting(false);
          onPaymentSuccess(order.id, true);
        } else if (res.data.paidTotal > 0) {
          toast.success(
            `Pembayaran parsial terverifikasi. Sisa tagihan: ${formatRupiah(res.data.remainingBalance)}`,
          );
          setMidtransWaiting(false);
          onPaymentSuccess(order.id, false);
        } else {
          toast.info(res.data.reconciliationMessage || "Pembayaran masih menunggu penyelesaian pelanggan.");
        }
      } else {
        toast.error(res.message || "Gagal memeriksa status pembayaran server.");
      }
    } catch {
      setIsVerifyingMidtrans(false);
      toast.error("Gagal memeriksa status pembayaran server.");
    }
  };

  // Deteksi otomatis jika pesanan sudah memiliki transaksi Snap aktif saat tab Midtrans dibuka
  useEffect(() => {
    if (method === "midtrans_snap" && !activeSnapToken) {
      getOrderPaymentStatusAction(order.id).then((res) => {
        if (res.ok && res.data?.activeSnapToken) {
          setActiveSnapToken(res.data.activeSnapToken);
          if (res.data.isSettled) {
            toast.success(`Pesanan #${res.data.orderNumber} LUNAS terverifikasi!`);
            onPaymentSuccess(order.id, true);
          }
        }
      }).catch(() => {});
    }
  }, [method, order.id, activeSnapToken, onPaymentSuccess, setActiveSnapToken]);

  return (
    <>
      {/* Header */}
      <DialogHeader className="p-5 pb-3 border-b bg-muted/20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <CreditCard className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold font-display">
                Pembayaran Pesanan #{order.order_number}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {order.order_type === "dine_in"
                  ? `Dine-in (${order.tableName || "Meja"})`
                  : "Takeaway"}{" "}
                • {order.items.length} item
              </DialogDescription>
            </div>
          </div>

          <div className="text-right">
            <span className="text-[11px] text-muted-foreground block">Sisa Tagihan</span>
            <span className="text-base font-bold font-display text-primary">
              {formatRupiah(remainingBalance)}
            </span>
          </div>
        </div>
      </DialogHeader>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
        {/* Mode Split Bill Selector */}
        <div className="rounded-xl border bg-muted/20 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-bold flex items-center gap-1.5">
              <Split className="size-3.5 text-primary" />
              Opsi Pembagian Tagihan (Split Bill)
            </Label>
            <Badge variant="outline" className="text-[10px]">
              {splitMode === "full"
                ? "Bayar Penuh"
                : splitMode === "custom_amount"
                  ? "Nominal Kustom"
                  : "Per Item"}
            </Badge>
          </div>

          <RadioGroup
            value={splitMode}
            onValueChange={(val) => setSplitMode(val as SplitMode)}
            className="grid grid-cols-3 gap-2 pt-1"
          >
            <div className="flex items-center space-x-2 rounded-lg border p-2 bg-background hover:bg-muted/50 cursor-pointer">
              <RadioGroupItem value="full" id="split-full" />
              <Label htmlFor="split-full" className="text-[11px] font-medium cursor-pointer">
                Bayar Penuh
              </Label>
            </div>

            <div className="flex items-center space-x-2 rounded-lg border p-2 bg-background hover:bg-muted/50 cursor-pointer">
              <RadioGroupItem value="custom_amount" id="split-custom" />
              <Label htmlFor="split-custom" className="text-[11px] font-medium cursor-pointer">
                Nominal Parsial
              </Label>
            </div>

            <div className="flex items-center space-x-2 rounded-lg border p-2 bg-background hover:bg-muted/50 cursor-pointer">
              <RadioGroupItem value="by_item" id="split-item" />
              <Label htmlFor="split-item" className="text-[11px] font-medium cursor-pointer">
                Pilih Item
              </Label>
            </div>
          </RadioGroup>

          {/* Input Kustom Nominal Parsial */}
          {splitMode === "custom_amount" && (
            <div className="pt-2 space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                Nominal Pembayaran Kali Ini:
              </Label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-xs text-muted-foreground">Rp</span>
                <Input
                  type="number"
                  min={1}
                  max={remainingBalance}
                  value={customAmount || ""}
                  onChange={(e) => setCustomAmount(parseInt(e.target.value, 10) || 0)}
                  className="pl-8 h-9 text-xs font-mono font-bold"
                />
              </div>
            </div>
          )}

          {/* Pilihan Item untuk Split Bill Item */}
          {splitMode === "by_item" && (
            <div className="pt-2 space-y-1.5 max-h-36 overflow-y-auto">
              <Label className="text-[11px] text-muted-foreground">
                Centang item yang akan dibayar pada transaksi ini:
              </Label>
              {order.items.map((it) => {
                const isSelected = selectedItemIds.has(it.id);
                return (
                  <div
                    key={it.id}
                    onClick={() => {
                      const updated = new Set(selectedItemIds);
                      if (isSelected) updated.delete(it.id);
                      else updated.add(it.id);
                      setSelectedItemIds(updated);
                    }}
                    className={`flex items-center justify-between p-2 rounded-lg border cursor-pointer transition-colors ${
                      isSelected ? "border-primary bg-primary/5" : "bg-background"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}} // dikontrol parent div
                        className="rounded border-input text-primary"
                      />
                      <span className="font-medium text-[11px]">
                        {it.product_name_snapshot} x{it.quantity}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] font-bold">
                      {formatRupiah(it.line_total)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Total Tagihan yang Dibayar */}
        <div className="rounded-xl border p-3 bg-card flex items-center justify-between">
          <span className="font-bold text-xs">Total Pembayaran Sekarang</span>
          <span className="font-display font-bold text-lg text-primary">
            {formatRupiah(payAmount)}
          </span>
        </div>

        {/* Tab Metode Pembayaran */}
        <div className="space-y-3">
          <div className="grid grid-cols-4 gap-1 p-1 bg-muted/40 rounded-xl border">
            <button
              type="button"
              onClick={() => {
                setMethod("cash");
                setMidtransWaiting(false);
              }}
              className={cn(
                "flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg text-xs font-semibold transition-all",
                method === "cash"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
              )}
            >
              <Banknote className="size-3.5" />
              Tunai
            </button>
            <button
              type="button"
              onClick={() => {
                setMethod("midtrans_snap");
                setMidtransWaiting(false);
              }}
              className={cn(
                "flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg text-xs font-semibold transition-all",
                method === "midtrans_snap"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
              )}
            >
              <QrCode className="size-3.5" />
              Midtrans
            </button>
            <button
              type="button"
              onClick={() => {
                setMethod("qris_manual");
                setMidtransWaiting(false);
              }}
              className={cn(
                "flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg text-xs font-semibold transition-all",
                method === "qris_manual"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
              )}
            >
              <ScanLine className="size-3.5" />
              QRIS
            </button>
            <button
              type="button"
              onClick={() => {
                setMethod("bank_transfer");
                setMidtransWaiting(false);
              }}
              className={cn(
                "flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg text-xs font-semibold transition-all",
                method === "bank_transfer"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
              )}
            >
              <Building2 className="size-3.5" />
              Transfer
            </button>
          </div>

          {/* TAB 1: TUNAI (CASH) */}
          {method === "cash" && (
            <div className="space-y-3 pt-1">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Uang Tunai Diterima (Cash Received)</Label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-xs text-muted-foreground font-semibold">
                    Rp
                  </span>
                  <Input
                    type="number"
                    min={0}
                    value={cashReceived}
                    onChange={(e) => setCashReceived(e.target.value)}
                    placeholder="0"
                    className="pl-9 h-10 text-sm font-mono font-bold"
                  />
                </div>
              </div>

              {/* Quick Cash Buttons */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {quickCashPresets.map((preset) => (
                  <Button
                    key={preset}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCashReceived(preset.toString())}
                    className={`h-8.5 px-3 text-xs font-mono font-semibold rounded-lg transition-colors ${
                      parsedCashReceived === preset
                        ? "border-primary bg-primary/10 text-primary font-bold shadow-2xs"
                        : "hover:bg-muted/60"
                    }`}
                  >
                    {preset === payAmount ? "Uang Pas" : formatRupiah(preset)}
                  </Button>
                ))}
              </div>

              {/* Kembalian Box */}
              <div
                className={`rounded-xl border p-3 flex items-center justify-between ${
                  isCashDeficit
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
                    : "border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200"
                }`}
              >
                <div className="flex items-center gap-2">
                  {isCashDeficit ? (
                    <AlertCircle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  ) : (
                    <CheckCircle className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  )}
                  <span className="font-semibold text-xs">
                    {isCashDeficit ? "Uang Tunai Kurang" : "Kembalian"}
                  </span>
                </div>
                <span className="font-mono font-bold text-base">
                  {isCashDeficit
                    ? `- ${formatRupiah(payAmount - parsedCashReceived)}`
                    : formatRupiah(changeAmount)}
                </span>
              </div>
            </div>
          )}

          {/* TAB 2: MIDTRANS SNAP (SANDBOX) */}
          {method === "midtrans_snap" && (
            <div className="space-y-3 pt-1">
              <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold flex items-center gap-1.5 text-foreground">
                    <QrCode className="size-4 text-primary" />
                    Midtrans Snap Gateway (Sandbox)
                  </span>
                  <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">
                    Sandbox Active
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Membuka popup pembayaran Snap terintegrasi. Pelanggan dapat membayar via simulator QRIS
                  GoPay, ShopeePay, atau Virtual Account bank.
                </p>

                {/* Status Box & Tombol Cek Status */}
                {activeSnapToken ? (
                  <div className="pt-2.5 border-t border-primary/20 space-y-2.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <Clock className="size-3.5 text-amber-500" />
                        <span>Transaksi Snap Aktif</span>
                      </div>
                      <Badge variant="secondary" className="text-[10px] font-mono">
                        Menunggu Verifikasi
                      </Badge>
                    </div>

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-1.5">
                      <Button
                        type="button"
                        size="default"
                        variant="default"
                        disabled={isVerifyingMidtrans || isSubmitting}
                        onClick={checkServerPaymentStatus}
                        className="flex-1 h-9 px-4 text-xs font-bold gap-2 bg-primary text-primary-foreground shadow-xs rounded-xl"
                      >
                        <RefreshCw className={`size-3.5 ${isVerifyingMidtrans ? "animate-spin" : ""}`} />
                        {isVerifyingMidtrans ? "Memeriksa Status..." : "Cek Status Pembayaran"}
                      </Button>

                      <Button
                        type="button"
                        size="default"
                        variant="outline"
                        disabled={isVerifyingMidtrans || isSubmitting || midtransWaiting}
                        onClick={() => triggerSnapPopup(activeSnapToken)}
                        className="h-9 px-4 text-xs font-semibold gap-2 border-primary/40 hover:bg-primary/10 rounded-xl"
                      >
                        <ExternalLink className="size-3.5" />
                        Buka Ulang Snap
                      </Button>
                    </div>
                  </div>
                ) : midtransWaiting ? (
                  <div className="pt-2 border-t border-primary/20 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-primary font-medium text-[11px]">
                      <Loader2 className="size-3.5 animate-spin" />
                      Menunggu konfirmasi pembayaran...
                    </div>
                  </div>
                ) : (
                  <p className="text-[10px] text-muted-foreground italic">
                    Klik tombol di bawah untuk membuka popup pembayaran Midtrans Snap.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: QRIS MANUAL */}
          {method === "qris_manual" && (
            <div className="space-y-3 pt-1">
              <div className="rounded-xl border bg-muted/20 p-3 space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  Gunakan jika pelanggan memindai barcode QRIS statis di meja kasir Nine Licious.
                </p>
                <div className="space-y-1">
                  <Label className="text-[11px]">Nomor Referensi / RRN QRIS (Opsional)</Label>
                  <Input
                    type="text"
                    placeholder="Contoh: RRN-981240192"
                    value={referenceNumber}
                    onChange={(e) => setReferenceNumber(e.target.value)}
                    className="h-8 text-xs font-mono"
                  />
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: BANK TRANSFER */}
          {method === "bank_transfer" && (
            <div className="space-y-3 pt-1">
              <div className="rounded-xl border bg-muted/20 p-3 space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  Pencatatan pembayaran transfer bank langsung ke rekening operasional resto.
                </p>
                <div className="space-y-1">
                  <Label className="text-[11px]">Nomor Referensi Transfer / Bukti (Opsional)</Label>
                  <Input
                    type="text"
                    placeholder="Contoh: TRF-BCA-102931"
                    value={referenceNumber}
                    onChange={(e) => setReferenceNumber(e.target.value)}
                    className="h-8 text-xs font-mono"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Catatan Transaksi */}
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Catatan Pembayaran (Opsional)</Label>
          <Input
            type="text"
            placeholder="Keterangan tambahan transaksi..."
            value={paymentNotes}
            onChange={(e) => setPaymentNotes(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
      </div>

      {/* Footer */}
      <DialogFooter className="p-4 sm:p-5 border-t bg-muted/20 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <Button
          type="button"
          variant="ghost"
          size="default"
          disabled={isSubmitting || midtransWaiting}
          onClick={onClose}
          className="h-10 px-4 text-xs font-medium rounded-xl hover:bg-muted"
        >
          Batal
        </Button>

        {method === "midtrans_snap" ? (
          activeSnapToken ? (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <Button
                type="button"
                size="default"
                variant="outline"
                disabled={isSubmitting || isVerifyingMidtrans || midtransWaiting}
                onClick={() => triggerSnapPopup(activeSnapToken)}
                className="h-10 px-4 text-xs font-semibold rounded-xl border-primary/40 hover:bg-primary/10 gap-2"
              >
                <ExternalLink className="size-3.5" />
                Buka Ulang Snap
              </Button>
              <Button
                type="button"
                size="default"
                disabled={isSubmitting || isVerifyingMidtrans}
                onClick={checkServerPaymentStatus}
                className="h-10 px-5 text-xs font-bold bg-primary text-primary-foreground shadow-sm rounded-xl gap-2 hover:bg-primary/90"
              >
                <RefreshCw className={`size-3.5 ${isVerifyingMidtrans ? "animate-spin" : ""}`} />
                {isVerifyingMidtrans ? "Memeriksa..." : "Cek Status Pembayaran"}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="default"
              disabled={isSubmitting || midtransWaiting || payAmount <= 0}
              onClick={handleOpenMidtransSnap}
              className="h-10 px-5 text-xs sm:text-sm font-bold bg-primary text-primary-foreground shadow-sm rounded-xl gap-2 hover:bg-primary/90"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Membuka Snap...
                </>
              ) : midtransWaiting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Snap Sedang Aktif...
                </>
              ) : (
                <>
                  <ExternalLink className="size-4" />
                  Buka Midtrans Snap ({formatRupiah(payAmount)})
                </>
              )}
            </Button>
          )
        ) : (
          <Button
            type="button"
            size="default"
            disabled={
              isSubmitting ||
              midtransWaiting ||
              payAmount <= 0 ||
              (method === "cash" && isCashDeficit)
            }
            onClick={handleProcessManualPayment}
            className="h-10 px-5 text-xs sm:text-sm font-bold bg-primary text-primary-foreground shadow-sm rounded-xl gap-2 hover:bg-primary/90"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Memproses Pembayaran...
              </>
            ) : (
              <>
                <CheckCircle className="size-4" />
                Bayar Sekarang ({formatRupiah(payAmount)})
              </>
            )}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
