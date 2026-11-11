# Roadmap Nine Licious

| Field | Nilai |
| --- | --- |
| Produk | Nine Licious POS |
| Versi dokumen | 1.5 |
| Tanggal | 11 November 2026 |
| Status | F0 selesai; F1 dipecah menjadi F1.1–F1.4; implementasi menunggu persetujuan |
| Dokumen terkait | [`docs/PRD.md`](./PRD.md), [`README.md`](../README.md) |

> Roadmap ini adalah rencana eksekusi. Requirement lengkap ada di
> [`docs/PRD.md`](./PRD.md). Setiap fase harus selesai, diuji, dan disetujui
> sebelum fase berikutnya dimulai.
>
> **Dokumentasi:** `docs/PRD.md` adalah satu-satunya PRD utama. Jangan membuat
> `prd.md` di root project atau salinan PRD dengan nama lain. Setiap perubahan
> requirement harus disinkronkan ke roadmap ini dan `README.md`.

---

## 1. Prinsip eksekusi

1. **Berurutan.** F0 → F1 → F2 → F3 → F4 → F5 → F6. F3 tidak boleh dimulai
   sebelum F2 selesai karena KDS hanya menerima pesanan lunas.
2. **Tidak menghapus fitur.** Requirement lama yang masih relevan tetap
   dikerjakan, termasuk denah meja, split bill, stok, shift, laporan, dan audit.
3. **Tidak ada QR ordering.** Tidak ada pemesanan mandiri pelanggan, baik lewat
   QR di meja maupun tautan publik.
4. **Pembayaran sebelum dapur.** Pesanan hanya masuk KDS dan nomor antrean hanya
   dibuat setelah pembayaran lunas.
5. **Satu fase, satu verifikasi.** Setiap fase memiliki migration, acceptance
   criteria, dan bukti pengujian.
6. **Tidak ada data demo.** Master data yang diwajibkan (kategori, pengaturan)
   bukan data contoh transaksi.
7. **Satu kunjungan per meja.** Satu meja hanya memiliki satu kunjungan dine-in
   aktif; satu kunjungan dapat memiliki beberapa pesanan.
8. **Pesanan tambahan tidak menggandakan transaksi.** Pesanan tambahan setelah
   pembayaran memakai pesanan, pembayaran, dan nomor antrean baru yang
   terhubung ke kunjungan yang sama; idempotency key mencegah duplikasi.
9. **Sumber pembayaran eksplisit.** QRIS Manual dan QRIS Midtrans dicatat
   sebagai sumber berbeda.
10. **Refund setelah lunas terkontrol.** Refund penuh setelah pesanan lunas
    memerlukan approval admin. Bila tiket KDS masih aktif, tiket dihentikan dan
    kitchen menerima notifikasi.
11. **Dokumentasi ikut diperbarui.** Setiap fase memperbarui README/PRD bila ada
    keputusan produk baru.
12. **Split bill Midtrans per transaksi gateway.** Setiap bagian pembayaran
    online memakai transaksi gateway sendiri dengan `midtrans_order_id` unik;
    callback diverifikasi dan idempoten; total pembayaran tidak boleh melebihi
    tagihan.
13. **Diskon terkontrol.** Diskon produk, diskon pesanan, dan diskon manual
    didukung; diskon manual memerlukan alasan dan approval admin; kasir tidak
    dapat mengubah harga produk secara bebas; semua diskon diaudit.
14. **Printing bertahap.** F2 memakai browser print untuk struk 58 mm dan 80 mm;
    integrasi ESC/POS atau printer thermal khusus tidak wajib dan dapat
    dipertimbangkan pada fase berikutnya.
15. **F1 bertahap.** F1 dipecah menjadi F1.1 Menu & Master Data, F1.2 Meja &
    Denah, F1.3 POS Core/Kunjungan/Pesanan, dan F1.4 Diskon & Finalisasi.
    Pembagian ini tidak memindahkan fitur ke F2.
16. **F1 berhenti di menunggu pembayaran.** F1 tidak mencatat pembayaran,
    membuat nomor antrean, atau membuat tiket KDS. Handoff ke F2 memakai
    `order_id` yang sama.
17. **Pembatalan belum lunas terkontrol.** Pembatalan F1 hanya untuk pesanan
    **Menunggu Pembayaran** tanpa pembayaran, wajib alasan dan audit; dampak
    meja mengikuti pesanan yang tersisa.
18. **Status meja bertahap.** F1.2 merender tiga status; transisi nyata ke
    **Menunggu Pembayaran** diuji F1.3, dan transisi ke **Terisi** diuji F2.

---

## 2. Ringkasan fase

| Fase | Nama | Status | Fokus | Gate |
| --- | --- | --- | --- | --- |
| **F0** | Fondasi & autentikasi | **Selesai** | Next.js, desain, auth, role, audit, pengguna | Lulus verifikasi F0 |
| **F1** | Menu, meja, dan POS | **Berikutnya** | Fase induk; dipecah menjadi F1.1–F1.4 | Seluruh milestone F1 lulus |
| **F1.1** | Menu & Master Data | **Berikutnya** | Kategori, produk, modifier, foto, master data | Admin dapat mengelola menu |
| **F1.2** | Meja & Denah | **Berikutnya** | Zona, meja, editor drag-and-drop, denah interaktif | Layout terbit; tiga status ter-render |
| **F1.3** | POS Core, Kunjungan & Pesanan | Rencana | POS dua bagian, keranjang, dine-in/takeaway, pesanan, pembatalan, handoff | Pesanan tersimpan menunggu pembayaran; tanpa KDS/antrean |
| **F1.4** | Diskon & Finalisasi | Rencana | Diskon produk/pesanan/manual, approval, pajak/service, hardening | Seluruh acceptance F1 lulus |
| **F2** | Pembayaran, split bill, pesanan tambahan, antrean, struk | Rencana | Tunai/QRIS Manual/QRIS Midtrans/transfer/Midtrans, split bill Midtrans per transaksi gateway, pesanan tambahan, nomor antrean, browser print 58/80 mm, refund | Pesanan lunas memicu antrean dan tiket KDS |
| **F3** | KDS dan papan antrean | Rencana | KDS tiga status, realtime, papan publik, konfirmasi pengambilan kasir/admin, tampilan notifikasi refund | Hanya pesanan lunas yang tampil |
| **F4** | Stok dan bahan baku | Rencana | Bahan baku, resep, penyesuaian stok | Stok terhubung ke menu |
| **F5** | Shift dan kas | Rencana | Shift, kas drawer, tutup shift, rekonsiliasi | Refund tunai terhubung ke shift |
| **F6** | Laporan dan audit lanjutan | Rencana | Laporan, export, audit, penyempurnaan | Laporan operasional siap |

---

## 3. F0 — Fondasi dan autentikasi (selesai)

### 3.1 Deliverable

- Next.js 16 App Router, TypeScript strict, Tailwind v4, shadcn/ui.
- Desain Nine Licious: teal, terracotta, latar paper, mode terang.
- Supabase Auth + Postgres.
- Tabel `profiles`, `restaurant_settings`, `audit_logs`, `login_attempts`,
  `daily_sequences`.
- Login username → email sintetis `username@saji.app`.
- Role `admin`, `kasir`, `kitchen`.
- Guard rute dan sesi idle.
- Rate limit login dan lockout.
- Manajemen pengguna oleh admin.
- Audit log aktivitas pengguna.
- Lima akun awal: 1 admin, 2 kasir, 2 kitchen.
- Prosedur reset password admin tanpa membuat akun duplikat.
- Halaman placeholder POS, kitchen, queue, admin.

### 3.2 Bukti penyelesaian

- `verify-f0.mjs`: 18 PASS.
- `verify-f0-ui.mjs`: 40 PASS mode kasir dan 40 PASS mode kitchen.
- Typecheck, lint, build PASS.
- Lima akun awal utuh; tidak ada akun uji tersisa.
- Admin login terverifikasi; audit `user.password_reset` tercatat.

### 3.3 Catatan

F0 tidak memiliki tabel menu, meja, pesanan, pembayaran, KDS, atau split bill.
Semua itu masuk F1–F3.

---

## 4. F1 — Menu, meja, dan POS

### 4.1 Tujuan

Kasir dapat menyusun pesanan lengkap dan menyimpannya sebagai **Menunggu
Pembayaran**, tanpa mengirim apa pun ke KDS. F1 berhenti pada status tersebut;
pembayaran, nomor antrean, dan tiket KDS baru dibuat pada F2.

F1 dipecah menjadi empat milestone internal agar setiap bagian dapat diuji dan
didemokan sebelum milestone berikutnya. Pembagian ini **tidak memindahkan**
fitur ke F2 dan tidak menghapus requirement.

### 4.2 Milestone internal dan dependency

| Milestone | Fokus | Dependency | Gate utama |
| --- | --- | --- | --- |
| **F1.1** | Menu & Master Data | F0 selesai | Admin dapat mengelola menu; belum ada POS |
| **F1.2** | Meja & Denah | F0 selesai; boleh paralel dengan F1.1 | Layout tersimpan/terbit; tiga status meja ter-render |
| **F1.3** | POS Core, Kunjungan & Pesanan | F1.1 dan F1.2 selesai | Pesanan tersimpan **Menunggu Pembayaran**; pembatalan dan penutupan meja berjalan |
| **F1.4** | Diskon & Finalisasi | F1.3 selesai | Seluruh acceptance F1 lulus; diskon dan perhitungan final benar |

Aturan dependency:

- F1.1 dan F1.2 independen dan boleh dikerjakan paralel.
- F1.3 menunggu F1.1 dan F1.2 selesai.
- F1.4 menunggu F1.3 selesai.
- F1 dinyatakan selesai hanya setelah F1.4 lulus gate.
- Setiap milestone memiliki migration, acceptance, dan gate sendiri. Jangan
  memulai milestone berikutnya sebelum gate sebelumnya lulus, kecuali F1.1 dan
  F1.2 yang boleh paralel.

### 4.3 F1.1 — Menu & Master Data

#### Deliverable

- Migrasi `menu_categories`, `products`, `modifier_groups`,
  `modifier_options`, `product_modifier_groups`.
- Seed empat kategori utama: Food, Drinks, Desserts, Packages sebagai master
  data, bukan data demo.
- Admin CRUD kategori, produk, modifier, dan relasi produk–modifier.
- Upload/foto produk dan placeholder untuk produk tanpa foto.
- Field produk: nama, kategori, harga, foto, deskripsi opsional, SKU opsional,
  status aktif, status ketersediaan, stasiun dapur opsional, urutan tampil.
- Modifier: level pedas, ukuran, topping, catatan khusus; grup wajib/opsional,
  minimum/maksimum pilihan, selisih harga, urutan, status aktif.
- Validasi server untuk modifier wajib/opsional dan batas pilihan.
- RLS, grant, index, dan audit master data.
- Tidak ada tabel pesanan, pembayaran, KDS, atau antrean pada milestone ini.

#### Migration

| File usulan | Isi |
| --- | --- |
| `supabase/migrations/20261111000100_menu_master.sql` | Kategori, produk, modifier, produk–modifier, seed empat kategori, RLS, index, constraint harga |

#### Dependency

- F0 selesai.
- `profiles` dan `restaurant_settings` tersedia.
- Storage bucket untuk foto produk disiapkan bila memakai Supabase Storage.

#### Acceptance criteria

- Admin dapat membuat, mengubah, menonaktifkan, dan mengurutkan kategori.
- Empat kategori utama tersedia dan bukan data demo.
- Admin dapat membuat produk dengan foto, nama, harga, modifier, status aktif,
  status ketersediaan, dan stasiun dapur opsional.
- Admin dapat mengelola grup/opsi modifier dan menghubungkannya ke produk.
- Modifier wajib/opsional dan batas pilihan tervalidasi di server.
- Produk tanpa foto memakai placeholder yang konsisten.
- Produk nonaktif/tidak tersedia tidak dapat dipesan; pengujian dari POS
  dilakukan pada F1.3.
- RLS dan grant diuji; audit perubahan master data tercatat.
- Tidak ada tabel atau data transaksi pesanan pada F1.1.

#### Gate

- Migration F1.1 dijalankan dan ditinjau di development.
- CRUD kategori/produk/modifier PASS.
- Typecheck, lint, dan build PASS.
- Tidak ada data transaksi contoh.
- Tidak ada tiket KDS atau nomor antrean.

### 4.4 F1.2 — Meja & Denah

#### Deliverable

- Migrasi `table_zones` dan `dining_tables`.
- Admin CRUD zona dan meja: nomor/nama, kapasitas, zona, posisi x/y, bentuk,
  status aktif.
- Zona wajib dipilih; default **Utama** bila belum diatur.
- Editor denah meja admin dengan **drag-and-drop** untuk posisi, kapasitas, dan
  zona; layout dapat disimpan dan diterbitkan.
- Denah meja interaktif: posisi, kapasitas, zona, dan status.
- Denah dapat merender tiga status: **Kosong**, **Menunggu Pembayaran**,
  **Terisi**.
- Soft delete/nonaktif untuk meja yang memiliki riwayat; tidak dihapus permanen.
- RLS, grant, index, dan audit perubahan layout.
- Tidak ada `dining_sessions`, pesanan, pembayaran, KDS, atau nomor antrean pada
  milestone ini.

#### Migration

| File usulan | Isi |
| --- | --- |
| `supabase/migrations/20261111000200_tables_layout.sql` | Zona meja, meja, posisi/kapasitas/bentuk, status, layout, RLS, index |

#### Dependency

- F0 selesai.
- Boleh berjalan paralel dengan F1.1.

#### Acceptance criteria

- Admin dapat mengatur zona, meja, kapasitas, posisi x/y, bentuk, dan layout.
- Zona default **Utama** tersedia; zona dengan meja aktif tidak dapat
  dinonaktifkan.
- Admin dapat menggeser meja dengan drag-and-drop, menyimpan, dan menerbitkan
  layout.
- Layout yang disimpan tetap sama setelah reload dan terlihat oleh kasir.
- Denah dapat merender status **Kosong**, **Menunggu Pembayaran**, dan
  **Terisi** dari data uji terkontrol.
- Transisi nyata **Kosong → Menunggu Pembayaran** dan kembali **Kosong** setelah
  pembatalan diuji pada F1.3.
- Transisi nyata ke **Terisi** diuji pada F2 karena memerlukan pembayaran.
- Meja dengan riwayat tidak dihapus permanen; dinonaktifkan.
- Tidak ada pesanan, KDS, atau nomor antrean pada F1.2.

#### Gate

- Migration F1.2 dijalankan dan ditinjau di development.
- Layout tersimpan/terbit dan bertahan setelah reload.
- Tiga status meja ter-render pada denah.
- Typecheck, lint, build, dan E2E F1.2 PASS.
- Tidak ada tiket KDS atau nomor antrean.

### 4.5 F1.3 — POS Core, Kunjungan & Pesanan

#### Deliverable

- Migrasi `dining_sessions`, `orders`, `order_items`, dan
  `order_item_modifiers` dengan `dining_session_id` dan idempotency key.
- POS dua bagian: kategori/produk di kiri, keranjang/total di kanan.
- Pencarian produk dan kartu produk: foto, nama, harga, status.
- Modifier: level pedas, ukuran, topping, catatan khusus; perubahan harga
  terlihat di keranjang.
- Pilihan dine-in/takeaway; pemilihan meja dari denah untuk dine-in.
- Satu meja hanya memiliki satu kunjungan dine-in aktif; satu kunjungan dapat
  memiliki beberapa pesanan.
- Simpan pesanan → status **Menunggu Pembayaran**; meja → **Menunggu
  Pembayaran**.
- Penambahan item sebelum lunas dilakukan pada pesanan yang sama, bukan membuat
  pesanan baru.
- Pembuatan pesanan idempotent; klik ganda/retry tidak membuat pesanan ganda.
- Pembatalan pesanan **Menunggu Pembayaran** tanpa pembayaran: kasir/admin,
  alasan wajib, konfirmasi, audit, dan dampak meja sesuai FR-POS-11.
- Tutup kunjungan dan kosongkan meja setelah semua pesanan dibatalkan dan tidak
  ada pembayaran tertunda; alur penutupan setelah pembayaran diuji pada F2.
- Handoff ke pembayaran F2: konfirmasi **Menunggu Pembayaran** dan CTA
  pembayaran nonaktif/placeholder; tidak ada pencatatan pembayaran.
- Guard role: hanya admin/kasir.
- Tidak ada tiket KDS atau nomor antrean.

#### Migration

| File usulan | Isi |
| --- | --- |
| `supabase/migrations/20261111000300_orders_pos.sql` | Kunjungan dine-in, pesanan, item, modifier item, pembatalan, snapshot, idempotency, satu sesi aktif per meja, RLS, index |

#### Dependency

- F1.1 selesai (produk, modifier, harga).
- F1.2 selesai (zona, meja, layout).
- `profiles` dan `restaurant_settings` tersedia.

#### Acceptance criteria

- Kasir dapat mencari produk dan menambahkannya ke keranjang.
- Modifier wajib/opsional tervalidasi di server; harga keranjang berubah sesuai
  modifier.
- Dine-in mewajibkan meja; takeaway tidak memakai meja atau kunjungan.
- Satu meja hanya memiliki satu kunjungan dine-in aktif.
- Satu kunjungan dapat menampung lebih dari satu pesanan tanpa menggandakan
  kunjungan.
- Pesanan tersimpan sebagai **Menunggu Pembayaran**; tidak ada KDS/antrean.
- Penambahan item sebelum lunas tidak membuat pesanan baru.
- Klik ganda/retry simpan pesanan tidak membuat pesanan ganda.
- Kasir/admin dapat membatalkan pesanan **Menunggu Pembayaran** tanpa pembayaran
  dengan alasan wajib; kitchen tidak dapat membatalkan; pembatalan tercatat di
  audit dan pesanan tidak dapat diaktifkan kembali.
- Setelah pembatalan, meja kembali **Kosong** hanya bila tidak ada pesanan aktif
  lain dan tidak ada pembayaran tertunda; bila ada, status meja mengikuti
  pesanan yang tersisa.
- Kunjungan dapat ditutup dan meja kembali **Kosong** setelah semua pesanan
  dibatalkan dan tidak ada pembayaran tertunda.
- Setelah simpan, konfirmasi **Menunggu Pembayaran** tampil dengan CTA
  pembayaran nonaktif/placeholder; tidak ada baris pembayaran yang dibuat.
- F1.3 tidak menghasilkan tiket KDS atau nomor antrean.
- Typecheck, lint, build, dan E2E F1.3 PASS.

#### Gate

- Migration F1.3 dijalankan dan ditinjau di development.
- Satu kunjungan aktif per meja dan beberapa pesanan per kunjungan terbukti.
- Pembatalan pesanan belum lunas, audit, dan dampak meja terbukti.
- Handoff ke pembayaran tidak mencatat pembayaran dan tidak membuat dead-end.
- Tidak ada tiket KDS atau nomor antrean.
- Typecheck, lint, build, dan E2E F1.3 PASS.

### 4.6 F1.4 — Diskon & Finalisasi

#### Deliverable

- Migrasi `order_discounts` dengan jenis, cakupan, nilai, alasan, status
  approval, approver, snapshot, dan audit.
- Perhitungan subtotal, diskon produk, diskon pesanan, diskon manual, pajak,
  service charge, dan grand total.
- Diskon produk dihitung per baris; diskon pesanan dihitung setelah diskon
  produk; diskon manual dihitung setelah diskon produk dan diskon pesanan.
- Diskon manual memerlukan alasan dan approval admin; diskon yang belum
  disetujui tidak boleh diterapkan pada pesanan.
- Layar/aksi approval diskon manual untuk admin, termasuk penolakan dan audit.
- Kasir tidak dapat mengubah harga produk secara bebas; harga berasal dari
  master produk dan hanya admin yang dapat mengubahnya.
- Semua diskon tersimpan pada transaksi dan tercatat di audit log, termasuk
  jenis, nilai, alasan, dan approver.
- Pajak dan service charge dihitung setelah seluruh diskon; total diskon tidak
  boleh melebihi subtotal pesanan sebelum diskon.
- E2E F1 dan hardening seluruh alur F1.1–F1.4.

#### Migration

| File usulan | Isi |
| --- | --- |
| `supabase/migrations/20261111000400_discounts.sql` | Diskon produk/pesanan/manual, approval diskon, snapshot diskon, audit, constraint nilai, RLS, index |

#### Dependency

- F1.3 selesai.

#### Acceptance criteria

- Diskon produk, diskon pesanan, dan diskon manual tersedia.
- Diskon manual memerlukan alasan dan approval admin; diskon yang belum
  disetujui tidak diterapkan pada pesanan.
- Admin dapat menyetujui atau menolak diskon manual; penolakan dan approval
  tercatat di audit.
- Kasir tidak dapat mengubah harga produk secara bebas.
- Diskon produk dihitung per baris, diskon pesanan setelah diskon produk,
  diskon manual setelah diskon pesanan, dan pajak/service charge setelah seluruh
  diskon.
- Diskon pesanan tidak melebihi subtotal setelah diskon produk; diskon manual
  tidak melebihi subtotal setelah diskon produk dan diskon pesanan.
- Total diskon tidak melebihi subtotal pesanan sebelum diskon dan seluruh
  diskon tercatat di transaksi serta audit log.
- Seluruh acceptance F1.1–F1.4 lulus.
- Tidak ada tiket KDS atau nomor antrean pada F1.
- Typecheck, lint, build, dan E2E F1 PASS.

#### Gate

- Migration F1.4 dijalankan dan ditinjau di development.
- Diskon tanpa approval ditolak; total dan pajak/service benar.
- Seluruh acceptance F1 dari PRD lulus.
- Typecheck, lint, build, dan E2E F1 PASS.
- Persetujuan user diperoleh sebelum F2 dimulai.

### 4.7 Migration F1

| Milestone | File usulan | Isi |
| --- | --- | --- |
| F1.1 | `supabase/migrations/20261111000100_menu_master.sql` | Kategori, produk, modifier, produk–modifier, seed empat kategori, RLS, index |
| F1.2 | `supabase/migrations/20261111000200_tables_layout.sql` | Zona meja, meja, posisi/kapasitas/bentuk, layout, RLS, index |
| F1.3 | `supabase/migrations/20261111000300_orders_pos.sql` | Kunjungan dine-in, pesanan, item, modifier item, pembatalan, snapshot, idempotency, satu sesi aktif per meja |
| F1.4 | `supabase/migrations/20261111000400_discounts.sql` | Diskon produk/pesanan/manual, approval diskon, snapshot, audit, constraint nilai |

File belum dibuat. Setiap migrasi harus:

- mengaktifkan RLS,
- memberi grant sesuai peran,
- membuat index status/tanggal/meja/kunjungan,
- memiliki constraint harga dan jumlah,
- memiliki unique constraint untuk satu kunjungan aktif per meja dan
  idempotency key pesanan,
- menyimpan snapshot diskon dan approver diskon manual,
- tidak membuat transaksi contoh,
- dijalankan berurutan sesuai milestone.

### 4.8 Gate dan dependency F1

- F1.1 dan F1.2 tidak boleh saling menunggu, tetapi keduanya harus lulus gate
  sebelum F1.3 dimulai.
- F1.3 tidak boleh dianggap selesai bila pesanan belum lunas bisa masuk KDS,
  memiliki nomor antrean, atau handoff pembayaran mencatat pembayaran.
- F1.4 tidak boleh dianggap selesai bila diskon manual bisa diterapkan tanpa
  approval atau total diskon/pajak salah.
- F1 tidak boleh membuat tiket KDS atau nomor antrean.
- F1 harus membuktikan satu kunjungan aktif per meja dan beberapa pesanan per
  kunjungan.
- F1 harus membuktikan pembatalan pesanan belum lunas memiliki role, alasan,
  audit, dan dampak meja yang benar.
- F1 harus membuktikan denah dapat merender tiga status meja; transisi nyata ke
  **Terisi** diuji di F2.

### 4.9 Yang tidak termasuk F1

- Pembayaran dan split bill.
- Nomor antrean.
- KDS.
- Papan antrean real-time.
- Perilaku pesanan tambahan **setelah pembayaran**; model data dan kunjungan
  disiapkan di F1.3, alur transaksinya diuji di F2.
- Pembatalan pesanan **Sebagian Dibayar**; baru dijalankan di F2 setelah refund
  bagian disetujui dan dicatat admin.
- Stok, shift, laporan.

---

## 5. F2 — Pembayaran, split bill, pesanan tambahan, antrean, dan struk

### 5.1 Tujuan

Kasir dapat menerima pembayaran penuh atau split bill. Setelah lunas, sistem
membuat nomor antrean dan tiket KDS. Pesanan tambahan setelah pembayaran
mendapat nomor antrean baru tanpa menggandakan transaksi.

### 5.2 Deliverable

- Migrasi `payments`, `refunds`, dan kolom pembayaran/antrean pada `orders`.
- Pembayaran tunai dengan kembalian.
- Pembayaran QRIS Manual (`qris_manual`) dan QRIS Midtrans
  (`qris_midtrans`) sebagai sumber berbeda.
- Pembayaran transfer manual dengan referensi.
- Midtrans Snap + webhook terverifikasi.
- Split bill: beberapa pembayaran untuk satu pesanan, termasuk campuran sumber.
  Setiap bagian pembayaran online Midtrans memakai transaksi gateway sendiri
  dengan `midtrans_order_id` unik; callback diproses idempoten dan tidak membuat
  pembayaran ganda.
- Validasi total pembayaran: tidak boleh melebihi grand total; uang tunai
  berlebih dicatat sebagai kembalian, bukan nilai pembayaran.
- Status pembayaran: Belum Dibayar, Sebagian, Lunas, Refund Sebagian, Refund
  Penuh.
- Pembayaran dimulai dari pesanan **Menunggu Pembayaran** hasil handoff F1.3;
  F2 memakai `order_id` yang sama dan tidak membuat pesanan/kunjungan baru.
- Transisi meja ke **Terisi** setelah semua pesanan aktif lunas.
- Pembatalan pesanan **Sebagian Dibayar** setelah refund bagian disetujui dan
  dicatat admin; pesanan menjadi **Dibatalkan** tanpa antrean/KDS.
- Nomor antrean harian `A001` setelah lunas.
- Pesanan tambahan setelah pembayaran: pesanan baru, nomor antrean baru, tetap
  pada meja dan `dining_session_id` yang sama; idempotent dan tanpa antrean
  ganda.
- Pembuatan tiket KDS setelah lunas (data disiapkan pada F2; tampilan KDS
  dibangun pada F3).
- Struk 58/80 mm dicetak melalui **browser print** dengan label sumber
  pembayaran dan rincian diskon. Integrasi ESC/POS atau printer thermal khusus
  tidak diwajibkan pada F2.
- Cetak ulang struk/nomor antrean dengan audit.
- Refund admin; refund penuh setelah pesanan lunas memerlukan approval admin.
  Bila tiket KDS masih aktif, tiket dihentikan dan waktu notifikasi dapur dicatat
  pada F2; tabel dan tampilan notifikasi dibangun pada F3.
- Penutupan kunjungan dan pengosongan meja hanya setelah semua pesanan
  selesai/dibatalkan/direfund penuh dan tidak ada pembayaran tertunda; pesanan
  Lunas yang belum diambil tetap menghalangi penutupan.
- Pencatatan dampak kas/shift refund diselesaikan pada F5.
- Idempotensi webhook, pembayaran, transaksi gateway split bill, pesanan
  tambahan, dan pembuatan nomor antrean.
- Audit pembayaran, split bill, transaksi gateway Midtrans, diskon, refund,
  approval, dan notifikasi dapur.

### 5.3 Migration

| File usulan | Isi |
| --- | --- |
| `supabase/migrations/20261112000100_payments_queue.sql` | Pembayaran, sumber/channel, transaksi gateway per pembayaran online, `midtrans_order_id` unik, `gateway_transaction_id`, refund approval + waktu notifikasi, kolom antrean/status, idempotency, index, RLS |

### 5.4 Dependency

- F1.4 selesai dan seluruh acceptance F1 lulus.
- `daily_sequences` tersedia.
- `dining_sessions` dan `orders` dari F1.3 tersedia.
- Kredensial Midtrans Sandbox/Production.
- `restaurant_settings` untuk pajak, service charge, struk.

### 5.5 Acceptance criteria

- Tunai, QRIS Manual, QRIS Midtrans, transfer, dan Midtrans dapat dicatat.
- QRIS Manual dan QRIS Midtrans tersimpan serta tampil sebagai sumber berbeda
  di struk, detail pembayaran, laporan, dan audit.
- Split bill mencatat lebih dari satu pembayaran dan boleh mencampur sumber.
- Setiap pembayaran online Midtrans pada split bill memiliki transaksi gateway
  sendiri dengan `midtrans_order_id` unik.
- Callback/webhook duplikat tidak membuat pembayaran ganda atau melunasi dua
  baris pembayaran.
- Total pembayaran tidak boleh melebihi grand total; uang tunai berlebih
  dicatat sebagai kembalian.
- Pesanan baru lunas saat total pembayaran = grand total.
- Transisi nyata meja ke **Terisi** setelah semua pesanan aktif lunas terbukti
  pada F2.
- Pembatalan pesanan **Sebagian Dibayar** hanya berjalan setelah refund bagian
  disetujui dan dicatat admin; pesanan menjadi **Dibatalkan** dan tidak ada
  antrean/KDS yang perlu dihentikan.
- Nomor antrean dibuat tepat sekali setelah lunas.
- Nomor antrean unik per tanggal Jakarta.
- Tiket KDS dibuat setelah lunas.
- Pesanan belum lunas tidak memiliki nomor antrean/tiket KDS.
- Pesanan tambahan setelah pembayaran mendapat nomor antrean baru, tetap pada
  kunjungan yang sama, dan tidak membuat pesanan/antrean ganda.
- Midtrans hanya valid setelah webhook signature valid dan status diverifikasi.
- Struk dapat dicetak melalui browser print pada layout 58 mm dan 80 mm,
  menampilkan sumber pembayaran, rincian diskon, dan approver diskon manual bila
  ada.
- Integrasi ESC/POS atau printer thermal khusus tidak diwajibkan pada F2.
- Refund penuh setelah lunas tidak dapat diproses tanpa approval admin. Bila
  tiket KDS masih aktif, setelah disetujui tiket dihentikan dan waktu notifikasi
  dapur tercatat. Tampilan notifikasi dapur diuji pada F3. Semua aksi refund,
  approval, penghentian tiket, dan notifikasi tercatat di audit.
- Refund admin tercatat; bila modul shift sudah aktif, refund tunai memengaruhi
  shift.
- Pesanan yang dibatalkan/direfund penuh tidak lagi menghalangi penutupan
  kunjungan; pesanan Lunas yang belum diambil tetap menghalangi.
- Typecheck, lint, build, dan E2E F2 PASS.

### 5.6 Gate ke F3

F2 harus selesai dan terbukti bahwa:

- pesanan belum lunas tidak masuk KDS,
- pesanan lunas selalu mendapat nomor antrean,
- split bill dan pesanan tambahan tidak membuat antrean ganda,
- setiap pembayaran online Midtrans pada split bill memakai transaksi gateway
  terpisah dan callback duplikat tidak membuat pembayaran ganda,
- total pembayaran tidak melebihi grand total dan kembalian tunai tercatat
  terpisah,
- QRIS Manual dan QRIS Midtrans dapat dibedakan pada data dan struk,
- struk 58 mm dan 80 mm dapat dicetak melalui browser print,
- refund penuh setelah lunas hanya berjalan melalui approval admin,
- transisi meja ke **Terisi** terbukti setelah semua pesanan aktif lunas,
- pembatalan **Sebagian Dibayar** hanya berjalan setelah refund bagian
  disetujui/dicatat admin.

---

## 6. F3 — KDS dan papan antrean

### 6.1 Tujuan

Dapur memproses pesanan lunas melalui tiga status, dan pelanggan melihat status
antrean tanpa data pribadi.

### 6.2 Deliverable

- Migrasi kolom/riwayat status KDS, index realtime, dan `kitchen_notifications`.
- KDS hanya menampilkan pesanan lunas.
- Tiga kolom/status: Pesanan Masuk, Sedang Disiapkan, Siap Diambil.
- Aksi mulai menyiapkan dan menandai siap.
- Waktu masuk/mulai/siap.
- Filter stasiun dapur.
- Realtime + fallback polling.
- Papan antrean publik `/queue` dengan nomor dan status.
- Konfirmasi pengambilan oleh **kasir/admin**, bukan kitchen.
- Penghapusan tiket dari KDS setelah pengambilan dikonfirmasi.
- Notifikasi dapur saat refund penuh setelah lunas disetujui dan tiket masih
  aktif; notifikasi bukan status KDS keempat.
- Override tutup meja oleh admin hanya setelah pesanan aktif/pembayaran tertunda
  diselesaikan; konfirmasi dan audit.
- Audit transisi status, pengambilan, penghentian tiket, notifikasi, dan override
  tutup meja.
- Perbaikan copy placeholder kitchen/queue/POS agar sesuai alur baru.

### 6.3 Migration

| File usulan | Isi |
| --- | --- |
| `supabase/migrations/20261113000100_kds_queue.sql` | Status KDS, riwayat, index, view papan antrean, notifikasi dapur, RLS |

### 6.4 Dependency

- F2 selesai.
- Tiket KDS sudah dibuat saat lunas.
- Nomor antrean sudah tersedia.
- Refund approval dan waktu notifikasi dapur dari F2 tersedia.

### 6.5 Acceptance criteria

- KDS hanya menampilkan pesanan lunas.
- KDS memiliki tepat tiga status.
- Tidak ada kolom Selesai/Diambil/Disajikan.
- Kitchen hanya dapat mengubah status sampai Siap Diambil.
- Kitchen tidak memiliki aksi konfirmasi pengambilan.
- Kasir/admin dapat mengonfirmasi pengambilan; pesanan menjadi Selesai dan
  hilang dari KDS.
- Pesanan Selesai tidak lagi menghalangi penutupan kunjungan.
- Perpindahan status tervalidasi dan tercatat.
- Refund penuh yang disetujui atas pesanan dengan tiket KDS aktif menghentikan
  tiket, menghapusnya dari papan aktif, dan mengirim notifikasi ke dapur.
- Papan antrean menampilkan nomor dan status tanpa nama/telepon/meja/nominal.
- Pesanan selesai atau direfund penuh hilang dari KDS dan papan antrean.
- Override tutup meja tidak meninggalkan pesanan aktif/pembayaran tertunda;
  aksi dikonfirmasi dan diaudit.
- Realtime bekerja; fallback polling tersedia.
- Typecheck, lint, build, dan E2E F3 PASS.

### 6.6 Larangan

- Jangan menambah status KDS keempat.
- Jangan memberi kitchen aksi konfirmasi pengambilan atau status Selesai.
- Jangan menampilkan pesanan belum lunas di KDS.
- Jangan menampilkan data pelanggan/keuangan di `/queue`.
- Jangan membuat QR ordering.

---

## 7. F4 — Stok dan bahan baku

### 7.1 Tujuan

Mengaitkan menu dengan bahan baku dan mengurangi stok berdasarkan penjualan.

### 7.2 Deliverable

- Migrasi `ingredients`, `recipes`, `stock_movements`.
- Admin mengelola bahan baku dan resep.
- Pengurangan stok saat pesanan lunas/disiapkan sesuai kebijakan.
- Penyesuaian stok manual dengan alasan dan audit.
- Peringatan stok rendah.
- Laporan pemakaian bahan baku.

### 7.3 Dependency

- F1 menu/produk selesai.
- F2 pembayaran selesai agar pengurangan stok terhubung ke transaksi lunas.
- F3 tidak wajib, tetapi urutan roadmap tetap F3 → F4.

### 7.4 Acceptance criteria

- Resep terhubung ke produk.
- Penjualan mengurangi stok sesuai resep.
- Penyesuaian stok tercatat dan diaudit.
- Stok rendah terlihat admin.
- Tidak ada data stok contoh.

---

## 8. F5 — Shift dan kas

### 8.1 Tujuan

Mengelola shift kasir, kas drawer, dan rekonsiliasi pembayaran tunai.

### 8.2 Deliverable

- Migrasi `shifts`, `cash_movements`.
- Buka/tutup shift.
- Kas awal, kas masuk, kas keluar, kas akhir.
- Rekonsiliasi tunai.
- Refund tunai memengaruhi shift aktif.
- Tanpa shift aktif, admin dapat mencatat pengeluaran tunai di luar shift.
- Audit shift dan kas.

### 8.3 Dependency

- F2 pembayaran selesai.
- F4 tidak wajib, tetapi urutan roadmap tetap F4 → F5.

### 8.4 Acceptance criteria

- Kasir dapat membuka/menutup shift.
- Pembayaran tunai terhubung ke shift.
- Refund tunai mengurangi kas shift.
- Selisih kas terlihat dan dapat direkonsiliasi.
- Audit lengkap.

---

## 9. F6 — Laporan dan audit lanjutan

### 9.1 Tujuan

Menyediakan laporan operasional dan keuangan yang dapat diekspor.

### 9.2 Deliverable

- Laporan penjualan harian/periode.
- Laporan per kategori/produk.
- Laporan pembayaran dan split bill.
- Laporan refund.
- Laporan stok.
- Laporan shift.
- Export CSV/Excel.
- Audit lanjutan dan filter.
- Penyempurnaan performa/UX.

### 9.3 Dependency

- F1–F5 selesai.
- Data transaksi nyata tersedia.

### 9.4 Acceptance criteria

- Laporan dapat difilter tanggal.
- Total laporan cocok dengan data transaksi.
- Export berhasil.
- Audit dapat difilter.
- Tidak ada data Sandbox di laporan production.

---

## 10. Dependency graph

```text
F0 (fondasi)
  ├─ F1.1 (menu & master data)
  └─ F1.2 (meja & denah)
        └─ F1.3 (POS core, kunjungan & pesanan)   ← menunggu F1.1 + F1.2
             └─ F1.4 (diskon & finalisasi)
                  └─ F2 (pembayaran, sumber QRIS, split bill Midtrans per transaksi gateway, pesanan tambahan, antrean, browser print 58/80 mm, refund)
                       └─ F3 (KDS tiga status, papan antrean, pengambilan oleh kasir/admin, notifikasi refund)
                            └─ F4 (stok, bahan baku)
                                 └─ F5 (shift, kas)
                                      └─ F6 (laporan, audit lanjutan)
```

Aturan gate:

- F1.1 dan F1.2 boleh paralel, tetapi keduanya harus lulus gate sebelum F1.3.
- F1.1 tidak boleh membuat tabel pesanan, pembayaran, KDS, atau antrean.
- F1.2 harus membuktikan layout tersimpan/terbit dan tiga status meja
  ter-render; transisi nyata ke **Terisi** diuji di F2.
- F1.3 tidak boleh membuat tiket KDS, nomor antrean, atau mencatat pembayaran.
- F1.3 harus membuktikan satu kunjungan aktif per meja dan beberapa pesanan per
  kunjungan.
- F1.3 harus membuktikan pembatalan pesanan belum lunas memiliki role, alasan,
  audit, dan dampak meja yang benar.
- F1.4 harus membuktikan diskon manual tidak dapat diterapkan tanpa approval
  serta perhitungan diskon/pajak/service benar.
- F1 tidak boleh membuat tiket KDS.
- F2 tidak boleh dianggap selesai bila pesanan belum lunas bisa masuk KDS.
- F2 harus membuktikan pesanan tambahan tidak membuat pesanan/antrean ganda.
- F2 harus membuktikan QRIS Manual dan QRIS Midtrans tercatat terpisah.
- F2 harus membuktikan setiap pembayaran online Midtrans pada split bill memakai
  transaksi gateway sendiri dan callback duplikat tidak membuat pembayaran ganda.
- F2 harus membuktikan total pembayaran tidak melebihi grand total dan struk
  58/80 mm dapat dicetak melalui browser print.
- F2 harus membuktikan refund penuh setelah lunas hanya berjalan lewat approval
  admin.
- F2 harus membuktikan transisi meja ke **Terisi** dan pembatalan
  **Sebagian Dibayar** setelah refund bagian disetujui/dicatat admin.
- F3 tidak boleh dimulai sebelum F2 lulus gate.
- F4–F6 tidak boleh menghapus fitur F0–F3.

---

## 11. Rencana migrasi

| Fase | File usulan | Status |
| --- | --- | --- |
| F0 | `20261110000100_foundation.sql` | **Ada dan sudah dijalankan** |
| F1.1 | `20261111000100_menu_master.sql` | Belum dibuat |
| F1.2 | `20261111000200_tables_layout.sql` | Belum dibuat |
| F1.3 | `20261111000300_orders_pos.sql` | Belum dibuat |
| F1.4 | `20261111000400_discounts.sql` | Belum dibuat |
| F2 | `20261112000100_payments_queue.sql` | Belum dibuat |
| F3 | `20261113000100_kds_queue.sql` | Belum dibuat |
| F4 | `20261114000100_inventory.sql` | Belum dibuat |
| F5 | `20261115000100_shifts.sql` | Belum dibuat |
| F6 | `20261116000100_reporting.sql` | Belum dibuat |

Setiap migrasi wajib:

1. Ditinjau sebelum dijalankan.
2. Diuji di development.
3. Membuat backup sebelum production.
4. Memiliki RLS dan grant.
5. Tidak membuat data transaksi contoh.
6. Dijalankan berurutan.

---

## 12. Matriks requirement lama vs fase

| Requirement | Fase | Status roadmap |
| --- | --- | --- |
| Auth, role, sesi, rate limit | F0 | Selesai |
| Manajemen pengguna dan audit | F0 | Selesai |
| Reset password admin | F0 | Selesai |
| Menu, kategori, produk | F1.1 | Rencana |
| Modifier dan harga | F1.1 | Rencana |
| Foto produk dan ketersediaan | F1.1 | Rencana |
| Editor denah meja drag-and-drop: posisi, kapasitas, zona | F1.2 | **Wajib** |
| Zona meja dan layout terbit | F1.2 | **Wajib** |
| Denah merender tiga status meja | F1.2 | **Wajib** |
| POS dua bagian | F1.3 | Rencana |
| Dine-in/takeaway | F1.3 | Rencana |
| Satu kunjungan aktif per meja; beberapa pesanan per kunjungan | F1.3 | **Wajib** |
| Pesanan dan item + idempotency | F1.3 | Rencana |
| Pembatalan pesanan belum lunas: role, alasan, audit, dampak meja | F1.3 | **Wajib** |
| Handoff POS ke pembayaran F2 | F1.3/F2 | **Wajib** |
| Transisi nyata meja ke **Terisi** | F2 | **Wajib** |
| Diskon produk, diskon pesanan, diskon manual + approval admin | F1.4 | **Wajib** |
| Kasir tidak dapat mengubah harga produk secara bebas | F1.1/F1.4 | **Wajib** |
| Diskon tercatat di transaksi dan audit; pajak/service setelah diskon | F1.4 | **Wajib** |
| Pembayaran tunai/QRIS Manual/QRIS Midtrans/transfer/Midtrans | F2 | Rencana |
| QRIS Manual vs QRIS Midtrans sebagai sumber berbeda | F2 | **Wajib** |
| Split bill lintas sumber pembayaran | F2 | **Wajib** |
| Split bill Midtrans: transaksi gateway terpisah per pembayaran online | F2 | **Wajib** |
| Callback Midtrans idempoten; total pembayaran tidak melebihi tagihan | F2 | **Wajib** |
| Pesanan tambahan: antrean baru, kunjungan sama, anti-duplikasi | F2 | **Wajib** |
| Nomor antrean A001 | F2 | Rencana |
| Browser print struk 58/80 mm + label sumber pembayaran | F2 | **Wajib** |
| Integrasi ESC/POS/printer thermal khusus | Fase berikutnya | **Ditunda** |
| Refund penuh setelah lunas: approval admin + notifikasi dapur bila tiket aktif | F2/F3 | **Wajib** |
| Refund dan shift | F2/F5 | Rencana |
| KDS tiga status | F3 | Rencana |
| Kitchen berhenti di Siap Diambil; kasir/admin konfirmasi pengambilan | F3 | **Wajib** |
| Papan antrean publik | F3 | Rencana |
| Stok, bahan baku, resep | F4 | Rencana |
| Shift, kas drawer, rekonsiliasi | F5 | Rencana |
| Laporan, export, audit lanjutan | F6 | Rencana |
| QR ordering | — | **Dilarang** |

---

## 13. Risiko dan mitigasi

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Pembayaran dan pembuatan antrean tidak atomik | Antrean ganda/hilang | Transaksi DB + unique constraint + idempotensi |
| Klik ganda/retry saat simpan pesanan | Pesanan/antrean ganda | Idempotency key + unique constraint + transaksi DB |
| Pesanan tambahan dianggap pesanan baru lepas dari kunjungan | Meja/kunjungan ganda | Wajib `dining_session_id`; satu sesi aktif per meja |
| Webhook Midtrans duplikat | Pembayaran ganda | Idempotency key dan cek status transaksi |
| Satu transaksi gateway dipakai untuk dua baris split bill | Pembayaran ganda/lunas palsu | `midtrans_order_id` unik per pembayaran online + validasi server |
| Total pembayaran split bill melebihi tagihan | Kelebihan bayar/selisih kas | Validasi sisa tagihan di server; kembalian tunai disimpan terpisah |
| Diskon manual disalahgunakan | Kebocoran pendapatan | Wajib alasan + approval admin; batas diskon; audit lengkap |
| Diskon melebihi subtotal sebelum diskon | Grand total negatif | Validasi server + constraint nilai diskon |
| Kasir mengubah harga produk | Harga tidak konsisten | Harga hanya dari master produk; perubahan harga khusus admin + audit |
| QRIS Manual dan QRIS Midtrans tercampur | Laporan/rekonsiliasi salah | Kolom sumber/channel wajib + label struk/laporan/audit |
| Split bill membingungkan | Salah hitung | Ringkasan sisa tagihan dan validasi server |
| F1 terlalu besar untuk satu delivery | Demo terlambat, bug sulit dilacak | Pecah F1.1–F1.4 dengan acceptance dan gate terpisah |
| F1.3 menunggu F1.1/F1.2 terlalu lama | POS tidak bisa diuji | F1.1 dan F1.2 independen/paralel; gate masing-masing jelas |
| Denah meja terlalu kompleks | F1.2 molor | Scope editor jelas; drag-and-drop dasar; zona wajib sederhana |
| Status **Terisi** dianggap tercapai di F1 | Acceptance palsu | F1.2 hanya merender tiga status; transisi nyata ke Terisi diuji F2 |
| Handoff F1 ke pembayaran berakhir dead-end | Kasir tidak bisa melanjutkan | Konfirmasi Menunggu Pembayaran + CTA placeholder + kembali ke POS/denah |
| Pembatalan pesanan belum lunas disalahgunakan | Kehilangan pesanan/pendapatan | Role kasir/admin, alasan wajib, konfirmasi, audit, pesanan final |
| Meja dikosongkan saat masih ada pesanan/pembayaran | Meja ganda/kehilangan tagihan | Cek pesanan aktif dan pembayaran tertunda sebelum tutup kunjungan |
| Pembatalan **Sebagian Dibayar** sebelum refund dicatat | Dana tidak konsisten | F1 hanya membatalkan tanpa pembayaran; F2 menunggu refund bagian disetujui/dicatat admin |
| KDS menampilkan pesanan belum lunas | Makanan diproses tanpa bayar | Query wajib filter lunas + test |
| Data pelanggan bocor di `/queue` | Privasi | Query khusus tanpa kolom sensitif + test |
| Status KDS bertambah | Tidak sesuai keputusan | Kontrak tiga status + review |
| Kitchen mengonfirmasi pengambilan | Status/otoritas tidak sesuai | Aksi pengambilan hanya untuk kasir/admin + test role |
| Refund setelah lunas tanpa approval | Tiket menggantung/penyalahgunaan | Approval admin wajib; hentikan tiket bila masih aktif; notifikasi dapur; audit |
| Printer thermal belum siap | Struk tidak tercetak | Browser print 58/80 mm pada F2; integrasi printer khusus ditunda |
| Layout browser print tidak konsisten di 58/80 mm | Struk sulit dibaca | Template terpisah, uji cetak nyata, dan verifikasi acceptance F2 |

---

## 14. Definition of done per fase

Sebuah fase dianggap selesai bila:

- Semua deliverable fase terpenuhi.
- Migration sudah dijalankan di development dan ditinjau.
- RLS dan otorisasi server diuji.
- Acceptance criteria fase PASS.
- `npm run typecheck`, `npm run lint`, dan `npm run build` PASS.
- E2E/verifikasi fase PASS.
- Tidak ada data uji/akun uji yang tertinggal.
- README/PRD diperbarui bila ada keputusan baru.
- Tidak ada fitur fase sebelumnya yang rusak.
- Persetujuan user diperoleh sebelum fase berikutnya.

Untuk F1, definition of done berlaku **per milestone**:

- F1.1 dan F1.2 masing-masing lulus gate sebelum F1.3 dimulai.
- F1.3 lulus gate sebelum F1.4 dimulai.
- F1.4 lulus gate dan seluruh acceptance F1 sebelum F2 dimulai.
- Setiap milestone membuktikan tidak ada tiket KDS/nomor antrean yang dibuat.
- F1.3 membuktikan pembatalan pesanan belum lunas dan handoff pembayaran.
- F1.4 membuktikan diskon, approval, dan perhitungan final.

---

## 15. Change log

| Versi | Tanggal | Perubahan |
| --- | --- | --- |
| 1.0 | 10 November 2026 | Roadmap F0–F6 baseline |
| 1.1 | 11 November 2026 | Selaraskan dengan counter ordering, POS dua bagian, denah meja wajib, pembayaran sebelum KDS, antrean A001, KDS tiga status, split bill, dan migration plan |
| 1.2 | 11 November 2026 | Sinkronkan dengan PRD 1.2: QRIS Manual vs QRIS Midtrans, approval refund setelah KDS + notifikasi dapur, pesanan tambahan dengan antrean baru pada kunjungan yang sama, konfirmasi pengambilan hanya kasir/admin, editor denah drag-and-drop dengan zona, serta `docs/PRD.md` sebagai satu-satunya PRD utama |
| 1.3 | 11 November 2026 | Sinkronkan dengan PRD 1.3: split bill Midtrans per transaksi gateway + callback idempoten + total pembayaran tidak melebihi tagihan; diskon produk/pesanan/manual dengan approval admin dan audit pada F1; browser print 58/80 mm pada F2 tanpa kewajiban ESC/POS |
| 1.4 | 11 November 2026 | Audit konsistensi pra-F1: lima status pembayaran, refund penuh setelah lunas, penghentian tiket/antrean, arti override tutup meja, dan klarifikasi urutan pembayaran sebelum KDS |
| 1.5 | 11 November 2026 | Pecah F1 menjadi F1.1 Menu & Master Data, F1.2 Meja & Denah, F1.3 POS Core/Kunjungan/Pesanan, dan F1.4 Diskon & Finalisasi; tambah acceptance/gate per milestone, pembatalan pesanan belum lunas, handoff ke pembayaran F2, tiga status meja (render F1.2, transisi Terisi F2), larangan KDS/antrean F1, serta migration F1 terpisah |
