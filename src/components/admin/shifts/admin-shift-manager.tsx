"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowDownCircle,
  ArrowUpCircle,
  CheckCircle2,
  Clock,
  Download,
  Eye,
  Filter,
  History,
  Loader2,
  Lock,
  PlusCircle,
  Receipt,
  Search,
  ShieldCheck,
  Users,
  Wallet,
  X,
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
import { GlobalShiftSyncListener } from "@/components/pos/shift/global-shift-sync-listener";
import {
  closeShiftAction,
  getCashMovementsAction,
  getShiftSummaryAction,
  openShiftAction,
} from "@/lib/shifts/actions";
import { broadcastGlobalShiftChanged } from "@/lib/shifts/realtime";
import { exportShiftsCsvAction } from "@/lib/export/actions";
import { downloadCsvInBrowser } from "@/lib/export/csv";
import { getJakartaDateDaysAgo, getJakartaDateToday } from "@/lib/reports/calculations";
import type {
  CashMovement,
  CashMovementType,
  ShiftSummary,
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
  const router = useRouter();

  // Filter states
  const [cashierFilter, setCashierFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "closed">("all");
  const [dateFilter, setDateFilter] = useState<"all" | "today" | "7d" | "30d" | "custom">("all");
  const [customDate, setCustomDate] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Modal Buka Shift atas nama kasir
  const [isOpenShiftOpen, setIsOpenShiftOpen] = useState(false);
  const [selectedCashierId, setSelectedCashierId] = useState<string>("");
  const [openingCashInput, setOpeningCashInput] = useState<number>(200000);
  const [openingNotes, setOpeningNotes] = useState<string>("");

  // Modal Detail Mutasi Kas & Audit Rekonsiliasi
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [selectedShiftForDetail, setSelectedShiftForDetail] = useState<ShiftWithCashier | null>(null);
  const [selectedShiftSummary, setSelectedShiftSummary] = useState<ShiftSummary | null>(null);
  const [shiftMovements, setShiftMovements] = useState<CashMovement[]>([]);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  // Modal Tutup Shift Kasir oleh Admin
  const [shiftToClose, setShiftToClose] = useState<ShiftWithCashier | null>(null);
  const [actualCashInput, setActualCashInput] = useState<number>(0);
  const [closingNotes, setClosingNotes] = useState<string>("");

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
      // 1. Kasir Filter
      if (cashierFilter !== "all" && shift.cashier_id !== cashierFilter) {
        return false;
      }

      // 2. Status Filter
      if (statusFilter !== "all" && shift.status !== statusFilter) {
        return false;
      }

      // 3. Date Filter
      if (dateFilter !== "all") {
        const shiftDate = new Date(shift.opened_at);
        const now = new Date();

        if (dateFilter === "today") {
          const isSameDay =
            shiftDate.getFullYear() === now.getFullYear() &&
            shiftDate.getMonth() === now.getMonth() &&
            shiftDate.getDate() === now.getDate();
          if (!isSameDay) return false;
        } else if (dateFilter === "7d") {
          const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          if (shiftDate < sevenDaysAgo) return false;
        } else if (dateFilter === "30d") {
          const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          if (shiftDate < thirtyDaysAgo) return false;
        } else if (dateFilter === "custom" && customDate) {
          const target = new Date(customDate);
          const isSameDay =
            shiftDate.getFullYear() === target.getFullYear() &&
            shiftDate.getMonth() === target.getMonth() &&
            shiftDate.getDate() === target.getDate();
          if (!isSameDay) return false;
        }
      }

      // 4. Search Query (nama kasir, username, catatan)
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const nameMatch = shift.cashier?.full_name?.toLowerCase().includes(q);
        const userMatch = shift.cashier?.username?.toLowerCase().includes(q);
        const notesMatch = shift.notes?.toLowerCase().includes(q);
        return Boolean(nameMatch || userMatch || notesMatch);
      }

      return true;
    });
  }, [allShifts, cashierFilter, statusFilter, dateFilter, customDate, searchQuery]);

  const isFiltered =
    cashierFilter !== "all" ||
    statusFilter !== "all" ||
    dateFilter !== "all" ||
    customDate !== "" ||
    searchQuery.trim() !== "";

  const handleResetFilters = () => {
    setCashierFilter("all");
    setStatusFilter("all");
    setDateFilter("all");
    setCustomDate("");
    setSearchQuery("");
  };

  // Handler Buka Shift atas nama kasir oleh Admin
  const handleOpenShiftByAdmin = () => {
    if (!selectedCashierId) {
      toast.error("Pilih kasir yang akan dibuka shift-nya.");
      return;
    }

    if (activeShifts.length > 0) {
      toast.error(
        `Sudah ada shift kasir aktif atas nama ${activeShifts[0]?.cashier?.full_name || "kasir lain"}. Tutup shift tersebut terlebih dahulu.`,
      );
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
        void broadcastGlobalShiftChanged();
        router.refresh();
      } else {
        toast.error(res.message || "Gagal membuka shift kasir.");
      }
    });
  };

  // Handler Tutup Shift Kasir oleh Admin
  const handleOpenCloseShiftModal = (shift: ShiftWithCashier) => {
    setShiftToClose(shift);
    setActualCashInput(shift.expected_cash ?? 0);
    setClosingNotes("");
  };

  const handleCloseShiftByAdmin = () => {
    if (!shiftToClose) return;

    if (actualCashInput < 0) {
      toast.error("Nominal uang fisik tidak boleh bernilai negatif.");
      return;
    }

    const difference = actualCashInput - (shiftToClose.expected_cash ?? 0);
    if (difference !== 0 && (!closingNotes || closingNotes.trim().length < 3)) {
      toast.error(
        "Terdapat selisih kas fisik. Catatan rekonsiliasi wajib diisi minimal 3 karakter.",
      );
      return;
    }

    startTransition(async () => {
      const res = await closeShiftAction({
        shiftId: shiftToClose.id,
        actualCash: actualCashInput,
        notes: closingNotes.trim() || null,
      });

      if (res.ok && res.data) {
        toast.success(res.message);
        setShiftToClose(null);
        void broadcastGlobalShiftChanged();
        router.refresh();
      } else {
        toast.error(res.message || "Gagal menutup shift kasir.");
      }
    });
  };

  const adminCloseDifference = shiftToClose
    ? actualCashInput - (shiftToClose.expected_cash ?? 0)
    : 0;

  // Handler Lihat Detail Mutasi Kas & Audit Rekonsiliasi Shift
  const handleViewDetail = async (shift: ShiftWithCashier) => {
    setSelectedShiftForDetail(shift);
    setSelectedShiftSummary(null);
    setIsDetailModalOpen(true);
    setIsLoadingDetail(true);

    const [movRes, sumRes] = await Promise.all([
      getCashMovementsAction(shift.id),
      getShiftSummaryAction(shift.id),
    ]);

    if (movRes.ok && movRes.data) {
      setShiftMovements(movRes.data);
    } else {
      toast.error(movRes.message || "Gagal memuat mutasi kas shift.");
      setShiftMovements([]);
    }

    if (sumRes.ok && sumRes.data) {
      setSelectedShiftSummary(sumRes.data);
    } else {
      setSelectedShiftSummary(null);
    }

    setIsLoadingDetail(false);
  };

  const [isExporting, setIsExporting] = useState(false);

  const handleExportCsv = async () => {
    setIsExporting(true);
    try {
      let start: string | undefined;
      let end: string | undefined;
      if (dateFilter === "today") {
        start = getJakartaDateToday();
        end = getJakartaDateToday();
      } else if (dateFilter === "7d") {
        start = getJakartaDateDaysAgo(7);
        end = getJakartaDateToday();
      } else if (dateFilter === "30d") {
        start = getJakartaDateDaysAgo(30);
        end = getJakartaDateToday();
      } else if (dateFilter === "custom" && customDate) {
        start = customDate;
        end = customDate;
      }

      const res = await exportShiftsCsvAction({
        cashierId: cashierFilter,
        status: statusFilter,
        startDate: start,
        endDate: end,
      });

      if (res.ok && res.csvContent && res.filename) {
        downloadCsvInBrowser(res.filename, res.csvContent);
        toast.success("Data rekonsiliasi shift berhasil diekspor ke CSV.");
      } else {
        toast.error(res.message || "Gagal mengekspor data shift.");
      }
    } catch {
      toast.error("Terjadi kesalahan saat mengekspor data shift.");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <GlobalShiftSyncListener channelSuffix="admin-shifts" />
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
              {allShifts.length} <span className="text-xs font-normal text-muted-foreground">Sesi Tercatat</span>
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
                Monitoring laci kasir fisik aktif — maksimal 1 shift kasir aktif secara global pada satu waktu
              </CardDescription>
            </div>

            {inactiveCashiers.length > 0 &&
              (activeShifts.length === 0 ? (
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
              ) : (
                <div className="flex items-center gap-2">
                  <Badge
                    variant="secondary"
                    className="rounded-lg text-[11px] font-medium gap-1 text-amber-800 bg-amber-100 border border-amber-300"
                  >
                    <Lock className="size-3" />
                    Terkunci: 1 Shift Aktif Global
                  </Badge>
                  <Button
                    size="sm"
                    disabled
                    title="Tutup shift aktif saat ini sebelum membuka shift untuk kasir lain."
                    className="text-xs font-semibold rounded-xl gap-1.5"
                  >
                    <PlusCircle className="size-3.5" />
                    Buka Shift untuk Kasir
                  </Button>
                </div>
              ))}
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
                        <div className="inline-flex items-center justify-end gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleViewDetail(shift)}
                            className="h-8 px-2.5 text-xs font-semibold rounded-lg gap-1.5"
                          >
                            <Eye className="size-3.5" />
                            <span>Detail &amp; Mutasi</span>
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleOpenCloseShiftModal(shift)}
                            className="h-8 px-2.5 text-xs font-semibold rounded-lg gap-1.5"
                          >
                            <Lock className="size-3.5" />
                            <span>Tutup Shift</span>
                          </Button>
                        </div>
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
            <div className="text-xs text-muted-foreground font-medium">
              Menampilkan <strong>{filteredShifts.length}</strong> dari {allShifts.length} shift
            </div>
          </div>

          {/* Bar Filter Lengkap (Pencarian, Kasir, Status, Tanggal) */}
          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Cari kasir atau catatan..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-8.5 text-xs rounded-xl"
              />
            </div>

            <div className="w-full sm:w-48">
              <Select value={cashierFilter} onValueChange={setCashierFilter}>
                <SelectTrigger className="h-8.5 text-xs rounded-xl">
                  <SelectValue placeholder="Semua Kasir" />
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

            <div className="w-full sm:w-36">
              <Select
                value={statusFilter}
                onValueChange={(val) => setStatusFilter(val as "all" | "open" | "closed")}
              >
                <SelectTrigger className="h-8.5 text-xs rounded-xl">
                  <SelectValue placeholder="Semua Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Status</SelectItem>
                  <SelectItem value="open">Shift Aktif</SelectItem>
                  <SelectItem value="closed">Shift Ditutup</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="w-full sm:w-40">
              <Select
                value={dateFilter}
                onValueChange={(val) => {
                  setDateFilter(val as "all" | "today" | "7d" | "30d" | "custom");
                  if (val !== "custom") setCustomDate("");
                }}
              >
                <SelectTrigger className="h-8.5 text-xs rounded-xl">
                  <SelectValue placeholder="Semua Tanggal" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Tanggal</SelectItem>
                  <SelectItem value="today">Hari Ini</SelectItem>
                  <SelectItem value="7d">7 Hari Terakhir</SelectItem>
                  <SelectItem value="30d">30 Hari Terakhir</SelectItem>
                  <SelectItem value="custom">Pilih Tanggal...</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {dateFilter === "custom" && (
              <Input
                type="date"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                className="w-auto h-8.5 text-xs rounded-xl"
              />
            )}

            {isFiltered && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetFilters}
                className="h-8.5 px-2.5 text-xs font-semibold text-muted-foreground hover:text-foreground rounded-xl gap-1"
              >
                <X className="size-3.5" />
                Reset
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCsv}
              disabled={isExporting}
              className="h-8.5 px-3 text-xs font-semibold rounded-xl gap-1.5"
            >
              {isExporting ? (
                <Loader2 className="size-3.5 animate-spin text-primary" />
              ) : (
                <Download className="size-3.5 text-primary" />
              )}
              Export CSV
            </Button>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {filteredShifts.length === 0 ? (
            <div className="p-10 text-center space-y-2">
              <Filter className="size-8 text-muted-foreground/40 mx-auto" />
              <p className="text-xs font-semibold text-foreground">Tidak ada data shift yang cocok.</p>
              <p className="text-[11px] text-muted-foreground">
                Coba sesuaikan kata kunci pencarian, filter kasir, status, atau rentang tanggal.
              </p>
              {isFiltered && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleResetFilters}
                  className="h-8 text-xs font-semibold rounded-xl mt-2"
                >
                  Reset Semua Filter
                </Button>
              )}
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
                        <TableCell className="text-right font-mono font-bold text-primary">
                          {formatRupiah(shift.expected_cash)}
                        </TableCell>
                        <TableCell className="text-right font-mono font-bold">
                          {shift.actual_cash !== null ? formatRupiah(shift.actual_cash) : "-"}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {shift.status === "closed" ? (
                            diff === 0 ? (
                              <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-300 font-bold gap-1 font-mono">
                                <CheckCircle2 className="size-3 text-emerald-600" />
                                Cocok (Pas)
                              </Badge>
                            ) : diff > 0 ? (
                              <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-300 font-bold gap-1 font-mono">
                                <ArrowUpCircle className="size-3 text-blue-600" />
                                Lebih (+{formatRupiah(diff)})
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-300 font-bold gap-1 font-mono">
                                <ArrowDownCircle className="size-3 text-rose-600" />
                                Kurang (-{formatRupiah(Math.abs(diff))})
                              </Badge>
                            )
                          ) : (
                            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300 font-medium">
                              Shift Aktif
                            </Badge>
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
                            <span>Detail &amp; Mutasi</span>
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
      {/* DIALOG 2: AUDIT DETAIL SHIFT & REKONSILIASI KAS */}
      {/* ========================================================================= */}
      <Dialog open={isDetailModalOpen} onOpenChange={setIsDetailModalOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col p-0">
          <DialogHeader className="p-5 pb-3 border-b">
            <div className="flex items-center justify-between gap-3">
              <div>
                <DialogTitle className="text-base font-bold flex items-center gap-2">
                  <Receipt className="size-5 text-primary" />
                  Audit Detail Shift &amp; Rekonsiliasi Kas (Detail Mutasi Kas Shift)
                </DialogTitle>
                <DialogDescription className="text-xs mt-1">
                  Kasir: <strong>{selectedShiftForDetail?.cashier?.full_name}</strong> (@{selectedShiftForDetail?.cashier?.username}) • ID Shift: <span className="font-mono text-[11px]">{selectedShiftForDetail?.id}</span>
                </DialogDescription>
              </div>
              <div>
                {selectedShiftForDetail?.status === "open" ? (
                  <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-300 font-bold">
                    Shift Aktif
                  </Badge>
                ) : (
                  <Badge variant="outline" className="bg-slate-100 text-slate-700 font-bold">
                    Shift Selesai (Closed)
                  </Badge>
                )}
              </div>
            </div>
          </DialogHeader>

          <div className="p-5 space-y-4 flex-1 overflow-y-auto">
            {isLoadingDetail ? (
              <div className="p-12 text-center space-y-2">
                <Loader2 className="size-6 animate-spin text-primary mx-auto" />
                <p className="text-xs text-muted-foreground">Memuat rincian finansial &amp; buku mutasi kas...</p>
              </div>
            ) : (
              <>
                {/* 1. Rekonsiliasi Status Callout Banner */}
                {selectedShiftForDetail?.status === "closed" ? (
                  (selectedShiftForDetail?.cash_difference ?? 0) === 0 ? (
                    <div className="flex items-start gap-3 p-3.5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-900 text-xs">
                      <CheckCircle2 className="size-5 text-emerald-600 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-bold text-sm text-emerald-800">Rekonsiliasi Sempurna: Cocok / Seimbang (Pas)</p>
                        <p className="text-emerald-700 text-[11px] mt-0.5">
                          Uang fisik aktual di laci kasir cocok persis dengan ekspektasi sistem tanpa ada selisih kas (Rp 0).
                        </p>
                      </div>
                    </div>
                  ) : (selectedShiftForDetail?.cash_difference ?? 0) > 0 ? (
                    <div className="flex items-start gap-3 p-3.5 bg-blue-500/10 border border-blue-500/30 rounded-xl text-blue-900 text-xs">
                      <ArrowUpCircle className="size-5 text-blue-600 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-bold text-sm text-blue-800">
                          Rekonsiliasi Kas: Selisih Lebih / Surplus (+{formatRupiah(selectedShiftForDetail?.cash_difference ?? 0)})
                        </p>
                        <p className="text-blue-700 text-[11px] mt-0.5">
                          Uang fisik di kasir tercatat lebih banyak daripada saldo ekspektasi sistem.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-3 p-3.5 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-900 text-xs">
                      <ArrowDownCircle className="size-5 text-rose-600 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-bold text-sm text-rose-800">
                          Rekonsiliasi Kas: Selisih Kurang / Defisit (-{formatRupiah(Math.abs(selectedShiftForDetail?.cash_difference ?? 0))})
                        </p>
                        <p className="text-rose-700 text-[11px] mt-0.5">
                          Uang fisik di kasir tercatat lebih sedikit daripada saldo ekspektasi sistem.
                        </p>
                      </div>
                    </div>
                  )
                ) : (
                  <div className="flex items-start gap-3 p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-900 text-xs">
                    <Clock className="size-5 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-sm text-amber-800">Shift Sedang Berjalan (Belum Ditutup)</p>
                      <p className="text-amber-700 text-[11px] mt-0.5">
                        Kasir belum menyelesaikan shift. Rekonsiliasi kas fisik dan pencatatan selisih akan dievaluasi saat penutupan shift.
                      </p>
                    </div>
                  </div>
                )}

                {/* 2. Informasi Waktu & Durasi Shift */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 rounded-xl border bg-muted/20 text-xs">
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Waktu Buka Shift</span>
                    <span className="font-mono font-bold text-foreground">
                      {selectedShiftForDetail && formatDate(selectedShiftForDetail.opened_at)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Waktu Tutup Shift</span>
                    <span className="font-mono font-bold text-foreground">
                      {selectedShiftForDetail?.closed_at ? formatDate(selectedShiftForDetail.closed_at) : "Masih Buka (Aktif)"}
                    </span>
                  </div>
                </div>

                {/* 3. Grid Rincian Finansial Shift (Sesuai Persyaratan F5.4) */}
                <div className="space-y-1.5">
                  <h4 className="text-xs font-bold text-foreground">Rincian Finansial Kas Drawer</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                    <Card className="rounded-xl shadow-2xs">
                      <CardHeader className="p-3 pb-1">
                        <CardDescription className="text-[10px] font-semibold text-muted-foreground">Modal Awal</CardDescription>
                        <CardTitle className="text-sm font-bold font-mono">
                          {formatRupiah(selectedShiftSummary?.openingCash ?? selectedShiftForDetail?.opening_cash ?? 0)}
                        </CardTitle>
                      </CardHeader>
                    </Card>

                    <Card className="rounded-xl shadow-2xs">
                      <CardHeader className="p-3 pb-1">
                        <CardDescription className="text-[10px] font-semibold text-emerald-700">Penjualan Tunai (+)</CardDescription>
                        <CardTitle className="text-sm font-bold font-mono text-emerald-700">
                          +{formatRupiah(selectedShiftSummary?.totalCashSales ?? 0)}
                        </CardTitle>
                      </CardHeader>
                    </Card>

                    <Card className="rounded-xl shadow-2xs">
                      <CardHeader className="p-3 pb-1">
                        <CardDescription className="text-[10px] font-semibold text-rose-700">Refund Tunai (-)</CardDescription>
                        <CardTitle className="text-sm font-bold font-mono text-rose-700">
                          -{formatRupiah(selectedShiftSummary?.totalCashRefunds ?? 0)}
                        </CardTitle>
                      </CardHeader>
                    </Card>

                    <Card className="rounded-xl shadow-2xs">
                      <CardHeader className="p-3 pb-1">
                        <CardDescription className="text-[10px] font-semibold text-blue-700">Kas Masuk (+)</CardDescription>
                        <CardTitle className="text-sm font-bold font-mono text-blue-700">
                          +{formatRupiah(selectedShiftSummary?.totalCashIn ?? 0)}
                        </CardTitle>
                      </CardHeader>
                    </Card>

                    <Card className="rounded-xl shadow-2xs">
                      <CardHeader className="p-3 pb-1">
                        <CardDescription className="text-[10px] font-semibold text-amber-700">Kas Keluar (-)</CardDescription>
                        <CardTitle className="text-sm font-bold font-mono text-amber-700">
                          -{formatRupiah(selectedShiftSummary?.totalCashOut ?? 0)}
                        </CardTitle>
                      </CardHeader>
                    </Card>

                    <Card className="rounded-xl border-primary/30 bg-primary/5 shadow-2xs">
                      <CardHeader className="p-3 pb-1">
                        <CardDescription className="text-[10px] font-bold text-primary">Expected Cash</CardDescription>
                        <CardTitle className="text-sm font-extrabold font-mono text-primary">
                          {formatRupiah(selectedShiftSummary?.expectedCash ?? selectedShiftForDetail?.expected_cash ?? 0)}
                        </CardTitle>
                      </CardHeader>
                    </Card>
                  </div>
                </div>

                {/* 4. Perbandingan Rekonsiliasi Fisik */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 rounded-xl border bg-muted/20 text-xs">
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Uang Fisik Aktual (Dihitung Kasir)</span>
                    <span className="font-mono font-extrabold text-base text-foreground">
                      {selectedShiftForDetail?.actual_cash !== null
                        ? formatRupiah(selectedShiftForDetail?.actual_cash ?? 0)
                        : "- (Shift Belum Ditutup)"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Selisih Kas Rekonsiliasi</span>
                    <span className="font-mono font-extrabold text-base">
                      {selectedShiftForDetail?.status === "closed" ? (
                        (selectedShiftForDetail?.cash_difference ?? 0) === 0 ? (
                          <span className="text-emerald-700">Pas (Rp 0)</span>
                        ) : (selectedShiftForDetail?.cash_difference ?? 0) > 0 ? (
                          <span className="text-blue-700">+{formatRupiah(selectedShiftForDetail?.cash_difference ?? 0)}</span>
                        ) : (
                          <span className="text-rose-700">-{formatRupiah(Math.abs(selectedShiftForDetail?.cash_difference ?? 0))}</span>
                        )
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </span>
                  </div>
                </div>

                {/* 5. Catatan Shift / Rekonsiliasi */}
                {selectedShiftForDetail?.notes && (
                  <div className="text-xs p-3.5 rounded-xl border bg-muted/10 space-y-1">
                    <span className="font-semibold text-muted-foreground block text-[11px]">Catatan Pembukaan / Penutupan Shift:</span>
                    <p className="text-foreground leading-relaxed">{selectedShiftForDetail.notes}</p>
                  </div>
                )}

                {/* 6. Tabel Buku Besar Mutasi Kas Shift */}
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-foreground">
                      Buku Besar Pergerakan Kas Drawer ({shiftMovements.length} Mutasi)
                    </h4>
                    <span className="text-[11px] text-muted-foreground">Urutan Kronologis</span>
                  </div>

                  {shiftMovements.length === 0 ? (
                    <div className="p-8 text-center text-xs text-muted-foreground border rounded-xl">
                      Tidak ada pergerakan kas selain modal awal.
                    </div>
                  ) : (
                    <div className="rounded-xl border overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow className="text-xs">
                            <TableHead>Waktu</TableHead>
                            <TableHead>Jenis</TableHead>
                            <TableHead>Keterangan / Alasan</TableHead>
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
                                <TableCell
                                  className={`text-right font-mono font-bold whitespace-nowrap ${
                                    isPositive ? "text-emerald-700" : "text-rose-700"
                                  }`}
                                >
                                  {isPositive ? "+" : "-"}
                                  {formatRupiah(m.amount)}
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
              </>
            )}
          </div>

          <DialogFooter className="p-4 border-t bg-muted/20">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsDetailModalOpen(false)}
              className="rounded-xl text-xs font-semibold"
            >
              Tutup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ========================================================================= */}
      {/* DIALOG 3: TUTUP SHIFT KASIR OLEH ADMIN & REKONSILIASI */}
      {/* ========================================================================= */}
      <Dialog
        open={shiftToClose !== null}
        onOpenChange={(open) => {
          if (!open && !isPending) setShiftToClose(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Lock className="size-5 text-destructive" />
              Tutup Shift Kasir (Admin)
            </DialogTitle>
            <DialogDescription className="text-xs">
              Menutup shift aktif milik{" "}
              <strong>{shiftToClose?.cashier?.full_name || "Kasir"}</strong> (@
              {shiftToClose?.cashier?.username || "-"}) dan mencatat hasil rekonsiliasi kas.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="p-4 rounded-xl border bg-muted/30 flex items-center justify-between">
              <div>
                <span className="text-xs text-muted-foreground block">
                  Expected Cash (Sistem)
                </span>
                <span className="text-xl font-mono font-extrabold text-foreground">
                  {formatRupiah(shiftToClose?.expected_cash ?? 0)}
                </span>
              </div>
              <Badge variant="outline" className="text-xs font-mono">
                Modal: {formatRupiah(shiftToClose?.opening_cash ?? 0)}
              </Badge>
            </div>

            <div className="space-y-2">
              <Label htmlFor="admin-actual-cash-input" className="text-xs font-semibold">
                Uang Fisik Aktual (Rp)
              </Label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">
                  Rp
                </span>
                <Input
                  id="admin-actual-cash-input"
                  type="number"
                  min={0}
                  value={actualCashInput}
                  onChange={(e) =>
                    setActualCashInput(parseInt(e.target.value, 10) || 0)
                  }
                  className="pl-10 text-base font-mono font-bold h-11 rounded-xl"
                />
              </div>
            </div>

            <div
              className={`p-3.5 rounded-xl border flex items-center justify-between text-xs font-medium ${
                adminCloseDifference === 0
                  ? "border-emerald-500/40 bg-emerald-50 text-emerald-900"
                  : adminCloseDifference > 0
                    ? "border-blue-500/40 bg-blue-50 text-blue-900"
                    : "border-rose-500/40 bg-rose-50 text-rose-900"
              }`}
            >
              <div className="flex items-center gap-2">
                {adminCloseDifference === 0 ? (
                  <CheckCircle2 className="size-4 text-emerald-600" />
                ) : (
                  <AlertCircle className="size-4 text-rose-600" />
                )}
                <span>
                  {adminCloseDifference === 0
                    ? "Kas Fisik Cocok Sempurna (Tidak Ada Selisih)"
                    : adminCloseDifference > 0
                      ? "Selisih Lebih (Surplus)"
                      : "Selisih Kurang (Defisit)"}
                </span>
              </div>
              <span className="font-mono font-bold text-sm">
                {adminCloseDifference === 0
                  ? "Rp 0"
                  : adminCloseDifference > 0
                    ? `+${formatRupiah(adminCloseDifference)}`
                    : `-${formatRupiah(Math.abs(adminCloseDifference))}`}
              </span>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="admin-closing-notes" className="text-xs font-semibold">
                Catatan Penutupan{" "}
                {adminCloseDifference !== 0 && (
                  <span className="text-destructive">* (Wajib bila ada selisih)</span>
                )}
              </Label>
              <Textarea
                id="admin-closing-notes"
                rows={2}
                placeholder={
                  adminCloseDifference !== 0
                    ? "Jelaskan penyebab selisih kas..."
                    : "Catatan penutupan shift oleh admin (opsional)..."
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
              onClick={() => setShiftToClose(null)}
              className="rounded-xl text-xs"
            >
              Batal
            </Button>
            <Button
              type="button"
              disabled={
                isPending ||
                actualCashInput < 0 ||
                (adminCloseDifference !== 0 && closingNotes.trim().length < 3)
              }
              onClick={handleCloseShiftByAdmin}
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
