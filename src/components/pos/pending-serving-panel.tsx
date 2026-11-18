"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Info,
  Loader2,
  PlusCircle,
  RefreshCw,
  ShoppingBag,
  Utensils,
  Wifi,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
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
import { formatElapsedDuration } from "@/lib/kds/transitions";
import {
  mergePendingServingOrdersById,
  type PendingServingBoardData,
  type PendingServingOrder,
} from "@/lib/orders/serving";
import {
  confirmOrderServedAction,
  getPendingServingOrdersAction,
} from "@/lib/orders/serving-actions";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type PendingServingPanelProps = {
  initialData: PendingServingBoardData;
};

type ConnectionState = "connecting" | "connected" | "polling";

const REALTIME_DEBOUNCE_MS = 250;
const FALLBACK_POLL_INTERVAL_MS = 8_000;
const SAFETY_SYNC_INTERVAL_MS = 30_000;
const CLOCK_TICK_INTERVAL_MS = 15_000;

const WIB_TIME_FORMATTER = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatWibTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${WIB_TIME_FORMATTER.format(date)} WIB`;
}

export function PendingServingPanel({ initialData }: PendingServingPanelProps) {
  const [orders, setOrders] = useState<PendingServingOrder[]>(() =>
    mergePendingServingOrdersById(initialData.orders),
  );
  const [schemaReady, setSchemaReady] = useState<boolean>(
    initialData.schemaReady,
  );
  const [migrationNotice, setMigrationNotice] = useState<string | null>(
    initialData.migrationNotice ?? null,
  );
  const [nowMs, setNowMs] = useState<number>(() => {
    const parsed = Date.parse(initialData.syncedAt);
    return Number.isNaN(parsed) ? 0 : parsed;
  });

  const [isExpanded, setIsExpanded] = useState<boolean>(
    initialData.orders.length > 0,
  );
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedOrder, setSelectedOrder] =
    useState<PendingServingOrder | null>(null);
  const [confirmingOrderId, setConfirmingOrderId] = useState<string | null>(
    null,
  );

  const seenOrderIdsRef = useRef<Set<string>>(
    new Set(initialData.orders.map((o) => o.id)),
  );
  const inFlightRefreshRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  const syncPendingOrders = useCallback(
    async (options?: { manual?: boolean }) => {
      if (inFlightRefreshRef.current) {
        pendingRefreshRef.current = true;
        return;
      }

      inFlightRefreshRef.current = true;
      let isManual = Boolean(options?.manual);
      if (isManual) {
        setIsRefreshing(true);
      }

      try {
        while (isMountedRef.current) {
          pendingRefreshRef.current = false;

          try {
            const result = await getPendingServingOrdersAction();
            if (!isMountedRef.current) return;

            if (!result.ok || !result.data) {
              if (isManual) {
                toast.error(result.message);
              }
            } else {
              const nextOrders = mergePendingServingOrdersById(
                result.data.orders,
              );

              let hasNewReadyOrder = false;
              for (const order of nextOrders) {
                if (!seenOrderIdsRef.current.has(order.id)) {
                  seenOrderIdsRef.current.add(order.id);
                  hasNewReadyOrder = true;
                  const targetLabel =
                    order.orderType === "dine_in"
                      ? order.tableName
                        ? `Meja ${order.tableName}`
                        : "Dine-in"
                      : "Takeaway";
                  toast.info(
                    `Pesanan ${order.queueNumber ?? order.orderNumber} (${targetLabel}) siap disajikan.`,
                  );
                }
              }

              // Bersihkan ID yang sudah tidak berada dalam daftar menunggu disajikan
              const activeIds = new Set(nextOrders.map((o) => o.id));
              for (const seenId of Array.from(seenOrderIdsRef.current)) {
                if (!activeIds.has(seenId)) {
                  seenOrderIdsRef.current.delete(seenId);
                }
              }

              setOrders(nextOrders);
              setSchemaReady(result.data.schemaReady);
              setMigrationNotice(result.data.migrationNotice ?? null);
              setNowMs(Date.now());

              if (hasNewReadyOrder) {
                setIsExpanded(true);
              }

              if (isManual) {
                toast.success("Daftar pesanan menunggu disajikan diperbarui.");
              }
            }
          } catch {
            if (!isMountedRef.current) return;
            if (isManual) {
              toast.error(
                "Gagal menyinkronkan daftar pesanan menunggu disajikan.",
              );
            }
          }

          isManual = false;
          if (!pendingRefreshRef.current) {
            break;
          }
        }
      } finally {
        inFlightRefreshRef.current = false;
        if (isMountedRef.current) {
          setIsRefreshing(false);
        }
      }
    },
    [],
  );

  const scheduleRealtimeSync = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void syncPendingOrders({ manual: false });
    }, REALTIME_DEBOUNCE_MS);
  }, [syncPendingOrders]);

  useEffect(() => {
    isMountedRef.current = true;
    const clockTimer = setInterval(() => {
      setNowMs(Date.now());
    }, CLOCK_TICK_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      clearInterval(clockTimer);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Supabase Realtime subscription on public.orders
  useEffect(() => {
    let supabase: ReturnType<typeof createSupabaseBrowserClient> | null = null;
    try {
      supabase = createSupabaseBrowserClient();
    } catch {
      const fallbackTimer = setTimeout(() => {
        if (isMountedRef.current) {
          setConnectionState("polling");
        }
      }, 0);
      return () => clearTimeout(fallbackTimer);
    }

    const channel = supabase
      .channel("pos-pending-serving-orders")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orders",
        },
        () => {
          scheduleRealtimeSync();
        },
      )
      .subscribe((status) => {
        if (!isMountedRef.current) return;
        if (status === "SUBSCRIBED") {
          setConnectionState("connected");
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          setConnectionState("polling");
        }
      });

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void syncPendingOrders({ manual: false });
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (supabase) {
        void supabase.removeChannel(channel);
      }
    };
  }, [scheduleRealtimeSync, syncPendingOrders]);

  // Fallback polling
  useEffect(() => {
    const intervalMs =
      connectionState === "connected"
        ? SAFETY_SYNC_INTERVAL_MS
        : FALLBACK_POLL_INTERVAL_MS;

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void syncPendingOrders({ manual: false });
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }, [connectionState, syncPendingOrders]);

  const handleConfirmServed = async () => {
    if (!selectedOrder) return;
    if (confirmingOrderId === selectedOrder.id) return;

    const target = selectedOrder;
    setConfirmingOrderId(target.id);

    try {
      const result = await confirmOrderServedAction(target.id);
      if (!isMountedRef.current) return;

      if (!result.ok) {
        toast.error(result.message);
        setSelectedOrder(null);
        void syncPendingOrders({ manual: false });
        return;
      }

      // Hilangkan segera dari daftar menunggu disajikan
      setOrders((prev) => prev.filter((item) => item.id !== target.id));
      seenOrderIdsRef.current.delete(target.id);
      setSelectedOrder(null);
      toast.success(result.message);
      scheduleRealtimeSync();
    } catch {
      if (!isMountedRef.current) return;
      toast.error(
        "Terjadi kesalahan saat menyimpan konfirmasi penyajian. Silakan coba lagi.",
      );
      void syncPendingOrders({ manual: false });
    } finally {
      if (isMountedRef.current) {
        setConfirmingOrderId(null);
      }
    }
  };

  const pendingCount = orders.length;
  const headerToneClass = useMemo(() => {
    if (pendingCount > 0) {
      return "border-emerald-300/90 bg-emerald-50/75";
    }
    return "border-border bg-card";
  }, [pendingCount]);

  return (
    <>
      <section
        aria-label="Menunggu Disajikan"
        data-testid="pos-pending-serving-panel"
        className={cn(
          "shrink-0 rounded-2xl border shadow-xs transition-colors",
          headerToneClass,
        )}
      >
        {/* Header Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-lg",
                pendingCount > 0
                  ? "bg-emerald-600 text-white"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <BellRing className="size-3.5" />
            </span>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <h2 className="font-display text-xs font-bold text-foreground sm:text-sm">
                Menunggu Disajikan
              </h2>
              <Badge
                variant={pendingCount > 0 ? "default" : "secondary"}
                className={cn(
                  "h-5 rounded-full px-2 text-[11px] font-bold tabular-nums",
                  pendingCount > 0 && "bg-emerald-700 text-white",
                )}
              >
                {pendingCount}
              </Badge>
              <span
                className={cn(
                  "hidden items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold sm:inline-flex",
                  connectionState === "connected"
                    ? "border-emerald-200 bg-white/80 text-emerald-800"
                    : "border-amber-200 bg-amber-50 text-amber-800",
                )}
              >
                {connectionState === "connected" ? (
                  <>
                    <Wifi className="size-3" />
                    Realtime
                  </>
                ) : (
                  <>
                    <WifiOff className="size-3" />
                    Polling
                  </>
                )}
              </span>
              <span className="hidden truncate text-xs text-muted-foreground xl:inline">
                {pendingCount === 0
                  ? "· Belum ada pesanan siap dari dapur"
                  : `· ${pendingCount} pesanan siap dikonfirmasi penyajian`}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isRefreshing}
              onClick={() => void syncPendingOrders({ manual: true })}
              className="h-7.5 gap-1.5 rounded-lg bg-background px-2.5 text-xs font-semibold"
            >
              <RefreshCw
                className={cn("size-3.5", isRefreshing && "animate-spin")}
              />
              <span className="hidden sm:inline">Segarkan</span>
            </Button>

            {pendingCount > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsExpanded((prev) => !prev)}
                className="h-7.5 gap-1 rounded-lg bg-background px-2.5 text-xs font-semibold"
              >
                {isExpanded ? (
                  <>
                    Ringkas
                    <ChevronUp className="size-3.5" />
                  </>
                ) : (
                  <>
                    Lihat ({pendingCount})
                    <ChevronDown className="size-3.5" />
                  </>
                )}
              </Button>
            ) : null}
          </div>
        </div>

        {/* Non-blocking Migration Notice if SQL not yet applied */}
        {!schemaReady && migrationNotice ? (
          <div className="mx-3.5 mb-2.5 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 sm:mx-4">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-700" />
            <span>{migrationNotice}</span>
          </div>
        ) : null}

        {/* Cards List */}
        {pendingCount > 0 && isExpanded ? (
          <div className="border-t border-emerald-200/80 px-3.5 py-3 sm:px-4">
            <div className="grid max-h-[195px] grid-cols-1 gap-2.5 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-3">
              {orders.map((order) => {
                const isConfirming = confirmingOrderId === order.id;

                return (
                  <article
                    key={order.id}
                    data-testid={`pending-serving-card-${order.id}`}
                    className="flex flex-col justify-between gap-2.5 rounded-xl border border-emerald-200 bg-card p-3 shadow-xs"
                  >
                    <div className="space-y-2">
                      {/* Card Top Row */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-baseline gap-1.5">
                            <span className="font-display text-lg font-bold tabular-nums text-foreground">
                              {order.queueNumber ??
                                `#${order.orderNumber.slice(-4)}`}
                            </span>
                            <span className="truncate font-mono text-[11px] font-medium text-muted-foreground">
                              {order.orderNumber}
                            </span>
                          </div>

                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {order.orderType === "dine_in" ? (
                              <Badge
                                variant="secondary"
                                className="gap-1 border border-primary/20 bg-primary/10 px-1.5 py-0 text-[11px] font-semibold text-primary"
                              >
                                <Utensils className="size-3" />
                                {order.tableName
                                  ? `Dine-in · Meja ${order.tableName}`
                                  : "Dine-in"}
                              </Badge>
                            ) : (
                              <Badge
                                variant="secondary"
                                className="gap-1 border border-slate-300 bg-slate-100 px-1.5 py-0 text-[11px] font-semibold text-slate-800"
                              >
                                <ShoppingBag className="size-3" />
                                Takeaway
                              </Badge>
                            )}

                            {order.isAdditionalOrder ? (
                              <Badge
                                variant="outline"
                                className="gap-0.5 border-amber-400 bg-amber-50 px-1.5 py-0 text-[10px] font-semibold text-amber-900"
                              >
                                <PlusCircle className="size-2.5" />
                                Tambahan #{order.sessionOrderIndex}
                              </Badge>
                            ) : null}
                          </div>
                        </div>

                        <div className="shrink-0 text-right">
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-emerald-800">
                            <Clock3 className="size-3" />
                            Siap {formatWibTime(order.readyAt)}
                          </span>
                          <p className="mt-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                            {formatElapsedDuration(order.readyAt, nowMs)} lalu ·{" "}
                            {order.totalItemCount} item
                          </p>
                        </div>
                      </div>

                      {/* Items Preview */}
                      <ul className="space-y-1 rounded-lg bg-muted/40 px-2.5 py-2 text-xs">
                        {order.items.map((item) => (
                          <li
                            key={item.id}
                            className="flex items-start justify-between gap-2"
                          >
                            <div className="min-w-0">
                              <span className="font-bold tabular-nums text-primary">
                                {item.quantity}×
                              </span>{" "}
                              <span className="font-medium text-foreground">
                                {item.productName}
                              </span>
                              {item.modifiers.length > 0 ? (
                                <span className="ml-1 text-[11px] text-muted-foreground">
                                  ({item.modifiers.join(", ")})
                                </span>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <Button
                      type="button"
                      size="sm"
                      disabled={isConfirming || !schemaReady}
                      onClick={() => setSelectedOrder(order)}
                      className="h-9 w-full gap-1.5 rounded-xl bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                    >
                      {isConfirming ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" />
                          Menyimpan...
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="size-3.5" />
                          Tandai Sudah Disajikan
                        </>
                      )}
                    </Button>
                  </article>
                );
              })}
            </div>
          </div>
        ) : null}
      </section>

      {/* Confirmation Dialog */}
      <Dialog
        open={selectedOrder !== null}
        onOpenChange={(open) => {
          if (!open && confirmingOrderId === null) {
            setSelectedOrder(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-lg">
              Konfirmasi Pesanan Sudah Disajikan
            </DialogTitle>
            <DialogDescription>
              Pastikan seluruh item pada pesanan berikut sudah diambil dari
              dapur dan diserahkan kepada pelanggan.
            </DialogDescription>
          </DialogHeader>

          {selectedOrder ? (
            <div className="space-y-3 py-1">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/40 px-3.5 py-2.5">
                <div>
                  <p className="font-display text-xl font-bold tabular-nums text-foreground">
                    {selectedOrder.queueNumber ??
                      `#${selectedOrder.orderNumber.slice(-4)}`}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {selectedOrder.orderNumber}
                  </p>
                </div>
                <div className="text-right">
                  {selectedOrder.orderType === "dine_in" ? (
                    <Badge
                      variant="secondary"
                      className="gap-1 border border-primary/20 bg-primary/10 text-xs font-semibold text-primary"
                    >
                      <Utensils className="size-3" />
                      {selectedOrder.tableName
                        ? `Dine-in · Meja ${selectedOrder.tableName}`
                        : "Dine-in"}
                    </Badge>
                  ) : (
                    <Badge
                      variant="secondary"
                      className="gap-1 border border-slate-300 bg-slate-100 text-xs font-semibold text-slate-800"
                    >
                      <ShoppingBag className="size-3" />
                      Takeaway
                    </Badge>
                  )}
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Siap {formatWibTime(selectedOrder.readyAt)}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Daftar Item ({selectedOrder.totalItemCount} porsi)
                </p>
                <ul className="max-h-44 space-y-1.5 overflow-y-auto rounded-xl border border-border bg-background p-3 text-sm">
                  {selectedOrder.items.map((item) => (
                    <li key={item.id} className="leading-snug">
                      <span className="font-bold tabular-nums text-primary">
                        {item.quantity}×
                      </span>{" "}
                      <span className="font-medium text-foreground">
                        {item.productName}
                      </span>
                      {item.modifiers.length > 0 ? (
                        <p className="pl-6 text-xs text-muted-foreground">
                          {item.modifiers.join(" · ")}
                        </p>
                      ) : null}
                      {item.notes ? (
                        <p className="pl-6 text-xs text-amber-800">
                          Catatan: {item.notes}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex items-start gap-2 rounded-xl border border-primary/20 bg-brand-soft/50 px-3 py-2.5 text-xs leading-relaxed text-foreground/90">
                <Info className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>
                  {selectedOrder.orderType === "dine_in"
                    ? "Konfirmasi ini hanya mencatat pesanan sudah disajikan. Sesi meja dan status meja tetap terbuka sampai pelanggan selesai makan dan kasir menutup sesi meja."
                    : "Konfirmasi ini mencatat pesanan takeaway telah diserahkan kepada pelanggan tanpa mengubah riwayat pembayaran."}
                </span>
              </div>
            </div>
          ) : null}

          <DialogFooter className="mx-0 mb-0 gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={confirmingOrderId !== null}
              onClick={() => setSelectedOrder(null)}
              className="rounded-xl"
            >
              Batal
            </Button>
            <Button
              type="button"
              disabled={confirmingOrderId !== null}
              onClick={() => void handleConfirmServed()}
              className="gap-1.5 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {confirmingOrderId !== null ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Menyimpan...
                </>
              ) : (
                <>
                  <CheckCircle2 className="size-4" />
                  Ya, Tandai Sudah Disajikan
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
