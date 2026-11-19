import pkg from "@next/env";
import { createClient } from "@supabase/supabase-js";

const { loadEnvConfig } = pkg;
loadEnvConfig(process.cwd(), true);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function checkOrders() {
  const { data: orders, count, error } = await supabase
    .from("orders")
    .select("id, order_number, status, payment_status, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("Error query orders:", error.message);
  } else {
    console.log("Total orders di DB:", count);
    console.log("Daftar pesanan:", orders);
  }
}

checkOrders().catch(console.error);
