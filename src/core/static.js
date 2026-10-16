'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const APP_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Serve the web UI. Unknown paths fall back to index.html (client-side routes like /d/CODE). */
function createStatic(root) {
  const resolvedRoot = path.resolve(root);
  return function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel.startsWith('/d/')) rel = '/index.html';
    let file = path.resolve(resolvedRoot, '.' + rel);
    if (!file.startsWith(resolvedRoot + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        if (path.extname(rel)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('Not found');
        }
        file = path.join(resolvedRoot, 'index.html');
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        ...(ext === '.html' ? { 'Content-Security-Policy': APP_CSP, 'Referrer-Policy': 'no-referrer' } : {}),
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  };
}

module.exports = { createStatic };
