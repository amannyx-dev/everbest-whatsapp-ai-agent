'use strict';
const fs = require('fs');
const { writeJsonAtomic, clip } = require('./util');

const LIMITS = { messages: 5000, pairs: 5000, perChat: 400, recentTurns: 12, recentChats: 500, chatMsgChats: 700, contactMessages: 800, contactChats: 700, chatTurns: 900, chatTurnChats: 700 };
const KNOWN_CHAT_MIN = 1; // one owner message is enough to establish that this is a real conversation

const MEDIA_PLACEHOLDER = /(<Media omitted>|omitted>|This message was deleted|You deleted this message)/i;
// Never keep things that look like OTPs, account numbers, links, e-mail addresses or credentials.
const SENSITIVE = /(\b\d{6,}\b|https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+|\b(otp|password|passcode|cvv|pin)\b)/i;

function isLearnable(text) {
  const t = String(text || '').trim();
  return !!t && t.length <= 300 && !MEDIA_PLACEHOLDER.test(t) && !SENSITIVE.test(t);
}

const pairKey = (p) => `${p.them}\u0000${p.me}`;

function emptyData() {
  return {
    messages: [], // things the owner wrote (deduplicated, newest last)
    pairs: [], // { chatId, them, me }: what someone said and how the owner answered
    chats: {}, // chatId -> number of messages the owner wrote there
    chatMsgs: {}, // chatId -> the owner's latest messages in that chat
    names: {}, // chatId -> contact name
    contacts: {}, // chatId -> recent incoming messages for per-person habit learning
    chatHistory: {}, // chatId -> longer-term alternating conversation memory [{ r: 'u'|'a', t, ts }]
    chatMeta: {}, // chatId -> lightweight interaction intelligence and duplicate protection
    recent: {}, // chatId -> latest conversation turns [{ r: 'u'|'a', t, ts }]
    state: { enabled: true, mutedUntil: 0 }
  };
}

class Store {
  constructor(file, limits = {}) {
    this.file = file;
    this.limits = { ...LIMITS, ...limits };
    this.timer = null;
    this.corrupted = false;
    this.load();
  }

  load() {
    this.data = emptyData();
    this.corrupted = false;
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        const base = emptyData();
        this.data = { ...base, ...parsed, state: { ...base.state, ...(parsed.state || {}) } };
      } catch {
        this.corrupted = true;
        try {
          fs.renameSync(this.file, `${this.file}.corrupt`); // keep the broken file for inspection
        } catch {
          /* ignore */
        }
      }
    }
    // Upgrade older learned.json files: seed per-contact behavior from whatever recent
    // conversation context the previous version already retained. A fresh history sync will
    // expand this automatically.
    this.data.contacts ||= {};
    this.data.chatHistory ||= {};
    this.data.chatMeta ||= {};
    // Migrate v3 memory so upgrading does not throw away any already-learned chat context.
    for (const [chatId, turns] of Object.entries(this.data.recent || {})) {
      const existing = this.data.chatHistory[chatId] || [];
      const seen = new Set(existing.map(t => `${t.ts}|${t.r}|${t.t}`));
      for (const t of (turns || [])) {
        const turn = { r: t.r, t: clip(String(t.t || ''), 500), ts: Number(t.ts) || 0 };
        const key = `${turn.ts}|${turn.r}|${turn.t}`;
        if (turn.t && !seen.has(key)) { existing.push(turn); seen.add(key); }
      }
      this.data.chatHistory[chatId] = existing.slice(-this.limits.chatTurns);
    }
    for (const pair of (this.data.pairs || [])) {
      if (!pair.chatId) continue;
      const existing = this.data.chatHistory[pair.chatId] || [];
      const last = existing.at(-1);
      const them = { r: 'u', t: clip(String(pair.them || ''), 500), ts: 0 };
      const me = { r: 'a', t: clip(String(pair.me || ''), 500), ts: 0 };
      if (them.t && (!last || last.t !== them.t)) existing.push(them);
      existing.push(me);
      this.data.chatHistory[pair.chatId] = existing.slice(-this.limits.chatTurns);
    }
    for (const [chatId, turns] of Object.entries(this.data.recent || {})) {
      if (this.data.contacts[chatId]?.length || !this.isKnownChat(chatId)) continue;
      const incoming = (turns || []).filter((t) => t.r === 'u' && isLearnable(t.t));
      if (incoming.length) this.data.contacts[chatId] = incoming.slice(-this.limits.contactMessages).map((t) => ({ t: clip(t.t, 300), ts: Number(t.ts) || 0 }));
    }
    this.messageSet = new Set(this.data.messages);
    this.pairSet = new Set(this.data.pairs.map(pairKey));
  }

  saveSoon(delayMs = 3000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delayMs);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    clearTimeout(this.timer);
    try {
      writeJsonAtomic(this.file, this.data);
    } catch (err) {
      console.error('Could not save learned.json:', err.message);
    }
  }

  isKnownChat(chatId) {
    return (this.data.chats[chatId] || 0) >= KNOWN_CHAT_MIN;
  }

  setName(chatId, name) {
    const clean = String(name || '').trim();
    if (clean && this.data.names[chatId] !== clean) {
      this.data.names[chatId] = clip(clean, 60);
      this.saveSoon();
    }
  }

  /** Records one message the owner wrote, and optionally what it was answering. Returns true when learned. */
  addOwnerMessage(chatId, text, previousIncoming) {
    this.data.chats[chatId] = (this.data.chats[chatId] || 0) + 1;

    const clean = String(text || '').trim();
    if (!isLearnable(clean)) return false;

    if (!this.messageSet.has(clean)) {
      this.data.messages.push(clean);
      this.messageSet.add(clean);
      while (this.data.messages.length > this.limits.messages) this.messageSet.delete(this.data.messages.shift());
    }

    const mine = (this.data.chatMsgs[chatId] ||= []);
    if (mine[mine.length - 1] !== clean) mine.push(clean);
    if (mine.length > this.limits.perChat) mine.splice(0, mine.length - this.limits.perChat);
    const chatIds = Object.keys(this.data.chatMsgs);
    if (chatIds.length > this.limits.chatMsgChats) delete this.data.chatMsgs[chatIds[0]];

    if (previousIncoming && isLearnable(previousIncoming)) {
      const pair = { chatId, them: clip(previousIncoming.trim(), 200), me: clean };
      const key = pairKey(pair);
      if (!this.pairSet.has(key)) {
        this.data.pairs.push(pair);
        this.pairSet.add(key);
        while (this.data.pairs.length > this.limits.pairs) this.pairSet.delete(pairKey(this.data.pairs.shift()));
      }
    }
    return true;
  }


  /** Stores an incoming message so the bot can continuously learn this person's texting habits. */
  addIncomingMessage(chatId, text, ts) {
    if (!isLearnable(text)) return false;
    const list = (this.data.contacts[chatId] ||= []);
    const clean = clip(String(text).trim(), 300);
    const stamp = Number(ts) || Math.floor(Date.now() / 1000);
    const duplicate = list.some((m) => m.t === clean && Math.abs(Number(m.ts || 0) - stamp) <= 2);
    if (duplicate) return false;
    list.push({ t: clean, ts: stamp });
    if (list.length > this.limits.contactMessages) list.splice(0, list.length - this.limits.contactMessages);
    const ids = Object.keys(this.data.contacts);
    if (ids.length > this.limits.contactChats) delete this.data.contacts[ids[0]];
    this.saveSoon();
    return true;
  }

  getContactMessages(chatId) {
    return (this.data.contacts[chatId] || []).slice(-this.limits.contactMessages);
  }

  getContactProfile(chatId, analyzer) {
    return analyzer(this.getContactMessages(chatId));
  }

  /** Conversation context for a chat. Only kept for chats the owner has actually written in. */
  pushRecent(chatId, role, text, ts) {
    if (!this.isKnownChat(chatId)) return;
    const turn = { r: role, t: clip(text, 500), ts: Number(ts) || Math.floor(Date.now() / 1000) };
    const turns = this.data.recent[chatId] || [];
    delete this.data.recent[chatId];
    turns.push(turn);
    this.data.recent[chatId] = turns.slice(-this.limits.recentTurns);
    const ids = Object.keys(this.data.recent);
    if (ids.length > this.limits.recentChats) delete this.data.recent[ids[0]];

    const history = this.data.chatHistory[chatId] || [];
    history.push(turn);
    const meta = (this.data.chatMeta[chatId] ||= { incoming: 0, owner: 0, lastIncomingAt: 0, lastOwnerAt: 0, replySamples: [] });
    if (role === 'u') { meta.incoming++; meta.lastIncomingAt = turn.ts; }
    else { meta.owner++; meta.lastOwnerAt = turn.ts; meta.replySamples = [...(meta.replySamples || []), turn.t].slice(-20); }
    this.data.chatHistory[chatId] = history.slice(-this.limits.chatTurns);
    const hids = Object.keys(this.data.chatHistory);
    if (hids.length > this.limits.chatTurnChats) delete this.data.chatHistory[hids[0]];
    this.saveSoon();
  }

  /** Current conversation window. If it is old, keep it: old context is still useful when a person returns. */
  getRecent(chatId, maxAgeMs, nowMs) {
    const turns = this.data.recent[chatId] || [];
    const minTs = (nowMs - maxAgeMs) / 1000;
    const fresh = turns.filter((turn) => Number(turn.ts) >= minTs);
    return fresh.length >= 2 ? fresh : turns.slice(-this.limits.recentTurns);
  }

  /** Longer-term memory for this exact person, ranked by lexical relevance to the new message. */
  getRelevantChatHistory(chatId, query, limit = 18) {
    const history = this.data.chatHistory[chatId] || [];
    const { scoreText, retrieveWindows } = require('./intelligence');
    const windows = retrieveWindows(history, query, limit);
    if (windows.length) return windows;
    return history.map((t, i) => ({ t, i, score: scoreText(query, t.t, i / Math.max(1, history.length)) }))
      .sort((a,b) => b.score - a.score).slice(0, limit).sort((a,b) => a.i - b.i).map(x => x.t);
  }

  /** Learns from chat history delivered by WhatsApp. entries: [{ chatId, fromMe, text, ts(seconds) }]. */
  learnFromHistory(entries) {
    const byChat = {};
    for (const e of entries) (byChat[e.chatId] ||= []).push(e);

    let added = 0;
    for (const [chatId, list] of Object.entries(byChat)) {
      list.sort((a, b) => a.ts - b.ts);
      let prev = null;
      for (const m of list) {
        if (m.fromMe) {
          const answered = prev && m.ts - prev.ts < 600 ? prev.text : null;
          if (this.addOwnerMessage(chatId, m.text, answered)) added++;
          prev = null;
        } else {
          prev = m;
        }
      }
    }

    // Import contact behavior from OLD history immediately. Do not wait for a new message.
    // We learn profiles for every personal chat, while reply eligibility is still enforced separately.
    for (const [chatId, list] of Object.entries(byChat)) {
      const learnable = list.filter((m) => isLearnable(m.text));
      for (const m of learnable) {
        if (!m.fromMe) this.addIncomingMessage(chatId, m.text, m.ts);
      }
      const existing = this.data.chatHistory[chatId] || [];
      const knownKeys = new Set(existing.map(t => `${t.ts}|${t.r}|${t.t}`));
      for (const m of learnable) {
        const turn = { r: m.fromMe ? 'a' : 'u', t: clip(m.text, 500), ts: Number(m.ts) || 0 };
        const key = `${turn.ts}|${turn.r}|${turn.t}`;
        if (!knownKeys.has(key)) { existing.push(turn); knownKeys.add(key); }
      }
      existing.sort((a,b) => Number(a.ts)-Number(b.ts));
      this.data.chatHistory[chatId] = existing.slice(-this.limits.chatTurns);
      if (this.isKnownChat(chatId)) {
        const tail = this.data.chatHistory[chatId].slice(-this.limits.recentTurns);
        if (tail.length) this.data.recent[chatId] = tail;
      }
    }
    this.saveSoon();
    return added;
  }

  /** Returns reply examples most relevant to the current incoming message. */
  getRelevantPairs(chatId, incomingText, limit = 6) {
    const query = String(incomingText || '').toLowerCase();
    const tokens = new Set((query.match(/[a-z\u0900-\u097f0-9']{2,}/g) || []).filter((x) => !/^(hai|haan|the|and|you|for|this|that|bro|bhai|kya|ka|ke|ki|ko)$/i.test(x)));
    const score = (p) => {
      if (p.chatId === chatId) return 100 + [...tokens].filter((t) => p.them.toLowerCase().includes(t)).length * 10;
      return [...tokens].filter((t) => p.them.toLowerCase().includes(t)).length * 3;
    };
    return this.data.pairs
      .map((p, i) => ({ p, i, score: score(p) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.i - a.i)
      .slice(0, limit)
      .map(({ p }) => p);
  }

  stats() {
    return {
      messages: this.data.messages.length,
      pairs: this.data.pairs.length,
      chats: Object.keys(this.data.chats).length,
      knownChats: Object.keys(this.data.chats).filter((id) => this.isKnownChat(id)).length,
      contactProfiles: Object.keys(this.data.contacts).length,
      memoryTurns: Object.values(this.data.chatHistory).reduce((n, x) => n + x.length, 0)
    };
  }

  /** Erase everything that was learned (the on/off state is kept). */
  forget() {
    const { state } = this.data;
    this.data = { ...emptyData(), state };
    this.messageSet = new Set();
    this.pairSet = new Set();
    this.flush();
  }
}

module.exports = { Store, isLearnable, LIMITS, KNOWN_CHAT_MIN };
