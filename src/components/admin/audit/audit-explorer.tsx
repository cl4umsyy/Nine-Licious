"use client";

/**
 * NINE LICIOUS POS — ADMIN AUDIT EXPLORER COMPONENT
 * File: src/components/admin/audit/audit-explorer.tsx
 *
 * Antarmuka administratif untuk mengaudit rekaman aktivitas pengguna,
 * perubahan data (before/after), dan rekaman keamanan sistem.
 */

import { useEffect, useRef, useState, useTransition } from "react";
import {
  Activity,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Download,
  Eye,
  FileSearch,
  Loader2,
  Search,
  ShieldCheck,
  Users,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  exportAuditLogsCsvAction,
  getAdminAuditLogsAction,
} from "@/lib/audit/actions";
import type {
  AuditFilterInput,
  AuditLogItem,
  PaginatedAuditLogsResult,
} from "@/lib/audit/types";
import { downloadCsvInBrowser } from "@/lib/export/csv";
import {
  getJakartaDateDaysAgo,
  getJakartaDateToday,
} from "@/lib/reports/calculations";

type AuditExplorerProps = {
  initialData: PaginatedAuditLogsResult;
};

function formatJakartaTime(isoString: string | null | undefined): string {
  if (!isoString) return "-";
  try {
    const d = new Date(isoString);
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return String(isoString);
  }
}

function getActionColor(action: string): string {
  const act = action.toLowerCase();
  if (act.includes("delete") || act.includes("cancel") || act.includes("reject") || act.includes("waste")) {
    return "bg-rose-50 text-rose-700 border-rose-300";
  }
  if (act.includes("update") || act.includes("edit") || act.includes("opname") || act.includes("refund")) {
    return "bg-amber-50 text-amber-700 border-amber-300";
  }
  if (act.includes("create") || act.includes("open") || act.includes("success") || act.includes("settle") || act.includes("served")) {
    return "bg-emerald-50 text-emerald-700 border-emerald-300";
  }
  if (act.includes("shift") || act.includes("cash")) {
    return "bg-blue-50 text-blue-700 border-blue-300";
  }
  return "bg-slate-100 text-slate-700 border-slate-300";
}

export function AuditExplorer({ initialData }: AuditExplorerProps) {
  const [data, setData] = useState<PaginatedAuditLogsResult>(initialData);
  const [isPending, startTransition] = useTransition();
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Filters State
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [role, setRole] = useState<string>("all");
  const [entity, setEntity] = useState<string>("all");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [datePreset, setDatePreset] = useState<"all" | "today" | "7d" | "30d" | "custom">("all");
  const [currentPage, setCurrentPage] = useState<number>(initialData.page || 1);
  const [pageSize, setPageSize] = useState<number>(initialData.pageSize || 20);

  // Modal State
  const [selectedLog, setSelectedLog] = useState<AuditLogItem | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Refs
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
        const payload: AuditFilterInput = {
          search: debouncedSearch.trim() || undefined,
          role: role !== "all" ? role : undefined,
          entity: entity !== "all" ? entity : undefined,
          action: actionFilter !== "all" ? actionFilter : undefined,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          page: currentPage,
          pageSize,
        };

        const res = await getAdminAuditLogsAction(payload);
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
    role,
    entity,
    actionFilter,
    startDate,
    endDate,
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
    setRole("all");
    setEntity("all");
    setActionFilter("all");
    setStartDate("");
    setEndDate("");
    setDatePreset("all");
    setCurrentPage(1);
  };

  const handleExportCsv = async () => {
    setIsExporting(true);
    try {
      const res = await exportAuditLogsCsvAction({
        search: debouncedSearch.trim() || undefined,
        role: role !== "all" ? role : undefined,
        entity: entity !== "all" ? entity : undefined,
        action: actionFilter !== "all" ? actionFilter : undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });

      if (res.ok && res.csvContent && res.filename) {
        downloadCsvInBrowser(res.filename, res.csvContent);
      }
    } finally {
      setIsExporting(false);
    }
  };

  const handleCopyJson = () => {
    if (!selectedLog) return;
    navigator.clipboard.writeText(JSON.stringify(selectedLog.details, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isRefreshing = isPending || isLoading;

  const isFiltered =
    search.trim() !== "" ||
    role !== "all" ||
    entity !== "all" ||
    actionFilter !== "all" ||
    startDate !== "" ||
    endDate !== "" ||
    datePreset !== "all" ||
    currentPage > 1;

  // Cek apakah details memiliki before dan after
  const detailsBefore =
    selectedLog?.details?.before || selectedLog?.details?.old_data || null;
  const detailsAfter =
    selectedLog?.details?.after || selectedLog?.details?.new_data || null;
  const hasDiff = Boolean(detailsBefore || detailsAfter);

  return (
    <div className="space-y-6">
      {/* SECTION 1: KPI SUMMARY CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <Card className="rounded-2xl border-primary/30 bg-primary/5 shadow-2xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-semibold text-primary flex items-center justify-between">
              <span>Total Aktivitas Tercatat</span>
              <Activity className="size-4 text-primary" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono text-primary">
              {data.summary.totalEvents.toLocaleString("id-ID")}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="rounded-2xl shadow-2xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium text-muted-foreground flex items-center justify-between">
              <span>Pengguna Terlibat</span>
              <Users className="size-4 text-muted-foreground" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono text-foreground">
              {data.summary.distinctUsers}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="rounded-2xl border-blue-200 bg-blue-50/40 shadow-2xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-semibold text-blue-800 flex items-center justify-between">
              <span>Jenis Aksi Terpantau</span>
              <ShieldCheck className="size-4 text-blue-600" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono text-blue-700">
              {data.summary.distinctActions}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* SECTION 2: SEARCH & FILTER BAR */}
      <Card className="rounded-2xl shadow-2xs">
        <CardHeader className="p-4 pb-3 border-b space-y-3">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            {/* Search Input */}
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Cari username, ID entitas, atau jenis aksi..."
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

            {/* Date Preset Buttons & Export */}
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

              <Button
                variant="outline"
                size="sm"
                onClick={handleExportCsv}
                disabled={isRefreshing || isExporting}
                className="h-8 text-xs rounded-xl gap-1.5 font-medium ml-1"
              >
                {isExporting ? (
                  <Loader2 className="size-3.5 animate-spin text-primary" />
                ) : (
                  <Download className="size-3.5 text-primary" />
                )}
                <span>Export CSV</span>
              </Button>
            </div>
          </div>

          {/* Filter Selects */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 pt-1">
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
              <Label className="text-[11px] text-muted-foreground">Role Pengguna</Label>
              <Select
                value={role}
                onValueChange={(val) => {
                  setRole(val);
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger className="h-8.5 text-xs rounded-xl">
                  <SelectValue placeholder="Semua Role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Role</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="kasir">Kasir</SelectItem>
                  <SelectItem value="kitchen">Dapur (Kitchen)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-[11px] text-muted-foreground">Entitas Terkait</Label>
              <Select
                value={entity}
                onValueChange={(val) => {
                  setEntity(val);
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger className="h-8.5 text-xs rounded-xl">
                  <SelectValue placeholder="Semua Entitas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Entitas</SelectItem>
                  <SelectItem value="orders">Pesanan (Orders)</SelectItem>
                  <SelectItem value="payments">Pembayaran (Payments)</SelectItem>
                  <SelectItem value="refunds">Pengembalian (Refunds)</SelectItem>
                  <SelectItem value="shifts">Shift Kasir (Shifts)</SelectItem>
                  <SelectItem value="cash_movements">Mutasi Kas Laci</SelectItem>
                  <SelectItem value="inventory_items">Stok Bahan (Inventory)</SelectItem>
                  <SelectItem value="discounts">Diskon &amp; Promo</SelectItem>
                  <SelectItem value="profiles">Akun Pengguna (Profiles)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-[11px] text-muted-foreground">Jenis Aksi</Label>
              <Select
                value={actionFilter}
                onValueChange={(val) => {
                  setActionFilter(val);
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger className="h-8.5 text-xs rounded-xl">
                  <SelectValue placeholder="Semua Aksi" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Aksi</SelectItem>
                  <SelectItem value="shift_open">shift_open (Buka Shift)</SelectItem>
                  <SelectItem value="shift_close">shift_close (Tutup Shift)</SelectItem>
                  <SelectItem value="cash_in">cash_in (Kas Masuk)</SelectItem>
                  <SelectItem value="cash_out">cash_out (Kas Keluar)</SelectItem>
                  <SelectItem value="payment_cash_success">payment_cash_success</SelectItem>
                  <SelectItem value="midtrans_charge_created">midtrans_charge_created</SelectItem>
                  <SelectItem value="midtrans_webhook_settlement">midtrans_webhook_settlement</SelectItem>
                  <SelectItem value="order_created">order_created</SelectItem>
                  <SelectItem value="order_served">order_served</SelectItem>
                  <SelectItem value="order_cancelled">order_cancelled</SelectItem>
                  <SelectItem value="refund_approved">refund_approved</SelectItem>
                  <SelectItem value="stock_opname">stock_opname</SelectItem>
                  <SelectItem value="stock_received">stock_received</SelectItem>
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

        {/* SECTION 3: AUDIT LOGS TABLE */}
        <CardContent className="p-0">
          {data.items.length === 0 ? (
            <div className="p-12 text-center space-y-2">
              <FileSearch className="size-8 text-muted-foreground/40 mx-auto" />
              <p className="text-xs font-semibold text-foreground">
                Tidak ada log aktivitas yang sesuai dengan filter.
              </p>
              <p className="text-[11px] text-muted-foreground">
                Coba sesuaikan kata kunci pencarian, filter role, jenis aksi, entitas, atau rentang waktu.
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
                    <TableHead>Waktu (WIB)</TableHead>
                    <TableHead>Pengguna / Aktor</TableHead>
                    <TableHead>Jenis Aksi</TableHead>
                    <TableHead>Entitas Terkait</TableHead>
                    <TableHead>ID Record</TableHead>
                    <TableHead>Ringkasan Detail</TableHead>
                    <TableHead className="text-right">Aksi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="text-xs font-medium">
                  {data.items.map((log) => (
                    <TableRow key={log.id} className="hover:bg-muted/20">
                      <TableCell className="font-mono text-muted-foreground whitespace-nowrap">
                        {formatJakartaTime(log.createdAt)}
                      </TableCell>

                      <TableCell className="whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <div>
                            <p className="font-semibold text-foreground">
                              {log.userFullName || log.username}
                            </p>
                            <p className="text-[10px] text-muted-foreground font-mono">
                              @{log.username}
                            </p>
                          </div>
                          <Badge
                            variant="outline"
                            className="text-[10px] uppercase font-mono px-1.5 py-0"
                          >
                            {log.userRole}
                          </Badge>
                        </div>
                      </TableCell>

                      <TableCell className="whitespace-nowrap">
                        <Badge
                          variant="outline"
                          className={`${getActionColor(log.action)} font-mono font-bold text-[11px]`}
                        >
                          {log.action}
                        </Badge>
                      </TableCell>

                      <TableCell className="font-mono text-foreground whitespace-nowrap capitalize">
                        {log.entity || "-"}
                      </TableCell>

                      <TableCell className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {log.entityId ? (
                          <span title={log.entityId}>
                            {log.entityId.length > 12
                              ? `${log.entityId.slice(0, 10)}...`
                              : log.entityId}
                          </span>
                        ) : (
                          "-"
                        )}
                      </TableCell>

                      <TableCell className="max-w-[240px] truncate text-[11px] text-muted-foreground font-mono">
                        {Object.keys(log.details).length > 0
                          ? JSON.stringify(log.details)
                          : "-"}
                      </TableCell>

                      <TableCell className="text-right whitespace-nowrap">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSelectedLog(log);
                            setIsModalOpen(true);
                          }}
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

          {/* SECTION 4: SERVER-SIDE PAGINATION */}
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
                aktivitas
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
      {/* DIALOG DETAIL AKTIVITAS & PERUBAHAN (BEFORE / AFTER) */}
      {/* ========================================================================= */}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent
          className="w-[min(100%-2rem,900px)] sm:max-w-[900px] max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden shadow-2xl rounded-2xl bg-card border border-border"
          style={{ width: "min(100% - 32px, 900px)" }}
        >
          {selectedLog && (
            <>
              {/* Header Modal */}
              <DialogHeader className="p-5 sm:px-6 sm:py-4 pb-3 border-b bg-muted/15 shrink-0 text-left pr-12">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <DialogTitle className="text-base sm:text-lg font-bold flex items-center gap-2">
                      <ShieldCheck className="size-5 text-primary shrink-0" />
                      Detail Log Audit #{selectedLog.id}
                    </DialogTitle>
                    <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                      Waktu Aktivitas: {formatJakartaTime(selectedLog.createdAt)}
                    </DialogDescription>
                  </div>

                  <Badge
                    variant="outline"
                    className={`${getActionColor(selectedLog.action)} font-mono font-bold text-xs`}
                  >
                    {selectedLog.action}
                  </Badge>
                </div>
              </DialogHeader>

              {/* Body Konten */}
              <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 space-y-5">
                {/* Info Metadata Grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-muted/30 p-3.5 sm:p-4 rounded-xl border text-xs">
                  <div className="space-y-1">
                    <span className="text-[11px] font-medium text-muted-foreground">Pengguna (Aktor)</span>
                    <p className="font-bold text-foreground">
                      {selectedLog.userFullName || selectedLog.username}
                    </p>
                    <p className="text-[10px] text-muted-foreground font-mono">
                      @{selectedLog.username}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <span className="text-[11px] font-medium text-muted-foreground">Peran (Role)</span>
                    <p className="font-bold font-mono uppercase text-foreground">
                      {selectedLog.userRole}
                    </p>
                    <p className="text-[10px] text-muted-foreground font-mono truncate" title={selectedLog.userId || "system"}>
                      ID: {selectedLog.userId ? `${selectedLog.userId.slice(0, 8)}...` : "system"}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <span className="text-[11px] font-medium text-muted-foreground">Entitas &amp; ID Record</span>
                    <p className="font-bold text-foreground capitalize">
                      {selectedLog.entity || "-"}
                    </p>
                    <p className="text-[10px] text-primary font-mono truncate" title={selectedLog.entityId || "-"}>
                      {selectedLog.entityId || "-"}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <span className="text-[11px] font-medium text-muted-foreground">IP Hash Keamanan</span>
                    <p className="font-mono text-muted-foreground text-[11px] truncate" title={selectedLog.ipHash || "-"}>
                      {selectedLog.ipHash || "-"}
                    </p>
                  </div>
                </div>

                {/* Perubahan Data (Before / After) jika tersedia */}
                {hasDiff && (
                  <div className="space-y-2">
                    <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
                      <Database className="size-3.5 text-primary" />
                      Komparasi Perubahan Data (Diff)
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                      {/* Before */}
                      <div className="border border-rose-200 bg-rose-50/20 rounded-xl p-3 space-y-1.5">
                        <span className="font-bold text-rose-800 text-[11px] uppercase tracking-wider">
                          Data Sebelum Perubahan (Before)
                        </span>
                        <pre className="p-2.5 bg-background rounded-lg border text-[11px] font-mono overflow-x-auto max-h-48 text-muted-foreground">
                          {JSON.stringify(detailsBefore, null, 2)}
                        </pre>
                      </div>

                      {/* After */}
                      <div className="border border-emerald-200 bg-emerald-50/20 rounded-xl p-3 space-y-1.5">
                        <span className="font-bold text-emerald-800 text-[11px] uppercase tracking-wider">
                          Data Sesudah Perubahan (After)
                        </span>
                        <pre className="p-2.5 bg-background rounded-lg border text-[11px] font-mono overflow-x-auto max-h-48 text-foreground font-semibold">
                          {JSON.stringify(detailsAfter, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}

                {/* Rincian Lengkap Payload Details (JSON Viewer) */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
                      <FileSearch className="size-3.5 text-primary" />
                      Payload Metadata Aktivitas (JSON)
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCopyJson}
                      className="h-7 px-2 text-[11px] rounded-lg gap-1"
                    >
                      {copied ? (
                        <>
                          <Check className="size-3 text-emerald-600" />
                          <span>Tersalin</span>
                        </>
                      ) : (
                        <>
                          <Copy className="size-3" />
                          <span>Salin JSON</span>
                        </>
                      )}
                    </Button>
                  </div>

                  <div className="border rounded-xl bg-muted/15 p-3 overflow-hidden">
                    <pre className="p-3 bg-card rounded-lg border font-mono text-xs overflow-x-auto max-h-72 leading-relaxed text-foreground">
                      {JSON.stringify(selectedLog.details, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
