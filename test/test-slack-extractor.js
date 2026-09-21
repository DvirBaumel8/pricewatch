#!/usr/bin/env node
"use strict";

/**
 * Unit tests for the Slack extractor — validates price extraction
 * with and without the strikeprice promo layout.
 */
const { extractors } = require("../src/steps/step2-http-dom");

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

const slack = extractors["slack.com"];
const target = "Pro plan $8.75 per active user per month when paying monthly";

// ── Test 1: Original promo layout with strikeprice ──────────────────────
console.log("\n=== Slack extractor: strikeprice promo layout ===");
const promoHtml = `
<div class="plan-type--pro">
  <h3>Pro</h3>
  <div class="pricing-card-body">
    <span class="plan-emphasized-rate">$4.38</span>
    <span class="v--strikeprice">$8.75</span>
    <span class="term-copy">per user / month, when paying monthly</span>
  </div>
</div>
`;

const r1 = slack.extract(promoHtml, target);
assert("Extracts price from strikeprice layout", r1 !== null);
assert("Price is $8.75", r1 && r1.price === 8.75);
assert("Does not pick promo $4.38", r1 && r1.price !== 4.38);
assert("Period is month", r1 && r1.period === "month");
assert("Plan is Pro", r1 && r1.planName === "Pro");

// ── Test 2: Non-promo layout (no strikeprice) ──────────────────────────
console.log("\n=== Slack extractor: standard layout (no strikeprice) ===");
const standardHtml = `
<div class="plan-type--pro">
  <h3>Pro</h3>
  <div class="pricing-card-body">
    <span class="plan-emphasized-rate">$8.75</span>
    <span class="term-copy">per active user / month, when paying monthly</span>
  </div>
</div>
`;

const r2 = slack.extract(standardHtml, target);
assert("Extracts price from standard layout", r2 !== null);
assert("Price is $8.75", r2 && r2.price === 8.75);
assert("Period is month", r2 && r2.period === "month");

// ── Test 3: Layout with just a price near monthly text ──────────────────
console.log("\n=== Slack extractor: minimal layout with $ near monthly ===");
const minimalHtml = `
<div class="plan-type--pro">
  <h3>Pro</h3>
  <p>$8.75 per active user / month, billed monthly</p>
</div>
`;

const r3 = slack.extract(minimalHtml, target);
assert("Extracts price from minimal layout", r3 !== null);
assert("Price is $8.75", r3 && r3.price === 8.75);

// ── Test 4: Annual price should NOT be picked ───────────────────────────
console.log("\n=== Slack extractor: should not pick annual half-price ===");
const annualHtml = `
<div class="plan-type--pro">
  <h3>Pro</h3>
  <div>
    <span class="plan-emphasized-rate">$4.38</span>
    <span class="term-copy">per user / month, billed annually</span>
  </div>
</div>
`;

const r4 = slack.extract(annualHtml, target);
assert("Does not pick $4.38 as standard monthly", !r4 || r4.price !== 4.38);

// ── Test 5: Blocked / empty page should return null ──────────────────────
console.log("\n=== Slack extractor: no plan-type--pro section ===");
const blockedHtml = `<html><body>Just a moment...</body></html>`;
const r5 = slack.extract(blockedHtml, target);
assert("Returns null for blocked page", r5 === null);

// ── Test 6: aria-label/data-price fallback ───────────────────────────────
console.log("\n=== Slack extractor: aria-label fallback ===");
const ariaHtml = `
<div class="plan-type--pro">
  <h3>Pro</h3>
  <div aria-label="$8.75 per user monthly pricing">
    <span>Pro plan</span>
  </div>
</div>
`;

const r6 = slack.extract(ariaHtml, target);
assert("Extracts price from aria-label", r6 !== null);
assert("Price is $8.75", r6 && r6.price === 8.75);

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
