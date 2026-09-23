#!/usr/bin/env node
/**
 * PriceWatch lab site — controlled pricing page for MVP tests.
 * GET  /              → HTML with current single-plan price
 * GET  /price.json    → raw JSON (single plan)
 * POST /set-price     → {"amount": 39} updates single-plan price
 * GET  /pricing       → multi-plan HTML page (F4 intake tests)
 * GET  /plans.json    → raw JSON (multi-plan)
 * POST /set-plans     → update multi-plan data
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3847;
const PRICE_FILE = path.join(__dirname, "price.json");

function readPrice() {
  return JSON.parse(fs.readFileSync(PRICE_FILE, "utf8"));
}

function writePrice(data) {
  data.updated_at = new Date().toISOString();
  fs.writeFileSync(PRICE_FILE, JSON.stringify(data, null, 2) + "\n");
}

function renderHtml(p) {
  const display = `$${p.amount}/${p.period === "month" ? "mo" : p.period}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Acme Lab — Pricing</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 16px; color: #111; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 24px; }
    .price { font-size: 2.5rem; font-weight: 700; margin: 8px 0; }
    .muted { color: #666; }
    #plan-name { font-size: 1.25rem; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Acme Lab</h1>
  <p class="muted">Fake product page for PriceWatch automated tests. Not a real company.</p>
  <div class="card">
    <div id="plan-name">${p.product}</div>
    <div class="price" id="price" data-amount="${p.amount}" data-currency="${p.currency}" data-period="${p.period}">${display}</div>
    <p id="price-description">Main monthly subscription price for ${p.product}.</p>
    <ul>
      <li>Unlimited widgets</li>
      <li>Email support</li>
      <li>Cancel anytime</li>
    </ul>
  </div>
  <p class="muted" style="margin-top:24px;font-size:0.85rem;">Test control: POST /set-price {"amount":39} · GET /price.json</p>
</body>
</html>`;
}

const PLANS_FILE = path.join(__dirname, "plans.json");

function readPlans() {
  return JSON.parse(fs.readFileSync(PLANS_FILE, "utf8"));
}

function writePlans(data) {
  data.updated_at = new Date().toISOString();
  fs.writeFileSync(PLANS_FILE, JSON.stringify(data, null, 2) + "\n");
}

function renderMultiPlanHtml(data) {
  const cards = data.plans.map((p) => {
    const priceDisplay = p.price === null
      ? "Contact us"
      : `$${p.price}/${p.period === "month" ? "mo" : p.period}`;
    return `  <div class="plan-card" data-plan-key="${p.plan_key}">
    <h3 class="plan-name">${p.name}</h3>
    <div class="plan-price" data-amount="${p.price === null ? '' : p.price}" data-currency="${p.currency}" data-period="${p.period}">${priceDisplay}</div>
  </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Acme Lab — Plans and Prices</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 48px auto; padding: 0 16px; color: #111; }
    .plans-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
    .plan-card { border: 1px solid #ddd; border-radius: 12px; padding: 24px; text-align: center; }
    .plan-name { font-size: 1.25rem; font-weight: 600; margin: 0 0 8px; }
    .plan-price { font-size: 2rem; font-weight: 700; margin: 8px 0; }
    .muted { color: #666; }
  </style>
</head>
<body>
  <h1>Acme Lab — Plans and Prices</h1>
  <p class="muted">Multi-plan pricing page for PriceWatch F4 intake tests.</p>
  <div class="plans-grid">
${cards}
  </div>
  <p class="muted" style="margin-top:24px;font-size:0.85rem;">Test control: POST /set-plans · GET /plans.json</p>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
    const p = readPrice();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderHtml(p));
    return;
  }
  if (req.method === "GET" && req.url === "/price.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readPrice(), null, 2));
    return;
  }
  if (req.method === "GET" && req.url === "/pricing") {
    const data = readPlans();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderMultiPlanHtml(data));
    return;
  }
  if (req.method === "GET" && req.url === "/plans.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readPlans(), null, 2));
    return;
  }
  if (req.method === "POST" && req.url === "/set-plans") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const incoming = JSON.parse(body || "{}");
        const data = readPlans();
        if (Array.isArray(incoming.plans)) data.plans = incoming.plans;
        writePlans(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data, null, 2));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/set-price") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const incoming = JSON.parse(body || "{}");
        const p = readPrice();
        if (typeof incoming.amount === "number") p.amount = incoming.amount;
        if (incoming.product) p.product = incoming.product;
        if (incoming.currency) p.currency = incoming.currency;
        if (incoming.period) p.period = incoming.period;
        writePrice(p);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(p, null, 2));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

module.exports = { renderMultiPlanHtml, readPlans };

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`PriceWatch lab listening on http://127.0.0.1:${PORT}/`);
  });
}
