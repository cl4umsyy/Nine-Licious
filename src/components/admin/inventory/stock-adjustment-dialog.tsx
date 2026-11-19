"use client";

import { useMemo, useState, useTransition } from "react";
import {
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  ClipboardCheck,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Textarea } from "@/components/ui/textarea";
import { adjustIngredientStockAction } from "@/lib/inventory/actions";
import {
  calculateStockOpnameDelta,
  formatStockQuantity,
  roundQuantity3,
} from "@/lib/inventory/calculations";
import {
  STOCK_MOVEMENT_DESCRIPTIONS,
  type ManualStockMovementType,
} from "@/lib/inventory/constants";
import type { Ingredient } from "@/lib/inventory/types";
import { cn } from "@/lib/utils";

type StockAdjustmentDialogProps = {
  ingredient: Ingredient | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdjusted: () => void;
};

const MOVEMENT_OPTIONS: Array<{
  type: ManualStockMovementType;
  label: string;
  shortLabel: string;
  icon: typeof ArrowUpCircle;
}> = [
  {
    type: "manual_in",
    label: "Stok Masuk",
    shortLabel: "Masuk (+)",
    icon: ArrowUpCircle,
  },
  {
    type: "manual_out",
    label: "Stok Keluar / Waste",
    shortLabel: "Keluar (-)",
    icon: ArrowDownCircle,
  },
  {
    type: "stock_opname",
    label: "Stock Opname",
    shortLabel: "Opname",
    icon: ClipboardCheck,
  },
];

export function StockAdjustmentDialog({
  ingredient,
  open,
  onOpenChange,
  onAdjusted,
}: StockAdjustmentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open && ingredient ? (
          <StockAdjustmentDialogForm
            key={ingredient.id}
            ingredient={ingredient}
            onClose={() => onOpenChange(false)}
            onAdjusted={onAdjusted}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function StockAdjustmentDialogForm({
  ingredient,
  onClose,
  onAdjusted,
}: {
  ingredient: Ingredient;
  onClose: () => void;
  onAdjusted: () => void;
}) {
  const [movementType, setMovementType] =
    useState<ManualStockMovementType>("manual_in");
  const [quantityInput, setQuantityInput] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() =>
    crypto.randomUUID(),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  const parsedQty = useMemo(() => {
    const trimmed = quantityInput.trim().replace(",", ".");
    if (!trimmed) return null;
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return null;
    try {
      return roundQuantity3(num);
    } catch {
      return null;
    }
  }, [quantityInput]);

  const currentStock = ingredient.current_stock;
  const reservedStock = ingredient.reserved_stock ?? 0;
  const availableStock =
    ingredient.available_stock ??
    Math.max(0, currentStock - reservedStock);

  const preview = useMemo(() => {
    const before = currentStock;
    if (parsedQty === null) {
      return {
        before,
        delta: null as number | null,
        after: null as number | null,
        error: null as string | null,
      };
    }

    if (movementType === "manual_in") {
      if (parsedQty <= 0) {
        return {
          before,
          delta: null,
          after: null,
          error: "Jumlah stok masuk harus lebih besar dari 0.",
        };
      }
      const after = roundQuantity3(before + parsedQty);
      return { before, delta: parsedQty, after, error: null };
    }

    if (movementType === "manual_out") {
      if (parsedQty <= 0) {
        return {
          before,
          delta: null,
          after: null,
          error: "Jumlah stok keluar harus lebih besar dari 0.",
        };
      }
      if (parsedQty > availableStock) {
        return {
          before,
          delta: null,
          after: null,
          error: `Pengurangan stok (${formatStockQuantity(parsedQty, ingredient.unit)}) melebihi stok yang tersedia (${formatStockQuantity(availableStock, ingredient.unit)}). ${reservedStock > 0 ? `Terdapat ${formatStockQuantity(reservedStock, ingredient.unit)} yang sedang direservasi pesanan aktif.` : ""}`,
        };
      }
      const delta = roundQuantity3(-parsedQty);
      const after = roundQuantity3(before + delta);
      if (after < 0) {
        return {
          before,
          delta,
          after,
          error:
            "Pengurangan stok manual melebihi stok saat ini. Gunakan Stock Opname untuk menyetel stok aktual.",
        };
      }
      return { before, delta, after, error: null };
    }

    // stock_opname
    if (parsedQty < 0) {
      return {
        before,
        delta: null,
        after: null,
        error: "Stok aktual pada Stock Opname tidak boleh negatif.",
      };
    }
    if (parsedQty < reservedStock) {
      return {
        before,
        delta: null,
        after: null,
        error: `Stok opname (${formatStockQuantity(parsedQty, ingredient.unit)}) tidak boleh lebih rendah dari stok yang sedang direservasi pesanan aktif (${formatStockQuantity(reservedStock, ingredient.unit)}).`,
      };
    }
    const opname = calculateStockOpnameDelta(before, parsedQty);
    if (!opname.has_change) {
      return {
        before,
        delta: 0,
        after: opname.stock_after,
        error: "Stok aktual sama dengan stok saat ini. Tidak ada perubahan.",
      };
    }
    return {
      before: opname.stock_before,
      delta: opname.delta,
      after: opname.stock_after,
      error: null,
    };
  }, [currentStock, reservedStock, availableStock, ingredient.unit, movementType, parsedQty]);

  const canSubmit =
    !isPending &&
    ingredient.is_active &&
    parsedQty !== null &&
    preview.after !== null &&
    !preview.error &&
    reason.trim().length >= 3;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || parsedQty === null) return;

    setFormError(null);
    setFieldErrors({});

    startTransition(async () => {
      const result = await adjustIngredientStockAction({
        ingredientId: ingredient.id,
        movementType,
        quantity: parsedQty,
        reason: reason.trim(),
        idempotencyKey,
      });

      if (!result.ok) {
        setFormError(result.message);
        if (result.fieldErrors) {
          setFieldErrors(result.fieldErrors);
        }
        toast.error(result.message);
        return;
      }

      toast.success(result.message);
      setIdempotencyKey(crypto.randomUUID());
      onAdjusted();
      onClose();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>Penyesuaian Stok Bahan Baku</DialogTitle>
        <DialogDescription>
          {ingredient.name} ({ingredient.unit}) · Perubahan diproses atomik
          melalui RPC terverifikasi dan dicatat di buku besar mutasi serta audit
          log.
        </DialogDescription>
      </DialogHeader>

      {!ingredient.is_active ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>
            Bahan baku ini sedang diarsipkan dan tidak dapat disesuaikan
            stoknya. Aktifkan kembali terlebih dahulu jika ingin menyesuaikan
            stok.
          </AlertDescription>
        </Alert>
      ) : null}

      {formError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      {/* Ringkasan Saldo Stok Saat Ini */}
      <div className="grid grid-cols-3 gap-2 rounded-xl border border-border/80 bg-muted/40 p-3 text-center">
        <div>
          <span className="block text-[11px] font-medium text-muted-foreground">
            Stok Fisik
          </span>
          <span className="mt-0.5 block font-mono text-sm font-bold text-foreground">
            {formatStockQuantity(currentStock, ingredient.unit)}
          </span>
        </div>
        <div>
          <span className="block text-[11px] font-medium text-muted-foreground">
            Direservasi
          </span>
          <span className="mt-0.5 block font-mono text-sm font-bold text-sky-700">
            {formatStockQuantity(reservedStock, ingredient.unit)}
          </span>
        </div>
        <div>
          <span className="block text-[11px] font-medium text-muted-foreground">
            Stok Tersedia
          </span>
          <span
            className={cn(
              "mt-0.5 block font-mono text-sm font-bold",
              availableStock <= 0 ? "text-destructive" : "text-emerald-700",
            )}
          >
            {formatStockQuantity(availableStock, ingredient.unit)}
          </span>
        </div>
      </div>

      {/* Pilih Jenis Penyesuaian */}
      <div className="space-y-2">
        <Label>Jenis Penyesuaian</Label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {MOVEMENT_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = movementType === opt.type;
            return (
              <button
                key={opt.type}
                type="button"
                disabled={isPending}
                onClick={() => {
                  setMovementType(opt.type);
                  setFormError(null);
                  setIdempotencyKey(crypto.randomUUID());
                }}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-semibold transition-colors cursor-pointer",
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {STOCK_MOVEMENT_DESCRIPTIONS[movementType]}
        </p>
      </div>

      {/* Input Jumlah */}
      <div className="space-y-1.5">
        <Label htmlFor="adjust-quantity">
          {movementType === "stock_opname"
            ? `Stok Fisik Aktual (${ingredient.unit})`
            : movementType === "manual_in"
              ? `Jumlah Masuk (${ingredient.unit})`
              : `Jumlah Keluar / Waste (${ingredient.unit})`}
        </Label>
        <Input
          id="adjust-quantity"
          type="number"
          step="0.001"
          min={movementType === "stock_opname" ? "0" : "0.001"}
          value={quantityInput}
          onChange={(e) => {
            setQuantityInput(e.target.value);
            setFormError(null);
          }}
          placeholder={
            movementType === "stock_opname"
              ? "Contoh: 2.5"
              : "Contoh: 5 atau 0.25"
          }
          disabled={isPending || !ingredient.is_active}
          required
        />
        {fieldErrors.quantity ? (
          <p className="text-xs text-destructive">{fieldErrors.quantity}</p>
        ) : null}
      </div>

      {/* Pratinjau Stok Sebelum -> Perubahan -> Sesudah */}
      <div className="rounded-xl border border-border bg-muted/30 p-3.5 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-muted-foreground">
            Pratinjau Perubahan Stok
          </span>
          {preview.after !== null && preview.after <= ingredient.min_stock ? (
            <Badge
              variant={preview.after <= 0 ? "destructive" : "outline"}
              className="text-[10px]"
            >
              {preview.after <= 0 ? "Habis" : "Stok Rendah"}
            </Badge>
          ) : null}
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg border border-border/70 bg-card px-2 py-2">
            <span className="block text-[11px] text-muted-foreground">
              Stok Sebelum
            </span>
            <span
              className={cn(
                "mt-0.5 block font-mono text-xs font-bold",
                ingredient.current_stock < 0
                  ? "text-destructive"
                  : "text-foreground",
              )}
            >
              {formatStockQuantity(preview.before, ingredient.unit)}
            </span>
          </div>
          <div className="rounded-lg border border-border/70 bg-card px-2 py-2">
            <span className="block text-[11px] text-muted-foreground">
              Perubahan
            </span>
            <span
              className={cn(
                "mt-0.5 block font-mono text-xs font-bold",
                preview.delta === null
                  ? "text-muted-foreground"
                  : preview.delta > 0
                    ? "text-emerald-700"
                    : "text-destructive",
              )}
            >
              {preview.delta === null
                ? "—"
                : `${preview.delta > 0 ? "+" : ""}${formatStockQuantity(
                    preview.delta,
                    ingredient.unit,
                  )}`}
            </span>
          </div>
          <div className="rounded-lg border border-border/70 bg-card px-2 py-2">
            <span className="block text-[11px] text-muted-foreground">
              Stok Sesudah
            </span>
            <span
              className={cn(
                "mt-0.5 block font-mono text-xs font-bold",
                preview.after === null
                  ? "text-muted-foreground"
                  : preview.after <= 0
                    ? "text-destructive"
                    : "text-primary",
              )}
            >
              {preview.after === null
                ? "—"
                : formatStockQuantity(preview.after, ingredient.unit)}
            </span>
          </div>
        </div>
        {preview.error ? (
          <p className="text-xs font-medium text-destructive">{preview.error}</p>
        ) : null}
      </div>

      {/* Alasan Wajib */}
      <div className="space-y-1.5">
        <Label htmlFor="adjust-reason">
          Alasan Penyesuaian <span className="text-destructive">*</span>
        </Label>
        <Textarea
          id="adjust-reason"
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={
            movementType === "manual_in"
              ? "Contoh: Belanja harian supplier / pengembalian bahan layak pakai pasca refund"
              : movementType === "manual_out"
                ? "Contoh: Bahan kedaluwarsa, rusak, atau tumpah di dapur"
                : "Contoh: Hasil stock opname fisik akhir shift"
          }
          disabled={isPending || !ingredient.is_active}
          required
        />
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Wajib minimal 3 karakter untuk jejak audit.</span>
          <span>{reason.trim().length}/500</span>
        </div>
        {fieldErrors.reason ? (
          <p className="text-xs text-destructive">{fieldErrors.reason}</p>
        ) : null}
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={onClose}
        >
          Batal
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {isPending ? (
            <>
              <Loader2 className="animate-spin" />
              Menyimpan...
            </>
          ) : (
            "Simpan Penyesuaian Stok"
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}
