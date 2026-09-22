#!/usr/bin/env node
"use strict";

/**
 * Unit tests for looksBlocked — validates challenge/blocked detection.
 */
const { looksBlocked } = require("../src/steps/http-fetch");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`${GREEN}  PASS${RESET}: ${label}`);
    passed++;
  } else {
    console.log(`${RED}  FAIL${RESET}: ${label}`);
    failed++;
  }
}

console.log("\n=== looksBlocked: challenge detection ===");

assert("Empty body is blocked", looksBlocked(200, "") === "empty_body");
assert("Null body is blocked", looksBlocked(200, null) === "empty_body");
assert("Whitespace-only body is blocked", looksBlocked(200, "   ") === "empty_body");
assert("HTTP 403 is blocked", looksBlocked(403, "<html>Forbidden</html>") === "http_403");
assert("HTTP 503 is blocked", looksBlocked(503, "<html>Service Unavailable</html>") === "http_503");

const cfChallenge = `<html><body><div id="cf-challenge-running">Checking your browser...</div></body></html>`;
assert("Cloudflare challenge is blocked", looksBlocked(200, cfChallenge) === "challenge_page");

const justAMoment = `<html><head><title>Just a moment...</title></head><body>Please wait</body></html>`;
assert("'Just a moment' challenge is blocked", looksBlocked(200, justAMoment) === "challenge_page");

const captchaPage = `<html><body><div class="captcha-container">Solve this captcha</div></body></html>`;
assert("Captcha page is blocked", looksBlocked(200, captchaPage) === "challenge_page");

const managedChallenge = `<html><body><div class="managed-challenge">Verifying</div></body></html>`;
assert("Managed challenge is blocked", looksBlocked(200, managedChallenge) === "challenge_page");

const normalHtml = `<html><body><h1>Pricing</h1><p>$29/mo</p></body></html>`;
assert("Normal HTML is not blocked", looksBlocked(200, normalHtml) === null);

const normalJson = `{"amount":29,"currency":"USD","period":"month"}`;
assert("Normal JSON is not blocked", looksBlocked(200, normalJson) === null);

const largePage = "x".repeat(60000) + "cf-challenge" + "x".repeat(1000);
assert("Large page with challenge marker is not blocked (>50k)", looksBlocked(200, largePage) === null);

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
