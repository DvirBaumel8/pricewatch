# CI — GitHub Actions merge gate (F7)

## Workflow

`.github/workflows/ci.yml` runs on every pull request targeting `main`
(and on pushes to `main`).

## Jobs

| Job        | What it does                                    | Fail = block merge? |
|------------|-------------------------------------------------|----------------------|
| **Test**   | `npm ci` then `npm test` (unit / offline tests) | **Yes**              |
| **Lint**   | `npm run lint` — `node --check` syntax check on all JS source files | **Yes** |
| **Security** | `npm audit --audit-level=high`                | **Yes**              |

### Notes

- **Test** runs the existing offline test suite. No `DATABASE_URL` is
  needed — tests do not connect to Neon.
- **Lint** currently uses `node --check` for syntax validation. When
  ESLint is added later, update the `lint` script in `package.json`.
- **Security** runs `npm audit`. With minimal dependencies this may
  report zero issues; the job still runs so future dependency additions
  are checked automatically.

## Required status checks (Chris — merge gate)

To enforce these as merge gates, a repo admin must enable branch
protection on `main`:

1. **Settings → Branches → Branch protection rules → Add rule**
2. Branch name pattern: `main`
3. Enable **Require status checks to pass before merging**
4. Search and select these check names:
   - `Test`
   - `Lint`
   - `Security audit`
5. Optionally enable **Require branches to be up to date before merging**
6. Save changes

After this, PRs cannot merge while any of these three jobs is red.

## No DATABASE_URL in CI

Wave 1 CI does not need Neon credentials. If DB integration tests are
added later, store `DATABASE_URL` as a GitHub Actions secret and
reference it in the workflow:

```yaml
env:
  DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

Use a dedicated Neon branch for CI to avoid polluting the shared database.
