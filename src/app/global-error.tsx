"use client";

import "@/app/globals.css";
import { CircleExclamationPoint, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="id">
      <body className="bg-background">
        <div className="flex min-h-dvh items-center justify-center px-4 py-10">
          <Card className="w-full max-w-md">
            <CardHeader className="items-center text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                <CircleExclamationPoint className="size-5" />
              </div>
              <CardTitle className="mt-2 font-display text-2xl">
                Terjadi kendala
              </CardTitle>
              <CardDescription>
                Nine Licious tidak dapat memuat halaman ini. Coba lagi; bila masalah
                berlanjut, hubungi admin restoran.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error.digest ? (
                <p className="rounded-lg bg-muted/60 px-3 py-2 text-center font-mono text-[0.7rem] text-muted-foreground">
                  Kode: {error.digest}
                </p>
              ) : null}
              <Button onClick={reset} className="w-full">
                <RefreshCw />
                Coba lagi
              </Button>
            </CardContent>
          </Card>
        </div>
      </body>
    </html>
  );
}
