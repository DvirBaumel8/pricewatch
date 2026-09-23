/**
 * F6 schema — product_offers, user_packages, click_log (Rob).
 *
 * product_offers: stub catalog — merchant URL, affiliate URL/program,
 *   disclosure, skillId optional, active flag.
 * user_packages: B2C slot packages — free-3 default, then purchased packages.
 * click_log: affiliate redirect click tracking for GET /r/:id.
 *
 * Affiliate fields live here — NOT on B2B competitor emails.
 */

exports.up = (pgm) => {
  pgm.createTable('product_offers', {
    id:              { type: 'text', primaryKey: true },
    merchant_url:    { type: 'text', notNull: true },
    affiliate_url:   { type: 'text' },
    affiliate_program_id: { type: 'text' },
    disclosure:      { type: 'text', notNull: true },
    skill_id:        { type: 'text' },
    active:          { type: 'boolean', notNull: true, default: true },
    label:           { type: 'text', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('product_offers', 'active');

  pgm.createTable('user_packages', {
    id:           { type: 'text', primaryKey: true },
    user_id:      { type: 'text', notNull: true, references: 'users(id)' },
    package_type: { type: 'text', notNull: true },
    slot_count:   { type: 'integer', notNull: true },
    granted_via:  { type: 'text', notNull: true },
    active:       { type: 'boolean', notNull: true, default: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.addConstraint('user_packages', 'user_packages_type_check', {
    check: "package_type IN ('free', 'pkg_1', 'pkg_3', 'pkg_5', 'pkg_10', 'unlimited')",
  });

  pgm.addConstraint('user_packages', 'user_packages_granted_check', {
    check: "granted_via IN ('signup', 'payment', 'payment_stub', 'admin')",
  });

  pgm.createIndex('user_packages', 'user_id');

  pgm.createTable('click_log', {
    id:              { type: 'text', primaryKey: true },
    product_offer_id: { type: 'text', notNull: true, references: 'product_offers(id)' },
    user_id:         { type: 'text' },
    ip:              { type: 'text' },
    user_agent:      { type: 'text' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('click_log', 'product_offer_id');
  pgm.createIndex('click_log', 'created_at');
};

exports.down = (pgm) => {
  pgm.dropTable('click_log');
  pgm.dropTable('user_packages');
  pgm.dropTable('product_offers');
};
