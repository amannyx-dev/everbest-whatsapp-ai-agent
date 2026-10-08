'use strict';

const STOP = new Set(['hai','haan','h','he','ka','ke','ki','ko','kya','the','and','you','are','for','this','that','bro','bhai','yaar','aur','to','me','main','mai','se','on','in','of','a','an','is','it','i','my','your','bas','nhi','nahi','na','but','bhi','ye','wo','or','so']);
const POS = ['haha','lol','nice','great','mast','sahi','awesome','love','good','yay','😂','🤣','❤️','❤','🔥','😄','😁','😌'];
const NEG = ['sad','upset','angry','gussa','problem','issue','tension','worried','pareshan','hate','bad','sorry','cry','dukhi','bura','faltu'];
const URGENT = ['urgent','asap','jaldi','abhi','immediately','emergency','help','please call','call me'];

function tokens(text) {
  return String(text || '').toLowerCase().match(/[a-z\u0900-\u097f0-9']{2,}/g) || [];
}
function normalize(text) { return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function wordCount(text) { return String(text || '').trim().split(/\s+/).filter(Boolean).length; }
function overlap(a, b) {
  const A = new Set(tokens(a).filter(x => !STOP.has(x)));
  const B = new Set(tokens(b).filter(x => !STOP.has(x)));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.sqrt(A.size * B.size);
}
function classify(text) {
  const t = normalize(text);
  const ts = tokens(t);
  const has = (arr) => arr.some(x => t.includes(x));
  let intent = 'chat';
  if (/\?$/.test(t) || /\b(why|how|when|where|what|who|which|kya|kaise|kab|kaha|kyu|kyon|kon)\b/i.test(t)) intent = 'question';
  else if (has(['congrats','happy birthday','happy anniversary','all the best'])) intent = 'celebration';
  else if (has(['sorry','maaf','forgive'])) intent = 'apology';
  else if (has(['thanks','thank you','thx','ty'])) intent = 'gratitude';
  else if (has(['bye','good night','gn','good morning','gm','good afternoon'])) intent = 'greeting_or_closing';
  else if (has(['plan','meet','milte','kab mil','aa raha','coming','party'])) intent = 'planning';
  else if (has(['help','problem','issue','tension'])) intent = 'support';
  const pos = POS.reduce((n, x) => n + (t.includes(x) ? 1 : 0), 0);
  const neg = NEG.reduce((n, x) => n + (t.includes(x) ? 1 : 0), 0);
  const sentiment = pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral';
  const urgency = has(URGENT) ? 'high' : 'normal';
  const question = /[?؟]/.test(t) || intent === 'question';
  return { intent, sentiment, urgency, question, words: wordCount(t), emoji: /\p{Extended_Pictographic}/u.test(t), tokens: [...new Set(ts.filter(x => !STOP.has(x)))].slice(0, 20) };
}

function scoreText(query, candidate, recencyBoost = 0) {
  const q = new Set(tokens(query).filter(x => !STOP.has(x)));
  const c = tokens(candidate);
  let hits = 0;
  for (const x of q) if (c.includes(x)) hits++;
  return hits * 4 + overlap(query, candidate) * 8 + recencyBoost;
}

function retrieveWindows(history, query, maxTurns = 24) {
  if (!Array.isArray(history) || !history.length) return [];
  const scored = history.map((turn, i) => ({ turn, i, score: scoreText(query, turn.t, i / Math.max(1, history.length) * 0.8) }));
  const picked = new Set();
  scored.sort((a,b) => b.score - a.score).slice(0, Math.max(4, Math.floor(maxTurns / 3))).forEach(x => {
    for (let j = Math.max(0, x.i - 2); j <= Math.min(history.length - 1, x.i + 2); j++) picked.add(j);
  });
  const recentStart = Math.max(0, history.length - Math.min(8, maxTurns));
  for (let i = recentStart; i < history.length; i++) picked.add(i);
  return [...picked].sort((a,b) => a-b).slice(-maxTurns).map(i => history[i]);
}

function chooseQuestion(context) {
  const { incoming, reply, profile } = context;
  const c = classify(incoming);
  if (c.intent === 'greeting_or_closing' || c.intent === 'gratitude') return false;
  if (profile?.doubleTexts && c.words <= 3) return false; // don't interrogate rapid-fire fragments
  if (/\b(haan|ok|okay|acha|accha|hmm|hm|lol|haha|😂|🤣)\b/i.test(normalize(incoming)) && wordCount(reply) < 8) return false;
  return true;
}

function shouldSkipDuplicate(reply, previousReplies = []) {
  const n = normalize(reply);
  if (!n) return true;
  return previousReplies.some(x => normalize(x) === n || overlap(n, x) > 0.93);
}

module.exports = { tokens, normalize, wordCount, classify, scoreText, retrieveWindows, chooseQuestion, shouldSkipDuplicate, overlap };
