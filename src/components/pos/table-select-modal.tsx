"use client";

import { useMemo, useState } from "react";
import { Check, Grid2X2, Layers, MapPin, Users, Utensils } from "lucide-react";
import { FloorPlanCanvas } from "@/components/tables/floor-plan-canvas";
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
import {
  TABLE_SHAPE_LABELS,
  TABLE_STATUS_LABELS,
} from "@/lib/tables/constants";
import { cn } from "@/lib/utils";
import type { DiningTable, TableStatus, TableZone } from "@/types/database";

export type TableSelectModalProps = {
  isOpen: boolean;
  onClose: () => void;
  tables: DiningTable[];
  zones: TableZone[];
  selectedTableId?: string | null;
  onSelectTable: (table: DiningTable) => void;
};

const STATUS_BADGE_CLASSES: Record<TableStatus, string> = {
  empty: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-300",
  awaiting_payment: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950 dark:text-amber-300",
  occupied: "bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950 dark:text-rose-300",
};

export function TableSelectModal({
  isOpen,
  onClose,
  tables,
  zones,
  selectedTableId,
  onSelectTable,
}: TableSelectModalProps) {
  const [activeZoneId, setActiveZoneId] = useState<string>(
    zones[0]?.id ?? "",
  );
  const [tempSelectedTable, setTempSelectedTable] = useState<DiningTable | null>(
    () => tables.find((t) => t.id === selectedTableId) ?? null,
  );
  const [viewMode, setViewMode] = useState<"floor-plan" | "grid">("floor-plan");

  // Sync selected table when prop changes
  const [prevSelectedId, setPrevSelectedId] = useState(selectedTableId);
  if (selectedTableId !== prevSelectedId) {
    setPrevSelectedId(selectedTableId);
    setTempSelectedTable(tables.find((t) => t.id === selectedTableId) ?? null);
  }

  const currentZone = useMemo(
    () => zones.find((z) => z.id === activeZoneId) ?? zones[0],
    [zones, activeZoneId],
  );

  const zoneTables = useMemo(
    () => tables.filter((t) => t.zone_id === currentZone?.id && t.is_active),
    [tables, currentZone],
  );

  const handleConfirm = () => {
    if (tempSelectedTable) {
      onSelectTable(tempSelectedTable);
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[calc(100vw-32px)] sm:max-w-4xl md:max-w-5xl lg:max-w-5xl max-h-[calc(100dvh-32px)] flex flex-col p-0 gap-0 overflow-hidden shadow-2xl rounded-2xl">
        {/* Header Modal */}
        <DialogHeader className="p-4 sm:p-6 pb-4 border-b bg-muted/15 space-y-4 shrink-0">
          {/* Baris 1: Ikon + Judul + Deskripsi (dengan ruang penuh bebas dari tombol aksi) */}
          <div className="flex items-start gap-3.5 pr-10 sm:pr-12">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary shrink-0 mt-0.5 shadow-xs">
              <Utensils className="size-5" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <DialogTitle className="text-lg sm:text-xl font-bold font-display text-foreground tracking-tight leading-snug">
                Pilih Meja Dine-in
              </DialogTitle>
              <DialogDescription className="text-xs sm:text-sm text-muted-foreground leading-normal">
                Pilih meja yang tersedia pada denah restoran untuk pesanan makan di tempat.
              </DialogDescription>
            </div>
          </div>

          {/* Baris 2: Subheader Toolbar (Pilihan Area Restoran & View Mode Switcher) */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-3.5 border-t border-border/50">
            {/* Pilihan Area Restoran */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mr-1 flex items-center gap-1.5">
                <Layers className="size-3.5 text-primary" />
                Area Restoran:
              </span>
              {zones.map((zone) => {
                const isSelected = zone.id === (currentZone?.id ?? "");
                const count = tables.filter((t) => t.zone_id === zone.id && t.is_active).length;
                return (
                  <button
                    key={zone.id}
                    type="button"
                    onClick={() => setActiveZoneId(zone.id)}
                    className={cn(
                      "h-9 px-3.5 text-xs font-semibold rounded-xl transition-all flex items-center gap-2 border cursor-pointer",
                      isSelected
                        ? "bg-primary text-primary-foreground border-primary shadow-xs font-bold"
                        : "bg-card text-muted-foreground border-border hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    <span>Area {zone.name}</span>
                    <span
                      className={cn(
                        "px-1.5 py-0.5 rounded-md text-[10px] font-bold",
                        isSelected
                          ? "bg-white/20 text-white"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {count} meja
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Mode Switcher: Denah Visual vs Daftar Meja */}
            <div className="flex items-center gap-1 bg-muted/60 p-1 rounded-xl border border-border/70 shrink-0 self-start sm:self-auto">
              <button
                type="button"
                onClick={() => setViewMode("floor-plan")}
                className={cn(
                  "px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer",
                  viewMode === "floor-plan"
                    ? "bg-card text-foreground shadow-xs font-bold"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <MapPin className="size-3.5 text-primary" />
                Denah Visual
              </button>
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                className={cn(
                  "px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer",
                  viewMode === "grid"
                    ? "bg-card text-foreground shadow-xs font-bold"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Grid2X2 className="size-3.5 text-primary" />
                Daftar Meja ({zoneTables.length})
              </button>
            </div>
          </div>
        </DialogHeader>

        {/* Modal Body: Denah Visual OR Grid */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 bg-background">
          {zoneTables.length === 0 ? (
            <div className="rounded-2xl border border-dashed p-10 text-center text-muted-foreground space-y-2 bg-muted/10">
              <Layers className="size-10 stroke-[1.5] text-muted-foreground/60 mx-auto" />
              <p className="font-bold text-sm text-foreground">
                Tidak ada meja di Area {currentZone?.name ?? ""}.
              </p>
              <p className="text-xs max-w-md mx-auto">
                Silakan pilih area lain di atas untuk melihat meja yang tersedia.
              </p>
            </div>
          ) : viewMode === "floor-plan" ? (
            <div className="w-full mx-auto max-w-4xl space-y-3">
              <FloorPlanCanvas
                tables={tables}
                zones={zones}
                activeZoneId={currentZone?.id}
                onZoneChange={setActiveZoneId}
                selectable={true}
                selectedTableId={tempSelectedTable?.id}
                onSelectTable={(table) => setTempSelectedTable(table)}
                hideHeader={true}
                hideZoneTabs={true}
              />
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3.5">
              {zoneTables.map((table) => {
                const isSelected = tempSelectedTable?.id === table.id;
                const isOccupied = table.status === "occupied";
                const isAwaitingPayment = table.status === "awaiting_payment";

                return (
                  <button
                    key={table.id}
                    type="button"
                    onClick={() => setTempSelectedTable(table)}
                    className={cn(
                      "relative flex flex-col p-3.5 rounded-xl border text-left transition-all cursor-pointer",
                      isSelected
                        ? "border-primary ring-2 ring-primary/40 bg-brand-soft/30 shadow-md scale-[1.02]"
                        : isOccupied
                        ? "border-rose-300/80 bg-rose-50/20 hover:border-rose-400 hover:bg-rose-50/40 dark:bg-rose-950/20"
                        : isAwaitingPayment
                        ? "border-amber-300/80 bg-amber-50/20 hover:border-amber-400 hover:bg-amber-50/40 dark:bg-amber-950/20"
                        : "border-border/80 bg-card hover:border-primary/50 hover:bg-muted/30 shadow-xs",
                    )}
                  >
                    {/* Header: Table name & Shape */}
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="font-display font-bold text-base truncate text-foreground">
                        {table.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground capitalize">
                        {TABLE_SHAPE_LABELS[table.shape]}
                      </span>
                    </div>

                    {/* Capacity */}
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3">
                      <Users className="size-3.5 text-muted-foreground" />
                      <span>{table.capacity} orang</span>
                    </div>

                    {/* Status Pill */}
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] h-5 justify-center font-semibold border",
                        STATUS_BADGE_CLASSES[table.status],
                      )}
                    >
                      {isOccupied ? "Terisi (Pesanan Tambahan)" : TABLE_STATUS_LABELS[table.status]}
                    </Badge>

                    {/* Note if awaiting payment or occupied */}
                    {isOccupied && (
                      <span className="text-[9px] text-rose-700 dark:text-rose-300 mt-1.5 leading-tight font-medium">
                        Sesi aktif (bisa tambah pesanan)
                      </span>
                    )}
                    {isAwaitingPayment && (
                      <span className="text-[9px] text-amber-700 dark:text-amber-300 mt-1.5 leading-tight font-medium">
                        Ada pesanan belum lunas
                      </span>
                    )}

                    {/* Selected check badge */}
                    {isSelected && (
                      <div className="absolute top-2.5 right-2.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
                        <Check className="size-2.5 stroke-[3]" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="p-4 sm:p-5 px-4 sm:px-6 border-t bg-muted/20 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3.5 shrink-0">
          <div className="text-xs text-muted-foreground flex-1 min-w-0">
            {tempSelectedTable ? (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-foreground text-sm tracking-tight flex items-center gap-1.5">
                    <Utensils className="size-3.5 text-primary" />
                    Meja {tempSelectedTable.name}
                  </span>
                  <Badge variant="outline" className="text-[11px] px-2 py-0.5 font-medium border">
                    <Users className="size-3 mr-1 text-muted-foreground" />
                    {tempSelectedTable.capacity} Orang
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[11px] px-2 py-0.5 font-semibold border",
                      STATUS_BADGE_CLASSES[tempSelectedTable.status],
                    )}
                  >
                    {TABLE_STATUS_LABELS[tempSelectedTable.status]}
                  </Badge>
                </div>
                <span className="text-[11px] text-muted-foreground hidden md:inline">·</span>
                <span
                  className={cn(
                    "text-[11px] font-medium leading-tight",
                    tempSelectedTable.status === "empty"
                      ? "text-emerald-700 dark:text-emerald-400"
                      : tempSelectedTable.status === "occupied"
                      ? "text-rose-700 dark:text-rose-400"
                      : "text-amber-700 dark:text-amber-400",
                  )}
                >
                  {tempSelectedTable.status === "empty"
                    ? "Meja kosong dan siap digunakan untuk pesanan Dine-in baru."
                    : tempSelectedTable.status === "occupied"
                    ? "Meja terisi. Pesanan baru akan dibuat sebagai Pesanan Tambahan pada sesi aktif."
                    : "Meja menunggu pembayaran. Pilih untuk menambahkan item ke pesanan aktif."}
                </span>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground italic flex items-center gap-1.5">
                <MapPin className="size-3.5 text-muted-foreground/70" />
                Belum ada meja yang dipilih. Silakan klik salah satu meja pada denah visual atau daftar meja.
              </span>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 shrink-0 w-full sm:w-auto">
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={onClose}
              className="h-10 px-5 text-xs font-semibold rounded-xl border-border hover:bg-muted/60 flex-1 sm:flex-none cursor-pointer"
            >
              Batal
            </Button>
            <Button
              type="button"
              size="default"
              disabled={!tempSelectedTable}
              onClick={handleConfirm}
              className={cn(
                "h-10 px-6 text-xs font-bold rounded-xl shadow-xs transition-all flex-1 sm:flex-none cursor-pointer",
                tempSelectedTable?.status === "occupied"
                  ? "bg-rose-600 hover:bg-rose-700 text-white"
                  : tempSelectedTable?.status === "awaiting_payment"
                  ? "bg-amber-600 hover:bg-amber-700 text-white"
                  : "bg-primary hover:bg-primary/95 text-primary-foreground",
              )}
            >
              {tempSelectedTable?.status === "awaiting_payment"
                ? "Pilih (Tambah Item)"
                : tempSelectedTable?.status === "occupied"
                ? "Pilih (Pesanan Tambahan)"
                : "Pilih Meja Ini"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
