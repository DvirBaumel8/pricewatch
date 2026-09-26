/**
 * Wave 4 — daily_ledger table for hosted B2B daily job tracking.
 *
 * One row per (watch_target, Jerusalem calendar day).
 * Idempotent claim via UNIQUE constraint.
 * Statuses: claimed → success | failed | blocked | skipped.
 */

exports.up = (pgm) => {
  pgm.createTable('daily_ledger', {
    id:               { type: 'text', primaryKey: true },
    watch_target_id:  { type: 'text', notNull: true },
    customer_id:      { type: 'text', notNull: true },
    skill_id:         { type: 'text' },
    jerusalem_day:    { type: 'text', notNull: true },
    status:           { type: 'text', notNull: true, default: "'claimed'" },
    result:           { type: 'text' },
    reason:           { type: 'text' },
    retry_count:      { type: 'integer', notNull: true, default: 0 },
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

  pgm.addConstraint('daily_ledger', 'daily_ledger_one_per_day',
    { unique: ['watch_target_id', 'jerusalem_day'] }
  );

  pgm.addConstraint('daily_ledger', 'daily_ledger_status_check', {
    check: "status IN ('claimed', 'success', 'failed', 'blocked', 'skipped')",
  });

  pgm.createIndex('daily_ledger', 'jerusalem_day');
  pgm.createIndex('daily_ledger', 'status');
  pgm.createIndex('daily_ledger', 'customer_id');
};

exports.down = (pgm) => {
  pgm.dropTable('daily_ledger');
};
