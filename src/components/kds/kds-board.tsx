"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertOctagon,
  CheckCircle2,
  ChefHat,
  Clock3,
  Flame,
  Inbox,
  RefreshCw,
  RotateCcw,
  ShoppingBag,
  Utensils,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { KdsTicketCard } from "@/components/kds/kds-ticket-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ROLE_LABELS, type UserRole } from "@/lib/auth/roles";
import {
  getKdsBoardDataAction,
  updateKdsStatusAction,
} from "@/lib/kds/actions";
import {
  filterKdsTickets,
  getKitchenStationLabel,
  KDS_STATUS_DESCRIPTIONS,
  KDS_STATUS_LABELS,
  KDS_STATUS_ORDER,
  mergeKdsTicketsById,
} from "@/lib/kds/transitions";
import type {
  KdsBoardData,
  KdsOrderTypeFilter,
  KdsRefundAlert,
  KdsStationFilter,
  KdsStatusFilter,
  KdsTicket,
} from "@/lib/kds/types";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { KdsStatus } from "@/types/database";

type KdsBoardProps = {
  initialData: KdsBoardData;
  userRole: UserRole;
  initialError?: string | null;
};

type ConnectionState = "connecting" | "connected" | "polling";

const REALTIME_DEBOUNCE_MS = 250;
const FALLBACK_POLL_INTERVAL_MS = 8_000;
const SAFETY_SYNC_INTERVAL_MS = 30_000;
const CLOCK_TICK_INTERVAL_MS = 15_000;

const WIB_CLOCK_FORMATTER = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatWibClock(ms: number): string {
  return `${WIB_CLOCK_FORMATTER.format(new Date(ms))} WIB`;
}

export function KdsBoard({
  initialData,
  userRole,
  initialError = null,
}: KdsBoardProps) {
  const [tickets, setTickets] = useState<KdsTicket[]>(() =>
    mergeKdsTicketsById(initialData.tickets),
  );
  const [refundAlerts, setRefundAlerts] = useState<KdsRefundAlert[]>(
    () => initialData.refundAlerts,
  );
  const [availableStations, setAvailableStations] = useState<string[]>(
    () => initialData.availableStations,
  );
  const [syncedAt, setSyncedAt] = useState<string>(initialData.syncedAt);
  const [nowMs, setNowMs] = useState<number>(() => {
    const parsed = Date.parse(initialData.syncedAt);
    return Number.isNaN(parsed) ? 0 : parsed;
  });

  const [statusFilter, setStatusFilter] = useState<KdsStatusFilter>("all");
  const [orderTypeFilter, setOrderTypeFilter] =
    useState<KdsOrderTypeFilter>("all");
  const [stationFilter, setStationFilter] = useState<KdsStationFilter>("all");

  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(initialError);
  const [updatingOrderIds, setUpdatingOrderIds] = useState<string[]>([]);
  const [dismissedRefundIds, setDismissedRefundIds] = useState<string[]>([]);

  const seenTicketIdsRef = useRef<Set<string>>(
    new Set(initialData.tickets.map((t) => t.id)),
  );
  const seenRefundIdsRef = useRef<Set<string>>(
    new Set(initialData.refundAlerts.map((a) => a.refundId)),
  );
  const inFlightRefreshRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  const syncBoard = useCallback(async (options?: { manual?: boolean }) => {
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
          const result = await getKdsBoardDataAction();

          if (!isMountedRef.current) return;

          if (!result.ok || !result.data) {
            setSyncError(result.message);
            if (isManual) {
              toast.error(result.message);
            }
          } else {
            const nextTickets = mergeKdsTicketsById(result.data.tickets);
            const nextAlerts = result.data.refundAlerts;

            // Detect newly entered tickets to notify kitchen staff
            for (const ticket of nextTickets) {
              if (!seenTicketIdsRef.current.has(ticket.id)) {
                seenTicketIdsRef.current.add(ticket.id);
                const locationLabel =
                  ticket.orderType === "dine_in"
                    ? ticket.tableName
                      ? `Meja ${ticket.tableName}`
                      : "Dine-in"
                    : "Takeaway";
                const prefix = ticket.isAdditionalOrder
                  ? "Pesanan tambahan masuk"
                  : "Pesanan baru masuk";
                toast.info(
                  `${prefix}: ${ticket.queueNumber ?? ticket.orderNumber} · ${locationLabel}`,
                );
              }
            }

            // Detect newly arrived full-refund terminations
            for (const alert of nextAlerts) {
              if (!seenRefundIdsRef.current.has(alert.refundId)) {
                seenRefundIdsRef.current.add(alert.refundId);
                toast.warning(
                  `Hentikan pesanan ${alert.queueNumber ?? alert.orderNumber}: dibatalkan (Refund Penuh).`,
                  { duration: 8000 },
                );
              }
            }

            setTickets(nextTickets);
            setRefundAlerts(nextAlerts);
            setAvailableStations(result.data.availableStations);
            setSyncedAt(result.data.syncedAt);
            setNowMs(Date.now());
            setSyncError(null);

            if (isManual) {
              toast.success("Antrean dapur berhasil disegarkan.");
            }
          }
        } catch {
          if (!isMountedRef.current) return;
          const message =
            "Koneksi ke server terganggu. Mencoba sinkronisasi ulang.";
          setSyncError(message);
          if (isManual) {
            toast.error(message);
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
  }, []);

  const scheduleRealtimeSync = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void syncBoard({ manual: false });
    }, REALTIME_DEBOUNCE_MS);
  }, [syncBoard]);

  // Mount tracking + periodic clock tick for elapsed timers
  useEffect(() => {
    isMountedRef.current = true;
    const clockInterval = setInterval(() => {
      setNowMs(Date.now());
    }, CLOCK_TICK_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      clearInterval(clockInterval);
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
      .channel("kds-live-orders")
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
        void syncBoard({ manual: false });
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (supabase) {
        void supabase.removeChannel(channel);
      }
    };
  }, [scheduleRealtimeSync, syncBoard]);

  // Fallback polling (fast when Realtime disconnected, periodic safety sync when connected)
  useEffect(() => {
    const intervalMs =
      connectionState === "connected"
        ? SAFETY_SYNC_INTERVAL_MS
        : FALLBACK_POLL_INTERVAL_MS;

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void syncBoard({ manual: false });
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }, [connectionState, syncBoard]);

  const handleAdvanceStatus = useCallback(
    async (ticket: KdsTicket, nextStatus: KdsStatus) => {
      if (updatingOrderIds.includes(ticket.id)) {
        return;
      }

      setUpdatingOrderIds((prev) => [...prev, ticket.id]);

      try {
        const result = await updateKdsStatusAction({
          orderId: ticket.id,
          expectedStatus: ticket.kdsStatus,
          nextStatus,
        });

        if (!isMountedRef.current) return;

        if (!result.ok || !result.data) {
          toast.error(result.message);
          void syncBoard({ manual: false });
          return;
        }

        const updatedData = result.data;
        setTickets((prev) =>
          mergeKdsTicketsById(
            prev.map((item) => {
              if (item.id !== updatedData.orderId) return item;
              return {
                ...item,
                kdsStatus: updatedData.kdsStatus,
                updatedAt: updatedData.updatedAt,
                startedAt:
                  updatedData.kdsStatus === "preparing"
                    ? item.startedAt ?? updatedData.updatedAt
                    : item.startedAt,
                readyAt:
                  updatedData.kdsStatus === "ready"
                    ? item.readyAt ?? updatedData.updatedAt
                    : item.readyAt,
              };
            }),
          ),
        );

        toast.success(result.message);
        scheduleRealtimeSync();
      } catch {
        if (!isMountedRef.current) return;
        toast.error(
          "Terjadi gangguan saat memperbarui status dapur. Silakan coba lagi.",
        );
        void syncBoard({ manual: false });
      } finally {
        if (isMountedRef.current) {
          setUpdatingOrderIds((prev) => prev.filter((id) => id !== ticket.id));
        }
      }
    },
    [scheduleRealtimeSync, syncBoard, updatingOrderIds],
  );

  // Counts by status (after applying orderType + station filters so counters match active workspace)
  const ticketsForCounts = useMemo(
    () =>
      filterKdsTickets(tickets, {
        status: "all",
        orderType: orderTypeFilter,
        station: stationFilter,
      }),
    [orderTypeFilter, stationFilter, tickets],
  );

  const counts = useMemo(() => {
    const map: Record<KdsStatus, number> = {
      queued: 0,
      preparing: 0,
      ready: 0,
    };
    for (const ticket of ticketsForCounts) {
      map[ticket.kdsStatus] += 1;
    }
    return map;
  }, [ticketsForCounts]);

  const filteredTickets = useMemo(
    () =>
      filterKdsTickets(tickets, {
        status: statusFilter,
        orderType: orderTypeFilter,
        station: stationFilter,
      }),
    [orderTypeFilter, stationFilter, statusFilter, tickets],
  );

  const ticketsByColumn = useMemo(() => {
    const grouped: Record<KdsStatus, KdsTicket[]> = {
      queued: [],
      preparing: [],
      ready: [],
    };
    for (const ticket of filteredTickets) {
      grouped[ticket.kdsStatus].push(ticket);
    }
    return grouped;
  }, [filteredTickets]);

  const visibleRefundAlerts = useMemo(
    () =>
      refundAlerts.filter(
        (alert) => !dismissedRefundIds.includes(alert.refundId),
      ),
    [dismissedRefundIds, refundAlerts],
  );

  const hasActiveFilters =
    statusFilter !== "all" ||
    orderTypeFilter !== "all" ||
    stationFilter !== "all";

  const syncedClockLabel = useMemo(() => {
    const parsed = Date.parse(syncedAt);
    return Number.isNaN(parsed) ? "--:--" : formatWibClock(parsed);
  }, [syncedAt]);

  return (
    <div className="space-y-5">
      {/* Top Operational Header */}
      <section className="flex flex-col gap-4 rounded-2xl border border-border bg-card px-5 py-4 shadow-xs lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-primary">
              <ChefHat className="size-3.5" />
              Kitchen Display System
            </span>
            <Badge variant="outline" className="text-xs font-medium">
              {ROLE_LABELS[userRole]}
            </Badge>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
                connectionState === "connected"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : connectionState === "connecting"
                    ? "border-amber-200 bg-amber-50 text-amber-800"
                    : "border-orange-200 bg-orange-50 text-orange-800",
              )}
            >
              {connectionState === "connected" ? (
                <>
                  <Wifi className="size-3" />
                  Terhubung Realtime
                </>
              ) : connectionState === "connecting" ? (
                <>
                  <Clock3 className="size-3" />
                  Menghubungkan...
                </>
              ) : (
                <>
                  <WifiOff className="size-3" />
                  Mode Polling Otomatis
                </>
              )}
            </span>
          </div>

          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Antrean Pesanan Dapur
          </h1>
          <p className="text-sm text-muted-foreground">
            Pesanan lunas masuk otomatis dari kasir. Proses berurutan dari
            Pesanan Masuk hingga Siap Diambil.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="rounded-xl border border-border bg-muted/40 px-3.5 py-2 text-right">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Sinkron Terakhir
            </p>
            <p className="font-mono text-sm font-semibold tabular-nums text-foreground">
              {syncedClockLabel}
            </p>
          </div>

          <Button
            type="button"
            variant="outline"
            size="default"
            disabled={isRefreshing}
            onClick={() => void syncBoard({ manual: true })}
            className="h-11 gap-2 rounded-xl px-4 font-semibold"
          >
            <RefreshCw
              className={cn("size-4", isRefreshing && "animate-spin")}
            />
            Segarkan
          </Button>
        </div>
      </section>

      {/* Sync Error Banner */}
      {syncError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <span className="font-medium">{syncError}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void syncBoard({ manual: true })}
            className="border-destructive/30 bg-background text-destructive hover:bg-destructive/10"
          >
            Coba Lagi
          </Button>
        </div>
      ) : null}

      {/* Full Refund Termination Alerts (FR-KDS-08) */}
      {visibleRefundAlerts.length > 0 ? (
        <section
          aria-label="Notifikasi Pembatalan Refund Penuh"
          className="space-y-2"
        >
          {visibleRefundAlerts.map((alert) => (
            <div
              key={alert.refundId}
              className="flex items-start justify-between gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive shadow-xs"
            >
              <div className="flex items-start gap-3">
                <AlertOctagon className="mt-0.5 size-5 shrink-0" />
                <div className="space-y-0.5 text-sm">
                  <p className="font-bold">
                    Hentikan Persiapan:{" "}
                    {alert.queueNumber
                      ? `${alert.queueNumber} (${alert.orderNumber})`
                      : alert.orderNumber}
                    {alert.orderType === "dine_in" && alert.tableName
                      ? ` · Meja ${alert.tableName}`
                      : alert.orderType === "takeaway"
                        ? " · Takeaway"
                        : ""}
                  </p>
                  <p className="text-xs font-medium text-destructive/90">
                    Pesanan dibatalkan melalui Refund Penuh ({alert.reason}).
                    Tiket telah dihapus dari antrean dapur aktif.
                  </p>
                </div>
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Tutup notifikasi refund"
                onClick={() =>
                  setDismissedRefundIds((prev) => [...prev, alert.refundId])
                }
                className="shrink-0 text-destructive hover:bg-destructive/15 hover:text-destructive"
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
        </section>
      ) : null}

      {/* Summary Counters */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => setStatusFilter("all")}
          className={cn(
            "flex items-center justify-between rounded-2xl border px-4 py-3.5 text-left transition-all",
            statusFilter === "all"
              ? "border-primary bg-primary text-primary-foreground shadow-sm"
              : "border-border bg-card text-foreground hover:border-primary/40",
          )}
        >
          <div>
            <p
              className={cn(
                "text-xs font-semibold uppercase tracking-wider",
                statusFilter === "all"
                  ? "text-primary-foreground/80"
                  : "text-muted-foreground",
              )}
            >
              Total Aktif
            </p>
            <p className="mt-1 font-display text-3xl font-bold tabular-nums">
              {ticketsForCounts.length}
            </p>
          </div>
          <ChefHat
            className={cn(
              "size-7 opacity-80",
              statusFilter === "all"
                ? "text-primary-foreground"
                : "text-primary",
            )}
          />
        </button>

        <button
          type="button"
          onClick={() =>
            setStatusFilter((prev) => (prev === "queued" ? "all" : "queued"))
          }
          className={cn(
            "flex items-center justify-between rounded-2xl border px-4 py-3.5 text-left transition-all",
            statusFilter === "queued"
              ? "border-primary bg-brand-soft text-primary ring-2 ring-primary/20"
              : "border-border bg-card text-foreground hover:border-primary/40",
          )}
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {KDS_STATUS_LABELS.queued}
            </p>
            <p className="mt-1 font-display text-3xl font-bold tabular-nums text-primary">
              {counts.queued}
            </p>
          </div>
          <Inbox className="size-7 text-primary/75" />
        </button>

        <button
          type="button"
          onClick={() =>
            setStatusFilter((prev) =>
              prev === "preparing" ? "all" : "preparing",
            )
          }
          className={cn(
            "flex items-center justify-between rounded-2xl border px-4 py-3.5 text-left transition-all",
            statusFilter === "preparing"
              ? "border-amber-500 bg-amber-50 text-amber-950 ring-2 ring-amber-500/20"
              : "border-border bg-card text-foreground hover:border-amber-400",
          )}
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {KDS_STATUS_LABELS.preparing}
            </p>
            <p className="mt-1 font-display text-3xl font-bold tabular-nums text-amber-700">
              {counts.preparing}
            </p>
          </div>
          <Flame className="size-7 text-amber-600/80" />
        </button>

        <button
          type="button"
          onClick={() =>
            setStatusFilter((prev) => (prev === "ready" ? "all" : "ready"))
          }
          className={cn(
            "flex items-center justify-between rounded-2xl border px-4 py-3.5 text-left transition-all",
            statusFilter === "ready"
              ? "border-emerald-600 bg-emerald-50 text-emerald-950 ring-2 ring-emerald-600/20"
              : "border-border bg-card text-foreground hover:border-emerald-400",
          )}
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {KDS_STATUS_LABELS.ready}
            </p>
            <p className="mt-1 font-display text-3xl font-bold tabular-nums text-emerald-700">
              {counts.ready}
            </p>
          </div>
          <CheckCircle2 className="size-7 text-emerald-600/80" />
        </button>
      </section>

      {/* Filter Toolbar */}
      <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-4">
          {/* Order Type Filter */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Tipe:
            </span>
            <Button
              type="button"
              size="sm"
              variant={orderTypeFilter === "all" ? "default" : "outline"}
              onClick={() => setOrderTypeFilter("all")}
              className="h-8 rounded-lg px-3 text-xs font-semibold"
            >
              Semua
            </Button>
            <Button
              type="button"
              size="sm"
              variant={orderTypeFilter === "dine_in" ? "default" : "outline"}
              onClick={() => setOrderTypeFilter("dine_in")}
              className="h-8 gap-1.5 rounded-lg px-3 text-xs font-semibold"
            >
              <Utensils className="size-3.5" />
              Dine-in
            </Button>
            <Button
              type="button"
              size="sm"
              variant={orderTypeFilter === "takeaway" ? "default" : "outline"}
              onClick={() => setOrderTypeFilter("takeaway")}
              className="h-8 gap-1.5 rounded-lg px-3 text-xs font-semibold"
            >
              <ShoppingBag className="size-3.5" />
              Takeaway
            </Button>
          </div>

          <div className="hidden h-5 w-px bg-border sm:block" />

          {/* Station Filter */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Stasiun:
            </span>
            <Button
              type="button"
              size="sm"
              variant={stationFilter === "all" ? "default" : "outline"}
              onClick={() => setStationFilter("all")}
              className="h-8 rounded-lg px-3 text-xs font-semibold"
            >
              Semua Stasiun
            </Button>
            {availableStations.map((station) => (
              <Button
                key={station}
                type="button"
                size="sm"
                variant={stationFilter === station ? "default" : "outline"}
                onClick={() => setStationFilter(station)}
                className="h-8 rounded-lg px-3 text-xs font-semibold"
              >
                {getKitchenStationLabel(station)}
              </Button>
            ))}
          </div>
        </div>

        {hasActiveFilters ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setStatusFilter("all");
              setOrderTypeFilter("all");
              setStationFilter("all");
            }}
            className="h-8 gap-1.5 self-start text-xs font-semibold text-muted-foreground hover:text-foreground lg:self-auto"
          >
            <RotateCcw className="size-3.5" />
            Reset Filter
          </Button>
        ) : null}
      </section>

      {/* Main Ticket Board */}
      {statusFilter === "all" ? (
        <section className="grid grid-cols-1 gap-5 xl:grid-cols-3">
          {KDS_STATUS_ORDER.map((status) => {
            const columnTickets = ticketsByColumn[status];
            const columnHeaderAccent =
              status === "queued"
                ? "border-primary/25 bg-brand-soft/60 text-primary"
                : status === "preparing"
                  ? "border-amber-300/70 bg-amber-50 text-amber-950"
                  : "border-emerald-300/70 bg-emerald-50 text-emerald-950";

            return (
              <div
                key={status}
                data-testid={`kds-column-${status}`}
                className="flex flex-col rounded-2xl border border-border bg-muted/25 p-3.5"
              >
                <div
                  className={cn(
                    "mb-3.5 flex items-center justify-between rounded-xl border px-3.5 py-2.5",
                    columnHeaderAccent,
                  )}
                >
                  <div>
                    <h2 className="font-display text-base font-bold">
                      {KDS_STATUS_LABELS[status]}
                    </h2>
                    <p className="text-[11px] opacity-80">
                      {KDS_STATUS_DESCRIPTIONS[status]}
                    </p>
                  </div>
                  <span className="inline-flex min-w-8 items-center justify-center rounded-full bg-background px-2.5 py-1 text-sm font-bold tabular-nums text-foreground shadow-xs">
                    {columnTickets.length}
                  </span>
                </div>

                {columnTickets.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-background/70 px-4 py-12 text-center">
                    <ChefHat className="size-8 text-muted-foreground/45" />
                    <p className="mt-2.5 text-sm font-semibold text-foreground/80">
                      Belum ada tiket di tahap ini
                    </p>
                    <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                      {status === "queued"
                        ? "Pesanan lunas dari kasir akan langsung muncul di sini."
                        : status === "preparing"
                          ? "Klik \"Mulai Siapkan\" pada tiket masuk untuk mulai memasak."
                          : "Pesanan yang ditandai siap akan menunggu diambil kasir."}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3.5">
                    {columnTickets.map((ticket) => (
                      <KdsTicketCard
                        key={ticket.id}
                        ticket={ticket}
                        nowMs={nowMs}
                        activeStationFilter={stationFilter}
                        isUpdating={updatingOrderIds.includes(ticket.id)}
                        onAdvanceStatus={(target, next) =>
                          void handleAdvanceStatus(target, next)
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ) : (
        <section className="space-y-3.5">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-bold text-foreground">
              {KDS_STATUS_LABELS[statusFilter]} ({filteredTickets.length})
            </h2>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setStatusFilter("all")}
              className="rounded-lg text-xs font-semibold"
            >
              Tampilkan Semua Kolom
            </Button>
          </div>

          {filteredTickets.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center">
              <ChefHat className="size-10 text-muted-foreground/45" />
              <p className="mt-3 text-base font-semibold text-foreground">
                Tidak ada pesanan sesuai filter aktif
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Coba ubah filter status, tipe pesanan, atau stasiun dapur.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {filteredTickets.map((ticket) => (
                <KdsTicketCard
                  key={ticket.id}
                  ticket={ticket}
                  nowMs={nowMs}
                  activeStationFilter={stationFilter}
                  isUpdating={updatingOrderIds.includes(ticket.id)}
                  onAdvanceStatus={(target, next) =>
                    void handleAdvanceStatus(target, next)
                  }
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
