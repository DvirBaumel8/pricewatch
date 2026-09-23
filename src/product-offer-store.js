/**
 * ProductOffer store (F6 / CB-15).
 *
 * Stub catalog of merchant products with affiliate redirect info.
 * Affiliate fields live here — never on B2B competitor emails.
 *
 * Fields: merchant_url, affiliate_url (or affiliate_program_id),
 *   disclosure, skill_id (optional), active flag, label.
 *
 * Token budget: 0 LLM.
 */
'use strict';

const crypto = require('crypto');
const { query, getPool } = require('./db');

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
    skill_id: row.skill_id,
    active: row.active,
    label: row.label,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SEED_OFFERS = Object.freeze([
  {
    id: 'offer-plausible-growth',
    merchant_url: 'https://plausible.io/pricing',
    affiliate_url: 'https://aff.example.com/plausible?ref=pricewatch',
    affiliate_program_id: 'plausible-aff-001',
    disclosure: 'PriceWatch earns a commission if you subscribe via this link.',
    skill_id: 'plausible-io',
    active: true,
    label: 'Plausible Analytics — Growth',
  },
  {
    id: 'offer-linear-standard',
    merchant_url: 'https://linear.app/pricing',
    affiliate_url: null,
    affiliate_program_id: 'linear-partner-002',
    disclosure: 'PriceWatch may receive referral credit for sign-ups via this link.',
    skill_id: 'linear-app',
    active: true,
    label: 'Linear — Standard',
  },
]);

async function create(opts) {
  if (!dbAvailable()) {
    throw new Error('No database pool — cannot create ProductOffer without Neon');
  }
  if (!opts.merchant_url) throw new Error('merchant_url is required');
  if (!opts.disclosure) throw new Error('disclosure is required');
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
      opts.disclosure,
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
  SEED_OFFERS,
  create,
  getById,
  listActive,
  listAll,
  seedOffers,
  recordClick,
  getClickCount,
};
