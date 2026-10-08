'use strict';

const STOP = new Set(['hai','haan','h','ka','ke','ki','ko','kya','the','and','you','are','for','this','that','bro','bhai','yaar','aur','to','me','main','mai','se','on','in','of','a','an','is','it','i','my','your','bas','nhi','nahi','na']);

function words(text) {
  return String(text || '').toLowerCase().match(/[a-z\u0900-\u097f0-9']{2,}/g) || [];
}

function analyzeContact(messages = []) {
  const clean = messages.filter((m) => m && String(m.t || '').trim());
  const total = Math.max(1, clean.length);
  const wordCounts = clean.map((m) => String(m.t).trim().split(/\s+/).filter(Boolean).length);
  const avgWords = Math.max(1, Math.round(wordCounts.reduce((a, b) => a + b, 0) / total));
  const pct = (fn) => Math.round((clean.filter(fn).length / total) * 100);
  const emojiPct = pct((m) => /\p{Extended_Pictographic}/u.test(m.t));
  const questionPct = pct((m) => /\?/.test(m.t));
  const lowerPct = pct((m) => /^[a-z\u0900-\u097f]/.test(m.t));
  const punctPct = pct((m) => /[.!?,]$/.test(m.t.trim()));
  const shortPct = pct((m) => String(m.t).trim().split(/\s+/).filter(Boolean).length <= 5);

  const freq = {};
  for (const m of clean) {
    for (const w of words(m.t)) {
      if (STOP.has(w)) continue;
      freq[w] = (freq[w] || 0) + 1;
    }
  }
  const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w]) => w);

  const hours = {};
  for (const m of clean) {
    const d = new Date(Number(m.ts || 0) * 1000);
    if (Number.isFinite(d.getTime())) {
      const h = d.getHours();
      hours[h] = (hours[h] || 0) + 1;
    }
  }
  const activeHours = Object.entries(hours)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h]) => `${String(h).padStart(2, '0')}:00-${String((Number(h) + 1) % 24).padStart(2, '0')}:00`);

  let burstCount = 0;
  let doubleTextCount = 0;
  for (let i = 1; i < clean.length; i++) {
    const gap = Number(clean[i].ts) - Number(clean[i - 1].ts);
    if (gap >= 0 && gap <= 90) burstCount++;
    if (gap >= 0 && gap <= 12) doubleTextCount++;
  }

  const summary = [
    `${clean.length} recent messages analyzed for this person.`,
    `Typical length: about ${avgWords} words; ${shortPct}% are 5 words or fewer.`,
    `${emojiPct}% use emoji, ${questionPct}% contain a question, ${lowerPct}% start casually/lowercase, ${punctPct}% end with punctuation.`,
    burstCount > Math.max(1, clean.length * 0.15) ? 'They often send messages in quick bursts instead of one long message.' : 'They usually send messages as individual turns.',
    doubleTextCount > Math.max(1, clean.length * 0.1) ? 'They frequently double-text within seconds.' : '',
    topWords.length ? `Their recurring words: ${topWords.join(', ')}.` : '',
    activeHours.length ? `Most active around ${activeHours.join(', ')}.` : ''
  ].filter(Boolean).join(' ');

  const recent = clean.slice(-14).map((m) => m.t).filter(Boolean);
  return {
    count: clean.length,
    avgWords,
    emojiPct,
    questionPct,
    lowerPct,
    punctPct,
    shortPct,
    topWords,
    activeHours,
    bursty: burstCount > Math.max(1, clean.length * 0.15),
    doubleTexts: doubleTextCount > Math.max(1, clean.length * 0.1),
    summary,
    recent
  };
}

module.exports = { analyzeContact };
