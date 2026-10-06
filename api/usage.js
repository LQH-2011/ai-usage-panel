'use strict';

/**
 * GET /api/usage?range=24h|7d|30d|90d|all  (or &from=&to= ISO / epoch-ms)
 *
 * Returns everything the dashboard charts need, aggregated for the window:
 *   aihubmix.series   — account spend curve (derived from usage snapshots)
 *   aihubmix.keys     — per-key lifetime + spend within the window
 *   deepseek.series   — balance curve
 *   deepseek.daily    — per-day / per-model cost + tokens
 */

const { handlePreflight, sendJson, requireAuth } = require('./_lib');
const db = require('./_db');
const { usdFromUnits } = require('./_providers');

const DAY_MS = 86400000;
const RANGES = { '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, '90d': 90 * DAY_MS };

function toMs(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRange(req) {
  const q = req.query || {};
  const now = Date.now();
  const to = toMs(q.to);
  const end = to === null ? now : to;
  const explicitFrom = toMs(q.from);
  if (explicitFrom !== null) return { from: Math.min(explicitFrom, end), to: end, key: 'custom' };
  const key = String(q.range || '7d');
  if (key === 'all') return { from: 0, to: end, key };
  const span = RANGES[key];
  if (!span) return { from: end - RANGES['7d'], to: end, key: '7d' };
  return { from: end - span, to: end, key };
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function aggregateKeys(rows) {
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.token_id)) byId.set(r.token_id, []);
    byId.get(r.token_id).push(r);
  }
  const out = [];
  for (const [tokenId, list] of byId) {
    list.sort((a, b) => a.ts - b.ts);
    const first = list[0];
    const last = list[list.length - 1];
    const usedStart = first.used_quota || 0;
    const usedEnd = last.used_quota || 0;
    out.push({
      token_id: tokenId,
      name: last.name,
      status: last.status,
      unlimited: Boolean(last.unlimited),
      models: last.models,
      used_usd: usdFromUnits(usedEnd),
      spend_usd: usdFromUnits(usedEnd - usedStart),
      remain_usd: last.remain_quota === null || last.remain_quota < 0 ? null : usdFromUnits(last.remain_quota),
      first_ts: first.ts,
      last_ts: last.ts,
      points: list.length,
    });
  }
  return out.sort((a, b) => b.spend_usd - a.spend_usd || b.used_usd - a.used_usd);
}

function aggregateDsUsage(rows) {
  const byModel = new Map();
  const byDay = new Map();
  let costCurrency = null;
  for (const r of rows) {
    if (!costCurrency && r.currency) costCurrency = r.currency;
    const m = byModel.get(r.model) || {
      model: r.model,
      requests: 0,
      tokens: 0,
      cache_hit: 0,
      cache_miss: 0,
      output: 0,
      cost: 0,
    };
    m.requests += r.requests;
    m.tokens += r.tokens;
    m.cache_hit += r.prompt_hit;
    m.cache_miss += r.prompt_miss;
    m.output += r.output;
    m.cost += r.cost;
    byModel.set(r.model, m);

    const d = byDay.get(r.day) || { day: r.day, requests: 0, tokens: 0, cost: 0 };
    d.requests += r.requests;
    d.tokens += r.tokens;
    d.cost += r.cost;
    byDay.set(r.day, d);
  }
  const round = (n) => Number(n.toFixed(6));
  return {
    models: [...byModel.values()]
      .map((m) => ({ ...m, cost: round(m.cost) }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    days: [...byDay.values()]
      .map((d) => ({ ...d, cost: round(d.cost) }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
    currency: costCurrency,
  };
}

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') {
    return sendJson(req, res, 405, { success: false, message: 'Method not allowed' });
  }

  const range = parseRange(req);
  try {
    await db.ensureSchema();
    const [acct, keys, dsBalance, dsUsage] = await Promise.all([
      db.getAccountSeries(range.from, range.to),
      db.getKeySeries(range.from, range.to),
      db.getDeepseekSeries(range.from, range.to),
      db.getDsUsage(isoDay(range.from), isoDay(range.to)),
    ]);

    const acctSeries = acct.map((r) => ({
      ts: r.ts,
      used_usd: usdFromUnits(r.used_quota),
      balance_usd: usdFromUnits(r.quota),
      request_count: r.request_count || 0,
    }));
    const acctFirst = acct[0] || null;
    const acctLast = acct[acct.length - 1] || null;

    const dsAgg = aggregateDsUsage(dsUsage);
    const dsFirst = dsBalance[0] || null;
    const dsLast = dsBalance[dsBalance.length - 1] || null;

    return sendJson(req, res, 200, {
      success: true,
      range: { from: range.from, to: range.to, key: range.key },
      aihubmix: {
        configured: Boolean(process.env.AIHUBMIX_MANAGE_KEY),
        series: acctSeries,
        baseline_used_usd: acctFirst ? usdFromUnits(acctFirst.used_quota) : null,
        spend_usd: acctFirst && acctLast ? usdFromUnits((acctLast.used_quota || 0) - (acctFirst.used_quota || 0)) : 0,
        requests:
          acctFirst && acctLast
            ? Math.max(0, (acctLast.request_count || 0) - (acctFirst.request_count || 0))
            : 0,
        balance_usd: acctLast ? usdFromUnits(acctLast.quota) : null,
        points: acct.length,
        keys: aggregateKeys(keys),
      },
      deepseek: {
        configured: Boolean(process.env.DEEPSEEK_API_KEY),
        usage_api: Boolean(process.env.DEEPSEEK_PLATFORM_TOKEN),
        series: dsBalance.map((r) => ({ ts: r.ts, balance: r.total_balance, currency: r.currency })),
        balance: dsLast ? dsLast.total_balance : null,
        currency: dsLast ? dsLast.currency : null,
        // Positive = money consumed during the window (balance went down).
        spend:
          dsFirst && dsLast && dsFirst.total_balance !== null && dsLast.total_balance !== null
            ? Number((dsFirst.total_balance - dsLast.total_balance).toFixed(6))
            : null,
        baseline_balance: dsFirst ? dsFirst.total_balance : null,
        points: dsBalance.length,
        models: dsAgg.models,
        days: dsAgg.days,
        usage_currency: dsAgg.currency,
      },
    });
  } catch (err) {
    return sendJson(req, res, 500, { success: false, message: err.message });
  }
};
