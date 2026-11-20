"use client";

import { useState, useTransition } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  Clock,
  CreditCard,
  Info,
  Loader2,
  Package,
  Percent,
  Receipt,
  RefreshCw,
  ShoppingBag,
  TrendingDown,
  TrendingUp,
  UtensilsCrossed,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { getComprehensiveReportAction } from "@/lib/reports/actions";
import {
  getJakartaDateDaysAgo,
  getJakartaDateToday,
  getJakartaFirstDayOfMonth,
} from "@/lib/reports/calculations";
import type { ComprehensiveReportData } from "@/lib/reports/types";

type DatePreset = "today" | "7d" | "30d" | "this_month" | "custom";
type ReportTab = "sales" | "payments" | "products";

type ReportsDashboardProps = {
  initialData: ComprehensiveReportData;
  defaultStartDate: string;
  defaultEndDate: string;
};

function formatRupiah(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDateIndo(dateStr: string): string {
  try {
    const [year, month, day] = dateStr.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return new Intl.DateTimeFormat("id-ID", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(date);
  } catch {
    return dateStr;
  }
}

export function ReportsDashboard({
  initialData,
  defaultStartDate,
  defaultEndDate,
}: ReportsDashboardProps) {
  const [data, setData] = useState<ComprehensiveReportData>(initialData);
  const [selectedPreset, setSelectedPreset] = useState<DatePreset>("today");
  const [startDate, setStartDate] = useState<string>(defaultStartDate);
  const [endDate, setEndDate] = useState<string>(defaultEndDate);
  const [activeTab, setActiveTab] = useState<ReportTab>("sales");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [isPending, startTransition] = useTransition();

  const handleApplyFilter = (
    preset: DatePreset,
    start: string,
    end: string,
  ) => {
    setErrorMessage(null);
    startTransition(async () => {
      const res = await getComprehensiveReportAction({
        startDate: start,
        endDate: end,
      });

      if (!res.ok || !res.data) {
        setErrorMessage(res.message || "Gagal memuat data laporan.");
        toast.error(res.message || "Gagal memuat data laporan.");
        return;
      }

      setData(res.data);
      setSelectedPreset(preset);
      setStartDate(start);
      setEndDate(end);
      toast.success("Laporan berhasil diperbarui.");
    });
  };

  const handlePresetClick = (preset: DatePreset) => {
    const today = getJakartaDateToday();
    let newStart = today;
    const newEnd = today;

    if (preset === "today") {
      newStart = today;
    } else if (preset === "7d") {
      newStart = getJakartaDateDaysAgo(6);
    } else if (preset === "30d") {
      newStart = getJakartaDateDaysAgo(29);
    } else if (preset === "this_month") {
      newStart = getJakartaFirstDayOfMonth();
    } else if (preset === "custom") {
      setSelectedPreset("custom");
      return;
    }

    handleApplyFilter(preset, newStart, newEnd);
  };

  const sales = data.sales;
  const payments = data.payments;
  const products = data.products;

  const maxDailyRevenue = Math.max(
    ...sales.dailyBreakdown.map((d) => d.grossSales),
    1,
  );

  return (
    <div className="space-y-6">
      {/* FILTER BAR & PERIODE */}
      <Card className="border-border/60 bg-card">
        <CardContent className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mr-1 flex items-center gap-1.5">
              <Calendar className="size-3.5" />
              Filter Periode:
            </span>
            <Button
              type="button"
              size="sm"
              variant={selectedPreset === "today" ? "default" : "outline"}
              onClick={() => handlePresetClick("today")}
              disabled={isPending}
            >
              Hari Ini
            </Button>
            <Button
              type="button"
              size="sm"
              variant={selectedPreset === "7d" ? "default" : "outline"}
              onClick={() => handlePresetClick("7d")}
              disabled={isPending}
            >
              7 Hari Terakhir
            </Button>
            <Button
              type="button"
              size="sm"
              variant={selectedPreset === "30d" ? "default" : "outline"}
              onClick={() => handlePresetClick("30d")}
              disabled={isPending}
            >
              30 Hari Terakhir
            </Button>
            <Button
              type="button"
              size="sm"
              variant={selectedPreset === "this_month" ? "default" : "outline"}
              onClick={() => handlePresetClick("this_month")}
              disabled={isPending}
            >
              Bulan Ini
            </Button>
            <Button
              type="button"
              size="sm"
              variant={selectedPreset === "custom" ? "default" : "outline"}
              onClick={() => setSelectedPreset("custom")}
              disabled={isPending}
            >
              Kustom
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handleApplyFilter(selectedPreset, startDate, endDate)}
              disabled={isPending}
              className="gap-1.5"
            >
              <RefreshCw className={`size-3.5 ${isPending ? "animate-spin" : ""}`} />
              Segarkan
            </Button>
          </div>
        </CardContent>

        {selectedPreset === "custom" && (
          <div className="border-t border-border/60 bg-muted/20 px-5 py-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="custom-start" className="text-xs">
                  Tanggal Mulai
                </Label>
                <Input
                  id="custom-start"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="h-9 w-40 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="custom-end" className="text-xs">
                  Tanggal Akhir
                </Label>
                <Input
                  id="custom-end"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="h-9 w-40 text-xs"
                />
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => handleApplyFilter("custom", startDate, endDate)}
                disabled={isPending || !startDate || !endDate}
                className="h-9 text-xs"
              >
                {isPending ? (
                  <>
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    Memuat...
                  </>
                ) : (
                  "Terapkan Rentang"
                )}
              </Button>
            </div>
          </div>
        )}

        <div className="border-t border-border/40 px-5 py-2.5 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Clock className="size-3 text-primary" />
            <span>
              Periode Aktif:{" "}
              <strong className="text-foreground">
                {formatDateIndo(startDate)}
              </strong>{" "}
              s/d{" "}
              <strong className="text-foreground">
                {formatDateIndo(endDate)}
              </strong>{" "}
              (Zona Waktu Asia/Jakarta · WIB)
            </span>
          </div>
          {isPending && (
            <Badge variant="secondary" className="gap-1 text-[11px] animate-pulse">
              <Loader2 className="size-3 animate-spin" />
              Menghitung ulang data...
            </Badge>
          )}
        </div>
      </Card>

      {/* ERROR STATE */}
      {errorMessage && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Terjadi Kesalahan</AlertTitle>
          <AlertDescription className="flex items-center justify-between">
            <span>{errorMessage}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleApplyFilter(selectedPreset, startDate, endDate)}
              className="h-7 text-xs"
            >
              Coba Lagi
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* 7 KPI PENJUALAN */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <Card className="border-border/60 bg-card">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium">Gross Sales</CardDescription>
            <CardTitle className="text-lg font-bold font-mono tracking-tight text-foreground">
              {formatRupiah(sales.grossSales)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground flex items-center gap-1">
            <TrendingUp className="size-3 text-emerald-600" />
            Omzet kotor lunas
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium">Total Diskon</CardDescription>
            <CardTitle className="text-lg font-bold font-mono tracking-tight text-rose-600">
              -{formatRupiah(sales.totalDiscount)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground flex items-center gap-1">
            <Percent className="size-3 text-rose-500" />
            Promo &amp; diskon manual
          </CardContent>
        </Card>

        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-semibold text-primary">
              Net Sales
            </CardDescription>
            <CardTitle className="text-lg font-bold font-mono tracking-tight text-primary">
              {formatRupiah(sales.netSales)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground flex items-center gap-1">
            <CheckCircle2 className="size-3 text-primary" />
            Gross dikurangi refund
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium">Total Pajak</CardDescription>
            <CardTitle className="text-lg font-bold font-mono tracking-tight text-foreground">
              {formatRupiah(sales.totalTax)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground flex items-center gap-1">
            <Receipt className="size-3 text-muted-foreground" />
            Pajak restoran 10%
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium">Service Charge</CardDescription>
            <CardTitle className="text-lg font-bold font-mono tracking-tight text-foreground">
              {formatRupiah(sales.totalServiceCharge)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground flex items-center gap-1">
            <Receipt className="size-3 text-muted-foreground" />
            Biaya layanan 5%
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium">Average Order (AOV)</CardDescription>
            <CardTitle className="text-lg font-bold font-mono tracking-tight text-foreground">
              {formatRupiah(sales.averageOrderValue)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground flex items-center gap-1">
            <ArrowUpRight className="size-3 text-blue-600" />
            Rata-rata per pesanan
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium">Pesanan Lunas</CardDescription>
            <CardTitle className="text-lg font-bold font-mono tracking-tight text-foreground">
              {sales.paidOrdersCount}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground flex items-center gap-1">
            <ShoppingBag className="size-3 text-primary" />
            {sales.totalRefund > 0 ? `Refund: ${formatRupiah(sales.totalRefund)}` : "Tanpa refund"}
          </CardContent>
        </Card>
      </div>

      {/* TAB NAVIGATION */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <Button
          type="button"
          size="sm"
          variant={activeTab === "sales" ? "default" : "outline"}
          onClick={() => setActiveTab("sales")}
          className="gap-2"
        >
          <TrendingUp className="size-4" />
          1. Penjualan
          <Badge
            variant={activeTab === "sales" ? "secondary" : "outline"}
            className="ml-1 text-[10px]"
          >
            {sales.paidOrdersCount}
          </Badge>
        </Button>

        <Button
          type="button"
          size="sm"
          variant={activeTab === "payments" ? "default" : "outline"}
          onClick={() => setActiveTab("payments")}
          className="gap-2"
        >
          <CreditCard className="size-4" />
          2. Pembayaran
          <Badge
            variant={activeTab === "payments" ? "secondary" : "outline"}
            className="ml-1 text-[10px]"
          >
            {payments.totalTransactions}
          </Badge>
        </Button>

        <Button
          type="button"
          size="sm"
          variant={activeTab === "products" ? "default" : "outline"}
          onClick={() => setActiveTab("products")}
          className="gap-2"
        >
          <UtensilsCrossed className="size-4" />
          3. Produk &amp; Kategori
          <Badge
            variant={activeTab === "products" ? "secondary" : "outline"}
            className="ml-1 text-[10px]"
          >
            {products.totalItemsSold}
          </Badge>
        </Button>
      </div>

      {/* TAB 1: PENJUALAN */}
      {activeTab === "sales" && (
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base font-semibold">
                  Grafik Tren Penjualan Harian
                </CardTitle>
                <CardDescription>
                  Distribusi omzet kotor (Gross) dan omzet bersih (Net) per tanggal operasional.
                </CardDescription>
              </div>
              <Badge variant="outline" className="font-mono text-xs">
                {sales.dailyBreakdown.length} Hari Aktif
              </Badge>
            </CardHeader>
            <CardContent>
              {sales.dailyBreakdown.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <Info className="size-10 text-muted-foreground/40 mb-3" />
                  <p className="text-sm font-medium text-foreground">
                    Belum Ada Data Penjualan
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                    Tidak ditemukan transaksi pesanan lunas pada rentang tanggal yang dipilih.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {sales.dailyBreakdown.map((item) => {
                    const grossWidth = Math.max(
                      4,
                      Math.round((item.grossSales / maxDailyRevenue) * 100),
                    );
                    const netWidth = Math.max(
                      2,
                      Math.round((item.netSales / maxDailyRevenue) * 100),
                    );

                    return (
                      <div key={item.date} className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-foreground">
                            {formatDateIndo(item.date)}
                          </span>
                          <div className="flex items-center gap-3 font-mono">
                            <span className="text-muted-foreground">
                              {item.paidOrdersCount} pesanan
                            </span>
                            <span className="font-semibold text-primary">
                              {formatRupiah(item.netSales)}
                            </span>
                          </div>
                        </div>
                        <div className="h-3 w-full rounded-full bg-muted/60 overflow-hidden relative">
                          <div
                            className="h-full bg-primary/40 rounded-full absolute top-0 left-0"
                            style={{ width: `${grossWidth}%` }}
                            title={`Gross: ${formatRupiah(item.grossSales)}`}
                          />
                          <div
                            className="h-full bg-primary rounded-full absolute top-0 left-0"
                            style={{ width: `${netWidth}%` }}
                            title={`Net: ${formatRupiah(item.netSales)}`}
                          />
                        </div>
                        {item.totalRefund > 0 && (
                          <p className="text-[10px] text-rose-600 flex items-center gap-1">
                            <TrendingDown className="size-3" />
                            Refund: -{formatRupiah(item.totalRefund)}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold">
                Rincian Harian Penjualan
              </CardTitle>
              <CardDescription>
                Tabel rincian omzet, subtotal, diskon, pajak, dan refund harian.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30">
                    <TableHead>Tanggal</TableHead>
                    <TableHead className="text-right">Pesanan</TableHead>
                    <TableHead className="text-right">Subtotal</TableHead>
                    <TableHead className="text-right">Diskon</TableHead>
                    <TableHead className="text-right">Pajak</TableHead>
                    <TableHead className="text-right">Service</TableHead>
                    <TableHead className="text-right">Gross Sales</TableHead>
                    <TableHead className="text-right">Refund</TableHead>
                    <TableHead className="text-right font-semibold text-primary">
                      Net Sales
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sales.dailyBreakdown.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={9}
                        className="text-center py-8 text-xs text-muted-foreground"
                      >
                        Tidak ada transaksi pada periode ini.
                      </TableCell>
                    </TableRow>
                  ) : (
                    sales.dailyBreakdown.map((row) => (
                      <TableRow key={row.date}>
                        <TableCell className="font-medium text-xs">
                          {formatDateIndo(row.date)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {row.paidOrdersCount}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatRupiah(row.subtotal)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-rose-600">
                          {row.totalDiscount > 0 ? `-${formatRupiah(row.totalDiscount)}` : "Rp 0"}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatRupiah(row.totalTax)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatRupiah(row.totalServiceCharge)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-medium">
                          {formatRupiah(row.grossSales)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-rose-600">
                          {row.totalRefund > 0 ? `-${formatRupiah(row.totalRefund)}` : "Rp 0"}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold text-primary">
                          {formatRupiah(row.netSales)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      {/* TAB 2: METODE PEMBAYARAN */}
      {activeTab === "payments" && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="border-border/60">
              <CardHeader className="p-4 pb-2">
                <CardDescription className="text-xs">Total Penerimaan Tunai</CardDescription>
                <CardTitle className="text-xl font-bold font-mono text-emerald-700">
                  {formatRupiah(payments.totalCash)}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0 text-xs text-muted-foreground flex items-center gap-1.5">
                <Wallet className="size-3.5 text-emerald-600" />
                {payments.cashTransactionCount} transaksi tunai fisik
              </CardContent>
            </Card>

            <Card className="border-border/60">
              <CardHeader className="p-4 pb-2">
                <CardDescription className="text-xs">Total Pembayaran Midtrans</CardDescription>
                <CardTitle className="text-xl font-bold font-mono text-blue-700">
                  {formatRupiah(payments.totalMidtrans)}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0 text-xs text-muted-foreground flex items-center gap-1.5">
                <CreditCard className="size-3.5 text-blue-600" />
                {payments.midtransTransactionCount} transaksi gateway online
              </CardContent>
            </Card>

            <Card className="border-border/60">
              <CardHeader className="p-4 pb-2">
                <CardDescription className="text-xs">Pesanan Split Bill</CardDescription>
                <CardTitle className="text-xl font-bold font-mono text-purple-700">
                  {payments.splitBillOrdersCount}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0 text-xs text-muted-foreground flex items-center gap-1.5">
                <Receipt className="size-3.5 text-purple-600" />
                {formatRupiah(payments.totalSplitBillReceipts)} akumulasi tagihan
              </CardContent>
            </Card>

            <Card className="border-border/60">
              <CardHeader className="p-4 pb-2">
                <CardDescription className="text-xs">Total Baris Pembayaran</CardDescription>
                <CardTitle className="text-xl font-bold font-mono text-foreground">
                  {payments.totalTransactions}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0 text-xs text-muted-foreground flex items-center gap-1.5">
                <CheckCircle2 className="size-3.5 text-primary" />
                Total: {formatRupiah(payments.totalPayments)}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold">
                Rincian Transaksi per Saluran Pembayaran
              </CardTitle>
              <CardDescription>
                Klasifikasi sumber pembayaran operasional: Tunai, Midtrans Snap, QRIS, dan Transfer.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30">
                    <TableHead>Metode</TableHead>
                    <TableHead>Saluran Sumber</TableHead>
                    <TableHead className="text-right">Jumlah Transaksi</TableHead>
                    <TableHead className="text-right">Total Penerimaan</TableHead>
                    <TableHead className="text-right">Porsi (%)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.methodsBreakdown.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center py-8 text-xs text-muted-foreground"
                      >
                        Tidak ada transaksi pembayaran pada periode ini.
                      </TableCell>
                    </TableRow>
                  ) : (
                    payments.methodsBreakdown.map((row) => {
                      const sharePct =
                        payments.totalPayments > 0
                          ? ((row.totalAmount / payments.totalPayments) * 100).toFixed(1)
                          : "0.0";

                      return (
                        <TableRow key={`${row.method}-${row.source}`}>
                          <TableCell className="font-semibold text-xs text-foreground">
                            {row.label}
                          </TableCell>
                          <TableCell className="text-xs font-mono text-muted-foreground">
                            {row.source}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {row.transactionCount}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs font-semibold">
                            {formatRupiah(row.totalAmount)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            <Badge variant="secondary" className="text-[11px]">
                              {sharePct}%
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      {/* TAB 3: PRODUK & KATEGORI */}
      {activeTab === "products" && (
        <div className="space-y-6">
          {/* KATEGORI PERFORMANCE */}
          <div>
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Package className="size-4 text-primary" />
              Kontribusi Penjualan per Kategori Menu
            </h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {products.categoryBreakdown.map((cat) => (
                <Card key={cat.categoryName} className="border-border/60">
                  <CardHeader className="p-4 pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm font-bold text-foreground">
                        {cat.categoryName}
                      </CardTitle>
                      <Badge variant="outline" className="font-mono text-xs">
                        {cat.revenuePercentage}%
                      </Badge>
                    </div>
                    <CardDescription className="text-xs">
                      {cat.quantitySold} porsi terjual
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="p-4 pt-1">
                    <div className="font-mono text-base font-bold text-primary mb-2">
                      {formatRupiah(cat.totalRevenue)}
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full"
                        style={{ width: `${Math.min(100, Math.max(0, cat.revenuePercentage))}%` }}
                      />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          {/* TOP SELLING PRODUCTS */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base font-semibold">
                  Peringkat Produk Terlaris (Top Selling)
                </CardTitle>
                <CardDescription>
                  Diurutkan berdasarkan volume porsi terjual dan total omzet (menggunakan snapshot nama historis).
                </CardDescription>
              </div>
              <Badge variant="secondary" className="font-mono text-xs">
                {products.topProducts.length} Menu Terjual
              </Badge>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30">
                    <TableHead className="w-12 text-center">#</TableHead>
                    <TableHead>Nama Menu (Snapshot Transaksi)</TableHead>
                    <TableHead>Kategori</TableHead>
                    <TableHead className="text-right">Kuantitas</TableHead>
                    <TableHead className="text-right">Total Omzet</TableHead>
                    <TableHead className="text-right">Kontribusi Omzet</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {products.topProducts.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-center py-8 text-xs text-muted-foreground"
                      >
                        Tidak ada produk yang terjual pada periode ini.
                      </TableCell>
                    </TableRow>
                  ) : (
                    products.topProducts.map((prod, idx) => {
                      const sharePct =
                        products.totalProductsRevenue > 0
                          ? ((prod.totalRevenue / products.totalProductsRevenue) * 100).toFixed(1)
                          : "0.0";

                      return (
                        <TableRow key={prod.productId}>
                          <TableCell className="text-center font-mono text-xs text-muted-foreground">
                            {idx + 1}
                          </TableCell>
                          <TableCell className="font-medium text-xs">
                            <span className="text-foreground">{prod.productName}</span>
                            {prod.sku && (
                              <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                                ({prod.sku})
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            <Badge variant="outline" className="text-[10px]">
                              {prod.categoryName}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs font-semibold text-foreground">
                            {prod.quantitySold} porsi
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs font-semibold text-primary">
                            {formatRupiah(prod.totalRevenue)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            <Badge variant="secondary" className="text-[11px]">
                              {sharePct}%
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
