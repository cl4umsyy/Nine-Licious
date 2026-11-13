"use client";

import { useId, useState, useTransition } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Filter,
  LoaderCircle,
  Pencil,
  Percent,
  Plus,
  Search,
  Tag,
  Trash2,
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import {
  deleteDiscountAction,
  saveDiscountAction,
  setDiscountActiveAction,
} from "@/lib/discounts/actions";
import type {
  DiscountFormData,
  DiscountWithTargets,
} from "@/lib/discounts/types";
import { formatRupiah } from "@/lib/menu/format";
import type { DiscountType, MenuCategory, Product } from "@/types/database";

export type DiscountManagementProps = {
  initialDiscounts: DiscountWithTargets[];
  categories: MenuCategory[];
  products: Product[];
};

export function DiscountManagement({
  initialDiscounts,
  categories,
  products,
}: DiscountManagementProps) {
  const [discounts, setDiscounts] =
    useState<DiscountWithTargets[]>(initialDiscounts);
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<"all" | "product" | "order">(
    "all",
  );
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">(
    "all",
  );

  // Modal State
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingDiscount, setEditingDiscount] =
    useState<DiscountWithTargets | null>(null);
  const [deletingDiscount, setDeletingDiscount] =
    useState<DiscountWithTargets | null>(null);

  // Form State
  const [formName, setFormName] = useState("");
  const [formScope, setFormScope] = useState<"product" | "order">("order");
  const [formTargetType, setFormTargetType] = useState<
    "all" | "category" | "product"
  >("all");
  const [formCategoryId, setFormCategoryId] = useState<string>("");
  const [formProductId, setFormProductId] = useState<string>("");
  const [formDiscountType, setFormDiscountType] =
    useState<DiscountType>("percentage");
  const [formDiscountValue, setFormDiscountValue] = useState<number>(10);
  const [formMinOrderAmount, setFormMinOrderAmount] = useState<number>(0);
  const [formMaxDiscountAmount, setFormMaxDiscountAmount] = useState<
    number | null
  >(null);
  const [formIsActive, setFormIsActive] = useState(true);
  const [formFieldErrors, setFormFieldErrors] = useState<
    Record<string, string>
  >({});

  const [isPending, startTransition] = useTransition();

  // Reset form
  const handleOpenCreate = () => {
    setEditingDiscount(null);
    setFormName("");
    setFormScope("order");
    setFormTargetType("all");
    setFormCategoryId("");
    setFormProductId("");
    setFormDiscountType("percentage");
    setFormDiscountValue(10);
    setFormMinOrderAmount(0);
    setFormMaxDiscountAmount(null);
    setFormIsActive(true);
    setFormFieldErrors({});
    setIsFormOpen(true);
  };

  const handleOpenEdit = (item: DiscountWithTargets) => {
    setEditingDiscount(item);
    setFormName(item.name);
    setFormScope(item.scope);

    if (item.applies_to_product_id) {
      setFormTargetType("product");
      setFormProductId(item.applies_to_product_id);
      setFormCategoryId("");
    } else if (item.applies_to_category_id) {
      setFormTargetType("category");
      setFormCategoryId(item.applies_to_category_id);
      setFormProductId("");
    } else {
      setFormTargetType("all");
      setFormCategoryId("");
      setFormProductId("");
    }

    setFormDiscountType(item.discount_type);
    setFormDiscountValue(item.discount_value);
    setFormMinOrderAmount(item.min_order_amount ?? 0);
    setFormMaxDiscountAmount(item.max_discount_amount);
    setFormIsActive(item.is_active);
    setFormFieldErrors({});
    setIsFormOpen(true);
  };

  // Submit Save
  const handleSaveDiscount = () => {
    setFormFieldErrors({});

    const payload: DiscountFormData = {
      id: editingDiscount?.id,
      name: formName.trim(),
      scope: formScope,
      discountType: formDiscountType,
      discountValue: Number(formDiscountValue) || 0,
      appliesToCategoryId:
        formScope === "product" && formTargetType === "category" && formCategoryId
          ? formCategoryId
          : null,
      appliesToProductId:
        formScope === "product" && formTargetType === "product" && formProductId
          ? formProductId
          : null,
      minOrderAmount: Number(formMinOrderAmount) || 0,
      maxDiscountAmount:
        formDiscountType === "percentage" && formMaxDiscountAmount
          ? Number(formMaxDiscountAmount)
          : null,
      isActive: formIsActive,
    };

    startTransition(async () => {
      const result = await saveDiscountAction(payload);
      if (result.ok && result.data) {
        toast.success(result.message);

        // Update local state
        const saved = result.data;
        const categoryName = saved.applies_to_category_id
          ? categories.find((c) => c.id === saved.applies_to_category_id)?.name
          : null;
        const productName = saved.applies_to_product_id
          ? products.find((p) => p.id === saved.applies_to_product_id)?.name
          : null;

        const updatedItem: DiscountWithTargets = {
          ...saved,
          categoryName,
          productName,
        };

        setDiscounts((prev) => {
          const index = prev.findIndex((d) => d.id === saved.id);
          if (index > -1) {
            const next = [...prev];
            next[index] = updatedItem;
            return next;
          }
          return [updatedItem, ...prev];
        });

        setIsFormOpen(false);
      } else {
        toast.error(result.message || "Gagal menyimpan promo diskon.");
        if (!result.ok && result.fieldErrors) {
          setFormFieldErrors(result.fieldErrors);
        }
      }
    });
  };

  // Quick Toggle Active
  const handleToggleActive = (item: DiscountWithTargets, checked: boolean) => {
    startTransition(async () => {
      const result = await setDiscountActiveAction(item.id, checked);
      if (result.ok) {
        toast.success(result.message);
        setDiscounts((prev) =>
          prev.map((d) => (d.id === item.id ? { ...d, is_active: checked } : d)),
        );
      } else {
        toast.error(result.message);
      }
    });
  };

  // Submit Delete
  const handleDeleteDiscount = () => {
    if (!deletingDiscount) return;
    startTransition(async () => {
      const result = await deleteDiscountAction(deletingDiscount.id);
      if (result.ok) {
        toast.success(result.message);
        setDiscounts((prev) => prev.filter((d) => d.id !== deletingDiscount.id));
        setDeletingDiscount(null);
      } else {
        toast.error(result.message);
      }
    });
  };

  // Filtered List
  const filteredDiscounts = discounts.filter((d) => {
    if (search.trim()) {
      const query = search.toLowerCase();
      const matchName = d.name.toLowerCase().includes(query);
      const matchTarget =
        d.productName?.toLowerCase().includes(query) ||
        d.categoryName?.toLowerCase().includes(query);
      if (!matchName && !matchTarget) return false;
    }

    if (scopeFilter !== "all" && d.scope !== scopeFilter) {
      return false;
    }

    if (statusFilter === "active" && !d.is_active) return false;
    if (statusFilter === "inactive" && d.is_active) return false;

    return true;
  });

  // KPI stats
  const activeCount = discounts.filter((d) => d.is_active).length;
  const orderScopeCount = discounts.filter((d) => d.scope === "order").length;
  const productScopeCount = discounts.filter((d) => d.scope === "product").length;

  const scopeFieldId = useId();

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-border/70 shadow-sm bg-card">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs">Total Master Promo</CardDescription>
            <CardTitle className="text-2xl font-bold font-display">
              {discounts.length}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-xs text-muted-foreground">
            Dikelola oleh Admin
          </CardContent>
        </Card>

        <Card className="border-border/70 shadow-sm bg-card">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs">Promo Aktif</CardDescription>
            <CardTitle className="text-2xl font-bold font-display text-emerald-600 dark:text-emerald-400">
              {activeCount}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-xs text-muted-foreground">
            Tersedia untuk kasir di POS
          </CardContent>
        </Card>

        <Card className="border-border/70 shadow-sm bg-card">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs">Promo Pesanan (Order)</CardDescription>
            <CardTitle className="text-2xl font-bold font-display text-primary">
              {orderScopeCount}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-xs text-muted-foreground">
            Potongan total belanja
          </CardContent>
        </Card>

        <Card className="border-border/70 shadow-sm bg-card">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs">Diskon Produk</CardDescription>
            <CardTitle className="text-2xl font-bold font-display text-indigo-600 dark:text-indigo-400">
              {productScopeCount}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-xs text-muted-foreground">
            Potongan spesifik menu
          </CardContent>
        </Card>
      </div>

      {/* Main Table Card */}
      <Card className="border-border/80 shadow-sm bg-card">
        <CardHeader className="p-5 border-b space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="text-lg font-bold font-display">
                Daftar Kebijakan Promo & Diskon
              </CardTitle>
              <CardDescription className="text-xs">
                Atur aturan promosi produk, diskon pesanan, batas maksimal, dan syarat minimal belanja.
              </CardDescription>
            </div>
            <Button
              type="button"
              size="sm"
              onClick={handleOpenCreate}
              className="h-9 font-semibold text-xs bg-primary text-primary-foreground shadow"
            >
              <Plus className="size-3.5 mr-1.5" />
              Tambah Promo Diskon
            </Button>
          </div>

          {/* Search & Filters */}
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Cari nama promo atau target menu..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-xs"
              />
            </div>

            <Select
              value={scopeFilter}
              onValueChange={(val: "all" | "product" | "order") => setScopeFilter(val)}
            >
              <SelectTrigger className="h-8 text-xs">
                <Filter className="size-3 mr-1.5 text-muted-foreground" />
                <SelectValue placeholder="Cakupan Diskon" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Semua Cakupan</SelectItem>
                <SelectItem value="order">Promo Pesanan (Order)</SelectItem>
                <SelectItem value="product">Diskon Produk</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={statusFilter}
              onValueChange={(val: "all" | "active" | "inactive") => setStatusFilter(val)}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Status Aktif" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Semua Status</SelectItem>
                <SelectItem value="active">Hanya Aktif</SelectItem>
                <SelectItem value="inactive">Hanya Nonaktif</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>

        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/40 text-xs">
              <TableRow>
                <TableHead className="w-[200px]">Nama Promo</TableHead>
                <TableHead>Cakupan</TableHead>
                <TableHead>Jenis & Nilai</TableHead>
                <TableHead>Target Berlaku</TableHead>
                <TableHead>Syarat & Batas</TableHead>
                <TableHead className="w-[100px] text-center">Status</TableHead>
                <TableHead className="w-[100px] text-right">Aksi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="text-xs">
              {filteredDiscounts.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="h-32 text-center text-muted-foreground"
                  >
                    <div className="flex flex-col items-center justify-center space-y-1.5">
                      <Tag className="size-6 text-muted-foreground/40" />
                      <p className="font-semibold text-sm">Tidak ada promo ditemukan</p>
                      <p className="text-xs">
                        Silakan buat promo diskon baru menggunakan tombol di atas.
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filteredDiscounts.map((item) => (
                  <TableRow key={item.id} className="hover:bg-muted/30">
                    <TableCell className="font-bold text-foreground">
                      <div className="space-y-0.5">
                        <div>{item.name}</div>
                        <div className="text-[10px] font-mono text-muted-foreground">
                          ID: {item.id.slice(0, 8)}...
                        </div>
                      </div>
                    </TableCell>

                    <TableCell>
                      {item.scope === "order" ? (
                        <Badge
                          variant="secondary"
                          className="bg-primary/10 text-primary border-primary/20 text-[11px]"
                        >
                          Pesanan (Order)
                        </Badge>
                      ) : (
                        <Badge
                          variant="secondary"
                          className="bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/20 text-[11px]"
                        >
                          Produk
                        </Badge>
                      )}
                    </TableCell>

                    <TableCell>
                      <div className="font-semibold font-mono text-foreground flex items-center gap-1">
                        {item.discount_type === "percentage" ? (
                          <span className="inline-flex items-center text-emerald-600 dark:text-emerald-400 font-bold">
                            <Percent className="size-3 mr-0.5" />
                            {item.discount_value}%
                          </span>
                        ) : (
                          <span className="font-bold text-foreground">
                            {formatRupiah(item.discount_value)}
                          </span>
                        )}
                      </div>
                    </TableCell>

                    <TableCell className="text-muted-foreground">
                      {item.scope === "order" ? (
                        <span className="italic text-[11px]">Seluruh Pesanan</span>
                      ) : item.productName ? (
                        <span className="font-medium text-foreground">
                          Menu: {item.productName}
                        </span>
                      ) : item.categoryName ? (
                        <span className="font-medium text-foreground">
                          Kategori: {item.categoryName}
                        </span>
                      ) : (
                        <span className="text-[11px]">Semua Produk</span>
                      )}
                    </TableCell>

                    <TableCell className="space-y-0.5 text-muted-foreground text-[11px]">
                      {item.min_order_amount > 0 ? (
                        <div>Min: {formatRupiah(item.min_order_amount)}</div>
                      ) : (
                        <div>Tanpa min. belanja</div>
                      )}
                      {item.max_discount_amount && (
                        <div className="text-amber-700 dark:text-amber-400 font-medium">
                          Maks: {formatRupiah(item.max_discount_amount)}
                        </div>
                      )}
                    </TableCell>

                    <TableCell className="text-center">
                      <div className="flex items-center justify-center">
                        <Switch
                          checked={item.is_active}
                          disabled={isPending}
                          onCheckedChange={(checked) =>
                            handleToggleActive(item, checked)
                          }
                          aria-label={`Status aktif ${item.name}`}
                        />
                      </div>
                    </TableCell>

                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7 text-muted-foreground hover:text-foreground"
                          onClick={() => handleOpenEdit(item)}
                          disabled={isPending}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeletingDiscount(item)}
                          disabled={isPending}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Dialog Form Tambah / Ubah Promo */}
      <Dialog open={isFormOpen} onOpenChange={(open) => !open && setIsFormOpen(false)}>
        <DialogContent className="max-w-md sm:max-w-lg p-0 overflow-hidden">
          <DialogHeader className="p-5 pb-3 border-b bg-muted/20">
            <DialogTitle className="text-base font-bold font-display">
              {editingDiscount ? "Ubah Promo Diskon" : "Tambah Promo Diskon Baru"}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Pastikan ketentuan promosi akurat dan sesuai dengan aturan transaksi restoran.
            </DialogDescription>
          </DialogHeader>

          <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto text-xs">
            {/* Nama Promo */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Nama Promo / Diskon</Label>
              <Input
                type="text"
                placeholder="Contoh: Diskon Karyawan, Promo Opening 10%, dsb."
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                maxLength={80}
                className="h-9 text-xs"
              />
              {formFieldErrors.name && (
                <p className="text-[11px] text-destructive flex items-center gap-1">
                  <AlertCircle className="size-3" />
                  {formFieldErrors.name}
                </p>
              )}
            </div>

            {/* Scope (Cakupan Diskon) */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Cakupan Diskon (Scope)</Label>
              <RadioGroup
                value={formScope}
                onValueChange={(val: "product" | "order") => setFormScope(val)}
                className="grid grid-cols-2 gap-2"
              >
                <div className="flex items-center space-x-2 border rounded-xl p-3 cursor-pointer hover:bg-muted/40">
                  <RadioGroupItem value="order" id={`${scopeFieldId}-order`} />
                  <Label htmlFor={`${scopeFieldId}-order`} className="cursor-pointer text-xs space-y-0.5">
                    <span className="font-bold block text-foreground">Pesanan (Order)</span>
                    <span className="text-[10px] text-muted-foreground block">
                      Potongan pada total seluruh pesanan
                    </span>
                  </Label>
                </div>

                <div className="flex items-center space-x-2 border rounded-xl p-3 cursor-pointer hover:bg-muted/40">
                  <RadioGroupItem value="product" id={`${scopeFieldId}-product`} />
                  <Label htmlFor={`${scopeFieldId}-product`} className="cursor-pointer text-xs space-y-0.5">
                    <span className="font-bold block text-foreground">Produk Menu</span>
                    <span className="text-[10px] text-muted-foreground block">
                      Potongan pada item produk tertentu
                    </span>
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {/* Target Options (hanya jika scope = product) */}
            {formScope === "product" && (
              <div className="space-y-3 rounded-xl border p-3.5 bg-muted/20">
                <Label className="text-xs font-semibold">Target Menu Diskon</Label>
                <RadioGroup
                  value={formTargetType}
                  onValueChange={(val: "all" | "category" | "product") =>
                    setFormTargetType(val)
                  }
                  className="space-y-1.5"
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="all" id="target-all" />
                    <Label htmlFor="target-all" className="text-xs cursor-pointer">
                      Berlaku untuk <strong>Semua Produk</strong>
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="category" id="target-cat" />
                    <Label htmlFor="target-cat" className="text-xs cursor-pointer">
                      Berlaku untuk <strong>Kategori Tertentu</strong>
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="product" id="target-prod" />
                    <Label htmlFor="target-prod" className="text-xs cursor-pointer">
                      Berlaku untuk <strong>Satu Produk Spesifik</strong>
                    </Label>
                  </div>
                </RadioGroup>

                {formTargetType === "category" && (
                  <div className="space-y-1 pt-1">
                    <Label className="text-[11px] font-medium text-muted-foreground">
                      Pilih Kategori:
                    </Label>
                    <Select
                      value={formCategoryId}
                      onValueChange={setFormCategoryId}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Pilih Kategori Menu" />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {formTargetType === "product" && (
                  <div className="space-y-1 pt-1">
                    <Label className="text-[11px] font-medium text-muted-foreground">
                      Pilih Produk Menu:
                    </Label>
                    <Select
                      value={formProductId}
                      onValueChange={setFormProductId}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Pilih Produk Menu" />
                      </SelectTrigger>
                      <SelectContent>
                        {products.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name} ({formatRupiah(p.price)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}

            {/* Jenis & Nilai Diskon */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Tipe Diskon</Label>
                <Select
                  value={formDiscountType}
                  onValueChange={(val: DiscountType) => setFormDiscountType(val)}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percentage">Persentase (%)</SelectItem>
                    <SelectItem value="fixed">Nominal Tetap (Rp)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">
                  Nilai Diskon {formDiscountType === "percentage" ? "(%)" : "(Rp)"}
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={formDiscountType === "percentage" ? 100 : undefined}
                  value={formDiscountValue || ""}
                  onChange={(e) => setFormDiscountValue(Number(e.target.value))}
                  className="h-9 text-xs font-mono"
                />
                {formFieldErrors.discountValue && (
                  <p className="text-[11px] text-destructive">
                    {formFieldErrors.discountValue}
                  </p>
                )}
              </div>
            </div>

            {/* Minimal Belanja */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">
                Syarat Minimal Belanja (Rp)
              </Label>
              <Input
                type="number"
                min={0}
                placeholder="0 = Tanpa batas minimal"
                value={formMinOrderAmount || ""}
                onChange={(e) => setFormMinOrderAmount(Number(e.target.value))}
                className="h-9 text-xs font-mono"
              />
              <p className="text-[10px] text-muted-foreground">
                Khusus promo pesanan: total subtotal harus mencapai nominal ini agar promo berlaku.
              </p>
            </div>

            {/* Batas Maksimal Diskon (hanya jika percentage) */}
            {formDiscountType === "percentage" && (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">
                  Batas Maksimal Potongan (Rp, Opsional)
                </Label>
                <Input
                  type="number"
                  min={1}
                  placeholder="Kosongkan jika tanpa batas"
                  value={formMaxDiscountAmount ?? ""}
                  onChange={(e) =>
                    setFormMaxDiscountAmount(
                      e.target.value ? Number(e.target.value) : null,
                    )
                  }
                  className="h-9 text-xs font-mono"
                />
                <p className="text-[10px] text-muted-foreground">
                  Membatasi nominal potongan rupiah maksimal yang diberikan oleh diskon persentase.
                </p>
              </div>
            )}

            {/* Status Aktif */}
            <div className="flex items-center justify-between rounded-xl border p-3 bg-muted/20">
              <div className="space-y-0.5">
                <Label className="text-xs font-semibold">Status Aktif</Label>
                <p className="text-[10px] text-muted-foreground">
                  Hanya promo aktif yang dapat diterapkan oleh kasir di POS.
                </p>
              </div>
              <Switch
                checked={formIsActive}
                onCheckedChange={setFormIsActive}
              />
            </div>
          </div>

          <DialogFooter className="p-4 border-t bg-muted/20 flex-row justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={() => setIsFormOpen(false)}
              className="text-xs"
            >
              Batal
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isPending || !formName.trim()}
              onClick={handleSaveDiscount}
              className="text-xs font-bold bg-primary text-primary-foreground"
            >
              {isPending ? (
                <>
                  <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                  Menyimpan...
                </>
              ) : (
                <>
                  <CheckCircle2 className="size-3.5 mr-1.5" />
                  Simpan Promo
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Alert Dialog Konfirmasi Hapus */}
      <AlertDialog
        open={deletingDiscount !== null}
        onOpenChange={(open) => !open && setDeletingDiscount(null)}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base font-bold font-display">
              Hapus Promo Diskon?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed">
              Apakah Anda yakin ingin menghapus promo{" "}
              <strong>&ldquo;{deletingDiscount?.name}&rdquo;</strong>? Promo yang sudah
              pernah digunakan dalam riwayat pesanan tidak dapat dihapus dan hanya dapat
              dinonaktifkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel size="sm" className="text-xs">
              Batal
            </AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              disabled={isPending}
              onClick={handleDeleteDiscount}
              className="text-xs font-bold bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isPending ? "Menghapus..." : "Ya, Hapus Promo"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
