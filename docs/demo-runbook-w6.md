# W6 sell-demo runbook — browser UI ≤90–120s

**For:** Carlos (record) · Launch (beat sheet v2 inbox-first)  
**Dev state:** Browser sell UI ready. Inbox is the hero. No secrets needed.

## Primary record path (browser)

```bash
npm run demo-ui
```

Then open the PriceWatch page in the browser **fullscreen** and **hide the address bar**.

- Cold open already shows a **preloaded** sample alert: Pro $20 → $25 (Plan · Was · Now).
- Inbox-only frame for Beat 1: append `?view=inbox` to the page URL.
- Fresh workbench (no sample): `?demo=fresh`.

**Do not** show the address bar, terminal, or JSON on camera.

### Fresh clone setup (before first run)

```bash
git clone https://github.com/DvirBaumel8/pricewatch.git
cd pricewatch
# optional engineer setup: extract live pricing plans from supported pages
npm run demo-ui
```

---

## What the camera sees (script v2 — inbox first)

### Beat 0 — Cold open (~2s)

Split UI idle with inbox already showing an unread PriceWatch row. Music starts.

**Caption:** Competitor price — in your inbox.

### Beat 1 — Inbox hero (~22s) — LEAD

1. Click the unread row (subject like `Pro $20 → $25 · vercel.com`).
2. Hold on the open message — large **Plan · Was · Now** table ($20/mo → $25/mo).

**Narration:** "When a competitor’s Pro plan moves from twenty to twenty-five dollars, you get one email. Plan name. Old number. New number."

### Beat 2 — Problem + not noise (~8s)

Optional cutaway: hand-refresh on a public pricing tab, or a noisy “page changed” alert — then cut back.

**Caption:** Hand-refresh is the old way · Banner ≠ price

### Beat 3 — How it works (~28s)

On the left workbench:

1. Pricing URL is prefilled (`https://vercel.com/pricing`) → click **Read plans**.
2. Pricing plans table fills (Hobby / Pro / Enterprise…).
3. Tap **Pro** (or **Watch all paid plans**). Chip: Watching: Pro.
4. Click **Simulate price bump** — inbox updates with a fresh alert.

**Narration:** "Paste a pricing page we support. We read the plans and prices. You tap which plan to watch."

### Beat 4 — Banner silence (~12s)

Click **Simulate banner-only**. Trust banner: *No price changes — banner/copy edits stay quiet.* No new unread.

**Narration:** "Cookie banners stay quiet. We check once a day, morning Israel time."

### Beat 5 — Ask (~8s)

End card / VO: Pitch A + soft CTA — pilot when ready / waitlist. No outreach.

---

## Recording tips

1. **Fullscreen browser,** hide address bar, zoom 125–150% if needed so the Was/Now table reads on phone preview.
2. **Inbox first** — do not lecture setup before the email open.
3. Large type is already in the UI; keep captions ≤8 words/line.
4. Continuous music bed; zero dead air in the first 5–10s.
5. **No terminal, no localhost, no JSON** on camera.
6. One competitor for the whole clip (Vercel default).

## Test suite (optional closing frame)

```bash
npm test
```

---

## Sell-facing assets

| Asset | Purpose |
|------|---------|
| `npm run demo-ui` | **Primary sell UI** — workbench + inbox hero |
| `outbox/samples/` | Pre-generated sample emails for reference |

---

## Engineer-only footnote (not for sell recording)

Internal modules power the UI (`scripts/demo-ui-server.js`, pricing-plan extractors, selection store, email writer).

```bash
npm run ladder:allowlist          # extract live pricing plans (~3s, network)
node scripts/demo-w6-sell.js      # CLI paced script — engineer only
node scripts/demo-w6-sell.js --fixture
```

Do **not** screen-record the terminal for customer-facing video. The CEO rejected CLI as the demo surface.

Internal HTML plan picker (`npm run pick`) is also engineer-only — not the sell path.
