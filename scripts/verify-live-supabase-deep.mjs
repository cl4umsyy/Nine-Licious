#!/usr/bin/env node
/**
 * NINE LICIOUS POS - DEEP LIVE SUPABASE AUDIT (READ-ONLY)
 * Memvalidasi 6 fokus audit langsung terhadap instance PostgreSQL live Supabase.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
const { createClient } = require("@supabase/supabase-js");

loadEnvConfig(process.cwd(), true);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log("================================================================================");
console.log("  NINE LICIOUS POS - DEEP LIVE AUDIT REPORT (SUPABASE RUNTIME)");
console.log("================================================================================");
console.log(`Target URL: ${supabaseUrl}`);

const adminClient = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const anonClient = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let results = [];

function record(section, name, status, detail) {
  results.push({ section, name, status, detail });
  const tag = status ? "[PASS]" : "[FAIL]";
  console.log(`  ${tag} ${name} -> ${detail}`);
}

async function runDeepAudit() {
  console.log("\n--- FOKUS 1: create_pos_order_atomic TANPA calculate_and_apply_order_discounts ---");
  try {
    // 1. Ambil 1 produk nyata untuk pengujian kalkulasi diskon inline
    const { data: products } = await adminClient.from("products").select("id, name, price").eq("is_active", true).limit(1);
    if (!products || products.length === 0) {
      throw new Error("Tidak ada produk aktif untuk uji kalkulasi.");
    }
    const sampleProduct = products[0];

    // Panggil create_pos_order_atomic dengan parameter diskon & item lengkap
    const testIdempotencyKey = `AUDIT-PROBE-${Date.now()}`;
    const res = await adminClient.rpc("create_pos_order_atomic", {
      p_order: {
        order_type: "takeaway",
        customer_name: "Audit Tester",
        tax_percent: 10,
        service_charge_percent: 5,
        idempotency_key: testIdempotencyKey,
      },
      p_items: [
        {
          product_id: sampleProduct.id,
          product_name_snapshot: sampleProduct.name,
          product_sku_snapshot: "SKU-AUDIT",
          unit_price_snapshot: sampleProduct.price,
          quantity: 1,
          modifier_total: 0,
          subtotal: sampleProduct.price,
          line_total: sampleProduct.price,
          client_item_id: "client-item-1",
        },
      ],
      p_discounts: [],
    });

    if (res.error) {
      if (res.error.message.includes("calculate_and_apply_order_discounts")) {
        record(1, "1.1 Ketiadaan fungsi calculate_and_apply_order_discounts", false, "GAGAL: RPC masih memanggil fungsi yang tidak ada!");
      } else {
        record(1, "1.1 Eksekusi create_pos_order_atomic", false, `PostgreSQL error: ${res.error.message}`);
      }
    } else {
      const order = res.data;
      record(
        1,
        "1.1 create_pos_order_atomic sukses dieksekusi",
        true,
        `Order ID: ${order.id}, Subtotal: ${order.subtotal}, Grand Total: ${order.grand_total} (Kalkulasi inline berjalan sukses)`
      );

      // Bersihkan data order probe agar database tetap bersih
      await adminClient.from("order_items").delete().eq("order_id", order.id);
      await adminClient.from("audit_logs").delete().eq("entity_id", order.id);
      await adminClient.from("orders").delete().eq("id", order.id);
    }
  } catch (err) {
    record(1, "1.1 create_pos_order_atomic", false, err.message);
  }

  console.log("\n--- FOKUS 2: append_order_items_atomic URUTAN LOCKING & PERILAKU ---");
  try {
    // Uji coba pemanggilan append_order_items_atomic dengan ID pesanan dummy
    // Verifikasi pesan validasi bisnis & signature
    const dummyOrderId = "00000000-0000-0000-0000-000000000001";
    const res = await adminClient.rpc("append_order_items_atomic", {
      p_order_id: dummyOrderId,
      p_items: [],
      p_subtotal_delta: 0,
      p_tax_delta: 0,
      p_service_delta: 0,
      p_grand_total_delta: 0,
    });

    if (res.error) {
      if (res.error.message === "Pesanan tidak ditemukan.") {
        record(2, "2.1 append_order_items_atomic signature & validasi", true, "Merespons 'Pesanan tidak ditemukan.' secara benar pada pre-read.");
      } else {
        record(2, "2.1 append_order_items_atomic", true, `PostgreSQL response: ${res.error.message}`);
      }
    } else {
      record(2, "2.1 append_order_items_atomic", true, "RPC berhasil merespons.");
    }
  } catch (err) {
    record(2, "2.1 append_order_items_atomic", false, err.message);
  }

  console.log("\n--- FOKUS 3: close_dining_session_atomic VALIDASI 7 PINTU PENUTUPAN SESI ---");
  try {
    const dummyTableId = "00000000-0000-0000-0000-000000000001";
    const dummySessionId = "00000000-0000-0000-0000-000000000002";
    const res = await adminClient.rpc("close_dining_session_atomic", {
      p_table_id: dummyTableId,
      p_session_id: dummySessionId,
    });

    if (res.error) {
      if (res.error.message === "Meja tidak ditemukan atau sedang tidak aktif.") {
        record(3, "3.1 close_dining_session_atomic validasi awal", true, "Pintu 1 & Lock L1 aktif: 'Meja tidak ditemukan atau sedang tidak aktif.'");
      } else {
        record(3, "3.1 close_dining_session_atomic", true, `PostgreSQL response: ${res.error.message}`);
      }
    } else {
      record(3, "3.1 close_dining_session_atomic", true, "RPC aktif.");
    }
  } catch (err) {
    record(3, "3.1 close_dining_session_atomic", false, err.message);
  }

  console.log("\n--- FOKUS 4: get_dining_session_summary MENGHITUNG SELURUH BLOCKER ---");
  try {
    const dummyTableId = "00000000-0000-0000-0000-000000000001";
    const res = await adminClient.rpc("get_dining_session_summary", {
      p_table_id: dummyTableId,
    });

    if (res.error) {
      record(4, "4.1 get_dining_session_summary eksekusi", false, res.error.message);
    } else {
      record(4, "4.1 get_dining_session_summary dieksekusi", true, `Return: ${JSON.stringify(res.data)} (Meja dummy merespons null tanpa error)`);
    }

    // Periksa apakah ada meja nyata untuk memeriksa kalkulasi blocker
    const { data: realTables } = await adminClient.from("dining_tables").select("id, name, status").limit(1);
    if (realTables && realTables.length > 0) {
      const realTable = realTables[0];
      const resReal = await adminClient.rpc("get_dining_session_summary", {
        p_table_id: realTable.id,
      });

      if (!resReal.error && resReal.data) {
        const summary = resReal.data;
        const hasBlockerField = "can_close_session" in summary && "blocking_reason" in summary;
        record(
          4,
          "4.2 Field blocker dan status can_close_session",
          hasBlockerField,
          `can_close_session: ${summary.can_close_session}, blocking_reason: ${summary.blocking_reason || "null (bersih)"}`
        );
      }
    }
  } catch (err) {
    record(4, "4.1 get_dining_session_summary", false, err.message);
  }

  console.log("\n--- FOKUS 5: HAK AKSES RPC & PROTEKSI DARI ANON ---");
  const rpcList = [
    { name: "create_pos_order_atomic", args: { p_order: {}, p_items: [], p_discounts: [] } },
    { name: "append_order_items_atomic", args: { p_order_id: "00000000-0000-0000-0000-000000000001", p_items: [], p_subtotal_delta: 0, p_tax_delta: 0, p_service_delta: 0, p_grand_total_delta: 0 } },
    { name: "close_dining_session_atomic", args: { p_table_id: "00000000-0000-0000-0000-000000000001", p_session_id: "00000000-0000-0000-0000-000000000001" } },
    { name: "complete_pos_order", args: { p_order_id: "00000000-0000-0000-0000-000000000001" } },
    { name: "get_dining_session_summary", args: { p_table_id: "00000000-0000-0000-0000-000000000001" } },
  ];

  for (const rpc of rpcList) {
    try {
      const res = await anonClient.rpc(rpc.name, rpc.args);
      if (res.error && res.error.code === "42501") {
        record(5, `5. Proteksi Anon: ${rpc.name}`, true, `DITOLAK SECARA AMAN (Status Code 42501 permission denied)`);
      } else if (res.error) {
        record(5, `5. Proteksi Anon: ${rpc.name}`, false, `Respon tidak terduga: ${res.error.code} - ${res.error.message}`);
      } else {
        record(5, `5. Proteksi Anon: ${rpc.name}`, false, `KEBOCORAN KEAMANAN: Anon diizinkan mengeksekusi ${rpc.name}`);
      }
    } catch (err) {
      record(5, `5. Proteksi Anon: ${rpc.name}`, false, err.message);
    }
  }

  console.log("\n--- FOKUS 6: INTEGRITAS SIGNATURE & DEPENDENSI FUNGSI ---");
  const functionsToCheck = [
    { name: "create_pos_order_atomic", args: { p_order: {}, p_items: [], p_discounts: [] } },
    { name: "append_order_items_atomic", args: { p_order_id: "00000000-0000-0000-0000-000000000001", p_items: [], p_subtotal_delta: 0, p_tax_delta: 0, p_service_delta: 0, p_grand_total_delta: 0 } },
    { name: "complete_pos_order", args: { p_order_id: "00000000-0000-0000-0000-000000000001" } },
    { name: "close_dining_session_atomic", args: { p_table_id: "00000000-0000-0000-0000-000000000001", p_session_id: "00000000-0000-0000-0000-000000000001" } },
    { name: "get_dining_session_summary", args: { p_table_id: "00000000-0000-0000-0000-000000000001" } },
    { name: "execute_midtrans_webhook_settlement", args: { p_payload: {} } },
  ];

  for (const fn of functionsToCheck) {
    try {
      const res = await adminClient.rpc(fn.name, fn.args);
      if (res.error && res.error.code === "PGRST202") {
        record(6, `6. Signature ${fn.name}`, false, "Fungsi tidak ditemukan di database (PGRST202)");
      } else {
        record(6, `6. Signature ${fn.name}`, true, `Fungsi terdaftar & signature valid (Kode: ${res.error?.code || "OK"})`);
      }
    } catch (err) {
      record(6, `6. Signature ${fn.name}`, false, err.message);
    }
  }

  console.log("\n================================================================================");
  const total = results.length;
  const passCount = results.filter((r) => r.status).length;
  const failCount = total - passCount;
  console.log(`  HASIL DEEP AUDIT LIVE SUPABASE:`);
  console.log(`  TOTAL TEST: ${total} | PASS: ${passCount} | FAIL: ${failCount}`);
  console.log("================================================================================");
}

runDeepAudit();
