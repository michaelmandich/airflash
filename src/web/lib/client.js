// Talks to the AirFlash node: identity, live events, creating drops and uploading.

import { uploadChunked as uploadChunkedWith } from './chunks.js';

const SECRET_KEY = 'airflash.secret';
const PROFILE_KEY = 'airflash.profile';
const ACCESS_KEY = 'airflash.key';
const DEFAULT_PORT = 4747;
const DEFAULT_CHUNK_BYTES = 32 * 1024 * 1024;
const NEEDKEY_DEBOUNCE_MS = 3000;
const PROBE_TIMEOUT_MS = 2500;
const LOCKED_MESSAGE = 'Too many wrong keys, wait 10 minutes';

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
  return value;
}

// ---------------------------------------------------------------- access key (relay nodes)

/** The relay's access key, '' when none is set. LAN nodes never ask for one, so nothing is sent then. */
export function getAccessKey() {
  return store(ACCESS_KEY) || '';
}

export function setAccessKey(key) {
  const k = String(key || '').trim();
  store(ACCESS_KEY, k || null);
  needKeyAt = 0; // a new key means a new verdict: the next refusal must be shown, not swallowed as a repeat
  return k;
}

/** Header to add to requests; empty when no key is configured so LAN traffic stays exactly as it was. */
function keyHeaders() {
  const key = getAccessKey();
  return key ? { 'X-AirFlash-Key': key } : {};
}

/**
 * The key is for our node only. Relative URLs and URLs under apiBase() are ours; anything else
 * (the server picker probing a Bonjour-found or typed address) gets no key, since a stored relay
 * key must never travel in cleartext to whatever host someone tapped.
 */
function isOurNode(url) {
  if (!/^https?:\/\//i.test(url)) return true;
  const base = apiBase();
  return !!base && (url === base || url.startsWith(`${base}/`));
}

let needKeyAt = 0;
/**
 * Tell the UI the node wants an access key (reason: 'missing' | 'wrong' | 'locked').
 * Debounced for ordinary requests (a burst of failing requests must produce one prompt, not one
 * per request); not for the event stream's probe, which fires once per stream and is the verdict
 * on a key that was just saved.
 */
function needKey(reason, source = 'request') {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (source !== 'stream' && now - needKeyAt < NEEDKEY_DEBOUNCE_MS) return;
  needKeyAt = now;
  window.dispatchEvent(new CustomEvent('airflash:needkey', { detail: { reason, source, hasKey: !!getAccessKey() } }));
}

/** Map a response status to a key problem, or null when it is not one. */
function keyProblem(status) {
  if (status === 401) return getAccessKey() ? 'wrong' : 'missing';
  if (status === 429) return 'locked';
  return null;
}

// ---------------------------------------------------------------- node limits (chunked uploads)

let nodeLimits = null; // { maxRequestBytes: number|null, chunkBytes: number, ttlMs } from GET /api/node or the hello snapshot

/** Remember the node's request limits; app.js calls this from the hello snapshot and the server-picker test. */
export function setNodeLimits(limits) {
  if (!limits || typeof limits !== 'object') { nodeLimits = null; return; }
  const max = Number(limits.maxRequestBytes);
  const chunk = Number(limits.chunkBytes);
  nodeLimits = {
    maxRequestBytes: Number.isFinite(max) && max > 0 ? max : null,
    chunkBytes: Number.isFinite(chunk) && chunk > 0 ? Math.floor(chunk) : DEFAULT_CHUNK_BYTES,
  };
}

export function getNodeLimits() {
  return nodeLimits;
}

/** True when a file of this size must go up in chunks (the node caps a single request). */
export function needsChunks(size) {
  return !!(nodeLimits?.maxRequestBytes && size > nodeLimits.maxRequestBytes);
}

/**
 * Where the node lives. '' in a browser or Electron (the node served this page,
 * so URLs stay root-relative); inside the iOS app it is the configured node
 * origin, e.g. 'http://192.0.2.15:4747', because the UI is bundled with the app.
 */
export function apiBase() {
  const native = typeof window !== 'undefined' ? window.AirFlashNative : null;
  return native ? native.getServerUrl() || '' : '';
}

const absolute = (url) => (/^https?:\/\//i.test(url) ? url : apiBase() + url);

/**
 * URL for a QR image of `data`. An <img> cannot send a header, so on a relay the key rides in the
 * query (like the event stream); on a LAN node no key is stored and the URL is what it always was.
 */
export function qrUrl(data) {
  const q = new URLSearchParams({ data });
  const key = getAccessKey();
  if (key) q.set('key', key);
  return `${apiBase()}/api/qr.svg?${q}`;
}

/**
 * Turn what a person typed ('192.0.2.15', 'my-pc.local:4747', 'https://relay.example.com')
 * into an origin. Plain http without a port gets AirFlash's default port.
 */
export function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname) return null;
  if (!u.port && u.protocol === 'http:') u.port = String(DEFAULT_PORT);
  return u.origin;
}

/** This device's private secret. Generated once, never shown to other devices. */
export function deviceSecret() {
  let s = store(SECRET_KEY);
  if (!s || s.length < 16) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    s = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
    store(SECRET_KEY, s);
  }
  return s;
}

export function guessDevice() {
  const ua = navigator.userAgent;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/iPhone|iPod/.test(ua)) return { kind: 'phone', name: 'iPhone', platform: 'ios' };
  if (/iPad/.test(ua) || touchMac) return { kind: 'tablet', name: 'iPad', platform: 'ios' };
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? { kind: 'phone', name: 'Android phone', platform: 'android' } : { kind: 'tablet', name: 'Android tablet', platform: 'android' };
  if (/Macintosh/.test(ua)) return { kind: 'laptop', name: 'Mac', platform: 'mac' };
  if (/Windows/.test(ua)) return { kind: 'desktop', name: 'Windows PC', platform: 'windows' };
  if (/CrOS/.test(ua)) return { kind: 'laptop', name: 'Chromebook', platform: 'chromeos' };
  return { kind: 'desktop', name: 'Browser', platform: 'other' };
}

export function loadProfile() {
  try { return JSON.parse(store(PROFILE_KEY) || 'null'); } catch { return null; }
}

export function saveProfile(p) {
  store(PROFILE_KEY, JSON.stringify(p));
}

/**
 * Live connection to the node over Server-Sent Events.
 * EventSource reconnects by itself; after every (re)connect the node sends a
 * fresh `hello` snapshot, so the UI never has to diff missed events.
 * close() stops it; reopen() starts it again (the iOS app does this around backgrounding).
 */
export function connect(getProfile, handlers) {
  const secret = deviceSecret();
  let es = null;
  let closed = false;
  // Set once the node has refused our key: reconnecting would only feed the brute-force guard
  // (20 failures → locked out), so we wait for a new key (app.js starts a fresh connection then).
  let paused = false;
  let probing = null;
  let lanNode = false; // the last hello said relay: false, so a dead stream is never a key problem
  const open = () => {
    // A stale retry timer must not start a second stream next to a live one.
    if (closed || paused || (es && es.readyState !== EventSource.CLOSED)) return;
    const profile = getProfile(); // read fresh each time so a rename survives reconnects
    const q = new URLSearchParams({ device: secret, name: profile.name, kind: profile.kind });
    const key = getAccessKey();
    if (key) q.set('key', key);
    es = new EventSource(absolute(`/api/events?${q}`)); // the secret (and key) ride in the query: EventSource can't set headers
    for (const [event, fn] of Object.entries(handlers)) {
      if (event === 'open' || event === 'error') continue;
      es.addEventListener(event, (e) => {
        const data = JSON.parse(e.data);
        if (event === 'hello') lanNode = data?.node?.relay === false;
        fn(data);
      });
    }
    es.onopen = () => handlers.open?.();
    es.onerror = () => {
      handlers.error?.();
      // Safari sometimes gives up permanently (readyState CLOSED); restart it. A non-200 answer
      // (401/429 from a relay) also closes the stream for good, and EventSource hides the status,
      // so ask the node directly before deciding whether to retry. A LAN node never refuses, so its
      // reconnects stay what they always were: a plain retry in 2 s, no extra requests.
      if (es.readyState === EventSource.CLOSED && !closed) {
        if (lanNode && !key) { setTimeout(open, 2000); return; }
        probing ??= probeAccess().finally(() => { probing = null; });
        probing.then((problem) => {
          if (closed) return;
          if (problem) { paused = true; needKey(problem, 'stream'); return; }
          setTimeout(open, 2000);
        });
      }
    };
  };
  open();
  // iOS kills background connections; reconnect right away when we come back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !closed && es.readyState === EventSource.CLOSED) open();
  });
  return {
    close() { closed = true; es?.close(); },
    reopen() { if (!closed) return; closed = false; open(); },
  };
}

/**
 * Why did the event stream die? GET /api/node never needs a key; if that says the node is a relay
 * and GET /api/devices answers 401/429, the key is the problem. Anything else (node down, network
 * blip, a LAN node) returns null and the normal reconnect goes on. Short timeouts: this sits in
 * front of every retry while the node is unreachable.
 */
async function probeAccess() {
  try {
    const node = await fetch(absolute('/api/node'), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!node.ok) return null;
    const info = await node.json().catch(() => null);
    if (!info?.relay) return null;
    const res = await fetch(absolute('/api/devices'), { headers: { 'X-AirFlash-Device': deviceSecret(), ...keyHeaders() }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return keyProblem(res.status);
  } catch {
    return null;
  }
}

/**
 * Does this key open that node? For the server picker: 'ok', 'missing', 'wrong', 'locked', or
 * 'open' when the node is not a relay and never asks. Talks to the node directly (no needkey event).
 */
export async function checkAccessKeyAt(origin, key, info = null) {
  const node = info || (await fetchNodeAt(origin));
  if (!node.relay) return 'open';
  const k = String(key || '').trim();
  const res = await fetch(`${origin}/api/devices`, {
    headers: { 'X-AirFlash-Device': deviceSecret(), ...(k ? { 'X-AirFlash-Key': k } : {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (res.ok) return 'ok';
  if (res.status === 401) return k ? 'wrong' : 'missing';
  if (res.status === 429) return 'locked';
  const data = await res.json().catch(() => ({}));
  throw new Error(data.error || `Request failed (${res.status})`);
}

async function api(method, url, body, { signal, keyless = false } = {}) {
  const res = await fetch(absolute(url), {
    method,
    headers: { 'X-AirFlash-Device': deviceSecret(), ...(isOurNode(url) ? keyHeaders() : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A route that never wants a key (share links) can still answer 429; that is no reason to ask for one.
    const problem = keyless ? null : keyProblem(res.status);
    if (problem) needKey(problem);
    // `.status` lets callers tell a refusal from a lost connection (the chunk uploader retries only the latter).
    throw Object.assign(new Error(problem === 'locked' ? LOCKED_MESSAGE : data.error || `Request failed (${res.status})`), { status: res.status });
  }
  return data;
}

export const updateMe = (profile) => api('POST', '/api/me', profile);
export const deleteDrop = (base, id, token) => api('DELETE', `${base}/api/drops/${id}${token ? `?token=${token}` : ''}`);
export const fetchLink = (code) => api('GET', `/api/link/${encodeURIComponent(code)}`, null, { keyless: true });
export const fetchNode = () => api('GET', '/api/node');
/**
 * Probe a node at another origin (the iOS app's server picker). A bare fetch: GET /api/node needs
 * neither the device secret nor the key, and the origin is whatever was typed or found by Bonjour,
 * so nothing stored may ride along. Unreachable LAN IPs hang, hence the timeout.
 */
export async function fetchNodeAt(origin) {
  const res = await fetch(`${origin}/api/node`, { signal: AbortSignal.timeout(8000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

/** Base URL prefix for talking to a device's node (remote nodes are reached through ours). */
export function baseFor(target) {
  return apiBase() + (target && target.remote ? `/peer/${encodeURIComponent(target.node)}` : '');
}

/**
 * Create a drop and upload its files one by one.
 * Files are File objects, or native entries {native: true, path, name, size, type} from the iOS app.
 * onProgress(fileId, sentBytes) fires during uploads.
 */
export async function sendDrop({ target, files = [], text = null }, { onCreated, onFileStart, onProgress, onFileDone }) {
  const base = baseFor(target);
  const { drop, uploadToken } = await api('POST', `${base}/api/drops`, {
    to: target.link ? null : target.id,
    link: !!target.link,
    text,
    files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
  });
  onCreated?.(drop, uploadToken, base);
  for (let i = 0; i < files.length; i++) {
    const entry = drop.files[i];
    onFileStart?.(entry.id);
    await uploadFile(`${base}/api/drops/${drop.id}/files/${entry.id}`, uploadToken, files[i], (sent) => onProgress?.(entry.id, sent));
    onFileDone?.(entry.id);
  }
  return { drop, uploadToken, base };
}

export function retryFile(base, dropId, fileId, token, file, onProgress) {
  return uploadFile(`${base}/api/drops/${dropId}/files/${fileId}`, token, file, onProgress);
}

/**
 * fileUrl is `.../api/drops/:id/files/:fid` without the token. Whole-file PUT unless the node
 * caps request size below the file (a relay behind Cloudflare), then chunks. Native entries always
 * go whole: the iOS background uploader can't slice yet, and app.js refuses oversized ones up front.
 */
function uploadFile(fileUrl, token, file, onProgress) {
  if (file.native) return uploadNative(`${fileUrl}?token=${token}`, file, onProgress);
  if (needsChunks(file.size)) return uploadChunked(fileUrl, token, file, onProgress);
  return uploadXhr(`${fileUrl}?token=${token}`, file, onProgress);
}

/** XHR rather than fetch: fetch can't report upload progress. The File streams from disk. */
function uploadXhr(url, body, onProgress, type = body.type) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', absolute(url));
    xhr.setRequestHeader('Content-Type', type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let msg = `Upload failed (${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        reject(Object.assign(new Error(msg), { status: xhr.status }));
      }
    };
    xhr.onerror = () => reject(Object.assign(new Error('Connection lost during upload'), { network: true }));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.send(body);
  });
}

/**
 * Chunked upload (docs/relay-mode.md), see lib/chunks.js. The transport is XHR for the chunk PUTs
 * (fetch cannot report upload progress) and api() for the JSON calls, so the device header, the
 * access key and the 401/429 handling are the same as for every other request.
 */
function uploadChunked(fileUrl, token, file, onProgress) {
  return uploadChunkedWith({
    fileUrl,
    token,
    file,
    chunkBytes: nodeLimits?.chunkBytes || DEFAULT_CHUNK_BYTES,
    onProgress,
    transport: {
      get: (url) => api('GET', url),
      post: (url) => api('POST', url),
      put: (url, body, onLoaded) => uploadXhr(url, body, onLoaded, 'application/octet-stream'),
    },
  });
}

/** iOS: a background URLSession PUTs the file from disk, so the upload survives the phone locking. */
async function uploadNative(url, file, onProgress) {
  const native = window.AirFlashNative;
  await native.upload(
    // Uploads are token-only on the node; the key rides along for consistency with every other call.
    { path: file.path, url: absolute(url), mimeType: file.type || 'application/octet-stream', headers: { 'X-AirFlash-Device': deviceSecret(), ...keyHeaders() } },
    (percent) => onProgress?.(Math.round((percent / 100) * file.size)),
  );
  // The node has the bytes now; the picker's (or share extension's) copy is only taking up space.
  await native.deleteFile(file.path);
}

/** Headers for native downloads of a drop's files (app.js hands these to native.download). */
export function requestHeaders() {
  return { 'X-AirFlash-Device': deviceSecret(), ...keyHeaders() };
}
