// Activity cards: one per drop, incoming or outgoing.
import { h, icon, formatBytes, timeAgo, countdown, extOf, linkify, isPreviewable } from './dom.js';
import { qrUrl } from './client.js';

/** A short summary like "3 photos · 1 video · 24 MB". */
function summarize(vm) {
  const count = (re) => vm.files.filter((f) => re.test(f.type)).length;
  const photos = count(/^image\//);
  const videos = count(/^video\//);
  const others = vm.files.length - photos - videos;
  const parts = [];
  if (photos) parts.push(`${photos} photo${photos > 1 ? 's' : ''}`);
  if (videos) parts.push(`${videos} video${videos > 1 ? 's' : ''}`);
  if (others) parts.push(`${others} file${others > 1 ? 's' : ''}`);
  if (vm.text) parts.push('text');
  const bytes = vm.files.reduce((n, f) => n + f.size, 0);
  if (bytes) parts.push(formatBytes(bytes));
  return parts.join(' · ');
}

/** Changes in this string mean the card's structure must be rebuilt. */
export function signature(vm) {
  return JSON.stringify([vm.files.map((f) => [f.status, !!f.src, f.saving != null, !!f.saved]), vm.failed, vm.code, vm.text?.length, vm.dir]);
}

export function renderCard(vm, actions) {
  const el = h('article.card', { dataset: { id: vm.id } });
  fillCard(el, vm, actions);
  return el;
}

export function fillCard(el, vm, actions) {
  el.dataset.sig = signature(vm);
  el.replaceChildren();

  const who = vm.dir === 'in' ? `From ${vm.fromName}` : vm.code ? 'Shared by link' : `To ${vm.toName}`;
  const head = h('div.card-head', null,
    h('div', { class: `mini-avatar ${vm.dir}`, html: icon(vm.code ? 'link' : vm.dir === 'in' ? 'down' : 'up') }),
    h('div.card-title', null,
      h('div', null, h('b', null, who)),
      h('div.meta', null, `${summarize(vm)} · `, h('span', { dataset: { ago: vm.createdAt } }, timeAgo(vm.createdAt))),
    ),
    h('span.timer', { dataset: { expires: vm.expiresAt }, title: 'Deleted automatically when this hits zero', html: icon('clock') },
      h('span', null, countdown(vm.expiresAt))),
    h('button.icon-btn', { type: 'button', title: 'Delete now', 'aria-label': 'Delete now', html: icon('close'), onclick: () => actions.remove(vm) }),
  );

  const body = h('div.card-body');
  const media = vm.files.filter((f) => isPreviewable(f.type));
  const others = vm.files.filter((f) => !isPreviewable(f.type));

  if (vm.code) body.append(linkBox(vm, actions));

  if (media.length) {
    body.append(h('div.thumbs', null, media.map((f) => thumb(vm, f, actions))));
  }
  for (const f of others) body.append(fileRow(vm, f, actions));

  if (vm.text) {
    body.append(h('div.text-snippet', null, linkify(vm.text)));
  }

  const buttons = [];
  if (vm.text) buttons.push(h('button.btn.small', { type: 'button', html: icon('copy'), onclick: () => actions.copy(vm.text) }, 'Copy text'));
  const mediaDone = media.length > 0 && media.every((f) => f.status === 'done');
  if (actions.native && vm.dir === 'in' && mediaDone) {
    // The iOS app saves straight into the Photos library instead of downloading.
    const busy = media.some((f) => f.saving != null);
    buttons.push(h('button.btn.small.primary', { type: 'button', html: icon('down'), disabled: busy, onclick: () => actions.saveAll(vm) },
      media.length > 1 ? 'Save all to Photos' : 'Save to Photos'));
  } else if (!actions.native && vm.dir === 'in' && vm.files.length > 1 && vm.files.every((f) => f.status === 'done')) {
    buttons.push(h('button.btn.small.primary', { type: 'button', html: icon('down'), onclick: () => actions.saveAll(vm) }, 'Save all'));
  }
  if (vm.failed && vm.dir === 'out' && vm.canRetry) {
    buttons.push(h('button.btn.small', { type: 'button', html: icon('retry'), onclick: () => actions.retry(vm) }, 'Retry'));
  }
  if (vm.failed) body.append(h('div.status.bad', null, vm.error || 'Some files didn’t make it.'));
  if (buttons.length) body.append(h('div.card-actions', null, buttons));

  el.append(head, body);
  updateCard(el, vm);
}

/** Cheap in-place refresh for progress + timers. */
export function updateCard(el, vm) {
  for (const f of vm.files) {
    const bar = el.querySelector(`[data-progress="${f.id}"]`);
    if (bar) bar.style.width = `${Math.round(f.progress * 100)}%`;
    const pct = el.querySelector(`[data-pct="${f.id}"]`);
    if (pct) pct.textContent = `${Math.round(f.progress * 100)}%`;
    const save = el.querySelector(`[data-save-progress="${f.id}"]`);
    if (save) save.style.width = `${Math.round((f.saving || 0) * 100)}%`;
  }
}

function progressBar(f) {
  return h('div.bar', null, h('i', { dataset: { progress: f.id } }));
}

function thumb(vm, f, actions) {
  const isVideo = /^video\//.test(f.type);
  const ready = f.status === 'done' || f.src;
  if (!ready) {
    return h('div.thumb.pending', null,
      h('div', { style: 'text-align:center;width:80%' },
        h('div.small.muted', { dataset: { pct: f.id } }, '0%'),
        progressBar(f)));
  }
  const src = f.src || f.url;
  const media = isVideo
    ? h('video', { src: `${src}#t=0.1`, muted: true, playsInline: true, preload: 'metadata' })
    : h('img', { src, alt: f.name, loading: 'lazy', decoding: 'async' });
  // Formats the browser can't decode (HEIC on Windows, HEVC video...) fall back to a label.
  media.addEventListener('error', () => media.replaceWith(h('div.ext', { style: 'width:100%;height:100%;display:grid;place-items:center' }, extOf(f.name))));
  const el = h('button.thumb', { type: 'button', title: f.name, onclick: () => actions.view(vm, f) }, media);
  if (isVideo) el.append(h('span.badge', { html: icon('play') }, formatBytes(f.size)));
  if (f.status === 'failed') {
    el.append(h('span.badge', null, 'Failed'));
  } else if (f.status !== 'done') {
    el.append(h('div', { style: 'position:absolute;left:6px;right:6px;bottom:6px' }, progressBar(f)));
  } else if (f.saving != null) {
    el.append(h('div', { style: 'position:absolute;left:6px;right:6px;bottom:6px' }, h('div.bar', null, h('i', { dataset: { saveProgress: f.id } }))));
  } else if (f.saved) {
    el.append(h('span.badge', { style: 'left:auto;right:6px', html: icon('check') }, 'Saved'));
  }
  return el;
}

function fileRow(vm, f, actions) {
  let right;
  if (f.status === 'done' && vm.dir === 'in') {
    right = h('a.btn.small', { href: f.downloadUrl, download: f.name, html: icon('down'), onclick: (e) => actions.save(e, vm, f) }, 'Save');
  } else if (f.status === 'done') {
    right = h('span.status.good', { html: icon('check') });
  } else if (f.status === 'failed') {
    right = h('span.status.bad', null, 'Failed');
  } else {
    right = h('span.small.muted', { dataset: { pct: f.id } }, '0%');
  }
  return h('div.file-row', null,
    h('div.ext', null, extOf(f.name)),
    h('div.fname', null,
      h('div', { title: f.name }, f.name),
      h('div.fsize', null, formatBytes(f.size)),
      f.status !== 'done' && f.status !== 'failed' ? progressBar(f) : null),
    right);
}

function linkBox(vm, actions) {
  const url = actions.linkUrl(vm);
  return h('div.link-box', null,
    h('img', { src: qrUrl(url), alt: 'QR code for this link', onclick: () => actions.showLinkQr(vm), style: 'cursor:zoom-in' }),
    h('div', { style: 'min-width:0;display:grid;gap:8px' },
      h('div.small.muted', null, 'Anyone on this network with the link can open it:'),
      h('code', null, url),
      h('div', null, h('button.btn.small', { type: 'button', html: icon('copy'), onclick: () => actions.copy(url) }, 'Copy link'))));
}
