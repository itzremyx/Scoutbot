const { createCanvas, loadImage } = require('@napi-rs/canvas');

const W = 900;
const H = 340;
const FONT = '22px Consolas, "Cascadia Mono", "Courier New", monospace';
const TEXT_FONT = '20px Consolas, "Cascadia Mono", "Courier New", monospace';
const SMALL_FONT = '16px Consolas, "Cascadia Mono", "Courier New", monospace';

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

// Simple vector marks inspired by each model family. They are drawn here, not copies of official logos.
function drawClaude(ctx, x, y, r, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = r * 0.22;
  ctx.lineCap = 'round';
  for (let i = 0; i < 8; i += 1) {
    const a = (i * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * r * 0.25, y + Math.sin(a) * r * 0.25);
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    ctx.stroke();
  }
}

function drawGpt(ctx, x, y, r, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = r * 0.16;
  ctx.beginPath();
  for (let i = 0; i < 6; i += 1) {
    const a = (i * Math.PI) / 3;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
  ctx.stroke();
}

function drawGemini(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawGrok(ctx, x, y, r, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = r * 0.28;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - r * 0.8, y - r * 0.8);
  ctx.lineTo(x + r * 0.8, y + r * 0.8);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + r * 0.8, y - r * 0.8);
  ctx.lineTo(x - r * 0.5, y + r * 0.9);
  ctx.stroke();
}

function drawMuse(ctx, x, y, r, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = r * 0.2;
  for (const k of [1, 0.66, 0.33]) {
    ctx.beginPath();
    ctx.arc(x, y, r * k, 0, Math.PI * 1.5);
    ctx.stroke();
  }
}

const THEMES = {
  claude: { label: 'Claude', accent: '#d97757', glyph: drawClaude },
  gpt: { label: 'GPT', accent: '#10a37f', glyph: drawGpt },
  gemini: { label: 'Gemini', accent: '#4f8cff', glyph: drawGemini },
  grok: { label: 'Grok', accent: '#e6e6e6', glyph: drawGrok },
  muse: { label: 'Muse', accent: '#ff6ad5', glyph: drawMuse },
};

const THEME_CHOICES = Object.entries(THEMES).map(([value, theme]) => ({ name: theme.label, value }));

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Draws [text, color] pieces one after another on the same line.
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

// "2h 14m", "45m" or "3h" — voice time as hours and minutes.
function formatDuration(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours}h ${rest}m`;
  if (hours) return `${hours}h`;
  return `${rest}m`;
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

// Renders a code-editor style card and returns PNG bytes. The avatar is only kept in memory.
async function renderRankCard({ username, avatarUrl, themeId, level, xp, floor, next, rank, messages = 0, voiceMs = 0 }) {
  const theme = THEMES[themeId] ?? THEMES.claude;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  roundRect(ctx, 0, 0, W, H, 22);
  ctx.fillStyle = '#1e1e1e';
  ctx.fill();

  // Title bar with traffic lights, a "rank.ts" tab and the model theme on the right.
  ctx.save();
  roundRect(ctx, 0, 0, W, H, 22);
  ctx.clip();
  ctx.fillStyle = '#252526';
  ctx.fillRect(0, 0, W, 44);
  ctx.restore();

  for (const [color, x] of [['#ff5f57', 24], ['#febc2e', 44], ['#28c840', 64]]) {
    ctx.beginPath();
    ctx.arc(x, 22, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(84, 0, 170, 44);
  ctx.fillStyle = theme.accent;
  ctx.fillRect(84, 0, 170, 2);
  ctx.font = SMALL_FONT;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#cccccc';
  ctx.fillText('rank.ts', 104, 28);
  ctx.textAlign = 'right';
  ctx.fillStyle = theme.accent;
  ctx.fillText(theme.label, W - 44, 28);
  theme.glyph(ctx, W - 24, 22, 9, theme.accent);

  // Code body: a line-numbered gutter with the member's stats written as constants.
  const lines = [
    [['// Scoutcode Rank Card', SYNTAX.comment]],
    [['const', SYNTAX.keyword], [' user', SYNTAX.name], [' = ', SYNTAX.punct], [JSON.stringify(shorten(username, 20)), SYNTAX.string], [';', SYNTAX.punct]],
    [['const', SYNTAX.keyword], [' level', SYNTAX.name], [' = ', SYNTAX.punct], [String(level), SYNTAX.number], [';', SYNTAX.punct]],
    [['const', SYNTAX.keyword], [' xp', SYNTAX.name], [' = ', SYNTAX.punct], [String(xp), SYNTAX.number], [';', SYNTAX.punct]],
    [['const', SYNTAX.keyword], [' nextLevel', SYNTAX.name], [' = ', SYNTAX.punct], [String(next), SYNTAX.number], [';', SYNTAX.punct]],
    [['const', SYNTAX.keyword], [' rank', SYNTAX.name], [' = ', SYNTAX.punct], [JSON.stringify(`#${rank}`), SYNTAX.string], [';', SYNTAX.punct]],
    [['const', SYNTAX.keyword], [' messages', SYNTAX.name], [' = ', SYNTAX.punct], [String(messages), SYNTAX.number], [';', SYNTAX.punct]],
    [['const', SYNTAX.keyword], [' voiceTime', SYNTAX.name], [' = ', SYNTAX.punct], [JSON.stringify(formatDuration(voiceMs)), SYNTAX.string], [';', SYNTAX.punct]],
  ];
  lines.forEach((tokens, i) => {
    const y = 96 + i * 30;
    ctx.font = FONT;
    ctx.textAlign = 'right';
    ctx.fillStyle = SYNTAX.gutter;
    ctx.fillText(String(i + 1), 64, y);
    drawTokens(ctx, 92, y, tokens);
  });

  // Progress bar toward the next level.
  const span = Math.max(1, next - floor);
  const fraction = Math.min(1, Math.max(0, (xp - floor) / span));
  const barX = 92;
  const barY = 310;
  const barW = 470;
  const barH = 14;
  roundRect(ctx, barX, barY, barW, barH, 7);
  ctx.fillStyle = '#3c3c3c';
  ctx.fill();
  roundRect(ctx, barX, barY, Math.max(barH, barW * fraction), barH, 7);
  ctx.fillStyle = theme.accent;
  ctx.fill();
  ctx.font = SMALL_FONT;
  ctx.textAlign = 'left';
  ctx.fillStyle = SYNTAX.gutter;
  ctx.fillText(`${Math.floor(fraction * 100)}%`, barX + barW + 16, barY + 12);

  // Avatar on the right, with the username, level and server rank below it.
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
  ctx.fillText(`Level ${level} | #${rank}`, cx, 248);

  return canvas.encode('png');
}

module.exports = { renderRankCard, THEME_CHOICES, formatDuration };
