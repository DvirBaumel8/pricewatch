/**
 * Auth module — Google OAuth + JWT + stub mode (F5).
 *
 * Modes:
 *   AUTH_STUB=1  → test/local: no real Google, accepts { google_subject, email } directly
 *   Real         → exchanges Google authorization code for id_token via Google tokeninfo
 *
 * JWT is HMAC-SHA256 signed with JWT_SECRET (required in production).
 * In stub mode, JWT_SECRET defaults to a test-only value.
 *
 * Env vars:
 *   GOOGLE_CLIENT_ID      — GCP OAuth 2.0 client id
 *   GOOGLE_CLIENT_SECRET  — GCP OAuth 2.0 client secret (NEVER commit)
 *   GOOGLE_REDIRECT_URI   — OAuth redirect URI
 *   JWT_SECRET            — HMAC key for session JWTs
 *   AUTH_STUB             — set to "1" for local/CI test mode
 *
 * Token budget: 0 LLM.
 */
'use strict';

const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');
const userStore = require('./user-store');

const STUB = process.env.AUTH_STUB === '1';
const JWT_SECRET = process.env.JWT_SECRET || (STUB ? 'test-jwt-secret-do-not-use-in-prod' : null);
const JWT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

function isStub() {
  return STUB;
}

function base64UrlEncode(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function signJwt(payload) {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is required (set env or use AUTH_STUB=1 for tests)');
  }
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64UrlEncode(Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor((Date.now() + JWT_EXPIRY_MS) / 1000),
  })));
  const sig = base64UrlEncode(
    crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token) {
  if (!JWT_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const sig = base64UrlEncode(
    crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest()
  );
  if (sig !== parts[2]) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]).toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Exchange Google authorization code for user profile.
 * Returns { google_subject, email, name? }.
 */
function exchangeGoogleCode(code) {
  return new Promise((resolve, reject) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'postmessage';

    if (!clientId || !clientSecret) {
      return reject(new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required'));
    }

    const postData = querystring.stringify({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.error) {
            return reject(new Error(`Google OAuth error: ${data.error_description || data.error}`));
          }
          const idToken = data.id_token;
          if (!idToken) return reject(new Error('No id_token in Google response'));

          const payloadPart = idToken.split('.')[1];
          const payload = JSON.parse(base64UrlDecode(payloadPart).toString());

          resolve({
            google_subject: payload.sub,
            email: payload.email,
            name: payload.name || null,
          });
        } catch (e) {
          reject(new Error(`Failed to parse Google token response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Handle login. In stub mode, accepts { google_subject, email } directly.
 * In real mode, exchanges { code } via Google OAuth.
 * Returns { user, token }.
 */
async function login(body) {
  let profile;

  if (STUB) {
    if (!body.google_subject || !body.email) {
      throw new Error('AUTH_STUB mode requires body { google_subject, email }');
    }
    profile = { google_subject: body.google_subject, email: body.email };
  } else {
    if (!body.code) {
      throw new Error('Google authorization code is required');
    }
    profile = await exchangeGoogleCode(body.code);
  }

  const user = await userStore.findOrCreateFromGoogle(profile);

  const token = signJwt({ sub: user.id, email: user.email });

  return { user, token };
}

/**
 * Extract user from request Authorization header (Bearer JWT).
 * Returns user object or null.
 */
async function getUserFromRequest(req) {
  const authHeader = req.headers && req.headers.authorization;
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;

  const payload = verifyJwt(match[1]);
  if (!payload || !payload.sub) return null;

  return userStore.getById(payload.sub);
}

/**
 * Middleware-style: attach req._user if valid JWT present.
 * Does not reject — call requireAuth() for protected routes.
 */
async function extractUser(req) {
  req._user = await getUserFromRequest(req);
}

/**
 * Check if request has an authenticated user.
 * Returns the user or null.
 */
function getUser(req) {
  return req._user || null;
}

module.exports = {
  isStub,
  signJwt,
  verifyJwt,
  login,
  getUserFromRequest,
  extractUser,
  getUser,
  exchangeGoogleCode,
};
