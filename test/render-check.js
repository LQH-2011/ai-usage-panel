#!/usr/bin/env node
'use strict';

/**
 * Headless render check (no Playwright dependency — drives Chromium over CDP
 * using Node's built-in WebSocket + fetch).
 *
 *   node test/render-check.js <baseUrl> <token> [outfile.png]
 *
 * Logs in by seeding localStorage, screenshots the dashboard, prints a DOM
 * summary, and fails on any page error / console error.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME =
  process.env.CHROME_BIN || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const PORT = Number(process.env.CDP_PORT || 9333);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const base = process.argv[2] || 'http://127.0.0.1:3000';
  const token = process.argv[3] || '';
  const out = process.argv[4] || path.join(os.tmpdir(), 'panel.png');

  if (!fs.existsSync(CHROME)) throw new Error(`chrome not found at ${CHROME} (set CHROME_BIN)`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aup-chrome-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--window-size=1440,2000',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    // detached:true so the whole chrome process tree can be killed below.
    { stdio: 'ignore', detached: true }
  );

  let wsUrl = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      wsUrl = (await res.json()).webSocketDebuggerUrl;
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!wsUrl) throw new Error('devtools endpoint never came up');

  const sock = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    sock.addEventListener('open', res, { once: true });
    sock.addEventListener('error', rej, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const waiters = [];
  const problems = [];

  sock.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    const m = msg.method;
    if (m === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      problems.push(`pageerror: ${d.exception ? d.exception.description : d.text}`);
    }
    if (m === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      problems.push(
        `console.${msg.params.type}: ${msg.params.args.map((a) => a.value || a.description || '').join(' ')}`
      );
    }
    if (m === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      problems.push(`log: ${msg.params.entry.text}`);
    }
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].method === m) {
        waiters[i].resolve(msg.params);
        waiters.splice(i, 1);
      }
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      sock.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const waitFor = (method, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const w = { method, resolve };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) {
          waiters.splice(i, 1);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, timeoutMs);
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);

  const loaded = waitFor('Page.loadEventFired');
  await send('Page.navigate', { url: base }, sessionId);
  await loaded;

  if (token) {
    const reloaded = waitFor('Page.loadEventFired');
    await send(
      'Runtime.evaluate',
      { expression: `localStorage.setItem('aup_token', ${JSON.stringify(token)}); location.reload();` },
      sessionId
    );
    await reloaded;
  }
  // Wait for the dashboard to actually populate instead of guessing a delay:
  // the live functions cold-start and fetch both providers on first load.
  const deadline = Date.now() + 25000;
  let populated = false;
  while (Date.now() < deadline) {
    const tick = await send(
      'Runtime.evaluate',
      {
        expression: `document.querySelectorAll('#cards .card').length + (document.getElementById('overlay').classList.contains('show') ? 1000 : 0)`,
        returnByValue: true,
      },
      sessionId
    );
    const v = Number(tick.result.value) || 0;
    if (v >= 1000) break; // login overlay is up — nothing more will load
    if (v > 0) {
      populated = true;
      break;
    }
    await sleep(400);
  }
  await sleep(1200); // let Chart.js finish drawing
  if (!populated) console.log('WARNING: dashboard did not populate within 25s');

  const probe = await send(
    'Runtime.evaluate',
    {
      expression: `JSON.stringify({
        title: document.title,
        loginVisible: document.getElementById('overlay').classList.contains('show'),
        cards: document.querySelectorAll('#cards .card').length,
        canvases: [...document.querySelectorAll('canvas')].map(c => ({ id: c.id, w: c.width, h: c.height })),
        keyRows: document.querySelectorAll('#keysTable tbody tr').length,
        modelRows: document.querySelectorAll('#modelsTable tbody tr').length,
        warnings: document.getElementById('warnings').textContent.trim(),
        headerText: document.querySelector('.brand h1').textContent.trim(),
        balanceCards: [...document.querySelectorAll('#cards .big')].map(e => e.textContent.trim())
      })`,
      returnByValue: true,
    },
    sessionId
  );

  const shot = await send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: true, fromSurface: true },
    sessionId
  );
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));

  console.log('DOM summary:');
  console.log(JSON.stringify(JSON.parse(probe.result.value), null, 2));
  console.log(`screenshot: ${out} (${fs.statSync(out).size} bytes)`);
  console.log(problems.length ? `PROBLEMS:\n - ${problems.join('\n - ')}` : 'no console/page errors');

  sock.close();
  try {
    process.kill(-chrome.pid, 'SIGKILL');
  } catch {
    chrome.kill('SIGKILL');
  }
  fs.rmSync(userDataDir, { recursive: true, force: true });
  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error('render-check failed:', err.message);
  process.exit(2);
});
