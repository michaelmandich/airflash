'use strict';

// Chunked uploads (docs/relay-mode.md): PUT .../chunks/:n, GET .../chunks, POST .../complete.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startNode } = require('../src/core');
const { publicIdFromSecret } = require('../src/core/util');

const secretA = 'secret-for-device-a-0123456789';
const secretB = 'secret-for-device-b-0123456789';
const idB = publicIdFromSecret(secretB);
const CHUNK = 4;

const tmpDirs = new Set();
function tmp(name) {
  const dir = path.join(os.tmpdir(), `airflash-chunks-${name}-${process.pid}`);
  tmpDirs.add(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
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

/** A node with tiny chunks, two devices, and a drop declaring one file of `content`. */
async function setup(name, content, extra = {}) {
  const node = await startNode({ port: 0, discovery: false, dataDir: tmp(name), chunkBytes: CHUNK, ...extra });
  await req(node, 'POST', '/api/me', { secret: secretA, json: { name: 'A', kind: 'phone' } });
  await req(node, 'POST', '/api/me', { secret: secretB, json: { name: 'B', kind: 'laptop' } });
  const created = await req(node, 'POST', '/api/drops', { secret: secretA, json: { to: idB, files: [{ name: 'big.bin', size: content.length, type: 'application/octet-stream' }] } });
  assert.equal(created.status, 201);
  const { drop, uploadToken } = created.data;
  const file = drop.files[0];
  const base = `/api/drops/${drop.id}/files/${file.id}`;
  const slice = (n) => content.subarray(n * CHUNK, (n + 1) * CHUNK);
  return {
    node, drop, file, base, slice,
    put: (n, body = slice(n)) => req(node, 'PUT', `${base}/chunks/${n}?token=${uploadToken}`, { body }),
    status: () => req(node, 'GET', `${base}/chunks?token=${uploadToken}`),
    complete: () => req(node, 'POST', `${base}/complete?token=${uploadToken}`),
    whole: (body = content) => req(node, 'PUT', `${base}?token=${uploadToken}`, { body }),
    download: () => req(node, 'GET', base),
    token: uploadToken,
  };
}

test('three chunks out of order, then complete: the file is byte-identical', async (t) => {
  const content = Buffer.from('0123456789'); // 4 + 4 + 2
  const s = await setup('order', content);
  t.after(() => s.node.close());

  assert.equal((await s.download()).status, 409, 'not downloadable yet');
  assert.deepEqual((await s.status()).data, { received: [], chunkBytes: CHUNK, total: 3, status: 'pending' });

  for (const n of [2, 0, 1]) {
    const r = await s.put(n);
    assert.equal(r.status, 200, `chunk ${n}`);
    assert.deepEqual(r.data, { received: true });
  }
  const st = await s.status();
  assert.deepEqual(st.data.received, [0, 1, 2]);
  assert.equal(st.data.status, 'pending', 'nothing in flight between chunks');
  const before = await req(s.node, 'GET', `/api/drops/${s.drop.id}`);
  assert.equal(before.data.drop.files[0].received, content.length);
  assert.equal(before.data.drop.ready, false);

  const done = await s.complete();
  assert.equal(done.status, 200);
  assert.equal(done.data.file.status, 'done');
  assert.equal(done.data.file.received, content.length);
  const after = await req(s.node, 'GET', `/api/drops/${s.drop.id}`);
  assert.equal(after.data.drop.ready, true);
  assert.ok(after.data.drop.expiresAt > s.drop.expiresAt, 'expiry was extended');

  const dl = await s.download();
  assert.equal(dl.status, 200);
  assert.deepEqual(dl.data, content);
  const part = await req(s.node, 'GET', s.base, { headers: { Range: 'bytes=3-5' } });
  assert.equal(part.status, 206);
  assert.equal(part.data.toString(), '345');

  assert.equal((await s.complete()).status, 200, 'completing twice is harmless');
  assert.deepEqual((await s.status()).data, { received: [0, 1, 2], chunkBytes: CHUNK, total: 3, status: 'done' }, 'a done file lists every chunk');
  assert.equal((await s.put(0)).status, 409, 'no more chunks once done');
  assert.equal((await s.whole()).status, 409);
});

test('concurrent chunks do not corrupt each other', async (t) => {
  const content = Buffer.alloc(4 * 1024 * 1024 + 123);
  for (let i = 0; i < content.length; i++) content[i] = (i * 7 + (i >> 8)) & 0xff;
  const chunk = 512 * 1024;
  const s = await setup('concurrent', content, { chunkBytes: chunk });
  t.after(() => s.node.close());
  const total = Math.ceil(content.length / chunk);
  const puts = [];
  for (let n = total - 1; n >= 0; n--) puts.push(s.put(n, content.subarray(n * chunk, (n + 1) * chunk)));
  const results = await Promise.all(puts);
  for (const r of results) assert.equal(r.status, 200);
  assert.equal((await s.status()).data.received.length, total);
  assert.equal((await s.complete()).status, 200);
  const dl = await s.download();
  assert.equal(dl.status, 200);
  assert.equal(Buffer.compare(dl.data, content), 0, 'bytes identical');
});

test('wrong chunk length and bad index are 400; the drop is untouched', async (t) => {
  const content = Buffer.from('0123456789');
  const s = await setup('length', content);
  t.after(() => s.node.close());
  const short = await s.put(0, Buffer.from('012'));
  assert.equal(short.status, 400);
  assert.match(short.data.error, /exactly 4 bytes/);
  assert.equal((await s.put(2, Buffer.from('8901'))).status, 400, 'the last chunk must be the remainder');
  assert.equal((await s.put(3)).status, 400, 'index out of range');
  assert.equal((await s.put(1, Buffer.from('4567'))).status, 200);
  assert.equal((await s.put(1, Buffer.from('xyz'))).status, 400, 'a re-PUT with the wrong length is not the idempotent 200');
  assert.deepEqual((await s.status()).data.received, [1]);
  assert.equal((await req(s.node, 'PUT', `${s.base}/chunks/0?token=wrong`, { body: s.slice(0) })).status, 403);
  assert.equal((await req(s.node, 'PUT', `${s.base}/chunks/0`, { body: s.slice(0) })).status, 403);
});

test('complete with a missing chunk is 400 and lists it; a re-PUT is idempotent', async (t) => {
  const content = Buffer.from('0123456789');
  const s = await setup('missing', content);
  t.after(() => s.node.close());
  assert.equal((await s.put(0)).status, 200);
  assert.equal((await s.put(2)).status, 200);
  const r = await s.complete();
  assert.equal(r.status, 400);
  assert.deepEqual(r.data.missing, [1]);
  assert.match(r.data.error, /1/);
  assert.equal((await s.download()).status, 409);

  const again = await s.put(2);
  assert.equal(again.status, 200);
  assert.deepEqual(again.data, { received: true });
  assert.deepEqual((await s.status()).data.received, [0, 2]);

  assert.equal((await s.put(1)).status, 200);
  assert.equal((await s.complete()).status, 200);
  assert.deepEqual((await s.download()).data, content);
});

test('whole-file PUT is refused once a chunk is in, and chunks are refused during a whole-file PUT', async (t) => {
  const content = Buffer.from('0123456789');
  const s = await setup('mixed', content);
  t.after(() => s.node.close());
  assert.equal((await s.put(1)).status, 200);
  const whole = await s.whole();
  assert.equal(whole.status, 409);
  assert.match(whole.data.error, /chunks/);
  assert.equal((await s.status()).data.received.length, 1, 'the chunk survived');

  // And the other way round, on a second file.
  const s2 = await setup('mixed2', content);
  t.after(() => s2.node.close());
  assert.equal((await s2.whole()).status, 200);
  assert.equal((await s2.put(0)).status, 409);
  assert.equal((await s2.complete()).status, 200, 'already done: complete is a no-op');
  assert.deepEqual((await s2.download()).data, content);
});

test('expiry deletes a partially chunked file; an in-flight chunk holds it', async (t) => {
  const content = Buffer.from('0123456789');
  const s = await setup('expire', content, { ttlMs: 250 });
  t.after(() => s.node.close());
  assert.equal((await s.put(0)).status, 200);
  const onDisk = s.node.store.filePath(s.drop, s.file);
  assert.equal(fs.statSync(onDisk).size, content.length, 'pre-sized to the declared size');

  await new Promise((r) => setTimeout(r, 400));
  s.node.store.sweep();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await req(s.node, 'GET', `/api/drops/${s.drop.id}`)).status, 404);
  assert.equal(fs.existsSync(onDisk), false, 'the partial file is gone');
  assert.equal(fs.existsSync(path.dirname(onDisk)), false);
  assert.equal((await s.put(1)).status, 404);
});

test('an in-flight chunk keeps the drop alive and progress is reported', async (t) => {
  const content = Buffer.alloc(64 * 1024, 7);
  const chunk = 32 * 1024;
  const s = await setup('inflight', content, { chunkBytes: chunk, ttlMs: 300 });
  t.after(() => s.node.close());
  const progress = [];
  s.node.store.on('drop:progress', (d, f) => progress.push(f.received));

  // Stream chunk 0 slowly so it is still in flight when the ttl passes.
  const http = require('node:http');
  const rq = http.request({ host: '127.0.0.1', port: s.node.port, method: 'PUT', path: `${s.base}/chunks/0?token=${s.token}`, headers: { 'Content-Length': chunk } });
  const finished = new Promise((resolve) => rq.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }));
  rq.write(content.subarray(0, chunk / 2));
  await new Promise((r) => setTimeout(r, 450));
  s.node.store.sweep();
  // Past its ttl but still uploading: the sweeper leaves it alone (as for a slow whole-file PUT).
  assert.equal(s.node.store.drops.get(s.drop.id).files[0].status, 'uploading');
  assert.ok(fs.existsSync(s.node.store.filePath(s.drop, s.file)));
  rq.end(content.subarray(chunk / 2, chunk));
  assert.equal(await finished, 200);
  assert.equal((await req(s.node, 'GET', `/api/drops/${s.drop.id}`)).status, 200, 'the finished chunk extended the expiry');
  assert.ok(progress.length >= 1 && progress[0] > 0 && progress[0] <= chunk, `progress events carry received bytes (${progress})`);
  assert.equal((await s.put(1, content.subarray(chunk))).status, 200);
  assert.equal((await s.complete()).status, 200);
  assert.deepEqual((await s.download()).data, content);
});

test('a 0-byte file completes with no chunks', async (t) => {
  const s = await setup('empty', Buffer.alloc(0));
  t.after(() => s.node.close());
  assert.deepEqual((await s.status()).data, { received: [], chunkBytes: CHUNK, total: 0, status: 'pending' });
  assert.equal((await s.put(0, Buffer.alloc(0))).status, 400);
  assert.equal((await s.complete()).status, 200);
  const dl = await s.download();
  assert.equal(dl.status, 200);
  assert.equal(dl.data.length, 0);
});

test('deleting a drop mid-chunk aborts that chunk; the next drop to upload is untouched by it', async (t) => {
  // Chunk writes used to share one fd that delete() closed under the stream; the OS then handed the
  // same fd number to the next file the node opened and the stale chunk's bytes landed in it.
  const chunk = 1024;
  const a = Buffer.alloc(2 * chunk, 0xaa);
  const b = Buffer.alloc(2 * chunk);
  for (let i = 0; i < b.length; i++) b[i] = (i * 3) & 0xff;
  const A = await setup('fd-a', a, { chunkBytes: chunk });
  t.after(() => A.node.close());
  const http = require('node:http');
  const rq = http.request({ host: '127.0.0.1', port: A.node.port, method: 'PUT', path: `${A.base}/chunks/1?token=${A.token}`, headers: { 'Content-Length': chunk } });
  const outcome = new Promise((resolve) => {
    rq.on('response', (res) => { res.resume(); res.on('end', () => resolve(`status ${res.statusCode}`)); });
    rq.on('error', (err) => resolve(`error ${err.code}`));
  });
  rq.write(a.subarray(0, chunk / 2));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(A.node.store.drops.get(A.drop.id).files[0].status, 'uploading');
  const folderA = path.dirname(A.node.store.filePath(A.drop, A.file));

  assert.equal((await req(A.node, 'DELETE', `/api/drops/${A.drop.id}?token=${A.token}`)).status, 200);
  assert.equal(fs.existsSync(folderA), false, 'the folder went, so no fd was left open on it');

  // Another drop on the same node opens its file while A's request is still around.
  const created = await req(A.node, 'POST', '/api/drops', { secret: secretA, json: { to: idB, files: [{ name: 'b.bin', size: b.length }] } });
  const dropB = created.data.drop;
  const baseB = `/api/drops/${dropB.id}/files/${dropB.files[0].id}`;
  assert.equal((await req(A.node, 'PUT', `${baseB}/chunks/0?token=${created.data.uploadToken}`, { body: b.subarray(0, chunk) })).status, 200);
  assert.equal((await req(A.node, 'PUT', `${baseB}/chunks/1?token=${created.data.uploadToken}`, { body: b.subarray(chunk) })).status, 200);
  rq.end(a.subarray(chunk / 2)); // the rest of A's chunk arrives now, at chunk 1's offset: it must go nowhere
  const result = await outcome;
  assert.notEqual(result, 'status 200', `A's chunk was not accepted (${result})`);
  assert.equal((await req(A.node, 'POST', `${baseB}/complete?token=${created.data.uploadToken}`)).status, 200);
  const dl = await req(A.node, 'GET', baseB);
  assert.equal(dl.status, 200);
  assert.equal(Buffer.compare(dl.data, b), 0, 'B is byte-identical: none of A landed in it');
  assert.equal((await req(A.node, 'PUT', `${A.base}/chunks/0?token=${A.token}`, { body: a.subarray(0, chunk) })).status, 404, 'A is gone');
});

test('a chunk PUT that lands while complete is closing the file is a 409, and the file keeps its bytes', async (t) => {
  const content = Buffer.from('0123456789');
  const s = await setup('complete-race', content);
  t.after(() => s.node.close());
  for (const n of [0, 1, 2]) assert.equal((await s.put(n)).status, 200);
  // Hold the close so a late PUT can arrive inside the window.
  const store = s.node.store;
  const close = store._closeChunkState.bind(store);
  store._closeChunkState = async (id) => { await new Promise((r) => setTimeout(r, 200)); return close(id); };
  const completing = s.complete();
  await new Promise((r) => setTimeout(r, 50));
  const late = await s.put(0);
  assert.equal(late.status, 409);
  assert.match(late.data.error, /already uploaded/i);
  const done = await completing;
  assert.equal(done.status, 200);
  assert.equal(done.data.file.status, 'done');
  const dl = await s.download();
  assert.equal(dl.status, 200);
  assert.deepEqual(dl.data, content, 'nothing reopened the file with O_TRUNC');
  assert.equal(store.chunkStates.size, 0, 'no stray state (and no fd) was left behind');
});

test('a chunk that cannot be written is a masked 500: the data directory stays out of the answer', async (t) => {
  const content = Buffer.from('0123456789');
  const log = [];
  const s = await setup('masked', content, { log: (m) => log.push(m) });
  t.after(() => s.node.close());
  const folder = path.dirname(s.node.store.filePath(s.drop, s.file));
  fs.rmSync(folder, { recursive: true, force: true });
  const r = await s.put(0);
  assert.equal(r.status, 500);
  assert.equal(r.data.error, 'Something went wrong');
  assert.ok(!JSON.stringify(r.data).includes(folder.split(path.sep)[0] + path.sep), 'no path in the body');
  assert.ok(log.some((m) => /\[error\].*chunks\/0/.test(m) && /ENOENT|caused by/.test(m)), `the log has the real reason (${log.join(' | ')})`);
  assert.equal(s.node.store.chunkStates.size, 0, 'the failed state was dropped so a retry starts clean');
  // A 507 keeps its message: that one is for people.
  const full = await startNode({ port: 0, discovery: false, dataDir: tmp('masked-507'), maxStoreBytes: 5 });
  t.after(() => full.close());
  await req(full, 'POST', '/api/me', { secret: secretA, json: { name: 'A', kind: 'phone' } });
  await req(full, 'POST', '/api/me', { secret: secretB, json: { name: 'B', kind: 'laptop' } });
  const r507 = await req(full, 'POST', '/api/drops', { secret: secretA, json: { to: idB, files: [{ name: 'f', size: 10 }] } });
  assert.equal(r507.status, 507);
  assert.match(r507.data.error, /full/i);
});

test('chunkBytes never exceeds maxRequestBytes: the node clamps what it advertises and uses', async (t) => {
  const node = await startNode({ port: 0, discovery: false, dataDir: tmp('clamp'), maxRequestBytes: 1000, chunkBytes: 4096 });
  t.after(() => node.close());
  const info = await req(node, 'GET', '/api/node');
  assert.equal(info.data.limits.chunkBytes, 1000);
  assert.equal(info.data.limits.maxRequestBytes, 1000);
  assert.equal(node.store.opts.chunkBytes, 1000, 'the store cuts files the same way');
  const lan = await startNode({ port: 0, discovery: false, dataDir: tmp('clamp-lan'), chunkBytes: 4096 });
  t.after(() => lan.close());
  assert.equal((await req(lan, 'GET', '/api/node')).data.limits.chunkBytes, 4096, 'no cap, no clamp');
});
