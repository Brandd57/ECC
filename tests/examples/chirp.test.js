/**
 * Tests for examples/chirp (store logic and HTTP API)
 *
 * Run with: node tests/examples/chirp.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore, HttpError } = require('../../examples/chirp/lib/store');
const { createServer } = require('../../examples/chirp/server');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

function status(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
  return 200;
}

function seeded() {
  const store = createStore();
  store.signup('alice', 'password-1');
  store.signup('bob', 'password-2');
  store.signup('carol', 'password-3');
  return store;
}

async function startServer(store) {
  const server = createServer(store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, { token, body, raw } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const payload = raw !== undefined ? raw : (body ? JSON.stringify(body) : undefined);
    const res = await fetch(base + route, { method, headers, body: payload });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  return { call, close: () => new Promise(resolve => server.close(resolve)) };
}

async function run() {
  console.log('\n=== Testing chirp store ===\n');

  await test('signup validates username and password', () => {
    const store = createStore();
    assert.strictEqual(status(() => store.signup('ab', 'password-1')), 400);
    assert.strictEqual(status(() => store.signup('Bad Name!', 'password-1')), 400);
    assert.strictEqual(status(() => store.signup('alice', 'short')), 400);
  });

  await test('signup rejects duplicates case-insensitively', () => {
    const store = createStore();
    store.signup('alice', 'password-1');
    assert.strictEqual(status(() => store.signup('ALICE', 'password-1')), 409);
  });

  await test('login accepts the right password and rejects the wrong one', () => {
    const store = seeded();
    assert.strictEqual(store.userForToken(store.login('alice', 'password-1').token), 'alice');
    assert.strictEqual(status(() => store.login('alice', 'wrong-password')), 401);
    assert.strictEqual(status(() => store.login('nobody', 'password-1')), 401);
  });

  await test('logout invalidates the token', () => {
    const store = seeded();
    const { token } = store.login('alice', 'password-1');
    store.logout(token);
    assert.strictEqual(store.userForToken(token), null);
  });

  await test('post trims text and rejects empty or over-long chirps', () => {
    const store = seeded();
    assert.strictEqual(store.post('alice', '  hello  ').text, 'hello');
    assert.strictEqual(status(() => store.post('alice', '   ')), 400);
    assert.strictEqual(status(() => store.post('alice', 'x'.repeat(281))), 400);
    assert.strictEqual(store.post('alice', 'x'.repeat(280)).text.length, 280);
  });

  await test('only the author can delete a chirp', () => {
    const store = seeded();
    const chirp = store.post('alice', 'mine');
    assert.strictEqual(status(() => store.remove('bob', chirp.id)), 403);
    store.remove('alice', chirp.id);
    assert.strictEqual(store.feed('alice').length, 0);
    assert.strictEqual(status(() => store.remove('alice', chirp.id)), 404);
  });

  await test('like and unlike are idempotent', () => {
    const store = seeded();
    const chirp = store.post('alice', 'like me');
    store.like('bob', chirp.id, true);
    const liked = store.like('bob', chirp.id, true);
    assert.strictEqual(liked.likes, 1);
    assert.strictEqual(liked.liked, true);
    assert.strictEqual(store.like('bob', chirp.id, false).likes, 0);
    assert.strictEqual(store.like('bob', chirp.id, false).likes, 0);
  });

  await test('timeline shows own and followed chirps only', () => {
    const store = seeded();
    store.post('alice', 'from alice');
    store.post('bob', 'from bob');
    store.post('carol', 'from carol');
    store.follow('alice', 'bob', true);
    assert.deepStrictEqual(store.timeline('alice').map(c => c.author), ['bob', 'alice']);
    store.follow('alice', 'bob', false);
    assert.deepStrictEqual(store.timeline('alice').map(c => c.author), ['alice']);
  });

  await test('follow rejects self-follow and unknown users', () => {
    const store = seeded();
    assert.strictEqual(status(() => store.follow('alice', 'alice', true)), 400);
    assert.strictEqual(status(() => store.follow('alice', 'ghost', true)), 404);
  });

  await test('profile reports counts and follow state', () => {
    const store = seeded();
    store.post('bob', 'hi');
    store.follow('alice', 'bob', true);
    const profile = store.profile('bob', 'alice');
    assert.strictEqual(profile.chirps, 1);
    assert.strictEqual(profile.followers, 1);
    assert.strictEqual(profile.followedByViewer, true);
    assert.strictEqual(store.profile('alice', 'alice').following, 1);
  });

  await test('pagination uses the before cursor, newest first', () => {
    const store = seeded();
    for (let i = 1; i <= 5; i++) store.post('alice', `chirp ${i}`);
    const first = store.feed('alice', { limit: 2 });
    assert.deepStrictEqual(first.map(c => c.text), ['chirp 5', 'chirp 4']);
    const second = store.feed('alice', { limit: 2, before: first[1].id });
    assert.deepStrictEqual(second.map(c => c.text), ['chirp 3', 'chirp 2']);
  });

  await test('data persists to disk and reloads, but sessions do not', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chirp-')), 'data.json');
    try {
      const store = createStore(file);
      const { token } = store.signup('alice', 'password-1');
      store.post('alice', 'persisted');
      const reloaded = createStore(file);
      assert.strictEqual(reloaded.feed()[0].text, 'persisted');
      assert.strictEqual(reloaded.login('alice', 'password-1').username, 'alice');
      assert.strictEqual(reloaded.userForToken(token), null);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  console.log('\n=== Testing chirp HTTP API ===\n');

  const { call, close } = await startServer(createStore());
  try {
    let token;

    await test('signup returns a token and 201', async () => {
      const res = await call('POST', '/api/signup', { body: { username: 'alice', password: 'password-1' } });
      assert.strictEqual(res.status, 201);
      assert.match(res.body.token, /^[a-f0-9]{64}$/);
      token = res.body.token;
    });

    await test('protected routes require a valid token', async () => {
      assert.strictEqual((await call('POST', '/api/chirps', { body: { text: 'hi' } })).status, 401);
      assert.strictEqual((await call('GET', '/api/me', { token: 'f'.repeat(64) })).status, 401);
    });

    await test('post, like, and fetch a chirp over HTTP', async () => {
      const posted = await call('POST', '/api/chirps', { token, body: { text: 'hello world' } });
      assert.strictEqual(posted.status, 201);
      const liked = await call('PUT', `/api/chirps/${posted.body.id}/like`, { token });
      assert.strictEqual(liked.body.likes, 1);
      const feed = await call('GET', '/api/feed', { token });
      assert.strictEqual(feed.body[0].text, 'hello world');
      assert.strictEqual(feed.body[0].liked, true);
    });

    await test('bad input returns 400 and wrong method returns 405', async () => {
      assert.strictEqual((await call('POST', '/api/chirps', { token, body: { text: '' } })).status, 400);
      assert.strictEqual((await call('PATCH', '/api/feed')).status, 405);
      assert.strictEqual((await call('GET', '/api/nope')).status, 404);
    });

    await test('oversized and malformed bodies are rejected', async () => {
      const big = await call('POST', '/api/chirps', { token, body: { text: 'x'.repeat(20 * 1024) } });
      assert.strictEqual(big.status, 413);
      const bad = await call('POST', '/api/chirps', { token, raw: '{not json' });
      assert.strictEqual(bad.status, 400);
    });

    await test('serves the app shell with security headers and no path traversal', async () => {
      const page = await call('GET', '/');
      assert.strictEqual(page.status, 200);
      assert.ok(page.body.includes('<title>Chirp</title>'));
      assert.strictEqual((await call('GET', '/server.js')).status, 404);
      assert.strictEqual((await call('GET', '/..%2Fserver.js')).status, 404);
    });
  } finally {
    await close();
  }

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
