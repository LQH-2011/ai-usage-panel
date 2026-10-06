'use strict';

/**
 * Postgres (Neon) data access. One `pg` Pool per warm instance; the schema is
 * created on first use so a fresh database needs no manual migration step
 * (running schema.sql up front is still recommended and is idempotent).
 */

const { Pool } = require('pg');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snap_aihubmix_account (
  ts            BIGINT PRIMARY KEY,
  quota         BIGINT,
  used_quota    BIGINT,
  request_count BIGINT,
  grp           TEXT
);
CREATE TABLE IF NOT EXISTS snap_aihubmix_key (
  ts           BIGINT  NOT NULL,
  token_id     BIGINT  NOT NULL,
  name         TEXT,
  status       INTEGER,
  used_quota   BIGINT,
  remain_quota BIGINT,
  unlimited    BOOLEAN,
  models       TEXT,
  PRIMARY KEY (ts, token_id)
);
CREATE INDEX IF NOT EXISTS idx_aihubmix_key_ts ON snap_aihubmix_key (ts);
CREATE TABLE IF NOT EXISTS snap_deepseek_balance (
  ts                BIGINT PRIMARY KEY,
  is_available      BOOLEAN,
  currency          TEXT,
  total_balance     NUMERIC(18, 6),
  granted_balance   NUMERIC(18, 6),
  topped_up_balance NUMERIC(18, 6)
);
CREATE TABLE IF NOT EXISTS ds_usage_daily (
  day         DATE    NOT NULL,
  model       TEXT    NOT NULL,
  requests    BIGINT  DEFAULT 0,
  prompt_hit  BIGINT  DEFAULT 0,
  prompt_miss BIGINT  DEFAULT 0,
  output      BIGINT  DEFAULT 0,
  tokens      BIGINT  DEFAULT 0,
  cost        NUMERIC(18, 6) DEFAULT 0,
  currency    TEXT,
  PRIMARY KEY (day, model)
);
CREATE INDEX IF NOT EXISTS idx_ds_usage_day ON ds_usage_daily (day);
`;

let pool = null;
let schemaPromise = null;

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  if (!pool) {
    pool = new Pool({
      connectionString,
      // Neon serves publicly-trusted certs; verify them unless explicitly
      // opted out (local/self-signed Postgres only).
      ssl: { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' },
      max: 3,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
    });
  }
  return pool;
}

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = getPool()
      .query(SCHEMA)
      .catch((err) => {
        schemaPromise = null;
        throw err;
      });
  }
  return schemaPromise;
}

async function query(text, params) {
  await ensureSchema();
  return getPool().query(text, params);
}

// ── Writes ──────────────────────────────────────────────────────────────────

async function insertAihubmixAccount(ts, a) {
  await query(
    `INSERT INTO snap_aihubmix_account (ts, quota, used_quota, request_count, grp)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (ts) DO UPDATE SET
       quota = EXCLUDED.quota,
       used_quota = EXCLUDED.used_quota,
       request_count = EXCLUDED.request_count,
       grp = EXCLUDED.grp`,
    [ts, a.quota, a.used_quota, a.request_count, a.grp]
  );
}

async function insertAihubmixKeys(ts, keys) {
  for (const k of keys) {
    await query(
      `INSERT INTO snap_aihubmix_key
         (ts, token_id, name, status, used_quota, remain_quota, unlimited, models)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (ts, token_id) DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         used_quota = EXCLUDED.used_quota,
         remain_quota = EXCLUDED.remain_quota,
         unlimited = EXCLUDED.unlimited,
         models = EXCLUDED.models`,
      [ts, k.token_id, k.name, k.status, k.used_quota, k.remain_quota, k.unlimited, k.models]
    );
  }
}

async function insertDeepseekBalance(ts, b) {
  await query(
    `INSERT INTO snap_deepseek_balance
       (ts, is_available, currency, total_balance, granted_balance, topped_up_balance)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (ts) DO UPDATE SET
       is_available = EXCLUDED.is_available,
       currency = EXCLUDED.currency,
       total_balance = EXCLUDED.total_balance,
       granted_balance = EXCLUDED.granted_balance,
       topped_up_balance = EXCLUDED.topped_up_balance`,
    [ts, b.is_available, b.currency, b.total_balance, b.granted_balance, b.topped_up_balance]
  );
}

async function upsertDsUsageDaily(rows) {
  for (const r of rows) {
    await query(
      `INSERT INTO ds_usage_daily
         (day, model, requests, prompt_hit, prompt_miss, output, tokens, cost, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (day, model) DO UPDATE SET
         requests = EXCLUDED.requests,
         prompt_hit = EXCLUDED.prompt_hit,
         prompt_miss = EXCLUDED.prompt_miss,
         output = EXCLUDED.output,
         tokens = EXCLUDED.tokens,
         cost = EXCLUDED.cost,
         currency = EXCLUDED.currency`,
      [r.day, r.model, r.requests, r.prompt_hit, r.prompt_miss, r.output, r.tokens, r.cost, r.currency]
    );
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

const toNum = (v) => (v === null || v === undefined ? null : Number(v));

async function getLatestAccount() {
  const { rows } = await query(
    `SELECT ts, quota, used_quota, request_count, grp
       FROM snap_aihubmix_account ORDER BY ts DESC LIMIT 1`
  );
  return rows[0] || null;
}

async function getAccountSeries(fromTs, toTs) {
  const { rows } = await query(
    `SELECT ts, quota, used_quota, request_count
       FROM snap_aihubmix_account
      WHERE ts >= $1 AND ts <= $2
      ORDER BY ts ASC`,
    [fromTs, toTs]
  );
  return rows.map((r) => ({
    ts: Number(r.ts),
    quota: toNum(r.quota),
    used_quota: toNum(r.used_quota),
    request_count: toNum(r.request_count),
  }));
}

async function getKeySeries(fromTs, toTs) {
  const { rows } = await query(
    `SELECT ts, token_id, name, status, used_quota, remain_quota, unlimited, models
       FROM snap_aihubmix_key
      WHERE ts >= $1 AND ts <= $2
      ORDER BY ts ASC`,
    [fromTs, toTs]
  );
  return rows.map((r) => ({
    ts: Number(r.ts),
    token_id: toNum(r.token_id),
    name: r.name,
    status: toNum(r.status),
    used_quota: toNum(r.used_quota),
    remain_quota: toNum(r.remain_quota),
    unlimited: r.unlimited,
    models: r.models,
  }));
}

/** Most recent snapshot row for each API key. */
async function getLatestKeys() {
  const { rows } = await query(
    `SELECT DISTINCT ON (token_id)
            ts, token_id, name, status, used_quota, remain_quota, unlimited, models
       FROM snap_aihubmix_key
      ORDER BY token_id, ts DESC`
  );
  return rows
    .map((r) => ({
      ts: Number(r.ts),
      token_id: toNum(r.token_id),
      name: r.name,
      status: toNum(r.status),
      used_quota: toNum(r.used_quota),
      remain_quota: toNum(r.remain_quota),
      unlimited: r.unlimited,
      models: r.models,
    }))
    .sort((a, b) => (b.used_quota || 0) - (a.used_quota || 0));
}

async function getLatestDeepseek() {
  const { rows } = await query(
    `SELECT ts, is_available, currency, total_balance, granted_balance, topped_up_balance
       FROM snap_deepseek_balance ORDER BY ts DESC LIMIT 1`
  );
  return rows[0] || null;
}

async function getDeepseekSeries(fromTs, toTs) {
  const { rows } = await query(
    `SELECT ts, currency, total_balance
       FROM snap_deepseek_balance
      WHERE ts >= $1 AND ts <= $2
      ORDER BY ts ASC`,
    [fromTs, toTs]
  );
  return rows.map((r) => ({ ts: Number(r.ts), currency: r.currency, total_balance: toNum(r.total_balance) }));
}

async function getDsUsage(fromDay, toDay) {
  const { rows } = await query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, model, requests, prompt_hit, prompt_miss,
            output, tokens, cost, currency
       FROM ds_usage_daily
      WHERE day >= $1 AND day <= $2
      ORDER BY day ASC, model ASC`,
    [fromDay, toDay]
  );
  return rows.map((r) => ({
    day: r.day,
    model: r.model,
    requests: toNum(r.requests) || 0,
    prompt_hit: toNum(r.prompt_hit) || 0,
    prompt_miss: toNum(r.prompt_miss) || 0,
    output: toNum(r.output) || 0,
    tokens: toNum(r.tokens) || 0,
    cost: toNum(r.cost) || 0,
    currency: r.currency,
  }));
}

async function latestAgeMs() {
  const { rows } = await query(`SELECT GREATEST(
      COALESCE((SELECT MAX(ts) FROM snap_aihubmix_account), 0),
      COALESCE((SELECT MAX(ts) FROM snap_deepseek_balance), 0)
    ) AS ts`);
  const ts = toNum(rows[0] && rows[0].ts);
  if (!ts) return null;
  return Date.now() - ts;
}

module.exports = {
  SCHEMA,
  getPool,
  ensureSchema,
  query,
  insertAihubmixAccount,
  insertAihubmixKeys,
  insertDeepseekBalance,
  upsertDsUsageDaily,
  getLatestAccount,
  getAccountSeries,
  getKeySeries,
  getLatestKeys,
  getLatestDeepseek,
  getDeepseekSeries,
  getDsUsage,
  latestAgeMs,
};
