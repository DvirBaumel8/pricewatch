#!/usr/bin/env node
"use strict";

/**
 * Service A — thin HTTP API for customer + WatchTarget management.
 *
 * Public routes (no auth):
 *   GET  /health                            → health check
 *   POST /auth/login                        → Google OAuth login (or stub)
 *   POST /b2b/intake/preview                → intake preview (public, no auth)
 *
 * Protected routes (require Bearer JWT):
 *   GET  /auth/me                           → current user
 *   POST /auth/notify-email                 → set notify email
 *   POST /auth/verify-notify-email          → consume verify token
 *   POST /b2b/intake/confirm                → intake confirm (JWT + notify verified)
 *   POST /b2b/intake/selector               → fallback stub (501)
 *   POST /b2b/intake/manual-seed            → fallback stub (501)
 *   POST /customers                         → create customer
 *   POST /customers/:id/watch-targets       → create WatchTarget
 *   POST /watch-targets                     → create WatchTarget (body.customer_id)
 *   GET  /watch-targets/:id                 → WatchTarget by id
 *   GET  /customers/:id/watch-targets       → list WatchTargets for customer
 *   POST /customers/:id/competitors         → compat shim → WatchTarget surface=b2b
 *   GET  /customers/:id                     → customer + competitors + watch_targets
 *   GET  /customers                         → list customers
 *   GET  /jobs                              → list onboarding jobs
 *   GET  /jobs/:id                          → job detail
 *   GET  /b2c/slots                         → current user slot info
 *   POST /b2c/payment-stub                  → grant package (PAYMENT_STUB)
 *   GET  /product-offers                    → list active product offers
 *   POST /product-offers                    → create one product offer
 *   POST /product-offers/seed               → seed stub offers
 *
 * Public (no auth):
 *   GET  /r/:id                             → affiliate redirect (click log + 302)
 *
 * See docs/f5-auth.md for env vars, stub vs real OAuth, and route details.
 * See docs/f4-intake.md for intake preview/confirm details.
 * See docs/f6-b2c-stubs.md for B2C slot enforcement, payment stub, /r/:id.
 */
const http = require("http");
const customers = require("./customer-store");
const watchTargets = require("./watch-target-store");
const queue = require("./queue");
const auth = require("./auth");
const userStore = require("./user-store");
const intake = require("./intake");
const productOffers = require("./product-offer-store");
const slotStore = require("./slot-store");

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

const PUBLIC_HANDLERS = new Set(["health", "authLogin", "intakePreview", "affiliateRedirect"]);

const NOTIFY_GATED_HANDLERS = new Set([
  "createCustomer",
  "createWatchTargetForCustomer",
  "createWatchTarget",
  "addCompetitor",
  "intakeConfirm",
]);

function matchRoute(method, url) {
  const [pathStr] = url.split("?");
  const parts = pathStr.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

  if (method === "GET" && (parts.length === 0 || (parts.length === 1 && parts[0] === "health"))) {
    return { handler: "health" };
  }
  if (method === "POST" && parts[0] === "auth" && parts[1] === "login" && parts.length === 2) {
    return { handler: "authLogin" };
  }
  if (method === "GET" && parts[0] === "auth" && parts[1] === "me" && parts.length === 2) {
    return { handler: "authMe" };
  }
  if (method === "POST" && parts[0] === "auth" && parts[1] === "notify-email" && parts.length === 2) {
    return { handler: "setNotifyEmail" };
  }
  if (method === "POST" && parts[0] === "auth" && parts[1] === "verify-notify-email" && parts.length === 2) {
    return { handler: "verifyNotifyEmail" };
  }
  if (method === "POST" && parts[0] === "b2b" && parts[1] === "intake" && parts[2] === "preview" && parts.length === 3) {
    return { handler: "intakePreview" };
  }
  if (method === "POST" && parts[0] === "b2b" && parts[1] === "intake" && parts[2] === "confirm" && parts.length === 3) {
    return { handler: "intakeConfirm" };
  }
  if (method === "POST" && parts[0] === "b2b" && parts[1] === "intake" && parts[2] === "selector" && parts.length === 3) {
    return { handler: "intakeSelector" };
  }
  if (method === "POST" && parts[0] === "b2b" && parts[1] === "intake" && parts[2] === "manual-seed" && parts.length === 3) {
    return { handler: "intakeManualSeed" };
  }
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
  if (method === "GET" && parts[0] === "r" && parts.length === 2) {
    return { handler: "affiliateRedirect", params: { id: parts[1] } };
  }
  if (method === "GET" && parts[0] === "b2c" && parts[1] === "slots" && parts.length === 2) {
    return { handler: "b2cSlots" };
  }
  if (method === "POST" && parts[0] === "b2c" && parts[1] === "payment-stub" && parts.length === 2) {
    return { handler: "b2cPaymentStub" };
  }
  if (method === "GET" && parts[0] === "product-offers" && parts.length === 1) {
    return { handler: "listProductOffers" };
  }
  if (method === "POST" && parts[0] === "product-offers" && parts.length === 1) {
    return { handler: "createProductOffer" };
  }
  if (method === "POST" && parts[0] === "product-offers" && parts[1] === "seed" && parts.length === 2) {
    return { handler: "seedProductOffers" };
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
    await auth.extractUser(req);

    if (!PUBLIC_HANDLERS.has(route.handler) && !auth.getUser(req)) {
      return json(res, 401, { error: "Authentication required" });
    }

    if (NOTIFY_GATED_HANDLERS.has(route.handler)) {
      const user = auth.getUser(req);
      if (user && !userStore.isNotifyVerified(user)) {
        return json(res, 403, {
          error: "Notify email must be verified before creating watches",
          reason: "notify_email_unverified",
        });
      }
    }

    switch (route.handler) {
      case "health": {
        return json(res, 200, {
          status: "ok",
          service: "pricewatch-api",
          neon: watchTargets.dbAvailable() ? "connected" : "unavailable",
          auth_mode: auth.isStub() ? "stub" : "google",
        });
      }

      case "authLogin": {
        const body = await readBody(req);
        // Fail-closed structured errors (Wave 6 hosted login) — never opaque 500 from bare throw.
        if (!auth.isStub()) {
          if (!body || !body.code) {
            return json(res, 400, {
              error: "google_code_required",
              message:
                "Google authorization code is required. Pass { code } from the Google OAuth redirect.",
            });
          }
        } else if (!body.google_subject || !body.email) {
          return json(res, 400, {
            error: "stub_credentials_required",
            message: "AUTH_STUB mode requires body { google_subject, email }",
          });
        }
        try {
          const result = await auth.login(body);
          console.log(`[A] User login: ${result.user.id} (${result.user.email})`);
          return json(res, 200, { user: result.user, token: result.token });
        } catch (e) {
          return json(res, 400, {
            error: "auth_failed",
            message: e.message || "Authentication failed",
          });
        }
      }

      case "authMe": {
        const user = auth.getUser(req);
        return json(res, 200, {
          user,
          notify_verified: userStore.isNotifyVerified(user),
        });
      }

      case "setNotifyEmail": {
        const body = await readBody(req);
        const user = auth.getUser(req);
        if (!body.notify_email) {
          return json(res, 400, { error: "notify_email is required" });
        }

        const { user: updated, needsVerification } = await userStore.setNotifyEmail(
          user.id,
          body.notify_email
        );

        let verifyToken = null;
        if (needsVerification) {
          verifyToken = await userStore.createVerifyToken(user.id);
        }

        return json(res, 200, {
          user: updated,
          notify_verified: userStore.isNotifyVerified(updated),
          needs_verification: needsVerification,
          verify_token: verifyToken,
        });
      }

      case "verifyNotifyEmail": {
        const body = await readBody(req);
        if (!body.token) {
          return json(res, 400, { error: "token is required" });
        }

        const result = await userStore.consumeVerifyToken(body.token);
        if (!result.verified) {
          return json(res, 400, {
            error: "Verification failed",
            reason: result.reason,
          });
        }

        return json(res, 200, {
          verified: true,
          user: result.user,
          notify_verified: userStore.isNotifyVerified(result.user),
        });
      }

      case "intakePreview": {
        const body = await readBody(req);
        if (!body.url) {
          return json(res, 400, { error: "url is required" });
        }
        const result = await intake.preview(body.url, body.intent_text);
        if (result.error) {
          const status = result.error === "url_required" || result.error === "invalid_url" ? 400
            : result.error === "unsupported_site" ? 422
            : result.error === "fetch_failed" || result.error.startsWith("fetch_failed") ? 502
            : 422;
          return json(res, status, {
            error: result.error,
            url: result.url,
            site: result.site || null,
          });
        }
        return json(res, 200, {
          candidates: result.candidates,
          url: result.url,
          site: result.site,
          method: result.method,
          tokens: result.tokens,
        });
      }

      case "intakeConfirm": {
        const body = await readBody(req);
        if (!body.url) {
          return json(res, 400, { error: "url is required" });
        }
        if (!Array.isArray(body.selected) || body.selected.length === 0) {
          return json(res, 400, { error: "selected is required — must be an array of { plan_key }" });
        }
        if (!body.customer_id) {
          return json(res, 400, { error: "customer_id is required" });
        }

        const user = auth.getUser(req);

        const result = await intake.confirm(
          body.url,
          body.selected,
          user.id,
          body.customer_id
        );

        if (result.error) {
          const status = result.error === "customer_not_found" ? 404
            : result.error === "max_watch_targets_reached" ? 400
            : result.error === "unsupported_site" ? 422
            : result.error === "no_candidates" || result.error === "no_matching_plans" ? 422
            : 400;
          return json(res, status, { error: result.error, detail: result.detail });
        }

        console.log(`[A] Intake confirmed ${result.watch_targets.length} plan(s) for customer ${body.customer_id}`);

        return json(res, 201, {
          watch_targets: result.watch_targets,
          skills: result.skills,
          baselines: result.baselines,
          first_learn: result.first_learn,
        });
      }

      case "intakeSelector": {
        return json(res, 501, {
          error: "not_implemented",
          message: "Click-select fallback (POST /b2b/intake/selector) is not yet implemented. TODO: F4 fallback 1 — click the price on a preview.",
        });
      }

      case "intakeManualSeed": {
        return json(res, 501, {
          error: "not_implemented",
          message: "Manual seed fallback (POST /b2b/intake/manual-seed) is not yet implemented. TODO: F4 fallback 2 — type plan name + current price + currency + period.",
        });
      }

      case "createCustomer": {
        const body = await readBody(req);
        const user = auth.getUser(req);
        const customer = await customers.createCustomer({
          name: body.name,
          email: body.email,
          user_id: user ? user.id : undefined,
        });
        console.log(`[A] Created customer ${customer.id}: ${customer.name}`);
        return json(res, 201, customer);
      }

      case "createWatchTargetForCustomer": {
        const body = await readBody(req);
        const result = await createWatchTargetInternal(route.params.id, body, auth.getUser(req));
        return json(res, result.status, result.body);
      }

      case "createWatchTarget": {
        const body = await readBody(req);
        if (!body.customer_id) {
          return json(res, 400, { error: "customer_id is required" });
        }
        const result = await createWatchTargetInternal(body.customer_id, body, auth.getUser(req));
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

      case "affiliateRedirect": {
        const offerId = route.params.id;
        const offer = await productOffers.getById(offerId);
        if (!offer || !offer.active) {
          return json(res, 404, { error: "Product offer not found" });
        }
        const redirectUrl = offer.affiliate_url || offer.merchant_url;
        try {
          await productOffers.recordClick(offerId, {
            userId: auth.getUser(req) ? auth.getUser(req).id : null,
            ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
            userAgent: req.headers["user-agent"],
          });
        } catch (e) {
          console.error(`[A] Click log error for offer ${offerId}: ${e.message}`);
        }
        console.log(`[A] Redirect /r/${offerId} → ${redirectUrl}`);
        res.writeHead(302, { Location: redirectUrl });
        res.end();
        return;
      }

      case "b2cSlots": {
        const user = auth.getUser(req);
        const slotInfo = await slotStore.canCreateWatch(user.id);
        const packages = await slotStore.listPackages(user.id);
        return json(res, 200, { ...slotInfo, packages });
      }

      case "b2cPaymentStub": {
        if (process.env.PAYMENT_STUB !== "1" && process.env.NODE_ENV === "production") {
          return json(res, 403, {
            error: "Payment stub disabled in production. Set PAYMENT_STUB=1 for testing.",
          });
        }
        const body = await readBody(req);
        const user = auth.getUser(req);
        if (!body.package_type) {
          return json(res, 400, { error: "package_type is required (pkg_1, pkg_3, pkg_5, pkg_10, unlimited)" });
        }
        if (!slotStore.VALID_PACKAGE_TYPES.includes(body.package_type) || body.package_type === "free") {
          return json(res, 400, {
            error: `Invalid package_type "${body.package_type}"; valid purchasable: pkg_1, pkg_3, pkg_5, pkg_10, unlimited`,
          });
        }
        const pkg = await slotStore.grantPackage(user.id, body.package_type, "payment_stub");
        const slotInfo = await slotStore.canCreateWatch(user.id);
        console.log(`[A] Payment stub: granted ${body.package_type} to user ${user.id}`);
        return json(res, 201, { package: pkg, slots: slotInfo });
      }

      case "listProductOffers": {
        const offers = await productOffers.listActive();
        return json(res, 200, offers);
      }

      case "createProductOffer": {
        const body = await readBody(req);
        if (!body.merchant_url || !body.label) {
          return json(res, 400, {
            error: "merchant_url and label are required; disclosure defaults if omitted",
          });
        }
        if (!productOffers.dbAvailable()) {
          return json(res, 503, { error: "Neon required for ProductOffer create" });
        }
        const offer = await productOffers.create({
          id: body.id || undefined,
          merchant_url: body.merchant_url,
          affiliate_url: body.affiliate_url || null,
          affiliate_program_id: body.affiliate_program_id || null,
          disclosure: body.disclosure || productOffers.DEFAULT_DISCLOSURE,
          skill_id: body.skill_id || null,
          active: body.active !== false,
          label: body.label,
        });
        console.log(`[A] Created ProductOffer ${offer.id}`);
        return json(res, 201, offer);
      }

      case "seedProductOffers": {
        if (!productOffers.dbAvailable()) {
          return json(res, 503, { error: "Neon required for ProductOffer seed" });
        }
        const seeded = await productOffers.seedOffers();
        return json(res, 201, { seeded: seeded.length, offers: seeded });
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
async function createWatchTargetInternal(customerId, body, reqUser) {
  const surface = body.surface || "b2b";
  let label = body.label || body.name;
  let source_url =
    body.source_url != null
      ? body.source_url
      : body.pricing_url != null
        ? body.pricing_url
        : null;
  let target_description =
    body.target_description || body.target_price_description;
  let product_offer_id = body.product_offer_id || null;
  let skill_id = body.skill_id || null;

  // Wave 5: B2C catalog watch — fill from ProductOffer when linked.
  if (surface === "b2c" && product_offer_id && productOffers.dbAvailable()) {
    const offer = await productOffers.getById(product_offer_id);
    if (!offer || !offer.active) {
      return { status: 400, body: { error: "product_offer_id not found or inactive" } };
    }
    if (!label) label = offer.label;
    if (source_url == null) source_url = offer.merchant_url;
    if (!target_description) target_description = offer.label;
    if (!skill_id && offer.skill_id) skill_id = offer.skill_id;
  }

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

  if (surface === "b2c" && reqUser && slotStore.dbAvailable()) {
    const slotCheck = await slotStore.canCreateWatch(reqUser.id);
    if (!slotCheck.allowed) {
      return {
        status: 403,
        body: {
          error: "b2c_slots_exhausted",
          reason: slotCheck.reason,
          total_slots: slotCheck.total_slots,
          used_slots: slotCheck.used_slots,
          remaining: slotCheck.remaining,
        },
      };
    }
  }

  const customer = await ensureCustomerExists(customerId);
  if (!customer) {
    return { status: 404, body: { error: "Customer not found" } };
  }

  if (!watchTargets.dbAvailable()) {
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

  await customers.neonUpsertCustomer({
    id: customer.id,
    name: customer.name,
    email: customer.email,
    user_id: reqUser ? reqUser.id : null,
  });

  // Wave 6 hosted B2C catalog: known skill → skill_ready (self-serve, no ops plant).
  const status =
    body.status ||
    (surface === "b2c" && skill_id ? "skill_ready" : "pending_onboarding");

  const created = await watchTargets.create({
    customer_id: customerId,
    surface,
    label,
    source_url,
    target_description,
    plan_key: body.plan_key || null,
    skill_id: skill_id || null,
    product_offer_id: surface === "b2c" ? product_offer_id : null,
    status,
  });
  if (created.error === "max_watch_targets_reached") {
    return {
      status: 400,
      body: { error: `Maximum ${created.limit} watch targets allowed` },
    };
  }

  // Hosted path: persist skill + baseline to Neon before response (GHA must load without plant).
  if (surface === "b2c" && skill_id && watchTargets.dbAvailable()) {
    const skillStore = require("./skill-store");
    const ok = await skillStore.ensureSkillAndBaselineInNeon(skill_id);
    if (!ok) {
      console.error(
        `[A] B2C catalog create: could not ensure Neon skill/baseline for ${skill_id}`
      );
    }
  }

  dualWriteCompetitorFile(customerId, customer, created.watchTarget);

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

if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log(`[Service A] listening on http://${HOST}:${PORT}/`);
    console.log(`  GET  /health                          → health check (public)`);
    console.log(`  POST /auth/login                      → login (public)`);
    console.log(`  GET  /auth/me                         → current user`);
    console.log(`  POST /auth/notify-email               → set notify email`);
    console.log(`  POST /auth/verify-notify-email        → verify notify email`);
    console.log(`  POST /b2b/intake/preview               → intake preview (public)`);
    console.log(`  POST /b2b/intake/confirm               → intake confirm (auth+notify)`);
    console.log(`  POST /b2b/intake/selector              → selector stub (501)`);
    console.log(`  POST /b2b/intake/manual-seed           → manual-seed stub (501)`);
    console.log(`  POST /customers                       → create customer`);
    console.log(`  POST /customers/:id/watch-targets     → create WatchTarget`);
    console.log(`  POST /watch-targets                   → create WatchTarget`);
    console.log(`  GET  /watch-targets/:id               → get WatchTarget`);
    console.log(`  GET  /customers/:id/watch-targets     → list WatchTargets`);
    console.log(`  POST /customers/:id/competitors       → shim → WatchTarget b2b`);
    console.log(`  GET  /customers/:id                   → customer detail`);
    console.log(`  GET  /customers                       → list customers`);
    console.log(`  GET  /jobs                            → list jobs`);
    console.log(`  GET  /jobs/:id                        → job detail`);
    console.log(`  GET  /r/:id                           → affiliate redirect (public)`);
    console.log(`  GET  /b2c/slots                       → B2C slot info`);
    console.log(`  POST /b2c/payment-stub                → payment stub (test)`);
    console.log(`  GET  /product-offers                  → list product offers`);
    console.log(`  POST /product-offers                  → create product offer`);
    console.log(`  POST /product-offers/seed             → seed stub offers`);
    console.log(`  Auth: ${auth.isStub() ? "STUB (AUTH_STUB=1)" : "Google OAuth"}`);
    console.log(
      `  Neon: ${watchTargets.dbAvailable() ? "authoritative" : "unavailable (file fallback)"}`
    );
  });
}

module.exports = { handleRequest, matchRoute, PUBLIC_HANDLERS, createWatchTargetInternal };
