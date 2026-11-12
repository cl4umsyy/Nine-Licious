"use client";

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Info,
  Layers,
  LoaderCircle,
  Pencil,
  RotateCcw,
  UploadCloud,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  clampToFloorPlan,
  FLOOR_PLAN_HEIGHT,
  FLOOR_PLAN_WIDTH,
  snapToGrid,
  tableDimensions,
  TABLE_SHAPE_LABELS,
  TABLE_STATUS_DESCRIPTIONS,
  TABLE_STATUS_LABELS,
} from "@/lib/tables/constants";
import type { TablePosition } from "@/lib/tables/types";
import type { DiningTable, TableShape, TableStatus, TableZone } from "@/types/database";

export type FloorPlanCanvasProps = {
  tables: DiningTable[];
  zones: TableZone[];
  activeZoneId?: string;
  onZoneChange?: (zoneId: string) => void;
  publishedAt?: string | null;
  interactive?: boolean;
  onSavePositions?: (zoneId: string, positions: TablePosition[]) => Promise<{ ok: boolean; message?: string }>;
  onPublishLayout?: (zoneId: string) => Promise<{ ok: boolean; message?: string }>;
  onEditTable?: (table: DiningTable) => void;
};

const STATUS_VARIANTS: Record<
  TableStatus,
  {
    bg: string;
    border: string;
    text: string;
    badge: string;
    ring: string;
    dot: string;
  }
> = {
  empty: {
    bg: "bg-emerald-50/90 hover:bg-emerald-100/90 dark:bg-emerald-950/40 dark:hover:bg-emerald-900/50",
    border: "border-emerald-500/40 hover:border-emerald-600",
    text: "text-emerald-950 dark:text-emerald-100",
    badge: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/60 dark:text-emerald-200",
    ring: "focus-visible:ring-emerald-500",
    dot: "bg-emerald-500",
  },
  awaiting_payment: {
    bg: "bg-amber-50/90 hover:bg-amber-100/90 dark:bg-amber-950/40 dark:hover:bg-amber-900/50",
    border: "border-amber-500/50 hover:border-amber-600",
    text: "text-amber-950 dark:text-amber-100",
    badge: "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-900/60 dark:text-amber-200",
    ring: "focus-visible:ring-amber-500",
    dot: "bg-amber-500",
  },
  occupied: {
    bg: "bg-rose-50/90 hover:bg-rose-100/90 dark:bg-rose-950/40 dark:hover:bg-rose-900/50",
    border: "border-rose-500/45 hover:border-rose-600",
    text: "text-rose-950 dark:text-rose-100",
    badge: "bg-rose-100 text-rose-900 border-rose-300 dark:bg-rose-900/60 dark:text-rose-200",
    ring: "focus-visible:ring-rose-500",
    dot: "bg-rose-500",
  },
};

export function FloorPlanCanvas({
  tables,
  zones,
  activeZoneId: externalZoneId,
  onZoneChange,
  publishedAt,
  interactive = false,
  onSavePositions,
  onPublishLayout,
  onEditTable,
}: FloorPlanCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [internalZoneId, setInternalZoneId] = useState<string>(
    externalZoneId ?? zones[0]?.id ?? "",
  );

  const currentZoneId = externalZoneId ?? internalZoneId;

  const handleZoneSelect = (id: string) => {
    setInternalZoneId(id);
    onZoneChange?.(id);
  };

  const currentZone = useMemo(
    () => zones.find((z) => z.id === currentZoneId) ?? zones[0],
    [zones, currentZoneId],
  );

  const zoneTables = useMemo(
    () => tables.filter((t) => t.zone_id === currentZone?.id),
    [tables, currentZone],
  );

  // Local dragged positions: map table id -> { x, y }
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [selectedTable, setSelectedTable] = useState<DiningTable | null>(null);
  const [inspectTable, setInspectTable] = useState<DiningTable | null>(null);

  // Reset local positions when zone changes
  const [prevZoneId, setPrevZoneId] = useState(currentZone?.id);
  if (currentZone?.id !== prevZoneId) {
    setPrevZoneId(currentZone?.id);
    setLocalPositions({});
    setSelectedTable(null);
  }

  // Track dragging state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragStartRef = useRef<{
    tableId: string;
    pointerX: number;
    pointerY: number;
    startX: number;
    startY: number;
    capacity: number;
    shape: TableShape;
  } | null>(null);

  const hasUnsavedChanges = useMemo(() => {
    return Object.keys(localPositions).length > 0;
  }, [localPositions]);

  const [isSaving, startSaving] = useTransition();
  const [isPublishing, startPublishing] = useTransition();

  const handlePointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    table: DiningTable,
  ) => {
    if (!interactive) {
      setInspectTable(table);
      return;
    }

    // Set active selected table
    setSelectedTable(table);

    // Only allow left-click dragging
    if (e.button !== 0) return;

    const currentPos = localPositions[table.id] ?? {
      x: table.position_x,
      y: table.position_y,
    };

    dragStartRef.current = {
      tableId: table.id,
      pointerX: e.clientX,
      pointerY: e.clientY,
      startX: currentPos.x,
      startY: currentPos.y,
      capacity: table.capacity,
      shape: table.shape,
    };

    setDraggingId(table.id);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStartRef.current;
    if (!drag || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const scale = rect.width / FLOOR_PLAN_WIDTH;

    if (scale <= 0) return;

    const deltaX = (e.clientX - drag.pointerX) / scale;
    const deltaY = (e.clientY - drag.pointerY) / scale;

    const rawX = drag.startX + deltaX;
    const rawY = drag.startY + deltaY;

    const snappedX = snapToGrid(rawX);
    const snappedY = snapToGrid(rawY);

    const clamped = clampToFloorPlan(
      snappedX,
      snappedY,
      drag.capacity,
      drag.shape,
    );

    setLocalPositions((prev) => ({
      ...prev,
      [drag.tableId]: clamped,
    }));
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture already lost
      }
    }
    dragStartRef.current = null;
    setDraggingId(null);
  }, []);

  const handleResetPositions = () => {
    setLocalPositions({});
    toast.info("Perubahan posisi dibatalkan.");
  };

  const handleSavePositions = () => {
    if (!onSavePositions || !currentZone) return;

    const positionsToSave: TablePosition[] = zoneTables.map((t) => {
      const pos = localPositions[t.id] ?? { x: t.position_x, y: t.position_y };
      return {
        id: t.id,
        x: pos.x,
        y: pos.y,
      };
    });

    startSaving(async () => {
      const result = await onSavePositions(currentZone.id, positionsToSave);
      if (result.ok) {
        setLocalPositions({});
        toast.success(result.message ?? "Posisi meja berhasil disimpan.");
      } else {
        toast.error(result.message ?? "Gagal menyimpan posisi meja.");
      }
    });
  };

  const handlePublish = () => {
    if (!onPublishLayout || !currentZone) return;

    startPublishing(async () => {
      const result = await onPublishLayout(currentZone.id);
      if (result.ok) {
        toast.success(result.message ?? "Layout denah berhasil diterbitkan.");
      } else {
        toast.error(result.message ?? "Gagal menerbitkan layout denah.");
      }
    });
  };

  return (
    <div className="space-y-4">
      {/* Zone selection bar & actions header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mr-1">
            Area:
          </span>
          {zones.map((zone) => {
            const isSelected = zone.id === currentZone?.id;
            return (
              <Button
                key={zone.id}
                type="button"
                variant={isSelected ? "default" : "outline"}
                size="sm"
                onClick={() => handleZoneSelect(zone.id)}
                className={`h-8 text-xs font-medium ${
                  isSelected ? "bg-primary text-primary-foreground shadow-sm" : ""
                }`}
              >
                <Layers className="size-3.5 mr-1" />
                {zone.name}
                {!zone.is_active && (
                  <span className="ml-1 text-[10px] opacity-75">(nonaktif)</span>
                )}
              </Button>
            );
          })}
        </div>

        {interactive && (
          <div className="flex flex-wrap items-center gap-2">
            {hasUnsavedChanges && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleResetPositions}
                  disabled={isSaving}
                  className="h-8 text-xs"
                >
                  <RotateCcw className="size-3.5 mr-1.5" />
                  Reset
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={handleSavePositions}
                  disabled={isSaving}
                  className="h-8 text-xs bg-brand-accent hover:bg-brand-accent/90 text-white"
                >
                  {isSaving ? (
                    <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5 mr-1.5" />
                  )}
                  Simpan Posisi
                </Button>
              </>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handlePublish}
              disabled={isPublishing || hasUnsavedChanges || zoneTables.length === 0}
              className="h-8 text-xs border-primary/30 text-primary hover:bg-primary/5"
            >
              {isPublishing ? (
                <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
              ) : (
                <UploadCloud className="size-3.5 mr-1.5" />
              )}
              Terbitkan Layout
            </Button>
          </div>
        )}
      </div>

      {/* Unsaved changes notice banner */}
      {interactive && hasUnsavedChanges && (
        <div className="flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>
              Ada perubahan posisi meja yang belum disimpan. Klik{" "}
              <strong>Simpan Posisi</strong> agar tersimpan ke database.
            </span>
          </div>
          <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
            {Object.keys(localPositions).length} meja digeser
          </span>
        </div>
      )}

      {/* Canvas container */}
      <Card className="overflow-hidden border-border/80 shadow-sm">
        <CardHeader className="border-b bg-muted/20 px-4 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 font-medium">
              <span>Denah: {currentZone?.name ?? "Utama"}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{zoneTables.length} meja</span>
            </div>

            <div className="flex items-center gap-3">
              {publishedAt ? (
                <span className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="size-3.5" />
                  Terbit: {new Date(publishedAt).toLocaleString("id-ID")}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Status: Draf / Belum Diterbitkan
                </span>
              )}

              {interactive ? (
                <Badge variant="secondary" className="text-[11px] font-normal">
                  Mode Editor (Drag-and-Drop)
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[11px] font-normal">
                  Mode Tampilan
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-3 sm:p-4">
          <div
            ref={containerRef}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className="relative w-full aspect-[3/2] select-none overflow-hidden rounded-xl border border-dashed border-border/90 bg-[#faf8f5] dark:bg-muted/10 shadow-inner"
            style={{
              backgroundImage:
                "radial-gradient(circle, rgba(14, 79, 69, 0.08) 1.2px, transparent 1.2px)",
              backgroundSize: "20px 20px",
            }}
          >
            {zoneTables.length === 0 ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-muted-foreground">
                <Layers className="size-10 stroke-[1.5] text-muted-foreground/60 mb-2" />
                <p className="text-sm font-medium">Belum ada meja di area ini.</p>
                <p className="text-xs max-w-sm mt-1">
                  Tambahkan meja di tab &quot;Daftar Meja&quot; untuk mulai menyusun denah.
                </p>
              </div>
            ) : (
              zoneTables.map((table) => {
                const pos = localPositions[table.id] ?? {
                  x: table.position_x,
                  y: table.position_y,
                };
                const size = tableDimensions(table.capacity, table.shape);
                const isDragging = draggingId === table.id;
                const isSelected = selectedTable?.id === table.id;
                const variant = STATUS_VARIANTS[table.status];

                const leftPercent = (pos.x / FLOOR_PLAN_WIDTH) * 100;
                const topPercent = (pos.y / FLOOR_PLAN_HEIGHT) * 100;
                const widthPercent = (size.width / FLOOR_PLAN_WIDTH) * 100;
                const heightPercent = (size.height / FLOOR_PLAN_HEIGHT) * 100;

                return (
                  <div
                    key={table.id}
                    onPointerDown={(e) => handlePointerDown(e, table)}
                    onClick={() => {
                      if (!interactive) setInspectTable(table);
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`Meja ${table.name}, kapasitas ${table.capacity} orang, status ${TABLE_STATUS_LABELS[table.status]}`}
                    style={{
                      left: `${leftPercent}%`,
                      top: `${topPercent}%`,
                      width: `${widthPercent}%`,
                      height: `${heightPercent}%`,
                      touchAction: "none",
                    }}
                    className={`absolute flex flex-col items-center justify-center border-2 transition-shadow cursor-grab active:cursor-grabbing ${
                      table.shape === "round"
                        ? "rounded-full"
                        : "rounded-xl"
                    } ${variant.bg} ${variant.border} ${variant.text} ${
                      isDragging
                        ? "shadow-xl ring-2 ring-primary ring-offset-2 z-30 scale-105"
                        : isSelected
                        ? "shadow-md ring-2 ring-primary/60 z-20"
                        : "shadow-sm hover:shadow-md z-10"
                    } ${!table.is_active ? "opacity-50 border-dashed" : ""}`}
                  >
                    {/* Live Dragging Coordinates Tooltip */}
                    {isDragging && (
                      <div className="absolute -top-7 left-1/2 -translate-x-1/2 rounded bg-black/80 px-2 py-0.5 text-[10px] font-mono font-medium text-white shadow pointer-events-none whitespace-nowrap z-40">
                        X: {pos.x}, Y: {pos.y}
                      </div>
                    )}

                    {/* Table Name */}
                    <span className="font-display font-bold text-xs sm:text-sm md:text-base leading-tight truncate px-1 text-center">
                      {table.name}
                    </span>

                    {/* Table Meta: Capacity and Status Pill */}
                    <div className="flex items-center gap-1 mt-0.5 max-w-full overflow-hidden px-1">
                      <span className="flex items-center text-[10px] sm:text-xs font-medium opacity-80 shrink-0">
                        <Users className="size-2.5 sm:size-3 mr-0.5" />
                        {table.capacity}
                      </span>
                      <span
                        className={`size-1.5 sm:size-2 rounded-full shrink-0 ${variant.dot}`}
                        title={TABLE_STATUS_LABELS[table.status]}
                      />
                    </div>

                    {!table.is_active && (
                      <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-tight">
                        Nonaktif
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>

      {/* Status Legend & Quick Info */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3.5 py-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-4">
          <span className="font-semibold uppercase tracking-wider text-muted-foreground text-[11px]">
            Legenda Status:
          </span>

          <div className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-emerald-500" />
            <span className="font-medium text-emerald-950 dark:text-emerald-200">
              Kosong
            </span>
            <span className="text-muted-foreground hidden sm:inline">
              (Dapat dipilih)
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-amber-500" />
            <span className="font-medium text-amber-950 dark:text-amber-200">
              Menunggu Bayar
            </span>
            <span className="text-muted-foreground hidden sm:inline">
              (Pesanan belum lunas)
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-rose-500" />
            <span className="font-medium text-rose-950 dark:text-rose-200">
              Terisi
            </span>
            <span className="text-muted-foreground hidden sm:inline">
              (Pesanan lunas)
            </span>
          </div>
        </div>

        {interactive && selectedTable && onEditTable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onEditTable(selectedTable)}
            className="h-7 text-xs"
          >
            <Pencil className="size-3 mr-1" />
            Ubah Meja {selectedTable.name}
          </Button>
        )}
      </div>

      {/* Table inspection dialog (when clicking table in read-only / kasir mode) */}
      <Dialog
        open={Boolean(inspectTable)}
        onOpenChange={(open) => {
          if (!open) setInspectTable(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <DialogTitle className="font-display text-lg">
                Meja {inspectTable?.name}
              </DialogTitle>
              {inspectTable && (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    STATUS_VARIANTS[inspectTable.status].badge
                  }`}
                >
                  <span
                    className={`size-1.5 rounded-full ${
                      STATUS_VARIANTS[inspectTable.status].dot
                    }`}
                  />
                  {TABLE_STATUS_LABELS[inspectTable.status]}
                </span>
              )}
            </div>
            <DialogDescription>
              Detail informasi meja dine-in restoran.
            </DialogDescription>
          </DialogHeader>

          {inspectTable && (
            <div className="space-y-3 py-2 text-sm">
              <div className="rounded-lg bg-muted/50 p-3 space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Area:</span>
                  <span className="font-medium">
                    {zones.find((z) => z.id === inspectTable.zone_id)?.name ?? "-"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Kapasitas:</span>
                  <span className="font-medium">{inspectTable.capacity} orang</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Bentuk meja:</span>
                  <span className="font-medium">
                    {TABLE_SHAPE_LABELS[inspectTable.shape]}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Koordinat (X, Y):</span>
                  <span className="font-mono text-xs">
                    {inspectTable.position_x}, {inspectTable.position_y}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status Meja:</span>
                  <span className="font-semibold">
                    {TABLE_STATUS_LABELS[inspectTable.status]}
                  </span>
                </div>
              </div>

              <div className="rounded-lg border border-border/80 p-3 bg-background text-xs text-muted-foreground flex items-start gap-2">
                <Info className="size-4 shrink-0 text-primary mt-0.5" />
                <span>{TABLE_STATUS_DESCRIPTIONS[inspectTable.status]}</span>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setInspectTable(null)}
            >
              Tutup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
