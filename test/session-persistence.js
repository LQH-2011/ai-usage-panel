#!/usr/bin/env node
'use strict';

/**
 * Session-persistence regression test.
 *
 *   node test/session-persistence.js <baseUrl> <password>
 *
 * Phase 1 logs in through the form with "keep me signed in" ticked.
 * Phase 2 relaunches the SAME browser profile (a real browser restart) and
 * asserts the dashboard loads with no login prompt.
 * Phase 3 asserts an explicit sign-out forgets the saved passphrase, otherwise
 * the next load would silently sign back in.
 *
 * Needs only Chromium + Node's built-in WebSocket/fetch (no Playwright).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME =
  process.env.CHROME_BIN || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const PASSWORD = process.argv[3] || '';
const PORT = Number(process.env.CDP_PORT || 9444);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withBrowser(profileDir, fn) {
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
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    // detached:true makes chrome its own process group so the whole tree can be
    // killed below — otherwise zygote/renderer children survive and pile up.
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
  sock.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].method === msg.method) {
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
  const waitFor = (method, timeoutMs = 20000) =>
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

  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId))
      .result.value;

  const nav = async () => {
    const loaded = waitFor('Page.loadEventFired');
    await send('Page.navigate', { url: BASE }, sessionId);
    await loaded;
  };

  const stateOf = () =>
    evaluate(
      `document.getElementById('overlay').classList.contains('show') ? 'login'
         : (document.querySelectorAll('#cards .card').length > 0 ? 'ready' : 'loading')`
    );

  // Wait for a SPECIFIC state. Waiting for "either terminal state" returns
  // 'login' immediately after a submit, before the request has come back.
  const waitForState = async (want, timeoutMs = 25000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if ((await stateOf()) === want) return true;
      await sleep(300);
    }
    return false;
  };

  try {
    return await fn({ evaluate, nav, waitForState, stateOf });
  } finally {
    // Close gracefully FIRST: SIGKILL alone can leave localStorage writes
    // unflushed, which would make this test fail for the wrong reason.
    try {
      await Promise.race([send('Browser.close'), sleep(3000)]);
    } catch {
      /* the socket usually drops as the browser exits */
    }
    await sleep(700);
    sock.close();
    try {
      process.kill(-chrome.pid, 'SIGKILL');
    } catch {
      chrome.kill('SIGKILL');
    }
    await sleep(500); // let the profile lock release before the next launch
  }
}

async function main() {
  if (!PASSWORD) {
    console.error('usage: node test/session-persistence.js <baseUrl> <password>');
    process.exit(2);
  }
  if (!fs.existsSync(CHROME)) throw new Error(`chromium not found at ${CHROME} (set CHROME_BIN)`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aup-session-'));
  let failed = 0;
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed += 1;
  };

  console.log(`profile: ${profile}\ntarget : ${BASE}\n`);

  await withBrowser(profile, async ({ evaluate, nav, waitForState, stateOf }) => {
    await nav();
    check('phase 1: fresh browser shows the login form', await waitForState('login', 20000));
    // requestSubmit() runs validation and fires a real submit event; a
    // synthetic `new Event('submit')` does not reach the handler in Chromium.
    const submitted = await evaluate(
      `(() => {
         document.getElementById('pw').value = ${JSON.stringify(PASSWORD)};
         document.getElementById('remember').checked = true;
         const f = document.getElementById('loginForm');
         if (typeof f.requestSubmit === 'function') f.requestSubmit();
         else f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
         return 'submitted';
       })()`
    );
    check('phase 1: form submitted', submitted === 'submitted', submitted);
    const ready = await waitForState('ready', 25000);
    if (!ready) {
      console.log(
        `    state=${await stateOf()} loginErr="${await evaluate(`document.getElementById('loginErr').textContent`)}"`
      );
    }
    check('phase 1: signing in loads the dashboard', ready);
    check(
      'phase 1: passphrase saved to localStorage',
      (await evaluate(`localStorage.getItem('aup_pass') ? 'yes' : 'no'`)) === 'yes'
    );
  });

  await withBrowser(profile, async ({ evaluate, nav, waitForState, stateOf }) => {
    await nav();
    const ready = await waitForState('ready', 25000);
    check(
      'phase 2: NO prompt after a browser restart (auto sign-in)',
      ready,
      ready ? '' : `state=${await stateOf()}`
    );
    check(
      'phase 2: session token present',
      (await evaluate(`localStorage.getItem('aup_token') ? 'yes' : 'no'`)) === 'yes'
    );
  });

  await withBrowser(profile, async ({ evaluate, nav, waitForState }) => {
    await nav();
    await waitForState('ready', 25000);
    await evaluate(`document.getElementById('logout').click(); 'clicked'`);
    check('phase 3: sign-out shows the login form again', await waitForState('login', 10000));
    check(
      'phase 3: sign-out forgets the saved passphrase and token',
      (await evaluate(
        `(localStorage.getItem('aup_pass') ? 'yes' : 'no') + '|' + (localStorage.getItem('aup_token') ? 'yes' : 'no')`
      )) === 'no|no'
    );
  });

  fs.rmSync(profile, { recursive: true, force: true });
  console.log(failed ? `\nRESULT: \x1b[31m${failed} failed\x1b[0m` : '\nRESULT: \x1b[32mall passed\x1b[0m');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('session test failed:', err.message);
  process.exit(2);
});
