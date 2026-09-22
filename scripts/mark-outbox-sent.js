#!/usr/bin/env node
"use strict";

/**
 * Mark an outbox file as sent by writing its .sent sidecar.
 *
 * Used by the gmail-mcp agent workflow after a successful Gmail MCP
 * send_message call. Same sidecar format as send-outbox.js so the
 * idempotency contract is shared across all transports.
 *
 * Usage:
 *   node scripts/mark-outbox-sent.js <file-or-path> [transport]
 *
 * Examples:
 *   node scripts/mark-outbox-sent.js outbox/price-change_lab_2026-09-22.json gmail-mcp
 *   node scripts/mark-outbox-sent.js price-change_lab_2026-09-22.json
 *
 * Exit codes:
 *   0 — marked (or already marked)
 *   1 — file not found
 */

const fs = require("fs");
const path = require("path");

const OUTBOX_DIR = path.resolve(__dirname, "..", "outbox");

function resolve(fileArg) {
  if (path.isAbsolute(fileArg)) return fileArg;
  const inOutbox = path.join(OUTBOX_DIR, path.basename(fileArg));
  if (fs.existsSync(inOutbox)) return inOutbox;
  const relative = path.resolve(fileArg);
  if (fs.existsSync(relative)) return relative;
  return null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: node scripts/mark-outbox-sent.js <file> [transport]");
    process.exit(1);
  }

  const fileArg = args[0];
  const transport = args[1] || "gmail-mcp";
  const filePath = resolve(fileArg);

  if (!filePath || !fs.existsSync(filePath)) {
    console.error(`[mark-sent] File not found: ${fileArg}`);
    process.exit(1);
  }

  const sentPath = filePath + ".sent";
  if (fs.existsSync(sentPath)) {
    console.log(`[mark-sent] Already marked: ${path.basename(filePath)}`);
    return;
  }

  const marker = {
    sent_at: new Date().toISOString(),
    transport,
    file: path.basename(filePath),
  };
  fs.writeFileSync(sentPath, JSON.stringify(marker, null, 2) + "\n");
  console.log(`[mark-sent] Marked sent (${transport}): ${path.basename(filePath)}`);
}

main();
