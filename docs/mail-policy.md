# PriceWatch — Mail policy (allowlist gate)

## Summary

Until the M1b milestone is reached, `send-outbox.js` enforces an internal/test
allowlist. Only recipients on the allowlist receive email. Non-allowlisted
recipients are **skipped** (not fatal) with a clear log line; the outbox JSON
is preserved for audit.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PRICEWATCH_MAIL_ALLOWLIST` | no | empty | Comma-separated email addresses. Added to the allowlist alongside auto-included addresses below. |
| `PRICEWATCH_M1B_UNLOCK` | no | unset (locked) | Set to `1` to disable the allowlist gate entirely — any recipient may receive mail. **Do not set until M1b is reached.** |
| `PRICEWATCH_TEST_EMAIL` | no | — | Auto-included in the allowlist (no need to duplicate in `PRICEWATCH_MAIL_ALLOWLIST`). |
| `PRICEWATCH_OPS_EMAIL` | no | — | Auto-included in the allowlist. `ops_alert` emails resolve to this address. |

## How it works

1. **Locked (default):** `PRICEWATCH_M1B_UNLOCK` is unset or empty.
   - The mailer builds an allowlist from `PRICEWATCH_MAIL_ALLOWLIST` +
     `PRICEWATCH_TEST_EMAIL` + `PRICEWATCH_OPS_EMAIL`.
   - For each outbox file, the resolved recipient (`customer_email` for
     `price_change`, `PRICEWATCH_OPS_EMAIL` for `ops_alert`) is checked
     against the allowlist (case-insensitive).
   - **Allowlisted:** send proceeds normally.
   - **Not allowlisted:** send is skipped, a `[mailer] BLOCKED` log line is
     emitted, the outbox JSON file is kept (no `.sent` marker), and the
     mailer continues to the next file. Exit code remains 0 unless other
     errors occur.

2. **Unlocked:** `PRICEWATCH_M1B_UNLOCK=1`.
   - The allowlist gate is bypassed — all recipients are allowed.
   - This should only be set after the M1b milestone is reached and the
     team is ready to send to external/customer recipients.

## Kill switch interaction

The kill switch (`PRICEWATCH_KILL=1` or `data/KILL` file) takes priority
over the allowlist gate. When killed, the mailer exits immediately with
code 0 and sends nothing — regardless of allowlist or M1b state.

## Shame-tests

Automated acceptance tests in `test/test-mail-policy.js` verify:

- Non-allowlisted recipients are blocked when M1b is locked.
- Allowlisted recipients pass the gate.
- M1b unlock allows any recipient.
- Kill switch stops mailer regardless of allowlist state.
- Outbox JSON is preserved after allowlist skip (audit trail).
- Kill switch stops enqueue (`enqueue-daily-ticks.js`).

Run with: `node test/test-mail-policy.js` (also included in `npm test`).

## See also

- `.env.example` — full variable reference
- `docs/cron-pilot.md` — cron setup and mailer exit codes
