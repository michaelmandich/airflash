'use strict';

// The iOS app serves the UI from capacitor://localhost and talks to the node cross-origin,
// so /api and /peer must answer CORS; anything else on the LAN must not get a free pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { startNode } = require('../src/core');
const { publicIdFromSecret } = require('../src/core/util');

const APP = 'capacitor://localhost';
const EVIL = 'http://evil.example';
const secretA = 'secret-for-device-a-0123456789';
const secretB = 'secret-for-device-b-0123456789';
const idB = publicIdFromSecret(secretB);

const tmpDirs = new Set();
function tmp(name) {
  const dir = path.join(os.tmpdir(), `airflash-cors-${name}-${process.pid}`);
  tmpDirs.add(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpDirs) require('node:fs').rmSync(dir, { recursive: true, force: true });
});

function call(node, method, url, { origin, secret, json, body, headers = {} } = {}) {
  return fetch(`http://127.0.0.1:${node.port}${url}`, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(secret ? { 'X-AirFlash-Device': secret } : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
  });
}

test('preflight from the app origin gets the full CORS answer', async (t) => {
  const node = await startNode({ port: 0, discovery: false, dataDir: tmp('pre') });
  t.after(() => node.close());
  const res = await call(node, 'OPTIONS', '/api/drops', {
    origin: APP,
    headers: { 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-airflash-device, content-type' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), APP);
  assert.equal(res.headers.get('vary'), 'Origin');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET,POST,PUT,DELETE,OPTIONS');
  assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type, X-AirFlash-Device, X-AirFlash-Key, Range');
  assert.equal(res.headers.get('access-control-max-age'), '86400');
  await res.arrayBuffer();
});

test('a disallowed origin gets no CORS headers, and is not refused outright', async (t) => {
  const node = await startNode({ port: 0, discovery: false, dataDir: tmp('evil') });
  t.after(() => node.close());
  const pre = await call(node, 'OPTIONS', '/api/node', { origin: EVIL, headers: { 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
  assert.equal(pre.headers.get('access-control-allow-methods'), null);
  await pre.arrayBuffer();

  const get = await call(node, 'GET', '/api/node', { origin: EVIL });
  assert.equal(get.status, 200, 'the request itself still works; the browser is what blocks it');
  assert.equal(get.headers.get('access-control-allow-origin'), null);
  assert.equal(get.headers.get('access-control-expose-headers'), null);
  await get.arrayBuffer();

  // Same-origin / non-browser callers (no Origin header) are untouched.
  const plain = await call(node, 'GET', '/api/node');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('access-control-allow-origin'), null);
  await plain.arrayBuffer();

  // Another web server on the node's own machine is just another origin; only the app WebView is trusted by default.
  for (const origin of ['http://localhost', 'https://localhost', 'http://localhost:4747']) {
    const res = await call(node, 'GET', '/api/node', { origin });
    assert.equal(res.headers.get('access-control-allow-origin'), null, origin);
    await res.arrayBuffer();
  }
});

test('GET /api responses and SSE carry the CORS headers', async (t) => {
  const node = await startNode({ port: 0, discovery: false, dataDir: tmp('get') });
  t.after(() => node.close());

  const info = await call(node, 'GET', '/api/node', { origin: APP });
  assert.equal(info.status, 200);
  assert.equal(info.headers.get('access-control-allow-origin'), APP);
  assert.equal(info.headers.get('vary'), 'Origin');
  assert.equal(info.headers.get('access-control-expose-headers'), 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition');
  await info.arrayBuffer();

  // EventSource can't send headers, so the secret rides in the query; the stream headers must still allow the app origin.
  const q = new URLSearchParams({ device: secretA, name: 'iPhone', kind: 'phone' });
  const sse = await call(node, 'GET', `/api/events?${q}`, { origin: APP });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get('content-type'), /text\/event-stream/);
  assert.equal(sse.headers.get('access-control-allow-origin'), APP);
  assert.equal(sse.headers.get('vary'), 'Origin');
  await sse.body.cancel();

  // File downloads too (the app fetches thumbnails and saves media from these).
  await call(node, 'POST', '/api/me', { secret: secretB, json: { name: 'B', kind: 'laptop' } }).then((r) => r.arrayBuffer());
  const body = Buffer.from('pixels');
  const created = await call(node, 'POST', '/api/drops', { origin: APP, secret: secretA, json: { to: idB, files: [{ name: 'p.jpg', size: body.length, type: 'image/jpeg' }] } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('access-control-allow-origin'), APP);
  const { drop, uploadToken } = await created.json();
  const fileUrl = `/api/drops/${drop.id}/files/${drop.files[0].id}`;
  const up = await call(node, 'PUT', `${fileUrl}?token=${uploadToken}`, { origin: APP, body });
  assert.equal(up.status, 200);
  assert.equal(up.headers.get('access-control-allow-origin'), APP);
  await up.arrayBuffer();
  const dl = await call(node, 'GET', fileUrl, { origin: APP, headers: { Range: 'bytes=0-2' } });
  assert.equal(dl.status, 206);
  assert.equal(dl.headers.get('access-control-allow-origin'), APP);
  assert.equal(dl.headers.get('accept-ranges'), 'bytes');
  await dl.arrayBuffer();
});

test('extra origins come from opts.corsOrigins and AIRFLASH_CORS_ORIGINS', async (t) => {
  const prev = process.env.AIRFLASH_CORS_ORIGINS;
  process.env.AIRFLASH_CORS_ORIGINS = ' https://relay.example , https://other.example/';
  const node = await startNode({ port: 0, discovery: false, dataDir: tmp('extra'), corsOrigins: ['https://app.example'] });
  process.env.AIRFLASH_CORS_ORIGINS = prev;
  if (prev === undefined) delete process.env.AIRFLASH_CORS_ORIGINS;
  t.after(() => node.close());
  for (const origin of ['https://relay.example', 'https://other.example', 'https://app.example']) {
    const res = await call(node, 'GET', '/api/node', { origin });
    assert.equal(res.headers.get('access-control-allow-origin'), origin, origin);
    await res.arrayBuffer();
  }
  const res = await call(node, 'GET', '/api/node', { origin: 'https://relay.example.evil' });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  await res.arrayBuffer();
});

test('proxied /peer responses carry the CORS headers too', async (t) => {
  const pc = await startNode({ port: 0, name: 'PC', dataDir: tmp('pc') });
  const mac = await startNode({ port: 0, name: 'Mac', dataDir: tmp('mac') });
  t.after(async () => { await pc.close(); await mac.close(); });

  await call(pc, 'POST', '/api/me', { secret: secretA, json: { name: 'iPhone', kind: 'phone' } }).then((r) => r.arrayBuffer());
  await call(mac, 'POST', '/api/me', { secret: secretB, json: { name: 'MacBook', kind: 'laptop' } }).then((r) => r.arrayBuffer());
  pc.discovery.addManual('127.0.0.1', mac.port);
  mac.discovery.addManual('127.0.0.1', pc.port);

  let remote;
  for (let i = 0; i < 40 && !remote; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const { devices } = await call(pc, 'GET', '/api/devices').then((r) => r.json());
    remote = devices.find((d) => d.id === idB && d.remote);
  }
  assert.ok(remote, 'the MacBook shows up on the PC node');

  const pre = await call(pc, 'OPTIONS', `/peer/${remote.node}/api/drops`, { origin: APP, headers: { 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), APP);
  assert.equal(pre.headers.get('access-control-allow-methods'), 'GET,POST,PUT,DELETE,OPTIONS');
  await pre.arrayBuffer();

  const payload = Buffer.from('a photo, pretend');
  const created = await call(pc, 'POST', `/peer/${remote.node}/api/drops`, {
    origin: APP,
    secret: secretA,
    json: { to: idB, files: [{ name: 'IMG_0001.jpg', size: payload.length, type: 'image/jpeg' }] },
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('access-control-allow-origin'), APP);
  assert.equal(created.headers.get('vary'), 'Origin');
  assert.equal(created.headers.get('access-control-expose-headers'), 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition');
  const { drop, uploadToken } = await created.json();
  const up = await call(pc, 'PUT', `/peer/${remote.node}/api/drops/${drop.id}/files/${drop.files[0].id}?token=${uploadToken}`, { origin: APP, body: payload });
  assert.equal(up.status, 200);
  assert.equal(up.headers.get('access-control-allow-origin'), APP);
  await up.arrayBuffer();

  const blocked = await call(pc, 'POST', `/peer/${remote.node}/api/drops`, { origin: EVIL, secret: secretA, json: { to: idB, text: 'hi' } });
  assert.equal(blocked.status, 201);
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  await blocked.arrayBuffer();
});
