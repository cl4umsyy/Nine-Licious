import Link from "next/link";
import { ArrowLeft, LockKeyhole, LogOut, ShieldCheck } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { logoutAction } from "@/lib/auth/actions";
import { requireSession } from "@/lib/auth/guards";
import { ROLE_HOME, ROLE_LABELS } from "@/lib/auth/roles";

type UnauthorizedPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function UnauthorizedPage({
  searchParams,
}: UnauthorizedPageProps) {
  const session = await requireSession();
  const params = await searchParams;
  const from = typeof params.from === "string" ? params.from : null;

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center">
      <Card className="w-full">
        <CardHeader className="items-center text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-primary">
            <LockKeyhole className="size-5" />
          </div>
          <Badge variant="outline" className="mt-2">
            <ShieldCheck />
            Akses dibatasi
          </Badge>
          <CardTitle className="mt-1 font-display text-2xl">
            Halaman ini tidak tersedia untuk peran Anda
          </CardTitle>
          <CardDescription className="max-w-md leading-relaxed">
            Anda masuk sebagai{" "}
            <span className="font-medium text-foreground">
              {ROLE_LABELS[session.profile.role]}
            </span>
            . Gunakan menu yang sesuai dengan peran Anda atau hubungi admin
            restoran jika akses ini seharusnya tersedia.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {from ? (
            <div className="rounded-lg bg-muted/60 px-3 py-2 text-center font-mono text-xs text-muted-foreground">
              {from}
            </div>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button asChild className="flex-1">
              <Link href={ROLE_HOME[session.profile.role]}>
                <ArrowLeft />
                Kembali ke halaman utama
              </Link>
            </Button>
            <form action={logoutAction} className="flex-1">
              <Button
                type="submit"
                variant="outline"
                className="w-full"
              >
                <LogOut />
                Keluar
              </Button>
            </form>
          </div>

          <div className="flex justify-center">
            <BrandMark compact href={ROLE_HOME[session.profile.role]} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
