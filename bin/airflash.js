#!/usr/bin/env node
'use strict';

// Headless AirFlash node. Same server the desktop app runs, minus the window.
// Usage: airflash [--host 0.0.0.0] [--port 4747] [--name "Living room Pi"] [--data ./dir] [--allowed-hosts air.example.com] [--no-discovery]
//                 [--access-key K | --access-key-file F] [--ttl 24h] [--max-request-bytes 100mb] [--chunk-bytes 32mib]
//                 [--max-file-bytes 16gib] [--max-store-bytes 12gib] [--trust-proxy] [--cors-origins https://a,https://b]
// Env equivalents: AIRFLASH_HOST, AIRFLASH_PORT, AIRFLASH_NAME, AIRFLASH_ALLOWED_HOSTS, AIRFLASH_ACCESS_KEY, AIRFLASH_ACCESS_KEY_FILE,
// AIRFLASH_TTL, AIRFLASH_MAX_REQUEST_BYTES, AIRFLASH_CHUNK_BYTES, AIRFLASH_MAX_FILE_BYTES, AIRFLASH_MAX_STORE_BYTES,
// AIRFLASH_TRUST_PROXY=1|true|yes|on, AIRFLASH_CORS_ORIGINS (flags win). Any access key switches the node into relay mode (docs/relay-mode.md).
// Configuration errors exit 78 (EX_CONFIG); everything else that dies exits 1.

const fs = require('node:fs');
const path = require('node:path');
const { startNode, DEFAULT_PORT } = require('../src/core');
const { parseDuration, parseBytes } = require('../src/core/util');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// A configuration error is not a crash: exit 78 (EX_CONFIG) so a supervisor with
// RestartPreventExitStatus=78 leaves the node down with one clear line instead of restarting it forever.
const EXIT_CONFIG = 78;

/** --name on the command line, or the env set to 1/true/yes/on (0/false/no/off/empty = off; anything else is a typo). */
function flag(name, env) {
  if (process.argv.includes(`--${name}`)) return true;
  const raw = String(process.env[env] ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['', '0', 'false', 'no', 'off'].includes(raw)) return false;
  return fail(`${env} must be 1/true/yes/on or 0/false/no/off (got "${process.env[env]}")`);
}

function fail(message) {
  console.error(`airflash: ${message}`);
  process.exit(EXIT_CONFIG);
}

/** --ttl 15m / 24h / 2d (a bare number is minutes). */
function durationArg(name, env) {
  const raw = arg(name, process.env[env]);
  if (raw == null || raw === '') return undefined;
  const ms = parseDuration(raw);
  if (ms == null) fail(`--${name} wants a duration like 15m, 24h or 2d (got "${raw}")`);
  return ms;
}

/** --max-request-bytes 100mb / 1gb / 32mib / plain bytes. */
function bytesArg(name, env) {
  const raw = arg(name, process.env[env]);
  if (raw == null || raw === '') return undefined;
  const bytes = parseBytes(raw);
  if (bytes == null || bytes <= 0) fail(`--${name} wants a size like 100mb, 1gb or a number of bytes (got "${raw}")`);
  return bytes;
}

/** The access key from --access-key / env, or read (trimmed) from --access-key-file / env. Never printed. */
function accessKeyArg() {
  const file = arg('access-key-file', process.env.AIRFLASH_ACCESS_KEY_FILE);
  const inline = arg('access-key', process.env.AIRFLASH_ACCESS_KEY);
  if (file) {
    let key;
    try {
      key = fs.readFileSync(path.resolve(file), 'utf8').trim();
    } catch (err) {
      fail(`cannot read the access key file ${file}: ${err.message}`);
    }
    if (!key) fail(`the access key file ${file} is empty`);
    return key;
  }
  return inline || undefined;
}

async function main() {
  const host = arg('host', process.env.AIRFLASH_HOST) || undefined; // e.g. 127.0.0.1 behind a tunnel or reverse proxy
  const node = await startNode({
    host,
    port: Number(arg('port', process.env.AIRFLASH_PORT || DEFAULT_PORT)),
    name: arg('name', process.env.AIRFLASH_NAME) || undefined,
    dataDir: arg('data') ? path.resolve(arg('data')) : undefined,
    // Public hostnames to answer to; the node refuses any other Host header (DNS-rebinding guard).
    allowedHosts: (arg('allowed-hosts', process.env.AIRFLASH_ALLOWED_HOSTS) || '').split(',').map((h) => h.trim()).filter(Boolean),
    discovery: !process.argv.includes('--no-discovery'),
    // Relay mode (docs/relay-mode.md): an access key gates sending, plus the limits a proxy in front imposes.
    accessKey: accessKeyArg(),
    ttlMs: durationArg('ttl', 'AIRFLASH_TTL'),
    maxRequestBytes: bytesArg('max-request-bytes', 'AIRFLASH_MAX_REQUEST_BYTES'),
    chunkBytes: bytesArg('chunk-bytes', 'AIRFLASH_CHUNK_BYTES'),
    maxFileBytes: bytesArg('max-file-bytes', 'AIRFLASH_MAX_FILE_BYTES'),
    maxStoreBytes: bytesArg('max-store-bytes', 'AIRFLASH_MAX_STORE_BYTES'),
    trustProxy: flag('trust-proxy', 'AIRFLASH_TRUST_PROXY'),
    corsOrigins: (arg('cors-origins') || '').split(',').map((o) => o.trim()).filter(Boolean), // AIRFLASH_CORS_ORIGINS is read by the node itself
    log: (m) => console.log(m),
  });

  const info = node.info();
  console.log(`\n  ⚡ AirFlash is running${info.relay ? ' in relay mode' : ''}\n`);
  console.log(`  On this computer:  http://localhost:${info.port}`);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (loopback) console.log(`  Bound to ${host} only; devices reach it through whatever proxy or tunnel sits in front.`);
  else for (const u of info.urls || []) console.log(`  On your network:   ${u.url}   (${u.iface})`);
  // A relay prints no LAN URLs, so there is nothing to "open on your phone" here.
  console.log(`\n  ${loopback || info.relay ? 'Drops' : 'Open one of those on your phone (same Wi-Fi). Drops'} expire after ${Math.round(info.ttlMs / 60000)} minutes.`);
  if (info.relay) {
    const { maxRequestBytes, chunkBytes } = info.limits;
    console.log(`  Relay mode: on. Sending needs the access key; links work without it.`);
    console.log(`  Requests up to ${maxRequestBytes ? `${Math.round(maxRequestBytes / 1e6)} MB` : 'any size'}, chunks of ${(chunkBytes / 1024 ** 2).toFixed(chunkBytes % 1024 ** 2 ? 1 : 0)} MiB${node.store.opts.maxStoreBytes ? `, store capped at ${(node.store.opts.maxStoreBytes / 1024 ** 3).toFixed(1)} GiB` : ''}.`);
    console.log(`  Client IP: ${node.trustProxy ? 'CF-Connecting-IP / X-Forwarded-For (trust-proxy)' : 'socket address'}.`);
    // The brute-force guard counts per client IP; behind a proxy without --trust-proxy every client is 127.0.0.1.
    if (loopback && !node.trustProxy) console.log(`  WARNING: bound to ${host} without --trust-proxy: one visitor's wrong keys block everyone behind the proxy. Set AIRFLASH_TRUST_PROXY=1.`);
  } else console.log(`  Relay mode: off (no access key; anyone on the network can send).`);
  console.log('');

  const shutdown = async () => {
    await node.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
