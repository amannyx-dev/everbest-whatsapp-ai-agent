'use strict';
// Shared test harness: a fake WhatsApp library, fake Groq and a fake clock, so the whole bot can be tested offline.
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

const OWN_JID = '919000000000@s.whatsapp.net';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await delay(5);
  }
  return false;
}

function createHarness({ registered = true, config = {}, ask = async () => '', startTime = Date.now(), pairingFails = false, ws = 'open' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-flow-'));
  const paths = { config: path.join(dir, 'config.json'), learned: path.join(dir, 'learned.json'), auth: path.join(dir, 'auth') };
  fs.writeFileSync(
    paths.config,
    JSON.stringify({
      configVersion: 3,
      groqApiKey: 'test-key',
      minLearnedMessages: 3,
      debounceMs: 30,
      minReadDelayMs: 0,
      maxReadDelayMs: 0,
      typingMsPerChar: 0,
      maxTypingDelayMs: 0,
      proactiveQuestion: false,
      ...config
    })
  );

  const ev = new EventEmitter();
  const sent = [];
  const reads = [];
  const pairing = [];
  let socketCount = 0;
  const socketOptions = [];
  const fetchArgs = [];
  const sock = {
    ev: { on: (name, fn) => ev.on(name, fn) },
    user: { id: '919000000000:7@s.whatsapp.net' },
    sendPresenceUpdate: async () => {},
    readMessages: async (keys) => reads.push(keys),
    sendMessage: async (jid, content) => {
      sent.push({ jid, text: content.text });
      return { key: { id: `BOT${sent.length}` } };
    },
    requestPairingCode: async (number) => {
      if (pairingFails) throw new Error('pairing unavailable');
      pairing.push(number);
      return 'ABCD1234';
    }
  };
  const baileys = {
    default: (options) => {
      socketCount++;
      socketOptions.push(options);
      return sock;
    },
    useMultiFileAuthState: async () => ({ state: { creds: { registered } }, saveCreds() {} }),
    fetchLatestBaileysVersion: async (options) => {
      fetchArgs.push(options);
      return { version: [2, 3000, 1] };
    },
    DisconnectReason: { loggedOut: 401, restartRequired: 515 },
    normalizeMessageContent: (m) => m,
    Browsers: { macOS: () => ['Mac OS', 'Desktop', '14'], ubuntu: (b) => ['Ubuntu', b, '22.04.4'] }
  };

  const clock = { t: startTime };
  const http = {
    calls: [],
    reply: 'haan bhai',
    post: async (url, body) => {
      http.calls.push({ url, body });
      return { data: { choices: [{ message: { content: http.reply } }] } };
    },
    get: async () => ({ status: 200 })
  };
  const out = [];
  const timers = [];
  const qr = { generated: [], generate: (q) => qr.generated.push(q) };

  const wsControl = { behavior: ws, urls: [] };
  class FakeWebSocket extends EventEmitter {
    constructor(url) {
      super();
      wsControl.urls.push(url);
      process.nextTick(() => {
        if (wsControl.behavior === 'open') this.emit('open');
        else if (wsControl.behavior === 'error') this.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
        else this.emit('close', 1006);
      });
    }
    terminate() {}
  }

  const app = createApp({
    baileys,
    WebSocket: FakeWebSocket,
    http,
    qrcode: qr,
    pino: () => ({}),
    ask,
    paths,
    log: { log: (...args) => out.push(args.join(' ')) },
    now: () => clock.t,
    sleep: async () => {},
    schedule: (fn, ms) => timers.push({ fn, ms })
  });

  const seconds = () => Math.floor(clock.t / 1000);
  const entry = (jid, fromMe, text, ts, id, extra = {}) => ({
    key: { remoteJid: jid, fromMe, id: id || `m${ts}${fromMe ? 'o' : 't'}${Math.random().toString(36).slice(2, 6)}` },
    message: { conversation: text },
    messageTimestamp: ts,
    ...extra
  });
  let counter = 0;
  const incoming = (jid, text, extra = {}) =>
    entry(jid, false, text, seconds(), `in${++counter}`, { pushName: 'Rahul', ...extra });
  const fromOwner = (jid, text) => entry(jid, true, text, seconds(), `own${++counter}`);
  const deliver = (messages, type = 'notify') => ev.emit('messages.upsert', { messages: Array.isArray(messages) ? messages : [messages], type });

  /** Gives the bot a past with chat A: the owner wrote 4 messages there. */
  const seedHistory = (jid) => {
    const base = seconds() - 3000;
    ev.emit('messaging-history.set', {
      progress: 100,
      messages: [
        entry(jid, false, 'kal milte hai?', base, 'h1'),
        entry(jid, true, 'haan pakka', base + 10, 'h2'),
        entry(jid, false, 'kitne baje', base + 100, 'h3'),
        entry(jid, true, '5 baje', base + 105, 'h4'),
        entry(jid, true, 'chal done', base + 200, 'h5'),
        entry(jid, false, 'ok', base + 300, 'h6'),
        entry(jid, true, 'bye', base + 310, 'h7')
      ]
    });
  };

  const ready = async () => {
    await app.init();
    await app.start();
  };

  return {
    app, ev, sock, sent, reads, pairing, http, out, timers, clock, paths, qr, ready,
    entry, incoming, fromOwner, deliver, seedHistory, seconds,
    sockets: () => socketCount,
    socketOptions,
    fetchArgs,
    wsControl,
    toChat: (jid) => sent.filter((s) => s.jid === jid),
    toSelf: () => sent.filter((s) => s.jid === OWN_JID),
    store: () => app.getStore()
  };
}

module.exports = { createHarness, waitFor, delay, OWN_JID };
