# W6 sell-demo runbook — screen record ≤90s

**For:** Carlos (record) · Launch (beat sheet)  
**Dev state:** Record-ready. No setup needed beyond `git clone` + `node ≥18`.

## Quick start (one command)

```bash
node scripts/demo-w6-sell.js
```

This fetches Vercel's **live** pricing page, extracts the full plan ladder,
simulates a Pro +$5 price bump, fires the diff → email, then proves the
noise gate stays silent on banner-only changes. ~2 seconds, no secrets needed.

### Offline fallback (no network)

```bash
node scripts/demo-w6-sell.js --fixture
```

Uses hardcoded Vercel fixture data instead of a live fetch. Identical flow,
guaranteed reproducible.

---

## What the camera sees (4 scenes, ~60s of terminal)

### Scene 1 — Structured plan ladder (live)

The script fetches `https://vercel.com/pricing` and prints a clean table:

```
Plan            | Price       | Unit             | Billing
--------------- | ----------- | ---------------- | --------
Hobby           | $0          | —                | free
Pro             | $20         | developer seat   | monthly
Enterprise      | Custom      | —                | custom
```

**Narration:** "We extract the full plan ladder — structured, not vague.
Hobby is free, Pro is $20 per developer seat, Enterprise is custom."

### Scene 2 — Simulate price bump

The script injects Pro $20 → $25 into the snapshot. Table updates on screen.

**Narration:** "Now we simulate Vercel raising the Pro price by $5."

### Scene 3 — Alert fires → customer email

The diff engine detects the price change. A customer email prints:

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

### Scene 4 — Banner-only → silent

The script re-runs with identical plans (simulating a banner/copy change).

```
Changes detected: 0
Signal: NO → no email
✓ Noise gate working: banner/copy changes do not trigger alerts.
```

**Narration:** "And when it's just a banner change — no email. No noise.
That's the difference versus Visualping."

---

## Recording tips for Carlos

1. **Terminal setup:** Dark background, large font (≥16pt), max 80 columns wide.
2. **Clear the terminal** before running: `clear && node scripts/demo-w6-sell.js`
3. The entire demo runs in **<3 seconds** — scroll is clean, no waiting.
4. **No secrets needed.** No `.env` file required. Works on a fresh clone.
5. No localhost/127.0.0.1 appears in any output — customer-facing safe.

## Alternative demo: live allowlist scan

To show breadth (6 SaaS sites in one pass):

```bash
node src/plan-ladder-monitor.js --allowlist
```

Outputs all 6 sites with plan counts. Good as a "wide shot" before the
Vercel deep-dive.

## Test suite (optional post-roll)

```bash
npm test
```

Shows all 88 tests passing in ~1 second. Good closing frame.

---

## Files referenced

| File | Purpose |
|------|---------|
| `scripts/demo-w6-sell.js` | Self-contained demo script (live or fixture) |
| `src/plan-ladder.js` | Multi-plan extractor (6 sites, 0 LLM tokens) |
| `src/plan-ladder-diff.js` | Diff engine + noise gate |
| `src/plan-ladder-email.js` | Customer email template |
| `outbox/samples/` | Pre-generated sample emails for reference |
| `docs/retros/wedge-demo-7d.md` | Full W1–W3 evidence retrospective |
