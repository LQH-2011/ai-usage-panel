#!/usr/bin/env node
'use strict';

/**
 * Mock upstream (test only). Mimics the provider endpoints the collector calls,
 * with values that drift on every AIHubMix read so successive collections
 * exercise the spend-delta maths. DeepSeek usage days are generated for the
 * REQUESTED month, like the real API, so a two-month fetch stays disjoint.
 *
 *   node test/mock-upstream.js [port]
 */

const http = require('http');

let tick = 0;

function aihubmixAccount() {
  tick += 1;
  return {
    data: {
      username: 'tester',
      display_name: 'Tester',
      role: 1,
      status: 1,
      email: 'tester@example.com',
      quota: 29071257 - tick * 500000, // remaining (raw units; USD = /500000)
      used_quota: 286403484 + tick * 1000000, // lifetime used, +$2 per read
      request_count: 614422 + tick * 37,
      group: 'default',
      aff_code: 'XXXX',
      notify: true,
      quota_remind_threshold: 10000000,
      notify_email: 'tester@example.com',
      ext: '',
    },
    message: '',
    success: true,
  };
}

function aihubmixKeys() {
  return {
    data: [
      {
        id: 101,
        user_id: 7,
        status: 1,
        name: 'prod-key',
        created_time: 1735000000,
        accessed_time: 1759700000,
        expired_time: -1,
        remain_quota: 5000000,
        unlimited_quota: false,
        used_quota: 12000000 + tick * 400000,
        models: 'gpt-4.1,claude-sonnet-5',
        subnet: '',
      },
      {
        id: 202,
        user_id: 7,
        status: 1,
        name: 'ci-key',
        created_time: 1740000000,
        accessed_time: 1759600000,
        expired_time: -1,
        remain_quota: -1,
        unlimited_quota: true,
        used_quota: 3000000 + tick * 150000,
        models: '',
        subnet: '',
      },
      {
        id: 303,
        user_id: 7,
        status: 0,
        name: 'old-disabled',
        created_time: 1700000000,
        accessed_time: 1710000000,
        expired_time: 1735689600,
        remain_quota: 0,
        unlimited_quota: false,
        used_quota: 900000,
        models: '',
        subnet: '10.0.0.0/8',
      },
    ],
    message: '',
    success: true,
  };
}

function deepseekBalance() {
  return {
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
    ],
  };
}

const fmt = (d) => d.toISOString().slice(0, 10);

/** Days inside the requested month, like the real endpoint returns. */
function monthDays(year, month) {
  const now = new Date();
  if (now.getUTCFullYear() === year && now.getUTCMonth() + 1 === month) {
    const today = new Date(Date.UTC(year, month - 1, now.getUTCDate()));
    const yesterday = new Date(today.getTime() - 86400000);
    return yesterday.getUTCMonth() + 1 === month ? [fmt(yesterday), fmt(today)] : [fmt(today)];
  }
  return [`${year}-${String(month).padStart(2, '0')}-01`];
}

const FLASH_DAY1 = [
  { type: 'REQUEST', amount: '820' },
  { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '50000000' },
  { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '1200000' },
  { type: 'RESPONSE_TOKEN', amount: '400000' },
];
const PRO_DAY1 = [
  { type: 'REQUEST', amount: '30' },
  { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '9000000' },
  { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '300000' },
  { type: 'RESPONSE_TOKEN', amount: '120000' },
];
const FLASH_DAY2 = [
  { type: 'REQUEST', amount: '384' },
  { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '21000000' },
  { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '500000' },
  { type: 'RESPONSE_TOKEN', amount: '180000' },
];

function usageAmount(year, month) {
  const days = monthDays(year, month);
  const dayData = days.map((date, i) =>
    i === 0
      ? {
          date,
          data: [
            { model: 'deepseek-v4-flash', usage: FLASH_DAY1 },
            { model: 'deepseek-v4-pro', usage: PRO_DAY1 },
          ],
        }
      : { date, data: [{ model: 'deepseek-v4-flash', usage: FLASH_DAY2 }] }
  );
  return {
    code: 0,
    msg: '',
    data: {
      biz_data: {
        total: [
          { model: 'deepseek-v4-flash', usage: [{ type: 'REQUEST', amount: '1204' }] },
          { model: 'deepseek-v4-pro', usage: [{ type: 'REQUEST', amount: '58' }] },
        ],
        days: dayData,
      },
    },
  };
}

function usageCost(year, month) {
  const days = monthDays(year, month);
  const costOf = (usage) => {
    if (usage === FLASH_DAY1) return '0.4100';
    if (usage === PRO_DAY1) return '0.1100';
    return '0.2100';
  };
  const dayData = days.map((date, i) =>
    i === 0
      ? {
          date,
          data: [
            { model: 'deepseek-v4-flash', usage: [{ type: 'COST', amount: costOf(FLASH_DAY1) }] },
            { model: 'deepseek-v4-pro', usage: [{ type: 'COST', amount: costOf(PRO_DAY1) }] },
          ],
        }
      : {
          date,
          data: [{ model: 'deepseek-v4-flash', usage: [{ type: 'COST', amount: costOf(FLASH_DAY2) }] }],
        }
  );
  return {
    code: 0,
    msg: '',
    data: {
      biz_data: [
        {
          total: [
            { model: 'deepseek-v4-flash', usage: [{ type: 'COST', amount: '0.6200' }] },
            { model: 'deepseek-v4-pro', usage: [{ type: 'COST', amount: '0.1100' }] },
          ],
          days: dayData,
        },
      ],
    },
  };
}

const PORT = Number(process.argv[2] || 3100);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const now = new Date();
  const year = Number(url.searchParams.get('year')) || now.getUTCFullYear();
  const month = Number(url.searchParams.get('month')) || now.getUTCMonth() + 1;
  const send = (obj) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  };
  if (p === '/api/user/self') return send(aihubmixAccount());
  if (p === '/api/token/' || p === '/api/token') return send(aihubmixKeys());
  if (p === '/user/balance') return send(deepseekBalance());
  if (p === '/usage/amount') return send(usageAmount(year, month));
  if (p === '/usage/cost') return send(usageCost(year, month));
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found', path: p }));
});

server.listen(PORT, () => console.log(`mock upstream → http://127.0.0.1:${PORT}`));
