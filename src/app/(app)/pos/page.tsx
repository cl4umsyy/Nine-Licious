import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  ClipboardList,
  Database,
  MapPin,
  Wallet,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { PendingServingPanel } from "@/components/pos/pending-serving-panel";
import { PosContainer } from "@/components/pos/pos-container";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireRole } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { checkAllProductsStockAvailability } from "@/lib/orders/inventory-validation";
import type { PendingServingBoardData } from "@/lib/orders/serving";
import { getPendingServingOrdersAction } from "@/lib/orders/serving-actions";
import type {
  ProductModifierGroupWithDetails,
  ProductWithModifiers,
} from "@/lib/orders/types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  DiningTable,
  Discount,
  MenuCategory,
  ModifierGroup,
  ModifierOption,
  Product,
  ProductModifierGroup,
  Shift,
  TableZone,
} from "@/types/database";

export default async function PosPage() {
  const session = await requireRole(["admin", "kasir"]);
  const supabase = await createSupabaseServerClient();

  let categories: MenuCategory[] = [];
  let productsWithModifiers: ProductWithModifiers[] = [];
  let tables: DiningTable[] = [];
  let zones: TableZone[] = [];
  let discounts: Discount[] = [];
  let activeShift: Shift | null = null;
  let taxPercent = 10;
  let serviceChargePercent = 5;
  let loadError: string | null = null;
  let pendingServingData: PendingServingBoardData = {
    orders: [],
    syncedAt: new Date().toISOString(),
    schemaReady: true,
    migrationNotice: null,
  };

  if (!supabase) {
    loadError = "Supabase belum dikonfigurasi.";
  } else {
    try {
      const [
        categoriesRes,
        productsRes,
        pmgRes,
        groupsRes,
        optionsRes,
        tablesRes,
        zonesRes,
        settingsRes,
        discountsRes,
        pendingServingRes,
        shiftRes,
      ] = await Promise.all([
        supabase
          .from("menu_categories")
          .select("*")
          .eq("is_active", true)
          .order("sort_order", { ascending: true })
          .order("name", { ascending: true }),
        supabase
          .from("products")
          .select("*")
          .eq("is_active", true)
          .order("sort_order", { ascending: true })
          .order("name", { ascending: true }),
        supabase
          .from("product_modifier_groups")
          .select("*")
          .order("sort_order", { ascending: true }),
        supabase
          .from("modifier_groups")
          .select("*")
          .eq("is_active", true)
          .order("sort_order", { ascending: true }),
        supabase
          .from("modifier_options")
          .select("*")
          .eq("is_active", true)
          .order("sort_order", { ascending: true }),
        supabase
          .from("dining_tables")
          .select("*")
          .eq("is_active", true)
          .order("name", { ascending: true }),
        supabase
          .from("table_zones")
          .select("*")
          .eq("is_active", true)
          .order("sort_order", { ascending: true }),
        supabase
          .from("restaurant_settings")
          .select("tax_percent, service_charge_percent")
          .eq("id", 1)
          .maybeSingle<{
            tax_percent: number;
            service_charge_percent: number;
          }>(),
        supabase
          .from("discounts")
          .select("*")
          .eq("is_active", true)
          .order("name", { ascending: true }),
        getPendingServingOrdersAction(),
        supabase
          .from("shifts")
          .select("*")
          .eq("cashier_id", session.profile.id)
          .eq("status", "open")
          .maybeSingle(),
      ]);

      if (shiftRes?.data) {
        activeShift = shiftRes.data as unknown as Shift;
      }

      if (pendingServingRes.ok && pendingServingRes.data) {
        pendingServingData = pendingServingRes.data;
      }

      if (categoriesRes.error || productsRes.error) {
        loadError =
          "Data menu belum dapat dimuat. Pastikan migration F1.1 sudah dijalankan.";
      } else {
        categories = (categoriesRes.data ?? []) as MenuCategory[];
        const rawProducts = (productsRes.data ?? []) as Product[];
        const pmgList = (pmgRes.data ?? []) as ProductModifierGroup[];
        const groupsList = (groupsRes.data ?? []) as ModifierGroup[];
        const optionsList = (optionsRes.data ?? []) as ModifierOption[];
        tables = (tablesRes.data ?? []) as DiningTable[];
        zones = (zonesRes.data ?? []) as TableZone[];
        discounts = (discountsRes.data ?? []) as Discount[];

        if (settingsRes.data) {
          taxPercent = Number(settingsRes.data.tax_percent) || 0;
          serviceChargePercent =
            Number(settingsRes.data.service_charge_percent) || 0;
        }

        // Susun grup & opsi modifier
        const optionsByGroup = new Map<string, ModifierOption[]>();
        for (const opt of optionsList) {
          const arr = optionsByGroup.get(opt.group_id) ?? [];
          arr.push(opt);
          optionsByGroup.set(opt.group_id, arr);
        }

        const groupsById = new Map<string, ModifierGroup>();
        for (const g of groupsList) {
          groupsById.set(g.id, g);
        }

        const groupsByProduct = new Map<string, string[]>();
        for (const pmg of pmgList) {
          const arr = groupsByProduct.get(pmg.product_id) ?? [];
          arr.push(pmg.modifier_group_id);
          groupsByProduct.set(pmg.product_id, arr);
        }

        const categoryMap = new Map<string, string>();
        for (const c of categories) {
          categoryMap.set(c.id, c.name);
        }

        const stockAvailabilityMap = await checkAllProductsStockAvailability(
          createSupabaseAdminClient() ?? supabase,
          rawProducts.map((p) => p.id),
        );

        productsWithModifiers = rawProducts.map((p) => {
          const applicableGroupIds = groupsByProduct.get(p.id) ?? [];
          const detailedGroups: ProductModifierGroupWithDetails[] = [];

          for (const gId of applicableGroupIds) {
            const g = groupsById.get(gId);
            if (g && g.is_active) {
              detailedGroups.push({
                ...g,
                options: optionsByGroup.get(g.id) ?? [],
              });
            }
          }

          const stockInfo = stockAvailabilityMap.get(p.id);

          return {
            ...p,
            categoryName: categoryMap.get(p.category_id),
            modifierGroups: detailedGroups,
            isStockAvailable: stockInfo?.isAvailable ?? true,
            stockUnavailableReason: stockInfo?.unavailableReason,
            missingIngredientName: stockInfo?.missingIngredientName,
          };
        });
      }
    } catch (err: unknown) {
      loadError =
        err instanceof Error
          ? err.message
          : "Terjadi kesalahan saat memuat master data POS.";
    }
  }

  return (
    <div className="flex flex-col space-y-3.5 pb-8">
      <PageHeader
        title="POS Utama"
        className="shrink-0 py-0"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-8.5 px-3 text-xs font-semibold rounded-xl"
            >
              <Link href="/pos/orders">
                <ClipboardList className="size-3.5 mr-1.5 text-primary" />
                Daftar Pesanan
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-8.5 px-3 text-xs font-semibold rounded-xl"
            >
              <Link href="/pos/floor">
                <MapPin className="size-3.5 mr-1.5 text-primary" />
                Denah Meja
                <ArrowRight className="size-3.5 ml-1.5" />
              </Link>
            </Button>
            <Button
              asChild
              variant={activeShift ? "outline" : "default"}
              size="sm"
              className={`h-8.5 px-3 text-xs font-semibold rounded-xl ${
                !activeShift ? "bg-amber-600 hover:bg-amber-700 text-white font-bold" : ""
              }`}
            >
              <Link href="/pos/shift">
                <Wallet className="size-3.5 mr-1.5" />
                {activeShift ? "Shift Aktif" : "Buka Shift"}
              </Link>
            </Button>
            <Badge
              variant="outline"
              className="h-8.5 px-3 text-xs font-semibold rounded-xl"
            >
              {ROLE_LABELS[session.profile.role]}
            </Badge>
          </div>
        }
      />

      {!loadError ? (
        <PendingServingPanel initialData={pendingServingData} />
      ) : null}

      {!loadError && !activeShift ? (
        <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100 py-2.5 px-3.5">
          <Wallet className="size-4 text-amber-600 dark:text-amber-400 mt-0.5" />
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 w-full">
            <div>
              <AlertTitle className="text-xs font-bold">Shift Kasir Belum Dibuka</AlertTitle>
              <AlertDescription className="text-[11px] text-amber-900/90 dark:text-amber-200/90">
                Anda belum membuka shift kasir. Pembayaran tunai mewajibkan shift aktif dengan modal kas awal.
              </AlertDescription>
            </div>
            <Button asChild size="sm" className="h-7.5 px-3 text-xs font-bold shrink-0 bg-amber-600 hover:bg-amber-700 text-white rounded-lg">
              <Link href="/pos/shift">Buka Shift Sekarang</Link>
            </Button>
          </div>
        </Alert>
      ) : null}

      {loadError ? (
        <Alert variant="destructive">
          <Database className="size-4" />
          <AlertTitle>Master Data POS Belum Siap</AlertTitle>
          <AlertDescription className="text-xs">
            {loadError}
          </AlertDescription>
        </Alert>
      ) : productsWithModifiers.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-10 text-center space-y-3 bg-card/60">
          <AlertCircle className="size-10 text-muted-foreground/50 mx-auto" />
          <div className="space-y-1">
            <h3 className="font-bold text-base">Belum Ada Produk Menu Aktif</h3>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              Admin belum menambahkan atau mengaktifkan produk menu di master data.
            </p>
          </div>
          {session.profile.role === "admin" && (
            <Button asChild size="sm" className="text-xs">
              <Link href="/admin/menu">Kelola Menu & Produk</Link>
            </Button>
          )}
        </div>
      ) : (
        <PosContainer
          products={productsWithModifiers}
          categories={categories}
          tables={tables}
          zones={zones}
          taxPercent={taxPercent}
          serviceChargePercent={serviceChargePercent}
          discounts={discounts}
          userRole={session.profile.role}
          activeShift={activeShift}
        />
      )}
    </div>
  );
}
