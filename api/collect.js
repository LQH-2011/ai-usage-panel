'use strict';

/**
 * GET|POST /api/collect — append a fresh snapshot from both providers.
 * Authorised by either a panel session token or the cron secret, so the Vercel
 * cron can call it without a user session.
 */

const { handlePreflight, sendJson, verifyToken, bearer, timingSafeEqualStr } = require('./_lib');
const { runCollect } = require('./_collect');

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = req.headers['x-cron-secret'];
    if (typeof header === 'string' && timingSafeEqualStr(header, secret)) return true;
    const token = bearer(req);
    if (token && timingSafeEqualStr(token, secret)) return true;
  }
  return Boolean(verifyToken(bearer(req)));
}

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return sendJson(req, res, 405, { success: false, message: 'Method not allowed' });
  }
  if (!process.env.DATABASE_URL) {
    return sendJson(req, res, 500, { success: false, message: 'DATABASE_URL is not set' });
  }
  if (!isAuthorized(req)) {
    return sendJson(req, res, 401, { success: false, message: 'Unauthorized' });
  }

  try {
    const report = await runCollect();
    const ok = report.aihubmix.ok || report.deepseek.ok || report.deepseek.usage_rows > 0;
    // 200 when anything was recorded so the cron does not enter a retry storm.
    return sendJson(req, res, ok ? 200 : 502, { success: ok, report });
  } catch (err) {
    return sendJson(req, res, 500, { success: false, message: err.message });
  }
};
