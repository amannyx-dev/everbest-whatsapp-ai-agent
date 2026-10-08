'use strict';
const { sleep: defaultSleep } = require('./util');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const SAFE_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];

function cleanModelText(raw) {
  let text = String(raw ?? '').trim();
  text = text.replace(/^```(?:text|markdown)?\s*|\s*```$/gi, '').trim();
  return text;
}

function parseReply(raw) {
  let text = cleanModelText(raw);

  // Backward-compatible JSON parsing for older learned/configured prompts. The new
  // generation path never requests provider-side JSON, so a JSON validation failure
  // can no longer be the normal failure mode.
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && ('action' in obj || 'reply' in obj)) {
      if (String(obj.action || '').toLowerCase() === 'skip') {
        return { type: 'skip', reason: String(obj.reason || 'model chose not to answer').slice(0, 240) };
      }
      const reply = String(obj.reply || '').trim();
      const question = String(obj.question || '').trim();
      if (!reply) return { type: 'empty' };
      if (isAiLanguage(reply)) return { type: 'skip', reason: 'AI-style language' };
      return {
        type: 'reply',
        text: clipReply(reply),
        question: cleanQuestion(question),
        confidence: Number.isFinite(Number(obj.confidence)) ? Math.max(0, Math.min(100, Number(obj.confidence))) : undefined
      };
    }
  } catch {
    // Plain-text contract below is the primary path.
  }

  const tagged = text.match(/^\s*(?:REPLY|ANSWER)\s*:\s*([\s\S]*?)(?:\n\s*(?:QUESTION|FOLLOW[- ]?UP)\s*:\s*([\s\S]*))?$/i);
  if (tagged) {
    const reply = stripQuotes(tagged[1]);
    const question = cleanQuestion(stripQuotes(tagged[2] || ''));
    if (!reply) return { type: 'empty' };
    if (/^\[\s*SKIP\s*\]/i.test(reply)) return { type: 'skip', reason: reply.replace(/^\[\s*SKIP\s*\]\s*/i, '').slice(0, 240) };
    if (isAiLanguage(reply)) return { type: 'skip', reason: 'AI-style language' };
    return question ? { type: 'reply', text: clipReply(reply), question } : { type: 'reply', text: clipReply(reply) };
  }

  const skip = text.match(/^\[\s*SKIP\s*\]\s*[-:–]?\s*([\s\S]*)$/i);
  if (skip) return { type: 'skip', reason: skip[1].trim().slice(0, 240) };

  const marker = text.split(/\s*\[\[QUESTION\]\]\s*/i);
  if (marker.length > 1) {
    const reply = stripQuotes(marker.shift());
    const question = cleanQuestion(marker.join(' '));
    if (!reply) return { type: 'empty' };
    if (isAiLanguage(reply)) return { type: 'skip', reason: 'AI-style language' };
    return question ? { type: 'reply', text: clipReply(reply), question } : { type: 'reply', text: clipReply(reply) };
  }

  text = text.replace(/^(?:you|me|owner|reply|response)\s*:\s*/i, '').trim();
  text = stripQuotes(text);
  if (!text) return { type: 'empty' };
  if (isAiLanguage(text)) return { type: 'skip', reason: 'AI-style language' };
  return { type: 'reply', text: clipReply(text) };
}

function stripQuotes(text) {
  const value = String(text || '').trim();
  if (value.length > 1 && /^['"“‘]/.test(value) && /['"”’]$/.test(value)) return value.slice(1, -1).trim();
  return value;
}

function cleanQuestion(text) {
  const q = stripQuotes(text);
  return /[?؟]$/.test(q) ? q.slice(0, 300) : '';
}

function clipReply(text) {
  const value = String(text || '').trim();
  if (value.length <= 500) return value;
  return `${value.slice(0, 500).replace(/\s+\S*$/, '')}…`;
}

function isAiLanguage(text) {
  return /\b(as an ai|as a language model|language model|chatbot|ai assistant|automated account|artificial intelligence)\b/i.test(String(text || ''));
}

function describeError(err) {
  const status = err?.response?.status;
  const apiMessage = err?.response?.data?.error?.message;
  let message;
  if (status === 401 || status === 403) message = `Groq rejected the API key (HTTP ${status}). Fix groqApiKey in config.json or GROQ_API_KEY.`;
  else if (status === 429) message = 'Groq rate limit reached (HTTP 429). The bot will use its fallback model/backoff.';
  else if (status) message = `Groq returned HTTP ${status}${apiMessage ? `: ${apiMessage}` : ''}`;
  else message = err?.message || 'Unknown error while contacting Groq';
  const out = new Error(message);
  out.fatal = status === 401 || status === 403;
  out.status = status;
  return out;
}

function retryDelay(err, attempt) {
  const header = Number(err?.response?.headers?.['retry-after']);
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 8000);
  return Math.min(600 * 2 ** attempt, 5000);
}

function modelCandidates(config) {
  return [...new Set([config.model, config.fallbackModel, ...SAFE_MODELS].filter(Boolean).map(String))];
}

async function requestReply({ http, config, system, messages, sleep = defaultSleep }) {
  const models = modelCandidates(config);
  let lastErr = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const body = {
        model,
        max_completion_tokens: Number(config.maxCompletionTokens) || 360,
        temperature: Number.isFinite(Number(config.naturalnessTemperature)) ? Number(config.naturalnessTemperature) : 0.25,
        messages: [
          { role: 'system', content: String(system || 'Answer the current WhatsApp message naturally and concisely.') },
          ...(Array.isArray(messages) ? messages : [])
        ]
      };

      if (/^openai\/gpt-oss-(20b|120b)$/.test(model)) {
        body.reasoning_effort = config.reasoningEffort || 'medium';
        body.include_reasoning = false;
      }

      const res = await http.post(GROQ_URL, body, {
        headers: { Authorization: `Bearer ${config.groqApiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000
      });
      const content = res?.data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error(`Groq returned an empty response from ${model}`);
      return content.trim();
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      if (status === 401 || status === 403) throw describeError(err);
      const retryable = status === 404 || status === 408 || status === 409 || status === 429 || status === 422 || (status >= 500 && status <= 599) || !status;
      if (!retryable) throw describeError(err);
      if (i < models.length - 1) await sleep(retryDelay(err, i));
    }
  }

  throw describeError(lastErr);
}

async function requestFollowUpQuestion({ http, config, context, styleSummary = '', sleep = defaultSleep }) {
  const system = `You are choosing a natural follow-up question for a WhatsApp conversation.
Return ONLY one question ending in ? or the exact token [NONE].
Base the question on the CURRENT MESSAGE and normal conversation logic only.
Do not use old owner replies as content or answer evidence.
Do not invent personal facts.
Never ask filler like "aur batao?", "what about you?", or a random topic.
Only ask if the question genuinely continues the current topic.
Owner texting style (style only): ${String(styleSummary || 'casual, concise')}`;
  const raw = await requestReply({
    http,
    config,
    system,
    messages: [{ role: 'user', content: String(context || '') }],
    sleep
  });
  const q = cleanQuestion(raw.replace(/^\[NONE\]$/i, ''));
  return /^\[NONE\]$/i.test(raw.trim()) ? '' : q;
}

async function repairReply({ http, config, original, system, messages, reasons, sleep = defaultSleep }) {
  const repairSystem = `${String(system || '')}

QUALITY CONTROL:
Rewrite the draft below so it answers the CURRENT MESSAGE correctly.
Fix only these problems: ${reasons.join(', ')}.
Do not add facts that are not supported by the current message or ordinary general knowledge.
Return ONLY the final WhatsApp reply text. No JSON. No labels. No explanation.
DRAFT: ${String(original || '')}`;
  return requestReply({ http, config, system: repairSystem, messages, sleep });
}

async function transcribeAudio({ http, config, buffer, mimeType = 'audio/ogg', fileName = 'voice.ogg' }) {
  if (!buffer || !buffer.length) return '';
  if (buffer.length > Number(config.maxAudioBytes || 25 * 1024 * 1024)) throw new Error('Voice note is larger than the configured audio limit.');
  const form = new FormData();
  const blob = new Blob([buffer], { type: mimeType || 'audio/ogg' });
  form.append('file', blob, fileName);
  form.append('model', config.transcriptionModel || 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (config.transcriptionLanguage) form.append('language', config.transcriptionLanguage);
  const res = await http.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
    headers: { Authorization: `Bearer ${config.groqApiKey}` },
    timeout: 30000,
    maxBodyLength: Number(config.maxAudioBytes || 25 * 1024 * 1024) + 1024 * 1024
  });
  return String(res?.data?.text || '').trim();
}

module.exports = { parseReply, requestReply, requestFollowUpQuestion, repairReply, describeError, GROQ_URL, SAFE_MODELS, modelCandidates, transcribeAudio };
