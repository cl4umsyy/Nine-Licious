"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import {
  ArrowDown,
  ArrowUp,
  FolderTree,
  LoaderCircle,
  Pencil,
  Plus,
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FormError, FormField } from "@/components/admin/form-field";
import {
  deleteCategoryAction,
  moveCategoryAction,
  saveCategoryAction,
  setCategoryActiveAction,
} from "@/lib/menu/actions";
import type { MenuActionState } from "@/lib/menu/action-types";
import type { CategoryWithCount } from "@/lib/menu/types";
import type { MenuCategory } from "@/types/database";

type CategoryManagerProps = {
  categories: CategoryWithCount[];
};

const initialState: MenuActionState = { status: "idle" };

function CategoryFormDialog({
  category,
  defaultSortOrder,
  onClose,
}: {
  category: MenuCategory | null;
  defaultSortOrder: number;
  onClose: () => void;
}) {
  const [state, formAction, isPending] = useActionState(
    saveCategoryAction,
    initialState,
  );
  const [isActive, setIsActive] = useState(category?.is_active ?? true);

  useEffect(() => {
    if (state.status === "success") {
      toast.success(state.message);
      onClose();
    }
  }, [state, onClose]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {category ? "Ubah kategori" : "Tambah kategori"}
          </DialogTitle>
          <DialogDescription>
            Kategori menentukan pengelompokan produk pada POS dan laporan.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="space-y-4">
          {category ? <input type="hidden" name="id" value={category.id} /> : null}

          <FormField
            label="Nama kategori"
            htmlFor="category-name"
            error={state.fieldErrors?.name}
          >
            <Input
              id="category-name"
              name="name"
              defaultValue={category?.name ?? ""}
              placeholder="Contoh: Food"
              maxLength={60}
              required
              autoFocus
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Slug"
              htmlFor="category-slug"
              error={state.fieldErrors?.slug}
              hint="Kosongkan untuk dibuat otomatis dari nama."
            >
              <Input
                id="category-slug"
                name="slug"
                defaultValue={category?.slug ?? ""}
                placeholder="food"
                maxLength={40}
                autoCapitalize="none"
                spellCheck={false}
              />
            </FormField>
            <FormField
              label="Urutan tampil"
              htmlFor="category-sort-order"
              error={state.fieldErrors?.sortOrder}
              hint="Angka lebih kecil tampil lebih dulu."
            >
              <Input
                id="category-sort-order"
                name="sortOrder"
                type="number"
                min={0}
                max={9999}
                step={1}
                defaultValue={category?.sort_order ?? defaultSortOrder}
                required
              />
            </FormField>
          </div>

          <FormField
            label="Warna penanda"
            htmlFor="category-color"
            error={state.fieldErrors?.color}
            hint="Dipakai sebagai aksen kategori pada tampilan menu."
          >
            <div className="flex items-center gap-3">
              <input
                id="category-color"
                name="color"
                type="color"
                defaultValue={category?.color ?? "#0e4f45"}
                className="h-9 w-14 cursor-pointer rounded-lg border border-input bg-card p-1"
              />
              <p className="text-xs text-muted-foreground">
                Pilih warna yang kontras dengan latar terang.
              </p>
            </div>
          </FormField>

          <input
            type="hidden"
            name="isActive"
            value={isActive ? "true" : "false"}
          />
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-foreground">
                Kategori aktif
              </p>
              <p className="text-xs text-muted-foreground">
                Kategori nonaktif tidak ditampilkan pada POS.
              </p>
            </div>
            <Switch
              checked={isActive}
              onCheckedChange={setIsActive}
              aria-label="Status aktif kategori"
            />
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
                  <FolderTree />
                  {category ? "Simpan perubahan" : "Buat kategori"}
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CategoryManager({ categories }: CategoryManagerProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MenuCategory | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CategoryWithCount | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();

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

  const defaultSortOrder =
    categories.reduce(
      (maximum, category) => Math.max(maximum, category.sort_order),
      0,
    ) + 10;

  return (
    <>
      <Card>
        <CardHeader className="gap-3 border-b border-border">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Kategori menu</CardTitle>
              <CardDescription>
                {categories.length} kategori. Urutan di sini menjadi urutan tab
                pada POS.
              </CardDescription>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus />
              Tambah kategori
            </Button>
          </div>
        </CardHeader>

        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">Urutan</TableHead>
                  <TableHead>Kategori</TableHead>
                  <TableHead>Produk</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24 text-right">
                    <span className="sr-only">Aksi</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center">
                      <p className="text-sm font-medium text-foreground">
                        Belum ada kategori
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Tambahkan kategori pertama untuk mulai menyusun menu.
                      </p>
                    </TableCell>
                  </TableRow>
                ) : (
                  categories.map((category, index) => (
                    <TableRow key={category.id}>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            disabled={isPending || index === 0}
                            onClick={() =>
                              runAction(() =>
                                moveCategoryAction(category.id, "up"),
                              )
                            }
                            aria-label={`Naikkan ${category.name}`}
                          >
                            <ArrowUp />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            disabled={isPending || index === categories.length - 1}
                            onClick={() =>
                              runAction(() =>
                                moveCategoryAction(category.id, "down"),
                              )
                            }
                            aria-label={`Turunkan ${category.name}`}
                          >
                            <ArrowDown />
                          </Button>
                          <span className="ml-1 text-xs tabular-nums text-muted-foreground">
                            {category.sort_order}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <span
                            className="size-3 shrink-0 rounded-full border border-black/10"
                            style={{
                              backgroundColor: category.color ?? "#c7d2cf",
                            }}
                          />
                          <div className="min-w-0">
                            <p className="font-medium text-foreground">
                              {category.name}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              /{category.slug}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{category.product_count} produk</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={category.is_active}
                            disabled={isPending}
                            onCheckedChange={(checked) =>
                              runAction(() =>
                                setCategoryActiveAction(category.id, checked),
                              )
                            }
                            aria-label={`Status aktif ${category.name}`}
                          />
                          <span className="text-xs text-muted-foreground">
                            {category.is_active ? "Aktif" : "Nonaktif"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => {
                              setEditing(category);
                              setFormOpen(true);
                            }}
                            aria-label={`Ubah ${category.name}`}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={isPending || category.product_count > 0}
                            title={
                              category.product_count > 0
                                ? "Pindahkan atau hapus produk terlebih dahulu."
                                : "Hapus kategori"
                            }
                            onClick={() => setDeleteTarget(category)}
                            aria-label={`Hapus ${category.name}`}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {formOpen ? (
        <CategoryFormDialog
          key={editing?.id ?? "new"}
          category={editing}
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
            <AlertDialogTitle>Hapus kategori?</AlertDialogTitle>
            <AlertDialogDescription>
              Kategori{" "}
              <span className="font-medium text-foreground">
                {deleteTarget?.name}
              </span>{" "}
              akan dihapus permanen. Tindakan ini tercatat di audit log.
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
                  const result = await deleteCategoryAction(target.id);

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
                  Hapus kategori
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
