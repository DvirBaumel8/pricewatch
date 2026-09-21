# PriceWatch lab site (test 7.1)

Controlled fake pricing page for MVP tests.

## Run
```bash
node server.js
# → http://127.0.0.1:3847/
```

## Change price (for cron tests)
```bash
curl -s -X POST http://127.0.0.1:3847/set-price \
  -H 'Content-Type: application/json' \
  -d '{"amount":39}'
```

## What scrapers should read
- Visible: `#price` text like `$29/mo`
- Attributes: `data-amount`, `data-currency`, `data-period`
- Or: `GET /price.json` (API-like path for ladder step 1)

## Pass criteria (spec 7.1)
Change price in &lt;1 minute; reload shows new price.
