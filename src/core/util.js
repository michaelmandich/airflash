'use strict';

const crypto = require('node:crypto');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

/** Unguessable id, used as a bearer capability for drops and files. */
function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Short, human-typeable code for share links. Uniform over the alphabet: a byte that would bias `% 31` is thrown away. */
function shortCode(len = 6) {
  const limit = 256 - (256 % CODE_ALPHABET.length); // 248: the largest multiple of 31 that fits a byte
  let out = '';
  while (out.length < len) {
    for (const b of crypto.randomBytes(len - out.length)) {
      if (b < limit && out.length < len) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

/** Public device id derived from the device's private secret. */
function publicIdFromSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('base64url').slice(0, 16);
}

/** Strip path components and control characters from a client-supplied filename. */
function safeFilename(name) {
  let n = String(name || '').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '');
  n = n.trim().replace(/^\.+/, '');
  if (!n) n = 'file';
  if (n.length > 200) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : '';
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n;
}

function clampString(s, max) {
  return String(s ?? '').slice(0, max);
}

const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "15m", "24h", "2d", "90s" → milliseconds. A bare number is minutes. Returns null when unparseable. */
function parseDuration(input) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(String(input ?? ''));
  if (!m) return null;
  const ms = Number(m[1]) * DURATION_UNITS[(m[2] || 'm').toLowerCase()];
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

// kb/mb/gb are decimal (what Cloudflare's "100 MB" means), kib/mib/gib binary.
const BYTE_UNITS = { b: 1, k: 1000, kb: 1000, m: 1000 ** 2, mb: 1000 ** 2, g: 1000 ** 3, gb: 1000 ** 3, t: 1000 ** 4, tb: 1000 ** 4, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

/** "100mb", "1gb", "32mib", "12345" → bytes. Returns null when unparseable. */
function parseBytes(input) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(String(input ?? ''));
  if (!m) return null;
  const unit = BYTE_UNITS[(m[2] || 'b').toLowerCase()];
  if (!unit) return null;
  const bytes = Math.round(Number(m[1]) * unit);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

function contentDisposition(type, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/** Read a small JSON request body (with a size cap). */
function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

module.exports = {
  randomId,
  shortCode,
  publicIdFromSecret,
  safeFilename,
  clampString,
  parseDuration,
  parseBytes,
  contentDisposition,
  sendJson,
  sendError,
  readJson,
};
