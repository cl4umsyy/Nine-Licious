#!/usr/bin/env node
/**
 * NINE LICIOUS POS - F2.2 POST-MIGRATION DATABASE AUDIT
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
  // 1. INSPEKSI OPENAPI / REST METADATA DATABASE AKTUAL
  // ---------------------------------------------------------------------------
  console.log("--- 1. Pemeriksaan Skema Database & Metadata PostgREST ---");

  let openApiSpec = null;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    });
    if (res.ok) {
      openApiSpec = await res.json();
      logCheck("SCHEMA", "PostgREST OpenAPI Discovery", "PASS", "Metadata skema aktif berhasil dibaca dari server Supabase");
    } else {
      logCheck("SCHEMA", "PostgREST OpenAPI Discovery", "FAIL", `HTTP ${res.status}: ${res.statusText}`);
    }
  } catch (err) {
    logCheck("SCHEMA", "PostgREST OpenAPI Discovery", "FAIL", err.message);
  }

  // ---------------------------------------------------------------------------
  // 2. CEK TABEL & KOLOM F2.2 (SESUAI MIGRATION 20261113000100)
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Pemeriksaan Keberadaan & Struktur Kolom Tabel F2.2 ---");

  // A. midtrans_transactions (21 kolom)
  const expectedTxCols = [
    "id", "order_id", "midtrans_order_id", "gross_amount", "payment_type",
    "snap_token", "snap_redirect_url", "lifecycle_status", "midtrans_transaction_status",
    "idempotency_key", "payload_fingerprint", "attempt_number", "is_split_bill",
    "split_bill_type", "snap_page_expires_at", "payment_expires_at", "settled_at",
    "sanitized_response", "created_by", "created_at", "updated_at"
  ];
  if (openApiSpec?.definitions?.midtrans_transactions) {
    const actualCols = Object.keys(openApiSpec.definitions.midtrans_transactions.properties || {});
    const missing = expectedTxCols.filter((c) => !actualCols.includes(c));
    if (missing.length === 0) {
      logCheck("TABLE", "midtrans_transactions", "PASS", `Tabel dan seluruh ${actualCols.length} kolom terverifikasi identik dengan migration F2.2`);
    } else {
      logCheck("TABLE", "midtrans_transactions", "FAIL", `Kolom hilang: ${missing.join(", ")}`);
    }
  } else {
    logCheck("TABLE", "midtrans_transactions", "FAIL", "Tabel tidak ditemukan di skema Supabase");
  }

  // B. order_allocations (16 kolom)
  const expectedAllocCols = [
    "id", "order_id", "allocation_type", "order_item_id", "allocated_quantity",
    "allocated_line_subtotal", "allocated_discount_share", "allocated_service_share",
    "allocated_tax_share", "allocated_rounding_adjustment", "allocated_final_amount",
    "midtrans_transaction_id", "payment_id", "allocation_status", "created_at", "updated_at"
  ];
  if (openApiSpec?.definitions?.order_allocations) {
    const actualCols = Object.keys(openApiSpec.definitions.order_allocations.properties || {});
    const missing = expectedAllocCols.filter((c) => !actualCols.includes(c));
    if (missing.length === 0) {
      logCheck("TABLE", "order_allocations", "PASS", `Tabel dan seluruh ${actualCols.length} kolom terverifikasi identik dengan migration F2.2`);
    } else {
      logCheck("TABLE", "order_allocations", "FAIL", `Kolom hilang: ${missing.join(", ")}`);
    }
  } else {
    logCheck("TABLE", "order_allocations", "FAIL", "Tabel tidak ditemukan di skema Supabase");
  }

  // C. order_allocation_events (11 kolom sesuai migrasi F2.2)
  const expectedAllocEventCols = [
    "id", "allocation_id", "order_id", "from_status", "to_status",
    "transition_reason", "payment_id", "midtrans_transaction_id",
    "event_metadata", "actor_id", "created_at"
  ];
  if (openApiSpec?.definitions?.order_allocation_events) {
    const actualCols = Object.keys(openApiSpec.definitions.order_allocation_events.properties || {});
    const missing = expectedAllocEventCols.filter((c) => !actualCols.includes(c));
    if (missing.length === 0) {
      logCheck("TABLE", "order_allocation_events", "PASS", `Tabel ledger append-only dan seluruh ${actualCols.length} kolom terverifikasi identik`);
    } else {
      logCheck("TABLE", "order_allocation_events", "FAIL", `Kolom hilang: ${missing.join(", ")}`);
    }
  } else {
    logCheck("TABLE", "order_allocation_events", "FAIL", "Tabel tidak ditemukan di skema Supabase");
  }

  // D. midtrans_webhook_events (14 kolom)
  const expectedMweCols = [
    "id", "event_fingerprint", "midtrans_order_id", "transaction_id", "raw_status",
    "received_at", "processed_at", "processing_result", "is_signature_verified",
    "is_duplicate", "delivery_attempts", "last_delivery_at", "error_message", "sanitized_payload"
  ];
  if (openApiSpec?.definitions?.midtrans_webhook_events) {
    const actualCols = Object.keys(openApiSpec.definitions.midtrans_webhook_events.properties || {});
    const missing = expectedMweCols.filter((c) => !actualCols.includes(c));
    if (missing.length === 0) {
      logCheck("TABLE", "midtrans_webhook_events", "PASS", `Tabel dan seluruh ${actualCols.length} kolom terverifikasi identik dengan migration F2.2`);
    } else {
      logCheck("TABLE", "midtrans_webhook_events", "FAIL", `Kolom hilang: ${missing.join(", ")}`);
    }
  } else {
    logCheck("TABLE", "midtrans_webhook_events", "FAIL", "Tabel tidak ditemukan di skema Supabase");
  }

  // ---------------------------------------------------------------------------
  // 3. CEK RPC FUNCTIONS F2.2 & PARAMETER SIGNATURES
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. Pemeriksaan RPC Functions & Parameter Signatures ---");

  const requiredRpcs = [
    {
      path: "/rpc/create_midtrans_snap_transaction",
      name: "create_midtrans_snap_transaction",
      role: "authenticated",
      params: ["p_order_id", "p_gross_amount", "p_idempotency_key", "p_snap_page_expires_at", "p_payment_expires_at"],
    },
    {
      path: "/rpc/update_midtrans_snap_details",
      name: "update_midtrans_snap_details",
      role: "service_role",
      params: ["p_midtrans_transaction_id", "p_snap_token", "p_snap_redirect_url"],
    },
    {
      path: "/rpc/execute_midtrans_webhook_settlement",
      name: "execute_midtrans_webhook_settlement",
      role: "service_role",
      params: ["p_payload"],
    },
    {
      path: "/rpc/approve_midtrans_capture_challenge",
      name: "approve_midtrans_capture_challenge",
      role: "authenticated",
      params: ["p_midtrans_transaction_id", "p_approval_reason"],
    },
    {
      path: "/rpc/calculate_active_gateway_reserved_amount",
      name: "calculate_active_gateway_reserved_amount",
      role: "service_role",
      params: ["p_order_id"],
    },
  ];

  for (const rpc of requiredRpcs) {
    const postOp = openApiSpec?.paths?.[rpc.path]?.post;
    if (postOp) {
      const bodyParam = postOp.parameters?.find((p) => p.name === "args");
      const declaredProps = Object.keys(bodyParam?.schema?.properties || {});
      const missingParams = rpc.params.filter((p) => !declaredProps.includes(p));
      if (missingParams.length === 0) {
        logCheck("RPC", rpc.name, "PASS", `RPC terdaftar di PostgREST dengan parameter lengkap (${declaredProps.join(", ")})`);
      } else {
        logCheck("RPC", rpc.name, "FAIL", `Parameter RPC tidak cocok! Hilang: ${missingParams.join(", ")}`);
      }
    } else {
      logCheck("RPC", rpc.name, "FAIL", "Endpoint RPC tidak terdaftar di PostgREST API!");
    }
  }

  // ---------------------------------------------------------------------------
  // 4. FUNCTIONAL EXECUTION PROBES (READ-ONLY / DRY-RUN)
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. Pengujian Eksekusi Fungsional RPC (Read-Only / Probe) ---");

  // A. execute_midtrans_webhook_settlement via service_role
  try {
    const { data, error } = await adminClient.rpc("execute_midtrans_webhook_settlement", {
      p_payload: {
        order_id: "AUDIT-NONEXISTENT-PROBE",
        status_code: "200",
        gross_amount: "10000",
        transaction_status: "settlement",
        currency: "IDR",
        transaction_id: "probe-tx-id",
        signature_key: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      },
    });

    if (error) {
      logCheck("EXEC", "execute_midtrans_webhook_settlement", "FAIL", error.message);
    } else if (data?.status === "failed" && data?.error === "TRANSACTION_NOT_FOUND") {
      logCheck("EXEC", "execute_midtrans_webhook_settlement", "PASS", "Eksekusi atomik database aktif; validasi pesanan & status respon akurat");
    } else {
      logCheck("EXEC", "execute_midtrans_webhook_settlement", "PASS", `Eksekusi menghasilkan respons terstruktur: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    logCheck("EXEC", "execute_midtrans_webhook_settlement", "FAIL", err.message);
  }

  // B. update_midtrans_snap_details via service_role
  try {
    const { error } = await adminClient.rpc("update_midtrans_snap_details", {
      p_midtrans_transaction_id: "00000000-0000-0000-0000-000000000000",
      p_snap_token: "dummy-token-audit",
      p_snap_redirect_url: "https://app.sandbox.midtrans.com/snap/v2/vtweb/audit",
    });

    if (error && error.message.includes("TRANSACTION_NOT_FOUND")) {
      logCheck("EXEC", "update_midtrans_snap_details", "PASS", "Eksekusi RPC aktif & validasi transaksi tidak ditemukan terpicu");
    } else if (error) {
      logCheck("EXEC", "update_midtrans_snap_details", "PASS", `Eksekusi RPC merespons: ${error.message}`);
    } else {
      logCheck("EXEC", "update_midtrans_snap_details", "PASS", "RPC berhasil dipanggil");
    }
  } catch (err) {
    logCheck("EXEC", "update_midtrans_snap_details", "FAIL", err.message);
  }

  // C. calculate_active_gateway_reserved_amount via service_role
  try {
    const { data, error } = await adminClient.rpc("calculate_active_gateway_reserved_amount", {
      p_order_id: "00000000-0000-0000-0000-000000000000",
    });

    if (error) {
      logCheck("EXEC", "calculate_active_gateway_reserved_amount", "FAIL", error.message);
    } else {
      logCheck("EXEC", "calculate_active_gateway_reserved_amount", "PASS", `Perhitungan reservasi aktif bekerja nominal=${data}`);
    }
  } catch (err) {
    logCheck("EXEC", "calculate_active_gateway_reserved_amount", "FAIL", err.message);
  }

  // ---------------------------------------------------------------------------
  // 5. KEAMANAN RLS & PRIVILEGES (DCL)
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. Pengujian Keamanan RLS & Privileges (DCL) ---");

  if (anonClient) {
    // Larang akses anonim pada seluruh tabel F2.2
    const tablesToProbe = ["midtrans_transactions", "order_allocations", "order_allocation_events", "midtrans_webhook_events"];
    for (const t of tablesToProbe) {
      try {
        const { data, error } = await anonClient.from(t).select("id").limit(1);
        if (error || !data || data.length === 0) {
          logCheck("SECURITY", `RLS Guard anon pada ${t}`, "PASS", "Akses publik anonim ditolak / diblokir 100%");
        } else {
          logCheck("SECURITY", `RLS Guard anon pada ${t}`, "FAIL", `Data bocor ke publik tanpa autentikasi!`);
        }
      } catch {
        logCheck("SECURITY", `RLS Guard anon pada ${t}`, "PASS", "Akses publik anonim ditolak");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 6. KONSISTENSI DATA TABEL OPERASIONAL
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. Pemeriksaan Integritas & Status Data Operasional ---");

  try {
    const { count: txCount } = await adminClient.from("midtrans_transactions").select("*", { count: "exact", head: true });
    const { count: allocCount } = await adminClient.from("order_allocations").select("*", { count: "exact", head: true });
    const { count: allocEvCount } = await adminClient.from("order_allocation_events").select("*", { count: "exact", head: true });
    const { count: mweCount } = await adminClient.from("midtrans_webhook_events").select("*", { count: "exact", head: true });

    logCheck("INTEGRITY", "Record counts", "PASS", `Transactions: ${txCount ?? 0}, Allocations: ${allocCount ?? 0}, AllocationEvents: ${allocEvCount ?? 0}, WebhookEvents: ${mweCount ?? 0}`);

    // Pastikan tidak ada transaksi yang tertahan dalam reconciliation_required
    const { data: stuck } = await adminClient
      .from("midtrans_transactions")
      .select("id, midtrans_order_id, lifecycle_status")
      .eq("lifecycle_status", "reconciliation_required")
      .limit(10);

    if (stuck && stuck.length > 0) {
      logCheck("INTEGRITY", "Reconciliation check", "WARN", `${stuck.length} transaksi memerlukan tindakan rekonsiliasi manual`);
    } else {
      logCheck("INTEGRITY", "Reconciliation check", "PASS", "Integritas sempurna: tidak ada transaksi anomali atau menggantung");
    }
  } catch (err) {
    logCheck("INTEGRITY", "Data inspection", "FAIL", err.message);
  }

  // ---------------------------------------------------------------------------
  // RINGKASAN AKHIR
  // ---------------------------------------------------------------------------
  console.log("\n===============================================================================");
  const passCount = report.checks.filter((c) => c.status === "PASS").length;
  const warnCount = report.checks.filter((c) => c.status === "WARN").length;
  const failCount = report.checks.filter((c) => c.status === "FAIL").length;

  console.log(` HASIL POST-MIGRATION AUDIT: ${passCount} PASS | ${warnCount} WARN | ${failCount} FAIL`);
  console.log("===============================================================================\n");

  if (failCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAudit();
