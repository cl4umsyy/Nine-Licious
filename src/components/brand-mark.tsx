import Link from "next/link";
import { cn } from "@/lib/utils";

type BrandMarkProps = {
  href?: string;
  compact?: boolean;
  tone?: "default" | "inverse";
  className?: string;
};

export function BrandMark({
  href = "/",
  compact = false,
  tone = "default",
  className,
}: BrandMarkProps) {
  const inverse = tone === "inverse";

  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
      aria-label="Saji POS"
    >
      <span
        className={cn(
          "relative grid size-10 shrink-0 place-items-center rounded-xl shadow-[0_1px_2px_rgba(14,79,69,0.2)] transition-colors",
          inverse
            ? "bg-primary-foreground text-primary"
            : "bg-primary text-primary-foreground group-hover:bg-brand-ink",
        )}
      >
        <span className="font-display text-[1.35rem] font-semibold leading-none">
          S
        </span>
        <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-brand-accent" />
      </span>
      {!compact ? (
        <span className="flex flex-col leading-none">
          <span
            className={cn(
              "font-display text-[1.35rem] font-semibold tracking-[-0.02em]",
              inverse ? "text-primary-foreground" : "text-foreground",
            )}
          >
            Saji
          </span>
          <span
            className={cn(
              "mt-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.18em]",
              inverse
                ? "text-primary-foreground/60"
                : "text-muted-foreground",
            )}
          >
            POS Restoran
          </span>
        </span>
      ) : null}
    </Link>
  );
}
