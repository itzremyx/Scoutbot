// Set before any require so the tests never read or write the real data/store.json.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const testStore = path.join(os.tmpdir(), `scout-digest-test-${process.pid}.json`);
process.env.SCOUT_DATA_FILE = testStore;

const { test } = require('node:test');
const assert = require('node:assert');

const { configFor, postDigest, ACTION_LABEL } = require('../src/digest');

const FAKE_GUILD = 'digest-test-guild';
const FAKE_CHANNEL = '1566492359460659260';

// A text channel that captures everything sent to it.
function channelStub() {
  return {
    isTextBased: () => true,
    async send(payload) {
      channelStub.lastPayload = payload;
      return { id: 'sent-1' };
    },
  };
}
channelStub.lastPayload = null;

function guildStub(id) {
  const channel = channelStub();
  return {
    id,
    memberCount: 10,
    client: {
      channels: { cache: new Map([[FAKE_CHANNEL, channel]]) },
    },
    _channel: channel,
  };
}

test('digest config defaults to the configured channel', () => {
  const cfg = configFor(FAKE_GUILD);
  assert.strictEqual(cfg.channelId, FAKE_CHANNEL);
});

test('postDigest sends an embed with members, joins, leaves and top inviters', async () => {
  const store = require('../src/storage');
  const g = store.guild(FAKE_GUILD);
  g.joins = 3;
  g.leaves = 1;
  g.invites = {
    inviter1: { regular: 5, leaves: 1 },
    inviter2: { regular: 2, leaves: 0 },
  };
  g.modlog = { nextId: 1, entries: [{ id: 1, action: 'kick', userId: 'u1', at: Date.now() }] };
  g.levels = { users: { p1: { xp: 900 }, p2: { xp: 700 } } };

  const guild = guildStub(FAKE_GUILD);
  const sent = await postDigest(guild);
  assert.ok(sent, 'postDigest returns the sent message');

  const payload = channelStub.lastPayload;
  assert.ok(payload?.embeds?.[0], 'sends an embed');
  const desc = payload.embeds[0].data.description;
  assert.ok(desc.includes('**Members:** 10'), 'mentions member count');
  assert.ok(desc.includes('**Joined this week:** 3'), 'mentions joins');
  assert.ok(desc.includes('**Left this week:** 1'), 'mentions leaves');
  assert.ok(desc.includes('Top inviters'), 'mentions top inviters');
  assert.ok(desc.includes('<@inviter1>'), 'mentions the best inviter');
  assert.ok(desc.includes('Kicks: 1'), 'summarizes moderation');
  assert.ok(desc.includes('Top XP'), 'mentions XP leaders');

  // Posting again in the same window is prevented by runDigest, not postDigest,
  // but the last-post timestamp must have been saved.
  assert.ok(configFor(FAKE_GUILD).lastPostedAt > 0, 'records lastPostedAt');
});

test('ACTION_LABEL covers every moderation action used in the digest', () => {
  for (const action of ['warn', 'automod', 'kick', 'ban', 'timeout']) {
    assert.ok(ACTION_LABEL[action], `missing label for ${action}`);
  }
});

test.after(() => {
  try { fs.unlinkSync(testStore); } catch {}
});
