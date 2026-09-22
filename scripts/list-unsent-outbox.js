#!/usr/bin/env node
"use strict";

/**
 * List unsent outbox files as JSON lines for agent / Gmail MCP consumption.
 *
 * Prints one JSON object per line for each outbox/*.json that has no
 * corresponding .sent sidecar. No network calls — pure filesystem read.
 *
 * Output fields per line:
 *   { file, path, type, to, subject, body }
 *
 * Usage:
 *   node scripts/list-unsent-outbox.js            # JSON lines to stdout
 *   node scripts/list-unsent-outbox.js --pretty    # indented JSON array
 *
 * For the gmail-mcp workflow an agent reads this output, calls Gmail MCP
 * send_message for each entry, then marks sent via:
 *   node scripts/mark-outbox-sent.js <file> [transport]
 */

const fs = require("fs");
const path = require("path");

const OUTBOX_DIR = path.resolve(__dirname, "..", "outbox");
const PRETTY = process.argv.includes("--pretty");

function resolveRecipient(email) {
  if (email.type === "ops_alert") {
    return (
      process.env.PRICEWATCH_OPS_EMAIL ||
      process.env.PRICEWATCH_MAIL_FROM ||
      "price.watcher.service@gmail.com"
    );
  }
  return email.customer_email || null;
}

function resolveSubject(email) {
  if (email.type === "ops_alert") {
    if (email.subject && /^\[ops\]/i.test(email.subject)) return email.subject;
    return `[ops] ${email.subject || "PriceWatch ops alert"}`;
  }
  return email.subject || "PriceWatch notification";
}

function main() {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });

  const files = fs
    .readdirSync(OUTBOX_DIR)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".sent"));

  const unsent = [];

  for (const file of files) {
    const filePath = path.join(OUTBOX_DIR, file);
    const sentPath = filePath + ".sent";
    if (fs.existsSync(sentPath)) continue;

    let email;
    try {
      email = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }

    const to = resolveRecipient(email);
    if (!to) continue;

    unsent.push({
      file,
      path: filePath,
      type: email.type || "unknown",
      to,
      subject: resolveSubject(email),
      body: email.body || JSON.stringify(email, null, 2),
    });
  }

  if (PRETTY) {
    console.log(JSON.stringify(unsent, null, 2));
  } else {
    for (const entry of unsent) {
      console.log(JSON.stringify(entry));
    }
  }
}

main();
