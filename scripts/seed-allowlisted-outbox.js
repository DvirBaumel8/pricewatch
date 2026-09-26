#!/usr/bin/env node
"use strict";

/**
 * Seed one allowlisted outbox entry for live Resend proof.
 *
 * Fail-closed:
 *   - Exits non-zero if PRICEWATCH_TEST_EMAIL is not set.
 *   - Only intended to run via workflow_dispatch with seed_allowlisted_proof=true.
 *   - Scheduled runs must NEVER call this script.
 *
 * Writes exactly one outbox/*.json whose customer_email is the
 * PRICEWATCH_TEST_EMAIL pilot address. The existing send-outbox.js
 * pipeline then drains it through the normal allowlist gate.
 */

const fs = require("fs");
const path = require("path");

const OUTBOX_DIR = path.resolve(__dirname, "..", "outbox");

function seed() {
  const testEmail = (process.env.PRICEWATCH_TEST_EMAIL || "").trim();
  if (!testEmail) {
    console.error("[seed] FATAL: PRICEWATCH_TEST_EMAIL is not set.");
    console.error("[seed] Cannot seed without an allowlisted pilot address.");
    process.exit(1);
  }

  fs.mkdirSync(OUTBOX_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `seeded-proof_${ts}.json`;
  const filepath = path.join(OUTBOX_DIR, filename);

  const entry = {
    type: "price_change",
    customer_email: testEmail,
    subject: "PriceWatch seeded proof — allowlisted live test",
    body: [
      "This is a seeded proof email sent via workflow_dispatch.",
      `Timestamp: ${new Date().toISOString()}`,
      "If you received this, the allowlisted Resend pipeline is working.",
    ].join("\n"),
    seeded: true,
    seeded_at: new Date().toISOString(),
  };

  fs.writeFileSync(filepath, JSON.stringify(entry, null, 2) + "\n");
  console.log(`[seed] Wrote seeded outbox entry: ${filename}`);
  console.log(`[seed] Recipient: ${testEmail}`);
  return { filename, filepath, entry };
}

module.exports = { seed, OUTBOX_DIR };

if (require.main === module) {
  seed();
}
