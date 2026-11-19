"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  AlertTriangle,
  CalendarRange,
  FileBarChart2,
  Loader2,
  RefreshCw,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getIngredientUsageReportAction } from "@/lib/inventory/actions";
import { formatStockQuantity } from "@/lib/inventory/calculations";
import {
  STOCK_MOVEMENT_LABELS,
  STOCK_MOVEMENT_TYPES,
  STOCK_STATUS_LABELS,
  type StockMovementType,
} from "@/lib/inventory/constants";
import type {
  Ingredient,
  IngredientUsageReportData,
} from "@/lib/inventory/types";
import { cn } from "@/lib/utils";

type UsageReportPanelProps = {
  ingredients: Ingredient[];
  defaultStartDate: string;
  defaultEndDate: string;
};

function formatJakartaTimestamp(iso: string): string {
  try {
    return new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function UsageReportPanel({
  ingredients,
  defaultStartDate,
  defaultEndDate,
}: UsageReportPanelProps) {
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(defaultEndDate);
  const [ingredientId, setIngredientId] = useState<string>("all");
  const [movementType, setMovementType] = useState<string>("all");
  const [report, setReport] = useState<IngredientUsageReportData | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isFiltering, startFiltering] = useTransition();
  const isLoading = isInitialLoading || isFiltering;

  const loadReport = useCallback(
    (params: {
      start: string;
      end: string;
      ingId: string;
      movType: string;
      showToastOnError?: boolean;
    }) => {
      setErrorMessage(null);

      startFiltering(async () => {
        const result = await getIngredientUsageReportAction({
          startDate: params.start,
          endDate: params.end,
          ingredientId: params.ingId === "all" ? null : params.ingId,
          movementType:
            params.movType === "all"
              ? null
              : (params.movType as StockMovementType),
        });

        if (!result.ok || !result.data) {
          setErrorMessage(result.message);
          if (params.showToastOnError) {
            toast.error(result.message);
          }
          return;
        }

        setReport(result.data);
      });
    },
    [],
  );

  useEffect(() => {
    let active = true;

    getIngredientUsageReportAction({
      startDate: defaultStartDate,
      endDate: defaultEndDate,
      ingredientId: null,
      movementType: null,
    })
      .then((result) => {
        if (!active) return;
        setIsInitialLoading(false);
        if (!result.ok || !result.data) {
          setErrorMessage(result.message);
          return;
        }
        setErrorMessage(null);
        setReport(result.data);
      })
      .catch(() => {
        if (!active) return;
        setIsInitialLoading(false);
        setErrorMessage("Gagal memuat laporan pemakaian bahan baku.");
      });

    return () => {
      active = false;
    };
  }, [defaultEndDate, defaultStartDate]);

  function handleApplyFilter(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    loadReport({
      start: startDate,
      end: endDate,
      ingId: ingredientId,
      movType: movementType,
      showToastOnError: true,
    });
  }

  return (
    <div className="space-y-4">
      {/* Filter Laporan */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarRange className="size-4 text-primary" />
            Filter Laporan Pemakaian Bahan Baku
          </CardTitle>
          <CardDescription>
            Rentang tanggal menggunakan zona waktu operasional Asia/Jakarta
            (WIB). Data berasal dari buku besar mutasi stok.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleApplyFilter}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end"
          >
            <div className="space-y-1.5">
              <Label htmlFor="report-start" className="text-xs">
                Tanggal Mulai
              </Label>
              <Input
                id="report-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                disabled={isLoading}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="report-end" className="text-xs">
                Tanggal Akhir
              </Label>
              <Input
                id="report-end"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={isLoading}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="report-ingredient" className="text-xs">
                Bahan Baku
              </Label>
              <Select
                value={ingredientId}
                onValueChange={setIngredientId}
                disabled={isLoading}
              >
                <SelectTrigger id="report-ingredient">
                  <SelectValue placeholder="Semua bahan" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Bahan Baku</SelectItem>
                  {ingredients.map((ing) => (
                    <SelectItem key={ing.id} value={ing.id}>
                      {ing.name} ({ing.unit})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="report-type" className="text-xs">
                Jenis Mutasi
              </Label>
              <Select
                value={movementType}
                onValueChange={setMovementType}
                disabled={isLoading}
              >
                <SelectTrigger id="report-type">
                  <SelectValue placeholder="Semua mutasi" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Jenis Mutasi</SelectItem>
                  {STOCK_MOVEMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {STOCK_MOVEMENT_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button type="submit" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="animate-spin" />
                  Memuat...
                </>
              ) : (
                <>
                  <RefreshCw />
                  Terapkan
                </>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {errorMessage ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Gagal memuat laporan pemakaian</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {isLoading && !report ? (
        <Card>
          <CardContent className="space-y-3 py-6">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-32 w-full" />
          </CardContent>
        </Card>
      ) : null}

      {/* Ringkasan Pemakaian per Bahan */}
      {report ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Ringkasan Pemakaian per Bahan Baku</CardTitle>
              <CardDescription>
                Periode {report.startDate} s.d. {report.endDate} (WIB) ·{" "}
                {report.totals.totalMovements} mutasi tercatat.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {report.rows.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-10 text-center">
                  <FileBarChart2 className="size-8 text-muted-foreground/60" />
                  <p className="mt-2 text-sm font-medium text-foreground">
                    Belum ada mutasi stok pada periode ini
                  </p>
                  <p className="mt-1 max-w-md text-xs text-muted-foreground">
                    Pemakaian akan muncul otomatis saat pesanan lunas terjual
                    atau ketika admin melakukan penyesuaian stok manual.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Bahan Baku</TableHead>
                        <TableHead className="text-right">
                          Pemakaian Penjualan
                        </TableHead>
                        <TableHead className="text-right">
                          Stok Masuk Manual
                        </TableHead>
                        <TableHead className="text-right">
                          Stok Keluar Manual
                        </TableHead>
                        <TableHead className="text-right">
                          Selisih Opname
                        </TableHead>
                        <TableHead className="text-right">
                          Perubahan Bersih
                        </TableHead>
                        <TableHead className="text-right">
                          Stok Saat Ini
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.rows.map((row) => (
                        <TableRow key={row.ingredient_id}>
                          <TableCell>
                            <div className="space-y-0.5">
                              <p className="font-medium text-foreground">
                                {row.ingredient_name}
                              </p>
                              <p className="text-[11px] text-muted-foreground">
                                {row.sale_order_count} pesanan ·{" "}
                                {row.movement_count} mutasi
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs font-semibold text-foreground">
                            {formatStockQuantity(
                              row.sale_deducted_total,
                              row.unit,
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-emerald-700">
                            +
                            {formatStockQuantity(row.manual_in_total, row.unit)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-destructive">
                            -
                            {formatStockQuantity(
                              row.manual_out_total,
                              row.unit,
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground">
                            {row.opname_net_delta > 0 ? "+" : ""}
                            {formatStockQuantity(
                              row.opname_net_delta,
                              row.unit,
                            )}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right font-mono text-xs font-semibold",
                              row.net_change > 0
                                ? "text-emerald-700"
                                : row.net_change < 0
                                  ? "text-destructive"
                                  : "text-muted-foreground",
                            )}
                          >
                            {row.net_change > 0 ? "+" : ""}
                            {formatStockQuantity(row.net_change, row.unit)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="inline-flex flex-col items-end gap-0.5">
                              <span
                                className={cn(
                                  "font-mono text-xs font-semibold",
                                  row.current_stock <= 0 && "text-destructive",
                                )}
                              >
                                {formatStockQuantity(
                                  row.current_stock,
                                  row.unit,
                                )}
                              </span>
                              <Badge
                                variant={
                                  row.stock_status === "out_of_stock"
                                    ? "destructive"
                                    : row.stock_status === "low_stock"
                                      ? "outline"
                                      : "secondary"
                                }
                                className="text-[10px]"
                              >
                                {row.current_stock < 0
                                  ? "Kritis (Negatif)"
                                  : STOCK_STATUS_LABELS[row.stock_status]}
                              </Badge>
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

          {/* Riwayat Mutasi Stok */}
          <Card>
            <CardHeader>
              <CardTitle>Riwayat Mutasi Stok</CardTitle>
              <CardDescription>
                Buku besar kronologis (append-only) seluruh pengurangan
                penjualan dan penyesuaian stok manual.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {report.movements.length === 0 ? (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  Tidak ada riwayat mutasi stok untuk filter yang dipilih.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Waktu (WIB)</TableHead>
                        <TableHead>Bahan Baku</TableHead>
                        <TableHead>Jenis Mutasi</TableHead>
                        <TableHead className="text-right">Perubahan</TableHead>
                        <TableHead className="text-right">
                          Saldo Sebelum → Sesudah
                        </TableHead>
                        <TableHead>Referensi &amp; Alasan</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.movements.map((mov) => (
                        <TableRow key={mov.id}>
                          <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                            {formatJakartaTimestamp(mov.created_at)}
                          </TableCell>
                          <TableCell className="font-medium text-xs text-foreground">
                            {mov.ingredient_name ?? mov.ingredient_id}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                mov.movement_type === "manual_in"
                                  ? "secondary"
                                  : mov.movement_type === "sale_deduction"
                                    ? "outline"
                                    : "default"
                              }
                              className="text-[10px]"
                            >
                              {STOCK_MOVEMENT_LABELS[mov.movement_type]}
                            </Badge>
                          </TableCell>
                          <TableCell
                            className={cn(
                              "whitespace-nowrap text-right font-mono text-xs font-bold",
                              mov.quantity_delta > 0
                                ? "text-emerald-700"
                                : "text-destructive",
                            )}
                          >
                            {mov.quantity_delta > 0 ? "+" : ""}
                            {formatStockQuantity(
                              mov.quantity_delta,
                              mov.ingredient_unit,
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-right font-mono text-xs text-muted-foreground">
                            {formatStockQuantity(
                              mov.stock_before,
                              mov.ingredient_unit,
                            )}{" "}
                            →{" "}
                            <span
                              className={cn(
                                "font-semibold",
                                mov.stock_after < 0
                                  ? "text-destructive"
                                  : "text-foreground",
                              )}
                            >
                              {formatStockQuantity(
                                mov.stock_after,
                                mov.ingredient_unit,
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-xs">
                            <p className="text-xs text-foreground">
                              {mov.reason}
                            </p>
                            <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                              {mov.order_number ? (
                                <span className="font-mono">
                                  Order #{mov.order_number}
                                </span>
                              ) : null}
                              {mov.actor_username ? (
                                <span>oleh {mov.actor_username}</span>
                              ) : null}
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
        </>
      ) : null}
    </div>
  );
}
