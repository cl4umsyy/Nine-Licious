"use client";

import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import {
  Circle,
  Layers,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Square,
  Trash2,
  Users,
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
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
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
  FLOOR_PLAN_HEIGHT,
  FLOOR_PLAN_WIDTH,
  TABLE_SHAPE_LABELS,
  TABLE_STATUS_LABELS,
} from "@/lib/tables/constants";
import {
  deleteTableAction,
  saveTableAction,
  setTableActiveAction,
} from "@/lib/tables/actions";
import type { TableActionState } from "@/lib/tables/action-types";
import type { DiningTable, TableShape, TableStatus, TableZone } from "@/types/database";

type TableManagerProps = {
  tables: DiningTable[];
  zones: TableZone[];
  onOpenCreate?: () => void;
};

const initialState: TableActionState = { status: "idle" };

const STATUS_BADGES: Record<TableStatus, { class: string; label: string }> = {
  empty: {
    class:
      "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-200",
    label: "Kosong",
  },
  awaiting_payment: {
    class:
      "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950/60 dark:text-amber-200",
    label: "Menunggu Bayar",
  },
  occupied: {
    class:
      "bg-rose-100 text-rose-900 border-rose-300 dark:bg-rose-950/60 dark:text-rose-200",
    label: "Terisi",
  },
};

export function TableFormDialog({
  table,
  zones,
  defaultZoneId,
  onClose,
}: {
  table: DiningTable | null;
  zones: TableZone[];
  defaultZoneId?: string;
  onClose: () => void;
}) {
  const [state, formAction, isPending] = useActionState(
    saveTableAction,
    initialState,
  );

  const activeZones = useMemo(
    () => zones.filter((z) => z.is_active || z.id === table?.zone_id),
    [zones, table],
  );

  const [selectedZoneId, setSelectedZoneId] = useState<string>(
    table?.zone_id ?? defaultZoneId ?? activeZones[0]?.id ?? "",
  );
  const [shape, setShape] = useState<TableShape>(table?.shape ?? "rectangle");
  const [isActive, setIsActive] = useState(table?.is_active ?? true);

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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{table ? "Ubah data meja" : "Tambah meja baru"}</DialogTitle>
          <DialogDescription>
            Atur nomor/nama meja, kapasitas, area, bentuk fisik, dan posisi pada denah.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="space-y-4">
          {table ? <input type="hidden" name="id" value={table.id} /> : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="Nomor / nama meja"
              htmlFor="table-name"
              error={state.fieldErrors?.name}
              hint="Unik di seluruh restoran."
            >
              <Input
                id="table-name"
                name="name"
                defaultValue={table?.name ?? ""}
                placeholder="Contoh: Meja 01, VIP-1"
                autoFocus
              />
            </FormField>

            <FormField
              label="Area / zona"
              htmlFor="table-zone"
              error={state.fieldErrors?.zoneId}
            >
              <input type="hidden" name="zoneId" value={selectedZoneId} />
              <Select value={selectedZoneId} onValueChange={setSelectedZoneId}>
                <SelectTrigger id="table-zone" className="w-full">
                  <SelectValue placeholder="Pilih area meja" />
                </SelectTrigger>
                <SelectContent>
                  {activeZones.map((zone) => (
                    <SelectItem key={zone.id} value={zone.id}>
                      {zone.name}
                      {!zone.is_active ? " (nonaktif)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="Kapasitas (kursi)"
              htmlFor="table-capacity"
              error={state.fieldErrors?.capacity}
              hint="Jumlah orang/tamu (1–50)."
            >
              <Input
                id="table-capacity"
                name="capacity"
                type="number"
                min={1}
                max={50}
                defaultValue={table?.capacity ?? 4}
              />
            </FormField>

            <FormField
              label="Bentuk meja"
              htmlFor="table-shape"
              error={state.fieldErrors?.shape}
            >
              <input type="hidden" name="shape" value={shape} />
              <Select
                value={shape}
                onValueChange={(val) => setShape(val as TableShape)}
              >
                <SelectTrigger id="table-shape" className="w-full">
                  <SelectValue placeholder="Pilih bentuk meja" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rectangle">
                    <span className="flex items-center gap-2">
                      <Square className="size-3.5" />
                      Persegi panjang
                    </span>
                  </SelectItem>
                  <SelectItem value="round">
                    <span className="flex items-center gap-2">
                      <Circle className="size-3.5" />
                      Bulat
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="rounded-xl border p-3.5 bg-muted/20 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Koordinat Posisi pada Denah
              </span>
              <span className="text-[11px] text-muted-foreground">
                Dapat juga digeser langsung di tab Denah
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField
                label="Posisi X"
                htmlFor="table-position-x"
                error={state.fieldErrors?.positionX}
                hint={`Maksimal ${FLOOR_PLAN_WIDTH}`}
              >
                <Input
                  id="table-position-x"
                  name="positionX"
                  type="number"
                  min={0}
                  max={FLOOR_PLAN_WIDTH}
                  defaultValue={table?.position_x ?? 50}
                />
              </FormField>

              <FormField
                label="Posisi Y"
                htmlFor="table-position-y"
                error={state.fieldErrors?.positionY}
                hint={`Maksimal ${FLOOR_PLAN_HEIGHT}`}
              >
                <Input
                  id="table-position-y"
                  name="positionY"
                  type="number"
                  min={0}
                  max={FLOOR_PLAN_HEIGHT}
                  defaultValue={table?.position_y ?? 50}
                />
              </FormField>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-xl border p-3">
            <div className="space-y-0.5">
              <span className="text-xs font-medium">Status aktif</span>
              <p className="text-[0.7rem] text-muted-foreground">
                Meja aktif dapat dipilih untuk kunjungan dine-in kasir.
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
              ) : table ? (
                "Simpan perubahan"
              ) : (
                "Tambah meja"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TableManager({ tables, zones }: TableManagerProps) {
  const [editingTable, setEditingTable] = useState<DiningTable | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deletingTable, setDeletingTable] = useState<DiningTable | null>(null);

  const [selectedZoneFilter, setSelectedZoneFilter] = useState<string>("all");
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const zoneMap = useMemo(
    () => new Map(zones.map((z) => [z.id, z.name])),
    [zones],
  );

  const filteredTables = useMemo(() => {
    return tables.filter((table) => {
      if (selectedZoneFilter !== "all" && table.zone_id !== selectedZoneFilter) {
        return false;
      }
      if (
        selectedStatusFilter !== "all" &&
        table.status !== selectedStatusFilter
      ) {
        return false;
      }
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const matchesName = table.name.toLowerCase().includes(query);
        const zoneName = zoneMap.get(table.zone_id) ?? "";
        const matchesZone = zoneName.toLowerCase().includes(query);
        if (!matchesName && !matchesZone) {
          return false;
        }
      }
      return true;
    });
  }, [tables, selectedZoneFilter, selectedStatusFilter, searchQuery, zoneMap]);

  const handleToggleActive = (table: DiningTable, nextActive: boolean) => {
    setPendingActionId(`active-${table.id}`);
    startTransition(async () => {
      const result = await setTableActiveAction(table.id, nextActive);
      setPendingActionId(null);
      if (result.status === "success") {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  };

  const handleDelete = (table: DiningTable) => {
    setPendingActionId(`delete-${table.id}`);
    startTransition(async () => {
      const result = await deleteTableAction(table.id);
      setPendingActionId(null);
      setDeletingTable(null);
      if (result.status === "success") {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  };

  return (
    <div className="space-y-4">
      {/* Action and Filter Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2 flex-1">
          <div className="relative min-w-44 flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari meja..."
              className="h-8 pl-8 text-xs"
            />
          </div>

          <Select
            value={selectedZoneFilter}
            onValueChange={setSelectedZoneFilter}
          >
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue placeholder="Semua Area" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Semua Area</SelectItem>
              {zones.map((zone) => (
                <SelectItem key={zone.id} value={zone.id}>
                  {zone.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={selectedStatusFilter}
            onValueChange={setSelectedStatusFilter}
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue placeholder="Semua Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Semua Status</SelectItem>
              <SelectItem value="empty">Kosong</SelectItem>
              <SelectItem value="awaiting_payment">Menunggu Bayar</SelectItem>
              <SelectItem value="occupied">Terisi</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button
          type="button"
          size="sm"
          onClick={() => setIsCreating(true)}
          className="h-8 text-xs shrink-0"
        >
          <Plus className="size-3.5 mr-1.5" />
          Tambah Meja
        </Button>
      </div>

      {/* Table List Card */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nomor Meja</TableHead>
                <TableHead>Area</TableHead>
                <TableHead>Kapasitas</TableHead>
                <TableHead>Bentuk</TableHead>
                <TableHead>Koordinat</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Aktif</TableHead>
                <TableHead className="text-right">Aksi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTables.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="h-28 text-center text-xs text-muted-foreground"
                  >
                    Tidak ada meja yang sesuai dengan filter.
                  </TableCell>
                </TableRow>
              ) : (
                filteredTables.map((table) => {
                  const isToggling = pendingActionId === `active-${table.id}`;
                  const statusInfo = STATUS_BADGES[table.status];

                  return (
                    <TableRow key={table.id}>
                      <TableCell className="font-semibold text-sm">
                        {table.name}
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="inline-flex items-center gap-1">
                          <Layers className="size-3 text-muted-foreground" />
                          {zoneMap.get(table.zone_id) ?? "-"}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="inline-flex items-center gap-1 font-medium">
                          <Users className="size-3 text-muted-foreground" />
                          {table.capacity} orang
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          {table.shape === "round" ? (
                            <Circle className="size-3" />
                          ) : (
                            <Square className="size-3" />
                          )}
                          {TABLE_SHAPE_LABELS[table.shape]}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">
                        {table.position_x}, {table.position_y}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium border ${statusInfo.class}`}
                        >
                          {statusInfo.label}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Switch
                            checked={table.is_active}
                            disabled={isToggling}
                            onCheckedChange={(checked) =>
                              handleToggleActive(table, checked)
                            }
                          />
                          <span className="text-[11px] text-muted-foreground">
                            {table.is_active ? "Aktif" : "Nonaktif"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => setEditingTable(table)}
                            className="size-8"
                            title="Ubah meja"
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeletingTable(table)}
                            className="size-8 text-destructive hover:text-destructive"
                            title="Hapus meja"
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
      {(isCreating || editingTable) && (
        <TableFormDialog
          table={editingTable}
          zones={zones}
          defaultZoneId={
            selectedZoneFilter !== "all" ? selectedZoneFilter : undefined
          }
          onClose={() => {
            setIsCreating(false);
            setEditingTable(null);
          }}
        />
      )}

      {/* Delete Confirmation Alert */}
      <AlertDialog
        open={Boolean(deletingTable)}
        onOpenChange={(open) => {
          if (!open) setDeletingTable(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus meja {deletingTable?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingTable && deletingTable.status !== "empty" ? (
                <span className="text-destructive font-medium">
                  Meja ini sedang digunakan (status:{" "}
                  {TABLE_STATUS_LABELS[deletingTable.status]}). Selesaikan transaksi atau
                  kosongkan meja terlebih dahulu sebelum menghapus.
                </span>
              ) : (
                "Meja yang belum memiliki riwayat pesanan dapat dihapus. Jika meja memiliki riwayat transaksi, gunakan opsi nonaktifkan agar data audit tetap utuh."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingTable && handleDelete(deletingTable)}
              disabled={
                Boolean(deletingTable && deletingTable.status !== "empty") ||
                pendingActionId === `delete-${deletingTable?.id}`
              }
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              {pendingActionId === `delete-${deletingTable?.id}` ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                "Hapus meja"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
