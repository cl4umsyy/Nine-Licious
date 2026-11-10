import { APP_ENVIRONMENT_LABELS } from "@/lib/constants";
import type { AppEnvironment } from "@/lib/env";
import { cn } from "@/lib/utils";

type EnvironmentBadgeProps = {
  environment: AppEnvironment;
  className?: string;
};

export function EnvironmentBadge({
  environment,
  className,
}: EnvironmentBadgeProps) {
  const isProduction = environment === "production";

  return (
    <div
      className={cn(
        "hidden items-center gap-2 rounded-full border px-2.5 py-1 sm:flex",
        isProduction
          ? "border-success/25 bg-success/5"
          : "border-border bg-card",
        className,
      )}
      title="Lingkungan aplikasi"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          isProduction ? "bg-success" : "bg-brand-accent",
        )}
        aria-hidden="true"
      />
      <span className="text-[0.7rem] font-medium text-muted-foreground">
        {APP_ENVIRONMENT_LABELS[environment]}
      </span>
    </div>
  );
}
