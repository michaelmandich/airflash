'use strict';

// The brute-force guard behind the access key and share-link checks (src/core/guard.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { FailureGuard, addressBucket } = require('../src/core/guard');

test('more than max failures inside the window → blocked for banMs; the window forgets old ones', () => {
  const g = new FailureGuard({ max: 3, windowMs: 1000, banMs: 5000 });
  let now = 10_000;
  for (let i = 0; i < 3; i++) assert.equal(g.fail('a', now += 10), 0);
  assert.equal(g.blockedFor('a', now), 0, 'three is allowed');
  assert.equal(g.fail('a', now += 10), 5000, 'the fourth crosses the line');
  assert.equal(g.blockedFor('a', now + 4999), 1, 'still blocked');
  assert.equal(g.blockedFor('a', now + 5000), 0, 'and free again');
  assert.equal(g.blockedFor('b', now), 0, 'others are unaffected');
  // Spread out, the same failures never add up.
  const slow = new FailureGuard({ max: 3, windowMs: 1000, banMs: 5000 });
  for (let i = 0; i < 10; i++) assert.equal(slow.fail('a', i * 600), 0, `failure ${i}`);
  slow.sweep(20_000);
  assert.equal(slow.size, 0, 'the sweeper drops quiet entries');
});

test('the map is capped: a client rotating addresses evicts the oldest entries, never grows the map', () => {
  const g = new FailureGuard({ max: 20, windowMs: 60_000, banMs: 60_000, maxEntries: 100 });
  for (let i = 0; i < 1000; i++) g.fail(`203.0.${i >> 8}.${i & 255}`, i);
  assert.equal(g.size, 100);
  assert.equal(g.entries.has('203.0.0.0'), false, 'the oldest went first');
  assert.equal(g.entries.has('203.0.3.231'), true, 'the newest stayed');
  // A failure re-inserts, so an active entry is never the one evicted.
  g.fail('203.0.3.132', 2000);
  for (let i = 0; i < 99; i++) g.fail(`192.0.2.${i}`, 3000 + i);
  assert.equal(g.entries.has('203.0.3.132'), true);
  assert.equal(g.size, 100);
});

test('addressBucket: IPv4 as is, IPv6 by /64, mapped IPv4 unwrapped, junk in one bucket', () => {
  assert.equal(addressBucket('203.0.113.7'), '203.0.113.7');
  assert.equal(addressBucket('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(addressBucket('2001:db8:1:2::1'), '2001:0db8:0001:0002::/64');
  assert.equal(addressBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:0db8:0001:0002::/64');
  assert.equal(addressBucket('2001:DB8:1:2::9'), '2001:0db8:0001:0002::/64', 'case does not split a bucket');
  assert.equal(addressBucket('2001:db8::1'), '2001:0db8:0000:0000::/64');
  assert.equal(addressBucket('::1'), '0000:0000:0000:0000::/64');
  assert.equal(addressBucket('fe80::1%eth0'), 'fe80:0000:0000:0000::/64', 'zone ids are dropped');
  assert.equal(addressBucket('64:ff9b::192.0.2.33'), '0064:ff9b:0000:0000::/64', 'an embedded IPv4 counts as two groups');
  assert.equal(addressBucket('1:2:3:4:5:6:7:8'), '0001:0002:0003:0004::/64');
  assert.equal(addressBucket('not an ip'), 'invalid');
  assert.equal(addressBucket(''), 'invalid');
  assert.equal(addressBucket('2001:db8:1:2::1'), addressBucket('2001:db8:1:2::2'));
  assert.notEqual(addressBucket('2001:db8:1:2::1'), addressBucket('2001:db8:1:3::1'));
});
