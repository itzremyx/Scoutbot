const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { drawEditorFrame, THEMES } = require('./rankcard');

const W = 900;
const H = 340;
const FONT = '22px Consolas, "Cascadia Mono", "Courier New", monospace';
const TEXT_FONT = '20px Consolas, "Cascadia Mono", "Courier New", monospace';

const SYNTAX = {
  keyword: '#569cd6',
  name: '#9cdcfe',
  punct: '#d4d4d4',
  string: '#ce9178',
  number: '#b5cea8',
  comment: '#6a9955',
  gutter: '#858585',
  text: '#d4d4d4',
};

// Same chrome and themes as the rank card, so the welcome reads as a level-up in the same family.
function drawTokens(ctx, x, y, tokens) {
  ctx.font = FONT;
  ctx.textAlign = 'left';
  for (const [text, color] of tokens) {
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    x += ctx.measureText(text).width;
  }
}

const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function formatDate(ms) {
  if (!ms) return 'unknown';
  return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function loadAvatar(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

// Welcome card for a member who joined: member, member count, join date. Same frame as rank.ts.
async function renderWelcomeCard({ username, avatarUrl, themeId, memberCount, joinDate, invitedBy = null }) {
  const theme = THEMES[themeId] ?? THEMES.claude;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  drawEditorFrame(ctx, W, H, 'welcome.ts', theme);

  const inviterValue = invitedBy
    ? [JSON.stringify(`${shorten(invitedBy.tag, 16)} (${invitedBy.count})`), SYNTAX.string]
    : ['null', SYNTAX.keyword];
  const lines = [
    [['// Scoutcode Welcome', SYNTAX.comment]],
    [['const', SYNTAX.keyword], [' member', SYNTAX.name], [' = ', SYNTAX.punct], [JSON.stringify(shorten(username, 20)), SYNTAX.string], [';', SYNTAX.punct]],
    [['const', SYNTAX.keyword], [' memberCount', SYNTAX.name], [' = ', SYNTAX.punct], [String(memberCount ?? 0), SYNTAX.number], [';', SYNTAX.punct]],
    [['const', SYNTAX.keyword], [' joined', SYNTAX.name], [' = ', SYNTAX.punct], [JSON.stringify(formatDate(joinDate)), SYNTAX.string], [';', SYNTAX.punct]],
    [['const', SYNTAX.keyword], [' invitedBy', SYNTAX.name], [' = ', SYNTAX.punct], inviterValue, [';', SYNTAX.punct]],
  ];
  lines.forEach((tokens, i) => {
    const y = 104 + i * 30;
    ctx.font = FONT;
    ctx.textAlign = 'right';
    ctx.fillStyle = SYNTAX.gutter;
    ctx.fillText(String(i + 1), 64, y);
    drawTokens(ctx, 92, y, tokens);
  });

  // Avatar on the right, like the rank card.
  const cx = 748;
  const cy = 124;
  const r = 56;
  const avatar = await loadAvatar(avatarUrl);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (avatar) {
    ctx.drawImage(avatar, cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = theme.accent;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.font = '48px Consolas, "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#1e1e1e';
    ctx.fillText((username[0] ?? '?').toUpperCase(), cx, cy + 16);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.font = TEXT_FONT;
  ctx.textAlign = 'center';
  ctx.fillStyle = SYNTAX.text;
  ctx.fillText(shorten(username, 14), cx, 218);
  ctx.fillStyle = theme.accent;
  ctx.fillText(`Member #${memberCount ?? 0}`, cx, 248);

  return canvas.encode('png');
}

module.exports = { renderWelcomeCard };
