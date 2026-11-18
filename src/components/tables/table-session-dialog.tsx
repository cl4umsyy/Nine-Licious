"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  AlertTriangle,
  CheckCheck,
  CheckCircle2,
  Clock,
  DoorOpen,
  Info,
  LoaderCircle,
  ReceiptText,
  RefreshCw,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatRupiah } from "@/lib/menu/format";
import {
  closeDiningSessionAction,
  completePosOrderAction,
  getDiningSessionSummaryAction,
} from "@/lib/orders/actions";
import { ORDER_STATUS_BADGES, ORDER_STATUS_LABELS } from "@/lib/orders/constants";
import { formatSessionCode } from "@/lib/orders/session-closure";
import type { DiningSessionSummary } from "@/lib/orders/types";
import { TABLE_SHAPE_LABELS, TABLE_STATUS_LABELS } from "@/lib/tables/constants";
import type { DiningTable, TableStatus, TableZone } from "@/types/database";

const STATUS_BADGE_STYLE: Record<TableStatus, { badge: string; dot: string }> = {
  empty: {
    badge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  awaiting_payment: {
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  occupied: {
    badge: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
    dot: "bg-rose-500",
  },
};

export type TableSessionDialogProps = {
  table: DiningTable | null;
  zones: TableZone[];
  onClose: () => void;
  onSessionClosed: (tableId: string) => void;
};

export function TableSessionDialog({
  table,
  zones,
  onClose,
  onSessionClosed,
}: TableSessionDialogProps) {
  const [sessionSummary, setSessionSummary] = useState<DiningSessionSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [isCompletingOrder, startCompletingOrder] = useTransition();
  const [isClosingSession, startClosingSession] = useTransition();

  // Reset state saat target meja berubah (pola resmi React: adjusting state on prop change)
  const [prevTableId, setPrevTableId] = useState<string | null>(table?.id ?? null);
  const currentTableId = table?.id ?? null;
  if (currentTableId !== prevTableId) {
    setPrevTableId(currentTableId);
    setSessionSummary(null);
    setLoadError(null);
    setIsConfirmOpen(false);
    setIsLoadingSummary(Boolean(currentTableId));
  }

  const refreshSummary = useCallback(() => {
    setIsLoadingSummary(true);
    setLoadError(null);
    setReloadNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!currentTableId) return;
    let cancelled = false;

    getDiningSessionSummaryAction(currentTableId)
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.data) {
          setSessionSummary(res.data);
          setLoadError(null);
        } else {
          setSessionSummary(null);
          setLoadError(res.message || "Gagal memuat ringkasan sesi meja.");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setSessionSummary(null);
        setLoadError("Terjadi gangguan saat memuat informasi sesi meja.");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingSummary(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentTableId, reloadNonce]);

  const handleCompleteOrder = (orderId: string) => {
    startCompletingOrder(async () => {
      const res = await completePosOrderAction(orderId);
      if (res.ok) {
        toast.success(res.message || "Pesanan berhasil ditandai selesai diserahkan.");
        refreshSummary();
      } else {
        toast.error(res.message || "Gagal menyelesaikan pesanan.");
      }
    });
  };

  const handleConfirmCloseSession = () => {
    if (!table || !sessionSummary?.session_id) return;
    startClosingSession(async () => {
      const res = await closeDiningSessionAction(table.id, sessionSummary.session_id!);
      if (res.ok) {
        toast.success(
          res.message || `Sesi Meja ${table.name} berhasil ditutup. Meja kini berstatus kosong.`,
        );
        setIsConfirmOpen(false);
        onSessionClosed(table.id);
        onClose();
      } else {
        toast.error(res.message || "Gagal menutup sesi meja.");
        setIsConfirmOpen(false);
        refreshSummary();
      }
    });
  };

  const zoneName = table
    ? zones.find((z) => z.id === table.zone_id)?.name ?? "-"
    : "-";
  const sessionCode = formatSessionCode(sessionSummary?.session_id);
  const statusStyle = table ? STATUS_BADGE_STYLE[table.status] : STATUS_BADGE_STYLE.empty;

  return (
    <>
      <Dialog
        open={Boolean(table)}
        onOpenChange={(open) => {
          if (!open && !isClosingSession) {
            onClose();
          }
        }}
      >
        <DialogContent className="w-[calc(100vw-1.5rem)] max-w-[640px] sm:max-w-[620px] max-h-[90dvh] flex flex-col p-0 gap-0 overflow-hidden rounded-2xl shadow-2xl">
          <DialogHeader className="px-5 sm:px-6 py-4 pr-12 border-b bg-muted/20 shrink-0 text-left">
            <div className="flex flex-wrap items-center gap-2.5">
              <DialogTitle className="font-display text-lg font-bold tracking-tight">
                Detail Meja {table?.name}
              </DialogTitle>
              {table && (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusStyle.badge}`}
                >
                  <span className={`size-1.5 rounded-full ${statusStyle.dot}`} />
                  {TABLE_STATUS_LABELS[table.status]}
                </span>
              )}
            </div>
            <DialogDescription className="text-xs text-muted-foreground">
              Informasi sesi kunjungan, rincian tagihan, pembayaran, dan penutupan sesi meja.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 sm:px-6 py-5 space-y-4 text-sm">
            {table && (
              <>
                {/* Ringkasan Meja */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs bg-muted/35 p-3.5 rounded-xl border border-border/75">
                  <div>
                    <span className="text-[11px] text-muted-foreground block">Nomor Meja</span>
                    <span className="font-bold text-foreground">{table.name}</span>
                  </div>
                  <div>
                    <span className="text-[11px] text-muted-foreground block">Area</span>
                    <span className="font-semibold text-foreground">{zoneName}</span>
                  </div>
                  <div>
                    <span className="text-[11px] text-muted-foreground block">Kapasitas</span>
                    <span className="font-semibold text-foreground">{table.capacity} orang</span>
                  </div>
                  <div>
                    <span className="text-[11px] text-muted-foreground block">Bentuk</span>
                    <span className="font-semibold text-foreground">
                      {TABLE_SHAPE_LABELS[table.shape]}
                    </span>
                  </div>
                </div>

                {/* Sesi Kunjungan & Orders Section */}
                {isLoadingSummary ? (
                  <div className="flex items-center justify-center p-8 text-muted-foreground gap-2.5">
                    <LoaderCircle className="size-4 animate-spin text-primary" />
                    <span className="text-xs">Memuat informasi sesi kunjungan...</span>
                  </div>
                ) : loadError ? (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-xs text-destructive flex items-center justify-between gap-3">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                      <span>{loadError}</span>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={refreshSummary}
                      className="h-8 text-xs shrink-0"
                    >
                      <RefreshCw className="size-3 mr-1" />
                      Muat Ulang
                    </Button>
                  </div>
                ) : sessionSummary?.has_active_session ? (
                  <div className="space-y-4">
                    {/* Kartu Informasi Sesi */}
                    <div className="rounded-xl border border-border/80 bg-card p-4 space-y-3.5 shadow-2xs">
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-border/60">
                        <div className="flex items-center gap-2">
                          <Clock className="size-4 text-primary shrink-0" />
                          <div className="text-xs">
                            <span className="text-muted-foreground">Nomor Sesi: </span>
                            <span className="font-mono font-bold text-foreground">
                              {sessionCode}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className="text-[11px] border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 font-semibold"
                          >
                            Sesi Aktif (Open)
                          </Badge>
                          {sessionSummary.opened_at && (
                            <span className="text-[11px] text-muted-foreground font-mono">
                              {new Date(sessionSummary.opened_at).toLocaleTimeString("id-ID", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* 4 Metrik Wajib: Total Pesanan, Total Tagihan, Total Pembayaran, Sisa Tagihan */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                        <div className="rounded-lg bg-muted/35 p-2.5 border border-border/50">
                          <div className="text-[10px] text-muted-foreground">Total Pesanan</div>
                          <div className="font-bold text-sm mt-0.5 text-foreground">
                            {sessionSummary.total_orders} pesanan
                          </div>
                        </div>
                        <div className="rounded-lg bg-muted/35 p-2.5 border border-border/50">
                          <div className="text-[10px] text-muted-foreground">Total Tagihan</div>
                          <div className="font-bold text-sm mt-0.5 font-mono text-foreground">
                            {formatRupiah(sessionSummary.session_grand_total)}
                          </div>
                        </div>
                        <div className="rounded-lg bg-muted/35 p-2.5 border border-border/50">
                          <div className="text-[10px] text-muted-foreground">Total Pembayaran</div>
                          <div className="font-bold text-sm mt-0.5 font-mono text-primary">
                            {formatRupiah(sessionSummary.session_paid_total)}
                          </div>
                        </div>
                        <div className="rounded-lg bg-muted/35 p-2.5 border border-border/50">
                          <div className="text-[10px] text-muted-foreground">Sisa Tagihan</div>
                          <div
                            className={`font-bold text-sm mt-0.5 font-mono ${
                              sessionSummary.session_remaining_balance > 0
                                ? "text-rose-600 dark:text-rose-400"
                                : "text-emerald-600 dark:text-emerald-400"
                            }`}
                          >
                            {formatRupiah(sessionSummary.session_remaining_balance)}
                          </div>
                        </div>
                      </div>

                      {(sessionSummary.session_refunded_total ?? 0) > 0 && (
                        <div className="text-[11px] text-muted-foreground flex items-center justify-between pt-1 border-t border-border/50">
                          <span>Total Refund Tercatat</span>
                          <span className="font-mono font-semibold text-amber-700 dark:text-amber-300">
                            {formatRupiah(sessionSummary.session_refunded_total ?? 0)}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Daftar Pesanan Dalam Sesi */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                          <ReceiptText className="size-3.5 text-primary" />
                          Daftar Pesanan ({sessionSummary.orders.length})
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={isLoadingSummary}
                          onClick={refreshSummary}
                          className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          <RefreshCw className="size-3 mr-1" />
                          Segarkan
                        </Button>
                      </div>

                      {sessionSummary.orders.length === 0 ? (
                        <p className="text-xs text-muted-foreground italic p-3 rounded-xl border border-dashed">
                          Belum ada pesanan pada sesi ini.
                        </p>
                      ) : (
                        <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                          {sessionSummary.orders.map((ord) => {
                            const badgeCfg =
                              ORDER_STATUS_BADGES[ord.status as keyof typeof ORDER_STATUS_BADGES] ?? {
                                variant: "outline" as const,
                                className: "",
                              };
                            const isPaidReadyToServe =
                              ord.status === "paid" && ord.payment_status === "paid";

                            return (
                              <div
                                key={ord.id}
                                className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-xl border border-border/75 bg-muted/20 text-xs"
                              >
                                <div className="space-y-1 min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-bold font-mono">#{ord.order_number}</span>
                                    <Badge
                                      variant={badgeCfg.variant}
                                      className={`text-[10px] h-4.5 px-1.5 ${badgeCfg.className}`}
                                    >
                                      {ORDER_STATUS_LABELS[
                                        ord.status as keyof typeof ORDER_STATUS_LABELS
                                      ] ?? ord.status}
                                    </Badge>
                                  </div>
                                  <div className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-2">
                                    <span>
                                      Tagihan:{" "}
                                      <strong className="font-mono text-foreground">
                                        {formatRupiah(ord.grand_total)}
                                      </strong>
                                    </span>
                                    <span>
                                      Dibayar:{" "}
                                      <strong className="font-mono text-primary">
                                        {formatRupiah(ord.paid_total)}
                                      </strong>
                                    </span>
                                    {ord.remaining_balance > 0 && (
                                      <span className="text-rose-600 dark:text-rose-400 font-semibold">
                                        (Sisa: {formatRupiah(ord.remaining_balance)})
                                      </span>
                                    )}
                                    {(ord.refunded_total ?? 0) > 0 && (
                                      <span className="text-amber-700 dark:text-amber-300 font-medium">
                                        (Refund: {formatRupiah(ord.refunded_total ?? 0)})
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {isPaidReadyToServe && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={isCompletingOrder || isClosingSession}
                                    onClick={() => handleCompleteOrder(ord.id)}
                                    className="h-7.5 px-2.5 text-[11px] rounded-lg border-emerald-500/50 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 shrink-0"
                                  >
                                    <CheckCheck className="size-3.5 mr-1" />
                                    Tandai Selesai
                                  </Button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Bagian Status & Aksi Penutupan Sesi */}
                    <div className="pt-2 border-t border-border/70 space-y-3">
                      {sessionSummary.can_close_session ? (
                        <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3.5 space-y-3 text-xs">
                          <div className="flex items-start gap-2.5 text-emerald-800 dark:text-emerald-300">
                            <CheckCircle2 className="size-4 shrink-0 mt-0.5 text-emerald-600" />
                            <div className="space-y-0.5">
                              <p className="font-semibold">
                                Seluruh tagihan pada sesi ini telah lunas.
                              </p>
                              <p className="text-[11px] opacity-90">
                                Jika pelanggan sudah selesai makan dan meninggalkan meja, tutup sesi untuk mengembalikan meja ke status Kosong.
                              </p>
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="default"
                            disabled={isClosingSession || isCompletingOrder}
                            onClick={() => setIsConfirmOpen(true)}
                            className="w-full h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs sm:text-sm gap-2 shadow-xs"
                          >
                            {isClosingSession ? (
                              <LoaderCircle className="size-4 animate-spin" />
                            ) : (
                              <DoorOpen className="size-4" />
                            )}
                            Tutup Sesi Meja
                          </Button>
                        </div>
                      ) : (
                        <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3.5 space-y-3 text-xs">
                          <div className="flex items-start gap-2.5 text-amber-900 dark:text-amber-200">
                            <AlertTriangle className="size-4 shrink-0 mt-0.5 text-amber-600" />
                            <div className="space-y-0.5">
                              <p className="font-semibold">Sesi belum dapat ditutup</p>
                              <p className="text-[11px] leading-relaxed">
                                {sessionSummary.blocking_reason ||
                                  "Pastikan seluruh tagihan pada sesi ini telah dilunasi terlebih dahulu."}
                              </p>
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="default"
                            disabled
                            className="w-full h-10 rounded-xl font-semibold text-xs gap-2"
                          >
                            <DoorOpen className="size-4" />
                            Tutup Sesi Meja (Tagihan Belum Selesai)
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-border/80 p-4 bg-muted/20 text-xs text-muted-foreground flex items-start gap-2.5">
                    <Info className="size-4 shrink-0 text-primary mt-0.5" />
                    <div className="space-y-0.5">
                      <p className="font-semibold text-foreground">Status Sesi: Tidak Ada Sesi Aktif</p>
                      <p>
                        Meja ini tidak memiliki sesi kunjungan aktif dan siap digunakan untuk pesanan Dine-in baru melalui POS.
                      </p>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <DialogFooter className="mx-0 mb-0 px-5 sm:px-6 py-3.5 border-t bg-muted/20 flex justify-end shrink-0 rounded-b-2xl">
            <Button
              type="button"
              variant="outline"
              size="default"
              disabled={isClosingSession}
              onClick={onClose}
              className="h-9.5 px-5 rounded-xl text-xs font-semibold"
            >
              Tutup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog Konfirmasi Penutupan Sesi Meja */}
      <AlertDialog
        open={isConfirmOpen}
        onOpenChange={(open) => {
          if (!isClosingSession) setIsConfirmOpen(open);
        }}
      >
        <AlertDialogContent className="rounded-2xl max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display text-base sm:text-lg flex items-center gap-2">
              <DoorOpen className="size-5 text-primary shrink-0" />
              Konfirmasi Tutup Sesi Meja
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-xs sm:text-sm text-muted-foreground pt-1">
                <p>
                  Apakah Anda yakin ingin menutup sesi kunjungan untuk{" "}
                  <strong className="text-foreground">Meja {table?.name}</strong> (
                  <span className="font-mono font-semibold text-foreground">{sessionCode}</span>)?
                </p>
                <p>
                  Status sesi akan diubah menjadi <strong className="text-foreground">Ditutup</strong>{" "}
                  dan <strong className="text-foreground">meja akan dikembalikan ke status Kosong</strong>{" "}
                  sehingga dapat langsung digunakan oleh pelanggan berikutnya. Riwayat transaksi tetap tersimpan.
                </p>
                {sessionSummary && (
                  <div className="rounded-xl border bg-muted/30 p-3 space-y-1 text-xs">
                    <div className="flex items-center justify-between">
                      <span>Total Pesanan</span>
                      <span className="font-semibold text-foreground">
                        {sessionSummary.total_orders} pesanan
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Total Pembayaran</span>
                      <span className="font-mono font-semibold text-primary">
                        {formatRupiah(sessionSummary.session_paid_total)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Sisa Tagihan</span>
                      <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                        {formatRupiah(sessionSummary.session_remaining_balance)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2.5 pt-2">
            <AlertDialogCancel
              disabled={isClosingSession}
              className="rounded-xl h-10 text-xs sm:text-sm"
            >
              Batal
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isClosingSession}
              onClick={(e) => {
                e.preventDefault();
                handleConfirmCloseSession();
              }}
              className="rounded-xl h-10 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs sm:text-sm gap-2"
            >
              {isClosingSession ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  Menutup Sesi...
                </>
              ) : (
                <>
                  <DoorOpen className="size-4" />
                  Tutup Sesi
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
