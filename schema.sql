-- AI Usage Panel — Postgres schema (Neon).
-- Run once in the Neon SQL editor, or: psql "$DATABASE_URL" -f schema.sql
--
-- Design: neither provider exposes a full historical usage API, so the panel
-- appends point-in-time snapshots and derives spend-over-time from the deltas.

-- AIHubMix account-level snapshot (one row per collection).
-- quota / used_quota are stored RAW (panel units); USD = value / 500000.
CREATE TABLE IF NOT EXISTS snap_aihubmix_account (
  ts            BIGINT PRIMARY KEY,   -- epoch milliseconds
  quota         BIGINT,               -- remaining balance, raw units
  used_quota    BIGINT,               -- lifetime used, raw units (monotonic)
  request_count BIGINT,
  grp           TEXT
);

-- AIHubMix per-API-key snapshot (one row per key per collection).
CREATE TABLE IF NOT EXISTS snap_aihubmix_key (
  ts           BIGINT  NOT NULL,
  token_id     BIGINT  NOT NULL,
  name         TEXT,
  status       INTEGER,
  used_quota   BIGINT,                -- lifetime used for this key, raw units
  remain_quota BIGINT,                -- -1 = unlimited
  unlimited    BOOLEAN,
  models       TEXT,
  PRIMARY KEY (ts, token_id)
);

CREATE INDEX IF NOT EXISTS idx_aihubmix_key_ts ON snap_aihubmix_key (ts);

-- DeepSeek account balance snapshot (one row per collection).
CREATE TABLE IF NOT EXISTS snap_deepseek_balance (
  ts                BIGINT PRIMARY KEY, -- epoch milliseconds
  is_available      BOOLEAN,
  currency          TEXT,
  total_balance     NUMERIC(18, 6),
  granted_balance   NUMERIC(18, 6),
  topped_up_balance NUMERIC(18, 6)
);

-- DeepSeek per-model / per-day usage, from the internal console usage API.
-- Only populated when DEEPSEEK_PLATFORM_TOKEN is configured.
CREATE TABLE IF NOT EXISTS ds_usage_daily (
  day         DATE    NOT NULL,
  model       TEXT    NOT NULL,
  requests    BIGINT  DEFAULT 0,
  prompt_hit  BIGINT  DEFAULT 0,   -- cache-hit input tokens
  prompt_miss BIGINT  DEFAULT 0,   -- cache-miss input tokens
  output      BIGINT  DEFAULT 0,
  tokens      BIGINT  DEFAULT 0,
  cost        NUMERIC(18, 6) DEFAULT 0,
  currency    TEXT,
  PRIMARY KEY (day, model)
);

CREATE INDEX IF NOT EXISTS idx_ds_usage_day ON ds_usage_daily (day);
