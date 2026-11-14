#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd(), true);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function checkPostgrestSchema() {
  const res = await fetch(`${url}/rest/v1/`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });

  if (!res.ok) {
    console.error("Failed to fetch OpenAPI spec:", res.status, res.statusText);
    return;
  }

  const spec = await res.json();
  console.log("=== POSTGREST OPENAPI SPEC INSPECTION ===");

  // 1. Check definitions for tables
  const tables = ["midtrans_transactions", "midtrans_webhook_events", "order_allocations", "payments"];
  for (const t of tables) {
    const def = spec.definitions?.[t];
    if (def) {
      console.log(`\nTable '${t}' properties:`, Object.keys(def.properties || {}));
    } else {
      console.log(`\nTable '${t}' NOT FOUND in definitions!`);
    }
  }

  // 2. Check paths (RPCs)
  console.log("\n=== RPC FUNCTIONS IN DATABASE ===");
  const paths = Object.keys(spec.paths || {});
  const rpcs = paths.filter((p) => p.startsWith("/rpc/"));
  console.log("Available RPC endpoints:", rpcs);
}

checkPostgrestSchema();
