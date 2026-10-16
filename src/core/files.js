'use strict';

const fs = require('node:fs');
const { contentDisposition } = require('./util');

// Types that are safe to render inline. Anything else (HTML, SVG, PDF, ...) is
// served as a download so an uploaded file can never run script on our origin.
const INLINE_TYPES = /^(image\/(jpeg|png|gif|webp|avif|bmp|heic|heif)|video\/[\w.+-]+|audio\/[\w.+-]+|text\/plain)$/i;

const FILE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
  'Cache-Control': 'private, max-age=900',
  'Accept-Ranges': 'bytes',
};

/** Parse a single-range "bytes=" header. Returns null for "whole file", or false if unsatisfiable. */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null; // multi-range or junk: ignore and send everything
  let start;
  let end;
  if (m[1] === '' && m[2] === '') return false;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return false;
  return { start, end };
}

/** Serve a stored file with HTTP Range support (iOS Safari needs it for video). */
function serveFile(req, res, filePath, file, { download = false } = {}) {
  const inline = !download && INLINE_TYPES.test(file.type);
  const headers = {
    ...FILE_HEADERS,
    'Content-Type': inline ? file.type : 'application/octet-stream',
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', file.name),
  };
  const range = parseRange(req.headers.range, file.size);
  if (range === false) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${file.size}` });
    return res.end();
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : file.size - 1;
  const length = file.size === 0 ? 0 : end - start + 1;
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
  headers['Content-Length'] = length;
  fs.stat(filePath, (err) => {
    if (err) {
      res.writeHead(410, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'This file is no longer available' }));
    }
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || length === 0) return res.end();
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

module.exports = { serveFile, parseRange };
