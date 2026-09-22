# W6 sell-demo runbook — screen record ≤90s

**For:** Carlos (record) · Launch (beat sheet)  
**Dev state:** Record-ready. Terminal demo only. No secrets needed.

## Record command (one line)

```bash
clear && node scripts/demo-w6-sell.js
```

That's it. This fetches Vercel's **live** pricing page, shows the full sell
story in 5 beats, finishes in ~3 seconds. Dark terminal, no browser needed.

### Offline fallback (no network)

```bash
clear && node scripts/demo-w6-sell.js --fixture
```

### Fresh clone setup (before first run)

```bash
git clone https://github.com/DvirBaumel8/pricewatch.git
cd pricewatch
npm run ladder:allowlist     # extracts live plan data (~3s, needs network)
node scripts/demo-w6-sell.js # run the demo
```

---

## What the camera sees (5 beats, ~60s)

### Beat 1 — Structured plan ladder

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

```
  ➜  Customer selects: "Pro"

       Hobby            $0          (not watching)
    ✓  Pro              $20
       Enterprise       Custom      (not watching)

  ✓ Watching: Pro on vercel.com
```

**Narration:** "The customer picks from the plans we found — not free-text.
They select Pro because that's the plan they compete with."

### Beat 3 — Price bump

The table reprints with Pro $20 → $25.

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

1. **Dark terminal,** ≥16pt font, max 80 columns wide.
2. **Clear first:** `clear && node scripts/demo-w6-sell.js`
3. Entire demo runs in **<3 seconds** — clean scroll, no waiting.
4. **No secrets, no `.env`, no browser.** Works on a fresh clone after `npm run ladder:allowlist`.
5. **No internal/lab addresses in any customer-facing output** — verified.

## Alternative wide-shot (optional opening)

```bash
node src/plan-ladder-monitor.js --allowlist
```

Shows all 6 SaaS sites with plan counts. Good as a "we cover six competitors" opening frame.

## Test suite (optional closing frame)

```bash
npm test
```

97+ tests passing in ~1 second.

---

## Files

| File | Purpose |
|------|---------|
| `scripts/demo-w6-sell.js` | Terminal demo: 5 beats, live or `--fixture` |
| `src/plan-ladder.js` | Multi-plan extractor (6 sites, 0 LLM tokens) |
| `src/plan-ladder-email.js` | Customer email template |
| `outbox/samples/` | Pre-generated sample emails for reference |
| `docs/retros/wedge-demo-7d.md` | Full W1–W3 + W6 evidence retrospective |

---

*Internal ops note: `scripts/plan-picker-server.js` serves an HTML plan picker
for internal testing. It binds to a local port and is NOT part of the sell
recording path. Do not screen-record the browser picker for customer-facing video.*
