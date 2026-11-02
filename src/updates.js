// Posts new ScoutCode commits to the update channel, and CHANGELOG entries to the changelog channel.
// Watches the public repo's main branch. The last announced commit is kept in store.settings.updates so a
// restart does not repost anything. The first run only records the current head: it never floods a channel
// with the repo's existing history.
const { Events } = require('discord.js');
const config = require('./config');
const store = require('./storage');
const { makeEmbed, truncate } = require('./utils');

const REPO = 'gentraxyz/scoutcode';
const BRANCH = 'main';
const CHECK_EVERY_MS = 10 * 60_000;
const MAX_COMMITS_PER_RUN = 10;

const state = () => (store.data.settings.updates ??= { lastSha: null, announced: 0 });

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Scoutbot' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`);
  return response.json();
}

// Commits on main newer than lastSha, oldest first. Returns [] when nothing is new.
async function newCommits(lastSha) {
  const list = await github(`/commits?sha=${BRANCH}&per_page=${MAX_COMMITS_PER_RUN}`);
  const fresh = [];
  for (const commit of list) {
    if (commit.sha === lastSha) break;
    fresh.push(commit);
  }
  return fresh.reverse();
}

// First line is the subject; the rest is the body. Co-author trailers are dropped.
function parseCommit(commit) {
  const [subject, ...rest] = commit.commit.message.split('\n');
  const body = rest
    .filter((line) => !/^Co-Authored-By:/i.test(line))
    .join('\n')
    .trim();
  return {
    sha: commit.sha,
    short: commit.sha.slice(0, 7),
    subject: subject.trim(),
    body,
    url: commit.html_url,
    author: commit.commit.author?.name ?? 'unknown',
  };
}

// Latest version section of CHANGELOG.md (## <version> ...), or null.
async function latestChangelog() {
  const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/CHANGELOG.md`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;
  const text = await response.text();
  const match = text.match(/^## (.+)\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m);
  if (!match) return null;
  return { version: match[1].trim(), body: match[2].trim() };
}

async function postTo(client, channelId, embed) {
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({ embeds: [embed] }).catch((err) => console.error('Update post failed:', err.message));
}

// Runs one check. Returns how many commits were announced.
async function checkOnce(client) {
  const s = state();
  const head = await github(`/commits/${BRANCH}`);

  // First run: remember where we are, announce nothing.
  if (!s.lastSha) {
    s.lastSha = head.sha;
    store.save();
    return 0;
  }

  const fresh = await newCommits(s.lastSha);
  if (!fresh.length) return 0;

  for (const commit of fresh.map(parseCommit)) {
    const lines = [`\`${commit.short}\` ${commit.subject}`];
    if (commit.body) lines.push('', truncate(commit.body, 800));
    lines.push('', `[View commit](${commit.url}) · by ${commit.author}`);
    await postTo(client, config.updateChannelId, makeEmbed('info', 'Update', lines.join('\n')));
    s.lastSha = commit.sha;
    s.announced += 1;
    store.save();
  }

  // The changelog channel gets the latest CHANGELOG section, once per version.
  const log = await latestChangelog().catch(() => null);
  if (log && log.version !== s.lastChangelog) {
    await postTo(client, config.changelogChannelId, makeEmbed('success', `Changelog ${log.version}`, truncate(log.body || 'No details.', 3800)));
    s.lastChangelog = log.version;
    store.save();
  }
  return fresh.length;
}

function register(client) {
  const tick = () => checkOnce(client).catch((err) => console.error('Update check failed:', err.message));
  client.once(Events.ClientReady, () => {
    tick();
    setInterval(tick, CHECK_EVERY_MS);
  });
}

module.exports = { register, checkOnce, parseCommit, latestChangelog };
