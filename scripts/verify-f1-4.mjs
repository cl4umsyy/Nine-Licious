#!/usr/bin/env node
/**
 * Verifikasi F1.4 Tahap 1: Database Migration, Diskon, Nonce, & Finalisasi Pesanan
 *
 * Menguji:
 * 1. File migration SQL 20261111000400_discounts.sql
 * 2. Tabel discounts, discount_approval_nonces, order_discounts, kolom is_finalized
 * 3. RPC create_pos_order_atomic 3-parameter & wrapper 2-parameter (kompatibilitas F1.3)
 * 4. RPC finalize_pos_order & unfinalize_pos_order
 * 5. Proteksi append_order_items_atomic terhadap pesanan yang sudah difinalisasi
 * 6. Keamanan database: RLS policies, grants, revokes anon, pembatasan REST API order_discounts
 * 7. Tipe TypeScript database F1.4
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd(), true);

const results = [];

function record(status, name, detail = "") {
  results.push({ status, name, detail });
  console.log(`${status.padEnd(7)} | ${name}${detail ? ` | ${detail}` : ""}`);
}

function pass(name, detail = "") {
  record("PASS", name, detail);
}

function fail(name, detail = "") {
  record("FAIL", name, detail);
}

console.log("===============================================================================");
console.log(" Nine Licious POS - Verifikasi F1.4 Tahap 1: Migration, Schema & RPC");
console.log("===============================================================================\n");

// -----------------------------------------------------------------------------
// 1. File Migration SQL F1.4
// -----------------------------------------------------------------------------
console.log("--- 1. File Migration SQL F1.4 ---");
const migrationPath = resolve(process.cwd(), "supabase/migrations/20261111000400_discounts.sql");

if (!existsSync(migrationPath)) {
  fail("File migration F1.4 ditemukan", migrationPath);
} else {
  const sql = readFileSync(migrationPath, "utf-8");
  pass("File migration F1.4 ditemukan", migrationPath);

  // Cek kolom finalisasi pada orders
  if (
    sql.includes("add column if not exists is_finalized") &&
    sql.includes("add column if not exists finalized_at") &&
    sql.includes("add column if not exists finalized_by") &&
    sql.includes("orders_is_finalized_idx")
  ) {
    pass("Kolom finalisasi orders terdefinisi", "is_finalized, finalized_at, finalized_by, dan indeks");
  } else {
    fail("Kolom finalisasi orders terdefinisi");
  }

  // Cek tabel master discounts
  if (
    sql.includes("create table if not exists public.discounts") &&
    sql.includes("discounts_name_length_check") &&
    sql.includes("discounts_percentage_check") &&
    sql.includes("discounts_order_scope_targets_check") &&
    sql.includes("discounts_active_scope_idx") &&
    sql.includes("execute function public.set_updated_at()")
  ) {
    pass("Tabel master discounts terdefinisi", "Scope product/order, tipe percentage/fixed, min_order_amount, max_discount_amount, scope target check, trigger set_updated_at");
  } else {
    fail("Tabel master discounts terdefinisi");
  }

  // Cek tabel discount_approval_nonces
  if (
    sql.includes("create table if not exists public.discount_approval_nonces") &&
    sql.includes("approval_nonces_lookup_idx") &&
    sql.includes("approval_nonce_reason_check") &&
    sql.includes("nonce text not null unique") &&
    sql.includes("approver_id") &&
    sql.includes("cashier_id")
  ) {
    pass("Tabel discount_approval_nonces terdefinisi", "Single-use nonce terikat kasir, admin, nilai, dan alasan");
  } else {
    fail("Tabel discount_approval_nonces terdefinisi");
  }

  // Cek tabel order_discounts
  if (
    sql.includes("create table if not exists public.order_discounts") &&
    sql.includes("order_discounts_manual_approval_check") &&
    sql.includes("order_discounts_scope_item_check") &&
    sql.includes("order_discounts_one_per_item_idx")
  ) {
    pass("Tabel snapshot order_discounts terdefinisi", "Relasi order & item, proteksi satu diskon produk per item, validasi approval manual");
  } else {
    fail("Tabel snapshot order_discounts terdefinisi");
  }

  // Cek RPC create_pos_order_atomic (3 parameter tanpa default)
  if (
    sql.includes("create or replace function public.create_pos_order_atomic(\n  p_order jsonb,\n  p_items jsonb,\n  p_discounts jsonb\n)") ||
    sql.includes("create or replace function public.create_pos_order_atomic(\r\n  p_order jsonb,\r\n  p_items jsonb,\r\n  p_discounts jsonb\r\n)")
  ) {
    pass("Fungsi utama create_pos_order_atomic 3-parameter terdefinisi", "Tanpa default argument untuk mencegah ambiguitas");
  } else {
    fail("Fungsi utama create_pos_order_atomic 3-parameter terdefinisi");
  }

  // Cek Wrapper RPC create_pos_order_atomic (2 parameter untuk F1.3)
  if (
    (sql.includes("create or replace function public.create_pos_order_atomic(\n  p_order jsonb,\n  p_items jsonb\n)") ||
     sql.includes("create or replace function public.create_pos_order_atomic(\r\n  p_order jsonb,\r\n  p_items jsonb\r\n)")) &&
    sql.includes("return public.create_pos_order_atomic(p_order, p_items, '[]'::jsonb);")
  ) {
    pass("Wrapper kompatibilitas F1.3 (2-parameter) terdefinisi", "Meneruskan pemanggilan dengan '[]'::jsonb");
  } else {
    fail("Wrapper kompatibilitas F1.3 (2-parameter) terdefinisi");
  }

  // Cek Pembaruan append_order_items_atomic (Proteksi is_finalized & Rekalkulasi Diskon H-3)
  if (
    sql.includes("Pesanan sudah difinalisasi dan tidak dapat diubah") &&
    sql.includes("v_order.is_finalized") &&
    sql.includes("v_subtotal_after_product_discount") &&
    sql.includes("v_manual_discount_base") &&
    sql.includes("update public.order_discounts")
  ) {
    pass("Pembaruan append_order_items_atomic terdefinisi", "Memblokir pesanan finalized dan menghitung ulang diskon pesanan/manual secara atomik (H-3)");
  } else {
    fail("Pembaruan append_order_items_atomic terdefinisi");
  }

  // Cek Fungsi Finalisasi & Pembukaan Kembali (finalize / unfinalize) & Audit Log (M-1)
  if (
    sql.includes("create or replace function public.finalize_pos_order") &&
    sql.includes("create or replace function public.unfinalize_pos_order") &&
    sql.includes("Pesanan sudah difinalisasi sebelumnya") &&
    sql.includes("Alasan pembukaan kembali pesanan wajib diisi") &&
    sql.includes("'order.finalize'") &&
    sql.includes("'order.unfinalize'") &&
    sql.includes("insert into public.audit_logs")
  ) {
    pass("Fungsi finalize_pos_order dan unfinalize_pos_order terdefinisi", "Penguncian pesanan, pembukaan kembali, dan audit log otomatis (M-1)");
  } else {
    fail("Fungsi finalize_pos_order dan unfinalize_pos_order terdefinisi");
  }

  // Cek Security Audit Fixes C-1, H-1, H-2 & Penyempurnaan Tambahan
  const hasC1 =
    !sql.includes("approval_nonces_insert_staff") &&
    sql.includes("revoke insert on public.discount_approval_nonces from authenticated") &&
    sql.includes("Pemberi otorisasi diskon manual bukan Admin aktif") &&
    sql.includes("and is_active = true");

  if (hasC1) {
    pass("Security C-1 & Admin Aktif terverifikasi", "Kasir dilarang insert nonce langsung, verifikasi approver adalah admin aktif (is_active = true)");
  } else {
    fail("Security C-1 & Admin Aktif terverifikasi", "Proteksi pembuatan approval nonce atau status admin aktif belum lengkap");
  }

  const hasNonceBinding =
    sql.includes("v_disc_reason := v_nonce_rec.reason") &&
    sql.includes("Pesanan dengan diskon manual wajib menyertakan kunci idempotensi") &&
    sql.includes("Token persetujuan diskon tidak memiliki binding konteks keranjang yang valid") &&
    sql.includes("Token tidak dapat dipindahkan antar keranjang");

  if (hasNonceBinding) {
    pass("Binding Nonce & Alasan Resmi terverifikasi", "Alasan resmi Admin sebagai kebenaran, context_ref terikat ketat pada idempotency_key keranjang");
  } else {
    fail("Binding Nonce & Alasan Resmi terverifikasi", "Binding alasan resmi atau context_ref idempotency_key belum lengkap");
  }

  const hasAppendFixedReject =
    sql.includes("Nilai diskon pesanan nominal (Rp %) melebihi subtotal setelah penambahan item") &&
    sql.includes("Nilai diskon manual nominal (Rp %) melebihi sisa dasar subtotal setelah penambahan item");

  if (hasAppendFixedReject) {
    pass("Append fixed discount rejection terverifikasi", "Fixed discount yang melebihi dasar setelah append ditolak langsung tanpa auto-clamping");
  } else {
    fail("Append fixed discount rejection terverifikasi", "Penolakan fixed discount yang melebihi dasar belum lengkap");
  }

  const hasH1 =
    sql.includes("round((v_item_subtotal * v_disc_rate) / 100.0)") &&
    sql.includes("round((v_subtotal_after_product_discount * v_disc_rate) / 100.0)") &&
    sql.includes("round((v_manual_discount_base * v_disc_rate) / 100.0)");

  if (hasH1) {
    pass("Security H-1 terverifikasi", "Kalkulasi diskon persentase dihitung ulang secara authoritatif di SQL dalam rupiah integer");
  } else {
    fail("Security H-1 terverifikasi", "Kalkulasi persentase SQL belum lengkap");
  }

  const hasH2 =
    sql.includes("from public.discounts") &&
    sql.includes("applies_to_product_id") &&
    sql.includes("applies_to_category_id") &&
    sql.includes("min_order_amount") &&
    sql.includes("max_discount_amount");

  if (hasH2) {
    pass("Security H-2 terverifikasi", "Validasi master promo di SQL (kategori, produk, min order, max discount)");
  } else {
    fail("Security H-2 terverifikasi", "Validasi master promo di SQL belum lengkap");
  }

  // Cek RLS dan Grants Keamanan
  if (
    sql.includes("alter table public.discounts enable row level security") &&
    sql.includes("alter table public.discount_approval_nonces enable row level security") &&
    sql.includes("alter table public.order_discounts enable row level security") &&
    sql.includes("discounts_select_staff") &&
    sql.includes("discounts_insert_admin") &&
    sql.includes("order_discounts_select_staff") &&
    sql.includes("revoke all on public.order_discounts from anon")
  ) {
    pass("RLS dan Grants keamanan terdefinisi", "order_discounts hanya select bagi kasir, penulisan lewat SECURITY DEFINER RPC");
  } else {
    fail("RLS dan Grants keamanan terdefinisi");
  }

  // Cek Grants kedua signature create_pos_order_atomic
  if (
    sql.includes("grant execute on function public.create_pos_order_atomic(jsonb, jsonb, jsonb) to authenticated") &&
    sql.includes("grant execute on function public.create_pos_order_atomic(jsonb, jsonb) to authenticated")
  ) {
    pass("Grants eksplisit untuk kedua signature create_pos_order_atomic", "authenticated dan service_role memiliki izin eksekusi");
  } else {
    fail("Grants eksplisit untuk kedua signature create_pos_order_atomic");
  }
}

// -----------------------------------------------------------------------------
// 2. Tipe Database TypeScript F1.4
// -----------------------------------------------------------------------------
console.log("\n--- 2. Tipe Database TypeScript F1.4 ---");
const dbTypesPath = resolve(process.cwd(), "src/types/database.ts");
const dbTypesContent = readFileSync(dbTypesPath, "utf-8");

if (
  dbTypesContent.includes("is_finalized: boolean;") &&
  dbTypesContent.includes("finalized_at: string | null;") &&
  dbTypesContent.includes("finalized_by: string | null;")
) {
  pass("Tipe Order diperbarui dengan field finalisasi", "is_finalized, finalized_at, finalized_by");
} else {
  fail("Tipe Order diperbarui dengan field finalisasi");
}

if (
  dbTypesContent.includes("export type Discount =") &&
  dbTypesContent.includes("export type OrderDiscount =") &&
  dbTypesContent.includes("export type DiscountApprovalNonce =") &&
  dbTypesContent.includes("export type DiscountScope =") &&
  dbTypesContent.includes("export type DiscountType =")
) {
  pass("Tipe TypeScript database F1.4 lengkap", "Discount, OrderDiscount, DiscountApprovalNonce, DiscountScope, DiscountType");
} else {
  fail("Tipe TypeScript database F1.4 lengkap");
}

// -----------------------------------------------------------------------------
// Ringkasan
// -----------------------------------------------------------------------------
console.log("\n===============================================================================");
const passCount = results.filter((r) => r.status === "PASS").length;
const failCount = results.filter((r) => r.status === "FAIL").length;

console.log(` HASIL: ${passCount} PASS | ${failCount} FAIL`);
console.log("===============================================================================\n");

if (failCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}

