"use client";

import { useMemo, useState, useTransition } from "react";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowUpDown,
  Loader2,
  Package,
  Pencil,
  Plus,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  createIngredientAction,
  toggleIngredientActiveAction,
  updateIngredientAction,
} from "@/lib/inventory/actions";
import {
  formatStockQuantity,
  getStockStatus,
} from "@/lib/inventory/calculations";
import {
  INGREDIENT_UNITS,
  INGREDIENT_UNIT_LABELS,
  STOCK_STATUS_LABELS,
  type IngredientUnit,
} from "@/lib/inventory/constants";
import type {
  Ingredient,
  LinkedProductRecipeInfo,
} from "@/lib/inventory/types";
import { cn } from "@/lib/utils";

type IngredientFilter = "all" | "low_stock" | "out_of_stock" | "inactive";

type IngredientManagerProps = {
  ingredients: Ingredient[];
  initialFilter?: IngredientFilter;
  onOpenAdjustStock: (ingredient: Ingredient) => void;
  onDataChanged: () => void;
  linkedProductsByIngredientId?: Map<
    string,
    Array<{ id: string; name: string; sku: string | null }>
  >;
};

export function IngredientManager({
  ingredients,
  initialFilter = "all",
  onOpenAdjustStock,
  onDataChanged,
  linkedProductsByIngredientId,
}: IngredientManagerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<IngredientFilter>(initialFilter);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingIngredient, setEditingIngredient] =
    useState<Ingredient | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Ingredient | null>(null);

  const counts = useMemo(() => {
    let active = 0;
    let lowStock = 0;
    let outOfStock = 0;
    let inactive = 0;

    for (const ing of ingredients) {
      if (!ing.is_active) {
        inactive += 1;
        continue;
      }
      active += 1;
      const available =
        ing.available_stock ??
        Math.max(0, ing.current_stock - (ing.reserved_stock ?? 0));
      const st = getStockStatus(available, ing.min_stock);
      if (st === "low_stock") lowStock += 1;
      if (st === "out_of_stock") outOfStock += 1;
    }

    return {
      all: active,
      lowStock,
      outOfStock,
      inactive,
    };
  }, [ingredients]);

  const filteredIngredients = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    return ingredients.filter((ing) => {
      if (filter === "inactive") {
        if (ing.is_active) return false;
      } else {
        if (!ing.is_active) return false;
        const available =
          ing.available_stock ??
          Math.max(0, ing.current_stock - (ing.reserved_stock ?? 0));
        const st = getStockStatus(available, ing.min_stock);
        if (filter === "low_stock" && st !== "low_stock") return false;
        if (filter === "out_of_stock" && st !== "out_of_stock") return false;
      }

      if (!q) return true;
      return (
        ing.name.toLowerCase().includes(q) ||
        (ing.sku ?? "").toLowerCase().includes(q) ||
        ing.unit.toLowerCase().includes(q)
      );
    });
  }, [ingredients, filter, searchQuery]);

  function openCreateDialog() {
    setEditingIngredient(null);
    setEditorOpen(true);
  }

  function openEditDialog(ingredient: Ingredient) {
    setEditingIngredient(ingredient);
    setEditorOpen(true);
  }

  const filterButtons: Array<{
    id: IngredientFilter;
    label: string;
    count: number;
  }> = [
    { id: "all", label: "Semua Aktif", count: counts.all },
    { id: "low_stock", label: "Stok Menipis (Rendah)", count: counts.lowStock },
    { id: "out_of_stock", label: "Stok Habis / Kritis", count: counts.outOfStock },
    { id: "inactive", label: "Nonaktif", count: counts.inactive },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Daftar Bahan Baku</CardTitle>
            <CardDescription>
              Kelola master bahan baku, batas minimum stok, serta penyesuaian
              stok masuk, keluar, dan opname.
            </CardDescription>
          </div>
          <Button type="button" size="sm" onClick={openCreateDialog}>
            <Plus />
            Tambah Bahan Baku
          </Button>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Pencarian & Filter */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full lg:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Cari nama bahan, SKU, atau satuan..."
                className="pl-9"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {filterButtons.map((btn) => {
                const active = filter === btn.id;
                return (
                  <Button
                    key={btn.id}
                    type="button"
                    size="sm"
                    variant={active ? "default" : "outline"}
                    onClick={() => setFilter(btn.id)}
                  >
                    {btn.label}
                    <Badge
                      variant={active ? "secondary" : "outline"}
                      className="ml-1 h-4 px-1.5 text-[10px]"
                    >
                      {btn.count}
                    </Badge>
                  </Button>
                );
              })}
            </div>
          </div>

          {/* Tabel Bahan Baku */}
          {filteredIngredients.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-6 py-12 text-center">
              <div className="flex size-12 items-center justify-center rounded-xl bg-brand-soft text-primary">
                <Package className="size-5" />
              </div>
              <h3 className="mt-3 font-display text-base font-semibold text-foreground">
                {ingredients.length === 0
                  ? "Belum ada bahan baku"
                  : "Tidak ada bahan baku yang cocok"}
              </h3>
              <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
                {ingredients.length === 0
                  ? "Tambahkan bahan baku terlebih dahulu untuk mulai menghubungkannya dengan resep produk dan memantau stok."
                  : "Ubah kata kunci pencarian atau pilih filter status lain."}
              </p>
              {ingredients.length === 0 ? (
                <Button
                  type="button"
                  size="sm"
                  className="mt-4"
                  onClick={openCreateDialog}
                >
                  <Plus />
                  Tambah Bahan Baku Pertama
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Bahan Baku</TableHead>
                    <TableHead>Satuan</TableHead>
                    <TableHead className="text-right">Stok Fisik</TableHead>
                    <TableHead className="text-right">Direservasi</TableHead>
                    <TableHead className="text-right">Stok Tersedia</TableHead>
                    <TableHead className="text-right">Batas Minimum</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Aksi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredIngredients.map((ing) => {
                    const current = ing.current_stock;
                    const reserved = ing.reserved_stock ?? 0;
                    const available =
                      ing.available_stock ??
                      Math.max(0, current - reserved);
                    const status = getStockStatus(available, ing.min_stock);
                    const isNegative = current < 0;

                    return (
                      <TableRow
                        key={ing.id}
                        className={cn(!ing.is_active && "opacity-70")}
                      >
                        <TableCell>
                          <div className="space-y-0.5">
                            <p className="font-medium text-foreground">
                              {ing.name}
                            </p>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              {ing.sku ? (
                                <span className="font-mono">{ing.sku}</span>
                              ) : null}
                              {ing.notes ? (
                                <span className="line-clamp-1 max-w-xs">
                                  {ing.notes}
                                </span>
                              ) : null}
                            </div>
                            {(() => {
                              const linked =
                                linkedProductsByIngredientId?.get(ing.id) ?? [];
                              if (linked.length > 0) {
                                return (
                                  <div className="space-y-1">
                                    <p
                                      className="line-clamp-1 text-[11px] text-muted-foreground"
                                      title={linked.map((p) => p.name).join(", ")}
                                    >
                                      Dipakai di {linked.length} menu:{" "}
                                      <span className="font-medium text-foreground/85">
                                        {linked
                                          .slice(0, 2)
                                          .map((p) => p.name)
                                          .join(", ")}
                                        {linked.length > 2
                                          ? ` (+${linked.length - 2})`
                                          : ""}
                                      </span>
                                    </p>
                                    {status === "out_of_stock" ? (
                                      <div className="rounded-md border border-destructive/25 bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive font-medium leading-tight">
                                        <span className="font-bold">⚠️ {linked.length} Menu Terdampak (Habis di POS): </span>
                                        <span title={linked.map((p) => p.name).join(", ")}>
                                          {linked.slice(0, 3).map((p) => p.name).join(", ")}
                                          {linked.length > 3 ? ` (+${linked.length - 3})` : ""}
                                        </span>
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              }
                              return (
                                <p className="text-[11px] text-muted-foreground/60 italic">
                                  Belum terhubung ke resep produk
                                </p>
                              );
                            })()}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {ing.unit}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-medium text-foreground">
                          {formatStockQuantity(current, ing.unit)}
                        </TableCell>
                        <TableCell className="text-right">
                          {reserved > 0 ? (
                            <div className="inline-flex flex-col items-end gap-0.5">
                              <span className="font-mono text-xs font-semibold text-sky-700">
                                {formatStockQuantity(reserved, ing.unit)}
                              </span>
                              <Badge
                                variant="outline"
                                className="border-sky-500/40 bg-sky-500/10 text-sky-700 text-[9px] px-1 py-0 h-3.5"
                              >
                                Pesanan Aktif
                              </Badge>
                            </div>
                          ) : (
                            <span className="font-mono text-xs text-muted-foreground/60">
                              0
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex flex-col items-end gap-0.5">
                            <span
                              className={cn(
                                "font-mono text-sm font-semibold",
                                isNegative
                                  ? "text-destructive"
                                  : status === "out_of_stock"
                                    ? "text-destructive"
                                    : status === "low_stock"
                                      ? "text-amber-700"
                                      : "text-emerald-700",
                              )}
                            >
                              {formatStockQuantity(available, ing.unit)}
                            </span>
                            {isNegative ? (
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-destructive">
                                Kritis · Stok Negatif
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          {formatStockQuantity(ing.min_stock, ing.unit)}
                        </TableCell>
                        <TableCell>
                          {!ing.is_active ? (
                            <Badge variant="outline">Nonaktif</Badge>
                          ) : status === "out_of_stock" ? (
                            <Badge variant="destructive">
                              {isNegative
                                ? "Kritis (Negatif)"
                                : STOCK_STATUS_LABELS.out_of_stock}
                            </Badge>
                          ) : status === "low_stock" ? (
                            <Badge
                              variant="outline"
                              className="border-amber-500/50 bg-amber-500/10 text-amber-800"
                            >
                              {STOCK_STATUS_LABELS.low_stock}
                            </Badge>
                          ) : (
                            <Badge
                              variant="secondary"
                              className="bg-emerald-500/10 text-emerald-800"
                            >
                              {STOCK_STATUS_LABELS.safe}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                            {ing.is_active ? (
                              <Button
                                type="button"
                                size="xs"
                                variant="default"
                                onClick={() => onOpenAdjustStock(ing)}
                              >
                                <ArrowUpDown />
                                Sesuaikan Stok
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              onClick={() => openEditDialog(ing)}
                            >
                              <Pencil />
                              Ubah
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              onClick={() => setArchiveTarget(ing)}
                            >
                              {ing.is_active ? (
                                <>
                                  <Archive />
                                  Arsipkan
                                </>
                              ) : (
                                <>
                                  <ArchiveRestore />
                                  Aktifkan
                                </>
                              )}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialog Tambah / Ubah Bahan Baku */}
      <IngredientFormDialog
        open={editorOpen}
        ingredient={editingIngredient}
        onOpenChange={setEditorOpen}
        onSaved={onDataChanged}
      />

      {/* Dialog Konfirmasi Arsip / Aktifkan Bahan Baku */}
      <IngredientArchiveDialog
        ingredient={archiveTarget}
        open={Boolean(archiveTarget)}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(null);
        }}
        onUpdated={onDataChanged}
      />
    </div>
  );
}

function IngredientFormDialog({
  open,
  ingredient,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  ingredient: Ingredient | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open ? (
          <IngredientFormContent
            key={ingredient?.id ?? "new-ingredient"}
            ingredient={ingredient}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function IngredientFormContent({
  ingredient,
  onClose,
  onSaved,
}: {
  ingredient: Ingredient | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEditing = Boolean(ingredient);
  const [name, setName] = useState(ingredient?.name ?? "");
  const [sku, setSku] = useState(ingredient?.sku ?? "");
  const [unit, setUnit] = useState<IngredientUnit>(ingredient?.unit ?? "g");
  const [minStock, setMinStock] = useState(
    ingredient ? String(ingredient.min_stock) : "0",
  );
  const [notes, setNotes] = useState(ingredient?.notes ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});

    const parsedMinStock = Number(minStock.trim().replace(",", "."));
    if (!Number.isFinite(parsedMinStock) || parsedMinStock < 0) {
      setFieldErrors({ minStock: "Batas stok minimum harus angka >= 0." });
      return;
    }

    startTransition(async () => {
      const result = isEditing && ingredient
        ? await updateIngredientAction({
            ingredientId: ingredient.id,
            name,
            sku: sku.trim() || null,
            unit,
            minStock: parsedMinStock,
            notes: notes.trim() || null,
          })
        : await createIngredientAction({
            name,
            sku: sku.trim() || null,
            unit,
            minStock: parsedMinStock,
            notes: notes.trim() || null,
          });

      if (!result.ok) {
        setFormError(result.message);
        if (result.fieldErrors) setFieldErrors(result.fieldErrors);
        toast.error(result.message);
        return;
      }

      toast.success(result.message);
      onSaved();
      onClose();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>
          {isEditing ? "Ubah Bahan Baku" : "Tambah Bahan Baku"}
        </DialogTitle>
        <DialogDescription>
          {isEditing
            ? "Perbarui metadata bahan baku. Perubahan saldo stok tetap dilakukan melalui tombol Sesuaikan Stok agar tercatat di buku besar."
            : "Stok awal bahan baku baru selalu dimulai dari 0. Setelah dibuat, gunakan tombol Sesuaikan Stok (Stok Masuk) untuk mencatat stok awal."}
        </DialogDescription>
      </DialogHeader>

      {formError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="ing-name">
          Nama Bahan Baku <span className="text-destructive">*</span>
        </Label>
        <Input
          id="ing-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Contoh: Beras Pandan Wangi"
          maxLength={80}
          disabled={isPending}
          required
        />
        {fieldErrors.name ? (
          <p className="text-xs text-destructive">{fieldErrors.name}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ing-sku">Kode / SKU (Opsional)</Label>
          <Input
            id="ing-sku"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="Contoh: ING-BRS-01"
            maxLength={32}
            disabled={isPending}
          />
          {fieldErrors.sku ? (
            <p className="text-xs text-destructive">{fieldErrors.sku}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ing-unit">
            Satuan <span className="text-destructive">*</span>
          </Label>
          <Select
            value={unit}
            onValueChange={(val) => setUnit(val as IngredientUnit)}
            disabled={isPending}
          >
            <SelectTrigger id="ing-unit">
              <SelectValue placeholder="Pilih satuan" />
            </SelectTrigger>
            <SelectContent>
              {INGREDIENT_UNITS.map((u) => (
                <SelectItem key={u} value={u}>
                  {INGREDIENT_UNIT_LABELS[u]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {fieldErrors.unit ? (
            <p className="text-xs text-destructive">{fieldErrors.unit}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ing-min-stock">
          Batas Stok Minimum ({unit}) <span className="text-destructive">*</span>
        </Label>
        <Input
          id="ing-min-stock"
          type="number"
          step="0.001"
          min="0"
          value={minStock}
          onChange={(e) => setMinStock(e.target.value)}
          disabled={isPending}
          required
        />
        <p className="text-[11px] text-muted-foreground">
          Peringatan Stok Rendah muncul saat stok saat ini kurang dari atau sama
          dengan batas ini.
        </p>
        {fieldErrors.minStock ? (
          <p className="text-xs text-destructive">{fieldErrors.minStock}</p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ing-notes">Catatan (Opsional)</Label>
        <Textarea
          id="ing-notes"
          rows={2}
          maxLength={500}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Catatan penyimpanan, supplier, atau spesifikasi bahan..."
          disabled={isPending}
        />
        {fieldErrors.notes ? (
          <p className="text-xs text-destructive">{fieldErrors.notes}</p>
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
        <Button type="submit" disabled={isPending}>
          {isPending ? (
            <>
              <Loader2 className="animate-spin" />
              Menyimpan...
            </>
          ) : isEditing ? (
            "Simpan Perubahan"
          ) : (
            "Tambah Bahan Baku"
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}

function IngredientArchiveDialog({
  ingredient,
  open,
  onOpenChange,
  onUpdated,
}: {
  ingredient: Ingredient | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open && ingredient ? (
          <IngredientArchiveContent
            key={`${ingredient.id}-${ingredient.is_active}`}
            ingredient={ingredient}
            onClose={() => onOpenChange(false)}
            onUpdated={onUpdated}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function IngredientArchiveContent({
  ingredient,
  onClose,
  onUpdated,
}: {
  ingredient: Ingredient;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const willArchive = ingredient.is_active;
  const [linkedProducts, setLinkedProducts] = useState<
    LinkedProductRecipeInfo[]
  >([]);
  const [needsForceConfirm, setNeedsForceConfirm] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm(forceArchive: boolean) {
    setErrorMessage(null);

    startTransition(async () => {
      const result = await toggleIngredientActiveAction({
        ingredientId: ingredient.id,
        isActive: !willArchive,
        confirmArchiveWithActiveRecipes: forceArchive,
      });

      if (!result.ok) {
        if (
          result.code === "INGREDIENT_IN_USE_REQUIRES_CONFIRMATION" &&
          result.data?.linkedProducts
        ) {
          setLinkedProducts(result.data.linkedProducts);
          setNeedsForceConfirm(true);
          setErrorMessage(result.message);
          return;
        }
        setErrorMessage(result.message);
        toast.error(result.message);
        return;
      }

      toast.success(result.message);
      onUpdated();
      onClose();
    });
  }

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>
          {willArchive
            ? `Arsipkan Bahan "${ingredient.name}"?`
            : `Aktifkan Kembali "${ingredient.name}"?`}
        </DialogTitle>
        <DialogDescription>
          {willArchive
            ? "Bahan baku yang diarsipkan tidak dapat ditambahkan ke resep baru maupun disesuaikan stoknya. Riwayat resep lama dan mutasi stok tetap tersimpan aman."
            : "Bahan baku yang diaktifkan kembali dapat digunakan pada resep produk dan penyesuaian stok."}
        </DialogDescription>
      </DialogHeader>

      {errorMessage ? (
        <Alert variant={needsForceConfirm ? "default" : "destructive"}>
          <AlertTriangle />
          <AlertTitle>
            {needsForceConfirm
              ? "Bahan Masih Dipakai di Resep Produk"
              : "Gagal Mengubah Status"}
          </AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {needsForceConfirm && linkedProducts.length > 0 ? (
        <div className="max-h-44 space-y-1.5 overflow-y-auto rounded-xl border border-border bg-muted/25 p-3">
          <p className="text-xs font-semibold text-foreground">
            Daftar Produk yang Menggunakan Bahan Ini ({linkedProducts.length}):
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {linkedProducts.map((lp) => (
              <li
                key={lp.recipe_id}
                className="flex items-center justify-between gap-2 rounded-lg bg-card px-2.5 py-1.5 border border-border/60"
              >
                <span className="font-medium text-foreground">
                  {lp.product_name}
                </span>
                <span className="font-mono text-[11px]">
                  {formatStockQuantity(lp.quantity_required, ingredient.unit)} /
                  porsi
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={onClose}
        >
          Batal
        </Button>
        {needsForceConfirm ? (
          <Button
            type="button"
            variant="destructive"
            disabled={isPending}
            onClick={() => handleConfirm(true)}
          >
            {isPending ? (
              <>
                <Loader2 className="animate-spin" />
                Mengarsipkan...
              </>
            ) : (
              "Konfirmasi Tetap Arsipkan"
            )}
          </Button>
        ) : (
          <Button
            type="button"
            variant={willArchive ? "destructive" : "default"}
            disabled={isPending}
            onClick={() => handleConfirm(false)}
          >
            {isPending ? (
              <>
                <Loader2 className="animate-spin" />
                Memproses...
              </>
            ) : willArchive ? (
              "Ya, Arsipkan Bahan"
            ) : (
              "Ya, Aktifkan Kembali"
            )}
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}
