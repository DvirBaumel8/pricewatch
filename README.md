# PriceWatch

Competitor pricing monitor MVP.

- Spec: see `docs/pricewatch-mvp-spec.md` (synced from ops)
- Lab fixture: `lab/` — fake pricing page for test plan §7.1–7.2
- App code: `src/` — discover + monitor CLI

## Owners
- Spec / acceptance: Carlos (CoS) → CEO
- App code: Developer Bot
- CI / run / cron: DevOps Bot
- Written tests: QA Bot

---

## §7.2 Thin Monitor — Quick Start

### Prerequisites

- Node.js ≥ 18
- Lab server running (for live tests)

### Directory layout

```
src/discover.js     # Skill discovery: API → DOM ladder, 0 LLM tokens
src/monitor.js      # Price monitor: fetch → diff → outbox email
data/skills/        # Generated skill JSON files
data/snapshots/     # Latest price snapshot per skill
outbox/             # Email artifacts (file sink)
scripts/run-7.2.sh  # Full §7.2 acceptance sequence against lab
scripts/test-7.2-offline.sh  # Self-contained test (starts its own lab)
```

### 1. Start the lab server

```bash
node lab/server.js
# → http://127.0.0.1:3847/
```

### 2. Discover a skill

```bash
node src/discover.js http://127.0.0.1:3847 "main monthly price"
# → writes data/skills/<id>.json
```

The discover command tries the API path (`/price.json`) first (step 1, 0 LLM tokens),
then falls back to DOM extraction with `data-*` attributes (step 2, still 0 LLM tokens).

### 3. Run the monitor

```bash
node src/monitor.js <skill_id>
```

- First run: saves a baseline snapshot, no email.
- Subsequent runs: compares to last snapshot. If price unchanged, no email.
  If changed, writes exactly one email artifact to `outbox/` with before/after amounts.

### 4. Run the full §7.2 acceptance sequence

Against a running lab (default `http://127.0.0.1:3847`):

```bash
./scripts/run-7.2.sh                      # uses default lab URL
./scripts/run-7.2.sh http://127.0.0.1:3847  # explicit URL
```

Or run the self-contained offline test (starts its own lab on a random port):

```bash
./scripts/test-7.2-offline.sh
```

### §7.2 acceptance criteria

| # | Check | Assertion |
|---|-------|-----------|
| 1 | Discover lab URL + "main monthly price" | Skill JSON created |
| 2 | Run monitor (price unchanged) | No email in outbox |
| 3 | `POST /set-price {"amount":39}` | Lab price updated |
| 4 | Run monitor (price changed) | Exactly 1 email with before=29, after=39 |
| 5 | Cleanup | Lab reset to $29, temp files removed |

All steps use **0 LLM tokens**. No keep-alive browser tabs; short HTTP fetch only.
