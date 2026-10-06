'use strict';

/**
 * The collector: reads both providers and appends a timestamped snapshot.
 * Called by the Vercel cron, by the panel's Refresh button, and automatically
 * by /api/overview when the newest snapshot is stale.
 *
 * Either provider failing never aborts the other, and a failure is reported in
 * `errors` instead of throwing, so a half-configured panel still records what
 * it can.
 */

const db = require('./_db');
const providers = require('./_providers');

async function runCollect() {
  const ts = Date.now();
  const report = {
    ts,
    aihubmix: { ok: false, keys: 0 },
    deepseek: { ok: false, usage_rows: 0 },
    errors: [],
  };

  await db.ensureSchema();

  try {
    const account = await providers.fetchAihubmixAccount();
    await db.insertAihubmixAccount(ts, account);
    report.aihubmix.ok = true;
    report.aihubmix.account = account;
  } catch (err) {
    report.errors.push(`aihubmix.account: ${err.message}`);
  }

  try {
    const keys = await providers.fetchAihubmixKeys();
    await db.insertAihubmixKeys(ts, keys);
    report.aihubmix.keys = keys.length;
  } catch (err) {
    report.errors.push(`aihubmix.keys: ${err.message}`);
  }

  try {
    const balance = await providers.fetchDeepseekBalance();
    await db.insertDeepseekBalance(ts, balance);
    report.deepseek.ok = true;
    report.deepseek.balance = balance;
  } catch (err) {
    report.errors.push(`deepseek.balance: ${err.message}`);
  }

  try {
    const rows = await providers.fetchDeepseekPlatformUsage();
    if (rows.length) await db.upsertDsUsageDaily(rows);
    report.deepseek.usage_rows = rows.length;
  } catch (err) {
    report.errors.push(`deepseek.usage: ${err.message}`);
  }

  return report;
}

module.exports = { runCollect };
