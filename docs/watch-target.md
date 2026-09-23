# WatchTarget (F2)

Canonical unit of watch for PriceWatch B2B and B2C. When
`DATABASE_URL` or `DATABASE_URL_NODE` is set, **Neon is authoritative**.
File JSON (`data/customers.json`) is dual-write / lab fallback only.

Token budget: **0 LLM**.

## Fields (`watch_targets` table)

| Field | Type | Notes |
|--|--|--|
| `id` | text PK | Same id used as legacy competitor id |
| `customer_id` | text | Owner customer |
| `surface` | text | `b2b` \| `b2c` |
| `label` | text | Competitor name or product label |
| `source_url` | text | Pricing / product page URL (may be empty; Service B marks unsupported) |
| `target_description` | text | Which plan/price to watch |
| `plan_key` | text nullable | Selected plan key (intake / F4) |
| `skill_id` | text nullable | Skill basename (no `.json`) |
| `status` | text | `pending_onboarding` \| `skill_ready` \| `unsupported` \| `needs_ceo` \| `error` |
| `failure_count` | int | Default 0 (incremented in F3) |
| `created_at` / `updated_at` | timestamptz | |

Customers live in `customers` (`id`, `name`, `email`, `created_at`).

## Service A endpoints

| Method | Path | Behavior |
|--|--|--|
| `POST` | `/customers` | Create customer (Neon upsert + file dual-write) |
| `POST` | `/customers/:id/watch-targets` | Create WatchTarget (`surface` default `b2b`) |
| `POST` | `/watch-targets` | Same; body must include `customer_id` |
| `GET` | `/watch-targets/:id` | Read one WatchTarget (requires Neon) |
| `GET` | `/customers/:id/watch-targets` | List WatchTargets for customer |
| `POST` | `/customers/:id/competitors` | **Compat shim** → WatchTarget `surface=b2b` + enqueue onboarding |
| `GET` | `/customers/:id` | Customer + `competitors[]` (b2b shape) + `watch_targets[]` when Neon |

### Create WatchTarget body

```json
{
  "surface": "b2b",
  "label": "Acme Pricing",
  "source_url": "https://example.com/pricing",
  "target_description": "Pro monthly",
  "plan_key": null
}
```

Aliases accepted: `name`→`label`, `pricing_url`→`source_url`,
`target_price_description`→`target_description`.

## Competitor ↔ WatchTarget mapping

| Legacy competitor field | WatchTarget field |
|--|--|
| `id` | `id` (same value) |
| `name` | `label` |
| `pricingUrl` | `source_url` |
| `targetPriceDescription` | `target_description` |
| `status` | `status` |
| `skillPath` (`data/skills/<id>.json`) | `skill_id` (`<id>`) |
| `addedAt` | `created_at` |
| _(implied B2B)_ | `surface = "b2b"` |

`POST /customers/:id/competitors` writes a WatchTarget under the hood when
Neon is available and still returns the legacy `{ competitor, job, … }`
payload (plus `watch_target` when present). Service B continues to call
`updateCompetitorStatus`, which updates the WatchTarget row in Neon.

## Chris proof: create → GET (Neon)

```bash
set -a && source /home/box/secrets/pricewatch.env && set +a
# or: export DATABASE_URL=… / DATABASE_URL_NODE=…

npm run test:watch-target
# or start Service A and curl:

npm run service-a   # another terminal

curl -sS -X POST http://127.0.0.1:3850/customers \
  -H 'content-type: application/json' \
  -d '{"name":"Chris Lab","email":"chris@example.com"}'

# use returned id:
curl -sS -X POST http://127.0.0.1:3850/customers/CUSTOMER_ID/watch-targets \
  -H 'content-type: application/json' \
  -d '{"surface":"b2b","label":"Lab Target","source_url":"http://127.0.0.1:3847/","target_description":"Pro plan"}'

curl -sS http://127.0.0.1:3850/watch-targets/WATCH_TARGET_ID
```

Without `DATABASE_URL` / `DATABASE_URL_NODE`, `npm run test:watch-target`
**exits 0 with SKIP** (documented fail-closed for CI without secrets).
With secrets set, missing Neon connectivity **fails** the test.
