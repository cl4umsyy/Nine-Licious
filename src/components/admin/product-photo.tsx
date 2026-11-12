import Image from "next/image";
import { UtensilsCrossed } from "lucide-react";
import { cn } from "@/lib/utils";

type ProductPhotoProps = {
  src: string | null;
  alt: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
};

export function ProductPhoto({
  src,
  alt,
  className,
  sizes = "96px",
  priority = false,
}: ProductPhotoProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border border-border bg-muted",
        className,
      )}
    >
      {src ? (
        <Image
          src={src}
          alt={alt}
          fill
          sizes={sizes}
          priority={priority}
          className="object-cover"
        />
      ) : (
        <div
          role="img"
          className="flex size-full items-center justify-center bg-[radial-gradient(circle_at_30%_20%,rgba(14,79,69,0.12),transparent_60%)] text-muted-foreground"
          aria-label={`${alt} belum memiliki foto`}
        >
          <UtensilsCrossed className="size-6" />
        </div>
      )}
    </div>
  );
}
