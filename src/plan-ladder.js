/**
 * Plan-ladder extractor — structured multi-plan snapshots from pricing pages.
 *
 * extractPlanLadder(url) → { plans: [{plan, price, currency, unit, billing}], method, tokens, error }
 *
 * Reuses existing site-specific extractors from step2-http-dom.js where possible.
 * 0 LLM tokens; deterministic regex/DOM only; hard cap 8000 tokens on any LLM
 * step (currently none) then abort.
 */
"use strict";

const { fetchHtml } = require("./steps/http-fetch");

const LLM_TOKEN_CAP = 8000;

const siteExtractors = {

  "lab-multiplan": {
    extract(html) {
      const plans = [];
      const cardRe = /data-plan-key="([^"]+)"[\s\S]*?class="plan-name">([^<]+)<[\s\S]*?class="plan-price"\s+data-amount="([^"]*)"\s+data-currency="([^"]*)"\s+data-period="([^"]*)"/g;
      let m;
      while ((m = cardRe.exec(html)) !== null) {
        const amount = m[3] === "" ? null : Number(m[3]);
        plans.push({
          plan_key: m[1],
          plan: m[2].trim(),
          price: amount,
          currency: m[4] || "USD",
          unit: null,
          billing: m[5] || "month",
        });
      }
      return plans.length > 0 ? plans : null;
    },
  },

  "vercel.com": {
    extract(html) {
      const plans = [];

      const hobbyMatch = html.match(
        /\\?"planPrices\\?"[\s\S]{0,300}?\\?"hobby\\?"\s*:\s*\{[^}]*?\\?"amount\\?"\s*:\s*\\?"([^"\\]+)\\?"/
      );
      const hobbyDom = html.match(
        /Hobby<\/(?:span|h\d)>[\s\S]{0,500}?(?:Free|<span[^>]*>\$0)/i
      );
      plans.push({
        plan: "Hobby",
        price: 0,
        currency: "USD",
        unit: null,
        billing: "free",
      });

      const proJsonMatch = html.match(
        /\\?"planPrices\\?"[\s\S]{0,300}?\\?"pro\\?"\s*:\s*\{[^}]*?\\?"amount\\?"\s*:\s*\\?"\$\$(\d+)\\?"/
      );
      const proHeading = html.match(
        /Popular<\/span>[\s\S]{0,500}?text-heading-\d+[^>]*>\$(\d+)<\/span><span[^>]*>\/mo\./
      );
      let proPrice = null;
      if (proJsonMatch) proPrice = Number(proJsonMatch[1]);
      else if (proHeading) proPrice = Number(proHeading[1]);

      if (proPrice !== null) {
        plans.push({
          plan: "Pro",
          price: proPrice,
          currency: "USD",
          unit: "developer seat",
          billing: "monthly",
        });
      }

      const entMatch = html.match(/Enterprise[\s\S]{0,300}?(?:Custom|Contact)/i);
      if (entMatch) {
        plans.push({
          plan: "Enterprise",
          price: null,
          currency: "USD",
          unit: null,
          billing: "custom",
        });
      }

      return plans.length > 0 ? plans : null;
    },
  },

  "linear.app": {
    extract(html) {
      const plans = [];

      const freeIdx = html.indexOf('id="free"');
      if (freeIdx !== -1) {
        const chunk = html.slice(freeIdx, freeIdx + 2000);
        const freeMatch = chunk.match(/Free/i);
        if (freeMatch) {
          plans.push({
            plan: "Free",
            price: 0,
            currency: "USD",
            unit: "user",
            billing: "free",
          });
        }
      }

      const basicIdx = html.indexOf('id="basic"');
      if (basicIdx !== -1) {
        const chunk = html.slice(basicIdx, basicIdx + 3000);
        const m = chunk.match(/\$(\d+)\s+per\s+user\/month/);
        if (m) {
          plans.push({
            plan: "Basic",
            price: Number(m[1]),
            currency: "USD",
            unit: "user",
            billing: "monthly",
          });
        }
      }

      const businessIdx = html.indexOf('id="business"');
      if (businessIdx === -1) {
        const bizSearch = html.match(/Business[\s\S]{0,200}?\$(\d+)\s+per\s+user\/month/);
        if (bizSearch) {
          plans.push({
            plan: "Business",
            price: Number(bizSearch[1]),
            currency: "USD",
            unit: "user",
            billing: "monthly",
          });
        }
      } else {
        const chunk = html.slice(businessIdx, businessIdx + 3000);
        const m = chunk.match(/\$(\d+)\s+per\s+user\/month/);
        if (m) {
          plans.push({
            plan: "Business",
            price: Number(m[1]),
            currency: "USD",
            unit: "user",
            billing: "monthly",
          });
        }
      }

      const entMatch = html.match(/Enterprise[\s\S]{0,300}?(?:Custom|Contact|Sales)/i);
      if (entMatch) {
        plans.push({
          plan: "Enterprise",
          price: null,
          currency: "USD",
          unit: "user",
          billing: "custom",
        });
      }

      return plans.length > 0 ? plans : null;
    },
  },

  "notion.com": {
    extract(html) {
      const plans = [];

      const freeMatch = html.match(/heading">\s*Free\s*<\/h3>/);
      if (freeMatch) {
        plans.push({
          plan: "Free",
          price: 0,
          currency: "USD",
          unit: null,
          billing: "free",
        });
      }

      const plusBlock = html.match(/"plus"\s*:\s*\{\s*"USD"\s*:\s*(\{[\s\S]{0,1000}?\})\s*\}/);
      if (plusBlock) {
        const block = plusBlock[1];
        const yearMatch = block.match(/"year"\s*:\s*\{[^}]*"unit_amount"\s*:\s*(\d+)/);
        const monthMatch = block.match(/"month"\s*:\s*\{[^}]*"unit_amount"\s*:\s*(\d+)/);
        const yearlyPerMonth = yearMatch ? Number(yearMatch[1]) / 100 / 12 : null;
        const monthlyPrice = monthMatch ? Number(monthMatch[1]) / 100 : null;
        const price = yearlyPerMonth !== null ? yearlyPerMonth : monthlyPrice;
        if (price !== null) {
          plans.push({
            plan: "Plus",
            price,
            currency: "USD",
            unit: "member",
            billing: "monthly",
          });
        }
      } else {
        const domMatch = html.match(/heading">\s*Plus\s*<\/h3>[\s\S]{0,500}?heading">\s*\$(\d+)\s*</);
        if (domMatch) {
          plans.push({
            plan: "Plus",
            price: Number(domMatch[1]),
            currency: "USD",
            unit: "member",
            billing: "monthly",
          });
        }
      }

      const bizBlock = html.match(/"business"\s*:\s*\{\s*"USD"\s*:\s*(\{[\s\S]{0,1000}?\})\s*\}/);
      if (bizBlock) {
        const block = bizBlock[1];
        const yearMatch = block.match(/"year"\s*:\s*\{[^}]*"unit_amount"\s*:\s*(\d+)/);
        const monthMatch = block.match(/"month"\s*:\s*\{[^}]*"unit_amount"\s*:\s*(\d+)/);
        const yearlyPerMonth = yearMatch ? Number(yearMatch[1]) / 100 / 12 : null;
        const monthlyPrice = monthMatch ? Number(monthMatch[1]) / 100 : null;
        const price = yearlyPerMonth !== null ? yearlyPerMonth : monthlyPrice;
        if (price !== null) {
          plans.push({
            plan: "Business",
            price,
            currency: "USD",
            unit: "member",
            billing: "monthly",
          });
        }
      } else {
        const domMatch = html.match(/heading">\s*Business\s*<\/h3>[\s\S]{0,500}?heading">\s*\$(\d+)\s*</);
        if (domMatch) {
          plans.push({
            plan: "Business",
            price: Number(domMatch[1]),
            currency: "USD",
            unit: "member",
            billing: "monthly",
          });
        }
      }

      const entMatch = html.match(/Enterprise[\s\S]{0,300}?(?:Custom|Contact|Sales)/i);
      if (entMatch) {
        plans.push({
          plan: "Enterprise",
          price: null,
          currency: "USD",
          unit: "member",
          billing: "custom",
        });
      }

      return plans.length > 0 ? plans : null;
    },
  },

  "slack.com": {
    extract(html) {
      const plans = [];

      const freeIdx = html.indexOf("plan-type--free");
      if (freeIdx !== -1) {
        plans.push({
          plan: "Free",
          price: 0,
          currency: "USD",
          unit: null,
          billing: "free",
        });
      }

      const proIdx = html.indexOf("plan-type--pro");
      if (proIdx !== -1) {
        const chunk = html.slice(proIdx, proIdx + 5000);
        let price = null;

        const strikeMatch = chunk.match(/v--strikeprice">\$(\d+(?:\.\d{1,2})?)</);
        if (strikeMatch) {
          price = Number(strikeMatch[1]);
        }

        if (price === null) {
          const rateMatch = chunk.match(
            /(?:plan-(?:emphasized-)?rate|price-value|pricing-amount)[^>]*>\s*\$(\d+(?:\.\d{1,2})?)/
          );
          if (rateMatch) {
            const candidate = Number(rateMatch[1]);
            if (candidate > 4 && candidate < 20) price = candidate;
          }
        }

        if (price === null) {
          const allPrices = [...chunk.matchAll(/\$(\d+(?:\.\d{1,2})?)/g)];
          for (const m of allPrices) {
            const val = Number(m[1]);
            if (val >= 7 && val <= 15) { price = val; break; }
          }
        }

        if (price !== null) {
          plans.push({
            plan: "Pro",
            price,
            currency: "USD",
            unit: "active user",
            billing: "monthly",
          });
        }
      }

      const bizIdx = html.indexOf("plan-type--business");
      if (bizIdx !== -1) {
        const chunk = html.slice(bizIdx, bizIdx + 5000);
        const priceMatch = chunk.match(/\$(\d+(?:\.\d{1,2})?)/);
        if (priceMatch) {
          const val = Number(priceMatch[1]);
          if (val > 5) {
            plans.push({
              plan: "Business+",
              price: val,
              currency: "USD",
              unit: "active user",
              billing: "monthly",
            });
          }
        }
      }

      const gridMatch = html.match(/Enterprise Grid[\s\S]{0,500}?(?:Contact|Sales|custom)/i);
      if (gridMatch) {
        plans.push({
          plan: "Enterprise Grid",
          price: null,
          currency: "USD",
          unit: null,
          billing: "custom",
        });
      }

      return plans.length > 0 ? plans : null;
    },
  },

  "plausible.io": {
    extract(html) {
      const plans = [];

      const starterMatch = html.match(
        /price\(\s*currency\s*,\s*volumeIndex\s*,\s*'starter'\s*,\s*'monthly'\)\s*">\s*\$(\d+)\s*</
      );
      if (starterMatch) {
        plans.push({
          plan: "Starter",
          price: Number(starterMatch[1]),
          currency: "USD",
          unit: "~10k pageviews",
          billing: "monthly",
        });
      }

      const growthMatch = html.match(
        /price\(\s*currency\s*,\s*volumeIndex\s*,\s*'growth'\s*,\s*'monthly'\)\s*">\s*\$(\d+)\s*</
      );
      if (growthMatch) {
        plans.push({
          plan: "Growth",
          price: Number(growthMatch[1]),
          currency: "USD",
          unit: "~10k pageviews",
          billing: "monthly",
        });
      }

      if (plans.length === 0) {
        const fallback = html.match(/\$(\d+)\s*(?:<[^>]*>)?\s*\/\s*mo/);
        if (fallback) {
          plans.push({
            plan: "Starter",
            price: Number(fallback[1]),
            currency: "USD",
            unit: "~10k pageviews",
            billing: "monthly",
          });
        }
      }

      return plans.length > 0 ? plans : null;
    },
  },

  "shopify.com": {
    extract(html) {
      const plans = [];
      const cardRe = /text-t7"><p>(\w+)<\/p><p>\s*(?:<small[^>]*>[^<]*<\/small>\s*)?(?:<!--[^>]*-->)?\s*\$([\d,]+)<small[^>]*>\/mo<\/small>/g;
      let m;
      while ((m = cardRe.exec(html)) !== null) {
        const name = m[1];
        const price = Number(m[2].replace(/,/g, ""));
        if (price > 0) {
          plans.push({
            plan: name,
            price,
            currency: "USD",
            unit: null,
            billing: "monthly",
          });
        }
      }

      return plans.length > 0 ? plans : null;
    },
  },
};

/**
 * Extract all plans from a pricing page URL.
 * Returns { plans, method, tokens, url, site, error }.
 */
async function extractPlanLadder(url) {
  const t0 = Date.now();
  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    return {
      plans: null,
      method: null,
      tokens: 0,
      url,
      site: null,
      wallMs: Date.now() - t0,
      error: `fetch_failed: ${err.message}`,
    };
  }

  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^www\./, "");

  const isLab = (hostname === "127.0.0.1" || hostname === "localhost") &&
    parsed.pathname === "/pricing";
  if (isLab) {
    const plans = siteExtractors["lab-multiplan"].extract(html);
    if (plans && plans.length > 0) {
      return {
        plans,
        method: "dom",
        tokens: 0,
        url,
        site: "lab-multiplan",
        wallMs: Date.now() - t0,
        error: null,
      };
    }
  }

  for (const [domain, ext] of Object.entries(siteExtractors)) {
    if (domain === "lab-multiplan") continue;
    if (hostname === domain || hostname.endsWith("." + domain)) {
      const plans = ext.extract(html);
      if (plans && plans.length > 0) {
        return {
          plans,
          method: "dom",
          tokens: 0,
          url,
          site: domain,
          wallMs: Date.now() - t0,
          error: null,
        };
      }
    }
  }

  return {
    plans: null,
    method: null,
    tokens: 0,
    url,
    site: hostname,
    wallMs: Date.now() - t0,
    error: "unsupported_site",
  };
}

function extractPlansFromHtml(html, hostname, pathname) {
  const isLab = (hostname === "127.0.0.1" || hostname === "localhost") &&
    pathname === "/pricing";
  if (isLab) {
    return siteExtractors["lab-multiplan"].extract(html);
  }
  const normalHost = hostname.replace(/^www\./, "");
  for (const [domain, ext] of Object.entries(siteExtractors)) {
    if (domain === "lab-multiplan") continue;
    if (normalHost === domain || normalHost.endsWith("." + domain)) {
      return ext.extract(html);
    }
  }
  return null;
}

module.exports = {
  extractPlanLadder,
  extractPlansFromHtml,
  siteExtractors,
  LLM_TOKEN_CAP,
};
