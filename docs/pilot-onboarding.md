# PriceWatch — Pilot onboarding runbook

**Goal:** Hand-onboard one design partner onto PriceWatch. They get a daily
real email when an allowlisted competitor's price changes.

**Time budget:** < 30 minutes per partner.

---

## 1. Pre-flight checklist

- [ ] Pilot box is running (Node 18+, repo pulled to latest `main`)
- [ ] `.env` is populated — at minimum `RESEND_API_KEY` (preferred) or
      `PRICEWATCH_SMTP_PASS` is set (see `.env.example` and `docs/cron-pilot.md`)
- [ ] Lab test passed: `npm run test:e2e:mailer` shows PASS with real SMTP
      **or** mock-mode passes and real-send is documented for CEO
- [ ] Cron or nohup loop is active (see `docs/cron-pilot.md`)
- [ ] Kill switch is **not** active (`data/KILL` does not exist,
      `PRICEWATCH_KILL` is unset)

## 2. Create the partner as a customer

```bash
# Start Service A (if not already running)
node src/service-a.js &

# Create customer — use their real email
curl -s -X POST http://127.0.0.1:3850/customers \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Partner Name",
    "email": "partner@example.com"
  }' | jq .
# → note the returned customer id
```

## 3. Add competitors (≤ 10, allowlisted domains only)

Only domains from `docs/allowlist.md` are supported. Max 10 competitors per
customer.

```bash
CUSTOMER_ID=<id-from-step-2>

curl -s -X POST "http://127.0.0.1:3850/customers/$CUSTOMER_ID/competitors" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Competitor Display Name",
    "pricing_url": "https://plausible.io/",
    "target_price_description": "Starter plan monthly price"
  }' | jq .
```

Repeat for each competitor (up to 10).

## 4. Run onboarding (Service B — skill discovery)

```bash
node scripts/run-onboarding-worker.js
```

Check result:

```bash
curl -s "http://127.0.0.1:3850/customers/$CUSTOMER_ID" | jq '.competitors[] | {name, status, skillPath}'
```

All competitors should show `"status": "skill_ready"`. If any show
`discovery_failed`, the site may not be on the allowlist or the pricing page
structure changed — see troubleshooting below.

## 5. Verify with a manual run

```bash
# Enqueue + monitor + send in one shot
bash scripts/cron-daily-monitor.sh
```

- If the price is unchanged since the last snapshot: **no email** (correct).
- To force a test email on lab: change lab price, then re-run:

```bash
curl -s -X POST http://127.0.0.1:3847/set-price \
  -H 'Content-Type: application/json' -d '{"amount": 39}'
bash scripts/cron-daily-monitor.sh
# → partner should receive email within seconds
```

## 5b. gmail-mcp drain (preferred §8.1 path — no secrets needed)

When `send-outbox.js` exits 7 (no SMTP_PASS / RESEND_API_KEY), a Cursor
agent with the **Gmail MCP** connected to `price.watcher.service@gmail.com`
drains the outbox instead.

**Locked test address:** `PRICEWATCH_TEST_EMAIL=dvirbaumel9@gmail.com`

### Agent workflow

1. **List unsent files** (no network — pure filesystem):

```bash
node scripts/list-unsent-outbox.js
```

Prints one JSON line per unsent `outbox/*.json`:

```json
{"file":"price-change_lab_2026-09-22T15-00-00-000Z.json","to":"dvirbaumel9@gmail.com","subject":"Price changed: main monthly price at …","body":"The main monthly price at …\n\n  Before: $29/mo\n  After:  $49/mo\n…"}
```

2. **Agent sends each entry** via Gmail MCP `send_message`:
   - **From:** `price.watcher.service@gmail.com` (the OAuth-authenticated account)
   - **To:** `entry.to` (customer email — or `dvirbaumel9@gmail.com` for lab tests)
   - **Subject:** `entry.subject`
   - **Body:** `entry.body`

3. **Mark sent** after each successful MCP send:

```bash
node scripts/mark-outbox-sent.js <entry.file> gmail-mcp
```

This writes the `.sent` sidecar — same format as SMTP/Resend, so
idempotency works across all three transports. Outbox JSON is kept as
audit trail.

## 6. Confirm inbox delivery

- Check the partner's inbox (or `price.watcher.service@gmail.com` for lab tests)
- Verify: subject mentions the competitor, body shows before/after amounts
- Verify: no duplicate on re-run (`.sent` sidecar prevents re-send across all transports)

## 7. Enable daily cron

See `docs/cron-pilot.md` for crontab or nohup loop setup. The daily cron:

1. Enqueues ticks for all `skill_ready` competitors
2. Runs monitor checks (0 LLM for supported sites)
3. Sends any price-change emails via SMTP/Resend
4. Logs to `logs/cron-daily.log`

---

## What we promise / don't promise

**We promise:**
- Daily check of allowlisted competitor pricing pages
- Email notification within minutes of detecting a change
- No spam: only real price changes trigger email
- Kill switch available at any time

**We don't promise:**
- Coverage of every website (only allowlisted domains — see `docs/allowlist.md`)
- Real-time monitoring (daily cadence)
- 100% accuracy on complex pricing pages
- SLA on uptime (pilot phase)

## Kill switch

To stop all monitoring and email for a partner immediately:

```bash
# Stop everything
touch data/KILL

# Resume later
rm data/KILL
```

Or set `PRICEWATCH_KILL=1` in `.env`.

## How to cancel / remove a partner

Currently manual (no self-serve UI yet):

1. Stop cron or kill switch
2. Remove customer from `data/customers.json` (or remove their competitors)
3. Resume cron

---

## Ops section (Boris)

### Env vars

All mail-related env vars are documented in `.env.example` and `docs/cron-pilot.md`.

**Resend (preferred — §8.1 path):**

- `RESEND_API_KEY` — Resend API key (Carlos provides via secret-request)
- `PRICEWATCH_MAIL_FROM=PriceWatch <onboarding@resend.dev>` — Resend sandbox sender
  (or a verified custom domain; Resend cannot send as `@gmail.com`)
- `PRICEWATCH_MAIL_REPLY_TO=price.watcher.service@gmail.com` — replies go to support inbox

**SMTP fallback (when Gmail app password available):**

- `PRICEWATCH_SMTP_USER=price.watcher.service@gmail.com`
- `PRICEWATCH_SMTP_PASS` — Gmail app password (Carlos provides via secret-request)
- `PRICEWATCH_SMTP_HOST=smtp.gmail.com`
- `PRICEWATCH_SMTP_PORT=587` (STARTTLS)
- `PRICEWATCH_MAIL_FROM` — defaults to `SMTP_USER` for SMTP path

**Transport override:** set `PRICEWATCH_MAIL_TRANSPORT=resend` (or `smtp`) to
force one transport when both credentials are configured.

### Cron stay-alive

Boris owns the cron/nohup setup on the pilot box. Reference:

- `scripts/cron-daily-monitor.sh` — sources `.env`, runs enqueue → C → mailer
- `scripts/pilot-daily-loop.sh` — nohup fallback if no crontab
- `docs/cron-pilot.md` — full setup instructions

The cron script already calls `send-outbox.js` at the end of each run.
No additional wiring needed — just ensure `.env` has `PRICEWATCH_SMTP_PASS`.

### Mailer exit codes

| Code | Meaning | Action |
|---|---|---|
| 0 | All sent (or nothing to send) | Normal |
| 1 | Some sends failed | Check `logs/cron-daily.log`, retry |
| 7 | No credentials | Set `RESEND_API_KEY` or `PRICEWATCH_SMTP_PASS` in `.env` |

### Monitoring

- Outbox files: `outbox/*.json` (audit trail, kept)
- Send receipts: `outbox/*.json.sent` (idempotency markers)
- Logs: `logs/cron-daily.log`

---

## Troubleshooting

| Problem | Fix |
|---|---|
| No email received | Check `outbox/` for `.json` files; check `.sent` sidecars; check `logs/cron-daily.log` for mailer errors |
| Exit code 7 | No mail credentials — set `RESEND_API_KEY` or `PRICEWATCH_SMTP_PASS` in `.env` |
| Duplicate emails | Should not happen (`.sent` sidecar prevents). If it does, check for corrupted `.sent` files |
| Discovery failed | Site may not be allowlisted; check `docs/allowlist.md` |
| Kill switch active | Remove `data/KILL` and unset `PRICEWATCH_KILL` |
