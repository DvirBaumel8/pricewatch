# PriceWatch — 7-day wedge demo retrospective

**Date:** 2026-09-22  
**Dev:** Cloud Agent  
**Spec:** `pricewatch-wedge-demo-7d.md`

## W1 — Extract plan ladder on ≥5 live pages

**Score: 6/6** (threshold: ≥4/5)

| Site | Plans extracted | Main plans correct | Method | LLM tokens |
|------|---------------|-------------------|--------|------------|
| vercel.com | 3 (Hobby, Pro, Enterprise) | ✅ Hobby=Free, Pro=$20/dev seat, Enterprise=Custom | dom | 0 |
| linear.app | 4 (Free, Basic, Business, Enterprise) | ✅ Free=0, Basic=$10/user, Business=$16/user | dom | 0 |
| notion.com | 4 (Free, Plus, Business, Enterprise) | ✅ Free=0, Plus=$10/member, Business=$20/member | dom | 0 |
| plausible.io | 2 (Starter, Growth) | ✅ Starter=$9/~10k pageviews | dom | 0 |
| slack.com | 3 (Free, Pro, Business+) | ✅ Free=0, Pro=$8.75/active user | dom | 0 |
| shopify.com | 4 (Basic, Grow, Advanced, Plus) | ✅ Basic=$29, Grow=$79, Adv=$299, Plus=$2300 | dom | 0 |

**Total LLM tokens: 0** (all deterministic regex/DOM extraction).  
**Cap compliance:** No LLM step used; hard cap 8000 tokens would abort — not triggered.

## W2 — Diff email format

**Evidence:** `test/test-wedge.js` (30 tests), `test/test-email-format.js` (25 tests)

- ✅ Subject: `PriceWatch: {site} pricing changed`
- ✅ Body: table with Plan | Field | Before | After
- ✅ Body: one plain summary sentence after table
- ✅ No localhost/127.0.0.1 in subject or body (HARD rule)
- ✅ Jerusalem timezone (Asia/Jerusalem)
- ✅ Support line: `price.watcher.service@gmail.com`
- ✅ PriceWatch signature
- ✅ No internal labels (§, acceptance, oauth, test harness)

**Sample emails for CEO:** `outbox/samples/`
- `vercel-pro-price-bump.json` — Pro $20→$25
- `linear-basic-price-bump.json` — Basic $10→$12
- `notion-new-plan-added.json` — Business plan added

## W3 — Noise gate fixtures

**Both behaviors proven:**

| Fixture | Description | Expected | Actual | Result |
|---------|-------------|----------|--------|--------|
| A | Pro +$10 ($20→$30) | alert fires (hasSignal=true) | hasSignal=true | ✅ PASS |
| B | Banner/copy only (identical plans) | no alert (hasSignal=false) | hasSignal=false | ✅ PASS |

**Additional edge cases tested (all pass):**
- Plan added → signal ✅
- Plan removed → signal ✅  
- Unit change (seat→user) → signal ✅
- Identical plans → no signal ✅
- Null old plans (baseline) → no signal ✅
- Null new plans (extract fail) → no signal ✅

## Architecture

```
src/plan-ladder.js          — Multi-plan extractor (6 site-specific + generic)
src/plan-ladder-snapshot.js — Structured snapshot store (data/snapshots/ladder/)
src/plan-ladder-diff.js     — Diff engine + noise gate
src/plan-ladder-email.js    — Customer email template (table + summary)
src/plan-ladder-monitor.js  — Full pipeline: extract → snapshot → diff → email
src/monitor-lib.js          — Updated: Jerusalem time, no-localhost, support line
scripts/send-outbox.js      — Mailer transport (Resend/SMTP) ported from PR #8
scripts/generate-sample-emails.js — Sample email generator for CEO review
```

## Senior bar compliance

- ✅ No wrong price shipped as truth (6/6 spot-checked)
- ✅ No slogan AI without structure (deterministic regex, 0 LLM tokens)
- ✅ No localhost/lab in customer email
- ✅ No forever LLM loops (no LLM used; cap enforced)
- ✅ Partner promise honored (daily morning Israel, not 24/7)
- ✅ Cites sources (snapshot files, test results)
- ✅ Proof left (this file, test fixtures, sample emails)

## Blockers

- W4 (side-by-side honesty note): deferred to Carlos
- W5 (shame retest): deferred to Chris
- Mailer secrets (RESEND_API_KEY or SMTP_PASS) not configured — outbox-only for now

## Files

- `test/fixtures/wedge/fixture-a-price-bump.json`
- `test/fixtures/wedge/fixture-b-banner-only.json`
- `test/test-wedge.js` (30 tests)
- `test/test-email-format.js` (25 tests)
- `test/test-w1-spot-check.js` (6 tests)
- `outbox/samples/vercel-pro-price-bump.json`
- `outbox/samples/linear-basic-price-bump.json`
- `outbox/samples/notion-new-plan-added.json`
- `data/snapshots/ladder/*.json` (6 baseline snapshots)
