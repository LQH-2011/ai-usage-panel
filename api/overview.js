'use strict';

/** GET /api/overview — current quota / balance for both platforms. */

const { handlePreflight, sendJson, requireAuth } = require('./_lib');
const { runCollect } = require('./_collect');
const db = require('./_db');
const { usdFromUnits } = require('./_providers');

const STALE_MS = Number(process.env.COLLECT_TTL_MS || 5 * 60 * 1000);

function keyView(k) {
  return {
    token_id: k.token_id,
    name: k.name,
    status: k.status,
    used_usd: usdFromUnits(k.used_quota),
    remain_usd: k.remain_quota === null || k.remain_quota < 0 ? null : usdFromUnits(k.remain_quota),
    unlimited: Boolean(k.unlimited),
    models: k.models,
    ts: k.ts,
  };
}

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') {
    return sendJson(req, res, 405, { success: false, message: 'Method not allowed' });
  }

  try {
    await db.ensureSchema();

    const warnings = [];
    let collected = null;
    // Refresh on read when the newest snapshot is stale, so the panel is never
    // showing day-old numbers on first open.
    const age = await db.latestAgeMs();
    if (age === null || age > STALE_MS) {
      try {
        collected = await runCollect();
        if (collected.errors && collected.errors.length) warnings.push(...collected.errors);
      } catch (err) {
        warnings.push(`collect: ${err.message}`);
      }
    }

    const [account, keys, ds] = await Promise.all([
      db.getLatestAccount(),
      db.getLatestKeys(),
      db.getLatestDeepseek(),
    ]);

    return sendJson(req, res, 200, {
      success: true,
      now: Date.now(),
      collected,
      warnings,
      aihubmix: {
        configured: Boolean(process.env.AIHUBMIX_MANAGE_KEY),
        ts: account ? Number(account.ts) : null,
        balance_usd: account ? usdFromUnits(account.quota) : null,
        used_usd: account ? usdFromUnits(account.used_quota) : null,
        request_count: account ? Number(account.request_count) || 0 : null,
        group: account ? account.grp : null,
        keys: keys.map(keyView),
      },
      deepseek: {
        configured: Boolean(process.env.DEEPSEEK_API_KEY),
        usage_api: Boolean(process.env.DEEPSEEK_PLATFORM_TOKEN),
        ts: ds ? Number(ds.ts) : null,
        is_available: ds ? Boolean(ds.is_available) : null,
        currency: ds ? ds.currency : null,
        total_balance: ds ? Number(ds.total_balance) : null,
        granted_balance: ds ? Number(ds.granted_balance) : null,
        topped_up_balance: ds ? Number(ds.topped_up_balance) : null,
      },
    });
  } catch (err) {
    return sendJson(req, res, 500, { success: false, message: err.message });
  }
};
