'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DropStore, publicDrop, httpError } = require('./store');
const { DeviceRegistry } = require('./devices');
const { Discovery } = require('./discovery');
const { serveFile } = require('./files');
const { createStatic } = require('./static');
const { lanAddresses } = require('./net');
const { FailureGuard, addressBucket } = require('./guard');
const { randomId, sendJson, sendError, readJson, clampString } = require('./util');

const VERSION = require('../../package.json').version;
const DEFAULT_PORT = 4747;
// Web origins allowed to call the API from another origin: only the app WebView origins (Capacitor/Ionic
// serve the bundled UI from these) plus whatever AIRFLASH_CORS_ORIGINS / opts.corsOrigins add (a relay's site).
// http(s)://localhost is deliberately absent: nothing of ours is served there (Electron is
// http://localhost:<port>, a different origin), but any other local web server would be.
const DEFAULT_CORS_ORIGINS = ['capacitor://localhost', 'ionic://localhost'];
const DEFAULT_CHUNK_BYTES = 32 * 1024 ** 2;
// Brute-force guard for the access key: more than GUARD_MAX wrong keys from one IP inside
// GUARD_WINDOW_MS → every guarded request from that IP is 429 for GUARD_BAN_MS. On a relay the
// same shape guards /api/link/:code, the one unauthenticated route whose capability is short enough to enumerate.
const GUARD_MAX = 20;
const GUARD_WINDOW_MS = 10 * 60 * 1000;
const GUARD_BAN_MS = 10 * 60 * 1000;
const GUARD_SWEEP_MS = 60 * 1000;
const GUARD_MAX_ENTRIES = 10_000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** opts.accessKey (one string) and/or opts.accessKeys (strings or {key,label}) → [{key,label}]; empty = LAN mode. */
function normalizeKeys({ accessKey, accessKeys }) {
  const raw = [...(Array.isArray(accessKeys) ? accessKeys : []), ...(accessKey != null && accessKey !== '' ? [accessKey] : [])];
  const out = [];
  for (const k of raw) {
    const key = typeof k === 'string' ? k : String(k?.key ?? '');
    if (!key) continue;
    out.push({ key, label: typeof k === 'object' && k?.label ? clampString(k.label, 40) : null });
  }
  return out;
}

/**
 * Start an AirFlash node: HTTP API + web UI + LAN discovery.
 * The desktop app runs one of these in-process; `bin/airflash.js` runs one headless.
 */
async function startNode(options = {}) {
  const opts = {
    port: DEFAULT_PORT,
    host: '0.0.0.0',
    name: os.hostname(),
    dataDir: path.join(os.tmpdir(), 'airflash'),
    webRoot: path.join(__dirname, '..', 'web'),
    discovery: true,
    allowedHosts: [],
    corsOrigins: [],
    accessKey: null,
    accessKeys: [],
    maxRequestBytes: null, // what a single request body may carry (Cloudflare: 100 MB); null = unlimited
    chunkBytes: DEFAULT_CHUNK_BYTES,
    maxStoreBytes: null,
    maxFileBytes: undefined,
    graceMs: undefined, // how long an empty drop with files holds its quota before the first byte (store default: 15 min)
    trustProxy: false,
    log: () => {},
    ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
  };
  const keys = normalizeKeys(opts).map((k) => ({ ...k, hash: sha256(k.key) }));
  const relay = keys.length > 0;
  const corsOrigins = new Set(
    [...DEFAULT_CORS_ORIGINS, ...String(process.env.AIRFLASH_CORS_ORIGINS || '').split(','), ...opts.corsOrigins]
      .map((o) => String(o).trim().toLowerCase().replace(/\/+$/, ''))
      .filter(Boolean),
  );

  const nodeId = randomId(9);
  const dropsRoot = path.join(opts.dataDir, 'drops');
  removeStaleStores(dropsRoot);
  // Each node gets its own folder: the desktop app and a headless node on the same machine must not share one.
  const store = new DropStore({
    dir: path.join(dropsRoot, `${process.pid}-${nodeId}`),
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.maxFileBytes ? { maxFileBytes: opts.maxFileBytes } : {}),
    ...(opts.graceMs ? { graceMs: opts.graceMs } : {}),
    // A chunk is one request, so it can never be allowed to exceed what the proxy in front lets through.
    chunkBytes: opts.maxRequestBytes ? Math.min(opts.chunkBytes, opts.maxRequestBytes) : opts.chunkBytes,
    maxStoreBytes: opts.maxStoreBytes || null,
    codeLength: relay ? 8 : 6, // the internet gets to guess, the LAN doesn't
  });
  const registry = new DeviceRegistry();
  const serveStatic = createStatic(opts.webRoot);
  let port = opts.port;
  const discovery = opts.discovery ? new Discovery({ nodeId, name: opts.name, port: 0, version: VERSION }) : null;

  // ---------- helpers ----------

  function nodeInfo() {
    const info = { nodeId, name: opts.name, version: VERSION, port, ttlMs: store.opts.ttlMs };
    if (!relay) {
      // A relay's LAN addresses are nobody's business; its public hostname is what clients already have.
      info.urls = lanAddresses().map((a) => ({ url: `http://${a.address}:${port}`, iface: a.iface }));
      info.hostnameUrl = `http://${os.hostname().toLowerCase()}.local:${port}`;
    }
    info.relay = relay;
    info.limits = { maxRequestBytes: opts.maxRequestBytes || null, chunkBytes: store.opts.chunkBytes, ttlMs: store.opts.ttlMs };
    return info;
  }

  /** Local devices plus devices attached to peer nodes. */
  function allDevices() {
    const out = registry.list().map((d) => ({ ...d, node: nodeId, nodeName: opts.name, remote: false }));
    for (const peer of discovery?.list() || []) {
      for (const d of peer.devices) out.push({ ...d, node: peer.nodeId, nodeName: peer.name, remote: true });
    }
    return out;
  }

  let devicesTimer = null;
  function scheduleDevicesBroadcast() {
    clearTimeout(devicesTimer);
    devicesTimer = setTimeout(() => registry.broadcast('devices', allDevices()), 100);
  }
  registry.on('change', scheduleDevicesBroadcast);
  discovery?.on('change', scheduleDevicesBroadcast);
  discovery?.on('warn', (m) => opts.log(`[discovery] ${m}`));

  function notify(drop, event, data) {
    const recipients = new Set([drop.to, drop.from.id].filter(Boolean));
    for (const id of recipients) registry.send(id, event, data);
  }
  store.on('drop:new', (d) => notify(d, 'drop', publicDrop(d)));
  store.on('drop:update', (d) => notify(d, 'drop', publicDrop(d)));
  store.on('drop:progress', (d, f) => notify(d, 'progress', { id: d.id, fileId: f.id, received: f.received }));
  store.on('drop:gone', (d) => notify(d, 'gone', { id: d.id }));

  function isLoopback(req) {
    const a = req.socket.remoteAddress || '';
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  }

  /**
   * The address the request came from; behind Cloudflare/a proxy only when told to trust it, and
   * then only when the header holds an actual IP address (it is attacker-controlled text otherwise).
   */
  function clientIp(req) {
    if (opts.trustProxy) {
      const cf = String(req.headers['cf-connecting-ip'] || '').trim();
      if (net.isIP(cf)) return cf;
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (net.isIP(xff)) return xff;
    }
    return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  }

  // ---------- access key ----------

  const guardOpts = { max: GUARD_MAX, windowMs: GUARD_WINDOW_MS, banMs: GUARD_BAN_MS, maxEntries: GUARD_MAX_ENTRIES };
  const keyGuard = new FailureGuard(guardOpts);
  const linkGuard = new FailureGuard(guardOpts);
  const guardSweeper = setInterval(() => { keyGuard.sweep(); linkGuard.sweep(); }, GUARD_SWEEP_MS);
  guardSweeper.unref();

  /**
   * Access-key check for the routes that need one. Without configured keys every request passes
   * (LAN mode). Throws 401/429 as httpErrors so a route can simply call it first; returns the
   * matched key's {label} so per-person keys can be attributed later without touching the routes.
   * Both sides are hashed before timingSafeEqual so a length mismatch never short-circuits.
   */
  function authorize(req, url) {
    if (!relay) return { label: null };
    const ip = clientIp(req);
    const bucket = addressBucket(ip);
    const left = keyGuard.blockedFor(bucket);
    if (left) throw banned(left, 'Too many wrong access keys; try again later');
    const presented = req.headers['x-airflash-key'] ?? url.searchParams.get('key');
    if (presented == null || presented === '') throw httpError(401, 'Access key required');
    const hash = sha256(presented);
    let match = null;
    for (const k of keys) if (crypto.timingSafeEqual(hash, k.hash) && !match) match = k;
    if (match) return { label: match.label };
    const ban = keyGuard.fail(bucket);
    if (ban) {
      opts.log(`[auth] too many wrong access keys from ${ip}; blocked for ${ban / 60000} minutes`);
      throw banned(ban, 'Too many wrong access keys; try again later');
    }
    throw httpError(401, 'Wrong access key');
  }

  /** On a relay, unknown share codes count like wrong keys: an 8-char code is guessable at full speed, not at 20 per 10 minutes. */
  function guardLink(req, found) {
    if (!relay) return;
    const ip = clientIp(req);
    const bucket = addressBucket(ip);
    const left = linkGuard.blockedFor(bucket);
    if (left) throw banned(left, 'Too many unknown links; try again later');
    if (found) return;
    const ban = linkGuard.fail(bucket);
    if (ban) {
      opts.log(`[auth] too many unknown share links from ${ip}; blocked for ${ban / 60000} minutes`);
      throw banned(ban, 'Too many unknown links; try again later');
    }
  }

  function banned(remainingMs, message) {
    return Object.assign(httpError(429, message), { retryAfter: Math.ceil(remainingMs / 1000) });
  }

  /** The calling device, from its secret (header, or query for EventSource). */
  function authDevice(req, url, info) {
    const secret = req.headers['x-airflash-device'] || url.searchParams.get('device');
    return registry.touch(secret, info, { isLocal: isLoopback(req) });
  }

  /** Identity asserted by a peer node that forwarded this request. */
  function forwardedSender(req) {
    const raw = req.headers['x-airflash-from'];
    if (!raw) return null;
    try {
      const v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
      return { id: clampString(v.id, 64), name: clampString(v.name, 40), kind: clampString(v.kind, 16), node: clampString(v.node, 40) };
    } catch {
      return null;
    }
  }

  /** Reject DNS-rebinding style requests: only answer to IPs, localhost, *.local and configured names. */
  function hostAllowed(req) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) return false;
    if (net.isIP(host) || host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) return true;
    if (host === os.hostname().toLowerCase()) return true;
    return opts.allowedHosts.map((h) => h.toLowerCase()).includes(host);
  }

  /**
   * CORS for /api and /peer. Headers go on via setHeader so every later writeHead
   * (JSON, file streams, SSE, proxied replies) carries them. A disallowed Origin
   * gets none, which makes the browser block the response; we don't 403 it.
   */
  function applyCors(req, res) {
    res.setHeader('Vary', 'Origin');
    const origin = String(req.headers.origin || '');
    if (!origin || !corsOrigins.has(origin.toLowerCase())) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AirFlash-Device, X-AirFlash-Key, Range');
      res.setHeader('Access-Control-Max-Age', '86400');
    } else {
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition');
    }
  }

  // ---------- peer proxy ----------

  /** Forward a drop request to the peer node that owns the target device. */
  function proxyToPeer(req, res, url, peerId, rest) {
    const peer = discovery?.getPeer(peerId);
    if (!peer) return sendError(res, 404, 'That device is no longer on the network');
    const allowed =
      (req.method === 'POST' && rest === '/api/drops') ||
      (req.method === 'PUT' && /^\/api\/drops\/[\w-]+\/files\/[\w-]+(\/chunks\/\d+)?$/.test(rest)) ||
      (req.method === 'GET' && /^\/api\/drops\/[\w-]+\/files\/[\w-]+\/chunks$/.test(rest)) ||
      (req.method === 'POST' && /^\/api\/drops\/[\w-]+\/files\/[\w-]+\/complete$/.test(rest)) ||
      (req.method === 'DELETE' && /^\/api\/drops\/[\w-]+$/.test(rest));
    if (!allowed) return sendError(res, 404, 'Not found');

    let from = null;
    if (req.method === 'POST') {
      const me = authDevice(req, url);
      if (!me) return sendError(res, 401, 'Unknown device');
      from = { id: me.id, name: me.name, kind: me.kind, node: opts.name };
    }
    const headers = {};
    for (const h of ['content-type', 'content-length']) if (req.headers[h]) headers[h] = req.headers[h];
    if (from) headers['x-airflash-from'] = Buffer.from(JSON.stringify(from)).toString('base64url');

    const upstream = http.request(
      { host: peer.host, port: peer.port, method: req.method, path: rest + url.search, headers },
      (up) => {
        res.writeHead(up.statusCode, { 'Content-Type': up.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store' });
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) sendError(res, 502, `Couldn't reach ${peer.name}`);
      else res.destroy();
    });
    req.on('close', () => { if (!req.complete) upstream.destroy(); });
    req.pipe(upstream);
  }

  // ---------- routes ----------

  async function handleApi(req, res, url) {
    const p = url.pathname;
    const m = (re) => re.exec(p);
    let match;

    if (p === '/api/node' && req.method === 'GET') return sendJson(res, 200, nodeInfo());

    if (p === '/api/devices' && req.method === 'GET') {
      authorize(req, url);
      const local = url.searchParams.get('local') === '1';
      return sendJson(res, 200, { nodeId, devices: local ? registry.list() : allDevices() });
    }

    if (p === '/api/events' && req.method === 'GET') {
      authorize(req, url);
      const me = authDevice(req, url, { name: url.searchParams.get('name'), kind: url.searchParams.get('kind') });
      if (!me) return sendError(res, 401, 'Missing device secret');
      registry.attachStream(me, res);
      const hello = {
        node: nodeInfo(),
        me: registry.list().find((d) => d.id === me.id),
        devices: allDevices(),
        drops: store.listFor(me.id).map(publicDrop),
      };
      res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
      return;
    }

    if (p === '/api/me' && req.method === 'POST') {
      authorize(req, url);
      const body = await readJson(req);
      const me = authDevice(req, url, { name: body.name, kind: body.kind });
      if (!me) return sendError(res, 401, 'Missing device secret');
      return sendJson(res, 200, { me: registry.list().find((d) => d.id === me.id) });
    }

    if (p === '/api/drops' && req.method === 'GET') {
      authorize(req, url);
      const me = authDevice(req, url);
      if (!me) return sendError(res, 401, 'Missing device secret');
      return sendJson(res, 200, { drops: store.listFor(me.id).map(publicDrop) });
    }

    if (p === '/api/drops' && req.method === 'POST') {
      authorize(req, url);
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendError(res, 415, 'Expected JSON');
      const body = await readJson(req);
      let from = null;
      const me = authDevice(req, url);
      if (me) from = { id: me.id, name: me.name, kind: me.kind, node: null };
      else from = forwardedSender(req);
      if (!from) return sendError(res, 401, 'Unknown sender');
      if (body.to && !body.link && !registry.get(body.to)) return sendError(res, 404, 'That device is not known to this node');
      const drop = store.create({ from, to: body.to, link: !!body.link, text: body.text, files: body.files });
      return sendJson(res, 201, { drop: publicDrop(drop), uploadToken: drop.uploadToken });
    }

    // Chunked uploads (relay mode, bodies capped by the proxy). Token-only, like the whole-file PUT.
    if ((match = m(/^\/api\/drops\/([\w-]+)\/files\/([\w-]+)\/(chunks\/(\d+)|chunks|complete)$/))) {
      const drop = store.get(match[1]);
      if (!drop) return sendError(res, 404, 'This drop has expired');
      if (url.searchParams.get('token') !== drop.uploadToken) return sendError(res, 403, 'Bad upload token');
      if (match[4] != null && req.method === 'PUT') return sendJson(res, 200, await store.receiveChunk(drop, match[2], Number(match[4]), req));
      if (match[3] === 'chunks' && req.method === 'GET') return sendJson(res, 200, store.chunkStatus(drop, match[2]));
      if (match[3] === 'complete' && req.method === 'POST') {
        try {
          return sendJson(res, 200, { file: await store.completeFile(drop, match[2]) });
        } catch (err) {
          if (err.missing) return sendJson(res, err.status, { error: err.message, missing: err.missing });
          throw err;
        }
      }
    }

    if ((match = m(/^\/api\/drops\/([\w-]+)\/files\/([\w-]+)$/))) {
      const drop = store.get(match[1]);
      if (!drop) return sendError(res, 404, 'This drop has expired');
      if (req.method === 'PUT') {
        if (url.searchParams.get('token') !== drop.uploadToken) return sendError(res, 403, 'Bad upload token');
        const file = await store.receiveFile(drop, match[2], req);
        return sendJson(res, 200, { file });
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const file = drop.files.find((f) => f.id === match[2]);
        if (!file) return sendError(res, 404, 'No such file');
        if (file.status !== 'done') return sendError(res, 409, 'Still uploading');
        return serveFile(req, res, store.filePath(drop, file), file, { download: url.searchParams.get('download') === '1' });
      }
    }

    if ((match = m(/^\/api\/drops\/([\w-]+)$/))) {
      const drop = store.get(match[1]);
      if (!drop) return sendError(res, 404, 'This drop has expired');
      if (req.method === 'GET') return sendJson(res, 200, { drop: publicDrop(drop) });
      if (req.method === 'DELETE') {
        const me = authDevice(req, url);
        const ok = url.searchParams.get('token') === drop.uploadToken || (me && (me.id === drop.to || me.id === drop.from.id));
        if (!ok) return sendError(res, 403, 'Not your drop');
        await store.delete(drop.id);
        return sendJson(res, 200, { ok: true });
      }
    }

    if ((match = m(/^\/api\/link\/([A-Za-z0-9]{4,12})$/)) && req.method === 'GET') {
      const drop = store.getByCode(match[1]);
      guardLink(req, !!drop);
      if (!drop) return sendError(res, 404, 'This link has expired');
      return sendJson(res, 200, { drop: publicDrop(drop) });
    }

    if (p === '/api/qr.svg' && req.method === 'GET') {
      // Rendering is CPU the internet should not get for free; on a relay the UI only asks once it holds the key.
      authorize(req, url);
      const QRCode = require('qrcode');
      const data = clampString(url.searchParams.get('data'), 1000);
      const svg = await QRCode.toString(data || ' ', { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=300' });
      return res.end(svg);
    }

    return sendError(res, 404, 'Not found');
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return sendError(res, 400, 'Bad URL');
    }
    if (!hostAllowed(req)) return sendError(res, 421, 'Unknown host');
    try {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/peer/')) {
        applyCors(req, res);
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }
      }
      const peer = /^\/peer\/([\w-]+)(\/api\/.*)$/.exec(url.pathname);
      if (peer) {
        authorize(req, url);
        return proxyToPeer(req, res, url, peer[1], peer[2]);
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) opts.log(`[error] ${req.method} ${url.pathname}: ${err.stack || err}${err.cause ? `\n  caused by: ${err.cause.stack || err.cause}` : ''}`);
      if (err.retryAfter && !res.headersSent) res.setHeader('Retry-After', String(err.retryAfter));
      // 4xx messages are meant for people; a 5xx is masked unless it asked to be shown (a 507 "disk full"),
      // because fs errors name the node's data directory.
      const expose = err.expose ?? (err.status != null && err.status < 500);
      if (!res.headersSent) sendError(res, status, expose ? err.message : 'Something went wrong');
      else res.destroy();
    }
  });
  server.requestTimeout = 0; // big uploads on slow Wi-Fi can take a while
  server.headersTimeout = 30 * 1000;

  port = await listen(server, opts.host, opts.port, opts.strictPort);
  if (discovery) {
    discovery.self.port = port;
    discovery.start();
  }
  opts.log(`[airflash] node ${opts.name} listening on :${port}${relay ? ' (relay mode: access key required)' : ''}`);

  return {
    nodeId,
    get port() { return port; },
    relay,
    trustProxy: !!opts.trustProxy,
    info: nodeInfo,
    authorize,
    guards: { key: keyGuard, link: linkGuard },
    store,
    registry,
    discovery,
    async close() {
      clearTimeout(devicesTimer);
      clearInterval(guardSweeper);
      registry.close();
      await discovery?.stop();
      await new Promise((r) => {
        server.close(r);
        server.closeAllConnections(); // peers poll with keep-alive; don't wait for them to go idle
      });
      await store.close();
    },
  };
}

/** Delete drop folders left behind by nodes whose process is gone (crashes, force-quits). */
function removeStaleStores(root) {
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { return; }
  for (const name of entries) {
    const pid = Number(name.split('-')[0]);
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) continue;
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, just not ours to signal
  }
}

/** Listen on the preferred port, walking upward if it's taken. */
function listen(server, host, preferred, strict) {
  return new Promise((resolve, reject) => {
    let attempt = preferred;
    const tryListen = () => {
      server.once('error', onError);
      server.listen(attempt, host, () => {
        server.off('error', onError);
        resolve(server.address().port);
      });
    };
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && !strict && attempt !== 0 && attempt < preferred + 20) {
        attempt += 1;
        tryListen();
      } else reject(err);
    };
    tryListen();
  });
}

module.exports = { startNode, DEFAULT_PORT, VERSION };
