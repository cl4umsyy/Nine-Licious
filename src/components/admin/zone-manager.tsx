"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import {
  ArrowDown,
  ArrowUp,
  Layers,
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
import { Card, CardContent } from "@/components/ui/card";
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
  deleteZoneAction,
  moveZoneAction,
  saveZoneAction,
  setZoneActiveAction,
} from "@/lib/tables/actions";
import type { TableActionState } from "@/lib/tables/action-types";
import type { ZoneWithTableCount } from "@/lib/tables/types";
import type { TableZone } from "@/types/database";

type ZoneManagerProps = {
  zones: ZoneWithTableCount[];
};

const initialState: TableActionState = { status: "idle" };

function ZoneFormDialog({
  zone,
  defaultSortOrder,
  onClose,
}: {
  zone: TableZone | null;
  defaultSortOrder: number;
  onClose: () => void;
}) {
  const [state, formAction, isPending] = useActionState(
    saveZoneAction,
    initialState,
  );
  const [isActive, setIsActive] = useState(zone?.is_active ?? true);

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
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{zone ? "Ubah area meja" : "Tambah area meja"}</DialogTitle>
          <DialogDescription>
            Area mengelompokkan meja pada denah dan pemesanan kasir.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="space-y-4">
          {zone ? <input type="hidden" name="id" value={zone.id} /> : null}

          <FormField
            label="Nama area"
            htmlFor="zone-name"
            error={state.fieldErrors?.name}
          >
            <Input
              id="zone-name"
              name="name"
              defaultValue={zone?.name ?? ""}
              placeholder="Contoh: Utama, Outdoor, Lantai 2"
              autoFocus
            />
          </FormField>

          <FormField
            label="Urutan tampil"
            htmlFor="zone-sort-order"
            error={state.fieldErrors?.sortOrder}
            hint="Angka lebih kecil tampil lebih dulu pada tab denah."
          >
            <Input
              id="zone-sort-order"
              name="sortOrder"
              type="number"
              min={0}
              max={9999}
              defaultValue={zone?.sort_order ?? defaultSortOrder}
            />
          </FormField>

          <div className="flex items-center justify-between rounded-xl border p-3">
            <div className="space-y-0.5">
              <span className="text-xs font-medium">Status aktif</span>
              <p className="text-[0.7rem] text-muted-foreground">
                Area aktif dapat dipilih untuk meja dan tampil pada kasir.
              </p>
            </div>
            <input type="hidden" name="isActive" value={String(isActive)} />
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          <FormError message={state.status === "error" ? state.message : undefined} />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isPending}
            >
              Batal
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? (
                <>
                  <LoaderCircle className="size-4 mr-2 animate-spin" />
                  Menyimpan...
                </>
              ) : zone ? (
                "Simpan perubahan"
              ) : (
                "Tambah area"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ZoneManager({ zones }: ZoneManagerProps) {
  const [editingZone, setEditingZone] = useState<TableZone | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deletingZone, setDeletingZone] = useState<ZoneWithTableCount | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const handleToggleActive = (zone: ZoneWithTableCount, nextActive: boolean) => {
    if (!nextActive && zone.active_table_count > 0) {
      toast.error(
        `Area ${zone.name} masih memiliki ${zone.active_table_count} meja aktif. Nonaktifkan atau pindahkan meja terlebih dahulu.`,
      );
      return;
    }

    setPendingActionId(`active-${zone.id}`);
    startTransition(async () => {
      const result = await setZoneActiveAction(zone.id, nextActive);
      setPendingActionId(null);
      if (result.status === "success") {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  };

  const handleMove = (zone: ZoneWithTableCount, direction: "up" | "down") => {
    setPendingActionId(`move-${zone.id}`);
    startTransition(async () => {
      const result = await moveZoneAction(zone.id, direction);
      setPendingActionId(null);
      if (result.status === "success") {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  };

  const handleDelete = (zone: ZoneWithTableCount) => {
    setPendingActionId(`delete-${zone.id}`);
    startTransition(async () => {
      const result = await deleteZoneAction(zone.id);
      setPendingActionId(null);
      setDeletingZone(null);
      if (result.status === "success") {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  };

  const nextSortOrder =
    zones.length > 0 ? Math.max(...zones.map((z) => z.sort_order)) + 10 : 10;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-base font-semibold">Area / Zona Meja</h3>
          <p className="text-xs text-muted-foreground">
            Kelola zona restoran seperti Utama, Smoking Area, Lantai 2, atau VIP.
          </p>
        </div>

        <Button
          type="button"
          size="sm"
          onClick={() => setIsCreating(true)}
          className="h-8 text-xs"
        >
          <Plus className="size-3.5 mr-1.5" />
          Tambah Area
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Urutan</TableHead>
                <TableHead>Nama Area</TableHead>
                <TableHead>Jumlah Meja</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Aksi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {zones.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="h-28 text-center text-xs text-muted-foreground"
                  >
                    Belum ada area meja yang dibuat.
                  </TableCell>
                </TableRow>
              ) : (
                zones.map((zone, index) => {
                  const isFirst = index === 0;
                  const isLast = index === zones.length - 1;
                  const isMoving = pendingActionId === `move-${zone.id}`;
                  const isToggling = pendingActionId === `active-${zone.id}`;

                  return (
                    <TableRow key={zone.id}>
                      <TableCell>
                        <div className="flex items-center gap-0.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            disabled={isFirst || isMoving}
                            onClick={() => handleMove(zone, "up")}
                            className="size-7"
                            title="Pindah ke atas"
                          >
                            <ArrowUp className="size-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            disabled={isLast || isMoving}
                            onClick={() => handleMove(zone, "down")}
                            className="size-7"
                            title="Pindah ke bawah"
                          >
                            <ArrowDown className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="font-medium text-sm">
                        <div className="flex items-center gap-2">
                          <Layers className="size-4 text-primary shrink-0" />
                          <span>{zone.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="font-semibold">{zone.table_count}</span> meja
                        {zone.active_table_count < zone.table_count && (
                          <span className="text-muted-foreground ml-1">
                            ({zone.active_table_count} aktif)
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={zone.is_active}
                            disabled={isToggling}
                            onCheckedChange={(checked) =>
                              handleToggleActive(zone, checked)
                            }
                          />
                          <Badge
                            variant={zone.is_active ? "outline" : "secondary"}
                            className="text-[10px]"
                          >
                            {zone.is_active ? "Aktif" : "Nonaktif"}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => setEditingZone(zone)}
                            className="size-8"
                            title="Ubah area"
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeletingZone(zone)}
                            className="size-8 text-destructive hover:text-destructive"
                            title="Hapus area"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create / Edit Dialog */}
      {(isCreating || editingZone) && (
        <ZoneFormDialog
          zone={editingZone}
          defaultSortOrder={nextSortOrder}
          onClose={() => {
            setIsCreating(false);
            setEditingZone(null);
          }}
        />
      )}

      {/* Delete Confirmation Alert */}
      <AlertDialog
        open={Boolean(deletingZone)}
        onOpenChange={(open) => {
          if (!open) setDeletingZone(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus area {deletingZone?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingZone && deletingZone.table_count > 0 ? (
                <span className="text-destructive font-medium">
                  Area ini masih memiliki {deletingZone.table_count} meja. Area yang
                  memiliki meja tidak dapat dihapus. Pindahkan atau hapus semua meja di
                  area ini terlebih dahulu.
                </span>
              ) : (
                "Area yang tidak memiliki meja dapat dihapus secara aman. Tindakan ini tidak dapat dibatalkan."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingZone && handleDelete(deletingZone)}
              disabled={
                Boolean(deletingZone && deletingZone.table_count > 0) ||
                pendingActionId === `delete-${deletingZone?.id}`
              }
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              {pendingActionId === `delete-${deletingZone?.id}` ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                "Hapus area"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
