'use strict';

const net = require('node:net');

/**
 * Per-client failure counter: more than `max` failures inside `windowMs` → blocked for `banMs`.
 * Keys are client addresses as `bucket()` returns them. The map is capped at `maxEntries`: when
 * it is full, the entry whose last failure is oldest goes, so a client rotating addresses can
 * fill it with junk but never grow it (the Map keeps insertion order and every failure re-inserts).
 */
class FailureGuard {
  constructor({ max, windowMs, banMs, maxEntries = 10_000 }) {
    this.max = max;
    this.windowMs = windowMs;
    this.banMs = banMs;
    this.maxEntries = maxEntries;
    this.entries = new Map(); // bucket -> { fails: [timestamps], bannedUntil }
  }

  /** Milliseconds left on this client's block, 0 when it may proceed. */
  blockedFor(key, now = Date.now()) {
    const e = this.entries.get(key);
    return e && e.bannedUntil > now ? e.bannedUntil - now : 0;
  }

  /** Record a failure. Returns the ban length when this failure crossed the line, else 0. */
  fail(key, now = Date.now()) {
    const e = this.entries.get(key) || { fails: [], bannedUntil: 0 };
    this.entries.delete(key); // re-insert so the Map's order is "oldest last failure first"
    if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, e);
    e.fails = e.fails.filter((t) => now - t < this.windowMs);
    e.fails.push(now);
    if (e.fails.length <= this.max) return 0;
    e.fails = [];
    e.bannedUntil = now + this.banMs;
    return this.banMs;
  }

  sweep(now = Date.now()) {
    for (const [key, e] of this.entries) {
      e.fails = e.fails.filter((t) => now - t < this.windowMs);
      if (!e.fails.length && e.bannedUntil <= now) this.entries.delete(key);
    }
  }

  get size() {
    return this.entries.size;
  }
}

/**
 * The key a client address is counted under: IPv4 as is, IPv6 by its /64 (one host gets a whole
 * /64, so counting single addresses would let it dodge the limit forever), anything that is not
 * an IP address under one shared bucket.
 */
function addressBucket(ip) {
  const s = String(ip || '').trim().replace(/%.*$/, ''); // drop a zone id (fe80::1%eth0)
  if (net.isIPv4(s)) return s;
  if (!net.isIPv6(s)) return 'invalid';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) return mapped[1];
  const [head, tail = ''] = s.split('::');
  const groups = (part) => (part ? part.split(':') : []);
  const h = groups(head);
  const t = groups(tail);
  const width = (g) => (g.includes('.') ? 2 : 1); // an embedded IPv4 (64:ff9b::1.2.3.4) is two groups
  const used = [...h, ...t].reduce((n, g) => n + width(g), 0);
  const full = [...h, ...Array(Math.max(0, 8 - used)).fill('0'), ...t];
  return `${full.slice(0, 4).map((g) => g.padStart(4, '0').toLowerCase()).join(':')}::/64`;
}

module.exports = { FailureGuard, addressBucket };
