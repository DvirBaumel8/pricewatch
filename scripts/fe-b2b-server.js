#!/usr/bin/env node
"use strict";

/**
 * Thin FE-B2B — static UI + optional reverse-proxy to Service A.
 *
 * Serves public/fe-b2b/ only. Browser JS calls Service A HTTP APIs
 * (same-origin via proxy, or SERVICE_A_URL directly). No second backend:
 * this process never imports intake / plan-ladder / customer-store.
 *
 * Usage:
 *   npm run fe-b2b
 *   node scripts/fe-b2b-server.js [--port 3920]
 *
 * Env:
 *   SERVICE_A_URL   default http://127.0.0.1:3850
 *   FE_B2B_PORT     default 3920 (or --port)
 *   FE_B2B_HOST     default 127.0.0.1
 *
 * Run Service A first (AUTH_STUB=1 for local/shame only):
 *   AUTH_STUB=1 npm run service-a
 *   npm run fe-b2b
 *
 * Live Google OAuth stays PARKED (Wave 6 Phase B). AUTH_STUB is test-only.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PROJECT_ROOT = path.join(__dirname, "..");
const STATIC_ROOT = path.join(PROJECT_ROOT, "public", "fe-b2b");

const PORT = parseInt(
  process.argv.find((_, i, a) => a[i - 1] === "--port") ||
    process.env.FE_B2B_PORT ||
    "3920",
  10
);
const HOST = process.env.FE_B2B_HOST || "127.0.0.1";
const SERVICE_A_URL = (process.env.SERVICE_A_URL || "http://127.0.0.1:3850").replace(
  /\/$/,
  ""
);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

/** Paths forwarded to Service A (one backend — not a parallel API). */
function isServiceAPath(pathname) {
  return (
    pathname === "/health" ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/b2b/") ||
    pathname === "/customers" ||
    pathname.startsWith("/customers/") ||
    pathname === "/jobs" ||
    pathname.startsWith("/jobs/") ||
    pathname === "/watch-targets" ||
    pathname.startsWith("/watch-targets/")
  );
}

function sendText(res, status, body, contentType) {
  const buf = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "Content-Type": contentType || "text/plain; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

function safeStaticPath(urlPath) {
  let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  rel = decodeURIComponent(rel).replace(/\0/g, "");
  if (rel.includes("..") || path.isAbsolute(rel)) return null;
  const full = path.normalize(path.join(STATIC_ROOT, rel));
  if (!full.startsWith(STATIC_ROOT)) return null;
  return full;
}

function serveStatic(req, res, urlPath) {
  const filePath = safeStaticPath(urlPath);
  if (!filePath) {
    sendText(res, 400, "Bad path");
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(res, 404, "Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function proxyToServiceA(req, res, pathname, search) {
  const target = new URL(SERVICE_A_URL);
  const headers = { ...req.headers };
  delete headers.host;
  headers.host = target.host;

  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: pathname + (search || ""),
    method: req.method,
    headers,
  };

  const upstream = http.request(opts, (upRes) => {
    const outHeaders = { ...upRes.headers };
    // Same-origin proxy — drop upstream CORS noise if any.
    delete outHeaders["access-control-allow-origin"];
    delete outHeaders["access-control-allow-credentials"];
    res.writeHead(upRes.statusCode || 502, outHeaders);
    upRes.pipe(res);
  });

  upstream.on("error", (err) => {
    sendText(
      res,
      502,
      JSON.stringify({
        error: "service_a_unreachable",
        message:
          "Could not reach Service A at " +
          SERVICE_A_URL +
          ". Start it first (e.g. AUTH_STUB=1 npm run service-a). " +
          (err.message || ""),
      }),
      "application/json; charset=utf-8"
    );
  });

  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const rawUrl = req.url || "/";
  let parsed;
  try {
    parsed = new URL(rawUrl, `http://${HOST}:${PORT}`);
  } catch {
    sendText(res, 400, "Bad URL");
    return;
  }

  const pathname = parsed.pathname;

  if (req.method === "OPTIONS" && isServiceAPath(pathname)) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  if (isServiceAPath(pathname)) {
    proxyToServiceA(req, res, pathname, parsed.search);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    if (pathname === "/fe-b2b" || pathname === "/fe-b2b/") {
      serveStatic(req, res, "/");
      return;
    }
    serveStatic(req, res, pathname);
    return;
  }

  sendText(res, 404, "Not found");
});

if (require.main === module) {
  if (!fs.existsSync(path.join(STATIC_ROOT, "index.html"))) {
    console.error("[fe-b2b] missing public/fe-b2b/index.html");
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    console.log(`[fe-b2b] static UI on http://${HOST}:${PORT}/`);
    console.log(`[fe-b2b] proxy → Service A at ${SERVICE_A_URL}`);
    console.log(
      "[fe-b2b] Start Service A first. AUTH_STUB=1 is local/shame only — never prod."
    );
    console.log("[fe-b2b] Live Google OAuth: PARKED (Wave 6 Phase B).");
  });
}

module.exports = {
  createServer: () => server,
  isServiceAPath,
  STATIC_ROOT,
  SERVICE_A_URL,
  PORT,
  HOST,
};
