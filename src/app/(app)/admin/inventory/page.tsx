import { Database, ShieldAlert } from "lucide-react";
import { InventoryManagement } from "@/components/admin/inventory/inventory-management";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireRole } from "@/lib/auth/guards";
import { roundQuantity3 } from "@/lib/inventory/calculations";
import type { IngredientUnit } from "@/lib/inventory/constants";
import type {
  Ingredient,
  ProductWithRecipe,
  RecipeItem,
} from "@/lib/inventory/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type RawIngredientRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: IngredientUnit;
  current_stock: number | string;
  reserved_stock?: number | string | null;
  min_stock: number | string;
  is_active: boolean;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type RawRecipeRow = {
  id: string;
  product_id: string;
  ingredient_id: string;
  quantity_required: number | string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type RawProductRow = {
  id: string;
  category_id: string;
  name: string;
  sku: string | null;
  is_active: boolean;
  is_available: boolean;
};

type RawCategoryRow = {
  id: string;
  name: string;
};

function formatJakartaIsoDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Jakarta",
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year")?.value ?? "2026";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function isMigrationMissingError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  const code = (error.code ?? "").trim();
  const msg = error.message ?? "";
  return (
    code === "PGRST205" ||
    code === "42P01" ||
    code === "PGRST202" ||
    code === "42883" ||
    msg.includes("Could not find the table") ||
    msg.includes("does not exist")
  );
}

export default async function AdminInventoryPage() {
  await requireRole("admin");
  const supabase = await createSupabaseServerClient();

  const now = new Date();
  const todayJakarta = formatJakartaIsoDate(now);
  const sevenDaysAgo = new Date(now.getTime() - 6 * 86_400_000);
  const defaultStartDate = formatJakartaIsoDate(sevenDaysAgo);

  let ingredients: Ingredient[] = [];
  let productsWithRecipes: ProductWithRecipe[] = [];
  let todayMovementsCount = 0;
  let migrationRequired = false;
  let loadError: string | null = null;

  if (!supabase) {
    loadError = "Supabase belum dikonfigurasi.";
  } else {
    const startOfTodayIso = `${todayJakarta}T00:00:00+07:00`;
    const endOfTodayIso = `${todayJakarta}T23:59:59.999+07:00`;

    const [
      ingredientsRes,
      recipesRes,
      productsRes,
      categoriesRes,
      todayMovementsRes,
    ] = await Promise.all([
      supabase
        .from("ingredients")
        .select("*")
        .order("name", { ascending: true }),
      supabase
        .from("recipes")
        .select("*")
        .order("created_at", { ascending: true }),
      supabase
        .from("products")
        .select("id, category_id, name, sku, is_active, is_available")
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
      supabase.from("menu_categories").select("id, name"),
      supabase
        .from("stock_movements")
        .select("id", { count: "exact", head: true })
        .gte("created_at", startOfTodayIso)
        .lte("created_at", endOfTodayIso),
    ]);

    const inventoryError =
      ingredientsRes.error ?? recipesRes.error ?? todayMovementsRes.error;
    const menuError = productsRes.error ?? categoriesRes.error;

    if (isMigrationMissingError(inventoryError)) {
      migrationRequired = true;
    } else if (inventoryError) {
      loadError = `Gagal membaca data inventori: ${inventoryError.message}`;
    } else if (menuError) {
      loadError = `Gagal membaca daftar produk menu: ${menuError.message}`;
    } else {
      ingredients = ((ingredientsRes.data ?? []) as RawIngredientRow[]).map(
        (row) => {
          const currentStock = roundQuantity3(row.current_stock);
          const reservedStock = roundQuantity3(row.reserved_stock ?? 0);
          const availableStock = Math.max(
            0,
            roundQuantity3(currentStock - reservedStock),
          );
          return {
            id: row.id,
            name: row.name,
            sku: row.sku,
            unit: row.unit,
            current_stock: currentStock,
            reserved_stock: reservedStock,
            available_stock: availableStock,
            min_stock: roundQuantity3(row.min_stock),
            is_active: row.is_active,
            notes: row.notes,
            created_by: row.created_by,
            created_at: row.created_at,
            updated_at: row.updated_at,
          };
        },
      );

      const ingredientById = new Map(ingredients.map((i) => [i.id, i]));
      const categoryById = new Map(
        ((categoriesRes.data ?? []) as RawCategoryRow[]).map((c) => [
          c.id,
          c.name,
        ]),
      );

      const recipesByProduct = new Map<string, RecipeItem[]>();
      for (const raw of (recipesRes.data ?? []) as RawRecipeRow[]) {
        const ing = ingredientById.get(raw.ingredient_id);
        const enriched: RecipeItem = {
          id: raw.id,
          product_id: raw.product_id,
          ingredient_id: raw.ingredient_id,
          quantity_required: roundQuantity3(raw.quantity_required),
          notes: raw.notes,
          created_by: raw.created_by,
          created_at: raw.created_at,
          updated_at: raw.updated_at,
          ingredient_name: ing?.name,
          ingredient_sku: ing?.sku ?? null,
          ingredient_unit: ing?.unit,
          ingredient_current_stock: ing?.current_stock,
          ingredient_reserved_stock: ing?.reserved_stock,
          ingredient_available_stock: ing?.available_stock,
          ingredient_min_stock: ing?.min_stock,
          ingredient_is_active: ing?.is_active,
        };
        const list = recipesByProduct.get(raw.product_id) ?? [];
        list.push(enriched);
        recipesByProduct.set(raw.product_id, list);
      }

      productsWithRecipes = ((productsRes.data ?? []) as RawProductRow[]).map(
        (prod) => {
          const items = recipesByProduct.get(prod.id) ?? [];
          return {
            product_id: prod.id,
            product_name: prod.name,
            product_sku: prod.sku,
            category_id: prod.category_id,
            category_name: categoryById.get(prod.category_id) ?? null,
            is_active: prod.is_active,
            is_available: prod.is_available,
            recipe_items: items,
            has_inactive_ingredient: items.some(
              (item) => item.ingredient_is_active === false,
            ),
          };
        },
      );

      todayMovementsCount = todayMovementsRes.count ?? 0;
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Inventori · F4"
        title="Stok & Resep"
        description="Kelola master bahan baku, komposisi resep produk, penyesuaian stok manual beraudit, peringatan stok rendah, dan laporan pemakaian bahan baku."
        actions={
          <Badge variant="outline" className="h-7 px-3">
            {migrationRequired
              ? "Menunggu migrasi F4.1"
              : `${ingredients.length} bahan · ${productsWithRecipes.length} produk`}
          </Badge>
        }
      />

      {migrationRequired ? (
        <div className="space-y-4">
          <Alert>
            <Database />
            <AlertTitle>Migrasi Database F4.1 Belum Aktif (MIGRATION_REQUIRED)</AlertTitle>
            <AlertDescription>
              Tabel <code>ingredients</code>, <code>recipes</code>, dan{" "}
              <code>stock_movements</code> belum ditemukan di database Supabase.
              Halaman ini siap digunakan segera setelah migrasi F4.1 dijalankan
              secara manual melalui Supabase SQL Editor.
            </AlertDescription>
          </Alert>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldAlert className="size-4 text-primary" />
                Langkah Aktivasi Skema Inventori F4.1
              </CardTitle>
              <CardDescription>
                Tidak ada perubahan otomatis ke database production. Jalankan
                file migrasi berikut setelah backup dan tinjauan keamanan:
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-xs text-muted-foreground">
              <div className="rounded-xl border border-border bg-muted/30 px-3.5 py-2.5 font-mono text-foreground">
                supabase/migrations/20261119000100_f4_inventory_stock.sql
              </div>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Membuat tabel <code>public.ingredients</code>,{" "}
                  <code>public.recipes</code>, dan{" "}
                  <code>public.stock_movements</code> lengkap dengan RLS khusus
                  admin.
                </li>
                <li>
                  Mengaktifkan RPC atomik{" "}
                  <code>adjust_ingredient_stock_atomic</code> dan guard anti
                  mutasi langsung pada <code>current_stock</code>.
                </li>
                <li>
                  Mengaktifkan trigger non-invasif pengurangan stok saat pesanan
                  lunas (<code>payment_status = &apos;paid&apos;</code>) tanpa
                  mengganggu pembayaran Tunai, Split Bill, maupun Midtrans.
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>
      ) : loadError ? (
        <Alert variant="destructive">
          <Database />
          <AlertTitle>Data inventori tidak tersedia</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : (
        <InventoryManagement
          ingredients={ingredients}
          products={productsWithRecipes}
          todayMovementsCount={todayMovementsCount}
          defaultReportStartDate={defaultStartDate}
          defaultReportEndDate={todayJakarta}
        />
      )}
    </div>
  );
}
