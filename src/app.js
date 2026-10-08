'use strict';
const fs = require('fs');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { analyzeStyle } = require('./style');
const { analyzeContact } = require('./contact');
const { buildSystemPrompt } = require('./prompt');
const { requestReply, requestFollowUpQuestion, parseReply } = require('./llm');
const {
  isPersonalChat,
  numberOf,
  shouldReplyTo,
  parseQuietHours,
  inQuietHours,
  RateLimiter,
  parseCommand
} = require('./rules');
const { sleep: defaultSleep, randInt, toNumber, clip } = require('./util');
const { classify, chooseQuestion, shouldSkipDuplicate, normalize } = require('./intelligence');
const { buildBrain, validateReply } = require('./brain');
const { Telemetry } = require('./telemetry');
const { createDashboard } = require('./dashboard');

const HOUR = 60 * 60 * 1000;
const CONTEXT_MAX_AGE = 90 * 24 * HOUR; // keep a month of active context, with long-term chat memory as fallback

const DISCONNECT_HINTS = {
  405: 'WhatsApp rejected the connection. The library version may be outdated, or the network is blocking WhatsApp. Try: npm install @whiskeysockets/baileys@latest',
  408: 'The connection timed out. Check your internet connection, firewall and VPN.',
  428: 'The connection was cut before WhatsApp finished the handshake. This usually means the network is blocking or interrupting WebSocket connections (campus, office or public Wi-Fi, VPN, proxy, antivirus web protection). The connection check below shows whether that is the case.',
  440: 'This WhatsApp session was opened somewhere else. Close any other running copy of the bot.',
  500: 'The saved login is corrupted. Run RELINK.bat (or "npm run relink") to log in again.',
  503: 'WhatsApp servers are temporarily unavailable. Retrying automatically.'
};

const HELP_TEXT = [
  'Bot commands (send them in this chat):',
  '/bot on - turn auto-replies on',
  '/bot off - turn auto-replies off',
  '/bot mute <minutes> - pause auto-replies for a while',
  '/bot status - show what the bot has learned',
  '/bot metrics - runtime AI/reliability metrics',
  '/bot dashboard - open the local portfolio control center',
  '/bot forget confirm - erase everything it learned'
].join('\n');

// Connection profiles. When the first one keeps failing, the bot switches to the simpler one automatically.
const PROFILES = [
  { name: 'desktop', build: (b) => ({ browser: b.Browsers.macOS('Desktop'), syncFullHistory: true }) },
  { name: 'compatibility', build: (b) => ({ browser: b.Browsers.ubuntu('Chrome'), syncFullHistory: true }) }
];

/**
 * Creates the bot. Everything that touches the outside world (WhatsApp library, HTTP, prompts, clock,
 * timers) is injected, which keeps the logic testable without a real WhatsApp account.
 */
function createApp(deps) {
  const { baileys, http, qrcode, pino, ask, paths } = deps;
  const log = deps.log || console;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || defaultSleep;
  const schedule = deps.schedule || setTimeout;
  const debug = !!deps.debug;

  let config;
  let store;
  let limiter;
  let sock = null;
  let generation = 0;
  let connectFailures = 0;
  let announcedReady = false;
  let lastLearningNotice = 0;
  let repliesSent = 0;
  let askedLinkMethod = false;
  let profileIndex = 0;
  let pairingPhone = '';
  let styleCache = { key: -1, value: null };
  const telemetry = new Telemetry(now);
  let dashboard = null;
  let consecutiveGenerationFailures = 0;
  const lastReplyAt = {};
  const recentBotReplies = {};
  const lastGeneratedInput = {};

  const botSentIds = new Set(); // ids of messages the bot sent, so it never learns from itself
  const seenIds = new Set(); // protects against duplicate deliveries
  const lastManual = {}; // chatId -> when the owner last typed in that chat
  const lastNotified = {}; // chatId -> last "needs you" notification
  const pending = {}; // chatId -> { keys, timer } (messages waiting for follow-ups)
  const chatQueues = {}; // chatId -> promise chain, one reply at a time per chat

  const say = (msg) => log.log(`[${new Date(now()).toTimeString().slice(0, 8)}] ${msg}`);

  /* ------------------------------ WhatsApp helpers ------------------------------ */
  const contentOf = (message) => baileys.normalizeMessageContent(message) || message;

  function extractText(message) {
    const c = contentOf(message);
    return c?.conversation || c?.extendedTextMessage?.text || c?.imageMessage?.caption || c?.videoMessage?.caption || null;
  }

  function audioInfo(message) {
    const c = contentOf(message);
    const a = c?.audioMessage;
    if (!a) return null;
    return { mimeType: a.mimetype || 'audio/ogg', seconds: Number(a.seconds || 0), message: c };
  }

  async function resolveText(message) {
    const direct = extractText(message);
    if (direct) return { text: direct, source: 'text' };
    const audio = audioInfo(message);
    if (!audio || !config.voiceNotes) return { text: null, source: 'unsupported' };
    try {
      let buffer;
      if (typeof baileys.downloadContentFromMessage === 'function') {
        const stream = await baileys.downloadContentFromMessage(audio.message.audioMessage, 'audio', {});
        const chunks = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        buffer = Buffer.concat(chunks);
      } else if (typeof baileys.downloadMediaMessage === 'function') {
        buffer = await baileys.downloadMediaMessage({ message: audio.message }, 'buffer', {});
      }
      const { transcribeAudio } = require('./llm');
      const text = await transcribeAudio({ http, config, buffer, mimeType: audio.mimeType, fileName: audio.mimeType.includes('webm') ? 'voice.webm' : 'voice.ogg' });
      if (text) { telemetry.inc('voiceTranscribed'); return { text, source: 'voice' }; }
    } catch (err) {
      telemetry.inc('voiceTranscriptionFailures'); telemetry.error('voice-transcription');
      if (debug) say(`Voice transcription failed: ${err.message}`);
    }
    return { text: null, source: 'voice-failed' };
  }

  function extractQuoted(message) {
    const q = contentOf(message)?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!q) return null;
    const c = baileys.normalizeMessageContent(q) || q;
    return c?.conversation || c?.extendedTextMessage?.text || c?.imageMessage?.caption || null;
  }

  function ownNumbers() {
    return [sock?.user?.id, sock?.user?.lid].filter(Boolean).map(numberOf);
  }
  const isSelfChat = (chatId) => ownNumbers().includes(numberOf(chatId));
  const ownJid = () => (sock?.user?.id ? `${numberOf(sock.user.id)}@s.whatsapp.net` : null);

  async function sendText(chatId, text) {
    const sent = await sock.sendMessage(chatId, { text });
    if (sent?.key?.id) {
      botSentIds.add(sent.key.id);
      if (botSentIds.size > 500) botSentIds.delete(botSentIds.values().next().value);
    }
    return sent;
  }

  /* ------------------------------- Learning / style ----------------------------- */
  function getStyle() {
    const n = store.data.messages.length;
    const key = n < 50 ? n : Math.floor(n / 10) * 10;
    if (!styleCache.value || styleCache.key !== key) styleCache = { key, value: analyzeStyle(store.data.messages) };
    return styleCache.value;
  }

  function checkReady() {
    if (!announcedReady && store.data.messages.length >= config.minLearnedMessages) {
      announcedReady = true;
      say('READY: the bot has learned your style and auto-replies are now active. It keeps learning in the background.');
    }
  }

  /* ----------------------------------- Rules ------------------------------------ */
  const manualRecently = (chatId) => now() - (lastManual[chatId] || 0) < config.pauseAfterManualMs;

  function canReply(chatId) {
    const { state } = store.data;
    if (!state.enabled) return { ok: false, reason: 'off' };
    if (now() < state.mutedUntil) return { ok: false, reason: 'muted' };
    if (!shouldReplyTo(chatId, config, store)) return { ok: false, reason: 'not-eligible' };
    if (inQuietHours(config.quietHours, new Date(now()))) return { ok: false, reason: 'quiet-hours' };
    if (manualRecently(chatId)) return { ok: false, reason: 'manual' };
    if (config.requireGlobalLearning && store.data.messages.length < config.minLearnedMessages) return { ok: false, reason: 'learning' };
    if (!limiter.canSend(chatId, now())) return { ok: false, reason: 'rate-limit' };
    if (now() - (lastReplyAt[chatId] || 0) < Number(config.minReplyGapMs || 0)) return { ok: false, reason: 'cooldown' };
    return { ok: true };
  }

  /* ------------------------------ Reply generation ------------------------------ */
  function toChatMessages(turns) {
    const out = [];
    for (const t of turns) {
      const role = t.r === 'u' ? 'user' : 'assistant';
      const last = out[out.length - 1];
      if (last && last.role === role) last.content += `\n${t.t}`;
      else out.push({ role, content: t.t });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }

  function typingDelay(text) {
    const base = Math.min(text.length * config.typingMsPerChar, config.maxTypingDelayMs);
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  async function notifyOwner(chatId, incomingText, reason) {
    const to = ownJid();
    if (!config.notifyOwnerOnSkip || !to) return;
    if (now() - (lastNotified[chatId] || 0) < 10 * 60 * 1000) return; // at most one note per chat per 10 minutes
    lastNotified[chatId] = now();
    const who = store.data.names[chatId] || numberOf(chatId);
    try {
      await sendText(to, `Needs you: ${who} wrote "${clip(incomingText, 160)}"${reason ? ` (${reason})` : ''}`);
    } catch (err) {
      say(`Could not notify you: ${err.message}`);
    }
  }

  async function respond(chatId, keys) {
    if (!sock) return;
    if (!canReply(chatId).ok) return;

    let turns = store.getRecent(chatId, CONTEXT_MAX_AGE, now());
    if (!turns.length || turns[turns.length - 1].r !== 'u') return;
    // Treat a rapid burst of incoming messages as one current user turn. This prevents the
    // model from answering only the last fragment and missing the actual question/context.
    const trailingIncoming = [];
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].r !== 'u') break;
      trailingIncoming.unshift(turns[i].t);
    }
    const incomingText = trailingIncoming.length ? trailingIncoming.join('\n') : turns[turns.length - 1].t;
    // Every live message triggers a fresh scan of this person's stored history. No waiting for a new chat.
    const longMemory = store.getRelevantChatHistory(chatId, incomingText, config.longMemoryTurns || 18);
    if (longMemory.length) {
      // Historical evidence first, live conversation last: the newest incoming message MUST remain the final user turn.
      const historical = longMemory.filter(x => !turns.some(t => t.t === x.t && t.ts === x.ts));
      turns = [...historical, ...turns].slice(-Math.max(config.recentTurnsForPrompt || 28, 12));
      if (turns[turns.length - 1]?.r !== 'u') return;
    }
    // IMPORTANT: only the current incoming message is sent as the model's user content.
    // Historical owner messages are deliberately NOT sent as assistant turns: they are style-learning
    // data, not semantic answer evidence. This prevents the model from recycling an old answer.
    const messages = [{ role: 'user', content: incomingText }];
    // Keep the prompt bounded even when a contact has a very long history. Prefer the newest turns.
    let contextChars = messages.reduce((n, m) => n + String(m.content || '').length, 0);
    if (contextChars > (config.maxContextChars || 12000)) {
      while (messages.length > 2 && contextChars > (config.maxContextChars || 12000)) {
        messages.shift();
        contextChars = messages.reduce((n, m) => n + String(m.content || '').length, 0);
      }
    }

    const contactMessages = config.analyzeEachContact ? store.getContactMessages(chatId) : [];
    const contactProfile = config.analyzeEachContact ? analyzeContact(contactMessages) : {};
    const incomingAnalysis = classify(incomingText);
    const recentReplies = recentBotReplies[chatId] || [];
    if (config.smartSkip && recentReplies.length && incomingAnalysis.intent !== 'question' && /^(ok|okay|haan|hmm|hm|acha|accha|thanks|thx|bye|gn|gm)$/i.test(normalize(incomingText))) {
      // Tiny acknowledgements should not create an artificial interrogation loop.
      await pause(chatId);
      return;
    }
    const historicalChat = store.getRelevantChatHistory(chatId, incomingText, config.longMemoryTurns || 18);
    const brain = buildBrain({
      history: store.data.chatHistory[chatId] || [],
      contactProfile,
      ownerStyle: getStyle(),
      incoming: incomingText
    });

    const priorIncoming = turns
      .filter(t => t.r === 'u')
      .slice(0, -trailingIncoming.length)
      .slice(-3)
      .map(t => t.t)
      .filter(Boolean)
      .join('\n');
    const currentQuoted = (() => {
      const match = String(incomingText).match(/^\(replying to "([\s\S]*?)"\)\s*/);
      return match ? match[1] : '';
    })();
    const system = buildSystemPrompt({
      style: getStyle(),
      contactProfile,
      contactName: store.data.names[chatId] || '',
      now: new Date(now()),
      incomingText,
      recentIncoming: priorIncoming,
      quotedText: currentQuoted,
      incomingAnalysis,
      brain
    });

    const current = sock;
    if (config.markAsRead) {
      try {
        await current.readMessages(keys);
      } catch {
        /* not critical */
      }
    }
    await sleep(randInt(config.minReadDelayMs, config.maxReadDelayMs));
    if (manualRecently(chatId)) return;

    try {
      await current.sendPresenceUpdate('composing', chatId);
    } catch {
      /* not critical */
    }
    const started = now();
    telemetry.inc('generationAttempts');

    let raw;
    try {
      raw = await requestReply({ http, config, system, messages, sleep });
    } catch (err) {
      consecutiveGenerationFailures++;
      telemetry.inc('generationFailures'); telemetry.error('generation');
      say(`Could not generate a reply: ${err.message}`);
      if (consecutiveGenerationFailures >= Number(config.maxConsecutiveFailures || 8)) say('AI generation has failed repeatedly; keeping WhatsApp connection alive and continuing to retry on the next incoming message.');
      await pause(chatId);
      return;
    }

    let parsed = parseReply(raw);
    consecutiveGenerationFailures = 0;
    if (parsed.type === 'reply' && config.responseQualityGate) {
      const quality = validateReply(parsed.text, incomingText, recentReplies, brain);
      if (!quality.ok && config.repairOnLowQuality) {
        for (let attempt = 0; attempt < Number(config.maxRepairAttempts || 1); attempt++) {
          try {
            const repaired = await require('./llm').repairReply({
              http, config, original: parsed.text, system, messages, reasons: quality.reasons, sleep
            });
            const repairedParsed = parseReply(repaired);
            if (repairedParsed.type === 'reply' && validateReply(repairedParsed.text, incomingText, recentReplies, brain).ok) {
              parsed = repairedParsed;
              telemetry.inc('qualityRepairs');
              break;
            }
          } catch (err) {
            if (debug) say(`Reply repair failed: ${err.message}`);
          }
        }
      }
      if (parsed.type === 'reply') {
        const finalQuality = validateReply(parsed.text, incomingText, recentReplies, brain);
        if (!finalQuality.ok) {
          const critical = finalQuality.reasons.some((r) => ['empty', 'ai-language'].includes(r));
          if (critical || finalQuality.score < 48) {
            say(`Skipped low-quality draft for ${store.data.names[chatId] || numberOf(chatId)}: ${finalQuality.reasons.join(', ')}`);
            await pause(chatId);
            return;
          }
          // A useful but imperfect conversational draft is preferable to silence.
          telemetry.inc('softQualityPasses');
        }
      }
    }
    if (parsed.type !== 'reply') {
      await pause(chatId);
      if (parsed.type === 'skip') {
        say(`Skipped ${store.data.names[chatId] || numberOf(chatId)}: this one needs you${parsed.reason ? ` (${parsed.reason})` : ''}.`);
        await notifyOwner(chatId, incomingText, parsed.reason);
      }
      return;
    }

    const confidence = validateReply(parsed.text, incomingText, recentReplies, brain).score;
    telemetry.observe(confidence);
    if (config.confidenceHandoff && confidence < Number(config.lowConfidenceThreshold || 58)) {
      telemetry.inc('lowConfidenceHandoffs');
      await pause(chatId);
      await notifyOwner(chatId, incomingText, `low confidence (${confidence})`);
      return;
    }

    const wait = typingDelay(parsed.text) - (now() - started);
    if (wait > 0) await sleep(wait);

    // The owner may have taken over, or switched the bot off, while it was "typing"
    if (manualRecently(chatId) || !store.data.state.enabled) {
      await pause(chatId);
      return;
    }
    if (config.smartSkip && normalize(lastGeneratedInput[chatId] || '') === normalize(incomingText) && shouldSkipDuplicate(parsed.text, recentReplies.slice(-(config.duplicateReplyWindow || 12)))) {
      await pause(chatId);
      say(`Skipped duplicate-style reply for ${store.data.names[chatId] || numberOf(chatId)}.`);
      return;
    }

    await sendText(chatId, parsed.text);
    telemetry.inc('repliesSent');
    telemetry.observe(now() - started);
    limiter.record(chatId, now());
    repliesSent++;
    lastReplyAt[chatId] = now();
    lastGeneratedInput[chatId] = incomingText;
    recentBotReplies[chatId] = [...(recentBotReplies[chatId] || []), parsed.text].slice(-Math.max(12, Number(config.duplicateReplyWindow || 12)));
    store.pushRecent(chatId, 'a', parsed.text, Math.floor(now() / 1000));

    // If the model found a genuinely relevant question, send it as a second WhatsApp turn.
    // This keeps the conversation moving without adding a forced generic "aur batao?".
    const shouldAskFollowUp = config.proactiveQuestion && (!config.adaptiveQuestion || chooseQuestion({ incoming: incomingText, reply: parsed.text, profile: contactProfile }));
    if (shouldAskFollowUp) {
      let question = parsed.question;
      if (!question) {
        try {
          question = await requestFollowUpQuestion({
            http,
            config,
            context: `CURRENT MESSAGE ONLY:\n${incomingText}`,
            styleSummary: getStyle()?.summary || '',
            sleep
          });
        } catch (err) {
          if (debug) say(`Follow-up question fallback failed: ${err.message}`);
        }
      }
      if (question && question !== parsed.text) {
        await sleep(Math.max(0, Number(config.questionDelayMs) || 0));
        if (!manualRecently(chatId) && store.data.state.enabled && limiter.canSend(chatId, now())) {
          await sendText(chatId, question);
          // The follow-up is part of the same conversational turn; don't consume a second hourly slot.
          repliesSent++;
          lastReplyAt[chatId] = now();
          recentBotReplies[chatId] = [...(recentBotReplies[chatId] || []), question].slice(-Math.max(12, Number(config.duplicateReplyWindow || 12)));
          store.pushRecent(chatId, 'a', question, Math.floor(now() / 1000));
        }
      }
    }

    await pause(chatId);
    say(`-> [${store.data.names[chatId] || numberOf(chatId)}] ${parsed.text}${parsed.question ? ` | Q: ${parsed.question}` : ''}`);
  }

  async function pause(chatId) {
    try {
      await sock?.sendPresenceUpdate('paused', chatId);
    } catch {
      /* not critical */
    }
  }

  function pickPairs(chatId, incomingText = '') {
    const relevant = store.getRelevantPairs ? store.getRelevantPairs(chatId, incomingText, 6) : [];
    if (relevant.length >= 4) return relevant;
    const recent = store.data.pairs.filter((p) => p.chatId === chatId).slice(-6);
    return [...new Map([...relevant, ...recent].map((p) => [`${p.chatId}\u0000${p.them}\u0000${p.me}`, p])).values()].slice(-6);
  }

  function enqueue(chatId, task) {
    const prev = chatQueues[chatId] || Promise.resolve();
    const next = prev.then(task).catch((err) => say(`Unexpected error: ${err.message}`));
    chatQueues[chatId] = next;
    return next;
  }

  /** Waits for follow-up messages (people often send 2-3 in a row) and answers them together. */
  function scheduleReply(chatId, key) {
    const entry = (pending[chatId] ||= { keys: [], timer: null });
    entry.keys.push(key);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      delete pending[chatId];
      enqueue(chatId, () => respond(chatId, entry.keys));
    }, config.debounceMs);
  }

  function cancelPending(chatId) {
    if (pending[chatId]) {
      clearTimeout(pending[chatId].timer);
      delete pending[chatId];
    }
  }

  /* --------------------------------- Owner commands ----------------------------- */
  async function handleOwnerCommand(text) {
    const cmd = parseCommand(text);
    const to = ownJid();
    if (!cmd || !to) return;
    const { state } = store.data;
    let reply;

    switch (cmd.name) {
      case 'on':
        state.enabled = true;
        state.mutedUntil = 0;
        reply = 'Auto-replies are ON.';
        break;
      case 'off':
        state.enabled = false;
        reply = 'Auto-replies are OFF. Send /bot on to resume.';
        break;
      case 'mute': {
        const minutes = Math.min(Math.max(parseInt(cmd.arg, 10) || 60, 1), 24 * 60);
        state.mutedUntil = now() + minutes * 60 * 1000;
        reply = `Auto-replies are paused for ${minutes} minutes. Send /bot on to resume earlier.`;
        break;
      }
      case 'status': {
        const s = store.stats();
        const mode = !state.enabled
          ? 'OFF'
          : now() < state.mutedUntil
            ? `paused for ${Math.ceil((state.mutedUntil - now()) / 60000)} more minutes`
            : 'ON';
        reply = `Bot status: ${mode}.\nLearned: ${s.messages} messages, ${s.pairs} reply examples, ${s.knownChats} known chats, ${s.contactProfiles} person profiles.\nReplies sent this session: ${repliesSent}.\nLong-term per-person memory: ${config.longMemoryTurns || 18} turns.\nAdvanced brain: topic memory, open-question tracking, adaptive reply length and response quality gate are ON.`;
        break;
      }
      case 'forget':
        if (cmd.arg.toLowerCase() === 'confirm') {
          store.forget();
          announcedReady = false;
          reply = 'Everything the bot learned has been erased. It will start learning again from your next messages.';
        } else {
          reply = 'This erases everything the bot learned. To continue, send: /bot forget confirm';
        }
        break;
      case 'resync':
        reply = 'To import old WhatsApp chats again, stop the bot and run: npm run relink. Your learned.json is kept; only the WhatsApp session is relinked so WhatsApp can send the history again.';
        break;
      case 'metrics': {
        const s = store.stats(); const t = telemetry.snapshot();
        reply = `Runtime: ${t.uptimeSeconds}s\nReplies: ${t.counters.repliesSent || 0}\nVoice transcribed: ${t.counters.voiceTranscribed || 0}\nAI failures: ${t.counters.generationFailures || 0}\nQuality repairs: ${t.counters.qualityRepairs || 0}\nLow-confidence handoffs: ${t.counters.lowConfidenceHandoffs || 0}\nLatency p50/p95: ${t.latencyMs.p50}/${t.latencyMs.p95}ms\nMemory: ${s.memoryTurns} turns / ${s.contactProfiles} profiles.`;
        break;
      }
      case 'dashboard': {
        if (!dashboard) reply = 'Dashboard is disabled.';
        else { try { const url = await dashboard.start(); reply = `Control Center: ${url}`; } catch (e) { reply = `Dashboard could not start: ${e.message}`; } }
        break;
      }
      default:
        reply = HELP_TEXT;
    }
    store.saveSoon();
    say(`Command from you: ${text.trim()}`);
    await sendText(to, reply);
  }

  /* ---------------------------------- Messages ---------------------------------- */
  async function handleMessage(msg, type) {
    if (!msg.message || !msg.key?.remoteJid) return;
    const { key } = msg;
    const chatId = key.remoteJid;

    if (key.id) {
      if (seenIds.has(key.id)) return;
      seenIds.add(key.id);
      if (seenIds.size > 2000) seenIds.delete(seenIds.values().next().value);
    }

    const self = isSelfChat(chatId);
    if (!self && !isPersonalChat(chatId)) return; // no groups, status, broadcasts or channels

    const resolved = await resolveText(msg.message);
    const text = resolved.text;
    if (!text) return;
    const ts = toNumber(msg.messageTimestamp) || Math.floor(now() / 1000);

    // Messages written by the owner
    if (key.fromMe) {
      if (botSentIds.has(key.id)) return; // that was the bot itself
      if (self) {
        await handleOwnerCommand(text);
        return;
      }
      lastManual[chatId] = now();
      cancelPending(chatId);
      if (config.learningEnabled) {
        const prev = lastIncoming[chatId];
        const answered = prev && now() - prev.at < 10 * 60 * 1000 ? prev.text : null;
        store.addOwnerMessage(chatId, text, answered);
        delete lastIncoming[chatId];
        store.saveSoon();
        checkReady();
      }
      store.pushRecent(chatId, 'a', text, ts);
      return;
    }

    // Messages from other people
    if (type !== 'notify' || self) return;
    if (msg.pushName) store.setName(chatId, msg.pushName);
    const quoted = extractQuoted(msg.message);
    const full = quoted ? `(replying to "${clip(quoted, 120)}") ${text}` : text;
    telemetry.inc(resolved.source === 'voice' ? 'voiceMessages' : 'textMessages');
    lastIncoming[chatId] = { text, at: now() };
    if (config.learningEnabled && config.analyzeEachContact) {
      // Learn this person's fingerprint immediately, even if this chat has not yet become reply-eligible.
      store.addIncomingMessage(chatId, text, ts);
    }
    store.pushRecent(chatId, 'u', full, ts);

    const decision = canReply(chatId);
    if (!decision.ok) {
      if (decision.reason === 'learning' && shouldReplyTo(chatId, config, store) && now() - lastLearningNotice > 60000) {
        lastLearningNotice = now();
        say(`Still learning (${store.data.messages.length}/${config.minLearnedMessages} messages). Skipping auto-reply for now.`);
      }
      return;
    }
    scheduleReply(chatId, key);
  }
  const lastIncoming = {}; // chatId -> { text, at } used to pair the owner's manual replies

  function handleHistory(messages, progress) {
    if (!config.learningEnabled) return;
    const entries = [];
    for (const m of messages || []) {
      const chatId = m.key?.remoteJid;
      if (!chatId || !m.message || !isPersonalChat(chatId) || isSelfChat(chatId)) continue;
      const text = extractText(m.message);
      if (!text) continue;
      if (!m.key.fromMe && m.pushName) store.setName(chatId, m.pushName);
      entries.push({ chatId, fromMe: !!m.key.fromMe, text, ts: toNumber(m.messageTimestamp) });
    }
    const added = store.learnFromHistory(entries);
    const progressText = progress != null ? `, WhatsApp batch progress ${progress}%` : '';
    say(`History sync batch: learned ${added} owner messages (total ${store.data.messages.length})${progressText}`);
    checkReady();
  }

  /* -------------------------------- Connection ---------------------------------- */
  /** Opens a real WebSocket to WhatsApp (the same kind of connection the bot needs) and reports the result. */
  function checkWebSocket(timeoutMs = 8000) {
    const WS = deps.WebSocket;
    if (!WS) return Promise.resolve(null);
    return new Promise((resolve) => {
      let ws;
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          ws?.terminate();
        } catch {
          /* ignore */
        }
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, detail: 'timed out' }), timeoutMs);
      try {
        ws = new WS(deps.wsUrl || 'wss://web.whatsapp.com/ws/chat', { origin: 'https://web.whatsapp.com', handshakeTimeout: timeoutMs });
      } catch (e) {
        finish({ ok: false, detail: e.message });
        return;
      }
      ws.on('open', () => finish({ ok: true }));
      ws.on('error', (e) => finish({ ok: false, detail: e.code || e.message }));
      ws.on('close', (code) => finish({ ok: false, detail: `closed by the network (code ${code})` }));
    });
  }

  async function diagnoseConnection() {
    log.log(`\nRunning connection check (Node ${process.version}, ${process.platform})...`);
    for (const url of ['https://web.whatsapp.com', 'https://raw.githubusercontent.com']) {
      try {
        const res = await http.get(url, { timeout: 8000, validateStatus: () => true });
        log.log(`  ${url}: reachable (HTTP ${res.status})`);
      } catch (e) {
        log.log(`  ${url}: NOT reachable (${e.code || e.message})`);
      }
    }
    log.log('  (raw.githubusercontent.com is only used to look up the latest WhatsApp version. If it is unreachable, the built-in version is used, which is fine.)');
    const ws = await checkWebSocket();
    if (ws) log.log(`  WebSocket to WhatsApp: ${ws.ok ? 'connected OK' : `FAILED (${ws.detail})`}`);
    if (ws && !ws.ok) {
      log.log('  Your network is blocking WebSocket connections to WhatsApp. Try a mobile hotspot or a different Wi-Fi, and turn off any VPN, proxy or antivirus web protection.');
    } else if (ws && ws.ok) {
      log.log('  Your network allows WhatsApp. If the connection keeps closing, run: npm run debug');
    } else {
      log.log('  If web.whatsapp.com is not reachable, your network, firewall, antivirus or VPN is blocking WhatsApp.');
    }
    log.log('  Also make sure the date and time on this computer are correct.');
    log.log('  For detailed logs run: npm run debug\n');
  }

  function showQr(qr) {
    log.log('\nOpen WhatsApp > Linked devices > Link a device, then scan this QR code:\n');
    qrcode.generate(qr, { small: true });
  }

  async function start() {
    const gen = ++generation;
    const { DisconnectReason } = baileys;

    const hadAuth = fs.existsSync(paths.auth) && fs.readdirSync(paths.auth).length > 0;
    const { state, saveCreds } = await baileys.useMultiFileAuthState(paths.auth);
    let version;
    try {
      ({ version } = await baileys.fetchLatestBaileysVersion({ timeout: 5000 }));
    } catch {
      /* the library falls back to its built-in version */
    }
    const registered = !!state?.creds?.registered;

    if (!registered && !askedLinkMethod) {
      askedLinkMethod = true;
      const answer = await ask(
        '\nLink WhatsApp with a QR code (just press Enter) or with a pairing code\n(type your phone number with country code, digits only, for example 919876543210): '
      );
      const digits = String(answer || '').replace(/\D/g, '');
      pairingPhone = digits.length >= 8 ? digits : '';
    }

    const profile = PROFILES[profileIndex];
    say(`Connecting to WhatsApp (${profile.name} mode)...`);
    const socket = baileys.default({
      version,
      auth: state,
      logger: pino({ level: debug ? 'debug' : 'silent' }),
      ...profile.build(baileys), // "desktop" mode receives more chat history, "compatibility" mode connects more reliably
      markOnlineOnConnect: false, // keep phone notifications working while the bot runs
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined
    });
    sock = socket;
    let pairingState = pairingPhone && !registered ? 'pending' : 'off'; // pending | requesting | done | failed | off

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update) => {
      if (gen !== generation) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (pairingState === 'pending') {
          pairingState = 'requesting';
          try {
            const code = await socket.requestPairingCode(pairingPhone);
            const pretty = String(code).match(/.{1,4}/g)?.join('-') || code;
            log.log(
              `\nYour pairing code: ${pretty}\nOn your phone: WhatsApp > Linked devices > Link a device > Link with phone number instead, then enter this code.\n`
            );
            pairingState = 'done';
          } catch (err) {
            pairingState = 'failed';
            say(`Could not get a pairing code (${err.message}). Showing a QR code instead.`);
            showQr(qr);
          }
        } else if (pairingState === 'off' || pairingState === 'failed') {
          showQr(qr);
        }
      }

      if (connection === 'close') {
        const err = lastDisconnect?.error;
        const statusCode = err?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          say('Logged out of WhatsApp. Run "npm run relink" (or RELINK.bat) and scan the QR code again.');
          return;
        }
        if (statusCode === DisconnectReason.restartRequired) {
          // Normal right after scanning the QR code: WhatsApp asks for a fresh connection.
          start().catch(onStartError);
          return;
        }

        connectFailures++;
        const hint =
          DISCONNECT_HINTS[statusCode] ||
          'Could not stay connected to WhatsApp. Check your internet connection, firewall, antivirus and VPN.';
        const delaySec = Math.min(5 * 2 ** (connectFailures - 1), 60);
        say(`Connection closed (code: ${statusCode ?? 'none'}${err?.message ? `, reason: ${err.message}` : ''}).`);
        log.log(`  ${hint}`);
        log.log(`  Retrying in ${delaySec}s (attempt ${connectFailures}).`);
        if (connectFailures === 1) diagnoseConnection();
        if (connectFailures % 2 === 0) {
          profileIndex = (profileIndex + 1) % PROFILES.length;
          say(`Switching to ${PROFILES[profileIndex].name} mode for the next attempt.`);
        }
        schedule(() => start().catch(onStartError), delaySec * 1000);
      }

      if (connection === 'open') {
        connectFailures = 0;
        say('Connected to WhatsApp.');
        if (store.data.state.profile !== profileIndex) {
          store.data.state.profile = profileIndex; // remember the mode that works on this network
          store.saveSoon();
        }
        if (PROFILES[profileIndex].name === 'compatibility') {
          say('Running in compatibility mode: fewer old chats may be imported, but learning from your new messages works normally.');
        }
        if (!hadAuth) {
          say('Syncing chat history. Auto-replies start as soon as enough of your messages are learned. Keep your phone connected to the internet.');
        }
        say(`Learned messages so far: ${store.data.messages.length}`);
        checkReady();
      }
    });

    // WhatsApp sends old chats right after linking; the bot learns from them automatically
    socket.ev.on('messaging-history.set', ({ messages, progress }) => {
      if (gen === generation) handleHistory(messages, progress);
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (gen !== generation) return;
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages) {
        try {
          await handleMessage(msg, type);
        } catch (err) {
          say(`Error while handling a message: ${err.message}`);
        }
      }
    });
  }

  function onStartError(err) {
    say(`Could not start the WhatsApp connection: ${err.message}. Retrying in 10s.`);
    schedule(() => start().catch(onStartError), 10000);
  }

  /* --------------------------------- Lifecycle ---------------------------------- */
  async function init() {
    config = await loadConfig(paths.config, ask);
    store = new Store(paths.learned, {
      contactMessages: Math.min(Math.max(Number(config.contactHistoryLimit) || 120, 20), 800),
      chatTurns: Math.min(Math.max(Number(config.memoryTurnsPerChat) || 900, 100), 3000),
      pairs: Math.min(Math.max(Number(config.pairLimitPerChat) * 10 || 5000, 500), 10000),
      perChat: Math.min(Math.max(Number(config.pairLimitPerChat) || 400, 50), 1000),
      recentTurns: 12
    });
    limiter = new RateLimiter(config.maxRepliesPerChatPerHour);
    if (config.dashboardEnabled) {
      dashboard = createDashboard({
        port: config.dashboardPort,
        getSnapshot: async () => ({ status: !store.data.state.enabled ? 'OFF' : 'ON', store: store.stats(), telemetry: telemetry.snapshot() }),
        getContacts: async () => Object.entries(store.data.contacts || {}).map(([id, msgs]) => { const meta = store.data.chatMeta[id] || {}; const hours = {}; for (const m of msgs.slice(-300)) { const h = new Date(Number(m.ts || 0) * 1000).getHours(); hours[h] = (hours[h] || 0) + 1; } return { name: store.data.names[id] || id, messages: msgs.length, ownerReplies: meta.owner || 0, activeHours: Object.entries(hours).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([h])=>`${String(h).padStart(2,'0')}:00`) }; }).sort((a,b)=>b.messages-a.messages)
      });
    }
    profileIndex = Math.min(Math.max(Number(store.data.state.profile) || 0, 0), PROFILES.length - 1);
    if (store.corrupted) say('learned.json was corrupted. A copy was kept as learned.json.corrupt and learning starts fresh.');
    if (config.quietHours && !parseQuietHours(config.quietHours)) {
      say(`Ignoring invalid quietHours "${config.quietHours}". Use the format "23:00-07:00".`);
    }
    return { config, store };
  }

  function shutdown() {
    for (const id of Object.keys(pending)) cancelPending(id);
    if (dashboard) dashboard.stop().catch(() => {});
    if (store) store.flush();
  }

  return {
    init,
    start,
    shutdown,
    checkWebSocket,
    getConfig: () => config,
    getStore: () => store
  };
}

module.exports = { createApp, DISCONNECT_HINTS };
