"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  ChefHat,
  ClipboardList,
  Clock3,
  CreditCard,
  Eye,
  Info,
  Loader2,
  Lock,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  ShoppingBag,
  Utensils,
  Wifi,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import { OrderCancelModal } from "@/components/pos/order-cancel-modal";
import { OrderConfirmationModal } from "@/components/pos/order-confirmation-modal";
import { PaymentModal } from "@/components/pos/payment-modal";
import { ReceiptModal } from "@/components/pos/receipt-modal";
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
import { Input } from "@/components/ui/input";
import { formatRupiah } from "@/lib/menu/format";
import {
  CASHIER_ORDER_FILTER_LABELS,
  CASHIER_ORDER_FILTERS,
  filterCashierOrders,
  getKitchenStatusLabel,
  getPaymentStatusLabel,
  getServingStatusLabel,
  matchesCashierOrderFilter,
  mergeCashierOrdersById,
  type CashierOrderFilter,
  type CashierOrderListItem,
  type CashierOrdersBoardData,
} from "@/lib/orders/cashier-orders";
import {
  getCashierOrderDetailsAction,
  getCashierOrdersAction,
} from "@/lib/orders/cashier-orders-actions";
import { confirmOrderServedAction } from "@/lib/orders/serving-actions";
import type { OrderWithDetails } from "@/lib/orders/types";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { OrderType } from "@/types/database";

type CashierOrdersBoardProps = {
  initialData: CashierOrdersBoardData;
  userRole: string;
  initialError?: string | null;
};

type ConnectionState = "connecting" | "connected" | "polling";

const REALTIME_DEBOUNCE_MS = 250;
const FALLBACK_POLL_INTERVAL_MS = 8_000;
const SAFETY_SYNC_INTERVAL_MS = 30_000;

const WIB_DATETIME_FORMATTER = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const WIB_TIME_FORMATTER = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatWibDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return `${WIB_DATETIME_FORMATTER.format(date)} WIB`;
}

function formatWibTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return `${WIB_TIME_FORMATTER.format(date)} WIB`;
}

export function CashierOrdersBoard({
  initialData,
  userRole,
  initialError = null,
}: CashierOrdersBoardProps) {
  const [orders, setOrders] = useState<CashierOrderListItem[]>(() =>
    mergeCashierOrdersById(initialData.orders),
  );
  const [servingSchemaReady, setServingSchemaReady] = useState(
    initialData.servingSchemaReady,
  );
  const [syncedAt, setSyncedAt] = useState(initialData.syncedAt);

  const [statusFilter, setStatusFilter] = useState<CashierOrderFilter>("all");
  const [orderTypeFilter, setOrderTypeFilter] = useState<"all" | OrderType>(
    "all",
  );
  const [searchQuery, setSearchQuery] = useState("");

  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(initialError);

  // Action modal states (reusing authoritative POS modals)
  const [loadingOrderId, setLoadingOrderId] = useState<string | null>(null);
  const [confirmedOrder, setConfirmedOrder] =
    useState<OrderWithDetails | null>(null);
  const [paymentOrder, setPaymentOrder] = useState<OrderWithDetails | null>(
    null,
  );
  const [orderToCancel, setOrderToCancel] = useState<OrderWithDetails | null>(
    null,
  );
  const [receiptOrderId, setReceiptOrderId] = useState<string | null>(null);

  // Serving confirmation dialog state
  const [orderToServe, setOrderToServe] =
    useState<CashierOrderListItem | null>(null);
  const [isConfirmingServe, setIsConfirmingServe] = useState(false);

  const inFlightRefreshRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  const syncOrders = useCallback(async (options?: { manual?: boolean }) => {
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
          const result = await getCashierOrdersAction();
          if (!isMountedRef.current) return;

          if (!result.ok || !result.data) {
            setSyncError(result.message);
            if (isManual) {
              toast.error(result.message);
            }
          } else {
            setOrders(mergeCashierOrdersById(result.data.orders));
            setServingSchemaReady(result.data.servingSchemaReady);
            setSyncedAt(result.data.syncedAt);
            setSyncError(null);
            if (isManual) {
              toast.success("Daftar pesanan berhasil disegarkan.");
            }
          }
        } catch {
          if (!isMountedRef.current) return;
          const msg = "Gagal menyinkronkan daftar pesanan.";
          setSyncError(msg);
          if (isManual) {
            toast.error(msg);
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
      void syncOrders({ manual: false });
    }, REALTIME_DEBOUNCE_MS);
  }, [syncOrders]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Supabase Realtime on public.orders
  useEffect(() => {
    let supabase: ReturnType<typeof createSupabaseBrowserClient> | null = null;
    try {
      supabase = createSupabaseBrowserClient();
    } catch {
      const t = setTimeout(() => {
        if (isMountedRef.current) setConnectionState("polling");
      }, 0);
      return () => clearTimeout(t);
    }

    const channel = supabase
      .channel("cashier-orders-list")
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

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void syncOrders({ manual: false });
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      if (supabase) {
        void supabase.removeChannel(channel);
      }
    };
  }, [scheduleRealtimeSync, syncOrders]);

  // Fallback polling
  useEffect(() => {
    const intervalMs =
      connectionState === "connected"
        ? SAFETY_SYNC_INTERVAL_MS
        : FALLBACK_POLL_INTERVAL_MS;

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void syncOrders({ manual: false });
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }, [connectionState, syncOrders]);

  const handleOpenOrderAction = async (
    orderId: string,
    targetModal: "confirmation" | "payment",
  ) => {
    if (loadingOrderId) return;
    setLoadingOrderId(orderId);

    try {
      const result = await getCashierOrderDetailsAction(orderId);
      if (!isMountedRef.current) return;

      if (!result.ok || !result.data) {
        toast.error(result.message);
        return;
      }

      if (targetModal === "payment" && result.data.is_finalized) {
        setPaymentOrder(result.data);
      } else {
        setConfirmedOrder(result.data);
      }
    } catch {
      toast.error("Gagal memuat detail pesanan.");
    } finally {
      if (isMountedRef.current) {
        setLoadingOrderId(null);
      }
    }
  };

  const handleConfirmServe = async () => {
    if (!orderToServe || isConfirmingServe) return;
    setIsConfirmingServe(true);

    try {
      const result = await confirmOrderServedAction(orderToServe.id);
      if (!isMountedRef.current) return;

      if (!result.ok) {
        toast.error(result.message);
        setOrderToServe(null);
        void syncOrders({ manual: false });
        return;
      }

      toast.success(result.message);
      setOrderToServe(null);
      void syncOrders({ manual: false });
    } catch {
      toast.error("Gagal menyimpan konfirmasi penyajian.");
    } finally {
      if (isMountedRef.current) {
        setIsConfirmingServe(false);
      }
    }
  };

  // Counts per filter tab (respecting orderTypeFilter so badges stay accurate)
  const ordersByType = useMemo(
    () =>
      orderTypeFilter === "all"
        ? orders
        : orders.filter((o) => o.orderType === orderTypeFilter),
    [orderTypeFilter, orders],
  );

  const filterCounts = useMemo(() => {
    const map: Record<CashierOrderFilter, number> = {
      all: ordersByType.length,
      awaiting_payment: 0,
      queued: 0,
      preparing: 0,
      ready: 0,
      served: 0,
    };
    for (const order of ordersByType) {
      for (const filter of CASHIER_ORDER_FILTERS) {
        if (filter !== "all" && matchesCashierOrderFilter(order, filter)) {
          map[filter] += 1;
        }
      }
    }
    return map;
  }, [ordersByType]);

  const filteredOrders = useMemo(
    () =>
      filterCashierOrders(orders, {
        statusFilter,
        orderTypeFilter,
        searchQuery,
      }),
    [orderTypeFilter, orders, searchQuery, statusFilter],
  );

  return (
    <>
      <div className="space-y-4">
        {/* Top Action & Status Bar */}
        <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-xs lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold",
                connectionState === "connected"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-amber-200 bg-amber-50 text-amber-800",
              )}
            >
              {connectionState === "connected" ? (
                <>
                  <Wifi className="size-3.5" />
                  Terhubung Realtime
                </>
              ) : (
                <>
                  <WifiOff className="size-3.5" />
                  Mode Polling Otomatis
                </>
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              Sinkron terakhir: <strong>{formatWibTime(syncedAt)}</strong> ·{" "}
              {orders.length} pesanan (48 jam terakhir & aktif)
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isRefreshing}
              onClick={() => void syncOrders({ manual: true })}
              className="h-9 gap-1.5 rounded-xl px-3.5 text-xs font-semibold"
            >
              <RefreshCw
                className={cn("size-3.5", isRefreshing && "animate-spin")}
              />
              Segarkan
            </Button>
            <Button
              asChild
              size="sm"
              className="h-9 gap-1.5 rounded-xl bg-primary px-4 text-xs font-semibold text-primary-foreground"
            >
              <Link href="/pos">
                <Plus className="size-3.5" />
                Buat Pesanan Baru
              </Link>
            </Button>
          </div>
        </section>

        {syncError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-xs font-medium text-destructive">
            {syncError}
          </div>
        ) : null}

        {/* Filter Tabs + Search + Type Filter */}
        <section className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-xs">
          {/* Status Filter Pills */}
          <div className="flex flex-wrap items-center gap-1.5">
            {CASHIER_ORDER_FILTERS.map((filter) => {
              const active = statusFilter === filter;
              const count = filterCounts[filter];
              return (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setStatusFilter(filter)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer",
                    active
                      ? "border-primary bg-primary text-primary-foreground shadow-xs"
                      : "border-border bg-background text-foreground hover:border-primary/40 hover:bg-muted/40",
                  )}
                >
                  <span>{CASHIER_ORDER_FILTER_LABELS[filter]}</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums",
                      active
                        ? "bg-primary-foreground/20 text-primary-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Search & Order Type Filter */}
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1 sm:max-w-md">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Cari nomor pesanan, antrean, meja, atau menu..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 rounded-xl pl-9 text-xs"
              />
            </div>

            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant={orderTypeFilter === "all" ? "default" : "outline"}
                onClick={() => setOrderTypeFilter("all")}
                className="h-8 rounded-lg px-3 text-xs font-semibold"
              >
                Semua Tipe
              </Button>
              <Button
                type="button"
                size="sm"
                variant={orderTypeFilter === "dine_in" ? "default" : "outline"}
                onClick={() => setOrderTypeFilter("dine_in")}
                className="h-8 gap-1 rounded-lg px-3 text-xs font-semibold"
              >
                <Utensils className="size-3" />
                Dine-in
              </Button>
              <Button
                type="button"
                size="sm"
                variant={orderTypeFilter === "takeaway" ? "default" : "outline"}
                onClick={() => setOrderTypeFilter("takeaway")}
                className="h-8 gap-1 rounded-lg px-3 text-xs font-semibold"
              >
                <ShoppingBag className="size-3" />
                Takeaway
              </Button>
            </div>
          </div>
        </section>

        {/* Orders List */}
        {filteredOrders.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center">
            <ClipboardList className="size-10 text-muted-foreground/45" />
            <p className="mt-3 text-sm font-semibold text-foreground">
              Tidak ada pesanan sesuai filter saat ini
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Pesanan baru yang dibuat kasir akan langsung muncul di sini secara
              otomatis.
            </p>
          </div>
        ) : (
          <section className="space-y-3">
            {filteredOrders.map((order) => {
              const isUnpaid =
                order.status === "awaiting_payment" ||
                order.status === "partially_paid";
              const isReadyToServe =
                order.status === "paid" &&
                order.kdsStatus === "ready" &&
                !order.servedAt;
              const isPaidOrDone =
                order.status === "paid" ||
                order.status === "completed" ||
                order.paymentStatus === "partially_refunded";
              const isLoadingThis = loadingOrderId === order.id;

              const paymentBadgeClass =
                order.paymentStatus === "paid"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : order.paymentStatus === "partially_paid"
                    ? "border-amber-300 bg-amber-50 text-amber-900"
                    : order.paymentStatus === "refunded"
                      ? "border-destructive/30 bg-destructive/10 text-destructive"
                      : order.paymentStatus === "partially_refunded"
                        ? "border-sky-200 bg-sky-50 text-sky-800"
                        : "border-orange-300 bg-orange-50 text-orange-900";

              const kdsBadgeClass =
                order.kdsStatus === "ready"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                  : order.kdsStatus === "preparing"
                    ? "border-amber-300 bg-amber-50 text-amber-900"
                    : order.kdsStatus === "queued"
                      ? "border-primary/30 bg-brand-soft/60 text-primary"
                      : "border-border bg-muted/50 text-muted-foreground";

              const servingBadgeClass = order.servedAt
                ? "border-emerald-300 bg-emerald-100/80 text-emerald-900"
                : isReadyToServe
                  ? "border-emerald-500 bg-emerald-600 text-white"
                  : "border-border bg-muted/40 text-muted-foreground";

              return (
                <article
                  key={order.id}
                  data-testid={`cashier-order-row-${order.id}`}
                  className={cn(
                    "rounded-2xl border bg-card p-4 shadow-xs transition-shadow hover:shadow-sm",
                    isReadyToServe
                      ? "border-emerald-300 ring-1 ring-emerald-200"
                      : isUnpaid
                        ? "border-amber-200/90"
                        : "border-border",
                  )}
                >
                  <div className="flex flex-col gap-3.5 lg:flex-row lg:items-start lg:justify-between">
                    {/* Left: Order Identity, Type, Items */}
                    <div className="min-w-0 flex-1 space-y-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        {order.queueNumber ? (
                          <span className="rounded-lg bg-primary px-2 py-0.5 font-display text-sm font-bold tabular-nums text-primary-foreground">
                            {order.queueNumber}
                          </span>
                        ) : null}
                        <span className="font-mono text-sm font-bold text-foreground">
                          {order.orderNumber}
                        </span>
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock3 className="size-3" />
                          {formatWibDateTime(order.createdAt)}
                        </span>

                        {order.orderType === "dine_in" ? (
                          <Badge
                            variant="secondary"
                            className="gap-1 border border-primary/20 bg-primary/10 text-xs font-semibold text-primary"
                          >
                            <Utensils className="size-3" />
                            {order.tableName
                              ? `Dine-in · Meja ${order.tableName}`
                              : "Dine-in"}
                          </Badge>
                        ) : (
                          <Badge
                            variant="secondary"
                            className="gap-1 border border-slate-300 bg-slate-100 text-xs font-semibold text-slate-800"
                          >
                            <ShoppingBag className="size-3" />
                            Takeaway
                            {order.customerName
                              ? ` · ${order.customerName}`
                              : ""}
                          </Badge>
                        )}
                      </div>

                      {/* Items Summary */}
                      <div className="rounded-xl bg-muted/35 px-3 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          {order.items.map((item) => (
                            <span key={item.id} className="text-foreground">
                              <strong className="font-bold tabular-nums text-primary">
                                {item.quantity}×
                              </strong>{" "}
                              {item.productName}
                            </span>
                          ))}
                          <span className="ml-auto font-medium text-muted-foreground">
                            ({order.totalItemCount} item)
                          </span>
                        </div>
                      </div>

                      {/* 3 Authoritative Statuses: Pembayaran, Dapur, Penyajian */}
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 font-semibold",
                            paymentBadgeClass,
                          )}
                        >
                          <CreditCard className="size-3" />
                          Bayar: {getPaymentStatusLabel(order.paymentStatus)}
                        </span>

                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 font-semibold",
                            kdsBadgeClass,
                          )}
                        >
                          <ChefHat className="size-3" />
                          Dapur: {getKitchenStatusLabel(order)}
                        </span>

                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 font-semibold",
                            servingBadgeClass,
                          )}
                        >
                          <CheckCircle2 className="size-3" />
                          Penyajian: {getServingStatusLabel(order)}
                          {order.servedAt
                            ? ` (${formatWibTime(order.servedAt)})`
                            : ""}
                        </span>
                      </div>
                    </div>

                    {/* Right: Totals & Actions */}
                    <div className="flex shrink-0 flex-col justify-between gap-3 border-t border-border/70 pt-3 lg:w-64 lg:items-end lg:border-t-0 lg:pt-0">
                      <div className="flex items-baseline justify-between gap-3 lg:flex-col lg:items-end lg:gap-0.5">
                        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                          Total Tagihan
                        </span>
                        <span className="font-display text-lg font-bold tabular-nums text-primary">
                          {formatRupiah(order.grandTotal)}
                        </span>
                        {order.remainingBalance > 0 && isUnpaid ? (
                          <span className="text-[11px] font-semibold tabular-nums text-amber-700">
                            Sisa: {formatRupiah(order.remainingBalance)}
                          </span>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                        {isUnpaid ? (
                          order.isFinalized ? (
                            <Button
                              type="button"
                              size="sm"
                              disabled={isLoadingThis}
                              onClick={() =>
                                void handleOpenOrderAction(order.id, "payment")
                              }
                              className="h-9 gap-1.5 rounded-xl bg-primary px-3.5 text-xs font-bold text-primary-foreground"
                            >
                              {isLoadingThis ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <CreditCard className="size-3.5" />
                              )}
                              {order.paymentStatus === "partially_paid"
                                ? "Lanjutkan Pembayaran"
                                : "Proses Pembayaran"}
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              disabled={isLoadingThis}
                              onClick={() =>
                                void handleOpenOrderAction(
                                  order.id,
                                  "confirmation",
                                )
                              }
                              className="h-9 gap-1.5 rounded-xl bg-primary px-3.5 text-xs font-bold text-primary-foreground"
                            >
                              {isLoadingThis ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Lock className="size-3.5" />
                              )}
                              Finalisasi & Bayar
                            </Button>
                          )
                        ) : null}

                        {isReadyToServe ? (
                          <Button
                            type="button"
                            size="sm"
                            disabled={!servingSchemaReady}
                            onClick={() => setOrderToServe(order)}
                            className="h-9 gap-1.5 rounded-xl bg-emerald-700 px-3.5 text-xs font-bold text-white hover:bg-emerald-800"
                          >
                            <CheckCircle2 className="size-3.5" />
                            Tandai Sudah Disajikan
                          </Button>
                        ) : null}

                        {isPaidOrDone ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setReceiptOrderId(order.id)}
                            className="h-9 gap-1 rounded-xl px-3 text-xs font-semibold"
                          >
                            <Receipt className="size-3.5" />
                            Struk
                          </Button>
                        ) : null}

                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isLoadingThis}
                          onClick={() =>
                            void handleOpenOrderAction(order.id, "confirmation")
                          }
                          className="h-9 gap-1 rounded-xl px-3 text-xs font-semibold"
                        >
                          <Eye className="size-3.5" />
                          Detail
                        </Button>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </div>

      {/* Authoritative POS Modals (Reused Without Altering F2 Logic) */}
      <OrderConfirmationModal
        order={confirmedOrder}
        isOpen={confirmedOrder !== null}
        onClose={() => {
          setConfirmedOrder(null);
          void syncOrders({ manual: false });
        }}
        userRole={userRole}
        onOrderUpdated={(updated) => {
          setConfirmedOrder(updated);
          if (paymentOrder?.id === updated.id) {
            setPaymentOrder(updated);
          }
          void syncOrders({ manual: false });
        }}
        onOpenCancel={(order) => {
          setConfirmedOrder(null);
          setOrderToCancel(order);
        }}
        onOpenPayment={(order) => {
          setConfirmedOrder(null);
          setPaymentOrder(order);
        }}
        onOpenReceipt={(orderId) => {
          setReceiptOrderId(orderId);
        }}
      />

      <PaymentModal
        order={paymentOrder}
        isOpen={paymentOrder !== null}
        onClose={() => {
          setPaymentOrder(null);
          void syncOrders({ manual: false });
        }}
        onPaymentSuccess={(orderId, isSettled) => {
          setPaymentOrder(null);
          void syncOrders({ manual: false });
          if (isSettled) {
            setReceiptOrderId(orderId);
          } else {
            toast.info("Pembayaran parsial berhasil dicatat.");
          }
        }}
      />

      <ReceiptModal
        orderId={receiptOrderId}
        isOpen={receiptOrderId !== null}
        onClose={() => setReceiptOrderId(null)}
      />

      <OrderCancelModal
        order={orderToCancel}
        isOpen={orderToCancel !== null}
        onClose={() => setOrderToCancel(null)}
        onSuccess={() => {
          setOrderToCancel(null);
          void syncOrders({ manual: false });
        }}
      />

      {/* Serving Confirmation Dialog */}
      <Dialog
        open={orderToServe !== null}
        onOpenChange={(open) => {
          if (!open && !isConfirmingServe) {
            setOrderToServe(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-lg">
              Konfirmasi Pesanan Sudah Disajikan
            </DialogTitle>
            <DialogDescription>
              Pastikan pesanan sudah diambil dari dapur dan diserahkan kepada
              pelanggan.
            </DialogDescription>
          </DialogHeader>

          {orderToServe ? (
            <div className="space-y-3 py-1">
              <div className="flex items-center justify-between rounded-xl border border-border bg-muted/40 px-3.5 py-2.5">
                <div>
                  <p className="font-display text-lg font-bold tabular-nums">
                    {orderToServe.queueNumber ?? orderToServe.orderNumber}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {orderToServe.orderNumber}
                  </p>
                </div>
                <Badge variant="secondary" className="text-xs font-semibold">
                  {orderToServe.orderType === "dine_in"
                    ? orderToServe.tableName
                      ? `Meja ${orderToServe.tableName}`
                      : "Dine-in"
                    : "Takeaway"}
                </Badge>
              </div>

              <div className="flex items-start gap-2 rounded-xl border border-primary/20 bg-brand-soft/50 px-3 py-2.5 text-xs">
                <Info className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>
                  {orderToServe.orderType === "dine_in"
                    ? "Sesi meja dan status meja tetap terbuka sampai pelanggan selesai makan dan kasir menutup sesi meja."
                    : "Konfirmasi ini mencatat pesanan takeaway telah diserahkan kepada pelanggan."}
                </span>
              </div>
            </div>
          ) : null}

          <DialogFooter className="mx-0 mb-0 gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={isConfirmingServe}
              onClick={() => setOrderToServe(null)}
              className="rounded-xl"
            >
              Batal
            </Button>
            <Button
              type="button"
              disabled={isConfirmingServe}
              onClick={() => void handleConfirmServe()}
              className="gap-1.5 rounded-xl bg-primary text-primary-foreground"
            >
              {isConfirmingServe ? (
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
