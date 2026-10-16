'use strict';

// The browser's chunk uploader (src/web/lib/chunks.js, what client.js runs on a relay) driven
// end to end against a real relay-mode node: the transport is Node's fetch instead of XHR.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startNode } = require('../src/core');
const { publicIdFromSecret } = require('../src/core/util');

const lib = (f) => pathToFileURL(path.join(__dirname, '..', 'src', 'web', 'lib', f)).href;
const KEY = 'k';
const MAX_REQUEST = 1024 * 1024;
const CHUNK = 256 * 1024;
const secretA = 'secret-for-device-a-0123456789';
const secretB = 'secret-for-device-b-0123456789';
const idB = publicIdFromSecret(secretB);

const tmpDirs = new Set();
function tmp(name) {
  const dir = path.join(os.tmpdir(), `airflash-chunks-e2e-${name}-${process.pid}`);
  tmpDirs.add(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** 1.5 MB of non-repeating bytes: exactly six 256 KiB chunks. */
function content(size = 1.5 * 1024 * 1024) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 13 + (i >> 9)) & 0xff;
  return buf;
}

async function json(base, method, url, { secret = secretA, key = KEY, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'X-AirFlash-Device': secret, ...(key ? { 'X-AirFlash-Key': key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

/** A relay node (key 'k', 1 MiB per request, 256 KiB chunks), two devices and a drop declaring one file. */
async function setup(name, bytes) {
  const node = await startNode({ port: 0, discovery: false, dataDir: tmp(name), accessKey: KEY, maxRequestBytes: MAX_REQUEST, chunkBytes: CHUNK });
  const base = `http://127.0.0.1:${node.port}`;
  await json(base, 'POST', '/api/me', { body: { name: 'A', kind: 'phone' } });
  await json(base, 'POST', '/api/me', { secret: secretB, body: { name: 'B', kind: 'laptop' } });
  const { drop, uploadToken } = await json(base, 'POST', '/api/drops', { body: { to: idB, files: [{ name: 'big.bin', size: bytes.length, type: 'application/octet-stream' }] } });
  const fileUrl = `/api/drops/${drop.id}/files/${drop.files[0].id}`;
  return {
    node, base, drop, fileUrl, token: uploadToken,
    file: new Blob([bytes]),
    download: async () => Buffer.from(await (await fetch(base + fileUrl)).arrayBuffer()),
    state: async () => (await fetch(`${base}${fileUrl}/chunks?token=${uploadToken}`)).json(),
  };
}

/**
 * What client.js wires up in the browser, over fetch. `fault(n, attempt)` can make a chunk PUT
 * look lost: 'before' never sends it, 'after' sends it and then drops the answer.
 */
function transport(base, { key = KEY, fault = () => null } = {}) {
  const calls = { get: 0, post: 0, put: [] };
  const lost = () => Object.assign(new Error('Connection lost during upload'), { network: true });
  return {
    calls,
    get: (url) => { calls.get++; return json(base, 'GET', url, { key }); },
    post: (url) => { calls.post++; return json(base, 'POST', url, { key }); },
    async put(url, body, onLoaded) {
      const n = Number(/\/chunks\/(\d+)\?/.exec(url)[1]);
      calls.put.push(n);
      const what = fault(n, calls.put.filter((x) => x === n).length);
      if (what === 'before') throw lost();
      const res = await fetch(base + url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body });
      const data = await res.json().catch(() => ({}));
      if (what === 'after') throw lost();
      if (!res.ok) throw Object.assign(new Error(data.error || `Upload failed (${res.status})`), { status: res.status });
      onLoaded(body.size);
    },
  };
}

const counts = (list) => list.reduce((m, n) => m.set(n, (m.get(n) || 0) + 1), new Map());
const noWait = async () => {};

test('a 1.5 MB Blob goes up as six chunks and comes back byte-identical', async (t) => {
  const { uploadChunked, chunkPlan } = await import(lib('chunks.js'));
  const { setNodeLimits, needsChunks } = await import(lib('client.js'));
  const bytes = content();
  const s = await setup('six', bytes);
  t.after(() => s.node.close());

  // The node advertises the limits the client decides with: 1.5 MB is over the request cap, so chunks.
  const info = await json(s.base, 'GET', '/api/node', { key: null });
  assert.equal(info.relay, true);
  assert.equal(info.urls, undefined);
  assert.deepEqual(info.limits, { maxRequestBytes: MAX_REQUEST, chunkBytes: CHUNK, ttlMs: 15 * 60 * 1000 });
  setNodeLimits(info.limits);
  assert.equal(needsChunks(bytes.length), true);
  assert.equal(needsChunks(MAX_REQUEST), false, 'exactly the cap still goes whole');
  assert.equal(chunkPlan(bytes.length, info.limits.chunkBytes).total, 6);

  const tr = transport(s.base);
  const progress = [];
  await uploadChunked({ fileUrl: s.fileUrl, token: s.token, file: s.file, chunkBytes: info.limits.chunkBytes, transport: tr, onProgress: (n) => progress.push(n), wait: noWait });

  assert.deepEqual([...tr.calls.put].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5], 'each chunk exactly once');
  assert.equal(tr.calls.get, 1, 'one GET .../chunks on first contact, no resync needed');
  assert.equal(tr.calls.post, 1, 'one POST .../complete');
  assert.ok(progress.every((n) => n <= bytes.length));
  assert.equal(progress.at(-1), bytes.length);
  // Done files list every chunk, so a Retry after a lost `complete` answer goes straight to complete again.
  assert.deepEqual(await s.state(), { received: [0, 1, 2, 3, 4, 5], chunkBytes: CHUNK, total: 6, status: 'done' });

  const { drop } = await json(s.base, 'GET', `/api/drops/${s.drop.id}`, { key: null });
  assert.equal(drop.ready, true);
  assert.equal(drop.files[0].received, bytes.length);
  assert.equal(Buffer.compare(await s.download(), bytes), 0, 'bytes identical');
});

test('chunk 3 lost after the node had it: the resync sees it and it is not sent again', async (t) => {
  const { uploadChunked } = await import(lib('chunks.js'));
  const bytes = content();
  const s = await setup('lost-after', bytes);
  t.after(() => s.node.close());

  const tr = transport(s.base, { fault: (n, attempt) => (n === 3 && attempt === 1 ? 'after' : null) });
  await uploadChunked({ fileUrl: s.fileUrl, token: s.token, file: s.file, chunkBytes: CHUNK, transport: tr, wait: noWait });

  const seen = counts(tr.calls.put);
  assert.equal(seen.get(3), 1, 'chunk 3 was PUT once: the resync said the node already had it');
  for (const n of [0, 1, 2, 4, 5]) assert.equal(seen.get(n), 1, `chunk ${n}`);
  assert.ok(tr.calls.get >= 2, 'GET .../chunks was asked again after the failure');
  assert.equal(tr.calls.post, 1);
  assert.equal(Buffer.compare(await s.download(), bytes), 0, 'bytes identical');
});

test('chunk 3 lost before it reached the node: the resync shows it missing and only it is re-sent', async (t) => {
  const { uploadChunked } = await import(lib('chunks.js'));
  const bytes = content();
  const s = await setup('lost-before', bytes);
  t.after(() => s.node.close());

  const tr = transport(s.base, { fault: (n, attempt) => (n === 3 && attempt === 1 ? 'before' : null) });
  await uploadChunked({ fileUrl: s.fileUrl, token: s.token, file: s.file, chunkBytes: CHUNK, transport: tr, wait: noWait });

  const seen = counts(tr.calls.put);
  assert.equal(seen.get(3), 2, 'chunk 3: the lost attempt, then the real one');
  for (const n of [0, 1, 2, 4, 5]) assert.equal(seen.get(n), 1, `chunk ${n} was not re-sent`);
  assert.equal(Buffer.compare(await s.download(), bytes), 0, 'bytes identical');
});

test('Retry after a dropped connection sends only what the node is missing, and needs no key', async (t) => {
  const { uploadChunked } = await import(lib('chunks.js'));
  const bytes = content();
  const s = await setup('resume', bytes);
  t.after(() => s.node.close());

  // A first attempt got chunks 0, 1 and 4 in before the connection died.
  for (const n of [0, 1, 4]) {
    const res = await fetch(`${s.base}${s.fileUrl}/chunks/${n}?token=${s.token}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: s.file.slice(n * CHUNK, (n + 1) * CHUNK) });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  }
  assert.deepEqual((await s.state()).received, [0, 1, 4]);

  // The chunk routes are token-only (docs/relay-mode.md), so a client without the key can still finish an upload.
  const tr = transport(s.base, { key: null });
  await uploadChunked({ fileUrl: s.fileUrl, token: s.token, file: s.file, chunkBytes: CHUNK, transport: tr, wait: noWait });
  assert.deepEqual([...tr.calls.put].sort((a, b) => a - b), [2, 3, 5], 'only the missing chunks went up');
  assert.equal(Buffer.compare(await s.download(), bytes), 0, 'bytes identical');
});

test('a short last chunk and a chunk the node refuses for good', async (t) => {
  const { uploadChunked } = await import(lib('chunks.js'));
  const bytes = content(CHUNK * 2 + 777);
  const s = await setup('short', bytes);
  t.after(() => s.node.close());

  const tr = transport(s.base);
  await uploadChunked({ fileUrl: s.fileUrl, token: s.token, file: s.file, chunkBytes: CHUNK, transport: tr, wait: noWait });
  assert.deepEqual([...tr.calls.put].sort((a, b) => a - b), [0, 1, 2]);
  assert.equal(Buffer.compare(await s.download(), bytes), 0, 'bytes identical');

  // A bad token is a 403 on every chunk route: not a network blip, so the uploader gives up at once.
  const s2 = await setup('short2', bytes);
  t.after(() => s2.node.close());
  const bad = transport(s2.base);
  await assert.rejects(
    uploadChunked({ fileUrl: s2.fileUrl, token: 'wrong', file: s2.file, chunkBytes: CHUNK, transport: bad, wait: noWait }),
    (err) => err.status === 403,
  );
  assert.equal(bad.calls.put.length, 2, 'both workers failed their first chunk and stopped');
});
