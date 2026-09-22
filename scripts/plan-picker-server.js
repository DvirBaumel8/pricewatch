#!/usr/bin/env node
"use strict";

/**
 * Plan-picker — minimal HTML confirm page for W6 Beat 2.5.
 *
 * Shows extracted plan ladder as selectable rows. Customer picks which
 * plan(s) to watch or "all paid plans." No raw JSON on screen.
 *
 * Usage:
 *   node scripts/plan-picker-server.js [--port 3900]
 *
 * Routes:
 *   GET  /                → redirect to /pick/vercel.com (demo default)
 *   GET  /pick/:site      → HTML plan picker for a site
 *   POST /pick/:site      → save selection, show confirmation
 *   GET  /confirmed/:site → confirmation page
 *
 * Reads from data/snapshots/ladder/<site>.json (run ladder extract first).
 * Writes to data/watched/<site>.json on selection.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadLadderSnapshot } = require("../src/plan-ladder-snapshot");
const { saveSelection, loadSelection } = require("../src/plan-selection");

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") || "3900", 10);

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPrice(price, currency) {
  if (price === null || price === undefined) return "Custom";
  return `$${price}`;
}

function renderPickerPage(site, plans, error) {
  const paidPlans = plans.filter((p) => p.price !== null && p.price > 0);
  const rows = plans
    .map((p, i) => {
      const isPaid = p.price !== null && p.price > 0;
      const checked = isPaid ? "checked" : "";
      const price = formatPrice(p.price, p.currency);
      const unit = p.unit ? `per ${p.unit}` : "";
      const billing = p.billing === "free" ? "" : `/ ${p.billing}`;
      const badge = p.billing === "free"
        ? '<span class="badge free">Free</span>'
        : p.billing === "custom"
          ? '<span class="badge custom">Custom</span>'
          : "";
      return `
      <label class="plan-row${isPaid ? "" : " dimmed"}">
        <input type="checkbox" name="plan" value="${esc(p.plan)}" ${checked}>
        <span class="plan-name">${esc(p.plan)}</span>
        <span class="plan-price">${esc(price)}</span>
        <span class="plan-detail">${esc(unit)} ${esc(billing)} ${badge}</span>
      </label>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PriceWatch — Pick plans to watch on ${esc(site)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
           background: #0a0a0a; color: #e5e5e5; min-height: 100vh;
           display: flex; justify-content: center; padding: 48px 16px; }
    .container { max-width: 560px; width: 100%; }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 4px; color: #fff; }
    .subtitle { color: #888; font-size: 0.9rem; margin-bottom: 32px; }
    .site-badge { display: inline-block; background: #1a1a2e; color: #7c8aff;
                  padding: 2px 10px; border-radius: 6px; font-size: 0.85rem;
                  font-weight: 500; margin-bottom: 16px; }
    .plan-row { display: flex; align-items: center; gap: 12px; padding: 14px 16px;
                background: #141414; border: 1px solid #262626; border-radius: 10px;
                margin-bottom: 8px; cursor: pointer; transition: border-color 0.15s; }
    .plan-row:hover { border-color: #444; }
    .plan-row.dimmed { opacity: 0.5; }
    .plan-row input[type="checkbox"] { width: 18px; height: 18px; accent-color: #7c8aff;
                                        flex-shrink: 0; }
    .plan-name { font-weight: 600; font-size: 1rem; min-width: 100px; color: #fff; }
    .plan-price { font-weight: 700; font-size: 1.1rem; min-width: 70px; color: #7c8aff; }
    .plan-detail { color: #888; font-size: 0.85rem; flex: 1; }
    .badge { display: inline-block; padding: 1px 8px; border-radius: 4px;
             font-size: 0.75rem; font-weight: 600; margin-left: 4px; }
    .badge.free { background: #1a2e1a; color: #6bc46b; }
    .badge.custom { background: #2e2a1a; color: #c4a86b; }
    .actions { margin-top: 24px; display: flex; gap: 12px; align-items: center; }
    .btn { padding: 10px 24px; border-radius: 8px; border: none; font-size: 0.95rem;
           font-weight: 600; cursor: pointer; transition: background 0.15s; }
    .btn-primary { background: #7c8aff; color: #fff; }
    .btn-primary:hover { background: #6b79ee; }
    .btn-secondary { background: #262626; color: #ccc; }
    .btn-secondary:hover { background: #333; }
    .shortcut { color: #666; font-size: 0.85rem; }
    .error { color: #ff6b6b; font-size: 0.9rem; margin-bottom: 12px; }
    .footer { margin-top: 32px; color: #555; font-size: 0.8rem; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="site-badge">${esc(site)}</div>
    <h1>Which plans should we watch?</h1>
    <p class="subtitle">Pick the plan(s) you want price alerts for. We check daily, morning Israel time.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <form method="POST" action="/pick/${esc(site)}">
      ${rows}
      <div class="actions">
        <button type="submit" name="mode" value="selected" class="btn btn-primary">Watch selected plans</button>
        <button type="submit" name="mode" value="all_paid" class="btn btn-secondary">Watch all paid plans</button>
      </div>
    </form>
    <p class="footer">
      We'll email you when a selected plan's price, unit, or billing changes.<br>
      Banner or layout changes won't trigger an alert.
    </p>
  </div>
</body>
</html>`;
}

function renderConfirmedPage(site, selection) {
  const planList = selection.mode === "all_paid"
    ? "<li><strong>All paid plans</strong></li>"
    : selection.plans.map((p) => `<li>${esc(p)}</li>`).join("\n        ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PriceWatch — Watching ${esc(site)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
           background: #0a0a0a; color: #e5e5e5; min-height: 100vh;
           display: flex; justify-content: center; align-items: center; padding: 48px 16px; }
    .container { max-width: 480px; width: 100%; text-align: center; }
    .check { font-size: 3rem; margin-bottom: 16px; }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 8px; color: #fff; }
    .subtitle { color: #888; font-size: 0.95rem; margin-bottom: 24px; }
    .plan-list { list-style: none; margin: 0 auto 24px; text-align: left;
                 max-width: 280px; }
    .plan-list li { padding: 8px 0; border-bottom: 1px solid #222; font-size: 1rem;
                    color: #7c8aff; font-weight: 500; }
    .promise { color: #666; font-size: 0.85rem; line-height: 1.6; max-width: 360px;
               margin: 0 auto; }
  </style>
</head>
<body>
  <div class="container">
    <div class="check">✓</div>
    <h1>Watching ${esc(site)}</h1>
    <p class="subtitle">You'll get an email when these plans change price.</p>
    <ul class="plan-list">
        ${planList}
    </ul>
    <p class="promise">
      Daily check, morning Israel time. Price, plan, or seat changes only.<br>
      Banner edits stay silent. Reply to any alert or write
      price.watcher.service@gmail.com to pause or cancel.
    </p>
  </div>
</body>
</html>`;
}

function parseFormBody(body) {
  const params = new URLSearchParams(body);
  const plans = params.getAll("plan");
  const mode = params.get("mode") || "selected";
  return { plans, mode };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(302, { Location: "/pick/vercel.com" });
    res.end();
    return;
  }

  const pickMatch = url.pathname.match(/^\/pick\/([a-z0-9.-]+)$/);
  if (pickMatch && req.method === "GET") {
    const site = pickMatch[1];
    const snap = loadLadderSnapshot(site);
    if (!snap) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(`<h1>No plan data for ${esc(site)}</h1><p>Run: <code>node src/plan-ladder-monitor.js https://${esc(site)}/pricing</code></p>`);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPickerPage(site, snap.plans, null));
    return;
  }

  if (pickMatch && req.method === "POST") {
    const site = pickMatch[1];
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { plans, mode } = parseFormBody(body);
      if (mode === "selected" && plans.length === 0) {
        const snap = loadLadderSnapshot(site);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderPickerPage(site, snap ? snap.plans : [], "Please select at least one plan."));
        return;
      }
      saveSelection(site, { plans, mode });
      res.writeHead(302, { Location: `/confirmed/${site}` });
      res.end();
    });
    return;
  }

  const confirmMatch = url.pathname.match(/^\/confirmed\/([a-z0-9.-]+)$/);
  if (confirmMatch && req.method === "GET") {
    const site = confirmMatch[1];
    const sel = loadSelection(site);
    if (!sel) {
      res.writeHead(302, { Location: `/pick/${site}` });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderConfirmedPage(site, sel));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`PriceWatch plan picker: http://127.0.0.1:${PORT}/`);
  console.log(`  Demo default: http://127.0.0.1:${PORT}/pick/vercel.com`);
  console.log(`  (Run ladder extract first: npm run ladder:allowlist)`);
});
