// @ts-check
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const setupEnvPath = resolve(process.cwd(), ".env.setup.local");
if (existsSync(setupEnvPath)) {
  try {
    process.loadEnvFile(setupEnvPath);
  } catch {}
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const midtransServerKey = process.env.MIDTRANS_SERVER_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error("Missing Supabase configuration");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);

async function inspectOrder() {
  const targetOrderNo = "ORD-20261121-0001";
  console.log(`\n============================================================`);
  console.log(` AUDIT ENTITAS UNTUK ORDER: ${targetOrderNo}`);
  console.log(`============================================================\n`);

  // 1. ORDER & ORDER ITEMS
  console.log(`--- [1] PUBLIC.ORDERS & ORDER_ITEMS ---`);
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("*")
    .eq("order_number", targetOrderNo)
    .maybeSingle();

  if (orderErr) {
    console.error("Order query error:", orderErr);
    return;
  }
  if (!order) {
    console.log("Order not found!");
    return;
  }

  const { data: orderItems, error: itemsErr } = await supabase
    .from("order_items")
    .select("id, product_name_snapshot, quantity, unit_price_snapshot, line_total, notes")
    .eq("order_id", order.id);

  if (itemsErr) console.error("Order items error:", itemsErr);

  console.log("Order Data:", {
    id: order.id,
    order_number: order.order_number,
    order_type: order.order_type,
    table_id: order.table_id,
    dining_session_id: order.dining_session_id,
    status: order.status,
    payment_status: order.payment_status,
    subtotal: order.subtotal,
    discount_total: order.discount_total,
    tax_total: order.tax_total,
    service_charge_total: order.service_charge_total,
    grand_total: order.grand_total,
    paid_total: order.paid_total,
    refunded_total: order.refunded_total,
    remaining_balance: order.grand_total - order.paid_total,
    is_finalized: order.is_finalized,
    queue_number: order.queue_number,
    kds_status: order.kds_status,
    served_at: order.served_at,
    created_at: order.created_at,
    updated_at: order.updated_at,
  });
  console.log("Order Items count:", orderItems?.length || 0);
  if (orderItems && orderItems.length > 0) {
    console.log("Items:", orderItems);
  }

  // 2. PUBLIC.PAYMENTS
  console.log(`\n--- [2] PUBLIC.PAYMENTS ---`);
  const { data: payments, error: payErr } = await supabase
    .from("payments")
    .select("*")
    .eq("order_id", order.id)
    .order("created_at", { ascending: true });
  if (payErr) console.error("Payment query error:", payErr);
  console.log("Payments count:", payments?.length || 0);
  if (payments && payments.length > 0) {
    console.log("Payment records:", payments);
  } else {
    console.log("No payment records found in public.payments.");
  }

  // 3. PUBLIC.MIDTRANS_TRANSACTIONS & WEBHOOK EVENTS
  console.log(`\n--- [3] PUBLIC.MIDTRANS_TRANSACTIONS & WEBHOOK EVENTS ---`);
  const { data: midtransTxs, error: mtxErr } = await supabase
    .from("midtrans_transactions")
    .select("*")
    .eq("order_id", order.id)
    .order("created_at", { ascending: true });
  if (mtxErr) console.error("Midtrans tx query error:", mtxErr);
  console.log("Midtrans transactions count:", midtransTxs?.length || 0);
  if (midtransTxs && midtransTxs.length > 0) {
    midtransTxs.forEach((tx, idx) => {
      console.log(`Transaction #${idx + 1}:`, {
        id: tx.id,
        midtrans_order_id: tx.midtrans_order_id,
        gross_amount: tx.gross_amount,
        payment_type: tx.payment_type,
        lifecycle_status: tx.lifecycle_status,
        midtrans_transaction_status: tx.midtrans_transaction_status,
        fraud_status: tx.fraud_status,
        snap_token: tx.snap_token ? "[TOKEN_PRESENT]" : "[NULL]",
        snap_redirect_url: tx.snap_redirect_url ? "[URL_PRESENT]" : "[NULL]",
        payment_expires_at: tx.payment_expires_at,
        settlement_time: tx.settlement_time,
        created_at: tx.created_at,
        updated_at: tx.updated_at,
      });
    });
  }

  const { data: webhookEvents, error: whErr } = await supabase
    .from("midtrans_webhook_events")
    .select("id, event_fingerprint, midtrans_order_id, transaction_id, raw_status, received_at, processed_at, processing_result, is_signature_verified, is_duplicate")
    .like("midtrans_order_id", `${targetOrderNo}%`)
    .order("received_at", { ascending: true });
  if (whErr) console.error("Webhook events query error:", whErr);
  console.log("Webhook events count:", webhookEvents?.length || 0);
  if (webhookEvents && webhookEvents.length > 0) {
    console.log("Webhook events:", webhookEvents);
  }

  // 4. MIDTRANS LIVE CORE API STATUS
  console.log(`\n--- [4] MIDTRANS SANDBOX LIVE API STATUS ---`);
  if (!midtransServerKey) {
    console.log("MIDTRANS_SERVER_KEY is not defined in environment.");
  } else {
    const checkedOrderIds = new Set();
    if (midtransTxs) {
      midtransTxs.forEach((t) => checkedOrderIds.add(t.midtrans_order_id));
    }
    checkedOrderIds.add(`${targetOrderNo}-A1`);
    checkedOrderIds.add(targetOrderNo);

    for (const mOrderId of checkedOrderIds) {
      try {
        const authHeader = "Basic " + Buffer.from(`${midtransServerKey}:`).toString("base64");
        const resp = await fetch(
          `https://api.sandbox.midtrans.com/v2/${mOrderId}/status`,
          {
            headers: {
              Accept: "application/json",
              Authorization: authHeader,
            },
          }
        );
        const data = await resp.json();
        console.log(`Gateway Live Status for [${mOrderId}]:`, {
          status_code: data.status_code,
          transaction_id: data.transaction_id,
          transaction_status: data.transaction_status,
          fraud_status: data.fraud_status,
          payment_type: data.payment_type,
          gross_amount: data.gross_amount,
          transaction_time: data.transaction_time,
          settlement_time: data.settlement_time,
          status_message: data.status_message,
          va_numbers: data.va_numbers,
        });
      } catch (e) {
        console.error(`Failed to fetch Midtrans status for ${mOrderId}:`, e?.message || e);
      }
    }
  }

  // 5. STOCK RESERVATIONS (PUBLIC.INGREDIENT_RESERVATIONS)
  console.log(`\n--- [5] PUBLIC.INGREDIENT_RESERVATIONS ---`);
  const { data: reservations, error: resErr } = await supabase
    .from("ingredient_reservations")
    .select(`
      id,
      order_id,
      ingredient_id,
      quantity_reserved,
      status,
      created_at,
      updated_at,
      ingredients (name, unit, current_stock)
    `)
    .eq("order_id", order.id);
  if (resErr) console.error("Reservation query error:", resErr);
  console.log("Reservations count:", reservations?.length || 0);
  if (reservations && reservations.length > 0) {
    console.log("Stock Reservations:", JSON.stringify(reservations, null, 2));
  } else {
    console.log("No stock reservations found for this order.");
  }

  // 6. STOCK MOVEMENTS (PUBLIC.STOCK_MOVEMENTS)
  console.log(`\n--- [6] PUBLIC.STOCK_MOVEMENTS ---`);
  const { data: movements, error: movErr } = await supabase
    .from("stock_movements")
    .select(`
      id,
      ingredient_id,
      movement_type,
      quantity_delta,
      stock_before,
      stock_after,
      order_id,
      reason,
      idempotency_key,
      created_at,
      ingredients (name, unit)
    `)
    .eq("order_id", order.id);
  if (movErr) console.error("Stock movements query error:", movErr);
  console.log("Stock movements count for order:", movements?.length || 0);
  if (movements && movements.length > 0) {
    console.log("Stock Movements:", JSON.stringify(movements, null, 2));
  } else {
    console.log("No stock movements recorded yet for this order.");
  }

  // 7. QUEUE NUMBER & KDS STATUS
  console.log(`\n--- [7] QUEUE NUMBER & KDS STATUS ---`);
  console.log("Queue Number:", order.queue_number ?? "NULL (Belum digenerate)");
  console.log("KDS Status:", order.kds_status ?? "NULL (Belum masuk antrean KDS)");

  // 8. REFUNDS (PUBLIC.REFUNDS)
  console.log(`\n--- [8] PUBLIC.REFUNDS ---`);
  const { data: refunds, error: refErr } = await supabase
    .from("refunds")
    .select("*")
    .eq("order_id", order.id);
  if (refErr) console.error("Refund query error:", refErr);
  console.log("Refunds count for order:", refunds?.length || 0);
  if (refunds && refunds.length > 0) {
    console.log("Refund records:", refunds);
  } else {
    console.log("No refund records found for this order.");
  }

  // 9. AUDIT LOGS (PUBLIC.AUDIT_LOGS)
  console.log(`\n--- [9] PUBLIC.AUDIT_LOGS ---`);
  const { data: logs, error: logErr } = await supabase
    .from("audit_logs")
    .select("action, entity, entity_id, username, details, created_at")
    .or(`entity_id.eq.${order.id},details->>order_number.eq.${targetOrderNo},details->>order_id.eq.${order.id}`)
    .order("created_at", { ascending: true });
  if (logErr) console.error("Audit log query error:", logErr);
  console.log("Audit logs count:", logs?.length || 0);
  if (logs && logs.length > 0) {
    console.log("Audit logs:", JSON.stringify(logs, null, 2));
  }
}

inspectOrder();
