#!/usr/bin/env node
"use strict";

/**
 * Service A — thin HTTP API for customer + WatchTarget management.
 *
 * Endpoints:
 *   POST /customers                         → create customer (Neon when pool set)
 *   POST /customers/:id/watch-targets       → create WatchTarget
 *   POST /watch-targets                     → create WatchTarget (body.customer_id)
 *   GET  /watch-targets/:id                 → WatchTarget by id
 *   GET  /customers/:id/watch-targets       → list WatchTargets for customer
 *   POST /customers/:id/competitors         → compat shim → WatchTarget surface=b2b
 *   GET  /customers/:id                     → customer + competitors + watch_targets
 *   GET  /customers                         → list customers
 *   GET  /jobs                              → list onboarding jobs
 *   GET  /jobs/:id                          → job detail
 *
 * Auth/billing: stubbed (no Stripe — out of scope for F2).
 * See docs/watch-target.md for competitor ↔ WatchTarget mapping.
 */
const http = require("http");
const customers = require("./customer-store");
const watchTargets = require("./watch-target-store");
const queue = require("./queue");

const PORT = parseInt(process.env.SERVICE_A_PORT || "3850", 10);
const HOST = process.env.SERVICE_A_HOST || "127.0.0.1";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2) + "\n");
}

function matchRoute(method, url) {
  const [path] = url.split("?");
  const parts = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

  if (method === "POST" && parts[0] === "customers" && parts.length === 1) {
    return { handler: "createCustomer" };
  }
  if (
    method === "POST" &&
    parts[0] === "customers" &&
    parts[2] === "competitors" &&
    parts.length === 3
  ) {
    return { handler: "addCompetitor", params: { id: parts[1] } };
  }
  if (
    method === "POST" &&
    parts[0] === "customers" &&
    parts[2] === "watch-targets" &&
    parts.length === 3
  ) {
    return { handler: "createWatchTargetForCustomer", params: { id: parts[1] } };
  }
  if (
    method === "GET" &&
    parts[0] === "customers" &&
    parts[2] === "watch-targets" &&
    parts.length === 3
  ) {
    return { handler: "listWatchTargets", params: { id: parts[1] } };
  }
  if (method === "POST" && parts[0] === "watch-targets" && parts.length === 1) {
    return { handler: "createWatchTarget" };
  }
  if (method === "GET" && parts[0] === "watch-targets" && parts.length === 2) {
    return { handler: "getWatchTarget", params: { id: parts[1] } };
  }
  if (method === "GET" && parts[0] === "customers" && parts.length === 2) {
    return { handler: "getCustomer", params: { id: parts[1] } };
  }
  if (method === "GET" && parts[0] === "customers" && parts.length === 1) {
    return { handler: "listCustomers" };
  }
  if (method === "GET" && parts[0] === "jobs" && parts.length === 2) {
    return { handler: "getJob", params: { id: parts[1] } };
  }
  if (method === "GET" && parts[0] === "jobs" && parts.length === 1) {
    return { handler: "listJobs" };
  }
  return null;
}

async function ensureCustomerExists(customerId) {
  const existing = await customers.getCustomer(customerId);
  if (existing) return existing;
  return null;
}

async function handleRequest(req, res) {
  const route = matchRoute(req.method, req.url);
  if (!route) {
    return json(res, 404, { error: "Not found" });
  }

  try {
    switch (route.handler) {
      case "createCustomer": {
        const body = await readBody(req);
        const customer = await customers.createCustomer({
          name: body.name,
          email: body.email,
        });
        console.log(`[A] Created customer ${customer.id}: ${customer.name}`);
        return json(res, 201, customer);
      }

      case "createWatchTargetForCustomer": {
        const body = await readBody(req);
        const result = await createWatchTargetInternal(route.params.id, body);
        return json(res, result.status, result.body);
      }

      case "createWatchTarget": {
        const body = await readBody(req);
        if (!body.customer_id) {
          return json(res, 400, { error: "customer_id is required" });
        }
        const result = await createWatchTargetInternal(body.customer_id, body);
        return json(res, result.status, result.body);
      }

      case "getWatchTarget": {
        if (!watchTargets.dbAvailable()) {
          return json(res, 503, {
            error: "DATABASE_URL not set — WatchTarget GET requires Neon",
          });
        }
        const wt = await watchTargets.getById(route.params.id);
        if (!wt) return json(res, 404, { error: "WatchTarget not found" });
        return json(res, 200, wt);
      }

      case "listWatchTargets": {
        const customer = await customers.getCustomer(route.params.id);
        if (!customer) return json(res, 404, { error: "Customer not found" });
        if (!watchTargets.dbAvailable()) {
          const fromFile = (customer.competitors || []).map((c) => ({
            id: c.id,
            customer_id: route.params.id,
            surface: "b2b",
            label: c.name,
            source_url: c.pricingUrl,
            target_description: c.targetPriceDescription,
            plan_key: null,
            skill_id: watchTargets.skillIdFromPath(c.skillPath),
            status: c.status,
            failure_count: 0,
            created_at: c.addedAt,
            updated_at: c.addedAt,
            _storage: "file",
          }));
          return json(res, 200, fromFile);
        }
        const list = await watchTargets.listByCustomer(route.params.id);
        return json(res, 200, list);
      }

      case "addCompetitor": {
        const body = await readBody(req);
        if (!body.target_price_description) {
          return json(res, 400, { error: "target_price_description is required" });
        }

        const result = await customers.addCompetitor(route.params.id, {
          name: body.name,
          pricingUrl: body.pricing_url,
          targetPriceDescription: body.target_price_description,
        });

        if (result.error === "customer_not_found") {
          return json(res, 404, { error: "Customer not found" });
        }
        if (result.error === "max_competitors_reached") {
          return json(res, 400, {
            error: `Maximum ${result.limit} competitors allowed`,
          });
        }

        const { competitor } = result;

        const enqueueResult = queue.enqueue({
          customerId: route.params.id,
          competitorId: competitor.id,
          competitorName: competitor.name,
          pricingUrl: competitor.pricingUrl,
          targetPriceDescription: competitor.targetPriceDescription,
        });

        console.log(
          `[A] Added competitor ${competitor.id} to customer ${route.params.id}` +
            (result.watchTarget ? " (WatchTarget surface=b2b)" : "") +
            (enqueueResult.created
              ? ` → job ${enqueueResult.job.id} enqueued`
              : ` → duplicate job skipped (existing: ${enqueueResult.job.id})`)
        );

        return json(res, 201, {
          competitor,
          watch_target: result.watchTarget || null,
          job: enqueueResult.job,
          job_created: enqueueResult.created,
        });
      }

      case "getCustomer": {
        const customer = await customers.getCustomer(route.params.id);
        if (!customer) {
          return json(res, 404, { error: "Customer not found" });
        }
        const jobs = queue.listJobs({ customerId: route.params.id });
        return json(res, 200, { ...customer, jobs });
      }

      case "listCustomers": {
        return json(res, 200, await customers.listCustomers());
      }

      case "getJob": {
        const job = queue.getJob(route.params.id);
        if (!job) {
          return json(res, 404, { error: "Job not found" });
        }
        return json(res, 200, job);
      }

      case "listJobs": {
        return json(res, 200, queue.listJobs());
      }

      default:
        return json(res, 404, { error: "Not found" });
    }
  } catch (e) {
    console.error("[A] Error:", e.message);
    return json(res, 500, { error: e.message });
  }
}

/**
 * Create WatchTarget without double-inserting via addCompetitor.
 */
async function createWatchTargetInternal(customerId, body) {
  const surface = body.surface || "b2b";
  const label = body.label || body.name;
  const source_url =
    body.source_url != null
      ? body.source_url
      : body.pricing_url != null
        ? body.pricing_url
        : null;
  const target_description =
    body.target_description || body.target_price_description;

  if (!label) {
    return { status: 400, body: { error: "label (or name) is required" } };
  }
  if (source_url == null) {
    return {
      status: 400,
      body: { error: "source_url (or pricing_url) is required" },
    };
  }
  if (!target_description) {
    return {
      status: 400,
      body: {
        error: "target_description (or target_price_description) is required",
      },
    };
  }

  const customer = await ensureCustomerExists(customerId);
  if (!customer) {
    return { status: 404, body: { error: "Customer not found" } };
  }

  if (!watchTargets.dbAvailable()) {
    // File-only: use competitor path (no Neon)
    const result = await customers.addCompetitor(customerId, {
      name: label,
      pricingUrl: source_url,
      targetPriceDescription: target_description,
    });
    if (result.error === "max_competitors_reached") {
      return {
        status: 400,
        body: { error: `Maximum ${result.limit} watch targets allowed` },
      };
    }
    const c = result.competitor;
    return {
      status: 201,
      body: {
        watch_target: {
          id: c.id,
          customer_id: customerId,
          surface,
          label: c.name,
          source_url: c.pricingUrl,
          target_description: c.targetPriceDescription,
          plan_key: body.plan_key || null,
          skill_id: null,
          status: c.status,
          failure_count: 0,
          created_at: c.addedAt,
          updated_at: c.addedAt,
          _storage: "file",
        },
      },
    };
  }

  // Ensure customer row in Neon (may only exist in file)
  await customers.neonUpsertCustomer({
    id: customer.id,
    name: customer.name,
    email: customer.email,
  });

  const created = await watchTargets.create({
    customer_id: customerId,
    surface,
    label,
    source_url,
    target_description,
    plan_key: body.plan_key || null,
    skill_id: body.skill_id || null,
    status: body.status || "pending_onboarding",
  });
  if (created.error === "max_watch_targets_reached") {
    return {
      status: 400,
      body: { error: `Maximum ${created.limit} watch targets allowed` },
    };
  }

  // Dual-write competitor into file JSON (same id) for Service B readers
  dualWriteCompetitorFile(customerId, customer, created.watchTarget);

  // Enqueue onboarding for b2b (same as competitor path)
  let enqueueResult = null;
  if (surface === "b2b") {
    enqueueResult = queue.enqueue({
      customerId,
      competitorId: created.watchTarget.id,
      competitorName: created.watchTarget.label,
      pricingUrl: created.watchTarget.source_url,
      targetPriceDescription: created.watchTarget.target_description,
    });
  }

  console.log(
    `[A] Created WatchTarget ${created.watchTarget.id} for customer ${customerId} surface=${surface}`
  );

  return {
    status: 201,
    body: {
      watch_target: created.watchTarget,
      job: enqueueResult ? enqueueResult.job : null,
      job_created: enqueueResult ? enqueueResult.created : false,
    },
  };
}

function dualWriteCompetitorFile(customerId, customerMeta, wt) {
  const fs = require("fs");
  const STORE_FILE = customers.STORE_FILE;
  let store = { customers: {} };
  try {
    if (fs.existsSync(STORE_FILE)) {
      store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    }
  } catch {
    store = { customers: {} };
  }
  if (!store.customers[customerId]) {
    store.customers[customerId] = {
      id: customerId,
      name: customerMeta.name || "Unnamed",
      email: customerMeta.email || null,
      check_interval: "daily",
      competitors: [],
      createdAt: new Date().toISOString(),
    };
  }
  const competitor = watchTargets.toCompetitorShape(wt);
  const list = store.customers[customerId].competitors;
  if (!list.find((c) => c.id === competitor.id)) {
    list.push(competitor);
  }
  fs.mkdirSync(require("path").dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2) + "\n");
}

const server = http.createServer(handleRequest);

server.listen(PORT, HOST, () => {
  console.log(`[Service A] listening on http://${HOST}:${PORT}/`);
  console.log(`  POST /customers                       → create customer`);
  console.log(`  POST /customers/:id/watch-targets      → create WatchTarget`);
  console.log(`  POST /watch-targets                    → create WatchTarget`);
  console.log(`  GET  /watch-targets/:id                → get WatchTarget`);
  console.log(`  GET  /customers/:id/watch-targets      → list WatchTargets`);
  console.log(`  POST /customers/:id/competitors        → shim → WatchTarget b2b`);
  console.log(`  GET  /customers/:id                    → customer detail`);
  console.log(`  GET  /customers                        → list customers`);
  console.log(`  GET  /jobs                             → list jobs`);
  console.log(`  GET  /jobs/:id                         → job detail`);
  console.log(
    `  Neon: ${watchTargets.dbAvailable() ? "authoritative" : "unavailable (file fallback)"}`
  );
});
