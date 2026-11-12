"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { Minus, Plus, Utensils } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { formatPriceDelta, formatRupiah } from "@/lib/menu/format";
import type {
  CartItem,
  CartItemModifier,
  ProductWithModifiers,
} from "@/lib/orders/types";

export type ModifierModalProps = {
  product: ProductWithModifiers | null;
  isOpen: boolean;
  onClose: () => void;
  onAddToCart: (item: CartItem) => void;
};

export function ModifierModal({
  product,
  isOpen,
  onClose,
  onAddToCart,
}: ModifierModalProps) {
  if (!product) return null;

  return (
    <ModifierModalContent
      key={product.id}
      product={product}
      isOpen={isOpen}
      onClose={onClose}
      onAddToCart={onAddToCart}
    />
  );
}

function ModifierModalContent({
  product,
  isOpen,
  onClose,
  onAddToCart,
}: {
  product: ProductWithModifiers;
  isOpen: boolean;
  onClose: () => void;
  onAddToCart: (item: CartItem) => void;
}) {
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  // Selected options: map group id -> set of option ids
  const [selectedOptions, setSelectedOptions] = useState<
    Record<string, string[]>
  >(() => {
    const initial: Record<string, string[]> = {};
    for (const group of product.modifierGroups) {
      if (group.is_required && group.selection_type === "single" && group.options.length > 0) {
        initial[group.id] = [group.options[0].id];
      } else {
        initial[group.id] = [];
      }
    }
    return initial;
  });

  const activeGroups = useMemo(
    () => product.modifierGroups.filter((g) => g.is_active),
    [product],
  );

  // Toggle multiple choice option
  const handleToggleMultiple = (groupId: string, optionId: string) => {
    setSelectedOptions((prev) => {
      const current = prev[groupId] ?? [];
      const group = activeGroups.find((g) => g.id === groupId);
      const isSelected = current.includes(optionId);

      if (isSelected) {
        return {
          ...prev,
          [groupId]: current.filter((id) => id !== optionId),
        };
      }

      // Check max_select constraint
      if (group && current.length >= group.max_select) {
        return prev;
      }

      return {
        ...prev,
        [groupId]: [...current, optionId],
      };
    });
  };

  // Select single choice option
  const handleSelectSingle = (groupId: string, optionId: string) => {
    setSelectedOptions((prev) => ({
      ...prev,
      [groupId]: [optionId],
    }));
  };

  // Validation: are all required groups satisfied?
  const validationErrors = useMemo(() => {
    const errors: string[] = [];

    for (const group of activeGroups) {
      const selected = selectedOptions[group.id] ?? [];

      if (group.is_required && selected.length === 0) {
        errors.push(`Pilihan pada "${group.name}" wajib dipilih.`);
      }

      if (selected.length < group.min_select) {
        errors.push(
          `"${group.name}" minimal memilih ${group.min_select} opsi.`,
        );
      }

      if (selected.length > group.max_select) {
        errors.push(
          `"${group.name}" maksimal memilih ${group.max_select} opsi.`,
        );
      }
    }

    return errors;
  }, [activeGroups, selectedOptions]);

  const isValid = validationErrors.length === 0;

  // Calculate modifier total price delta
  const modifierPriceDelta = useMemo(() => {
    let total = 0;
    for (const group of activeGroups) {
      const selectedIds = selectedOptions[group.id] ?? [];
      for (const optId of selectedIds) {
        const option = group.options.find((o) => o.id === optId);
        if (option) {
          total += option.price_delta;
        }
      }
    }
    return total;
  }, [activeGroups, selectedOptions]);

  const unitTotal = product.price + modifierPriceDelta;
  const lineTotal = unitTotal * quantity;

  const handleConfirm = () => {
    if (!isValid) return;

    const chosenModifiers: CartItemModifier[] = [];

    for (const group of activeGroups) {
      const selectedIds = selectedOptions[group.id] ?? [];
      for (const optId of selectedIds) {
        const opt = group.options.find((o) => o.id === optId);
        if (opt) {
          chosenModifiers.push({
            optionId: opt.id,
            groupId: group.id,
            groupName: group.name,
            name: opt.name,
            priceDelta: opt.price_delta,
          });
        }
      }
    }

    onAddToCart({
      id: `${product.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      productId: product.id,
      productName: product.name,
      productSku: product.sku,
      photoUrl: product.photo_url,
      unitPrice: product.price,
      quantity,
      notes: notes.trim() || undefined,
      modifiers: chosenModifiers,
      kitchenStation: product.kitchen_station,
    });

    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0 overflow-hidden sm:max-w-xl">
        <DialogHeader className="p-5 pb-3 border-b bg-muted/20">
          <div className="flex items-start gap-3.5">
            {product.photo_url ? (
              <div className="relative size-16 shrink-0 overflow-hidden rounded-xl border bg-muted">
                <Image
                  src={product.photo_url}
                  alt={product.name}
                  fill
                  className="object-cover"
                />
              </div>
            ) : (
              <div className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-primary">
                <Utensils className="size-7" />
              </div>
            )}
            <div className="space-y-1">
              <DialogTitle className="text-lg font-bold font-display">
                {product.name}
              </DialogTitle>
              <DialogDescription className="text-xs line-clamp-2">
                {product.description || "Pilih varian atau modifier untuk produk ini."}
              </DialogDescription>
              <div className="text-sm font-bold text-primary">
                {formatRupiah(product.price)}
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {activeGroups.map((group) => {
            const selected = selectedOptions[group.id] ?? [];
            const isSingle = group.selection_type === "single";

            return (
              <div
                key={group.id}
                className="space-y-3 rounded-xl border p-4 bg-card/60"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h4 className="font-semibold text-sm">{group.name}</h4>
                    {group.is_required ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] h-5 px-1.5 border-brand-accent/40 text-brand-accent"
                      >
                        Wajib
                      </Badge>
                    ) : (
                      <Badge
                        variant="secondary"
                        className="text-[10px] h-5 px-1.5 opacity-80"
                      >
                        Opsional
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {isSingle
                      ? "Pilih 1"
                      : group.max_select > 1
                      ? `Pilih s/d ${group.max_select}`
                      : "Bebas pilih"}
                  </span>
                </div>

                {isSingle ? (
                  <RadioGroup
                    value={selected[0] ?? ""}
                    onValueChange={(val: string) => handleSelectSingle(group.id, val)}
                    className="space-y-2 pt-1"
                  >
                    {group.options
                      .filter((o) => o.is_active)
                      .map((opt) => (
                        <Label
                          key={opt.id}
                          htmlFor={`opt-${opt.id}`}
                          className="flex items-center justify-between p-2.5 rounded-lg border bg-background/50 hover:bg-muted/40 cursor-pointer font-normal text-xs"
                        >
                          <div className="flex items-center gap-2.5">
                            <RadioGroupItem
                              value={opt.id}
                              id={`opt-${opt.id}`}
                            />
                            <span className="font-medium text-foreground">
                              {opt.name}
                            </span>
                          </div>
                          <span className="text-muted-foreground font-mono">
                            {formatPriceDelta(opt.price_delta)}
                          </span>
                        </Label>
                      ))}
                  </RadioGroup>
                ) : (
                  <div className="space-y-2 pt-1">
                    {group.options
                      .filter((o) => o.is_active)
                      .map((opt) => {
                        const isChecked = selected.includes(opt.id);
                        return (
                          <Label
                            key={opt.id}
                            htmlFor={`chk-${opt.id}`}
                            className="flex items-center justify-between p-2.5 rounded-lg border bg-background/50 hover:bg-muted/40 cursor-pointer font-normal text-xs"
                          >
                            <div className="flex items-center gap-2.5">
                              <Checkbox
                                id={`chk-${opt.id}`}
                                checked={isChecked}
                                onCheckedChange={() =>
                                  handleToggleMultiple(group.id, opt.id)
                                }
                              />
                              <span className="font-medium text-foreground">
                                {opt.name}
                              </span>
                            </div>
                            <span className="text-muted-foreground font-mono">
                              {formatPriceDelta(opt.price_delta)}
                            </span>
                          </Label>
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })}

          {/* Catatan Khusus */}
          <div className="space-y-2">
            <Label htmlFor="special-notes" className="text-xs font-semibold">
              Catatan Khusus (Opsional)
            </Label>
            <Textarea
              id="special-notes"
              placeholder="Contoh: jangan terlalu pedas, pisahkan es, saus diperbanyak..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="resize-none h-20 text-xs"
              maxLength={300}
            />
            <div className="text-right text-[10px] text-muted-foreground">
              {notes.length}/300
            </div>
          </div>
        </div>

        {/* Footer with Quantity Stepper & Price */}
        <DialogFooter className="p-4 border-t bg-muted/20 flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center justify-between sm:justify-start gap-4">
            <span className="text-xs font-semibold text-muted-foreground">
              Jumlah:
            </span>
            <div className="flex items-center border rounded-lg bg-background">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                disabled={quantity <= 1}
              >
                <Minus className="size-3.5" />
              </Button>
              <span className="w-9 text-center font-bold text-sm">
                {quantity}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => setQuantity((q) => q + 1)}
              >
                <Plus className="size-3.5" />
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="flex-1 sm:flex-none text-xs"
            >
              Batal
            </Button>
            <Button
              type="button"
              onClick={handleConfirm}
              disabled={!isValid}
              className="flex-1 sm:flex-none text-xs font-semibold"
            >
              Tambah ({formatRupiah(lineTotal)})
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
