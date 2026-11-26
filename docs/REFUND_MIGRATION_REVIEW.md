# Nine Licious POS — Audit Dampak & Review Migration Plan Refund System (R1–R5)

**Status:** Siap Review Eksekusi (Belum Dijalankan ke Supabase Live Database)  
**Tanggal Pembaruan:** 26 November 2026  
**Cakupan:** Revisi Final R1–R5 ([20261126000100](file:///d:/POS%20online/supabase/migrations/20261126000100_refund_r1_foundation.sql) s.d. [20261126000500](file:///d:/POS%20online/supabase/migrations/20261126000500_refund_r5_atomic_refund_engine.sql)), Hardening `SECURITY DEFINER`, Rollback/Data Safety, dan Audit Integrasi Sistem Menyeluruh.

---

## 1. Daftar File Migration R1–R5

Seluruh migrasi dijalankan berurutan di atas skema **F0–F6** saat ini (termasuk [20261125000100_require_active_shift_for_pos_orders.sql](file:///d:/POS%20online/supabase/migrations/20261125000100_require_active_shift_for_pos_orders.sql)):

| Urutan | File Migrasi | Perubahan Utama |
|---|---|---|
| **R1** | [20261126000100_refund_r1_foundation.sql](file:///d:/POS%20online/supabase/migrations/20261126000100_refund_r1_foundation.sql) | Ekstensi `public.refunds` (`approval_status`, `payout_status`, `resolution_type`, komponen pembukuan `reference_service_charge_amount` & `reference_tax_amount`, constraint `replacement` boleh `amount = 0`), `refund_items` (dengan `is_full_item_refund`, `reference_service_charge_amount`, `reference_tax_amount`), `refund_payout_allocations` (Split Bill multi-payment), dan `refund_corrections`. |
| **R2** | [20261126000200_refund_r2_replacement_inventory.sql](file:///d:/POS%20online/supabase/migrations/20261126000200_refund_r2_replacement_inventory.sql) | Penanda `orders.order_kind` (`standard`/`replacement`) & `parent_order_id`, update `assert_active_cashier_shift_for_order_mutation()` (`SET search_path = ''`, serialisasi `pg_catalog.to_jsonb(new)` lintas tabel `orders`/`order_items`/`dining_sessions` agar Replacement bebas shift aktif tanpa membuka celah order biasa), `order_replacements`, `kds_item_cancellations`, serta mutasi stok `'waste'` (`quantity_delta = 0, wasted_quantity > 0`) & `'refund_restock'`. |
| **R3** | [20261126000300_refund_r3_evidence_notifications.sql](file:///d:/POS%20online/supabase/migrations/20261126000300_refund_r3_evidence_notifications.sql) | Bucket privat `refund-evidence` (`public = false`, maks 50 MB), tabel `refund_evidence`, tabel persisten `notifications` + trigger anti-tampering konten, serta publikasi `supabase_realtime`. Seluruh fungsi memakai `SET search_path = ''`. |
| **R4** | [20261126000400_refund_r4_paid_at_and_allocation.sql](file:///d:/POS%20online/supabase/migrations/20261126000400_refund_r4_paid_at_and_allocation.sql) | Kolom `orders.paid_at` + backfill historis (`success` & `refunded`), update `execute_order_payment_internal`, kalkulasi `calculate_refund_breakdown_internal` (kompensasi 25%/50% murni DPP & Rp 0 pajak/service + kumulatif per `order_item_id`), `get_order_receipt_data`, serta `get_dining_session_summary` & `close_dining_session_atomic` (`pending_approval` tidak memblokir tutup meja). |
| **R5** | [20261126000500_refund_r5_atomic_refund_engine.sql](file:///d:/POS%20online/supabase/migrations/20261126000500_refund_r5_atomic_refund_engine.sql) | 14 fungsi transaksional `SET search_path = ''` dengan hierarki lock `L1 → L2 → L3 → L4 → L5 → L6 → L7 → L8`, penguncian `order_items` & `refunds` (`FOR UPDATE`) sebelum hitung kumulatif, `confirm_midtrans_refund_atomic` idempoten per leg Split Bill (`service_role` only), koreksi `under_refund`/`over_refund`, dan kompatibilitas RPC lama F2.4/F5 `process_order_refund_atomic`. |

---

## 2. Penerapan Final Business Rules (Section A)

### A.1 Penutupan Meja (`close_dining_session_atomic` & `get_dining_session_summary`)
- Pengajuan refund berstatus `approval_status = 'pending_approval'` **tidak memblokir** `close_dining_session_atomic` maupun `get_dining_session_summary`. Kasir dan admin dapat menutup meja secara normal apabila seluruh pesanan standar meja sudah selesai dan tidak ada transaksi pembayaran aktif.
- Penutupan meja **hanya ditahan** apabila terdapat pengembalian dana yang sudah **disetujui** (`approval_status = 'approved'`) dan pencairan gateway Midtrans-nya masih berjalan (`payout_status in ('pending', 'processing', 'reconciliation_required')` pada `refunds` atau `refund_payout_allocations` dengan metode `midtrans`/`mixed`).
- Pengajuan replacement (`resolution_type = 'replacement'`) dan pesanan pengganti (`order_kind = 'replacement'`) menggunakan `table_id = null` dan `dining_session_id = null`, sehingga tidak memengaruhi status okupansi meja maupun perhitungan tagihan sesi meja.

### A.2 Kompensasi Parsial 25% & 50% vs Pembatalan Item 100%
- **Baseline item pesanan:** `calculate_refund_breakdown_internal` menghitung DPP item bersih secara deterministik setelah diskon produk serta alokasi proporsional `discount_order_total + discount_manual_total` (dengan metode kumulatif berurutan guna mencegah *rounding drift*).
- **Kompensasi `25%` (`light`) & `50%` (`medium`):**
  - Dihitung **hanya dari nilai bersih item (DPP setelah alokasi diskon)**: `refund_amount = net_item_amount = round(req_dpp * pct / 100)`.
  - Komponen `service_charge_amount` dan `tax_amount` yang dikembalikan ke pelanggan dipaksa bernilai **Rp 0**.
  - Nilai service charge dan pajak proporsional item tetap disimpan pada kolom pembukuan terpisah: `reference_service_charge_amount` dan `reference_tax_amount` pada tabel `public.refunds` dan `public.refund_items`.
- **Pembatalan item `100%` (`heavy`) & `full_refund`:**
  - Mengembalikan sisa DPP yang belum diklaim ditambah sisa `service_charge_amount` dan `tax_amount` yang menjadi bagian item/pesanan tersebut (`is_full_item_refund = true`), sehingga akumulasi maksimal sama dengan nilai penuh yang dibayarkan pelanggan untuk item tersebut.

### A.3 Pengajuan Ulang & Pencegahan Double-Claim / Over-Compensation (`order_item_id`)
- Item yang telah menerima kompensasi `25%` atau `50%` tetap dapat diajukan kembali oleh kasir/admin menggunakan agregasi kumulatif historis per `order_item_id` (mengabaikan pengajuan `rejected`, `cancelled`, `failed`, dan `replacement`).
- Total akumulasi kompensasi per `order_item_id` dibatasi keras agar **tidak pernah melampaui nilai DPP bersih (untuk klaim 25%/50%) maupun nilai penuh item (untuk pembatalan 100%)**, dengan toleransi pembulatan `<= Rp 1` hanya saat klaim parsial terakhir tepat menuntaskan 100% DPP.
- Begitu item mencapai batas 100% (`v_prior_refund_total >= v_base_full_total`, `v_prior_full_qty >= quantity`, `is_full_item_refund = true`, atau DPP terpakai penuh untuk klaim parsial), seluruh pengajuan ulang pada item tersebut langsung ditolak.
- Untuk mencegah kondisi balapan paralel (*race condition*), `request_order_refund_atomic` dan `approve_order_refund_atomic` mengunci baris `orders`, `order_items`, `order_allocations`, `midtrans_transactions`, `payments`, dan `refunds` dengan `FOR UPDATE` **sebelum** memanggil `calculate_refund_breakdown_internal`.

---

## 3. Audit Keamanan `SECURITY DEFINER`, Schema Qualification, RLS & Hak Akses (Section B)

Seluruh fungsi pada migrasi R1–R5 telah diaudit dan diperkeras dengan standar berikut:

1. **Paksa `SET search_path = ''` pada 100% fungsi `SECURITY DEFINER`:**
   - **R2 (1 fungsi):** `assert_active_cashier_shift_for_order_mutation()`. *(Perbaikan krusial yang ditemukan saat uji runtime PostgreSQL 18: memakai `pg_catalog.to_jsonb(new)` agar aman dipanggil lintas trigger tabel `orders`, `order_items`, dan `dining_sessions` tanpa error `record "new" has no field "order_kind"`.)*
   - **R3 (4 fungsi):** `protect_notification_payload_on_update()`, `notify_user_internal()`, `notify_role_users_internal()`, `mark_notifications_read_atomic()`.
   - **R4 (5 fungsi):** `execute_order_payment_internal()`, `calculate_refund_breakdown_internal()`, `get_order_receipt_data()`, `get_dining_session_summary()`, `close_dining_session_atomic()`.
   - **R5 (13 fungsi + `get_order_pending_refund_amount_internal`):** seluruh helper internal dan RPC publik.
2. **Kualifikasi Skema Penuh & Kompatibilitas Parser PostgreSQL:**
   - Seluruh referensi tabel, sequence, dan fungsi aplikasi di dalam badan PL/pgSQL maupun SQL memakai prefix eksplisit (`public.*`, `auth.uid()`, `pg_catalog.*`, `storage.*`).
   - Kata kunci grammar SQL (`greatest`, `least`, `coalesce`, `nullif`) dipastikan tetap tanpa prefix `pg_catalog.` (sesuai parser PostgreSQL 18), sementara fungsi `pg_proc` (`now`, `btrim`, `lower`, `char_length`, `format`, `round`, `abs`, `array_agg`, `array_length`, `gen_random_uuid`, `jsonb_*`, `set_config`, `to_jsonb`, dll.) dikualifikasi eksplisit `pg_catalog.*`.
3. **Matriks Hak Eksekusi (`REVOKE`/`GRANT`) & RLS Least Privilege:**
   - **Mutasi langsung dari klien dilarang:** Seluruh tabel finansial & ledger (`refunds`, `refund_items`, `refund_payout_allocations`, `refund_corrections`, `refund_evidence`, `order_replacements`, `kds_item_cancellations`) hanya mengizinkan `SELECT` via RLS terfilter; `INSERT`/`UPDATE`/`DELETE` langsung ditolak untuk `anon`, `authenticated`, `kasir`, dan `kitchen`.
   - **Isolasi role `kitchen`:** RLS menolak total pembacaan `kitchen` atas `refunds`, `refund_items`, `refund_payout_allocations`, `refund_corrections`, `refund_evidence`, dan bucket Storage `refund-evidence`. Role `kitchen` hanya dapat membaca `order_replacements` dan `kds_item_cancellations` yang bersih dari nominal uang dan PII pelanggan.
   - **Fungsi internal & `service_role`:** `execute_order_payment_internal`, `calculate_refund_breakdown_internal`, `get_order_pending_refund_amount_internal`, `execute_order_replacement_internal`, `execute_refund_approval_internal`, `notify_user_internal`, `notify_role_users_internal`, `mark_midtrans_refund_processing_atomic`, dan `confirm_midtrans_refund_atomic` telah di-`REVOKE ALL` dari `public, anon, authenticated` dan hanya dapat dijalankan internal/eksklusif `service_role` (khususnya `confirm_midtrans_refund_atomic` & `mark_midtrans_refund_processing_atomic`).
   - **Validasi Role dalam RPC Publik:**
     - `request_order_refund_atomic`, `cancel_order_refund_atomic`, `attach_refund_evidence_atomic`, `close_dining_session_atomic`: hanya `admin` atau `kasir` aktif (`kasir` dibatasi pada pengajuan sendiri dan `p_auto_approve` ditolak untuk kasir).
     - `approve_order_refund_atomic`, `reject_order_refund_atomic`, `complete_refund_manual_fallback_atomic`, `record_refund_correction_atomic`, `request_refund_evidence_atomic`, `process_order_refund_atomic`: hanya `admin` aktif.
4. **Penjagaan Kontrak F2.4, F4, F5, dan F6:**
   - `process_order_refund_atomic` (8-argumen), `execute_order_payment_internal` (11-argumen), `confirm_midtrans_refund_atomic` (4-argumen), `get_order_receipt_data(uuid)`, `get_dining_session_summary(uuid)`, dan `close_dining_session_atomic(uuid, uuid)` mempertahankan signature lama 100%.

---

## 4. Strategi Rollback & Keamanan Data Produksi (Section C)

> [!CAUTION]
> **DILARANG keras menjalankan `DROP TABLE ... CASCADE` pada skema R1–R5 setelah data operasional refund, pembukuan koreksi, replacement, atau bukti pengaduan mulai tercipta di database produksi.** Penghapusan tabel secara paksa akan menghilangkan jejak audit keuangan, mutasi stok `waste`/`refund_restock`, alokasi payout Split Bill, dan referensi `stock_movements` / `refunds` secara permanen.

### 4.1 Prasyarat Wajib Sebelum Eksekusi Migrasi ke Supabase
1. Ambil **snapshot / manual backup + pastikan PITR (*Point-in-Time Recovery*) aktif** di dashboard Supabase sebelum menjalankan R1.
2. Catat timestamp UTC tepat sebelum menjalankan R1–R5 agar titik pemulihan PITR terdefinisi jelas.
3. Uji terlebih dahulu R1–R5 pada project/branch **staging Supabase** bila tersedia.

### 4.2 Skenario 1 — Rollback Bersih Pra-Operasional (HANYA Jika Aplikasi Belum Aktif & Belum Ada Data Transaksi Baru)
Berlaku **eksklusif** apabila migrasi gagal di tengah jalan saat window maintenance **dan** belum ada satupun baris baru pada `refund_items`, `refund_payout_allocations`, `refund_corrections`, `order_replacements`, `refund_evidence`, `kds_item_cancellations`, atau `orders (order_kind = 'replacement')`:
1. Verifikasi terlebih dahulu jumlah baris (`SELECT count(*)`) seluruh tabel baru dan `stock_movements where movement_type in ('waste', 'refund_restock')` bernilai `0`.
2. Pulihkan fungsi RPC dan trigger ke definisi F0–F5 sebelumnya secara terbalik (**R5 → R4 → R3 → R2 → R1**):
   - Pulihkan fungsi dari [20261125000100](file:///d:/POS%20online/supabase/migrations/20261125000100_require_active_shift_for_pos_orders.sql), [20261120000100](file:///d:/POS%20online/supabase/migrations/20261120000100_f5_shift_and_cash_management.sql), dan [20261115000200](file:///d:/POS%20online/supabase/migrations/20261115000200_f2_4_post_migration_patch.sql).
   - `DROP FUNCTION IF EXISTS` khusus fungsi baru R3/R4/R5.
   - Hapus bucket/policy `refund-evidence` apabila kosong, lalu `DROP TABLE IF EXISTS` hanya pada tabel yang **terbukti kosong** (`0` baris), baru hapus kolom tambahan pada `refunds`, `orders`, dan `stock_movements`.

### 4.3 Skenario 2 — Pemulihan Pasca-Data Operasional Masuk (*Forward-Fix Recovery*, Tanpa `DROP TABLE`)
Jika migrasi R1–R5 sudah berjalan di produksi dan pengguna sudah membuat pengajuan refund, replacement, notifikasi, koreksi, atau bukti foto/video:
1. **Jangan menjalankan skrip `DROP TABLE` / `DROP COLUMN`**.
2. Untuk menghentikan perilaku workflow baru secara cepat sementara memperbaiki logika di aplikasi atau RPC:
   - Terapkan migrasi **forward-fix** yang hanya mengganti (`CREATE OR REPLACE FUNCTION`) definisi RPC bermasalah atau mencabut sementara hak `EXECUTE` RPC R5 baru (`REVOKE EXECUTE ... FROM authenticated`) agar kasir/admin sementara kembali melalui jalur darurat yang terkendali.
   - Pertahankan seluruh tabel R1–R3 beserta constraint pembukuan agar catatan historis (`refund_items`, `refund_corrections`, `stock_movements` `'waste'`/`'refund_restock'`, `order_replacements`, `audit_logs`) tetap utuh untuk rekonsiliasi keuangan dan pajak.
   - Jika terjadi kerusakan skema yang tidak dapat dipulihkan dengan forward-fix pada window rilis yang sama, lakukan **PITR Restore** ke timestamp prapenerapan migrasi dengan kesadaran bahwa transaksi setelah titik PITR harus direkonsiliasi ulang dari log pembayaran Midtrans & shift kas.

### 4.4 Risiko Kehilangan Data Jika Rollback Destruktif Tetap Dilakukan
Menjalankan `DROP TABLE ... CASCADE` setelah data operasional masuk mengakibatkan:
- Hilangnya bukti audit komponen pembukuan `reference_service_charge_amount` & `reference_tax_amount` untuk kompensasi 25%/50%.
- Hilangnya keterlacakan Split Bill multi-payment (`refund_payout_allocations`) dan status `reconciliation_required` Midtrans.
- Hilangnya buku pembantu `refund_corrections` (*under-refund* / *over-refund*), jejak `waste`/`refund_restock`, tiket dapur `kds_item_cancellations`/`order_replacements`, file bukti pelanggan (`refund_evidence`), dan jejak riwayat klaim kumulatif per `order_item_id`.

---

## 5. Audit Integrasi Lintas Modul (Section D)

Status kesesuaian setiap domain terhadap **R1–R5** saat ini (sebelum pembaruan UI & Server Actions TypeScript pada fase implementasi aplikasi berikutnya):

| Domain / Subsistem | Perlindungan Sudah Aktif di Level SQL (R1–R5) | Celah / Perubahan Wajib di Layer Aplikasi (Fase Implementasi) |
|---|---|---|
| **F2.4 (Refund & Struk)** | `process_order_refund_atomic` (8-arg) & `get_order_receipt_data` kompatibel 100%; kolom komponen pajak/service & `paid_at` tersedia; `get_order_receipt_data` menyertakan daftar refund. | Perbarui `src/lib/payments/actions.ts`, `src/lib/payments/receipt.ts`, dan [refund-modal.tsx](file:///d:/POS%20online/src/components/pos/refund-modal.tsx) agar mengarahkan pengajuan baru ke RPC R5 dan menampilkan breakdown DPP/pajak/service sesuai aturan A.2. |
| **F4 (Inventory & Reservasi Stok)** | `execute_order_replacement_internal` mengunci `ingredients` (L8), memvalidasi `(current_stock - reserved_stock) >= qty_needed`, mencatat `'waste'` (`quantity_delta = 0`, `wasted_quantity > 0`), lalu memotong bahan pengganti (`sale_deduction`). Item `queued` mendukung `'refund_restock'`. Constraint `current_stock >= reserved_stock` terjaga. | Perbarui `src/lib/inventory/constants.ts` (saat ini hanya menampilkan label `'manual_out'` sebagai deskripsi waste manual di baris 59) dan UI `/admin/inventory` agar menampilkan `movement_type = 'waste'`/`'refund_restock'` beserta `wasted_quantity`. |
| **F5 (Shift & Cash Drawer)** | Trigger `assert_active_cashier_shift_for_order_mutation` mengecualikan `order_kind = 'replacement'` & itemnya, sementara pesanan `'standard'` tetap wajib shift aktif. Refund tunai mengurangi `expected_cash` shift `open` + `cash_movements` (`cash_refund`) atau dicatat eksplisit `shift_id = null` (`out_of_shift`) bila shift sudah `closed`. | Tampilkan indikator status `open` shift vs `out_of_shift` pada panel persetujuan refund Admin dan laporan tutup shift di [transaction-history.tsx](file:///d:/POS%20online/src/components/admin/transactions/transaction-history.tsx). |
| **F6 (Laporan, Omzet, AOV, Count, & CSV)** | Di level DB: pesanan Replacement memakai `order_kind = 'replacement'` dengan `grand_total = 0, paid_total = 0`; pengajuan Replacement di `refunds` memakai `resolution_type = 'replacement', amount = 0`. *(Di DB data keuangan pengganti sudah bernilai 0, namun barisnya berstatus `paid`/`completed`.)* | **WAJIB pada Fase Aplikasi:** Query saat ini di [reports/actions.ts](file:///d:/POS%20online/src/lib/reports/actions.ts) (baris 110, 130, 294, 424) dan [export/actions.ts](file:///d:/POS%20online/src/lib/export/actions.ts) (baris 261) **belum memfilter `order_kind` maupun `resolution_type`**. Wajib tambahkan `.eq("order_kind", "standard")` pada query `orders` (agar Replacement tidak ikut `paidOrdersCount` maupun merusak AOV/CSV) serta `.neq("resolution_type", "replacement")` & `.eq("payout_status", "completed")` pada query laporan refund. |
| **Midtrans (Settlement, Refund, Webhook, Rekonsiliasi)** | `confirm_midtrans_refund_atomic` tetap eksklusif `service_role`, mendukung multi-leg Split Bill secara idempoten per `gateway_refund_id`, dan `complete_refund_manual_fallback_atomic` menyediakan jalur transfer bank manual berbukti saat gateway gagal/butuh rekonsiliasi. `cancel_order_refund_atomic` memblokir pembatalan jika Midtrans sudah `processing`/`reconciliation_required`/`completed`. | Perbarui handler webhook/API Midtrans refund di `src/lib/midtrans/` & `src/lib/payments/actions.ts` untuk memanggil `mark_midtrans_refund_processing_atomic` serta mengirim `p_expected_amount` per leg `refund_payout_allocations`. |
| **Split Bill Multi-Payment** | `refund_payout_allocations` membagi satu pengajuan refund ke beberapa baris `payments` (`cash`, `midtrans`, `transfer`, `manual`) tanpa melebihi sisa refundable tiap baris pembayaran dan menyinkronkan `payments.payment_status` secara akurat. | Bangun komponen UI alokasi Split Bill saat Admin menyetujui refund pesanan berbayar campuran di dashboard Admin. |
| **KDS & Replacement Order** | Pesanan Replacement otomatis berstatus `paid` + `kds_status = 'queued'`, `table_id = null`, `dining_session_id = null`, `notes = '[REPLACEMENT] ...'`. `kds_item_cancellations` dan `order_replacements` mempublikasikan event Realtime tanpa membocorkan nominal/PII ke role `kitchen`. | Query utama di [kds/actions.ts](file:///d:/POS%20online/src/lib/kds/actions.ts) (baris 160–173) sudah memuat pesanan `status = 'paid'` & `kds_status in ('queued','preparing','ready')` sehingga tiket Replacement otomatis tampil; tambahkan pembacaan `order_replacements`/`kds_item_cancellations` di KDS untuk badge `[REPLACEMENT]` dan alert pembatalan per item. |
| **Customer `/queue` & Estimasi Antrean Struk** | Di level DB: pesanan Replacement memakai `queue_number = null` dan `queue_date = null`. **Temuan Kritis Struk:** Pada [receipt.ts](file:///d:/POS%20online/src/lib/payments/receipt.ts) (baris 147–174), `isOrderBeforeInKds` melompati perbandingan nomor antrean jika `candidate.queue_number` bernilai `null` dan jatuh ke perbandingan `created_at`! | **WAJIB pada Fase Aplikasi:** Query kandidat antrean KDS untuk hitung estimasi sisa antrean struk di `src/lib/payments/` dan implementasi masa depan [queue/page.tsx](file:///d:/POS%20online/src/app/queue/page.tsx) (saat ini masih halaman statis kosong) **wajib memfilter `order_kind = 'standard'`** agar tiket `replacement` tidak memengaruhi hitungan antrean pelanggan biasa. |
| **Dining Session & Penutupan Meja** | R4 (`get_dining_session_summary` & `close_dining_session_atomic`) mengecualikan `order_kind = 'replacement'`, tidak memblokir `approval_status = 'pending_approval'`, dan hanya memblokir payout Midtrans aktif yang sudah `approved`. | Verifikasi integrasi wrapper fallback TS di [orders/actions.ts](file:///d:/POS%20online/src/lib/orders/actions.ts) agar saat R4 aktif, RPC menjadi sumber kebenaran tunggal dan pesan error pembatasan Midtrans aktif tampil jelas di UI meja. |

---

## 6. Hasil Validasi & Cakupan Pengujian (Section E)

### 6.1 Yang Terverifikasi Secara Nyata (Sesi Review Ini)
1. **Audit Statis SQL (`scratch/audit_refund_sql.mjs`):** **248 / 248** pengecekan lulus (0 gagal) mencakup keseimbangan sintaks/kurung/transaksi, `SECURITY DEFINER`, `SET search_path = ''`, bebas `SET search_path = public`, kualifikasi penuh `public.*`/`pg_catalog.*`, larangan prefix `pg_catalog.` pada keyword SQL (`greatest`/`least`/`coalesce`/`nullif`), pencocokan eksak signature `REVOKE`/`GRANT`, serta kontrak A.1, A.2, A.3, dan R1–R5.
2. **Validasi DDL & Eksekusi Nyata pada PostgreSQL 18.4 Terisolasi (`scratch/verify_pg18_refunds.mjs`):**
   - Seluruh **21 berkas migrasi DDL** dari `20261110000100` s.d. `20261126000500` berhasil dieksekusi berurutan pada cluster PostgreSQL 18.4 sementara dengan stub minimal schema `auth`, `storage`, role Supabase, dan publikasi `supabase_realtime` *(kecuali berkas seed data historis `20261119000200_f4_seed_ingredients_recipes.sql` yang dilewati karena mengandung klausul `ON CONFLICT (sku)` terhadap indeks ekspresi lama di migrasi F4 historis)*.
   - **Skenario transaksi runtime yang diuji & lulus pada PostgreSQL 18.4:**
     - **Test 1:** Rule A.1 (`pending_approval` tidak memblokir `get_dining_session_summary` & `close_dining_session_atomic`), Rule A.2 (`25%` dan `50%` kompensasi menghitung DPP prorata bersih dengan `service_charge_amount = 0` & `tax_amount = 0` sementara `reference_*` tersimpan utuh), Rule A.3 (pengajuan ulang kumulatif `25% -> 50% -> 100% heavy`, penolakan over-claim `25%+50%+50%`, pembulatan toleransi 1 Rp pada `50%+50%` mencapai `is_full_item_refund = true` lalu memblokir klaim berikutnya), serta penolakan RBAC kasir approve & kasir lintas akun.
     - **Test 2:** Replacement (`amount = 0`, `p_auto_approve = true` Admin tanpa shift aktif berhasil sementara order `'standard'` tanpa shift tetap ditolak trigger `SHIFT_NOT_OPEN`), pemotongan stok pengganti L8 + catatan `waste` (`quantity_delta = 0, wasted_quantity = 2`), audit log terpisah `order.refund_requested` & `order.refund_approved`, serta isolasi RLS role `kitchen` (`0` baris terbaca di `refunds`/`refund_items`, dapat membaca `order_replacements`).
     - **Test 3 & 3B:** Split Bill 2x pembayaran Midtrans (`midtrans_snap` + `qris_midtrans`), pemblokiran tutup meja selama payout Midtrans `approved` masih `pending`, penolakan `confirm_midtrans_refund_atomic` oleh role `authenticated`, konfirmasi multi-leg bertahap oleh `service_role` + idempotency replay per `gateway_refund_id` (tidak menyentuh leg ke-2 saat leg ke-1 di-replay), auto-release meja pada full refund & unblock `close_dining_session_atomic` setelah konfirmasi partial Midtrans, serta `record_refund_correction_atomic` (`over_refund`).
     - **Test 4:** `refund_restock` pada pesanan `queued`, cash refund `out_of_shift` (`shift_id IS NULL`), tiket `kds_item_cancellations`, `get_order_receipt_data`, kompatibilitas `process_order_refund_atomic` (8-arg F2.4), serta `under_refund` supplemental refund.
3. **Regresi Kode Aplikasi Offline Existing (`scripts/test-*.mjs`, tanpa koneksi live Supabase):**
   - `test-f2-4-refunds-receipts.mjs`: **51/51** pass.
   - `test-dining-session-closure.mjs`: **16/16** pass.
   - `test-shift-order-enforcement.mjs`: **14/14** pass.
   - `test-f3-kds.mjs`: **12/12** pass.
   - `test-f4-stock-reservation.mjs`: **58** pass (`0` gagal).
   - `test-f5-1-shift-management.mjs`: **42/42** pass.
   - `test-f5-2-shift-actions.mjs`: **54/54** pass.
   - `test-f6-1-reporting-engine.mjs`: **15/15** pass.
   - `test-f6-3-transaction-history.mjs`: **20/20** pass.
   - `test-payment-cash-midtrans-interaction.mjs`: **18/18** pass.

### 6.2 Batasan Verifikasi (Belum Dapat Diuji Tanpa Eksekusi Supabase Live & Fase Aplikasi)
1. Belum dijalankan terhadap database **Supabase live/staging** (sesuai larangan menyentuh database live), sehingga perilaku Postgres engine Supabase terkelola (`supabase_realtime` WAL logical replication sesungguhnya, kebijakan Storage upload HTTP nyata pada bucket `refund-evidence`, serta data produksi lama aktual pada `orders`/`refunds`/`payments`) baru terverifikasi pada level kontrak dan PostgreSQL 18 lokal.
2. Backfill `orders.paid_at` dan konversi status historis F2.4 belum diuji terhadap dataset historis produksi yang berisi baris-baris edge case lama dari masa transisi F2.2/F2.4.
3. Pengujian race condition paralel lintas dua koneksi database konkuren nyata (*two concurrent transactions* secara paralel) baru dijamin secara desain melalui `FOR UPDATE` berurutan (`L1 → L7`) dan indeks unik `idempotency_key`, belum ditembakkan melalui multi-connection load test.
4. Perubahan query & UI TypeScript (filter `order_kind = 'standard'` pada F6 reports/export/receipt queue, integrasi `/queue`, modul kasir/admin Refund R5, upload `refund-evidence`, dan listener Realtime `notifications`) belum diimplementasikan karena cakupan tahap ini terbatas pada revisi migrasi database R1–R5 & dokumentasi audit.
