#!/usr/bin/env node
"use strict";

/**
 * Service A — thin HTTP API for customer + competitor management.
 *
 * Endpoints:
 *   POST /customers                    → create customer
 *   POST /customers/:id/competitors    → add competitor, enqueue onboarding
 *   GET  /customers/:id                → customer detail + competitors + skill/status
 *   GET  /customers                    → list all customers
 *   GET  /jobs                         → list all onboarding jobs
 *   GET  /jobs/:id                     → single job detail
 *
 * Auth/billing: stubbed (no Stripe yet — T4 out of scope).
 */

const http = require("http");
const customers = require("./customer-store");
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
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");

  if (method === "POST" && parts[0] === "customers" && parts.length === 1) {
    return { handler: "createCustomer" };
  }
  if (method === "POST" && parts[0] === "customers" && parts[2] === "competitors" && parts.length === 3) {
    return { handler: "addCompetitor", params: { id: parts[1] } };
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

async function handleRequest(req, res) {
  const route = matchRoute(req.method, req.url);
  if (!route) {
    return json(res, 404, { error: "Not found" });
  }

  try {
    switch (route.handler) {
      case "createCustomer": {
        const body = await readBody(req);
        const customer = customers.createCustomer({
          name: body.name,
          email: body.email,
        });
        console.log(`[A] Created customer ${customer.id}: ${customer.name}`);
        return json(res, 201, customer);
      }

      case "addCompetitor": {
        const body = await readBody(req);
        if (!body.target_price_description) {
          return json(res, 400, { error: "target_price_description is required" });
        }

        const result = customers.addCompetitor(route.params.id, {
          name: body.name,
          pricingUrl: body.pricing_url,
          targetPriceDescription: body.target_price_description,
        });

        if (result.error === "customer_not_found") {
          return json(res, 404, { error: "Customer not found" });
        }
        if (result.error === "max_competitors_reached") {
          return json(res, 400, { error: `Maximum ${result.limit} competitors allowed` });
        }

        const { competitor, customer } = result;

        const enqueueResult = queue.enqueue({
          customerId: route.params.id,
          competitorId: competitor.id,
          competitorName: competitor.name,
          pricingUrl: competitor.pricingUrl,
          targetPriceDescription: competitor.targetPriceDescription,
        });

        console.log(
          `[A] Added competitor ${competitor.id} to customer ${route.params.id}` +
            (enqueueResult.created
              ? ` → job ${enqueueResult.job.id} enqueued`
              : ` → duplicate job skipped (existing: ${enqueueResult.job.id})`)
        );

        return json(res, 201, {
          competitor,
          job: enqueueResult.job,
          job_created: enqueueResult.created,
        });
      }

      case "getCustomer": {
        const customer = customers.getCustomer(route.params.id);
        if (!customer) {
          return json(res, 404, { error: "Customer not found" });
        }
        const jobs = queue.listJobs({ customerId: route.params.id });
        return json(res, 200, { ...customer, jobs });
      }

      case "listCustomers": {
        return json(res, 200, customers.listCustomers());
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

const server = http.createServer(handleRequest);

server.listen(PORT, HOST, () => {
  console.log(`[Service A] listening on http://${HOST}:${PORT}/`);
  console.log(`  POST /customers                  → create customer`);
  console.log(`  POST /customers/:id/competitors   → add competitor + enqueue`);
  console.log(`  GET  /customers/:id               → customer detail`);
  console.log(`  GET  /customers                   → list customers`);
  console.log(`  GET  /jobs                        → list jobs`);
  console.log(`  GET  /jobs/:id                    → job detail`);
});
