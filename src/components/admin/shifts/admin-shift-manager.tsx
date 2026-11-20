"use client";

import { useMemo, useState, useTransition } from "react";
import {
  Eye,
  History,
  PlusCircle,
  Receipt,
  Search,
  ShieldCheck,
  Users,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  getCashMovementsAction,
  openShiftAction,
} from "@/lib/shifts/actions";
import type {
  CashMovement,
  CashMovementType,
  ShiftWithCashier,
} from "@/lib/shifts/types";

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

export type CashierProfile = {
  id: string;
  full_name: string;
  username: string;
  is_active: boolean;
};

export type AdminShiftManagerProps = {
  activeShifts: ShiftWithCashier[];
  allShifts: ShiftWithCashier[];
  cashiers: CashierProfile[];
};

export function AdminShiftManager({
  activeShifts,
  allShifts,
  cashiers,
}: AdminShiftManagerProps) {
  // Filter states
  const [cashierFilter, setCashierFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Modal Buka Shift atas nama kasir
  const [isOpenShiftOpen, setIsOpenShiftOpen] = useState(false);
  const [selectedCashierId, setSelectedCashierId] = useState<string>("");
  const [openingCashInput, setOpeningCashInput] = useState<number>(200000);
  const [openingNotes, setOpeningNotes] = useState<string>("");

  // Modal Detail Mutasi Kas
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [selectedShiftForDetail, setSelectedShiftForDetail] = useState<ShiftWithCashier | null>(null);
  const [shiftMovements, setShiftMovements] = useState<CashMovement[]>([]);
  const [isLoadingMovements, setIsLoadingMovements] = useState(false);

  const [isPending, startTransition] = useTransition();

  // Hitung total kas fisik drawer beredar di seluruh shift aktif
  const totalActiveDrawerCash = useMemo(() => {
    return activeShifts.reduce((sum, s) => sum + (s.expected_cash || 0), 0);
  }, [activeShifts]);

  // Daftar kasir yang belum memiliki shift aktif
  const inactiveCashiers = useMemo(() => {
    const activeCashierIds = new Set(activeShifts.map((s) => s.cashier_id));
    return cashiers.filter((c) => !activeCashierIds.has(c.id));
  }, [cashiers, activeShifts]);

  // Filter daftar riwayat shift
  const filteredShifts = useMemo(() => {
    return allShifts.filter((shift) => {
      if (cashierFilter !== "all" && shift.cashier_id !== cashierFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const nameMatch = shift.cashier?.full_name?.toLowerCase().includes(q);
        const userMatch = shift.cashier?.username?.toLowerCase().includes(q);
        const notesMatch = shift.notes?.toLowerCase().includes(q);
        return nameMatch || userMatch || notesMatch;
      }
      return true;
    });
  }, [allShifts, cashierFilter, searchQuery]);

  // Handler Buka Shift atas nama kasir
  const handleOpenShiftByAdmin = () => {
    if (!selectedCashierId) {
      toast.error("Pilih kasir yang akan dibuka shift-nya.");
      return;
    }

    if (openingCashInput < 0) {
      toast.error("Modal kas awal tidak boleh bernilai negatif.");
      return;
    }

    startTransition(async () => {
      const res = await openShiftAction({
        cashierId: selectedCashierId,
        openingCash: openingCashInput,
        notes: openingNotes.trim() || null,
      });

      if (res.ok && res.data) {
        toast.success(res.message);
        setIsOpenShiftOpen(false);
        window.location.reload();
      } else {
        toast.error(res.message || "Gagal membuka shift kasir.");
      }
    });
  };

  // Handler Lihat Detail Mutasi Kas
  const handleViewDetail = async (shift: ShiftWithCashier) => {
    setSelectedShiftForDetail(shift);
    setIsDetailModalOpen(true);
    setIsLoadingMovements(true);

    const res = await getCashMovementsAction(shift.id);
    if (res.ok && res.data) {
      setShiftMovements(res.data);
    } else {
      toast.error(res.message || "Gagal memuat mutasi kas shift.");
      setShiftMovements([]);
    }
    setIsLoadingMovements(false);
  };

  return (
    <div className="space-y-6">
      {/* SECTION 1: METRIC SUMMARY CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <Card className="rounded-2xl border-primary/30 bg-primary/5 shadow-2xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-semibold text-primary flex items-center justify-between">
              <span>Shift Kasir Aktif</span>
              <ShieldCheck className="size-4 text-primary" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono text-primary">
              {activeShifts.length} <span className="text-xs font-normal text-muted-foreground">Kasir</span>
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="rounded-2xl shadow-2xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium flex items-center justify-between">
              <span>Total Kas Drawer Beredar</span>
              <Wallet className="size-4 text-emerald-600" />
            </CardDescription>
            <CardTitle className="text-2xl font-extrabold font-mono text-emerald-700">
              {formatRupiah(totalActiveDrawerCash)}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="rounded-2xl shadow-2xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium flex items-center justify-between">
              <span>Kasir Terdaftar</span>
              <Users className="size-4 text-muted-foreground" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono">
              {cashiers.length} <span className="text-xs font-normal text-muted-foreground">Staf Kasir</span>
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="rounded-2xl shadow-2xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium flex items-center justify-between">
              <span>Total Riwayat Shift</span>
              <History className="size-4 text-muted-foreground" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono">
              {allShifts.length} <span className="text-xs font-normal text-muted-foreground">Sesi Selesai</span>
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* SECTION 2: SHIFT KASIR AKTIF SAAT INI */}
      <Card className="rounded-2xl shadow-2xs">
        <CardHeader className="p-5 pb-3 border-b">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <ShieldCheck className="size-4.5 text-primary" />
                Shift Kasir yang Sedang Berjalan (Aktif)
              </CardTitle>
              <CardDescription className="text-xs">
                Monitoring laci kasir fisik yang saat ini melayani transaksi di POS
              </CardDescription>
            </div>

            {inactiveCashiers.length > 0 && (
              <Button
                size="sm"
                onClick={() => {
                  setSelectedCashierId(inactiveCashiers[0]?.id || "");
                  setOpeningCashInput(200000);
                  setOpeningNotes("");
                  setIsOpenShiftOpen(true);
                }}
                className="text-xs font-semibold rounded-xl gap-1.5"
              >
                <PlusCircle className="size-3.5" />
                Buka Shift untuk Kasir
              </Button>
            )}
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {activeShifts.length === 0 ? (
            <div className="p-8 text-center space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                Tidak ada shift kasir yang sedang aktif saat ini.
              </p>
              {inactiveCashiers.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSelectedCashierId(inactiveCashiers[0]?.id || "");
                    setIsOpenShiftOpen(true);
                  }}
                  className="text-xs font-semibold rounded-xl"
                >
                  Buka Shift Kasir
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="text-xs">
                    <TableHead>Kasir</TableHead>
                    <TableHead>Waktu Dibuka</TableHead>
                    <TableHead className="text-right">Modal Awal</TableHead>
                    <TableHead className="text-right">Saldo Kas Saat Ini</TableHead>
                    <TableHead>Keterangan Pembukaan</TableHead>
                    <TableHead className="text-right">Aksi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="text-xs font-medium">
                  {activeShifts.map((shift) => (
                    <TableRow key={shift.id}>
                      <TableCell>
                        <div className="space-y-0.5">
                          <p className="font-bold text-foreground">{shift.cashier?.full_name}</p>
                          <p className="text-[11px] text-muted-foreground">@{shift.cashier?.username}</p>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-muted-foreground">
                        {formatDate(shift.opened_at)}
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold">
                        {formatRupiah(shift.opening_cash)}
                      </TableCell>
                      <TableCell className="text-right font-mono font-extrabold text-emerald-700 text-sm">
                        {formatRupiah(shift.expected_cash)}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-[11px] text-muted-foreground" title={shift.notes || ""}>
                        {shift.notes || "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleViewDetail(shift)}
                          className="h-8 px-2.5 text-xs font-semibold rounded-lg gap-1.5"
                        >
                          <Eye className="size-3.5" />
                          <span>Mutasi Kas</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* SECTION 3: RIWAYAT SHIFT & REKONSILIASI KAS */}
      <Card className="rounded-2xl shadow-2xs">
        <CardHeader className="p-5 pb-3 border-b space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <History className="size-4.5 text-primary" />
                Riwayat Shift &amp; Rekonsiliasi Kasir
              </CardTitle>
              <CardDescription className="text-xs">
                Audit riwayat seluruh sesi kerja kasir, perbandingan uang fisik aktual vs sistem, dan catatan selisih
              </CardDescription>
            </div>
          </div>

          {/* Bar Filter */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-1">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Cari nama kasir atau catatan..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-8.5 text-xs rounded-xl"
              />
            </div>

            <div className="w-full sm:w-56">
              <Select value={cashierFilter} onValueChange={setCashierFilter}>
                <SelectTrigger className="h-8.5 text-xs rounded-xl">
                  <SelectValue placeholder="Filter Kasir" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Kasir</SelectItem>
                  {cashiers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.full_name} (@{c.username})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {filteredShifts.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              Tidak ada data shift yang cocok dengan filter.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="text-xs">
                    <TableHead>Kasir</TableHead>
                    <TableHead>Waktu Buka / Tutup</TableHead>
                    <TableHead className="text-right">Modal Awal</TableHead>
                    <TableHead className="text-right">Expected Cash</TableHead>
                    <TableHead className="text-right">Fisik (Actual)</TableHead>
                    <TableHead className="text-right">Selisih Rekonsiliasi</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                    <TableHead className="text-right">Aksi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="text-xs font-medium">
                  {filteredShifts.map((shift) => {
                    const diff = shift.cash_difference ?? 0;
                    return (
                      <TableRow key={shift.id}>
                        <TableCell>
                          <div className="space-y-0.5">
                            <p className="font-bold text-foreground">{shift.cashier?.full_name}</p>
                            <p className="text-[11px] text-muted-foreground">@{shift.cashier?.username}</p>
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-muted-foreground">
                          <p>Buka: {formatDate(shift.opened_at)}</p>
                          <p>Tutup: {shift.closed_at ? formatDate(shift.closed_at) : "-"}</p>
                        </TableCell>
                        <TableCell className="text-right font-mono font-bold">
                          {formatRupiah(shift.opening_cash)}
                        </TableCell>
                        <TableCell className="text-right font-mono font-bold">
                          {formatRupiah(shift.expected_cash)}
                        </TableCell>
                        <TableCell className="text-right font-mono font-bold">
                          {shift.actual_cash !== null ? formatRupiah(shift.actual_cash) : "-"}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {shift.status === "closed" ? (
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
                          {shift.status === "open" ? (
                            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-300">
                              Aktif
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-slate-100 text-slate-700">
                              Ditutup
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleViewDetail(shift)}
                            className="h-8 px-2.5 text-xs font-semibold rounded-lg gap-1.5"
                          >
                            <Eye className="size-3.5" />
                            <span>Mutasi</span>
                          </Button>
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
      {/* DIALOG 1: BUKA SHIFT ATAS NAMA KASIR OLEH ADMIN */}
      {/* ========================================================================= */}
      <Dialog open={isOpenShiftOpen} onOpenChange={setIsOpenShiftOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Wallet className="size-5 text-primary" />
              Buka Shift atas nama Kasir
            </DialogTitle>
            <DialogDescription className="text-xs">
              Admin membuka shift kasir secara terotorisasi. Catatan audit akan secara otomatis mencatat identitas admin pembuka.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-xs font-semibold">Pilih Kasir</Label>
              <Select value={selectedCashierId} onValueChange={setSelectedCashierId}>
                <SelectTrigger className="h-10 text-xs rounded-xl">
                  <SelectValue placeholder="Pilih staf kasir..." />
                </SelectTrigger>
                <SelectContent>
                  {inactiveCashiers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.full_name} (@{c.username})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="admin-opening-cash-input" className="text-xs font-semibold">
                Modal Kas Awal (Rp)
              </Label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">
                  Rp
                </span>
                <Input
                  id="admin-opening-cash-input"
                  type="number"
                  min={0}
                  value={openingCashInput || ""}
                  onChange={(e) => setOpeningCashInput(parseInt(e.target.value, 10) || 0)}
                  className="pl-10 text-base font-mono font-bold h-11 rounded-xl"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="admin-opening-notes" className="text-xs font-semibold">
                Catatan Pembukaan (Opsional)
              </Label>
              <Textarea
                id="admin-opening-notes"
                rows={2}
                placeholder="Misal: Dibukakan oleh supervisor shift pagi..."
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
              disabled={isPending || !selectedCashierId || openingCashInput < 0}
              onClick={handleOpenShiftByAdmin}
              className="rounded-xl text-xs font-bold bg-primary text-primary-foreground"
            >
              {isPending ? "Membuka Shift..." : "Konfirmasi Buka Shift"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ========================================================================= */}
      {/* DIALOG 2: DETAIL MUTASI KAS SHIFT */}
      {/* ========================================================================= */}
      <Dialog open={isDetailModalOpen} onOpenChange={setIsDetailModalOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0">
          <DialogHeader className="p-5 pb-3 border-b">
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Receipt className="size-5 text-primary" />
              Detail Mutasi Kas Shift
            </DialogTitle>
            <DialogDescription className="text-xs">
              Kasir: <strong>{selectedShiftForDetail?.cashier?.full_name}</strong> (@{selectedShiftForDetail?.cashier?.username}) • Dibuka {selectedShiftForDetail && formatDate(selectedShiftForDetail.opened_at)}
            </DialogDescription>
          </DialogHeader>

          <div className="p-5 space-y-4 flex-1 overflow-y-auto">
            {/* Box Ringkasan Saldo Shift */}
            <div className="grid grid-cols-3 gap-3 p-3.5 rounded-xl border bg-muted/20 text-xs">
              <div>
                <span className="text-muted-foreground block">Modal Awal</span>
                <span className="font-mono font-bold text-sm">
                  {formatRupiah(selectedShiftForDetail?.opening_cash ?? 0)}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground block">Expected Cash</span>
                <span className="font-mono font-bold text-sm text-primary">
                  {formatRupiah(selectedShiftForDetail?.expected_cash ?? 0)}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground block">Fisik (Actual)</span>
                <span className="font-mono font-bold text-sm">
                  {selectedShiftForDetail?.actual_cash !== null
                    ? formatRupiah(selectedShiftForDetail?.actual_cash ?? 0)
                    : "- (Shift Aktif)"}
                </span>
              </div>
            </div>

            {selectedShiftForDetail?.notes && (
              <div className="text-xs p-3 rounded-lg border bg-muted/10 space-y-1">
                <span className="font-semibold text-muted-foreground block">Catatan Shift:</span>
                <p className="text-foreground">{selectedShiftForDetail.notes}</p>
              </div>
            )}

            {/* Tabel Mutasi */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold">Daftar Mutasi Kas ({shiftMovements.length})</h4>
              {isLoadingMovements ? (
                <div className="p-8 text-center text-xs text-muted-foreground">Memuat mutasi kas...</div>
              ) : shiftMovements.length === 0 ? (
                <div className="p-8 text-center text-xs text-muted-foreground">Tidak ada mutasi kas selain modal awal.</div>
              ) : (
                <div className="rounded-xl border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="text-xs">
                        <TableHead>Waktu</TableHead>
                        <TableHead>Jenis</TableHead>
                        <TableHead>Alasan / Ref</TableHead>
                        <TableHead className="text-right">Nominal</TableHead>
                        <TableHead className="text-right">Saldo Sesudah</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="text-xs font-medium">
                      {shiftMovements.map((m) => {
                        const isPositive =
                          m.movement_type === "opening_cash" ||
                          m.movement_type === "cash_sale" ||
                          m.movement_type === "cash_in";
                        return (
                          <TableRow key={m.id}>
                            <TableCell className="font-mono text-muted-foreground whitespace-nowrap">
                              {formatDate(m.created_at)}
                            </TableCell>
                            <TableCell>{getMovementTypeBadge(m.movement_type)}</TableCell>
                            <TableCell className="max-w-xs truncate" title={m.reason}>
                              {m.reason}
                            </TableCell>
                            <TableCell className={`text-right font-mono font-bold whitespace-nowrap ${isPositive ? "text-emerald-700" : "text-rose-700"}`}>
                              {isPositive ? "+" : "-"}{formatRupiah(m.amount)}
                            </TableCell>
                            <TableCell className="text-right font-mono font-bold whitespace-nowrap">
                              {formatRupiah(m.balance_after)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="p-4 border-t bg-muted/20">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsDetailModalOpen(false)}
              className="rounded-xl text-xs"
            >
              Tutup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
