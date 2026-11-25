"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Search, Sparkles, Utensils, Wallet, X } from "lucide-react";
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
  disabledByShift?: boolean;
};

export function ProductCatalog({
  products,
  categories,
  onSelectProduct,
  disabledByShift = false,
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
    <div className="flex flex-col space-y-4 w-full">
      {/* Search Bar & Category Filter Bar */}
      <div className="space-y-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Cari produk menu atau SKU..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 pr-10 h-10.5 text-sm bg-card rounded-xl border-border/80 shadow-2xs"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground rounded-md"
              aria-label="Bersihkan pencarian"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        {/* Category Pills */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
          <Button
            type="button"
            variant={selectedCategoryId === null ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedCategoryId(null)}
            className={`h-8.5 px-3.5 text-xs shrink-0 rounded-full font-semibold transition-all ${
              selectedCategoryId === null
                ? "bg-primary text-primary-foreground shadow-xs"
                : "bg-card border-border/80 hover:bg-muted/60"
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
                className={`h-8.5 px-3.5 text-xs shrink-0 rounded-full font-semibold transition-all ${
                  isSelected
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "bg-card border-border/80 hover:bg-muted/60"
                }`}
              >
                {cat.name} ({count})
              </Button>
            );
          })}
        </div>
      </div>

      {/* Product Grid */}
      <div className="w-full space-y-3">
        {disabledByShift && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-950 dark:text-amber-100">
            <div className="flex items-center gap-2">
              <Wallet className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="font-medium">
                Pemilihan menu dikunci sampai shift kasir dibuka. Silakan buka shift terlebih dahulu.
              </span>
            </div>
            <Button
              asChild
              size="sm"
              className="h-7 px-3 text-xs font-bold bg-amber-600 hover:bg-amber-700 text-white rounded-lg shrink-0"
            >
              <Link href="/pos/shift">Buka Shift</Link>
            </Button>
          </div>
        )}

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
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredProducts.map((product, idx) => {
              const isStockDepleted = product.isStockAvailable === false;
              const isAvailable = product.is_available && !isStockDepleted;
              const isClickable = isAvailable && !disabledByShift;
              const hasModifiers = product.modifierGroups.length > 0;

              return (
                <button
                  key={product.id}
                  type="button"
                  disabled={!isClickable}
                  onClick={() => onSelectProduct(product)}
                  title={
                    disabledByShift
                      ? "Buka shift kasir terlebih dahulu sebelum memilih produk"
                      : product.stockUnavailableReason ||
                        (!product.is_available
                          ? "Produk sedang tidak tersedia"
                          : undefined)
                  }
                  className={`group relative flex flex-col overflow-hidden rounded-2xl border border-border/75 text-left bg-card shadow-2xs transition-all ${
                    isClickable
                      ? "hover:border-primary/50 hover:shadow-md cursor-pointer active:scale-[0.985]"
                      : isAvailable && disabledByShift
                        ? "opacity-75 cursor-not-allowed"
                        : "cursor-not-allowed"
                  }`}
                >
                  {/* Photo Container */}
                  <div className="relative aspect-4/3 w-full overflow-hidden bg-muted shrink-0">
                    {product.photo_url ? (
                      <Image
                        src={product.photo_url}
                        alt={product.name}
                        fill
                        priority={idx === 0}
                        sizes="(max-width: 640px) 50vw, (max-width: 1280px) 33vw, 25vw"
                        className={`object-cover transition-all duration-300 ${
                          isAvailable
                            ? "group-hover:scale-105"
                            : "grayscale contrast-[0.95]"
                        }`}
                      />
                    ) : (
                      <div
                        className={`flex size-full items-center justify-center ${
                          isAvailable
                            ? "bg-brand-soft/50 text-primary/70"
                            : "bg-muted text-muted-foreground/60 grayscale"
                        }`}
                      >
                        <Utensils className="size-8" />
                      </div>
                    )}

                    {/* UX Kasir: Produk stok habis (isStockDepleted / missingIngredientName) tidak menampilkan badge "Habis" atau teks label apapun, melainkan foto produk grayscale 100%. */}

                    {/* Modifier Indicator Badge */}
                    {hasModifiers && isAvailable && (
                      <div className="absolute top-2.5 right-2.5">
                        <Badge
                          variant="secondary"
                          className="text-[10px] px-2 py-0.5 h-5 bg-background/95 backdrop-blur border text-foreground flex items-center gap-1 shadow-xs"
                        >
                          <Sparkles className="size-2.5 text-primary" />
                          Custom
                        </Badge>
                      </div>
                    )}
                  </div>

                  {/* Details */}
                  <div className="flex flex-col flex-1 w-full p-3.5 gap-1.5">
                    <h3 className="font-display font-bold text-sm leading-snug line-clamp-2 text-foreground group-hover:text-primary transition-colors">
                      {product.name}
                    </h3>

                    {product.description ? (
                      <p className="text-[11px] leading-relaxed text-muted-foreground line-clamp-1">
                        {product.description}
                      </p>
                    ) : (
                      <div className="h-4" aria-hidden="true" />
                    )}

                    <div className="mt-auto pt-2.5 border-t border-border/40 flex items-baseline justify-between gap-2">
                      <span className="font-bold text-sm text-primary tracking-tight">
                        {formatRupiah(product.price)}
                      </span>
                      {product.sku && (
                        <span className="text-[10px] text-muted-foreground font-mono shrink-0">
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

