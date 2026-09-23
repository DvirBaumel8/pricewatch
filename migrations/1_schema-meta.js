/**
 * Placeholder migration — creates schema_meta table for tracking
 * application-level schema version metadata.
 *
 * Rob will add the real WatchTarget schema in F2.
 */

exports.up = (pgm) => {
  pgm.createTable('schema_meta', {
    key:        { type: 'text', primaryKey: true },
    value:      { type: 'text', notNull: true },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.sql(`
    INSERT INTO schema_meta (key, value)
    VALUES ('schema_version', '1 — placeholder (F1)')
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('schema_meta');
};
