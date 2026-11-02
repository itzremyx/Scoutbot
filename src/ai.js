const config = require('./config');
const store = require('./storage');
const memory = require('./memory');
const budget = require('./budget');
const { SCOUTCODE, SUPPORT_FOCUS } = require('./knowledge');

const MAX_HISTORY = 20; // messages kept per channel (about 10 exchanges)

const EXTRACT_PROMPT = [
  'You extract long-term memory notes about a Discord user from one chat exchange.',
  'Keep only durable facts about the user that will still matter later: name or nickname, preferences, languages, projects, hobbies, or anything they explicitly ask you to remember.',
  'Ignore small talk, one-off questions, requests and anything about other people.',
  'You are given the facts already known about the user, each with an id. If the exchange makes one of them outdated (they moved, changed job, changed their mind), return the new fact with "replaces" set to that id. If it only makes one false, return an empty "text" with "replaces" set to its id. Otherwise set "replaces" to null.',
  'Reply with ONLY a JSON array of objects, e.g. [{"text": "Lives in Lyon", "replaces": 3}, {"text": "Is learning Rust", "replaces": null}]. Reply [] if there is nothing worth keeping.',
].join('\n');

function getPersonality() {
  return store.data.settings.personality || config.defaultPersonality;
}

function conversation(channelId) {
  return (store.data.conversations[channelId] ??= []);
}

function systemPrompt(botName, speaker, userId, guildId) {
  const lines = [
    `Your name is ${botName}. You are a Discord bot.`,
    `Your owner is ${config.owner.name}. If anyone asks who owns or made you, say it is ${config.owner.name}.`,
    `Personality (stay in character at all times): ${getPersonality()}`,
    'Always reply in English, even if the user writes in another language.',
    'Messages from users are prefixed with the speaker\'s name, like "Name: message". Never add that prefix to your own replies.',
    'Keep answers focused and under 1500 characters unless asked for more detail.',
    'If you are not sure of an answer or do not know it, say so plainly instead of guessing. Never invent facts about the user, the server or the outside world.',
    ...SUPPORT_FOCUS,
    'What you know about ScoutCode:',
    ...SCOUTCODE.map((fact) => `- ${fact}`),
  ];

  // Server rules from administrators: always applied in this server.
  const instructions = guildId ? memory.getInstructions(guildId) : [];
  if (instructions.length) {
    lines.push('Instructions from this server\'s administrators. Always follow them:');
    lines.push(...instructions.map((item) => `- ${item.text}`));
  }

  const facts = memory.getFacts(userId);
  if (facts.length) {
    lines.push(`Things you remember about ${speaker} from earlier conversations:`);
    lines.push(...facts.map((fact) => `- ${fact.text}`));
    lines.push('Use these naturally when they are relevant. Do not recite the list unless asked.');
  }
  return lines.join('\n');
}

// Model in use: /botstats ai model overrides AI_MODEL from the .env file, and it survives restarts.
function activeModel() {
  return store.data.settings.aiModel || config.ai.model;
}

// fetch reports connection problems as TypeError("fetch failed") and hides the real reason in
// cause. Returns a user-facing message, or null when this is not a connection problem.
function connectionProblem(err) {
  if (err.name !== 'TypeError' || !/fetch failed/i.test(err.message)) return null;
  const detail = err.cause?.code;
  return `Could not reach the AI server${detail ? ` (${detail})` : ''}. It looks like a connection problem, try again in a moment.`;
}

// A dropped connection is often momentary: retry once before giving up. The timeout signal is shared,
// so the total wait stays within the configured limit.
async function fetchWithRetry(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!connectionProblem(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return fetch(url, init);
  }
}

// Tools the model can call. web_search goes through the ScoutCode server (same key as the chat).
const TOOLS = [{
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current or external information. Use it for anything that may have changed, or that is not about ScoutCode itself. Returns titles, URLs, dates and short excerpts.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, in plain words' },
        num_results: { type: 'integer', description: '1-5, default 5' },
      },
      required: ['query'],
    },
  },
}];
const TOOL_LABELS = { web_search: (args) => `Browsing the internet for "${args.query ?? '…'}"…` };
const MAX_TOOL_ROUNDS = 4;

// Runs one tool call and returns the text the model reads back.
async function runTool(name, args) {
  if (name !== 'web_search') throw new Error(`Unknown tool ${name}`);
  const query = String(args.query ?? '').trim();
  if (!query) return 'No query given.';
  const count = Math.min(5, Math.max(1, Math.trunc(Number(args.num_results) || 5)));
  const response = await fetchWithRetry(`${config.ai.baseUrl}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.apiKey}` },
    body: JSON.stringify({ query, num_results: count, highlights: true }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) return `Search failed (${response.status}). Answer without it.`;
  const data = await response.json().catch(() => ({}));
  const results = data.results ?? [];
  if (!results.length) return `No results for "${query}".`;
  return results.map((r, i) => [
    `${i + 1}. ${r.title || '(no title)'}`,
    `   ${r.url}`,
    r.published_date ? `   Published ${String(r.published_date).slice(0, 10)}` : null,
    ...(r.highlights ?? []).map((h) => `   > ${String(h).split(/\s+/).join(' ')}`),
  ].filter(Boolean).join('\n')).join('\n');
}

// Calls the chat API. MiniMax-M3.1-Flash always thinks, and its thinking counts toward the token limit.
// With tools, the model may call them; each call is run, reported through onProgress, and sent back
// until the model answers in text.
async function callModel(system, messages, { maxTokens = config.ai.maxTokens, effort = config.ai.reasoningEffort, model = activeModel(), tools = null, onProgress = () => {} } = {}) {
  if (!config.ai.apiKey) {
    throw new Error('The AI is not configured. Set AI_API_KEY in the .env file.');
  }
  budget.assertAvailable();

  const conversationMessages = [...messages];
  const ask = async (modelName, withTools) => {
    const payload = {
      model: modelName,
      max_completion_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...conversationMessages],
    };
    if (effort) payload.reasoning_effort = effort;
    if (withTools) payload.tools = tools;

    let response;
    try {
      response = await fetchWithRetry(`${config.ai.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.ai.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.ai.timeoutMs),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`The AI took too long to answer (over ${Math.round(config.ai.timeoutMs / 1000)}s). Try a simpler question.`);
      }
      const problem = connectionProblem(err);
      if (problem) throw new Error(problem);
      throw err;
    }
    const data = await response.json().catch(() => ({}));
    return { response, data, payload };
  };

  let activeModelName = model;
  for (let round = 0; ; round++) {
    // Once tool rounds are used up, ask for a plain answer so the loop always ends.
    const useTools = tools && round < MAX_TOOL_ROUNDS;
    let { response, data, payload } = await ask(activeModelName, useTools);

    // 400/404 means the model itself was rejected (renamed or removed): retry once with the fallback.
    if ((response.status === 400 || response.status === 404) && activeModelName !== config.ai.fallbackModel) {
      activeModelName = config.ai.fallbackModel;
      ({ response, data, payload } = await ask(activeModelName, useTools));
    }

    if (!response.ok) {
      const reason = data.error?.message ?? data.base_resp?.status_msg ?? response.statusText;
      throw new Error(`AI request failed (${response.status}): ${reason}`);
    }

    // Count tokens from the API's usage report. If it is missing, estimate about 4 characters per token.
    const replyLength = data.choices?.[0]?.message?.content?.length ?? 0;
    budget.record(data.usage?.total_tokens ?? Math.ceil((JSON.stringify(payload).length + replyLength) / 4));

    const choice = data.choices?.[0];
    const calls = useTools ? choice?.message?.tool_calls ?? [] : [];
    if (calls.length) {
      // Keep the assistant turn with its tool calls, then answer each call so the model can continue.
      conversationMessages.push(choice.message);
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* keep empty args */ }
        onProgress(TOOL_LABELS[call.function?.name]?.(args) ?? `Running ${call.function?.name}…`);
        let result;
        try {
          result = await runTool(call.function?.name, args);
        } catch (err) {
          result = `Tool failed: ${err.message}`;
        }
        conversationMessages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      continue;
    }

    // Drop an inline <think> block if the provider puts one in the content.
    const text = choice?.message?.content?.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!text) {
      if (choice?.finish_reason === 'length') {
        throw new Error('The AI ran out of room before answering. Try a shorter question.');
      }
      throw new Error('The AI returned an empty answer.');
    }
    return text;
  }
}

// Turns the model's reply into fact updates: { text, replaces } where replaces is the id of an
// outdated fact (or null). Invalid output gives an empty list.
function parseFacts(raw) {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const items = JSON.parse(match[0]);
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => {
        if (typeof item === 'string') return { text: item, replaces: null };
        if (!item || typeof item !== 'object') return null;
        const text = typeof item.text === 'string' && item.text.trim() ? item.text : null;
        const replaces = Number.isInteger(item.replaces) ? item.replaces : null;
        return text || replaces !== null ? { text, replaces } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const INSTRUCTION_PROMPT = [
  'An administrator of a Discord server is talking to the bot.',
  'If the message asks the bot to keep a standing rule or behaviour for this server (for example "always answer in English" or "remember that our staff meeting is on Friday"), reply with ONLY that rule, written as one short English instruction for the bot.',
  'If it is a one-off question, a greeting or small talk, reply with ONLY the word NONE.',
].join('\n');

// Turns an admin message into a server rule, or null when it is not a standing instruction.
async function extractInstruction(text) {
  const raw = await callModel(INSTRUCTION_PROMPT, [{ role: 'user', content: text }], { maxTokens: 512, effort: 'low' });
  const rule = raw.replace(/^["'\s]+|["'\s]+$/g, '');
  return !rule || /^none\.?$/i.test(rule) ? null : rule;
}

// Runs after each reply in the background. New facts are queued for a server admin to approve;
// they only go live after approval. Outside a server there is no admin, so nothing is learned.
// Failures are ignored.
async function learnFromExchange(guildId, userId, speaker, question, answer) {
  if (!guildId) return;
  try {
    const known = memory.getFacts(userId).map((fact) => `[id ${fact.id}] ${fact.text}`);
    const raw = await callModel(
      EXTRACT_PROMPT,
      [{
        role: 'user',
        content: `Known facts about ${speaker}:\n${known.length ? known.join('\n') : '(none)'}\n\n${speaker} said: ${question}\nYou replied: ${answer}`,
      }],
      { maxTokens: 1024, effort: 'low' },
    );
    for (const update of parseFacts(raw)) {
      memory.addPendingFact(guildId, userId, update.text, update.replaces);
    }
  } catch (err) {
    console.error('Memory update skipped:', err.message);
  }
}

// Answers one question, using the channel's saved chat history and what the bot knows about the user.
// onProgress(text) is called before each step so the caller can show what the bot is doing.
async function chat({ channelId, guildId, botName, userId, speaker, question, onProgress = () => {} }) {
  budget.checkCooldown(userId);
  const history = conversation(channelId);
  const userMessage = { role: 'user', content: `${speaker}: ${question}` };
  onProgress('Thinking about your question…');
  const answer = await callModel(systemPrompt(botName, speaker, userId, guildId), [...history, userMessage], {
    tools: TOOLS,
    onProgress,
  });

  history.push(userMessage, { role: 'assistant', content: answer });
  history.splice(0, Math.max(0, history.length - MAX_HISTORY));
  while (history[0]?.role === 'assistant') history.shift(); // history must start with a user message
  store.save();

  void learnFromExchange(guildId, userId, speaker, question, answer);
  return answer;
}

// Generates images from a text prompt. Uses its own daily cap and endpoint/key (the chat
// endpoint may not expose /image_generation).
// Returns { images: Buffer[], failed } where failed is the count blocked by content safety.
async function generateImages({ userId, prompt, ratio, count = 1 }) {
  if (!config.ai.imageApiKey) {
    throw new Error('Image generation is not configured. Set AI_IMAGE_API_KEY in the .env file.');
  }
  budget.checkCooldown(userId);
  budget.assertImagesAvailable();

  const n = Math.max(1, Math.trunc(count));
  if (!budget.canGenerateImages(n)) {
    throw new Error(`Only ${budget.imagesLeft()} image(s) left today. Try fewer images.`);
  }

  const payload = {
    model: config.ai.imageModel,
    prompt: prompt.slice(0, 1500), // the API rejects longer prompts
    aspect_ratio: ratio,
    response_format: 'base64', // urls expire after 24h; base64 is sent straight to Discord
    n,
    prompt_optimizer: true,
  };

  let response;
  try {
    response = await fetchWithRetry(`${config.ai.imageBaseUrl}/image_generation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.imageApiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.ai.imageTimeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Image generation took too long (over ${Math.round(config.ai.imageTimeoutMs / 1000)}s). Try again.`);
    }
    const problem = connectionProblem(err);
    if (problem) throw new Error(problem.replace('the AI server', 'the image server'));
    throw err;
  }

  const data = await response.json().catch(() => ({}));
  const status = data.base_resp?.status_code;
  if (!response.ok || (status !== undefined && status !== 0)) {
    const reason = data.base_resp?.status_msg ?? data.error?.message ?? response.statusText;
    if (status === 1026) throw new Error('Content safety blocked that prompt. Try a different one.');
    if (status === 1008) throw new Error('The account has insufficient balance for image generation.');
    if (response.status === 404) {
      throw new Error(`No image endpoint at ${config.ai.imageBaseUrl}/image_generation (404). Check AI_IMAGE_BASE_URL in the .env file.`);
    }
    throw new Error(`Image generation failed (${status ?? response.status}): ${reason}`);
  }

  budget.recordImages(n);

  const images = (data.data?.image_base64 ?? [])
    .map((b64) => Buffer.from(b64, 'base64'))
    .filter((buffer) => buffer.length > 0);
  const failed = Number(data.metadata?.failed_count ?? 0) || 0;
  if (!images.length) {
    throw new Error(
      failed
        ? 'All generated images were blocked by content safety. Try a different prompt.'
        : 'No image was returned. Try again.',
    );
  }
  return { images, failed };
}

function resetConversation(channelId) {
  delete store.data.conversations[channelId];
  store.save();
}

module.exports = { chat, generateImages, extractInstruction, activeModel, getPersonality, parseFacts, resetConversation };
