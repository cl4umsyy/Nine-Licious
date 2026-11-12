"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Ban, LoaderCircle } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { cancelPosOrderAction } from "@/lib/orders/actions";
import { DEFAULT_CANCEL_REASONS } from "@/lib/orders/constants";
import type { OrderWithDetails } from "@/lib/orders/types";

export type OrderCancelModalProps = {
  order: OrderWithDetails | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
};

export function OrderCancelModal({
  order,
  isOpen,
  onClose,
  onSuccess,
}: OrderCancelModalProps) {
  const [selectedReason, setSelectedReason] = useState<string>(
    DEFAULT_CANCEL_REASONS[0],
  );
  const [customReason, setCustomReason] = useState("");
  const [isPending, startTransition] = useTransition();

  if (!order) return null;

  const finalReason =
    selectedReason === "Alasan lainnya"
      ? customReason.trim()
      : selectedReason;

  const isValid = finalReason.length >= 3;

  const handleCancelOrder = () => {
    if (!isValid || isPending) return;

    startTransition(async () => {
      const result = await cancelPosOrderAction(order.id, finalReason);

      if (result.ok) {
        toast.success(
          result.message || `Pesanan ${order.order_number} berhasil dibatalkan.`,
        );
        onSuccess();
        onClose();
      } else {
        toast.error(result.message || "Gagal membatalkan pesanan.");
      }
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader className="space-y-1">
          <div className="flex items-center gap-2 text-destructive">
            <Ban className="size-5" />
            <DialogTitle className="text-base font-bold">
              Batalkan Pesanan {order.order_number}
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs">
            Pesanan yang dibatalkan tidak dapat diaktifkan kembali. Seluruh data pembatalan akan dicatat di audit log.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 text-xs">
          <Alert variant="destructive" className="py-2 px-3">
            <AlertTriangle className="size-4" />
            <AlertDescription className="text-xs">
              Tindakan ini permanen. Jika meja menjadi kosong, status meja akan dikembalikan menjadi <strong>Kosong</strong>.
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Label className="text-xs font-semibold">
              Pilih Alasan Pembatalan (Wajib):
            </Label>
            <RadioGroup
              value={selectedReason}
              onValueChange={setSelectedReason}
              className="space-y-1.5"
            >
              {DEFAULT_CANCEL_REASONS.map((reason) => (
                <Label
                  key={reason}
                  htmlFor={`reason-${reason}`}
                  className="flex items-center gap-2 p-2 rounded-lg border bg-card hover:bg-muted/40 cursor-pointer font-normal text-xs"
                >
                  <RadioGroupItem value={reason} id={`reason-${reason}`} />
                  <span>{reason}</span>
                </Label>
              ))}
            </RadioGroup>
          </div>

          {selectedReason === "Alasan lainnya" && (
            <div className="space-y-1.5">
              <Label htmlFor="custom-reason" className="text-xs font-semibold">
                Keterangan Tambahan:
              </Label>
              <Textarea
                id="custom-reason"
                placeholder="Tuliskan alasan pembatalan secara jelas..."
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                className="h-20 text-xs resize-none"
                maxLength={300}
              />
              <div className="text-right text-[10px] text-muted-foreground">
                {customReason.length}/300
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex-row items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={isPending}
            className="text-xs"
          >
            Kembali
          </Button>

          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={!isValid || isPending}
            onClick={handleCancelOrder}
            className="text-xs font-semibold"
          >
            {isPending ? (
              <>
                <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                Membatalkan...
              </>
            ) : (
              "Ya, Batalkan Pesanan"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

