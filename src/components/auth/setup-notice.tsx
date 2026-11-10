import { Database, KeyRound, ShieldCheck, Terminal } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const STEPS = [
  {
    icon: KeyRound,
    title: "Siapkan environment",
    body: "Buat .env.local untuk development, atau salin .env.production.example menjadi .env.production.local untuk production. Isi URL, anon key, dan service role key dari project Supabase utama.",
  },
  {
    icon: Database,
    title: "Jalankan migrasi",
    body: "Buka Supabase SQL Editor dan jalankan supabase/migrations/20261110000100_foundation.sql. Migrasi membuat profil, pengaturan restoran, audit log, dan tabel pendukung autentikasi tanpa membuat data transaksi contoh.",
  },
  {
    icon: Terminal,
    title: "Buat akun awal",
    body: "Salin .env.setup.example menjadi .env.setup.local, isi kredensial lima akun awal, lalu jalankan npm run setup:accounts. Tidak ada akun default atau password bawaan.",
  },
  {
    icon: ShieldCheck,
    title: "Jaga kunci server",
    body: "Service role key dan Midtrans server key hanya boleh berada di server. Jangan pernah menaruhnya di variabel NEXT_PUBLIC_ atau mengirimnya ke browser.",
  },
];

export function SetupNotice() {
  return (
    <Card className="border-warning/30 bg-warning/[0.035]">
      <CardHeader>
        <CardTitle className="text-lg">Nine Licious belum terhubung ke Supabase</CardTitle>
        <CardDescription>
          Aplikasi berjalan dalam mode setup. Ikuti langkah berikut untuk
          mengaktifkan autentikasi dan data restoran.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <Database />
          <AlertTitle>Project Supabase utama diperlukan</AlertTitle>
          <AlertDescription>
            Nine Licious memakai satu project Supabase sebagai database utama. Pisahkan
            file environment development dan production, dan jangan menjalankan
            operasi destruktif tanpa backup.
          </AlertDescription>
        </Alert>

        <ol className="space-y-3.5">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-brand-soft text-[0.7rem] font-semibold text-primary">
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <step.icon className="size-3.5 text-brand-accent" />
                  {step.title}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>

        <div className="rounded-lg bg-primary/95 p-3 font-mono text-[0.7rem] leading-relaxed text-primary-foreground">
          <p className="text-primary-foreground/60"># setelah environment terisi</p>
          <p>npm run setup:accounts</p>
          <p>npm run dev</p>
        </div>

        <p className="text-[0.7rem] leading-relaxed text-muted-foreground">
          Midtrans disiapkan melalui MIDTRANS_ENV, MIDTRANS_SERVER_KEY, dan
          NEXT_PUBLIC_MIDTRANS_CLIENT_KEY. Pembayaran hanya dianggap berhasil
          setelah webhook Midtrans terverifikasi pada F2. Detail lengkap ada di
          README.md.
        </p>
      </CardContent>
    </Card>
  );
}
