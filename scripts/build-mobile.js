'use strict';

// Builds the Capacitor webDir: www/ = src/web (unchanged, no bundling) + native.js (src/mobile
// bundled, because WKWebView cannot resolve bare '@capacitor/*' imports). Run: npm run build:mobile

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const SRC_WEB = path.join(ROOT, 'src', 'web');
const SRC_NATIVE = path.join(ROOT, 'src', 'mobile', 'native.js');
const WWW = path.join(ROOT, 'www');
const APP_TAG = '<script type="module" src="/app.js"></script>';
const NATIVE_TAG = '<script src="/native.js"></script>';

async function main() {
  fs.rmSync(WWW, { recursive: true, force: true });
  fs.cpSync(SRC_WEB, WWW, { recursive: true });

  await esbuild.build({
    entryPoints: [SRC_NATIVE],
    outfile: path.join(WWW, 'native.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'safari16',
    minify: false,
    sourcemap: false,
    logLevel: 'error',
  });

  const indexPath = path.join(WWW, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const at = html.indexOf(APP_TAG);
  if (at < 0) throw new Error(`${indexPath}: could not find ${APP_TAG}`);
  if (html.indexOf(APP_TAG, at + 1) >= 0) throw new Error(`${indexPath}: ${APP_TAG} appears more than once`);
  const indent = /[ \t]*$/.exec(html.slice(0, at))[0];
  fs.writeFileSync(indexPath, html.slice(0, at) + NATIVE_TAG + '\n' + indent + html.slice(at));

  const files = fs.readdirSync(WWW, { recursive: true }).filter((f) => fs.statSync(path.join(WWW, f)).isFile());
  console.log(`www/: ${files.length} files, native.js ${fs.statSync(path.join(WWW, 'native.js')).size} bytes`);
}

main().catch((err) => {
  console.error('build-mobile failed:', err && err.message ? err.message : err);
  process.exit(1);
});
