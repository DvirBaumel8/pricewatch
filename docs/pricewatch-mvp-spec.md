# PriceWatch — MVP Tech Spec (v2)
**Status:** Draft for CEO approval — 2026-09-22  
**Supersedes:** v1 draft  
**Standards:** `/workspace/strategy/spec-standards.md` — test plan is the spine

---

## 0. Goal (one sentence)
Customers subscribe, add competitors each with **one** target price; a **configurable cron** (MVP default: **daily**) checks that price and emails them when it changes.

---

## 1. In scope / out of scope

### In scope (MVP)
- Self-serve signup + Stripe billing (can be stubbed in early phases)
- Competitors with exactly **one** `target_price_description` each
- Cap: **10 competitors / customer** (MVP)
- **Fetch skills** (reusable how-to-get-this-price)
- Discovery ladder with **hard token/time/page caps per step**
- **Monitor cron** — wakes on schedule, runs checks (see §3)
- Per-customer configurable check interval; **MVP ships daily only**
- Email on real price/plan change
- CEO teach path (especially early), still with weekly soft cap as seatbelt
- Serious test plan (§7) including lab site + 3 real cases

### Out of scope (MVP)
- Many target prices per competitor
- Generic whole-page change alerts
- Keep browser tabs open 24/7
- Guaranteed “any website on earth”
- Sub-daily schedules in product UI (code may support interval; we only enable daily)
- Unlimited rare-agent exploration

---

## 2. System map (services + cron)

```
Customer → Service A (API / billing / config)
              │
              ├─ onboarding → queue: pendingCustomerOnboardingRequests
              │                    ↓
              │              Service B (discovery → skill)
              │
              └─ schedule config (MVP: daily @ customer timezone or Asia/Jerusalem)
                         ↓
              *** CRON / Service C (Monitor) ***
              Wakes each tick (MVP: once per day per customer watch set)
              For each ready skill: short visit → extract → snapshot → maybe email
```

| Component | Job |
|-----------|-----|
| **Service A** | Auth, billing, CRUD competitors, enqueue onboarding, store `check_interval` (MVP fixed `daily`) |
| **Service B** | Consume onboarding queue; run discovery ladder; write skill or `unsupported` / `needs_ceo` |
| **Cron → Service C** | **Missing in verbal map before — now first-class.** Scheduler wakes workers; loads due watches; runs fetch via skill; diffs; emails |
| **Skill library** | Global reuse: same competitor+target → one skill for all customers |
| **CEO teach** | Rare human: show where price is → skill saved |

### Cron details (MVP)
- **Default:** daily (e.g. 06:00 in customer TZ or Asia/Jerusalem)
- **Config field:** `check_interval_minutes` (or enum) on customer or watch — **MVP only allows daily** (1440 minutes); finer intervals later
- **Behavior:** enqueue `pendingMonitorTicks` for due watches; workers pull; no forever-open tabs — open → extract → close
- **Idempotency:** one successful check per watch per calendar day (MVP)

---

## 3. Skill schema (summary)
Versioned JSON: `pricing_url`, `target_price_description`, `method` (`api` | `dom` | `llm_html` | `manual_ceo`), selectors/regex/api path, normalize (currency/period), `confidence`, `version`, failure counters.

---

## 4. Discovery ladder + hard budgets (permanent)

**“Rare agent” (plain words):** an expensive step where the AI may browse/search to *find* how to read a price when we have no skill yet. Not used on normal daily checks.

| Step | What | Max tokens | Max time | Max page loads | On exceed |
|------|------|------------|----------|----------------|-----------|
| 0 | Reuse global skill | 0 | 5s | 0 | — |
| 1 | Public API | 0 | 10s | 1 | fail → next |
| 2 | HTTP + DOM/regex | 0 | 15s | 1 | fail → next |
| 3 | Playwright + DOM/regex | 0 LLM | 45s | 2 | fail → next |
| 4 | Playwright + small LLM on cleaned HTML | **≤ 2_000** | 60s | 2 | **abort step** |
| 5 | Rare agent (browse/search) | **≤ 5_000** | 120s | 5 | **abort step** |
| 6 | CEO teach or `unsupported` | 0 | — | — | if CEO weekly budget empty → unsupported |

**Monitor path (Service C):** steps 0–3 only by default (0 LLM). Optional LLM fallback only if skill flagged degraded — same **≤ 2_000** cap, then degrade + alert, **never loop**.

**Anti-loop rule:** no step retries more than once; no re-entry to rare agent in the same onboarding without a new CEO/system signal.

---

## 5. Anti-bot / proxies / dynamic DOM
- HTTP first; Playwright when needed  
- Detect challenge pages → `blocked`, don’t save empty price  
- Proxies off by default; enable per domain after repeated blocks (cost guard)  
- Skills versioned; redesign → one retry → rediscovery from step 2 (not rare agent first)

---

## 6. Phased build
| Phase | Deliverable |
|-------|-------------|
| **T0** | Spec approved |
| **T1** | Lab test website (§7.1) |
| **T2** | Happy-path monitor on lab site (§7.2–7.4) |
| **T3** | Three real competitor cases (§7.5–7.6) |
| **T4** | Service A/B/C skeleton + daily cron for allowlisted skills |
| **T5** | Demand landing (only if T2–T3 pass) |

---

## 7. TEST PLAN (most important section)

### 7.1 Lab website
| | |
|--|--|
| **Target** | A site we fully control so tests are deterministic |
| **Build** | One HTML page: some text + a clearly visible price (e.g. `$29/mo`) we can edit by hand or via a tiny admin |
| **Measure** | Page loads; price string present and editable |
| **Pass** | We can change the price in &lt;1 minute and reload shows new price |
| **Fail** | Flaky hosting or unclear price location |
| **On fail** | Fix lab site before any PriceWatch work |

### 7.2 Controlled system test (happy path)
| | |
|--|--|
| **Target** | Prove discover → skill → cron → no false email → price change → email |
| **Steps** | 1) Point system at lab URL + target description “main monthly price” 2) Run discovery → skill ready 3) **Trigger cron/monitor** → assert **no email** (price unchanged) 4) Change lab price 5) Trigger cron again → assert **exactly one email** with before/after |
| **Measure** | Skill status; snapshot rows; email sink (Mailhog/Resend test); logs |
| **Pass** | No email on unchanged; one correct email after change; snapshots stored |
| **Fail** | False email, missed change, crash, or wrong amount |
| **On fail** | Fix extractor/cron; do not proceed to real sites |

### 7.3 Analyze run #7.2
| | |
|--|--|
| **Target** | Know cost and quality of the happy path |
| **Measure** | Tokens used per step; wall time; which ladder step succeeded; proxy? |
| **Pass** | Monitor path used **0 LLM tokens**; onboarding tokens within caps; documented notes “what to improve” |
| **Fail** | Monitor used LLM without need, or caps exceeded, or no analysis written |
| **On fail** | Improve until pass, then re-run 7.2 |

### 7.4 Re-run 7.2 after improvements
| | |
|--|--|
| **Target** | Improvements didn’t break happy path |
| **Pass** | Same as 7.2 |
| **Fail** | Regressions |
| **On fail** | Revert or fix; block real-case tests |

### 7.5 Three real use cases
| | |
|--|--|
| **Target** | Discovery ladder works on real public pricing pages (honest sample) |
| **Steps** | For **3** companies: pick company → main competitor → **one** main product price → run discovery logic (API → DOM → …) → record skill or failure reason |
| **Measure** | Success/fail per case; step that worked; tokens; blocks |
| **Pass** | ≥ **2 of 3** get a usable skill **without** CEO teach; all runs respect token caps |
| **Fail** | &lt;2/3 succeed, or caps blown, or silent wrong prices |
| **On fail** | Narrow allowlist / improve ladder; or kill MVP scope |

### 7.6 Analyze real cases (same as 7.3)
| | |
|--|--|
| **Target** | Decide if MVP is operable under 2h/day + cost |
| **Measure** | Tokens, success rate, would-CEO-teach count, proxy need |
| **Pass** | Written go / pivot / kill recommendation with numbers |
| **Fail** | No analysis |
| **On fail** | Do analysis before any product build or landing |

---

## 8. Kill / stop criteria
- Lab happy path can’t stay green after one improvement cycle  
- Real cases &lt;2/3 without heavy CEO teach  
- Token/proxy cost implies we can’t price the product  
- False emails in lab or real tests  

---

## 9. Open items for CEO
- Exact daily hour / timezone default  
- Email provider for tests  
- Whether Phase T5 landing waits for all of 7.5–7.6  

---

*End v2*
