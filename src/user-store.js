/**
 * User store — Neon-backed users + email-verify-tokens (F5).
 *
 * Users are identified by Google OAuth subject (google_subject).
 * notify_email defaults to the Google account email on first login.
 * When notify_email === Google email, verification is skipped (Q6 locked).
 * When they differ, a verify token must be consumed before watches proceed.
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

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    google_subject: row.google_subject,
    email: row.email,
    notify_email: row.notify_email,
    notify_verified_at: row.notify_verified_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Find or create user from Google OAuth profile.
 * On first sign-in, notify_email = Google email and notify_verified_at = now()
 * (same-email rule: skip verify when notify matches Google email).
 */
async function findOrCreateFromGoogle({ google_subject, email }) {
  if (!dbAvailable()) {
    throw new Error('No database pool — user operations require Neon');
  }
  if (!google_subject) throw new Error('google_subject is required');
  if (!email) throw new Error('email is required');

  const normalizedEmail = email.toLowerCase().trim();

  const existing = await query(
    'SELECT * FROM users WHERE google_subject = $1',
    [google_subject]
  );
  if (existing.rows[0]) {
    const user = existing.rows[0];
    if (user.email !== normalizedEmail) {
      await query(
        'UPDATE users SET email = $1, updated_at = now() WHERE id = $2',
        [normalizedEmail, user.id]
      );
      user.email = normalizedEmail;
    }
    return rowToUser(user);
  }

  const id = generateId();
  const res = await query(
    `INSERT INTO users (id, google_subject, email, notify_email, notify_verified_at, created_at, updated_at)
     VALUES ($1, $2, $3, $3, now(), now(), now())
     RETURNING *`,
    [id, google_subject, normalizedEmail]
  );
  return rowToUser(res.rows[0]);
}

async function getById(id) {
  if (!dbAvailable()) return null;
  const res = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rowToUser(res.rows[0] || null);
}

async function getByGoogleSubject(googleSubject) {
  if (!dbAvailable()) return null;
  const res = await query(
    'SELECT * FROM users WHERE google_subject = $1',
    [googleSubject]
  );
  return rowToUser(res.rows[0] || null);
}

/**
 * Check if user's notify email is verified.
 * Q6 rule: verified if notify_email === email (Google account)
 * OR if notify_verified_at is set.
 */
function isNotifyVerified(user) {
  if (!user) return false;
  const googleEmail = (user.email || '').toLowerCase().trim();
  const notifyEmail = (user.notify_email || '').toLowerCase().trim();
  if (notifyEmail === googleEmail) return true;
  return !!user.notify_verified_at;
}

/**
 * Set notify email. If same as Google email → auto-verify.
 * If different → clear verification, caller must issue a verify token.
 * Returns { user, needsVerification }.
 */
async function setNotifyEmail(userId, notifyEmail) {
  if (!dbAvailable()) {
    throw new Error('No database pool — user operations require Neon');
  }
  const normalizedNotify = notifyEmail.toLowerCase().trim();
  const user = await getById(userId);
  if (!user) throw new Error('User not found');

  const googleEmail = user.email.toLowerCase().trim();
  const sameAsGoogle = normalizedNotify === googleEmail;

  const verifiedAt = sameAsGoogle ? 'now()' : 'NULL';
  const res = await query(
    `UPDATE users
     SET notify_email = $1,
         notify_verified_at = ${verifiedAt},
         updated_at = now()
     WHERE id = $2
     RETURNING *`,
    [normalizedNotify, userId]
  );
  const updated = rowToUser(res.rows[0]);
  return { user: updated, needsVerification: !sameAsGoogle };
}

/**
 * Create a verify token for the user's current notify_email.
 * Token expires in 1 hour.
 */
async function createVerifyToken(userId) {
  if (!dbAvailable()) {
    throw new Error('No database pool — user operations require Neon');
  }
  const user = await getById(userId);
  if (!user) throw new Error('User not found');
  if (!user.notify_email) throw new Error('No notify email set');

  const id = generateId();
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await query(
    `INSERT INTO email_verify_tokens (id, user_id, email, token, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [id, userId, user.notify_email, token, expiresAt.toISOString()]
  );

  return { token, email: user.notify_email, expires_at: expiresAt.toISOString() };
}

/**
 * Consume a verify token. On success, sets notify_verified_at on the user
 * (only if the token's email still matches current notify_email).
 * Returns { verified, reason }.
 */
async function consumeVerifyToken(token) {
  if (!dbAvailable()) {
    throw new Error('No database pool — user operations require Neon');
  }
  const res = await query(
    'SELECT * FROM email_verify_tokens WHERE token = $1',
    [token]
  );
  const row = res.rows[0];
  if (!row) return { verified: false, reason: 'invalid_token' };
  if (row.consumed_at) return { verified: false, reason: 'already_consumed' };
  if (new Date(row.expires_at) < new Date()) {
    return { verified: false, reason: 'expired' };
  }

  await query(
    'UPDATE email_verify_tokens SET consumed_at = now() WHERE id = $1',
    [row.id]
  );

  const user = await getById(row.user_id);
  if (!user) return { verified: false, reason: 'user_not_found' };

  const currentNotify = (user.notify_email || '').toLowerCase().trim();
  const tokenEmail = (row.email || '').toLowerCase().trim();
  if (currentNotify !== tokenEmail) {
    return { verified: false, reason: 'email_changed' };
  }

  await query(
    'UPDATE users SET notify_verified_at = now(), updated_at = now() WHERE id = $1',
    [row.user_id]
  );

  return { verified: true, user: await getById(row.user_id) };
}

/**
 * Delete a user and their verify tokens (test cleanup).
 */
async function deleteUser(id) {
  if (!dbAvailable()) return;
  await query('DELETE FROM email_verify_tokens WHERE user_id = $1', [id]);
  await query('DELETE FROM customers WHERE user_id = $1', [id]);
  await query('DELETE FROM users WHERE id = $1', [id]);
}

module.exports = {
  dbAvailable,
  generateId,
  findOrCreateFromGoogle,
  getById,
  getByGoogleSubject,
  isNotifyVerified,
  setNotifyEmail,
  createVerifyToken,
  consumeVerifyToken,
  deleteUser,
};
