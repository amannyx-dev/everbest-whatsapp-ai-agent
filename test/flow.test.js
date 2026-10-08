'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, waitFor, delay, OWN_JID } = require('./_harness');

const A = '919111111111@s.whatsapp.net'; // a friend the owner has chatted with
const B = '919222222222@s.whatsapp.net'; // a stranger (OTP sender, bank, unknown number)
const GROUP = '120363000000@g.us';

async function setup(options) {
  const h = createHarness(options);
  await h.ready();
  h.seedHistory(A);
  return h;
}

test('learns from history, announces READY and replies in a known chat using learned context', async (t) => {
  const h = await setup();
  t.after(() => h.app.shutdown());
  h.http.reply = 'haan bhai, abhi free hu';

  assert.ok(h.out.some((l) => l.includes('History sync batch: learned 4 owner messages')));
  assert.ok(h.out.some((l) => l.includes('READY')));

  h.deliver(h.incoming(A, 'bhai kya kar raha hai'));
  assert.ok(await waitFor(() => h.toChat(A).length === 1));
  assert.equal(h.toChat(A)[0].text, 'haan bhai, abhi free hu');
  assert.equal(h.reads.length, 1, 'message is marked as read');

  const { messages } = h.http.calls[0].body;
  const system = messages[0].content;
  assert.ok(system.includes('OWNER TEXTING STYLE'), 'owner style is in the prompt');
  assert.ok(!system.includes('Owner: haan pakka'), 'old owner replies are not used as semantic evidence');
  assert.ok(system.includes('Rahul'), 'contact name is in the prompt');
  assert.deepEqual(messages.slice(1).map((m) => m.role), ['user']);
  assert.equal(messages[messages.length - 1].content, 'bhai kya kar raha hai');
});


test("per-contact learning scans the person's old and live messages and sends a separate relevant question", async (t) => {
  const h = await setup({ config: { proactiveQuestion: true, questionDelayMs: 0 } });
  t.after(() => h.app.shutdown());
  h.http.reply = 'haan bhai, aaj free hu[[QUESTION]] kal kitne baje milna hai?';

  h.deliver(h.incoming(A, 'aaj kya plan hai'));
  assert.ok(await waitFor(() => h.toChat(A).length === 2));
  const profile = h.store().data.contacts[A];
  assert.ok(profile && profile.length >= 4, 'old history plus live message should be profiled');
  assert.equal(h.toChat(A)[0].text, 'haan bhai, aaj free hu');
  assert.equal(h.toChat(A)[1].text, 'kal kitne baje milna hai?');
  const system = h.http.calls[0].body.messages[0].content;
  assert.match(system, /OWNER TEXTING STYLE/i);
  assert.match(system, /CURRENT MESSAGE/i);
  assert.doesNotMatch(system, /OLD MESSAGES/);
});

test('a burst of messages is answered once, together', async (t) => {
  const h = await setup();
  t.after(() => h.app.shutdown());

  h.deliver(h.incoming(A, 'oye'));
  h.deliver(h.incoming(A, 'sun'));
  h.deliver(h.incoming(A, 'ek kaam tha'));
  assert.ok(await waitFor(() => h.toChat(A).length >= 1));
  await delay(120);

  assert.equal(h.http.calls.length, 1);
  assert.equal(h.toChat(A).length, 1);
  const last = h.http.calls[0].body.messages.at(-1).content;
  assert.equal(last, 'oye\nsun\nek kaam tha');
  assert.equal(h.reads[0].length, 3, 'all three messages are marked as read');
});

test('never replies to unknown chats, groups, status or channels', async (t) => {
  const h = await setup();
  t.after(() => h.app.shutdown());

  h.deliver([
    h.incoming(B, 'Your OTP is 123456'),
    h.incoming(GROUP, 'hello group'),
    h.incoming('status@broadcast', 'status update'),
    h.incoming('1234@newsletter', 'channel post')
  ]);
  await delay(150);
  assert.equal(h.sent.length, 0);
  assert.equal(h.http.calls.length, 0);
  assert.equal(h.store().data.recent[B], undefined, 'nothing is stored for unknown chats');
});

test('ignores history-sync and duplicate deliveries', async (t) => {
  const h = await setup();
  t.after(() => h.app.shutdown());

  const msg = h.incoming(A, 'ek baar');
  h.deliver(msg, 'append'); // old message replayed during sync: no reply
  await delay(100);
  assert.equal(h.http.calls.length, 0);

  const live = h.incoming(A, 'asli message');
  h.deliver(live);
  h.deliver(live); // delivered twice
  assert.ok(await waitFor(() => h.toChat(A).length >= 1));
  await delay(100);
  assert.equal(h.http.calls.length, 1);
});

test('[SKIP] sends no reply and notifies the owner once', async (t) => {
  const h = await setup();
  t.after(() => h.app.shutdown());
  h.http.reply = '[SKIP] asks for money';

  h.deliver(h.incoming(A, 'bhai 5000 bhej de urgent'));
  assert.ok(await waitFor(() => h.toSelf().length === 1));
  assert.equal(h.toChat(A).length, 0, 'nothing is sent to the friend');
  assert.match(h.toSelf()[0].text, /Needs you: Rahul wrote "bhai 5000 bhej de urgent" \(asks for money\)/);

  h.deliver(h.incoming(A, 'jaldi bhej'));
  assert.ok(await waitFor(() => h.http.calls.length === 2));
  await delay(100);
  assert.equal(h.toSelf().length, 1, 'no notification spam for the same chat');
});

test('notifications can be switched off', async (t) => {
  const h = await setup({ config: { notifyOwnerOnSkip: false } });
  t.after(() => h.app.shutdown());
  h.http.reply = '[SKIP]';
  h.deliver(h.incoming(A, 'are you a bot?'));
  assert.ok(await waitFor(() => h.http.calls.length === 1));
  await delay(100);
  assert.equal(h.sent.length, 0);
});

test('replying manually pauses the bot and cancels a reply that was about to be sent', async (t) => {
  const h = await setup({ config: { debounceMs: 100 } });
  t.after(() => h.app.shutdown());

  h.deliver(h.incoming(A, 'kya haal'));
  h.deliver(h.fromOwner(A, 'main khud reply kar raha hoon')); // owner types before the debounce ends
  await delay(250);
  assert.equal(h.http.calls.length, 0, 'pending reply was cancelled');

  h.deliver(h.incoming(A, 'sun'));
  await delay(250);
  assert.equal(h.http.calls.length, 0, 'bot stays quiet after a manual reply');
  assert.ok(h.store().data.messages.includes('main khud reply kar raha hoon'), 'and learns from it');
});

test('owner commands in the self chat control the bot', async (t) => {
  const h = await setup();
  t.after(() => h.app.shutdown());
  const say = async (text) => {
    const before = h.toSelf().length;
    h.deliver(h.fromOwner(OWN_JID, text));
    assert.ok(await waitFor(() => h.toSelf().length === before + 1));
    return h.toSelf().at(-1).text;
  };

  assert.match(await say('/bot off'), /OFF/);
  h.deliver(h.incoming(A, 'hello'));
  await delay(120);
  assert.equal(h.http.calls.length, 0, 'no reply while off');

  assert.match(await say('/bot on'), /ON/);
  h.deliver(h.incoming(A, 'hello again'));
  assert.ok(await waitFor(() => h.toChat(A).length === 1), 'replies again after /bot on');

  assert.match(await say('/bot status'), /Bot status: ON\.\nLearned: \d+ messages/);
  assert.match(await say('/bot mute 10'), /paused for 10 minutes/);
  assert.match(await say('/bot status'), /paused for 10 more minutes/);
  h.deliver(h.incoming(A, 'still there?'));
  await delay(120);
  assert.equal(h.toChat(A).length, 1, 'no reply while muted');

  assert.match(await say('/bot help'), /Bot commands/);
  assert.match(await say('/bot forget'), /forget confirm/);
  assert.ok(h.store().data.messages.length > 0);
  assert.match(await say('/bot forget confirm'), /erased/);
  assert.equal(h.store().data.messages.length, 0);
});

test('notes to self are never learned and are not treated as chat', async (t) => {
  const h = await setup();
  t.after(() => h.app.shutdown());
  h.deliver(h.fromOwner(OWN_JID, 'remember to buy milk'));
  await delay(60);
  assert.equal(h.sent.length, 0);
  assert.ok(!h.store().data.messages.includes('remember to buy milk'));
});

test('the bot never learns from its own messages', async (t) => {
  const h = await setup();
  t.after(() => h.app.shutdown());
  h.http.reply = 'haan bhai pakka';
  h.deliver(h.incoming(A, 'aa raha hai?'));
  assert.ok(await waitFor(() => h.toChat(A).length === 1));

  // WhatsApp echoes the bot's own message back as "from me"
  h.deliver({ key: { remoteJid: A, fromMe: true, id: 'BOT1' }, message: { conversation: 'haan bhai pakka' }, messageTimestamp: h.seconds() });
  await delay(60);
  assert.ok(!h.store().data.messages.includes('haan bhai pakka'));
  assert.ok(!h.store().data.chatMsgs[A].includes('haan bhai pakka'));
});

test('limits replies per chat per hour (loop protection)', async (t) => {
  const h = await setup({ config: { maxRepliesPerChatPerHour: 1 } });
  t.after(() => h.app.shutdown());

  h.deliver(h.incoming(A, 'pehla'));
  assert.ok(await waitFor(() => h.toChat(A).length === 1));
  h.deliver(h.incoming(A, 'doosra'));
  await delay(150);
  assert.equal(h.toChat(A).length, 1);

  h.clock.t += 61 * 60 * 1000; // an hour later
  h.deliver(h.incoming(A, 'teesra'));
  assert.ok(await waitFor(() => h.toChat(A).length === 2));
});

test('respects quiet hours', async (t) => {
  const night = new Date(2026, 9, 7, 2, 0).getTime();
  const h = await setup({ startTime: night, config: { quietHours: '23:00-07:00' } });
  t.after(() => h.app.shutdown());

  h.deliver(h.incoming(A, 'raat ke 2 baje'));
  await delay(150);
  assert.equal(h.http.calls.length, 0);

  h.clock.t = new Date(2026, 9, 7, 9, 0).getTime();
  h.deliver(h.incoming(A, 'subah ho gayi'));
  assert.ok(await waitFor(() => h.toChat(A).length === 1));
});

test('does not require global learning once a known chat has history', async (t) => {
  const h = await setup({ config: { minLearnedMessages: 50 } });
  t.after(() => h.app.shutdown());
  h.deliver(h.incoming(A, 'hello'));
  assert.ok(await waitFor(() => h.toChat(A).length === 1));
  assert.equal(h.http.calls.length, 1);
});

test('keeps the quoted message as context', async (t) => {
  const h = await setup();
  t.after(() => h.app.shutdown());
  h.deliver(
    h.incoming(A, 'haan chalega', {
      message: { extendedTextMessage: { text: 'haan chalega', contextInfo: { quotedMessage: { conversation: 'dinner kal?' } } } }
    })
  );
  assert.ok(await waitFor(() => h.http.calls.length === 1));
  assert.equal(h.http.calls[0].body.messages.at(-1).content, '(replying to "dinner kal?") haan chalega');
});

test('a failing Groq request is logged and nothing is sent', async (t) => {
  const h = await setup();
  t.after(() => h.app.shutdown());
  h.http.post = async () => {
    throw Object.assign(new Error('bad key'), { response: { status: 401 } });
  };
  h.deliver(h.incoming(A, 'hello'));
  assert.ok(await waitFor(() => h.out.some((l) => l.includes('Could not generate a reply'))));
  assert.ok(h.out.some((l) => l.includes('Groq rejected the API key')));
  assert.equal(h.sent.length, 0);
});

/* ---------------------------------- connection --------------------------------- */
const closeWith = (code, message) => ({
  connection: 'close',
  lastDisconnect: { error: Object.assign(new Error(message), { output: { statusCode: code } }) }
});

test('connection problems show the real code, a hint, back off and run a full network check', async (t) => {
  const h = await setup();
  t.after(() => h.app.shutdown());

  h.ev.emit('connection.update', closeWith(428, 'Connection Terminated'));
  assert.ok(h.out.some((l) => l.includes('Connection closed (code: 428, reason: Connection Terminated)')));
  assert.ok(h.out.some((l) => l.includes('blocking or interrupting WebSocket connections')));
  assert.equal(h.timers.at(-1).ms, 5000);
  assert.ok(await waitFor(() => h.out.some((l) => l.includes('WebSocket to WhatsApp: connected OK'))));
  assert.ok(h.out.some((l) => l.includes('web.whatsapp.com: reachable')));
  assert.ok(h.wsControl.urls.includes('wss://web.whatsapp.com/ws/chat'));

  h.ev.emit('connection.update', closeWith(405, 'Connection Failure'));
  assert.equal(h.timers.at(-1).ms, 10000, 'back-off doubles');
  assert.ok(h.out.some((l) => l.includes('npm install @whiskeysockets/baileys@latest')));

  const before = h.sockets();
  h.timers.at(-1).fn(); // the scheduled retry reconnects
  assert.ok(await waitFor(() => h.sockets() === before + 1));
});

test('the connection check says clearly when the network blocks WebSockets', async (t) => {
  for (const behavior of ['close', 'error']) {
    const h = await setup({ ws: behavior });
    t.after(() => h.app.shutdown());
    h.ev.emit('connection.update', closeWith(428, 'Connection Terminated'));
    assert.ok(await waitFor(() => h.out.some((l) => l.includes('WebSocket to WhatsApp: FAILED'))), behavior);
    assert.ok(h.out.some((l) => l.includes('Your network is blocking WebSocket connections')), behavior);
    assert.ok(h.out.some((l) => l.includes('mobile hotspot')), behavior);
  }
});

test('after repeated failures the bot switches to compatibility mode and remembers what works', async (t) => {
  const h = await setup();
  t.after(() => h.app.shutdown());

  // first attempt: desktop mode with full history
  assert.deepEqual(h.socketOptions[0].browser, ['Mac OS', 'Desktop', '14']);
  assert.equal(h.socketOptions[0].syncFullHistory, true);
  assert.ok(h.out.some((l) => l.includes('Connecting to WhatsApp (desktop mode)')));
  assert.equal(h.fetchArgs[0].timeout, 5000, 'the version lookup cannot hang forever');

  h.ev.emit('connection.update', closeWith(428, 'Connection Terminated'));
  h.ev.emit('connection.update', closeWith(428, 'Connection Terminated'));
  assert.ok(h.out.some((l) => l.includes('Switching to compatibility mode')));

  const before = h.sockets();
  h.timers.at(-1).fn();
  assert.ok(await waitFor(() => h.sockets() === before + 1));
  const last = h.socketOptions.at(-1);
  assert.deepEqual(last.browser, ['Ubuntu', 'Chrome', '22.04.4']);
  assert.equal(last.syncFullHistory, true);
  assert.equal(last.markOnlineOnConnect, false);

  h.ev.emit('connection.update', { connection: 'open' });
  assert.ok(h.out.some((l) => l.includes('Running in compatibility mode')));
  h.store().flush();
  assert.equal(JSON.parse(require('fs').readFileSync(h.paths.learned, 'utf8')).state.profile, 1);
});

test('a mode that worked before is used again on the next start', async (t) => {
  const first = await setup();
  first.store().data.state.profile = 1;
  first.store().flush();
  first.app.shutdown();

  const again = createHarness();
  require('fs').copyFileSync(first.paths.learned, again.paths.learned);
  t.after(() => again.app.shutdown());
  await again.ready();
  assert.ok(again.out.some((l) => l.includes('compatibility mode')));
  assert.equal(again.socketOptions[0].syncFullHistory, true);
});

test('a restart request after scanning the QR code reconnects immediately', async (t) => {
  const h = await setup();
  t.after(() => h.app.shutdown());
  const before = h.sockets();
  h.ev.emit('connection.update', closeWith(515, 'restart required'));
  assert.ok(await waitFor(() => h.sockets() === before + 1));
  assert.equal(h.timers.length, 0, 'no waiting, no back-off');
  assert.ok(!h.out.some((l) => l.includes('Connection closed')), 'and no scary message');
});

test('logging out is reported clearly and the bot does not retry', async (t) => {
  const h = await setup();
  t.after(() => h.app.shutdown());
  const before = h.sockets();
  h.ev.emit('connection.update', closeWith(401, 'logged out'));
  assert.ok(h.out.some((l) => l.includes('Logged out of WhatsApp') && l.includes('relink')));
  assert.equal(h.timers.length, 0);
  assert.equal(h.sockets(), before);
});

test('logging in: QR code by default, pairing code when a phone number is given', async (t) => {
  const qr = createHarness({ registered: false, ask: async () => '' });
  t.after(() => qr.app.shutdown());
  await qr.ready();
  qr.ev.emit('connection.update', { qr: 'QR-DATA' });
  assert.deepEqual(qr.qr.generated, ['QR-DATA']);
  assert.equal(qr.pairing.length, 0);

  const pair = createHarness({ registered: false, ask: async () => '+91 98765 43210' });
  t.after(() => pair.app.shutdown());
  await pair.ready();
  pair.ev.emit('connection.update', { qr: 'QR-DATA' });
  assert.ok(await waitFor(() => pair.pairing.length === 1));
  assert.equal(pair.pairing[0], '919876543210');
  assert.ok(pair.out.some((l) => l.includes('ABCD-1234')));
  pair.ev.emit('connection.update', { qr: 'QR-DATA-2' }); // later QR refreshes are ignored
  assert.equal(pair.qr.generated.length, 0);

  const fallback = createHarness({ registered: false, pairingFails: true, ask: async () => '919876543210' });
  t.after(() => fallback.app.shutdown());
  await fallback.ready();
  fallback.ev.emit('connection.update', { qr: 'QR-X' });
  assert.ok(await waitFor(() => fallback.qr.generated.length === 1), 'falls back to a QR code if pairing fails');
});
