/**
 * Plan-ladder email — structured change table for customer emails.
 *
 * writePlanLadderEmail(site, pricingUrl, changes, customerInfo) → emailPath
 *
 * Rules:
 *  - No localhost/127.0.0.1 in subject or body
 *  - Jerusalem time
 *  - Support line to price.watcher.service@gmail.com
 *  - Table of field changes only; optional one plain sentence after table
 *  - Partner promise: daily morning Israel check, not 24/7
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { formatJerusalemTime, isLocalUrl } = require("./monitor-lib");

const OUTBOX_DIR = path.resolve(__dirname, "..", "outbox");

function friendlySite(site, pricingUrl) {
  if (site && !isLocalUrl(`https://${site}`)) return site;
  if (pricingUrl && !isLocalUrl(pricingUrl)) {
    try { return new URL(pricingUrl).hostname; } catch {}
  }
  return "the site you're watching";
}

function friendlyLink(pricingUrl) {
  if (!pricingUrl || isLocalUrl(pricingUrl)) return "Your monitored pricing page";
  return `Open pricing page: ${pricingUrl}`;
}

function formatFieldValue(field, value) {
  if (value === null || value === undefined) return "—";
  if (field === "price") return `$${value}`;
  return String(value);
}

function formatPrice(p) {
  if (p === null || p === undefined) return "Custom";
  return `$${p}`;
}

function buildChangeTable(changes) {
  const lines = [];
  lines.push("  Plan            | Field    | Before     | After");
  lines.push("  --------------- | -------- | ---------- | ----------");
  for (const c of changes) {
    const plan = (c.plan || "—").padEnd(15);

    if (c.type === "plan_added") {
      const price = formatPrice(c.newPrice);
      lines.push(`  ${plan} | ${"added".padEnd(8)} | ${"—".padEnd(10)} | ${price.padEnd(10)}`);
      continue;
    }
    if (c.type === "plan_removed") {
      const price = formatPrice(c.oldPrice);
      lines.push(`  ${plan} | ${"removed".padEnd(8)} | ${price.padEnd(10)} | ${"—".padEnd(10)}`);
      continue;
    }

    const field = (c.field || "—").padEnd(8);
    const old = formatFieldValue(c.field, c.old).padEnd(10);
    const nw = formatFieldValue(c.field, c.new).padEnd(10);
    lines.push(`  ${plan} | ${field} | ${old} | ${nw}`);
  }
  return lines.join("\n");
}

function buildSummaryLine(changes) {
  const priceChanges = changes.filter(c => c.type === "price_change" && c.field === "price");
  if (priceChanges.length === 1) {
    const c = priceChanges[0];
    const dir = (c.new !== null && c.old !== null && c.new > c.old) ? "increased" : "changed";
    return `${c.plan} price ${dir} from $${c.old} to $${c.new}.`;
  }
  if (priceChanges.length > 1) {
    return `${priceChanges.length} plan prices changed.`;
  }
  const added = changes.filter(c => c.type === "plan_added");
  const removed = changes.filter(c => c.type === "plan_removed");
  if (added.length > 0 && removed.length === 0) {
    const descs = added.map(c => {
      const price = c.newPrice !== null && c.newPrice !== undefined ? ` at $${c.newPrice}` : "";
      return `${c.plan}${price}`;
    });
    return `New plan${added.length > 1 ? "s" : ""} detected: ${descs.join(", ")}.`;
  }
  if (removed.length > 0 && added.length === 0) {
    const descs = removed.map(c => {
      const price = c.oldPrice !== null && c.oldPrice !== undefined ? ` ($${c.oldPrice})` : "";
      return `${c.plan}${price}`;
    });
    return `Plan${removed.length > 1 ? "s" : ""} removed: ${descs.join(", ")}.`;
  }
  return `${changes.length} pricing change${changes.length > 1 ? "s" : ""} detected.`;
}

function writePlanLadderEmail(site, pricingUrl, changes, customerInfo) {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeSite = (site || "unknown").replace(/[^a-z0-9.-]/gi, "_");
  const filename = `plan-ladder_${safeSite}_${ts}.json`;
  const emailPath = path.join(OUTBOX_DIR, filename);

  const name = friendlySite(site, pricingUrl);
  const now = new Date();
  const greeting = customerInfo && customerInfo.customerName
    ? `Hi ${customerInfo.customerName},`
    : "Hi,";

  const table = buildChangeTable(changes);
  const summary = buildSummaryLine(changes);

  const email = {
    type: "plan_ladder_change",
    site,
    pricing_url: pricingUrl,
    customer_id: customerInfo ? customerInfo.customerId : null,
    customer_email: customerInfo ? customerInfo.customerEmail : null,
    customer_name: customerInfo ? customerInfo.customerName : null,
    timestamp: now.toISOString(),
    changes,
    subject: `PriceWatch: ${name} pricing changed`,
    body: [
      greeting,
      "",
      `We detected pricing changes on ${name}.`,
      "",
      table,
      "",
      summary,
      "",
      friendlyLink(pricingUrl),
      "",
      `Detected ${formatJerusalemTime(now)}.`,
      "",
      "Questions? Reply to this email or write price.watcher.service@gmail.com.",
      "",
      "— PriceWatch",
    ].join("\n"),
  };

  fs.writeFileSync(emailPath, JSON.stringify(email, null, 2) + "\n");
  return emailPath;
}

module.exports = {
  writePlanLadderEmail,
  buildChangeTable,
  buildSummaryLine,
  friendlySite,
  OUTBOX_DIR,
};
