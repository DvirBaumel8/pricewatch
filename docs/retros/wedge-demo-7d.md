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
src/plan-ladder-diff.js     — Diff engine + noise gate + filterBySelection
src/plan-ladder-email.js    — Customer email template (table + summary)
src/plan-ladder-monitor.js  — Full pipeline: extract → snapshot → diff → email
src/plan-selection.js       — Plan-selection store (data/watched/)
src/monitor-lib.js          — Updated: Jerusalem time, no-localhost, support line
scripts/plan-picker-server.js  — HTML plan picker for Beat 2.5 (no raw JSON)
scripts/demo-w6-sell.js     — Record-ready 5-beat demo (live or --fixture)
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

## W6 — Record-ready sell demo (≤90s)

**State:** Ready for Carlos to screen-record.

### Terminal demo

`node scripts/demo-w6-sell.js` (live Vercel) or `--fixture` (offline)

**5 beats in ~60s:**

1. **Extract** — Vercel live plan ladder: Hobby Free / Pro $20 / Enterprise Custom
2. **Pick plans** (Beat 2.5) — Customer picks "Pro" from ladder rows (not free-text jargon)
3. **Price bump** — Pro $20 → $25 injected into snapshot
4. **Alert fires** — Diff detects change → customer email with plan + old$→new$ table
5. **Banner silent** — Identical plans re-run → 0 changes → no email (noise gate)

### HTML plan picker (Beat 2.5 browser demo)

`npm run pick` → `http://127.0.0.1:3900/pick/vercel.com`

- Dark theme, clean plan rows with checkboxes (no raw JSON visible)
- "Watch selected plans" or "Watch all paid plans" buttons
- Confirmation page: "✓ Watching vercel.com — Pro"
- Persisted to `data/watched/vercel-com.json`

### Verification

- **No localhost/127.0.0.1** in any customer-facing output (grep = 0)
- **No raw JSON fields** shown in picker HTML (grep = 0)
- **No free-text jargon** — customer picks from extracted ladder rows

**Runbook:** `docs/demo-runbook-w6.md`

**Carlos records; Dev does not record unless asked.** Launch writes beat sheet.

## Blockers

- W4 (side-by-side honesty note): deferred to Carlos
- W5 (shame retest): deferred to Chris
- Mailer secrets (RESEND_API_KEY or SMTP_PASS) not configured — outbox-only for now

## Files

- `test/fixtures/wedge/fixture-a-price-bump.json`
- `test/fixtures/wedge/fixture-b-banner-only.json`
- `test/test-wedge.js` (39 tests)
- `test/test-email-format.js` (25 tests)
- `test/test-w1-spot-check.js` (6 tests)
- `outbox/samples/vercel-pro-price-bump.json`
- `outbox/samples/linear-basic-price-bump.json`
- `outbox/samples/notion-new-plan-added.json`
- `data/snapshots/ladder/*.json` (6 baseline snapshots)
- `scripts/demo-w6-sell.js` (record-ready 5-beat demo script)
- `scripts/plan-picker-server.js` (HTML plan picker for Beat 2.5)
- `src/plan-selection.js` (plan-selection persistence)
- `docs/demo-runbook-w6.md` (exact commands + narration for Carlos)
