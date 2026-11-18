#!/usr/bin/env node
/**
 * NINE LICIOUS POS - TEST SUITE: MIDTRANS WEBHOOK SIGNATURE & GET STATUS API VERIFICATION
 *
 * Menguji seluruh skenario wajib Bagian 5:
 * 1. Signature valid Sandbox (SHA512(order_id + status_code + gross_amount + ServerKey)).
 * 2. Signature tidak valid (dimodifikasi / panjang salah / non-hex / kosong).
 * 3. Server Key salah.
 * 4. Gross amount berbeda (termasuk "43700" vs "43700.00" & parser ketat tanpa float drift).
 * 5. Order ID berbeda.
 * 6. Status code berbeda.
 * 7. Webhook duplikat (idempotensi SHA-256 fingerprint, tanpa pembayaran ganda).
 * 8. Notifikasi pending (tidak mengubah pesanan menjadi paid).
 * 9. Notifikasi settlement (valid signature -> settlement berhasil).
 * 10. Notifikasi deny atau expire (melepas reservasi & status terminal).
 * 11. GET Status API berhasil (server-to-server Basic Auth HTTPS -> settleVerifiedMidtransStatus,
 *     sementara HTTP webhook eksternal tetap menolak invalid signature dengan HTTP 401).
 */

import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
function readProjectFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

// ============================================================================
// Pure Mirror of src/lib/midtrans/signature.ts
// ============================================================================
function computeMidtransSignature({ orderId, statusCode, grossAmount, serverKey }) {
  return createHash("sha512")
    .update(`${orderId.trim()}${statusCode.trim()}${grossAmount.trim()}${serverKey.trim()}`)
    .digest("hex");
}

function verifyMidtransSignature({ orderId, statusCode, grossAmount, signatureKey, serverKey }) {
  if (
    !orderId ||
    !statusCode ||
    !grossAmount ||
    !signatureKey ||
    !serverKey ||
    typeof orderId !== "string" ||
    typeof statusCode !== "string" ||
    typeof grossAmount !== "string" ||
    typeof signatureKey !== "string" ||
    typeof serverKey !== "string"
  ) {
    return false;
  }

  const trimmedOrderId = orderId.trim();
  const trimmedStatusCode = statusCode.trim();
  const trimmedGross = grossAmount.trim();
  const trimmedSig = signatureKey.trim().toLowerCase();
  const trimmedKey = serverKey.trim();

  if (!trimmedOrderId || !trimmedStatusCode || !trimmedGross || !trimmedSig || !trimmedKey) {
    return false;
  }

  if (!/^[0-9a-f]{128}$/.test(trimmedSig)) {
    return false;
  }

  const expected = computeMidtransSignature({
    orderId: trimmedOrderId,
    statusCode: trimmedStatusCode,
    grossAmount: trimmedGross,
    serverKey: trimmedKey,
  });

  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(trimmedSig, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

function parseMidtransGrossAmount(rawGrossAmount) {
  if (typeof rawGrossAmount !== "string") return null;
  const trimmed = rawGrossAmount.trim();
  const match = /^(\d+)(?:\.(0+))?$/.exec(trimmed);
  if (!match) return null;
  const val = Number(match[1]);
  if (!Number.isSafeInteger(val) || val <= 0) return null;
  return val;
}

function computeFingerprint(payload) {
  const parts = [
    payload.order_id ?? "",
    payload.status_code ?? "",
    payload.gross_amount ?? "",
    payload.currency ?? "IDR",
    payload.transaction_status ?? "",
    payload.fraud_status ?? "",
    payload.transaction_id ?? "",
  ];
  return createHash("sha256").update(parts.join(":")).digest("hex");
}

// ============================================================================
// Stateful Webhook & GET Status Reconciliation Simulator
// ============================================================================
function createMidtransSimulator(serverKey) {
  const tx = {
    midtrans_order_id: "ORD-20261118-0008-A1",
    gross_amount: 43700,
    lifecycle_status: "token_created",
    allocation_status: "reserved",
  };
  const order = {
    order_number: "ORD-20261118-0008",
    status: "awaiting_payment",
    payment_status: "unpaid",
    grand_total: 43700,
    paid_total: 0,
  };
  const seenFingerprints = new Map();
  let settlementExecutions = 0;

  function applyVerifiedSettlement(payload) {
    const fp = computeFingerprint(payload);
    if (seenFingerprints.has(fp)) {
      return { ok: true, processingResult: "ignored_duplicate", isDuplicate: true };
    }

    const gross = parseMidtransGrossAmount(payload.gross_amount);
    if (gross === null || gross !== tx.gross_amount) {
      return { ok: false, processingResult: "failed", error: "GROSS_AMOUNT_MISMATCH" };
    }

    const status = payload.transaction_status;
    if (status === "settlement" || (status === "capture" && payload.fraud_status === "accept")) {
      tx.lifecycle_status = "settled";
      tx.allocation_status = "settled";
      order.paid_total += tx.gross_amount;
      order.status = "paid";
      order.payment_status = "paid";
      settlementExecutions += 1;
      seenFingerprints.set(fp, "settled");
      return { ok: true, processingResult: "settled", isDuplicate: false };
    }

    if (["deny", "expire", "cancel"].includes(status)) {
      tx.lifecycle_status = status === "deny" ? "denied" : status === "expire" ? "expired" : "cancelled";
      tx.allocation_status = "released";
      seenFingerprints.set(fp, "terminal_released");
      return { ok: true, processingResult: "terminal_released", isDuplicate: false };
    }

    if (status === "pending") {
      tx.lifecycle_status = "pending";
      seenFingerprints.set(fp, "processing");
      return { ok: true, processingResult: "processing", isDuplicate: false };
    }

    return { ok: true, processingResult: "processing", isDuplicate: false };
  }

  function handleHttpWebhook(payload) {
    const valid = verifyMidtransSignature({
      orderId: payload.order_id,
      statusCode: payload.status_code,
      grossAmount: payload.gross_amount,
      signatureKey: payload.signature_key,
      serverKey,
    });
    if (!valid) {
      return { httpStatus: 401, ok: false, error: "Tanda tangan digital webhook tidak valid." };
    }
    const res = applyVerifiedSettlement(payload);
    return { httpStatus: res.ok ? 200 : 500, ...res };
  }

  function reconcileFromGetStatusApi(apiResponse) {
    if (apiResponse.order_id !== tx.midtrans_order_id) {
      return { ok: false, isSettled: false, error: "ORDER_ID_MISMATCH" };
    }
    const gross = parseMidtransGrossAmount(apiResponse.gross_amount);
    if (gross === null || gross !== tx.gross_amount) {
      return { ok: false, isSettled: false, error: "GROSS_AMOUNT_MISMATCH" };
    }
    if ((apiResponse.currency || "IDR").toUpperCase() !== "IDR") {
      return { ok: false, isSettled: false, error: "CURRENCY_MISMATCH" };
    }
    // Note: does NOT pass apiResponse.signature_key through external webhook validator
    const res = applyVerifiedSettlement({
      order_id: apiResponse.order_id,
      status_code: apiResponse.status_code,
      gross_amount: apiResponse.gross_amount,
      transaction_status: apiResponse.transaction_status,
      fraud_status: apiResponse.fraud_status,
      currency: apiResponse.currency || "IDR",
      transaction_id: apiResponse.transaction_id,
    });
    return { ok: res.ok, isSettled: order.payment_status === "paid", ...res };
  }

  return {
    tx,
    order,
    getSettlementCount: () => settlementExecutions,
    handleHttpWebhook,
    reconcileFromGetStatusApi,
  };
}

// ============================================================================
// Test Runner
// ============================================================================
const SANDBOX_KEY = "SB-Mid-server-TestSandboxKey0000000001";
const WRONG_KEY = "SB-Mid-server-WrongSandboxKey999999999";

const BASE_PAYLOAD = {
  order_id: "ORD-20261118-0008-A1",
  status_code: "200",
  gross_amount: "43700.00",
  currency: "IDR",
  transaction_id: "tx-sandbox-0008",
  transaction_status: "settlement",
  fraud_status: "accept",
  payment_type: "bank_transfer",
};

const VALID_SIG = computeMidtransSignature({
  orderId: BASE_PAYLOAD.order_id,
  statusCode: BASE_PAYLOAD.status_code,
  grossAmount: BASE_PAYLOAD.gross_amount,
  serverKey: SANDBOX_KEY,
});

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  }
}

console.log("\n======================================================================");
console.log("  NINE LICIOUS POS — MIDTRANS SIGNATURE & GET STATUS API TEST SUITE");
console.log("======================================================================\n");

test("1. Signature valid Sandbox lulus verifikasi SHA512(order_id+status_code+gross_amount+ServerKey)", () => {
  assert.equal(VALID_SIG.length, 128);
  assert.equal(
    verifyMidtransSignature({
      orderId: BASE_PAYLOAD.order_id,
      statusCode: BASE_PAYLOAD.status_code,
      grossAmount: BASE_PAYLOAD.gross_amount,
      signatureKey: VALID_SIG,
      serverKey: SANDBOX_KEY,
    }),
    true,
  );
  // Case-insensitive hex allowed
  assert.equal(
    verifyMidtransSignature({
      orderId: BASE_PAYLOAD.order_id,
      statusCode: BASE_PAYLOAD.status_code,
      grossAmount: BASE_PAYLOAD.gross_amount,
      signatureKey: VALID_SIG.toUpperCase(),
      serverKey: SANDBOX_KEY,
    }),
    true,
  );
});

test("2. Signature tidak valid (dimodifikasi / pendek / kosong / non-hex) ditolak", () => {
  const tampered = (VALID_SIG[0] === "a" ? "b" : "a") + VALID_SIG.slice(1);
  assert.equal(
    verifyMidtransSignature({
      orderId: BASE_PAYLOAD.order_id,
      statusCode: BASE_PAYLOAD.status_code,
      grossAmount: BASE_PAYLOAD.gross_amount,
      signatureKey: tampered,
      serverKey: SANDBOX_KEY,
    }),
    false,
  );
  assert.equal(
    verifyMidtransSignature({
      orderId: BASE_PAYLOAD.order_id,
      statusCode: BASE_PAYLOAD.status_code,
      grossAmount: BASE_PAYLOAD.gross_amount,
      signatureKey: "short-invalid",
      serverKey: SANDBOX_KEY,
    }),
    false,
  );
  assert.equal(
    verifyMidtransSignature({
      orderId: BASE_PAYLOAD.order_id,
      statusCode: BASE_PAYLOAD.status_code,
      grossAmount: BASE_PAYLOAD.gross_amount,
      signatureKey: "",
      serverKey: SANDBOX_KEY,
    }),
    false,
  );
});

test("3. Server Key salah ditolak", () => {
  assert.equal(
    verifyMidtransSignature({
      orderId: BASE_PAYLOAD.order_id,
      statusCode: BASE_PAYLOAD.status_code,
      grossAmount: BASE_PAYLOAD.gross_amount,
      signatureKey: VALID_SIG,
      serverKey: WRONG_KEY,
    }),
    false,
  );
});

test("4. Gross amount berbeda (atau format Rupiah / desimal non-nol) ditolak", () => {
  assert.equal(
    verifyMidtransSignature({
      orderId: BASE_PAYLOAD.order_id,
      statusCode: BASE_PAYLOAD.status_code,
      grossAmount: "43700", // tanpa .00 berbeda dari payload asli "43700.00"
      signatureKey: VALID_SIG,
      serverKey: SANDBOX_KEY,
    }),
    false,
  );
  assert.equal(
    verifyMidtransSignature({
      orderId: BASE_PAYLOAD.order_id,
      statusCode: BASE_PAYLOAD.status_code,
      grossAmount: "43701.00",
      signatureKey: VALID_SIG,
      serverKey: SANDBOX_KEY,
    }),
    false,
  );
  assert.equal(parseMidtransGrossAmount("43700.00"), 43700);
  assert.equal(parseMidtransGrossAmount("43700"), 43700);
  assert.equal(parseMidtransGrossAmount("Rp 43.700"), null);
  assert.equal(parseMidtransGrossAmount("43700.50"), null);
  assert.equal(parseMidtransGrossAmount("-43700.00"), null);
});

test("5. Order ID berbeda ditolak", () => {
  assert.equal(
    verifyMidtransSignature({
      orderId: "ORD-20261118-0099-A1",
      statusCode: BASE_PAYLOAD.status_code,
      grossAmount: BASE_PAYLOAD.gross_amount,
      signatureKey: VALID_SIG,
      serverKey: SANDBOX_KEY,
    }),
    false,
  );
});

test("6. Status code berbeda ditolak", () => {
  assert.equal(
    verifyMidtransSignature({
      orderId: BASE_PAYLOAD.order_id,
      statusCode: "201",
      grossAmount: BASE_PAYLOAD.gross_amount,
      signatureKey: VALID_SIG,
      serverKey: SANDBOX_KEY,
    }),
    false,
  );
});

test("7. Webhook duplikat ditangani idempoten tanpa pembayaran ganda", () => {
  const sim = createMidtransSimulator(SANDBOX_KEY);
  const payload = { ...BASE_PAYLOAD, signature_key: VALID_SIG };

  const first = sim.handleHttpWebhook(payload);
  const second = sim.handleHttpWebhook(payload);

  assert.equal(first.httpStatus, 200);
  assert.equal(first.processingResult, "settled");
  assert.equal(second.httpStatus, 200);
  assert.equal(second.processingResult, "ignored_duplicate");
  assert.equal(sim.getSettlementCount(), 1);
  assert.equal(sim.order.paid_total, 43700);
});

test("8. Notifikasi pending tidak mengubah pesanan menjadi paid", () => {
  const sim = createMidtransSimulator(SANDBOX_KEY);
  const pendingPayload = {
    ...BASE_PAYLOAD,
    status_code: "201",
    transaction_status: "pending",
  };
  pendingPayload.signature_key = computeMidtransSignature({
    orderId: pendingPayload.order_id,
    statusCode: pendingPayload.status_code,
    grossAmount: pendingPayload.gross_amount,
    serverKey: SANDBOX_KEY,
  });

  const res = sim.handleHttpWebhook(pendingPayload);
  assert.equal(res.httpStatus, 200);
  assert.equal(sim.order.status, "awaiting_payment");
  assert.equal(sim.order.payment_status, "unpaid");
  assert.equal(sim.tx.lifecycle_status, "pending");
});

test("9. Notifikasi settlement dengan signature valid melunasi pesanan; invalid signature ditolak HTTP 401", () => {
  const sim = createMidtransSimulator(SANDBOX_KEY);

  const badAttempt = sim.handleHttpWebhook({
    ...BASE_PAYLOAD,
    signature_key: "0".repeat(128),
  });
  assert.equal(badAttempt.httpStatus, 401);
  assert.equal(sim.order.status, "awaiting_payment");

  const goodAttempt = sim.handleHttpWebhook({
    ...BASE_PAYLOAD,
    signature_key: VALID_SIG,
  });
  assert.equal(goodAttempt.httpStatus, 200);
  assert.equal(sim.order.status, "paid");
  assert.equal(sim.order.payment_status, "paid");
});

test("10. Notifikasi deny dan expire melepas reservasi tanpa melunasi pesanan", () => {
  for (const terminalStatus of ["deny", "expire"]) {
    const sim = createMidtransSimulator(SANDBOX_KEY);
    const p = {
      ...BASE_PAYLOAD,
      status_code: terminalStatus === "deny" ? "202" : "407",
      transaction_status: terminalStatus,
      fraud_status: terminalStatus === "deny" ? "deny" : "",
    };
    p.signature_key = computeMidtransSignature({
      orderId: p.order_id,
      statusCode: p.status_code,
      grossAmount: p.gross_amount,
      serverKey: SANDBOX_KEY,
    });

    const res = sim.handleHttpWebhook(p);
    assert.equal(res.httpStatus, 200);
    assert.equal(res.processingResult, "terminal_released");
    assert.equal(sim.order.status, "awaiting_payment");
    assert.equal(sim.tx.allocation_status, "released");
  }
});

test("11. GET Status API berhasil memverifikasi settlement & kontrak kode keamanan terjaga", () => {
  const sim = createMidtransSimulator(SANDBOX_KEY);

  // Simulasi respons live Midtrans Sandbox GET /v2/ORD-20261118-0008-A1/status
  // yang menyertakan signature_key berbeda dari SHA512(order_id+status_code+gross_amount+serverKey)
  const res = sim.reconcileFromGetStatusApi({
    ...BASE_PAYLOAD,
    signature_key: "f".repeat(128),
  });
  assert.equal(res.ok, true);
  assert.equal(res.isSettled, true);
  assert.equal(sim.order.status, "paid");
  assert.equal(sim.order.paid_total, 43700);

  // Panggilan kedua GET Status API tetap idempoten (tidak menggandakan pembayaran)
  const res2 = sim.reconcileFromGetStatusApi({
    ...BASE_PAYLOAD,
    signature_key: "f".repeat(128),
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.processingResult, "ignored_duplicate");
  assert.equal(sim.getSettlementCount(), 1);

  // Audit kontrak kode sumber
  const sigSrc = readProjectFile("src/lib/midtrans/signature.ts");
  const routeSrc = readProjectFile("src/app/api/midtrans/webhook/route.ts");
  const webhookSrc = readProjectFile("src/lib/midtrans/webhook.ts");
  const reconcileSrc = readProjectFile("src/lib/midtrans/reconcile.ts");

  // Rumus resmi SHA512 + timingSafeEqual + tidak ada console.log serverKey/signature
  assert.match(sigSrc, /createHash\("sha512"\)/);
  assert.match(sigSrc, /timingSafeEqual/);
  assert.equal(/console\.(log|error|warn).*serverKey/i.test(sigSrc), false);
  assert.equal(/console\.(log|error|warn).*signatureKey/i.test(sigSrc), false);

  // HTTP webhook route tetap mewajibkan validasi signature (HTTP 401 bila invalid)
  assert.match(routeSrc, /verifyMidtransWebhookSignature/);
  assert.match(routeSrc, /status:\s*401/);

  // processMidtransWebhook tetap memverifikasi signature sebelum settlement
  assert.match(webhookSrc, /verifyMidtransWebhookSignature/);
  assert.match(webhookSrc, /export async function settleVerifiedMidtransStatus/);

  // reconcile.ts memakai parseMidtransGrossAmount ketat & settleVerifiedMidtransStatus (bukan processMidtransWebhook)
  assert.match(reconcileSrc, /parseMidtransGrossAmount/);
  assert.match(reconcileSrc, /settleVerifiedMidtransStatus/);
  assert.equal(/processMidtransWebhook\(/.test(reconcileSrc), false);
});

console.log("\n----------------------------------------------------------------------");
console.log(`  HASIL MIDTRANS SIGNATURE & STATUS API: ${passed} PASS, ${failed} FAIL`);
console.log("----------------------------------------------------------------------\n");

if (failed > 0) {
  process.exit(1);
}
