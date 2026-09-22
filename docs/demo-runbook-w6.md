# W6 sell-demo runbook — screen record ≤90s

**For:** Carlos (record) · Launch (beat sheet)  
**Dev state:** Record-ready. No setup needed beyond `git clone` + `node ≥18`.

## Quick start — terminal demo (one command)

```bash
node scripts/demo-w6-sell.js
```

Fetches Vercel's **live** pricing page, extracts the plan ladder, shows customer
picking "Pro" to watch, simulates a price bump, fires the diff → email, then
proves the noise gate stays silent. ~3 seconds, no secrets needed.

### Offline fallback (no network)

```bash
node scripts/demo-w6-sell.js --fixture
```

## Quick start — browser demo (Beat 2.5 HTML picker)

```bash
# 1. Extract plan ladders (needs network, ~3s)
npm run ladder:allowlist

# 2. Start the plan picker UI
npm run pick
# → opens http://127.0.0.1:3900/pick/vercel.com

# 3. Open browser to http://127.0.0.1:3900/pick/vercel.com
#    Select "Pro" → click "Watch selected plans" → confirmation page
```

The HTML picker shows clean plan rows with checkboxes — no raw JSON visible.
Dark theme, modern UI, screen-record friendly.

---

## What the camera sees (5 beats)

### Beat 1 — Structured plan ladder

The script fetches `https://vercel.com/pricing` and prints a clean table:

```
┌─────────────────┬─────────────┬──────────────────┬──────────┐
│ Plan            │ Price       │ Unit             │ Billing  │
├─────────────────┼─────────────┼──────────────────┼──────────┤
│ Hobby           │ $0          │ —                │ free     │
│ Pro             │ $20         │ developer seat   │ monthly  │
│ Enterprise      │ Custom      │ —                │ custom   │
└─────────────────┴─────────────┴──────────────────┴──────────┘
```

**Narration:** "We extract the full plan ladder — structured, not vague.
Hobby is free, Pro is $20 per developer seat, Enterprise is custom."

### Beat 2.5 — Customer picks which plans to watch

**Terminal version** (in the demo script):
```
  ➜  Customer selects: "Pro"

       Hobby            $0          (not watching)
    ✓  Pro              $20
       Enterprise       Custom      (not watching)

  ✓ Watching: Pro on vercel.com
```

**Browser version** (for richer visual — `npm run pick`):
The customer sees the plan ladder as selectable rows with checkboxes.
They check "Pro" and click **"Watch selected plans"** or **"Watch all paid plans."**
Confirmation page: "✓ Watching vercel.com — Pro."

**Narration:** "The customer picks from the plans we found — not free-text jargon.
They select Pro because that's the plan they compete with."

### Beat 3 — Price bump

The script injects Pro $20 → $25. Updated table prints.

**Narration:** "Next morning, Vercel raised Pro by $5."

### Beat 4 — Alert fires → customer email

```
Subject: PriceWatch: vercel.com pricing changed

Hi Dvir,

We detected pricing changes on vercel.com.

  Plan            | Field    | Before     | After
  --------------- | -------- | ---------- | ----------
  Pro             | price    | $20        | $25

Pro price increased from $20 to $25.

Open pricing page: https://vercel.com/pricing

Detected 22 Sept 2026, 21:15 GMT+3.

Questions? Reply to this email or write price.watcher.service@gmail.com.

— PriceWatch
```

**Narration:** "The founder gets an email: which plan moved, old price, new price.
Table format. One clear sentence. Link to the pricing page. Done."

### Beat 5 — Banner-only → silent

```
Changes detected: 0
Signal: NO → no email
✓ Noise gate: banner/copy changes stay silent.
```

**Narration:** "When it's just a banner change — no email. No noise.
That's the difference versus Visualping."

---

## Recording tips

1. **Terminal:** Dark background, ≥16pt font, 80 columns wide.
2. **Browser (Beat 2.5):** The picker page has a dark theme. Full-screen the browser.
3. **Two options for Beat 2.5:**
   - **Option A (simple):** Run the terminal demo only — Beat 2.5 shows the CLI pick.
   - **Option B (richer):** Split: terminal for Beats 1/3/4/5, browser for Beat 2.5 plan picker.
4. **Clear terminal before running:** `clear && node scripts/demo-w6-sell.js`
5. **No secrets needed.** No `.env`. Works on a fresh clone.
6. **No localhost/127.0.0.1** in any customer-facing output.

## Alternative demo: wide-shot allowlist scan

```bash
node src/plan-ladder-monitor.js --allowlist
```

Shows all 6 SaaS sites with plan counts. Good opening "wide shot."

## Test suite (optional closing frame)

```bash
npm test
```

97 tests passing in ~1 second.

---

## Files

| File | Purpose |
|------|---------|
| `scripts/demo-w6-sell.js` | Terminal demo: 5 beats, live or `--fixture` |
| `scripts/plan-picker-server.js` | HTML plan picker for Beat 2.5 browser recording |
| `src/plan-selection.js` | Plan-selection persistence (data/watched/) |
| `src/plan-ladder-diff.js` | Diff engine + noise gate + `filterBySelection` |
| `src/plan-ladder.js` | Multi-plan extractor (6 sites, 0 LLM tokens) |
| `src/plan-ladder-email.js` | Customer email template |
| `outbox/samples/` | Pre-generated sample emails for reference |
| `docs/retros/wedge-demo-7d.md` | Full W1–W3 + W6 evidence retrospective |
