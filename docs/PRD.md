# PRD Nine Licious

| Field | Nilai |
| --- | --- |
| Produk | Nine Licious POS |
| Versi dokumen | 1.5 |
| Tanggal | 11 November 2026 |
| Status | Draft untuk persetujuan; implementasi menunggu persetujuan |
| Pemilik produk | Pemilik Nine Licious |
| Dokumen terkait | [`README.md`](../README.md), [`docs/ROADMAP.md`](./ROADMAP.md) |

> Dokumen ini adalah sumber kebenaran requirement produk. `README.md` tetap
> menjadi panduan setup dan ringkasan operasional. Beberapa halaman placeholder
> di kode masih memakai copy lama; perbedaannya dicatat di bagian **Konflik
> requirement** dan baru diperbaiki saat fase implementasi terkait.
>
> **Dokumentasi:** `docs/PRD.md` adalah satu-satunya PRD utama. Jangan membuat
> `prd.md` di root project atau salinan PRD dengan nama lain. Setiap perubahan
> harus disinkronkan dengan `docs/ROADMAP.md` dan `README.md`.

---

## 1. Ringkasan produk

Nine Licious adalah aplikasi point of sale (POS) operasional untuk restoran
cepat saji dengan **counter ordering**. Pelanggan datang, melihat menu, memesan
langsung kepada kasir, membayar di kasir, lalu menunggu pesanan siap diambil.

Alur inti:

1. Pelanggan melihat menu di area restoran.
2. Pelanggan memesan melalui kasir.
3. Kasir memasukkan pesanan ke POS.
4. Kasir memproses pembayaran.
5. Setelah pembayaran **lunas**, pesanan dikirim ke KDS dan pelanggan menerima
   nomor antrean.
6. Dapur menyiapkan pesanan.
7. Pelanggan mengambil pesanan ketika status **Siap Diambil**.

Aplikasi tidak menyediakan pemesanan mandiri oleh pelanggan dan tidak
menyediakan QR ordering.

---

## 2. Tujuan

### 2.1 Tujuan bisnis

- Mempercepat proses pemesanan dan pembayaran di kasir.
- Mengurangi kesalahan pencatatan pesanan dan modifier.
- Memberi visibilitas status pesanan kepada kasir, dapur, dan pelanggan.
- Menjaga konsistensi pembayaran, diskon, pajak, dan split bill.
- Menyediakan jejak audit untuk aktivitas operasional dan keuangan.
- Menjadi dasar modul stok, shift, dan laporan pada fase berikutnya.

### 2.2 Ukuran keberhasilan

- Kasir dapat menyelesaikan satu pesanan baru tanpa berpindah halaman.
- Pesanan yang belum lunas tidak pernah muncul di KDS.
- Nomor antrean harian unik dan berurutan, minimal format `A001`.
- Status KDS hanya memiliki tiga status operasional.
- Denah meja interaktif dapat digunakan kasir untuk memilih meja dine-in.
- Admin dapat mengatur posisi, kapasitas, dan zona meja melalui editor
  drag-and-drop.
- Split bill dapat mencatat lebih dari satu pembayaran untuk satu pesanan.
- Setiap pembayaran online Midtrans pada split bill memakai transaksi gateway
  terpisah dan tidak membuat pembayaran ganda.
- Pesanan hanya dianggap lunas saat total pembayaran sama dengan grand total;
  total pembayaran tidak boleh melebihi tagihan.
- Diskon produk, diskon pesanan, dan diskon manual dapat dicatat; diskon manual
  memerlukan approval admin dan seluruh diskon tercatat di transaksi serta audit
  log.
- Kasir tidak dapat mengubah harga produk secara bebas.
- Struk 58 mm dan 80 mm dapat dicetak melalui browser print pada F2 tanpa
  integrasi ESC/POS.
- QRIS Manual dan QRIS Midtrans dapat dibedakan pada data, struk, dan laporan.
- Pesanan tambahan tidak membuat pesanan atau nomor antrean ganda.
- Refund penuh setelah pesanan lunas tidak dapat diproses tanpa approval admin.
- Konfirmasi pengambilan hanya dapat dilakukan kasir/admin.
- Tidak ada data pelanggan atau nominal pembayaran di papan antrean publik.

---

## 3. Prinsip produk

1. **Operasional, bukan simulasi.** Tidak ada mode demo, akun contoh, atau data
   transaksi contoh yang dibuat otomatis.
2. **Counter ordering.** Pelanggan memesan lewat kasir; tidak ada self-order.
3. **Pembayaran sebelum dapur.** KDS hanya menerima pesanan yang sudah lunas.
4. **Satu sumber kebenaran.** Status pesanan, pembayaran, meja, dan antrean
   disimpan di database, bukan hanya di state browser.
5. **Audit sejak awal.** Tindakan istimewa dan perubahan status penting dicatat.
6. **Privasi pelanggan.** Papan antrean publik tidak menampilkan identitas,
   kontak, atau data pembayaran.
7. **Bertahap dan terverifikasi.** Setiap fase diselesaikan dan diuji sebelum
   fase berikutnya dimulai.

### 3.1 Non-goals

Hal-hal berikut **tidak** termasuk scope:

- QR ordering atau pemesanan mandiri dari meja pelanggan.
- Aplikasi pelanggan, akun pelanggan, atau loyalty program.
- Reservasi meja online.
- Marketplace atau integrasi delivery pihak ketiga.
- Manajemen multi-cabang pada fase awal.
- Mode offline penuh.
- Penggantian mesin kasir fiskal/EDC di luar integrasi pembayaran yang
  dinyatakan di dokumen ini.

---

## 4. Peran dan hak akses

| Peran | Kebutuhan utama | Batasan |
| --- | --- | --- |
| **Admin** | Mengelola pengguna, menu, modifier, meja, pengaturan, pembayaran, diskon, refund, laporan, audit; menyetujui diskon manual | Tidak dapat menonaktifkan admin aktif terakhir; aksi istimewa diaudit |
| **Kasir** | Membuat pesanan dan pesanan tambahan, memilih meja, menerapkan diskon produk/pesanan sesuai kebijakan, mengajukan diskon manual, memproses pembayaran, split bill, mencetak struk, melihat antrean, mengonfirmasi pengambilan | Tidak dapat mengakses manajemen pengguna atau pengaturan sensitif; tidak dapat mengubah harga produk secara bebas; diskon manual memerlukan approval admin; refund hanya dapat dilakukan admin |
| **Kitchen** | Melihat tiket pesanan lunas dan mengubah status KDS sampai **Siap Diambil** | Tidak dapat mengonfirmasi pengambilan, melihat data pembayaran/nominal, atau mengakses manajemen pengguna |
| **Publik** | Melihat papan antrean | Tanpa login; tanpa data pribadi atau keuangan |

Aturan akses rute yang sudah berjalan pada F0 dipertahankan:

| Rute | Admin | Kasir | Kitchen | Publik |
| --- | --- | --- | --- | --- |
| `/login` | ✓ | ✓ | ✓ | ✓ |
| `/queue` | ✓ | ✓ | ✓ | ✓ |
| `/admin` | ✓ | — | — | — |
| `/admin/users` | ✓ | — | — | — |
| `/pos` | ✓ | ✓ | — | — |
| `/kitchen` | ✓ | — | ✓ | — |
| `/unauthorized` | ✓ | ✓ | ✓ | — |

---

## 5. Alur utama counter ordering

### 5.1 Dine-in

1. Kasir membuka POS.
2. Kasir memilih tipe pesanan **Dine-in**.
3. Kasir memilih meja dari denah meja:
   - meja **Kosong** membuka kunjungan dine-in baru;
   - meja dengan kunjungan dine-in aktif dan pesanan sebelumnya sudah lunas
     dapat dipilih untuk **pesanan tambahan** pada kunjungan yang sama;
   - bila masih ada pesanan belum lunas, item ditambahkan ke pesanan tersebut.
4. Kasir mencari dan menambahkan produk ke keranjang.
5. Kasir mengatur modifier, jumlah, dan catatan khusus.
6. Kasir memeriksa subtotal, diskon produk/pesanan, pajak, service charge, dan
   grand total. Diskon manual diajukan dan disetujui admin sebelum pesanan
   disimpan atau pembayaran diproses.
7. Kasir menyimpan pesanan. Pesanan berstatus **Menunggu Pembayaran**; bila
   kunjungan baru, sistem membuka kunjungan dine-in; meja berstatus
   **Menunggu Pembayaran**.
8. Pada F2, kasir memproses pembayaran, baik penuh maupun split bill. Pada F1,
   alur berhenti pada status **Menunggu Pembayaran** dan handoff ke pembayaran
   mengikuti bagian 5.5.
9. Setelah total pembayaran pesanan sama dengan grand total, pesanan berstatus
   **Lunas**.
10. Sistem membuat nomor antrean harian dan tiket KDS untuk pesanan tersebut.
11. Meja berubah menjadi **Terisi** bila semua pesanan aktif dalam kunjungan
    sudah lunas; bila masih ada pesanan tambahan yang belum lunas, meja tetap
    **Menunggu Pembayaran**.
12. Dapur memproses pesanan melalui tiga status KDS.
13. Pelanggan mengambil pesanan saat status **Siap Diambil**.
14. Kasir/admin mengonfirmasi pengambilan; pesanan menjadi **Selesai**.
15. Setelah semua pesanan dalam kunjungan selesai/dibatalkan/direfund dan tidak
    ada pembayaran tertunda, kasir/admin mengosongkan meja, menutup kunjungan,
    dan meja kembali **Kosong**.

### 5.2 Takeaway

1. Kasir memilih tipe pesanan **Takeaway**.
2. Tidak ada pemilihan meja dan tidak ada kunjungan dine-in.
3. Kasir menambahkan produk, modifier, dan catatan.
4. Kasir menyimpan pesanan; status **Menunggu Pembayaran**.
5. Kasir memproses pembayaran.
6. Setelah lunas, sistem membuat nomor antrean dan tiket KDS.
7. Pelanggan menunggu dan mengambil pesanan saat **Siap Diambil**.
8. Kasir/admin mengonfirmasi pengambilan; pesanan menjadi **Selesai**.

### 5.3 Aturan penting alur

- Pesanan **tidak boleh** masuk KDS sebelum pembayaran lunas.
- Nomor antrean **tidak boleh** diberikan sebelum pembayaran lunas.
- Split bill tidak mengubah aturan ini: pesanan baru dianggap lunas ketika
  akumulasi pembayaran sama dengan grand total. Total pembayaran tidak boleh
  melebihi tagihan; uang tunai berlebih dicatat sebagai kembalian.
- Diskon manual harus disetujui admin sebelum pesanan disimpan atau pembayaran
  diproses.
- Meja hanya wajib untuk dine-in.
- Pembatalan pesanan belum lunas pada F1 hanya untuk pesanan **Menunggu
  Pembayaran** tanpa pembayaran, wajib alasan, dan dicatat di audit (FR-POS-11).
- Perubahan status pesanan, pembayaran, meja, dan KDS harus tercatat.

### 5.4 Pesanan tambahan dine-in

Pesanan tambahan adalah pesanan baru yang dibuat setelah pesanan sebelumnya
sudah lunas, tetapi pelanggan masih berada di meja yang sama.

Aturan:

1. Pesanan tambahan harus terhubung ke **kunjungan dine-in** dan **meja** yang
   sama.
2. Setiap pesanan tambahan memiliki **nomor pesanan baru** dan, setelah lunas,
   **nomor antrean baru**.
3. Nomor antrean pesanan sebelumnya tidak berubah dan tidak boleh dipakai ulang.
4. Tiket KDS pesanan sebelumnya tetap berjalan; pesanan tambahan membuat tiket
   KDS sendiri setelah lunas.
5. Meja berstatus **Menunggu Pembayaran** selama masih ada pesanan tambahan yang
   belum lunas, lalu kembali **Terisi** setelah semua pesanan aktif lunas.
6. Pembatalan pesanan tambahan tidak boleh membatalkan atau mengubah pesanan
   sebelumnya dalam kunjungan yang sama.
7. Setiap aksi simpan pesanan dan pembayaran memakai idempotency key agar klik
   ganda, retry, atau webhook duplikat tidak membuat pesanan/antrean ganda.
8. Meja tidak boleh dikosongkan selama masih ada pesanan aktif atau pembayaran
   tertunda dalam kunjungan.

### 5.5 Batas F1 dan handoff ke pembayaran F2

F1 berhenti pada status **Menunggu Pembayaran**. Setelah kasir menyimpan pesanan:

1. Sistem menampilkan konfirmasi berisi nomor pesanan, tipe pesanan, meja (untuk
   dine-in), grand total, dan status **Menunggu Pembayaran**.
2. CTA pembayaran ditampilkan sebagai placeholder nonaktif dengan label bahwa
   pembayaran tersedia pada F2. F1 tidak membuka panel pembayaran dan tidak
   mencatat pembayaran.
3. Kasir dapat kembali ke POS/denah atau membatalkan pesanan belum lunas sesuai
   FR-POS-11.
4. Pesanan tetap dapat dibuka kembali. F2 memakai `order_id` yang sama untuk
   mencatat pembayaran, sehingga tidak membuat pesanan atau kunjungan baru.
5. F1 tidak boleh mengubah pesanan menjadi **Lunas**, membuat nomor antrean,
   atau membuat tiket KDS. Transisi meja ke **Terisi** baru diuji pada F2.

---

## 6. Requirement fungsional

### 6.1 POS — tampilan dua bagian

**FR-POS-01 — Layout utama**

POS menggunakan dua area utama:

- **Kiri:** kategori dan daftar produk.
- **Kanan:** keranjang pesanan, ringkasan pembayaran, dan tombol aksi.

Layout harus tetap dapat digunakan pada layar kasir desktop/tablet. Pada layar
sempit, keranjang boleh menjadi panel yang dapat dibuka/tutup, tetapi alur dan
informasi tidak boleh hilang.

**FR-POS-02 — Kategori**

Kategori utama:

- Food
- Drinks
- Desserts
- Packages

Kategori ditampilkan sebagai tab/filter. Kategori memiliki urutan tampil dan
status aktif. Admin dapat menambah, mengubah urutan, menonaktifkan, dan
menghapus kategori yang tidak memiliki produk terkait (atau mengarsipkannya).

**FR-POS-03 — Daftar produk**

Setiap kartu produk menampilkan:

- foto produk,
- nama produk,
- harga,
- status ketersediaan.

Produk yang tidak aktif/tidak tersedia ditampilkan nonaktif atau disembunyikan
sesuai pengaturan, dan tidak dapat ditambahkan ke keranjang.

**FR-POS-04 — Pencarian produk**

Kasir dapat mencari produk berdasarkan nama (minimal) dan kode/SKU bila
tersedia. Pencarian harus:

- bekerja lintas kategori atau dalam kategori aktif sesuai pilihan,
- memiliki empty state yang jelas,
- dapat dibersihkan dengan satu aksi,
- tidak menghapus isi keranjang.

**FR-POS-05 — Keranjang**

Keranjang menampilkan:

- nama produk,
- modifier yang dipilih,
- catatan khusus,
- jumlah,
- harga satuan setelah modifier,
- subtotal baris.

Kasir dapat menambah, mengurangi, mengubah modifier, dan menghapus baris.
Jumlah tidak boleh nol atau negatif. Perubahan harga akibat modifier harus
terlihat sebelum pembayaran.

**FR-POS-06 — Tipe pesanan**

POS menyediakan pilihan **Dine-in** dan **Takeaway**.

- Dine-in mewajibkan pemilihan meja.
- Takeaway tidak menampilkan/mewajibkan meja.
- Tipe pesanan harus tersimpan pada pesanan dan tercetak di struk.

**FR-POS-07 — Ringkasan pembayaran**

Ringkasan minimal menampilkan:

- subtotal,
- diskon,
- pajak,
- service charge,
- grand total,
- jumlah yang sudah dibayar (jika split bill),
- sisa pembayaran.

Perhitungan mengikuti aturan pada bagian 8.

**FR-POS-08 — Simpan pesanan**

Saat kasir menyimpan pesanan:

- pesanan dibuat dengan status **Menunggu Pembayaran**,
- pesanan dine-in baru membuka kunjungan dine-in atau memakai kunjungan aktif
  pada meja yang sama,
- penambahan item **sebelum pesanan lunas** dilakukan pada pesanan yang sama,
  bukan membuat pesanan baru,
- meja dine-in berubah menjadi **Menunggu Pembayaran**,
- pesanan belum dikirim ke KDS,
- nomor antrean belum dibuat,
- idempotency key mencegah pesanan ganda akibat klik ganda atau retry,
- pesanan dapat dibatalkan sebelum lunas sesuai FR-POS-11,
- setelah tersimpan, sistem menampilkan konfirmasi **Menunggu Pembayaran**
  dengan CTA pembayaran nonaktif/placeholder; F1 tidak mencatat pembayaran,
  tidak membuat nomor antrean, dan tidak membuat tiket KDS (handoff ke F2
  mengikuti FR-POS-12).

**FR-POS-09 — Hak akses**

Hanya admin dan kasir yang dapat membuka POS dan membuat pesanan. Kitchen tidak
dapat mengakses POS.

**FR-POS-10 — Diskon**

POS mendukung tiga jenis diskon:

1. **Diskon produk** — diskon pada baris produk/varian tertentu, dihitung
   sebelum diskon pesanan.
2. **Diskon seluruh pesanan** — diskon pada subtotal pesanan setelah diskon
   produk.
3. **Diskon manual** — diskon nominal/persentase yang memerlukan hak akses admin
   atau persetujuan admin, dihitung setelah diskon produk dan diskon pesanan.

Aturan diskon:

- Kasir **tidak boleh mengubah harga produk secara bebas**. Harga produk berasal
  dari master produk; perubahan harga hanya dilakukan admin melalui pengelolaan
  produk.
- Diskon produk dan diskon pesanan mengikuti kebijakan yang ditetapkan admin.
- Diskon manual harus memiliki alasan. Kasir dapat mengajukan, tetapi diskon
  manual baru berlaku setelah disetujui admin.
- Diskon manual yang belum disetujui tidak boleh diterapkan pada pesanan.
- Diskon tidak boleh membuat subtotal, dasar pajak, atau grand total menjadi
  negatif; total diskon tidak boleh melebihi subtotal pesanan sebelum diskon.
- Semua diskon menyimpan jenis, cakupan, nilai, alasan, aktor, dan approver
  (untuk diskon manual).
- Semua diskon tercatat pada transaksi dan audit log.

**FR-POS-11 — Pembatalan pesanan belum lunas**

Pembatalan pada F1 hanya berlaku untuk pesanan berstatus **Menunggu Pembayaran**
yang belum memiliki pembayaran tercatat.

- **Role:** kasir dan admin dapat membatalkan pesanan belum lunas. Kitchen tidak
  dapat membatalkan. Pembatalan pesanan **Sebagian Dibayar** baru diizinkan pada
  F2 setelah refund bagian disetujui dan dicatat admin.
- **Alasan wajib:** kasir/admin memilih alasan pembatalan dan boleh menambahkan
  catatan. Pembatalan tanpa alasan ditolak server.
- **Konfirmasi:** aksi memerlukan konfirmasi eksplisit dan tidak boleh terjadi
  karena klik ganda; permintaan berulang untuk pesanan yang sama idempoten.
- **Audit:** sistem mencatat pesanan, meja/kunjungan, aktor, waktu, alasan,
  grand total, dan status sebelumnya di `audit_logs`. Pesanan **Dibatalkan**
  bersifat final dan tidak dapat diaktifkan kembali; pesanan baru harus dibuat
  bila pelanggan tetap memesan.
- **Tanpa KDS/antrean:** karena pesanan belum lunas, tidak ada nomor antrean
  atau tiket KDS yang dibuat maupun dihentikan.
- **Dampak meja:** bila tidak ada pesanan aktif lain dan tidak ada pembayaran
  tertunda dalam kunjungan, kasir/admin dapat menutup kunjungan dan meja kembali
  **Kosong**. Bila masih ada pesanan aktif lain, status meja mengikuti pesanan
  tersebut (**Menunggu Pembayaran** atau **Terisi**). Pembatalan tidak boleh
  menutup kunjungan yang masih memiliki pesanan aktif atau pembayaran tertunda.
- Pesanan **Lunas** tidak boleh dibatalkan; pembatalan setelah lunas hanya
  melalui refund penuh F2.

**FR-POS-12 — Handoff ke pembayaran F2**

- F1 berhenti pada **Menunggu Pembayaran** dan tidak mencatat pembayaran.
- Setelah pesanan disimpan, tampilkan konfirmasi berisi nomor pesanan, tipe
  pesanan, meja untuk dine-in, grand total, dan status **Menunggu Pembayaran**.
- CTA pembayaran ditampilkan nonaktif/placeholder dengan keterangan bahwa
  pembayaran tersedia pada F2. Jangan membuat panel pembayaran di F1.
- Tidak ada nomor antrean atau tiket KDS yang dibuat pada F1.
- F2 memakai `order_id` yang sama untuk mencatat pembayaran; F2 tidak membuat
  pesanan atau kunjungan baru.
- Setelah konfirmasi, kasir dapat kembali ke POS/denah atau membatalkan pesanan
  belum lunas sesuai FR-POS-11. Alur F1 tidak boleh berakhir di halaman buntu.

---

### 6.2 Menu, produk, dan modifier

**FR-MENU-01 — Kategori**

Admin dapat mengelola kategori dengan field minimal:

- nama,
- slug/kode,
- urutan,
- status aktif,
- opsional ikon/warna.

Empat kategori utama di atas adalah kategori awal yang wajib tersedia. Kategori
tambahan boleh dibuat admin bila diperlukan.

**FR-MENU-02 — Produk**

Admin dapat membuat dan mengubah produk dengan field minimal:

- nama,
- kategori,
- harga,
- foto,
- deskripsi singkat (opsional),
- kode/SKU (opsional),
- status aktif,
- status ketersediaan,
- stasiun dapur (opsional, untuk filter KDS),
- urutan tampil.

Foto disimpan di Supabase Storage atau penyimpanan objek yang disetujui. Produk
tanpa foto memakai placeholder yang konsisten.

**FR-MENU-03 — Harga**

Harga disimpan dalam rupiah tanpa desimal tersembunyi. Perubahan harga produk
tidak boleh mengubah harga pesanan yang sudah dibuat; pesanan menyimpan snapshot
nama dan harga saat transaksi.

**FR-MENU-04 — Modifier**

Modifier mendukung kebutuhan berikut:

- **Level pedas** — pilihan tunggal, misalnya Tidak Pedas, Level 1–5.
- **Ukuran** — pilihan tunggal, misalnya Regular, Large.
- **Topping** — pilihan ganda, opsional, dapat menambah harga.
- **Catatan khusus** — teks bebas per item.

Setiap grup modifier memiliki:

- nama,
- tipe pilihan (tunggal/ganda),
- wajib atau opsional,
- minimum/maksimum pilihan,
- urutan,
- status aktif.

Setiap opsi modifier memiliki:

- nama,
- selisih harga (boleh nol, positif; negatif hanya bila kebijakan diskon
  modifier diizinkan),
- status aktif,
- urutan.

**FR-MENU-05 — Modifier per produk**

Admin dapat menentukan grup modifier mana yang berlaku untuk produk tertentu.
Produk dapat memiliki lebih dari satu grup. Kombinasi modifier yang tidak valid
harus ditolak di server.

**FR-MENU-06 — Snapshot modifier**

Saat produk ditambahkan ke pesanan, sistem menyimpan snapshot nama modifier dan
selisih harga. Perubahan master modifier setelahnya tidak mengubah pesanan lama.

**FR-MENU-07 — Catatan khusus**

Catatan khusus disimpan per item, ditampilkan di keranjang, struk, dan KDS.
Catatan tidak boleh menjadi satu-satunya tempat menyimpan instruksi yang
mengubah harga; perubahan harga harus melalui modifier.

---

### 6.3 Manajemen meja dan denah interaktif

> Denah meja interaktif adalah **challenge pembimbing** dan wajib
> dipertahankan. Fitur ini tidak boleh dihapus atau ditunda tanpa persetujuan
> pembimbing.

**FR-MEJA-01 — Status meja**

Status meja hanya:

| Status | Arti |
| --- | --- |
| **Kosong** | Tidak ada kunjungan dine-in aktif; meja dapat dipilih untuk kunjungan baru |
| **Menunggu Pembayaran** | Ada kunjungan dine-in aktif dengan minimal satu pesanan yang belum lunas |
| **Terisi** | Semua pesanan aktif dalam kunjungan sudah lunas; pelanggan masih di meja |

Pesanan tambahan yang belum lunas membuat meja kembali berstatus **Menunggu
Pembayaran** sampai pesanan tersebut lunas. Status tidak boleh bertambah menjadi
status keempat tanpa keputusan produk baru.

Pada F1.2, denah wajib dapat **merender** ketiga status. Transisi nyata
**Kosong → Menunggu Pembayaran** dan kembali **Kosong** setelah pembatalan
pesanan belum lunas diuji pada F1.3. Transisi nyata ke **Terisi** memerlukan
pembayaran dan baru diuji pada F2.

**FR-MEJA-02 — Editor denah interaktif**

Admin memiliki editor denah meja dengan fitur wajib:

- menambah/mengubah/menonaktifkan meja,
- mengatur nomor/nama meja,
- mengatur kapasitas,
- mengatur zona/area meja; zona wajib dipilih (default **Utama** bila belum
  diatur),
- mengatur posisi meja pada denah (koordinat x/y),
- **drag-and-drop** posisi meja,
- mengatur bentuk/ukuran tampilan (opsional),
- menyimpan dan menerbitkan layout,
- melihat status meja secara real-time.

Admin juga dapat mengelola daftar zona (tambah, ubah nama, urutan, nonaktifkan)
selama zona tersebut tidak memiliki meja aktif.

**FR-MEJA-03 — Pemilihan meja oleh kasir**

Kasir memilih meja melalui denah yang sama:

- meja **Kosong** → membuka kunjungan dine-in baru;
- meja dengan kunjungan aktif dan **tidak ada pesanan belum lunas** → dapat
  dipilih untuk **pesanan tambahan** pada kunjungan yang sama;
- meja dengan kunjungan aktif dan **masih ada pesanan belum lunas** →
  penambahan item dilakukan pada pesanan tersebut, bukan membuat pesanan baru;
- meja dengan kunjungan aktif tidak boleh dipakai untuk kunjungan baru yang
  tidak terkait.

**FR-MEJA-04 — Hubungan pesanan, meja, dan kunjungan**

Pesanan dine-in menyimpan referensi `table_id` dan `dining_session_id`. Satu meja
hanya boleh memiliki **satu kunjungan dine-in aktif** pada satu waktu, tetapi
satu kunjungan dapat memiliki **lebih dari satu pesanan**. Pesanan takeaway tidak
memiliki meja atau kunjungan dine-in.

**FR-MEJA-05 — Mengosongkan meja**

Kasir/admin dapat mengosongkan meja setelah semua pesanan dalam kunjungan
selesai, dibatalkan, atau direfund penuh, dan tidak ada pembayaran tertunda.
Tindakan ini menutup kunjungan dine-in dan mengubah meja menjadi **Kosong**.

- Meja tidak boleh dikosongkan bila masih ada pesanan aktif atau pembayaran
  tertunda.
- Bila pesanan dibatalkan atau direfund penuh sebelum selesai, pesanan tersebut
  tidak lagi menghalangi penutupan kunjungan setelah refund dicatat.
- Pembatalan pesanan belum lunas mengikuti FR-POS-11: wajib alasan, dicatat di
  audit, dan tidak boleh menutup kunjungan yang masih memiliki pesanan aktif
  atau pembayaran tertunda.
- Admin dapat melakukan **override tutup meja** hanya setelah menyelesaikan
  seluruh pesanan: pesanan belum lunas dibatalkan dengan alasan, pembayaran
  tertunda dibatalkan/direkonsiliasi, dan pesanan lunas yang masih aktif direfund
  penuh melalui approval admin. Override tidak boleh meninggalkan pesanan aktif
  atau pembayaran tertunda; konfirmasi dan seluruh aksi dicatat di audit.
  Override bukan bypass status pesanan/pembayaran.
- Meja yang sudah memiliki riwayat pesanan tidak dihapus permanen; gunakan
  status aktif/nonaktif.

**FR-MEJA-06 — Akses**

Admin dapat mengelola meja, zona, dan layout serta melihat statusnya. Kasir dapat
melihat denah dan memilih meja. Kitchen hanya dapat melihat nomor meja pada tiket
KDS bila diperlukan untuk penyajian; kitchen tidak dapat mengubah meja atau
mengonfirmasi pengambilan.

**FR-MEJA-07 — Pesanan tambahan**

Pesanan tambahan setelah pembayaran:

- terhubung ke meja dan `dining_session_id` yang sama,
- memiliki ID pesanan baru,
- memiliki nomor antrean baru setelah pesanan tambahan lunas,
- tidak mengubah nomor antrean atau tiket KDS pesanan sebelumnya,
- tidak boleh membuat pesanan/antrean ganda akibat klik ganda atau retry;
  gunakan idempotency key dan transaksi database,
- tetap tunduk pada aturan pembayaran sebelum KDS.

---

### 6.4 Pembayaran

**FR-BAYAR-01 — Metode dan sumber pembayaran**

Metode dan sumber pembayaran yang didukung:

| Metode | Sumber/channel | Sifat | Keterangan |
| --- | --- | --- | --- |
| **Tunai** | `cash` | Manual | Kasir menerima uang, sistem menghitung kembalian |
| **QRIS Manual** | `qris_manual` | Manual | QRIS statis; kasir mengonfirmasi pembayaran dan mencatat referensi |
| **QRIS Midtrans** | `qris_midtrans` | Gateway | QRIS melalui Midtrans; status hanya valid setelah webhook terverifikasi |
| **Transfer** | `bank_transfer` | Manual | Transfer bank; kasir mencatat referensi dan mengonfirmasi |
| **Midtrans** | `midtrans_snap` | Gateway | Snap; kartu/e-wallet sesuai channel yang diaktifkan |

Aturan pencatatan:

- Setiap pembayaran menyimpan **metode** dan **sumber/channel** pembayaran.
- **QRIS Manual** dan **QRIS Midtrans** adalah dua sumber berbeda dan tidak boleh
  digabung menjadi satu kategori tanpa rincian.
- Struk, detail pembayaran, laporan, dan audit harus menampilkan label sumber
  yang membedakan keduanya.
- `Manual` adalah cara pencatatan, bukan metode pembayaran kelima.
- Metode `kartu` tidak menjadi metode terpisah; pembayaran kartu diproses melalui
  Midtrans bila channel tersebut diaktifkan.

**FR-BAYAR-02 — Pembayaran sebelum KDS**

Pesanan hanya boleh masuk KDS setelah pembayaran lunas. Tidak ada mekanisme
"kirim ke dapur dulu, bayar kemudian".

**FR-BAYAR-03 — Split bill**

Satu pesanan dapat memiliki lebih dari satu pembayaran. Setiap pembayaran
mencatat:

- metode,
- sumber/channel pembayaran,
- nominal,
- waktu,
- kasir,
- referensi eksternal (opsional),
- status pembayaran,
- shift/kas drawer terkait (bila modul shift aktif).

Aturan split bill:

- Pesanan berstatus **Sebagian Dibayar** bila total pembayaran kurang dari
  grand total.
- Pesanan berstatus **Lunas** bila total pembayaran sama dengan grand total.
- Total nilai pembayaran yang dicatat tidak boleh melebihi grand total.
- Split bill boleh mencampur metode/sumber pembayaran, misalnya tunai + QRIS
  Manual, asalkan totalnya valid.
- Setiap bagian pembayaran online melalui Midtrans menggunakan transaksi gateway
  tersendiri dengan `midtrans_order_id` unik; satu transaksi gateway tidak boleh
  dipakai untuk dua baris pembayaran.
- Callback/webhook setiap transaksi gateway diverifikasi; event duplikat harus
  idempoten dan tidak boleh membuat pembayaran ganda.
- Pembayaran non-tunai tidak boleh melebihi sisa tagihan.
- Uang tunai yang diserahkan boleh melebihi sisa tagihan; selisih dicatat sebagai
  kembalian dan **bukan** bagian dari nilai pembayaran.
- Perubahan status menjadi lunas harus atomik dan idempoten.
- Nomor antrean dan tiket KDS dibuat sekali saat pesanan pertama kali lunas.

**FR-BAYAR-04 — Midtrans**

- Integrasi memakai Midtrans Snap.
- Setiap bagian pembayaran online pada split bill memakai transaksi Midtrans
  terpisah dan `midtrans_order_id` yang unik.
- Status pembayaran hanya dianggap berhasil setelah webhook diverifikasi di
  server dengan signature yang valid dan status transaksi diambil ulang dari API
  Midtrans.
- Callback Snap di browser bukan bukti pembayaran.
- Webhook harus idempoten; event duplikat tidak boleh membuat pembayaran ganda
  atau melunasi dua baris pembayaran.
- QRIS yang diproses melalui Midtrans dicatat sebagai sumber `qris_midtrans`,
  bukan `qris_manual`.
- Environment development hanya boleh memakai Sandbox; production hanya boleh
  memakai Production.
- Data uji Sandbox tidak boleh masuk laporan operasional production.

**FR-BAYAR-05 — Struk**

Struk minimal memuat:

- nama dan identitas restoran,
- nomor pesanan/nomor antrean,
- tipe pesanan (dine-in/takeaway),
- nomor meja untuk dine-in,
- item, modifier, catatan, jumlah, harga,
- subtotal, rincian diskon produk/pesanan/manual, pajak, service charge, grand
  total,
- approver diskon manual (bila ada),
- daftar pembayaran, sumber pembayaran, dan kembalian,
- kasir,
- tanggal dan waktu.

Pada F2, struk dicetak melalui **browser print** dengan dukungan layout thermal 58 mm dan 80 mm. Kontrak data struk disediakan oleh RPC terverifikasi `get_order_receipt_data(p_order_id)` yang mengembalikan JSON komprehensif (informasi resto, line items, modifier, catatan, subtotal, diskon terurai beserta approver diskon manual, pajak, service charge, grand total, riwayat pembayaran, kembalian tunai, riwayat refund selesai & pending, dan kalkulasi pembayaran bersih `net_paid`). Integrasi ESC/POS atau printer thermal khusus **tidak wajib** pada F2 dan dapat dipertimbangkan pada fase berikutnya. Cetak ulang struk harus dicatat di audit.

**FR-BAYAR-06 — Refund (F2.4 Contract)**

- **Hak Akses & Otorisasi**: Refund hanya dapat dibuat dan disetujui admin (`profiles.role = 'admin'`). Kasir hanya dapat melihat status. Pengguna non-admin ditolak di tingkat RPC dan RLS database.
- **Validasi Nominal & Jenis**:
  - Alasan refund wajib diisi minimal 3 karakter.
  - Nominal refund harus berupa integer positif (> 0).
  - Mendukung refund penuh (`full`) dan sebagian (`partial`).
  - Total refund kumulatif (termasuk refund berstatus `pending`) tidak boleh melebihi sisa dana yang dapat direfund (`paid_total - refunded_total - pending_reservations`).
  - Refund parsial yang menghabiskan seluruh sisa tagihan ditolak dan diarahkan menggunakan refund `full`.
- **Dukungan Metode Pembayaran & Split Bill**:
  - Mendukung metode pembayaran tunai (`cash`), QRIS manual (`qris_manual`), transfer manual (`transfer`), dan Midtrans (`midtrans`).
  - Pada split bill, refund dapat diarahkan ke pembayaran tertentu (`payment_id`).
  - Akumulasi refund pada baris pembayaran tertentu diverifikasi terhadap nominal pembayaran tersebut; status pembayaran diubah menjadi `refunded` secara otomatis hanya ketika akumulasi refund selesai $\ge$ nominal pembayaran.
- **Midtrans Refund & Server-Side Confirmation**:
  - Permintaan refund untuk metode Midtrans tidak mempercayai parameter konfirmasi dari client (tanpa `p_gateway_confirmed`).
  - Status refund Midtrans pertama kali dicatat sebagai `pending` dengan `approved_by = NULL` dan `approved_at = NULL`.
  - Konfirmasi refund Midtrans diproses secara terpisah dan eksklusif melalui RPC `confirm_midtrans_refund_atomic` yang hanya dapat dieksekusi oleh `service_role` setelah validasi server-side atau webhook gateway tepercaya.
- **Anti-Overlap Pending Reservation**:
  - Refund pending secara atomik mengalokasikan (reserve) saldo order yang dapat direfund untuk mencegah tumpang tindih transaksi refund paralel pada saldo yang sama.
- **Penghentian Tiket KDS Aktif**:
  - Refund penuh pada pesanan yang sudah lunas menghentikan tiket KDS aktif secara atomik: status KDS direset (`orders.kds_status = NULL`), waktu pembatalan (`cancelled_at = now()`), pembatal (`cancelled_by = admin_id`), dan waktu notifikasi dapur (`refunds.kitchen_notified_at = now()`) dicatat.
  - Refund sebagian tidak menghentikan tiket KDS dan mempertahankan status pesanan.
- **Kepatuhan Deadlock & Locking Hierarchy**:
  - Seluruh RPC refund wajib mengikuti hierarki kunci kanonikal: $L_1 (\text{dining\_tables}) \to L_2 (\text{dining\_sessions}) \to L_3 (\text{orders}) \to L_4 (\text{order\_allocations}) \to L_5 (\text{midtrans\_transactions}) \to L_6 (\text{payments}) \to L_7 (\text{refunds})$.
- **Keamanan Data & Privilese Database**:
  - Tabel `public.refunds` diproteksi RLS ketat tanpa izin `INSERT/UPDATE/DELETE` langsung untuk user biasa.
  - Seluruh mutasi hanya dapat terjadi melalui RPC atomik (`SECURITY DEFINER`).
  - Fungsi `generate_refund_number()` hanya dapat dieksekusi oleh `service_role`.
- **Dampak Sesi Meja & Shift**:
  - Pesanan yang direfund penuh tidak lagi menghalangi penutupan sesi meja pada `close_dining_session_atomic`.
  - Refund tunai dicatat untuk integrasi modul shift (F5).
- **Audit Logging**:
  - Setiap refund yang diproses (`process_order_refund_atomic`) dan dikonfirmasi (`confirm_midtrans_refund_atomic`) dicatat ke `audit_logs` secara komprehensif.

**FR-BAYAR-07 — Diskon, pajak, dan service charge**

- Diskon yang didukung: **diskon produk**, **diskon seluruh pesanan**, dan
  **diskon manual**.
- Diskon produk dihitung per baris setelah harga produk + modifier.
- Diskon seluruh pesanan dihitung setelah diskon produk.
- Diskon manual dihitung setelah diskon produk dan diskon pesanan.
- Diskon manual hanya berlaku setelah disetujui admin; wajib memiliki alasan dan
  approver.
- Diskon pesanan tidak boleh melebihi subtotal setelah diskon produk; diskon
  manual tidak boleh melebihi subtotal setelah diskon produk dan diskon pesanan.
- Total diskon tidak boleh melebihi subtotal pesanan sebelum diskon dan tidak
  boleh membuat grand total negatif.
- Pajak dan service charge dihitung **setelah seluruh diskon**.
- Nilai default pajak dan service charge berasal dari `restaurant_settings`.
- Diskon disimpan sebagai snapshot pada transaksi dan dicatat di audit log.
- Perubahan master produk atau pengaturan tidak boleh mengubah transaksi yang
  sudah lunas.

---

### 6.5 Nomor antrean

**FR-ANTREAN-01 — Format**

Nomor antrean harian memakai format huruf + tiga digit, contoh:

- `A001`
- `A002`
- `A003`

Bila jumlah melewati 999, digit boleh bertambah tanpa mengubah prefiks.

**FR-ANTREAN-02 — Waktu pembuatan**

Nomor antrean dibuat **setelah pembayaran lunas**, bukan saat pesanan disimpan.
Pesanan yang belum lunas tidak memiliki nomor antrean.

**FR-ANTREAN-03 — Reset harian**

Nomor direset setiap hari berdasarkan zona waktu `Asia/Jakarta`. Gunakan
`daily_sequences` yang sudah tersedia dengan `sequence_name` yang disepakati,
misalnya `queue`.

**FR-ANTREAN-04 — Keunikan dan anti-duplikasi**

Nomor antrean unik per tanggal bisnis. Pembuatan nomor harus atomik dan aman
terhadap dua pembayaran bersamaan. Setiap pesanan hanya boleh memiliki satu
nomor antrean aktif. Nomor antrean yang sudah dipakai tidak boleh digunakan ulang
untuk pesanan lain. Idempotency key dan unique constraint wajib mencegah
pembuatan nomor ganda akibat retry, klik ganda, atau webhook duplikat.

**FR-ANTREAN-05 — Tampilan**

Nomor antrean ditampilkan:

- di struk,
- di layar konfirmasi pembayaran,
- di papan antrean publik,
- di KDS.

Kasir dapat mencetak ulang nomor antrean; cetak ulang dicatat di audit.

**FR-ANTREAN-06 — Pesanan tambahan**

Pesanan tambahan setelah pembayaran mendapatkan nomor antrean baru setelah
pesanan tambahan tersebut lunas. Nomor antrean pesanan sebelumnya tidak berubah.
Pesanan tambahan tetap terhubung ke meja dan kunjungan dine-in yang sama, dan
tidak boleh membuat antrean ganda atau menimpa antrean lama.

---

### 6.6 KDS — Kitchen Display System

**FR-KDS-01 — Hanya pesanan lunas**

KDS hanya menampilkan pesanan yang sudah lunas. Pesanan **Menunggu Pembayaran**
atau **Sebagian Dibayar** tidak boleh muncul.

**FR-KDS-02 — Tiga status**

KDS hanya memiliki tiga status:

| Status | Arti | Aksi |
| --- | --- | --- |
| **Pesanan Masuk** | Tiket baru setelah pembayaran lunas | Dapur mulai menyiapkan |
| **Sedang Disiapkan** | Pesanan sedang dikerjakan | Dapur menandai siap |
| **Siap Diambil** | Pesanan selesai disiapkan | Kasir/admin mengonfirmasi pengambilan; kitchen tidak mengubah status lagi |

Status **Selesai**, **Diambil**, atau **Disajikan** bukan kolom keempat KDS.
Penyelesaian pesanan adalah aksi di luar papan KDS yang menghapus tiket dari
papan dan mengubah status pesanan menjadi **Selesai**. Aksi tersebut hanya
dilakukan kasir/admin, bukan kitchen.

**FR-KDS-03 — Isi tiket**

Tiket KDS minimal menampilkan:

- nomor antrean,
- tipe pesanan,
- nomor meja untuk dine-in,
- daftar item dan jumlah,
- modifier,
- catatan khusus,
- waktu masuk,
- waktu mulai disiapkan,
- waktu siap.

Tiket KDS tidak menampilkan nama pelanggan, nomor telepon, nominal pembayaran,
atau data keuangan.

**FR-KDS-04 — Aksi status**

- **Pesanan Masuk → Sedang Disiapkan**: dicatat waktunya.
- **Sedang Disiapkan → Siap Diambil**: dicatat waktunya.
- Perpindahan status harus divalidasi di server; tidak boleh melompati status.
- Kitchen tidak boleh mengubah status setelah **Siap Diambil** dan tidak memiliki
  aksi **Selesai**/**Diambil**.
- Perubahan status dicatat di audit.

**FR-KDS-05 — Filter stasiun**

Dapur hanya melihat item yang relevan. Filter dapat berbasis stasiun dapur
(misalnya kitchen/bar) atau kategori. Bila filter belum dikonfigurasi, semua
item ditampilkan.

**FR-KDS-06 — Realtime**

KDS memperbarui tiket secara realtime. Bila realtime gagal, sediakan fallback
polling dan indikator koneksi.

**FR-KDS-07 — Pengambilan**

Kitchen hanya berwenang mengubah status sampai **Siap Diambil**. Konfirmasi
pengambilan hanya dilakukan **kasir/admin** dari POS atau layar operasional yang
hanya dapat diakses kasir/admin. Halaman publik `/queue` hanya menampilkan status
dan tidak memiliki aksi konfirmasi. KDS tidak menyediakan aksi pengambilan untuk
kitchen. Setelah dikonfirmasi, tiket dihapus dari KDS dan pesanan menjadi
**Selesai**.

**FR-KDS-08 — Notifikasi penghentian tiket**

Bila refund penuh setelah pesanan lunas sebelum **Selesai** disetujui admin,
tiket dihentikan dan dihapus dari papan KDS aktif, lalu kitchen menerima
notifikasi penghentian tiket. Penghentian tiket bukan status KDS keempat.
Notifikasi, penghentian tiket, dan aktor yang menyetujui refund dicatat di audit
log.

---

### 6.7 Papan antrean publik

**FR-QUEUE-01 — Akses publik**

`/queue` dapat dibuka tanpa login dan aman dibiarkan terbuka di area pelanggan.

**FR-QUEUE-02 — Data yang ditampilkan**

Hanya:

- nomor antrean,
- status pesanan (Pesanan Masuk, Sedang Disiapkan, Siap Diambil),
- waktu pembaruan.

**FR-QUEUE-03 — Data yang dilarang**

Papan antrean tidak boleh menampilkan:

- nama pelanggan,
- nomor telepon,
- nomor meja,
- nominal pembayaran,
- metode pembayaran,
- data keuangan lainnya.

**FR-QUEUE-04 — Pesanan selesai atau refund**

Pesanan yang sudah diambil atau direfund penuh menghilang dari papan antrean.
Riwayat tetap tersimpan di database untuk laporan.

---

### 6.8 Pengaturan dan administrasi

**FR-ADMIN-01 — Pengguna**

Fitur F0 dipertahankan:

- admin membuat akun kasir dan kitchen,
- menentukan username dan password awal,
- melihat daftar pengguna, role, dan status,
- mengaktifkan/menonaktifkan akun,
- mereset password,
- kasir/kitchen tidak dapat membuat akun sendiri,
- kasir/kitchen tidak dapat mengakses manajemen pengguna,
- semua aktivitas pengelolaan akun masuk `audit_logs`.

**FR-ADMIN-02 — Pengaturan restoran**

Admin dapat mengubah:

- nama restoran,
- logo,
- alamat dan telepon,
- header/footer struk,
- pajak,
- service charge,
- lebar struk,
- jam operasional dan hari libur (bila modul terkait aktif).

**FR-ADMIN-03 — Menu dan meja**

Admin dapat mengelola kategori, produk, modifier, dan denah meja. Perubahan
harga/menu tidak boleh merusak snapshot transaksi lama.

**FR-ADMIN-04 — Audit**

Admin dapat melihat audit log aktivitas:

- login dan kegagalan login,
- pengelolaan pengguna,
- pembuatan/perubahan pesanan, termasuk pesanan tambahan,
- pembayaran, split bill, sumber QRIS Manual/Midtrans, refund,
- permintaan, approval/penolakan refund, penghentian tiket, dan notifikasi dapur,
- perubahan status KDS,
- perubahan meja, zona, dan layout denah,
- cetak ulang struk/nomor antrean,
- perubahan pengaturan.

---

## 7. State machine

### 7.1 Status pesanan

| Status | Arti | Masuk dari | Keluar ke |
| --- | --- | --- | --- |
| **Menunggu Pembayaran** | Pesanan tersimpan, belum lunas | Simpan pesanan | Lunas, Dibatalkan |
| **Sebagian Dibayar** | Ada pembayaran, total belum mencapai grand total | Menunggu Pembayaran | Lunas, Dibatalkan |
| **Lunas** | Total pembayaran = grand total; antrean dan tiket KDS dibuat | Menunggu Pembayaran/Sebagian Dibayar | Selesai, Refund |
| **Selesai** | Pesanan sudah diambil | Lunas | Refund |
| **Dibatalkan** | Pesanan batal sebelum lunas; pembayaran yang sudah tercatat dikembalikan | Menunggu Pembayaran/Sebagian Dibayar | — |
| **Refund** | Refund penuh tercatat setelah pesanan lunas | Lunas/Selesai | — |

Catatan:

- Status pesanan tidak sama dengan status KDS.
- Pesanan **Lunas** dapat memiliki status KDS apa pun.
- Pesanan **Selesai** tidak lagi tampil di KDS dan papan antrean. Pesanan
  **Refund** penuh juga dihentikan dari KDS dan papan antrean aktif.
- Refund sebagian tidak mengubah status pesanan dari **Lunas** atau **Selesai**;
  status **Refund** dipakai untuk refund penuh.
- Refund penuh setelah **Selesai** tetap dicatat sebagai **Refund**; tiket KDS
  sudah tidak aktif sehingga tidak ada notifikasi penghentian tiket.
- Pesanan yang sudah **Lunas** tidak boleh berstatus **Dibatalkan**; pembatalan
  setelah lunas dicatat sebagai **Refund** penuh.
- Setiap pesanan dalam satu kunjungan dine-in memiliki status, pembayaran,
  nomor antrean, dan tiket KDS sendiri.
- Pesanan tambahan adalah pesanan baru dengan nomor antrean baru; pesanan
  sebelumnya tidak berubah.
- Total nilai pembayaran yang dicatat tidak boleh melebihi grand total; uang
  tunai berlebih dicatat sebagai kembalian.
- Pada F1, transisi **Menunggu Pembayaran → Dibatalkan** hanya berlaku untuk
  pesanan tanpa pembayaran. Pembatalan wajib alasan dan dicatat di audit;
  kasir/admin boleh membatalkan, kitchen tidak.
- Transisi **Sebagian Dibayar → Dibatalkan** baru dijalankan pada F2 setelah
  refund bagian disetujui dan dicatat admin.
- Pesanan **Dibatalkan** bersifat final; untuk memesan lagi dibuat pesanan baru.
- Pembatalan pesanan belum lunas tidak membuat atau menghentikan nomor antrean
  maupun tiket KDS karena keduanya belum pernah dibuat.

### 7.2 Status pembayaran

| Status | Arti |
| --- | --- |
| **Belum Dibayar** | Belum ada pembayaran |
| **Sebagian** | Total pembayaran < grand total; belum ada refund |
| **Lunas** | Total pembayaran = grand total; belum ada refund |
| **Refund Sebagian** | Sebagian pembayaran yang tercatat dikembalikan; masih ada dana yang tidak direfund |
| **Refund Penuh** | Seluruh pembayaran yang tercatat dikembalikan; tidak ada dana tersisa |

Metode dan sumber pembayaran disimpan per baris pembayaran. **QRIS Manual** dan
**QRIS Midtrans** adalah sumber berbeda meskipun sama-sama memakai metode QRIS.
Status pembayaran **Sebagian** berbeda dari status pesanan **Sebagian Dibayar**;
keduanya menunjukkan total pembayaran belum mencapai grand total. Status
pembayaran mengikuti dana yang tercatat, bukan status pesanan: pesanan
**Dibatalkan** sebelum lunas yang seluruh pembayaran sebagiannya dikembalikan
memakai status pembayaran **Refund Penuh**.

### 7.3 Status meja

| Status | Arti | Transisi |
| --- | --- | --- |
| **Kosong** | Tidak ada kunjungan dine-in aktif | → Menunggu Pembayaran saat kunjungan baru dibuka |
| **Menunggu Pembayaran** | Ada kunjungan aktif dengan minimal satu pesanan belum lunas | → Terisi saat semua pesanan aktif lunas; → Kosong setelah kasir/admin menutup kunjungan bila seluruh pesanan dalam kunjungan dibatalkan sebelum lunas dan tidak ada pembayaran tertunda |
| **Terisi** | Semua pesanan aktif dalam kunjungan sudah lunas | → Menunggu Pembayaran bila ada pesanan tambahan belum lunas; → Kosong setelah semua pesanan selesai/dibatalkan/direfund dan kunjungan ditutup |

Catatan milestone:

- **F1.2** wajib merender ketiga status pada denah. Transisi nyata ke
  **Menunggu Pembayaran** dan kembali **Kosong** setelah pembatalan pesanan
  belum lunas diuji pada **F1.3**.
- Transisi nyata ke **Terisi** memerlukan pembayaran dan diuji pada **F2**.
  F1 tidak boleh menandai pesanan **Lunas** atau membuat pembayaran.

### 7.4 Status KDS

| Status | Arti | Transisi |
| --- | --- | --- |
| **Pesanan Masuk** | Tiket baru setelah lunas | → Sedang Disiapkan |
| **Sedang Disiapkan** | Sedang dikerjakan | → Siap Diambil |
| **Siap Diambil** | Siap diambil pelanggan | Dihapus dari papan saat kasir/admin mengonfirmasi pengambilan |

Tidak ada status KDS keempat. Kitchen hanya mengubah status sampai **Siap
Diambil**; konfirmasi pengambilan adalah aksi kasir/admin di luar papan KDS.

### 7.5 Status antrean

Status antrean mengikuti status KDS:

- **Pesanan Masuk**
- **Sedang Disiapkan**
- **Siap Diambil**

Antrean hilang dari papan setelah pesanan **Selesai**. Pesanan yang direfund
penuh dihentikan dan hilang dari papan aktif; status antrean tidak bertambah
menjadi status keempat. Riwayat tetap tersimpan.

### 7.6 Status kunjungan dine-in

| Status | Arti |
| --- | --- |
| **Terbuka** | Pelanggan masih di meja; pesanan baru/tambahan boleh dibuat |
| **Ditutup** | Semua pesanan selesai/dibatalkan/direfund dan meja sudah dikosongkan |
| **Dibatalkan** | Kunjungan batal sebelum ada pesanan yang perlu diselesaikan |

Satu meja hanya boleh memiliki satu kunjungan **Terbuka** pada satu waktu.
Override admin tidak mengubah definisi ini: pesanan aktif dan pembayaran
tertunda harus diselesaikan lebih dahulu sebelum kunjungan dapat ditutup.

### 7.7 Idempotensi dan anti-duplikasi

- Pembuatan pesanan memakai idempotency key; klik ganda atau retry
  mengembalikan pesanan yang sama, bukan membuat pesanan baru.
- Pembuatan pembayaran dan pemrosesan webhook Midtrans harus idempoten.
- Setiap pembayaran online Midtrans pada split bill memakai transaksi gateway
  tersendiri dengan `midtrans_order_id` unik; callback duplikat tidak boleh
  membuat pembayaran ganda.
- Nomor antrean dibuat tepat sekali per pesanan dan unik per tanggal bisnis.
- Pesanan tambahan selalu membuat ID pesanan baru dan nomor antrean baru;
  nomor antrean lama tidak boleh dipakai ulang.
- Transaksi database dan unique constraint wajib mencegah pesanan, pembayaran,
  atau antrean ganda.

---

## 8. Aturan perhitungan

1. Harga produk dan modifier dalam rupiah.
2. Subtotal baris sebelum diskon = (harga produk + total selisih modifier) ×
   jumlah.
3. Diskon produk dihitung per baris; line total = subtotal baris sebelum diskon
   − diskon produk.
4. Subtotal pesanan sebelum diskon = jumlah subtotal baris sebelum diskon.
5. Subtotal setelah diskon produk = jumlah line total.
6. Diskon seluruh pesanan dihitung dari subtotal setelah diskon produk. Diskon
   manual dihitung dari subtotal setelah diskon produk dan diskon pesanan.
7. Total diskon = diskon produk + diskon pesanan + diskon manual. Diskon pesanan
   tidak boleh melebihi subtotal setelah diskon produk; diskon manual tidak boleh
   melebihi subtotal setelah diskon produk dan diskon pesanan. Total diskon tidak
   boleh melebihi subtotal pesanan sebelum diskon.
8. Dasar pengenaan pajak = subtotal setelah diskon produk − diskon pesanan −
   diskon manual = subtotal pesanan sebelum diskon − total diskon.
9. Pajak = persentase pajak × dasar pengenaan pajak.
10. Service charge = persentase service charge × dasar pengenaan pajak.
11. Grand total = dasar pengenaan pajak + pajak + service charge.
12. Pembulatan mengikuti kebijakan restoran; bila diterapkan, aturan pembulatan
    harus konsisten dan terlihat di struk.
13. Split bill dihitung terhadap grand total. Saat pesanan lunas, total nilai
    pembayaran yang dicatat harus sama dengan grand total dan tidak boleh
    melebihi tagihan. Uang tunai yang diserahkan boleh lebih; selisihnya dicatat
    sebagai kembalian.
14. Nilai diskon, pajak, service charge, dan grand total disimpan sebagai
    snapshot pada pesanan saat lunas.

---

## 9. Requirement yang tetap berlaku

Requirement berikut berasal dari baseline F0/README serta keputusan 1.2, 1.3, dan 1.4;
**tidak dihapus**:

- Login staf dengan username; pemetaan internal ke `username@saji.app`
  dipertahankan agar akun lama tetap kompatibel.
- Role `admin`, `kasir`, `kitchen`; sumber kebenaran di `profiles`.
- Lima akun awal (1 admin, 2 kasir, 2 kitchen) tidak dihapus.
- Admin dapat membuat akun staf; tidak ada pendaftaran mandiri.
- Sesi idle (`SESSION_IDLE_MINUTES`) dan rate limit login.
- Audit log untuk aktivitas istimewa.
- Service role key hanya di server.
- RLS pada seluruh tabel.
- Midtrans signature verification dan pemisahan Sandbox/Production.
- Pajak dan service charge dihitung setelah diskon.
- Diskon produk, diskon pesanan, dan diskon manual; diskon manual memerlukan
  approval admin dan seluruh diskon dicatat di audit.
- Kasir tidak dapat mengubah harga produk secara bebas.
- Split bill Midtrans memakai transaksi gateway terpisah untuk setiap pembayaran
  online; total pembayaran tidak boleh melebihi tagihan.
- Refund hanya admin; refund penuh setelah lunas memerlukan approval admin, dan
  notifikasi dapur hanya bila tiket KDS masih aktif; refund tunai memengaruhi
  shift; tanpa shift aktif, pengeluaran tunai dicatat admin.
- Struk 58/80 mm melalui browser print pada F2; integrasi ESC/POS tidak wajib.
- Papan antrean publik tanpa data pribadi/keuangan.
- Stok, bahan baku, resep, penyesuaian stok (F4).
- Shift, kas drawer, tutup shift, rekonsiliasi (F5).
- Laporan, export, audit lanjutan (F6).
- Tidak ada akun, transaksi, atau data contoh.
- Denah meja interaktif sebagai challenge pembimbing.
- Split bill dan pencatatan pembayaran.
- QRIS Manual dan QRIS Midtrans sebagai sumber pembayaran berbeda.
- Pesanan tambahan dengan nomor antrean baru pada kunjungan dine-in yang sama.
- Konfirmasi pengambilan hanya oleh kasir/admin.

---

## 10. Non-functional requirements

### 10.1 Keamanan

- Semua mutasi memakai Server Action/route server; otorisasi dicek di server.
- Service role key tidak pernah masuk bundle browser.
- RLS aktif pada semua tabel baru.
- Validasi input memakai Zod di server.
- Pembayaran dan pembuatan nomor antrean harus atomik dan idempoten.
- Setiap pembayaran menyimpan metode dan sumber/channel; QRIS Manual dan QRIS
  Midtrans tidak boleh tercampur tanpa rincian.
- Setiap pembayaran online Midtrans pada split bill memakai transaksi gateway
  terpisah dan `midtrans_order_id` unik.
- Diskon manual hanya dapat disetujui admin melalui server; kasir tidak dapat
  mengubah harga produk secara bebas.
- Approval refund dan notifikasi penghentian tiket hanya dapat dilakukan admin
  melalui server; kitchen tidak dapat menyetujui refund.
- Webhook Midtrans diverifikasi signature dan status transaksi.
- Audit log tidak dapat diubah dari client.
- Akses `/admin/*` hanya admin; `/pos` admin/kasir; `/kitchen` admin/kitchen.

### 10.2 Integritas data

- Gunakan transaksi database untuk pembayaran, split bill, nomor antrean,
  pesanan tambahan, dan perubahan status KDS.
- Unique constraint untuk nomor antrean per tanggal dan idempotency key untuk
  pesanan/pembayaran.
- Saat pesanan lunas, total nilai pembayaran yang dicatat harus sama dengan
  grand total dan tidak boleh melebihi tagihan; kembalian tunai disimpan
  terpisah.
- Setiap pembayaran online Midtrans memiliki `midtrans_order_id` unik dan
  idempotency key sendiri.
- Diskon produk, diskon pesanan, dan diskon manual disimpan sebagai snapshot;
  diskon manual menyimpan alasan, status approval, approver, dan waktu approval.
- Satu meja hanya boleh memiliki satu kunjungan dine-in aktif; beberapa pesanan
  boleh berada dalam kunjungan yang sama.
- Snapshot harga/nama produk dan modifier pada item pesanan.
- Refund penuh setelah lunas harus memiliki status approval, aktor approval, dan
  waktu approval. Bila tiket KDS masih aktif, waktu notifikasi dapur juga wajib
  dicatat.
- Soft delete/arsip untuk produk, kategori, dan meja yang sudah dipakai
  transaksi.
- Jangan menghapus riwayat pesanan/pembayaran; gunakan status dan audit.

### 10.3 Performa

- Pencarian dan penambahan produk terasa responsif pada perangkat kasir.
- KDS menerima tiket baru dalam hitungan detik setelah pembayaran lunas.
- Papan antrean publik diperbarui tanpa refresh manual.
- Gunakan indeks pada kolom status, tanggal, meja, dan nomor antrean.
- Fallback polling bila realtime tidak tersedia.

### 10.4 Usability

- Bahasa Indonesia.
- Mode terang; identitas teal/terracotta dipertahankan.
- Target sentuh nyaman untuk tablet.
- Status meja dibedakan dengan warna dan label, bukan warna saja.
- Konfirmasi sebelum aksi destruktif (batal, refund, kosongkan meja).
- Empty state dan error state yang jelas.

### 10.5 Waktu dan format

- Zona waktu operasional: `Asia/Jakarta`.
- Mata uang: IDR, format `id-ID`.
- Tanggal bisnis untuk nomor antrean mengikuti tanggal Jakarta, bukan UTC.

### 10.6 Printing

- Pada F2, pencetakan memakai **browser print** sebagai metode awal.
- Layout struk 58 mm dan 80 mm harus tersedia dan diuji.
- Integrasi ESC/POS atau printer thermal khusus **tidak wajib** pada F2.
- Integrasi printer khusus dapat dipertimbangkan pada fase berikutnya.
- Cetak ulang struk dan nomor antrean dicatat.

### 10.7 Audit dan observability

- Catat aktor, waktu, entitas, dan detail perubahan.
- Catat diskon produk, diskon pesanan, diskon manual, alasan, dan approver.
- Catat transaksi gateway Midtrans per pembayaran online, termasuk event webhook
  yang diterima atau ditolak.
- Jangan mencatat password, service key, atau data sensitif di audit.
- Sediakan log server untuk error pembayaran/webhook.

---

## 11. Kesiapan database

### 11.1 Kondisi saat ini

Skema F0 saat ini hanya berisi:

| Tabel | Fungsi | Mendukung kebutuhan baru? |
| --- | --- | --- |
| `profiles` | Profil staf, role, status | Ya, untuk aktor dan role |
| `restaurant_settings` | Nama, pajak, service charge, struk | Sebagian; belum ada pengaturan antrean/meja |
| `audit_logs` | Jejak aktivitas generik | Ya, dapat menampung event baru |
| `login_attempts` | Rate limit login | Ya, tidak berubah |
| `daily_sequences` | Urutan harian generik | Ya, dapat dipakai nomor antrean |

**Kesimpulan:** database **belum siap** untuk counter ordering. Belum ada tabel
menu, modifier, meja, kunjungan dine-in, pesanan, item pesanan, diskon,
pembayaran, split bill, refund, KDS, atau antrean. Diperlukan migrasi baru pada
F1–F3.

### 11.2 Tabel yang perlu ditambahkan

| Kebutuhan | Tabel yang diusulkan | Fase | Catatan |
| --- | --- | --- | --- |
| Kategori menu | `menu_categories` | F1.1 | Seed Food/Drinks/Desserts/Packages sebagai master data, bukan data demo |
| Produk | `products` | F1.1 | Harga, foto, kategori, status, stasiun |
| Grup modifier | `modifier_groups` | F1.1 | Level pedas, ukuran, topping |
| Opsi modifier | `modifier_options` | F1.1 | Selisih harga |
| Produk–modifier | `product_modifier_groups` | F1.1 | Many-to-many |
| Zona meja | `table_zones` | F1.2 | Nama, urutan, status aktif |
| Meja | `dining_tables` | F1.2 | Nomor, kapasitas, zona, posisi x/y, bentuk, status |
| Kunjungan dine-in | `dining_sessions` | F1.3 | Satu sesi aktif per meja; menampung beberapa pesanan |
| Pesanan | `orders` | F1.3 | Tipe, meja, sesi, status, total snapshot, idempotency, pembatalan |
| Item pesanan | `order_items` | F1.3 | Snapshot nama/harga dan diskon produk per baris |
| Modifier item | `order_item_modifiers` | F1.3 | Snapshot nama/selisih harga |
| Diskon pesanan/manual | `order_discounts` | F1.4 | Jenis, cakupan, nilai, alasan, status approval, approver, audit |
| Pembayaran | `payments` | F2 | Metode, sumber/channel, nominal, referensi, status, transaksi gateway, idempotency |
| Refund | `refunds` | F2 | Penuh/sebagian, status approval, aktor, alasan, notifikasi dapur |
| Riwayat status | `order_status_events` | F2/F3 | Audit transisi pesanan/KDS |
| Tiket KDS (opsional) | `kitchen_tickets` | F3 | Bila butuh pemisahan per stasiun |
| Notifikasi dapur | `kitchen_notifications` | F3 | Penghentian tiket/refund dan pesan operasional |
| Shift | `shifts`, `cash_movements` | F5 | Sesuai requirement lama |
| Stok | `ingredients`, `recipes`, `stock_movements` | F4 | Sesuai requirement lama |

### 11.3 Kolom penting yang perlu dirancang

- `orders`: `id`, `order_number`, `queue_number`, `queue_date`,
  `business_date`, `order_type` (`dine_in`/`takeaway`), `table_id`,
  `dining_session_id`, `status`, `payment_status`, `kds_status`, `subtotal`,
  `discount_product_total`, `discount_order_total`, `discount_manual_total`,
  `discount_total`, `tax_total`, `service_total`, `grand_total`, `paid_total`,
  `idempotency_key`, `created_by`, `created_at`, `paid_at`, `completed_at`,
  `cancelled_at`, `cancelled_by`, `cancel_reason`. `queue_number` unik per
  `queue_date`.
- `dining_sessions`: `id`, `table_id`, `status`, `opened_at`, `closed_at`,
  `opened_by`, `closed_by`.
- `dining_tables`: `id`, `name`, `capacity`, `zone_id`, `x`, `y`, `shape`,
  `status`, `is_active`.
- `table_zones`: `id`, `name`, `sort_order`, `is_active`.
- `order_items`: `order_id`, `product_id`, `product_name_snapshot`,
  `unit_price_snapshot`, `quantity`, `notes`, `discount_amount`,
  `discount_type`, `discount_reason`, `line_total`.
- `order_discounts`: `id`, `order_id`, `scope` (`order`/`manual`), `type`
  (`percentage`/`fixed`), `value`, `amount`, `reason`, `status`
  (`pending`/`approved`/`rejected`), `requested_by`, `approved_by`,
  `approved_at`, `created_at`.
- `order_item_modifiers`: `order_item_id`, `modifier_option_id`,
  `name_snapshot`, `price_delta_snapshot`.
- `payments`: `order_id`, `payment_method`, `payment_channel`, `amount`,
  `status`, `reference`, `midtrans_order_id`, `gateway_transaction_id`,
  `idempotency_key`, `paid_at`, `created_by`, `shift_id`, `change_amount`.
  `midtrans_order_id` unik per pembayaran online.
- `refunds`: `order_id`, `payment_id` (opsional), `amount`, `refund_type`,
  `status` (`pending`/`approved`/`rejected`), `reason`, `requested_by`,
  `approved_by`, `approved_at`, `kitchen_notified_at`, `created_at`.
- `kitchen_notifications`: `id`, `order_id`, `type`, `message`, `created_at`,
  `acknowledged_at`.
- `products`: `id`, `category_id`, `name`, `sku`, `price`, `photo_url`,
  `description`, `is_active`, `is_available`, `kitchen_station`, `sort_order`.

### 11.4 RLS dan grant

Setiap tabel baru harus:

- mengaktifkan RLS,
- memberi akses baca sesuai peran (admin/kasir/kitchen),
- membatasi tulis ke server action/service role,
- memiliki policy yang diuji,
- tidak memberi akses `anon` kecuali data publik papan antrean yang memang
  dirancang aman.

### 11.5 Migrasi per fase

| Fase | Migrasi yang diusulkan | Isi |
| --- | --- | --- |
| F1.1 | `20261111000100_menu_master.sql` | Kategori, produk, modifier, produk–modifier, seed empat kategori, RLS, index |
| F1.2 | `20261111000200_tables_layout.sql` | Zona meja, meja, posisi/kapasitas/bentuk, layout, RLS, index |
| F1.3 | `20261111000300_orders_pos.sql` | Kunjungan dine-in, pesanan, item, modifier item, pembatalan, snapshot, idempotency, satu sesi aktif per meja |
| F1.4 | `20261111000400_discounts.sql` | Diskon produk/pesanan/manual, approval diskon, snapshot diskon, audit, constraint nilai |
| F2 | `20261112000100_payments_queue.sql` | Pembayaran, sumber/channel QRIS, transaksi gateway per pembayaran online, split bill, refund approval + waktu notifikasi dapur, nomor antrean, status lunas |
| F3 | `20261113000100_kds_queue.sql` | Status KDS, riwayat status, index realtime, papan antrean, notifikasi dapur |
| F4 | `20261114000100_inventory.sql` | Bahan baku, resep, stok |
| F5 | `20261115000100_shifts.sql` | Shift, kas drawer, rekonsiliasi |
| F6 | `20261116000100_reporting.sql` | View/laporan, export, audit lanjutan |

Nama file migrasi adalah usulan dan belum dibuat. Setiap migrasi harus
ditinjau, diuji di development, dan di-backup sebelum production.

---

## 12. Konflik requirement

Konflik berikut ditemukan antara keputusan terbaru dan dokumentasi/kode
placeholder. **Belum ada kode yang diubah.** Perbaikan dilakukan pada fase yang
tercantum.

| ID | Sumber | Konflik | Keputusan/penyelesaian | Fase |
| --- | --- | --- | --- | --- |
| C-01 | `src/app/(app)/kitchen/page.tsx` | Placeholder memakai empat status: baru, diproses, siap, disajikan | Ganti menjadi tiga status: Pesanan Masuk, Sedang Disiapkan, Siap Diambil; `disajikan` menjadi `diambil` dan bukan kolom KDS | F3 |
| C-02 | `src/app/(app)/pos/page.tsx` | Copy menyebut pembayaran `tunai, QRIS, kartu, atau manual` | Metode resmi: tunai, QRIS Manual, QRIS Midtrans, transfer, Midtrans; `manual` adalah cara pencatatan; kartu melalui Midtrans | F2 |
| C-03 | `src/app/(app)/pos/page.tsx` | Copy menyiratkan tiket dikirim ke dapur dari layar kasir sebelum pembayaran | Kirim ke KDS hanya setelah lunas; copy dan alur diperbaiki | F2/F3 |
| C-04 | `src/app/queue/page.tsx` | Copy: antrean muncul setelah kasir mengirim pesanan ke dapur | Antrean muncul setelah pembayaran lunas | F3 |
| C-05 | `src/app/(app)/kitchen/page.tsx` | Copy: pesanan baru masuk dari kasir secara real-time | Hanya pesanan lunas yang masuk KDS; copy diperbaiki | F3 |
| C-06 | `src/app/(app)/pos/page.tsx` | Copy: pilih meja dan jumlah tamu untuk semua pesanan | Meja hanya wajib untuk dine-in; takeaway tanpa meja | F1 |
| C-07 | `README.md` bagian keamanan | Frasa `pembayaran manual tetap tersedia` ambigu | Perjelas: pencatatan manual untuk tunai/QRIS Manual/transfer; Midtrans untuk gateway | Dokumentasi |
| C-08 | `README.md` roadmap | F3 mencakup antrean, tetapi nomor antrean dibuat saat pembayaran di F2 | Perjelas pembagian: F2 membuat nomor antrean; F3 menampilkan papan dan KDS | Dokumentasi |
| C-09 | `README.md` | Split bill dan pencatatan pembayaran belum dirinci | Tambahkan sebagai requirement F2 | Dokumentasi |
| C-10 | `README.md` roadmap | Denah meja interaktif belum eksplisit sebagai challenge wajib | Tambahkan sebagai deliverable wajib F1 | Dokumentasi |
| C-11 | Requirement refund lama | Refund penuh setelah pesanan masuk KDS belum mengatur approval dan notifikasi dapur | Refund penuh setelah lunas wajib approval admin; bila tiket KDS masih aktif, tiket dihentikan dan kitchen menerima notifikasi; semua aksi diaudit; refund sebagian tidak mengubah status KDS | F2/F3 |
| C-12 | `README.md` / Midtrans | `kartu` disebut terpisah, sementara Midtrans menangani kartu | Tidak ada metode `kartu` terpisah; pembayaran kartu diproses melalui Midtrans bila channel diaktifkan. EDC di luar scope. | F2 |
| C-13 | PRD 1.1 | Pesanan tambahan setelah pembayaran belum diputuskan | Pesanan baru dengan nomor antrean baru, tetap di meja/kunjungan yang sama, idempotent, tidak membuat antrean ganda | F1/F2 |
| C-14 | PRD 1.1 | Siapa yang mengonfirmasi pengambilan masih pertanyaan terbuka | Kitchen hanya sampai Siap Diambil; kasir/admin mengonfirmasi pengambilan | F3 |
| C-15 | PRD 1.1 | Kedalaman editor denah meja masih pertanyaan terbuka | Admin memiliki editor drag-and-drop dengan posisi, kapasitas, dan zona | F1 |
| C-16 | Dokumentasi | Risiko PRD ganda di root atau nama lain | `docs/PRD.md` adalah satu-satunya PRD utama; README dan roadmap menautkannya | Dokumentasi |
| C-17 | PRD 1.2 / README | Split bill belum mengatur transaksi gateway Midtrans untuk setiap bagian pembayaran online | Setiap pembayaran online Midtrans memakai transaksi gateway sendiri dengan `midtrans_order_id` unik; callback diverifikasi dan idempoten; saat lunas, total pembayaran harus sama dengan grand total dan tidak boleh melebihi; uang tunai berlebih menjadi kembalian | F2 |
| C-18 | PRD 1.2 / README | Aturan diskon masih generik; belum membedakan diskon produk, pesanan, dan manual | Tiga jenis diskon: produk per baris, pesanan setelah diskon produk, dan manual dengan alasan + approval admin; kasir tidak boleh mengubah harga produk; semua diskon tercatat di transaksi dan audit; pajak/service charge dihitung setelah seluruh diskon | F1 |
| C-19 | PRD 1.2 / README | Printing masih menyebut browser print sebagai fallback dan integrasi ESC/POS belum diputuskan | F2 memakai browser print untuk layout 58 mm dan 80 mm; integrasi ESC/POS tidak wajib; printer khusus dapat dipertimbangkan pada fase berikutnya | F2 |

---

## 13. Asumsi dan keputusan final

Asumsi dan keputusan yang sudah final:

1. Satu meja hanya memiliki satu **kunjungan dine-in aktif** pada satu waktu;
   satu kunjungan dapat memiliki beberapa pesanan.
2. Kunjungan dine-in dibuka saat pesanan dine-in pertama disimpan dan ditutup
   saat meja dikosongkan setelah semua pesanan selesai/dibatalkan/direfund penuh
   dan tidak ada pembayaran tertunda.
3. Pesanan tambahan setelah pembayaran menghasilkan pesanan baru dengan nomor
   antrean baru, tetap terhubung ke meja dan kunjungan yang sama, serta memakai
   idempotency key agar tidak ada pesanan/antrean ganda.
4. QRIS Manual dan QRIS Midtrans sama-sama didukung dan dicatat sebagai sumber
   pembayaran berbeda.
5. Refund penuh setelah pesanan lunas memerlukan approval admin. Bila tiket KDS
   dan antrean masih aktif, setelah disetujui keduanya dihentikan dan kitchen
   menerima notifikasi. Refund penuh setelah **Selesai** tetap diaudit tanpa
   penghentian tiket. Refund sebagian tidak menghentikan tiket KDS.
6. Kitchen hanya mengubah status sampai **Siap Diambil**; kasir/admin
   mengonfirmasi pengambilan.
7. Split bill dengan Midtrans memungkinkan beberapa pembayaran untuk satu
   pesanan. Setiap bagian pembayaran online memakai transaksi gateway sendiri
   dengan `midtrans_order_id` unik; callback diverifikasi dan diproses secara
   idempoten. Saat pesanan lunas, total nilai pembayaran harus sama dengan grand
   total dan tidak boleh melebihi tagihan; uang tunai berlebih dicatat sebagai
   kembalian.
8. Diskon terdiri dari **diskon produk**, **diskon seluruh pesanan**, dan
   **diskon manual**. Diskon manual memerlukan alasan dan approval admin.
   Kasir tidak dapat mengubah harga produk secara bebas. Seluruh diskon
   tercatat pada transaksi dan audit log.
9. Pajak dan service charge dihitung setelah seluruh diskon.
10. Pada F2, struk 58 mm dan 80 mm dicetak melalui **browser print**. Integrasi
    ESC/POS atau printer thermal khusus tidak wajib pada F2 dan dapat
    dipertimbangkan pada fase berikutnya.
11. `docs/PRD.md` adalah satu-satunya PRD utama.
12. Override tutup meja oleh admin bukan bypass: pesanan belum lunas harus
    dibatalkan, pembayaran tertunda diselesaikan, dan pesanan lunas yang masih
    aktif direfund penuh sebelum kunjungan ditutup. Tidak ada pesanan aktif atau
    pembayaran tertunda yang tertinggal.
13. F1 dipecah menjadi empat milestone internal: **F1.1 Menu & Master Data**,
    **F1.2 Meja & Denah**, **F1.3 POS Core, Kunjungan & Pesanan**, dan
    **F1.4 Diskon & Finalisasi**. F1.1 dan F1.2 boleh paralel; F1.3 menunggu
    keduanya; F1.4 menunggu F1.3. F1 selesai setelah F1.4 lulus gate.
14. Pembatalan pesanan belum lunas pada F1 hanya untuk **Menunggu Pembayaran**
    tanpa pembayaran. Kasir/admin boleh membatalkan dengan alasan wajib dan
    audit; kitchen tidak. Pembatalan **Sebagian Dibayar** dilakukan pada F2
    setelah refund bagian disetujui dan dicatat admin.
15. F1 berhenti pada **Menunggu Pembayaran**. Handoff ke pembayaran F2 berupa
    konfirmasi pesanan dan CTA pembayaran nonaktif/placeholder; F1 tidak
    mencatat pembayaran, nomor antrean, atau tiket KDS.
16. Denah F1.2 wajib merender tiga status meja. Transisi nyata ke **Terisi**
    diuji pada F2 karena memerlukan pembayaran.

Tidak ada pertanyaan terbuka yang menghalangi F1 untuk split bill, diskon, dan
printing. Detail teknis implementasi diputuskan pada fase terkait selama tidak
bertentangan dengan keputusan di atas.

---

## 14. Acceptance criteria tingkat produk

### F1 — Menu, meja, dan POS

F1 adalah fase induk dengan empat milestone internal. F1 dinyatakan selesai hanya
setelah F1.1–F1.4 lulus acceptance dan gate masing-masing.

#### F1.1 — Menu & Master Data

- Admin dapat mengelola kategori Food/Drinks/Desserts/Packages.
- Admin dapat membuat produk dengan foto, nama, harga, modifier, status aktif,
  status ketersediaan, dan stasiun dapur opsional.
- Admin dapat mengelola grup/opsi modifier dan menghubungkannya ke produk.
- Modifier wajib/opsional dan batas pilihan tervalidasi di server.
- Perubahan harga modifier terlihat pada master data dan snapshot disiapkan
  untuk pesanan.
- Produk nonaktif/tidak tersedia tidak dapat dipesan; pengujian dari POS
  dilakukan pada F1.3.
- RLS, grant, index, dan audit master data berjalan.
- Tidak ada tabel pesanan, pembayaran, KDS, atau antrean pada F1.1.

#### F1.2 — Meja & Denah

- Admin dapat mengelola zona dan meja, termasuk nomor, kapasitas, posisi x/y,
  bentuk, dan status aktif.
- Zona wajib dipilih; default **Utama** bila belum diatur.
- Zona yang masih memiliki meja aktif tidak dapat dinonaktifkan.
- Admin memiliki editor denah meja drag-and-drop dengan posisi, kapasitas, dan
  zona; layout dapat disimpan, diterbitkan, dan tetap sama setelah reload.
- Kasir dapat melihat denah yang sama dengan layout terbit.
- Denah meja interaktif dapat **merender** status kosong/menunggu pembayaran/
  terisi dari data uji terkontrol.
- Transisi nyata ke **Menunggu Pembayaran** diuji pada F1.3; transisi nyata ke
  **Terisi** diuji pada F2 karena memerlukan pembayaran.
- Meja dengan riwayat tidak dihapus permanen; dinonaktifkan.
- Tidak ada pesanan, KDS, atau nomor antrean pada F1.2.

#### F1.3 — POS Core, Kunjungan & Pesanan

- POS memiliki dua bagian: kategori/produk di kiri, keranjang/total di kanan.
- Kasir dapat mencari produk, memilih modifier, dan melihat perubahan harga.
- Kasir dapat memilih dine-in/takeaway; meja wajib untuk dine-in.
- Satu meja hanya memiliki satu kunjungan dine-in aktif; satu kunjungan dapat
  memiliki beberapa pesanan.
- Pesanan tersimpan sebagai **Menunggu Pembayaran**; belum masuk KDS dan belum
  memiliki nomor antrean.
- Penambahan item sebelum lunas tetap pada pesanan yang sama.
- Pembuatan pesanan idempotent dan tidak membuat pesanan ganda.
- Kasir/admin dapat membatalkan pesanan **Menunggu Pembayaran** tanpa pembayaran
  dengan alasan wajib; kitchen tidak dapat membatalkan; pembatalan tercatat di
  audit dan tidak dapat dibuka kembali.
- Setelah pembatalan, meja kembali **Kosong** hanya bila tidak ada pesanan aktif
  lain dan tidak ada pembayaran tertunda; bila ada, status meja mengikuti
  pesanan yang tersisa.
- Kunjungan dapat ditutup dan meja dikosongkan setelah semua pesanan
  selesai/dibatalkan/direfund penuh dan tidak ada pembayaran tertunda.
- Setelah simpan, tampil konfirmasi **Menunggu Pembayaran** dengan CTA
  pembayaran nonaktif/placeholder; F1 tidak mencatat pembayaran.
- F1 tidak menghasilkan tiket KDS atau nomor antrean.

#### F1.4 — Diskon & Finalisasi

- Tiga jenis diskon tersedia: diskon produk, diskon seluruh pesanan, dan diskon
  manual.
- Diskon manual memerlukan alasan dan approval admin; diskon yang belum
  disetujui tidak diterapkan pada pesanan.
- Kasir tidak dapat mengubah harga produk secara bebas.
- Diskon produk dihitung per baris, diskon pesanan setelah diskon produk,
  diskon manual setelah diskon pesanan, dan pajak/service charge setelah seluruh
  diskon.
- Diskon pesanan tidak melebihi subtotal setelah diskon produk; diskon manual
  tidak melebihi subtotal setelah diskon produk dan diskon pesanan; total diskon
  tidak melebihi subtotal pesanan sebelum diskon.
- Semua diskon tersimpan pada transaksi dan tercatat di audit log.
- Seluruh acceptance F1.1–F1.4 lulus; typecheck, lint, build, dan E2E F1 PASS.
- Tidak ada tiket KDS atau nomor antrean yang dihasilkan F1.

### F2 — Pembayaran, split bill, pesanan tambahan, antrean, struk

- Tunai, QRIS Manual, QRIS Midtrans, transfer, dan Midtrans dapat dicatat.
- QRIS Manual dan QRIS Midtrans tercatat sebagai sumber pembayaran berbeda.
- Split bill dapat mencatat beberapa pembayaran, termasuk campuran sumber.
- Setiap pembayaran online Midtrans pada split bill memakai transaksi gateway
  terpisah dengan `midtrans_order_id` unik.
- Webhook duplikat tidak membuat pembayaran ganda; total pembayaran tidak boleh
  melebihi grand total dan uang tunai berlebih dicatat sebagai kembalian.
- Pesanan menjadi lunas hanya saat total pembayaran sama dengan grand total.
- Transisi nyata meja menjadi **Terisi** setelah semua pesanan aktif lunas diuji
  pada F2.
- Pembatalan pesanan **Sebagian Dibayar** hanya diizinkan setelah refund bagian
  disetujui dan dicatat admin; pesanan berstatus **Dibatalkan** dan tidak ada
  antrean/KDS yang perlu dihentikan.
- Nomor antrean `A001` dibuat setelah lunas dan unik per hari.
- Pesanan tambahan setelah pembayaran mendapat nomor antrean baru, tetap di meja
  dan kunjungan yang sama, serta tidak membuat antrean ganda.
- Tiket KDS dibuat setelah lunas.
- Struk 58/80 mm dapat dicetak melalui browser print dan menampilkan sumber
  pembayaran, rincian diskon, serta approver diskon manual bila ada.
- Integrasi ESC/POS atau printer thermal khusus tidak diwajibkan pada F2.
- Refund penuh setelah lunas sebelum pesanan **Selesai** memerlukan approval
  admin; bila tiket KDS masih aktif, tiket ditandai dihentikan dan notifikasi
  dapur dicatat. Refund penuh setelah **Selesai** tetap diaudit tanpa penghentian
  tiket. Penghentian tiket di papan KDS diuji pada F3.
- Refund tunai memengaruhi shift bila modul shift aktif.
- Midtrans hanya valid setelah webhook terverifikasi.

### F3 — KDS dan papan antrean

- KDS hanya menampilkan pesanan lunas.
- KDS memiliki tepat tiga status.
- Kitchen hanya mengubah status sampai **Siap Diambil**.
- Kasir/admin mengonfirmasi pengambilan; kitchen tidak memiliki aksi tersebut.
- Perpindahan status tervalidasi dan tercatat.
- Refund penuh yang disetujui atas pesanan dengan tiket KDS aktif menghentikan
  tiket dan mengirim notifikasi dapur.
- Papan antrean publik menampilkan nomor dan status tanpa data pribadi/keuangan.
- Pesanan selesai hilang dari KDS dan papan antrean.
- Realtime berjalan dengan fallback polling.

### F4–F6

- Stok, shift, dan laporan mengikuti requirement lama dan tidak menghapus fitur
  yang sudah ada.

---

## 15. Change log

| Versi | Tanggal | Perubahan |
| --- | --- | --- |
| 1.0 | 10 November 2026 | Baseline F0: auth, peran, audit, pengguna, keamanan |
| 1.1 | 11 November 2026 | Tambah counter ordering, POS dua bagian, kategori Food/Drinks/Desserts/Packages, modifier, dine-in/takeaway, denah meja, antrean A001, KDS tiga status, pembayaran sebelum KDS, split bill, analisis database, dan konflik requirement |
| 1.2 | 11 November 2026 | Tegaskan QRIS Manual vs QRIS Midtrans, approval refund setelah KDS + notifikasi dapur, pesanan tambahan dengan antrean baru pada kunjungan yang sama, konfirmasi pengambilan hanya kasir/admin, editor denah drag-and-drop dengan zona, serta `docs/PRD.md` sebagai satu-satunya PRD utama |
| 1.3 | 11 November 2026 | Tetapkan split bill Midtrans per transaksi gateway dengan callback idempoten dan total pembayaran tidak boleh melebihi tagihan; tiga jenis diskon dengan approval admin, larangan kasir mengubah harga, pencatatan transaksi/audit, dan pajak/service setelah diskon; browser print 58/80 mm pada F2 tanpa kewajiban ESC/POS |
| 1.4 | 11 November 2026 | Audit konsistensi pra-F1: tegaskan status pesanan **Selesai → Refund**, lima status pembayaran, refund penuh setelah lunas/Selesai, penghentian antrean dan tiket KDS, transisi meja saat pembatalan, arti override tutup meja, pencatatan tunai split bill, serta klarifikasi konfirmasi pengambilan dan metode kartu |
| 1.5 | 11 November 2026 | Pecah F1 menjadi F1.1 Menu & Master Data, F1.2 Meja & Denah, F1.3 POS Core/Kunjungan/Pesanan, dan F1.4 Diskon & Finalisasi; tambah FR-POS-11 pembatalan pesanan belum lunas (role, alasan, audit, dampak meja) dan FR-POS-12 handoff ke pembayaran F2; tegaskan F1.2 merender tiga status meja dan transisi **Terisi** diuji di F2; tegaskan F1 tidak menghasilkan tiket KDS/nomor antrean; pecah migration F1 |
