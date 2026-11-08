const config = require('./config');

// Words that are very common in English and rare as the bulk of another language, so a short
// message containing one is treated as already English. Deliberately small: a false "not English"
// only adds a redundant translation line, while a false "English" hides one.
const ENGLISH = /\b(the|and|you|your|this|that|with|for|from|have|what|when|where|why|how|are|was|were|not|don't|just|please|thanks|hello|hey)\b/i;

// Anything outside Latin script (accents included) is not English. A one or two word message is
// too short to judge, so it is left alone rather than translated on a guess.
function likelyEnglish(text) {
  const source = String(text || '').trim();
  if (/[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{S}\p{M}]/u.test(source)) return false;
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length < 3) return true;
  return ENGLISH.test(source);
}

function clean(value) {
  return String(value || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

// One cheap, tool-free call to the AI endpoint. Returns null when the model is unreachable or
// hands the text back unchanged.
async function translateText(text, target = 'English') {
  const source = String(text || '').trim();
  if (!source || !config.ai.apiKey) return null;
  try {
    const response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.apiKey}` },
      body: JSON.stringify({
        model: config.ai.fallbackModel || config.ai.model,
        max_completion_tokens: 800,
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: `Translate the user message into ${target}. Return only the translation, with no quotes or commentary. If it is already in ${target}, return it unchanged.` },
          { role: 'user', content: source.slice(0, 3000) },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    const translated = clean(data.choices?.[0]?.message?.content);
    return translated || null;
  } catch {
    return null;
  }
}

// Kept for chat.js: it only translates when the message looks foreign, so an English reply never
// gets a redundant translation line.
async function translateToEnglish(text) {
  const source = String(text || '').trim();
  if (!source || likelyEnglish(source) || !config.ai.apiKey) return null;
  const translated = await translateText(source, 'English');
  if (!translated || translated.toLowerCase() === source.toLowerCase()) return null;
  return translated;
}

module.exports = { likelyEnglish, translateText, translateToEnglish };
