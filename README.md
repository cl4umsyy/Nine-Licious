# Nine Licious

Aplikasi point of sale restoran **Nine Licious** — pesanan, pembayaran, dapur, stok,
shift, laporan, dan audit dalam satu sistem. Antarmuka sepenuhnya berbahasa
Indonesia, mode terang, dengan identitas visual teal tua dan terracotta.

Status saat ini: **F0 — Fondasi & Autentikasi selesai**. F1 — Menu, meja, dan POS
dipecah menjadi **F1.1 Menu & Master Data**, **F1.2 Meja & Denah**, **F1.3 POS
Core, Kunjungan & Pesanan**, dan **F1.4 Diskon & Finalisasi**. Implementasi kode
F1.1 sudah tersedia dan menunggu migration serta pengujian runtime. Modul
pembayaran, dapur, stok, shift, dan laporan dikerjakan setelahnya sesuai
roadmap.

Dokumen acuan:

- [`docs/PRD.md`](docs/PRD.md) — **satu-satunya PRD utama**: requirement produk
  lengkap dan analisis database. Versi dokumen 1.5.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — fase F0–F6, milestone F1.1–F1.4,
  dependency, migration, dan acceptance criteria. Versi dokumen 1.5.
- [`docs/USER_FLOW.md`](docs/USER_FLOW.md) — alur penggunaan per role dan proses
  bisnis, status F0–F6, serta diagram Mermaid. Versi dokumen 1.2.

> Jangan membuat `prd.md` di root project atau salinan PRD dengan nama lain.
> Setiap keputusan produk harus masuk ke `docs/PRD.md`, lalu disinkronkan ke
> `docs/ROADMAP.md` dan README ini.

Keputusan produk utama:

- Nine Licious memakai **counter ordering**: pelanggan memesan melalui kasir,
  bukan memesan sendiri dari meja.
- **Tidak ada QR ordering** dan tidak ada akun pelanggan.
- POS terdiri dari dua bagian: kategori/produk di kiri, keranjang/total di kanan.
- Kategori utama: Food, Drinks, Desserts, dan Packages.
- Dine-in memilih meja; takeaway tidak memakai meja.
- Denah meja interaktif adalah challenge pembimbing dan wajib dipertahankan.
  Admin memiliki editor **drag-and-drop** untuk posisi, kapasitas, dan zona;
  kasir memilih meja melalui denah yang sama.
- Satu meja hanya memiliki **satu kunjungan dine-in aktif** pada satu waktu,
  tetapi satu kunjungan dapat memiliki beberapa pesanan.
- **Override tutup meja** tidak boleh meninggalkan pesanan aktif atau pembayaran
  tertunda; pesanan belum lunas dibatalkan dan pesanan lunas yang masih aktif
  direfund penuh sebelum kunjungan ditutup.
- **F1 berhenti pada Menunggu Pembayaran.** Setelah pesanan disimpan, F1
  menampilkan konfirmasi dan CTA pembayaran nonaktif/placeholder. F1 tidak
  mencatat pembayaran, tidak membuat nomor antrean, dan tidak membuat tiket KDS.
  F2 memakai `order_id` yang sama.
- **Pembatalan pesanan belum lunas** pada F1 hanya untuk pesanan **Menunggu
  Pembayaran** tanpa pembayaran. Kasir/admin dapat membatalkan dengan alasan
  wajib dan audit; kitchen tidak. Meja kembali **Kosong** hanya bila tidak ada
  pesanan aktif lain dan tidak ada pembayaran tertunda. Pembatalan **Sebagian
  Dibayar** baru dilakukan di F2 setelah refund bagian disetujui/dicatat admin.
- **Tiga status meja** wajib ter-render di F1.2. Transisi nyata ke **Menunggu
  Pembayaran** diuji di F1.3, sedangkan transisi ke **Terisi** diuji di F2
  karena memerlukan pembayaran.
- **F1 tidak menghasilkan tiket KDS atau nomor antrean.** Keduanya baru dibuat
  pada F2 setelah pembayaran lunas.
- Pesanan hanya masuk KDS setelah **pembayaran lunas**; nomor antrean `A001`
  diberikan setelah lunas.
- KDS hanya memiliki tiga status: **Pesanan Masuk**, **Sedang Disiapkan**, dan
  **Siap Diambil**.
- Kitchen hanya mengubah status sampai **Siap Diambil**; kasir/admin
  mengonfirmasi pengambilan.
- Split bill dan pencatatan pembayaran tetap didukung. Setiap bagian pembayaran
  online Midtrans memakai transaksi gateway sendiri dengan `midtrans_order_id`
  unik; callback diverifikasi dan idempoten. Total pembayaran tidak boleh
  melebihi tagihan; uang tunai berlebih menjadi kembalian.
- **Diskon** terdiri dari diskon produk, diskon seluruh pesanan, dan diskon
  manual. Diskon manual memerlukan alasan dan approval admin. Kasir tidak dapat
  mengubah harga produk secara bebas, semua diskon tercatat di transaksi serta
  audit log, dan pajak/service charge dihitung setelah diskon.
- **QRIS Manual** dan **QRIS Midtrans** sama-sama didukung dan dicatat sebagai
  sumber pembayaran berbeda.
- **Pesanan tambahan** setelah pembayaran mendapat nomor antrean baru, tetap
  terhubung ke meja dan kunjungan dine-in yang sama, dan tidak boleh membuat
  transaksi/antrean ganda.
- **Refund penuh setelah pesanan lunas** memerlukan approval admin. Bila tiket
  dapur masih aktif, tiket dihentikan dan kitchen menerima notifikasi. Refund
  penuh setelah pesanan **Selesai** tetap diaudit tanpa notifikasi penghentian
  tiket. Semua tindakan diaudit.
- Pada F2, struk 58 mm dan 80 mm dicetak melalui **browser print**. Integrasi
  ESC/POS atau printer thermal khusus tidak wajib dan dapat dipertimbangkan pada
  fase berikutnya.

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

Buka **Supabase Dashboard → SQL Editor** pada project utama, lalu jalankan isi
migration secara berurutan:

```text
supabase/migrations/20261110000100_foundation.sql
supabase/migrations/20261111000100_menu_master.sql
```

Migration F0 membuat:

- `profiles` — profil staf, peran, status aktif
- `restaurant_settings` — nama restoran, pajak, service charge, struk
- `audit_logs` — jejak aktivitas login dan perubahan pengguna
- `login_attempts` — pembatasan percobaan login
- `daily_sequences` — urutan nomor harian untuk fase transaksi
- trigger profil otomatis, trigger `updated_at`, helper RLS, dan proteksi
  admin aktif terakhir

Migrasi tidak membuat akun atau transaksi contoh.

Migration F1.1 membuat:

- `menu_categories` — kategori menu dan seed Food/Drinks/Desserts/Packages
- `products` — harga rupiah, foto, ketersediaan, dan stasiun dapur
- `modifier_groups` dan `modifier_options` — grup/opsi modifier
- `product_modifier_groups` — relasi many-to-many produk dan modifier
- RLS, grant, index, trigger `updated_at`, serta bucket/policy foto
  `product-photos`

Skema saat ini belum mencakup zona/meja, kunjungan dine-in, pesanan, diskon,
pembayaran, split bill, KDS, antrean, atau notifikasi dapur. Tabel tersebut
ditambahkan pada F1.2–F3 sesuai [`docs/ROADMAP.md`](docs/ROADMAP.md); lihat juga
analisis kesiapan database di [`docs/PRD.md`](docs/PRD.md).

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

### 3.4.1 Lupa password Admin

Password admin yang dibuat saat setup tersimpan di `.env.setup.local` pada
variabel `SETUP_ADMIN_PASSWORD`. File ini tidak dibaca aplikasi Next.js dan tidak
boleh di-commit. Jika nilainya hilang atau ingin diganti, gunakan prosedur reset
yang hanya memperbarui akun admin yang sudah ada:

```bash
# validasi target tanpa mengubah apa pun
npm run reset:admin -- --check

# reset interaktif; password diketik tersembunyi
npm run reset:admin
```

Script akan:

- mencari profil admin (default `admin`, atau dari `--username`) dan auth user
  dengan UUID yang sama;
- menolak akun non-admin, profil tanpa auth user, atau email yang tidak cocok;
- **tidak pernah membuat akun baru atau duplikat**;
- memperbarui password lewat Supabase Auth Admin API di server;
- menulis audit `user.password_reset`;
- tidak pernah mencetak service role key maupun password.

Jika akun admin sedang nonaktif atau dibanned:

```bash
npm run reset:admin -- --reactivate
```

Production:

```bash
npm run reset:admin -- production
```

Untuk otomasi tanpa prompt, set `ADMIN_NEW_PASSWORD` di environment. Jangan
menaruh password di command line atau file yang di-commit.

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
| `SUPABASE_SERVICE_ROLE_KEY` | Ya | Hanya server; jangan diekspos |
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

## 6. Keamanan & batasan operasional

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
- **Refund (F2+; integrasi shift pada F5):** hanya admin yang dapat membuat dan
  menyetujui refund. Kasir hanya melihat status. **Refund penuh setelah pesanan
  lunas wajib approval admin**; bila tiket dapur masih aktif, setelah disetujui
  tiket dihentikan, kitchen menerima notifikasi, dan seluruh tindakan dicatat di
  audit. Refund penuh setelah **Selesai** tetap diaudit tanpa penghentian tiket.
  Refund tunai dari drawer harus memengaruhi shift aktif; bila tidak ada shift
  aktif, admin dapat mencatat pengeluaran tunai di luar shift. Semua aktivitas
  refund diaudit dan dapat direkonsiliasi.
- **Sumber pembayaran:** QRIS Manual (`qris_manual`) dan QRIS Midtrans
  (`qris_midtrans`) adalah dua sumber berbeda. Struk, detail pembayaran,
  laporan, dan audit harus menampilkan label sumbernya. Split bill boleh
  mencampur sumber pembayaran.
- **Pajak dan service charge** dihitung setelah diskon. Nilai default ada di
  `restaurant_settings` dan dapat diubah admin pada fase pengaturan.
- **Diskon** terdiri dari diskon produk, diskon seluruh pesanan, dan diskon
  manual. Diskon produk dihitung per baris, diskon pesanan setelah diskon
  produk, diskon manual setelah diskon pesanan, dan pajak/service charge setelah
  seluruh diskon. Diskon manual wajib
  memiliki alasan dan approval admin; diskon yang belum disetujui tidak boleh
  diterapkan. Kasir tidak dapat mengubah harga produk secara bebas. Semua
  diskon tersimpan pada transaksi dan tercatat di audit log.
- **Split bill Midtrans** memakai transaksi gateway terpisah untuk setiap
  pembayaran online dengan `midtrans_order_id` unik. Callback diverifikasi dan
  idempoten; event duplikat tidak boleh membuat pembayaran ganda. Saat pesanan
  lunas, total nilai pembayaran harus sama dengan grand total dan tidak boleh
  melebihi tagihan; uang tunai berlebih dicatat sebagai kembalian.
- **Printing F2** memakai browser print untuk layout 58 mm dan 80 mm. Integrasi
  ESC/POS atau printer thermal khusus tidak diwajibkan pada F2 dan dapat
  dipertimbangkan pada fase berikutnya. Cetak ulang struk/nomor antrean dicatat
  di audit.
- **Pembayaran sebelum dapur.** KDS hanya menerima pesanan yang sudah lunas.
  Pesanan berstatus menunggu pembayaran atau sebagian dibayar tidak boleh
  muncul di KDS, dan nomor antrean baru dibuat setelah lunas.
- **Split bill** didukung. Pesanan dianggap lunas ketika akumulasi pembayaran
  sama dengan grand total; total pembayaran tidak boleh melebihi tagihan.
  Pembayaran non-tunai tidak boleh melebihi sisa tagihan; uang tunai berlebih
  dicatat sebagai kembalian.
- **Pesanan tambahan** setelah pembayaran selalu membuat pesanan dan nomor
  antrean baru, tetap pada meja dan kunjungan dine-in yang sama. Idempotency key
  dan unique constraint mencegah pesanan/antrean ganda.
- **Denah meja interaktif** adalah challenge pembimbing dan wajib dikerjakan
  pada F1.2. Admin mengatur posisi, kapasitas, dan zona lewat editor
  drag-and-drop; kasir memilih meja dari denah tersebut. Status meja hanya
  kosong, menunggu pembayaran, dan terisi; tiga status wajib ter-render pada
  F1.2, sedangkan transisi ke terisi diuji pada F2.
- **Konfirmasi pengambilan** hanya dilakukan kasir/admin. Kitchen berhenti di
  status **Siap Diambil** dan tidak memiliki aksi Selesai/Diambil.
- **Midtrans** belum aktif. Integrasi webhook dan Snap dikerjakan pada F2.
  Sampai integrasi selesai, kasir dapat mencatat pembayaran tunai, QRIS Manual,
  atau transfer secara manual. `Manual` adalah cara pencatatan, bukan metode
  pembayaran kelima; pembayaran kartu diproses melalui Midtrans bila channel
  tersebut diaktifkan.

---

## 7. Struktur project

```text
docs/
  PRD.md                   # Requirement produk, state machine, gap database
  ROADMAP.md               # Fase F0–F6, dependency, migration
  USER_FLOW.md             # Alur per role, status fase, diagram Mermaid
src/
  app/
    (app)/                 # Halaman yang membutuhkan login
      layout.tsx           # App shell + guard sesi
      admin/               # Dashboard dan pengguna (admin)
      pos/                 # Placeholder POS (F1.3)
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
  reset-admin-password.mjs # Reset password admin existing (tanpa duplikat)
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
| `npm run reset:admin` | Reset password admin existing (interaktif) |
| `npm run reset:admin -- --check` | Validasi target reset tanpa mengubah data |
| `npm run reset:admin -- production` | Reset password admin memakai env production |

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

### Lupa password Admin

Password awal tersimpan di `.env.setup.local` pada `SETUP_ADMIN_PASSWORD`. Jika
nilainya hilang, validasi target terlebih dahulu:

```bash
npm run reset:admin -- --check
```

Lalu atur password baru (input tersembunyi):

```bash
npm run reset:admin
```

Script hanya memperbarui admin yang sudah ada, tidak membuat akun duplikat, dan
mencatat audit `user.password_reset`. Jika akun sedang nonaktif, gunakan
`npm run reset:admin -- --reactivate`.

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

Ringkasan fase. Rincian deliverable, dependency, migration, dan acceptance
criteria ada di [`docs/ROADMAP.md`](docs/ROADMAP.md). Alur penggunaan per role,
kondisi berhasil/gagal/pembatalan, dan perpindahan data antar modul ada di
[`docs/USER_FLOW.md`](docs/USER_FLOW.md).

| Fase | Cakupan | Status |
| --- | --- | --- |
| **F0** | Fondasi Next.js, design system, auth, peran, audit, pengguna, reset admin | **Selesai** |
| **F1** | Fase induk menu, meja, dan POS; dipecah menjadi F1.1–F1.4 | **Berjalan** |
| **F1.1** | Menu & Master Data: kategori, produk, modifier, foto, ketersediaan | **Implementasi selesai; menunggu migration & uji runtime** |
| **F1.2** | Meja & Denah: zona, meja, editor drag-and-drop, denah tiga status | Rencana |
| **F1.3** | POS Core, Kunjungan & Pesanan: POS dua bagian, keranjang, dine-in/takeaway, pesanan menunggu pembayaran, pembatalan, handoff pembayaran | Rencana |
| **F1.4** | Diskon & Finalisasi: diskon produk/pesanan/manual, approval admin, pajak/service, hardening | Rencana |
| **F2** | Pembayaran tunai/QRIS Manual/QRIS Midtrans/transfer/Midtrans, split bill Midtrans per transaksi gateway, pesanan tambahan, nomor antrean `A001`, browser print 58/80 mm, refund dengan approval admin dan pencatatan waktu notifikasi dapur bila tiket aktif | Rencana |
| **F3** | KDS tiga status, papan antrean publik real-time, konfirmasi pengambilan kasir/admin, tampilan notifikasi refund | Rencana |
| **F4** | Stok, bahan baku, resep, penyesuaian stok | Rencana |
| **F5** | Shift, kas drawer, tutup shift, rekonsiliasi | Rencana |
| **F6** | Laporan, export, audit lanjutan, penyempurnaan operasional | Rencana |

Aturan roadmap:

- F1.1 dan F1.2 boleh paralel; F1.3 menunggu keduanya; F1.4 menunggu F1.3.
- F1 dinyatakan selesai hanya setelah F1.4 lulus gate dan seluruh acceptance F1
  PASS.
- F1 tidak menghasilkan tiket KDS atau nomor antrean. F1 berhenti pada
  **Menunggu Pembayaran** dengan CTA pembayaran placeholder.
- Pembatalan pesanan belum lunas pada F1 hanya untuk **Menunggu Pembayaran**
  tanpa pembayaran, wajib alasan dan audit; dampak meja mengikuti pesanan
  tersisa.
- Denah F1.2 wajib merender tiga status meja; transisi nyata ke **Terisi**
  diuji pada F2.
- Pembayaran harus selesai sebelum KDS; F3 tidak dimulai sebelum F2 lulus gate.
- KDS hanya memiliki tiga status; status selesai/diambil bukan kolom keempat.
- Kitchen hanya mengubah status sampai **Siap Diambil**; kasir/admin
  mengonfirmasi pengambilan.
- Refund penuh setelah pesanan lunas wajib approval admin; bila tiket dapur
  masih aktif, tiket dihentikan dan kitchen menerima notifikasi.
- QRIS Manual dan QRIS Midtrans dicatat sebagai sumber pembayaran berbeda.
- Setiap pembayaran online Midtrans pada split bill memakai transaksi gateway
  sendiri; callback duplikat tidak boleh membuat pembayaran ganda.
- Total pembayaran split bill tidak boleh melebihi grand total; uang tunai
  berlebih dicatat sebagai kembalian.
- Diskon manual memerlukan alasan dan approval admin; kasir tidak dapat
  mengubah harga produk secara bebas; semua diskon diaudit.
- Struk 58/80 mm pada F2 dicetak melalui browser print; integrasi ESC/POS tidak
  wajib.
- Pesanan tambahan setelah pembayaran mendapat nomor antrean baru pada
  kunjungan dine-in yang sama dan tidak boleh membuat transaksi/antrean ganda.
- Editor denah meja drag-and-drop dengan posisi, kapasitas, dan zona wajib masuk
  F1.2 karena merupakan challenge pembimbing.
- Split bill, stok, shift, dan laporan tidak dihapus atau dilewati.
- QR ordering tidak dibuat.
- Setiap fase diselesaikan, diuji, dan disetujui sebelum fase berikutnya.

---

## 11. Catatan pengembangan

- Semua teks UI berbahasa Indonesia.
- Hanya mode terang. Token warna ada di `src/app/globals.css`.
- Gunakan Server Actions untuk mutasi; jangan memanggil service role dari Client
  Component.
- Alur produk adalah counter ordering: pelanggan memesan melalui kasir. Jangan
  menambahkan QR ordering, self-order, atau akun pelanggan.
- Jangan mengirim pesanan ke KDS atau membuat nomor antrean sebelum pembayaran
  lunas. Split bill tetap mengikuti aturan grand total.
- F1 berhenti pada **Menunggu Pembayaran**: jangan mencatat pembayaran, membuka
  panel pembayaran, membuat nomor antrean, atau membuat tiket KDS. Gunakan
  konfirmasi dan CTA placeholder; F2 memakai `order_id` yang sama.
- Pembatalan pesanan belum lunas wajib alasan, hanya untuk kasir/admin, dicatat
  di audit, dan tidak boleh mengosongkan meja yang masih memiliki pesanan aktif
  atau pembayaran tertunda.
- Tiga status meja wajib ter-render di F1.2; jangan menandai **Terisi** sebelum
  pembayaran lunas pada F2.
- KDS hanya memiliki tiga status: Pesanan Masuk, Sedang Disiapkan, Siap Diambil.
  Jangan menambah kolom Selesai/Diambil/Disajikan.
- Kitchen tidak mengonfirmasi pengambilan; aksi itu hanya untuk kasir/admin.
- QRIS Manual dan QRIS Midtrans wajib dibedakan pada data, struk, laporan, dan
  audit.
- Split bill Midtrans wajib memakai transaksi gateway terpisah per pembayaran
  online dengan `midtrans_order_id` unik; callback harus idempoten dan total
  pembayaran tidak boleh melebihi tagihan.
- Diskon produk, diskon pesanan, dan diskon manual harus tercatat di transaksi
  dan audit; diskon manual memerlukan approval admin dan kasir tidak boleh
  mengubah harga produk secara bebas.
- Pajak dan service charge dihitung setelah seluruh diskon.
- Struk 58/80 mm pada F2 memakai browser print; jangan mewajibkan ESC/POS pada
  F2.
- Pesanan tambahan selalu membuat pesanan dan antrean baru pada kunjungan yang
  sama; gunakan idempotency key agar tidak terjadi duplikasi.
- Refund penuh setelah pesanan lunas wajib approval admin; bila tiket masih
  aktif, hentikan tiket dan kirim notifikasi ke dapur.
- Denah meja interaktif wajib dipertahankan sebagai challenge pembimbing; admin
  mengatur posisi, kapasitas, dan zona lewat editor drag-and-drop pada F1.2.
- `docs/PRD.md` adalah satu-satunya PRD utama. Jangan membuat `prd.md` di root
  atau salinan PRD dengan nama lain.
- Jangan menambahkan data pelanggan atau keuangan ke `/queue`.
- Jangan membuat akun, transaksi, atau data contoh. Gunakan
  `npm run setup:accounts` untuk lima akun awal dan menu **Pengguna** untuk staf
  berikutnya.
- Sebelum deploy production: backup database, tinjau migrasi, isi
  `.env.production.local`, build ulang, dan bootstrap admin production secara
  eksplisit.
