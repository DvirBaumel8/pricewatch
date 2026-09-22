# PriceWatch — Allowlisted domains & skills

**Policy:** Pilots may only monitor pricing pages on the domains listed below.
No "any URL" — we expand coverage deliberately after validating each skill.

## Supported domains

| Domain | Skill ID | Method | Plan / target | Status |
|---|---|---|---|---|
| `plausible.io` | `plausible-io-8e774063` | DOM | Starter plan monthly ~10k pageviews | Ready (§7.5) |
| `linear.app` | `linear-app-ee93dab8` | DOM | Basic plan per user monthly | Ready (§7.5) |
| `notion.com` | `notion-com-b33227e0` | DOM | Plus plan per member monthly | Ready (§7.5) |
| `vercel.com` | `vercel-com-8bd87c12` | DOM | Pro plan per developer seat monthly | Ready (§7.5b) |
| `slack.com` | `slack-com-f0f9c5de` | DOM | Pro plan per active user monthly | Ready (§7.5b) |
| `shopify.com` | `shopify-com-e148dd18` | DOM | Basic plan monthly | Ready (§7.5b) |

Plus the **lab fixture** (`127.0.0.1:3847`) for testing — always available.

## How skills work

Each domain has a skill file in `data/skills/<id>.json` that encodes:

- The pricing page URL
- The extraction method (`api` for JSON endpoints, `dom` for HTML scraping)
- CSS-attribute selectors or regex patterns for price, currency, period
- Confidence level and failure count

The monitor uses these skills to extract prices without LLM calls (0 tokens
on supported sites).

## Adding a new domain

1. Verify the domain's pricing page is stable and scrapable
2. Create a skill file via discovery (`npm run service-b`) or manually
3. Test with a manual monitor run: `node src/monitor.js <skill-id>`
4. Add to this table
5. CEO approval before offering to partners

## Limits

- Max 10 competitors per customer (enforced by customer-store)
- Only domains in this allowlist — discovery on unknown domains may fail
  or produce unreliable skills
- Sites that use heavy JavaScript rendering, CAPTCHAs, or bot detection
  will not work with the current HTTP+DOM approach

## Out of scope (for now)

- Any-URL scraping
- Shopify product pages (distinct from shopify.com pricing)
- Sites requiring login or API keys
- Dynamic pricing pages loaded entirely via client-side JS frameworks
