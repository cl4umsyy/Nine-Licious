"use client";

import { useMemo, useState, useTransition } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Loader2,
  Plus,
  Save,
  Search,
  Trash2,
  UtensilsCrossed,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteRecipeLineAction,
  saveProductRecipeAction,
} from "@/lib/inventory/actions";
import {
  formatStockQuantity,
  roundQuantity3,
} from "@/lib/inventory/calculations";
import type {
  Ingredient,
  ProductWithRecipe,
  RecipeItem,
} from "@/lib/inventory/types";
import { cn } from "@/lib/utils";

type RecipeFilter = "all" | "with_recipe" | "without_recipe";

type DraftRecipeLine = {
  existingRecipeId: string | null;
  ingredientId: string;
  ingredientName: string;
  unit: Ingredient["unit"];
  isActive: boolean;
  quantityInput: string;
  notes: string;
};

type RecipeManagerProps = {
  products: ProductWithRecipe[];
  ingredients: Ingredient[];
  onDataChanged: () => void;
};

export function RecipeManager({
  products,
  ingredients,
  onDataChanged,
}: RecipeManagerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<RecipeFilter>("all");
  const [selectedProductId, setSelectedProductId] = useState<string | null>(
    products[0]?.product_id ?? null,
  );

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return products.filter((p) => {
      if (filter === "with_recipe" && p.recipe_items.length === 0) return false;
      if (filter === "without_recipe" && p.recipe_items.length > 0) return false;
      if (!q) return true;
      return (
        p.product_name.toLowerCase().includes(q) ||
        (p.product_sku ?? "").toLowerCase().includes(q) ||
        (p.category_name ?? "").toLowerCase().includes(q)
      );
    });
  }, [products, filter, searchQuery]);

  const selectedProduct = useMemo(() => {
    if (selectedProductId) {
      const found = products.find((p) => p.product_id === selectedProductId);
      if (found) return found;
    }
    return products[0] ?? null;
  }, [products, selectedProductId]);

  const withRecipeCount = useMemo(
    () => products.filter((p) => p.recipe_items.length > 0).length,
    [products],
  );

  if (products.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-brand-soft text-primary">
            <UtensilsCrossed className="size-5" />
          </div>
          <h3 className="mt-3 font-display text-base font-semibold">
            Belum ada produk menu
          </h3>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">
            Tambahkan produk terlebih dahulu pada halaman Menu &amp; Harga
            sebelum menyusun resep bahan baku.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
      {/* Kolom Kiri: Daftar Produk */}
      <Card className="flex flex-col">
        <CardHeader className="space-y-3">
          <div>
            <CardTitle>Daftar Produk</CardTitle>
            <CardDescription>
              {withRecipeCount} dari {products.length} produk sudah memiliki
              resep bahan baku.
            </CardDescription>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari produk atau kategori..."
              className="pl-9"
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {(
              [
                { id: "all", label: "Semua" },
                { id: "with_recipe", label: "Ada Resep" },
                { id: "without_recipe", label: "Belum Ada" },
              ] as Array<{ id: RecipeFilter; label: string }>
            ).map((btn) => (
              <Button
                key={btn.id}
                type="button"
                size="xs"
                variant={filter === btn.id ? "default" : "outline"}
                onClick={() => setFilter(btn.id)}
              >
                {btn.label}
              </Button>
            ))}
          </div>
        </CardHeader>

        <CardContent className="max-h-[540px] space-y-1.5 overflow-y-auto pt-0">
          {filteredProducts.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              Tidak ada produk yang cocok dengan filter.
            </p>
          ) : (
            filteredProducts.map((product) => {
              const isSelected =
                selectedProduct?.product_id === product.product_id;
              return (
                <button
                  key={product.product_id}
                  type="button"
                  onClick={() => setSelectedProductId(product.product_id)}
                  className={cn(
                    "flex w-full items-start justify-between gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors cursor-pointer",
                    isSelected
                      ? "border-primary bg-primary/8 shadow-2xs"
                      : "border-border/70 bg-card hover:bg-muted/40",
                  )}
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate text-xs font-semibold text-foreground">
                      {product.product_name}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {product.category_name ?? "Tanpa kategori"}
                      {product.product_sku ? ` · ${product.product_sku}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge
                      variant={
                        product.recipe_items.length > 0
                          ? "secondary"
                          : "outline"
                      }
                      className={cn(
                        "text-[10px]",
                        product.recipe_items.length === 0 &&
                          "border-amber-500/50 bg-amber-500/10 text-amber-800 font-medium",
                      )}
                    >
                      {product.recipe_items.length > 0
                        ? `${product.recipe_items.length} bahan`
                        : "Belum Ada Resep"}
                    </Badge>
                    {product.has_inactive_ingredient ? (
                      <Badge
                        variant="outline"
                        className="border-amber-500/50 text-[10px] text-amber-800"
                      >
                        Ada bahan arsip
                      </Badge>
                    ) : null}
                  </div>
                </button>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Kolom Kanan: Editor Resep Produk Terpilih */}
      {selectedProduct ? (
        <ProductRecipeEditor
          key={`${selectedProduct.product_id}-${selectedProduct.recipe_items
            .map((r) => `${r.id}:${r.quantity_required}:${r.notes ?? ""}`)
            .join("|")}`}
          product={selectedProduct}
          ingredients={ingredients}
          onDataChanged={onDataChanged}
        />
      ) : null}
    </div>
  );
}

function ProductRecipeEditor({
  product,
  ingredients,
  onDataChanged,
}: {
  product: ProductWithRecipe;
  ingredients: Ingredient[];
  onDataChanged: () => void;
}) {
  const ingredientMap = useMemo(
    () => new Map(ingredients.map((i) => [i.id, i])),
    [ingredients],
  );

  const [lines, setLines] = useState<DraftRecipeLine[]>(() =>
    product.recipe_items.map((item: RecipeItem) => {
      const ing = ingredientMap.get(item.ingredient_id);
      return {
        existingRecipeId: item.id,
        ingredientId: item.ingredient_id,
        ingredientName:
          item.ingredient_name ?? ing?.name ?? "Bahan tidak ditemukan",
        unit: item.ingredient_unit ?? ing?.unit ?? "g",
        isActive: item.ingredient_is_active ?? ing?.is_active ?? true,
        quantityInput: String(item.quantity_required),
        notes: item.notes ?? "",
      };
    }),
  );

  const [selectedNewIngredientId, setSelectedNewIngredientId] =
    useState<string>("");
  const [newQuantityInput, setNewQuantityInput] = useState<string>("");
  const [newNotes, setNewNotes] = useState<string>("");
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DraftRecipeLine | null>(
    null,
  );
  const [isSaving, startSaving] = useTransition();
  const [isDeleting, startDeleting] = useTransition();

  // Hanya bahan AKTIF yang belum ada pada resep yang boleh ditambahkan
  const availableActiveIngredients = useMemo(() => {
    const usedIds = new Set(lines.map((l) => l.ingredientId));
    return ingredients.filter((ing) => ing.is_active && !usedIds.has(ing.id));
  }, [ingredients, lines]);

  const selectedNewIngredient = useMemo(
    () =>
      availableActiveIngredients.find((i) => i.id === selectedNewIngredientId) ??
      null,
    [availableActiveIngredients, selectedNewIngredientId],
  );

  function handleAddLine() {
    setFormError(null);
    if (!selectedNewIngredient) {
      setFormError("Pilih bahan baku aktif yang ingin ditambahkan ke resep.");
      return;
    }

    const parsed = Number(newQuantityInput.trim().replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setFormError("Takaran bahan per 1 porsi harus angka lebih besar dari 0.");
      return;
    }

    setLines((prev) => [
      ...prev,
      {
        existingRecipeId: null,
        ingredientId: selectedNewIngredient.id,
        ingredientName: selectedNewIngredient.name,
        unit: selectedNewIngredient.unit,
        isActive: true,
        quantityInput: String(roundQuantity3(parsed)),
        notes: newNotes.trim(),
      },
    ]);
    setSelectedNewIngredientId("");
    setNewQuantityInput("");
    setNewNotes("");
  }

  function handleRemoveUnsavedLine(ingredientId: string) {
    setLines((prev) => prev.filter((l) => l.ingredientId !== ingredientId));
  }

  function handleConfirmDeleteSavedLine() {
    if (!deleteTarget?.existingRecipeId) return;
    const target = deleteTarget;

    startDeleting(async () => {
      const result = await deleteRecipeLineAction({
        recipeId: target.existingRecipeId!,
      });

      if (!result.ok) {
        toast.error(result.message);
        setFormError(result.message);
        return;
      }

      toast.success(result.message);
      setLines((prev) =>
        prev.filter((l) => l.ingredientId !== target.ingredientId),
      );
      setDeleteTarget(null);
      onDataChanged();
    });
  }

  function handleSaveRecipe() {
    setFormError(null);

    const payloadItems: Array<{
      ingredientId: string;
      quantityRequired: number;
      notes: string | null;
    }> = [];

    for (const line of lines) {
      const qty = Number(line.quantityInput.trim().replace(",", "."));
      if (!Number.isFinite(qty) || qty <= 0) {
        setFormError(
          `Takaran untuk "${line.ingredientName}" harus angka lebih besar dari 0.`,
        );
        return;
      }
      payloadItems.push({
        ingredientId: line.ingredientId,
        quantityRequired: roundQuantity3(qty),
        notes: line.notes.trim() || null,
      });
    }

    startSaving(async () => {
      const result = await saveProductRecipeAction({
        productId: product.product_id,
        items: payloadItems,
      });

      if (!result.ok) {
        setFormError(result.message);
        toast.error(result.message);
        return;
      }

      toast.success(result.message);
      onDataChanged();
    });
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{product.product_name}</CardTitle>
              {product.category_name ? (
                <Badge variant="outline">{product.category_name}</Badge>
              ) : null}
              {!product.is_active ? (
                <Badge variant="destructive">Produk Nonaktif</Badge>
              ) : null}
            </div>
            <CardDescription>
              Atur komposisi bahan baku per 1 porsi produk. Stok akan dikurangi
              otomatis sesuai takaran ini saat pesanan lunas.
            </CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={isSaving || isDeleting}
            onClick={handleSaveRecipe}
          >
            {isSaving ? (
              <>
                <Loader2 className="animate-spin" />
                Menyimpan...
              </>
            ) : (
              <>
                <Save />
                Simpan Resep
              </>
            )}
          </Button>
        </CardHeader>

        <CardContent className="space-y-5">
          {formError ? (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          {lines.length === 0 ? (
            <Alert className="border-amber-500/40 bg-amber-500/5">
              <AlertTriangle className="size-4 text-amber-600" />
              <AlertDescription className="text-xs text-amber-900 leading-relaxed">
                <strong>Produk Belum Memiliki Resep:</strong> Saat pesanan produk
                ini berstatus lunas, sistem tidak akan mengurangi stok bahan baku.
                Tambahkan bahan baku di bawah ini lalu klik{" "}
                <strong>Simpan Resep</strong>.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert className="border-primary/20 bg-primary/5">
              <CheckCircle2 className="size-4 text-primary" />
              <AlertDescription className="text-xs text-primary leading-relaxed">
                <strong>
                  Resep Aktif Terhubung ({lines.length} bahan baku):
                </strong>{" "}
                Penjualan produk ini yang lunas (Tunai, Split Bill, atau
                Midtrans) akan otomatis memotong bahan baku berikut dari stok
                inventori.
              </AlertDescription>
            </Alert>
          )}

          {product.has_inactive_ingredient ? (
            <Alert>
              <AlertTriangle />
              <AlertDescription>
                Resep ini memuat bahan baku yang sudah diarsipkan. Bahan arsip
                tidak lagi dipotong otomatis saat penjualan, namun riwayat resep
                tetap tampil hingga Anda menghapus baris tersebut secara manual.
              </AlertDescription>
            </Alert>
          ) : null}

          {/* Tambah Bahan Aktif ke Resep */}
          <div className="rounded-xl border border-border bg-muted/25 p-4 space-y-3">
            <p className="text-xs font-semibold text-foreground">
              Tambah Bahan Baku Aktif ke Resep
            </p>
            {availableActiveIngredients.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Semua bahan baku aktif sudah dimasukkan ke resep ini, atau belum
                ada bahan baku aktif yang tersedia.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-[1fr_140px_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="recipe-add-ing" className="text-xs">
                    Bahan Baku Aktif
                  </Label>
                  <Select
                    value={selectedNewIngredientId}
                    onValueChange={setSelectedNewIngredientId}
                    disabled={isSaving}
                  >
                    <SelectTrigger id="recipe-add-ing">
                      <SelectValue placeholder="Pilih bahan baku aktif..." />
                    </SelectTrigger>
                    <SelectContent>
                      {availableActiveIngredients.map((ing) => (
                        <SelectItem key={ing.id} value={ing.id}>
                          {ing.name} ({ing.unit}) · Stok:{" "}
                          {formatStockQuantity(ing.current_stock, ing.unit)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="recipe-add-qty" className="text-xs">
                    Takaran / Porsi{" "}
                    {selectedNewIngredient
                      ? `(${selectedNewIngredient.unit})`
                      : ""}
                  </Label>
                  <Input
                    id="recipe-add-qty"
                    type="number"
                    step="0.001"
                    min="0.001"
                    value={newQuantityInput}
                    onChange={(e) => setNewQuantityInput(e.target.value)}
                    placeholder="Contoh: 150"
                    disabled={isSaving}
                  />
                </div>

                <Button
                  type="button"
                  size="default"
                  variant="secondary"
                  disabled={isSaving || !selectedNewIngredientId}
                  onClick={handleAddLine}
                >
                  <Plus />
                  Tambah
                </Button>
              </div>
            )}

            {selectedNewIngredient ? (
              <div className="space-y-1">
                <Label htmlFor="recipe-add-notes" className="text-[11px]">
                  Catatan Takaran (Opsional)
                </Label>
                <Input
                  id="recipe-add-notes"
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  maxLength={300}
                  placeholder="Contoh: Berat bersih setelah dicuci"
                  disabled={isSaving}
                />
              </div>
            ) : null}
          </div>

          {/* Daftar Baris Resep */}
          {lines.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-10 text-center">
              <BookOpen className="size-8 text-muted-foreground/60" />
              <p className="mt-2 text-sm font-medium text-foreground">
                Produk ini belum memiliki resep bahan baku
              </p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                Penjualan produk tanpa resep tetap berjalan normal dan dilewati
                secara aman oleh sistem pengurangan stok.
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-foreground">
                  Komposisi Bahan ({lines.length} bahan per 1 porsi)
                </p>
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <CheckCircle2 className="size-3.5 text-primary" />
                  Klik &ldquo;Simpan Resep&rdquo; untuk menerapkan perubahan
                  takaran
                </span>
              </div>

              {lines.map((line) => (
                <div
                  key={line.ingredientId}
                  className={cn(
                    "grid gap-3 rounded-xl border p-3 sm:grid-cols-[1fr_140px_1fr_auto] sm:items-center",
                    line.isActive
                      ? "border-border bg-card"
                      : "border-amber-500/40 bg-amber-500/5",
                  )}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-xs font-semibold text-foreground">
                        {line.ingredientName}
                      </span>
                      {!line.isActive ? (
                        <Badge
                          variant="outline"
                          className="border-amber-500/50 text-[10px] text-amber-800"
                        >
                          Nonaktif (Arsip)
                        </Badge>
                      ) : null}
                      {!line.existingRecipeId ? (
                        <Badge variant="secondary" className="text-[10px]">
                          Baru
                        </Badge>
                      ) : null}
                    </div>
                    <span className="block text-[11px] text-muted-foreground">
                      Satuan: {line.unit}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">
                      Takaran ({line.unit})
                    </Label>
                    <Input
                      type="number"
                      step="0.001"
                      min="0.001"
                      value={line.quantityInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        setLines((prev) =>
                          prev.map((item) =>
                            item.ingredientId === line.ingredientId
                              ? { ...item, quantityInput: val }
                              : item,
                          ),
                        );
                      }}
                      disabled={isSaving || isDeleting}
                      className="h-9 font-mono text-xs"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">
                      Catatan (Opsional)
                    </Label>
                    <Input
                      value={line.notes}
                      maxLength={300}
                      onChange={(e) => {
                        const val = e.target.value;
                        setLines((prev) =>
                          prev.map((item) =>
                            item.ingredientId === line.ingredientId
                              ? { ...item, notes: val }
                              : item,
                          ),
                        );
                      }}
                      placeholder="Catatan singkat..."
                      disabled={isSaving || isDeleting}
                      className="h-9 text-xs"
                    />
                  </div>

                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      title="Hapus bahan dari resep"
                      disabled={isSaving || isDeleting}
                      onClick={() => {
                        if (line.existingRecipeId) {
                          setDeleteTarget(line);
                        } else {
                          handleRemoveUnsavedLine(line.ingredientId);
                        }
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialog Konfirmasi Hapus 1 Baris Resep Tersimpan */}
      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Hapus Bahan dari Resep?</DialogTitle>
            <DialogDescription>
              Bahan &ldquo;{deleteTarget?.ingredientName}&rdquo; akan dilepas
              dari resep produk &ldquo;{product.product_name}&rdquo;. Master
              bahan baku dan riwayat mutasi stok tidak akan dihapus.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isDeleting}
              onClick={() => setDeleteTarget(null)}
            >
              Batal
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isDeleting}
              onClick={handleConfirmDeleteSavedLine}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="animate-spin" />
                  Menghapus...
                </>
              ) : (
                "Ya, Hapus dari Resep"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
