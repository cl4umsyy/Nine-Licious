#!/usr/bin/env node
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd(), true);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function inspectSchema() {
  console.log("=== INSPECTING ACTUAL SUPABASE SCHEMA ===");

  // Cek kolom yang ada di midtrans_webhook_events dengan query satu persatu atau SELECT *
  try {
    const { data, error } = await supabase.from("midtrans_webhook_events").select("*").limit(0);
    console.log("midtrans_webhook_events select * result:", { data, error });
  } catch (err) {
    console.log("midtrans_webhook_events err:", err.message);
  }

  // Cek order_allocations select *
  try {
    const { data, error } = await supabase.from("order_allocations").select("*").limit(0);
    console.log("order_allocations select * result:", { data, error });
  } catch (err) {
    console.log("order_allocations err:", err.message);
  }

  // Cek payments select *
  try {
    const { data, error } = await supabase.from("payments").select("*").limit(0);
    console.log("payments select * result:", { data, error });
  } catch (err) {
    console.log("payments err:", err.message);
  }

  // Cek migration history table supabase_migrations
  try {
    const { data, error } = await supabase.from("supabase_migrations.schema_migrations").select("*");
    console.log("schema_migrations (direct):", { data, error });
  } catch (err) {
    console.log("schema_migrations err:", err.message);
  }
}

inspectSchema();
