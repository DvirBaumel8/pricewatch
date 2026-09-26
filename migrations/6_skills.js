/**
 * Wave 4 Phase B — skills table for Neon-hosted skill persistence.
 *
 * Replaces file-only data/skills/<id>.json with a Neon row so GHA daily
 * can load skills without a local filesystem checkout.
 *
 * Columns:
 *   id          — skill id (e.g. "vercel-com-8bd87c12"), PK
 *   site        — hostname slug for fast lookup
 *   payload     — full skill JSON (same shape as data/skills/*.json)
 *   baseline    — optional baseline snapshot for change detection
 *   created_at  — row creation timestamp
 *   updated_at  — last update timestamp
 */

exports.up = (pgm) => {
  pgm.createTable('skills', {
    id: { type: 'text', primaryKey: true },
    site: { type: 'text' },
    payload: { type: 'jsonb', notNull: true },
    baseline: { type: 'jsonb' },
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

  pgm.createIndex('skills', 'site');
};

exports.down = (pgm) => {
  pgm.dropTable('skills');
};
