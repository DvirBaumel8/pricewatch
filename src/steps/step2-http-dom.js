/**
 * Step 2 — HTTP GET + DOM / regex extraction.
 * Zero LLM tokens. One page load. Max 15s.
 *
 * Site-specific extractors are tried first; if none match, a set of
 * generic pricing-page heuristics run as fallback.
 */
const { fetchHtml } = require("./http-fetch");

// ── Site extractors ─────────────────────────────────────────────────

const extractors = {

  "plausible.io": {
    extract(html, target) {
      // Plausible renders pricing with Alpine x-text, but the SSR HTML
      // contains the default value.  Pattern:
      //   x-text="price(currency, volumeIndex, 'starter', 'monthly')"> $9 </span>
      //   … /month
      const m = html.match(
        /price\(\s*currency\s*,\s*volumeIndex\s*,\s*'starter'\s*,\s*'monthly'\)\s*">\s*\$(\d+)\s*</
      );
      if (!m) return null;
      return {
        price: Number(m[1]),
        currency: "USD",
        period: "month",
        perUnit: null,
        planName: "Starter",
        site: "plausible.io",
        selector: '[x-text*="starter"][x-text*="monthly"]',
        regex: "price\\(.*?'starter'.*?'monthly'\\).*?\\$(\\d+)",
        confidence: "high",
        notes: "SSR value from Alpine x-text binding; ~10k pageviews default band",
      };
    },
  },

  "linear.app": {
    extract(html, target) {
      // Linear SSR contains an accessibility span:
      //   <span class="…visuallyHidden">$10 per user/month</span>
      // right after the <h3>Basic</h3> heading.  Also aria-label on
      // <number-flow-react>.
      //
      // Strategy: find the Basic section, then grab the first
      // "$N per user/month" string.
      const basicIdx = html.indexOf('id="basic"');
      if (basicIdx === -1) return null;
      const chunk = html.slice(basicIdx, basicIdx + 3000);

      const m = chunk.match(/\$(\d+)\s+per\s+user\/month/);
      if (!m) return null;
      return {
        price: Number(m[1]),
        currency: "USD",
        period: "month",
        perUnit: "user",
        planName: "Basic",
        site: "linear.app",
        selector: '#basic [class*="visuallyHidden"], #basic [aria-label*="per user/month"]',
        regex: 'id="basic".*?\\$(\\d+)\\s+per\\s+user/month',
        confidence: "high",
        notes: "Extracted from visually-hidden span near #basic section; page says 'Billed yearly'",
      };
    },
  },

  "vercel.com": {
    extract(html, target) {
      // Vercel SSR embeds a planPrices JSON block in the RSC payload with
      // escaped quotes:  \"planPrices\":{\"pro\":{\"amount\":\"$$20\",\"suffix\":\"/mo.\"}}
      // The heading renders near a "Popular" badge:
      //   Popular</span>…<span class="text-heading-…">$20</span><span…>/mo.</span>
      // Feature table row: "Developer seat" → "$$20 / month"

      let price = null;
      let notes = "";

      const jsonMatch = html.match(
        /\\?"planPrices\\?"[\s\S]{0,300}?\\?"pro\\?"\s*:\s*\{[^}]*?\\?"amount\\?"\s*:\s*\\?"\$\$(\d+)\\?"/
      );
      if (jsonMatch) {
        price = Number(jsonMatch[1]);
        notes = `Embedded RSC JSON: pro.amount=$$${price}`;
      }

      const headingMatch = html.match(
        /Popular<\/span>[\s\S]{0,500}?text-heading-\d+[^>]*>\$(\d+)<\/span><span[^>]*>\/mo\./
      );
      if (headingMatch) {
        const domPrice = Number(headingMatch[1]);
        if (price === null) {
          price = domPrice;
          notes = `DOM heading (Pro/Popular section): $${domPrice}/mo.`;
        } else if (domPrice === price) {
          notes += "; confirmed by DOM heading near Popular badge";
        }
      }

      const seatMatch = html.match(
        /\\?"Developer seat\\?"[\s\S]{0,400}?\\?"proTitle\\?"\s*:\s*\\?"\$\$(\d+)\s*\/\s*month\\?"/
      );
      if (seatMatch) {
        const seatPrice = Number(seatMatch[1]);
        if (price !== null && seatPrice === price) {
          notes += `; Developer seat row confirms $${seatPrice}/month`;
        }
      }

      if (price === null) return null;

      return {
        price,
        currency: "USD",
        period: "month",
        perUnit: "developer seat",
        planName: "Pro",
        site: "vercel.com",
        selector: '.text-heading-32 (near Popular badge)',
        regex: 'planPrices.*?pro.*?amount.*?\\$\\$(\\d+)',
        jsonPath: 'planPrices.pro.amount',
        confidence: "high",
        notes,
      };
    },
  },

  "slack.com": {
    extract(html, target) {
      // Slack SSR renders plan cards with class "plan-type--pro".
      // Inside the Pro card, the standard monthly price is in a
      // <span class="v--strikeprice">$8.75</span> (struck through for promo).
      // The promo price is in <span class="plan-emphasized-rate">$4.38…</span>.
      // The term text: "per user / month, when paying monthly"
      //
      // We extract the strikeprice (standard monthly), NOT the promo.

      const proIdx = html.indexOf('plan-type--pro');
      if (proIdx === -1) return null;
      const chunk = html.slice(proIdx, proIdx + 3000);

      const strikeMatch = chunk.match(/v--strikeprice">\$(\d+(?:\.\d{1,2})?)</);
      if (!strikeMatch) return null;

      const standardPrice = Number(strikeMatch[1]);

      const promoMatch = chunk.match(/plan-emphasized-rate">\$(\d+(?:\.\d{1,2})?)/);
      const promoPrice = promoMatch ? Number(promoMatch[1]) : null;

      const termMatch = chunk.match(/term-copy[^>]*>([^<]+)</);
      const termText = termMatch ? termMatch[1].trim() : "";

      let notes = `Standard monthly: $${standardPrice}`;
      if (promoPrice !== null) {
        notes += `; promo: $${promoPrice} (ignored — 50% off limited-time offer)`;
      }
      if (termText) notes += `; term: "${termText}"`;

      return {
        price: standardPrice,
        currency: "USD",
        period: "month",
        perUnit: "active user",
        planName: "Pro",
        site: "slack.com",
        selector: '.plan-type--pro .v--strikeprice',
        regex: 'plan-type--pro[\\s\\S]{0,1500}v--strikeprice">\\$(\\d+\\.\\d{2})',
        confidence: "high",
        notes,
      };
    },
  },

  "shopify.com": {
    extract(html, target) {
      // Shopify SSR renders pricing cards with a flex layout.
      // The Basic card: <p>Basic</p><p> <!-- -->$29<small class="text-xs">/mo</small></p>
      // Promo trap: "$1/month for 3 months" appears elsewhere on the page.
      // The comparison table also has "Pay monthly" → "$39 USD/mo" (full monthly)
      // and "Pay yearly" → "$29 USD/mo" (annual rate).
      // The main card shows $29/mo (the standard annual-billing rate).

      const cardMatch = html.match(
        /text-t7"><p>Basic<\/p><p>\s*(?:<!--[^>]*-->)?\s*\$(\d+)<small[^>]*>\/mo<\/small>/
      );
      if (!cardMatch) return null;

      const cardPrice = Number(cardMatch[1]);

      let notes = `Card heading: Basic $${cardPrice}/mo`;

      const yearlyMatch = html.match(
        /Pay yearly[\s\S]{0,200}?\$(\d+)\s+USD\/mo/
      );
      if (yearlyMatch) {
        const yearlyPrice = Number(yearlyMatch[1]);
        if (yearlyPrice === cardPrice) {
          notes += `; yearly row confirms $${yearlyPrice} USD/mo`;
        }
      }

      const monthlyMatch = html.match(
        /Pay monthly[\s\S]{0,200}?\$(\d+)\s+USD\/mo/
      );
      if (monthlyMatch) {
        notes += `; pay-monthly rate: $${monthlyMatch[1]} USD/mo (higher, ignored)`;
      }

      if (html.includes("$1/month for 3 months") || html.includes("$1 per month")) {
        notes += "; $1/mo intro promo present on page (ignored)";
      }

      return {
        price: cardPrice,
        currency: "USD",
        period: "month",
        perUnit: null,
        planName: "Basic",
        site: "shopify.com",
        selector: '.text-t7 p:first-child + p',
        regex: 'text-t7"><p>Basic</p><p>[^$]*\\$(\\d+)<small[^>]*>/mo',
        confidence: "high",
        notes,
      };
    },
  },

  "notion.com": {
    extract(html, target) {
      // Notion embeds structured pricing JSON in the page.
      // We can also read from the rendered PricingPlanCard headings:
      //   heading">Plus</h3> … heading">$10</span>
      //
      // Dual strategy: prefer structured JSON, validate with DOM.

      let price = null;
      let notes = "";

      // Strategy A: embedded JSON  "plus":{"USD":{"month":{…},"year":{…"unit_amount":12000…}}}
      // Annual price / 12 = monthly displayed price (page defaults to annual toggle)
      const plusBlock = html.match(/"plus"\s*:\s*\{\s*"USD"\s*:\s*(\{[\s\S]{0,1000}?\})\s*\}/);
      if (plusBlock) {
        const block = plusBlock[1];
        const monthMatch = block.match(/"month"\s*:\s*\{[^}]*"unit_amount"\s*:\s*(\d+)/);
        const yearMatch = block.match(/"year"\s*:\s*\{[^}]*"unit_amount"\s*:\s*(\d+)/);
        const monthlyAmountCents = monthMatch ? Number(monthMatch[1]) : null;
        const yearlyAmountCents = yearMatch ? Number(yearMatch[1]) : null;
        const yearlyPerMonth = yearlyAmountCents ? yearlyAmountCents / 100 / 12 : null;
        const monthlyPrice = monthlyAmountCents ? monthlyAmountCents / 100 : null;

        // The page displays the annual-billed price ($10) by default
        price = yearlyPerMonth !== null ? yearlyPerMonth : monthlyPrice;
        notes = `Embedded JSON: monthly=${monthlyPrice}, yearly/12=${yearlyPerMonth}; page default shows annual billing`;
      }

      // Strategy B: DOM headings — validate
      const domMatch = html.match(
        /heading">\s*Plus\s*<\/h3>[\s\S]{0,500}?heading">\s*\$(\d+)\s*</
      );
      if (domMatch) {
        const domPrice = Number(domMatch[1]);
        if (price === null) {
          price = domPrice;
          notes = "Extracted from PricingPlanCard heading pair (Plus → $N)";
        } else if (domPrice !== price) {
          notes += `; DOM shows $${domPrice} (mismatch — using DOM displayed value)`;
          price = domPrice;
        } else {
          notes += "; confirmed by DOM heading";
        }
      }

      if (price === null) return null;

      return {
        price,
        currency: "USD",
        period: "month",
        perUnit: "member",
        planName: "Plus",
        site: "notion.com",
        selector: '.PricingPlanCard h3:contains("Plus") + .pricingWrap .heading',
        regex: 'heading">\\s*Plus.*?heading">\\s*\\$(\\d+)',
        jsonPath: "plus.USD.year.unit_amount (÷1200) or plus.USD.month.unit_amount (÷100)",
        confidence: "high",
        notes,
      };
    },
  },
};

// ── Generic fallback ────────────────────────────────────────────────

function genericExtract(html, target) {
  // Try to find a dollar amount in the vicinity of the target keywords.
  const keywords = target.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const priceRe = /\$(\d+(?:\.\d{1,2})?)/g;
  let match;
  const candidates = [];
  while ((match = priceRe.exec(html)) !== null) {
    const start = Math.max(0, match.index - 500);
    const end = Math.min(html.length, match.index + 500);
    const ctx = html.slice(start, end).toLowerCase();
    const hits = keywords.filter(k => ctx.includes(k)).length;
    if (hits > 0) {
      candidates.push({ price: Number(match[1]), hits, index: match.index });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.hits - a.hits || a.index - b.index);
  const best = candidates[0];
  return {
    price: best.price,
    currency: "USD",
    period: "month",
    confidence: "low",
    notes: `Generic fallback: matched ${best.hits} keywords near $${best.price}`,
  };
}

// ── Step runner ─────────────────────────────────────────────────────

async function runStep2({ url, target }) {
  const html = await fetchHtml(url);
  const hostname = new URL(url).hostname.replace(/^www\./, "");

  // Try site-specific extractor
  for (const [domain, ext] of Object.entries(extractors)) {
    if (hostname === domain || hostname.endsWith("." + domain)) {
      const result = ext.extract(html, target);
      if (result) return result;
    }
  }

  // Fallback to generic
  return genericExtract(html, target);
}

module.exports = { runStep2, extractors };
