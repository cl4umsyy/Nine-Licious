"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import {
  LoaderCircle,
  Pencil,
  Plus,
  SlidersHorizontal,
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
import { FormError, FormField } from "@/components/admin/form-field";
import {
  deleteModifierGroupAction,
  deleteModifierOptionAction,
  saveModifierGroupAction,
  saveModifierOptionAction,
  setModifierGroupActiveAction,
  setModifierOptionActiveAction,
} from "@/lib/menu/actions";
import type { MenuActionState } from "@/lib/menu/action-types";
import { MODIFIER_SELECTION_LABELS } from "@/lib/menu/constants";
import { formatPriceDelta } from "@/lib/menu/format";
import type { ModifierGroupWithOptions } from "@/lib/menu/types";
import type {
  ModifierGroup,
  ModifierOption,
  ModifierSelectionType,
} from "@/types/database";

type ModifierManagerProps = {
  groups: ModifierGroupWithOptions[];
};

const initialState: MenuActionState = { status: "idle" };

function ModifierGroupFormDialog({
  group,
  defaultSortOrder,
  onClose,
}: {
  group: ModifierGroup | null;
  defaultSortOrder: number;
  onClose: () => void;
}) {
  const [state, formAction, isPending] = useActionState(
    saveModifierGroupAction,
    initialState,
  );
  const [selectionType, setSelectionType] = useState<ModifierSelectionType>(
    group?.selection_type ?? "single",
  );
  const [isRequired, setIsRequired] = useState(group?.is_required ?? false);
  const [isActive, setIsActive] = useState(group?.is_active ?? true);
  const [minSelect, setMinSelect] = useState(String(group?.min_select ?? 0));
  const [maxSelect, setMaxSelect] = useState(String(group?.max_select ?? 1));

  useEffect(() => {
    if (state.status === "success") {
      toast.success(state.message);
      onClose();
    }
  }, [state, onClose]);

  function handleSelectionTypeChange(value: string) {
    const next = value as ModifierSelectionType;
    setSelectionType(next);

    if (next === "single") {
      setMaxSelect("1");
      setMinSelect(isRequired ? "1" : "0");
    }
  }

  function handleRequiredChange(checked: boolean) {
    setIsRequired(checked);

    if (checked) {
      setMinSelect((current) => (current === "0" ? "1" : current));
    } else {
      setMinSelect("0");
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {group ? "Ubah grup modifier" : "Tambah grup modifier"}
          </DialogTitle>
          <DialogDescription>
            Grup mengatur apakah pelanggan wajib memilih dan berapa banyak
            pilihan yang boleh diambil.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="space-y-4">
          {group ? <input type="hidden" name="id" value={group.id} /> : null}

          <FormField
            label="Nama grup"
            htmlFor="group-name"
            error={state.fieldErrors?.name}
            hint="Contoh: Level pedas, Ukuran, Topping."
          >
            <Input
              id="group-name"
              name="name"
              defaultValue={group?.name ?? ""}
              placeholder="Contoh: Level pedas"
              maxLength={60}
              required
              autoFocus
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Tipe pilihan"
              htmlFor="group-selection-type"
              error={state.fieldErrors?.selectionType}
            >
              <Select
                name="selectionType"
                value={selectionType}
                onValueChange={handleSelectionTypeChange}
              >
                <SelectTrigger id="group-selection-type" className="w-full">
                  <SelectValue placeholder="Pilih tipe" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">Pilihan tunggal</SelectItem>
                  <SelectItem value="multiple">Pilihan ganda</SelectItem>
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label="Urutan tampil"
              htmlFor="group-sort-order"
              error={state.fieldErrors?.sortOrder}
              hint="Angka lebih kecil tampil lebih dulu."
            >
              <Input
                id="group-sort-order"
                name="sortOrder"
                type="number"
                min={0}
                max={9999}
                step={1}
                defaultValue={group?.sort_order ?? defaultSortOrder}
                required
              />
            </FormField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Minimum pilihan"
              htmlFor="group-min-select"
              error={state.fieldErrors?.minSelect}
              hint="Grup opsional memakai minimum 0."
            >
              <Input
                id="group-min-select"
                name="minSelect"
                type="number"
                min={0}
                max={20}
                step={1}
                value={minSelect}
                onChange={(event) => setMinSelect(event.target.value)}
                required
              />
            </FormField>
            <FormField
              label="Maksimum pilihan"
              htmlFor="group-max-select"
              error={state.fieldErrors?.maxSelect}
              hint="Pilihan tunggal selalu maksimum 1."
            >
              <Input
                id="group-max-select"
                name="maxSelect"
                type="number"
                min={1}
                max={20}
                step={1}
                value={maxSelect}
                onChange={(event) => setMaxSelect(event.target.value)}
                required
              />
            </FormField>
          </div>

          <input
            type="hidden"
            name="isRequired"
            value={isRequired ? "true" : "false"}
          />
          <input
            type="hidden"
            name="isActive"
            value={isActive ? "true" : "false"}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-foreground">Wajib</p>
                <p className="text-xs text-muted-foreground">
                  Pelanggan harus memilih.
                </p>
              </div>
              <Switch
                checked={isRequired}
                onCheckedChange={handleRequiredChange}
                aria-label="Grup modifier wajib"
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-foreground">Aktif</p>
                <p className="text-xs text-muted-foreground">
                  Nonaktif tidak ditampilkan di POS.
                </p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                aria-label="Status aktif grup modifier"
              />
            </div>
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
                  <SlidersHorizontal />
                  {group ? "Simpan perubahan" : "Buat grup"}
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ModifierOptionFormDialog({
  group,
  option,
  defaultSortOrder,
  onClose,
}: {
  group: ModifierGroupWithOptions;
  option: ModifierOption | null;
  defaultSortOrder: number;
  onClose: () => void;
}) {
  const [state, formAction, isPending] = useActionState(
    saveModifierOptionAction,
    initialState,
  );
  const [isActive, setIsActive] = useState(option?.is_active ?? true);

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
            {option ? "Ubah opsi" : "Tambah opsi"} · {group.name}
          </DialogTitle>
          <DialogDescription>
            Selisih harga boleh nol atau positif. Harga akhir dihitung saat
            transaksi.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="space-y-4">
          <input type="hidden" name="groupId" value={group.id} />
          {option ? <input type="hidden" name="id" value={option.id} /> : null}
          <input
            type="hidden"
            name="isActive"
            value={isActive ? "true" : "false"}
          />

          <FormField
            label="Nama opsi"
            htmlFor="option-name"
            error={state.fieldErrors?.name}
            hint="Contoh: Level 1, Large, Keju."
          >
            <Input
              id="option-name"
              name="name"
              defaultValue={option?.name ?? ""}
              placeholder="Contoh: Level 1"
              maxLength={60}
              required
              autoFocus
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Selisih harga (Rp)"
              htmlFor="option-price-delta"
              error={state.fieldErrors?.priceDelta}
              hint="Isi 0 bila tidak menambah harga."
            >
              <Input
                id="option-price-delta"
                name="priceDelta"
                type="number"
                min={0}
                max={999_999_999}
                step={1}
                defaultValue={option?.price_delta ?? 0}
                required
              />
            </FormField>
            <FormField
              label="Urutan tampil"
              htmlFor="option-sort-order"
              error={state.fieldErrors?.sortOrder}
              hint="Angka lebih kecil tampil lebih dulu."
            >
              <Input
                id="option-sort-order"
                name="sortOrder"
                type="number"
                min={0}
                max={9999}
                step={1}
                defaultValue={option?.sort_order ?? defaultSortOrder}
                required
              />
            </FormField>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-foreground">
                Opsi aktif
              </p>
              <p className="text-xs text-muted-foreground">
                Opsi nonaktif tidak dapat dipilih.
              </p>
            </div>
            <Switch
              checked={isActive}
              onCheckedChange={setIsActive}
              aria-label="Status aktif opsi modifier"
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
                  <Plus />
                  {option ? "Simpan perubahan" : "Buat opsi"}
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ModifierManager({ groups }: ModifierManagerProps) {
  const [groupFormOpen, setGroupFormOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ModifierGroup | null>(null);
  const [optionFormGroup, setOptionFormGroup] =
    useState<ModifierGroupWithOptions | null>(null);
  const [editingOption, setEditingOption] = useState<ModifierOption | null>(
    null,
  );
  const [deleteGroup, setDeleteGroup] =
    useState<ModifierGroupWithOptions | null>(null);
  const [deleteOption, setDeleteOption] = useState<{
    group: ModifierGroupWithOptions;
    option: ModifierOption;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  const defaultGroupSortOrder =
    groups.reduce(
      (maximum, group) => Math.max(maximum, group.sort_order),
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

  function openNewOption(group: ModifierGroupWithOptions) {
    setEditingOption(null);
    setOptionFormGroup(group);
  }

  function openEditOption(
    group: ModifierGroupWithOptions,
    option: ModifierOption,
  ) {
    setEditingOption(option);
    setOptionFormGroup(group);
  }

  return (
    <>
      <div className="space-y-4">
        <Card>
          <CardHeader className="gap-3 border-b border-border">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>Grup & opsi modifier</CardTitle>
                <CardDescription>
                  {groups.length} grup. Hubungkan grup ke produk pada tab
                  Produk.
                </CardDescription>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  setEditingGroup(null);
                  setGroupFormOpen(true);
                }}
              >
                <Plus />
                Tambah grup
              </Button>
            </div>
          </CardHeader>
          <CardContent className="py-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Level pedas dan ukuran biasanya memakai pilihan tunggal. Topping
              memakai pilihan ganda. Grup wajib harus memiliki minimum minimal
              1 pilihan, dan server menolak batas pilihan yang tidak konsisten.
            </p>
          </CardContent>
        </Card>

        {groups.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
              <SlidersHorizontal className="size-6 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">
                Belum ada grup modifier
              </p>
              <p className="max-w-md text-xs text-muted-foreground">
                Buat grup seperti Level pedas, Ukuran, atau Topping, lalu
                tambahkan opsinya.
              </p>
              <Button
                size="sm"
                className="mt-2"
                onClick={() => {
                  setEditingGroup(null);
                  setGroupFormOpen(true);
                }}
              >
                <Plus />
                Tambah grup modifier
              </Button>
            </CardContent>
          </Card>
        ) : (
          groups.map((group) => (
            <Card key={group.id}>
              <CardHeader className="gap-3 border-b border-border">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <CardTitle>{group.name}</CardTitle>
                      <Badge variant="outline">
                        {MODIFIER_SELECTION_LABELS[group.selection_type]}
                      </Badge>
                      {group.is_required ? (
                        <Badge variant="secondary">Wajib</Badge>
                      ) : (
                        <Badge variant="outline">Opsional</Badge>
                      )}
                      {!group.is_active ? (
                        <Badge variant="outline">Nonaktif</Badge>
                      ) : null}
                    </div>
                    <CardDescription>
                      Min {group.min_select} · Maks {group.max_select} · Urutan{" "}
                      {group.sort_order} · {group.options.length} opsi
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Switch
                      checked={group.is_active}
                      disabled={isPending}
                      onCheckedChange={(checked) =>
                        runAction(() =>
                          setModifierGroupActiveAction(group.id, checked),
                        )
                      }
                      aria-label={`Status aktif ${group.name}`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => {
                        setEditingGroup(group);
                        setGroupFormOpen(true);
                      }}
                      aria-label={`Ubah grup ${group.name}`}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={isPending}
                      onClick={() => setDeleteGroup(group)}
                      aria-label={`Hapus grup ${group.name}`}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="px-0">
                <div className="flex items-center justify-between gap-2 px-4 pb-2">
                  <p className="text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    Opsi
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => openNewOption(group)}
                  >
                    <Plus />
                    Tambah opsi
                  </Button>
                </div>

                {group.options.length === 0 ? (
                  <p className="px-4 pb-4 text-xs text-muted-foreground">
                    Belum ada opsi. Tambahkan minimal satu opsi agar grup dapat
                    dipakai produk.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Opsi</TableHead>
                          <TableHead>Selisih harga</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="w-24 text-right">
                            <span className="sr-only">Aksi</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {group.options.map((option) => (
                          <TableRow key={option.id}>
                            <TableCell>
                              <p className="font-medium text-foreground">
                                {option.name}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Urutan {option.sort_order}
                              </p>
                            </TableCell>
                            <TableCell className="whitespace-nowrap tabular-nums">
                              {formatPriceDelta(option.price_delta)}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <Switch
                                  checked={option.is_active}
                                  disabled={isPending}
                                  onCheckedChange={(checked) =>
                                    runAction(() =>
                                      setModifierOptionActiveAction(
                                        option.id,
                                        checked,
                                      ),
                                    )
                                  }
                                  aria-label={`Status aktif ${option.name}`}
                                />
                                <span className="text-xs text-muted-foreground">
                                  {option.is_active ? "Aktif" : "Nonaktif"}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() =>
                                    openEditOption(group, option)
                                  }
                                  aria-label={`Ubah opsi ${option.name}`}
                                >
                                  <Pencil />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  disabled={isPending}
                                  onClick={() =>
                                    setDeleteOption({ group, option })
                                  }
                                  aria-label={`Hapus opsi ${option.name}`}
                                >
                                  <Trash2 />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {groupFormOpen ? (
        <ModifierGroupFormDialog
          key={editingGroup?.id ?? "new"}
          group={editingGroup}
          defaultSortOrder={defaultGroupSortOrder}
          onClose={() => {
            setGroupFormOpen(false);
            setEditingGroup(null);
          }}
        />
      ) : null}

      {optionFormGroup ? (
        <ModifierOptionFormDialog
          key={editingOption?.id ?? `new-${optionFormGroup.id}`}
          group={optionFormGroup}
          option={editingOption}
          defaultSortOrder={
            optionFormGroup.options.reduce(
              (maximum, option) => Math.max(maximum, option.sort_order),
              0,
            ) + 10
          }
          onClose={() => {
            setOptionFormGroup(null);
            setEditingOption(null);
          }}
        />
      ) : null}

      <AlertDialog
        open={Boolean(deleteGroup)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteGroup(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus grup modifier?</AlertDialogTitle>
            <AlertDialogDescription>
              Grup{" "}
              <span className="font-medium text-foreground">
                {deleteGroup?.name}
              </span>{" "}
              beserta semua opsi dan relasinya ke produk akan dihapus permanen.
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
                const target = deleteGroup;

                if (!target) {
                  return;
                }

                startTransition(async () => {
                  const result = await deleteModifierGroupAction(target.id);

                  if (result.status === "success") {
                    toast.success(result.message);
                    setDeleteGroup(null);
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
                  Hapus grup
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(deleteOption)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteOption(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus opsi modifier?</AlertDialogTitle>
            <AlertDialogDescription>
              Opsi{" "}
              <span className="font-medium text-foreground">
                {deleteOption?.option.name}
              </span>{" "}
              pada grup{" "}
              <span className="font-medium text-foreground">
                {deleteOption?.group.name}
              </span>{" "}
              akan dihapus permanen.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Batal</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isPending}
              onClick={(event) => {
                event.preventDefault();
                const target = deleteOption;

                if (!target) {
                  return;
                }

                startTransition(async () => {
                  const result = await deleteModifierOptionAction(
                    target.option.id,
                  );

                  if (result.status === "success") {
                    toast.success(result.message);
                    setDeleteOption(null);
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
                  Hapus opsi
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
