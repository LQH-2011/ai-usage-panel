#!/usr/bin/env node
'use strict';

/**
 * Local same-origin replica of the Vercel deployment.
 *   - routes /api/<name> to the SAME handler modules (zero code changes)
 *   - serves index.html and static files at /
 *   - loads .env with a tiny parser (no dotenv dependency)
 *
 *   cp .env.example .env   # then fill it in
 *   npm run dev            # http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv(path.join(ROOT, '.env'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname || '/');

  if (pathname.startsWith('/api/')) {
    const name = pathname.slice('/api/'.length).replace(/\/+$/, '');
    if (!/^[a-z0-9_-]+$/i.test(name)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, message: 'Not found' }));
      return;
    }
    const file = path.join(ROOT, 'api', `${name}.js`);
    if (!fs.existsSync(file)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: false, message: 'Not found' }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    req.query = parsed.query;
    req.body = raw ? safeJson(raw) : {};

    try {
      // Hot-reload modules only when explicitly asked. Off by default because
      // re-requiring resets module-scoped state (e.g. the auth failure
      // counter), which would not happen on a warm Vercel instance.
      if (process.env.DEV_HOT === '1') delete require.cache[require.resolve(file)];
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const handler = require(file);
      await handler(req, res);
    } catch (err) {
      console.error(`[dev] ${name} →`, err);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    }
    return;
  }

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(ROOT, rel);
  if (!target.startsWith(ROOT) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[path.extname(target).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(target).pipe(res);
});

server.listen(PORT, () => {
  const missing = ['DATABASE_URL', 'AUTH_PASSWORD_HASH', 'AUTH_TOKEN_SECRET'].filter((k) => !process.env[k]);
  console.log(`dev server → http://localhost:${PORT}`);
  if (missing.length) console.log(`  ⚠ missing env: ${missing.join(', ')}`);
  for (const k of ['AIHUBMIX_MANAGE_KEY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_PLATFORM_TOKEN']) {
    console.log(`  ${process.env[k] ? '✓' : '·'} ${k}`);
  }
});
