"use client";

import { useId, useState, useTransition } from "react";
import { Clock, DollarSign, Loader2, RotateCcw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { confirmMidtransRefundAction, processOrderRefundAction } from "@/lib/payments/actions";
import type { Payment, RefundMethod, RefundType } from "@/types/database";

export type RefundOrderData = {
  id: string;
  order_number: string;
  order_type: string;
  status: string;
  payment_status: string;
  grand_total: number;
  paid_total: number;
  refunded_total?: number;
  payments?: Payment[];
};

export type RefundModalProps = {
  order: RefundOrderData | null;
  userRole?: string | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
};

export function RefundModal({
  order,
  userRole,
  isOpen,
  onClose,
  onSuccess,
}: RefundModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg p-0 overflow-hidden">
        {isOpen && order ? (
          <RefundModalContent
            order={order}
            userRole={userRole}
            onClose={onClose}
            onSuccess={onSuccess}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RefundModalContent({
  order,
  userRole,
  onClose,
  onSuccess,
}: {
  order: RefundOrderData;
  userRole?: string | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const componentId = useId();
  const isAdmin = userRole === "admin";
  const paidTotal = order.paid_total ?? 0;
  const refundedTotal = order.refunded_total ?? 0;
  const refundableBalance = Math.max(0, paidTotal - refundedTotal);

  const [refundType, setRefundType] = useState<RefundType>("full");
  const [refundMethod, setRefundMethod] = useState<RefundMethod>("cash");
  const [selectedPaymentId, setSelectedPaymentId] = useState<string>("all");
  const [amount, setAmount] = useState<number>(refundableBalance);
  const [reason, setReason] = useState<string>("");
  const [idempotencyKey] = useState<string>(
    () => `ref_${order.id.slice(0, 8)}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  );
  const [pendingRefundId, setPendingRefundId] = useState<string | null>(null);
  const [gatewayRefundId, setGatewayRefundId] = useState<string>("");
  const [isPending, startTransition] = useTransition();

  // Perhitungan sisa balance jika pembayaran spesifik dipilih
  const selectedPayment = order.payments?.find((p) => p.id === selectedPaymentId);
  const maxRefundAllowed = selectedPayment
    ? Math.min(selectedPayment.amount, refundableBalance)
    : refundableBalance;

  // Sesuaikan nominal saat tipe refund atau payment berubah
  const handleTypeChange = (val: RefundType) => {
    setRefundType(val);
    if (val === "full") {
      setAmount(maxRefundAllowed);
    }
  };

  const handlePaymentSelectChange = (val: string) => {
    setSelectedPaymentId(val);
    if (val !== "all") {
      const p = order.payments?.find((pay) => pay.id === val);
      if (p) {
        if (p.payment_method === "midtrans") setRefundMethod("midtrans");
        else if (p.payment_method === "cash") setRefundMethod("cash");
        else setRefundMethod("transfer");
      }
    }
  };

  const handleProcessRefund = () => {
    if (!isAdmin) {
      toast.error("Hanya admin yang berwenang memproses pengembalian dana.");
      return;
    }

    if (!reason || reason.trim().length < 3) {
      toast.error("Alasan refund wajib diisi minimal 3 karakter.");
      return;
    }

    if (amount <= 0 || amount > maxRefundAllowed) {
      toast.error(`Nominal refund tidak valid (Maks: Rp ${maxRefundAllowed.toLocaleString("id-ID")})`);
      return;
    }

    if (refundType === "partial" && amount >= refundableBalance) {
      toast.error("Nominal mencakup seluruh sisa dana; gunakan tipe refund full.");
      return;
    }

    startTransition(async () => {
      const res = await processOrderRefundAction({
        order_id: order.id,
        payment_id: selectedPaymentId === "all" ? undefined : selectedPaymentId,
        amount,
        refund_type: refundType,
        refund_method: refundMethod,
        reason: reason.trim(),
        idempotency_key: idempotencyKey,
      });

      if (!res.ok) {
        toast.error(res.message);
        return;
      }

      if (res.data?.status === "pending") {
        setPendingRefundId(res.data.refund_id);
        toast.info(res.message);
      } else {
        toast.success(res.message);
        onSuccess();
        onClose();
      }
    });
  };

  const handleConfirmGateway = () => {
    if (!pendingRefundId) return;
    if (!gatewayRefundId || gatewayRefundId.trim().length < 3) {
      toast.error("Harap masukkan Gateway Refund ID dari Midtrans.");
      return;
    }

    startTransition(async () => {
      const res = await confirmMidtransRefundAction({
        refundId: pendingRefundId,
        gatewayRefundId: gatewayRefundId.trim(),
      });
      if (res.ok) {
        toast.success(res.message);
        onSuccess();
        onClose();
      } else {
        toast.error(res.message);
      }
    });
  };

  return (
    <>
      <DialogHeader className="p-4 pb-2 border-b bg-muted/20">
        <DialogTitle className="flex items-center gap-2 font-display text-base">
          <RotateCcw className="size-4 text-destructive" />
          Proses Pengembalian Dana (Refund)
        </DialogTitle>
        <DialogDescription className="text-xs">
          Otorisasi pengembalian dana pesanan #{order.order_number}
        </DialogDescription>
      </DialogHeader>

      <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
        {!isAdmin ? (
          <Alert variant="destructive">
            <ShieldAlert className="size-4" />
            <AlertDescription className="text-xs">
              Akses Ditolak: Anda login sebagai kasir. Sesuai kebijakan keamanan,
              pengembalian dana hanya dapat diajukan dan disetujui oleh pengguna dengan peran <strong>Admin</strong>.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {/* Status Pesanan & Keuangan */}
            <div className="rounded-lg border bg-muted/40 p-3 space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total Tagihan:</span>
                <span className="font-semibold">Rp {order.grand_total.toLocaleString("id-ID")}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total Telah Dibayar:</span>
                <span className="font-semibold text-emerald-600">Rp {paidTotal.toLocaleString("id-ID")}</span>
              </div>
              {refundedTotal > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Telah Direfund Sebelumnya:</span>
                  <span className="font-semibold text-destructive">-Rp {refundedTotal.toLocaleString("id-ID")}</span>
                </div>
              )}
              <div className="flex justify-between pt-1 border-t font-bold">
                <span>Maksimal Dapat Direfund:</span>
                <span className="text-primary">Rp {refundableBalance.toLocaleString("id-ID")}</span>
              </div>
            </div>

            {/* Jika dalam mode konfirmasi gateway Midtrans */}
            {pendingRefundId ? (
              <div className="space-y-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                <div className="flex items-center gap-2 text-amber-600 font-semibold text-xs">
                  <Clock className="size-4" />
                  Konfirmasi Server-Side Midtrans Gateway
                </div>
                <p className="text-xs text-muted-foreground">
                  Refund Midtrans berhasil dicatat sebagai <strong>PENDING</strong>. Untuk menyelesaikan pengembalian dana,
                  masukkan Gateway Refund ID resmi yang diterbitkan oleh Midtrans.
                </p>
                <div className="space-y-1">
                  <Label htmlFor={`${componentId}-gw-id`} className="text-xs">
                    Gateway Refund ID
                  </Label>
                  <Input
                    id={`${componentId}-gw-id`}
                    placeholder="Contoh: ref_midtrans_992837102"
                    value={gatewayRefundId}
                    onChange={(e) => setGatewayRefundId(e.target.value)}
                    className="h-8 text-xs font-mono"
                  />
                </div>
              </div>
            ) : (
              <>
                {/* Form Input Refund */}
                {/* Pilihan Pembayaran Spesifik (Untuk Split Bill) */}
                {order.payments && order.payments.length > 1 && (
                  <div className="space-y-1.5">
                    <Label htmlFor={`${componentId}-payment-select`} className="text-xs">
                      Target Pembayaran (Split Bill)
                    </Label>
                    <Select value={selectedPaymentId} onValueChange={handlePaymentSelectChange}>
                      <SelectTrigger id={`${componentId}-payment-select`} className="h-8 text-xs">
                        <SelectValue placeholder="Pilih target pembayaran" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Semua Pembayaran Tersedia</SelectItem>
                        {order.payments.map((p) => (
                          <SelectItem
                            key={p.id}
                            value={p.id}
                            disabled={p.payment_status === "refunded"}
                          >
                            {p.payment_method.toUpperCase()} - Rp {p.amount.toLocaleString("id-ID")}
                            {p.payment_status === "refunded" ? " (Sudah Direfund)" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Tipe Refund: Penuh vs Sebagian */}
                <div className="space-y-1.5">
                  <Label className="text-xs">Tipe Pengembalian Dana</Label>
                  <RadioGroup
                    value={refundType}
                    onValueChange={(v) => handleTypeChange(v as RefundType)}
                    className="flex gap-4"
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="full" id={`${componentId}-full`} />
                      <Label htmlFor={`${componentId}-full`} className="text-xs cursor-pointer">
                        Penuh (Full Refund)
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="partial" id={`${componentId}-partial`} />
                      <Label htmlFor={`${componentId}-partial`} className="text-xs cursor-pointer">
                        Sebagian (Partial)
                      </Label>
                    </div>
                  </RadioGroup>
                </div>

                {/* Metode Refund */}
                <div className="space-y-1.5">
                  <Label htmlFor={`${componentId}-refund-method`} className="text-xs">
                    Metode Pengembalian
                  </Label>
                  <Select value={refundMethod} onValueChange={(v) => setRefundMethod(v as RefundMethod)}>
                    <SelectTrigger id={`${componentId}-refund-method`} className="h-8 text-xs">
                      <SelectValue placeholder="Pilih metode refund" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">Tunai (Cash Drawer)</SelectItem>
                      <SelectItem value="qris_manual">QRIS Manual</SelectItem>
                      <SelectItem value="transfer">Transfer Bank Manual</SelectItem>
                      <SelectItem value="midtrans">Midtrans Gateway</SelectItem>
                    </SelectContent>
                  </Select>
                  {refundMethod === "midtrans" && (
                    <p className="text-[11px] text-amber-600">
                      * Refund Midtrans akan dicatat PENDING hingga diverifikasi secara server-side melalui gateway.
                    </p>
                  )}
                </div>

                {/* Nominal Refund */}
                <div className="space-y-1.5">
                  <Label htmlFor={`${componentId}-refund-amount`} className="text-xs">
                    Nominal Refund (Rp)
                  </Label>
                  <div className="relative">
                    <DollarSign className="absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
                    <Input
                      id={`${componentId}-refund-amount`}
                      type="number"
                      min={1}
                      max={maxRefundAllowed}
                      value={amount || ""}
                      onChange={(e) => setAmount(Number(e.target.value))}
                      disabled={refundType === "full"}
                      className="pl-8 h-8 text-xs font-mono"
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Maksimum nominal yang dapat direfund untuk pilihan ini: Rp {maxRefundAllowed.toLocaleString("id-ID")}
                  </p>
                </div>

                {/* Alasan Refund */}
                <div className="space-y-1.5">
                  <Label htmlFor={`${componentId}-refund-reason`} className="text-xs">
                    Alasan Pengembalian (Wajib, min 3 karakter)
                  </Label>
                  <Textarea
                    id={`${componentId}-refund-reason`}
                    rows={2}
                    placeholder="Contoh: Pesanan salah input / keluhan pelanggan / pembatalan dine-in"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="text-xs resize-none"
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>

      <DialogFooter className="p-3 border-t bg-muted/20 gap-2 sm:gap-0">
        <Button variant="outline" size="sm" onClick={onClose} disabled={isPending}>
          Batal
        </Button>
        {isAdmin && (
          pendingRefundId ? (
            <Button
              variant="default"
              size="sm"
              onClick={handleConfirmGateway}
              disabled={isPending || !gatewayRefundId.trim()}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Konfirmasi Gateway Selesai
            </Button>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleProcessRefund}
              disabled={isPending || refundableBalance <= 0}
            >
              {isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Proses Refund
            </Button>
          )
        )}
      </DialogFooter>
    </>
  );
}
