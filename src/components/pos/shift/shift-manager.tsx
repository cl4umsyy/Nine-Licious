"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle,
  Coins,
  History,
  Lock,
  MinusCircle,
  PlusCircle,
  Receipt,
  RotateCcw,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  closeShiftAction,
  openShiftAction,
  recordCashMovementAction,
} from "@/lib/shifts/actions";
import type {
  CashMovement,
  CashMovementType,
  ShiftSummary,
  ShiftWithCashier,
} from "@/lib/shifts/types";
import { cn } from "@/lib/utils";

const QUICK_OPENING_CASH = [100000, 200000, 300000, 500000];

function formatRupiah(amount: number): string {
  return `Rp ${amount.toLocaleString("id-ID")}`;
}

function formatDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d);
  } catch {
    return isoString;
  }
}

function getMovementTypeBadge(type: CashMovementType) {
  switch (type) {
    case "opening_cash":
      return <Badge variant="outline" className="bg-slate-50 text-slate-700 border-slate-300">Kas Awal</Badge>;
    case "cash_sale":
      return <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-300">Penjualan Tunai</Badge>;
    case "cash_refund":
      return <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-300">Refund Tunai</Badge>;
    case "cash_in":
      return <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-300">Kas Masuk</Badge>;
    case "cash_out":
      return <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300">Kas Keluar</Badge>;
    case "closing_reconciliation":
      return <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-300">Tutup Shift</Badge>;
    default:
      return <Badge variant="outline">{type}</Badge>;
  }
}

export type CashierShiftManagerProps = {
  currentCashier: {
    id: string;
    full_name: string;
    username: string;
    role: string;
  };
  initialSummary: ShiftSummary | null;
  initialMovements: CashMovement[];
  initialHistory: ShiftWithCashier[];
};

export function CashierShiftManager({
  currentCashier,
  initialSummary: summary,
  initialMovements: movements,
  initialHistory: history,
}: CashierShiftManagerProps) {
  const router = useRouter();
  // Dialog States
  const [isOpenShiftOpen, setIsOpenShiftOpen] = useState(false);
  const [openingCashInput, setOpeningCashInput] = useState<number>(200000);
  const [openingNotes, setOpeningNotes] = useState<string>("");

  const [isCashMovementOpen, setIsCashMovementOpen] = useState(false);
  const [movementType, setMovementType] = useState<"cash_in" | "cash_out">("cash_in");
  const [movementAmount, setMovementAmount] = useState<number>(0);
  const [movementReason, setMovementReason] = useState<string>("");

  const [isCloseShiftOpen, setIsCloseShiftOpen] = useState(false);
  const [actualCashInput, setActualCashInput] = useState<number>(
    summary?.expectedCash ?? 0,
  );
  const [closingNotes, setClosingNotes] = useState<string>("");

  const [isPending, startTransition] = useTransition();

  const activeShift = summary?.shift ?? null;

  // Handler Buka Shift
  const handleOpenShift = () => {
    if (openingCashInput < 0) {
      toast.error("Modal kas awal tidak boleh bernilai negatif.");
      return;
    }

    startTransition(async () => {
      const res = await openShiftAction({
        openingCash: openingCashInput,
        notes: openingNotes.trim() || null,
      });

      if (res.ok && res.data) {
        toast.success(res.message);
        setIsOpenShiftOpen(false);
        // Refresh server components untuk sinkronisasi state
        router.refresh();
      } else {
        toast.error(res.message || "Gagal membuka shift kasir.");
      }
    });
  };

  // Handler Catat Kas Masuk / Keluar
  const handleRecordMovement = () => {
    if (!activeShift) {
      toast.error("Tidak ada shift aktif.");
      return;
    }

    if (movementAmount <= 0) {
      toast.error("Nominal mutasi kas harus lebih besar dari Rp 0.");
      return;
    }

    if (!movementReason || movementReason.trim().length < 3) {
      toast.error("Alasan mutasi kas wajib diisi (minimal 3 karakter).");
      return;
    }

    if (movementType === "cash_out" && movementAmount > (summary?.expectedCash ?? 0)) {
      toast.error(
        `Kas keluar tidak boleh melebihi saldo kas saat ini (${formatRupiah(summary?.expectedCash ?? 0)}).`,
      );
      return;
    }

    startTransition(async () => {
      const res = await recordCashMovementAction({
        shiftId: activeShift.id,
        movementType,
        amount: movementAmount,
        reason: movementReason.trim(),
      });

      if (res.ok && res.data) {
        toast.success(res.message);
        setIsCashMovementOpen(false);
        setMovementAmount(0);
        setMovementReason("");
        router.refresh();
      } else {
        toast.error(res.message || "Gagal mencatat mutasi kas.");
      }
    });
  };

  // Handler Tutup Shift
  const handleCloseShift = () => {
    if (!activeShift) {
      toast.error("Tidak ada shift aktif.");
      return;
    }

    if (actualCashInput < 0) {
      toast.error("Nominal uang fisik tidak boleh bernilai negatif.");
      return;
    }

    const difference = actualCashInput - (summary?.expectedCash ?? 0);
    if (difference !== 0 && (!closingNotes || closingNotes.trim().length < 3)) {
      toast.error("Terdapat selisih kas fisik. Catatan rekonsiliasi wajib diisi minimal 3 karakter.");
      return;
    }

    startTransition(async () => {
      const res = await closeShiftAction({
        shiftId: activeShift.id,
        actualCash: actualCashInput,
        notes: closingNotes.trim() || null,
      });

      if (res.ok && res.data) {
        toast.success(res.message);
        setIsCloseShiftOpen(false);
        router.refresh();
      } else {
        toast.error(res.message || "Gagal menutup shift.");
      }
    });
  };

  // Hitung selisih rekonsiliasi realtime di modal tutup shift
  const closeCashDifference = actualCashInput - (summary?.expectedCash ?? 0);

  return (
    <div className="space-y-6">
      {/* SECTION 1: STATUS SHIFT AKTIF ATAU EMPTY STATE */}
      {!activeShift ? (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader className="text-center sm:text-left">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <CardTitle className="text-lg font-bold flex items-center gap-2 justify-center sm:justify-start">
                  <Wallet className="size-5 text-amber-600" />
                  Shift Kasir Belum Dibuka
                </CardTitle>
                <CardDescription className="text-xs">
                  Anda sedang login sebagai <strong>{currentCashier.full_name}</strong> (@{currentCashier.username}).
                  Untuk mulai melayani transaksi pembayaran tunai di POS, buka shift terlebih dahulu.
                </CardDescription>
              </div>
              <Button
                onClick={() => {
                  setOpeningCashInput(200000);
                  setOpeningNotes("");
                  setIsOpenShiftOpen(true);
                }}
                className="bg-amber-600 hover:bg-amber-700 text-white font-bold gap-2 rounded-xl"
              >
                <PlusCircle className="size-4" />
                Buka Shift Sekarang
              </Button>
            </div>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-4">
          {/* Header Card Shift Aktif */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl border bg-card shadow-2xs">
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
                <ShieldCheck className="size-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-base">Shift Aktif Kasir</h3>
                  <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-300 text-xs">
                    Aktif
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Dibuka pada <strong>{formatDate(activeShift.opened_at)}</strong> oleh {currentCashier.full_name}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setMovementType("cash_in");
                  setMovementAmount(0);
                  setMovementReason("");
                  setIsCashMovementOpen(true);
                }}
                className="text-xs font-semibold rounded-xl gap-1.5"
              >
                <PlusCircle className="size-3.5 text-blue-600" />
                Kas Masuk
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setMovementType("cash_out");
                  setMovementAmount(0);
                  setMovementReason("");
                  setIsCashMovementOpen(true);
                }}
                className="text-xs font-semibold rounded-xl gap-1.5"
              >
                <MinusCircle className="size-3.5 text-amber-600" />
                Kas Keluar
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setActualCashInput(summary?.expectedCash ?? 0);
                  setClosingNotes("");
                  setIsCloseShiftOpen(true);
                }}
                className="text-xs font-bold rounded-xl gap-1.5"
              >
                <Lock className="size-3.5" />
                Tutup Shift
              </Button>
            </div>
          </div>

          {/* Metric Cards (5 Cards) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <Card className="rounded-xl shadow-2xs">
              <CardHeader className="p-4 pb-2">
                <CardDescription className="text-xs font-medium flex items-center justify-between">
                  <span>Modal Awal Kas</span>
                  <Coins className="size-4 text-muted-foreground" />
                </CardDescription>
                <CardTitle className="text-lg font-bold font-mono">
                  {formatRupiah(summary?.openingCash ?? 0)}
                </CardTitle>
              </CardHeader>
            </Card>

            <Card className="rounded-xl shadow-2xs">
              <CardHeader className="p-4 pb-2">
                <CardDescription className="text-xs font-medium flex items-center justify-between">
                  <span>Penjualan Tunai</span>
                  <TrendingUp className="size-4 text-emerald-600" />
                </CardDescription>
                <CardTitle className="text-lg font-bold font-mono text-emerald-700">
                  +{formatRupiah(summary?.totalCashSales ?? 0)}
                </CardTitle>
              </CardHeader>
            </Card>

            <Card className="rounded-xl shadow-2xs">
              <CardHeader className="p-4 pb-2">
                <CardDescription className="text-xs font-medium flex items-center justify-between">
                  <span>Refund Tunai</span>
                  <RotateCcw className="size-4 text-rose-600" />
                </CardDescription>
                <CardTitle className="text-lg font-bold font-mono text-rose-700">
                  -{formatRupiah(summary?.totalCashRefunds ?? 0)}
                </CardTitle>
              </CardHeader>
            </Card>

            <Card className="rounded-xl shadow-2xs">
              <CardHeader className="p-4 pb-2">
                <CardDescription className="text-xs font-medium flex items-center justify-between">
                  <span>Mutasi Kas Manual</span>
                  <ArrowUpRight className="size-4 text-blue-600" />
                </CardDescription>
                <CardTitle className="text-sm font-bold font-mono space-y-0.5">
                  <div className="text-blue-700">+{formatRupiah(summary?.totalCashIn ?? 0)}</div>
                  <div className="text-amber-700">-{formatRupiah(summary?.totalCashOut ?? 0)}</div>
                </CardTitle>
              </CardHeader>
            </Card>

            <Card className="rounded-xl border-primary/40 bg-primary/5 shadow-2xs sm:col-span-2 lg:col-span-1">
              <CardHeader className="p-4 pb-2">
                <CardDescription className="text-xs font-bold text-primary flex items-center justify-between">
                  <span>Saldo Kas Laci (Drawer)</span>
                  <Wallet className="size-4 text-primary" />
                </CardDescription>
                <CardTitle className="text-xl font-extrabold font-mono text-primary tracking-tight">
                  {formatRupiah(summary?.expectedCash ?? 0)}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>
        </div>
      )}

      {/* SECTION 2: BUKU BESAR MUTASI KAS SHIFT INI */}
      {activeShift && (
        <Card className="rounded-2xl shadow-2xs">
          <CardHeader className="p-5 pb-3 border-b">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base font-bold flex items-center gap-2">
                  <Receipt className="size-4.5 text-primary" />
                  Buku Besar Mutasi Kas (Shift Ini)
                </CardTitle>
                <CardDescription className="text-xs">
                  Riwayat pergerakan kas masuk dan kas keluar pada shift aktif saat ini ({movements.length} transaksi)
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {movements.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-xs">
                Belum ada mutasi kas selain modal awal pada shift ini.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="text-xs">
                      <TableHead>Waktu</TableHead>
                      <TableHead>Jenis Mutasi</TableHead>
                      <TableHead>Alasan / Keterangan</TableHead>
                      <TableHead className="text-right">Nominal</TableHead>
                      <TableHead className="text-right">Saldo Sesudah</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="text-xs font-medium">
                    {movements.map((m) => {
                      const isPositive =
                        m.movement_type === "opening_cash" ||
                        m.movement_type === "cash_sale" ||
                        m.movement_type === "cash_in";
                      return (
                        <TableRow key={m.id}>
                          <TableCell className="text-muted-foreground font-mono">
                            {formatDate(m.created_at)}
                          </TableCell>
                          <TableCell>{getMovementTypeBadge(m.movement_type)}</TableCell>
                          <TableCell className="max-w-xs truncate" title={m.reason}>
                            {m.reason}
                          </TableCell>
                          <TableCell className={`text-right font-mono font-bold ${isPositive ? "text-emerald-700" : "text-rose-700"}`}>
                            {isPositive ? "+" : "-"}{formatRupiah(m.amount)}
                          </TableCell>
                          <TableCell className="text-right font-mono font-bold">
                            {formatRupiah(m.balance_after)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* SECTION 3: RIWAYAT SHIFT SEBELUMNYA */}
      <Card className="rounded-2xl shadow-2xs">
        <CardHeader className="p-5 pb-3 border-b">
          <CardTitle className="text-base font-bold flex items-center gap-2">
            <History className="size-4.5 text-primary" />
            Riwayat Shift Kasir Sebelumnya
          </CardTitle>
          <CardDescription className="text-xs">
            Daftar shift yang telah selesai dan ditutup sebelumnya oleh kasir ini
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {history.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-xs">
              Belum ada riwayat shift yang ditutup.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="text-xs">
                    <TableHead>Waktu Buka</TableHead>
                    <TableHead>Waktu Tutup</TableHead>
                    <TableHead className="text-right">Modal Awal</TableHead>
                    <TableHead className="text-right">Expected Cash</TableHead>
                    <TableHead className="text-right">Fisik (Actual)</TableHead>
                    <TableHead className="text-right">Selisih</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="text-xs font-medium">
                  {history.map((s) => {
                    const diff = s.cash_difference ?? 0;
                    return (
                      <TableRow key={s.id}>
                        <TableCell className="font-mono">{formatDate(s.opened_at)}</TableCell>
                        <TableCell className="font-mono">{s.closed_at ? formatDate(s.closed_at) : "-"}</TableCell>
                        <TableCell className="text-right font-mono">{formatRupiah(s.opening_cash)}</TableCell>
                        <TableCell className="text-right font-mono">{formatRupiah(s.expected_cash)}</TableCell>
                        <TableCell className="text-right font-mono">
                          {s.actual_cash !== null ? formatRupiah(s.actual_cash) : "-"}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {s.status === "closed" ? (
                            diff === 0 ? (
                              <span className="text-emerald-700 font-bold">Pas (Rp 0)</span>
                            ) : diff > 0 ? (
                              <span className="text-blue-700 font-bold">+{formatRupiah(diff)}</span>
                            ) : (
                              <span className="text-rose-700 font-bold">-{formatRupiah(Math.abs(diff))}</span>
                            )
                          ) : (
                            "-"
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          {s.status === "open" ? (
                            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-300">
                              Aktif
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-slate-100 text-slate-700">
                              Ditutup
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ========================================================================= */}
      {/* DIALOG 1: BUKA SHIFT */}
      {/* ========================================================================= */}
      <Dialog open={isOpenShiftOpen} onOpenChange={setIsOpenShiftOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Wallet className="size-5 text-primary" />
              Buka Shift Kasir Baru
            </DialogTitle>
            <DialogDescription className="text-xs">
              Masukkan nominal modal kas awal (uang kembalian) yang tersedia di laci kasir fisik saat ini.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="opening-cash-input" className="text-xs font-semibold">
                Modal Kas Awal (Rp)
              </Label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">
                  Rp
                </span>
                <Input
                  id="opening-cash-input"
                  type="number"
                  min={0}
                  value={openingCashInput || ""}
                  onChange={(e) => setOpeningCashInput(parseInt(e.target.value, 10) || 0)}
                  className="pl-10 text-base font-mono font-bold h-11 rounded-xl"
                />
              </div>
            </div>

            {/* Tombol Pecahan Cepat */}
            <div className="space-y-1.5">
              <span className="text-[11px] text-muted-foreground">Pilihan Cepat:</span>
              <div className="grid grid-cols-2 gap-2">
                {QUICK_OPENING_CASH.map((preset) => (
                  <Button
                    key={preset}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setOpeningCashInput(preset)}
                    className={cn(
                      "text-xs font-mono font-semibold rounded-xl",
                      openingCashInput === preset && "border-primary bg-primary/10 text-primary font-bold",
                    )}
                  >
                    {formatRupiah(preset)}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="opening-notes-input" className="text-xs font-semibold">
                Catatan Pembukaan (Opsional)
              </Label>
              <Textarea
                id="opening-notes-input"
                rows={2}
                placeholder="Misal: Kondisi laci rapi, uang pecahan lengkap..."
                value={openingNotes}
                onChange={(e) => setOpeningNotes(e.target.value)}
                className="text-xs rounded-xl"
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={() => setIsOpenShiftOpen(false)}
              className="rounded-xl text-xs"
            >
              Batal
            </Button>
            <Button
              type="button"
              disabled={isPending || openingCashInput < 0}
              onClick={handleOpenShift}
              className="rounded-xl text-xs font-bold bg-primary text-primary-foreground"
            >
              {isPending ? "Membuka Shift..." : "Konfirmasi Buka Shift"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ========================================================================= */}
      {/* DIALOG 2: CATAT KAS MASUK / KAS KELUAR */}
      {/* ========================================================================= */}
      <Dialog open={isCashMovementOpen} onOpenChange={setIsCashMovementOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              {movementType === "cash_in" ? (
                <>
                  <PlusCircle className="size-5 text-blue-600" />
                  <span>Catat Kas Masuk (Laci Kasir)</span>
                </>
              ) : (
                <>
                  <MinusCircle className="size-5 text-amber-600" />
                  <span>Catat Kas Keluar (Laci Kasir)</span>
                </>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {movementType === "cash_in"
                ? "Penambahan uang fisik ke dalam laci (misal: tambah modal receh)."
                : "Pengeluaran uang fisik dari laci (misal: beli es batu darurat, bayar kurir operasional)."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="movement-amount-input" className="text-xs font-semibold">
                Nominal (Rp)
              </Label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">
                  Rp
                </span>
                <Input
                  id="movement-amount-input"
                  type="number"
                  min={1}
                  value={movementAmount || ""}
                  onChange={(e) => setMovementAmount(parseInt(e.target.value, 10) || 0)}
                  className="pl-10 text-base font-mono font-bold h-11 rounded-xl"
                />
              </div>
              {movementType === "cash_out" && (
                <p className="text-[11px] text-muted-foreground">
                  Maksimum kas keluar saat ini: <strong>{formatRupiah(summary?.expectedCash ?? 0)}</strong>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="movement-reason-input" className="text-xs font-semibold">
                Alasan Pengeluaran / Pemasukan (Wajib)
              </Label>
              <Input
                id="movement-reason-input"
                placeholder="Contoh: Beli es batu darurat 2 pack..."
                value={movementReason}
                onChange={(e) => setMovementReason(e.target.value)}
                className="text-xs h-10 rounded-xl"
              />
              <p className="text-[10px] text-muted-foreground">Minimal 3 karakter keterangan jelas.</p>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={() => setIsCashMovementOpen(false)}
              className="rounded-xl text-xs"
            >
              Batal
            </Button>
            <Button
              type="button"
              disabled={isPending || movementAmount <= 0 || movementReason.trim().length < 3}
              onClick={handleRecordMovement}
              className={`rounded-xl text-xs font-bold text-white ${
                movementType === "cash_in" ? "bg-blue-600 hover:bg-blue-700" : "bg-amber-600 hover:bg-amber-700"
              }`}
            >
              {isPending ? "Menyimpan..." : "Simpan Mutasi Kas"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ========================================================================= */}
      {/* DIALOG 3: TUTUP SHIFT & REKONSILIASI */}
      {/* ========================================================================= */}
      <Dialog open={isCloseShiftOpen} onOpenChange={setIsCloseShiftOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Lock className="size-5 text-destructive" />
              Tutup Shift Kasir &amp; Rekonsiliasi Kas
            </DialogTitle>
            <DialogDescription className="text-xs">
              Hitung dan masukkan seluruh uang tunai fisik yang ada di laci kasir saat ini untuk rekonsiliasi akhir.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Box Saldo Kas Sistem (Expected Cash) */}
            <div className="p-4 rounded-xl border bg-muted/30 flex items-center justify-between">
              <div>
                <span className="text-xs text-muted-foreground block">Saldo Kas Sistem (Expected Cash)</span>
                <span className="text-xl font-mono font-extrabold text-foreground">
                  {formatRupiah(summary?.expectedCash ?? 0)}
                </span>
              </div>
              <Badge variant="outline" className="text-xs font-mono">
                {summary?.movementsCount ?? 0} Transaksi
              </Badge>
            </div>

            {/* Input Kas Fisik Aktual */}
            <div className="space-y-2">
              <Label htmlFor="actual-cash-input" className="text-xs font-semibold">
                Uang Fisik Aktual di Laci Kasir (Rp)
              </Label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">
                  Rp
                </span>
                <Input
                  id="actual-cash-input"
                  type="number"
                  min={0}
                  value={actualCashInput}
                  onChange={(e) => setActualCashInput(parseInt(e.target.value, 10) || 0)}
                  className="pl-10 text-base font-mono font-bold h-11 rounded-xl"
                />
              </div>
            </div>

            {/* Status Selisih Real-time */}
            <div
              className={`p-3.5 rounded-xl border flex items-center justify-between text-xs font-medium ${
                closeCashDifference === 0
                  ? "border-emerald-500/40 bg-emerald-50 text-emerald-900"
                  : closeCashDifference > 0
                    ? "border-blue-500/40 bg-blue-50 text-blue-900"
                    : "border-rose-500/40 bg-rose-50 text-rose-900"
              }`}
            >
              <div className="flex items-center gap-2">
                {closeCashDifference === 0 ? (
                  <CheckCircle className="size-4 text-emerald-600" />
                ) : (
                  <AlertCircle className="size-4 text-rose-600" />
                )}
                <span>
                  {closeCashDifference === 0
                    ? "Kas Fisik Cocok Sempurna (Tidak Ada Selisih)"
                    : closeCashDifference > 0
                      ? "Selisih Lebih (Uang fisik lebih banyak dari sistem)"
                      : "Selisih Kurang (Uang fisik kurang dari sistem)"}
                </span>
              </div>
              <span className="font-mono font-bold text-sm">
                {closeCashDifference === 0
                  ? "Rp 0"
                  : closeCashDifference > 0
                    ? `+${formatRupiah(closeCashDifference)}`
                    : `-${formatRupiah(Math.abs(closeCashDifference))}`}
              </span>
            </div>

            {/* Catatan Penutupan */}
            <div className="space-y-1.5">
              <Label htmlFor="closing-notes-input" className="text-xs font-semibold">
                Catatan Penutupan {closeCashDifference !== 0 && <span className="text-destructive">* (Wajib bila ada selisih)</span>}
              </Label>
              <Textarea
                id="closing-notes-input"
                rows={2}
                placeholder={
                  closeCashDifference !== 0
                    ? "Jelaskan penyebab selisih kas fisik..."
                    : "Keterangan penutupan shift (opsional)..."
                }
                value={closingNotes}
                onChange={(e) => setClosingNotes(e.target.value)}
                className="text-xs rounded-xl"
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={() => setIsCloseShiftOpen(false)}
              className="rounded-xl text-xs"
            >
              Batal
            </Button>
            <Button
              type="button"
              disabled={
                isPending ||
                actualCashInput < 0 ||
                (closeCashDifference !== 0 && closingNotes.trim().length < 3)
              }
              onClick={handleCloseShift}
              className="rounded-xl text-xs font-bold bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isPending ? "Menutup Shift..." : "Konfirmasi Tutup Shift"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
