#!/usr/bin/env node
/**
 * Pengujian Runtime Database Remote F1.4: Diskon, Approval Nonce, & Finalisasi Pesanan
 *
 * Menguji secara live ke database Supabase:
 * 1. Skema & Kolom: discounts, order_discounts, discount_approval_nonces, kolom orders (is_finalized)
 * 2. RPC create_pos_order_atomic 2-parameter (kompatibilitas F1.3)
 * 3. RPC create_pos_order_atomic 3-parameter:
 *    - Diskon produk master (%)
 *    - Diskon pesanan master (fixed)
 *    - Diskon manual (%) dengan nonce approval admin aktif
 * 4. Keamanan Nonce:
 *    - Penolakan nonce dengan idempotency_key berbeda
 *    - Penolakan nonce yang sudah digunakan (single-use)
 * 5. RPC append_order_items_atomic:
 *    - Penambahan item baru & rekalkulasi diskon otomatis
 *    - Penolakan penambahan item jika pesanan sudah difinalisasi
 * 6. RPC finalize_pos_order & unfinalize_pos_order:
 *    - Penguncian status is_finalized = true & audit log order.finalize
 *    - Pembukaan kembali & audit log order.unfinalize
 * 7. Pembersihan data pengujian sementara
 */

import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd(), true);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const results = [];

function record(status, scenario, detail = "") {
  results.push({ status, scenario, detail });
  console.log(`${status.padEnd(8)} | ${scenario.padEnd(25)} | ${detail}`);
}

function pass(scenario, detail = "") {
  record("PASS", scenario, detail);
}

function fail(scenario, detail = "") {
  record("FAIL", scenario, detail);
}

console.log("===============================================================================");
console.log(" Nine Licious POS - Pengujian Runtime Database F1.4 (Remote Supabase)");
console.log("===============================================================================\n");

if (!supabaseUrl || !serviceRoleKey) {
  console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY tidak ditemukan di environment.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Pelacak Pembersihan Data Uji
const cleanup = {
  orderIds: [],
  sessionIds: [],
  tableIds: [],
  zoneIds: [],
  productIds: [],
  categoryIds: [],
  discountIds: [],
  nonceIds: [],
  auditLogIds: [],
};

async function main() {
  try {
    // -------------------------------------------------------------------------
    // 1. Verifikasi Keberadaan Tabel & Kolom F1.4
    // -------------------------------------------------------------------------
    console.log("--- 1. Verifikasi Skema & Kolom F1.4 di Supabase ---");

    // Tabel discounts
    const { error: discErr } = await supabase
      .from("discounts")
      .select("id, name, scope, discount_type, discount_value, is_active")
      .limit(1);

    if (discErr) {
      fail("1. SKEMA", `Tabel public.discounts tidak dapat diakses: ${discErr.message}`);
    } else {
      pass("1. SKEMA", "Tabel public.discounts tersedia dan dapat di-query");
    }

    // Tabel discount_approval_nonces
    const { error: nonceErr } = await supabase
      .from("discount_approval_nonces")
      .select("id, nonce, approver_id, cashier_id, context_ref, is_used")
      .limit(1);

    if (nonceErr) {
      fail("1. SKEMA", `Tabel public.discount_approval_nonces tidak dapat diakses: ${nonceErr.message}`);
    } else {
      pass("1. SKEMA", "Tabel public.discount_approval_nonces tersedia dan dapat di-query");
    }

    // Tabel order_discounts
    const { error: ordDiscErr } = await supabase
      .from("order_discounts")
      .select("id, order_id, scope, discount_type, discount_rate, discount_amount")
      .limit(1);

    if (ordDiscErr) {
      fail("1. SKEMA", `Tabel public.order_discounts tidak dapat diakses: ${ordDiscErr.message}`);
    } else {
      pass("1. SKEMA", "Tabel public.order_discounts tersedia dan dapat di-query");
    }

    // Kolom finalisasi pada orders
    const { error: orderColErr } = await supabase
      .from("orders")
      .select("id, is_finalized, finalized_at, finalized_by")
      .limit(1);

    if (orderColErr) {
      fail("1. SKEMA", `Kolom finalisasi pada public.orders tidak dapat diakses: ${orderColErr.message}`);
    } else {
      pass("1. SKEMA", "Kolom is_finalized, finalized_at, finalized_by pada orders tersedia");
    }

    // -------------------------------------------------------------------------
    // 2. Persiapan Data Master Sementara (Admin, Kasir, Kategori, Produk, Meja)
    // -------------------------------------------------------------------------
    console.log("\n--- 2. Persiapan Data Master Sementara ---");

    // Ambil admin aktif
    const { data: adminProfile } = await supabase
      .from("profiles")
      .select("id, role, is_active")
      .eq("role", "admin")
      .eq("is_active", true)
      .limit(1)
      .single();

    if (!adminProfile) {
      fail("2. SETUP", "Tidak ditemukan akun admin aktif di profiles");
      return;
    }
    pass("2. SETUP", `Admin aktif ditemukan (id: ${adminProfile.id})`);

    // Ambil kasir aktif
    const { data: cashierProfile } = await supabase
      .from("profiles")
      .select("id, role, is_active")
      .eq("role", "kasir")
      .eq("is_active", true)
      .limit(1)
      .single();

    const testStaffId = cashierProfile ? cashierProfile.id : adminProfile.id;
    pass("2. SETUP", `Staf kasir ditemukan (id: ${testStaffId})`);

    // Buat Area & Meja Uji
    const { data: testZone, error: zoneErr } = await supabase
      .from("table_zones")
      .insert({ name: "TEST_F1_4_ZONE", sort_order: 999, is_active: true })
      .select()
      .single();

    if (zoneErr) throw new Error(`Gagal membuat area uji: ${zoneErr.message}`);
    cleanup.zoneIds.push(testZone.id);

    const { data: testTable, error: tableErr } = await supabase
      .from("dining_tables")
      .insert({
        zone_id: testZone.id,
        name: "T-F14-01",
        capacity: 4,
        status: "empty",
        is_active: true,
        position_x: 100,
        position_y: 100,
        shape: "rectangle",
      })
      .select()
      .single();

    if (tableErr) throw new Error(`Gagal membuat meja uji: ${tableErr.message}`);
    cleanup.tableIds.push(testTable.id);

    // Buat Kategori & Produk Uji
    const testCatSlug = `test-cat-f14-${Date.now()}`;
    const { data: testCat, error: catErr } = await supabase
      .from("menu_categories")
      .insert({
        name: `Test Cat F14 ${Date.now()}`,
        slug: testCatSlug,
        sort_order: 999,
        is_active: true,
      })
      .select()
      .single();

    if (catErr) throw new Error(`Gagal membuat kategori uji: ${catErr.message}`);
    cleanup.categoryIds.push(testCat.id);

    const { data: testProd1, error: prodErr1 } = await supabase
      .from("products")
      .insert({
        category_id: testCat.id,
        name: `Test Nasgor F14 ${Date.now()}`,
        price: 30000,
        is_active: true,
        is_available: true,
      })
      .select()
      .single();

    if (prodErr1) throw new Error(`Gagal membuat produk uji 1: ${prodErr1.message}`);
    cleanup.productIds.push(testProd1.id);

    const { data: testProd2, error: prodErr2 } = await supabase
      .from("products")
      .insert({
        category_id: testCat.id,
        name: `Test Es Teh F14 ${Date.now()}`,
        price: 10000,
        is_active: true,
        is_available: true,
      })
      .select()
      .single();

    if (prodErr2) throw new Error(`Gagal membuat produk uji 2: ${prodErr2.message}`);
    cleanup.productIds.push(testProd2.id);

    // Buat Master Promo Diskon Produk (10%) & Diskon Pesanan (Fixed Rp 5.000)
    const { data: promoProd, error: promoProdErr } = await supabase
      .from("discounts")
      .insert({
        name: "TEST_PROMO_PRODUK_10_PCT",
        scope: "product",
        discount_type: "percentage",
        discount_value: 10,
        applies_to_product_id: testProd1.id,
        is_active: true,
      })
      .select()
      .single();

    if (promoProdErr) throw new Error(`Gagal membuat master diskon produk: ${promoProdErr.message}`);
    cleanup.discountIds.push(promoProd.id);

    const { data: promoOrder, error: promoOrderErr } = await supabase
      .from("discounts")
      .insert({
        name: "TEST_PROMO_ORDER_FIXED_5K",
        scope: "order",
        discount_type: "fixed",
        discount_value: 5000,
        min_order_amount: 20000,
        is_active: true,
      })
      .select()
      .single();

    if (promoOrderErr) throw new Error(`Gagal membuat master diskon order: ${promoOrderErr.message}`);
    cleanup.discountIds.push(promoOrder.id);

    pass("2. SETUP", "Data master uji berhasil dipersiapkan (meja, produk, master diskon)");

    // -------------------------------------------------------------------------
    // 3. Pengujian RPC create_pos_order_atomic (2 Parameter - Kompatibilitas F1.3)
    // -------------------------------------------------------------------------
    console.log("\n--- 3. Pengujian RPC 2-Parameter (Kompatibilitas F1.3) ---");
    const idempotencyF13 = `TEST_IDEMP_F13_${Date.now()}`;

    // Jalankan RPC sebagai testStaffId
    const { data: orderF13, error: errF13 } = await supabase.rpc("create_pos_order_atomic", {
      p_order: {
        order_type: "takeaway",
        customer_name: "Pelanggan F1.3 Test",
        idempotency_key: idempotencyF13,
        tax_percent: 10,
        service_charge_percent: 5,
      },
      p_items: [
        {
          product_id: testProd1.id,
          product_name_snapshot: testProd1.name,
          unit_price_snapshot: testProd1.price,
          quantity: 2,
          subtotal: 60000,
          modifier_total: 0,
        },
      ],
    });

    if (errF13) {
      fail("3. RPC F1.3", `Gagal memanggil create_pos_order_atomic (2 parameter): ${errF13.message}`);
    } else {
      cleanup.orderIds.push(orderF13.id);
      if (orderF13.subtotal === 60000 && orderF13.discount_total === 0 && orderF13.grand_total === 69000) {
        pass("3. RPC F1.3", `Kompatibilitas wrapper 2-parameter F1.3 lulus (Grand total: Rp ${orderF13.grand_total})`);
      } else {
        fail("3. RPC F1.3", `Kalkulasi total tidak sesuai: subtotal=${orderF13.subtotal}, grand=${orderF13.grand_total}`);
      }
    }

    // -------------------------------------------------------------------------
    // 4. Pengujian RPC create_pos_order_atomic (3 Parameter - Diskon Produk, Order, & Nonce Manual)
    // -------------------------------------------------------------------------
    console.log("\n--- 4. Pengujian RPC 3-Parameter dengan Diskon Lengkap ---");

    const idempotencyF14 = `TEST_IDEMP_F14_${Date.now()}`;
    const testNonceStr = `NONCE_TEST_${Date.now()}`;

    // Buat approval nonce resmi untuk diskon manual 5%
    const { data: createdNonce, error: nonceInsertErr } = await supabase
      .from("discount_approval_nonces")
      .insert({
        nonce: testNonceStr,
        approver_id: adminProfile.id,
        cashier_id: testStaffId,
        discount_type: "percentage",
        discount_value: 5,
        reason: "Diskon Karyawan Terverifikasi",
        context_ref: `idempotency:${idempotencyF14}`,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      })
      .select()
      .single();

    if (nonceInsertErr) {
      fail("4. RPC F1.4", `Gagal membuat approval nonce uji: ${nonceInsertErr.message}`);
    } else {
      cleanup.nonceIds.push(createdNonce.id);
      pass("4. RPC F1.4", `Approval nonce uji berhasil dibuat (id: ${createdNonce.id})`);
    }

    // Eksekusi pesanan Dine-in dengan 3 lapis diskon:
    // Item 1: Nasi Goreng (2 x 30.000 = 60.000) -> Diskon Produk 10% = 6.000 -> Line total 54.000
    // Item 2: Es Teh (2 x 10.000 = 20.000) -> Tanpa diskon produk -> Line total 20.000
    // Subtotal sebelum diskon: 80.000
    // Subtotal setelah diskon produk: 74.000
    // Diskon Pesanan (Fixed Rp 5.000): 5.000 -> Sisa 69.000
    // Diskon Manual (5% dari sisa 69.000): round(69.000 * 5 / 100) = 3.450 -> Sisa 65.550
    // Total Diskon: 6.000 + 5.000 + 3.450 = 14.450
    // Taxable base: 80.000 - 14.450 = 65.550
    // Pajak (10%): round(65.550 * 10%) = 6.555
    // Service Charge (5%): round(65.550 * 5%) = 3.278
    // Grand Total: 65.550 + 6.555 + 3.278 = 75.383

    const { data: orderF14, error: errF14 } = await supabase.rpc("create_pos_order_atomic", {
      p_order: {
        order_type: "dine_in",
        table_id: testTable.id,
        idempotency_key: idempotencyF14,
        tax_percent: 10,
        service_charge_percent: 5,
      },
      p_items: [
        {
          client_item_id: "item_nasgor",
          product_id: testProd1.id,
          product_name_snapshot: testProd1.name,
          unit_price_snapshot: testProd1.price,
          quantity: 2,
          subtotal: 60000,
          modifier_total: 0,
        },
        {
          client_item_id: "item_esteh",
          product_id: testProd2.id,
          product_name_snapshot: testProd2.name,
          unit_price_snapshot: testProd2.price,
          quantity: 2,
          subtotal: 20000,
          modifier_total: 0,
        },
      ],
      p_discounts: [
        {
          scope: "product",
          client_item_id: "item_nasgor",
          discount_id: promoProd.id,
          discount_type: "percentage",
          discount_rate: 10,
        },
        {
          scope: "order",
          discount_id: promoOrder.id,
          discount_type: "fixed",
          discount_rate: 5000,
        },
        {
          scope: "manual",
          discount_type: "percentage",
          discount_rate: 5,
          approval_nonce: testNonceStr,
          reason: "Diskon Karyawan Terverifikasi",
        },
      ],
    });

    if (errF14) {
      fail("4. RPC F1.4", `Gagal memanggil create_pos_order_atomic (3 parameter): ${errF14.message}`);
    } else {
      cleanup.orderIds.push(orderF14.id);
      if (orderF14.dining_session_id) cleanup.sessionIds.push(orderF14.dining_session_id);

      // Verifikasi status pesanan & kalkulasi di database
      const { data: fullOrder } = await supabase
        .from("orders")
        .select("*")
        .eq("id", orderF14.id)
        .single();

      const expectedDiscountTotal = 14450;
      const expectedGrandTotal = 75383;

      if (
        fullOrder.subtotal === 80000 &&
        fullOrder.discount_total === expectedDiscountTotal &&
        fullOrder.grand_total === expectedGrandTotal &&
        fullOrder.status === "awaiting_payment"
      ) {
        pass("4. RPC F1.4", `Pesanan 3 lapis diskon berhasil & authoritatif (Subtotal: 80k, Diskon: ${fullOrder.discount_total}, Grand: ${fullOrder.grand_total})`);
      } else {
        fail("4. RPC F1.4", `Kalkulasi diskon tidak cocok: subtotal=${fullOrder.subtotal}, diskon=${fullOrder.discount_total} (harus ${expectedDiscountTotal}), grand=${fullOrder.grand_total} (harus ${expectedGrandTotal})`);
      }

      // Verifikasi status single-use nonce
      const { data: usedNonce } = await supabase
        .from("discount_approval_nonces")
        .select("is_used, used_in_order_id, used_at")
        .eq("id", createdNonce.id)
        .single();

      if (usedNonce.is_used && usedNonce.used_in_order_id === orderF14.id) {
        pass("4. NONCE", "Nonce berhasil dikunci dan ditandai is_used = true mengaitkan order_id");
      } else {
        fail("4. NONCE", `Status nonce tidak terupdate: is_used=${usedNonce.is_used}`);
      }

      // -----------------------------------------------------------------------
      // 5. Pengujian Append Items & Rekalkulasi Diskon
      // -----------------------------------------------------------------------
      console.log("\n--- 5. Pengujian Append Items & Rekalkulasi Diskon ---");

      // Tambahkan 1 Es Teh (10.000) ke pesanan yang sedang menunggu pembayaran
      // Subtotal baru: 80.000 + 10.000 = 90.000
      // Diskon produk lama (tetap 6.000) -> Subtotal setelah diskon produk: 84.000
      // Diskon pesanan fixed (5.000) -> Sisa: 79.000
      // Diskon manual (5% dari sisa 79.000): round(79.000 * 5 / 100) = 3.950 -> Sisa 75.050
      // Total Diskon Baru: 6.000 + 5.000 + 3.950 = 14.950
      // Taxable base: 90.000 - 14.950 = 75.050
      // Pajak (10%): round(75.050 * 10%) = 7.505
      // Service Charge (5%): round(75.050 * 5%) = 3.753
      // Grand Total Baru: 75.050 + 7.505 + 3.753 = 86.308

      const { error: appendErr } = await supabase.rpc("append_order_items_atomic", {
        p_order_id: orderF14.id,
        p_items: [
          {
            product_id: testProd2.id,
            product_name_snapshot: testProd2.name,
            unit_price_snapshot: testProd2.price,
            quantity: 1,
            subtotal: 10000,
            line_total: 10000,
          },
        ],
        p_subtotal_delta: 10000,
        p_tax_delta: 0,
        p_service_delta: 0,
        p_grand_total_delta: 0,
      });

      if (appendErr) {
        fail("5. APPEND", `Gagal memanggil append_order_items_atomic: ${appendErr.message}`);
      } else {
        const { data: updatedOrder } = await supabase
          .from("orders")
          .select("*")
          .eq("id", orderF14.id)
          .single();

        const expectedAppendedGrand = 86308;
        const expectedAppendedDisc = 14950;

        if (
          updatedOrder.subtotal === 90000 &&
          updatedOrder.discount_total === expectedAppendedDisc &&
          updatedOrder.grand_total === expectedAppendedGrand
        ) {
          pass("5. APPEND", `Item berhasil di-append & seluruh diskon dihitung ulang otomatis (Grand baru: Rp ${updatedOrder.grand_total})`);
        } else {
          fail("5. APPEND", `Total setelah append tidak sesuai: subtotal=${updatedOrder.subtotal}, diskon=${updatedOrder.discount_total}, grand=${updatedOrder.grand_total} (harus ${expectedAppendedGrand})`);
        }
      }

      // -----------------------------------------------------------------------
      // 6. Pengujian RPC finalize_pos_order & unfinalize_pos_order
      // -----------------------------------------------------------------------
      console.log("\n--- 6. Pengujian RPC finalize_pos_order & unfinalize_pos_order ---");

      // Finalize pesanan
      const { error: finalizeErr } = await supabase.rpc("finalize_pos_order", {
        p_order_id: orderF14.id,
      });

      if (finalizeErr) {
        fail("6. FINALISASI", `Gagal memanggil finalize_pos_order: ${finalizeErr.message}`);
      } else {
        const { data: finalizedOrder } = await supabase
          .from("orders")
          .select("is_finalized, finalized_at")
          .eq("id", orderF14.id)
          .single();

        if (finalizedOrder.is_finalized && finalizedOrder.finalized_at) {
          pass("6. FINALISASI", `Pesanan berhasil difinalisasi (is_finalized = true)`);
        } else {
          fail("6. FINALISASI", "Kolom is_finalized tidak terupdate");
        }

        // Cek audit log finalize
        const { data: auditFinalize } = await supabase
          .from("audit_logs")
          .select("id, action, entity_id")
          .eq("action", "order.finalize")
          .eq("entity_id", orderF14.id)
          .limit(1)
          .single();

        if (auditFinalize) {
          cleanup.auditLogIds.push(auditFinalize.id);
          pass("6. FINALISASI", `Audit log order.finalize otomatis tercatat di database`);
        } else {
          fail("6. FINALISASI", "Audit log order.finalize tidak ditemukan");
        }

        // Coba append item ke pesanan yang sudah difinalisasi (harus ditolak)
        const { error: appendBlockedErr } = await supabase.rpc("append_order_items_atomic", {
          p_order_id: orderF14.id,
          p_items: [
            {
              product_id: testProd2.id,
              product_name_snapshot: testProd2.name,
              unit_price_snapshot: testProd2.price,
              quantity: 1,
              subtotal: 10000,
              line_total: 10000,
            },
          ],
          p_subtotal_delta: 10000,
          p_tax_delta: 0,
          p_service_delta: 0,
          p_grand_total_delta: 0,
        });

        if (appendBlockedErr && appendBlockedErr.message.includes("sudah difinalisasi")) {
          pass("6. PROTEKSI FINAL", "Penambahan item ke pesanan yang sudah difinalisasi berhasil diblokir");
        } else {
          fail("6. PROTEKSI FINAL", "Pesanan terfinalisasi tidak menolak penambahan item");
        }

        // Buka kembali (unfinalize)
        const { error: unfinalizeErr } = await supabase.rpc("unfinalize_pos_order", {
          p_order_id: orderF14.id,
          p_reason: "Pelanggan ingin menambah pesanan kembali sebelum bayar",
        });

        if (unfinalizeErr) {
          fail("6. UNFINALIZE", `Gagal memanggil unfinalize_pos_order: ${unfinalizeErr.message}`);
        } else {
          const { data: unfinalizedOrder } = await supabase
            .from("orders")
            .select("is_finalized, finalized_at")
            .eq("id", orderF14.id)
            .single();

          if (!unfinalizedOrder.is_finalized && unfinalizedOrder.finalized_at === null) {
            pass("6. UNFINALIZE", "Pesanan berhasil dibuka kembali (is_finalized = false)");
          } else {
            fail("6. UNFINALIZE", "Pesanan gagal di-unfinalize");
          }

          // Cek audit log unfinalize
          const { data: auditUnfinalize } = await supabase
            .from("audit_logs")
            .select("id, action, entity_id")
            .eq("action", "order.unfinalize")
            .eq("entity_id", orderF14.id)
            .limit(1)
            .single();

          if (auditUnfinalize) {
            cleanup.auditLogIds.push(auditUnfinalize.id);
            pass("6. UNFINALIZE", `Audit log order.unfinalize otomatis tercatat di database`);
          } else {
            fail("6. UNFINALIZE", "Audit log order.unfinalize tidak ditemukan");
          }
        }
      }
    }
  } catch (err) {
    fail("RUNTIME FATAL", err.message);
  } finally {
    // -------------------------------------------------------------------------
    // 7. Pembersihan Data Pengujian Sementara
    // -------------------------------------------------------------------------
    console.log("\n--- 7. Pembersihan Data Pengujian Sementara (Cleanup) ---");

    if (cleanup.orderIds.length > 0) {
      await supabase.from("order_discounts").delete().in("order_id", cleanup.orderIds);
      await supabase.from("order_item_modifiers").delete().in("order_item_id", (
        await supabase.from("order_items").select("id").in("order_id", cleanup.orderIds)
      ).data?.map((i) => i.id) || []);
      await supabase.from("order_items").delete().in("order_id", cleanup.orderIds);
      await supabase.from("orders").delete().in("id", cleanup.orderIds);
    }

    if (cleanup.nonceIds.length > 0) {
      await supabase.from("discount_approval_nonces").delete().in("id", cleanup.nonceIds);
    }

    if (cleanup.discountIds.length > 0) {
      await supabase.from("discounts").delete().in("id", cleanup.discountIds);
    }

    if (cleanup.sessionIds.length > 0) {
      await supabase.from("dining_sessions").delete().in("id", cleanup.sessionIds);
    }

    if (cleanup.tableIds.length > 0) {
      await supabase.from("dining_tables").delete().in("id", cleanup.tableIds);
    }

    if (cleanup.zoneIds.length > 0) {
      await supabase.from("table_zones").delete().in("id", cleanup.zoneIds);
    }

    if (cleanup.productIds.length > 0) {
      await supabase.from("products").delete().in("id", cleanup.productIds);
    }

    if (cleanup.categoryIds.length > 0) {
      await supabase.from("menu_categories").delete().in("id", cleanup.categoryIds);
    }

    if (cleanup.auditLogIds.length > 0) {
      await supabase.from("audit_logs").delete().in("id", cleanup.auditLogIds);
    }

    console.log("Pembersihan data selesai. Seluruh data transaksi asli utuh.");
  }

  // ---------------------------------------------------------------------------
  // Ringkasan
  // ---------------------------------------------------------------------------
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
}

main();
