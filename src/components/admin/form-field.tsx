"use client";

import { Label } from "@/components/ui/label";

export function FieldError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }

  return <p className="text-xs text-destructive">{message}</p>;
}

export function FormField({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? (
        <p className="text-[0.7rem] text-muted-foreground">{hint}</p>
      ) : null}
      <FieldError message={error} />
    </div>
  );
}

export function FormError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }

  return (
    <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {message}
    </p>
  );
}
