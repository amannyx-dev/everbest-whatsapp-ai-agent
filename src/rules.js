'use strict';

/** Personal chats only: normal numbers (@s.whatsapp.net) and hidden-number ids (@lid). */
function isPersonalChat(jid) {
  return !!jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
}

function numberOf(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

/** Decides whether this chat is allowed to receive automatic replies. */
function shouldReplyTo(chatId, config, store) {
  if (config.ignoreList.includes(chatId)) return false;
  if (config.allowList.length > 0) return config.allowList.includes(chatId);
  if (config.onlyReplyToKnownChats) return store.isKnownChat(chatId);
  return true;
}

/** "23:00-07:00" -> { start, end } in minutes since midnight, or null when empty/invalid. */
function parseQuietHours(spec) {
  const m = String(spec || '').match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [sh, sm, eh, em] = m.slice(1).map(Number);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start === end ? null : { start, end };
}

function inQuietHours(spec, date = new Date()) {
  const window = parseQuietHours(spec);
  if (!window) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return window.start < window.end
    ? minutes >= window.start && minutes < window.end
    : minutes >= window.start || minutes < window.end; // overnight window
}

/** Max N replies per chat per rolling hour. Protects against bot-to-bot loops and runaway API usage. */
class RateLimiter {
  constructor(maxPerHour, windowMs = 60 * 60 * 1000) {
    this.max = maxPerHour;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  _prune(chatId, now) {
    const list = (this.hits.get(chatId) || []).filter((t) => now - t < this.windowMs);
    this.hits.set(chatId, list);
    return list;
  }
  canSend(chatId, now = Date.now()) {
    if (!this.max) return true;
    return this._prune(chatId, now).length < this.max;
  }
  record(chatId, now = Date.now()) {
    this._prune(chatId, now).push(now);
  }
}

/** Owner commands, sent from the "Message yourself" chat: /bot on | off | mute 30 | status | forget confirm | help */
function parseCommand(text) {
  const m = String(text || '').trim().match(/^\/bot(?:\s+(\w+))?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return { name: (m[1] || 'help').toLowerCase(), arg: (m[2] || '').trim() };
}

module.exports = { isPersonalChat, numberOf, shouldReplyTo, parseQuietHours, inQuietHours, RateLimiter, parseCommand };
