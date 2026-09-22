# T4 — Service A + Service B

How to run Service A, Service B, and tests against the lab site.

## Prerequisites

- Node.js 18+
- No external services required (no Redis, no databases)

## Architecture

```
Customer → Service A (HTTP API, port 3850)
              │
              └─ POST /customers/:id/competitors
                   → enqueue job to data/queue.json
                                    ↓
           Service B (worker script)
              → consume job → run discovery ladder → write skill
              → mark job done/failed → update competitor status
```

Storage:
- `data/customers.json` — customer + competitor records
- `data/queue.json` — durable job queue (pendingCustomerOnboardingRequests)
- `data/skills/*.json` — discovered pricing skills

## Quick Start

### 1. Start the lab site

```bash
node lab/server.js
# → http://127.0.0.1:3847/
```

### 2. Start Service A

```bash
npm run service-a
# or: node src/service-a.js
# → http://127.0.0.1:3850/
```

### 3. Create a customer and add a competitor

```bash
# Create customer
curl -s -X POST http://127.0.0.1:3850/customers \
  -H 'Content-Type: application/json' \
  -d '{"name": "My Company", "email": "me@example.com"}'

# Add competitor (use the customer id from above)
curl -s -X POST http://127.0.0.1:3850/customers/<CUSTOMER_ID>/competitors \
  -H 'Content-Type: application/json' \
  -d '{"name": "Acme Lab", "pricing_url": "http://127.0.0.1:3847/", "target_price_description": "main monthly price"}'
```

### 4. Run Service B (process jobs)

```bash
# Process all pending jobs once:
npm run service-b
# or: node scripts/run-onboarding-worker.js

# Watch mode (poll every 5s):
npm run service-b:watch
# or: node scripts/run-onboarding-worker.js --watch
```

### 5. Check results

```bash
# Customer with competitors + skill status
curl -s http://127.0.0.1:3850/customers/<CUSTOMER_ID> | jq .

# All jobs
curl -s http://127.0.0.1:3850/jobs | jq .
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/customers` | Create customer (`name`, `email`) |
| POST | `/customers/:id/competitors` | Add competitor (`name`, `pricing_url`, `target_price_description`) + enqueue |
| GET | `/customers/:id` | Customer detail + competitors + jobs |
| GET | `/customers` | List all customers |
| GET | `/jobs` | List all onboarding jobs |
| GET | `/jobs/:id` | Single job detail |

## Running Tests

### Unit tests (queue)

```bash
npm run test:queue
# or: node test/test-queue.js
```

### E2E tests (§7.7–7.10)

Requires lab + Service A running:

```bash
# Terminal 1: lab
node lab/server.js

# Terminal 2: Service A
node src/service-a.js

# Terminal 3: run E2E
npm run test:e2e
# or: node test/test-service-ab.js
```

### All unit tests

```bash
npm test
```

## Test Plan Coverage

| Test | Section | What it proves |
|------|---------|---------------|
| `test-queue.js` | §7.7 | Queue enqueue/dequeue, idempotency, durability |
| `test-service-ab.js` §7.7 | §7.7 | HTTP create customer + competitor → exactly one job |
| `test-service-ab.js` §7.8 | §7.8 | Lab discovery → skill ready, job done |
| `test-service-ab.js` §7.9 | §7.9 | Bogus URL / no URL → job failed, no hang |
| `test-service-ab.js` §7.10 | §7.10 | Second customer same URL → step 0 reuse |

## Data Files

All state persists in `data/` (gitignored except skills and `.gitkeep`):
- `data/queue.json` — job queue
- `data/customers.json` — customer records
- `data/skills/*.json` — discovered skills

To reset: delete `data/queue.json` and `data/customers.json`.
