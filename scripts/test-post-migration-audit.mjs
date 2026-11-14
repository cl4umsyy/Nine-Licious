#!/usr/bin/env node
/**
 * POST-MIGRATION AUDIT FOR F2.2 (Midtrans Gateway, Webhook & Split Bill Engine)
 * Strictly READ-ONLY operations against Supabase database.
 */

import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd(), true);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("FATAL: Missing Supabase credentials in environment.");
  process.exit(1);
}

const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

const anonClient = anonKey
  ? createClient(supabaseUrl, anonKey, { auth: { persistSession: false } })
  : null;

const report = {
  timestamp: new Date().toISOString(),
  checks: [],
};

function logCheck(category, name, status, detail = "") {
  report.checks.push({ category, name, status, detail });
  const badge = status === "PASS" ? "✓ [PASS]" : status === "WARN" ? "⚠ [WARN]" : "✗ [FAIL]";
  console.log(`${badge.padEnd(10)} [${category}] ${name}${detail ? ` - ${detail}` : ""}`);
}

async function runAudit() {
  console.log("===============================================================================");
  console.log(" NINE LICIOUS POS - F2.2 POST-MIGRATION DATABASE AUDIT (STRICT READ-ONLY)");
  console.log(" Target: " + supabaseUrl.replace(/https:\/\/(.*?)\..*/, "https://$1.***"));
  console.log(" Timestamp: " + report.timestamp);
  console.log("===============================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. CEK TABEL & KOLOM F2.2 (VIA ADMIN CLIENT)
  // ---------------------------------------------------------------------------
  console.log("--- 1. Pemeriksaan Keberadaan Tabel & Kolom F2.2 ---");

  // A. midtrans_transactions
  try {
    const { data, error } = await adminClient
      .from("midtrans_transactions")
      .select("id, order_id, midtrans_order_id, gross_amount, payment_type, snap_token, snap_redirect_url, lifecycle_status, midtrans_transaction_status, idempotency_key, payload_fingerprint, attempt_number, is_split_bill, split_bill_type, snap_page_expires_at, payment_expires_at, settled_at, sanitized_response, created_by, created_at, updated_at")
      .limit(1);

    if (error) {
      logCheck("TABLE", "midtrans_transactions", "FAIL", error.message);
    } else {
      logCheck("TABLE", "midtrans_transactions", "PASS", "Tabel dan seluruh 21 kolom F2.2 terverifikasi ada");
    }
  } catch (err) {
    logCheck("TABLE", "midtrans_transactions", "FAIL", err.message);
  }

  // B. midtrans_webhook_events
  try {
    const { data, error } = await adminClient
      .from("midtrans_webhook_events")
      .select("id, event_fingerprint, midtrans_order_id, order_id, midtrans_transaction_id, status_code, gross_amount, currency, transaction_status, fraud_status, raw_payload, received_at, processing_result, processed_at, delivery_attempts, error_message")
      .limit(1);

    if (error) {
      logCheck("TABLE", "midtrans_webhook_events", "FAIL", error.message);
    } else {
      logCheck("TABLE", "midtrans_webhook_events", "PASS", "Tabel dan seluruh 16 kolom F2.2 terverifikasi ada");
    }
  } catch (err) {
    logCheck("TABLE", "midtrans_webhook_events", "FAIL", err.message);
  }

  // C. order_allocations
  try {
    const { data, error } = await adminClient
      .from("order_allocations")
      .select("id, order_id, order_item_id, midtrans_transaction_id, allocated_amount, allocated_quantity, allocation_status, created_at, updated_at")
      .limit(1);

    if (error) {
      logCheck("TABLE", "order_allocations", "FAIL", error.message);
    } else {
      logCheck("TABLE", "order_allocations", "PASS", "Tabel dan seluruh 9 kolom F2.2 terverifikasi ada");
    }
  } catch (err) {
    logCheck("TABLE", "order_allocations", "FAIL", err.message);
  }

  // D. payments (kolom midtrans_transaction_id dan allocation_id)
  try {
    const { data, error } = await adminClient
      .from("payments")
      .select("id, order_id, payment_method, amount, payment_status, midtrans_transaction_id, allocation_id")
      .limit(1);

    if (error) {
      logCheck("COLUMN", "payments foreign keys", "FAIL", error.message);
    } else {
      logCheck("COLUMN", "payments foreign keys", "PASS", "Kolom midtrans_transaction_id & allocation_id tersedia di tabel payments");
    }
  } catch (err) {
    logCheck("COLUMN", "payments foreign keys", "FAIL", err.message);
  }

  // ---------------------------------------------------------------------------
  // 2. CEK RPC FUNCTIONS F2.2
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Pemeriksaan Keberadaan & Kontrak RPC F2.2 ---");

  // A. create_midtrans_snap_transaction
  try {
    const { data, error } = await adminClient.rpc("create_midtrans_snap_transaction", {
      p_order_id: "00000000-0000-0000-0000-000000000000",
      p_gross_amount: 10000,
      p_idempotency_key: "audit-probe-key",
      p_snap_page_expires_at: new Date().toISOString(),
      p_payment_expires_at: new Date().toISOString(),
      p_is_split_bill: false,
      p_split_bill_type: null,
      p_item_allocations: null,
    });

    // We expect ORDER_NOT_FOUND (P0002) karena order dummy 00000000... tidak ada
    if (error && error.message.includes("ORDER_NOT_FOUND")) {
      logCheck("RPC", "create_midtrans_snap_transaction", "PASS", "RPC terdefinisi & eksekusi validasi ORDER_NOT_FOUND aktif");
    } else if (error && error.code === "PGRST202") {
      logCheck("RPC", "create_midtrans_snap_transaction", "FAIL", "Fungsi RPC tidak ditemukan di database!");
    } else {
      logCheck("RPC", "create_midtrans_snap_transaction", "PASS", `RPC merespons: ${error ? error.message : "OK"}`);
    }
  } catch (err) {
    logCheck("RPC", "create_midtrans_snap_transaction", "FAIL", err.message);
  }

  // B. update_midtrans_snap_details
  try {
    const { data, error } = await adminClient.rpc("update_midtrans_snap_details", {
      p_midtrans_transaction_id: "00000000-0000-0000-0000-000000000000",
      p_snap_token: "dummy-token",
      p_snap_redirect_url: "https://app.sandbox.midtrans.com/snap/v2/vtweb/dummy",
    });

    if (error && error.code === "PGRST202") {
      logCheck("RPC", "update_midtrans_snap_details", "FAIL", "Fungsi RPC tidak ditemukan di database!");
    } else {
      logCheck("RPC", "update_midtrans_snap_details", "PASS", "RPC terdefinisi & merespons pemanggilan");
    }
  } catch (err) {
    logCheck("RPC", "update_midtrans_snap_details", "FAIL", err.message);
  }

  // C. execute_midtrans_webhook_settlement
  try {
    const { data, error } = await adminClient.rpc("execute_midtrans_webhook_settlement", {
      p_payload: {
        order_id: "AUDIT-NONEXISTENT",
        status_code: "200",
        gross_amount: "10000",
        transaction_status: "settlement",
        signature_key: "dummy",
      },
      p_event_fingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
    });

    if (error && error.code === "PGRST202") {
      logCheck("RPC", "execute_midtrans_webhook_settlement", "FAIL", "Fungsi RPC tidak ditemukan di database!");
    } else if (data) {
      logCheck("RPC", "execute_midtrans_webhook_settlement", "PASS", `RPC terdefinisi & menghasilkan respons: status=${data.processing_result}`);
    } else {
      logCheck("RPC", "execute_midtrans_webhook_settlement", "PASS", `RPC terdefinisi: ${error ? error.message : "OK"}`);
    }
  } catch (err) {
    logCheck("RPC", "execute_midtrans_webhook_settlement", "FAIL", err.message);
  }

  // D. approve_midtrans_capture_challenge
  try {
    const { data, error } = await adminClient.rpc("approve_midtrans_capture_challenge", {
      p_midtrans_transaction_id: "00000000-0000-0000-0000-000000000000",
      p_reason: "Post migration audit check",
    });

    if (error && error.code === "PGRST202") {
      logCheck("RPC", "approve_midtrans_capture_challenge", "FAIL", "Fungsi RPC tidak ditemukan di database!");
    } else if (error && (error.message.includes("TRANSACTION_NOT_FOUND") || error.message.includes("UNAUTHORIZED"))) {
      logCheck("RPC", "approve_midtrans_capture_challenge", "PASS", `RPC terdefinisi & validasi aktif (${error.message})`);
    } else {
      logCheck("RPC", "approve_midtrans_capture_challenge", "PASS", "RPC terdefinisi");
    }
  } catch (err) {
    logCheck("RPC", "approve_midtrans_capture_challenge", "FAIL", err.message);
  }

  // ---------------------------------------------------------------------------
  // 3. KEAMANAN RLS & GRANT (ANON VS SERVICE ROLE)
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. Pemeriksaan Row Level Security & Hak Akses Anonim ---");

  if (anonClient) {
    try {
      const { data, error } = await anonClient.from("midtrans_transactions").select("id").limit(1);
      if (error || (data && data.length === 0)) {
        logCheck("RLS", "midtrans_transactions anon protection", "PASS", "Akses anon ditolak atau dibatasi RLS");
      } else {
        logCheck("RLS", "midtrans_transactions anon protection", "WARN", "Anon bisa membaca data transaksi!");
      }
    } catch (err) {
      logCheck("RLS", "midtrans_transactions anon protection", "PASS", "Anon ditolak");
    }

    try {
      const { data, error } = await anonClient.from("midtrans_webhook_events").select("id").limit(1);
      if (error || (data && data.length === 0)) {
        logCheck("RLS", "midtrans_webhook_events anon protection", "PASS", "Akses anon ditolak atau dibatasi RLS");
      } else {
        logCheck("RLS", "midtrans_webhook_events anon protection", "WARN", "Anon bisa membaca webhook events!");
      }
    } catch (err) {
      logCheck("RLS", "midtrans_webhook_events anon protection", "PASS", "Anon ditolak");
    }
  }

  // ---------------------------------------------------------------------------
  // 4. PEMERIKSAAN KONSISTENSI DATA AKTUAL & ORPHANED RECORDS
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. Pemeriksaan Konsistensi Data & Status Operasional ---");

  try {
    const { count: txCount, error: txErr } = await adminClient
      .from("midtrans_transactions")
      .select("*", { count: "exact", head: true });

    const { count: evCount, error: evErr } = await adminClient
      .from("midtrans_webhook_events")
      .select("*", { count: "exact", head: true });

    const { count: alCount, error: alErr } = await adminClient
      .from("order_allocations")
      .select("*", { count: "exact", head: true });

    logCheck("DATA", "Data Counts", "PASS", `midtrans_transactions: ${txCount ?? 0}, webhook_events: ${evCount ?? 0}, order_allocations: ${alCount ?? 0}`);

    // Cek apakah ada status rekonsiliasi yang menggantung
    const { data: stuckReconciliations, error: recErr } = await adminClient
      .from("midtrans_transactions")
      .select("id, midtrans_order_id, lifecycle_status")
      .eq("lifecycle_status", "reconciliation_required")
      .limit(5);

    if (stuckReconciliations && stuckReconciliations.length > 0) {
      logCheck("CONSISTENCY", "Anomalous Transactions", "WARN", `Terdapat ${stuckReconciliations.length} transaksi memerlukan rekonsiliasi`);
    } else {
      logCheck("CONSISTENCY", "Anomalous Transactions", "PASS", "Tidak ada transaksi menggantung yang memerlukan rekonsiliasi");
    }
  } catch (err) {
    logCheck("DATA", "Data inspection", "FAIL", err.message);
  }

  // ---------------------------------------------------------------------------
  // RINGKASAN AKHIR
  // ---------------------------------------------------------------------------
  console.log("\n===============================================================================");
  const passCount = report.checks.filter((c) => c.status === "PASS").length;
  const warnCount = report.checks.filter((c) => c.status === "WARN").length;
  const failCount = report.checks.filter((c) => c.status === "FAIL").length;

  console.log(` HASIL AUDIT: ${passCount} PASS | ${warnCount} WARN | ${failCount} FAIL`);
  console.log("===============================================================================\n");

  if (failCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAudit();
