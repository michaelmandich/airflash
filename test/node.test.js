'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { startNode } = require('../src/core');
const { publicIdFromSecret } = require('../src/core/util');

const secretA = 'secret-for-device-a-0123456789';
const secretB = 'secret-for-device-b-0123456789';
const idA = publicIdFromSecret(secretA);
const idB = publicIdFromSecret(secretB);

const tmpDirs = new Set();
function tmp(name) {
  const dir = path.join(os.tmpdir(), `airflash-test-${name}-${process.pid}`);
  tmpDirs.add(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpDirs) require('node:fs').rmSync(dir, { recursive: true, force: true });
});

async function req(node, method, url, { secret, json, body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${node.port}${url}`, {
    method,
    headers: {
      ...(secret ? { 'X-AirFlash-Device': secret } : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

async function register(node, secret, name) {
  const r = await req(node, 'POST', '/api/me', { secret, json: { name, kind: 'phone' } });
  assert.equal(r.status, 200);
  return r.data.me;
}

test('drops: send, upload, list, download with Range, delete', async (t) => {
  const node = await startNode({ port: 0, discovery: false, dataDir: tmp('a') });
  t.after(() => node.close());

  await register(node, secretA, 'Phone A');
  await register(node, secretB, 'Laptop B');

  const content = Buffer.from('0123456789abcdefghij');
  const created = await req(node, 'POST', '/api/drops', {
    secret: secretA,
    json: { to: idB, text: 'hello', files: [{ name: '../../evil/photo.jpg', size: content.length, type: 'image/jpeg' }] },
  });
  assert.equal(created.status, 201);
  const { drop, uploadToken } = created.data;
  assert.equal(drop.files[0].name, '.._.._evil_photo.jpg'.replace(/^\.+/, ''), 'path separators are neutralized');
  assert.equal(drop.uploadToken, undefined, 'token is not part of the public drop');
  assert.equal(drop.ready, false);

  // Wrong token is refused.
  const bad = await req(node, 'PUT', `/api/drops/${drop.id}/files/${drop.files[0].id}?token=nope`, { body: content });
  assert.equal(bad.status, 403);

  const up = await req(node, 'PUT', `/api/drops/${drop.id}/files/${drop.files[0].id}?token=${uploadToken}`, { body: content });
  assert.equal(up.status, 200);

  // B sees it, a stranger doesn't.
  const listB = await req(node, 'GET', '/api/drops', { secret: secretB });
  assert.equal(listB.data.drops.length, 1);
  assert.equal(listB.data.drops[0].ready, true);
  const stranger = await req(node, 'GET', '/api/drops', { secret: 'some-other-secret-0123456789' });
  assert.equal(stranger.data.drops.length, 0);

  const fileUrl = `/api/drops/${drop.id}/files/${drop.files[0].id}`;
  const full = await req(node, 'GET', fileUrl);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-disposition').startsWith('inline'), true);
  assert.deepEqual(full.data, content);

  const part = await req(node, 'GET', fileUrl, { headers: { Range: 'bytes=5-9' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 5-9/${content.length}`);
  assert.equal(part.data.toString(), '56789');

  const dl = await req(node, 'GET', `${fileUrl}?download=1`);
  assert.equal(dl.headers.get('content-disposition').startsWith('attachment'), true);

  const del = await req(node, 'DELETE', `/api/drops/${drop.id}`, { secret: 'some-other-secret-0123456789' });
  assert.equal(del.status, 403, 'only sender/recipient can delete');
  const del2 = await req(node, 'DELETE', `/api/drops/${drop.id}`, { secret: secretB });
  assert.equal(del2.status, 200);
  assert.equal((await req(node, 'GET', fileUrl)).status, 404);
});

test('uploads: size mismatch is rejected and can be retried', async (t) => {
  const node = await startNode({ port: 0, discovery: false, dataDir: tmp('b') });
  t.after(() => node.close());
  await register(node, secretA, 'A');
  await register(node, secretB, 'B');
  const { data } = await req(node, 'POST', '/api/drops', { secret: secretA, json: { to: idB, files: [{ name: 'a.bin', size: 4 }] } });
  const url = `/api/drops/${data.drop.id}/files/${data.drop.files[0].id}?token=${data.uploadToken}`;
  assert.equal((await req(node, 'PUT', url, { body: Buffer.from('12345') })).status, 400);
  assert.equal((await req(node, 'PUT', url, { body: Buffer.from('1234') })).status, 200);
  assert.equal((await req(node, 'PUT', url, { body: Buffer.from('1234') })).status, 409, 'cannot overwrite a finished file');
});

test('share links resolve by short code; HTML is never served inline', async (t) => {
  const node = await startNode({ port: 0, discovery: false, dataDir: tmp('c') });
  t.after(() => node.close());
  await register(node, secretA, 'A');
  const html = Buffer.from('<script>alert(1)</script>');
  const { data } = await req(node, 'POST', '/api/drops', { secret: secretA, json: { link: true, files: [{ name: 'x.html', size: html.length, type: 'text/html' }] } });
  assert.match(data.drop.code, /^[A-Z2-9]{6}$/);
  await req(node, 'PUT', `/api/drops/${data.drop.id}/files/${data.drop.files[0].id}?token=${data.uploadToken}`, { body: html });
  const link = await req(node, 'GET', `/api/link/${data.drop.code.toLowerCase()}`);
  assert.equal(link.status, 200);
  const file = await req(node, 'GET', `/api/drops/${data.drop.id}/files/${data.drop.files[0].id}`);
  assert.equal(file.headers.get('content-type'), 'application/octet-stream');
  assert.match(file.headers.get('content-security-policy'), /sandbox/);
});

test('drops expire', async (t) => {
  const node = await startNode({ port: 0, discovery: false, dataDir: tmp('d'), ttlMs: 200 });
  t.after(() => node.close());
  await register(node, secretA, 'A');
  await register(node, secretB, 'B');
  const { data } = await req(node, 'POST', '/api/drops', { secret: secretA, json: { to: idB, text: 'bye soon' } });
  assert.equal((await req(node, 'GET', `/api/drops/${data.drop.id}`)).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await req(node, 'GET', `/api/drops/${data.drop.id}`)).status, 404);
});

test('two nodes sharing a data dir do not delete each other’s files', async (t) => {
  const dir = tmp('shared');
  const a = await startNode({ port: 0, discovery: false, dataDir: dir });
  t.after(() => a.close());
  await register(a, secretA, 'A');
  await register(a, secretB, 'B');
  const body = Buffer.from('still here');
  const { data } = await req(a, 'POST', '/api/drops', { secret: secretA, json: { to: idB, files: [{ name: 'k.txt', size: body.length, type: 'text/plain' }] } });
  await req(a, 'PUT', `/api/drops/${data.drop.id}/files/${data.drop.files[0].id}?token=${data.uploadToken}`, { body });

  const b = await startNode({ port: 0, discovery: false, dataDir: dir }); // e.g. desktop app + headless node
  t.after(() => b.close());
  const got = await req(a, 'GET', `/api/drops/${data.drop.id}/files/${data.drop.files[0].id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.data, body);
});

test('peer nodes: devices are merged and drops are forwarded', async (t) => {
  const pc = await startNode({ port: 0, name: 'PC', dataDir: tmp('pc') });
  const mac = await startNode({ port: 0, name: 'Mac', dataDir: tmp('mac') });
  t.after(async () => { await pc.close(); await mac.close(); });

  await register(pc, secretA, 'iPhone'); // phone is attached to the PC node
  await register(mac, secretB, 'MacBook'); // laptop is attached to the Mac node

  // Don't depend on multicast in CI: introduce them directly too.
  pc.discovery.addManual('127.0.0.1', mac.port);
  mac.discovery.addManual('127.0.0.1', pc.port);

  let remote;
  for (let i = 0; i < 40 && !remote; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const { data } = await req(pc, 'GET', '/api/devices');
    remote = data.devices.find((d) => d.id === idB && d.remote);
  }
  assert.ok(remote, 'the MacBook shows up on the PC node');
  assert.equal(remote.nodeName, 'Mac');

  // Phone (on PC) sends to MacBook (on Mac) through the PC's /peer proxy.
  const payload = Buffer.from('a photo, pretend');
  const created = await req(pc, 'POST', `/peer/${remote.node}/api/drops`, {
    secret: secretA,
    json: { to: idB, files: [{ name: 'IMG_0001.jpg', size: payload.length, type: 'image/jpeg' }] },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.drop.from.name, 'iPhone');
  assert.equal(created.data.drop.from.node, 'PC');
  const { drop, uploadToken } = created.data;
  const up = await req(pc, 'PUT', `/peer/${remote.node}/api/drops/${drop.id}/files/${drop.files[0].id}?token=${uploadToken}`, { body: payload });
  assert.equal(up.status, 200);

  const inbox = await req(mac, 'GET', '/api/drops', { secret: secretB });
  assert.equal(inbox.data.drops.length, 1);
  const got = await req(mac, 'GET', `/api/drops/${drop.id}/files/${drop.files[0].id}`);
  assert.deepEqual(got.data, payload);

  // The proxy only forwards drop endpoints.
  assert.equal((await req(pc, 'GET', `/peer/${remote.node}/api/drops`, { secret: secretA })).status, 404);
});
