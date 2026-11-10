import Link from "next/link";
import { ArrowLeft, SearchX } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-primary">
            <SearchX className="size-5" />
          </div>
          <CardTitle className="mt-2 font-display text-2xl">
            Halaman tidak ditemukan
          </CardTitle>
          <CardDescription>
            Alamat yang Anda buka tidak tersedia atau sudah dipindahkan.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Button asChild className="w-full">
            <Link href="/">
              <ArrowLeft />
              Kembali ke awal
            </Link>
          </Button>
          <div className="flex justify-center">
            <BrandMark compact href="/" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
