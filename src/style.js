'use strict';

const wordsIn = (t) => t.split(/\s+/).filter(Boolean).length;

/** Analyses the owner's learned messages and returns a short style description plus real examples. */
function analyzeStyle(messages) {
  const mine = messages || [];
  const total = Math.max(1, mine.length);
  const pct = (fn) => Math.round((mine.filter(fn).length / total) * 100);

  const avgWords = Math.max(1, Math.round(mine.reduce((n, t) => n + wordsIn(t), 0) / total));
  const emojiPct = pct((t) => /\p{Extended_Pictographic}/u.test(t));
  const lowerStartPct = pct((t) => /^[a-z]/.test(t));
  const endPunctPct = pct((t) => /[.!?]$/.test(t));
  const shortPct = pct((t) => wordsIn(t) <= 5);
  const exclaimPct = pct((t) => t.includes('!'));
  const questionPct = pct((t) => t.includes('?'));

  const summary = [
    `Average message is about ${avgWords} words; ${shortPct}% of messages are 5 words or fewer.`,
    lowerStartPct > 60 ? 'Mostly starts messages in lowercase, casual typing.' : 'Usually capitalises the first letter.',
    endPunctPct < 30 ? 'Rarely ends messages with punctuation.' : 'Often ends messages with punctuation.',
    emojiPct > 15 ? `Uses emoji fairly often (${emojiPct}% of messages).` : emojiPct > 0 ? 'Uses emoji occasionally.' : 'Almost never uses emoji.',
    exclaimPct > 25 ? 'Uses exclamation marks often.' : '',
    questionPct > 25 ? 'Asks questions often.' : '',
    'Preserve the natural language mix, casing, punctuation, emoji frequency and approximate length; use these signals for style only, never for facts or content.'
  ].filter(Boolean).join(' ');

  // examples: the most recent ones plus an even spread from older history
  const recent = mine.slice(-15);
  const older = mine.slice(0, Math.max(0, mine.length - 15));
  const step = Math.max(1, Math.floor(older.length / 30));
  const spread = older.filter((_, i) => i % step === 0).slice(0, 30);
  const examples = [...new Set([...spread, ...recent])].filter((t) => wordsIn(t) <= 30);

  return { summary, examples, avgWords, usesEmoji: emojiPct >= 5 };
}

module.exports = { analyzeStyle };
