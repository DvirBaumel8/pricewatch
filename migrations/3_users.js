/**
 * F5 schema — users + email_verify_tokens (Rob).
 *
 * users: Google OAuth identity, notify email, verification state.
 * email_verify_tokens: one-time tokens for notify-email verification.
 *
 * Ties into existing customers table via optional user_id FK on customers.
 */

exports.up = (pgm) => {
  pgm.createTable('users', {
    id:                  { type: 'text', primaryKey: true },
    google_subject:      { type: 'text', notNull: true, unique: true },
    email:               { type: 'text', notNull: true },
    notify_email:        { type: 'text' },
    notify_verified_at:  { type: 'timestamptz' },
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

  pgm.createIndex('users', 'email');

  pgm.createTable('email_verify_tokens', {
    id:         { type: 'text', primaryKey: true },
    user_id:    { type: 'text', notNull: true, references: 'users(id)' },
    email:      { type: 'text', notNull: true },
    token:      { type: 'text', notNull: true, unique: true },
    consumed_at: { type: 'timestamptz' },
    expires_at: {
      type: 'timestamptz',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('email_verify_tokens', 'token');
  pgm.createIndex('email_verify_tokens', 'user_id');

  pgm.addColumns('customers', {
    user_id: { type: 'text', references: 'users(id)' },
  });
  pgm.createIndex('customers', 'user_id');
};

exports.down = (pgm) => {
  pgm.dropColumns('customers', ['user_id']);
  pgm.dropTable('email_verify_tokens');
  pgm.dropTable('users');
};
