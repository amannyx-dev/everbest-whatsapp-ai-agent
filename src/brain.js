'use strict';

const { classify, normalize, tokens, overlap, wordCount } = require('./intelligence');

const STOP = new Set(['hai','haan','h','he','ka','ke','ki','ko','kya','the','and','you','are','for','this','that','bro','bhai','yaar','aur','to','me','main','mai','se','on','in','of','a','an','is','it','i','my','your','bas','nhi','nahi','na','but','bhi','ye','wo','or','so']);

function keyPhrases(text) {
  const ts = tokens(text).filter(t => !STOP.has(t) && t.length > 2);
  const out = [];
  for (let n = 2; n >= 1; n--) {
    for (let i = 0; i <= ts.length - n; i++) {
      const p = ts.slice(i, i + n).join(' ');
      if (p.length >= 4 && !out.includes(p)) out.push(p);
    }
  }
  return out.slice(0, 12);
}

function extractTopics(history = []) {
  const freq = new Map();
  for (const t of history) {
    if (!t?.t) continue;
    for (const phrase of keyPhrases(t.t)) freq.set(phrase, (freq.get(phrase) || 0) + 1);
  }
  return [...freq.entries()].sort((a,b) => b[1] - a[1]).slice(0, 15).map(([text,count]) => ({ text, count }));
}

function unansweredQuestions(history = []) {
  // Deliberately style/context-only: we do NOT inspect old owner replies to decide the new answer.
  // Keep only recent questions asked by the person so follow-up planning can avoid repeating them.
  const out = [];
  for (let i = 0; i < history.length; i++) {
    const t = history[i];
    if (t?.r !== 'u' || !/[?؟]/.test(t.t || '')) continue;
    const n = normalize(t.t);
    if (!n) continue;
    if (!out.some((x) => normalize(x) === n || overlap(x, t.t) > 0.9)) out.push(t.t);
  }
  return out.slice(-5);
}

function relationshipSignals(history = []) {
  const incoming = history.filter(x => x.r === 'u');
  const owner = history.filter(x => x.r === 'a');
  const avgGap = (() => {
    const ts = history.map(x => Number(x.ts)).filter(Boolean);
    if (ts.length < 2) return 0;
    let total = 0, n = 0;
    for (let i = 1; i < ts.length; i++) {
      const gap = ts[i] - ts[i-1];
      if (gap >= 0 && gap < 86400) { total += gap; n++; }
    }
    return n ? Math.round(total / n) : 0;
  })();
  const ownerAvg = owner.length ? owner.reduce((n,x)=>n+wordCount(x.t),0)/owner.length : 0;
  const theirAvg = incoming.length ? incoming.reduce((n,x)=>n+wordCount(x.t),0)/incoming.length : 0;
  const balance = owner.length / Math.max(1, incoming.length);
  return {
    incomingCount: incoming.length,
    ownerCount: owner.length,
    ownerToIncomingRatio: Number(balance.toFixed(2)),
    ownerAvgWords: Math.round(ownerAvg * 10) / 10,
    theirAvgWords: Math.round(theirAvg * 10) / 10,
    typicalGapSeconds: avgGap
  };
}

function buildBrain({ history = [], contactProfile = {}, ownerStyle = null, incoming = '' }) {
  const analysis = classify(incoming);
  const topics = extractTopics(history);
  const open = unansweredQuestions(history);
  const relation = relationshipSignals(history);
  const localOwnerExamples = history.filter(x => x.r === 'a').slice(-35).map(x => x.t);
  const sameTopic = history
    .map((t, i) => ({ t, i, score: t?.t ? overlap(incoming, t.t) : 0 }))
    .filter(x => x.score > 0.08)
    .sort((a,b)=>b.score-a.score)
    .slice(0, 6)
    .sort((a,b)=>a.i-b.i)
    .map(x => x.t);

  let questionChance = 0.72;
  if (analysis.intent === 'greeting_or_closing' || analysis.intent === 'gratitude') questionChance = 0.12;
  if (analysis.words <= 2) questionChance = 0.35;
  if (contactProfile?.questionPct > 45) questionChance += 0.10;
  if (ownerStyle?.questionPct > 40) questionChance += 0.10;
  if (relation.ownerToIncomingRatio < 0.4) questionChance -= 0.08;
  questionChance = Math.max(0.08, Math.min(0.9, questionChance));

  const targetWords = Math.max(1, Math.min(35, Math.round((ownerStyle?.avgWords || relation.ownerAvgWords || 8) * (analysis.words > 20 ? 0.9 : 1))));
  return {
    analysis,
    topics,
    openQuestions: open,
    relationship: relation,
    sameTopic,
    localOwnerExamples,
    questionChance,
    targetWords,
    summary: [
      `Target reply length: about ${targetWords} words.`,
      relation.typicalGapSeconds ? `Conversation pacing signal: about ${relation.typicalGapSeconds}s between turns.` : '',
      `Follow-up question likelihood: ${Math.round(questionChance*100)}%.`,
      'Historical content is not answer evidence; use it only for style/pacing.'
    ].filter(Boolean).join(' ')
  };
}

function validateReply(reply, incoming, previousReplies = [], brain = {}) {
  const text = normalize(reply);
  if (!text || text === '[skip]') return { ok: false, score: 0, reasons: ['empty'] };
  const reasons = [];
  let score = 100;
  if (text.length > 520) { score -= 15; reasons.push('too-long'); }
  if (/^(sure|of course|certainly|absolutely|i understand|thanks for sharing)/i.test(text)) { score -= 18; reasons.push('generic-opener'); }
  if (/\b(as an ai|language model|chatbot|assistant)\b/i.test(text)) { score -= 100; reasons.push('ai-language'); }
  // Exact duplicate prevention is handled at the delivery layer where the previous incoming
  // message is also known. Do not reject a legitimate short reply just because the owner often
  // uses the same phrase for different situations (e.g. 'haan bhai').
  const a = classify(incoming);
  if (a.intent === 'question') {
    const q = normalize(incoming);
    const wh = /\b(what|kya|kaise|how|why|kyu|kyon|where|kaha|when|kab|who|kon|which|kaunsa|kitna|kitne|kitni)\b/i.test(q);
    const tinyAck = /^(haan|han|yes|no|nhi|nahi|ok|okay|hmm|hm|acha|accha|sure|haan bhai|nhi bhai|yes bhai)[.!?]*$/i.test(text);
    if (wh && tinyAck) { score -= 55; reasons.push('generic-ack-for-wh-question'); }
    else if (!/[?]|\b(haan|nhi|nahi|yes|no|because|kyunki|kyu|kyon|shayad|maybe|bas|abhi|pata)\b/i.test(text)) { score -= 20; reasons.push('does-not-answer-question'); }
  }
  if (brain.targetWords && wordCount(reply) > brain.targetWords * 4 + 12) { score -= 12; reasons.push('style-length-mismatch'); }
  if (/^(aur batao|what about you|how about you)\??$/i.test(text)) { score -= 25; reasons.push('generic-followup'); }
  return { ok: score >= 62, score, reasons };
}

module.exports = { buildBrain, extractTopics, unansweredQuestions, relationshipSignals, validateReply };
