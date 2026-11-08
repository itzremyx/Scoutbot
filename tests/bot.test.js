const { test } = require('node:test');
const assert = require('node:assert');

const botrepo = require('../src/botrepo');
const updates = require('../src/updates');
const errors = require('../src/errors');
const help = require('../src/help');

// Latest-first input (as GitHub returns them): [newest, ... , oldest].
function makeList(count) {
  const list = [];
  for (let i = 0; i < count; i++) {
    list.push({
      sha: 'a'.repeat(40).slice(0, 39) + String.fromCharCode(97 + i),
      commit: {
        message: `Subject ${i}

Body line ${i}

Co-Authored-By: Example Person`,
        author: { name: `Dev${i}` },
      },
      html_url: 'https://github.com/acme/repo/commit/x',
    });
  }
  return list;
}

test('botrepo.newCommits returns newest-first commits after lastSha', () => {
  const list = makeList(4);
  const lastSha = list[2].sha; // index 3 is the oldest after breaking at lastSha
  const fresh = botrepo.newCommits(list, lastSha);
  // list[0], list[1] are newer than lastSha; the loop breaks at list[2].
  assert.deepStrictEqual(fresh.map((c) => c.sha), [list[1].sha, list[0].sha]);
  assert.strictEqual(botrepo.newCommits(list, list[0].sha).length, 0);
});



test('parseCommit splits subject/body and drops Co-Authored-By trailers', () => {
  const commit = makeList(1)[0];
  const parsed = botrepo.parseCommit(commit);
  assert.strictEqual(parsed.subject, 'Subject 0');
  assert.strictEqual(parsed.short, commit.sha.slice(0, 7));
  assert.strictEqual(parsed.author, 'Dev0');
  assert.ok(!/Co-Authored-By/i.test(parsed.body), 'co-author trailer must be dropped');
  assert.strictEqual(parsed.githubAuthor, null);
});

test('botrepo.parseAtom reads the commit Atom feed like the REST API', () => {
  const xml = [
    '<feed>',
    '<entry><id>tag:github.com,2008:Grit::Commit/' + 'b'.repeat(40) + '</id>',
    '<updated>2026-11-07T21:44:29Z</updated>',
    '<author><name></name><email>dev@example.com</email></author>',
    '<content type="html">&lt;pre&gt;Only analyze images when the bot is addressed&lt;/pre&gt;</content></entry>',
    '<entry><id>tag:github.com,2008:Grit::Commit/' + 'a'.repeat(40) + '</id>',
    '<updated>2026-11-07T21:37:05Z</updated>',
    '<content type="html">&lt;pre&gt;Fix &amp;amp; ship&lt;/pre&gt;</content></entry>',
    '</feed>',
  ].join('');
  const list = botrepo.parseAtom(xml);
  assert.strictEqual(list.length, 2);
  const parsed = botrepo.parseCommit(list[0]);
  assert.strictEqual(parsed.short, 'b'.repeat(7));
  assert.strictEqual(parsed.subject, 'Only analyze images when the bot is addressed');
  assert.ok(parsed.url.endsWith('b'.repeat(40)));
  assert.strictEqual(botrepo.parseCommit(list[1]).subject, 'Fix & ship');
  // newest first, like the REST API, so newCommits keeps working on either source
  assert.deepStrictEqual(botrepo.newCommits(list, 'a'.repeat(40)).map((c) => c.sha), ['b'.repeat(40)]);
});

test('updates.parseCommit matches botrepo.parseCommit shape', () => {
  const commit = makeList(1)[0];
  const p = updates.parseCommit(commit);
  assert.strictEqual(p.subject, 'Subject 0');
  assert.ok(p.url);
});

test('botrepo.commitEmbed builds a styled embed', () => {
  const base = botrepo.parseCommit(makeList(1)[0]);
  const commit = { ...base, githubAuthor: 'dev0', authorUrl: 'https://github.com/dev0' };
  const embed = botrepo.commitEmbed(commit);
  const data = embed.data;
  assert.strictEqual(typeof data.color, 'number');
  assert.ok(data.title.includes('Subject 0'));
  assert.ok(data.fields.some((f) => f.name === 'Commit'));
  assert.ok(data.thumbnail?.url);
});

test('updates.commitEmbed has commit and branch fields', () => {
  const commit = updates.parseCommit(makeList(1)[0]);
  const embed = updates.commitEmbed(commit);
  const names = embed.data.fields.map((f) => f.name);
  assert.ok(names.includes('Commit'));
  assert.ok(names.includes('Branch'));
});

test('errors.clip normalizes whitespace and truncates', () => {
  const long = 'a '.repeat(500);
  const clipped = errors.clip(long, 100);
  assert.strictEqual(clipped.length, 100);
  assert.ok(clipped.endsWith('…'));
  assert.strictEqual(errors.clip('  hello   world  '), 'hello world');
  assert.strictEqual(errors.clip(null), 'Unknown error');
});

test('visibleCategories lists the new commands in their categories', () => {
  const commands = [
    { data: { name: 'changelog', toJSON: () => ({ name: 'changelog', options: [] }) } },
    { data: { name: 'download', toJSON: () => ({ name: 'download', options: [] }) } },
    { data: { name: 'role', toJSON: () => ({ name: 'role', options: [] }) } },
    { data: { name: 'help', toJSON: () => ({ name: 'help', options: [] }) } },
    { data: { name: 'botstats', toJSON: () => ({ name: 'botstats', options: [] }) } },
  ];
  const cats = help.visibleCategories(commands, true);
  const names = cats.reduce((acc, c) => acc.concat(c.items.map((i) => i.data.name)), []);
  assert.ok(names.includes('changelog'));
  assert.ok(names.includes('download'));
  assert.ok(names.includes('role'));
});

test('helpPayload is ephemeral and provides categories in English by default', () => {
  const commands = [
    { data: { name: 'changelog', toJSON: () => ({ name: 'changelog', options: [] }) } },
    { data: { name: 'download', toJSON: () => ({ name: 'download', options: [] }) } },
    { data: { name: 'role', toJSON: () => ({ name: 'role', options: [] }) } },
  ];
  const payload = help.helpPayload(commands, true, 'en');
  assert.strictEqual(payload.flags, 64);
  assert.strictEqual(payload.embeds.length, 1);
  assert.ok(payload.components.length >= 1);
});

test('link command has valid name, description, and required code option', () => {
  const link = require('../src/commands/link');
  assert.ok(link.data);
  assert.strictEqual(link.data.name, 'link');
  const json = link.data.toJSON();
  assert.strictEqual(json.name, 'link');
  const codeOpt = json.options.find((o) => o.name === 'code');
  assert.ok(codeOpt);
  assert.strictEqual(codeOpt.required, true);
});
