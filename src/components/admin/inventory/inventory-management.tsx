"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowUpDown,
  BookOpen,
  Boxes,
  FileBarChart2,
  Flame,
  Info,
} from "lucide-react";
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
import {
  buildLowStockAlerts,
  formatStockQuantity,
  getStockStatus,
} from "@/lib/inventory/calculations";
import type { Ingredient, ProductWithRecipe } from "@/lib/inventory/types";
import { cn } from "@/lib/utils";
import { IngredientManager } from "./ingredient-manager";
import { RecipeManager } from "./recipe-manager";
import { StockAdjustmentDialog } from "./stock-adjustment-dialog";
import { UsageReportPanel } from "./usage-report-panel";

type InventoryTab = "ingredients" | "recipes" | "usage";

type InventoryManagementProps = {
  ingredients: Ingredient[];
  products: ProductWithRecipe[];
  todayMovementsCount: number;
  defaultReportStartDate: string;
  defaultReportEndDate: string;
};

const TABS: Array<{
  id: InventoryTab;
  label: string;
  icon: typeof Boxes;
}> = [
  { id: "ingredients", label: "Bahan Baku", icon: Boxes },
  { id: "recipes", label: "Resep Produk", icon: BookOpen },
  { id: "usage", label: "Laporan Pemakaian", icon: FileBarChart2 },
];

export function InventoryManagement({
  ingredients,
  products,
  todayMovementsCount,
  defaultReportStartDate,
  defaultReportEndDate,
}: InventoryManagementProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<InventoryTab>("ingredients");
  const [adjustingIngredient, setAdjustingIngredient] =
    useState<Ingredient | null>(null);

  const stats = useMemo(() => {
    let activeCount = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;
    let negativeStockCount = 0;

    for (const ing of ingredients) {
      if (!ing.is_active) continue;
      activeCount += 1;
      const available =
        ing.available_stock ??
        Math.max(0, ing.current_stock - (ing.reserved_stock ?? 0));
      const st = getStockStatus(available, ing.min_stock);
      if (st === "low_stock") lowStockCount += 1;
      if (st === "out_of_stock") outOfStockCount += 1;
      if (ing.current_stock < 0) negativeStockCount += 1;
    }

    const withRecipeCount = products.filter(
      (p) => p.recipe_items.length > 0,
    ).length;

    return {
      activeCount,
      lowStockCount,
      outOfStockCount,
      negativeStockCount,
      withRecipeCount,
    };
  }, [ingredients, products]);

  const lowStockAlerts = useMemo(
    () => buildLowStockAlerts(ingredients),
    [ingredients],
  );

  const linkedProductsByIngredientId = useMemo(() => {
    const map = new Map<
      string,
      Array<{ id: string; name: string; sku: string | null }>
    >();
    for (const prod of products) {
      for (const item of prod.recipe_items) {
        const list = map.get(item.ingredient_id) ?? [];
        list.push({
          id: prod.product_id,
          name: prod.product_name,
          sku: prod.product_sku,
        });
        map.set(item.ingredient_id, list);
      }
    }
    return map;
  }, [products]);

  const criticalAlerts = useMemo(
    () => lowStockAlerts.filter((a) => a.status === "out_of_stock"),
    [lowStockAlerts],
  );
  const warningAlerts = useMemo(
    () => lowStockAlerts.filter((a) => a.status === "low_stock"),
    [lowStockAlerts],
  );

  const ingredientById = useMemo(
    () => new Map(ingredients.map((i) => [i.id, i])),
    [ingredients],
  );

  function handleDataChanged() {
    router.refresh();
  }

  return (
    <div className="space-y-5">
      {/* 4 Kartu Ringkasan KPI */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <CardDescription>Total Bahan Baku Aktif</CardDescription>
            <CardTitle className="font-display text-2xl">
              {stats.activeCount}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                / {ingredients.length}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Bahan aktif siap ditautkan ke resep dan dipantau stoknya.
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Bahan Stok Rendah</CardDescription>
            <CardTitle
              className={cn(
                "font-display text-2xl",
                stats.lowStockCount > 0 && "text-amber-700",
              )}
            >
              {stats.lowStockCount}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Saldo masih di atas 0 tetapi kurang dari atau sama dengan batas
            minimum.
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Bahan Habis / Kritis</CardDescription>
            <CardTitle
              className={cn(
                "font-display text-2xl",
                stats.outOfStockCount > 0 && "text-destructive",
              )}
            >
              {stats.outOfStockCount}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {stats.negativeStockCount > 0
              ? `${stats.negativeStockCount} bahan bersaldo negatif akibat penjualan lunas.`
              : "Saldo 0 atau negatif yang membutuhkan restock segera."}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Total Mutasi Hari Ini</CardDescription>
            <CardTitle className="font-display text-2xl">
              {todayMovementsCount}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Pengurangan penjualan otomatis &amp; penyesuaian manual (WIB).
          </CardContent>
        </Card>
      </div>

      {/* Panel Peringatan Stok Rendah & Kritis */}
      {lowStockAlerts.length > 0 ? (
        <Card
          className={cn(
            criticalAlerts.length > 0
              ? "border-destructive/40 bg-destructive/5"
              : "border-amber-500/40 bg-amber-500/5",
          )}
        >
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-sm sm:text-base">
                {criticalAlerts.length > 0 ? (
                  <Flame className="size-4 text-destructive" />
                ) : (
                  <AlertTriangle className="size-4 text-amber-600" />
                )}
                Peringatan Stok Rendah &amp; Kondisi Kritis
              </CardTitle>
              <CardDescription>
                {criticalAlerts.length} bahan habis/negatif ·{" "}
                {warningAlerts.length} bahan stok rendah (`current_stock ≤
                min_stock`).
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {criticalAlerts.length > 0 ? (
                <Badge variant="destructive">
                  {criticalAlerts.length} Kritis / Habis
                </Badge>
              ) : null}
              {warningAlerts.length > 0 ? (
                <Badge
                  variant="outline"
                  className="border-amber-500/50 bg-card text-amber-800"
                >
                  {warningAlerts.length} Stok Rendah
                </Badge>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {lowStockAlerts.slice(0, 6).map((alert) => {
                const fullIngredient = ingredientById.get(alert.ingredient_id);
                return (
                  <div
                    key={alert.ingredient_id}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-xl border bg-card px-3 py-2.5",
                      alert.is_negative
                        ? "border-destructive/50"
                        : alert.status === "out_of_stock"
                          ? "border-destructive/30"
                          : "border-amber-500/35",
                    )}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-xs font-semibold text-foreground">
                          {alert.ingredient_name}
                        </p>
                        <Badge
                          variant={
                            alert.status === "out_of_stock"
                              ? "destructive"
                              : "outline"
                          }
                          className="text-[10px]"
                        >
                          {alert.is_negative
                            ? "Kritis (Negatif)"
                            : alert.status === "out_of_stock"
                              ? "Habis"
                              : "Rendah"}
                        </Badge>
                      </div>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        Sisa:{" "}
                        <span
                          className={cn(
                            "font-bold",
                            alert.status === "out_of_stock"
                              ? "text-destructive"
                              : "text-amber-800",
                          )}
                        >
                          {formatStockQuantity(alert.current_stock, alert.unit)}
                        </span>{" "}
                        · Min: {formatStockQuantity(alert.min_stock, alert.unit)}
                      </p>
                    </div>
                    {fullIngredient ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => setAdjustingIngredient(fullIngredient)}
                      >
                        <ArrowUpDown />
                        Restock
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {lowStockAlerts.length > 6 ? (
              <p className="mt-2.5 text-xs text-muted-foreground">
                Menampilkan 6 bahan paling kritis dari total{" "}
                {lowStockAlerts.length} peringatan. Gunakan filter pada tabel
                Bahan Baku untuk melihat semuanya.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Alert>
          <Info />
          <AlertTitle>Aturan operasional stok F4</AlertTitle>
          <AlertDescription>
            Stok berkurang otomatis saat pesanan benar-benar lunas (Tunai, Split
            Bill, maupun Midtrans). Refund penuh tidak otomatis mengembalikan
            stok; bila bahan masih layak digunakan, catat melalui Penyesuaian
            Stok Masuk dengan alasan wajib.
          </AlertDescription>
        </Alert>
      )}

      {/* Navigasi Tab */}
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          const badgeValue =
            tab.id === "ingredients"
              ? ingredients.length
              : tab.id === "recipes"
                ? `${stats.withRecipeCount}/${products.length}`
                : todayMovementsCount;

          return (
            <Button
              key={tab.id}
              type="button"
              variant={isActive ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveTab(tab.id)}
              aria-pressed={isActive}
            >
              <Icon />
              {tab.label}
              <Badge
                variant={isActive ? "secondary" : "outline"}
                className="ml-1 h-4 px-1.5 text-[0.6rem]"
              >
                {badgeValue}
              </Badge>
            </Button>
          );
        })}
      </div>

      {/* Konten Tab Aktif */}
      {activeTab === "ingredients" ? (
        <IngredientManager
          ingredients={ingredients}
          linkedProductsByIngredientId={linkedProductsByIngredientId}
          onOpenAdjustStock={(ing) => setAdjustingIngredient(ing)}
          onDataChanged={handleDataChanged}
        />
      ) : null}

      {activeTab === "recipes" ? (
        <RecipeManager
          products={products}
          ingredients={ingredients}
          onDataChanged={handleDataChanged}
        />
      ) : null}

      {activeTab === "usage" ? (
        <UsageReportPanel
          ingredients={ingredients}
          defaultStartDate={defaultReportStartDate}
          defaultEndDate={defaultReportEndDate}
        />
      ) : null}

      {/* Dialog Penyesuaian Stok (Global untuk tab & panel peringatan) */}
      <StockAdjustmentDialog
        ingredient={adjustingIngredient}
        open={Boolean(adjustingIngredient)}
        onOpenChange={(open) => {
          if (!open) setAdjustingIngredient(null);
        }}
        onAdjusted={handleDataChanged}
      />
    </div>
  );
}
