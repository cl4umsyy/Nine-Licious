#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd(), true);

const serverKey = process.env.MIDTRANS_SERVER_KEY;
console.log("Midtrans Server Key configured:", !!serverKey);

if (!serverKey) {
  console.log("MIDTRANS_SERVER_KEY tidak ditemukan di environment.");
  process.exit(1);
}

const authHeader = `Basic ${Buffer.from(`${serverKey}:`).toString("base64")}`;

async function testMidtrans() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch("https://api.sandbox.midtrans.com/v2/dummy-probe-check/status", {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json();
    console.log("Midtrans Sandbox API Response Code:", res.status);
    console.log("Midtrans Sandbox API Message:", data.status_message || data);
  } catch (err) {
    clearTimeout(timeout);
    console.error("Midtrans Connection Error:", err.message);
  }
}

testMidtrans();
