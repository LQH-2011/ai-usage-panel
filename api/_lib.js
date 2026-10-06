'use strict';

/**
 * Shared helpers: CORS, JSON responses, password hashing (scrypt), stateless
 * HMAC session tokens, and a timeout-bounded JSON fetch.
 *
 * Written against plain Node `http` primitives (res.statusCode / setHeader /
 * end) so the exact same modules run on Vercel and under dev-server.js.
 */

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// ── CORS ────────────────────────────────────────────────────────────────────

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(req) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-cron-secret',
    Vary: 'Origin',
  };
  const origin = req && req.headers ? req.headers.origin : null;
  // Echo the origin only when it is explicitly allow-listed. Same-origin and
  // localhost requests simply get no ACAO header (the browser only enforces
  // CORS cross-origin), which is the desired behaviour.
  if (origin && allowedOrigins().includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function setHeaders(res, obj) {
  for (const [k, v] of Object.entries(obj)) res.setHeader(k, v);
}

/** Always returns true when it handled an OPTIONS preflight. */
function handlePreflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  setHeaders(res, corsHeaders(req));
  res.statusCode = 204;
  res.end();
  return true;
}

function sendJson(req, res, code, body) {
  setHeaders(res, corsHeaders(req));
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// ── Body parsing ────────────────────────────────────────────────────────────

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ── Passwords (scrypt) ──────────────────────────────────────────────────────

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (salt.length !== 16 || expected.length === 0) return false;
  const actual = crypto.scryptSync(password, salt, expected.length, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return crypto.timingSafeEqual(actual, expected);
}

// ── Session tokens (stateless HMAC) ─────────────────────────────────────────

function b64urlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Fails closed: throws when AUTH_TOKEN_SECRET is missing/empty. */
function signToken(sub, ttlMs = TOKEN_TTL_MS) {
  const secret = process.env.AUTH_TOKEN_SECRET;
  if (!secret) throw new Error('AUTH_TOKEN_SECRET is not set');
  const payload = b64urlEncode(JSON.stringify({ sub, exp: Date.now() + ttlMs }));
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/** Returns the decoded claims, or null when invalid/expired/unconfigured. */
function verifyToken(token) {
  const secret = process.env.AUTH_TOKEN_SECRET;
  if (!secret || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (!timingSafeEqualStr(sig, expected)) return null;
  let claims;
  try {
    claims = JSON.parse(b64urlDecode(payload));
  } catch {
    return null;
  }
  if (!claims || typeof claims.exp !== 'number' || Date.now() > claims.exp) return null;
  return claims;
}

function bearer(req) {
  const raw = (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m ? m[1].trim() : '';
}

/** Sends 401 and returns null when unauthenticated; otherwise returns claims. */
function requireAuth(req, res) {
  const claims = verifyToken(bearer(req));
  if (!claims) {
    sendJson(req, res, 401, { success: false, message: 'Unauthorized' });
    return null;
  }
  return claims;
}

// ── Outbound fetch ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15000;

async function fetchJson(url, opts = {}) {
  const { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, method = 'GET', body } = opts;
  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { _raw: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, data };
}

// ── Misc ────────────────────────────────────────────────────────────────────

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Nearest-rank percentile over an unsorted numeric array (p in 0..100). */
function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[idx];
}

module.exports = {
  SCRYPT,
  TOKEN_TTL_MS,
  corsHeaders,
  setHeaders,
  handlePreflight,
  sendJson,
  readBody,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  bearer,
  requireAuth,
  fetchJson,
  numOrNull,
  percentile,
  timingSafeEqualStr,
};
