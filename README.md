# Nine Licious

Aplikasi point of sale restoran **Nine Licious** — pesanan, pembayaran, dapur, stok,
shift, laporan, dan audit dalam satu sistem. Antarmuka sepenuhnya berbahasa
Indonesia, mode terang, dengan identitas visual teal tua dan terracotta.

Status saat ini: **F0 — Fondasi & Autentikasi**. Modul transaksi, pembayaran,
dapur, stok, shift, dan laporan dikerjakan pada fase berikutnya sesuai PRD.

Nine Licious adalah aplikasi operasional, bukan aplikasi simulasi. Tidak ada mode
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

> Nine Licious memakai satu project Supabase sebagai database utama. File environment
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

Buat `.env.local` di root project, lalu isi nilainya dari project Supabase
utama. File ini tidak di-commit.

Production:

```powershell
Copy-Item .env.production.example .env.production.local
```

Linux/macOS:

```bash
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
`.env.local` → `.env.$(NODE_ENV)` → `.env`. Development memakai `.env.local`;
build dan start production dapat memakai `.env.production.local` yang menimpa
nilai dari `.env.local`. Nilai `NEXT_PUBLIC_*` dibekukan saat build, jadi build
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

### 3.4 Buat lima akun awal

F0 memakai lima akun operasional: 1 admin, 2 kasir, dan 2 kitchen staff. Semua
akun dibuat lewat Supabase Auth Admin API dan terhubung ke tabel `profiles`.
Tidak ada username atau password bawaan di kode.

1. Salin template kredensial setup:

   ```powershell
   Copy-Item .env.setup.example .env.setup.local
   ```

   Linux/macOS:

   ```bash
   cp .env.setup.example .env.setup.local
   ```

2. Isi `SETUP_ADMIN_*`, `SETUP_KASIR1_*`, `SETUP_KASIR2_*`,
   `SETUP_KITCHEN1_*`, dan `SETUP_KITCHEN2_*` di `.env.setup.local`.
   File ini hanya dibaca oleh `npm run setup:accounts`, bukan oleh aplikasi
   Next.js. Jangan commit file tersebut.

3. Jalankan setup:

   ```bash
   npm run setup:accounts
   ```

   Production:

   ```bash
   npm run setup:accounts -- production
   ```

   Gunakan argumen posisional `production`, bukan `--production`, karena npm
   memakai flag tersebut untuk konfigurasinya sendiri.

Sifat script setup:

- **idempoten** — akun yang sudah ada dilewati, tidak dibuat duplikat;
- **tidak mengubah akun existing** — role atau status yang tidak sesuai
  dilaporkan `FAIL`, bukan diubah diam-diam;
- melengkapi profil yang hilang untuk auth user yang sudah ada;
- memastikan UUID auth sama dengan `profiles.id`, role tersimpan di
  `profiles.role` dan `app_metadata.role`, email terkonfirmasi, dan akun aktif;
- menulis audit log `accounts.bootstrap`;
- tidak pernah menampilkan password di log.

Menjalankan ulang `npm run setup:accounts` aman dan tidak menghapus akun.
Setelah lima akun awal ada, staf berikutnya dibuat admin melalui menu
**Pengguna**. Tidak ada pendaftaran mandiri.

`npm run create:admin` tetap tersedia untuk bootstrap admin manual dengan
variabel `ADMIN_USERNAME`, `ADMIN_FULL_NAME`, dan `ADMIN_PASSWORD`. Untuk setup
awal lima akun, gunakan `npm run setup:accounts`.

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
  email sintetis `username@saji.app`. Domain ini adalah identifier internal
  yang dipertahankan agar akun yang sudah ada tetap dapat login; bukan branding
  yang ditampilkan ke pengguna.
- Peran disimpan di `profiles` dan dicerminkan ke `app_metadata` untuk
  pengecekan cepat di proxy. Server tetap memakai `profiles` sebagai sumber
  kebenaran.
- Pelanggan tidak perlu login untuk melihat `/queue`.
- Sesi otomatis berakhir setelah `SESSION_IDLE_MINUTES` tanpa aktivitas
  (default 30 menit).
- Lima kegagalan login dalam 15 menit memicu lockout 15 menit, dihitung per
  username dan per IP (IP disimpan sebagai hash).
- Pesan error login sengaja generik agar tidak membocorkan username yang valid.

### Akun awal F0

| Label | Role | Sumber kredensial |
| --- | --- | --- |
| Admin | `admin` | `SETUP_ADMIN_*` |
| Kasir 1 | `kasir` | `SETUP_KASIR1_*` |
| Kasir 2 | `kasir` | `SETUP_KASIR2_*` |
| Kitchen 1 | `kitchen` | `SETUP_KITCHEN1_*` |
| Kitchen 2 | `kitchen` | `SETUP_KITCHEN2_*` |

Username pada tabel adalah contoh; nilai sebenarnya berasal dari
`.env.setup.local` atau environment shell. Password dibuat acak saat setup dan
hanya disimpan di file setup lokal, bukan di repository.

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
    globals.css            # Design token Nine Licious
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
scripts/
  setup-accounts.mjs       # Setup 5 akun awal (idempoten)
  create-admin.mjs         # Bootstrap admin manual
  verify-f0.mjs            # Verifikasi akun, login, RLS, audit
  verify-f0-ui.mjs         # Verifikasi UI, redirect, rate limit, pengguna
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
| `npm run setup:accounts` | Membuat 5 akun awal secara idempoten |
| `npm run setup:accounts -- production` | Setup akun memakai env production |
| `npm run create:admin` | Membuat/memperbarui admin manual |
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
`npm run setup:accounts` untuk melengkapi profil akun awal yang hilang, atau
buat ulang pengguna dari menu **Pengguna** sebagai admin. Pastikan trigger
`on_auth_user_created` berhasil dibuat.

### "Nine Licious belum terhubung ke Supabase" / mode setup

Periksa file environment yang sedang dipakai:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Restart `npm run dev` setelah mengubah env. Untuk production, build ulang
setelah mengubah `NEXT_PUBLIC_*`.

### Sesi langsung berakhir

Periksa `SESSION_IDLE_MINUTES`. Cookie `saji_last_seen` (nama teknis
dipertahankan agar sesi yang sudah ada tetap kompatibel) diperbarui pada setiap
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
- Jangan membuat akun, transaksi, atau data contoh. Gunakan
  `npm run setup:accounts` untuk lima akun awal dan menu **Pengguna** untuk staf
  berikutnya.
- Sebelum deploy production: backup database, tinjau migrasi, isi
  `.env.production.local`, build ulang, dan bootstrap admin production secara
  eksplisit.
