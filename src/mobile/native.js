// The native layer of the iOS app. Bundled by scripts/build-mobile.js into www/native.js and loaded
// before app.js, so window.AirFlashNative exists only inside the Capacitor shell. The shape of the
// object is the NATIVE CONTRACT shared with the web app; keep it in sync with app.js.

import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileTransfer } from '@capacitor/file-transfer';
import { LocalNotifications } from '@capacitor/local-notifications';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import { Uploader } from '@capgo/capacitor-uploader';
import { CapacitorShareTarget } from '@capgo/capacitor-share-target';
import { Media } from '@capacitor-community/media';
import { Bonjour } from 'airflash-bonjour';

const SERVER_URL_KEY = 'serverUrl';
const SHARE_INBOX_KEY = 'shareInboxDir'; // the App Group Inbox/ the extension copies into, once seen
const SERVICE_TYPE = '_airflash._tcp';
const DOWNLOAD_DIR = 'airflash-inbox'; // inside Directory.Cache
const STALE_MS = 60 * 60 * 1000;
// A shared file must be the extension's own copy: <App Group container>/Inbox/<uuid>_<name>.
const SHARE_FILE_RE = /^(file:\/\/)?(\/[^?#]*\/Shared\/AppGroup\/[^/]+\/Inbox)\/[^/?#]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- helpers

// Capacitor rejects with plain objects ({ message, code }) or strings; callers want a real Error.
function toError(err, context) {
  if (err instanceof Error) {
    if (context && !err.message.startsWith(context)) err.message = `${context}: ${err.message}`;
    return err;
  }
  const message = (err && typeof err === 'object' && err.message) ? String(err.message) : String(err ?? 'unknown error');
  const out = new Error(context ? `${context}: ${message}` : message);
  if (err && typeof err === 'object' && err.code) out.code = err.code;
  return out;
}

function wrap(context, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw toError(err, context);
    }
  };
}

function normalizeOrigin(url) {
  if (url == null) return null;
  const s = String(url).trim().replace(/\/+$/, '');
  return s ? s : null;
}

// Plugins that take a URL string (Media, FileTransfer) need file:// URLs, not bare POSIX paths.
function toFileUrl(path) {
  const s = String(path);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return 'file://' + encodeURI(s);
}

function safeName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(-200) || 'file';
}

function isIPv4(s) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}

function hostForUrl(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

// ---------------------------------------------------------------- settings

let serverUrl = null;
let shareInboxDir = null;

const ready = (async () => {
  try {
    const { value } = await Preferences.get({ key: SERVER_URL_KEY });
    serverUrl = normalizeOrigin(value);
    shareInboxDir = (await Preferences.get({ key: SHARE_INBOX_KEY })).value || null;
  } catch (err) {
    console.warn('AirFlashNative: could not load settings', toError(err));
  }
})();

function rememberShareInbox(dir) {
  if (!dir || dir === shareInboxDir) return;
  shareInboxDir = dir;
  Preferences.set({ key: SHARE_INBOX_KEY, value: dir }).catch(() => {});
}

function getServerUrl() {
  return serverUrl;
}

const setServerUrl = wrap('setServerUrl', async (url) => {
  const next = normalizeOrigin(url);
  if (next) await Preferences.set({ key: SERVER_URL_KEY, value: next });
  else await Preferences.remove({ key: SERVER_URL_KEY });
  serverUrl = next;
});

// ---------------------------------------------------------------- discovery

const discover = wrap('discover', async (onFound) => {
  const handle = await Bonjour.addListener('serviceFound', (svc) => {
    const addresses = Array.isArray(svc.addresses) ? svc.addresses.filter((a) => typeof a === 'string' && a) : [];
    const host = addresses.find(isIPv4) || svc.host || addresses[0];
    const port = Number(svc.port);
    if (!host || !port) return;
    onFound({ name: svc.name || host, host, port, url: `http://${hostForUrl(host)}:${port}` });
  });
  try {
    await Bonjour.start({ type: SERVICE_TYPE });
  } catch (err) {
    await handle.remove().catch(() => {});
    throw err;
  }
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    await handle.remove().catch(() => {});
    await Bonjour.stop().catch(() => {});
  };
});

// ---------------------------------------------------------------- files

const pickMedia = wrap('pickMedia', async () => {
  let result;
  try {
    result = await FilePicker.pickMedia({ limit: 0, skipTranscoding: true, readData: false });
  } catch (err) {
    // The picker rejects with "pickFiles canceled." when the user dismisses it; that is not an error.
    if (/cancel/i.test(toError(err).message)) return [];
    throw err;
  }
  const out = [];
  for (const f of result.files || []) {
    if (!f.path) continue;
    let size = Number(f.size);
    if (!Number.isFinite(size) || size <= 0) {
      const st = await Filesystem.stat({ path: f.path });
      size = Number(st.size) || 0;
    }
    out.push({ path: f.path, name: f.name, size, mimeType: f.mimeType || 'application/octet-stream' });
  }
  return out;
});

// One 'events' listener serves every upload; tasks are matched by the id startUpload returns.
// Events for an id can arrive before startUpload() resolves, so unknown ids are parked briefly.
const uploads = new Map(); // id -> { resolve, reject, onProgress }
const earlyEvents = new Map(); // id -> UploadEvent[]
let uploaderListener = null;

function handleUploadEvent(ev) {
  const task = uploads.get(ev.id);
  if (!task) {
    if (!earlyEvents.has(ev.id)) {
      earlyEvents.set(ev.id, []);
      setTimeout(() => earlyEvents.delete(ev.id), 30_000);
    }
    earlyEvents.get(ev.id).push(ev);
    return;
  }
  const payload = ev.payload || {};
  if (ev.name === 'uploading') {
    const pct = Number(payload.percent);
    if (task.onProgress && Number.isFinite(pct) && pct >= 0) task.onProgress(Math.min(100, pct));
    return;
  }
  if (ev.name !== 'completed' && ev.name !== 'failed') return;
  uploads.delete(ev.id);
  if (ev.eventId) Uploader.acknowledgeEvent({ eventId: ev.eventId }).catch(() => {});
  const status = Number(payload.statusCode);
  // 'completed' only means the transport finished; the plugin reports 4xx/5xx as completed too.
  if (ev.name === 'completed' && (!Number.isFinite(status) || (status >= 200 && status < 300))) {
    if (task.onProgress) task.onProgress(100);
    task.resolve();
  } else {
    const why = payload.error ? String(payload.error) : (Number.isFinite(status) ? `server answered HTTP ${status}` : 'upload failed');
    task.reject(new Error(`upload: ${why}`));
  }
}

async function ensureUploaderListener() {
  if (!uploaderListener) uploaderListener = Uploader.addListener('events', handleUploadEvent);
  await uploaderListener;
}

// opts.headers is forwarded verbatim: the web app puts X-AirFlash-Device there and, on a relay,
// X-AirFlash-Key (uploads are token-only on the node, so the key is optional; downloads likewise).
// Whole files only: on a relay, app.js refuses files above the node's maxRequestBytes before
// calling this (the native chunked uploader is a later milestone, see docs/relay-mode.md).
const upload = wrap('upload', async (opts, onProgress) => {
  if (!opts || !opts.path || !opts.url) throw new Error('path and url are required');
  await ensureUploaderListener();
  const { id } = await Uploader.startUpload({
    filePath: opts.path,
    serverUrl: opts.url,
    method: 'PUT',
    uploadType: 'binary',
    mimeType: opts.mimeType || 'application/octet-stream',
    headers: opts.headers || {},
    maxRetries: 3,
  });
  return new Promise((resolve, reject) => {
    uploads.set(id, { resolve, reject, onProgress });
    const parked = earlyEvents.get(id);
    if (parked) {
      earlyEvents.delete(id);
      for (const ev of parked) handleUploadEvent(ev);
    }
  });
});

const download = wrap('download', async (opts, onProgress) => {
  if (!opts || !opts.url) throw new Error('url is required');
  const rel = `${DOWNLOAD_DIR}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safeName(opts.name)}`;
  await Filesystem.mkdir({ path: DOWNLOAD_DIR, directory: Directory.Cache, recursive: true }).catch(() => {}); // exists → fine
  const { uri } = await Filesystem.getUri({ path: rel, directory: Directory.Cache });

  let progressHandle = null;
  if (onProgress) {
    progressHandle = await FileTransfer.addListener('progress', (p) => {
      if (p.type !== 'download' || p.url !== opts.url) return;
      if (p.lengthComputable && p.contentLength > 0) onProgress(Math.min(100, (p.bytes / p.contentLength) * 100));
    });
  }
  try {
    const res = await FileTransfer.downloadFile({ url: opts.url, path: uri, headers: opts.headers || {}, progress: !!onProgress });
    if (onProgress) onProgress(100);
    return { path: res.path || uri };
  } finally {
    if (progressHandle) await progressHandle.remove().catch(() => {});
  }
});

const saveToPhotos = wrap('saveToPhotos', async (opts) => {
  if (!opts || !opts.path) throw new Error('path is required');
  const mime = String(opts.mimeType || '');
  const path = toFileUrl(opts.path);
  if (mime.startsWith('image/')) await Media.savePhoto({ path });
  else if (mime.startsWith('video/')) await Media.saveVideo({ path });
  else throw new Error(`not a photo or video (${mime || 'unknown type'})`);
});

async function deleteFile(path) {
  if (!path) return;
  try {
    await Filesystem.deleteFile({ path: String(path) });
  } catch (err) {
    console.warn('AirFlashNative: deleteFile', toError(err).message);
  }
}

// Copies the web app should have deleted but could not (killed mid-send, crashed with the send
// sheet open): our download folder, the picker's UUID folders in Caches and the extension's
// Inbox/. Anything younger than an hour may still be feeding a background upload, so it stays.
async function sweepLeftovers() {
  const cutoff = Date.now() - STALE_MS;
  const stale = (f) => f.type === 'file' && Number(f.mtime) < cutoff;
  const list = (opts) => Filesystem.readdir(opts).then((r) => r.files || []).catch(() => []);

  for (const f of await list({ path: DOWNLOAD_DIR, directory: Directory.Cache })) {
    if (stale(f)) await deleteFile(f.uri || (await Filesystem.getUri({ path: `${DOWNLOAD_DIR}/${f.name}`, directory: Directory.Cache })).uri);
  }
  for (const f of await list({ path: '', directory: Directory.Cache })) {
    if (f.type !== 'directory' || !UUID_RE.test(f.name) || Number(f.mtime) >= cutoff) continue;
    await Filesystem.rmdir({ path: f.name, directory: Directory.Cache, recursive: true }).catch(() => {});
  }
  if (shareInboxDir) {
    for (const f of await list({ path: shareInboxDir })) {
      if (stale(f)) await deleteFile(f.uri || `${shareInboxDir}/${encodeURIComponent(f.name)}`);
    }
  }
}

ready.then(() => sweepLeftovers()).catch((err) => console.warn('AirFlashNative: sweep', toError(err).message));

// ---------------------------------------------------------------- notifications

const notify = wrap('notify', async (opts) => {
  let { display } = await LocalNotifications.checkPermissions();
  if (display === 'prompt' || display === 'prompt-with-rationale') ({ display } = await LocalNotifications.requestPermissions());
  if (display !== 'granted') throw new Error('notification permission denied');
  await LocalNotifications.schedule({
    notifications: [{
      id: Math.trunc(Number(opts.id)) || Math.floor(Math.random() * 2_000_000_000),
      title: String(opts.title || 'AirFlash'),
      body: String(opts.body || ''),
      foreground: true,
      schedule: { at: new Date(Date.now() + 1000) },
    }],
  });
});

// ---------------------------------------------------------------- share sheet handoff

// The share-target plugin retains a cold-start event until a JS listener exists, so we subscribe
// at module load and park payloads until app.js calls onShare().
const shareCallbacks = [];
const pendingShares = [];

function deliverShare(payload) {
  if (!payload.texts.length && !payload.files.length) return;
  if (!shareCallbacks.length) { pendingShares.push(payload); return; }
  for (const cb of shareCallbacks) {
    try { cb(payload); } catch (err) { console.error('AirFlashNative: onShare callback', err); }
  }
}

// The node refuses a file whose size was not declared, so a payload without one is stat'ed here
// rather than dropped by the web app. Only the extension's own copies are accepted: whatever
// else names a path would get it uploaded and then deleted.
async function fromShareEvent(ev) {
  const texts = (Array.isArray(ev?.texts) ? ev.texts : []).map((t) => String(t ?? '')).filter(Boolean);
  const files = [];
  for (const f of Array.isArray(ev?.files) ? ev.files : []) {
    const path = f?.uri || f?.path;
    const m = SHARE_FILE_RE.exec(String(path || ''));
    if (!m) { if (path) console.warn('AirFlashNative: ignoring shared file outside the Inbox'); continue; }
    rememberShareInbox((m[1] || '') + m[2]);
    const file = { path, name: safeName(f.name || path.split('/').pop()), mimeType: f.mimeType || 'application/octet-stream' };
    let size = Number(f.size);
    if (!Number.isFinite(size) || size <= 0) {
      try { size = Number((await Filesystem.stat({ path })).size); } catch { size = NaN; }
    }
    if (Number.isFinite(size) && size > 0) file.size = size;
    files.push(file);
  }
  return { texts, files };
}

// The airflash://share URL the extension opens is only a wake-up call: the plugin re-reads the App
// Group on every open-URL and didBecomeActive (cold start included), and the App Group is the one
// channel other apps cannot write to. Query parameters on the URL are deliberately not a second one.
CapacitorShareTarget.addListener('shareReceived', (ev) => {
  fromShareEvent(ev).then(deliverShare).catch((err) => console.error('AirFlashNative: shareReceived', toError(err)));
}).catch((err) => console.warn('AirFlashNative: share-target listener', toError(err).message));

function onShare(cb) {
  if (typeof cb !== 'function') return;
  shareCallbacks.push(cb);
  while (pendingShares.length) deliverShare(pendingShares.shift());
}

// ---------------------------------------------------------------- app state / external

function onAppState(cb) {
  if (typeof cb !== 'function') return;
  App.addListener('appStateChange', ({ isActive }) => cb(!!isActive))
    .catch((err) => console.warn('AirFlashNative: appStateChange listener', toError(err).message));
}

// Capacitor's WKUIDelegate hands any new-window request to UIApplication.open, i.e. Safari.
// @capacitor/browser is not installed, so this is the whole implementation.
function openExternal(url) {
  if (!url) return;
  window.open(String(url), '_blank');
}

// ---------------------------------------------------------------- export

window.AirFlashNative = Object.freeze({
  platform: 'ios',
  ready,
  getServerUrl,
  setServerUrl,
  discover,
  pickMedia,
  upload,
  download,
  saveToPhotos,
  deleteFile,
  notify,
  onShare,
  onAppState,
  openExternal,
});
