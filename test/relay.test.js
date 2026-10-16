'use strict';

// Relay mode (docs/relay-mode.md): an access key gates sending; links and downloads stay open.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { startNode } = require('../src/core');
const { publicIdFromSecret } = require('../src/core/util');

const APP = 'capacitor://localhost';
const KEY = 'correct-horse-battery-staple';
const secretA = 'secret-for-device-a-0123456789';
const secretB = 'secret-for-device-b-0123456789';
const idB = publicIdFromSecret(secretB);

const tmpDirs = new Set();
function tmp(name) {
  const dir = path.join(os.tmpdir(), `airflash-relay-${name}-${process.pid}`);
  tmpDirs.add(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpDirs) require('node:fs').rmSync(dir, { recursive: true, force: true });
});

async function req(node, method, url, { secret, key, json, body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${node.port}${url}`, {
    method,
    headers: {
      ...(secret ? { 'X-AirFlash-Device': secret } : {}),
      ...(key ? { 'X-AirFlash-Key': key } : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
  });
  const type = res.headers.get('content-type') || '';
  if (type.includes('event-stream')) {
    await res.body.cancel();
    return { status: res.status, headers: res.headers, data: null };
  }
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

const relayNode = (name, extra = {}) => startNode({ port: 0, discovery: false, dataDir: tmp(name), accessKey: KEY, ...extra });

test('without a key nothing changes: open routes, LAN URLs, 6-char codes, limits advertised', async (t) => {
  const node = await relayNode('lan', { accessKey: null });
  t.after(() => node.close());
  assert.equal(node.relay, false);
  const info = await req(node, 'GET', '/api/node');
  assert.equal(info.status, 200);
  assert.ok(Array.isArray(info.data.urls), 'LAN URLs are listed');
  assert.match(info.data.hostnameUrl, /^http:\/\/.+\.local:\d+$/);
  assert.equal(info.data.relay, false);
  assert.deepEqual(info.data.limits, { maxRequestBytes: null, chunkBytes: 32 * 1024 ** 2, ttlMs: 15 * 60 * 1000 });

  assert.equal((await req(node, 'GET', '/api/devices')).status, 200);
  assert.equal((await req(node, 'POST', '/api/me', { secret: secretA, json: { name: 'A', kind: 'phone' } })).status, 200);
  assert.equal((await req(node, 'GET', '/api/drops', { secret: secretA })).status, 200);
  const created = await req(node, 'POST', '/api/drops', { secret: secretA, json: { link: true, text: 'hi' } });
  assert.equal(created.status, 201);
  assert.match(created.data.drop.code, /^[A-Z2-9]{6}$/);
  // A wrong key on a LAN node is simply ignored.
  assert.equal((await req(node, 'GET', '/api/devices', { key: 'whatever' })).status, 200);
  assert.equal((await req(node, 'GET', '/api/qr.svg?data=x')).status, 200, 'QR images need no key on a LAN node');
});

test('relay: the key is required where the spec says, header or ?key=, and not elsewhere', async (t) => {
  const node = await relayNode('gate');
  t.after(() => node.close());
  assert.equal(node.relay, true);

  // Required.
  for (const [method, url, extra] of [
    ['GET', '/api/devices', {}],
    ['GET', `/api/events?${new URLSearchParams({ device: secretA, name: 'A', kind: 'phone' })}`, {}],
    ['POST', '/api/me', { secret: secretA, json: { name: 'A', kind: 'phone' } }],
    ['GET', '/api/drops', { secret: secretA }],
    ['POST', '/api/drops', { secret: secretA, json: { link: true, text: 'hi' } }],
    ['POST', '/peer/somebody/api/drops', { secret: secretA, json: { to: idB, text: 'hi' } }],
    ['GET', '/api/qr.svg?data=x', {}],
  ]) {
    const r = await req(node, method, url, { ...extra, headers: { Origin: APP } });
    assert.equal(r.status, 401, `${method} ${url}`);
    assert.equal(r.data?.error, 'Access key required');
    assert.equal(r.headers.get('access-control-allow-origin'), APP, `CORS on 401 for ${method} ${url}`);
  }

  // Header works.
  assert.equal((await req(node, 'POST', '/api/me', { key: KEY, secret: secretA, json: { name: 'A', kind: 'phone' } })).status, 200);
  assert.equal((await req(node, 'POST', '/api/me', { key: KEY, secret: secretB, json: { name: 'B', kind: 'laptop' } })).status, 200);
  assert.equal((await req(node, 'GET', '/api/devices', { key: KEY })).status, 200);
  // ?key= works (EventSource can't set headers).
  const q = new URLSearchParams({ device: secretA, name: 'A', kind: 'phone', key: KEY });
  assert.equal((await req(node, 'GET', `/api/events?${q}`)).status, 200);
  assert.equal((await req(node, 'GET', `/api/drops?key=${KEY}`, { secret: secretA })).status, 200);
  // The QR image is an <img>, so the UI sends the key in the query; the header works too.
  const qr = await req(node, 'GET', `/api/qr.svg?data=x&key=${KEY}`);
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
  assert.match(qr.data.toString(), /<svg/);
  assert.equal((await req(node, 'GET', '/api/qr.svg?data=x', { key: KEY })).status, 200);

  // Wrong key.
  const wrong = await req(node, 'GET', '/api/devices', { key: 'nope', headers: { Origin: APP } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error, 'Wrong access key');
  assert.equal(wrong.headers.get('access-control-allow-origin'), APP);
  assert.equal((await req(node, 'GET', '/api/devices', { key: KEY + 'x' })).status, 401, 'a longer key is just wrong, not a crash');

  // Not required: node info, the drop itself, the file, the link, static files, uploads (token-only).
  const body = Buffer.from('hello relay');
  const created = await req(node, 'POST', '/api/drops', { key: KEY, secret: secretA, json: { link: true, files: [{ name: 'a.txt', size: body.length, type: 'text/plain' }] } });
  assert.equal(created.status, 201);
  const { drop, uploadToken } = created.data;
  const fileUrl = `/api/drops/${drop.id}/files/${drop.files[0].id}`;
  assert.equal((await req(node, 'PUT', `${fileUrl}?token=${uploadToken}`, { body })).status, 200, 'upload is token-only');
  assert.equal((await req(node, 'GET', '/api/node')).status, 200);
  assert.equal((await req(node, 'GET', `/api/drops/${drop.id}`)).status, 200);
  const dl = await req(node, 'GET', fileUrl);
  assert.equal(dl.status, 200);
  assert.deepEqual(dl.data, body);
  assert.equal((await req(node, 'GET', `/api/link/${drop.code}`)).status, 200);
  assert.equal((await req(node, 'GET', '/')).status, 200);
  // Deleting is still "token or your own device", no key.
  assert.equal((await req(node, 'DELETE', `/api/drops/${drop.id}?token=${uploadToken}`)).status, 200);
});

test('relay: /api/node hides the LAN URLs and advertises the limits; codes are 8 chars', async (t) => {
  const node = await relayNode('info', { ttlMs: 24 * 3600 * 1000, maxRequestBytes: 100_000_000, chunkBytes: 1024 });
  t.after(() => node.close());
  const info = await req(node, 'GET', '/api/node');
  assert.equal(info.status, 200);
  assert.equal(info.data.urls, undefined);
  assert.equal(info.data.hostnameUrl, undefined);
  assert.equal(info.data.relay, true);
  assert.deepEqual(info.data.limits, { maxRequestBytes: 100_000_000, chunkBytes: 1024, ttlMs: 24 * 3600 * 1000 });
  assert.equal(info.data.ttlMs, 24 * 3600 * 1000);
  assert.equal(info.data.name, os.hostname());
  assert.deepEqual(node.info(), info.data, 'info() is what the SSE hello carries too');

  await req(node, 'POST', '/api/me', { key: KEY, secret: secretA, json: { name: 'A', kind: 'phone' } });
  const created = await req(node, 'POST', '/api/drops', { key: KEY, secret: secretA, json: { link: true, text: 'hi' } });
  assert.equal(created.status, 201);
  assert.match(created.data.drop.code, /^[A-Z2-9]{8}$/);
  assert.equal((await req(node, 'GET', `/api/link/${created.data.drop.code.toLowerCase()}`)).status, 200);
});

test('relay: accessKeys (per-person) and accessKey are both accepted', async (t) => {
  const node = await startNode({ port: 0, discovery: false, dataDir: tmp('keys'), accessKeys: [{ key: 'alice-key-1234', label: 'Alice' }, 'bob-key-1234'] });
  t.after(() => node.close());
  assert.equal((await req(node, 'GET', '/api/devices', { key: 'alice-key-1234' })).status, 200);
  assert.equal((await req(node, 'GET', '/api/devices', { key: 'bob-key-1234' })).status, 200);
  assert.equal((await req(node, 'GET', '/api/devices', { key: 'carol-key-1234' })).status, 401);
  assert.equal((await req(node, 'GET', '/api/devices')).status, 401);
  assert.equal(node.relay, true);
});

test('relay: more than 20 wrong keys from one IP → 429 for everything from that IP', async (t) => {
  const node = await relayNode('brute');
  t.after(() => node.close());
  for (let i = 1; i <= 20; i++) {
    const r = await req(node, 'GET', '/api/devices', { key: `guess-${i}` });
    assert.equal(r.status, 401, `attempt ${i}`);
  }
  const blocked = await req(node, 'GET', '/api/devices', { key: 'guess-21', headers: { Origin: APP } });
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /too many/i);
  assert.equal(blocked.headers.get('retry-after'), '600');
  assert.equal(blocked.headers.get('access-control-allow-origin'), APP, 'the browser can read the 429');
  // Even the right key is refused while the block lasts, on every guarded route; open routes keep working.
  assert.equal((await req(node, 'GET', '/api/devices', { key: KEY })).status, 429);
  assert.equal((await req(node, 'POST', '/api/drops', { key: KEY, secret: secretA, json: { link: true, text: 'x' } })).status, 429);
  assert.equal((await req(node, 'GET', '/api/node')).status, 200);
  // A missing key is a 401, not a counted failure (first-time visitors are not attackers).
  const fresh = await relayNode('missing');
  t.after(() => fresh.close());
  for (let i = 0; i < 25; i++) assert.equal((await req(fresh, 'GET', '/api/devices')).status, 401);
  assert.equal((await req(fresh, 'GET', '/api/devices', { key: KEY })).status, 200);
});

test('relay: the client IP comes from CF-Connecting-IP only with trustProxy', async (t) => {
  const trusting = await relayNode('proxy', { trustProxy: true });
  t.after(() => trusting.close());
  for (let i = 1; i <= 21; i++) await req(trusting, 'GET', '/api/devices', { key: 'bad', headers: { 'CF-Connecting-IP': '203.0.113.7' } });
  assert.equal((await req(trusting, 'GET', '/api/devices', { key: KEY, headers: { 'CF-Connecting-IP': '203.0.113.7' } })).status, 429);
  assert.equal((await req(trusting, 'GET', '/api/devices', { key: KEY, headers: { 'CF-Connecting-IP': '203.0.113.8' } })).status, 200, 'another visitor is unaffected');
  assert.equal((await req(trusting, 'GET', '/api/devices', { key: KEY, headers: { 'X-Forwarded-For': '198.51.100.1, 203.0.113.250' } })).status, 200);

  const plain = await relayNode('noproxy');
  t.after(() => plain.close());
  for (let i = 1; i <= 21; i++) await req(plain, 'GET', '/api/devices', { key: 'bad', headers: { 'CF-Connecting-IP': `203.0.113.${i}` } });
  // Spoofed headers were ignored: it is all one socket address, which is now blocked.
  assert.equal((await req(plain, 'GET', '/api/devices', { key: KEY, headers: { 'CF-Connecting-IP': '203.0.113.99' } })).status, 429);
});

test('maxStoreBytes caps the declared size of live drops with a 507', async (t) => {
  const node = await startNode({ port: 0, discovery: false, dataDir: tmp('quota'), maxStoreBytes: 100 });
  t.after(() => node.close());
  await req(node, 'POST', '/api/me', { secret: secretA, json: { name: 'A', kind: 'phone' } });
  await req(node, 'POST', '/api/me', { secret: secretB, json: { name: 'B', kind: 'laptop' } });
  const mk = (size) => req(node, 'POST', '/api/drops', { secret: secretA, json: { to: idB, files: [{ name: 'f', size }] } });
  const first = await mk(60);
  assert.equal(first.status, 201);
  const tooBig = await mk(50);
  assert.equal(tooBig.status, 507);
  assert.match(tooBig.data.error, /full/i);
  assert.equal((await mk(40)).status, 201, 'exactly at the cap is fine');
  await req(node, 'DELETE', `/api/drops/${first.data.drop.id}`, { secret: secretA });
  assert.equal((await mk(50)).status, 201, 'deleted drops free their share');
});

test('relay: unknown share codes are counted like wrong keys; a LAN node never counts them', async (t) => {
  const node = await relayNode('links', { trustProxy: true });
  t.after(() => node.close());
  await req(node, 'POST', '/api/me', { key: KEY, secret: secretA, json: { name: 'A', kind: 'phone' } });
  const created = await req(node, 'POST', '/api/drops', { key: KEY, secret: secretA, json: { link: true, text: 'hi' } });
  const code = created.data.drop.code;
  const from = (ip, extra = {}) => ({ headers: { 'CF-Connecting-IP': ip, ...extra } });
  for (let i = 1; i <= 20; i++) assert.equal((await req(node, 'GET', `/api/link/GUESS${String(i).padStart(3, '0')}`, from('203.0.113.5'))).status, 404, `guess ${i}`);
  const blocked = await req(node, 'GET', '/api/link/GUESS021', from('203.0.113.5', { Origin: APP }));
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /too many unknown links/i);
  assert.equal(blocked.headers.get('retry-after'), '600');
  assert.equal(blocked.headers.get('access-control-allow-origin'), APP);
  assert.equal((await req(node, 'GET', `/api/link/${code}`, from('203.0.113.5'))).status, 429, 'the real code is refused to the guesser too');
  assert.equal((await req(node, 'GET', `/api/link/${code}`, from('203.0.113.6'))).status, 200, 'everyone else still opens links');
  assert.equal((await req(node, 'GET', '/api/devices', { key: KEY, ...from('203.0.113.5') })).status, 200, 'the link guard is not the key guard');

  const lan = await relayNode('links-lan', { accessKey: null });
  t.after(() => lan.close());
  for (let i = 1; i <= 25; i++) assert.equal((await req(lan, 'GET', `/api/link/GUESS${String(i).padStart(3, '0')}`)).status, 404);
});

test('relay: the guard buckets IPv6 by /64 and ignores header values that are not IP addresses', async (t) => {
  const node = await relayNode('v6', { trustProxy: true });
  t.after(() => node.close());
  // One host rotating through its /64: every address is new, the bucket is not.
  for (let i = 1; i <= 20; i++) assert.equal((await req(node, 'GET', '/api/devices', { key: 'bad', headers: { 'CF-Connecting-IP': `2001:db8:1:2::${i.toString(16)}` } })).status, 401);
  assert.equal((await req(node, 'GET', '/api/devices', { key: 'bad', headers: { 'CF-Connecting-IP': '2001:db8:1:2:ffff::1' } })).status, 429);
  assert.equal((await req(node, 'GET', '/api/devices', { key: KEY, headers: { 'CF-Connecting-IP': '2001:db8:1:2::abcd' } })).status, 429, 'same /64, same block');
  assert.equal((await req(node, 'GET', '/api/devices', { key: KEY, headers: { 'CF-Connecting-IP': '2001:db8:1:3::1' } })).status, 200, 'the next /64 is somebody else');
  assert.equal(node.guards.key.size, 1, 'twenty-one addresses, one entry');

  // Junk in the trusted header is not a free bucket: it falls back to the socket address.
  const junk = await relayNode('v6-junk', { trustProxy: true });
  t.after(() => junk.close());
  for (let i = 1; i <= 21; i++) await req(junk, 'GET', '/api/devices', { key: 'bad', headers: { 'CF-Connecting-IP': `not-an-ip-${i}` } });
  assert.equal((await req(junk, 'GET', '/api/devices', { key: KEY })).status, 429, 'the socket address (ours) is blocked');
  assert.equal((await req(junk, 'GET', '/api/devices', { key: KEY, headers: { 'X-Forwarded-For': 'garbage, 203.0.113.250' } })).status, 429, 'a bad XFF falls back too');
  assert.equal((await req(junk, 'GET', '/api/devices', { key: KEY, headers: { 'CF-Connecting-IP': '198.51.100.9' } })).status, 200);
});

test('a drop with files holds its quota only for the grace period until bytes arrive', async (t) => {
  const node = await startNode({ port: 0, discovery: false, dataDir: tmp('grace'), maxStoreBytes: 100, ttlMs: 60_000, graceMs: 300 });
  t.after(() => node.close());
  await req(node, 'POST', '/api/me', { secret: secretA, json: { name: 'A', kind: 'phone' } });
  await req(node, 'POST', '/api/me', { secret: secretB, json: { name: 'B', kind: 'laptop' } });
  const mk = (size) => req(node, 'POST', '/api/drops', { secret: secretA, json: { to: idB, files: [{ name: 'f', size }] } });
  const abandoned = await mk(60);
  assert.equal(abandoned.status, 201);
  assert.ok(abandoned.data.drop.expiresAt - abandoned.data.drop.createdAt <= 300, 'nothing received yet: the short expiry');
  assert.equal((await mk(50)).status, 507, 'the reservation counts while it lasts');
  const text = await req(node, 'POST', '/api/drops', { secret: secretA, json: { link: true, text: 'no upload to wait for' } });
  assert.ok(text.data.drop.expiresAt - text.data.drop.createdAt >= 60_000, 'a text-only drop gets the full ttl at once');

  const live = await mk(30);
  const body = Buffer.alloc(30, 1);
  assert.equal((await req(node, 'PUT', `/api/drops/${live.data.drop.id}/files/${live.data.drop.files[0].id}?token=${live.data.uploadToken}`, { body })).status, 200);
  await new Promise((r) => setTimeout(r, 400));
  node.store.sweep();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await req(node, 'GET', `/api/drops/${abandoned.data.drop.id}`)).status, 404, 'the abandoned drop is gone after the grace');
  const kept = await req(node, 'GET', `/api/drops/${live.data.drop.id}`);
  assert.equal(kept.status, 200, 'the uploaded one lives on');
  assert.ok(kept.data.drop.expiresAt - kept.data.drop.createdAt >= 60_000, 'with the full ttl from the upload on');
  assert.equal((await mk(50)).status, 201, 'and its share of the quota is free again');
});
