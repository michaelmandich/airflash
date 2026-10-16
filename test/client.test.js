'use strict';

// Pure helpers from the web client that the iOS app leans on.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const clientUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'web', 'lib', 'client.js')).href;

test('normalizeServerUrl turns what people type into a node origin', async () => {
  const { normalizeServerUrl } = await import(clientUrl);
  assert.equal(normalizeServerUrl('192.0.2.15'), 'http://192.0.2.15:4747');
  assert.equal(normalizeServerUrl(' my-pc.local:4848 '), 'http://my-pc.local:4848');
  assert.equal(normalizeServerUrl('http://my-pc.local'), 'http://my-pc.local:4747');
  assert.equal(normalizeServerUrl('http://192.0.2.15:4747/some/path?x=1'), 'http://192.0.2.15:4747');
  assert.equal(normalizeServerUrl('https://relay.example.com'), 'https://relay.example.com');
  assert.equal(normalizeServerUrl('https://relay.example.com:8443/'), 'https://relay.example.com:8443');
  assert.equal(normalizeServerUrl('[fe80::1]:4747'), 'http://[fe80::1]:4747');
  assert.equal(normalizeServerUrl(''), null);
  assert.equal(normalizeServerUrl('   '), null);
  assert.equal(normalizeServerUrl('ftp://x'), null);
  assert.equal(normalizeServerUrl('not a url'), null);
});

/** A browser-ish global scope for client.js: storage, window events, a scripted fetch and a scripted EventSource. */
function browserScope(t, { native = null } = {}) {
  const storage = new Map();
  const events = [];
  const calls = [];
  const responses = [];
  class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    static instances = [];
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; FakeEventSource.instances.push(this); }
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
    close() { this.readyState = 2; }
    emit(ev, data) { this.readyState = 1; for (const fn of this.listeners[ev] || []) fn({ data: JSON.stringify(data) }); }
    die() { this.readyState = 2; this.onerror?.(); }
  }
  global.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
  global.window = { AirFlashNative: native, dispatchEvent: (e) => { events.push(e.detail); return true; } };
  global.document = { addEventListener() {}, visibilityState: 'visible' };
  global.EventSource = FakeEventSource;
  global.fetch = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {}, method: init.method || 'GET' });
    const next = responses.shift() || { status: 200, body: {} };
    return { ok: next.status < 300, status: next.status, json: async () => next.body };
  };
  t.after(() => { for (const k of ['localStorage', 'window', 'document', 'EventSource', 'fetch']) delete global[k]; });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { storage, events, calls, responses, FakeEventSource, settle };
}

test('fetchNodeAt probes a foreign origin bare: no stored key, no device secret', async (t) => {
  const { calls, storage } = browserScope(t);
  const { fetchNodeAt, setAccessKey, fetchNode } = await import(clientUrl);
  setAccessKey('relay-key-000');
  assert.equal(storage.get('airflash.key'), 'relay-key-000');
  await fetchNodeAt('http://192.0.2.44:4747');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://192.0.2.44:4747/api/node');
  assert.deepEqual(Object.keys(calls[0].headers), [], 'nothing stored travels to a host someone just tapped');
  await fetchNode();
  assert.equal(calls[1].url, '/api/node');
  assert.equal(calls[1].headers['X-AirFlash-Key'], 'relay-key-000', 'our own node does get the key');
  setAccessKey('');
});

test('the key goes only to our node: relative URLs and the configured origin, never another absolute origin', async (t) => {
  const { calls } = browserScope(t, { native: { getServerUrl: () => 'https://air.example' } });
  const { deleteDrop, setAccessKey } = await import(clientUrl);
  setAccessKey('relay-key-000');
  await deleteDrop('https://air.example', 'd1', 't');
  await deleteDrop('https://air.example/peer/x', 'd2', 't');
  await deleteDrop('http://other.example', 'd3', 't');
  await deleteDrop('https://air.example.evil', 'd4', 't');
  assert.equal(calls[0].headers['X-AirFlash-Key'], 'relay-key-000');
  assert.equal(calls[1].headers['X-AirFlash-Key'], 'relay-key-000');
  assert.equal(calls[2].headers['X-AirFlash-Key'], undefined);
  assert.equal(calls[3].headers['X-AirFlash-Key'], undefined, 'a prefix match on the hostname is not our node');
  setAccessKey('');
});

test('a LAN node reconnects as before: a dead stream is retried in 2 s with no probe requests', async (t) => {
  const { calls, events, FakeEventSource } = browserScope(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { connect, setAccessKey } = await import(clientUrl);
  setAccessKey('');
  const conn = connect(() => ({ name: 'A', kind: 'phone' }), { hello() {}, error() {} });
  const es1 = FakeEventSource.instances.at(-1);
  assert.doesNotMatch(es1.url, /key=/);
  es1.emit('hello', { node: { relay: false, limits: {} }, me: {}, devices: [], drops: [] });
  es1.die();
  await Promise.resolve();
  assert.equal(calls.length, 0, 'no GET /api/node, no GET /api/devices');
  t.mock.timers.tick(2000);
  assert.equal(FakeEventSource.instances.at(-1) !== es1, true, 'a fresh stream after 2 s');
  assert.equal(events.length, 0);
  conn.close();
});

test('a relay refusing the stream prompts once per stream, even right after a wrong key was saved', async (t) => {
  const { calls, events, responses, FakeEventSource, settle } = browserScope(t);
  const { connect, setAccessKey } = await import(clientUrl);
  setAccessKey('');
  // No key: /api/node says relay, /api/devices says 401 → ask for one, with the source so the UI can tell it from a request's 401.
  responses.push({ status: 200, body: { relay: true } }, { status: 401, body: { error: 'Access key required' } });
  const conn = connect(() => ({ name: 'A', kind: 'phone' }), { hello() {}, error() {} });
  FakeEventSource.instances.at(-1).die();
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(events.at(-1), { reason: 'missing', source: 'stream', hasKey: false });
  const streams = FakeEventSource.instances.length;
  await settle();
  assert.equal(FakeEventSource.instances.length, streams, 'paused: no reconnect loop feeding the guard');
  conn.close();

  // Seconds later the person saves a wrong key: the verdict on it must not be swallowed by the debounce.
  setAccessKey('wrong-key-0000');
  responses.push({ status: 200, body: { relay: true } }, { status: 401, body: { error: 'Wrong access key' } });
  const conn2 = connect(() => ({ name: 'A', kind: 'phone' }), { hello() {}, error() {} });
  const es2 = FakeEventSource.instances.at(-1);
  assert.match(es2.url, /key=wrong-key-0000/);
  es2.die();
  await settle();
  assert.deepEqual(events.at(-1), { reason: 'wrong', source: 'stream', hasKey: true });
  assert.equal(events.length, 2);
  conn2.close();
  setAccessKey('');
});

test('qrUrl carries the stored key in the query (an <img> has no headers); without one the URL is bare', async (t) => {
  browserScope(t, { native: { getServerUrl: () => 'https://air.example' } });
  const { qrUrl, setAccessKey } = await import(clientUrl);
  setAccessKey('');
  assert.equal(qrUrl('https://air.example/d/ABCD2345'), 'https://air.example/api/qr.svg?data=https%3A%2F%2Fair.example%2Fd%2FABCD2345');
  setAccessKey('relay-key-000');
  assert.equal(qrUrl('x y'), 'https://air.example/api/qr.svg?data=x+y&key=relay-key-000');
  setAccessKey('');
  assert.doesNotMatch(qrUrl('x'), /key=/, 'clearing the key clears the query');
});

test('apiBase is empty outside the iOS app, the configured origin inside it', async () => {
  const { apiBase, baseFor } = await import(clientUrl);
  assert.equal(apiBase(), '');
  assert.equal(baseFor({ remote: true, node: 'abc' }), '/peer/abc');
  global.window = { AirFlashNative: { getServerUrl: () => 'http://192.0.2.15:4747' } };
  try {
    assert.equal(apiBase(), 'http://192.0.2.15:4747');
    assert.equal(baseFor(null), 'http://192.0.2.15:4747');
    assert.equal(baseFor({ remote: true, node: 'abc' }), 'http://192.0.2.15:4747/peer/abc');
    global.window.AirFlashNative.getServerUrl = () => null;
    assert.equal(apiBase(), '');
  } finally {
    delete global.window;
  }
});
