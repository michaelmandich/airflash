'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomId, shortCode, safeFilename, clampString } = require('./util');

const DEFAULTS = {
  ttlMs: 15 * 60 * 1000,
  maxFileBytes: 16 * 1024 ** 3,
  maxFilesPerDrop: 200,
  maxTextChars: 200_000,
  diskReserveBytes: 512 * 1024 ** 2,
  maxStoreBytes: null, // sum of declared sizes of live drops; null = only the disk reserve applies
  chunkBytes: 32 * 1024 ** 2,
  codeLength: 6,
  // A drop with files that has received nothing yet only reserves its quota for this long (or the ttl,
  // whichever is shorter); the full ttl starts once bytes land. Abandoned pickers must not hold a relay's store for a day.
  graceMs: 15 * 60 * 1000,
};
const PROGRESS_EVERY_MS = 250;
const SWEEP_EVERY_MS = 10 * 1000;

/** An error with an HTTP status. `expose` says whether the message may go to the client (4xx yes, 5xx only when asked). */
function httpError(status, message, { expose = status < 500, cause } = {}) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { status, expose });
}

/**
 * Drops are the unit of sharing: some files and/or a text snippet, sent to one
 * device (or to "anyone with the link"), deleted from disk when they expire.
 */
class DropStore extends EventEmitter {
  constructor({ dir, ...opts }) {
    super();
    this.dir = dir;
    this.opts = { ...DEFAULTS, ...opts };
    this.drops = new Map();
    this.codes = new Map(); // share code -> drop id
    // Chunked-upload bookkeeping per file id. Kept off the file entry so publicDrop() can't leak it
    // and because an open fd must be closed before the drop folder can be removed (Windows refuses otherwise).
    this.chunkStates = new Map(); // file id -> { ready, received: Set, inflight: Map<n, bytesSoFar>, streams: Map<n, {fail, settled}>, closed, total, lastEmit }
    // This folder belongs to this node alone, and everything in it is temporary: start clean.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    this.sweeper = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
    this.sweeper.unref();
  }

  create({ from, to, text, files, link }) {
    files = Array.isArray(files) ? files : [];
    text = text == null ? null : String(text);
    if (!files.length && !text?.trim()) throw httpError(400, 'A drop needs files or text');
    if (files.length > this.opts.maxFilesPerDrop) throw httpError(400, `At most ${this.opts.maxFilesPerDrop} files per drop`);
    if (text && text.length > this.opts.maxTextChars) throw httpError(413, 'Text is too long');
    if (!link && !to) throw httpError(400, 'Pick a device or make a link');

    let total = 0;
    const fileEntries = files.map((f) => {
      const size = Number(f.size);
      if (!Number.isSafeInteger(size) || size < 0) throw httpError(400, 'Invalid file size');
      if (size > this.opts.maxFileBytes) throw httpError(413, `${safeFilename(f.name)} is too large`);
      total += size;
      return {
        id: randomId(9),
        name: safeFilename(f.name),
        size,
        type: clampString(f.type, 120) || 'application/octet-stream',
        received: 0,
        status: 'pending',
      };
    });
    this._checkQuota(total);
    this._checkDiskSpace(total);

    const now = Date.now();
    const drop = {
      id: randomId(16),
      code: null,
      createdAt: now,
      expiresAt: now + (fileEntries.length ? Math.min(this.opts.ttlMs, this.opts.graceMs) : this.opts.ttlMs),
      from: {
        id: clampString(from?.id, 64),
        name: clampString(from?.name, 40) || 'Someone',
        kind: clampString(from?.kind, 16) || 'other',
        node: clampString(from?.node, 40) || null,
      },
      to: link ? null : clampString(to, 64),
      text,
      files: fileEntries,
      uploadToken: randomId(16),
    };
    if (link) {
      let code;
      do code = shortCode(this.opts.codeLength); while (this.codes.has(code));
      drop.code = code;
      this.codes.set(code, drop.id);
    }
    fs.mkdirSync(path.join(this.dir, drop.id));
    this.drops.set(drop.id, drop);
    this.emit('drop:new', drop);
    return drop;
  }

  get(id) {
    const d = this.drops.get(id);
    return d && d.expiresAt > Date.now() ? d : null;
  }

  getByCode(code) {
    const id = this.codes.get(String(code || '').toUpperCase());
    return id ? this.get(id) : null;
  }

  /** Drops a device should see: sent to it, or sent by it from this node. */
  listFor(deviceId) {
    const out = [];
    for (const d of this.drops.values()) {
      if (d.expiresAt <= Date.now()) continue;
      if (d.to === deviceId || d.from.id === deviceId) out.push(d);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  filePath(drop, file) {
    return path.join(this.dir, drop.id, file.id);
  }

  /** Stream an upload body to disk. Resolves with the file entry. */
  receiveFile(drop, fileId, req) {
    const file = drop.files.find((f) => f.id === fileId);
    if (!file) return Promise.reject(httpError(404, 'No such file'));
    if (file.status === 'done') return Promise.reject(httpError(409, 'Already uploaded'));
    if (file.status === 'uploading') return Promise.reject(httpError(409, 'Upload already in progress'));
    if (this.chunkStates.has(file.id)) return Promise.reject(httpError(409, 'This file is being uploaded in chunks'));
    const declared = req.headers['content-length'];
    if (declared != null && Number(declared) !== file.size) {
      return Promise.reject(httpError(400, 'Content-Length does not match the declared size'));
    }

    file.status = 'uploading';
    file.received = 0;
    this.emit('drop:update', drop);

    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(this.filePath(drop, file));
      let lastEmit = 0;
      let failed = false;

      const fail = (err) => {
        if (failed) return;
        failed = true;
        out.destroy();
        fs.rm(this.filePath(drop, file), { force: true }, () => {});
        file.status = 'failed';
        file.received = 0;
        if (this.drops.has(drop.id)) this.emit('drop:update', drop);
        reject(err);
      };

      req.on('data', (chunk) => {
        file.received += chunk.length;
        if (file.received > file.size) {
          fail(httpError(413, 'Upload is larger than declared'));
          req.destroy();
          return;
        }
        const now = Date.now();
        if (now - lastEmit > PROGRESS_EVERY_MS) {
          lastEmit = now;
          this.emit('drop:progress', drop, file);
        }
      });
      req.on('aborted', () => fail(httpError(499, 'Upload aborted')));
      req.on('error', fail);
      out.on('error', fail);
      req.pipe(out);
      out.on('finish', () => {
        if (failed) return;
        if (file.received !== file.size) return fail(httpError(400, 'Upload was incomplete'));
        this._finishFile(drop, file);
        resolve(file);
      });
    });
  }

  // ---------- chunked uploads ----------

  chunkCount(file) {
    return Math.ceil(file.size / this.opts.chunkBytes);
  }

  chunkLength(file, n) {
    const total = this.chunkCount(file);
    return n === total - 1 ? file.size - n * this.opts.chunkBytes : this.opts.chunkBytes;
  }

  /** { received: [n...], chunkBytes, total, status } for resuming after a dropped connection. */
  chunkStatus(drop, fileId) {
    const file = drop.files.find((f) => f.id === fileId);
    if (!file) throw httpError(404, 'No such file');
    const state = this.chunkStates.get(file.id);
    const total = this.chunkCount(file);
    // A finished file lists every chunk: a client resuming after a lost `complete` answer then skips straight to it.
    const received = file.status === 'done' ? Array.from({ length: total }, (_, n) => n) : state ? [...state.received].sort((a, b) => a - b) : [];
    return {
      received,
      chunkBytes: this.opts.chunkBytes,
      total,
      status: file.status,
    };
  }

  /**
   * Write chunk `n` (0-based) of a file at offset n × chunkBytes into a file pre-sized to the
   * declared size. Different chunks may be written concurrently; the same chunk twice is a 409
   * while in flight and an idempotent 200 once it is in. Resolves with { received: true }.
   */
  async receiveChunk(drop, fileId, n, req) {
    const file = drop.files.find((f) => f.id === fileId);
    if (!file) throw httpError(404, 'No such file');
    if (file.status === 'done') throw httpError(409, 'Already uploaded');
    const total = this.chunkCount(file);
    if (!Number.isInteger(n) || n < 0 || n >= total) throw httpError(400, `Chunk index must be between 0 and ${total - 1}`);
    const expected = this.chunkLength(file, n);
    const declared = req.headers['content-length'];
    if (declared == null) throw httpError(411, 'Content-Length is required for chunks');
    if (Number(declared) !== expected) throw httpError(400, `Chunk ${n} must be exactly ${expected} bytes`);
    if (file.status === 'uploading' && !this.chunkStates.has(file.id)) throw httpError(409, 'A whole-file upload is in progress');

    let state = this.chunkStates.get(file.id);
    if (!state) {
      state = { ready: null, received: new Set(), inflight: new Map(), streams: new Map(), closed: false, total, lastEmit: 0 };
      this.chunkStates.set(file.id, state);
    }
    if (state.inflight.has(n)) throw httpError(409, `Chunk ${n} is already being uploaded`);
    if (state.received.has(n)) {
      // Drain so the client gets a clean reply rather than a reset mid-body.
      await new Promise((resolve, reject) => { req.on('end', resolve); req.on('error', reject); req.resume(); });
      return { received: true };
    }

    state.inflight.set(n, 0);
    file.status = 'uploading';
    this.emit('drop:update', drop);
    try {
      // The first chunk to arrive creates and pre-sizes the file; concurrent chunks wait for that.
      // No O_TRUNC: if the file is already there (a retry, a race with complete) its bytes stay.
      if (!state.ready) {
        state.ready = (async () => {
          const handle = await fsp.open(this.filePath(drop, file), fs.constants.O_RDWR | fs.constants.O_CREAT);
          try {
            await handle.truncate(file.size);
          } finally {
            await handle.close().catch(() => {});
          }
        })().catch((err) => {
          this.chunkStates.delete(file.id); // let the next chunk try again from scratch
          // The fs message names the node's data directory; the log gets it, the uploader does not.
          throw httpError(500, 'Could not create the file', { cause: err });
        });
      }
      await state.ready;
      if (state.closed) throw httpError(404, 'This drop has expired');
      await this._writeChunk(drop, file, state, n, expected, req);
      state.received.add(n);
      // Progress counts the chunks that are in; a slow uplink keeps the drop alive chunk by chunk.
      drop.expiresAt = Math.max(drop.expiresAt, Date.now() + this.opts.ttlMs);
      return { received: true };
    } finally {
      state.inflight.delete(n);
      if (this.drops.has(drop.id)) {
        file.received = this._chunkedBytes(file, state);
        if (!state.inflight.size && file.status === 'uploading') file.status = 'pending';
        this.emit('drop:update', drop);
      }
    }
  }

  /**
   * Each chunk streams through a write stream of its own ('r+' at its offset) that opens and closes its
   * fd inside this call, so two chunks never interleave and no stream ever outlives its fd: a stale fd
   * number would be reused by the next file the node opens, and the rest of the chunk would land in
   * somebody else's drop. _closeChunkState() aborts the chunk through `entry.fail` and waits for
   * `entry.settled` (the stream's 'close': fd gone) before the drop folder is removed.
   */
  _writeChunk(drop, file, state, n, expected, req) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(this.filePath(drop, file), { flags: 'r+', start: n * this.opts.chunkBytes });
      const entry = { fail: null, settled: new Promise((r) => out.once('close', r)) };
      entry.settled.then(() => state.streams.delete(n));
      state.streams.set(n, entry);
      let got = 0;
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        out.destroy();
        reject(err);
      };
      entry.fail = (err) => { fail(err); req.destroy(); };
      req.on('data', (buf) => {
        got += buf.length;
        state.inflight.set(n, got);
        if (got > expected) {
          fail(httpError(413, 'Chunk is larger than declared'));
          req.destroy();
          return;
        }
        const now = Date.now();
        if (now - state.lastEmit > PROGRESS_EVERY_MS) {
          state.lastEmit = now;
          file.received = this._chunkedBytes(file, state);
          this.emit('drop:progress', drop, file);
        }
      });
      req.on('aborted', () => fail(httpError(499, 'Upload aborted')));
      req.on('error', fail);
      // ENOENT/EACCES on open surface here; the fs message names the data directory, so it stays in the log.
      out.on('error', (err) => fail(err.code ? httpError(500, 'Could not open the file', { cause: err }) : err));
      req.pipe(out);
      // 'close' rather than 'finish': the fd is closed by then, so a drop deleted right after can remove its folder on Windows.
      out.on('close', () => {
        if (failed) return;
        if (got !== expected) return fail(httpError(400, 'Chunk was incomplete'));
        resolve();
      });
    });
  }

  _chunkedBytes(file, state) {
    let bytes = 0;
    for (const n of state.received) bytes += this.chunkLength(file, n);
    for (const partial of state.inflight.values()) bytes += partial;
    return Math.min(bytes, file.size);
  }

  /** Mark a chunked file done once every chunk is in. Throws 400 (with `.missing`) otherwise. */
  async completeFile(drop, fileId) {
    const file = drop.files.find((f) => f.id === fileId);
    if (!file) throw httpError(404, 'No such file');
    if (file.status === 'done') return file;
    const state = this.chunkStates.get(file.id);
    if (file.status === 'uploading' && !state) throw httpError(409, 'A whole-file upload is in progress');
    if (state?.inflight.size) throw httpError(409, 'A chunk is still uploading');
    const total = this.chunkCount(file);
    const missing = [];
    for (let n = 0; n < total; n++) if (!state?.received.has(n)) missing.push(n);
    if (missing.length) throw Object.assign(httpError(400, `Missing chunks: ${missing.join(', ')}`), { missing });
    if (state) {
      // Done before the state goes: a late chunk PUT in the close window must be the 409, not a fresh state that reopens the file.
      file.status = 'done';
      await this._closeChunkState(file.id);
    } else await fsp.writeFile(this.filePath(drop, file), ''); // a 0-byte file has no chunks to send
    file.received = file.size;
    this._finishFile(drop, file);
    return file;
  }

  _finishFile(drop, file) {
    file.status = 'done';
    // The 15 minutes start once the content is actually there.
    drop.expiresAt = Math.max(drop.expiresAt, Date.now() + this.opts.ttlMs);
    this.emit('drop:update', drop);
  }

  /** Forget a file's chunk state and abort whatever is still streaming into it; resolves once every fd on it is closed. */
  async _closeChunkState(fileId) {
    const state = this.chunkStates.get(fileId);
    if (!state) return;
    state.closed = true;
    this.chunkStates.delete(fileId);
    await state.ready?.catch(() => null);
    const open = [...state.streams.values()];
    for (const s of open) s.fail?.(httpError(404, 'This drop has expired'));
    await Promise.all(open.map((s) => s.settled));
  }

  // ---------- lifecycle ----------

  async delete(id) {
    const drop = this.drops.get(id);
    if (!drop) return;
    this.drops.delete(id);
    if (drop.code) this.codes.delete(drop.code);
    this.emit('drop:gone', drop);
    for (const f of drop.files) await this._closeChunkState(f.id);
    await fsp.rm(path.join(this.dir, id), { recursive: true, force: true }).catch(() => {});
  }

  sweep() {
    const now = Date.now();
    for (const d of this.drops.values()) {
      const uploading = d.files.some((f) => f.status === 'uploading');
      if (d.expiresAt <= now && !uploading) this.delete(d.id);
    }
  }

  stats() {
    let bytes = 0;
    for (const d of this.drops.values()) for (const f of d.files) bytes += f.received;
    return { drops: this.drops.size, bytes };
  }

  /** Declared bytes of every drop that has not expired (what the disk will hold once uploads finish). */
  declaredBytes() {
    const now = Date.now();
    let bytes = 0;
    for (const d of this.drops.values()) {
      if (d.expiresAt <= now) continue;
      for (const f of d.files) bytes += f.size;
    }
    return bytes;
  }

  _checkQuota(needed) {
    if (!needed || !this.opts.maxStoreBytes) return;
    if (this.declaredBytes() + needed > this.opts.maxStoreBytes) throw httpError(507, 'The node is full right now; try again once older drops expire', { expose: true });
  }

  _checkDiskSpace(needed) {
    if (!needed || typeof fs.statfsSync !== 'function') return;
    try {
      const s = fs.statfsSync(this.dir);
      const free = s.bavail * s.bsize;
      if (needed > free - this.opts.diskReserveBytes) throw httpError(507, 'Not enough disk space on the receiving device', { expose: true });
    } catch (err) {
      if (err.status) throw err;
    }
  }

  async close() {
    clearInterval(this.sweeper);
    for (const id of [...this.chunkStates.keys()]) await this._closeChunkState(id);
    await fsp.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The shape of a drop that clients are allowed to see. */
function publicDrop(drop) {
  const { uploadToken, ...rest } = drop;
  const ready = drop.files.every((f) => f.status === 'done');
  return { ...rest, ready, files: drop.files.map((f) => ({ ...f })) };
}

module.exports = { DropStore, publicDrop, httpError };
