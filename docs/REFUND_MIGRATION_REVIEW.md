# Nine Licious POS — Audit Dampak, Keamanan & Review Migration Plan Refund System (R1–R5)

**Status:** Siap Review Eksekusi (Belum Dijalankan ke Supabase Live Database)  
**Tanggal Pembaruan:** 27 November 2026  
**Cakupan:** Revisi Final R1–R5 ([20261126000100](file:///d:/POS%20online/supabase/migrations/20261126000100_refund_r1_foundation.sql) s.d. [20261126000500](file:///d:/POS%20online/supabase/migrations/20261126000500_refund_r5_atomic_refund_engine.sql)), Final Security & Inventory Safety Audit (Replacement Stock Deduction, Legacy Refund RPC Security, Validasi Rantai Migrasi PostgreSQL 18), Rollback/Data Safety, dan Audit Integrasi Sistem Menyeluruh.

---

## 1. Daftar File Migration R1–R5

Seluruh migrasi dijalankan berurutan di atas skema **F0–F6** saat ini (termasuk [20261125000100_require_active_shift_for_pos_orders.sql](file:///d:/POS%20online/supabase/migrations/20261125000100_require_active_shift_for_pos_orders.sql)):

| Urutan | File Migrasi | Perubahan Utama |
|---|---|---|
| **R1** | [20261126000100_refund_r1_foundation.sql](file:///d:/POS%20online/supabase/migrations/20261126000100_refund_r1_foundation.sql) | Ekstensi `public.refunds` (`approval_status`, `payout_status`, `resolution_type`, komponen pembukuan `reference_service_charge_amount` & `reference_tax_amount`, constraint `replacement` boleh `amount = 0`), `refund_items` (dengan `is_full_item_refund`, `reference_service_charge_amount`, `reference_tax_amount`), `refund_payout_allocations` (Split Bill multi-payment), dan `refund_corrections`. |
| **R2** | [20261126000200_refund_r2_replacement_inventory.sql](file:///d:/POS%20online/supabase/migrations/20261126000200_refund_r2_replacement_inventory.sql) | Penanda `orders.order_kind` (`standard`/`replacement`) & `parent_order_id`, update `assert_active_cashier_shift_for_order_mutation()` (`SET search_path = ''`, serialisasi `pg_catalog.to_jsonb(new)` lintas tabel `orders`/`order_items`/`dining_sessions`), hardening `deduct_order_stock_internal(uuid)` (`SET search_path = ''`, `service_role` only, skip guard `order_kind = 'replacement'`) & `trg_fn_orders_deduct_stock_on_paid()` (skip guard `order_kind = 'replacement'`), `order_replacements`, `kds_item_cancellations`, serta mutasi stok `'waste'` (`quantity_delta = 0, wasted_quantity > 0`) & `'refund_restock'`. |
| **R3** | [20261126000300_refund_r3_evidence_notifications.sql](file:///d:/POS%20online/supabase/migrations/20261126000300_refund_r3_evidence_notifications.sql) | Bucket privat `refund-evidence` (`public = false`, maks 50 MB), tabel `refund_evidence`, tabel persisten `notifications` + trigger anti-tampering konten, serta publikasi `supabase_realtime`. Seluruh fungsi memakai `SET search_path = ''`. |
| **R4** | [20261126000400_refund_r4_paid_at_and_allocation.sql](file:///d:/POS%20online/supabase/migrations/20261126000400_refund_r4_paid_at_and_allocation.sql) | Kolom `orders.paid_at` + backfill historis (`success` & `refunded`), update `execute_order_payment_internal`, kalkulasi `calculate_refund_breakdown_internal` (kompensasi 25%/50% murni DPP & Rp 0 pajak/service + kumulatif per `order_item_id`), `get_order_receipt_data`, serta `get_dining_session_summary` & `close_dining_session_atomic` (`pending_approval` tidak memblokir tutup meja). |
| **R5** | [20261126000500_refund_r5_atomic_refund_engine.sql](file:///d:/POS%20online/supabase/migrations/20261126000500_refund_r5_atomic_refund_engine.sql) | 14 fungsi transaksional `SET search_path = ''` dengan hierarki lock `L1 → L2 → L3 → L4 → L5 → L6 → L7 → L8`, idempotensi pemotongan stok Replacement (`returning id into v_inserted_id` pada `sale_deduction`), penguncian `order_items` & `refunds` (`FOR UPDATE`) sebelum hitung kumulatif, `confirm_midtrans_refund_atomic` idempoten per leg Split Bill (`service_role` only), koreksi `under_refund`/`over_refund`, dan hardening RPC legacy `process_order_refund_atomic` (8-argumen: wajib Admin aktif, hanya `order_kind = 'standard'`, mencatat `approved_by`, `refund_payout_allocations`, & dual audit log). |

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
   - **R2 (3 fungsi):** `assert_active_cashier_shift_for_order_mutation()` (`86–139`, memakai `pg_catalog.to_jsonb(new)` lintas trigger `orders`/`order_items`/`dining_sessions`), `deduct_order_stock_internal(uuid)` (`147–357`), dan `trg_fn_orders_deduct_stock_on_paid()` (`359–418`).
   - **R3 (4 fungsi):** `protect_notification_payload_on_update()`, `notify_user_internal()`, `notify_role_users_internal()`, `mark_notifications_read_atomic()`.
   - **R4 (5 fungsi):** `execute_order_payment_internal()`, `calculate_refund_breakdown_internal()`, `get_order_receipt_data()`, `get_dining_session_summary()`, `close_dining_session_atomic()`.
   - **R5 (14 fungsi, termasuk `get_order_pending_refund_amount_internal`):** seluruh helper internal dan RPC publik.
2. **Kualifikasi Skema Penuh & Kompatibilitas Parser PostgreSQL:**
   - Seluruh referensi tabel, sequence, dan fungsi aplikasi di dalam badan PL/pgSQL maupun SQL memakai prefix eksplisit (`public.*`, `auth.uid()`, `pg_catalog.*`, `storage.*`).
   - Kata kunci grammar SQL (`greatest`, `least`, `coalesce`, `nullif`) dipastikan tanpa prefix `pg_catalog.`, sementara fungsi `pg_proc` (`now`, `btrim`, `lower`, `char_length`, `format`, `round`, `abs`, `array_agg`, `array_length`, `gen_random_uuid`, `jsonb_*`, `set_config`, `to_jsonb`, dll.) dikualifikasi eksplisit `pg_catalog.*`.
3. **Matriks Hak Eksekusi (`REVOKE`/`GRANT`) & RLS Least Privilege:**
   - **Mutasi langsung dari klien dilarang:** Seluruh tabel finansial & ledger (`refunds`, `refund_items`, `refund_payout_allocations`, `refund_corrections`, `refund_evidence`, `order_replacements`, `kds_item_cancellations`) hanya mengizinkan `SELECT` via RLS terfilter; `INSERT`/`UPDATE`/`DELETE` langsung ditolak untuk `anon`, `authenticated`, `kasir`, dan `kitchen`.
   - **Isolasi role `kitchen`:** RLS menolak total pembacaan `kitchen` atas `refunds`, `refund_items`, `refund_payout_allocations`, `refund_corrections`, `refund_evidence`, dan bucket Storage `refund-evidence`. Role `kitchen` hanya dapat membaca `order_replacements` dan `kds_item_cancellations` yang bersih dari nominal uang dan PII pelanggan.
   - **Fungsi internal & `service_role`:** `deduct_order_stock_internal`, `mark_midtrans_refund_processing_atomic`, dan `confirm_midtrans_refund_atomic` di-`REVOKE ALL` dari `public, anon, authenticated` dan hanya dapat dipanggil oleh `service_role` (atau internal trigger/engine); helper murni (`execute_order_payment_internal`, `calculate_refund_breakdown_internal`, `get_order_pending_refund_amount_internal`, `execute_order_replacement_internal`, `execute_refund_approval_internal`, `notify_user_internal`, `notify_role_users_internal`, serta fungsi trigger R2/R3) di-`REVOKE ALL` dari `public, anon, authenticated, service_role`.
   - **Validasi Role dalam RPC Publik:**
     - `request_order_refund_atomic`, `cancel_order_refund_atomic`, `attach_refund_evidence_atomic`, `close_dining_session_atomic`: hanya `admin` atau `kasir` aktif (`kasir` dibatasi pada pengajuan sendiri dan `p_auto_approve = true` ditolak untuk kasir).
     - `approve_order_refund_atomic`, `reject_order_refund_atomic`, `complete_refund_manual_fallback_atomic`, `record_refund_correction_atomic`, `request_refund_evidence_atomic`, `process_order_refund_atomic`: hanya `admin` aktif (`role = 'admin'` dan `is_active = true` di `public.profiles`).
4. **Penjagaan Kontrak F2.4, F4, F5, dan F6:**
   - `process_order_refund_atomic` (8-argumen), `execute_order_payment_internal` (11-argumen), `confirm_midtrans_refund_atomic` (4-argumen), `deduct_order_stock_internal(uuid)`, `get_order_receipt_data(uuid)`, `get_dining_session_summary(uuid)`, dan `close_dining_session_atomic(uuid, uuid)` mempertahankan signature lama 100%.

---

## 4. Final Security & Inventory Safety Audit (Audit Keamanan & Stok R1–R5)

### 4.1 Audit 1 — Keamanan Pemotongan Stok Replacement (`order_kind = 'replacement'`)
Audit menyeluruh pada keterkaitan [20261119000100_f4_inventory_stock.sql](file:///d:/POS%20online/supabase/migrations/20261119000100_f4_inventory_stock.sql), [20261119000300_f4_stock_reservation_and_strict_positive.sql](file:///d:/POS%20online/supabase/migrations/20261119000300_f4_stock_reservation_and_strict_positive.sql), [20261126000200_refund_r2_replacement_inventory.sql](file:///d:/POS%20online/supabase/migrations/20261126000200_refund_r2_replacement_inventory.sql), dan [20261126000500_refund_r5_atomic_refund_engine.sql](file:///d:/POS%20online/supabase/migrations/20261126000500_refund_r5_atomic_refund_engine.sql):

1. **Mengapa Replacement hanya memotong stok bahan pengganti SATU KALI (tanpa double deduction F4):**
   - `execute_order_replacement_internal` (`20261126000500:75–513`) langsung menyisipkan order pengganti (`order_kind = 'replacement'`) dengan `status = 'paid'` dan `payment_status = 'paid'` (`baris 227–233`), sedangkan trigger F4 `trg_orders_deduct_stock_on_paid` (`20261119000100:859`) hanya aktif pada `AFTER UPDATE OF payment_status ... WHEN (old.payment_status is distinct from 'paid' and new.payment_status = 'paid')`.
   - Sebagai *defense-in-depth* terhadap pembaruan manual `payment_status` maupun panggilan langsung `service_role`, **R2** memperbarui `deduct_order_stock_internal` (`20261126000200:147–357`) dan `trg_fn_orders_deduct_stock_on_paid` (`20261126000200:359–418`) untuk melewati order dengan `coalesce(..., 'standard') = 'replacement'`.
   - Pada R5 `execute_order_replacement_internal`, insert `stock_movements` bertipe `'sale_deduction'` menggunakan `on conflict (order_id, ingredient_id) where (movement_type = 'sale_deduction' and order_id is not null) do nothing returning id into v_inserted_id` dan hanya mengurangi `ingredients.current_stock` apabila `v_inserted_id is not null`.
2. **Validasi Row Lock L8 & Perlindungan Stok Negatif / Reservasi Order Lain:**
   - Sebelum membuat order replacement, `execute_order_replacement_internal` (`20261126000500:154–185`) mengunci semua baris bahan pada `public.ingredients` secara deterministik (`ORDER BY rec.ingredient_id ASC FOR UPDATE`) dan memeriksa `v_available := v_ing.current_stock - v_ing.reserved_stock >= v_req_ing.qty_needed`.
   - Apabila tersedia kurang dari kebutuhan pengganti (termasuk ketika stok fisik habis atau sudah direservasi pesanan lain yang menunggu bayar), transaksi dibatalkan sebelum insert order pengganti dan ditopang check constraint F4 (`ingredients_current_stock_non_negative_check`, `ingredients_reserved_stock_non_negative_check`, `ingredients_available_stock_non_negative_check`).
3. **Idempotency & Pemisahan Mutasi `'waste'`:**
   - Pengajuan `approve_order_refund_atomic` pada baris `approved` mengembalikan replay idempoten (`is_duplicate = true`), sementara `execute_order_replacement_internal` memeriksa `v_replacement.replacement_order_id is not null` (`baris 139–145`) dan indeks unik partial `(order_id, ingredient_id)` pada `'sale_deduction'` + `stock_movements_refund_waste_unique_idx` (`20261126000200:622–624`).
   - Mutasi `'waste'` wajib `quantity_delta = 0` dan `wasted_quantity > 0` (`stock_movements_delta_non_zero_check`, `20261126000200:602–606`), sehingga tidak memotong `current_stock` kedua kalinya untuk bahan item awal.
4. **Pembuktian Uji Nyata di PostgreSQL 18 (`Test 5`):**
   - **Sebelum Replacement:** `Patty = 100.000`, `Sauce = 500.000` (setelah pengurangan pesanan awal `ORD-TEST-005`).
   - **Sesudah 1x Approval Replacement:** `Patty = 98.000` (`-2.000`), `Sauce = 470.000` (`-30.000`), hanya tercipta **1 baris `'sale_deduction'`** per bahan dan **1 baris `'waste'`** (`quantity_delta = 0`, `wasted_quantity = 2.000` / `30.000`).
   - **Sesudah Replay / Trigger / Service Role Guard:** pemanggilan ulang `approve_order_refund_atomic` (`is_duplicate = true`), `service_role` pada `deduct_order_stock_internal(replacement_order_id)` (`skipped = true`), maupun paksa trigger `payment_status` `'partially_paid' -> 'paid'` tidak mengubah stok (`Patty = 98.000`, `Sauce = 470.000`). Pencobaan Replacement saat stok bebas tidak mencukupi (karena `reserved_stock`) ditolak penuh tanpa mengurangi stok di bawah 0 atau merusak reservasi.

### 4.2 Audit 2 — Keamanan Legacy Refund RPC (`process_order_refund_atomic` & RPC Terkait)
Hasil pelacakan seluruh berkas migrasi mengonfirmasi hanya terdapat dua RPC mutasi refund historis:
1. **`public.process_order_refund_atomic(uuid, integer, text, text, text, uuid, text, uuid)`** (`20261126000500:3172–3644`; overload 7-argumen lama sudah di-`DROP` di [20261120000100_f5_shift_and_cash_management.sql](file:///d:/POS%20online/supabase/migrations/20261120000100_f5_shift_and_cash_management.sql)):
   - Memeriksa langsung `role, is_active` dari `public.profiles where id = v_user_id` (`v_is_active is distinct from true or coalesce(v_user_role, '') <> 'admin'`). Akun `kasir`, `kitchen`, `anon`, maupun `admin` non-aktif ditolak keras.
   - Menolak pesanan non-standar (`coalesce(v_order.order_kind, 'standard') <> 'standard'`).
   - Tidak mengizinkan bypass status persetujuan maupun audit trail: baik jalur `'midtrans'` maupun tunai/transfer/manual mengisi `approval_status = 'approved'`, `approved_by = v_user_id`, `approved_at = v_now`, membuat baris `public.refund_payout_allocations` jika `p_payment_id is not null`, serta menulis kedua entri audit `'order.refund_requested'` dan `'order.refund_approved'` (dengan penanda `'via_legacy_rpc', true`).
   - Kasir hanya dapat mengajukan refund berstatus `pending_approval` melalui `request_order_refund_atomic` (`p_auto_approve = true` ditolak jika bukan Admin aktif).
2. **`public.confirm_midtrans_refund_atomic(uuid, text, integer, jsonb)`** (`20261126000500:2607–2923`):
   - `REVOKE ALL` dari `public, anon, authenticated` dan hanya `GRANT EXECUTE` kepada `service_role`.
   - Tidak mem-bypass alur approval karena hanya memproses baris `refunds` yang sudah berstatus `approval_status = 'approved'` dengan `payout_status in ('pending', 'processing', 'reconciliation_required')`.

---

## 5. Strategi Rollback & Keamanan Data Produksi (Section C)

> [!CAUTION]
> **DILARANG keras menjalankan `DROP TABLE ... CASCADE` pada skema R1–R5 setelah data operasional refund, pembukuan koreksi, replacement, atau bukti pengaduan mulai tercipta di database produksi.** Penghapusan tabel secara paksa akan menghilangkan jejak audit keuangan, mutasi stok `waste`/`refund_restock`, alokasi payout Split Bill, dan referensi `stock_movements` / `refunds` secara permanen.

### 5.1 Prasyarat Wajib Sebelum Eksekusi Migrasi ke Supabase
1. Ambil **snapshot / manual backup + pastikan PITR (*Point-in-Time Recovery*) aktif** di dashboard Supabase sebelum menjalankan R1.
2. Catat timestamp UTC tepat sebelum menjalankan R1–R5 agar titik pemulihan PITR terdefinisi jelas.
3. Uji terlebih dahulu R1–R5 pada project/branch **staging Supabase** bila tersedia.

### 5.2 Skenario 1 — Rollback Bersih Pra-Operasional (HANYA Jika Aplikasi Belum Aktif & Belum Ada Data Transaksi Baru)
Berlaku **eksklusif** apabila migrasi gagal di tengah jalan saat window maintenance **dan** belum ada satupun baris baru pada `refund_items`, `refund_payout_allocations`, `refund_corrections`, `order_replacements`, `refund_evidence`, `kds_item_cancellations`, atau `orders (order_kind = 'replacement')`:
1. Verifikasi terlebih dahulu jumlah baris (`SELECT count(*)`) seluruh tabel baru dan `stock_movements where movement_type in ('waste', 'refund_restock')` bernilai `0`.
2. Pulihkan fungsi RPC dan trigger ke definisi F0–F5 sebelumnya secara terbalik (**R5 → R4 → R3 → R2 → R1**):
   - Pulihkan fungsi dari [20261125000100](file:///d:/POS%20online/supabase/migrations/20261125000100_require_active_shift_for_pos_orders.sql), [20261120000100](file:///d:/POS%20online/supabase/migrations/20261120000100_f5_shift_and_cash_management.sql), dan [20261115000200](file:///d:/POS%20online/supabase/migrations/20261115000200_f2_4_post_migration_patch.sql).
   - `DROP FUNCTION IF EXISTS` khusus fungsi baru R3/R4/R5.
   - Hapus bucket/policy `refund-evidence` apabila kosong, lalu `DROP TABLE IF EXISTS` hanya pada tabel yang **terbukti kosong** (`0` baris), baru hapus kolom tambahan pada `refunds`, `orders`, dan `stock_movements`.

### 5.3 Skenario 2 — Pemulihan Pasca-Data Operasional Masuk (*Forward-Fix Recovery*, Tanpa `DROP TABLE`)
Jika migrasi R1–R5 sudah berjalan di produksi dan pengguna sudah membuat pengajuan refund, replacement, notifikasi, koreksi, atau bukti foto/video:
1. **Jangan menjalankan skrip `DROP TABLE` / `DROP COLUMN`**.
2. Untuk menghentikan perilaku workflow baru secara cepat sementara memperbaiki logika di aplikasi atau RPC:
   - Terapkan migrasi **forward-fix** yang hanya mengganti (`CREATE OR REPLACE FUNCTION`) definisi RPC bermasalah atau mencabut sementara hak `EXECUTE` RPC R5 baru (`REVOKE EXECUTE ... FROM authenticated`) agar kasir/admin sementara kembali melalui jalur darurat yang terkendali.
   - Pertahankan seluruh tabel R1–R3 beserta constraint pembukuan agar catatan historis (`refund_items`, `refund_corrections`, `stock_movements` `'waste'`/`'refund_restock'`, `order_replacements`, `audit_logs`) tetap utuh untuk rekonsiliasi keuangan dan pajak.
   - Jika terjadi kerusakan skema yang tidak dapat dipulihkan dengan forward-fix pada window rilis yang sama, lakukan **PITR Restore** ke timestamp prapenerapan migrasi dengan kesadaran bahwa transaksi setelah titik PITR harus direkonsiliasi ulang dari log pembayaran Midtrans & shift kas.

### 5.4 Risiko Kehilangan Data Jika Rollback Destruktif Tetap Dilakukan
Menjalankan `DROP TABLE ... CASCADE` setelah data operasional masuk mengakibatkan:
- Hilangnya bukti audit komponen pembukuan `reference_service_charge_amount` & `reference_tax_amount` untuk kompensasi 25%/50%.
- Hilangnya keterlacakan Split Bill multi-payment (`refund_payout_allocations`) dan status `reconciliation_required` Midtrans.
- Hilangnya buku pembantu `refund_corrections` (*under-refund* / *over-refund*), jejak `waste`/`refund_restock`, tiket dapur `kds_item_cancellations`/`order_replacements`, file bukti pelanggan (`refund_evidence`), dan jejak riwayat klaim kumulatif per `order_item_id`.

---

## 6. Audit Integrasi Lintas Modul (Section D)

Status kesesuaian setiap domain terhadap **R1–R5** saat ini (sebelum pembaruan UI & Server Actions TypeScript pada fase implementasi aplikasi berikutnya):

| Domain / Subsistem | Perlindungan Sudah Aktif di Level SQL (R1–R5) | Celah / Perubahan Wajib di Layer Aplikasi (Fase Implementasi) |
|---|---|---|
| **F2.4 (Refund & Struk)** | `process_order_refund_atomic` (8-arg) & `get_order_receipt_data` kompatibel 100% dan telah diperkeras untuk Admin aktif & jejak persetujuan; kolom komponen pajak/service & `paid_at` tersedia; `get_order_receipt_data` menyertakan daftar refund. | Perbarui `src/lib/payments/actions.ts`, `src/lib/payments/receipt.ts`, dan [refund-modal.tsx](file:///d:/POS%20online/src/components/pos/refund-modal.tsx) agar mengarahkan pengajuan baru ke RPC R5 dan menampilkan breakdown DPP/pajak/service sesuai aturan A.2. |
| **F4 (Inventory & Reservasi Stok)** | `execute_order_replacement_internal` mengunci `ingredients` (L8), memvalidasi `(current_stock - reserved_stock) >= qty_needed`, mencatat `'waste'` (`quantity_delta = 0`, `wasted_quantity > 0`), lalu memotong bahan pengganti (`sale_deduction`) secara idempoten. R2 melarang `deduct_order_stock_internal` dan `trg_fn_orders_deduct_stock_on_paid` memotong ulang order `replacement`. | Perbarui `src/lib/inventory/constants.ts` (saat ini hanya menampilkan label `'manual_out'` sebagai deskripsi waste manual di baris 59) dan UI `/admin/inventory` agar menampilkan `movement_type = 'waste'`/`'refund_restock'` beserta `wasted_quantity`. |
| **F5 (Shift & Cash Drawer)** | Trigger `assert_active_cashier_shift_for_order_mutation` mengecualikan `order_kind = 'replacement'` & itemnya, sementara pesanan `'standard'` tetap wajib shift aktif. Refund tunai mengurangi `expected_cash` shift `open` + `cash_movements` (`cash_refund`) atau dicatat eksplisit `shift_id = null` (`out_of_shift`) bila shift sudah `closed`. | Tampilkan indikator status `open` shift vs `out_of_shift` pada panel persetujuan refund Admin dan laporan tutup shift di [transaction-history.tsx](file:///d:/POS%20online/src/components/admin/transactions/transaction-history.tsx). |
| **F6 (Laporan, Omzet, AOV, Count, & CSV)** | Di level DB: pesanan Replacement memakai `order_kind = 'replacement'` dengan `grand_total = 0, paid_total = 0`; pengajuan Replacement di `refunds` memakai `resolution_type = 'replacement', amount = 0`. *(Di DB data keuangan pengganti sudah bernilai 0, namun barisnya berstatus `paid`/`completed`.)* | **WAJIB pada Fase Aplikasi:** Query saat ini di [reports/actions.ts](file:///d:/POS%20online/src/lib/reports/actions.ts) (baris 110, 130, 294, 424) dan [export/actions.ts](file:///d:/POS%20online/src/lib/export/actions.ts) (baris 261) **belum memfilter `order_kind` maupun `resolution_type`**. Wajib tambahkan `.eq("order_kind", "standard")` pada query `orders` (agar Replacement tidak ikut `paidOrdersCount` maupun merusak AOV/CSV) serta `.neq("resolution_type", "replacement")` & `.eq("payout_status", "completed")` pada query laporan refund. |
| **Midtrans (Settlement, Refund, Webhook, Rekonsiliasi)** | `confirm_midtrans_refund_atomic` tetap eksklusif `service_role`, mendukung multi-leg Split Bill secara idempoten per `gateway_refund_id`, dan `complete_refund_manual_fallback_atomic` menyediakan jalur transfer bank manual berbukti saat gateway gagal/butuh rekonsiliasi. `cancel_order_refund_atomic` memblokir pembatalan jika Midtrans sudah `processing`/`reconciliation_required`/`completed`. | Perbarui handler webhook/API Midtrans refund di `src/lib/midtrans/` & `src/lib/payments/actions.ts` untuk memanggil `mark_midtrans_refund_processing_atomic` serta mengirim `p_expected_amount` per leg `refund_payout_allocations`. |
| **Split Bill Multi-Payment** | `refund_payout_allocations` membagi satu pengajuan refund ke beberapa baris `payments` (`cash`, `midtrans`, `transfer`, `manual`) tanpa melebihi sisa refundable tiap baris pembayaran dan menyinkronkan `payments.payment_status` secara akurat. | Bangun komponen UI alokasi Split Bill saat Admin menyetujui refund pesanan berbayar campuran di dashboard Admin. |
| **KDS & Replacement Order** | Pesanan Replacement otomatis berstatus `paid` + `kds_status = 'queued'`, `table_id = null`, `dining_session_id = null`, `notes = '[REPLACEMENT] ...'`. `kds_item_cancellations` dan `order_replacements` mempublikasikan event Realtime tanpa membocorkan nominal/PII ke role `kitchen`. | Query utama di [kds/actions.ts](file:///d:/POS%20online/src/lib/kds/actions.ts) (baris 160–173) sudah memuat pesanan `status = 'paid'` & `kds_status in ('queued','preparing','ready')` sehingga tiket Replacement otomatis tampil; tambahkan pembacaan `order_replacements`/`kds_item_cancellations` di KDS untuk badge `[REPLACEMENT]` dan alert pembatalan per item. |
| **Customer `/queue` & Estimasi Antrean Struk** | Di level DB: pesanan Replacement memakai `queue_number = null` dan `queue_date = null`. **Temuan Kritis Struk:** Pada [receipt.ts](file:///d:/POS%20online/src/lib/payments/receipt.ts) (baris 147–174), `isOrderBeforeInKds` melompati perbandingan nomor antrean jika `candidate.queue_number` bernilai `null` dan jatuh ke perbandingan `created_at`! | **WAJIB pada Fase Aplikasi:** Query kandidat antrean KDS untuk hitung estimasi sisa antrean struk di `src/lib/payments/` dan implementasi masa depan [queue/page.tsx](file:///d:/POS%20online/src/app/queue/page.tsx) (saat ini masih halaman statis kosong) **wajib memfilter `order_kind = 'standard'`** agar tiket `replacement` tidak memengaruhi hitungan antrean pelanggan biasa. |
| **Dining Session & Penutupan Meja** | R4 (`get_dining_session_summary` & `close_dining_session_atomic`) mengecualikan `order_kind = 'replacement'`, tidak memblokir `approval_status = 'pending_approval'`, dan hanya memblokir payout Midtrans aktif yang sudah `approved`. | Verifikasi integrasi wrapper fallback TS di [orders/actions.ts](file:///d:/POS%20online/src/lib/orders/actions.ts) agar saat R4 aktif, RPC menjadi sumber kebenaran tunggal dan pesan error pembatasan Midtrans aktif tampil jelas di UI meja. |

---

## 7. Hasil Validasi, Audit Rantai Migrasi & Cakupan Pengujian (Section E)

### 7.1 Validasi Rantai Migrasi & Pengujian PostgreSQL 18 Terisolasi
1. **Validasi Rantai DDL pada PostgreSQL 18.4 (`verify_pg18_refunds.mjs`):**
   - Dari **22 file** pada `supabase/migrations/`, **21 / 21 file DDL migration** (`20261110000100` s.d. `20261126000500`) berhasil diterapkan berurutan pada cluster PostgreSQL 18.4 sementara dengan stub minimal schema `auth`, `storage`, role Supabase, dan publikasi `supabase_realtime`.
   - **Keterangan berkas historis yang dilewati:** 1 file seed data historis [20261119000200_f4_seed_ingredients_recipes.sql](file:///d:/POS%20online/supabase/migrations/20261119000200_f4_seed_ingredients_recipes.sql) **tidak dijalankan apa adanya** (tanpa mengubah file migrasi historis tersebut) karena mengandung `on conflict (sku) where (sku is not null)` yang tidak cocok dengan expression unique index `ingredients_sku_unique_idx` (`on public.ingredients (lower(btrim(sku))) where (sku is not null)`) di [20261119000100_f4_inventory_stock.sql](file:///d:/POS%20online/supabase/migrations/20261119000100_f4_inventory_stock.sql). Sebagai gantinya pada cluster uji sementara disisipkan seed fixture F4 yang kompatibel dengan indeks `lower(btrim(sku))`. **Tidak diklaim bahwa seluruh 22 file historis lulus dijalankan verbatim.**
2. **Skenario Transaksi Runtime yang Diuji & Lulus pada PostgreSQL 18.4 (7 Suite Uji: `TEST 1`–`TEST 6`):**
   - **TEST 1:** Rule A.1 (`pending_approval` tidak memblokir `get_dining_session_summary` & `close_dining_session_atomic`), Rule A.2 (`25%` dan `50%` kompensasi menghitung DPP prorata bersih dengan `service_charge_amount = 0` & `tax_amount = 0` sementara `reference_*` tersimpan utuh), Rule A.3 (`25% -> 50% -> 100% heavy`, penolakan over-claim `25%+50%+50%`, pembulatan toleransi `<= Rp 1`), serta penolakan RBAC kasir approve & kasir lintas akun.
   - **TEST 2:** Replacement (`amount = 0`, `p_auto_approve = true` Admin tanpa shift aktif berhasil sementara order `'standard'` tanpa shift tetap ditolak trigger `SHIFT_NOT_OPEN`), pemotongan stok pengganti L8 + catatan `waste` (`quantity_delta = 0, wasted_quantity = 2`), audit log terpisah `order.refund_requested` & `order.refund_approved`, serta isolasi RLS role `kitchen`.
   - **TEST 3 & 3B:** Split Bill 2x pembayaran Midtrans (`midtrans_snap` + `qris_midtrans`), pemblokiran tutup meja selama payout Midtrans `approved` masih `pending`, penolakan `confirm_midtrans_refund_atomic` oleh role `authenticated`, konfirmasi multi-leg bertahap oleh `service_role` + idempotency replay per `gateway_refund_id`, auto-release meja & unblock `close_dining_session_atomic` setelah konfirmasi partial Midtrans, serta `record_refund_correction_atomic` (`over_refund`).
   - **TEST 4:** `refund_restock` pada pesanan `queued`, cash refund `out_of_shift` (`shift_id IS NULL`), tiket `kds_item_cancellations`, `get_order_receipt_data`, kompatibilitas `process_order_refund_atomic` (8-arg F2.4), serta `under_refund` supplemental refund.
   - **TEST 5 (Audit 1 — Bukti Keamanan Stok Replacement):** Membuktikan stok sebelum Replacement `Patty = 100.000, Sauce = 500.000` dan sesudah Replacement `Patty = 98.000, Sauce = 470.000` dengan tepat 1 `sale_deduction` per bahan, `waste` bertotal delta `0`, replay `approve_order_refund_atomic` idempoten, panggilan `service_role` `deduct_order_stock_internal` mengembalikan `skipped = true`, paksa trigger `payment_status` `'partially_paid' -> 'paid'` tidak memotong ulang stok, serta penolakan penuh saat stok bebas kurang akibat `reserved_stock`.
   - **TEST 6 (Audit 2 — Bukti Keamanan Legacy RPC):** Membuktikan penolakan `kasir`, `kitchen`, `anon`, dan `admin` non-aktif (`is_active = false`) pada `process_order_refund_atomic` dan penolakan `p_auto_approve = true`, penolakan refund pada `order_kind = 'replacement'`, terisinya `approved_by`/`approved_at`, `refund_payout_allocations`, dual audit log (`order.refund_requested` + `order.refund_approved`), serta interop `complete_refund_manual_fallback_atomic`.

### 7.2 Audit Statis SQL & Regresi Offline Aplikasi
- Audit statis SQL (`audit_refund_sql.mjs`) memeriksa keseimbangan transaksi/sintaks, `SECURITY DEFINER`, `SET search_path = ''`, larangan prefix `pg_catalog.` pada keyword grammar SQL, kecocokan `REVOKE`/`GRANT`, kontrak R1–R5, penjaga `deduct_order_stock_internal`, serta pengerasan `process_order_refund_atomic`.
- Regresi skrip aplikasi offline (`scripts/test-*.mjs`) memverifikasi tidak ada regresi pada logika helper aplikasi tanpa menyentuh `src/**`.

### 7.3 Batasan Verifikasi & Risiko Tersisa
1. **Belum diuji pada Supabase Live/Staging:** Sesuai pembatasan tugas, migrasi tidak dijalankan ke project Supabase live maupun staging. Perilaku engine terkelola Supabase (`supabase_realtime` WAL logical replication aktual, HTTP Storage RLS upload bucket `refund-evidence`, serta data produksi lama) wajib diverifikasi pada project/branch **staging Supabase** terlebih dahulu.
2. **Dataset Historis Produksi (`20261119000200` & Backfill F2.4):** Selain fakta bahwa seed historis `20261119000200` memiliki ketidakcocokan `ON CONFLICT (sku)` pada lingkungan kosong (sehingga jika pernah dijalankan ulang di DB kosong perlu perhatian khusus), backfill `orders.paid_at` dan data historis F2.2/F2.4 dari produksi aktual belum diuji langsung terhadap snapshot produksi.
3. **Konkurensi Dua Sesi DB Paralel Nyata:** Penguncian `FOR UPDATE` (`L1 → L8`) dan indeks unik partial sudah diverifikasi berurutan secara transaksional di PostgreSQL 18, namun uji stres dua transaksi konkuren paralel serentak (`concurrent sessions`) belum dijalankan.
4. **Celah Layer Aplikasi (Fase Implementasi Berikutnya):** Query F6 `reports/actions.ts` / `export/actions.ts` serta estimasi antrean di `payments/receipt.ts` / `/queue` belum memfilter `order_kind = 'standard'`, dan jalur TS UI/Webhook belum dihubungkan ke RPC R5.
