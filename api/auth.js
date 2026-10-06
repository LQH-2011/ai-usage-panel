'use strict';

/** POST /api/auth  { password } → { token }  (failure-only rate limiting) */

const { handlePreflight, sendJson, readBody, verifyPassword, signToken, TOKEN_TTL_MS } = require('./_lib');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map(); // ip → { count, first }

function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function locked(ip) {
  const rec = failures.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return rec.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const rec = failures.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else rec.count += 1;
}

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') {
    return sendJson(req, res, 405, { success: false, message: 'Method not allowed' });
  }
  if (!process.env.AUTH_PASSWORD_HASH || !process.env.AUTH_TOKEN_SECRET) {
    return sendJson(req, res, 500, {
      success: false,
      message: 'Server not configured: set AUTH_PASSWORD_HASH and AUTH_TOKEN_SECRET',
    });
  }

  const ip = clientIp(req);
  if (locked(ip)) {
    return sendJson(req, res, 429, { success: false, message: 'Too many failed attempts. Try again later.' });
  }

  const body = await readBody(req);
  const password = typeof body.password === 'string' ? body.password : '';

  // Verify FIRST: a correct password is never blocked by the limiter.
  if (!password || !verifyPassword(password, process.env.AUTH_PASSWORD_HASH)) {
    recordFailure(ip);
    return sendJson(req, res, 401, { success: false, message: 'Invalid password' });
  }
  failures.delete(ip);

  return sendJson(req, res, 200, {
    success: true,
    token: signToken('owner'),
    expires_in: Math.floor(TOKEN_TTL_MS / 1000),
  });
};
