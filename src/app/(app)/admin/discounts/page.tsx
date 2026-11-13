import { Database, Percent } from "lucide-react";
import { DiscountManagement } from "@/components/admin/discount-management";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { requireRole } from "@/lib/auth/guards";
import { getDiscountsAction } from "@/lib/discounts/actions";
import type { DiscountWithTargets } from "@/lib/discounts/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { MenuCategory, Product } from "@/types/database";

export default async function AdminDiscountsPage() {
  await requireRole("admin");
  const supabase = await createSupabaseServerClient();

  let discounts: DiscountWithTargets[] = [];
  let categories: MenuCategory[] = [];
  let products: Product[] = [];
  let loadError: string | null = null;

  if (!supabase) {
    loadError = "Supabase belum dikonfigurasi.";
  } else {
    try {
      const [discountsRes, categoriesRes, productsRes] = await Promise.all([
        getDiscountsAction(),
        supabase
          .from("menu_categories")
          .select("*")
          .order("sort_order", { ascending: true })
          .order("name", { ascending: true }),
        supabase
          .from("products")
          .select("*")
          .order("sort_order", { ascending: true })
          .order("name", { ascending: true }),
      ]);

      if (!discountsRes.ok) {
        loadError = discountsRes.message;
      } else {
        discounts = discountsRes.data ?? [];
      }

      categories = (categoriesRes.data ?? []) as MenuCategory[];
      products = (productsRes.data ?? []) as Product[];
    } catch (err: unknown) {
      loadError =
        err instanceof Error
          ? err.message
          : "Gagal memuat data master promo & diskon.";
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Master Data & Promosi"
        title="Diskon & Promo"
        description="Kelola kebijakan promo pesanan, diskon produk, minimal belanja, dan batas potongan harga untuk transaksi kasir."
        actions={
          <Badge
            variant="outline"
            className="h-8 px-3 text-xs flex items-center gap-1.5"
          >
            <Percent className="size-3.5 text-primary" />
            Khusus Admin
          </Badge>
        }
      />

      {loadError ? (
        <Alert variant="destructive">
          <Database className="size-4" />
          <AlertTitle>Gagal Memuat Data Diskon</AlertTitle>
          <AlertDescription className="text-xs">{loadError}</AlertDescription>
        </Alert>
      ) : (
        <DiscountManagement
          initialDiscounts={discounts}
          categories={categories}
          products={products}
        />
      )}
    </div>
  );
}

