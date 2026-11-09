const { test } = require('node:test');
const assert = require('node:assert');

const antiphish = require('../src/antiphish');
const metrics = require('../src/metrics');
const stats = require('../src/stats');

test('antiphish.detect flags known phishing hosts', () => {
  assert.ok(antiphish.detect('Claim your free nitro at https://discord-nitro-gift.com/x'));
  assert.ok(antiphish.detect('steam gift here www.steamgift.example'));
});

test('antiphish.detect flags shortened scam links', () => {
  assert.ok(antiphish.detect('free robux -> https://bit.ly/abc123'));
  assert.ok(antiphish.detect('nitro drop https://tinyurl.com/xyz'));
});

test('antiphish.detect leaves ordinary links alone', () => {
  assert.strictEqual(antiphish.detect('Read the docs at https://discord.js.org/docs'), null);
  assert.strictEqual(antiphish.detect('hello everyone, how are you?'), null);
});

test('antiphish.extractLinks normalizes hosts', () => {
  const links = antiphish.extractLinks('see https://www.Example.com/a and discord.gg/abc');
  assert.deepStrictEqual(links.map((link) => link.host), ['example.com', 'discord.gg']);
});

test('metrics.bucketize reduces long histories and keeps the newest timestamp', () => {
  const points = Array.from({ length: 1000 }, (_, i) => ({ t: i, ping: i, rss: 10, tokens: i, calls: 0, members: 1, tickets: 0 }));
  const out = metrics.bucketize(points, 120);
  assert.ok(out.length <= 120 && out.length > 0);
  assert.strictEqual(out[out.length - 1].t, 999);
});

test('stats.weekStart returns a Monday', () => {
  const start = new Date(stats.weekStart(new Date('2026-11-09T15:00:00Z')) + 'T00:00:00Z');
  assert.strictEqual(start.getUTCDay(), 1);
  assert.strictEqual(start.toISOString().slice(0, 10), '2026-11-09');
});
