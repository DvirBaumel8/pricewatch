# CI — GitHub Actions merge gate (F7)

## Workflow

`.github/workflows/ci.yml` runs on every pull request targeting `main`
(and on pushes to `main`).

## Jobs

| Job        | What it does                                    | Fail = block merge? |
|------------|-------------------------------------------------|----------------------|
| **Test**   | `npm ci` then `npm test` (unit / offline tests) | **Yes**              |
| **Lint**   | `npm run lint` — `node --check` syntax check on all JS source files | **Yes** |

### Notes

- **Test** runs the existing offline test suite. No `DATABASE_URL` is
  needed — tests do not connect to Neon.
- **Lint** currently uses `node --check` for syntax validation. When
  ESLint is added later, update the `lint` script in `package.json`.
- **Security** was removed from CI. Day-to-day `npm audit` in PR checks
  added noise without meaningful protection. Real security hardening is
  tracked in pre-prod backlog item PP-1 (harden + review).

## Required status checks (Chris — merge gate)

To enforce these as merge gates, a repo admin must enable branch
protection on `main`:

1. **Settings → Branches → Branch protection rules → Add rule**
2. Branch name pattern: `main`
3. Enable **Require status checks to pass before merging**
4. Search and select these check names:
   - `Test`
   - `Lint`
5. Optionally enable **Require branches to be up to date before merging**
6. Save changes

After this, PRs cannot merge while either of these two jobs is red.

## No DATABASE_URL in CI

Wave 1 CI does not need Neon credentials. If DB integration tests are
added later, store `DATABASE_URL` as a GitHub Actions secret and
reference it in the workflow:

```yaml
env:
  DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

Use a dedicated Neon branch for CI to avoid polluting the shared database.

## Continuous deploy (Render)

After CI passes on `main`, the **Deploy to Render** workflow
(`.github/workflows/deploy-render.yml`) triggers a Render deploy via a
deploy hook. Deploys only happen when both Test and Lint are green.

See `docs/render-ops.md` for full Render ops documentation, environment
variable setup, and the deploy hook configuration steps.

## Daily cron (GitHub Actions schedule)

`.github/workflows/daily-cron.yml` runs the PriceWatch daily pipeline
(enqueue → monitor → send-outbox) on a schedule.

| Trigger | When |
|---|---|
| `on.schedule` | `0 3 * * *` UTC (06:00 Jerusalem summer / 05:00 winter) |
| `on.workflow_dispatch` | Manual one-shot via Actions UI |

### Disarmed by default

The workflow checks the GitHub Actions **variable** `PRICEWATCH_CRON_ARMED`.
When it is not set to `1`, the job logs `"disarmed — skip"` and exits
green — no enqueue, no monitor, no mail.

**To arm:** set `PRICEWATCH_CRON_ARMED` to `1` in GitHub → repo Settings →
Secrets and variables → Actions → Variables. See `docs/cron-pilot.md`
for full instructions.

### Secrets

The workflow maps GitHub Actions secrets (names only) into the runner
environment for `scripts/render-cron-daily.sh`. Required: `DATABASE_URL`.
Optional: `DATABASE_URL_NODE`, `PRICEWATCH_KILL`, `RESEND_API_KEY`,
mail transport + allowlist secrets. See `docs/cron-pilot.md` for the
full secret list.

> **Note:** Render cron is **CANCELLED** (paid Starter plan). The daily
> schedule uses GitHub Actions only. Do not add `type: cron` to
> `render.yaml`.
