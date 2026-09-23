# F3 — Stabilize core algorithm / Service C (CB-4)

**Status:** implemented on this branch  
**Token budget:** daily / Service C / plans-prices path = **0 LLM**  
**Product language:** plans and prices (no “ladder” in customer-facing copy; repo filenames may still say `plan-ladder*`)

## What changed

1. **One skill schema** — `src/skill-schema.js` `normalizeSkill()` adapts lab (`selectors`/`normalize`) and real-site (`selector`/`regex`) skills. Migration: `node scripts/migrate-skills-schema.js`.
2. **Plans/prices on Service C** — skills with `method: "plans"` or `extract_mode: "plans"` (or tick `opts.mode: "plans"`) run through `plan-ladder*` extract/diff/snapshot/email inside `runMonitorCheck` — not only `npm run ladder`.
3. **`failure_count`** — increments on `fetch_fail` / `blocked` / `extract_fail`. At `PRICEWATCH_FAILURE_THRESHOLD` (default **3**) marks `skill_status: "unhealthy"` and enqueues **step2-only** rediscovery in `data/rediscovery-queue.json` (0 LLM).
4. **Mailer kill switch** — `scripts/send-outbox.js` honors `data/KILL` or `PRICEWATCH_KILL=1` and no-ops (exit 0).
5. **Honest empty/blocked** — invalid/empty extract never writes a price snapshot used as current; ops_alert instead.
6. **Noise gate** — plans path uses `diffPlanLadders` (banner/copy-only ≠ outbox; price/plan/currency/unit/billing = outbox).

## Chris — lab hard-fail tests

```bash
# Offline / local hard-fail (preferred gate)
npm run test:f3

# Full package unit suite (includes F3)
npm test

# Optional: lab server for single-price section inside test:f3
npm run lab   # separate terminal, :3847
npm run test:f3

# Existing Service C e2e (lab + Service A required)
npm run lab & npm run service-a &
npm run test:e2e:c
```

### Kill-switch proof on mailer

```bash
# Env
PRICEWATCH_KILL=1 npm run send-outbox
# Expect: "Kill switch active — no-op" and exit 0 (no sends)

# File
touch data/KILL
npm run send-outbox
# Expect same no-op
rm -f data/KILL
```

### Failure / empty / blocked proof (also covered by `test:f3`)

- Fetch to closed port → `fetch_fail`, `failure_count++`, ops_alert, **no** `data/snapshots/<id>.json`
- HTML without selectors → `extract_fail`, no snapshot
- Cloudflare challenge body → `blocked`, no snapshot
- Plans stub empty → `extract_fail`, no ladder snapshot
- Plans price bump fixture → exactly **1** `outbox/plan-ladder_*.json`; banner fixture → **0**

## Skill fields (canonical)

| Field | Notes |
|--|--|
| `method` | `api` \| `dom` \| `plans` |
| `extract_mode` | `single` \| `plans` |
| `selectors` | lab DOM attrs |
| `regex` / `selector` | real-site extract |
| `normalize` | currency/period field hints |
| `failure_count` | int, default 0 |
| `skill_status` | `healthy` \| `unhealthy` |
| `plan_key` | optional selected plan name |

## Out of scope (still)

LLM discovery, cloud cron (F9), stranger email, FE, F4 intake.
