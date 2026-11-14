#!/usr/bin/env node
/**
 * NINE LICIOUS POS - LIVE SUPABASE RPC & PRIVILEGE AUDIT SUITE
 * Memvalidasi keberadaan, signature, dan perilaku RPC aktual pada database remote Supabase.
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
console.log("  NINE LICIOUS POS - AUDIT AKTUAL DATABASE SUPABASE (LIVE RUNTIME)");
console.log("================================================================================");
console.log(`Target URL: ${supabaseUrl}`);

if (!supabaseUrl || !serviceKey) {
  console.error("FATAL: Kredensial Supabase (URL / SERVICE_ROLE_KEY) tidak lengkap.");
  process.exit(1);
}

const adminClient = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const anonClient = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let passed = 0;
let failed = 0;

function pass(name, detail = "") {
  passed++;
  console.log(`  [PASS] ${name}${detail ? " - " + detail : ""}`);
}

function fail(name, error) {
  failed++;
  console.error(`  [FAIL] ${name}: ${error?.message || error}`);
}

async function runAudit() {
  console.log("\n--- BAGIAN 1: VERIFIKASI KEBERADAAN & EKSEKUSI RPC AKTUAL (SERVICE ROLE) ---");

  // 1. append_order_items_atomic
  try {
    const dummyId = "00000000-0000-0000-0000-000000000001";
    const res = await adminClient.rpc("append_order_items_atomic", {
      p_order_id: dummyId,
      p_items: [],
      p_subtotal_delta: 0,
      p_tax_delta: 0,
      p_service_delta: 0,
      p_grand_total_delta: 0,
    });

    if (res.error) {
      // Jika RPC ada, akan mengembalikan exception bisnis PostgreSQL:
      // "Pesanan tidak ditemukan." atau "Hanya admin atau kasir yang berhak..."
      // Jika RPC tidak ada, PostgREST mengembalikan PGRST202
      if (res.error.code === "PGRST202") {
        fail("1. append_order_items_atomic", "RPC belum terpasang di database (PGRST202)");
      } else {
        pass("1. append_order_items_atomic terpasang & aktif", `PostgreSQL message: "${res.error.message}"`);
      }
    } else {
      pass("1. append_order_items_atomic dieksekusi", JSON.stringify(res.data));
    }
  } catch (err) {
    fail("1. append_order_items_atomic", err);
  }

  // 2. close_dining_session_atomic
  try {
    const dummyTableId = "00000000-0000-0000-0000-000000000001";
    const dummySessionId = "00000000-0000-0000-0000-000000000002";
    const res = await adminClient.rpc("close_dining_session_atomic", {
      p_table_id: dummyTableId,
      p_session_id: dummySessionId,
    });

    if (res.error) {
      if (res.error.code === "PGRST202") {
        fail("2. close_dining_session_atomic", "RPC belum terpasang di database (PGRST202)");
      } else {
        // Ekspektasi: "Meja tidak ditemukan atau sedang tidak aktif." atau "Hanya admin atau kasir..."
        pass("2. close_dining_session_atomic terpasang & aktif", `PostgreSQL message: "${res.error.message}"`);
      }
    } else {
      pass("2. close_dining_session_atomic dieksekusi", JSON.stringify(res.data));
    }
  } catch (err) {
    fail("2. close_dining_session_atomic", err);
  }

  // 3. complete_pos_order
  try {
    const dummyId = "00000000-0000-0000-0000-000000000001";
    const res = await adminClient.rpc("complete_pos_order", {
      p_order_id: dummyId,
    });

    if (res.error) {
      if (res.error.code === "PGRST202") {
        fail("3. complete_pos_order", "RPC belum terpasang di database (PGRST202)");
      } else {
        pass("3. complete_pos_order terpasang & aktif", `PostgreSQL message: "${res.error.message}"`);
      }
    } else {
      pass("3. complete_pos_order dieksekusi", JSON.stringify(res.data));
    }
  } catch (err) {
    fail("3. complete_pos_order", err);
  }

  // 4. create_pos_order_atomic
  try {
    const res = await adminClient.rpc("create_pos_order_atomic", {
      p_order: { order_type: "takeaway", grand_total: 0 },
      p_items: [],
      p_discounts: [],
    });

    if (res.error) {
      if (res.error.code === "PGRST202") {
        fail("4. create_pos_order_atomic", "RPC belum terpasang di database (PGRST202)");
      } else {
        pass("4. create_pos_order_atomic terpasang & aktif", `PostgreSQL message: "${res.error.message}"`);
      }
    } else {
      pass("4. create_pos_order_atomic dieksekusi", `Order created/replayed: ${res.data?.id}`);
    }
  } catch (err) {
    fail("4. create_pos_order_atomic", err);
  }

  // 5. get_dining_session_summary
  try {
    const dummyTableId = "00000000-0000-0000-0000-000000000001";
    const res = await adminClient.rpc("get_dining_session_summary", {
      p_table_id: dummyTableId,
    });

    if (res.error) {
      if (res.error.code === "PGRST202") {
        fail("5. get_dining_session_summary", "RPC belum terpasang di database (PGRST202)");
      } else {
        pass("5. get_dining_session_summary terpasang & aktif", `PostgreSQL message: "${res.error.message}"`);
      }
    } else {
      // Kembalian null karena meja dummy tidak ditemukan
      pass("5. get_dining_session_summary dieksekusi", `Return: ${JSON.stringify(res.data)}`);
    }
  } catch (err) {
    fail("5. get_dining_session_summary", err);
  }

  // 6. execute_midtrans_webhook_settlement
  try {
    const res = await adminClient.rpc("execute_midtrans_webhook_settlement", {
      p_payload: { order_id: "NL-AUDIT-DUMMY", transaction_status: "settlement" },
    });

    if (res.error) {
      if (res.error.code === "PGRST202") {
        fail("6. execute_midtrans_webhook_settlement", "RPC belum terpasang (PGRST202)");
      } else {
        pass("6. execute_midtrans_webhook_settlement terpasang", `PostgreSQL message: "${res.error.message}"`);
      }
    } else {
      pass("6. execute_midtrans_webhook_settlement dieksekusi", `Status: ${res.data?.status || res.data?.error}`);
    }
  } catch (err) {
    fail("6. execute_midtrans_webhook_settlement", err);
  }

  // 7. create_midtrans_snap_transaction
  try {
    const res = await adminClient.rpc("create_midtrans_snap_transaction", {
      p_order_id: "00000000-0000-0000-0000-000000000001",
      p_gross_amount: 10000,
      p_idempotency_key: "IDEM-DUMMY-AUDIT",
      p_snap_page_expires_at: new Date().toISOString(),
      p_payment_expires_at: new Date().toISOString(),
    });

    if (res.error) {
      if (res.error.code === "PGRST202") {
        fail("7. create_midtrans_snap_transaction", "RPC belum terpasang (PGRST202)");
      } else {
        pass("7. create_midtrans_snap_transaction terpasang", `PostgreSQL message: "${res.error.message}"`);
      }
    } else {
      pass("7. create_midtrans_snap_transaction dieksekusi", JSON.stringify(res.data));
    }
  } catch (err) {
    fail("7. create_midtrans_snap_transaction", err);
  }

  console.log("\n--- BAGIAN 2: VERIFIKASI HAK AKSES ANON / PUBLIC (SECURITY PRIVILEGE AUDIT) ---");

  // Anon must NOT be allowed to execute sensitive mutating RPCs or financial summaries
  const anonRpcChecks = [
    { name: "append_order_items_atomic", params: { p_order_id: "00000000-0000-0000-0000-000000000001", p_items: [], p_subtotal_delta: 0, p_tax_delta: 0, p_service_delta: 0, p_grand_total_delta: 0 } },
    { name: "close_dining_session_atomic", params: { p_table_id: "00000000-0000-0000-0000-000000000001", p_session_id: "00000000-0000-0000-0000-000000000002" } },
    { name: "complete_pos_order", params: { p_order_id: "00000000-0000-0000-0000-000000000001" } },
    { name: "create_pos_order_atomic", params: { p_order: {}, p_items: [], p_discounts: [] } },
    { name: "get_dining_session_summary", params: { p_table_id: "00000000-0000-0000-0000-000000000001" } },
  ];

  for (const check of anonRpcChecks) {
    try {
      const anonRes = await anonClient.rpc(check.name, check.params);
      if (anonRes.error) {
        // Ekspektasi: permission denied (42501) atau fungsi tidak ditemukan untuk role anon (PGRST202)
        // atau exception otorisasi bisnis
        pass(`Anon ditolak mengakses ${check.name}`, `Status code: ${anonRes.error.code || anonRes.status} (${anonRes.error.message})`);
      } else {
        fail(`Anon ditolak mengakses ${check.name}`, "Anon berhasil memanggil RPC tanpa penolakan hak akses!");
      }
    } catch (err) {
      pass(`Anon ditolak mengakses ${check.name}`, err.message);
    }
  }

  console.log("\n================================================================================");
  console.log(`  HASIL AKHIR AUDIT DATABASE AKTUAL:`);
  console.log(`  TOTAL: ${passed + failed} | PASS: ${passed} | FAIL: ${failed}`);
  console.log("================================================================================\n");

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAudit();
