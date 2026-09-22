#!/usr/bin/env node
"use strict";

/**
 * PriceWatch demo UI — browser sell surface for screen recording.
 *
 * Inbox-first (script v2): cold open shows a preloaded sample alert;
 * workbench on the left walks URL → pricing plans → tap plan → simulate.
 *
 * Usage:
 *   npm run demo-ui
 *   node scripts/demo-ui-server.js [--port 3910]
 *
 * Ops bind: 127.0.0.1 (not shown in customer chrome).
 * Sell path: open the page fullscreen / hide the address bar.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { extractPlanLadder } = require("../src/plan-ladder");
const { loadLadderSnapshot, saveLadderSnapshot } = require("../src/plan-ladder-snapshot");
const { diffPlanLadders, filterBySelection } = require("../src/plan-ladder-diff");
const { writePlanLadderEmail, buildSummaryLine } = require("../src/plan-ladder-email");
const { saveSelection, loadSelection } = require("../src/plan-selection");
const { formatJerusalemTime } = require("../src/monitor-lib");

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") || "3910", 10);
const DEFAULT_URL = "https://vercel.com/pricing";
const DEFAULT_SITE = "vercel.com";
const BUMP_DELTA = 5;

const FIXTURE_PLANS = [
  { plan: "Hobby", price: 0, currency: "USD", unit: null, billing: "free" },
  { plan: "Pro", price: 20, currency: "USD", unit: "developer seat", billing: "monthly" },
  { plan: "Enterprise", price: null, currency: "USD", unit: null, billing: "custom" },
];

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function siteFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return DEFAULT_SITE;
  }
}

function formatPrice(price) {
  if (price === null || price === undefined) return "Custom";
  return `$${price}`;
}

function buildSampleEmail() {
  const now = new Date();
  const changes = [
    {
      plan: "Pro",
      field: "price",
      old: 20,
      new: 25,
      type: "price_change",
      currency: "USD",
      billing: "monthly",
    },
  ];
  return {
    type: "price_alert",
    site: DEFAULT_SITE,
    pricing_url: DEFAULT_URL,
    customer_name: "Dvir",
    timestamp: now.toISOString(),
    changes,
    subject: "Pro $20 → $25 · vercel.com",
    preview: "Pro price increased from $20 to $25.",
    from: "PriceWatch <alerts@pricewatch.app>",
    to: "you@company.com",
    unread: true,
    body_lines: [
      "Hi Dvir,",
      "",
      "We detected a pricing change on vercel.com.",
      "",
      "Pro price increased from $20 to $25.",
      "",
      "Open pricing page: https://vercel.com/pricing",
      "",
      `Detected ${formatJerusalemTime(now)}.`,
      "",
      "Questions? Reply to this email or write price.watcher.service@gmail.com.",
      "",
      "— PriceWatch",
    ],
    table: [{ plan: "Pro", was: "$20/mo", now: "$25/mo" }],
  };
}

function emailFromOutbox(emailJson) {
  const changes = emailJson.changes || [];
  const table = changes
    .filter((c) => c.type === "price_change" && c.field === "price")
    .map((c) => ({
      plan: c.plan,
      was: formatPrice(c.old) + (c.billing === "monthly" ? "/mo" : ""),
      now: formatPrice(c.new) + (c.billing === "monthly" ? "/mo" : ""),
    }));

  if (table.length === 0) {
    for (const c of changes) {
      if (c.type === "plan_added") {
        table.push({ plan: c.plan, was: "—", now: formatPrice(c.newPrice) });
      } else if (c.type === "plan_removed") {
        table.push({ plan: c.plan, was: formatPrice(c.oldPrice), now: "—" });
      } else {
        table.push({
          plan: c.plan,
          was: String(c.old ?? "—"),
          now: String(c.new ?? "—"),
        });
      }
    }
  }

  const priceChange = changes.find((c) => c.type === "price_change" && c.field === "price");
  const subject = priceChange
    ? `${priceChange.plan} $${priceChange.old} → $${priceChange.new} · ${emailJson.site}`
    : emailJson.subject;

  return {
    type: "price_alert",
    site: emailJson.site,
    pricing_url: emailJson.pricing_url,
    customer_name: emailJson.customer_name,
    timestamp: emailJson.timestamp,
    changes,
    subject,
    preview: buildSummaryLine(changes),
    from: "PriceWatch <alerts@pricewatch.app>",
    to: emailJson.customer_email || "you@company.com",
    unread: true,
    body_lines: (emailJson.body || "").split("\n"),
    table,
  };
}

function resolvePlans(url) {
  const site = siteFromUrl(url);
  const snap = loadLadderSnapshot(site);
  if (snap && snap.plans && snap.plans.length) {
    return { site, plans: snap.plans, source: "snapshot" };
  }
  if (site === DEFAULT_SITE) {
    return { site, plans: FIXTURE_PLANS, source: "fixture" };
  }
  return null;
}

async function readPlans(url) {
  const site = siteFromUrl(url);
  try {
    const result = await extractPlanLadder(url);
    if (result.plans && result.plans.length > 0) {
      saveLadderSnapshot(site, result.plans);
      return { site, url, plans: result.plans, source: "live", wallMs: result.wallMs };
    }
  } catch {
    /* fall through */
  }
  const fallback = resolvePlans(url);
  if (fallback) {
    return { site: fallback.site, url, plans: fallback.plans, source: fallback.source, wallMs: 0 };
  }
  return { site, url, plans: null, source: null, error: "Could not read pricing plans for this page." };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function bumpPlans(plans, planName, delta) {
  return plans.map((p) => {
    if (p.plan.toLowerCase() !== planName.toLowerCase()) return { ...p };
    if (p.price === null || p.price === undefined) return { ...p };
    return { ...p, price: p.price + delta };
  });
}

function renderPage() {
  const sample = buildSampleEmail();
  const sampleJson = JSON.stringify(sample).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PriceWatch</title>
  <style>
    :root {
      --bg: #07080c;
      --panel: #0f1117;
      --panel-2: #151822;
      --border: #262a36;
      --text: #f2f3f7;
      --muted: #9aa3b5;
      --dim: #6b7385;
      --accent: #6d7cff;
      --accent-2: #8b97ff;
      --good: #3ecf8e;
      --warn: #f0b429;
      --danger: #ff6b6b;
      --mail: #111318;
      --mail-row: #181b24;
      --mail-open: #1c2030;
      --radius: 14px;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      overflow: hidden;
    }
    .app {
      display: grid;
      grid-template-columns: minmax(380px, 42%) 1fr;
      height: 100vh;
      gap: 0;
    }
    /* view=inbox: workbench is display:none (out of grid), so use a single 1fr column.
       Using "0 1fr" left .inbox in the zero-width track and collapsed the hero. */
    body.view-inbox .app {
      grid-template-columns: 1fr;
      height: 100vh;
      width: 100%;
    }
    body.view-inbox .workbench { display: none; }
    body.view-inbox .inbox {
      width: 100%;
      min-width: 0;
      height: 100vh;
    }
    body.view-inbox .inbox-body {
      grid-template-columns: minmax(280px, 28%) 1fr;
      min-height: 0;
      flex: 1;
    }
    body.view-inbox .mail-open {
      min-width: 0;
      width: auto;
    }
    body.view-inbox .msg-subject { font-size: 2.1rem; }
    body.view-inbox .change-table { font-size: 1.45rem; }
    body.view-inbox .change-table td.plan { font-size: 1.55rem; }
    body.view-inbox .change-table td.now { font-size: 1.7rem; }

    /* ── Workbench ── */
    .workbench {
      border-right: 1px solid var(--border);
      background: linear-gradient(180deg, #0c0e14 0%, #090a0f 100%);
      padding: 28px 28px 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      overflow: auto;
    }
    .brand {
      display: flex; align-items: center; gap: 12px;
    }
    .brand-mark {
      width: 36px; height: 36px; border-radius: 10px;
      background: linear-gradient(135deg, #6d7cff, #3b4de8);
      display: grid; place-items: center;
      font-weight: 800; font-size: 1.05rem; color: #fff;
      letter-spacing: -0.02em;
    }
    .brand h1 { font-size: 1.35rem; font-weight: 700; letter-spacing: -0.02em; }
    .brand .tag { color: var(--dim); font-size: 0.85rem; margin-top: 2px; }

    .step-label {
      font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase; color: var(--dim); margin-bottom: 8px;
    }
    .url-row { display: flex; gap: 10px; }
    .url-row input {
      flex: 1; background: var(--panel-2); border: 1px solid var(--border);
      color: var(--text); border-radius: 12px; padding: 14px 16px;
      font-size: 1.05rem; outline: none;
    }
    .url-row input:focus { border-color: var(--accent); }
    .btn {
      border: none; border-radius: 12px; padding: 14px 18px;
      font-size: 1rem; font-weight: 650; cursor: pointer;
      transition: transform 0.08s ease, background 0.15s ease, opacity 0.15s;
      white-space: nowrap;
    }
    .btn:active { transform: scale(0.98); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover:not(:disabled) { background: var(--accent-2); }
    .btn-ghost {
      background: var(--panel-2); color: var(--text);
      border: 1px solid var(--border);
    }
    .btn-ghost:hover:not(:disabled) { border-color: #3a4154; }
    .btn-bump { background: #243056; color: #c9d2ff; border: 1px solid #3a4a7a; }
    .btn-bump:hover:not(:disabled) { background: #2d3c68; }
    .btn-quiet { background: #1a2220; color: #9fd6b8; border: 1px solid #2a3d34; }
    .btn-quiet:hover:not(:disabled) { background: #22302b; }

    .plans-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      flex: 1;
      min-height: 220px;
      display: flex; flex-direction: column;
    }
    .plans-head {
      padding: 14px 18px; border-bottom: 1px solid var(--border);
      display: flex; justify-content: space-between; align-items: center;
    }
    .plans-head h2 { font-size: 1.05rem; font-weight: 650; }
    .chip {
      display: inline-flex; align-items: center; gap: 6px;
      background: #1a2033; color: var(--accent-2);
      border-radius: 999px; padding: 6px 12px;
      font-size: 0.85rem; font-weight: 600;
    }
    .chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); }
    .plans-empty {
      flex: 1; display: grid; place-items: center; color: var(--dim);
      font-size: 1.05rem; padding: 32px; text-align: center; line-height: 1.5;
    }
    .plan-table { width: 100%; border-collapse: collapse; }
    .plan-table th {
      text-align: left; font-size: 0.75rem; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--dim);
      padding: 10px 16px; border-bottom: 1px solid var(--border);
      font-weight: 650;
    }
    .plan-row {
      cursor: pointer; transition: background 0.12s;
    }
    .plan-row:hover { background: rgba(109,124,255,0.06); }
    .plan-row.selected { background: rgba(109,124,255,0.14); }
    .plan-row.dimmed { opacity: 0.55; }
    .plan-row td {
      padding: 16px; border-bottom: 1px solid #1c2030;
      font-size: 1.12rem; vertical-align: middle;
    }
    .plan-row td.name { font-weight: 700; font-size: 1.18rem; }
    .plan-row td.price { font-weight: 750; color: var(--accent-2); font-size: 1.25rem; }
    .plan-row td.unit { color: var(--muted); font-size: 0.98rem; }
    .check {
      width: 22px; height: 22px; border-radius: 7px;
      border: 2px solid #3a4154; display: grid; place-items: center;
      background: transparent; color: transparent; font-size: 0.85rem; font-weight: 800;
    }
    .plan-row.selected .check {
      background: var(--accent); border-color: var(--accent); color: #fff;
    }
    .watch-actions { display: flex; gap: 10px; padding: 14px 16px; border-top: 1px solid var(--border); }
    .sim-actions {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
    }
    .status-line {
      min-height: 1.4em; color: var(--muted); font-size: 0.95rem;
    }
    .status-line.ok { color: var(--good); }
    .status-line.warn { color: var(--warn); }
    .status-line.err { color: var(--danger); }

    /* ── Inbox hero ── */
    .inbox {
      background: #0a0b10;
      display: flex; flex-direction: column;
      min-width: 0;
      position: relative;
    }
    .inbox-chrome {
      padding: 18px 28px 12px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      background: #0d0f16;
    }
    .inbox-chrome .title {
      font-size: 1.45rem; font-weight: 700; letter-spacing: -0.02em;
      display: flex; align-items: center; gap: 12px;
    }
    .inbox-chrome .badge {
      background: #2a1f12; color: var(--warn);
      font-size: 0.78rem; font-weight: 700; padding: 4px 10px;
      border-radius: 999px; letter-spacing: 0.04em;
    }
    .inbox-chrome .hint { color: var(--dim); font-size: 0.9rem; }
    .inbox-body {
      flex: 1; display: grid;
      grid-template-columns: minmax(240px, 32%) 1fr;
      min-height: 0;
    }
    body.view-inbox .inbox-body {
      grid-template-columns: minmax(280px, 28%) 1fr;
    }
    .mail-list {
      border-right: 1px solid var(--border);
      overflow: auto; background: var(--mail);
      padding: 10px;
    }
    .mail-item {
      border-radius: 12px; padding: 16px 14px; cursor: pointer;
      border: 1px solid transparent; margin-bottom: 6px;
      background: var(--mail-row);
    }
    .mail-item:hover { border-color: #2e3444; }
    .mail-item.active { border-color: #3d4a74; background: var(--mail-open); }
    .mail-item.unread .mail-from { font-weight: 750; }
    .mail-item .mail-from {
      font-size: 1.05rem; display: flex; justify-content: space-between;
      margin-bottom: 4px;
    }
    .mail-item .mail-time { color: var(--dim); font-size: 0.82rem; font-weight: 500; }
    .mail-item .mail-subj {
      font-size: 1.15rem; font-weight: 650; margin-bottom: 4px;
      letter-spacing: -0.01em;
    }
    .mail-item .mail-prev { color: var(--muted); font-size: 0.95rem; line-height: 1.35; }
    .mail-item .unread-dot {
      width: 9px; height: 9px; border-radius: 50%; background: var(--accent);
      display: inline-block; margin-right: 8px;
    }
    .mail-empty {
      color: var(--dim); text-align: center; padding: 48px 20px;
      font-size: 1.1rem; line-height: 1.5;
    }
    .mail-empty .big {
      font-size: 1.35rem; color: var(--good); font-weight: 700;
      margin-bottom: 8px;
    }

    .mail-open {
      overflow: auto; padding: 28px 36px 40px;
      background: radial-gradient(1200px 500px at 70% -10%, #161a2a 0%, #0a0b10 55%);
    }
    .mail-open.empty {
      display: grid; place-items: center; color: var(--dim);
      font-size: 1.2rem; text-align: center; line-height: 1.55;
    }
    .msg-meta { margin-bottom: 28px; }
    .msg-subject {
      font-size: 2rem; font-weight: 750; letter-spacing: -0.03em;
      line-height: 1.2; margin-bottom: 18px;
    }
    .msg-from-row {
      display: flex; gap: 14px; align-items: center;
      color: var(--muted); font-size: 1.05rem;
    }
    .avatar {
      width: 44px; height: 44px; border-radius: 12px;
      background: linear-gradient(135deg, #6d7cff, #3b4de8);
      display: grid; place-items: center; color: #fff;
      font-weight: 800; font-size: 1.1rem; flex-shrink: 0;
    }
    .msg-from strong { color: var(--text); font-size: 1.12rem; }
    .msg-to { color: var(--dim); font-size: 0.92rem; margin-top: 2px; }

    .change-card {
      background: #12151f;
      border: 1px solid #2a3144;
      border-radius: 16px;
      padding: 8px; margin: 22px 0 28px;
      box-shadow: 0 18px 50px rgba(0,0,0,0.35);
    }
    .change-table {
      width: 100%; border-collapse: collapse;
      font-size: 1.35rem;
    }
    .change-table th {
      text-align: left; padding: 14px 20px 10px;
      color: var(--dim); font-size: 0.82rem;
      letter-spacing: 0.08em; text-transform: uppercase; font-weight: 700;
    }
    .change-table td {
      padding: 18px 20px; border-top: 1px solid #242a3a;
      font-weight: 650;
    }
    .change-table td.plan { font-size: 1.45rem; }
    .change-table td.was { color: var(--muted); text-decoration: line-through; text-decoration-thickness: 2px; }
    .change-table td.now { color: var(--good); font-size: 1.55rem; font-weight: 800; }

    .msg-body {
      font-size: 1.18rem; line-height: 1.65; color: #d5dae6;
      white-space: pre-wrap; max-width: 46rem;
    }
    .msg-footer {
      margin-top: 28px; padding-top: 18px; border-top: 1px solid var(--border);
      color: var(--dim); font-size: 0.95rem; line-height: 1.55;
    }

    .trust-banner {
      display: none;
      margin: 16px 28px 0;
      padding: 16px 18px;
      border-radius: 12px;
      background: #12201a;
      border: 1px solid #2a4638;
      color: #9fd6b8;
      font-size: 1.1rem; font-weight: 600;
    }
    .trust-banner.show { display: block; }

    @media (max-width: 980px) {
      body:not(.view-inbox) { overflow: auto; }
      body:not(.view-inbox) .app { grid-template-columns: 1fr; height: auto; min-height: 100vh; }
      body:not(.view-inbox) .inbox { min-height: 70vh; }
      body:not(.view-inbox) .inbox-body { grid-template-columns: 1fr; }
      body:not(.view-inbox) .mail-list { max-height: 220px; border-right: none; border-bottom: 1px solid var(--border); }
      .msg-subject { font-size: 1.55rem; }
      .change-table { font-size: 1.15rem; }
      body.view-inbox .msg-subject { font-size: 2rem; }
      body.view-inbox .change-table { font-size: 1.35rem; }
    }
  </style>
</head>
<body>
  <div class="app" id="app">
    <section class="workbench" id="workbench" aria-label="PriceWatch workbench">
      <div class="brand">
        <div class="brand-mark">P</div>
        <div>
          <h1>PriceWatch</h1>
          <div class="tag">Competitor prices — in your inbox</div>
        </div>
      </div>

      <div>
        <div class="step-label">1 · Pricing page</div>
        <div class="url-row">
          <input id="urlInput" type="url" value="${esc(DEFAULT_URL)}" spellcheck="false" autocomplete="off">
          <button class="btn btn-primary" id="readBtn" type="button">Read plans</button>
        </div>
      </div>

      <div class="plans-card" id="plansCard">
        <div class="plans-head">
          <h2>Pricing plans</h2>
          <span class="chip" id="watchChip" hidden><span class="dot"></span><span id="watchChipText">Watching</span></span>
        </div>
        <div class="plans-empty" id="plansEmpty">Paste a pricing page we support, then tap <strong>Read plans</strong>.</div>
        <div id="plansWrap" hidden>
          <table class="plan-table">
            <thead>
              <tr><th></th><th>Plan</th><th>Price</th><th>Unit</th></tr>
            </thead>
            <tbody id="plansBody"></tbody>
          </table>
          <div class="watch-actions">
            <button class="btn btn-primary" id="watchSelectedBtn" type="button">Watch selected</button>
            <button class="btn btn-ghost" id="watchAllBtn" type="button">Watch all paid plans</button>
          </div>
        </div>
      </div>

      <div>
        <div class="step-label">2 · Simulate a morning check</div>
        <div class="sim-actions">
          <button class="btn btn-bump" id="bumpBtn" type="button" disabled>Simulate price bump</button>
          <button class="btn btn-quiet" id="bannerBtn" type="button" disabled>Simulate banner-only</button>
        </div>
        <div style="margin-top:10px">
          <button class="btn btn-ghost" id="resetBtn" type="button" style="width:100%">Reset demo</button>
        </div>
        <p class="status-line" id="statusLine" style="margin-top:12px"></p>
      </div>
    </section>

    <section class="inbox" id="inbox" aria-label="Inbox preview">
      <div class="inbox-chrome">
        <div class="title">Inbox <span class="badge" id="inboxBadge">1 unread</span></div>
        <div class="hint">PriceWatch alerts</div>
      </div>
      <div class="trust-banner" id="trustBanner">No price changes — banner/copy edits stay quiet.</div>
      <div class="inbox-body">
        <div class="mail-list" id="mailList"></div>
        <div class="mail-open" id="mailOpen"></div>
      </div>
    </section>
  </div>

  <script>
    const SAMPLE_EMAIL = ${sampleJson};
    const state = {
      url: ${JSON.stringify(DEFAULT_URL)},
      site: ${JSON.stringify(DEFAULT_SITE)},
      plans: [],
      selected: new Set(["Pro"]),
      mode: "selected",
      watching: false,
      emails: [],
      activeId: null,
      trust: false,
    };

    const $ = (id) => document.getElementById(id);

    function applyViewMode() {
      const params = new URLSearchParams(location.search);
      const view = params.get("view");
      const demo = params.get("demo");
      if (view === "inbox" || view === "email") {
        document.body.classList.add("view-inbox");
      }
      // Default idle = preload sample. opt-out with ?demo=fresh
      if (demo !== "fresh") {
        preloadSample();
      } else {
        renderInbox();
      }
    }

    function preloadSample() {
      state.emails = [{ id: "sample", ...SAMPLE_EMAIL }];
      state.activeId = "sample";
      state.trust = false;
      state.watching = false;
      syncSimControls();
      updateWatchChip();
      renderInbox();
      setStatus("Sample alert ready — inbox is the hero.", "ok");
    }

    function setStatus(msg, kind) {
      const el = $("statusLine");
      el.textContent = msg || "";
      el.className = "status-line" + (kind ? " " + kind : "");
    }

    function formatPrice(p) {
      if (p === null || p === undefined) return "Custom";
      return "$" + p;
    }

    function renderPlans() {
      const empty = $("plansEmpty");
      const wrap = $("plansWrap");
      const body = $("plansBody");
      if (!state.plans.length) {
        empty.hidden = false;
        wrap.hidden = true;
        return;
      }
      empty.hidden = true;
      wrap.hidden = false;
      body.innerHTML = state.plans.map((p) => {
        const selected = state.selected.has(p.plan);
        const isPaid = p.price !== null && p.price > 0;
        const cls = ["plan-row", selected ? "selected" : "", !isPaid && !selected ? "dimmed" : ""].filter(Boolean).join(" ");
        const unit = p.unit ? p.unit : (p.billing === "free" ? "Free" : p.billing === "custom" ? "Custom" : "—");
        return '<tr class="' + cls + '" data-plan="' + escapeAttr(p.plan) + '">' +
          '<td><div class="check">✓</div></td>' +
          '<td class="name">' + escapeHtml(p.plan) + '</td>' +
          '<td class="price">' + escapeHtml(formatPrice(p.price)) + '</td>' +
          '<td class="unit">' + escapeHtml(unit) + '</td>' +
          '</tr>';
      }).join("");
      body.querySelectorAll(".plan-row").forEach((row) => {
        row.addEventListener("click", () => {
          const name = row.getAttribute("data-plan");
          if (state.selected.has(name)) state.selected.delete(name);
          else state.selected.add(name);
          state.mode = "selected";
          renderPlans();
          updateWatchChip();
        });
      });
      updateWatchChip();
      syncSimControls();
    }

    function syncSimControls() {
      const ready = state.plans.length > 0;
      $("bumpBtn").disabled = !ready;
      $("bannerBtn").disabled = !ready;
    }

    function updateWatchChip() {
      const chip = $("watchChip");
      const text = $("watchChipText");
      // Only show Watching after an explicit watch from a loaded plan list
      if (!state.watching || !state.plans.length) {
        chip.hidden = true;
        return;
      }
      chip.hidden = false;
      if (state.mode === "all_paid") text.textContent = "Watching: all paid plans";
      else text.textContent = "Watching: " + Array.from(state.selected).join(", ");
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }
    function escapeAttr(s) {
      return escapeHtml(s).replace(/"/g, "&quot;");
    }

    function timeLabel(iso) {
      try {
        const d = new Date(iso);
        return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      } catch { return ""; }
    }

    function renderInbox() {
      const list = $("mailList");
      const open = $("mailOpen");
      const badge = $("inboxBadge");
      const trust = $("trustBanner");

      trust.classList.toggle("show", !!state.trust);

      const unread = state.emails.filter((e) => e.unread).length;
      badge.textContent = unread ? (unread + " unread") : "Up to date";
      badge.style.display = "inline-block";
      if (!unread) {
        badge.style.background = "#12201a";
        badge.style.color = "#9fd6b8";
      } else {
        badge.style.background = "#2a1f12";
        badge.style.color = "#f0b429";
      }

      if (!state.emails.length) {
        list.innerHTML = '<div class="mail-empty"><div class="big">No price changes</div>Banner and copy edits stay quiet.</div>';
        open.className = "mail-open empty";
        open.innerHTML = "Inbox is clear.<br>We’ll email you when a watched plan’s price moves.";
        return;
      }

      list.innerHTML = state.emails.map((e) => {
        const active = e.id === state.activeId ? " active" : "";
        const unreadCls = e.unread ? " unread" : "";
        return '<div class="mail-item' + active + unreadCls + '" data-id="' + e.id + '">' +
          '<div class="mail-from">' +
            '<span>' + (e.unread ? '<span class="unread-dot"></span>' : '') + escapeHtml((e.from || "PriceWatch").split("<")[0].trim()) + '</span>' +
            '<span class="mail-time">' + escapeHtml(timeLabel(e.timestamp)) + '</span>' +
          '</div>' +
          '<div class="mail-subj">' + escapeHtml(e.subject) + '</div>' +
          '<div class="mail-prev">' + escapeHtml(e.preview || "") + '</div>' +
        '</div>';
      }).join("");

      list.querySelectorAll(".mail-item").forEach((el) => {
        el.addEventListener("click", () => {
          state.activeId = el.getAttribute("data-id");
          const mail = state.emails.find((m) => m.id === state.activeId);
          if (mail) mail.unread = false;
          renderInbox();
        });
      });

      const mail = state.emails.find((m) => m.id === state.activeId) || state.emails[0];
      if (!mail) return;
      open.className = "mail-open";
      const rows = (mail.table || []).map((r) =>
        '<tr><td class="plan">' + escapeHtml(r.plan) + '</td>' +
        '<td class="was">' + escapeHtml(r.was) + '</td>' +
        '<td class="now">' + escapeHtml(r.now) + '</td></tr>'
      ).join("");

      const bodyText = (mail.body_lines || [])
        .filter((line) => {
          // Hide ascii table lines — we render a real table instead
          if (/^\\s*Plan\\s+\\|/.test(line)) return false;
          if (/^-{3,}/.test(line.trim()) || /\\|\\s*-+/.test(line)) return false;
          if (/^\\s+\\w+\\s+\\|\\s+\\w+/.test(line)) return false;
          return true;
        })
        .join("\\n")
        .trim();

      open.innerHTML =
        '<div class="msg-meta">' +
          '<div class="msg-subject">' + escapeHtml(mail.subject) + '</div>' +
          '<div class="msg-from-row">' +
            '<div class="avatar">P</div>' +
            '<div><strong>' + escapeHtml((mail.from || "PriceWatch").split("<")[0].trim()) + '</strong>' +
            '<div class="msg-to">to ' + escapeHtml(mail.to || "you") + '</div></div>' +
          '</div>' +
        '</div>' +
        (rows
          ? '<div class="change-card"><table class="change-table"><thead><tr><th>Plan</th><th>Was</th><th>Now</th></tr></thead><tbody>' +
            rows + '</tbody></table></div>'
          : '') +
        '<div class="msg-body">' + escapeHtml(bodyText) + '</div>' +
        '<div class="msg-footer">Daily check · morning Israel time · price moves only</div>';
    }

    async function post(path, payload) {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      return data;
    }

    $("readBtn").addEventListener("click", async () => {
      const url = $("urlInput").value.trim();
      if (!url) return;
      setStatus("Reading pricing plans…");
      $("readBtn").disabled = true;
      try {
        const data = await post("/api/read-plans", { url });
        state.url = data.url;
        state.site = data.site;
        state.plans = data.plans || [];
        state.selected = new Set(
          state.plans.filter((p) => p.price !== null && p.price > 0).map((p) => p.plan)
        );
        if (state.selected.size === 0 && state.plans[0]) state.selected.add(state.plans[0].plan);
        state.watching = false;
        state.trust = false;
        renderPlans();
        setStatus("Found " + state.plans.length + " plans. Tap a plan to watch.", "ok");
      } catch (err) {
        setStatus(err.message || "Could not read plans", "err");
      } finally {
        $("readBtn").disabled = false;
      }
    });

    async function saveWatch(mode) {
      if (!state.plans.length) return;
      const plans = mode === "all_paid"
        ? state.plans.filter((p) => p.price !== null && p.price > 0).map((p) => p.plan)
        : Array.from(state.selected);
      if (mode === "selected" && plans.length === 0) {
        setStatus("Select at least one plan.", "warn");
        return;
      }
      if (mode === "all_paid") {
        state.selected = new Set(plans);
      }
      state.mode = mode;
      await post("/api/watch", { site: state.site, plans, mode });
      state.watching = true;
      renderPlans();
      setStatus(mode === "all_paid" ? "Watching all paid plans." : ("Watching: " + plans.join(", ")), "ok");
    }

    $("watchSelectedBtn").addEventListener("click", () => saveWatch("selected"));
    $("watchAllBtn").addEventListener("click", () => saveWatch("all_paid"));

    $("bumpBtn").addEventListener("click", async () => {
      setStatus("Simulating price bump…");
      try {
        if (!state.watching) await saveWatch(state.mode || "selected");
        const data = await post("/api/simulate/bump", {
          site: state.site,
          url: state.url,
          plan: Array.from(state.selected)[0] || "Pro",
          delta: 5,
        });
        state.trust = false;
        const email = { id: "bump-" + Date.now(), ...data.email, unread: true };
        state.emails = [email, ...state.emails.filter((e) => e.id !== "sample")];
        state.activeId = email.id;
        if (data.plans) {
          state.plans = data.plans;
          renderPlans();
        }
        renderInbox();
        setStatus("Price change → email ready in inbox.", "ok");
      } catch (err) {
        setStatus(err.message || "Simulate failed", "err");
      }
    });

    $("bannerBtn").addEventListener("click", async () => {
      setStatus("Simulating banner-only change…");
      try {
        const data = await post("/api/simulate/banner", { site: state.site });
        state.trust = true;
        // Keep existing emails but show trust state; for demo clarity, clear unread sample noise
        state.emails = state.emails.map((e) => ({ ...e, unread: false }));
        renderInbox();
        setStatus(data.message || "No price changes — no email.", "ok");
      } catch (err) {
        setStatus(err.message || "Simulate failed", "err");
      }
    });

    $("resetBtn").addEventListener("click", async () => {
      setStatus("Resetting demo…");
      try {
        const data = await post("/api/reset-demo", {});
        state.plans = data.plans || [];
        state.selected = new Set(["Pro"]);
        state.mode = "selected";
        state.watching = false;
        state.trust = false;
        state.url = data.url || state.url;
        state.site = data.site || state.site;
        if (data.email) {
          state.emails = [{ id: "sample", ...data.email, unread: true }];
          state.activeId = "sample";
        } else {
          preloadSample();
        }
        renderPlans();
        renderInbox();
        setStatus("Demo reset — Pro $20 → $25 ready.", "ok");
      } catch (err) {
        setStatus(err.message || "Reset failed", "err");
      }
    });

    syncSimControls();
    applyViewMode();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(renderPage());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sample-email") {
    sendJson(res, 200, buildSampleEmail());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/read-plans") {
    try {
      const body = await readJson(req);
      const target = body.url || DEFAULT_URL;
      const result = await readPlans(target);
      if (!result.plans) {
        sendJson(res, 400, { error: result.error || "No pricing plans found" });
        return;
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Bad request" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/watch") {
    try {
      const body = await readJson(req);
      const site = body.site || DEFAULT_SITE;
      const mode = body.mode === "all_paid" ? "all_paid" : "selected";
      const plans = Array.isArray(body.plans) ? body.plans : [];
      const filePath = saveSelection(site, { plans, mode });
      sendJson(res, 200, { ok: true, site, mode, plans, filePath: path.basename(filePath) });
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Bad request" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/simulate/bump") {
    try {
      const body = await readJson(req);
      const site = body.site || DEFAULT_SITE;
      const pricingUrl = body.url || DEFAULT_URL;
      const planName = body.plan || "Pro";
      const delta = Number(body.delta) || BUMP_DELTA;

      // Demo record: always bump from canonical base so takes never drift ($20→$25→$30).
      const canonical =
        site === DEFAULT_SITE
          ? FIXTURE_PLANS
          : (resolvePlans(pricingUrl) || { plans: FIXTURE_PLANS }).plans;
      const oldPlans = canonical.map((p) => ({ ...p }));
      const newPlans = bumpPlans(oldPlans, planName, delta);
      const { changes, hasSignal } = diffPlanLadders(oldPlans, newPlans);

      let selection = loadSelection(site);
      if (!selection) {
        saveSelection(site, { mode: "selected", plans: [planName] });
        selection = loadSelection(site);
      }
      const filtered = filterBySelection(changes, selection);

      if (!hasSignal || filtered.length === 0) {
        sendJson(res, 200, {
          hasSignal: false,
          message: "No watched plan price changes.",
          email: null,
        });
        return;
      }

      const emailPath = writePlanLadderEmail(site, pricingUrl, filtered, {
        customerId: "demo",
        customerEmail: "you@company.com",
        customerName: "Dvir",
      });
      const emailJson = JSON.parse(fs.readFileSync(emailPath, "utf8"));
      // Snap back to canonical base after the write so the next bump stays on-story.
      saveLadderSnapshot(site, oldPlans.map((p) => ({ ...p })));

      sendJson(res, 200, {
        hasSignal: true,
        changes: filtered,
        email: emailFromOutbox(emailJson),
        plans: oldPlans,
        outbox: path.basename(emailPath),
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message || "Simulate failed" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset-demo") {
    try {
      const restored = FIXTURE_PLANS.map((p) => ({ ...p }));
      saveLadderSnapshot(DEFAULT_SITE, restored);
      saveSelection(DEFAULT_SITE, { mode: "selected", plans: ["Pro"] });
      sendJson(res, 200, {
        ok: true,
        site: DEFAULT_SITE,
        url: DEFAULT_URL,
        plans: restored,
        email: buildSampleEmail(),
        message: "Demo reset to Pro $20 → $25.",
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message || "Reset failed" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/simulate/banner") {
    sendJson(res, 200, {
      hasSignal: false,
      changes: [],
      email: null,
      message: "No price changes — banner/copy edits stay quiet.",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, product: "PriceWatch" });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// Bind is loopback for local ops only — never print the raw URL in sell console lines.
saveLadderSnapshot(
  DEFAULT_SITE,
  FIXTURE_PLANS.map((p) => ({ ...p }))
);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`PriceWatch demo UI ready (port ${PORT})`);
  console.log("Open demo UI fullscreen and hide the address bar for recording.");
  console.log("Cold open: inbox preloaded with sample Pro $20 → $25 alert.");
  console.log("Inbox-only frame: open demo UI with ?view=inbox (fullscreen).");
  console.log("Before a take: fresh process, or hit Reset demo so Pro stays $20 → $25.");
});
