'use strict';

// The headless entry point (bin/airflash.js): configuration errors, the trust-proxy switch and the banner.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const BIN = path.join(__dirname, '..', 'bin', 'airflash.js');

/** Run the bin until it exits or prints `until`; resolves { code, out } (code is null when we stopped it). */
function run(args, env, { until = null, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out }); };
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out; output so far:\n${out}`)); }, timeoutMs);
    const onData = (d) => {
      out += d;
      if (until && out.includes(until)) { child.kill(); finish(null); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => finish(code));
    child.on('error', reject);
  });
}

const base = ['--port', '0', '--no-discovery', '--host', '127.0.0.1', '--data', path.join(os.tmpdir(), `airflash-bin-${process.pid}`)];
const noEnv = { AIRFLASH_TRUST_PROXY: '', AIRFLASH_ACCESS_KEY: '', AIRFLASH_ACCESS_KEY_FILE: '', AIRFLASH_TTL: '', AIRFLASH_MAX_REQUEST_BYTES: '' };

test('configuration errors exit 78, not 1, so a supervisor can tell them from crashes', async () => {
  const typo = await run([...base, '--access-key', 'k'], { ...noEnv, AIRFLASH_TRUST_PROXY: 'maybe' });
  assert.equal(typo.code, 78);
  assert.match(typo.out, /AIRFLASH_TRUST_PROXY must be 1\/true\/yes\/on/);
  const missing = await run([...base, '--access-key-file', path.join(os.tmpdir(), 'airflash-no-such-key-file')], noEnv);
  assert.equal(missing.code, 78);
  assert.match(missing.out, /cannot read the access key file/);
  const ttl = await run([...base, '--ttl', 'soon'], noEnv);
  assert.equal(ttl.code, 78);
  assert.match(ttl.out, /--ttl wants a duration/);
});

test('--trust-proxy comes from the flag or any usual spelling of the env, and the banner says which client IP is used', async () => {
  for (const value of ['1', 'true', 'YES', 'On']) {
    const r = await run([...base, '--access-key', 'k'], { ...noEnv, AIRFLASH_TRUST_PROXY: value }, { until: 'Client IP:' });
    assert.match(r.out, /Client IP: CF-Connecting-IP \/ X-Forwarded-For \(trust-proxy\)/, `env ${value}`);
    assert.doesNotMatch(r.out, /WARNING/);
  }
  for (const value of ['0', 'false', 'no', 'off']) {
    const r = await run([...base, '--access-key', 'k', '--max-request-bytes', '10mb'], { ...noEnv, AIRFLASH_TRUST_PROXY: value }, { until: 'WARNING' });
    assert.match(r.out, /Client IP: socket address/, `env ${value}`);
    assert.match(r.out, /WARNING: bound to 127\.0\.0\.1 without --trust-proxy/, 'loopback bind + key + no trust-proxy: the guard would block everyone at once');
    assert.match(r.out, /chunks of 9\.5 MiB/, 'the banner prints the clamped chunk size');
  }
  const flag = await run([...base, '--access-key', 'k', '--trust-proxy'], noEnv, { until: 'Client IP:' });
  assert.match(flag.out, /\(trust-proxy\)/);
  const lan = await run(base, noEnv, { until: 'Relay mode: off' });
  assert.doesNotMatch(lan.out, /Client IP/, 'a LAN node has no proxy story to tell');
});
