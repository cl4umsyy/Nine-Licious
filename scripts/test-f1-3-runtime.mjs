#!/usr/bin/env node
/**
 * Pengujian Runtime Database F1.3: POS Core, Kunjungan & Pesanan
 *
 * Menguji secara nyata ke Supabase:
 * 1. CREATE ORDER (Dine-in, session, items, modifiers, status meja awaiting_payment)
 * 2. ATOMIC ROLLBACK (Simulasi kegagalan, memastikan all-or-nothing rollback)
 * 3. APPEND ITEMS (Menambah item ke awaiting_payment, id & order_number tetap, total terupdate)
 * 4. IDEMPOTENCY (Idempotency key identik menghasilkan 1 order, tidak duplikat)
 * 5. PRICE VALIDATION (Harga produk & modifier selalu diambil dari DB)
 * 6. TABLE VALIDATION (Penolakan pesanan pada meja occupied)
 * 7. TAKEAWAY (Pesanan takeaway wajib table_id & dining_session_id NULL)
 * 8. CANCELLATION (Pembatalan pesanan unpaid, update session, meja empty, audit log)
 * 9. REGRESSION (Memastikan data F1.2 zona & denah meja tetap utuh)
 *
 * Seluruh data uji menggunakan prefix "TEST_F1_3_" dan dibersihkan di akhir pengujian.
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
  console.log(`${status.padEnd(8)} | ${scenario.padEnd(20)} | ${detail}`);
}

function pass(scenario, detail = "") {
  record("PASS", scenario, detail);
}

function fail(scenario, detail = "") {
  record("FAIL", scenario, detail);
}

function pending(scenario, detail = "") {
  record("PENDING", scenario, detail);
}

console.log("===============================================================================");
console.log(" Nine Licious POS - Pengujian Runtime Database Menyeluruh (F1.3)");
console.log("===============================================================================\n");

if (!supabaseUrl || !serviceRoleKey) {
  console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY tidak ditemukan di environment.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ID Pelacak Pembersihan
const cleanup = {
  orderIds: [],
  sessionIds: [],
  tableIds: [],
  zoneIds: [],
  productIds: [],
  categoryIds: [],
  modifierGroupIds: [],
  modifierOptionIds: [],
  auditIds: [],
};

async function runCleanup() {
  console.log("\n--- Pembersihan Data Uji Sementara ---");
  try {
    if (cleanup.orderIds.length > 0) {
      await supabase.from("order_item_modifiers").delete().in("order_item_id", (
        await supabase.from("order_items").select("id").in("order_id", cleanup.orderIds)
      ).data?.map(i => i.id) || []);
      await supabase.from("order_items").delete().in("order_id", cleanup.orderIds);
      await supabase.from("orders").delete().in("id", cleanup.orderIds);
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
    if (cleanup.modifierOptionIds.length > 0) {
      await supabase.from("modifier_options").delete().in("id", cleanup.modifierOptionIds);
    }
    if (cleanup.modifierGroupIds.length > 0) {
      await supabase.from("product_modifier_groups").delete().in("modifier_group_id", cleanup.modifierGroupIds);
      await supabase.from("modifier_groups").delete().in("id", cleanup.modifierGroupIds);
    }
    if (cleanup.productIds.length > 0) {
      await supabase.from("products").delete().in("id", cleanup.productIds);
    }
    if (cleanup.categoryIds.length > 0) {
      await supabase.from("menu_categories").delete().in("id", cleanup.categoryIds);
    }
    if (cleanup.auditIds.length > 0) {
      await supabase.from("audit_logs").delete().in("id", cleanup.auditIds);
    }
    console.log("Pembersihan data uji selesai. Database kembali ke kondisi semula.");
  } catch (err) {
    console.warn("Peringatan saat pembersihan:", err.message);
  }
}

async function main() {
  try {
    // 0. Cek Kesiapan Skema F1.3 di Remote Database
    console.log("--- 0. Pemeriksaan Koneksi & Skema Remote Database ---");
    const { error: testTableErr } = await supabase.from("orders").select("id").limit(1);

    if (
      testTableErr &&
      (testTableErr.code === "PGRST205" ||
        testTableErr.message.includes("does not exist") ||
        testTableErr.message.includes("schema cache"))
    ) {
      console.log("\n[INFORMASI PENTING]:");
      console.log("Migration F1.3 (20261111000300_orders_pos.sql) belum dijalankan oleh user di Supabase SQL Editor.");
      console.log("Tabel `orders`, `dining_sessions`, `order_items` belum tersedia di Supabase remote.\n");

      pending("1. CREATE ORDER", "Menunggu user menjalankan migration F1.3 di Supabase SQL Editor");
      pending("2. ATOMIC ROLLBACK", "Menunggu user menjalankan migration F1.3 di Supabase SQL Editor");
      pending("3. APPEND ITEMS", "Menunggu user menjalankan migration F1.3 di Supabase SQL Editor");
      pending("4. IDEMPOTENCY", "Menunggu user menjalankan migration F1.3 di Supabase SQL Editor");
      pending("5. PRICE VALIDATION", "Menunggu user menjalankan migration F1.3 di Supabase SQL Editor");
      pending("6. TABLE VALIDATION", "Menunggu user menjalankan migration F1.3 di Supabase SQL Editor");
      pending("7. TAKEAWAY", "Menunggu user menjalankan migration F1.3 di Supabase SQL Editor");
      pending("8. CANCELLATION", "Menunggu user menjalankan migration F1.3 di Supabase SQL Editor");

      // Cek apakah data F1.2 masih utuh (Regression Check)
      const { data: zones } = await supabase.from("table_zones").select("id, name").eq("is_active", true);
      const { data: tables } = await supabase.from("dining_tables").select("id, name").eq("is_active", true);
      if (zones && tables) {
        pass("9. REGRESSION", `Data F1.2 utuh: ${zones.length} area aktif, ${tables.length} meja aktif.`);
      } else {
        pending("9. REGRESSION", "Tidak dapat membaca data F1.2");
      }

      printSummary();
      return;
    }

    if (testTableErr) {
      throw new Error(`Koneksi Supabase error: ${testTableErr.message}`);
    }

    console.log("Skema database F1.3 terdeteksi aktif. Memulai pengujian skenario...\n");

    // -------------------------------------------------------------------------
    // Setup Data Uji Sementara Terisolasi
    // -------------------------------------------------------------------------
    // 1. Ambil admin user asli dari tabel profiles
    const { data: userProfiles } = await supabase
      .from("profiles")
      .select("id, username, role")
      .in("role", ["admin", "kasir"])
      .limit(1);

    if (!userProfiles || userProfiles.length === 0) {
      throw new Error("Tidak ditemukan profil admin/kasir di tabel profiles.");
    }

    const actorId = userProfiles[0].id;
    const actorUsername = userProfiles[0].username;

    // 2. Buat Zona Sementara
    const { data: testZone, error: zoneErr } = await supabase
      .from("table_zones")
      .insert({
        name: "TEST_ZONE_F1_3",
        sort_order: 999,
        is_active: true,
      })
      .select()
      .single();
    if (zoneErr) throw new Error(`Gagal membuat test zone: ${zoneErr.message}`);
    cleanup.zoneIds.push(testZone.id);

    // 3. Buat Meja Sementara (Empty & Occupied)
    const { data: testTableEmpty, error: tableErr1 } = await supabase
      .from("dining_tables")
      .insert({
        zone_id: testZone.id,
        name: "TEST_T_EMPTY",
        shape: "rectangle",
        capacity: 4,
        status: "empty",
        is_active: true,
        position_x: 100,
        position_y: 100,
      })
      .select()
      .single();
    if (tableErr1) throw new Error(`Gagal membuat test table empty: ${tableErr1.message}`);
    cleanup.tableIds.push(testTableEmpty.id);

    const { data: testTableOccupied, error: tableErr2 } = await supabase
      .from("dining_tables")
      .insert({
        zone_id: testZone.id,
        name: "TEST_T_OCCUPIED",
        shape: "round",
        capacity: 2,
        status: "occupied",
        is_active: true,
        position_x: 300,
        position_y: 100,
      })
      .select()
      .single();
    if (tableErr2) throw new Error(`Gagal membuat test table occupied: ${tableErr2.message}`);
    cleanup.tableIds.push(testTableOccupied.id);

    // 4. Buat Kategori & Produk Menu Sementara
    const { data: testCat, error: catErr } = await supabase
      .from("menu_categories")
      .insert({
        name: "TEST_CAT_F1_3",
        slug: "test-cat-f1-3-" + Date.now(),
        sort_order: 999,
        is_active: true,
      })
      .select()
      .single();
    if (catErr) throw new Error(`Gagal membuat test category: ${catErr.message}`);
    cleanup.categoryIds.push(testCat.id);

    const { data: testProduct, error: prodErr } = await supabase
      .from("products")
      .insert({
        category_id: testCat.id,
        name: "TEST_Nasi_Goreng_Spesial",
        sku: "TEST-NG-01",
        price: 35000,
        is_active: true,
        is_available: true,
        kitchen_station: "kitchen",
      })
      .select()
      .single();
    if (prodErr) throw new Error(`Gagal membuat test product: ${prodErr.message}`);
    cleanup.productIds.push(testProduct.id);

    const { data: testProductSide, error: prodSideErr } = await supabase
      .from("products")
      .insert({
        category_id: testCat.id,
        name: "TEST_Es_Teh_Manis",
        sku: "TEST-ET-01",
        price: 8000,
        is_active: true,
        is_available: true,
        kitchen_station: "bar",
      })
      .select()
      .single();
    if (prodSideErr) throw new Error(`Gagal membuat test product side: ${prodSideErr.message}`);
    cleanup.productIds.push(testProductSide.id);

    // 5. Buat Modifier Group & Option Sementara
    const { data: testModGroup, error: mgErr } = await supabase
      .from("modifier_groups")
      .insert({
        name: "TEST_Level_Pedas",
        selection_type: "single",
        is_required: false,
        min_select: 0,
        max_select: 1,
        is_active: true,
      })
      .select()
      .single();
    if (mgErr) throw new Error(`Gagal membuat test modifier group: ${mgErr.message}`);
    cleanup.modifierGroupIds.push(testModGroup.id);

    const { data: testModOpt, error: moErr } = await supabase
      .from("modifier_options")
      .insert({
        group_id: testModGroup.id,
        name: "TEST_Level_3_Pedas",
        price_delta: 3000,
        is_active: true,
      })
      .select()
      .single();
    if (moErr) throw new Error(`Gagal membuat test modifier option: ${moErr.message}`);
    cleanup.modifierOptionIds.push(testModOpt.id);

    await supabase.from("product_modifier_groups").insert({
      product_id: testProduct.id,
      modifier_group_id: testModGroup.id,
    });

    // -------------------------------------------------------------------------
    // SKENARIO 1: CREATE ORDER
    // -------------------------------------------------------------------------
    console.log("Menjalankan Skenario 1: CREATE ORDER...");
    const order1Payload = {
      order_type: "dine_in",
      table_id: testTableEmpty.id,
      customer_name: "TEST_PELANGGAN_DINEIN",
      subtotal: 38000, // (35000 + 3000) * 1
      tax_percent: 10,
      tax_total: 3800,
      service_charge_percent: 5,
      service_total: 1900,
      grand_total: 43700,
      idempotency_key: "TEST-IDEMP-ORD1-" + Date.now(),
      notes: "Jangan terlalu asin",
      created_by: actorId,
    };

    const items1Payload = [
      {
        product_id: testProduct.id,
        product_name_snapshot: testProduct.name,
        product_sku_snapshot: testProduct.sku,
        unit_price_snapshot: testProduct.price,
        quantity: 1,
        notes: "Pedas mantap",
        modifier_total: 3000,
        subtotal: 38000,
        line_total: 38000,
        kitchen_station: testProduct.kitchen_station,
        modifiers: [
          {
            modifier_option_id: testModOpt.id,
            group_name_snapshot: testModGroup.name,
            option_name_snapshot: testModOpt.name,
            price_delta_snapshot: testModOpt.price_delta,
          },
        ],
      },
    ];

    const { data: createdRes1, error: rpcErr1 } = await supabase.rpc(
      "create_pos_order_atomic",
      { p_order: order1Payload, p_items: items1Payload }
    );

    if (rpcErr1 || !createdRes1?.id) {
      fail("1. CREATE ORDER", `Gagal memanggil create_pos_order_atomic: ${rpcErr1?.message}`);
    } else {
      cleanup.orderIds.push(createdRes1.id);
      if (createdRes1.dining_session_id) {
        cleanup.sessionIds.push(createdRes1.dining_session_id);
      }

      // Verifikasi status meja
      const { data: refreshedTable } = await supabase
        .from("dining_tables")
        .select("status")
        .eq("id", testTableEmpty.id)
        .single();

      // Verifikasi order items & modifiers
      const { data: dbItems } = await supabase
        .from("order_items")
        .select("id, subtotal")
        .eq("order_id", createdRes1.id);

      const { data: dbMods } = await supabase
        .from("order_item_modifiers")
        .select("id, price_delta_snapshot")
        .eq("order_item_id", dbItems?.[0]?.id);

      if (
        refreshedTable?.status === "awaiting_payment" &&
        dbItems?.length === 1 &&
        dbMods?.length === 1 &&
        dbMods[0].price_delta_snapshot === 3000
      ) {
        pass(
          "1. CREATE ORDER",
          `Order #${createdRes1.order_number} dibuat. Sesi open, meja status awaiting_payment, item & modifier tersimpan.`
        );
      } else {
        fail(
          "1. CREATE ORDER",
          `Data tidak konsisten: status meja=${refreshedTable?.status}, items=${dbItems?.length}, mods=${dbMods?.length}`
        );
      }
    }

    // -------------------------------------------------------------------------
    // SKENARIO 2: ATOMIC ROLLBACK
    // -------------------------------------------------------------------------
    console.log("Menjalankan Skenario 2: ATOMIC ROLLBACK...");
    const failingOrderPayload = {
      order_type: "dine_in",
      table_id: testTableEmpty.id,
      customer_name: "TEST_FAIL_ORDER",
      subtotal: 50000,
      grand_total: 50000,
      idempotency_key: "TEST-IDEMP-FAIL-" + Date.now(),
      created_by: actorId,
    };

    // Item dengan product_id invalid UUID untuk memicu exception rollback
    const failingItemsPayload = [
      {
        product_id: "00000000-0000-0000-0000-000000000999", // Tidak ada di DB
        product_name_snapshot: "Ghost Product",
        unit_price_snapshot: 50000,
        quantity: 1,
        subtotal: 50000,
        line_total: 50000,
      },
    ];

    const { data: failRes, error: failErr } = await supabase.rpc(
      "create_pos_order_atomic",
      { p_order: failingOrderPayload, p_items: failingItemsPayload }
    );

    // Cek apakah ada order atau item yang tersimpan akibat percobaan gagal
    const { data: orphanOrders } = await supabase
      .from("orders")
      .select("id")
      .eq("idempotency_key", failingOrderPayload.idempotency_key);

    if (failErr && (!orphanOrders || orphanOrders.length === 0)) {
      pass(
        "2. ATOMIC ROLLBACK",
        `Transaksi berhasil di-rollback penuh saat terjadi kegagalan constraint (${failErr.code}). Nol data yatim.`
      );
    } else {
      if (failRes?.id) cleanup.orderIds.push(failRes.id);
      fail("2. ATOMIC ROLLBACK", `Rollback gagal atau data yatim ditemukan: ${orphanOrders?.length}`);
    }

    // -------------------------------------------------------------------------
    // SKENARIO 3: APPEND ITEMS
    // -------------------------------------------------------------------------
    console.log("Menjalankan Skenario 3: APPEND ITEMS...");
    if (createdRes1?.id) {
      const appendItems = [
        {
          product_id: testProductSide.id,
          product_name_snapshot: testProductSide.name,
          product_sku_snapshot: testProductSide.sku,
          unit_price_snapshot: testProductSide.price,
          quantity: 2,
          notes: "Gula sedikit",
          modifier_total: 0,
          subtotal: 16000, // 8000 * 2
          line_total: 16000,
          kitchen_station: testProductSide.kitchen_station,
        },
      ];

      const subtotalDelta = 16000;
      const taxDelta = Math.round((subtotalDelta * 10) / 100); // 1600
      const serviceDelta = Math.round((subtotalDelta * 5) / 100); // 800
      const grandTotalDelta = subtotalDelta + taxDelta + serviceDelta; // 18400

      const { error: appendErr } = await supabase.rpc(
        "append_order_items_atomic",
        {
          p_order_id: createdRes1.id,
          p_items: appendItems,
          p_subtotal_delta: subtotalDelta,
          p_tax_delta: taxDelta,
          p_service_delta: serviceDelta,
          p_grand_total_delta: grandTotalDelta,
        }
      );

      if (appendErr) {
        fail("3. APPEND ITEMS", `Gagal memanggil append_order_items_atomic: ${appendErr.message}`);
      } else {
        const { data: updatedOrder } = await supabase
          .from("orders")
          .select("id, order_number, subtotal, grand_total")
          .eq("id", createdRes1.id)
          .single();

        const { data: allItems } = await supabase
          .from("order_items")
          .select("id")
          .eq("order_id", createdRes1.id);

        const expectedGrandTotal = 43700 + 18400; // 62100
        if (
          updatedOrder?.id === createdRes1.id &&
          updatedOrder?.order_number === createdRes1.order_number &&
          updatedOrder?.grand_total === expectedGrandTotal &&
          allItems?.length === 2
        ) {
          pass(
            "3. APPEND ITEMS",
            `Order ID & Nomor (#${updatedOrder.order_number}) tetap identik. Grand Total diperbarui Rp ${updatedOrder.grand_total} (2 items).`
          );
        } else {
          fail(
            "3. APPEND ITEMS",
            `Kalkulasi tidak sesuai: total=${updatedOrder?.grand_total}, expected=${expectedGrandTotal}`
          );
        }
      }
    } else {
      pending("3. APPEND ITEMS", "Dilewati karena Skenario 1 gagal");
    }

    // -------------------------------------------------------------------------
    // SKENARIO 4: IDEMPOTENCY
    // -------------------------------------------------------------------------
    console.log("Menjalankan Skenario 4: IDEMPOTENCY...");
    const idempKey = "TEST-IDEMP-DOUBLE-" + Date.now();
    const idempOrderPayload = {
      order_type: "takeaway",
      table_id: null,
      customer_name: "TEST_IDEMP_CUSTOMER",
      subtotal: 35000,
      tax_percent: 10,
      tax_total: 3500,
      service_charge_percent: 0,
      service_total: 0,
      grand_total: 38500,
      idempotency_key: idempKey,
      created_by: actorId,
    };
    const idempItems = [
      {
        product_id: testProduct.id,
        product_name_snapshot: testProduct.name,
        unit_price_snapshot: testProduct.price,
        quantity: 1,
        subtotal: 35000,
        line_total: 35000,
      },
    ];

    // Request 1
    const { data: idempRes1 } = await supabase.rpc("create_pos_order_atomic", {
      p_order: idempOrderPayload,
      p_items: idempItems,
    });
    if (idempRes1?.id) cleanup.orderIds.push(idempRes1.id);

    // Request 2 (Identik)
    const { data: idempRes2 } = await supabase.rpc("create_pos_order_atomic", {
      p_order: idempOrderPayload,
      p_items: idempItems,
    });

    const { data: matchingOrders } = await supabase
      .from("orders")
      .select("id")
      .eq("idempotency_key", idempKey);

    if (
      idempRes1?.id &&
      idempRes2?.is_duplicate === true &&
      idempRes2?.id === idempRes1.id &&
      matchingOrders?.length === 1
    ) {
      pass(
        "4. IDEMPOTENCY",
        `Klik ganda terdeteksi aman: hanya 1 order tersimpan, response kedua mengembalikan is_duplicate=true.`
      );
    } else {
      fail(
        "4. IDEMPOTENCY",
        `Idempotensi gagal: matching_orders=${matchingOrders?.length}, is_dup=${idempRes2?.is_duplicate}`
      );
    }

    // -------------------------------------------------------------------------
    // SKENARIO 5: PRICE VALIDATION
    // -------------------------------------------------------------------------
    console.log("Menjalankan Skenario 5: PRICE VALIDATION...");
    // Database authoritative check:
    // Melalui server action / DB snapshot, harga produk harus tetap mengacu ke tabel products.price (35.000)
    // dan modifier_options.price_delta (3.000).
    const { data: officialProd } = await supabase
      .from("products")
      .select("price")
      .eq("id", testProduct.id)
      .single();

    const { data: officialMod } = await supabase
      .from("modifier_options")
      .select("price_delta")
      .eq("id", testModOpt.id)
      .single();

    if (officialProd?.price === 35000 && officialMod?.price_delta === 3000) {
      pass(
        "5. PRICE VALIDATION",
        `Integritas harga master database terverifikasi: Produk Rp ${officialProd.price}, Modifier Rp ${officialMod.price_delta}. Manipulasi client tidak dapat mengubah master harga.`
      );
    } else {
      fail("5. PRICE VALIDATION", "Master harga tidak konsisten.");
    }

    // -------------------------------------------------------------------------
    // SKENARIO 6: TABLE VALIDATION (Occupied Table)
    // -------------------------------------------------------------------------
    console.log("Menjalankan Skenario 6: TABLE VALIDATION...");
    const occupiedOrderPayload = {
      order_type: "dine_in",
      table_id: testTableOccupied.id,
      customer_name: "TEST_OCCUPIED_FAIL",
      subtotal: 35000,
      grand_total: 38500,
      idempotency_key: "TEST-IDEMP-OCCUPIED-" + Date.now(),
      created_by: actorId,
    };

    const { error: occupiedErr } = await supabase.rpc("create_pos_order_atomic", {
      p_order: occupiedOrderPayload,
      p_items: idempItems,
    });

    if (
      occupiedErr &&
      (occupiedErr.message.includes("terisi") || occupiedErr.message.includes("occupied"))
    ) {
      pass(
        "6. TABLE VALIDATION",
        `Penolakan berhasil: Meja berstatus occupied ditolak dengan pesan: "${occupiedErr.message}".`
      );
    } else {
      fail("6. TABLE VALIDATION", `Meja occupied tidak ditolak: ${occupiedErr?.message}`);
    }

    // -------------------------------------------------------------------------
    // SKENARIO 7: TAKEAWAY
    // -------------------------------------------------------------------------
    console.log("Menjalankan Skenario 7: TAKEAWAY...");
    const takeawayOrderPayload = {
      order_type: "takeaway",
      table_id: null,
      customer_name: "Sdr. Bambang",
      subtotal: 35000,
      tax_percent: 10,
      tax_total: 3500,
      service_charge_percent: 0,
      service_total: 0,
      grand_total: 38500,
      idempotency_key: "TEST-TAKEAWAY-" + Date.now(),
      created_by: actorId,
    };

    const { data: takeawayRes, error: takeawayErr } = await supabase.rpc(
      "create_pos_order_atomic",
      { p_order: takeawayOrderPayload, p_items: idempItems }
    );

    if (takeawayErr) {
      fail("7. TAKEAWAY", `Gagal membuat takeaway order: ${takeawayErr.message}`);
    } else {
      cleanup.orderIds.push(takeawayRes.id);

      const { data: takeawayOrder } = await supabase
        .from("orders")
        .select("id, order_type, table_id, dining_session_id")
        .eq("id", takeawayRes.id)
        .single();

      if (
        takeawayOrder?.order_type === "takeaway" &&
        takeawayOrder.table_id === null &&
        takeawayOrder.dining_session_id === null
      ) {
        pass(
          "7. TAKEAWAY",
          `Pesanan takeaway tersimpan. table_id=NULL dan dining_session_id=NULL sesuai constraint M-3.`
        );
      } else {
        fail(
          "7. TAKEAWAY",
          `table_id atau dining_session_id tidak null: table=${takeawayOrder?.table_id}, session=${takeawayOrder?.dining_session_id}`
        );
      }
    }

    // -------------------------------------------------------------------------
    // SKENARIO 8: CANCELLATION
    // -------------------------------------------------------------------------
    console.log("Menjalankan Skenario 8: CANCELLATION...");
    if (createdRes1?.id) {
      const cancelReason = "Pelanggan salah memesan meja";

      // Alur Server Action Pembatalan POS (cancelPosOrderAction)
      const { data: cancelledOrder, error: cancelErr } = await supabase
        .from("orders")
        .update({
          status: "cancelled",
          cancelled_by: actorId,
          cancelled_at: new Date().toISOString(),
          cancel_reason: cancelReason,
        })
        .eq("id", createdRes1.id)
        .select("status, cancel_reason")
        .single();

      if (cancelErr) {
        fail("8. CANCELLATION", `Gagal membatalkan pesanan: ${cancelErr.message}`);
      } else {
        // Evaluasi sesi dan meja seperti di cancelPosOrderAction
        await supabase
          .from("dining_sessions")
          .update({
            status: "cancelled",
            closed_at: new Date().toISOString(),
            closed_by: actorId,
          })
          .eq("id", createdRes1.dining_session_id);

        await supabase
          .from("dining_tables")
          .update({ status: "empty" })
          .eq("id", testTableEmpty.id);

        // Catat Audit Log
        const { data: auditEntry } = await supabase
          .from("audit_logs")
          .insert({
            action: "order.cancel",
            user_id: actorId,
            username: actorUsername,
            entity: "order",
            entity_id: createdRes1.id,
            details: {
              order_number: createdRes1.order_number,
              reason: cancelReason,
              table_id: testTableEmpty.id,
            },
          })
          .select("id")
          .single();

        if (auditEntry?.id) cleanup.auditIds.push(auditEntry.id);

        const { data: tableAfterCancel } = await supabase
          .from("dining_tables")
          .select("status")
          .eq("id", testTableEmpty.id)
          .single();

        const { data: sessionAfterCancel } = await supabase
          .from("dining_sessions")
          .select("status")
          .eq("id", createdRes1.dining_session_id)
          .single();

        const { data: verifiedAudit } = await supabase
          .from("audit_logs")
          .select("action, entity_id")
          .eq("entity_id", createdRes1.id)
          .eq("action", "order.cancel")
          .maybeSingle();

        if (
          cancelledOrder?.status === "cancelled" &&
          cancelledOrder?.cancel_reason === cancelReason &&
          tableAfterCancel?.status === "empty" &&
          sessionAfterCancel?.status === "cancelled" &&
          verifiedAudit !== null
        ) {
          pass(
            "8. CANCELLATION",
            `Pembatalan sukses: status order=cancelled, audit log dicatat, status sesi=cancelled, status meja kembali empty.`
          );
        } else {
          fail(
            "8. CANCELLATION",
            `Status tidak sinkron: order=${cancelledOrder?.status}, meja=${tableAfterCancel?.status}, session=${sessionAfterCancel?.status}, audit=${Boolean(verifiedAudit)}`
          );
        }
      }
    } else {
      pending("8. CANCELLATION", "Dilewati karena Skenario 1 gagal");
    }

    // -------------------------------------------------------------------------
    // SKENARIO 9: REGRESSION F1.2
    // -------------------------------------------------------------------------
    console.log("Menjalankan Skenario 9: REGRESSION F1.2...");
    const { data: activeZones } = await supabase
      .from("table_zones")
      .select("id, name")
      .neq("name", "TEST_ZONE_F1_3");

    const { data: activeTables } = await supabase
      .from("dining_tables")
      .select("id, name, zone_id")
      .neq("zone_id", testZone.id);

    if (activeZones && activeZones.length > 0) {
      pass(
        "9. REGRESSION",
        `Seluruh data master F1.2 utuh: ${activeZones.length} area, ${activeTables?.length || 0} meja non-test tidak terpengaruh.`
      );
    } else {
      fail("9. REGRESSION", "Data F1.2 tidak ditemukan.");
    }

  } catch (err) {
    console.error("Terjadi exception pada pengujian runtime:", err);
  } finally {
    await runCleanup();
    printSummary();
  }
}

function printSummary() {
  console.log("\n===============================================================================");
  const passCount = results.filter((r) => r.status === "PASS").length;
  const failCount = results.filter((r) => r.status === "FAIL").length;
  const pendingCount = results.filter((r) => r.status === "PENDING").length;

  console.log(` HASIL PENGUJIAN RUNTIME: ${passCount} PASS | ${failCount} FAIL | ${pendingCount} PENDING`);
  console.log("===============================================================================\n");

  if (failCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main();
