/**
 * F1 schema — customers + watch_targets (Rob).
 *
 * Prefer DATABASE_URL for the app pool (src/db.js).
 * For migrations: DATABASE_URL_UNPOOLED if set, else DATABASE_URL_NODE
 * if set, else DATABASE_URL. Never log connection strings.
 *
 * Intentionally does not touch schema_meta (owned by 1_schema-meta.js).
 */

exports.up = (pgm) => {
  pgm.createTable('customers', {
    id:         { type: 'text', primaryKey: true },
    name:       { type: 'text', notNull: true },
    email:      { type: 'text' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createTable('watch_targets', {
    id:                 { type: 'text', primaryKey: true },
    customer_id:        { type: 'text', notNull: true },
    surface:            { type: 'text', notNull: true },
    label:              { type: 'text', notNull: true },
    source_url:         { type: 'text', notNull: true },
    target_description: { type: 'text', notNull: true },
    plan_key:           { type: 'text' },
    skill_id:           { type: 'text' },
    status:             { type: 'text', notNull: true },
    failure_count:      { type: 'integer', notNull: true, default: 0 },
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

  pgm.addConstraint('watch_targets', 'watch_targets_surface_check', {
    check: "surface IN ('b2b', 'b2c')",
  });

  pgm.addConstraint('watch_targets', 'watch_targets_status_check', {
    check:
      "status IN ('pending_onboarding', 'skill_ready', 'unsupported', 'needs_ceo', 'error')",
  });

  pgm.createIndex('watch_targets', 'customer_id');
  pgm.createIndex('watch_targets', 'status');
};

exports.down = (pgm) => {
  pgm.dropTable('watch_targets');
  pgm.dropTable('customers');
};
