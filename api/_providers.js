'use strict';

/**
 * Upstream provider clients.
 *
 *  AIHubMix — account panel API, authenticated with the Manage Key (`fd…`),
 *             the "System Access Token" from the console, NOT the model key.
 *             Quota unit: 1 USD = 500000 raw units.
 *  DeepSeek — public API for the balance; the console's internal usage API
 *             (per-model, per-day) needs the browser session token.
 */

const { fetchJson, numOrNull } = require('./_lib');

const AIHUBMIX_QUOTA_PER_USD = 500000;
const AIHUBMIX_DEFAULT_BASE = 'https://aihubmix.com';
const DEEPSEEK_DEFAULT_API_BASE = 'https://api.deepseek.com';
const DEEPSEEK_DEFAULT_USAGE_BASE = 'https://platform.deepseek.com/api/v0/usage';

const usdFromUnits = (raw) => (Number(raw) || 0) / AIHUBMIX_QUOTA_PER_USD;
const unitsFromUsd = (usd) => Math.round((Number(usd) || 0) * AIHUBMIX_QUOTA_PER_USD);

function aihubmixBase() {
  return (process.env.AIHUBMIX_BASE_URL || AIHUBMIX_DEFAULT_BASE).replace(/\/+$/, '');
}

// Overridable purely so the smoke test can point them at a local mock.
function deepseekApiBase() {
  return (process.env.DEEPSEEK_BASE_URL || DEEPSEEK_DEFAULT_API_BASE).replace(/\/+$/, '');
}

function deepseekUsageBase() {
  return (process.env.DEEPSEEK_USAGE_BASE_URL || DEEPSEEK_DEFAULT_USAGE_BASE).replace(/\/+$/, '');
}

function aihubmixHeaders() {
  const key = process.env.AIHUBMIX_MANAGE_KEY;
  if (!key) throw new Error('AIHUBMIX_MANAGE_KEY is not set');
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' };
}

// ── AIHubMix ────────────────────────────────────────────────────────────────

/** GET /api/user/self → account balance, lifetime usage and request count. */
async function fetchAihubmixAccount() {
  const { ok, status, data } = await fetchJson(`${aihubmixBase()}/api/user/self`, {
    headers: aihubmixHeaders(),
  });
  if (!ok || !data || data.success === false) {
    throw new Error(`AIHubMix /api/user/self failed (HTTP ${status})${data && data.message ? `: ${data.message}` : ''}`);
  }
  const d = data.data || {};
  return {
    quota: numOrNull(d.quota),
    used_quota: numOrNull(d.used_quota),
    request_count: numOrNull(d.request_count),
    grp: d.group || null,
  };
}

/** GET /api/token/?num=100 → one row per API key. */
async function fetchAihubmixKeys(num = 100) {
  const { ok, status, data } = await fetchJson(`${aihubmixBase()}/api/token/?num=${encodeURIComponent(num)}`, {
    headers: aihubmixHeaders(),
  });
  if (!ok || !data || data.success === false) {
    throw new Error(`AIHubMix /api/token/ failed (HTTP ${status})${data && data.message ? `: ${data.message}` : ''}`);
  }
  const raw = data.data;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw && raw.items)
      ? raw.items
      : Array.isArray(raw && raw.records)
        ? raw.records
        : [];
  return list
    .map((k) => ({
      token_id: numOrNull(k.id),
      name: k.name == null ? null : String(k.name),
      status: numOrNull(k.status),
      used_quota: numOrNull(k.used_quota),
      remain_quota: numOrNull(k.remain_quota),
      unlimited: Boolean(k.unlimited_quota),
      models:
        k.models == null
          ? null
          : typeof k.models === 'string'
            ? k.models
            : JSON.stringify(k.models),
    }))
    .filter((k) => k.token_id !== null);
}

// ── DeepSeek ────────────────────────────────────────────────────────────────

/** GET /user/balance (official, API-key authenticated). */
async function fetchDeepseekBalance() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY is not set');
  const { ok, status, data } = await fetchJson(`${deepseekApiBase()}/user/balance`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!ok || !data) throw new Error(`DeepSeek /user/balance failed (HTTP ${status})`);
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
  const primary = infos[0] || {};
  return {
    is_available: Boolean(data.is_available),
    currency: primary.currency || 'CNY',
    total_balance: numOrNull(primary.total_balance),
    granted_balance: numOrNull(primary.granted_balance),
    topped_up_balance: numOrNull(primary.topped_up_balance),
  };
}

function deepseekUsageHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0',
    Referer: 'https://platform.deepseek.com/usage',
  };
}

/** `biz_data` is an object for /amount and an array for /cost — normalise. */
function bizOf(json) {
  if (!json || !json.data) return null;
  let bd = json.data.biz_data;
  if (Array.isArray(bd)) bd = bd[0];
  return bd && typeof bd === 'object' ? bd : null;
}

/**
 * Sum one usage block into token buckets.
 * DeepSeek reports input as a cache-hit / cache-miss split; PROMPT_TOKEN (when
 * present) is that same input, so it is only used when no split is available —
 * summing both would double count input.
 */
function tokenBreakdown(usage) {
  let requests = 0;
  let hit = 0;
  let miss = 0;
  let output = 0;
  let promptOnly = 0;
  let hasSplit = false;
  for (const e of usage || []) {
    const value = Math.round(Number(e && e.amount) || 0);
    switch (e && e.type) {
      case 'REQUEST':
        requests = value;
        break;
      case 'PROMPT_CACHE_HIT_TOKEN':
        hit = value;
        hasSplit = true;
        break;
      case 'PROMPT_CACHE_MISS_TOKEN':
        miss = value;
        hasSplit = true;
        break;
      case 'RESPONSE_TOKEN':
        output = value;
        break;
      case 'PROMPT_TOKEN':
        promptOnly = value;
        break;
      default:
        break;
    }
  }
  const input = hasSplit ? hit + miss : promptOnly;
  return { requests, hit, miss, output, tokens: input + output };
}

/** Money total of a usage block, excluding the REQUEST counter. */
function costSum(usage) {
  return (usage || [])
    .filter((e) => e && e.type !== 'REQUEST')
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
}

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Internal console usage API → rows for ds_usage_daily.
 * Returns [] when DEEPSEEK_PLATFORM_TOKEN is unset. Two months are fetched so
 * a 30-day window spanning a month boundary is complete.
 * NOTE: we read the upstream numbers, so a change in the undocumented shape
 * surfaces as an explicit error rather than silent zeros.
 */
async function fetchDeepseekPlatformUsage(monthsBack = 1) {
  const token = process.env.DEEPSEEK_PLATFORM_TOKEN;
  if (!token) return [];

  const now = new Date();
  const months = [];
  for (let i = 0; i <= monthsBack; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }

  const currency = process.env.DEEPSEEK_USAGE_CURRENCY || 'CNY';
  // day → model → row. Each day belongs to exactly ONE month, so the month loop
  // OVERWRITES a day's bucket instead of adding to it: summing across months
  // would double-count any day that appeared in two responses.
  const rows = new Map();

  for (const { year, month } of months) {
    const q = `month=${month}&year=${year}`;
    const [amount, cost] = await Promise.all([
      fetchJson(`${deepseekUsageBase()}/amount?${q}`, { headers: deepseekUsageHeaders(token) }),
      fetchJson(`${deepseekUsageBase()}/cost?${q}`, { headers: deepseekUsageHeaders(token) }),
    ]);

    const amountBiz = bizOf(amount.data);
    const costBiz = bizOf(cost.data);
    if (!amount.ok && !cost.ok) {
      throw new Error(`DeepSeek usage API failed (HTTP ${amount.status}/${cost.status})`);
    }

    const tokensByDay = new Map(); // day → model → {requests, hit, miss, output, tokens}
    const costByDay = new Map(); // day → model → money

    for (const dayEntry of Array.isArray(amountBiz && amountBiz.days) ? amountBiz.days : []) {
      const day = dayEntry && dayEntry.date;
      if (!day) continue;
      if (!tokensByDay.has(day)) tokensByDay.set(day, new Map());
      const byModel = tokensByDay.get(day);
      for (const block of dayEntry.data || []) {
        if (!block || !block.model) continue;
        const b = tokenBreakdown(block.usage);
        const prev = byModel.get(block.model) || { requests: 0, hit: 0, miss: 0, output: 0, tokens: 0 };
        byModel.set(block.model, {
          requests: prev.requests + b.requests,
          hit: prev.hit + b.hit,
          miss: prev.miss + b.miss,
          output: prev.output + b.output,
          tokens: prev.tokens + b.tokens,
        });
      }
    }

    for (const dayEntry of Array.isArray(costBiz && costBiz.days) ? costBiz.days : []) {
      const day = dayEntry && (dayEntry.date || dayEntry.day);
      if (!day) continue;
      if (!costByDay.has(day)) costByDay.set(day, new Map());
      const byModel = costByDay.get(day);
      for (const block of dayEntry.data || []) {
        if (!block || !block.model) continue;
        byModel.set(block.model, (byModel.get(block.model) || 0) + costSum(block.usage));
      }
    }

    // If the daily breakdown is unavailable but a month total exists, fall back
    // to the month total dated on the 1st (clearly approximate, still useful).
    if (tokensByDay.size === 0 && Array.isArray(amountBiz && amountBiz.total)) {
      const day = `${monthKey(year, month)}-01`;
      const byModel = new Map();
      for (const block of amountBiz.total) {
        if (!block || !block.model) continue;
        const b = tokenBreakdown(block.usage);
        const prev = byModel.get(block.model) || { requests: 0, hit: 0, miss: 0, output: 0, tokens: 0 };
        byModel.set(block.model, {
          requests: prev.requests + b.requests,
          hit: prev.hit + b.hit,
          miss: prev.miss + b.miss,
          output: prev.output + b.output,
          tokens: prev.tokens + b.tokens,
        });
      }
      tokensByDay.set(day, byModel);

      const costByModel = new Map();
      for (const block of Array.isArray(costBiz && costBiz.total) ? costBiz.total : []) {
        if (!block || !block.model) continue;
        costByModel.set(block.model, (costByModel.get(block.model) || 0) + costSum(block.usage));
      }
      costByDay.set(day, costByModel);
    }

    for (const [day, byModel] of tokensByDay) {
      if (!rows.has(day)) rows.set(day, new Map());
      const out = rows.get(day);
      const costs = costByDay.get(day) || new Map();
      for (const [model, t] of byModel) {
        out.set(model, {
          day,
          model,
          requests: t.requests,
          prompt_hit: t.hit,
          prompt_miss: t.miss,
          output: t.output,
          tokens: t.tokens,
          cost: Number((costs.get(model) || 0).toFixed(6)),
          currency,
        });
      }
    }
  }

  const flat = [];
  for (const byModel of rows.values()) for (const row of byModel.values()) flat.push(row);
  return flat;
}

module.exports = {
  AIHUBMIX_QUOTA_PER_USD,
  usdFromUnits,
  unitsFromUsd,
  aihubmixBase,
  fetchAihubmixAccount,
  fetchAihubmixKeys,
  fetchDeepseekBalance,
  fetchDeepseekPlatformUsage,
  // exported for tests
  tokenBreakdown,
  costSum,
  bizOf,
};
