"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  AlertCircle,
  ArrowDownCircle,
  ArrowUpCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  FileText,
  Filter,
  History,
  Info,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Split,
  Tag,
  Utensils,
  Wallet,
  X,
} from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getJakartaDateDaysAgo,
  getJakartaDateToday,
} from "@/lib/reports/calculations";
import {
  getAdminTransactionDetailAction,
  getAdminTransactionsAction,
} from "@/lib/transactions/actions";
import type {
  OrderStatus,
  OrderType,
  PaymentStatus,
} from "@/types/database";
import type {
  AdminTransactionDetail,
  PaginatedTransactionsResult,
  TransactionFilterInput,
  TransactionPaymentMethodFilter,
} from "@/lib/transactions/types";

export type CashierProfile = {
  id: string;
  full_name: string;
  username: string;
};

interface TransactionHistoryProps {
  initialData: PaginatedTransactionsResult;
  cashiers: CashierProfile[];
}

function formatRupiah(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDateTime(isoString: string | null | undefined): string {
  if (!isoString) return "-";
  try {
    const d = new Date(isoString);
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return isoString;
  }
}

export function TransactionHistory({
  initialData,
  cashiers,
}: TransactionHistoryProps) {
  const [data, setData] = useState<PaginatedTransactionsResult>(initialData);
  const [isPending, startTransition] = useTransition();
  const [isLoading, setIsLoading] = useState(false);

  // Filters State
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [datePreset, setDatePreset] = useState<"all" | "today" | "7d" | "30d" | "custom">("all");
  const [paymentStatus, setPaymentStatus] = useState<string>("all");
  const [orderStatus, setOrderStatus] = useState<string>("all");
  const [paymentMethod, setPaymentMethod] = useState<string>("all");
  const [orderType, setOrderType] = useState<string>("all");
  const [cashierId, setCashierId] = useState<string>("all");
  const [currentPage, setCurrentPage] = useState<number>(initialData.page || 1);
  const [pageSize, setPageSize] = useState<number>(initialData.pageSize || 20);

  // Refs for tracking lifecycle and race conditions
  const isFirstMount = useRef(true);
  const requestIdRef = useRef(0);

  // Debounce search input (400ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  // Reactive Auto Apply Fetch Effect
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }

    const reqId = ++requestIdRef.current;
    setIsLoading(true);

    startTransition(async () => {
      try {
        const payload: TransactionFilterInput = {
          search: debouncedSearch.trim() || undefined,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          paymentStatus: paymentStatus as PaymentStatus | "all",
          orderStatus: orderStatus as OrderStatus | "all",
          paymentMethod: paymentMethod as TransactionPaymentMethodFilter,
          orderType: orderType as OrderType | "all",
          cashierId: cashierId !== "all" ? cashierId : undefined,
          page: currentPage,
          pageSize,
        };

        const res = await getAdminTransactionsAction(payload);
        if (reqId === requestIdRef.current && res.ok && res.data) {
          setData(res.data);
        }
      } finally {
        if (reqId === requestIdRef.current) {
          setIsLoading(false);
        }
      }
    });
  }, [
    debouncedSearch,
    startDate,
    endDate,
    paymentStatus,
    orderStatus,
    paymentMethod,
    orderType,
    cashierId,
    currentPage,
    pageSize,
  ]);

  const handleApplyPreset = (preset: "all" | "today" | "7d" | "30d" | "custom") => {
    setDatePreset(preset);
    let s = "";
    let e = "";
    if (preset === "today") {
      s = getJakartaDateToday();
      e = getJakartaDateToday();
    } else if (preset === "7d") {
      s = getJakartaDateDaysAgo(7);
      e = getJakartaDateToday();
    } else if (preset === "30d") {
      s = getJakartaDateDaysAgo(30);
      e = getJakartaDateToday();
    }
    setStartDate(s);
    setEndDate(e);
    setCurrentPage(1);
  };

  const handleResetFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setStartDate("");
    setEndDate("");
    setDatePreset("all");
    setPaymentStatus("all");
    setOrderStatus("all");
    setPaymentMethod("all");
    setOrderType("all");
    setCashierId("all");
    setCurrentPage(1);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setDebouncedSearch(search);
  };

  const isRefreshing = isPending || isLoading;

  // Detail Modal State
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [detailData, setDetailData] = useState<AdminTransactionDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [activeDetailTab, setActiveDetailTab] = useState<
    "items" | "payments" | "refunds" | "shifts"
  >("items");

  // Buka Detail Transaksi
  const handleOpenDetail = async (orderId: string) => {
    setIsDetailOpen(true);
    setIsLoadingDetail(true);
    setDetailError(null);
    setDetailData(null);
    setActiveDetailTab("items");

    const res = await getAdminTransactionDetailAction(orderId);
    if (res.ok && res.data) {
      setDetailData(res.data);
    } else {
      setDetailError(res.message || "Gagal memuat detail transaksi.");
    }
    setIsLoadingDetail(false);
  };

  const isFiltered =
    search.trim() !== "" ||
    startDate !== "" ||
    endDate !== "" ||
    datePreset !== "all" ||
    paymentStatus !== "all" ||
    orderStatus !== "all" ||
    paymentMethod !== "all" ||
    orderType !== "all" ||
    cashierId !== "all" ||
    currentPage > 1;

  return (
    <div className="space-y-6">
      {/* SECTION 1: METRIC KPI SUMMARY */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <Card className="rounded-2xl border-primary/30 bg-primary/5 shadow-2xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-semibold text-primary flex items-center justify-between">
              <span>Total Transaksi</span>
              <FileText className="size-4 text-primary" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono text-primary">
              {data.metricSummary.totalTransactions.toLocaleString("id-ID")}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="rounded-2xl shadow-2xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium text-muted-foreground flex items-center justify-between">
              <span>Nilai Penjualan (Gross)</span>
              <Wallet className="size-4 text-muted-foreground" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono text-foreground">
              {formatRupiah(data.metricSummary.totalAmountSum)}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="rounded-2xl border-emerald-200 bg-emerald-50/40 shadow-2xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-semibold text-emerald-800 flex items-center justify-between">
              <span>Total Diterima (Paid)</span>
              <CheckCircle2 className="size-4 text-emerald-600" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono text-emerald-700">
              {formatRupiah(data.metricSummary.paidAmountSum)}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="rounded-2xl border-rose-200 bg-rose-50/40 shadow-2xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-semibold text-rose-800 flex items-center justify-between">
              <span>Total Pengembalian (Refund)</span>
              <RotateCcw className="size-4 text-rose-600" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono text-rose-700">
              {formatRupiah(data.metricSummary.totalRefundedSum)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* SECTION 2: SEARCH & FILTER CONTROLS */}
      <Card className="rounded-2xl shadow-2xs">
        <CardHeader className="p-4 pb-3 border-b space-y-3">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            {/* Search Input with Debounce & Loading Indicator */}
            <form onSubmit={handleSearchSubmit} className="flex-1 max-w-md">
              <div className="relative w-full">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="Cari nomor pesanan / pelanggan..."
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="pl-9 pr-9 h-9 text-xs rounded-xl"
                />
                {isRefreshing || search !== debouncedSearch ? (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                    <Loader2 className="size-3.5 text-primary animate-spin" />
                  </div>
                ) : search ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setDebouncedSearch("");
                      setCurrentPage(1);
                    }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded transition-colors"
                    title="Hapus pencarian"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
            </form>

            {/* Date Preset Buttons */}
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant={datePreset === "all" ? "default" : "outline"}
                size="sm"
                onClick={() => handleApplyPreset("all")}
                className="h-8 text-xs rounded-xl"
                disabled={isRefreshing}
              >
                Semua Waktu
              </Button>
              <Button
                variant={datePreset === "today" ? "default" : "outline"}
                size="sm"
                onClick={() => handleApplyPreset("today")}
                className="h-8 text-xs rounded-xl"
                disabled={isRefreshing}
              >
                Hari Ini
              </Button>
              <Button
                variant={datePreset === "7d" ? "default" : "outline"}
                size="sm"
                onClick={() => handleApplyPreset("7d")}
                className="h-8 text-xs rounded-xl"
                disabled={isRefreshing}
              >
                7 Hari
              </Button>
              <Button
                variant={datePreset === "30d" ? "default" : "outline"}
                size="sm"
                onClick={() => handleApplyPreset("30d")}
                className="h-8 text-xs rounded-xl"
                disabled={isRefreshing}
              >
                30 Hari
              </Button>
              <Button
                variant={datePreset === "custom" ? "default" : "outline"}
                size="sm"
                onClick={() => setDatePreset("custom")}
                className="h-8 text-xs rounded-xl"
                disabled={isRefreshing}
              >
                Kustom
              </Button>
            </div>
          </div>

          {/* Custom Date & Filter Selects (Auto Apply) */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 pt-1">
            {datePreset === "custom" && (
              <>
                <div>
                  <Label className="text-[11px] text-muted-foreground">Mulai</Label>
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => {
                      setStartDate(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="h-8.5 text-xs rounded-xl"
                  />
                </div>
                <div>
                  <Label className="text-[11px] text-muted-foreground">Akhir</Label>
                  <Input
                    type="date"
                    value={endDate}
                    onChange={(e) => {
                      setEndDate(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="h-8.5 text-xs rounded-xl"
                  />
                </div>
              </>
            )}

            <div>
              <Label className="text-[11px] text-muted-foreground">Status Bayar</Label>
              <Select
                value={paymentStatus}
                onValueChange={(val) => {
                  setPaymentStatus(val);
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger className="h-8.5 text-xs rounded-xl">
                  <SelectValue placeholder="Status Bayar" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Status Bayar</SelectItem>
                  <SelectItem value="paid">Lunas</SelectItem>
                  <SelectItem value="partially_paid">Sebagian Dibayar</SelectItem>
                  <SelectItem value="unpaid">Belum Bayar</SelectItem>
                  <SelectItem value="partially_refunded">Refund Sebagian</SelectItem>
                  <SelectItem value="refunded">Direfund Penuh</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-[11px] text-muted-foreground">Status Pesanan</Label>
              <Select
                value={orderStatus}
                onValueChange={(val) => {
                  setOrderStatus(val);
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger className="h-8.5 text-xs rounded-xl">
                  <SelectValue placeholder="Status Pesanan" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Status Pesanan</SelectItem>
                  <SelectItem value="completed">Selesai</SelectItem>
                  <SelectItem value="paid">Lunas (Menunggu Dapur)</SelectItem>
                  <SelectItem value="awaiting_payment">Menunggu Bayar</SelectItem>
                  <SelectItem value="cancelled">Dibatalkan</SelectItem>
                  <SelectItem value="refunded">Direfund</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-[11px] text-muted-foreground">Metode Bayar</Label>
              <Select
                value={paymentMethod}
                onValueChange={(val) => {
                  setPaymentMethod(val);
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger className="h-8.5 text-xs rounded-xl">
                  <SelectValue placeholder="Metode Bayar" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Metode</SelectItem>
                  <SelectItem value="cash">Tunai (Cash Drawer)</SelectItem>
                  <SelectItem value="midtrans">Midtrans Gateway</SelectItem>
                  <SelectItem value="split">Split Bill (Multi-Metode)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-[11px] text-muted-foreground">Tipe Pesanan</Label>
              <Select
                value={orderType}
                onValueChange={(val) => {
                  setOrderType(val);
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger className="h-8.5 text-xs rounded-xl">
                  <SelectValue placeholder="Tipe Pesanan" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Tipe</SelectItem>
                  <SelectItem value="dine_in">Dine-In (Di Tempat)</SelectItem>
                  <SelectItem value="takeaway">Takeaway (Bawa Pulang)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-[11px] text-muted-foreground">Kasir</Label>
              <Select
                value={cashierId}
                onValueChange={(val) => {
                  setCashierId(val);
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger className="h-8.5 text-xs rounded-xl">
                  <SelectValue placeholder="Pilih Kasir" />
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

            <div className="flex items-end gap-2 min-h-[34px]">
              {isFiltered && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleResetFilters}
                  className="h-8.5 px-3 text-xs rounded-xl text-muted-foreground hover:text-foreground gap-1.5 border-dashed"
                  disabled={isRefreshing}
                >
                  <X className="size-3.5" />
                  <span>Reset Filter</span>
                </Button>
              )}
              {isRefreshing && (
                <div className="flex items-center gap-1.5 text-[11px] text-primary font-medium px-1 h-8.5">
                  <Loader2 className="size-3.5 animate-spin" />
                  <span className="hidden sm:inline">Memperbarui...</span>
                </div>
              )}
            </div>
          </div>
        </CardHeader>

        {/* SECTION 3: TRANSACTIONS TABLE */}
        <CardContent className="p-0">
          {data.items.length === 0 ? (
            <div className="p-12 text-center space-y-2">
              <Filter className="size-8 text-muted-foreground/40 mx-auto" />
              <p className="text-xs font-semibold text-foreground">
                Tidak ada data transaksi yang ditemukan.
              </p>
              <p className="text-[11px] text-muted-foreground">
                Coba sesuaikan kata kunci pencarian, filter status, metode bayar, atau rentang tanggal.
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
            <div
              className={`overflow-x-auto transition-opacity duration-200 ${
                isRefreshing ? "opacity-60 pointer-events-none" : "opacity-100"
              }`}
            >
              <Table>
                <TableHeader>
                  <TableRow className="text-xs">
                    <TableHead>Pesanan</TableHead>
                    <TableHead>Waktu</TableHead>
                    <TableHead>Tipe &amp; Meja</TableHead>
                    <TableHead>Ringkasan Item</TableHead>
                    <TableHead className="text-right">Total Tagihan</TableHead>
                    <TableHead className="text-right">Dibayar</TableHead>
                    <TableHead className="text-center">Status Bayar</TableHead>
                    <TableHead className="text-center">Metode</TableHead>
                    <TableHead>Kasir</TableHead>
                    <TableHead className="text-right">Aksi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="text-xs font-medium">
                  {data.items.map((t) => (
                    <TableRow key={t.id}>
                      {/* Nomor Pesanan & Queue */}
                      <TableCell>
                        <div className="space-y-0.5">
                          <p className="font-bold font-mono text-foreground">
                            {t.orderNumber}
                          </p>
                          {t.queueNumber && (
                            <Badge
                              variant="outline"
                              className="bg-primary/10 text-primary border-primary/20 text-[10px] font-mono font-bold px-1.5 py-0"
                            >
                              Antrean: {t.queueNumber}
                            </Badge>
                          )}
                        </div>
                      </TableCell>

                      {/* Waktu */}
                      <TableCell className="font-mono text-muted-foreground whitespace-nowrap">
                        {formatDateTime(t.createdAt)}
                      </TableCell>

                      {/* Tipe & Meja */}
                      <TableCell>
                        <div className="space-y-0.5">
                          <Badge
                            variant="outline"
                            className={
                              t.orderType === "dine_in"
                                ? "bg-blue-50 text-blue-700 border-blue-200"
                                : "bg-purple-50 text-purple-700 border-purple-200"
                            }
                          >
                            {t.orderType === "dine_in" ? "Dine-In" : "Takeaway"}
                          </Badge>
                          {t.orderType === "dine_in" && t.tableName && (
                            <p className="text-[11px] text-muted-foreground font-semibold">
                              Meja: {t.tableName}
                            </p>
                          )}
                          {t.customerName && (
                            <p className="text-[11px] text-muted-foreground truncate max-w-[120px]">
                              {t.customerName}
                            </p>
                          )}
                        </div>
                      </TableCell>

                      {/* Ringkasan Item */}
                      <TableCell className="max-w-[200px]">
                        <p className="truncate text-foreground" title={t.itemSummary}>
                          {t.itemSummary}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {t.totalItemCount} item
                        </p>
                      </TableCell>

                      {/* Total Tagihan */}
                      <TableCell className="text-right font-mono font-bold text-foreground whitespace-nowrap">
                        {formatRupiah(t.grandTotal)}
                      </TableCell>

                      {/* Dibayar */}
                      <TableCell className="text-right font-mono font-bold text-emerald-700 whitespace-nowrap">
                        {formatRupiah(t.paidTotal)}
                        {t.hasRefund && (
                          <p className="text-[10px] text-rose-600 font-semibold">
                            (Refund: -{formatRupiah(t.refundedTotal)})
                          </p>
                        )}
                      </TableCell>

                      {/* Status Bayar */}
                      <TableCell className="text-center whitespace-nowrap">
                        {t.paymentStatus === "paid" ? (
                          <Badge
                            variant="outline"
                            className="bg-emerald-50 text-emerald-700 border-emerald-300 font-semibold"
                          >
                            Lunas
                          </Badge>
                        ) : t.paymentStatus === "partially_paid" ? (
                          <Badge
                            variant="outline"
                            className="bg-amber-50 text-amber-700 border-amber-300 font-semibold"
                          >
                            Sebagian
                          </Badge>
                        ) : t.paymentStatus === "refunded" ? (
                          <Badge
                            variant="outline"
                            className="bg-rose-50 text-rose-700 border-rose-300 font-semibold"
                          >
                            Direfund Penuh
                          </Badge>
                        ) : t.paymentStatus === "partially_refunded" ? (
                          <Badge
                            variant="outline"
                            className="bg-orange-50 text-orange-700 border-orange-300 font-semibold"
                          >
                            Refund Sebagian
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="bg-slate-100 text-slate-700 font-semibold"
                          >
                            Belum Bayar
                          </Badge>
                        )}
                      </TableCell>

                      {/* Metode Bayar */}
                      <TableCell className="text-center whitespace-nowrap">
                        {t.paymentMethod === "split" ? (
                          <Badge
                            variant="outline"
                            className="bg-indigo-50 text-indigo-700 border-indigo-300 font-semibold gap-1"
                          >
                            <Split className="size-3" />
                            Split Bill
                          </Badge>
                        ) : t.paymentMethod === "cash" ? (
                          <Badge
                            variant="outline"
                            className="bg-teal-50 text-teal-700 border-teal-300 font-semibold gap-1"
                          >
                            <Wallet className="size-3" />
                            Tunai
                          </Badge>
                        ) : t.paymentMethod === "midtrans" ? (
                          <Badge
                            variant="outline"
                            className="bg-blue-50 text-blue-700 border-blue-300 font-semibold"
                          >
                            Midtrans
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-[11px]">-</span>
                        )}
                      </TableCell>

                      {/* Kasir */}
                      <TableCell className="whitespace-nowrap">
                        <p className="font-semibold text-foreground">{t.cashierName}</p>
                        <p className="text-[11px] text-muted-foreground">
                          @{t.cashierUsername}
                        </p>
                      </TableCell>

                      {/* Aksi */}
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleOpenDetail(t.id)}
                          className="h-8 px-2.5 text-xs font-semibold rounded-lg gap-1.5"
                        >
                          <Eye className="size-3.5" />
                          <span>Detail</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* SECTION 4: SERVER-SIDE PAGINATION CONTROLS */}
          {data.totalCount > 0 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 border-t bg-muted/20">
              <div className="text-xs text-muted-foreground">
                Menampilkan{" "}
                <span className="font-bold text-foreground">
                  {(data.page - 1) * data.pageSize + 1}
                </span>{" "}
                sampai{" "}
                <span className="font-bold text-foreground">
                  {Math.min(data.page * data.pageSize, data.totalCount)}
                </span>{" "}
                dari{" "}
                <span className="font-bold text-foreground">
                  {data.totalCount}
                </span>{" "}
                transaksi
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">Tampilkan:</span>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(val) => {
                      const newSize = parseInt(val, 10);
                      setPageSize(newSize);
                      setCurrentPage(1);
                    }}
                  >
                    <SelectTrigger className="h-8 w-16 text-xs rounded-lg">
                      <SelectValue placeholder="20" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">10</SelectItem>
                      <SelectItem value="20">20</SelectItem>
                      <SelectItem value="50">50</SelectItem>
                      <SelectItem value="100">100</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage <= 1 || isRefreshing}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    className="h-8 w-8 p-0 rounded-lg"
                  >
                    <ChevronLeft className="size-4" />
                  </Button>

                  <span className="text-xs font-semibold px-2">
                    {data.page} / {Math.max(1, data.totalPages)}
                  </span>

                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage >= data.totalPages || isRefreshing}
                    onClick={() => setCurrentPage((p) => Math.min(data.totalPages, p + 1))}
                    className="h-8 w-8 p-0 rounded-lg"
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ========================================================================= */}
      {/* DIALOG: DETAIL TRANSAKSI, REFUND & REKONSILIASI SHIFT */}
      {/* ========================================================================= */}
      <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
        <DialogContent
          className="w-[min(100%-2rem,1050px)] sm:max-w-[1050px] max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden shadow-2xl rounded-2xl bg-card border border-border"
          style={{ width: "min(100% - 32px, 1050px)" }}
        >
          {/* HEADER MODAL (STICKY / SHRINK-0) */}
          <DialogHeader className="p-5 sm:px-6 sm:py-4 pb-3 border-b bg-muted/15 shrink-0 text-left pr-12">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <DialogTitle className="text-base sm:text-lg font-bold flex items-center gap-2">
                  <FileText className="size-5 text-primary shrink-0" />
                  Audit Detail Transaksi &amp; Integrasi
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  {detailData
                    ? `Nomor Pesanan: ${detailData.order.orderNumber} • ${formatDateTime(detailData.order.createdAt)}`
                    : "Memuat detail transaksi..."}
                </DialogDescription>
              </div>

              {detailData && (
                <div className="flex items-center gap-2 shrink-0">
                  <Badge
                    variant="outline"
                    className={
                      detailData.order.paymentStatus === "paid"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-300 font-semibold"
                        : detailData.order.paymentStatus === "partially_paid"
                          ? "bg-amber-50 text-amber-700 border-amber-300 font-semibold"
                          : detailData.order.paymentStatus === "refunded"
                            ? "bg-rose-50 text-rose-700 border-rose-300 font-semibold"
                            : "bg-slate-100 text-slate-700 font-semibold"
                    }
                  >
                    {detailData.order.paymentStatus === "paid"
                      ? "Lunas"
                      : detailData.order.paymentStatus === "partially_paid"
                        ? "Sebagian"
                        : detailData.order.paymentStatus === "refunded"
                          ? "Direfund"
                          : "Belum Bayar"}
                  </Badge>

                  <Badge
                    variant="outline"
                    className={
                      detailData.order.status === "completed"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                        : detailData.order.status === "paid"
                          ? "bg-blue-50 text-blue-700 border-blue-300"
                          : detailData.order.status === "cancelled"
                            ? "bg-rose-50 text-rose-700 border-rose-300"
                            : "bg-slate-100 text-slate-700"
                    }
                  >
                    {detailData.order.status}
                  </Badge>
                </div>
              )}
            </div>
          </DialogHeader>

          {isLoadingDetail ? (
            <div className="p-16 text-center space-y-3">
              <RefreshCw className="size-8 text-primary animate-spin mx-auto" />
              <p className="text-xs font-semibold text-muted-foreground">
                Memuat snapshot historis, pembayaran, refund, dan rekonsiliasi shift...
              </p>
            </div>
          ) : detailError || !detailData ? (
            <div className="p-16 text-center space-y-3">
              <AlertCircle className="size-8 text-rose-500 mx-auto" />
              <p className="text-xs font-semibold text-rose-600">
                {detailError || "Data detail transaksi tidak ditemukan."}
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 space-y-6">
              {/* TOP SUMMARY GRID */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-muted/30 p-3.5 sm:p-4 rounded-xl border">
                <div className="space-y-1">
                  <span className="text-[11px] font-medium text-muted-foreground">Tipe Pesanan &amp; Meja</span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge
                      variant="outline"
                      className={
                        detailData.order.orderType === "dine_in"
                          ? "bg-blue-50 text-blue-700 border-blue-200"
                          : "bg-purple-50 text-purple-700 border-purple-200"
                      }
                    >
                      {detailData.order.orderType === "dine_in" ? "Dine-In" : "Takeaway"}
                    </Badge>
                    {detailData.order.tableName && (
                      <span className="text-xs font-bold text-foreground">
                        Meja {detailData.order.tableName}
                      </span>
                    )}
                  </div>
                </div>

                <div className="space-y-1">
                  <span className="text-[11px] font-medium text-muted-foreground">Kasir Pembuat</span>
                  <p className="text-xs font-bold text-foreground truncate" title={detailData.order.cashierName}>
                    {detailData.order.cashierName}
                  </p>
                  <p className="text-[10px] text-muted-foreground font-mono">
                    @{detailData.order.cashierUsername}
                  </p>
                </div>

                <div className="space-y-1">
                  <span className="text-[11px] font-medium text-muted-foreground">Nomor Antrean &amp; Sesi</span>
                  <p className="text-xs font-bold font-mono text-primary">
                    {detailData.order.queueNumber ? `Antrean: ${detailData.order.queueNumber}` : "Tanpa Antrean"}
                  </p>
                  <p className="text-[10px] text-muted-foreground font-mono">
                    Tgl: {detailData.order.businessDate}
                  </p>
                </div>

                <div className="space-y-1">
                  <span className="text-[11px] font-medium text-muted-foreground">Nama Pelanggan</span>
                  <p className="text-xs font-bold text-foreground truncate" title={detailData.order.customerName ?? "Umum"}>
                    {detailData.order.customerName || "Pelanggan Umum"}
                  </p>
                  {detailData.order.notes && (
                    <p className="text-[10px] text-amber-700 italic truncate" title={detailData.order.notes}>
                      Catatan: {detailData.order.notes}
                    </p>
                  )}
                </div>
              </div>

              {/* TAB BUTTONS (RESPONSIVE HORIZONTAL SCROLL) */}
              <div className="border-b pb-2">
                <div className="flex items-center gap-2 overflow-x-auto no-scrollbar scroll-smooth">
                  <Button
                    type="button"
                    variant={activeDetailTab === "items" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setActiveDetailTab("items")}
                    className="h-8.5 px-3 text-xs font-semibold rounded-xl gap-1.5 shrink-0"
                  >
                    <Utensils className="size-3.5" />
                    <span>Rincian Produk ({detailData.items.length})</span>
                  </Button>
                  <Button
                    type="button"
                    variant={activeDetailTab === "payments" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setActiveDetailTab("payments")}
                    className="h-8.5 px-3 text-xs font-semibold rounded-xl gap-1.5 shrink-0"
                  >
                    <Wallet className="size-3.5" />
                    <span>Pembayaran ({detailData.payments.length})</span>
                  </Button>
                  <Button
                    type="button"
                    variant={activeDetailTab === "refunds" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setActiveDetailTab("refunds")}
                    className="h-8.5 px-3 text-xs font-semibold rounded-xl gap-1.5 shrink-0"
                  >
                    <RotateCcw className="size-3.5" />
                    <span>Riwayat Refund ({detailData.refunds.length})</span>
                  </Button>
                  <Button
                    type="button"
                    variant={activeDetailTab === "shifts" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setActiveDetailTab("shifts")}
                    className="h-8.5 px-3 text-xs font-semibold rounded-xl gap-1.5 shrink-0"
                  >
                    <ShieldCheck className="size-3.5" />
                    <span>Rekonsiliasi Shift ({detailData.shifts.length})</span>
                  </Button>
                </div>
              </div>

              {/* TAB 1: RINCIAN PRODUK & HARGA SNAPSHOT */}
              {activeDetailTab === "items" && (
                <div className="space-y-5">
                  <div className="border rounded-xl overflow-hidden bg-card">
                    <div className="overflow-x-auto">
                      <Table className="w-full">
                        <TableHeader className="bg-muted/40 text-xs">
                          <TableRow>
                            <TableHead className="w-[38%] min-w-[200px]">Produk (Snapshot Historis)</TableHead>
                            <TableHead className="text-right w-28 whitespace-nowrap">Harga Satuan</TableHead>
                            <TableHead className="text-center w-16 whitespace-nowrap">Qty</TableHead>
                            <TableHead className="text-right w-28 whitespace-nowrap">Subtotal</TableHead>
                            <TableHead className="text-right w-28 whitespace-nowrap">Diskon Item</TableHead>
                            <TableHead className="text-right w-32 whitespace-nowrap">Total Baris</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody className="text-xs font-medium">
                          {detailData.items.map((item) => (
                            <TableRow key={item.id} className="hover:bg-muted/20">
                              <TableCell className="align-top py-3">
                                <div className="space-y-1">
                                  <p className="font-bold text-foreground leading-snug">
                                    {item.productName}
                                  </p>
                                  {item.productSku && (
                                    <p className="text-[10px] text-muted-foreground font-mono">
                                      SKU: {item.productSku}
                                    </p>
                                  )}
                                  {item.modifiers.length > 0 && (
                                    <div className="text-[11px] text-muted-foreground space-y-0.5 pl-2 border-l-2 border-primary/30">
                                      {item.modifiers.map((m) => (
                                        <p key={m.id}>
                                          + {m.groupName}: <span className="font-medium text-foreground">{m.optionName}</span>{" "}
                                          {m.priceDelta > 0 && (
                                            <span className="text-primary font-mono">(+{formatRupiah(m.priceDelta)})</span>
                                          )}
                                        </p>
                                      ))}
                                    </div>
                                  )}
                                  {item.notes && (
                                    <p className="text-[11px] text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200/50 inline-block">
                                      Catatan: {item.notes}
                                    </p>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-right font-mono align-top py-3 whitespace-nowrap">
                                {formatRupiah(item.unitPrice)}
                              </TableCell>
                              <TableCell className="text-center font-mono font-bold align-top py-3 whitespace-nowrap">
                                {item.quantity}
                              </TableCell>
                              <TableCell className="text-right font-mono align-top py-3 whitespace-nowrap">
                                {formatRupiah(item.subtotal)}
                              </TableCell>
                              <TableCell className="text-right font-mono text-rose-600 align-top py-3 whitespace-nowrap">
                                {item.discountAmount > 0
                                  ? `-${formatRupiah(item.discountAmount)}`
                                  : "-"}
                              </TableCell>
                              <TableCell className="text-right font-mono font-bold text-foreground align-top py-3 whitespace-nowrap">
                                {formatRupiah(item.lineTotal)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  {/* Financial Breakdown (2-Column Grid on Desktop) */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
                    {/* Diskon & Linimasa Operasional */}
                    <div className="space-y-3">
                      {detailData.discounts.length > 0 ? (
                        <Card className="rounded-xl border shadow-2xs">
                          <CardHeader className="p-3.5 pb-2 border-b bg-muted/20">
                            <CardTitle className="text-xs font-bold flex items-center gap-1.5 text-foreground">
                              <Tag className="size-3.5 text-primary" />
                              Diskon &amp; Promo yang Diterapkan
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="p-3.5 space-y-2 text-xs">
                            {detailData.discounts.map((d) => (
                              <div
                                key={d.id}
                                className="flex justify-between items-start border-b pb-1.5 last:border-0 last:pb-0"
                              >
                                <div>
                                  <p className="font-bold text-foreground">
                                    {d.name}{" "}
                                    <span className="text-[10px] text-muted-foreground uppercase font-semibold">
                                      ({d.scope})
                                    </span>
                                  </p>
                                  {d.reason && (
                                    <p className="text-[11px] text-muted-foreground">
                                      Alasan: {d.reason}
                                    </p>
                                  )}
                                </div>
                                <span className="font-mono font-bold text-rose-600 shrink-0">
                                  -{formatRupiah(d.discountAmount)}
                                </span>
                              </div>
                            ))}
                          </CardContent>
                        </Card>
                      ) : (
                        <div className="p-4 rounded-xl border bg-muted/15 text-xs space-y-2">
                          <p className="font-bold text-foreground flex items-center gap-1.5">
                            <Clock className="size-4 text-primary" />
                            Linimasa Transaksi
                          </p>
                          <div className="space-y-1 text-muted-foreground text-[11px]">
                            <p>Waktu Dibuat: {formatDateTime(detailData.order.createdAt)}</p>
                            {detailData.order.servedAt && (
                              <p className="text-emerald-700 font-medium">
                                Waktu Disajikan: {formatDateTime(detailData.order.servedAt)}
                              </p>
                            )}
                            {detailData.order.cancelledAt && (
                              <p className="text-rose-600 font-medium">
                                Waktu Dibatalkan: {formatDateTime(detailData.order.cancelledAt)} (
                                {detailData.order.cancelReason || "Tanpa alasan"})
                              </p>
                            )}
                            <p>Pembaruan Terakhir: {formatDateTime(detailData.order.updatedAt)}</p>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Ringkasan Finansial Card */}
                    <Card className="rounded-xl border shadow-2xs bg-muted/20">
                      <CardContent className="p-4 space-y-2 text-xs">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Subtotal Produk</span>
                          <span className="font-mono font-semibold">
                            {formatRupiah(detailData.order.subtotal)}
                          </span>
                        </div>
                        {detailData.order.discountTotal > 0 && (
                          <div className="flex justify-between text-rose-600">
                            <span>Total Potongan Diskon</span>
                            <span className="font-mono font-bold">
                              -{formatRupiah(detailData.order.discountTotal)}
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            Pajak Restoran (PB1 {detailData.order.taxPercent}%)
                          </span>
                          <span className="font-mono">
                            {formatRupiah(detailData.order.taxTotal)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            Service Charge ({detailData.order.serviceChargePercent}%)
                          </span>
                          <span className="font-mono">
                            {formatRupiah(detailData.order.serviceTotal)}
                          </span>
                        </div>
                        <Separator className="my-1.5" />
                        <div className="flex justify-between text-sm font-bold">
                          <span className="text-foreground">Grand Total</span>
                          <span className="font-mono text-primary text-base">
                            {formatRupiah(detailData.order.grandTotal)}
                          </span>
                        </div>
                        <div className="flex justify-between font-bold text-emerald-700">
                          <span>Total Diterima (Paid)</span>
                          <span className="font-mono">
                            {formatRupiah(detailData.order.paidTotal)}
                          </span>
                        </div>
                        {detailData.order.refundedTotal > 0 && (
                          <div className="flex justify-between font-semibold text-rose-600">
                            <span>Total Direfund</span>
                            <span className="font-mono">
                              -{formatRupiah(detailData.order.refundedTotal)}
                            </span>
                          </div>
                        )}
                        {detailData.order.remainingBalance > 0 && (
                          <div className="flex justify-between font-bold text-rose-700 bg-rose-50 p-2.5 rounded-lg border border-rose-200 mt-1">
                            <span>Sisa Tagihan Belum Dibayar</span>
                            <span className="font-mono">
                              {formatRupiah(detailData.order.remainingBalance)}
                            </span>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </div>
              )}

              {/* TAB 2: RIWAYAT PEMBAYARAN & SPLIT BILL */}
              {activeDetailTab === "payments" && (
                <div className="space-y-4">
                  {detailData.splitBillSummary.isSplitBill && (
                    <div className="p-3.5 bg-indigo-50 border border-indigo-200 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2">
                        <Split className="size-4 text-indigo-700 shrink-0" />
                        <span className="font-bold text-indigo-900">
                          Transaksi Split Bill ({detailData.splitBillSummary.totalParts} Bagian Pembayaran)
                        </span>
                      </div>
                      <span className="font-mono font-bold text-indigo-800">
                        Total Terbayar: {formatRupiah(detailData.splitBillSummary.totalPaid)}
                      </span>
                    </div>
                  )}

                  <div className="border rounded-xl overflow-hidden bg-card">
                    <div className="overflow-x-auto">
                      <Table className="w-full">
                        <TableHeader className="bg-muted/40 text-xs">
                          <TableRow>
                            <TableHead className="min-w-[160px]">Metode &amp; Sumber</TableHead>
                            <TableHead className="whitespace-nowrap">Waktu</TableHead>
                            <TableHead className="text-right whitespace-nowrap">Nominal</TableHead>
                            <TableHead className="text-right whitespace-nowrap">Uang Diterima / Kembalian</TableHead>
                            <TableHead className="whitespace-nowrap">Kasir / Shift</TableHead>
                            <TableHead className="text-center whitespace-nowrap">Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody className="text-xs font-medium">
                          {detailData.payments.map((p) => (
                            <TableRow key={p.id} className="hover:bg-muted/20">
                              <TableCell>
                                <div className="space-y-0.5">
                                  <p className="font-bold uppercase text-foreground">
                                    {p.paymentMethod} ({p.paymentSource})
                                  </p>
                                  {p.referenceNumber && (
                                    <p className="text-[11px] font-mono text-muted-foreground">
                                      Ref: {p.referenceNumber}
                                    </p>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="font-mono text-muted-foreground whitespace-nowrap">
                                {formatDateTime(p.createdAt)}
                              </TableCell>
                              <TableCell className="text-right font-mono font-bold text-foreground whitespace-nowrap">
                                {formatRupiah(p.amount)}
                              </TableCell>
                              <TableCell className="text-right font-mono text-muted-foreground whitespace-nowrap">
                                {p.cashReceived !== null ? (
                                  <>
                                    <p>Diterima: {formatRupiah(p.cashReceived)}</p>
                                    <p>Kembalian: {formatRupiah(p.changeAmount)}</p>
                                  </>
                                ) : (
                                  "-"
                                )}
                              </TableCell>
                              <TableCell className="whitespace-nowrap">
                                <p className="font-bold text-foreground">{p.cashierName}</p>
                                {p.shiftId && (
                                  <p className="text-[10px] text-muted-foreground font-mono">
                                    Shift: {p.shiftId.slice(0, 8)}...
                                  </p>
                                )}
                              </TableCell>
                              <TableCell className="text-center whitespace-nowrap">
                                <Badge
                                  variant="outline"
                                  className={
                                    p.paymentStatus === "success"
                                      ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                                      : "bg-rose-50 text-rose-700 border-rose-300"
                                  }
                                >
                                  {p.paymentStatus}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  {/* Midtrans Transaction Metadata Card if available */}
                  {detailData.payments.some((p) => p.midtransDetails) && (
                    <Card className="rounded-xl border-blue-200 bg-blue-50/20">
                      <CardHeader className="p-3.5 pb-2">
                        <CardTitle className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                          <Info className="size-3.5 text-blue-600" />
                          Informasi Gateway Midtrans Sandbox
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="p-3.5 pt-0 text-xs space-y-1">
                        {detailData.payments
                          .filter((p) => p.midtransDetails)
                          .map((p) => {
                            const mt = p.midtransDetails!;
                            return (
                              <div
                                key={mt.id}
                                className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px] pt-1"
                              >
                                <div>
                                  <span className="text-muted-foreground">Order ID:</span>{" "}
                                  <span className="font-bold text-foreground">
                                    {mt.midtransOrderId}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Jenis:</span>{" "}
                                  <span className="font-bold">{mt.paymentType}</span>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Status:</span>{" "}
                                  <span className="font-bold text-blue-700">
                                    {mt.lifecycleStatus}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Waktu Lunas:</span>{" "}
                                  <span>{formatDateTime(mt.settledAt)}</span>
                                </div>
                              </div>
                            );
                          })}
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}

              {/* TAB 3: RIWAYAT REFUND F2.4 */}
              {activeDetailTab === "refunds" && (
                <div className="space-y-4">
                  {detailData.refunds.length === 0 ? (
                    <div className="p-10 text-center space-y-2 border rounded-xl bg-muted/20">
                      <CheckCircle2 className="size-7 text-muted-foreground mx-auto" />
                      <p className="text-xs font-bold text-foreground">
                        Tidak ada pengembalian dana (refund) untuk transaksi ini.
                      </p>
                      <p className="text-[11px] text-muted-foreground max-w-sm mx-auto">
                        Seluruh pembayaran transaksi ini tercatat penuh dan belum pernah direfund.
                      </p>
                    </div>
                  ) : (
                    <div className="border rounded-xl overflow-hidden bg-card">
                      <div className="overflow-x-auto">
                        <Table className="w-full">
                          <TableHeader className="bg-muted/40 text-xs">
                            <TableRow>
                              <TableHead className="min-w-[140px] whitespace-nowrap">Nomor Refund</TableHead>
                              <TableHead className="whitespace-nowrap">Tipe &amp; Metode</TableHead>
                              <TableHead className="text-right whitespace-nowrap">Nominal Refund</TableHead>
                              <TableHead className="min-w-[160px]">Alasan</TableHead>
                              <TableHead className="min-w-[160px]">Diajukan &amp; Disetujui</TableHead>
                              <TableHead className="text-center whitespace-nowrap">Status</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody className="text-xs font-medium">
                            {detailData.refunds.map((r) => (
                              <TableRow key={r.id} className="hover:bg-muted/20">
                                <TableCell className="font-mono font-bold text-foreground whitespace-nowrap">
                                  {r.refundNumber}
                                </TableCell>
                                <TableCell className="whitespace-nowrap">
                                  <div className="space-y-0.5">
                                    <Badge
                                      variant="outline"
                                      className="bg-muted font-semibold uppercase text-[10px]"
                                    >
                                      {r.refundType}
                                    </Badge>
                                    <p className="text-[11px] text-muted-foreground capitalize">
                                      {r.refundMethod}
                                    </p>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right font-mono font-bold text-rose-600 whitespace-nowrap">
                                  {formatRupiah(r.amount)}
                                </TableCell>
                                <TableCell className="max-w-[200px] truncate" title={r.reason}>
                                  {r.reason}
                                </TableCell>
                                <TableCell>
                                  <p className="font-bold text-foreground">Oleh: {r.requesterName}</p>
                                  {r.approverName && (
                                    <p className="text-[11px] text-muted-foreground">
                                      Disetujui: {r.approverName} ({formatDateTime(r.approvedAt)})
                                    </p>
                                  )}
                                </TableCell>
                                <TableCell className="text-center whitespace-nowrap">
                                  {r.status === "completed" ? (
                                    <Badge
                                      variant="outline"
                                      className="bg-emerald-50 text-emerald-700 border-emerald-300 font-semibold"
                                    >
                                      Selesai (Completed)
                                    </Badge>
                                  ) : r.status === "pending" ? (
                                    <Badge
                                      variant="outline"
                                      className="bg-amber-50 text-amber-700 border-amber-300 font-semibold"
                                    >
                                      Menunggu Persetujuan
                                    </Badge>
                                  ) : (
                                    <Badge
                                      variant="outline"
                                      className="bg-rose-50 text-rose-700 border-rose-300 font-semibold"
                                    >
                                      {r.status}
                                    </Badge>
                                  )}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 4: REKONSILIASI SHIFT & MUTASI KAS F5 */}
              {activeDetailTab === "shifts" && (
                <div className="space-y-5">
                  {detailData.shifts.length === 0 ? (
                    <div className="p-10 text-center space-y-2 border rounded-xl bg-muted/20">
                      <Wallet className="size-7 text-muted-foreground mx-auto" />
                      <p className="text-xs font-bold text-foreground">
                        Tidak ada shift kasir fisik yang terkait langsung.
                      </p>
                      <p className="text-[11px] text-muted-foreground max-w-sm mx-auto">
                        Transaksi ini diproses melalui gateway non-tunai (Midtrans) atau di luar sesi shift kasir fisik.
                      </p>
                    </div>
                  ) : (
                    detailData.shifts.map((s) => (
                      <Card key={s.id} className="rounded-xl border shadow-2xs">
                        <CardHeader className="p-4 pb-3 border-b bg-muted/20">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                            <div>
                              <CardTitle className="text-xs font-bold flex items-center gap-2">
                                <Wallet className="size-4 text-primary" />
                                Shift Kasir: {s.cashierName} (@{s.cashierUsername})
                              </CardTitle>
                              <CardDescription className="text-[11px] font-mono">
                                Dibuka: {formatDateTime(s.openedAt)} • Ditutup:{" "}
                                {s.closedAt ? formatDateTime(s.closedAt) : "Sedang Aktif"}
                              </CardDescription>
                            </div>
                            <div>
                              {s.status === "closed" ? (
                                s.reconciliationStatus === "match" ? (
                                  <Badge
                                    variant="outline"
                                    className="bg-emerald-50 text-emerald-700 border-emerald-300 font-bold gap-1 font-mono"
                                  >
                                    <CheckCircle2 className="size-3 text-emerald-600" />
                                    Cocok (Pas)
                                  </Badge>
                                ) : s.reconciliationStatus === "over" ? (
                                  <Badge
                                    variant="outline"
                                    className="bg-blue-50 text-blue-700 border-blue-300 font-bold gap-1 font-mono"
                                  >
                                    <ArrowUpCircle className="size-3 text-blue-600" />
                                    Lebih (+{formatRupiah(s.cashDifference ?? 0)})
                                  </Badge>
                                ) : (
                                  <Badge
                                    variant="outline"
                                    className="bg-rose-50 text-rose-700 border-rose-300 font-bold gap-1 font-mono"
                                  >
                                    <ArrowDownCircle className="size-3 text-rose-600" />
                                    Kurang (-{formatRupiah(Math.abs(s.cashDifference ?? 0))})
                                  </Badge>
                                )
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="bg-amber-50 text-amber-700 border-amber-300 font-medium"
                                >
                                  Shift Aktif
                                </Badge>
                              )}
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="p-4 space-y-4">
                          {/* Shift Reconciliation Metrics */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                            <div className="p-3 rounded-lg bg-muted/40 border">
                              <p className="text-[11px] text-muted-foreground">Modal Awal</p>
                              <p className="font-mono font-bold text-foreground">{formatRupiah(s.openingCash)}</p>
                            </div>
                            <div className="p-3 rounded-lg bg-muted/40 border">
                              <p className="text-[11px] text-muted-foreground">Penjualan Tunai</p>
                              <p className="font-mono font-bold text-emerald-700">
                                {formatRupiah(s.cashSales)}
                              </p>
                            </div>
                            <div className="p-3 rounded-lg bg-muted/40 border">
                              <p className="text-[11px] text-muted-foreground">Expected Cash (Sistem)</p>
                              <p className="font-mono font-bold text-primary">
                                {formatRupiah(s.expectedCash)}
                              </p>
                            </div>
                            <div className="p-3 rounded-lg bg-muted/40 border">
                              <p className="text-[11px] text-muted-foreground">Kas Fisik Aktual</p>
                              <p className="font-mono font-bold text-foreground">
                                {s.actualCash !== null ? formatRupiah(s.actualCash) : "-"}
                              </p>
                            </div>
                          </div>

                          {s.notes && (
                            <p className="text-[11px] text-muted-foreground italic bg-muted/20 p-2.5 rounded-lg border">
                              Catatan Penutupan: {s.notes}
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    ))
                  )}

                  {/* Cash Movements Ledger Related to this Transaction */}
                  {detailData.cashMovements.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
                        <History className="size-3.5 text-primary" />
                        Buku Besar Mutasi Kas Laci (Terkait Pesanan Ini)
                      </p>
                      <div className="border rounded-xl overflow-hidden bg-card">
                        <div className="overflow-x-auto">
                          <Table className="w-full">
                            <TableHeader className="bg-muted/40 text-xs">
                              <TableRow>
                                <TableHead className="whitespace-nowrap">Tipe Mutasi</TableHead>
                                <TableHead className="text-right whitespace-nowrap">Nominal</TableHead>
                                <TableHead className="text-right whitespace-nowrap">Saldo Sesudah</TableHead>
                                <TableHead className="min-w-[160px]">Alasan / Keterangan</TableHead>
                                <TableHead className="whitespace-nowrap">Waktu</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody className="text-xs font-medium">
                              {detailData.cashMovements.map((m) => (
                                <TableRow key={m.id} className="hover:bg-muted/20">
                                  <TableCell className="whitespace-nowrap">
                                    <Badge
                                      variant="outline"
                                      className={
                                        m.movementType === "cash_sale"
                                          ? "bg-emerald-50 text-emerald-700 border-emerald-300 font-mono text-[10px]"
                                          : "bg-rose-50 text-rose-700 border-rose-300 font-mono text-[10px]"
                                      }
                                    >
                                      {m.movementType}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="text-right font-mono font-bold whitespace-nowrap">
                                    {formatRupiah(m.amount)}
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-muted-foreground whitespace-nowrap">
                                    {formatRupiah(m.balanceAfter)}
                                  </TableCell>
                                  <TableCell className="max-w-xs truncate" title={m.reason}>
                                    {m.reason}
                                  </TableCell>
                                  <TableCell className="font-mono text-muted-foreground whitespace-nowrap">
                                    {formatDateTime(m.createdAt)}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
