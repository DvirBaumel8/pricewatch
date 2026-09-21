/**
 * Shared HTTP fetch helper — polite single-page GET with timeout.
 */
const https = require("https");
const http = require("http");

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CHALLENGE_MARKERS = [
  /cf-challenge/i,
  /challenge-platform/i,
  /Checking your browser/i,
  /Just a moment/i,
  /captcha[-_]?container/i,
  /id="challenge-form"/i,
  /managed-challenge/i,
  /ray ID/i,
];

function looksBlocked(status, body) {
  if (!body || body.trim().length === 0) return "empty_body";
  if (status === 403 || status === 503) return `http_${status}`;
  for (const re of CHALLENGE_MARKERS) {
    if (re.test(body) && body.length < 50000) return "challenge_page";
  }
  return null;
}

function fetchHtml(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": UA }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchHtml(new URL(res.headers.location, url).href, timeoutMs));
      }
      if (res.statusCode === 403 || res.statusCode === 503) {
        return reject(new Error("blocked"));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`http_${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const html = Buffer.concat(chunks).toString("utf8");
        const blockReason = looksBlocked(res.statusCode, html);
        if (blockReason) {
          return reject(new Error("blocked"));
        }
        resolve(html);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

module.exports = { fetchHtml, looksBlocked };
