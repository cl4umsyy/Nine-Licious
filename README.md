# Saji POS

Aplikasi point of sale restoran **Saji** — pesanan, pembayaran, dapur, stok,
shift, laporan, dan audit dalam satu sistem. Antarmuka sepenuhnya berbahasa
Indonesia, mode terang, dengan identitas visual teal tua dan terracotta.

Status saat ini: **F0 — Fondasi & Autentikasi**. Modul transaksi, pembayaran,
dapur, stok, shift, dan laporan dikerjakan pada fase berikutnya sesuai PRD.

Saji adalah aplikasi operasional, bukan aplikasi simulasi. Tidak ada mode
khusus pengujian, akun contoh, atau data contoh yang dibuat otomatis.

---

## 1. Stack

| Bagian | Teknologi |
| --- | --- |
| Framework | Next.js 16.4 (App Router, Turbopack) |
| Bahasa | TypeScript strict |
| UI | Tailwind CSS v4, shadcn/ui (Radix), Lucide |
| Auth & database | Supabase (Postgres + Auth) |
| Validasi | Zod |
| Notifikasi | Sonner |
| Pembayaran | Midtrans Snap — Sandbox untuk development, Production untuk transaksi nyata (F2) |

Desain: teal `#0e4f45`, terracotta `#c65d3b`, latar paper `#f7f5f0`, sudut
lembut, tanpa gradien berlebihan, glassmorphism, atau animasi yang tidak perlu.

---

## 2. Prasyarat

- Node.js 20.12+ (disarankan 22)
- npm 10+
- Satu **project Supabase utama** sebagai database operasional
- Akses ke Supabase SQL Editor (atau Supabase CLI bila tersedia)
- Akun Midtrans Sandbox untuk development dan Midtrans Production untuk
  transaksi nyata

> Saji memakai satu project Supabase sebagai database utama. File environment
> development dan production memisahkan konfigurasi aplikasi, bukan membuat
> database terpisah. Jangan membuat transaksi atau data pelanggan palsu di
> production.

---

## 3. Setup cepat

### 3.1 Install dependency

```bash
npm install
```

### 3.2 Siapkan environment

Development:

```powershell
Copy-Item .env.development.example .env.development.local
```

Production:

```powershell
Copy-Item .env.production.example .env.production.local
```

Linux/macOS:

```bash
cp .env.development.example .env.development.local
cp .env.production.example .env.production.local
```

Isi nilai berikut dari project Supabase utama:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

`SUPABASE_SERVICE_ROLE_KEY` hanya untuk server. Jangan pernah menambahkan prefix
`NEXT_PUBLIC_` pada kunci ini dan jangan mengirimnya ke browser.

Next.js memuat environment dengan urutan `.env.$(NODE_ENV).local` →
`.env.local` → `.env.$(NODE_ENV)` → `.env`. `next dev` memakai
`.env.development.local`; `next build` dan `next start` memakai
`.env.production.local`. Nilai `NEXT_PUBLIC_*` dibekukan saat build, jadi build
ulang setelah mengubahnya.

### 3.3 Jalankan migrasi database

Buka **Supabase Dashboard → SQL Editor** pada project utama, lalu jalankan isi:

```text
supabase/migrations/20261110000100_foundation.sql
```

Migrasi membuat:

- `profiles` — profil staf, peran, status aktif
- `restaurant_settings` — nama restoran, pajak, service charge, struk
- `audit_logs` — jejak aktivitas login dan perubahan pengguna
- `login_attempts` — pembatasan percobaan login
- `daily_sequences` — urutan nomor harian untuk fase transaksi
- trigger profil otomatis, trigger `updated_at`, helper RLS, dan proteksi
  admin aktif terakhir

Migrasi tidak membuat akun atau transaksi contoh.

Bila memakai Supabase CLI:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

### 3.4 Buat admin pertama

Admin pertama dibuat lewat script operasional dengan kredensial eksplisit.
Tidak ada username atau password bawaan.

PowerShell (development):

```powershell
$env:ADMIN_USERNAME="pemilik"
$env:ADMIN_FULL_NAME="Nama Pemilik"
$env:ADMIN_PASSWORD="PasswordKuat123"
npm run create:admin
```

Bash (development):

```bash
ADMIN_USERNAME=pemilik \
ADMIN_FULL_NAME="Nama Pemilik" \
ADMIN_PASSWORD="PasswordKuat123" \
npm run create:admin
```

Production memakai file `.env.production.local`:

```powershell
$env:ADMIN_USERNAME="pemilik"
$env:ADMIN_FULL_NAME="Nama Pemilik"
$env:ADMIN_PASSWORD="PasswordKuat123"
npm run create:admin -- production
```

Gunakan argumen posisional `production`, bukan `--production`, karena npm
memakai flag tersebut untuk konfigurasinya sendiri.

Karena development dan production memakai satu project utama, akun admin yang
sama berlaku di kedua lingkungan. Bootstrap cukup dijalankan sekali; perintah
production dipakai saat bootstrap pertama langsung dari server production atau
saat memutar password admin.

Script akan:

- memvalidasi username, nama, dan password,
- membuat akun auth dengan email sintetis `username@saji.app`,
- menetapkan peran `admin` di `app_metadata` dan `profiles`,
- menulis audit log `admin.bootstrap`.

Menjalankan ulang script dengan username yang sama akan memperbarui password
dan profil admin tersebut. Hapus variabel `ADMIN_PASSWORD` dari shell setelah
selesai.

Setelah admin pertama ada, akun kasir dan staf dapur dibuat oleh admin melalui
menu **Pengguna**. Tidak ada pendaftaran mandiri.

### 3.5 Jalankan aplikasi

Development:

```bash
npm run dev
```

Production:

```bash
npm run build
npm run start
```

Buka `NEXT_PUBLIC_APP_URL` yang dipakai (default development:
`http://localhost:3000`).

Bila env Supabase belum lengkap, aplikasi tetap bisa dibuka dalam **mode setup**
dan menampilkan instruksi konfigurasi, bukan crash.

---

## 4. Akun & hak akses

| Rute | Admin | Kasir | Staf Dapur | Publik |
| --- | --- | --- | --- | --- |
| `/login` | ✓ | ✓ | ✓ | ✓ |
| `/queue` | ✓ | ✓ | ✓ | ✓ |
| `/admin` | ✓ | — | — | — |
| `/admin/users` | ✓ | — | — | — |
| `/pos` | ✓ | ✓ | — | — |
| `/kitchen` | ✓ | — | ✓ | — |
| `/unauthorized` | ✓ | ✓ | ✓ | — |

- Login memakai username, bukan email. Di balik layar, username dipetakan ke
  email sintetis `username@saji.app`.
- Peran disimpan di `profiles` dan dicerminkan ke `app_metadata` untuk
  pengecekan cepat di proxy. Server tetap memakai `profiles` sebagai sumber
  kebenaran.
- Pelanggan tidak perlu login untuk melihat `/queue`.
- Sesi otomatis berakhir setelah `SESSION_IDLE_MINUTES` tanpa aktivitas
  (default 30 menit).
- Lima kegagalan login dalam 15 menit memicu lockout 15 menit, dihitung per
  username dan per IP (IP disimpan sebagai hash).
- Pesan error login sengaja generik agar tidak membocorkan username yang valid.

### Pengelolaan pengguna

Admin dapat:

- membuat akun staf baru,
- mereset password,
- menonaktifkan atau mengaktifkan akun.

Aturan keamanan:

- admin tidak dapat menonaktifkan akunnya sendiri,
- admin aktif terakhir tidak dapat dinonaktifkan atau diturunkan perannya,
- akun nonaktif tidak bisa login dan permintaan berikutnya dari sesi lama
  ditolak oleh pemeriksaan profil,
- semua tindakan istimewa dicatat di `audit_logs`.

---

## 5. Environment variables

| Variabel | Wajib | Keterangan |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Ya | URL project Supabase utama |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Ya | Anon key (aman untuk browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | Ya untuk F0 | Hanya server; jangan diekspos |
| `NEXT_PUBLIC_APP_URL` | Disarankan | Default `http://localhost:3000` |
| `SESSION_IDLE_MINUTES` | Tidak | Default 30, dibatasi 5–480 |
| `AUDIT_IP_SALT` | Disarankan | Salt hash IP audit; gunakan nilai acak panjang |
| `MIDTRANS_ENABLED` | F2 | Default `false` |
| `MIDTRANS_ENV` | F2 | `sandbox` di development, `production` di production |
| `MIDTRANS_SERVER_KEY` | F2 | Hanya server |
| `NEXT_PUBLIC_MIDTRANS_CLIENT_KEY` | F2 | Client key sesuai environment |

`src/lib/midtrans/config.ts` menolak konfigurasi yang tidak cocok:

- development hanya boleh memakai `MIDTRANS_ENV=sandbox`,
- production hanya boleh memakai `MIDTRANS_ENV=production`.

---

## 6. Keamanan & batasan F0

- **Service role key hanya di server.** Modul `src/lib/supabase/admin.ts`
  memakai `server-only`; kunci tidak pernah masuk bundle browser.
- **RLS aktif** pada seluruh tabel F0. Profil hanya bisa dibaca sendiri oleh
  staf aktif atau oleh admin. Audit log dan percobaan login hanya bisa dibaca
  admin. Penulisan audit/login attempts dilakukan lewat service role.
- **Validasi server-side** dilakukan pada login, pembuatan pengguna, reset
  password, dan perubahan status akun. Jangan memindahkan otorisasi ke client.
- **Halaman `/queue` publik tanpa login** dan tidak menampilkan nama pelanggan,
  nomor telepon, nominal pembayaran, atau data keuangan. Pada F0 halaman ini
  menampilkan empty state karena modul pesanan belum aktif.
- **Pembayaran Midtrans** hanya dianggap berhasil setelah webhook diverifikasi
  di server: signature `SHA512(order_id + status_code + gross_amount +
  server_key)` harus valid, lalu status transaksi diambil ulang dari API
  Midtrans. Callback Snap di browser bukan bukti pembayaran.
- **Tidak ada transaksi palsu di production.** Data uji Sandbox tidak boleh
  masuk ke laporan operasional production.
- **Refund (F2+):** hanya admin yang dapat membuat dan menyetujui refund. Kasir
  hanya melihat status. Refund tunai dari drawer harus memengaruhi shift aktif;
  bila tidak ada shift aktif, admin dapat mencatat pengeluaran tunai di luar
  shift. Semua aktivitas refund diaudit dan dapat direkonsiliasi.
- **Pajak dan service charge** dihitung setelah diskon. Nilai default ada di
  `restaurant_settings` dan dapat diubah admin pada fase pengaturan.
- **Midtrans** belum aktif. Integrasi webhook dan Snap dikerjakan pada F2;
  pembayaran manual tetap tersedia sampai integrasi selesai.

---

## 7. Struktur project

```text
src/
  app/
    (app)/                 # Halaman yang membutuhkan login
      layout.tsx           # App shell + guard sesi
      admin/               # Dashboard dan pengguna (admin)
      pos/                 # Placeholder POS (F1)
      kitchen/             # Placeholder dapur (F3)
      unauthorized/
    login/                 # Login + mode setup
    queue/                 # Papan antrean publik
    layout.tsx             # Root layout, font, Toaster
    globals.css            # Design token Saji
  components/
    admin/user-management.tsx
    auth/                  # Login form & setup notice
    ui/                    # shadcn/ui
    app-shell.tsx
    brand-mark.tsx
    environment-badge.tsx
    page-header.tsx
  lib/
    auth/                  # Session, guard, audit, rate limit, actions
    midtrans/              # Config, signature, status helper
    supabase/              # Browser, server, admin, proxy clients
    env.ts
    navigation.ts
  proxy.ts                 # Refresh sesi, guard rute, idle timeout
supabase/migrations/       # Skema F0
scripts/create-admin.mjs   # Bootstrap admin pertama
```

---

## 8. Scripts

| Perintah | Fungsi |
| --- | --- |
| `npm run dev` | Menjalankan development server |
| `npm run build` | Build produksi |
| `npm run start` | Menjalankan hasil build |
| `npm run lint` | ESLint |
| `npm run typecheck` | Pemeriksaan TypeScript |
| `npm run create:admin` | Membuat/memperbarui admin pertama |
| `npm run create:admin -- production` | Bootstrap admin memakai env production |

Verifikasi statis F0:

```bash
npm run typecheck
npm run lint
npm run build
```

Verifikasi login end-to-end, RLS, rate limiting, audit, dan pengelolaan pengguna
memerlukan project Supabase utama yang sudah dimigrasi dan admin yang sudah
dibuat. Tanpa kredensial tersebut, aplikasi hanya dapat diverifikasi dalam mode
setup dan halaman publik `/queue`.

---

## 9. Troubleshooting

### "Layanan login belum siap. Pastikan migrasi database sudah dijalankan."

Tabel `login_attempts` atau `profiles` belum ada. Jalankan migrasi F0 di SQL
Editor project yang benar, lalu coba lagi.

### "Profil akun tidak ditemukan atau tidak aktif"

Akun auth ada tetapi profilnya tidak ada/nonaktif. Jalankan ulang
`npm run create:admin` untuk admin, atau buat ulang pengguna dari menu
**Pengguna** sebagai admin. Pastikan trigger `on_auth_user_created` berhasil
dibuat.

### "Saji belum terhubung ke Supabase" / mode setup

Periksa file environment yang sedang dipakai:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Restart `npm run dev` setelah mengubah env. Untuk production, build ulang
setelah mengubah `NEXT_PUBLIC_*`.

### Sesi langsung berakhir

Periksa `SESSION_IDLE_MINUTES`. Cookie `saji_last_seen` diperbarui pada setiap
permintaan halaman/aksi. Menghapus cookie atau mengganti `SESSION_IDLE_MINUTES`
dapat memengaruhi perilaku sesi.

### Login berhasil tetapi diarahkan ke halaman yang salah

Periksa peran di tabel `profiles` dan `app_metadata.role` pengguna. Login akan
menyelaraskan `app_metadata.role` dengan profil; jika masih bermasalah, periksa
console server dan audit log.

### Midtrans ditolak saat dikonfigurasi

Pastikan `MIDTRANS_ENV` cocok dengan `NODE_ENV`: `sandbox` untuk development,
`production` untuk production. Jangan memakai kredensial Production di
development.

---

## 10. Roadmap

| Fase | Cakupan |
| --- | --- |
| **F0** | Fondasi Next.js, design system, auth, peran, audit, pengguna |
| F1 | Menu, kategori, meja, keranjang, pesanan, POS |
| F2 | Pembayaran, Midtrans Sandbox/Production, struk, refund |
| F3 | Dapur, antrean, status pesanan, papan publik real-time |
| F4 | Stok, bahan baku, resep, penyesuaian stok |
| F5 | Shift, kas drawer, tutup shift, rekonsiliasi |
| F6 | Laporan, export, audit lanjutan, penyempurnaan operasional |

Fitur PRD tidak dihapus atau dilewati; setiap fase diselesaikan dan diverifikasi
sebelum fase berikutnya dimulai.

---

## 11. Catatan pengembangan

- Semua teks UI berbahasa Indonesia.
- Hanya mode terang. Token warna ada di `src/app/globals.css`.
- Gunakan Server Actions untuk mutasi; jangan memanggil service role dari Client
  Component.
- Jangan menambahkan data pelanggan atau keuangan ke `/queue`.
- Jangan membuat akun, transaksi, atau data contoh. Gunakan `create:admin` untuk
  admin pertama dan menu **Pengguna** untuk staf berikutnya.
- Sebelum deploy production: backup database, tinjau migrasi, isi
  `.env.production.local`, build ulang, dan bootstrap admin production secara
  eksplisit.
