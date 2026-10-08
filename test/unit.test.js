'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store, isLearnable } = require('../src/store');
const { analyzeStyle } = require('../src/style');
const { buildSystemPrompt } = require('../src/prompt');
const { parseReply, requestReply } = require('../src/llm');
const { normalizeConfig, loadConfig, ConfigError, DEFAULT_CONFIG } = require('../src/config');
const { isPersonalChat, shouldReplyTo, parseQuietHours, inQuietHours, RateLimiter, parseCommand } = require('../src/rules');
const { toNumber, clip } = require('../src/util');

const tmpFile = (name = 'learned.json') => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-')), name);

/* ------------------------------------ util ------------------------------------ */
test('toNumber handles numbers, strings and protobuf Long objects', () => {
  assert.equal(toNumber(1700000000), 1700000000);
  assert.equal(toNumber('1700000000'), 1700000000);
  assert.equal(toNumber({ low: 1700000000, high: 0 }), 1700000000);
  assert.equal(toNumber({ toNumber: () => 42 }), 42);
  assert.equal(toNumber(undefined), 0);
});

test('clip shortens long text', () => {
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('abc', 4), 'abc');
});

/* ----------------------------------- store ------------------------------------ */
test('isLearnable rejects OTPs, links, e-mails, credentials, media placeholders and long text', () => {
  for (const bad of ['your otp is 483920', 'see https://example.com', 'mail me a@b.com', 'my password is x', '<Media omitted>', 'x'.repeat(301), '   ']) {
    assert.equal(isLearnable(bad), false, bad);
  }
  assert.equal(isLearnable('haan pakka'), true);
});

test('store deduplicates messages, counts chats and builds reply pairs', () => {
  const store = new Store(tmpFile());
  assert.equal(store.addOwnerMessage('a', 'haan pakka', 'kal milte hai?'), true);
  store.addOwnerMessage('a', 'haan pakka', 'kal milte hai?');
  store.addOwnerMessage('a', 'ok', null);
  assert.deepEqual(store.data.messages, ['haan pakka', 'ok']);
  assert.equal(store.data.pairs.length, 1);
  assert.equal(store.data.chats.a, 3);
  assert.equal(store.isKnownChat('a'), true);
  assert.equal(store.isKnownChat('b'), false);
});

test('store does not keep sensitive text, but still counts the chat', () => {
  const store = new Store(tmpFile());
  assert.equal(store.addOwnerMessage('a', 'otp 123456', null), false);
  assert.equal(store.data.messages.length, 0);
  assert.equal(store.data.chats.a, 1);
  store.addOwnerMessage('a', 'sure', 'your code is 998877');
  assert.equal(store.data.pairs.length, 0);
});

test('history learning orders by time and only pairs replies given within 10 minutes', () => {
  const store = new Store(tmpFile());
  const added = store.learnFromHistory([
    { chatId: 'a', fromMe: true, text: 'late reply', ts: 5000 },
    { chatId: 'a', fromMe: false, text: 'question', ts: 1000 },
    { chatId: 'a', fromMe: true, text: 'quick reply', ts: 1050 },
    { chatId: 'a', fromMe: false, text: 'old question', ts: 2000 },
    { chatId: 'a', fromMe: true, text: 'way later', ts: 4000 }
  ]);
  assert.equal(added, 3);
  assert.deepEqual(store.data.pairs.map((p) => [p.them, p.me]), [['question', 'quick reply']]);
});

test('conversation context is kept only for known chats, capped, and filtered by age', () => {
  const store = new Store(tmpFile());
  store.pushRecent('stranger', 'u', 'hello', 100);
  assert.equal(store.data.recent.stranger, undefined);

  for (const t of ['a', 'b', 'c']) store.addOwnerMessage('friend', t, null);
  for (let i = 0; i < 20; i++) store.pushRecent('friend', i % 2 ? 'a' : 'u', `m${i}`, 1000 + i);
  assert.equal(store.data.recent.friend.length, 12);
  const nowMs = (1000 + 19) * 1000;
  assert.equal(store.getRecent('friend', 5000, nowMs).length, 6); // only the last ~5 seconds
});

test('history keeps the latest turns of known chats only', () => {
  const store = new Store(tmpFile());
  store.learnFromHistory([
    { chatId: 'known', fromMe: false, text: 'q1', ts: 10 },
    { chatId: 'known', fromMe: true, text: 'a1', ts: 11 },
    { chatId: 'known', fromMe: true, text: 'a2', ts: 12 },
    { chatId: 'known', fromMe: true, text: 'a3', ts: 13 },
    { chatId: 'other', fromMe: false, text: 'hi', ts: 14 }
  ]);
  assert.equal(store.data.recent.known.length, 4);
  assert.equal(store.data.recent.other, undefined);
});

test('store survives a restart and recovers from a corrupted file', () => {
  const file = tmpFile();
  const a = new Store(file);
  a.addOwnerMessage('x', 'persist me', null);
  a.flush();
  assert.deepEqual(new Store(file).data.messages, ['persist me']);

  fs.writeFileSync(file, '{ this is not json');
  const b = new Store(file);
  assert.equal(b.corrupted, true);
  assert.equal(b.data.messages.length, 0);
  assert.equal(fs.existsSync(`${file}.corrupt`), true);
});

test('store enforces its size limits and forget() erases data but keeps on/off state', () => {
  const store = new Store(tmpFile(), { messages: 3, pairs: 2 });
  for (let i = 0; i < 6; i++) store.addOwnerMessage('c', `msg ${i}`, `q ${i}`);
  assert.deepEqual(store.data.messages, ['msg 3', 'msg 4', 'msg 5']);
  assert.equal(store.data.pairs.length, 2);

  store.data.state.enabled = false;
  store.forget();
  assert.equal(store.data.messages.length, 0);
  assert.equal(store.data.state.enabled, false);
});

/* ------------------------------------ style ----------------------------------- */
test('analyzeStyle describes length, casing and emoji without semantic word lists', () => {
  const style = analyzeStyle(['haan bhai', 'kal milte hai', 'ok 😂', 'chal theek hai', 'haan bhai pakka']);
  assert.equal(style.usesEmoji, true);
  assert.ok(style.avgWords >= 2 && style.avgWords <= 4);
  assert.match(style.summary, /lowercase/);
  assert.doesNotMatch(style.summary, /Words they use a lot/i);
  assert.ok(style.examples.includes('chal theek hai'));
});

/* ------------------------------------ prompt ---------------------------------- */
test('system prompt separates content from owner texting style', () => {
  const prompt = buildSystemPrompt({
    style: analyzeStyle(['haan bhai', 'ok']),
    chatMsgs: [{ r: 'u', t: 'yaar kya haal' }],
    contactName: 'Rahul',
    now: new Date(2026, 9, 7, 15, 41),
    incomingText: 'kal milna hai?'
  });
  for (const part of ['Rahul', 'OWNER TEXTING STYLE', 'kal milna hai?', 'skip', 'untrusted']) {
    assert.ok(prompt.includes(part), `missing: ${part}`);
  }
  assert.match(prompt, /NEVER use the owner.?s old replies as semantic evidence/i);
  assert.doesNotMatch(prompt, /Owner: haan pakka/);
});

/* ------------------------------------- llm ------------------------------------ */
test('parseReply supports the separate follow-up question marker', () => {
  assert.deepEqual(parseReply('haan bhai[[QUESTION]] kal free hai kya?'), { type: 'reply', text: 'haan bhai', question: 'kal free hai kya?' });
});

test('parseReply cleans output and detects [SKIP]', () => {
  assert.deepEqual(parseReply('  haan bhai  '), { type: 'reply', text: 'haan bhai' });
  assert.equal(parseReply('"haan bhai"').text, 'haan bhai');
  assert.equal(parseReply('Reply: ok done').text, 'ok done');
  assert.deepEqual(parseReply('[SKIP] asks for money'), { type: 'skip', reason: 'asks for money' });
  assert.equal(parseReply('[skip]').type, 'skip');
  assert.equal(parseReply('skip it bro').type, 'reply'); // a normal sentence is not a skip
  assert.equal(parseReply('As an AI language model, I cannot').type, 'skip');
  assert.equal(parseReply('   ').type, 'empty');
  assert.ok(parseReply('word '.repeat(300)).text.length <= 500);
});


test('parseReply accepts the reliable plain-text REPLY/QUESTION contract', () => {
  const out = parseReply('REPLY: kal milte hain bhai\nQUESTION: kitne baje aana hai?');
  assert.equal(out.type, 'reply');
  assert.equal(out.text, 'kal milte hain bhai');
  assert.equal(out.question, 'kitne baje aana hai?');
});

test('requestReply uses plain text transport with no provider JSON schema', async () => {
  let responseFormatSeen = false;
  const http = { post: async (_url, body) => {
    responseFormatSeen = !!body.response_format;
    return { data: { choices: [{ message: { content: 'REPLY: haan bhai aa jaunga\nQUESTION: kitne baje?' } }] } };
  }};
  const out = await requestReply({ http, config: { model: 'm', fallbackModel: 'f', groqApiKey: 'k', responseFormat: 'json' }, system: 's', messages: [], sleep: async () => {} });
  assert.equal(out.includes('REPLY:'), true);
  assert.equal(responseFormatSeen, false);
});
test('requestReply falls back to the second model after a 429 and honours retry-after', async () => {
  const models = [];
  const waits = [];
  const http = {
    post: async (url, body) => {
      models.push(body.model);
      if (models.length === 1) throw Object.assign(new Error('rate'), { response: { status: 429, headers: { 'retry-after': '2' } } });
      return { data: { choices: [{ message: { content: 'ok' } }] } };
    }
  };
  const config = { model: 'main', fallbackModel: 'small', groqApiKey: 'k' };
  const out = await requestReply({ http, config, system: 's', messages: [], sleep: async (ms) => waits.push(ms) });
  assert.equal(out, 'ok');
  assert.deepEqual(models, ['main', 'small']);
  assert.deepEqual(waits, [2000]);
});

test('requestReply keeps a healthy model usable when structured output fails', async () => {
  const modes = [];
  const http = { post: async (_url, body) => {
    modes.push(body.response_format?.type || 'none');
    if (body.response_format) throw Object.assign(new Error('schema'), { response: { status: 400, data: { error: { message: 'Failed to validate JSON. Please adjust your prompt.' } } } });
    return { data: { choices: [{ message: { content: JSON.stringify({ action: 'reply', reply: 'haan bhai', question: '', confidence: '92', reason: '' }) } }] } };
  }};
  const out = await requestReply({ http, config: { model: 'm', fallbackModel: 'f', groqApiKey: 'k' }, system: 's', messages: [], sleep: async () => {} });
  assert.ok(out.includes('haan bhai'));
  assert.deepEqual(modes, ['none']);
});

test('requestReply fails fast on an invalid API key and explains it', async () => {
  let calls = 0;
  const http = { post: async () => { calls++; throw Object.assign(new Error('x'), { response: { status: 401 } }); } };
  await assert.rejects(
    requestReply({ http, config: { model: 'm', groqApiKey: 'bad' }, system: 's', messages: [], sleep: async () => {} }),
    (err) => err.fatal === true && /API key/.test(err.message)
  );
  assert.equal(calls, 1);
});

test('requestReply gives up with a clear error after all attempts', async () => {
  const http = { post: async () => { throw Object.assign(new Error('boom'), { response: { status: 503 } }); } };
  await assert.rejects(
    requestReply({ http, config: { model: 'm', fallbackModel: 'f', groqApiKey: 'k' }, system: 's', messages: [], sleep: async () => {} }),
    /HTTP 503/
  );
});

/* ----------------------------------- config ----------------------------------- */
test('normalizeConfig fills defaults, sanitises values and migrates old configs', () => {
  const c = normalizeConfig({ groqApiKey: ' key ', debounceMs: 'abc', allowList: 'nope', typingMsPerChar: 50, maxTypingDelayMs: 4000, minLearnedMessages: 20 });
  assert.equal(c.groqApiKey, 'key');
  assert.equal(c.debounceMs, DEFAULT_CONFIG.debounceMs);
  assert.deepEqual(c.allowList, []);
  assert.equal(c.typingMsPerChar, 25); // very old config -> faster defaults
  assert.equal(c.minLearnedMessages, 5);
  assert.equal(c.configVersion, 12);
  assert.equal(c.preferIPv4, true);

  const v3 = normalizeConfig({ configVersion: 3, typingMsPerChar: 40 });
  assert.equal(v3.typingMsPerChar, 40); // current configs are never overwritten
  const migrated = normalizeConfig({ configVersion: 3, model: 'llama-3.3-70b-versatile', fallbackModel: 'llama-3.1-8b-instant' });
  assert.equal(migrated.model, 'openai/gpt-oss-120b');
  assert.equal(migrated.fallbackModel, 'openai/gpt-oss-20b');
});

test('loadConfig asks for the API key on first run and saves the file', async () => {
  const file = tmpFile('config.json');
  const config = await loadConfig(file, async () => '  gsk_abc  ');
  assert.equal(config.groqApiKey, 'gsk_abc');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).groqApiKey, 'gsk_abc');
  // second run: no prompt
  const again = await loadConfig(file, async () => { throw new Error('should not ask'); });
  assert.equal(again.groqApiKey, 'gsk_abc');
});

test('loadConfig rejects a missing key and a corrupted file', async () => {
  await assert.rejects(loadConfig(tmpFile('config.json'), async () => ''), ConfigError);
  const bad = tmpFile('config.json');
  fs.writeFileSync(bad, '{{{');
  await assert.rejects(loadConfig(bad, async () => 'k'), /corrupted/);
});

/* ------------------------------------ rules ----------------------------------- */
test('isPersonalChat accepts people and rejects groups, status and channels', () => {
  assert.equal(isPersonalChat('919111111111@s.whatsapp.net'), true);
  assert.equal(isPersonalChat('12345@lid'), true);
  for (const jid of ['120363@g.us', 'status@broadcast', '1@newsletter', '', undefined]) assert.equal(isPersonalChat(jid), false);
});

test('shouldReplyTo honours ignore list, allow list and known-chat rule', () => {
  const known = { isKnownChat: (id) => id === 'friend' };
  const base = { ignoreList: [], allowList: [], onlyReplyToKnownChats: true };
  assert.equal(shouldReplyTo('friend', base, known), true);
  assert.equal(shouldReplyTo('stranger', base, known), false);
  assert.equal(shouldReplyTo('stranger', { ...base, onlyReplyToKnownChats: false }, known), true);
  assert.equal(shouldReplyTo('friend', { ...base, ignoreList: ['friend'] }, known), false);
  assert.equal(shouldReplyTo('stranger', { ...base, allowList: ['stranger'] }, known), true);
  assert.equal(shouldReplyTo('friend', { ...base, allowList: ['stranger'] }, known), false);
});

test('quiet hours support overnight and same-day windows', () => {
  assert.equal(parseQuietHours('bad'), null);
  assert.equal(parseQuietHours('25:00-07:00'), null);
  assert.equal(parseQuietHours('10:00-10:00'), null);
  const at = (h, m = 0) => new Date(2026, 9, 7, h, m);
  assert.equal(inQuietHours('23:00-07:00', at(23, 30)), true);
  assert.equal(inQuietHours('23:00-07:00', at(2)), true);
  assert.equal(inQuietHours('23:00-07:00', at(7)), false);
  assert.equal(inQuietHours('23:00-07:00', at(12)), false);
  assert.equal(inQuietHours('13:00-15:00', at(14)), true);
  assert.equal(inQuietHours('13:00-15:00', at(16)), false);
  assert.equal(inQuietHours('', at(3)), false);
});

test('RateLimiter allows N per rolling hour per chat', () => {
  const r = new RateLimiter(2, 1000);
  assert.equal(r.canSend('a', 0), true);
  r.record('a', 0);
  r.record('a', 100);
  assert.equal(r.canSend('a', 200), false);
  assert.equal(r.canSend('b', 200), true);
  assert.equal(r.canSend('a', 1200), true);
  assert.equal(new RateLimiter(0).canSend('a'), true); // 0 = unlimited
});

test('parseCommand understands /bot commands only', () => {
  assert.deepEqual(parseCommand('/bot off'), { name: 'off', arg: '' });
  assert.deepEqual(parseCommand('  /BOT mute 30 '), { name: 'mute', arg: '30' });
  assert.deepEqual(parseCommand('/bot forget confirm'), { name: 'forget', arg: 'confirm' });
  assert.deepEqual(parseCommand('/bot'), { name: 'help', arg: '' });
  assert.equal(parseCommand('hello /bot off'), null);
  assert.equal(parseCommand('buy milk'), null);
});

/* ------------------------- real ws library, local servers --------------------- */
test('the WebSocket check works with the real ws library: open, refused and cut-off connections', async (t) => {
  let WebSocket;
  try { WebSocket = require('ws'); } catch { t.skip('ws is installed by npm ci in the normal project environment'); return; }
  const http = require('http');
  const { createApp } = require('../src/app');
  const make = (port) => createApp({ WebSocket, wsUrl: `ws://127.0.0.1:${port}`, paths: {}, log: { log() {} } });
  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  // 1) a normal WebSocket server: connection opens
  const good = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => good.on('listening', r));
  const goodPort = good.address().port;
  assert.deepEqual(await make(goodPort).checkWebSocket(3000), { ok: true });
  good.close();

  // 2) nothing is listening: fails fast with a reason
  const refused = await make(goodPort).checkWebSocket(3000);
  assert.equal(refused.ok, false);
  assert.ok(refused.detail);

  // 3) a middlebox that kills the connection during the upgrade: reported as a failure, never hangs
  const killer = http.createServer();
  killer.on('upgrade', (req, socket) => socket.destroy());
  const killerPort = await listen(killer);
  const cut = await make(killerPort).checkWebSocket(3000);
  assert.equal(cut.ok, false);
  assert.ok(cut.detail);
  killer.close();

  // 4) a server that never answers: the timeout ends the check
  const silent = http.createServer();
  silent.on('upgrade', () => {});
  const silentPort = await listen(silent);
  const started = Date.now();
  const timedOut = await make(silentPort).checkWebSocket(400);
  assert.equal(timedOut.ok, false);
  assert.ok(Date.now() - started < 2000);
  silent.closeAllConnections?.();
  silent.close();
});

test('advanced brain builds contact-specific conversation signals', () => {
  const { buildBrain, validateReply } = require('../src/brain');
  const history = [
    { r: 'u', t: 'kal college aa raha hai?', ts: 100 },
    { r: 'a', t: 'haan aaunga bhai', ts: 110 },
    { r: 'u', t: 'kitne baje?', ts: 120 },
    { r: 'a', t: '10 baje tak', ts: 130 },
    { r: 'u', t: 'canteen me milte?', ts: 140 },
    { r: 'a', t: 'haan canteen me', ts: 150 }
  ];
  const brain = buildBrain({ history, contactProfile: { questionPct: 50 }, ownerStyle: { avgWords: 4, questionPct: 30 }, incoming: 'college kab aa raha hai?' });
  assert.ok(brain.topics.length > 0);
  assert.ok(brain.sameTopic.length > 0);
  assert.ok(brain.targetWords <= 35);
  assert.ok(brain.summary.includes('Follow-up question likelihood'));
  assert.equal(validateReply('haan bhai', 'college kab aa raha hai?', [], brain).ok, false);
  assert.equal(validateReply('As an AI, I cannot...', 'kya kar raha hai?', [], brain).ok, false);
});
