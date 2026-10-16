import { h, $, icon, timeAgo, countdown, copyText, isPreviewable, formatBytes } from './lib/dom.js';
import { connect, guessDevice, loadProfile, saveProfile, updateMe, sendDrop, retryFile, deleteDrop, fetchLink, fetchNode, fetchNodeAt, apiBase, qrUrl, normalizeServerUrl, getAccessKey, setAccessKey, checkAccessKeyAt, setNodeLimits, getNodeLimits, requestHeaders } from './lib/client.js';
import { renderCard, fillCard, updateCard, signature } from './lib/cards.js';

const desktop = window.airflashDesktop || null; // set by the Electron preload
const native = window.AirFlashNative || null; // set by native.js inside the iOS app
const LINK_TARGET = { id: '__link__', link: true, name: 'Link', kind: 'link' };

const state = {
  node: null,
  me: null,
  devices: [],
  drops: new Map(), // id -> drop, as the node reports it
  outbox: new Map(), // id -> local sending state (progress, File objects, previews)
  shared: null, // drop opened via /d/CODE
  linkOnly: false, // a /d/CODE visitor on a relay without a key: the stream stays paused, quietly (links need no key)
  connected: false,
  seen: new Set(),
  unread: 0,
  saving: new Map(), // fileId -> 0..1 while the iOS app copies a file into Photos
  saved: new Set(), // fileIds already in Photos
};

let profile = loadProfile();
let conn = null; // the live SSE connection; replaced when the iOS app switches nodes
let pendingShare = null; // share-sheet payload waiting for a node to be configured and its hello to arrive

// ---------------------------------------------------------------- boot

async function boot() {
  if (desktop) document.documentElement.classList.add('is-desktop', `platform-${desktop.platform}`);
  if (native) document.documentElement.classList.add('is-native', `platform-${native.platform}`);
  if (!profile) {
    const guess = guessDevice();
    profile = { name: guess.name, kind: guess.kind };
    if (desktop) {
      try { profile.name = (await fetchNode()).name || profile.name; } catch {}
    }
    saveProfile(profile);
  }
  $('#meName').textContent = profile.name;

  wireSheets();
  wireKeySheet();
  wireDragAndDrop();
  wirePaste();
  setInterval(tick, 1000);
  window.addEventListener('beforeunload', (e) => {
    if ([...state.outbox.values()].some((o) => o.status === 'sending')) e.preventDefault();
  });
  desktop?.onOpenConnect?.(openConnect);
  desktop?.onDownloadDone?.((info) => {
    if (info.state === 'completed') toast(`Saved ${info.name}`, { action: 'Show', onAction: () => desktop.showItemInFolder(info.path) });
    else toast(`Couldn't save ${info.name}`, { bad: true });
  });

  if (native) {
    await native.ready;
    wireNative();
    if (apiBase()) startConnection();
    else { showNoServer(); openServerSheet(); }
    return;
  }

  startConnection();
  const code = /^\/d\/([A-Za-z0-9]+)/.exec(location.pathname)?.[1];
  if (code) openShared(code);
  showInstallTip();
}

/** Open the live connection, replacing any previous one (the hello snapshot resets state). */
function startConnection() {
  conn?.close();
  state.me = null;
  state.devices = [];
  state.linkOnly = false;
  $('#offlineText').textContent = 'Reconnecting to AirFlash…';
  $('#offlineKeyBtn').hidden = true;
  conn = connect(() => profile, {
    open: () => setConnected(true),
    error: () => setConnected(false),
    hello: onHello,
    devices: (list) => { state.devices = list; renderDevices(); },
    drop: onDrop,
    progress: onProgress,
    gone: ({ id }) => removeDrop(id),
  });
}

function setConnected(on) {
  state.connected = on;
  $('#connDot').classList.toggle('on', on);
  // Don't flash the banner for brief blips.
  clearTimeout(setConnected.t);
  if (on) $('#offlineBanner').hidden = true;
  else setConnected.t = setTimeout(() => { $('#offlineBanner').hidden = state.connected || state.linkOnly; }, 2500);
}

/** Opened through a share link (/d/CODE)? Such a visitor is here for the link, which needs no key. */
function isSharedView() {
  return !!state.shared || /^\/d\/[A-Za-z0-9]+/.test(location.pathname);
}

function showNoServer() {
  $('#offlineText').textContent = 'Not connected to a computer yet.';
  $('#offlineBanner').hidden = false;
}

function onHello(hello) {
  state.node = hello.node;
  state.me = hello.me;
  state.devices = hello.devices;
  state.drops = new Map(hello.drops.map((d) => [d.id, d]));
  for (const d of hello.drops) state.seen.add(d.id);
  setNodeLimits(hello.node.limits); // decides whole-file vs chunked uploads from here on
  $('#offlineKeyBtn').hidden = true;
  $('#ttlLabel').textContent = Math.round(hello.node.ttlMs / 60000);
  if (hello.me?.name) $('#meName').textContent = hello.me.name;
  renderDevices();
  renderActivity();
  if (pendingShare) { const p = pendingShare; pendingShare = null; onShare(p); }
}

function onDrop(drop) {
  const isNew = !state.drops.has(drop.id) && !state.seen.has(drop.id);
  state.drops.set(drop.id, drop);
  state.seen.add(drop.id);
  if (isNew && drop.to === state.me?.id && drop.from.id !== state.me?.id) announce(drop);
  renderActivity();
}

function onProgress({ id, fileId, received }) {
  const f = state.drops.get(id)?.files.find((x) => x.id === fileId);
  if (!f) return;
  f.received = received;
  if (f.status === 'pending') f.status = 'uploading';
  scheduleActivity();
}

function removeDrop(id) {
  state.drops.delete(id);
  const o = state.outbox.get(id);
  if (o && o.status !== 'sending') {
    Object.values(o.srcs).forEach((u) => { if (u.startsWith('blob:')) URL.revokeObjectURL(u); });
    discardNativeFiles(o.files); // leftovers from files that never finished
    state.outbox.delete(id);
  }
  renderActivity();
}

/**
 * The picker and the share extension copy files for us; once a copy is not going to be sent
 * (sheet cancelled, send failed before the node knew about it, drop expired) it is just taking up
 * phone storage, so every path that drops the references deletes the files too.
 */
function discardNativeFiles(files) {
  for (const f of files || []) if (f.native) native?.deleteFile(f.path);
}

/** Notify about an incoming drop: toast, desktop notification, badge. */
function announce(drop) {
  const what = drop.files.length ? `${drop.files.length} item${drop.files.length > 1 ? 's' : ''}` : 'a note';
  const title = `${drop.from.name} sent you ${what}`;
  const body = drop.text ? drop.text.slice(0, 120) : drop.files.map((f) => f.name).slice(0, 3).join(', ');
  toast(title);
  if (document.visibilityState !== 'visible' || !document.hasFocus()) {
    state.unread++;
    updateBadge();
  }
  if (native) {
    native.notify({ id: hashId(drop.id), title, body }).catch(() => {});
  } else if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, { body, tag: drop.id });
      n.onclick = () => { desktop?.focus?.(); window.focus(); };
    } catch {}
  }
}

/** Local notifications want a numeric id; derive a stable one from the drop id. */
function hashId(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(n) || 1;
}

function updateBadge() {
  document.title = state.unread ? `(${state.unread}) AirFlash` : 'AirFlash';
  desktop?.setBadge?.(state.unread);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { state.unread = 0; updateBadge(); }
});
window.addEventListener('focus', () => { state.unread = 0; updateBadge(); });

// ---------------------------------------------------------------- native (iOS app)

function wireNative() {
  $('#offlineServerBtn').hidden = false;
  $('#offlineServerBtn').addEventListener('click', () => openServerSheet());
  $('#serverSettingsBtn').addEventListener('click', () => { $('#meSheet').close(); openServerSheet(); });
  $('#serverTestBtn').addEventListener('click', () => testServer());
  $('#serverForm').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'save') return;
    const url = normalizeServerUrl($('#serverInput').value);
    if (!url) {
      e.preventDefault(); // keep the sheet open
      serverStatus('Type an address like 192.0.2.15 or my-pc.local:4747', 'bad');
      return;
    }
    // The key lives in localStorage like in a browser; only the address is Preferences-backed (the share extension reads it).
    setAccessKey($('#serverKeyInput').value);
    await native.setServerUrl(url);
    // Limits belong to the node we are on: the ones Test found for this address, until its hello says otherwise.
    setNodeLimits(probedNode?.url === url ? probedNode.info.limits : null);
    startConnection(); // the hello that follows hands any pendingShare on
  });
  $('#serverSheet').addEventListener('close', () => {
    stopDiscovery?.();
    stopDiscovery = null;
    // Cancelled without choosing a computer: a share waiting for one can never be sent.
    if (pendingShare && !apiBase() && $('#serverSheet').returnValue !== 'save') {
      discardNativeFiles(pendingShare.files);
      pendingShare = null;
    }
  });

  // The phone drops the SSE stream when backgrounded anyway; close it cleanly and
  // reopen on return, which also fetches a fresh hello snapshot.
  native.onAppState((active) => {
    if (!active) conn?.close();
    else conn?.reopen();
  });
  native.onShare(onShare);
}

let stopDiscovery = null;
let foundNodes = new Map(); // url -> node
let probedNode = null; // { url, info } from the last successful Test; applied only when that address is saved

function openServerSheet() {
  const sheet = $('#serverSheet');
  if (sheet.open) return;
  sheet.returnValue = '';
  $('#serverInput').value = apiBase();
  $('#serverKeyInput').value = getAccessKey();
  $('#serverStatus').hidden = true;
  foundNodes = new Map();
  renderFoundNodes();
  sheet.showModal();
  // Bonjour is a convenience; a typed address is the primary path, so a denied local-network prompt isn't fatal.
  native.discover((node) => {
    if (!node?.url || foundNodes.has(node.url)) return;
    foundNodes.set(node.url, node);
    renderFoundNodes();
  }).then((stop) => {
    if (sheet.open) stopDiscovery = stop;
    else stop();
  }).catch(() => {});
}

function renderFoundNodes() {
  const root = $('#serverFound');
  root.replaceChildren();
  for (const node of foundNodes.values()) {
    root.append(h('button.target', { type: 'button', html: icon('desktop'), onclick: () => { $('#serverInput').value = node.url; testServer(); } },
      h('span', null, node.name || node.host), h('span.sub', null, `${node.host}:${node.port}`)));
  }
  $('#serverFoundField').hidden = !foundNodes.size;
}

function serverStatus(text, cls = '') {
  const el = $('#serverStatus');
  el.hidden = false;
  el.className = `small ${cls}`;
  el.textContent = text;
}

async function testServer() {
  const url = normalizeServerUrl($('#serverInput').value);
  if (!url) { serverStatus('Type an address like 192.0.2.15 or my-pc.local:4747', 'bad'); return null; }
  $('#serverInput').value = url;
  serverStatus(`Checking ${url}…`, 'muted');
  let info;
  try {
    info = await fetchNodeAt(url);
  } catch {
    serverStatus(`Couldn't reach ${url}. Is AirFlash running there, and is this phone on the same Wi-Fi?`, 'bad');
    return null;
  }
  probedNode = { url, info }; // the live session keeps its own node's limits until this address is saved
  if (!info.relay) { serverStatus(`Found ${info.name}`, 'good'); return url; }
  // A relay wants a key: say now whether the one typed opens it, not after Save.
  let verdict;
  try { verdict = await checkAccessKeyAt(url, $('#serverKeyInput').value, info); } catch (err) { serverStatus(err.message, 'bad'); return null; }
  if (verdict === 'ok') { serverStatus(`Found ${info.name}. The access key works.`, 'good'); return url; }
  serverStatus(verdict === 'locked' ? KEY_MESSAGES.locked : `Found ${info.name}. ${verdict === 'wrong' ? 'That access key was not accepted.' : KEY_MESSAGES.missing}`, 'bad');
  return null;
}

/** Share sheet → AirFlash: the person still has to pick who gets it. */
function onShare(payload) {
  if (!apiBase()) { holdShare(payload); openServerSheet(); return; }
  // Before the hello there is nobody to pick from (cold start: the share is drained before the
  // connection even opens), so wait; onHello() calls back here.
  if (!state.me) { holdShare(payload); return; }
  const files = [];
  let unreadable = 0;
  for (const f of payload.files || []) {
    // A drop declares each file's size up front and the node refuses a mismatch, so a file we can't size can't be sent.
    if (!Number.isFinite(f.size)) { unreadable++; native.deleteFile(f.path); continue; }
    files.push({ native: true, path: f.path, name: f.name, size: f.size, type: f.mimeType || 'application/octet-stream' });
  }
  const text = (payload.texts || []).filter((t) => t && t.trim()).join('\n') || null;
  if (unreadable) toast(`Couldn't read ${unreadable} shared file${unreadable > 1 ? 's' : ''}`, { bad: true });
  if (!files.length && !text) return;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  openSendSheet({ files, text });
}

/** Park a share; a newer one replaces (and cleans up after) an older one that was never offered. */
function holdShare(payload) {
  if (pendingShare && pendingShare !== payload) discardNativeFiles(pendingShare.files);
  pendingShare = payload;
}

async function pickNativeMedia() {
  let items;
  try { items = await native.pickMedia(); } catch (err) { toast(err.message || 'Couldn’t open the photo picker', { bad: true }); return []; }
  return (items || []).map((f) => ({ native: true, path: f.path, name: f.name, size: f.size, type: f.mimeType || 'application/octet-stream' }));
}

/** Download a received photo/video and add it to the Photos library. */
async function saveToPhotos(vm, f) {
  if (state.saving.has(f.id) || state.saved.has(f.id)) return;
  state.saving.set(f.id, 0);
  renderActivity();
  try {
    const { path } = await native.download(
      { url: f.url, name: f.name, headers: requestHeaders() }, // device secret, plus the access key when one is set
      (percent) => { state.saving.set(f.id, percent / 100); scheduleActivity(); },
    );
    try {
      await native.saveToPhotos({ path, mimeType: f.type });
    } finally {
      await native.deleteFile(path);
    }
    state.saved.add(f.id);
    toast(`Saved ${f.name} to Photos`, { good: true });
  } catch (err) {
    toast(err.message || `Couldn't save ${f.name}`, { bad: true });
  } finally {
    state.saving.delete(f.id);
    renderActivity();
  }
}

// ---------------------------------------------------------------- devices

function others() {
  return state.devices
    .filter((d) => d.id !== state.me?.id)
    .sort((a, b) => (b.online - a.online) || (b.host - a.host) || (b.lastSeen - a.lastSeen));
}

let devicesKey = '';
function renderDevices({ force = false } = {}) {
  const list = others();
  // Skip identical re-renders so a drag-hover or tap in progress isn't interrupted.
  const key = JSON.stringify(list);
  const changed = key !== devicesKey;
  if (!force && !changed) return;
  devicesKey = key;
  // A send sheet waiting for a target (e.g. a share that arrived before the hello) follows the list.
  if (changed && $('#sendSheet').open && sheetPayload && !sheetTarget) fillTargetPicker();
  const root = $('#devices');
  root.replaceChildren();
  for (const d of list) root.append(deviceBubble(d));
  root.append(deviceBubble(LINK_TARGET));
  if (!list.length) {
    root.prepend(h('div.nearby-empty', null,
      h('span', null, 'No other devices yet. Open AirFlash on your phone to see it here.'),
      h('button.btn.small.primary', { type: 'button', onclick: openConnect }, 'Connect phone')));
  }
  $('#nearbyHint').textContent = matchMedia('(hover: hover)').matches
    ? 'Click a device to send, or drag files onto it.'
    : 'Tap a device to send.';
}

function deviceBubble(d) {
  const isLink = !!d.link;
  const sub = isLink ? 'Anyone nearby' : d.online ? (d.remote && !d.host ? `via ${d.nodeName}` : 'Available') : `Away · ${timeAgo(d.lastSeen)}`;
  const el = h('button', {
    type: 'button',
    class: `device ${isLink ? 'link' : d.online ? 'online' : 'offline'}`,
    title: isLink ? 'Make a link anyone on this network can open' : `Send to ${d.name}`,
    onclick: () => openSendSheet({ target: d }),
  },
  h('div.avatar', { html: icon(isLink ? 'link' : d.kind) }),
  h('div.name', null, isLink ? 'Share link' : d.name),
  h('div.sub', null, sub));

  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-hover'); });
  el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-hover');
    document.body.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files || [])];
    const text = files.length ? null : e.dataTransfer?.getData('text/plain');
    if (files.length || text) send(d, { files, text });
  });
  return el;
}

// ---------------------------------------------------------------- sending

/** Instant local thumbnail: a blob URL for a File, the WebView-readable file URL for a native entry. */
function previewSrc(f) {
  if (!isPreviewable(f.type)) return null;
  if (f.native) return window.Capacitor?.convertFileSrc?.(f.path) || null;
  return URL.createObjectURL(f);
}

async function send(target, { files = [], text = null }) {
  if (!files.length && !text?.trim()) return;
  // The iOS background uploader sends whole files, and a relay caps one request (docs/relay-mode.md):
  // refuse before the node even hears about the drop. The native chunked uploader is a later milestone.
  const max = getNodeLimits()?.maxRequestBytes;
  const tooBig = max ? files.find((f) => f.native && f.size > max) : null;
  if (tooBig) {
    toast(`Too big for this relay from the app for now (max ${formatBytes(max)}); send it from a computer, or use the LAN node`, { bad: true, ms: 7000 });
    discardNativeFiles(files);
    return;
  }
  let entry = null;
  if (!desktop && !native && /iPhone|iPad|Android/.test(navigator.userAgent) && files.length) {
    toast('Keep AirFlash open until sending finishes');
  }
  try {
    await sendDrop({ target, files, text }, {
      onCreated(drop, token, base) {
        entry = {
          id: drop.id,
          drop,
          target,
          base,
          token,
          files,
          status: 'sending',
          sent: {},
          fileStatus: Object.fromEntries(drop.files.map((f) => [f.id, 'pending'])),
          // Local previews: instant thumbnails, and the only way to see what you sent to another node.
          srcs: Object.fromEntries(drop.files.map((f, i) => [f.id, previewSrc(files[i])]).filter(([, v]) => v)),
        };
        state.outbox.set(drop.id, entry);
        renderActivity();
      },
      onFileStart(fid) { entry.fileStatus[fid] = 'uploading'; scheduleActivity(); },
      onProgress(fid, sent) { entry.sent[fid] = sent; scheduleActivity(); },
      onFileDone(fid) { entry.fileStatus[fid] = 'done'; extendLocalExpiry(entry); renderActivity(); },
    });
    entry.status = 'done';
    renderActivity();
    if (!target.link) toast(`Sent to ${target.name}`, { good: true });
  } catch (err) {
    if (entry) {
      entry.status = 'failed';
      entry.error = err.message;
      for (const [fid, s] of Object.entries(entry.fileStatus)) if (s !== 'done') entry.fileStatus[fid] = 'failed';
      renderActivity();
    } else {
      discardNativeFiles(files); // no outbox entry means no Retry, so nothing will ever use them
    }
    toast(err.message || 'Sending failed', { bad: true });
  }
}

/** Mirror the node's rule: the countdown restarts when a file finishes uploading. */
function extendLocalExpiry(o) {
  o.drop.expiresAt = Math.max(o.drop.expiresAt, Date.now() + (state.node?.ttlMs || 15 * 60 * 1000));
}

async function retry(vm) {
  const o = state.outbox.get(vm.id);
  if (!o) return;
  o.status = 'sending';
  o.error = null;
  try {
    for (let i = 0; i < o.drop.files.length; i++) {
      const fid = o.drop.files[i].id;
      if (o.fileStatus[fid] === 'done') continue;
      o.fileStatus[fid] = 'uploading';
      renderActivity();
      await retryFile(o.base, o.id, fid, o.token, o.files[i], (sent) => { o.sent[fid] = sent; scheduleActivity(); });
      o.fileStatus[fid] = 'done';
      extendLocalExpiry(o);
    }
    o.status = 'done';
    toast('Sent', { good: true });
  } catch (err) {
    o.status = 'failed';
    o.error = err.message;
    for (const [fid, s] of Object.entries(o.fileStatus)) if (s !== 'done') o.fileStatus[fid] = 'failed';
    toast(err.message, { bad: true });
  }
  renderActivity();
}

// ---------------------------------------------------------------- activity

/** Merge what the node says with what we know locally into one view model. */
function viewModel(id) {
  const d = state.drops.get(id);
  const o = state.outbox.get(id);
  const drop = d || o?.drop;
  const dir = o || drop.from.id === state.me?.id ? 'out' : 'in';
  const base = o?.base ?? apiBase();
  const files = drop.files.map((f) => {
    const live = d?.files.find((x) => x.id === f.id) || f;
    let status = live.status;
    let received = live.received || 0;
    if (o) {
      const local = o.fileStatus[f.id];
      if (!d || local === 'failed') status = local;
      if (local === 'done') status = 'done';
      received = Math.max(received, o.sent[f.id] || 0);
    }
    const url = `${base}/api/drops/${id}/files/${f.id}`;
    return {
      ...f,
      status,
      progress: status === 'done' ? 1 : f.size ? Math.min(1, received / f.size) : 0,
      url,
      downloadUrl: `${url}?download=1`,
      src: o?.srcs[f.id] || null,
      saving: state.saving.get(f.id) ?? null,
      saved: state.saved.has(f.id),
    };
  });
  const target = o?.target;
  const toDevice = state.devices.find((x) => x.id === drop.to);
  return {
    id,
    dir,
    code: drop.code,
    text: drop.text,
    createdAt: drop.createdAt,
    expiresAt: d?.expiresAt || o?.drop.expiresAt || drop.expiresAt,
    fromName: drop.from.name,
    toName: target?.name || toDevice?.name || 'device',
    files,
    failed: files.some((f) => f.status === 'failed') || o?.status === 'failed',
    error: o?.error,
    canRetry: !!o,
    base,
    token: o?.token,
  };
}

let activityQueued = false;
function scheduleActivity() {
  if (activityQueued) return;
  activityQueued = true;
  requestAnimationFrame(() => { activityQueued = false; renderActivity(); });
}

const cardActions = {
  native: !!native,
  remove: async (vm) => {
    if (vm.shared) { state.shared = null; renderShared(); return; }
    try { await deleteDrop(vm.base, vm.id, vm.token); } catch {}
    const o = state.outbox.get(vm.id);
    if (o) o.status = 'done';
    removeDrop(vm.id);
  },
  copy: async (text) => toast((await copyText(text)) ? 'Copied' : 'Couldn’t copy. Long-press the text to copy it.', { good: true }),
  view: (vm, f) => openViewer(vm, f),
  save: (e, vm, f) => {
    // Browsers: the default <a download> behaviour handles it. The app hands non-media files to Safari.
    if (native) { e.preventDefault(); native.openExternal(f.downloadUrl); }
  },
  saveAll: (vm) => saveAll(vm),
  retry,
  linkUrl: (vm) => `${shareOrigin()}/d/${vm.code}`,
  showLinkQr: (vm) => openQr({ title: 'Share link', url: `${shareOrigin()}/d/${vm.code}`, lead: 'Scan to open on any phone on this network.', foot: '' }),
};

function renderActivity() {
  const ids = new Set([...state.drops.keys(), ...state.outbox.keys()]);
  const vms = [...ids].map(viewModel).filter((vm) => vm.expiresAt > Date.now()).sort((a, b) => b.createdAt - a.createdAt);
  const root = $('#cards');
  const existing = new Map([...root.children].map((el) => [el.dataset.id, el]));
  let prev = null;
  for (const vm of vms) {
    let el = existing.get(vm.id);
    if (!el) el = renderCard(vm, cardActions);
    else if (el.dataset.sig !== signature(vm)) fillCard(el, vm, cardActions);
    else updateCard(el, vm);
    existing.delete(vm.id);
    const want = prev ? prev.nextSibling : root.firstChild;
    if (el !== want) root.insertBefore(el, want);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
  $('#emptyActivity').hidden = vms.length > 0;
}

function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-expires]')) {
    const exp = Number(el.dataset.expires);
    el.lastElementChild.textContent = countdown(exp);
    el.classList.toggle('soon', exp - now < 60_000);
  }
  for (const el of document.querySelectorAll('[data-ago]')) el.textContent = timeAgo(Number(el.dataset.ago));
  // Expired locally? Drop it now instead of waiting for the node's sweep.
  const expired = new Set();
  for (const [id, d] of state.drops) if (d.expiresAt <= now) expired.add(id);
  for (const [id, o] of state.outbox) if (!state.drops.has(id) && o.drop.expiresAt <= now && o.status !== 'sending') expired.add(id);
  for (const id of expired) removeDrop(id); // also frees previews and native copies
  // Refresh "Away · 3m ago" labels, but only if someone is away and nothing is being dragged.
  if (now % 30000 < 1000 && !document.body.classList.contains('dragging') && others().some((d) => !d.online)) {
    renderDevices({ force: true });
  }
}

async function saveAll(vm) {
  if (native) {
    for (const f of vm.files) if (isPreviewable(f.type) && f.status === 'done') await saveToPhotos(vm, f);
    return;
  }
  for (const f of vm.files) {
    const a = h('a', { href: f.downloadUrl, download: f.name });
    document.body.append(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 450));
  }
}

// ---------------------------------------------------------------- shared link (/d/CODE)

async function openShared(code) {
  try {
    const { drop } = await fetchLink(code);
    state.shared = drop;
    renderShared();
    if (!drop.files.every((f) => f.status === 'done')) setTimeout(() => openShared(code), 1500);
  } catch (err) {
    state.shared = null;
    $('#sharedPanel').hidden = false;
    $('#sharedCards').replaceChildren(h('div.empty', null, h('p', null, err.message), h('p.muted.small', null, 'Links only last 15 minutes.')));
  }
}

function renderShared() {
  const panel = $('#sharedPanel');
  if (!state.shared) { panel.hidden = true; return; }
  panel.hidden = false;
  const d = state.shared;
  const base = apiBase();
  const vm = {
    id: d.id, dir: 'in', shared: true, code: null, text: d.text, createdAt: d.createdAt, expiresAt: d.expiresAt,
    fromName: d.from.name, files: d.files.map((f) => {
      const url = `${base}/api/drops/${d.id}/files/${f.id}`;
      return { ...f, progress: f.size ? f.received / f.size : 0, url, downloadUrl: `${url}?download=1`, src: null };
    }),
    failed: false, base,
  };
  $('#sharedCards').replaceChildren(renderCard(vm, cardActions));
}

// ---------------------------------------------------------------- sheets

let sheetTarget = null;
let sheetPayload = null;

function openSendSheet({ target = null, files = null, text = null }) {
  const sheet = $('#sendSheet');
  const hasPayload = (files && files.length) || text;
  if (target && hasPayload) return send(target, { files: files || [], text });

  sheetTarget = target;
  if (sheetPayload) discardNativeFiles(sheetPayload.files); // replaced before anyone picked a target
  sheetPayload = hasPayload ? { files: files || [], text } : null;

  $('#sendTitle').textContent = target ? (target.link ? 'Share by link' : `Send to ${target.name}`) : 'Send to…';
  $('#sendChoices').hidden = !target || !!hasPayload;
  $('#textCompose').hidden = true;
  $('#sendFoot').hidden = true;
  $('#textInput').value = '';

  const pending = $('#pendingBox');
  pending.hidden = !hasPayload;
  pending.replaceChildren();
  if (hasPayload) {
    for (const f of sheetPayload.files) pending.append(h('div.file-row', null, h('div.fname', null, h('div', null, f.name), h('div.fsize', null, formatBytes(f.size)))));
    if (text) pending.append(h('div.text-snippet', null, text.slice(0, 400)));
  }

  $('#targetPicker').hidden = !!target;
  if (!target) fillTargetPicker();

  if (target && !target.link && !target.online) {
    pending.hidden = false;
    pending.append(h('div.small.muted', null, `${target.name} is away. They'll get it if they open AirFlash within ${Math.round((state.node?.ttlMs || 900000) / 60000)} minutes.`));
  }
  if (sheet.open) sheet.close();
  sheet.showModal();
}

/** "Send to…" choices for the payload held in the sheet. Taking one hands the payload to send(). */
function fillTargetPicker() {
  const sheet = $('#sendSheet');
  const picker = $('#targetPicker');
  picker.replaceChildren();
  for (const d of [...others(), LINK_TARGET]) {
    picker.append(h('button.target', {
      type: 'button',
      html: icon(d.link ? 'link' : d.kind),
      onclick: () => { const payload = sheetPayload; sheetPayload = null; sheet.close(); send(d, payload); },
    }, d.link ? 'Share link' : d.name));
  }
}

function wireSheets() {
  const sheet = $('#sendSheet');
  const fileInput = $('#fileInput');
  // Closed with a payload nobody took (Cancel, tap outside, Escape): the copies are never sent.
  // The event is queued, so by now a re-open has already put the sheet back up; leave that one alone.
  sheet.addEventListener('close', () => {
    if (sheet.open || !sheetPayload) return;
    discardNativeFiles(sheetPayload.files);
    sheetPayload = null;
  });
  $('#pickFilesBtn').addEventListener('click', async () => {
    if (!native) return fileInput.click();
    // PHPicker hands back the originals (HEIC/HEVC untouched), which Safari's file input won't.
    const target = sheetTarget;
    const files = await pickNativeMedia();
    if (!files.length) return;
    if (!target) { discardNativeFiles(files); return; }
    sheet.close();
    send(target, { files });
  });
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (!files.length || !sheetTarget) return;
    sheet.close();
    send(sheetTarget, { files });
  });
  $('#writeTextBtn').addEventListener('click', () => {
    $('#sendChoices').hidden = true;
    $('#textCompose').hidden = false;
    $('#sendFoot').hidden = false;
    $('#textInput').focus();
  });
  $('#sendBtn').addEventListener('click', () => {
    const text = $('#textInput').value;
    if (!text.trim() || !sheetTarget) return;
    sheet.close();
    send(sheetTarget, { text });
  });
  $('#textInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#sendBtn').click();
  });

  for (const d of document.querySelectorAll('dialog.sheet')) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // tap outside closes
  }
  // Close controls are plain buttons, not submit buttons: a form's default button is its first submit
  // button in tree order, so Enter in a sheet's text field must reach Save, never a Cancel.
  for (const b of document.querySelectorAll('dialog button[data-close]')) {
    b.addEventListener('click', () => b.closest('dialog').close('cancel'));
  }

  $('#connectBtn').addEventListener('click', openConnect);
  $('#qrCopy').addEventListener('click', async () => toast((await copyText($('#qrUrl').textContent)) ? 'Copied' : 'Couldn’t copy'));
  $('#qrAddr').addEventListener('change', (e) => setQr(e.target.value));

  $('#meChip').addEventListener('click', () => {
    $('#meNameInput').value = profile.name;
    $('#meKindInput').value = profile.kind;
    $('#desktopSettings').hidden = !desktop;
    $('#nativeSettings').hidden = !native;
    if (native) $('#serverCurrent').textContent = apiBase() || 'No computer chosen';
    // Browsers: the key row appears once the node is known to be a relay (or a key is already stored).
    // The iOS app edits the key on its Server screen instead.
    $('#keySettings').hidden = native || !(state.node?.relay || state.linkOnly || getAccessKey());
    $('#keyCurrent').textContent = getAccessKey() ? 'Set' : 'Not set';
    $('#meSheet').showModal();
  });
  $('#keySettingsBtn').addEventListener('click', () => { $('#meSheet').close(); openKeySheet({ reason: 'settings' }); });
  $('#meForm').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'save') return;
    profile = { name: $('#meNameInput').value.trim() || profile.name, kind: $('#meKindInput').value };
    saveProfile(profile);
    $('#meName').textContent = profile.name;
    try { await updateMe(profile); } catch (err) { toast(err.message, { bad: true }); }
  });
  $('#openDownloadsBtn').addEventListener('click', () => desktop?.openDownloads?.());

  $('#viewerClose').addEventListener('click', () => $('#viewer').close());
  $('#viewer').addEventListener('close', () => $('#viewerStage').replaceChildren());
  $('#viewer').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') stepViewer(1);
    if (e.key === 'ArrowLeft') stepViewer(-1);
  });
  $('#viewerDownload').addEventListener('click', (e) => {
    if (!native || !viewerCtx) return;
    e.preventDefault();
    const { vm, media, index } = viewerCtx;
    saveToPhotos(vm, media[index]);
    $('#viewer').close();
  });
  $('#installTipClose').addEventListener('click', () => {
    $('#installTip').hidden = true;
    try { localStorage.setItem('airflash.tipDone', '1'); } catch {}
  });
}

/** The origin other devices should use (never "localhost"). */
function shareOrigin() {
  if (native) return apiBase() || location.origin;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  return local && state.node?.urls?.[0] ? state.node.urls[0].url : location.origin;
}

function openConnect() {
  if (state.node?.relay) {
    // A relay hides its LAN URLs; the public address is the one that reaches it.
    return openQr({
      title: 'Connect a device',
      url: location.origin,
      lead: 'Scan this with your phone’s camera. It works from anywhere.',
      foot: 'The phone will ask for this node’s access key.',
    });
  }
  const urls = state.node?.urls || [];
  const select = $('#qrAddr');
  select.replaceChildren(...urls.map((u) => h('option', { value: u.url }, `${u.url}  (${u.iface})`)));
  $('#qrAddrField').hidden = urls.length < 2;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  openQr({
    title: 'Connect a device',
    url: local ? urls[0]?.url || location.origin : location.origin,
    lead: 'Scan this with your phone’s camera. It has to be on the same Wi-Fi as this computer.',
    foot: !urls.length
      ? 'No network connection found. Connect this computer to Wi-Fi or Ethernet.'
      : desktop?.platform === 'windows'
        ? 'Phone can’t connect? Allow AirFlash through Windows Firewall on Private networks, and make sure your Wi-Fi is set to Private (not Public).'
        : 'On iPhone, tap Share → Add to Home Screen once it opens, so it’s one tap next time.',
    keepSelect: true,
  });
}

function openQr({ title, url, lead, foot, keepSelect = false }) {
  if (!keepSelect) $('#qrAddrField').hidden = true;
  $('#qrTitle').textContent = title;
  $('#qrLead').textContent = lead;
  $('#qrFoot').textContent = foot;
  setQr(url);
  if (!$('#qrSheet').open) $('#qrSheet').showModal();
}

function setQr(url) {
  $('#qrUrl').textContent = url;
  $('#qrImg').src = qrUrl(url);
}

// ---------------------------------------------------------------- access key (relay nodes)

const KEY_MESSAGES = {
  missing: 'This node asks for an access key. Get it from whoever runs it.',
  wrong: 'That access key was not accepted. Check it with whoever runs this node.',
  locked: 'Too many wrong keys, wait 10 minutes',
  settings: 'Only relay nodes ask for one. Leave it empty on your own network.',
};

/**
 * Entry points: client.js fires `airflash:needkey` after a 401/429 (any request, or the event
 * stream's probe), the "Enter key…" link in the offline banner, and the device sheet's Access key row.
 */
function wireKeySheet() {
  const sheet = $('#keySheet');
  window.addEventListener('airflash:needkey', (e) => {
    const reason = e.detail?.reason || 'missing';
    // Someone opening a share link on a relay has no key and needs none: leave the stream paused and say
    // nothing. The device sheet's Access key row is still there for a person who does have one.
    if (e.detail?.source === 'stream' && reason === 'missing' && isSharedView() && !getAccessKey()) {
      state.linkOnly = true;
      $('#offlineBanner').hidden = true;
      return;
    }
    $('#offlineText').textContent = reason === 'locked' ? KEY_MESSAGES.locked : 'This node asks for an access key.';
    $('#offlineBanner').hidden = false;
    $('#offlineKeyBtn').hidden = false;
    // The iOS server picker has its own key field; don't stack a second sheet on top of it.
    if ($('#serverSheet').open) return;
    openKeySheet({ reason });
  });
  $('#offlineKeyBtn').addEventListener('click', () => openKeySheet({ reason: getAccessKey() ? 'wrong' : 'missing' }));
  $('#keyForm').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    setAccessKey($('#keyInput').value);
    startConnection(); // a fresh stream with the new key; the hello that follows clears the banner
  });
  sheet.addEventListener('close', () => { $('#keyInput').value = ''; });
}

function openKeySheet({ reason = 'missing' } = {}) {
  const sheet = $('#keySheet');
  if (sheet.open) { keyStatus(reason); return; }
  sheet.returnValue = '';
  $('#keyInput').value = getAccessKey();
  $('#keyLead').textContent = reason === 'settings' ? KEY_MESSAGES.settings : KEY_MESSAGES.missing;
  $('#keyStatus').hidden = true;
  keyStatus(reason);
  sheet.showModal();
  $('#keyInput').focus();
}

function keyStatus(reason) {
  const el = $('#keyStatus');
  if (reason !== 'wrong' && reason !== 'locked') { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'small bad';
  el.textContent = KEY_MESSAGES[reason];
}

// ---------------------------------------------------------------- viewer

let viewerCtx = null;

function openViewer(vm, f) {
  const media = vm.files.filter((x) => isPreviewable(x.type) && (x.status === 'done' || x.src));
  viewerCtx = { vm, media, index: Math.max(0, media.findIndex((x) => x.id === f.id)) };
  showViewerItem();
  $('#viewer').showModal();
}

function stepViewer(delta) {
  if (!viewerCtx) return;
  const n = viewerCtx.media.length;
  viewerCtx.index = (viewerCtx.index + delta + n) % n;
  showViewerItem();
}

function showViewerItem() {
  const { vm, media, index } = viewerCtx;
  const f = media[index];
  const isVideo = /^video\//.test(f.type);
  const src = f.src || f.url;
  $('#viewerName').textContent = `${f.name}${media.length > 1 ? `  ·  ${index + 1}/${media.length}` : ''}`;
  const dl = $('#viewerDownload');
  dl.href = f.src || f.downloadUrl;
  dl.download = f.name;
  if (native) {
    dl.textContent = f.saved ? 'Saved' : 'Save to Photos';
    dl.hidden = vm.dir !== 'in' || f.status !== 'done';
  } else {
    dl.hidden = vm.dir !== 'in' && !f.src;
  }
  const el = isVideo
    ? h('video', { src, controls: true, playsInline: true, autoplay: true })
    : h('img', { src, alt: f.name });
  $('#viewerStage').replaceChildren(el);
  const ios = /iPhone|iPad/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  $('#viewerHint').textContent = native
    ? vm.dir === 'in' && !f.saved ? 'Tap Save to Photos to keep it.' : ''
    : ios
      ? isVideo ? 'Tap Download, then open it from Downloads in the Files app → Share → Save Video.' : 'Press and hold the photo, then tap “Save to Photos”.'
      : media.length > 1 ? 'Use ← → to browse.' : '';
}

// ---------------------------------------------------------------- drag, drop, paste

function wireDragAndDrop() {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) openSendSheet({ files });
  });
}

function wirePaste() {
  document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea, [contenteditable]')) return;
    const files = [...(e.clipboardData?.files || [])];
    const text = e.clipboardData?.getData('text/plain');
    if (files.length) openSendSheet({ files: files.map(namePasted) });
    else if (text?.trim()) openSendSheet({ text });
  });
}

/** Pasted screenshots arrive as "image.png"; give them a useful name. */
function namePasted(f) {
  if (f.name && f.name !== 'image.png') return f;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return new File([f], `Pasted ${stamp}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type });
}

// ---------------------------------------------------------------- misc

function toast(message, { bad = false, good = false, action = null, onAction = null, ms = 3200 } = {}) {
  const el = h('div', { class: `toast${bad ? ' bad' : ''}` },
    good ? h('span.status.good', { html: icon('check') }) : null,
    h('span.grow', null, message),
    action ? h('button.link-btn', { type: 'button', onclick: () => { onAction?.(); el.remove(); } }, action) : null);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), action ? ms * 2 : ms);
}

function showInstallTip() {
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  let done = false;
  try { done = localStorage.getItem('airflash.tipDone') === '1'; } catch {}
  if (ios && !navigator.standalone && !done) $('#installTip').hidden = false;
}

boot();
