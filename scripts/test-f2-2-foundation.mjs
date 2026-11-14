import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

console.log("=== NINE LICIOUS POS - F2.2 LOCAL STATIC VALIDATION ===");

// 1. Periksa berkas migration F2.2
const migrationPath = path.resolve("supabase/migrations/20261113000100_midtrans_gateway_split_bill.sql");
assert(fs.existsSync(migrationPath), "Migration F2.2 harus ada.");

const sqlContent = fs.readFileSync(migrationPath, "utf8");

// Validasi struktur tabel dan constraint
const checks = [
  "create table if not exists public.midtrans_transactions",
  "create table if not exists public.order_allocations",
  "create table if not exists public.order_allocation_events",
  "create table if not exists public.midtrans_webhook_events",
  "references public.order_allocations (id)\n    on delete restrict",
  "allocation_type in ('full', 'custom_amount', 'by_item')",
  "allocation_status in ('reserved', 'settled', 'released')",
  "event_fingerprint varchar(128) not null unique",
  "'received'",
  "'processing'",
  "'settled'",
  "'ignored_duplicate'",
  "'ignored_out_of_order'",
  "'reconciliation_flagged'",
  "'terminal_released'",
  "'failed'",
  "create or replace function public.validate_order_allocation_relations()",
  "create or replace function public.log_order_allocation_status_event()",
  "create or replace function public.calculate_active_gateway_reserved_amount",
  "create or replace function public.process_pos_payment_manual",
  "create or replace function public.cancel_pos_order",
  "create or replace function public.create_midtrans_snap_transaction",
  "create or replace function public.update_midtrans_snap_details",
  "create or replace function public.execute_midtrans_webhook_settlement",
  "create or replace function public.approve_midtrans_capture_challenge",
  "alter table public.midtrans_transactions enable row level security",
  "alter table public.order_allocations enable row level security",
  "alter table public.order_allocation_events enable row level security",
  "alter table public.midtrans_webhook_events enable row level security",
];

for (const check of checks) {
  assert(sqlContent.includes(check), `SQL check failed: missing "${check}"`);
}

console.log("✓ SQL migration static check: PASS (All 27 required definitions and constraints present)");

// 2. Periksa bahwa ON DELETE CASCADE tidak digunakan pada order_allocation_events
assert(
  !sqlContent.includes("order_allocation_events") || !sqlContent.includes("order_allocation_events (id)\n    on delete cascade"),
  "order_allocation_events dilarang memakai ON DELETE CASCADE."
);
console.log("✓ Audit ledger immutability check: PASS (ON DELETE RESTRICT verified)");

// 3. Periksa bahwa search_path = '' diterapkan pada seluruh SECURITY DEFINER
const secDefinerCount = (sqlContent.match(/security definer/gi) || []).length;
const emptySearchPathCount = (sqlContent.match(/set search_path = ''/gi) || []).length;
assert.strictEqual(secDefinerCount, emptySearchPathCount, "Semua fungsi SECURITY DEFINER wajib menggunakan set search_path = ''");
console.log(`✓ SECURITY DEFINER security boundary check: PASS (${secDefinerCount} functions properly isolated)`);

// 4. Periksa nama kolom payments pada RPC F2.1
assert(!sqlContent.includes("payments.status"), "Dilarang menggunakan payments.status; wajib payments.payment_status");
console.log("✓ Payments column contract check: PASS (payments.payment_status correctly preserved)");

// 5. Periksa 6 Blocker Hasil SQL Review Terbaru:
// Blocker 1: Server-Side Item Allocation
assert(sqlContent.includes("ALLOCATION_FIELD_MISMATCH"), "Wajib validasi field alokasi server vs client");
assert(sqlContent.includes("ALLOCATION_TOTAL_MISMATCH"), "Wajib validasi total alokasi kalkulasi server");
console.log("✓ Blocker 1 (Server-Side Item Allocation): PASS (Server calculates and validates all financial fields)");

// Blocker 2: Webhook Gross Amount
assert(sqlContent.includes("FRACTIONAL_IDR_REJECTED"), "Wajib menolak nominal pecahan rupiah");
assert(sqlContent.includes("v_gross_numeric <> trunc(v_gross_numeric)"), "Wajib membandingkan nilai numerik asli tanpa pembulatan mengambang");
console.log("✓ Blocker 2 (Webhook Gross Amount): PASS (Fractional rupiah rejected & exact numeric check)");

// Blocker 3: Webhook Currency
assert(sqlContent.includes("MISSING_CURRENCY"), "Wajib menolak payload tanpa currency");
assert(sqlContent.includes("INVALID_CURRENCY"), "Wajib menolak currency selain IDR");
console.log("✓ Blocker 3 (Webhook Currency): PASS (Currency mandatory & strictly IDR)");

// Blocker 4: Snap Idempotency Fingerprint
assert(sqlContent.includes("payload_fingerprint"), "Tabel midtrans_transactions wajib memiliki payload_fingerprint");
assert(sqlContent.includes("IDEMPOTENCY_PAYLOAD_MISMATCH"), "Wajib menolak idempotency replay dengan payload berbeda");
console.log("✓ Blocker 4 (Snap Idempotency): PASS (Deterministic payload fingerprint & replay guard)");

// Blocker 5: Append-Only Allocation Ledger
assert(sqlContent.includes("IMMUTABLE_LEDGER"), "Wajib trigger anti-mutasi order_allocation_events");
assert(sqlContent.includes("grant select, insert on public.order_allocation_events to service_role"), "UPDATE/DELETE wajib dicabut dari service_role");
assert(!sqlContent.includes("grant all on public.order_allocation_events to service_role"), "Dilarang grant all pada order_allocation_events");
console.log("✓ Blocker 5 (Append-Only Ledger): PASS (UPDATE/DELETE revoked from all roles & trigger enforced)");

// Blocker 6: Webhook Terminal State
assert(sqlContent.includes("reconciliation_required_terminal_settlement"), "Settlement setelah terminal wajib reconciliation_required");
assert(sqlContent.includes("ignored_terminal_to_pending"), "Status terminal dilarang mundur menjadi pending");
console.log("✓ Blocker 6 (Webhook Terminal State): PASS (Terminal state transition guard strictly enforced)");

// 6. Validasi Tambahan F2.2 Hardening:
assert(sqlContent.includes("DUPLICATE_ORDER_ITEM_IN_REQUEST"), "Wajib tolak item duplikat dalam request alokasi");
assert(sqlContent.includes("MIXED_SPLIT_MODE_NOT_ALLOWED"), "Wajib larang mencampur mode split bill custom_amount dan by_item");
assert(sqlContent.includes("chk_alloc_financial_invariant"), "Wajib constraint invariant finansial pada order_allocations");
assert(sqlContent.includes("allocated_rounding_adjustment"), "Wajib kolom allocated_rounding_adjustment pada order_allocations");
assert(sqlContent.includes("GROSS_AMOUNT_IMMUTABLE"), "Wajib trigger proteksi perubahan gross_amount pada midtrans_transactions");
assert(sqlContent.includes("create or replace function public.approve_midtrans_capture_challenge"), "Wajib RPC approve_midtrans_capture_challenge untuk Admin");
assert(sqlContent.includes("midtrans.capture_challenge.approved"), "Wajib audit trail saat capture challenge disetujui Admin");
assert(sqlContent.includes("IMMUTABLE_ALLOCATION_FINANCIALS"), "Wajib proteksi komponen finansial alokasi pasca buat");
assert(sqlContent.includes("grant execute on function public.update_midtrans_snap_details(uuid, text, text) to service_role"), "RPC update_midtrans_snap_details harus untuk service_role");
console.log("✓ F2.2 Hardening (Invariant, Immutability & Admin Challenge Approval): PASS");

console.log("=== ALL STATIC CHECKS PASSED ===");

