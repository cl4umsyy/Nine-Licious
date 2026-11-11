"use client";

import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  ImagePlus,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
  UtensilsCrossed,
  X,
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
import { Button, buttonVariants } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { FormError, FormField } from "@/components/admin/form-field";
import { ProductPhoto } from "@/components/admin/product-photo";
import {
  deleteProductAction,
  saveProductAction,
  setProductStatusAction,
} from "@/lib/menu/actions";
import type { MenuActionState } from "@/lib/menu/action-types";
import {
  KITCHEN_STATIONS,
  KITCHEN_STATION_LABELS,
  MODIFIER_SELECTION_LABELS,
} from "@/lib/menu/constants";
import { formatRupiah } from "@/lib/menu/format";
import type { ProductWithModifiers } from "@/lib/menu/types";
import { cn } from "@/lib/utils";
import type { MenuCategory, ModifierGroup } from "@/types/database";

type ProductManagerProps = {
  products: ProductWithModifiers[];
  categories: MenuCategory[];
  modifierGroups: ModifierGroup[];
};

type StatusFilter =
  | "all"
  | "active"
  | "inactive"
  | "available"
  | "unavailable";

const initialState: MenuActionState = { status: "idle" };

function ProductFormDialog({
  product,
  categories,
  modifierGroups,
  defaultSortOrder,
  onClose,
}: {
  product: ProductWithModifiers | null;
  categories: MenuCategory[];
  modifierGroups: ModifierGroup[];
  defaultSortOrder: number;
  onClose: () => void;
}) {
  const [state, formAction, isPending] = useActionState(
    saveProductAction,
    initialState,
  );
  const [isActive, setIsActive] = useState(product?.is_active ?? true);
  const [isAvailable, setIsAvailable] = useState(
    product?.is_available ?? true,
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    if (state.status === "success") {
      toast.success(state.message);
      onClose();
    }
  }, [state, onClose]);

  const storedPhoto = removePhoto ? null : (product?.photo_url ?? null);

  function handlePhotoChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (file) {
      setPreviewUrl(URL.createObjectURL(file));
      setRemovePhoto(false);
    }
  }

  function clearNewPhoto() {
    setPreviewUrl(null);
    setRemovePhoto(false);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {product ? "Ubah produk" : "Tambah produk"}
          </DialogTitle>
          <DialogDescription>
            Harga disimpan sebagai rupiah tanpa desimal. Perubahan harga tidak
            mengubah snapshot pesanan lama.
          </DialogDescription>
        </DialogHeader>

        <form
          action={formAction}
          className="space-y-5"
          encType="multipart/form-data"
        >
          {product ? <input type="hidden" name="id" value={product.id} /> : null}
          <input
            type="hidden"
            name="removePhoto"
            value={removePhoto ? "true" : "false"}
          />

          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="space-y-2">
              <div className="relative size-28 overflow-hidden rounded-xl border border-border bg-muted">
                {previewUrl ? (
                  <div
                    role="img"
                    aria-label="Pratinjau foto produk"
                    className="size-full bg-cover bg-center"
                    style={{ backgroundImage: `url("${previewUrl}")` }}
                  />
                ) : (
                  <ProductPhoto
                    src={storedPhoto}
                    alt={product?.name ?? "Produk baru"}
                    className="size-full border-0"
                    sizes="112px"
                  />
                )}
              </div>
              <input
                ref={fileInputRef}
                id="product-photo"
                name="photo"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={handlePhotoChange}
              />
              <div className="flex flex-wrap gap-1.5">
                <label
                  htmlFor="product-photo"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "cursor-pointer",
                  )}
                >
                  <ImagePlus />
                  Pilih foto
                </label>
                {previewUrl ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearNewPhoto}
                  >
                    <X />
                    Batalkan
                  </Button>
                ) : null}
                {!previewUrl && product?.photo_url && !removePhoto ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRemovePhoto(true)}
                  >
                    <Trash2 />
                    Hapus foto
                  </Button>
                ) : null}
                {removePhoto ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRemovePhoto(false)}
                  >
                    Urungkan hapus
                  </Button>
                ) : null}
              </div>
              <p className="max-w-36 text-[0.7rem] leading-relaxed text-muted-foreground">
                JPEG, PNG, atau WebP. Maksimal 5 MB. Produk tanpa foto memakai
                placeholder.
              </p>
              {state.fieldErrors?.photo ? (
                <p className="text-xs text-destructive">
                  {state.fieldErrors.photo}
                </p>
              ) : null}
            </div>

            <div className="grid flex-1 gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <FormField
                  label="Nama produk"
                  htmlFor="product-name"
                  error={state.fieldErrors?.name}
                >
                  <Input
                    id="product-name"
                    name="name"
                    defaultValue={product?.name ?? ""}
                    placeholder="Contoh: Nasi Goreng Spesial"
                    maxLength={80}
                    required
                    autoFocus
                  />
                </FormField>
              </div>

              <FormField
                label="Kategori"
                htmlFor="product-category"
                error={state.fieldErrors?.categoryId}
              >
                <Select
                  name="categoryId"
                  defaultValue={product?.category_id ?? categories[0]?.id}
                >
                  <SelectTrigger id="product-category" className="w-full">
                    <SelectValue placeholder="Pilih kategori" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.name}
                        {category.is_active ? "" : " (nonaktif)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField
                label="Harga (Rp)"
                htmlFor="product-price"
                error={state.fieldErrors?.price}
                hint="Bilangan bulat tanpa titik atau desimal."
              >
                <Input
                  id="product-price"
                  name="price"
                  type="number"
                  min={0}
                  max={999_999_999}
                  step={1}
                  defaultValue={product?.price ?? ""}
                  placeholder="35000"
                  required
                />
              </FormField>

              <FormField
                label="SKU / kode"
                htmlFor="product-sku"
                error={state.fieldErrors?.sku}
                hint="Opsional. Harus unik bila diisi."
              >
                <Input
                  id="product-sku"
                  name="sku"
                  defaultValue={product?.sku ?? ""}
                  placeholder="FOOD-001"
                  maxLength={32}
                  autoCapitalize="characters"
                  spellCheck={false}
                />
              </FormField>

              <FormField
                label="Stasiun dapur"
                htmlFor="product-station"
                error={state.fieldErrors?.kitchenStation}
                hint="Opsional, dipakai untuk filter KDS."
              >
                <Select
                  name="kitchenStation"
                  defaultValue={product?.kitchen_station ?? "none"}
                >
                  <SelectTrigger id="product-station" className="w-full">
                    <SelectValue placeholder="Tanpa stasiun" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Tanpa stasiun</SelectItem>
                    {KITCHEN_STATIONS.map((station) => (
                      <SelectItem key={station} value={station}>
                        {KITCHEN_STATION_LABELS[station]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField
                label="Urutan tampil"
                htmlFor="product-sort-order"
                error={state.fieldErrors?.sortOrder}
                hint="Angka lebih kecil tampil lebih dulu."
              >
                <Input
                  id="product-sort-order"
                  name="sortOrder"
                  type="number"
                  min={0}
                  max={9999}
                  step={1}
                  defaultValue={product?.sort_order ?? defaultSortOrder}
                  required
                />
              </FormField>

              <div className="sm:col-span-2">
                <FormField
                  label="Deskripsi singkat"
                  htmlFor="product-description"
                  error={state.fieldErrors?.description}
                  hint="Opsional, maksimal 500 karakter."
                >
                  <Textarea
                    id="product-description"
                    name="description"
                    defaultValue={product?.description ?? ""}
                    placeholder="Bahan utama, porsi, atau catatan singkat."
                    maxLength={500}
                    rows={3}
                  />
                </FormField>
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <input
              type="hidden"
              name="isActive"
              value={isActive ? "true" : "false"}
            />
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Produk aktif
                </p>
                <p className="text-xs text-muted-foreground">
                  Nonaktif berarti tidak dijual.
                </p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                aria-label="Status aktif produk"
              />
            </div>

            <input
              type="hidden"
              name="isAvailable"
              value={isAvailable ? "true" : "false"}
            />
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Tersedia
                </p>
                <p className="text-xs text-muted-foreground">
                  Bisa dimatikan saat bahan habis.
                </p>
              </div>
              <Switch
                checked={isAvailable}
                onCheckedChange={setIsAvailable}
                aria-label="Ketersediaan produk"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Grup modifier
                </p>
                <p className="text-xs text-muted-foreground">
                  Pilih grup yang berlaku untuk produk ini.
                </p>
              </div>
              <Badge variant="outline">
                {modifierGroups.length} grup tersedia
              </Badge>
            </div>

            {modifierGroups.length === 0 ? (
              <div className="rounded-lg border border-dashed px-3 py-4 text-xs text-muted-foreground">
                Belum ada grup modifier. Buat grup di tab Modifier terlebih
                dahulu.
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {modifierGroups.map((group) => (
                  <label
                    key={group.id}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      name="modifierGroupIds"
                      value={group.id}
                      defaultChecked={product?.modifier_group_ids.includes(
                        group.id,
                      )}
                      className="mt-0.5 size-4 shrink-0 accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium text-foreground">
                          {group.name}
                        </span>
                        <Badge variant="outline" className="text-[0.6rem]">
                          {MODIFIER_SELECTION_LABELS[group.selection_type]}
                        </Badge>
                        {group.is_required ? (
                          <Badge variant="secondary" className="text-[0.6rem]">
                            Wajib
                          </Badge>
                        ) : null}
                        {!group.is_active ? (
                          <Badge variant="outline" className="text-[0.6rem]">
                            Nonaktif
                          </Badge>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Min {group.min_select} · Maks {group.max_select}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {state.fieldErrors?.modifierGroupIds ? (
              <p className="text-xs text-destructive">
                {state.fieldErrors.modifierGroupIds}
              </p>
            ) : null}
          </div>

          <FormError
            message={state.status === "error" ? state.message : undefined}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Batal
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? (
                <>
                  <LoaderCircle className="animate-spin" />
                  Menyimpan...
                </>
              ) : (
                <>
                  <UtensilsCrossed />
                  {product ? "Simpan perubahan" : "Buat produk"}
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProductManager({
  products,
  categories,
  modifierGroups,
}: ProductManagerProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProductWithModifiers | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<ProductWithModifiers | null>(null);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [isPending, startTransition] = useTransition();

  const categoryMap = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );

  const filteredProducts = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    return products.filter((product) => {
      const matchesQuery =
        !normalized ||
        product.name.toLowerCase().includes(normalized) ||
        (product.sku ?? "").toLowerCase().includes(normalized);
      const matchesCategory =
        categoryFilter === "all" || product.category_id === categoryFilter;
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && product.is_active) ||
        (statusFilter === "inactive" && !product.is_active) ||
        (statusFilter === "available" && product.is_available) ||
        (statusFilter === "unavailable" && !product.is_available);

      return matchesQuery && matchesCategory && matchesStatus;
    });
  }, [categoryFilter, products, query, statusFilter]);

  const defaultSortOrder =
    products.reduce(
      (maximum, product) => Math.max(maximum, product.sort_order),
      0,
    ) + 10;

  function runAction(action: () => Promise<MenuActionState>) {
    startTransition(async () => {
      const result = await action();

      if (result.status === "success") {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <>
      <Card>
        <CardHeader className="gap-3 border-b border-border">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Produk</CardTitle>
              <CardDescription>
                {products.length} produk. Atur harga, foto, ketersediaan, dan
                modifier per produk.
              </CardDescription>
            </div>
            <Button
              size="sm"
              disabled={categories.length === 0}
              title={
                categories.length === 0
                  ? "Tambahkan kategori terlebih dahulu."
                  : undefined
              }
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus />
              Tambah produk
            </Button>
          </div>

          <div className="grid gap-2 sm:grid-cols-[1fr_11rem_11rem]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Cari nama atau SKU..."
                className="pl-8"
                aria-label="Cari produk"
              />
            </div>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-full" aria-label="Filter kategori">
                <SelectValue placeholder="Semua kategori" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Semua kategori</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value as StatusFilter)}
            >
              <SelectTrigger className="w-full" aria-label="Filter status">
                <SelectValue placeholder="Semua status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Semua status</SelectItem>
                <SelectItem value="active">Aktif</SelectItem>
                <SelectItem value="inactive">Nonaktif</SelectItem>
                <SelectItem value="available">Tersedia</SelectItem>
                <SelectItem value="unavailable">Tidak tersedia</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>

        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produk</TableHead>
                  <TableHead>Kategori</TableHead>
                  <TableHead>Harga</TableHead>
                  <TableHead>Modifier</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24 text-right">
                    <span className="sr-only">Aksi</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredProducts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center">
                      <p className="text-sm font-medium text-foreground">
                        {products.length === 0
                          ? "Belum ada produk"
                          : "Tidak ada produk yang cocok"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {products.length === 0
                          ? "Tambahkan produk pertama untuk mulai menjual."
                          : "Ubah kata kunci atau filter kategori/status."}
                      </p>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredProducts.map((product) => {
                    const category = categoryMap.get(product.category_id);

                    return (
                      <TableRow key={product.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <ProductPhoto
                              src={product.photo_url}
                              alt={product.name}
                              className="size-11 shrink-0"
                              sizes="44px"
                            />
                            <div className="min-w-0">
                              <p className="font-medium text-foreground">
                                {product.name}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {product.sku ?? "Tanpa SKU"}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span
                              className="size-2.5 shrink-0 rounded-full border border-black/10"
                              style={{
                                backgroundColor: category?.color ?? "#c7d2cf",
                              }}
                            />
                            <span className="text-sm">
                              {category?.name ?? "Tanpa kategori"}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-medium tabular-nums">
                          {formatRupiah(product.price)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {product.modifier_group_ids.length} grup
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={product.is_available}
                                disabled={isPending}
                                onCheckedChange={(checked) =>
                                  runAction(() =>
                                    setProductStatusAction(
                                      product.id,
                                      "is_available",
                                      checked,
                                    ),
                                  )
                                }
                                aria-label={`Ketersediaan ${product.name}`}
                              />
                              <span className="text-xs text-muted-foreground">
                                {product.is_available
                                  ? "Tersedia"
                                  : "Tidak tersedia"}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <span
                                className={
                                  product.is_active
                                    ? "size-1.5 rounded-full bg-success"
                                    : "size-1.5 rounded-full bg-muted-foreground/40"
                                }
                              />
                              {product.is_active ? "Aktif" : "Nonaktif"}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => {
                                setEditing(product);
                                setFormOpen(true);
                              }}
                              aria-label={`Ubah ${product.name}`}
                            >
                              <Pencil />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              disabled={isPending}
                              onClick={() => setDeleteTarget(product)}
                              aria-label={`Hapus ${product.name}`}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {formOpen ? (
        <ProductFormDialog
          key={editing?.id ?? "new"}
          product={editing}
          categories={categories}
          modifierGroups={modifierGroups}
          defaultSortOrder={defaultSortOrder}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      ) : null}

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus produk?</AlertDialogTitle>
            <AlertDialogDescription>
              Produk{" "}
              <span className="font-medium text-foreground">
                {deleteTarget?.name}
              </span>{" "}
              beserta relasi modifier dan fotonya akan dihapus permanen.
              Tindakan ini tercatat di audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Batal</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isPending}
              onClick={(event) => {
                event.preventDefault();
                const target = deleteTarget;

                if (!target) {
                  return;
                }

                startTransition(async () => {
                  const result = await deleteProductAction(target.id);

                  if (result.status === "success") {
                    toast.success(result.message);
                    setDeleteTarget(null);
                  } else {
                    toast.error(result.message);
                  }
                });
              }}
            >
              {isPending ? (
                <>
                  <LoaderCircle className="animate-spin" />
                  Menghapus...
                </>
              ) : (
                <>
                  <Trash2 />
                  Hapus produk
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
