"use client";

import { useMemo, useState } from "react";
import { Check, Layers, Users, Utensils } from "lucide-react";
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
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="p-5 pb-3 border-b bg-muted/20">
          <div className="flex items-center gap-2">
            <Utensils className="size-5 text-primary" />
            <div>
              <DialogTitle className="text-lg font-bold font-display">
                Pilih Meja Dine-in
              </DialogTitle>
              <DialogDescription className="text-xs">
                Pilih meja yang tersedia untuk pesanan makan di tempat.
              </DialogDescription>
            </div>
          </div>

          {/* Area / Zone selector tabs */}
          <div className="flex flex-wrap items-center gap-1.5 pt-3">
            {zones.map((zone) => {
              const isSelected = zone.id === (currentZone?.id ?? "");
              return (
                <Button
                  key={zone.id}
                  type="button"
                  variant={isSelected ? "default" : "outline"}
                  size="sm"
                  onClick={() => setActiveZoneId(zone.id)}
                  className="h-7 text-xs px-2.5"
                >
                  <Layers className="size-3 mr-1" />
                  {zone.name}
                </Button>
              );
            })}
          </div>
        </DialogHeader>

        {/* Tables Grid */}
        <div className="flex-1 overflow-y-auto p-5">
          {zoneTables.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-muted-foreground space-y-1">
              <p className="font-medium text-sm">Tidak ada meja di area ini.</p>
              <p className="text-xs">
                Silakan pilih area lain atau hubungi admin untuk konfigurasi denah.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {zoneTables.map((table) => {
                const isSelected = tempSelectedTable?.id === table.id;
                const isOccupied = table.status === "occupied";
                const isAwaitingPayment = table.status === "awaiting_payment";

                return (
                  <button
                    key={table.id}
                    type="button"
                    onClick={() => setTempSelectedTable(table)}
                    className={`relative flex flex-col p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      isSelected
                        ? "border-primary ring-2 ring-primary/40 bg-brand-soft/30 shadow-md"
                        : isOccupied
                          ? "border-rose-300/80 bg-rose-50/20 hover:border-rose-400 hover:bg-rose-50/40 dark:bg-rose-950/20"
                          : isAwaitingPayment
                            ? "border-amber-300/80 bg-amber-50/20 hover:border-amber-400 hover:bg-amber-50/40 dark:bg-amber-950/20"
                            : "border-border/80 bg-card hover:border-primary/50 hover:bg-muted/30 shadow-sm"
                    }`}
                  >
                    {/* Header: Table name & Shape */}
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="font-display font-bold text-base truncate">
                        {table.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground capitalize">
                        {TABLE_SHAPE_LABELS[table.shape]}
                      </span>
                    </div>

                    {/* Capacity */}
                    <div className="flex items-center gap-1 text-xs text-muted-foreground mb-3">
                      <Users className="size-3 text-muted-foreground" />
                      <span>{table.capacity} orang</span>
                    </div>

                    {/* Status Pill */}
                    <Badge
                      variant="outline"
                      className={`text-[10px] h-5 justify-center font-medium border ${
                        STATUS_BADGE_CLASSES[table.status]
                      }`}
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
                      <div className="absolute top-2 right-2 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
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
        <DialogFooter className="p-4 border-t bg-muted/20 flex-row items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {tempSelectedTable ? (
              <div className="flex flex-col space-y-0.5">
                <span className="font-medium text-foreground">
                  Meja terpilih: <span className="text-primary font-bold">{tempSelectedTable.name}</span> ({tempSelectedTable.capacity} orang)
                </span>
                {tempSelectedTable.status === "awaiting_payment" && (
                  <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                    Meja ini memiliki pesanan aktif belum lunas. Item baru akan ditambahkan ke pesanan tersebut.
                  </span>
                )}
                {tempSelectedTable.status === "occupied" && (
                  <span className="text-[11px] text-rose-600 dark:text-rose-400 font-medium">
                    Meja terisi. Pesanan baru akan dibuat sebagai Pesanan Tambahan pada sesi meja yang sedang aktif.
                  </span>
                )}
              </div>
            ) : (
              <span>Pilih salah satu meja yang kosong atau terisi untuk pesanan tambahan.</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Batal
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!tempSelectedTable}
              onClick={handleConfirm}
              className="font-semibold"
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

