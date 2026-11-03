// Posts new Scoutbot commits to the changelog channel, and a new ScoutCode CHANGELOG version to the update channel.
// Watches the bot's own (private) repo every minute, so pushes made from this workspace show up in Discord.
// The last announced commit and version are kept in store.settings.updates so a restart does not repost
// anything. When nothing was ever announced (fresh start, or the watcher came online after the last push)
// the current head is posted once, so the channels are never left empty.
const { Events } = require('discord.js');
const config = require('./config');
const store = require('./storage');
const { makeEmbed, truncate } = require('./utils');

const COMMITS_REPO = 'itzremyx/Scoutbot'; // private: needs GITHUB_TOKEN in .env
const COMMITS_BRANCH = 'master';
const CHANGELOG_REPO = 'gentraxyz/scoutcode'; // public: product versions in CHANGELOG.md
const CHECK_EVERY_MS = 60_000;
const MAX_COMMITS_PER_RUN = 10;

const state = () => (store.data.settings.updates ??= { repo: null, lastSha: null, announced: 0 });

// The last ETag is sent back so an unchanged branch answers 304 and avoids unnecessary API work.
let commitsEtag = null;

// Latest commits on the watched branch, newest first. Returns null when nothing changed since the last check.
async function fetchCommits() {
  const response = await fetch(`https://api.github.com/repos/${COMMITS_REPO}/commits?sha=${COMMITS_BRANCH}&per_page=${MAX_COMMITS_PER_RUN}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Scoutbot',
      // The repo is private, so the API needs a token; the ETag still saves rate limit when nothing changed.
      ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}),
      ...(commitsEtag ? { 'If-None-Match': commitsEtag } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 304) return null;
  if (!response.ok) throw new Error(`GitHub ${response.status} for commits`);
  commitsEtag = response.headers.get('etag');
  return response.json();
}

// Commits newer than lastSha, oldest first.
function newCommits(list, lastSha) {
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
  const response = await fetch(`https://raw.githubusercontent.com/${CHANGELOG_REPO}/main/CHANGELOG.md`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;
  const text = await response.text();
  const match = text.match(/^## (.+)\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m);
  if (!match) return null;
  return { version: match[1].trim(), body: match[2].trim() };
}

// Returns true only when the message was really sent, so the caller retries instead of silently losing a
// post. Every outcome is logged: an empty channel should never be a mystery.
async function postTo(client, channelId, embed) {
  if (!channelId) {
    console.error('Updates: no channel id configured');
    return false;
  }
  const title = embed.data?.title ?? 'update';
  const channel = await client.channels.fetch(channelId).catch((err) => {
    console.error(`Updates: cannot open channel ${channelId}: ${err.message}`);
    return null;
  });
  if (!channel?.isTextBased()) {
    console.error(`Updates: channel ${channelId} is missing or is not a text channel`);
    return false;
  }
  const sent = await channel.send({ embeds: [embed] }).catch((err) => {
    console.error(`Updates: sending "${title}" to ${channelId} failed: ${err.message}`);
    return null;
  });
  if (sent) console.log(`Updates: posted "${title}" to channel ${channelId}`);
  return Boolean(sent);
}

// Runs one check. Returns how many commits were announced.
async function checkOnce(client) {
  const s = state();
  // The watch target may have changed (or this is the first run): start fresh and announce the current
  // head once instead of replaying the old repo's history or staying silent forever.
  if (s.repo !== COMMITS_REPO) {
    s.repo = COMMITS_REPO;
    s.lastSha = null;
    s.announced = 0;
    commitsEtag = null;
    store.save();
  }
  const list = await fetchCommits();
  const log = await latestChangelog().catch(() => null);

  // First run: remember where we are so only later commits count as new.
  if (!s.lastSha) {
    if (!list?.length) return 0;
    s.lastSha = list[0].sha;
    store.save();
  }

  // Nothing has ever been announced: post the current head once so the channels are not empty.
  // `announced` stops it from repeating on later checks and restarts.
  const baseline = s.announced === 0;
  const fresh = list ? newCommits(list, s.lastSha) : [];
  const toPost = fresh.length ? fresh : (baseline && list?.length ? [list[0]] : []);

  let posted = 0;
  for (const commit of toPost.map(parseCommit)) {
    const lines = [`\`${commit.short}\` ${commit.subject}`];
    if (commit.body) lines.push('', truncate(commit.body, 800));
    lines.push('', `[View commit](${commit.url}) · by ${commit.author}`);
    // State only moves after a successful post: a failed send is retried next check.
    const ok = await postTo(client, config.changelogChannelId, makeEmbed('info', 'Commit', lines.join('\n')));
    if (!ok) break;
    s.lastSha = commit.sha;
    s.announced += 1;
    posted += 1;
    store.save();
  }

  // A new version in CHANGELOG.md goes to the update channel, once per version.
  if (log && log.version !== s.lastChangelog) {
    const ok = await postTo(client, config.updateChannelId, makeEmbed('success', `Update ${log.version}`, truncate(log.body || 'No details.', 3800)));
    if (ok) {
      s.lastChangelog = log.version;
      store.save();
    }
  }
  return posted;
}

function register(client) {
  let running = false;
  const tick = async () => {
    if (running) return; // a slow check must not overlap the next one
    running = true;
    try {
      await checkOnce(client);
    } catch (err) {
      console.error('Update check failed:', err.message);
    } finally {
      running = false;
    }
  };
  client.once(Events.ClientReady, () => {
    console.log(`Updates: watching ${COMMITS_REPO} (${COMMITS_BRANCH}) every ${CHECK_EVERY_MS / 1000}s`);
    tick();
    setInterval(tick, CHECK_EVERY_MS);
  });
}

module.exports = { register, checkOnce, parseCommit, latestChangelog };
