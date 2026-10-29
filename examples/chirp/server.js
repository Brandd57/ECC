#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { createStore, HttpError } = require('./lib/store');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 10 * 1024;

// Fixed allowlist: no request path is ever joined onto the filesystem.
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function route(method, pattern, opts, handler) {
  const regex = new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`);
  return { method, regex, auth: opts.auth !== false, status: opts.status || 200, handler };
}

const ROUTES = [
  route('POST', '/api/signup', { auth: false, status: 201 }, ({ store, body }) => store.signup(body.username, body.password)),
  route('POST', '/api/login', { auth: false }, ({ store, body }) => store.login(body.username, body.password)),
  route('POST', '/api/logout', {}, ({ store, token }) => store.logout(token) || { ok: true }),
  route('GET', '/api/me', {}, ({ store, user }) => store.profile(user, user)),
  route('GET', '/api/feed', { auth: false }, ({ store, user, query }) => store.feed(user, query)),
  route('GET', '/api/timeline', {}, ({ store, user, query }) => store.timeline(user, query)),
  route('POST', '/api/chirps', { status: 201 }, ({ store, user, body }) => store.post(user, body.text)),
  route('DELETE', '/api/chirps/:id', {}, ({ store, user, params }) => store.remove(user, params[0])),
  route('PUT', '/api/chirps/:id/like', {}, ({ store, user, params }) => store.like(user, params[0], true)),
  route('DELETE', '/api/chirps/:id/like', {}, ({ store, user, params }) => store.like(user, params[0], false)),
  route('GET', '/api/users/:name', { auth: false }, ({ store, user, params }) => store.profile(params[0], user)),
  route('GET', '/api/users/:name/chirps', { auth: false }, ({ store, user, params, query }) => store.userChirps(params[0], user, query)),
  route('PUT', '/api/users/:name/follow', {}, ({ store, user, params }) => store.follow(user, params[0], true)),
  route('DELETE', '/api/users/:name/follow', {}, ({ store, user, params }) => store.follow(user, params[0], false))
];

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return reject(new HttpError(413, 'Request body too large'));
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(payload));
}

function bearerToken(req) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  return match ? match[1] : null;
}

async function handleApi(store, req, res, url) {
  const matched = ROUTES.map(r => ({ r, m: r.regex.exec(url.pathname) })).find(x => x.m && x.r.method === req.method);
  if (!matched) {
    const pathKnown = ROUTES.some(r => r.regex.test(url.pathname));
    throw new HttpError(pathKnown ? 405 : 404, pathKnown ? 'Method not allowed' : 'Not found');
  }
  const token = bearerToken(req);
  const user = token ? store.userForToken(token) : null;
  if (matched.r.auth && !user) throw new HttpError(401, 'Log in required');
  const body = req.method === 'GET' ? {} : await readJson(req);
  const params = matched.m.slice(1).map(decodeURIComponent);
  const query = Object.fromEntries(url.searchParams);
  send(res, matched.r.status, matched.r.handler({ store, token, user, body, params, query }));
}

function serveStatic(req, res, url) {
  const entry = STATIC_FILES[url.pathname];
  if (!entry || req.method !== 'GET') throw new HttpError(404, 'Not found');
  const [file, type] = entry;
  res.writeHead(200, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(fs.readFileSync(path.join(PUBLIC_DIR, file)));
}

function createServer(store) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await handleApi(store, req, res, url);
      else serveStatic(req, res, url);
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      process.stderr.write(`[chirp] ${error.stack}\n`);
      send(res, 500, { error: 'Internal error' });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const server = createServer(createStore(process.env.CHIRP_DATA));
  server.listen(port, () => process.stdout.write(`Chirp running at http://localhost:${port}\n`));
}

module.exports = { createServer };
