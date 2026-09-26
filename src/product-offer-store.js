/**
 * ProductOffer store (F6 / CB-15 + Wave 5 B2C catalog seed).
 *
 * Neon-backed curated catalog — merchant URL, affiliate redirect stub,
 * disclosure flag/copy. Affiliate fields live here — never on B2B emails.
 *
 * Seed uses real public product/pricing URLs (reachable / honest).
 * Affiliate destinations may be stubs (aff.example.com) until a network
 * is contracted. Token budget: 0 LLM.
 */
'use strict';

const crypto = require('crypto');
const { query, getPool } = require('./db');

/** One-line commission disclosure used when offer.disclosure is empty. */
const DEFAULT_DISCLOSURE =
  'We may earn a commission if you buy via this link.';

function dbAvailable() {
  return !!getPool();
}

function generateId() {
  return crypto.randomBytes(6).toString('hex');
}

function rowToOffer(row) {
  if (!row) return null;
  return {
    id: row.id,
    merchant_url: row.merchant_url,
    affiliate_url: row.affiliate_url,
    affiliate_program_id: row.affiliate_program_id,
    disclosure: row.disclosure,
    /** Explicit disclosure flag — true when disclosure copy is present. */
    disclosure_flag: !!(row.disclosure && String(row.disclosure).trim()),
    skill_id: row.skill_id,
    active: row.active,
    label: row.label,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Seed catalog — honest public URLs only (verified reachable at Wave 5 write).
 * Israel-relevant retail (Tami-4 / KSP class) was not stably reachable from
 * the host at seed time; Linear + Vercel pricing pages are public + skill-backed.
 * Affiliate destinations remain stubs until a real network is chosen.
 */
const SEED_OFFERS = Object.freeze([
  {
    id: 'offer-linear-standard',
    merchant_url: 'https://linear.app/pricing',
    affiliate_url: 'https://aff.example.com/linear?ref=pricewatch',
    affiliate_program_id: 'linear-partner-002',
    disclosure: DEFAULT_DISCLOSURE,
    skill_id: 'linear-app-ee93dab8',
    active: true,
    label: 'Linear — Basic',
  },
  {
    id: 'offer-vercel-pro',
    merchant_url: 'https://vercel.com/pricing',
    affiliate_url: 'https://aff.example.com/vercel?ref=pricewatch',
    affiliate_program_id: 'vercel-aff-001',
    disclosure: DEFAULT_DISCLOSURE,
    skill_id: 'vercel-com-8bd87c12',
    active: true,
    label: 'Vercel — Pro',
  },
]);

/** Tracked click path for email CTA / FE — Service A GET /r/:id. */
function trackedClickPath(offerId) {
  if (!offerId) return null;
  return `/r/${offerId}`;
}

/**
 * Resolve affiliate fields for a B2C price_change email.
 * Prefer /r/:id tracked path (logs click then 302s to affiliate_url or merchant).
 */
function affiliateFieldsForEmail(offer) {
  if (!offer || !offer.id) return null;
  const disclosure =
    (offer.disclosure && String(offer.disclosure).trim()) || DEFAULT_DISCLOSURE;
  return {
    product_offer_id: offer.id,
    affiliate_click_url: trackedClickPath(offer.id),
    disclosure_snippet: disclosure,
    disclosure_flag: true,
  };
}

async function create(opts) {
  if (!dbAvailable()) {
    throw new Error('No database pool — cannot create ProductOffer without Neon');
  }
  if (!opts.merchant_url) throw new Error('merchant_url is required');
  const disclosure = opts.disclosure || DEFAULT_DISCLOSURE;
  if (!disclosure) throw new Error('disclosure is required');
  if (!opts.label) throw new Error('label is required');

  const id = opts.id || generateId();
  const res = await query(
    `INSERT INTO product_offers (
       id, merchant_url, affiliate_url, affiliate_program_id,
       disclosure, skill_id, active, label, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       merchant_url = EXCLUDED.merchant_url,
       affiliate_url = EXCLUDED.affiliate_url,
       affiliate_program_id = EXCLUDED.affiliate_program_id,
       disclosure = EXCLUDED.disclosure,
       skill_id = EXCLUDED.skill_id,
       active = EXCLUDED.active,
       label = EXCLUDED.label,
       updated_at = now()
     RETURNING *`,
    [
      id,
      opts.merchant_url,
      opts.affiliate_url || null,
      opts.affiliate_program_id || null,
      disclosure,
      opts.skill_id || null,
      opts.active !== false,
      opts.label,
    ]
  );
  return rowToOffer(res.rows[0]);
}

async function getById(id) {
  if (!dbAvailable()) return null;
  const res = await query('SELECT * FROM product_offers WHERE id = $1', [id]);
  return rowToOffer(res.rows[0] || null);
}

async function listActive() {
  if (!dbAvailable()) return [];
  const res = await query(
    'SELECT * FROM product_offers WHERE active = true ORDER BY created_at ASC'
  );
  return res.rows.map(rowToOffer);
}

async function listAll() {
  if (!dbAvailable()) return [];
  const res = await query('SELECT * FROM product_offers ORDER BY created_at ASC');
  return res.rows.map(rowToOffer);
}

async function seedOffers() {
  if (!dbAvailable()) return [];
  const results = [];
  for (const offer of SEED_OFFERS) {
    results.push(await create(offer));
  }
  return results;
}

async function recordClick(offerId, { userId, ip, userAgent } = {}) {
  if (!dbAvailable()) {
    throw new Error('No database pool — cannot record click without Neon');
  }
  const id = generateId();
  const res = await query(
    `INSERT INTO click_log (id, product_offer_id, user_id, ip, user_agent, created_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING *`,
    [id, offerId, userId || null, ip || null, userAgent || null]
  );
  return res.rows[0];
}

async function getClickCount(offerId) {
  if (!dbAvailable()) return 0;
  const res = await query(
    'SELECT COUNT(*)::int AS n FROM click_log WHERE product_offer_id = $1',
    [offerId]
  );
  return res.rows[0].n;
}

module.exports = {
  dbAvailable,
  generateId,
  DEFAULT_DISCLOSURE,
  SEED_OFFERS,
  trackedClickPath,
  affiliateFieldsForEmail,
  create,
  getById,
  listActive,
  listAll,
  seedOffers,
  recordClick,
  getClickCount,
};
