// Posts new ScoutCode commits to the changelog channel, and a new CHANGELOG version to the update channel.
// Watches the public repo's main branch every minute. The last announced commit and version are kept in
// store.settings.updates so a restart does not repost anything. When nothing was ever announced (fresh
// start, or the watcher came online after the last push) the current head is posted once, so the channels
// are never left empty.
const { Events, EmbedBuilder } = require('discord.js');
const config = require('./config');
const store = require('./storage');
const { truncate } = require('./utils');

const REPO = 'gentraxyz/scoutcode';
const BRANCH = 'main';
const CHECK_EVERY_MS = 60_000;
const MAX_COMMITS_PER_RUN = 10;
const SCOUTCODE_ICON = 'https://github.com/gentraxyz.png';

const state = () => (store.data.settings.updates ??= { repo: null, lastSha: null, announced: 0 });

// GitHub allows 60 unauthenticated requests an hour. The last ETag is sent back so an unchanged branch
// answers 304, which does not count against that limit.
let commitsEtag = null;

// Latest commits on main, newest first. Returns null when nothing changed since the last check.
async function fetchCommits() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/commits?sha=${BRANCH}&per_page=${MAX_COMMITS_PER_RUN}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Scoutbot',
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
    githubAuthor: commit.author?.login ?? null,
    authorUrl: commit.author?.html_url ?? null,
    avatarUrl: commit.author?.avatar_url ?? null,
    date: commit.commit.author?.date ?? commit.commit.committer?.date ?? null,
  };
}

async function fetchCommitDetails(sha) {
  try {
    const response = await fetch('https://api.github.com/repos/' + REPO + '/commits/' + sha, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Scoutbot' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function enrichCommit(commit) {
  const parsed = parseCommit(commit);
  const detail = await fetchCommitDetails(parsed.sha);
  const author = detail?.author ?? commit.author;
  return {
    ...parsed,
    githubAuthor: author?.login ?? parsed.githubAuthor,
    authorUrl: author?.html_url ?? parsed.authorUrl,
    avatarUrl: author?.avatar_url ?? parsed.avatarUrl,
    filesChanged: Array.isArray(detail?.files) ? detail.files.length : null,
    additions: Number.isFinite(detail?.stats?.additions) ? detail.stats.additions : null,
    deletions: Number.isFinite(detail?.stats?.deletions) ? detail.stats.deletions : null,
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
  return {
    version: match[1].trim(),
    body: match[2].trim(),
    url: 'https://github.com/' + REPO + '/blob/' + BRANCH + '/CHANGELOG.md',
  };
}

function commitEmbed(commit) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: 'ScoutCode  •  Commit', url: commit.url, iconURL: SCOUTCODE_ICON })
    .setTitle('✨  ' + truncate(commit.subject, 240))
    .setURL(commit.url)
    .setDescription(commit.body ? truncate(commit.body, 900) : 'A new change has landed in ScoutCode.')
    .addFields(
      { name: 'Commit', value: '[' + commit.short + '](' + commit.url + ')', inline: true },
      { name: 'Branch', value: '`' + BRANCH + '`', inline: true },
      { name: 'Modified by', value: commit.githubAuthor && commit.authorUrl ? '[' + truncate(commit.githubAuthor, 80) + '](' + commit.authorUrl + ')' : truncate(commit.author, 1024), inline: true },
    )
    .setFooter({ text: 'ScoutCode  •  GitHub commit' })
    .setThumbnail(SCOUTCODE_ICON);
  if (commit.avatarUrl) embed.setAuthor({ name: 'ScoutCode  -  Commit', url: commit.url, iconURL: commit.avatarUrl });
  if (commit.filesChanged !== null && commit.filesChanged !== undefined) {
    embed.addFields({ name: 'Changes', value: '`' + commit.filesChanged + ' file(s) • +' + (commit.additions ?? 0) + ' / -' + (commit.deletions ?? 0) + '`', inline: true });
  }
  if (commit.date && !Number.isNaN(Date.parse(commit.date))) embed.setTimestamp(new Date(commit.date));
  return embed;
}

function releaseEmbed(log) {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setAuthor({ name: 'ScoutCode  •  Release', url: log.url, iconURL: SCOUTCODE_ICON })
    .setTitle('🚀  ' + truncate(log.version, 240))
    .setURL(log.url)
    .setDescription(truncate(log.body || 'A new ScoutCode release is available.', 3800))
    .addFields(
      { name: 'Status', value: '✅ Published', inline: true },
      { name: 'Branch', value: '`' + BRANCH + '`', inline: true },
      { name: 'Changelog', value: '[View on GitHub](' + log.url + ')', inline: true },
    )
    .setFooter({ text: 'ScoutCode  •  Release notes' })
    .setThumbnail(SCOUTCODE_ICON)
    .setTimestamp();
  return embed;
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
  // If the watched repo changed (or first run), start fresh so a sha from another repo is never
  // replayed or left unexplained.
  if (s.repo !== REPO) {
    s.repo = REPO;
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
  for (const commit of await Promise.all(toPost.map(enrichCommit))) {
    // State only moves after a successful post: a failed send is retried next check.
    const ok = await postTo(client, config.changelogChannelId, commitEmbed(commit));
    if (!ok) break;
    s.lastSha = commit.sha;
    s.announced += 1;
    posted += 1;
    store.save();
  }

  // A new version in CHANGELOG.md goes to the update channel, once per version.
  if (log && log.version !== s.lastChangelog) {
    const ok = await postTo(client, config.updateChannelId, releaseEmbed(log));
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
    console.log(`Updates: watching ${REPO} (${BRANCH}) every ${CHECK_EVERY_MS / 1000}s`);
    tick();
    setInterval(tick, CHECK_EVERY_MS);
  });
}

module.exports = { register, checkOnce, parseCommit, latestChangelog, commitEmbed, releaseEmbed };
