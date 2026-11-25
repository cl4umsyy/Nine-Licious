"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Ban,
  Banknote,
  CheckCircle,
  Clock,
  CreditCard,
  ExternalLink,
  Loader2,
  QrCode,
  Receipt,
  RefreshCw,
  Split,
  Wallet,
  XCircle,
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
import type { ActiveMidtransReservationInfo } from "@/lib/midtrans/reservation";
import {
  canCancelOrder,
  canPayOrder,
  canShowReceiptForOrder,
  isOrderCancelledOrRefunded,
} from "@/lib/orders/status-rules";
import type { OrderWithDetails } from "@/lib/orders/types";
import {
  cancelActiveMidtransReservationAction,
  createPosMidtransSnapAction,
  retryExpiredMidtransSnapAction,
  getOrderPaymentStatusAction,
  getOrderPaymentSummaryAction,
  processPosManualPaymentAction,
  type OrderPaymentSummaryData,
} from "@/lib/payments/actions";
import { getActiveShiftAction } from "@/lib/shifts/actions";
import type { Shift } from "@/types/database";

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

export type PaymentMethodTab = "cash" | "midtrans_snap";
export type SplitMode = "full" | "custom_amount" | "by_item";

export type PaymentModalProps = {
  order: OrderWithDetails | null;
  isOpen: boolean;
  onClose: () => void;
  onPaymentSuccess: (orderId: string, isSettled: boolean) => void;
  onOrderCancelled?: (orderId: string) => void;
  onOpenCancelOrder?: (order: OrderWithDetails) => void;
  activeShift?: Shift | null;
};

export function PaymentModal({
  order,
  isOpen,
  onClose,
  onPaymentSuccess,
  onOrderCancelled,
  onOpenCancelOrder,
  activeShift: propActiveShift,
}: PaymentModalProps) {
  const [midtransWaiting, setMidtransWaiting] = useState(false);
  const [method, setMethod] = useState<PaymentMethodTab>("cash");
  const [splitMode, setSplitMode] = useState<SplitMode>("full");
  const [fetchedActiveShift, setFetchedActiveShift] = useState<Shift | null>(null);
  const activeShift = propActiveShift !== undefined ? propActiveShift : fetchedActiveShift;
  const [isLoadingShift, setIsLoadingShift] = useState(false);

  useEffect(() => {
    if (propActiveShift !== undefined || !isOpen) return;
    let isMounted = true;
    async function fetchShift() {
      setIsLoadingShift(true);
      const res = await getActiveShiftAction();
      if (isMounted && res.ok) {
        setFetchedActiveShift((res.data as unknown as Shift) || null);
      }
      if (isMounted) setIsLoadingShift(false);
    }
    void fetchShift();
    return () => {
      isMounted = false;
    };
  }, [isOpen, propActiveShift]);

  const remainingBalance = useMemo(() => {
    if (!order) return 0;
    return Math.max(0, order.grand_total - (order.paid_total || 0));
  }, [order]);

  const [customAmount, setCustomAmount] = useState<number>(0);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [cashReceived, setCashReceived] = useState<string>("");
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
        className="w-[calc(100vw-1.5rem)] max-w-[800px] sm:max-w-[780px] lg:max-w-[800px] max-h-[90dvh] flex flex-col p-0 gap-0 overflow-hidden rounded-2xl shadow-2xl"
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
            onOrderCancelled={onOrderCancelled}
            onOpenCancelOrder={onOpenCancelOrder}
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
            paymentNotes={paymentNotes}
            setPaymentNotes={setPaymentNotes}
            idempotencyKey={idempotencyKey}
            onRefreshIdempotencyKey={() => setIdempotencyKey(crypto.randomUUID())}
            midtransWaiting={midtransWaiting}
            setMidtransWaiting={setMidtransWaiting}
            activeSnapToken={activeSnapToken}
            setActiveSnapToken={setActiveSnapToken}
            activeShift={activeShift}
            isLoadingShift={isLoadingShift}
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
  onOrderCancelled,
  onOpenCancelOrder,
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
  paymentNotes,
  setPaymentNotes,
  idempotencyKey,
  onRefreshIdempotencyKey,
  midtransWaiting,
  setMidtransWaiting,
  activeSnapToken,
  setActiveSnapToken,
  activeShift,
  isLoadingShift,
}: {
  order: OrderWithDetails;
  onClose: () => void;
  onPaymentSuccess: (orderId: string, isSettled: boolean) => void;
  onOrderCancelled?: (orderId: string) => void;
  onOpenCancelOrder?: (order: OrderWithDetails) => void;
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
  paymentNotes: string;
  setPaymentNotes: (s: string) => void;
  idempotencyKey: string;
  onRefreshIdempotencyKey: () => void;
  midtransWaiting: boolean;
  setMidtransWaiting: (waiting: boolean) => void;
  activeSnapToken: string | null;
  setActiveSnapToken: (token: string | null) => void;
  activeShift: Shift | null;
  isLoadingShift: boolean;
}) {
  // State proses transaksi, reservasi gateway & Midtrans
  const [isSubmitting, startTransition] = useTransition();
  const [isVerifyingMidtrans, setIsVerifyingMidtrans] = useState(false);
  const [isCancellingMidtrans, setIsCancellingMidtrans] = useState(false);
  const [pendingGatewayNotice, setPendingGatewayNotice] = useState<{
    message: string;
    midtransOrderIds: string[];
  } | null>(null);
  const [paymentSummary, setPaymentSummary] =
    useState<OrderPaymentSummaryData | null>(null);
  const [snapLoadError, setSnapLoadError] = useState<string | null>(() =>
    !process.env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY
      ? "NEXT_PUBLIC_MIDTRANS_CLIENT_KEY belum dikonfigurasi di browser."
      : null,
  );

  // Muat ringkasan saldo & reservasi gateway secara READ-ONLY saat modal dibuka.
  // Tidak membuat transaksi Midtrans baru dan tidak otomatis menutup modal / membuka struk.
  const refreshPaymentSummary = useCallback(async () => {
    try {
      const res = await getOrderPaymentSummaryAction(order.id);
      if (res.ok && res.data) {
        setPaymentSummary(res.data);
        if (res.data.activeMidtransTx?.canReopenSnap && res.data.activeMidtransTx.snapToken) {
          setActiveSnapToken(res.data.activeMidtransTx.snapToken);
        } else {
          setActiveSnapToken(null);
        }
      }
    } catch {
      // Biarkan nilai fallback dari prop order tetap tampil
    }
  }, [order.id, setActiveSnapToken]);

  useEffect(() => {
    let active = true;
    getOrderPaymentSummaryAction(order.id)
      .then((res) => {
        if (!active) return;
        if (res.ok && res.data) {
          setPaymentSummary(res.data);
          if (res.data.activeMidtransTx?.canReopenSnap && res.data.activeMidtransTx.snapToken) {
            setActiveSnapToken(res.data.activeMidtransTx.snapToken);
          } else {
            setActiveSnapToken(null);
          }
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [order.id, setActiveSnapToken]);

  const effectiveRemainingBalance =
    paymentSummary?.remainingBalance ?? remainingBalance;
  const reservedAmount = paymentSummary?.reservedAmount ?? 0;
  const availableForCashAmount =
    paymentSummary?.availableForCashAmount ?? effectiveRemainingBalance;
  const activeMidtransTx: ActiveMidtransReservationInfo | null =
    paymentSummary?.activeMidtransTx ?? null;
  const currentOrderStatus = paymentSummary?.status ?? order.status;
  const currentPaymentStatus = paymentSummary?.paymentStatus ?? order.payment_status;
  const currentPaidTotal = paymentSummary?.paidTotal ?? order.paid_total;
  const isCancelledOrRefunded = isOrderCancelledOrRefunded({
    status: currentOrderStatus,
    payment_status: currentPaymentStatus,
  });
  const isOrderPayable = canPayOrder({
    status: currentOrderStatus,
    payment_status: currentPaymentStatus,
  });
  const canCancelCurrentOrder = canCancelOrder({
    status: currentOrderStatus,
    payment_status: currentPaymentStatus,
    paid_total: currentPaidTotal,
  });
  const isAlreadySettledInDb =
    !isCancelledOrRefunded &&
    canShowReceiptForOrder({
      status: currentOrderStatus,
      payment_status: currentPaymentStatus,
      paid_total: currentPaidTotal,
    }) &&
    Boolean(
      paymentSummary
        ? paymentSummary.isSettled && paymentSummary.paymentStatus === "paid"
        : order.payment_status === "paid" || order.status === "paid",
    );

  // Muat script Midtrans Snap secara dinamis untuk environment sandbox
  useEffect(() => {
    const clientKey = process.env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY;
    if (!clientKey) return;

    const scriptId = "midtrans-snap-script";
    let script = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = scriptId;
      script.src = "https://app.sandbox.midtrans.com/snap/snap.js";
      script.setAttribute("data-client-key", clientKey);
      script.async = true;
      script.onload = () => {
        setSnapLoadError(null);
      };
      script.onerror = () => {
        const msg = "Gagal memuat skrip Midtrans Snap dari CDN. Periksa koneksi internet atau pemblokir iklan/skrip.";
        setSnapLoadError(msg);
        console.error("[Midtrans Snap]", msg);
      };
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
      return effectiveRemainingBalance;
    }
    if (splitMode === "custom_amount") {
      return Math.min(Math.max(1, customAmount || 0), effectiveRemainingBalance);
    }
    if (splitMode === "by_item") {
      if (selectedItemIds.size === 0) return 0;
      if (itemAllocationCalculation) {
        return Math.min(itemAllocationCalculation.grossTotal, effectiveRemainingBalance);
      }
      const selectedSubtotal = order.items
        .filter((it) => selectedItemIds.has(it.id))
        .reduce((sum, it) => sum + it.line_total, 0);

      if (order.subtotal <= 0) return selectedSubtotal;

      const taxRate = order.tax_percent / 100;
      const serviceRate = order.service_charge_percent / 100;
      const effectiveTotal = Math.round(selectedSubtotal * (1 + taxRate + serviceRate));

      return Math.min(Math.max(1, effectiveTotal), effectiveRemainingBalance);
    }
    return effectiveRemainingBalance;
  }, [splitMode, effectiveRemainingBalance, customAmount, selectedItemIds, itemAllocationCalculation, order.items, order.subtotal, order.tax_percent, order.service_charge_percent]);

  const isCashBlockedByReservation =
    method === "cash" && reservedAmount > 0 && payAmount > availableForCashAmount;

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

    if (isCancelledOrRefunded || !isOrderPayable) {
      toast.error(
        `Pesanan #${order.order_number} berstatus ${currentOrderStatus} dan tidak dapat menerima pembayaran.`,
      );
      return;
    }

    if (!order.is_finalized) {
      toast.error("Pesanan belum difinalisasi. Mohon finalisasi pesanan terlebih dahulu.");
      return;
    }

    if (method === "cash" && !activeShift) {
      toast.error(
        "Kasir belum membuka shift kasir. Buka shift terlebih dahulu sebelum memproses pembayaran tunai.",
      );
      return;
    }

    if (splitMode === "by_item" && selectedItemIds.size === 0) {
      toast.error("Pilih minimal satu item untuk pembayaran split bill.");
      return;
    }

    if (method === "cash" && isCashBlockedByReservation) {
      toast.error(
        `Sebesar ${formatRupiah(reservedAmount)} sedang direservasi transaksi Midtrans. Periksa status atau batalkan reservasi Midtrans terlebih dahulu.`,
      );
      return;
    }

    if (method === "cash" && isCashDeficit) {
      toast.error(
        `Uang tunai diterima kurang dari nominal tagihan (Kurang ${formatRupiah(payAmount - parsedCashReceived)}).`,
      );
      return;
    }

    startTransition(async () => {
      const payload = {
        orderId: order.id,
        paymentMethod: "cash" as const,
        paymentSource: "cash" as const,
        amount: payAmount,
        cashReceived: parsedCashReceived,
        changeAmount,
        referenceNumber: null,
        idempotencyKey,
        notes: paymentNotes.trim() || null,
      };

      const result = await processPosManualPaymentAction(payload);

      if (result.ok && result.data) {
        toast.success(result.message);
        onPaymentSuccess(order.id, result.data.is_settled);
      } else {
        toast.error(result.message || "Gagal memproses pembayaran.");
        void refreshPaymentSummary();
      }
    });
  };

  // Eksekusi Midtrans Snap Sandbox (F2.2 & TAHAP 3)
  const handleOpenMidtransSnap = () => {
    if (isSubmitting || midtransWaiting) return;

    if (isCancelledOrRefunded || !isOrderPayable) {
      toast.error(
        `Pesanan #${order.order_number} berstatus ${currentOrderStatus} dan tidak dapat membuat pembayaran baru.`,
      );
      return;
    }

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
        setMidtransWaiting(false);
        void refreshPaymentSummary();
        return;
      }

      const { snapToken } = result.data;
      setActiveSnapToken(snapToken);
      void refreshPaymentSummary();

      // 2. Buka popup Midtrans Snap di browser (JANGAN langsung buka struk sebelum terverifikasi server!)
      triggerSnapPopup(snapToken);
    });
  };

  // Helper untuk membuka popup Midtrans Snap menggunakan token aktif
  const triggerSnapPopup = (snapToken: string) => {
    if (!window.snap) {
      const clientKey = process.env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY;
      if (!clientKey) {
        toast.error("NEXT_PUBLIC_MIDTRANS_CLIENT_KEY belum diisi di environment.");
      } else if (snapLoadError) {
        toast.error(snapLoadError);
      } else {
        toast.error("Skrip Midtrans Snap belum siap di browser. Silakan muat ulang halaman atau periksa koneksi internet.");
      }
      return;
    }

    setMidtransWaiting(true);
    try {
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
        onError: (err) => {
          setMidtransWaiting(false);
          console.error("[Midtrans Snap] Transaksi onError:", err);
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
    } catch (popupErr) {
      setMidtransWaiting(false);
      console.error("[Midtrans Snap] Eksepsi saat membuka snap.pay:", popupErr);
      toast.error(
        "Gagal menampilkan popup Snap: " +
          (popupErr instanceof Error ? popupErr.message : "Kesalahan tidak terduga"),
      );
    }
  };

  // Membuat Snap Token baru ketika token lama sudah expired (attempt baru)
  const handleRetryExpiredMidtransSnap = () => {
    if (isSubmitting || isVerifyingMidtrans || isCancellingMidtrans) return;

    if (isCancelledOrRefunded || !isOrderPayable) {
      toast.error(
        `Pesanan #${order.order_number} berstatus ${currentOrderStatus} dan tidak dapat membuat token baru.`,
      );
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

      const freshIdempotencyKey = `pos-midtrans-${order.id}-${Date.now()}`;
      onRefreshIdempotencyKey();

      const result = await retryExpiredMidtransSnapAction({
        orderId: order.id,
        grossAmount: effectiveGross,
        idempotencyKey: freshIdempotencyKey,
        isSplitBill: splitMode !== "full",
        splitBillType:
          splitMode === "by_item"
            ? "by_item"
            : splitMode === "custom_amount"
              ? "custom_amount"
              : null,
        itemAllocations: itemAllocationsPayload ?? null,
      });

      if (!result.ok || !result.data?.snapToken) {
        toast.error(result.message || "Gagal membuat attempt Midtrans Snap baru.");
        setMidtransWaiting(false);
        void refreshPaymentSummary();
        return;
      }

      const { snapToken } = result.data;
      setActiveSnapToken(snapToken);
      await refreshPaymentSummary();
      toast.success("Token Midtrans Snap baru berhasil dibuat.");
      triggerSnapPopup(snapToken);
    });
  };

  // Verifikasi status pembayaran tepercaya dari server dengan rekonsiliasi aktif (GET Status API)
  const checkServerPaymentStatus = async () => {
    if (isVerifyingMidtrans || isCancellingMidtrans) return;
    setIsVerifyingMidtrans(true);
    try {
      const res = await getOrderPaymentStatusAction(order.id);
      setIsVerifyingMidtrans(false);
      if (res.ok && res.data) {
        setPaymentSummary({
          orderId: res.data.orderId,
          orderNumber: res.data.orderNumber,
          status: res.data.status,
          paymentStatus: res.data.paymentStatus,
          grandTotal: res.data.grandTotal,
          paidTotal: res.data.paidTotal,
          remainingBalance: res.data.remainingBalance,
          reservedAmount: res.data.reservedAmount,
          availableForCashAmount: res.data.availableForCashAmount,
          isSettled: res.data.isSettled,
          queueNumber: res.data.queueNumber ?? null,
          activeMidtransTx: res.data.activeMidtransTx ?? null,
        });

        setActiveSnapToken(res.data.activeSnapToken ?? null);

        const responseCancelledOrRefunded = isOrderCancelledOrRefunded({
          status: res.data.status,
          payment_status: res.data.paymentStatus,
        });
        const responseReceiptAllowed =
          !responseCancelledOrRefunded &&
          canShowReceiptForOrder({
            status: res.data.status,
            payment_status: res.data.paymentStatus,
            paid_total: res.data.paidTotal,
          });

        if (responseCancelledOrRefunded) {
          setMidtransWaiting(false);
          setActiveSnapToken(null);
          toast.error(
            res.data.reconciliationMessage ||
              `Pesanan #${res.data.orderNumber} berstatus ${res.data.status} dan tidak dapat diproses atau dicetak struknya.`,
          );
          await refreshPaymentSummary();
          return;
        }

        // SYARAT MUTLAK: onPaymentSuccess hanya dipanggil jika DATABASE sudah benar-benar berstatus "paid" & bukan cancelled
        if (
          responseReceiptAllowed &&
          res.data.isSettled &&
          res.data.paymentStatus === "paid"
        ) {
          toast.success(
            `Pesanan #${res.data.orderNumber} LUNAS terverifikasi di Midtrans!`,
          );
          setMidtransWaiting(false);
          onPaymentSuccess(order.id, true);
        } else if (res.data.isSettled && res.data.paymentStatus !== "paid") {
          // Gateway sudah settlement, namun status database belum paid
          toast.warning(
            res.data.reconciliationMessage ||
              "Pembayaran telah berhasil di gateway Midtrans, namun sinkronisasi database sedang diproses. Struk belum dapat dicetak.",
          );
          await refreshPaymentSummary();
        } else if (res.data.reservationReleased) {
          onRefreshIdempotencyKey();
          toast.info(
            res.data.reconciliationMessage ||
              "Reservasi Midtrans telah dilepas. Silakan bayar dengan Tunai, buat transaksi Midtrans baru, atau batalkan pesanan.",
          );
          await refreshPaymentSummary();
        } else if (
          responseReceiptAllowed &&
          res.data.paidTotal > (order.paid_total || 0) &&
          res.data.paymentStatus === "paid"
        ) {
          toast.success(
            `Pembayaran parsial terverifikasi. Sisa tagihan: ${formatRupiah(res.data.remainingBalance)}`,
          );
          setMidtransWaiting(false);
          onPaymentSuccess(order.id, false);
        } else {
          toast.info(
            res.data.reconciliationMessage ||
              "Pembayaran masih menunggu penyelesaian pelanggan.",
          );
        }
      } else {
        toast.error(res.message || "Gagal memeriksa status pembayaran server.");
      }
    } catch {
      setIsVerifyingMidtrans(false);
      toast.error("Gagal memeriksa status pembayaran server.");
    }
  };

  // Pembatalan aman reservasi Midtrans (wajib cek status aktual Midtrans dulu di server).
  // TIDAK PERNAH memicu pembayaran tunai, onPaymentSuccess, atau membuka struk.
  const handleCancelMidtransReservation = async (
    mode: "cancel_order" | "release_to_cash" | "official_pending_cancel" = "cancel_order",
  ) => {
    if (isCancellingMidtrans || isVerifyingMidtrans || midtransWaiting) return;
    setIsCancellingMidtrans(true);
    try {
      const res = await cancelActiveMidtransReservationAction(order.id, { mode });
      setIsCancellingMidtrans(false);

      if (!res.ok) {
        if (res.errorCode === "PENDING_GATEWAY") {
          setPendingGatewayNotice({
            message: res.message,
            midtransOrderIds: res.meta?.pendingMidtransOrderIds ?? [],
          });
          toast.warning(res.message);
        } else {
          toast.error(res.message);
        }
        void refreshPaymentSummary();
        return;
      }

      setPendingGatewayNotice(null);

      if (res.data?.wasAlreadySettled) {
        toast.info(res.message);
        await refreshPaymentSummary();
        return;
      }

      setActiveSnapToken(null);
      setMidtransWaiting(false);
      if (!res.data?.orderCancelled) {
        onRefreshIdempotencyKey();
      }
      toast.success(res.message);
      await refreshPaymentSummary();
      if (res.data?.orderCancelled) {
        onOrderCancelled?.(order.id);
      }
    } catch {
      setIsCancellingMidtrans(false);
      toast.error("Gagal membatalkan reservasi Midtrans. Silakan coba lagi.");
    }
  };

  return (
    <>
      {/* Header */}
      <DialogHeader className="px-5 sm:px-6 py-4 sm:py-5 pr-12 sm:pr-14 border-b bg-muted/20 shrink-0 text-left">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <CreditCard className="size-5" />
            </div>
            <div className="min-w-0 space-y-0.5">
              <DialogTitle className="text-base sm:text-lg font-bold font-display leading-snug truncate">
                Pembayaran Pesanan #{order.order_number}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                {order.order_type === "dine_in"
                  ? `Dine-in (${order.tableName || "Meja"})`
                  : "Takeaway"}{" "}
                • {order.items.length} item
              </DialogDescription>
            </div>
          </div>

          <div className="rounded-xl border border-border/75 bg-card px-3.5 py-2 flex items-center justify-between sm:block sm:text-right shrink-0 shadow-2xs">
            <span className="text-[11px] font-medium text-muted-foreground sm:block">
              Sisa Tagihan
            </span>
            <span className="text-base sm:text-lg font-bold font-display text-primary tracking-tight">
              {formatRupiah(effectiveRemainingBalance)}
            </span>
          </div>
        </div>
      </DialogHeader>

      {/* Main Content */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 sm:px-6 py-5 space-y-5 text-xs">
        {/* Banner jika pesanan dibatalkan atau direfund */}
        {isCancelledOrRefunded && (
          <div className="rounded-2xl border border-destructive/35 bg-destructive/10 p-4 space-y-2 text-destructive">
            <div className="flex items-start gap-2.5">
              <Ban className="size-4.5 shrink-0 mt-0.5" />
              <div className="space-y-1 min-w-0">
                <p className="font-bold text-xs sm:text-sm">
                  {currentOrderStatus === "refunded"
                    ? "Pesanan Telah Direfund Penuh"
                    : "Pesanan Telah Dibatalkan"}
                </p>
                <p className="text-xs leading-relaxed text-destructive/90">
                  Pesanan #{order.order_number} berstatus{" "}
                  <strong>{currentOrderStatus}</strong>. Pembayaran Tunai, pembayaran
                  Midtrans baru, maupun pencetakan struk tidak lagi tersedia untuk
                  pesanan ini.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Banner jika pesanan ternyata sudah lunas di database */}
        {isAlreadySettledInDb && (
          <div className="rounded-2xl border border-emerald-500/35 bg-emerald-500/10 p-4 space-y-3 text-emerald-950 dark:text-emerald-100">
            <div className="flex items-start gap-2.5">
              <CheckCircle className="size-4.5 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
              <div className="space-y-1 min-w-0">
                <p className="font-bold text-xs sm:text-sm">
                  Pesanan Ini Sudah Lunas
                </p>
                <p className="text-xs leading-relaxed text-emerald-900/85 dark:text-emerald-200/85">
                  Seluruh tagihan pesanan #{order.order_number} telah tercatat lunas di sistem.
                  Tidak diperlukan pembayaran tambahan. Klik tombol di bawah jika ingin melihat atau mencetak struk.
                </p>
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  if (isAlreadySettledInDb) {
                    onPaymentSuccess(order.id, true);
                  }
                }}
                className="h-9 px-4 text-xs font-bold gap-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700"
              >
                <Receipt className="size-3.5 shrink-0" />
                <span>Lihat &amp; Cetak Struk</span>
              </Button>
            </div>
          </div>
        )}

        {/* Banner Status Reservasi Gateway Midtrans (tampil jelas di Tab Tunai maupun Midtrans) */}
        {!isCancelledOrRefunded && !isAlreadySettledInDb && reservedAmount > 0 && (
          <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-3 text-amber-950 dark:text-amber-100">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-start gap-2.5 min-w-0">
                <Clock className="size-4.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                <div className="space-y-1 min-w-0">
                  <p className="font-bold text-xs sm:text-sm">
                    {activeMidtransTx?.isExpired
                      ? "Reservasi Midtrans Kedaluwarsa"
                      : "Ada Transaksi Midtrans yang Masih Mereservasi Tagihan"}
                  </p>
                  <p className="text-xs leading-relaxed text-amber-900/90 dark:text-amber-200/90">
                    {activeMidtransTx?.isExpired
                      ? "Masa berlaku transaksi Midtrans sebelumnya sudah habis. Verifikasi status ke Midtrans atau batalkan reservasi agar pembayaran Tunai maupun Midtrans baru dapat dilanjutkan."
                      : "Nominal sedang direservasi oleh transaksi Midtrans untuk mencegah pembayaran ganda. Cek status Midtrans jika pelanggan sudah membayar, atau batalkan reservasi Midtrans sebelum menerima pembayaran Tunai."}
                  </p>
                </div>
              </div>
              <Badge
                variant="outline"
                className="text-[11px] px-2.5 py-0.5 border-amber-500/45 bg-card/90 text-amber-800 dark:text-amber-300 font-semibold shrink-0"
              >
                {activeMidtransTx?.isExpired ? "Kedaluwarsa" : "Reservasi Aktif"}
              </Badge>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 rounded-xl border border-amber-500/25 bg-card/80 px-3 py-2.5 text-[11px]">
              <div>
                <span className="text-muted-foreground block">Direservasi Midtrans</span>
                <span className="font-mono font-bold text-foreground">
                  {formatRupiah(reservedAmount)}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground block">Tersedia untuk Tunai</span>
                <span className="font-mono font-bold text-foreground">
                  {formatRupiah(availableForCashAmount)}
                </span>
              </div>
              <div className="min-w-0">
                <span className="text-muted-foreground block">ID Transaksi Midtrans</span>
                <span className="font-mono font-semibold text-foreground truncate block">
                  {activeMidtransTx?.midtransOrderId || "-"}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isVerifyingMidtrans || isCancellingMidtrans || isSubmitting || midtransWaiting}
                onClick={checkServerPaymentStatus}
                className="h-9 px-3.5 text-xs font-semibold gap-1.5 rounded-xl border-amber-600/35 bg-card hover:bg-amber-500/15"
              >
                <RefreshCw className={`size-3.5 shrink-0 ${isVerifyingMidtrans ? "animate-spin" : ""}`} />
                <span>{isVerifyingMidtrans ? "Memeriksa Midtrans..." : "Cek Status Midtrans"}</span>
              </Button>

              {(activeMidtransTx?.canCancel ?? true) && (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={isCancellingMidtrans || isVerifyingMidtrans || isSubmitting || midtransWaiting}
                  onClick={() => void handleCancelMidtransReservation("cancel_order")}
                  className="h-9 px-3.5 text-xs font-semibold gap-1.5 rounded-xl"
                >
                  {isCancellingMidtrans ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin shrink-0" />
                      <span>Memverifikasi Midtrans...</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="size-3.5 shrink-0" />
                      <span>Batalkan Midtrans &amp; Lepas Reservasi</span>
                    </>
                  )}
                </Button>
              )}

              {(activeMidtransTx?.canCancel ?? true) &&
                activeMidtransTx?.lifecycleStatus !== "pending" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isCancellingMidtrans || isVerifyingMidtrans || isSubmitting || midtransWaiting}
                    onClick={() => void handleCancelMidtransReservation("release_to_cash")}
                    className="h-9 px-3.5 text-xs font-semibold gap-1.5 rounded-xl border-border/80 bg-card hover:bg-muted"
                  >
                    <Banknote className="size-3.5 shrink-0" />
                    <span>Lepas &amp; Ganti ke Tunai</span>
                  </Button>
                )}
            </div>

            {(pendingGatewayNotice || activeMidtransTx?.lifecycleStatus === "pending") && (
              <div className="rounded-xl border border-amber-600/35 bg-card/90 p-3 space-y-2.5 text-xs">
                <div className="flex items-start gap-2 text-amber-950 dark:text-amber-100">
                  <AlertCircle className="size-4 shrink-0 mt-0.5 text-amber-600" />
                  <div className="space-y-1 min-w-0">
                    <p className="font-bold">
                      Transaksi Masih PENDING di Gateway Midtrans
                    </p>
                    <p className="leading-relaxed text-muted-foreground">
                      {pendingGatewayNotice?.message ||
                        "Pembayaran masih menunggu penyelesaian pelanggan dan tidak dianggap batal. Anda dapat menunggu pelanggan menyelesaikan pembayaran atau membatalkan resmi ke Midtrans apabila pelanggan benar-benar membatalkan transaksi."}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={isCancellingMidtrans || isVerifyingMidtrans || isSubmitting || midtransWaiting}
                    onClick={() =>
                      void handleCancelMidtransReservation("official_pending_cancel")
                    }
                    className="h-8 px-3 text-xs font-semibold gap-1.5 rounded-lg"
                  >
                    <XCircle className="size-3.5 shrink-0" />
                    <span>Batalkan Resmi di Midtrans</span>
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {isOrderPayable && !isAlreadySettledInDb && !isCancelledOrRefunded && (
          <>
            {/* Mode Split Bill Selector */}
            <div className="rounded-2xl border border-border/80 bg-muted/15 p-4 space-y-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label className="text-xs font-bold flex items-center gap-2 text-foreground">
              <Split className="size-3.5 text-primary shrink-0" />
              Opsi Pembagian Tagihan (Split Bill)
            </Label>
            <Badge variant="outline" className="text-[11px] px-2.5 py-0.5 bg-card font-medium">
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
            className="grid grid-cols-1 sm:grid-cols-3 gap-2.5"
          >
            <label
              htmlFor="split-full"
              className={cn(
                "flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 cursor-pointer transition-all",
                splitMode === "full"
                  ? "border-primary bg-primary/5 shadow-2xs"
                  : "border-border/75 bg-card hover:bg-muted/40",
              )}
            >
              <RadioGroupItem value="full" id="split-full" />
              <span className="text-xs font-semibold text-foreground">
                Bayar Penuh
              </span>
            </label>

            <label
              htmlFor="split-custom"
              className={cn(
                "flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 cursor-pointer transition-all",
                splitMode === "custom_amount"
                  ? "border-primary bg-primary/5 shadow-2xs"
                  : "border-border/75 bg-card hover:bg-muted/40",
              )}
            >
              <RadioGroupItem value="custom_amount" id="split-custom" />
              <span className="text-xs font-semibold text-foreground">
                Nominal Parsial
              </span>
            </label>

            <label
              htmlFor="split-item"
              className={cn(
                "flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 cursor-pointer transition-all",
                splitMode === "by_item"
                  ? "border-primary bg-primary/5 shadow-2xs"
                  : "border-border/75 bg-card hover:bg-muted/40",
              )}
            >
              <RadioGroupItem value="by_item" id="split-item" />
              <span className="text-xs font-semibold text-foreground">
                Pilih Item
              </span>
            </label>
          </RadioGroup>

          {/* Input Kustom Nominal Parsial */}
          {splitMode === "custom_amount" && (
            <div className="pt-1.5 space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                Nominal Pembayaran Kali Ini
              </Label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground">
                  Rp
                </span>
                <Input
                  type="number"
                  min={1}
                  max={effectiveRemainingBalance}
                  value={customAmount || ""}
                  onChange={(e) => setCustomAmount(parseInt(e.target.value, 10) || 0)}
                  className="pl-10 h-10 text-sm font-mono font-bold rounded-xl bg-card"
                />
              </div>
            </div>
          )}

          {/* Pilihan Item untuk Split Bill Item */}
          {splitMode === "by_item" && (
            <div className="pt-1.5 space-y-2 max-h-44 overflow-y-auto pr-1">
              <Label className="text-xs font-medium text-muted-foreground">
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
                    className={`flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                      isSelected ? "border-primary bg-primary/5" : "border-border/75 bg-card hover:bg-muted/40"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}} // dikontrol parent div
                        className="rounded border-input text-primary shrink-0"
                      />
                      <span className="font-medium text-xs truncate">
                        {it.product_name_snapshot} ×{it.quantity}
                      </span>
                    </div>
                    <span className="font-mono text-xs font-bold shrink-0">
                      {formatRupiah(it.line_total)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Total Tagihan yang Dibayar */}
        <div className="rounded-2xl border border-primary/25 bg-brand-soft/30 px-4 sm:px-5 py-3.5 flex flex-wrap items-center justify-between gap-2">
          <span className="font-bold text-xs sm:text-sm text-foreground">
            Total Pembayaran Sekarang
          </span>
          <span className="font-display font-bold text-xl sm:text-2xl text-primary tracking-tight">
            {formatRupiah(payAmount)}
          </span>
        </div>

        {/* Tab Metode Pembayaran */}
        <div className="space-y-3.5">
          <div className="space-y-2">
            <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Metode Pembayaran
            </Label>
            <div className="grid grid-cols-2 gap-2.5 p-1.5 bg-muted/45 rounded-2xl border border-border/70">
              <button
                type="button"
                onClick={() => {
                  setMethod("cash");
                  setMidtransWaiting(false);
                }}
                className={cn(
                  "flex items-center justify-center gap-2 h-11 px-4 rounded-xl text-xs sm:text-sm font-semibold transition-all cursor-pointer",
                  method === "cash"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-card/80",
                )}
              >
                <Banknote className="size-4 shrink-0" />
                <span>Tunai</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMethod("midtrans_snap");
                  setMidtransWaiting(false);
                }}
                className={cn(
                  "flex items-center justify-center gap-2 h-11 px-4 rounded-xl text-xs sm:text-sm font-semibold transition-all cursor-pointer",
                  method === "midtrans_snap"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-card/80",
                )}
              >
                <QrCode className="size-4 shrink-0" />
                <span>Midtrans</span>
              </button>
            </div>
          </div>

          {/* TAB 1: TUNAI (CASH) */}
          {method === "cash" && (
            <div className="rounded-2xl border border-border/80 bg-card p-4 sm:p-5 space-y-4">
              {!isLoadingShift && !activeShift && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3.5 text-xs text-destructive space-y-2">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="size-4 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-bold">Shift Kasir Belum Dibuka</p>
                      <p className="leading-relaxed">
                        Pembayaran tunai mewajibkan shift kasir aktif untuk pencatatan laci kas fisik. Buka shift terlebih dahulu untuk memproses transaksi tunai.
                      </p>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button asChild size="sm" variant="destructive" className="h-8 text-xs font-semibold rounded-lg gap-1.5">
                      <Link href="/pos/shift" target="_blank">
                        <Wallet className="size-3.5" />
                        <span>Buka Shift Sekarang</span>
                      </Link>
                    </Button>
                  </div>
                </div>
              )}

              {isCashBlockedByReservation && !isAlreadySettledInDb && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3.5 text-xs text-destructive space-y-1.5">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="size-4 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-bold">
                        Pembayaran Tunai {formatRupiah(payAmount)} Tertahan Reservasi Midtrans
                      </p>
                      <p className="leading-relaxed">
                        Saat ini tersisa {formatRupiah(availableForCashAmount)} yang bebas untuk Tunai
                        karena {formatRupiah(reservedAmount)} masih direservasi oleh transaksi Midtrans.
                        Klik <strong>Cek Status Midtrans</strong> atau{" "}
                        <strong>Batalkan Midtrans &amp; Lepas Reservasi</strong> di panel atas sebelum
                        melanjutkan pembayaran Tunai.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <Label className="text-xs font-semibold text-foreground">
                  Uang Tunai Diterima (Cash Received)
                </Label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-semibold">
                    Rp
                  </span>
                  <Input
                    type="number"
                    min={0}
                    value={cashReceived}
                    onChange={(e) => setCashReceived(e.target.value)}
                    placeholder="0"
                    className="pl-10 h-11 text-base font-mono font-bold rounded-xl"
                  />
                </div>
              </div>

              {/* Quick Cash Buttons */}
              <div className="space-y-2">
                <span className="text-[11px] font-medium text-muted-foreground block">
                  Nominal Cepat
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {quickCashPresets.map((preset) => (
                    <Button
                      key={preset}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setCashReceived(preset.toString())}
                      className={`h-9.5 px-3 text-xs font-mono font-semibold rounded-xl transition-colors ${
                        parsedCashReceived === preset
                          ? "border-primary bg-primary/10 text-primary font-bold shadow-2xs"
                          : "border-border/80 hover:bg-muted/60"
                      }`}
                    >
                      {preset === payAmount ? "Uang Pas" : formatRupiah(preset)}
                    </Button>
                  ))}
                </div>
              </div>

              {/* Kembalian Box */}
              <div
                className={`rounded-xl border px-4 py-3.5 flex items-center justify-between gap-3 ${
                  isCashDeficit
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
                    : "border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  {isCashDeficit ? (
                    <AlertCircle className="size-4.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  ) : (
                    <CheckCircle className="size-4.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  )}
                  <span className="font-semibold text-xs sm:text-sm">
                    {isCashDeficit ? "Uang Tunai Kurang" : "Kembalian"}
                  </span>
                </div>
                <span className="font-mono font-bold text-lg tracking-tight">
                  {isCashDeficit
                    ? `- ${formatRupiah(payAmount - parsedCashReceived)}`
                    : formatRupiah(changeAmount)}
                </span>
              </div>
            </div>
          )}

          {/* TAB 2: MIDTRANS SNAP (SANDBOX) */}
          {method === "midtrans_snap" && (
            <div className="rounded-2xl border border-primary/25 bg-primary/5 p-4 sm:p-5 space-y-4 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold text-sm flex items-center gap-2 text-foreground">
                  <QrCode className="size-4 text-primary shrink-0" />
                  Midtrans Snap Gateway (Sandbox)
                </span>
                <Badge
                  variant="outline"
                  className="text-[11px] px-2.5 py-0.5 border-primary/40 bg-card text-primary font-semibold shrink-0"
                >
                  Sandbox Active
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Membuka popup pembayaran Snap terintegrasi. Pelanggan dapat membayar via simulator QRIS,
                GoPay, ShopeePay, atau Virtual Account bank. Pesanan hanya dianggap lunas setelah
                settlement diverifikasi server Midtrans.
              </p>

              {snapLoadError && (
                <div className="rounded-xl bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive flex items-start gap-2.5">
                  <AlertCircle className="size-4 shrink-0 mt-0.5" />
                  <span>{snapLoadError}</span>
                </div>
              )}

              {/* Status Box & Tombol Cek Status */}
              {activeSnapToken && (activeMidtransTx?.canReopenSnap ?? true) ? (
                <div className="rounded-xl border border-primary/20 bg-card/85 p-4 space-y-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-semibold text-xs text-foreground">
                      <Clock className="size-4 text-amber-500 shrink-0" />
                      <span>Transaksi Snap Aktif</span>
                    </div>
                    <Badge variant="secondary" className="text-[11px] px-2.5 py-0.5 font-mono">
                      {activeMidtransTx?.lifecycleStatus === "pending"
                        ? "Pending di Midtrans"
                        : "Menunggu Pembayaran"}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
                    <Button
                      type="button"
                      size="default"
                      variant="default"
                      disabled={isVerifyingMidtrans || isCancellingMidtrans || isSubmitting}
                      onClick={checkServerPaymentStatus}
                      className="h-10 px-3.5 text-xs font-bold gap-2 bg-primary text-primary-foreground shadow-xs rounded-xl"
                    >
                      <RefreshCw className={`size-3.5 shrink-0 ${isVerifyingMidtrans ? "animate-spin" : ""}`} />
                      <span>{isVerifyingMidtrans ? "Memeriksa..." : "Cek Status"}</span>
                    </Button>

                    <Button
                      type="button"
                      size="default"
                      variant="outline"
                      disabled={isVerifyingMidtrans || isCancellingMidtrans || isSubmitting || midtransWaiting}
                      onClick={() => triggerSnapPopup(activeSnapToken)}
                      className="h-10 px-3.5 text-xs font-semibold gap-2 border-primary/40 bg-card hover:bg-primary/10 rounded-xl"
                    >
                      <ExternalLink className="size-3.5 shrink-0" />
                      <span>Buka Ulang Snap</span>
                    </Button>

                    <Button
                      type="button"
                      size="default"
                      variant="outline"
                      disabled={isCancellingMidtrans || isVerifyingMidtrans || isSubmitting || midtransWaiting}
                      onClick={() => void handleCancelMidtransReservation("cancel_order")}
                      className="h-10 px-3.5 text-xs font-semibold gap-2 border-destructive/40 text-destructive hover:bg-destructive/10 rounded-xl"
                    >
                      <XCircle className="size-3.5 shrink-0" />
                      <span>{isCancellingMidtrans ? "Memproses..." : "Batalkan"}</span>
                    </Button>
                  </div>
                </div>
              ) : activeMidtransTx && !isAlreadySettledInDb ? (
                <div className="rounded-xl border border-amber-500/35 bg-card/90 p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-semibold text-xs text-foreground">
                      <AlertCircle className="size-4 text-amber-600 shrink-0" />
                      <span>
                        {activeMidtransTx.isExpired
                          ? "Token Snap Sebelumnya Sudah Kedaluwarsa"
                          : "Transaksi Midtrans Sebelumnya Tidak Dapat Dibuka Ulang"}
                      </span>
                    </div>
                    <Badge variant="outline" className="text-[11px] px-2.5 py-0.5 font-mono">
                      {activeMidtransTx.isExpired ? "Expired" : activeMidtransTx.lifecycleStatus}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {activeMidtransTx.isExpired
                      ? "Masa berlaku token Snap sebelumnya sudah habis. Jika pelanggan belum membayar, Anda dapat membuat Snap Token baru atau membatalkan reservasi untuk beralih ke Tunai."
                      : "Verifikasi status ke Midtrans atau batalkan reservasi terlebih dahulu agar Anda bisa membuka transaksi Midtrans Snap baru atau membayar Tunai."}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <Button
                      type="button"
                      size="default"
                      variant="default"
                      disabled={isVerifyingMidtrans || isCancellingMidtrans || isSubmitting}
                      onClick={handleRetryExpiredMidtransSnap}
                      className="h-10 px-3 text-xs font-bold gap-2 bg-primary text-primary-foreground shadow-xs rounded-xl"
                    >
                      {isSubmitting ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin shrink-0" />
                          <span>Membuat Token...</span>
                        </>
                      ) : (
                        <>
                          <QrCode className="size-3.5 shrink-0" />
                          <span>Buat Token Baru &amp; Buka Snap</span>
                        </>
                      )}
                    </Button>

                    <Button
                      type="button"
                      size="default"
                      variant="outline"
                      disabled={isVerifyingMidtrans || isCancellingMidtrans || isSubmitting}
                      onClick={checkServerPaymentStatus}
                      className="h-10 px-3 text-xs font-semibold gap-2 border-border/80 hover:bg-muted rounded-xl"
                    >
                      <RefreshCw className={`size-3.5 shrink-0 ${isVerifyingMidtrans ? "animate-spin" : ""}`} />
                      <span>{isVerifyingMidtrans ? "Memeriksa..." : "Cek Status Midtrans"}</span>
                    </Button>

                    <Button
                      type="button"
                      size="default"
                      variant="outline"
                      disabled={isCancellingMidtrans || isVerifyingMidtrans || isSubmitting}
                      onClick={() => void handleCancelMidtransReservation("release_to_cash")}
                      className="h-10 px-3 text-xs font-semibold gap-2 border-amber-600/40 text-amber-800 hover:bg-amber-500/10 rounded-xl"
                    >
                      <Banknote className="size-3.5 shrink-0" />
                      <span>{isCancellingMidtrans ? "Melepas..." : "Lepas ke Tunai"}</span>
                    </Button>
                  </div>
                </div>
              ) : midtransWaiting ? (
                <div className="pt-3 border-t border-primary/20 flex items-center gap-2.5 text-primary font-medium text-xs">
                  <Loader2 className="size-4 animate-spin shrink-0" />
                  <span>Menunggu konfirmasi pembayaran...</span>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground italic pt-1 border-t border-primary/15">
                  Klik tombol di bawah untuk membuka popup pembayaran Midtrans Snap.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Catatan Transaksi */}
        <div className="space-y-2">
          <Label className="text-xs font-semibold text-foreground">
            Catatan Pembayaran (Opsional)
          </Label>
          <Input
            type="text"
            placeholder="Keterangan tambahan transaksi..."
            value={paymentNotes}
            onChange={(e) => setPaymentNotes(e.target.value)}
            className="h-10 text-xs sm:text-sm rounded-xl bg-card"
          />
        </div>
          </>
        )}
      </div>

      {/* Footer */}
      <DialogFooter className="mx-0 mb-0 px-5 sm:px-6 py-4 border-t bg-muted/25 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 shrink-0 rounded-b-2xl">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto">
          <Button
            type="button"
            variant="outline"
            size="default"
            disabled={isSubmitting || isCancellingMidtrans || midtransWaiting}
            onClick={onClose}
            className="h-11 px-5 text-xs sm:text-sm font-semibold rounded-xl border-border/80 bg-card hover:bg-muted w-full sm:w-auto"
          >
            Tutup
          </Button>
          {!isAlreadySettledInDb &&
            !isCancelledOrRefunded &&
            canCancelCurrentOrder &&
            onOpenCancelOrder && (
              <Button
                type="button"
                variant="outline"
                size="default"
                disabled={
                  isSubmitting ||
                  isVerifyingMidtrans ||
                  isCancellingMidtrans ||
                  midtransWaiting
                }
                onClick={() => onOpenCancelOrder(order)}
                className="h-11 px-4 text-xs sm:text-sm font-semibold rounded-xl border-destructive/30 text-destructive hover:bg-destructive/10 gap-2 w-full sm:w-auto"
              >
                <Ban className="size-4 shrink-0" />
                <span>Batalkan Pesanan</span>
              </Button>
            )}
        </div>

        {isCancelledOrRefunded || (!isAlreadySettledInDb && !isOrderPayable) ? null : isAlreadySettledInDb ? (
          <Button
            type="button"
            size="default"
            onClick={() => {
              if (isAlreadySettledInDb) {
                onPaymentSuccess(order.id, true);
              }
            }}
            className="h-11 px-6 text-xs sm:text-sm font-bold bg-emerald-600 text-white shadow-sm rounded-xl gap-2 hover:bg-emerald-700 w-full sm:w-auto"
          >
            <Receipt className="size-4 shrink-0" />
            <span>Lihat &amp; Cetak Struk</span>
          </Button>
        ) : method === "midtrans_snap" ? (
          activeSnapToken && (activeMidtransTx?.canReopenSnap ?? true) ? (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
              <Button
                type="button"
                size="default"
                variant="outline"
                disabled={isSubmitting || isVerifyingMidtrans || isCancellingMidtrans || midtransWaiting}
                onClick={() => triggerSnapPopup(activeSnapToken)}
                className="h-11 px-4 text-xs sm:text-sm font-semibold rounded-xl border-primary/40 bg-card hover:bg-primary/10 gap-2"
              >
                <ExternalLink className="size-4 shrink-0" />
                <span>Buka Ulang Snap</span>
              </Button>
              <Button
                type="button"
                size="default"
                disabled={isSubmitting || isVerifyingMidtrans || isCancellingMidtrans}
                onClick={checkServerPaymentStatus}
                className="h-11 px-5 sm:px-6 text-xs sm:text-sm font-bold bg-primary text-primary-foreground shadow-sm rounded-xl gap-2 hover:bg-primary/90"
              >
                <RefreshCw className={`size-4 shrink-0 ${isVerifyingMidtrans ? "animate-spin" : ""}`} />
                <span>{isVerifyingMidtrans ? "Memeriksa..." : "Cek Status Pembayaran"}</span>
              </Button>
            </div>
          ) : activeMidtransTx ? (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
              <Button
                type="button"
                size="default"
                variant="outline"
                disabled={isSubmitting || isVerifyingMidtrans || isCancellingMidtrans || midtransWaiting}
                onClick={() => void handleCancelMidtransReservation("release_to_cash")}
                className="h-11 px-4 text-xs sm:text-sm font-semibold rounded-xl gap-2 border-amber-600/40 text-amber-800 hover:bg-amber-500/10"
              >
                <Banknote className="size-4 shrink-0" />
                <span>{isCancellingMidtrans ? "Melepas..." : "Lepas ke Tunai"}</span>
              </Button>
              <Button
                type="button"
                size="default"
                variant="outline"
                disabled={isSubmitting || isVerifyingMidtrans || isCancellingMidtrans}
                onClick={checkServerPaymentStatus}
                className="h-11 px-4 text-xs sm:text-sm font-semibold rounded-xl gap-2 border-border/80 hover:bg-muted"
              >
                <RefreshCw className={`size-4 shrink-0 ${isVerifyingMidtrans ? "animate-spin" : ""}`} />
                <span>{isVerifyingMidtrans ? "Memeriksa..." : "Cek Status Midtrans"}</span>
              </Button>
              <Button
                type="button"
                size="default"
                disabled={isSubmitting || isVerifyingMidtrans || isCancellingMidtrans || midtransWaiting}
                onClick={handleRetryExpiredMidtransSnap}
                className="h-11 px-5 sm:px-6 text-xs sm:text-sm font-bold bg-primary text-primary-foreground shadow-sm rounded-xl gap-2 hover:bg-primary/90"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin shrink-0" />
                    <span>Membuat Token...</span>
                  </>
                ) : (
                  <>
                    <QrCode className="size-4 shrink-0" />
                    <span>Buka Midtrans Snap Baru</span>
                  </>
                )}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="default"
              disabled={
                isSubmitting ||
                isVerifyingMidtrans ||
                isCancellingMidtrans ||
                midtransWaiting ||
                payAmount <= 0
              }
              onClick={handleOpenMidtransSnap}
              className="h-11 px-6 text-xs sm:text-sm font-bold bg-primary text-primary-foreground shadow-sm rounded-xl gap-2 hover:bg-primary/90 w-full sm:w-auto"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin shrink-0" />
                  <span>Membuka Snap...</span>
                </>
              ) : midtransWaiting ? (
                <>
                  <Loader2 className="size-4 animate-spin shrink-0" />
                  <span>Snap Sedang Aktif...</span>
                </>
              ) : (
                <>
                  <ExternalLink className="size-4 shrink-0" />
                  <span>Buka Midtrans Snap ({formatRupiah(payAmount)})</span>
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
              isVerifyingMidtrans ||
              isCancellingMidtrans ||
              midtransWaiting ||
              payAmount <= 0 ||
              isCashDeficit ||
              isCashBlockedByReservation ||
              (method === "cash" && !activeShift)
            }
            onClick={handleProcessManualPayment}
            className="h-11 px-6 text-xs sm:text-sm font-bold bg-primary text-primary-foreground shadow-sm rounded-xl gap-2 hover:bg-primary/90 w-full sm:w-auto"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="size-4 animate-spin shrink-0" />
                <span>Memproses Pembayaran...</span>
              </>
            ) : method === "cash" && !activeShift ? (
              <>
                <Wallet className="size-4 shrink-0" />
                <span>Buka Shift Dahulu</span>
              </>
            ) : (
              <>
                <CheckCircle className="size-4 shrink-0" />
                <span>Bayar Sekarang ({formatRupiah(payAmount)})</span>
              </>
            )}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
