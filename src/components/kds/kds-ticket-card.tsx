"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChefHat,
  Clock3,
  Flame,
  Loader2,
  PlusCircle,
  ShoppingBag,
  StickyNote,
  Utensils,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  formatElapsedDuration,
  getElapsedMinutes,
  getKitchenStationLabel,
  getNextKdsStatus,
  getTicketUrgency,
  KDS_NEXT_ACTION_LABELS,
  KDS_STATUS_LABELS,
  normalizeKitchenStation,
} from "@/lib/kds/transitions";
import type { KdsStationFilter, KdsTicket } from "@/lib/kds/types";
import { cn } from "@/lib/utils";
import type { KdsStatus } from "@/types/database";

type KdsTicketCardProps = {
  ticket: KdsTicket;
  nowMs: number;
  activeStationFilter: KdsStationFilter;
  isUpdating: boolean;
  onAdvanceStatus: (ticket: KdsTicket, nextStatus: KdsStatus) => void;
};

const WIB_TIME_FORMATTER = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatWibTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return WIB_TIME_FORMATTER.format(date);
}

function getStationBadgeClass(station: string): string {
  switch (station) {
    case "bar":
      return "border-sky-200 bg-sky-50 text-sky-800";
    case "dessert":
      return "border-pink-200 bg-pink-50 text-pink-800";
    default:
      return "border-emerald-200 bg-emerald-50 text-emerald-900";
  }
}

export function KdsTicketCard({
  ticket,
  nowMs,
  activeStationFilter,
  isUpdating,
  onAdvanceStatus,
}: KdsTicketCardProps) {
  const elapsedMinutes = getElapsedMinutes(ticket.createdAt, nowMs);
  const urgency = getTicketUrgency(elapsedMinutes, ticket.kdsStatus);
  const elapsedLabel = formatElapsedDuration(ticket.createdAt, nowMs);
  const nextStatus = getNextKdsStatus(ticket.kdsStatus);

  const normalizedFilter =
    activeStationFilter === "all"
      ? null
      : normalizeKitchenStation(activeStationFilter);

  const primaryItems = normalizedFilter
    ? ticket.items.filter((item) => item.kitchenStation === normalizedFilter)
    : ticket.items;
  const otherStationItems = normalizedFilter
    ? ticket.items.filter((item) => item.kitchenStation !== normalizedFilter)
    : [];

  const totalItemQty = ticket.items.reduce((sum, item) => sum + item.quantity, 0);
  const createdTime = formatWibTime(ticket.createdAt);
  const startedTime = formatWibTime(ticket.startedAt);
  const readyTime = formatWibTime(ticket.readyAt);

  const headerAccentClass =
    urgency === "overdue"
      ? "border-t-4 border-t-destructive bg-destructive/5"
      : urgency === "warning"
        ? "border-t-4 border-t-amber-500 bg-amber-50/70"
        : ticket.kdsStatus === "ready"
          ? "border-t-4 border-t-emerald-600 bg-emerald-50/60"
          : ticket.kdsStatus === "preparing"
            ? "border-t-4 border-t-amber-500 bg-amber-50/40"
            : "border-t-4 border-t-primary bg-brand-soft/45";

  const durationBadgeClass =
    urgency === "overdue"
      ? "border-destructive/40 bg-destructive text-destructive-foreground"
      : urgency === "warning"
        ? "border-amber-400 bg-amber-100 text-amber-950"
        : ticket.kdsStatus === "ready"
          ? "border-emerald-300 bg-emerald-100 text-emerald-900"
          : "border-border bg-background text-foreground";

  return (
    <article
      data-testid={`kds-ticket-${ticket.id}`}
      data-kds-status={ticket.kdsStatus}
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border bg-card shadow-sm transition-shadow hover:shadow-md",
        urgency === "overdue"
          ? "border-destructive/50 ring-1 ring-destructive/20"
          : urgency === "warning"
            ? "border-amber-300"
            : ticket.kdsStatus === "ready"
              ? "border-emerald-200"
              : "border-border",
      )}
    >
      {/* Ticket Header */}
      <div className={cn("space-y-2.5 border-b border-border/80 px-4 py-3.5", headerAccentClass)}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-display text-2xl font-bold tracking-tight tabular-nums text-foreground">
                {ticket.queueNumber ?? `#${ticket.orderNumber.slice(-4)}`}
              </span>
              <span className="truncate font-mono text-xs font-medium text-muted-foreground">
                {ticket.orderNumber}
              </span>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {ticket.orderType === "dine_in" ? (
                <Badge
                  variant="secondary"
                  className="gap-1 border border-primary/20 bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary"
                >
                  <Utensils className="size-3" />
                  {ticket.tableName ? `Meja ${ticket.tableName}` : "Dine-in"}
                </Badge>
              ) : (
                <Badge
                  variant="secondary"
                  className="gap-1 border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-800"
                >
                  <ShoppingBag className="size-3" />
                  Takeaway
                </Badge>
              )}

              {ticket.isAdditionalOrder ? (
                <Badge
                  variant="outline"
                  className="gap-1 border-amber-400 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-950"
                >
                  <PlusCircle className="size-3" />
                  Pesanan Tambahan
                  {ticket.sessionOrderIndex > 1
                    ? ` #${ticket.sessionOrderIndex}`
                    : ""}
                </Badge>
              ) : null}

              <Badge
                variant="outline"
                className="border-border/80 bg-background/80 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
              >
                {totalItemQty} porsi
              </Badge>
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-bold tabular-nums",
                durationBadgeClass,
              )}
              title="Durasi sejak pesanan masuk"
            >
              {urgency === "overdue" ? (
                <AlertTriangle className="size-3.5 shrink-0" />
              ) : (
                <Clock3 className="size-3.5 shrink-0" />
              )}
              {elapsedLabel}
            </span>
            {urgency === "overdue" ? (
              <span className="text-[11px] font-semibold uppercase tracking-wide text-destructive">
                Prioritas / Lama
              </span>
            ) : urgency === "warning" ? (
              <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                Segera Proses
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Items Section */}
      <div className="flex-1 space-y-3 px-4 py-3.5">
        {ticket.orderNotes ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-300/80 bg-amber-50 px-3 py-2 text-xs text-amber-950">
            <StickyNote className="mt-0.5 size-3.5 shrink-0 text-amber-700" />
            <div className="min-w-0">
              <span className="font-semibold">Catatan Pesanan: </span>
              <span className="break-words">{ticket.orderNotes}</span>
            </div>
          </div>
        ) : null}

        <ul className="divide-y divide-border/60">
          {primaryItems.map((item) => (
            <li key={item.id} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 inline-flex min-w-8 shrink-0 items-center justify-center rounded-lg bg-primary px-2 py-0.5 text-sm font-bold tabular-nums text-primary-foreground">
                  {item.quantity}×
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <p className="text-sm font-semibold leading-snug text-foreground">
                      {item.productName}
                    </p>
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                        getStationBadgeClass(item.kitchenStation),
                      )}
                    >
                      {getKitchenStationLabel(item.kitchenStation)}
                    </span>
                  </div>

                  {item.modifiers.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {item.modifiers.map((mod) => (
                        <span
                          key={mod.id}
                          className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-foreground/90"
                        >
                          <span className="text-muted-foreground">
                            {mod.groupName}:
                          </span>
                          <span className="ml-1 font-semibold">
                            {mod.optionName}
                          </span>
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {item.notes ? (
                    <p className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50/80 px-2.5 py-1 text-xs font-medium text-amber-950">
                      Catatan: {item.notes}
                    </p>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>

        {otherStationItems.length > 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground/80">
              +{otherStationItems.length} item stasiun lain:{" "}
            </span>
            {otherStationItems
              .map((item) => `${item.quantity}× ${item.productName}`)
              .join(", ")}
          </div>
        ) : null}
      </div>

      {/* Timestamps & Action Footer */}
      <div className="space-y-3 border-t border-border/80 bg-muted/20 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
            {createdTime ? <span>Masuk {createdTime}</span> : null}
            {startedTime ? <span>Mulai {startedTime}</span> : null}
            {readyTime ? <span>Siap {readyTime}</span> : null}
          </div>
          <span className="font-semibold text-foreground/75">
            {KDS_STATUS_LABELS[ticket.kdsStatus]}
          </span>
        </div>

        {nextStatus ? (
          <Button
            type="button"
            disabled={isUpdating}
            onClick={() => onAdvanceStatus(ticket, nextStatus)}
            className={cn(
              "h-11 w-full rounded-xl text-sm font-semibold shadow-xs transition-all",
              ticket.kdsStatus === "queued"
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-emerald-700 text-white hover:bg-emerald-800",
            )}
          >
            {isUpdating ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Memperbarui status...
              </>
            ) : ticket.kdsStatus === "queued" ? (
              <>
                <Flame className="size-4" />
                {KDS_NEXT_ACTION_LABELS.queued}
              </>
            ) : (
              <>
                <CheckCircle2 className="size-4" />
                {KDS_NEXT_ACTION_LABELS.preparing}
              </>
            )}
          </Button>
        ) : (
          <div className="flex h-11 items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-sm font-semibold text-emerald-900">
            <ChefHat className="size-4 text-emerald-700" />
            Siap Diambil · Menunggu Kasir
          </div>
        )}
      </div>
    </article>
  );
}
