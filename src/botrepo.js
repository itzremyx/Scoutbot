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
let localGit = null;
let githubAuth = true;

// Reads the bot's own checkout with git so a private repo still gets its changelog without a
// GitHub token. Falls back to the GitHub API only when git is unavailable and a token is set.
const { execFile } = require('child_process');
const path = require('path');
const REPO_ROOT = path.join(__dirname, '..');

function localCommit(entry) {
  const parts = entry.split('\u001f');
  const sha = parts[0];
  const authorDate = parts[1];
  const authorName = parts[2];
  const subject = parts[3] || '';
  const body = parts.slice(4).join('\u001f');
  const newline = String.fromCharCode(10);
  return {
    sha,
    html_url: 'https://github.com/' + REPO + '/commit/' + sha,
    commit: {
      message: body ? subject + newline + newline + body : subject,
      author: { name: authorName || 'unknown', date: authorDate || null },
      committer: { date: authorDate || null },
    },
  };
}

async function fetchCommits() {
  // Prefer the local checkout. Skip it after one failure so a container without git stays quiet.
  if (localGit !== false) try {
    const format = '%H%x1f%aI%x1f%an%x1f%s%x1f%b%x1e';
    const stdout = await new Promise((resolve, reject) => {
      execFile('git', ['log', BRANCH, '-n' + MAX_COMMITS_PER_RUN, '--pretty=format:' + format], {
        cwd: REPO_ROOT,
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      }, (error, out) => (error ? reject(error) : resolve(out)));
    });
    localGit = true;
    return String(stdout).split('\u001e').map((entry) => entry.trim()).filter(Boolean).map(localCommit);
  } catch (err) {
    localGit = false;
    console.warn('BotRepo: local git log unavailable; using the public GitHub API');
  }

  // The repo is public, so a token is optional. A bad token makes GitHub answer 401 even for a
  // public repo, which is worse than sending no token at all.
  const response = await fetch(
    'https://api.github.com/repos/' + REPO + '/commits?sha=' + BRANCH + '&per_page=' + MAX_COMMITS_PER_RUN,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Scoutbot',
        ...(githubAuth && config.githubToken ? { Authorization: 'Bearer ' + config.githubToken } : {}),
        ...(commitsEtag ? { 'If-None-Match': commitsEtag } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if ((response.status === 401 || response.status === 403) && config.githubToken) {
    githubAuth = false;
    console.warn('BotRepo: GitHub token was rejected; reading the public repo without it');
    const open = await fetch(
      'https://api.github.com/repos/' + REPO + '/commits?sha=' + BRANCH + '&per_page=' + MAX_COMMITS_PER_RUN,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Scoutbot' },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!open.ok) throw new Error('GitHub ' + open.status + ' for ' + REPO);
    return open.json();
  }
  if (response.status === 304) return null;
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('GitHub 404 for ' + REPO + '. The repository may be private; set GITHUB_TOKEN with repository read access.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('GitHub ' + response.status + ' for ' + REPO + '. Check GITHUB_TOKEN permissions and rate limits.');
    }
    throw new Error('GitHub ' + response.status + ' for ' + REPO);
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
        ...(githubAuth && config.githubToken ? { Authorization: 'Bearer ' + config.githubToken } : {}),
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

async function channelOf(client) {
  const channelId = config.botRepoChannelId;
  if (!channelId) {
    console.error('BotRepo: no channel id configured');
    return null;
  }
  const channel = await client.channels.fetch(channelId).catch((err) => {
    console.error('BotRepo: cannot open channel ' + channelId + ': ' + err.message);
    return null;
  });
  if (!channel?.isTextBased()) {
    console.error('BotRepo: channel ' + channelId + ' is missing or is not a text channel');
    return null;
  }
  return channel;
}

// A deploy restarts the process right after the push. The send can reach Discord and still be
// lost here if the process dies before store.save(). A commit already in the channel counts as posted.
async function alreadyPosted(channel, sha) {
  const short = String(sha || '').slice(0, 7);
  if (!short || !channel.messages?.fetch) return false;
  const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
  if (!recent) return false;
  const me = channel.client.user?.id;
  return recent.some((message) => message.author?.id === me && message.embeds?.some((embed) => {
    const bits = [embed.url, embed.description, ...(embed.fields || []).map((field) => field.value)];
    return bits.some((bit) => String(bit || '').includes(short));
  }));
}

async function postTo(client, embed, sha) {
  const channel = await channelOf(client);
  if (!channel) return false;
  if (await alreadyPosted(channel, sha)) {
    console.log('BotRepo: commit ' + String(sha).slice(0, 7) + ' is already in the channel');
    return true;
  }
  const sent = await channel.send({ embeds: [embed] }).catch((err) => {
    console.error('BotRepo: sending update to ' + channel.id + ' failed: ' + err.message);
    return null;
  });
  if (sent) console.log('BotRepo: posted update to channel ' + channel.id);
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
  if (!list?.length) return 0;

  // First sight of this repo: remember the head without replaying history.
  // A brand-new install (announced === 0) still posts that head once, below.
  // announced counts attempts; delivered counts messages Discord accepted.
  // A restart can save the sha and still leave the channel empty, so repost the gap.
  // Old state counted attempts before Discord confirmed them. Replay once, but do not
  // advance lastSha until the sends below succeed.
  const replayUndelivered = (current.delivered ?? 0) < (current.announced ?? 0);
  if (replayUndelivered) current.lastSha = null;

  if (!current.lastSha) {
    current.lastSha = list[0].sha;
    if (!replayUndelivered) store.save();
  }

  let posted = 0;
  const fresh = newCommits(list, current.lastSha);
  const baseline = (current.announced ?? 0) === 0;
  const replayCount = Math.max(0, (current.announced ?? 0) - (current.delivered ?? 0));
  const toPost = fresh.length ? fresh : (replayUndelivered ? list.slice(0, replayCount) : (baseline ? [list[0]] : []));

  // Remember the newest sha before sending. Deploy restarts this process as soon as the
  // commit lands, often while Discord is still accepting the message. Saving first keeps the
  // next boot from announcing it again; alreadyPosted covers a send that arrived but died
  // before this save.
  if (fresh.length && !replayUndelivered) {
    current.lastSha = fresh[0].sha;
    store.save();
  }

  for (const commit of await Promise.all(toPost.map(enrichCommit))) {
    if (!await postTo(client, commitEmbed(commit), commit.sha)) break;
    current.announced += 1;
    current.delivered = current.announced;
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
  return Promise.all(list.slice(0, Math.max(1, count)).map(enrichCommit));
}

module.exports = { register, checkOnce, parseCommit, commitEmbed, newCommits, recentCommits };
