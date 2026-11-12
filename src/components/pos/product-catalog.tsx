"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { Search, Sparkles, Utensils, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatRupiah } from "@/lib/menu/format";
import type { ProductWithModifiers } from "@/lib/orders/types";
import type { MenuCategory } from "@/types/database";

export type ProductCatalogProps = {
  products: ProductWithModifiers[];
  categories: MenuCategory[];
  onSelectProduct: (product: ProductWithModifiers) => void;
};

export function ProductCatalog({
  products,
  categories,
  onSelectProduct,
}: ProductCatalogProps) {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState("");

  const activeCategories = useMemo(
    () => categories.filter((c) => c.is_active),
    [categories],
  );

  const filteredProducts = useMemo(() => {
    let result = products.filter((p) => p.is_active);

    if (selectedCategoryId) {
      result = result.filter((p) => p.category_id === selectedCategoryId);
    }

    const query = searchQuery.trim().toLowerCase();
    if (query) {
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          (p.sku && p.sku.toLowerCase().includes(query)) ||
          (p.description && p.description.toLowerCase().includes(query)),
      );
    }

    return result;
  }, [products, selectedCategoryId, searchQuery]);

  return (
    <div className="flex flex-col h-full space-y-4">
      {/* Search Bar & Category Filter Bar */}
      <div className="space-y-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Cari produk menu atau SKU..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-9 h-10 text-sm bg-card"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
              aria-label="Bersihkan pencarian"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        {/* Category Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
          <Button
            type="button"
            variant={selectedCategoryId === null ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedCategoryId(null)}
            className={`h-8 text-xs shrink-0 rounded-full font-medium ${
              selectedCategoryId === null
                ? "bg-primary text-primary-foreground shadow-sm"
                : "bg-card hover:bg-muted/60"
            }`}
          >
            Semua ({products.filter((p) => p.is_active).length})
          </Button>

          {activeCategories.map((cat) => {
            const isSelected = selectedCategoryId === cat.id;
            const count = products.filter(
              (p) => p.category_id === cat.id && p.is_active,
            ).length;

            return (
              <Button
                key={cat.id}
                type="button"
                variant={isSelected ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedCategoryId(cat.id)}
                className={`h-8 text-xs shrink-0 rounded-full font-medium ${
                  isSelected
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-card hover:bg-muted/60"
                }`}
              >
                {cat.name} ({count})
              </Button>
            );
          })}
        </div>
      </div>

      {/* Product Grid */}
      <div className="flex-1 overflow-y-auto pr-1">
        {filteredProducts.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 text-center rounded-2xl border border-dashed bg-card/40 text-muted-foreground space-y-2 mt-4">
            <Utensils className="size-8 text-muted-foreground/60" />
            <p className="font-semibold text-sm">Tidak ada menu yang sesuai</p>
            <p className="text-xs max-w-xs">
              {searchQuery
                ? `Tidak ditemukan menu dengan kata kunci "${searchQuery}". Coba kata kunci lain.`
                : "Belum ada produk aktif dalam kategori ini."}
            </p>
            {searchQuery && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSearchQuery("")}
                className="mt-2 text-xs"
              >
                Reset Pencarian
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {filteredProducts.map((product) => {
              const isAvailable = product.is_available;
              const hasModifiers = product.modifierGroups.length > 0;

              return (
                <button
                  key={product.id}
                  type="button"
                  disabled={!isAvailable}
                  onClick={() => onSelectProduct(product)}
                  className={`group relative flex flex-col overflow-hidden rounded-2xl border text-left bg-card transition-all ${
                    isAvailable
                      ? "hover:border-primary/50 hover:shadow-md cursor-pointer active:scale-[0.98]"
                      : "opacity-60 cursor-not-allowed bg-muted/40"
                  }`}
                >
                  {/* Photo Container */}
                  <div className="relative aspect-4/3 w-full overflow-hidden bg-muted">
                    {product.photo_url ? (
                      <Image
                        src={product.photo_url}
                        alt={product.name}
                        fill
                        sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                        className="object-cover transition-transform duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center bg-brand-soft/50 text-primary/70">
                        <Utensils className="size-8" />
                      </div>
                    )}

                    {/* Availability Overlay */}
                    {!isAvailable && (
                      <div className="absolute inset-0 bg-background/80 backdrop-blur-[2px] flex items-center justify-center p-2 text-center">
                        <Badge
                          variant="destructive"
                          className="text-[10px] uppercase font-bold"
                        >
                          Habis
                        </Badge>
                      </div>
                    )}

                    {/* Modifier Indicator Badge */}
                    {hasModifiers && isAvailable && (
                      <div className="absolute top-2 right-2">
                        <Badge
                          variant="secondary"
                          className="text-[9px] px-1.5 py-0 h-4 bg-background/90 backdrop-blur border text-foreground flex items-center gap-1 shadow-sm"
                        >
                          <Sparkles className="size-2 text-primary" />
                          Custom
                        </Badge>
                      </div>
                    )}
                  </div>

                  {/* Details */}
                  <div className="flex flex-col flex-1 p-3 space-y-1">
                    <h3 className="font-display font-bold text-sm leading-snug line-clamp-2 text-foreground group-hover:text-primary transition-colors">
                      {product.name}
                    </h3>

                    {product.description && (
                      <p className="text-[11px] text-muted-foreground line-clamp-1">
                        {product.description}
                      </p>
                    )}

                    <div className="mt-auto pt-1 flex items-center justify-between">
                      <span className="font-bold text-sm text-primary">
                        {formatRupiah(product.price)}
                      </span>
                      {product.sku && (
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {product.sku}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

