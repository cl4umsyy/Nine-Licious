"use client";

import { useMemo, useState } from "react";
import {
  FolderTree,
  Info,
  SlidersHorizontal,
  UtensilsCrossed,
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
import { CategoryManager } from "@/components/admin/category-manager";
import { ModifierManager } from "@/components/admin/modifier-manager";
import { ProductManager } from "@/components/admin/product-manager";
import type {
  CategoryWithCount,
  ModifierGroupWithOptions,
  ProductWithModifiers,
} from "@/lib/menu/types";

type MenuManagementProps = {
  categories: CategoryWithCount[];
  products: ProductWithModifiers[];
  modifierGroups: ModifierGroupWithOptions[];
};

type MenuTab = "categories" | "products" | "modifiers";

const TABS: Array<{
  id: MenuTab;
  label: string;
  icon: typeof FolderTree;
}> = [
  { id: "categories", label: "Kategori", icon: FolderTree },
  { id: "products", label: "Produk", icon: UtensilsCrossed },
  { id: "modifiers", label: "Modifier", icon: SlidersHorizontal },
];

export function MenuManagement({
  categories,
  products,
  modifierGroups,
}: MenuManagementProps) {
  const [activeTab, setActiveTab] = useState<MenuTab>("products");

  const stats = useMemo(() => {
    const activeCategories = categories.filter(
      (category) => category.is_active,
    ).length;
    const availableProducts = products.filter(
      (product) => product.is_active && product.is_available,
    ).length;
    const unavailableProducts = products.filter(
      (product) => !product.is_active || !product.is_available,
    ).length;
    const optionCount = modifierGroups.reduce(
      (total, group) => total + group.options.length,
      0,
    );

    return {
      activeCategories,
      availableProducts,
      unavailableProducts,
      optionCount,
    };
  }, [categories, modifierGroups, products]);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <CardDescription>Kategori aktif</CardDescription>
            <CardTitle className="font-display text-2xl">
              {stats.activeCategories}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                / {categories.length}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Food, Drinks, Desserts, Packages tersedia sebagai master data.
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Produk siap jual</CardDescription>
            <CardTitle className="font-display text-2xl">
              {stats.availableProducts}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                / {products.length}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Aktif dan tersedia. Produk lain tidak dapat dipesan di POS.
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Perlu perhatian</CardDescription>
            <CardTitle className="font-display text-2xl">
              {stats.unavailableProducts}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Produk nonaktif atau sedang tidak tersedia.
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Grup modifier</CardDescription>
            <CardTitle className="font-display text-2xl">
              {modifierGroups.length}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {stats.optionCount} opsi aktif maupun nonaktif.
          </CardContent>
        </Card>
      </div>

      <Alert>
        <Info />
        <AlertTitle>Snapshot harga dan modifier</AlertTitle>
        <AlertDescription>
          Perubahan harga di master data hanya berlaku untuk pesanan baru.
          Pesanan yang sudah dibuat menyimpan snapshot nama dan harga, sehingga
          riwayat transaksi tidak berubah.
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          const count =
            tab.id === "categories"
              ? categories.length
              : tab.id === "products"
                ? products.length
                : modifierGroups.length;

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
                {count}
              </Badge>
            </Button>
          );
        })}
      </div>

      {activeTab === "categories" ? (
        <CategoryManager categories={categories} />
      ) : null}
      {activeTab === "products" ? (
        <ProductManager
          products={products}
          categories={categories}
          modifierGroups={modifierGroups}
        />
      ) : null}
      {activeTab === "modifiers" ? (
        <ModifierManager groups={modifierGroups} />
      ) : null}
    </div>
  );
}
