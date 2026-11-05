const { Events, EmbedBuilder } = require('discord.js');
const config = require('./config');
const store = require('./storage');
const { truncate } = require('./utils');

const REPO = 'itzremyx/Scoutbot';
const BRANCH = 'master';
const CHECK_EVERY_MS = 60_000;
const MAX_COMMITS_PER_RUN = 10;
const REPO_ICON = 'https://github.com/itzremyx.png';

const state = () => (store.data.settings.botRepo ??= {
  repo: null,
  branch: null,
  lastSha: null,
  announced: 0,
});

let commitsEtag = null;

async function fetchCommits() {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/commits?sha=${BRANCH}&per_page=${MAX_COMMITS_PER_RUN}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Scoutbot',
        ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}),
        ...(commitsEtag ? { 'If-None-Match': commitsEtag } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (response.status === 304) return null;
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`GitHub 404 for ${REPO}. The repository may be private; set GITHUB_TOKEN with repository read access.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`GitHub ${response.status} for ${REPO}. Check GITHUB_TOKEN permissions and rate limits.`);
    }
    throw new Error(`GitHub ${response.status} for ${REPO}`);
  }
  commitsEtag = response.headers.get('etag');
  return response.json();
}

function newCommits(list, lastSha) {
  const fresh = [];
  for (const commit of list) {
    if (commit.sha === lastSha) break;
    fresh.push(commit);
  }
  return fresh.reverse();
}

function parseCommit(commit) {
  const [subject, ...rest] = commit.commit.message.split('\n');
  return {
    sha: commit.sha,
    short: commit.sha.slice(0, 7),
    subject: subject.trim(),
    body: rest.filter((line) => !/^Co-Authored-By:/i.test(line)).join('\n').trim(),
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
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Scoutbot',
        ...(config.githubToken ? { Authorization: 'Bearer ' + config.githubToken } : {}),
      },
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

function commitEmbed(commit) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: 'ScoutBot  •  Commit', url: commit.url, iconURL: REPO_ICON })
    .setTitle('✨  ' + truncate(commit.subject, 240))
    .setURL(commit.url)
    .setDescription(commit.body ? truncate(commit.body, 900) : 'A new change has landed in ScoutBot.')
    .addFields(
      { name: 'Commit', value: `[${commit.short}](${commit.url})`, inline: true },
      { name: 'Branch', value: `\`${BRANCH}\``, inline: true },
      { name: 'Modified by', value: commit.githubAuthor && commit.authorUrl ? '[' + truncate(commit.githubAuthor, 80) + '](' + commit.authorUrl + ')' : truncate(commit.author, 1024), inline: true },
    )
    .setFooter({ text: 'ScoutBot  •  GitHub commit' })
    .setThumbnail(REPO_ICON);
  if (commit.avatarUrl) embed.setAuthor({ name: 'ScoutBot  -  Commit', url: commit.url, iconURL: commit.avatarUrl });
  if (commit.filesChanged !== null && commit.filesChanged !== undefined) {
    embed.addFields({ name: 'Changes', value: '`' + commit.filesChanged + ' file(s) • +' + (commit.additions ?? 0) + ' / -' + (commit.deletions ?? 0) + '`', inline: true });
  }
  if (commit.date && !Number.isNaN(Date.parse(commit.date))) embed.setTimestamp(new Date(commit.date));
  return embed;
}

async function postTo(client, embed) {
  const channelId = config.botRepoChannelId;
  if (!channelId) {
    console.error('BotRepo: no channel id configured');
    return false;
  }
  const channel = await client.channels.fetch(channelId).catch((err) => {
    console.error(`BotRepo: cannot open channel ${channelId}: ${err.message}`);
    return null;
  });
  if (!channel?.isTextBased()) {
    console.error(`BotRepo: channel ${channelId} is missing or is not a text channel`);
    return false;
  }
  const sent = await channel.send({ embeds: [embed] }).catch((err) => {
    console.error(`BotRepo: sending update to ${channelId} failed: ${err.message}`);
    return null;
  });
  if (sent) console.log(`BotRepo: posted update to channel ${channelId}`);
  return Boolean(sent);
}

async function checkOnce(client) {
  const current = state();
  if (current.repo !== REPO || current.branch !== BRANCH) {
    current.repo = REPO;
    current.branch = BRANCH;
    current.lastSha = null;
    current.announced = 0;
    commitsEtag = null;
    store.save();
  }

  const list = await fetchCommits();
  const firstRun = !current.lastSha;
  if (firstRun) {
    if (!list?.length) return 0;
    // Keep the first-run behavior useful: announce the current head once instead of
    // silently consuming it as a baseline. Later checks only announce newer commits.
    current.lastSha = list[0].sha;
    store.save();
  }

  let posted = 0;
  const fresh = list ? newCommits(list, current.lastSha) : [];
  const baseline = (current.announced ?? 0) === 0;
  const toPost = fresh.length ? fresh : (baseline && list?.length ? [list[0]] : []);
  for (const commit of await Promise.all(toPost.map(enrichCommit))) {
    if (!await postTo(client, commitEmbed(commit))) break;
    current.lastSha = commit.sha;
    current.announced += 1;
    posted += 1;
    store.save();
  }
  return posted;
}

function register(client) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await checkOnce(client);
    } catch (err) {
      console.error('BotRepo check failed:', err.message);
    } finally {
      running = false;
    }
  };
  client.once(Events.ClientReady, () => {
    console.log(`BotRepo: watching ${REPO} (${BRANCH}) every ${CHECK_EVERY_MS / 1000}s`);
    tick();
    setInterval(tick, CHECK_EVERY_MS);
  });
}

// Public helper used by /changelog: the newest commits on the branch, enriched with the
// GitHub author, avatar and file statistics.
async function recentCommits(count = 10) {
  const list = await fetchCommits();
  if (!list?.length) return [];
  return list.slice(0, Math.max(1, count)).map(enrichCommit);
}

module.exports = { register, checkOnce, parseCommit, commitEmbed, newCommits, recentCommits };
