import { Database } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { MenuManagement } from "@/components/admin/menu-management";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { requireRole } from "@/lib/auth/guards";
import type {
  CategoryWithCount,
  ModifierGroupWithOptions,
  ProductWithModifiers,
} from "@/lib/menu/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  MenuCategory,
  ModifierGroup,
  ModifierOption,
  Product,
  ProductModifierGroup,
} from "@/types/database";

export default async function AdminMenuPage() {
  await requireRole("admin");
  const supabase = await createSupabaseServerClient();

  let categories: CategoryWithCount[] = [];
  let products: ProductWithModifiers[] = [];
  let modifierGroups: ModifierGroupWithOptions[] = [];
  let loadError: string | null = null;

  if (!supabase) {
    loadError = "Supabase belum dikonfigurasi.";
  } else {
    const [
      categoriesResult,
      productsResult,
      groupsResult,
      optionsResult,
      relationsResult,
    ] = await Promise.all([
      supabase
        .from("menu_categories")
        .select(
          "id, name, slug, color, sort_order, is_active, created_at, updated_at",
        )
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
      supabase
        .from("products")
        .select(
          "id, category_id, name, sku, price, photo_url, photo_path, description, is_active, is_available, kitchen_station, sort_order, created_at, updated_at",
        )
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
      supabase
        .from("modifier_groups")
        .select(
          "id, name, selection_type, is_required, min_select, max_select, sort_order, is_active, created_at, updated_at",
        )
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
      supabase
        .from("modifier_options")
        .select(
          "id, group_id, name, price_delta, sort_order, is_active, created_at, updated_at",
        )
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
      supabase
        .from("product_modifier_groups")
        .select("product_id, modifier_group_id, sort_order"),
    ]);

    const firstError =
      categoriesResult.error ??
      productsResult.error ??
      groupsResult.error ??
      optionsResult.error ??
      relationsResult.error;

    if (firstError) {
      loadError =
        "Data menu belum dapat dibaca. Pastikan migration F1.1 sudah dijalankan.";
    } else {
      const categoryRows = (categoriesResult.data ?? []) as MenuCategory[];
      const productRows = (productsResult.data ?? []) as Product[];
      const groupRows = (groupsResult.data ?? []) as ModifierGroup[];
      const optionRows = (optionsResult.data ?? []) as ModifierOption[];
      const relationRows = (relationsResult.data ??
        []) as ProductModifierGroup[];

      const productCountByCategory = new Map<string, number>();
      for (const product of productRows) {
        productCountByCategory.set(
          product.category_id,
          (productCountByCategory.get(product.category_id) ?? 0) + 1,
        );
      }

      const optionsByGroup = new Map<string, ModifierOption[]>();
      for (const option of optionRows) {
        const current = optionsByGroup.get(option.group_id) ?? [];
        current.push(option);
        optionsByGroup.set(option.group_id, current);
      }

      const groupIdsByProduct = new Map<string, string[]>();
      for (const relation of relationRows) {
        const current = groupIdsByProduct.get(relation.product_id) ?? [];
        current.push(relation.modifier_group_id);
        groupIdsByProduct.set(relation.product_id, current);
      }

      categories = categoryRows.map((category) => ({
        ...category,
        product_count: productCountByCategory.get(category.id) ?? 0,
      }));
      products = productRows.map((product) => ({
        ...product,
        modifier_group_ids: groupIdsByProduct.get(product.id) ?? [],
      }));
      modifierGroups = groupRows.map((group) => ({
        ...group,
        options: optionsByGroup.get(group.id) ?? [],
      }));
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Master data"
        title="Menu & harga"
        description="Kelola kategori, produk, foto, harga, ketersediaan, stasiun dapur, dan modifier. Semua perubahan divalidasi di server dan dicatat di audit log."
        actions={
          <Badge variant="outline" className="h-7 px-3">
            {products.length} produk · {modifierGroups.length} grup modifier
          </Badge>
        }
      />

      {loadError ? (
        <Alert variant="destructive">
          <Database />
          <AlertTitle>Data menu tidak tersedia</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : (
        <MenuManagement
          categories={categories}
          products={products}
          modifierGroups={modifierGroups}
        />
      )}
    </div>
  );
}
