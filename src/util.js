'use strict';
const fs = require('fs');

/** Write JSON atomically (temp file + rename) so a crash can never leave a half-written file. */
function writeJsonAtomic(file, data, pretty = false) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randInt(min, max) {
  if (max <= min) return min;
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** WhatsApp timestamps can be numbers, strings or protobuf Long objects. Always returns seconds as a number. */
function toNumber(ts) {
  if (typeof ts === 'number') return ts;
  if (ts && typeof ts.toNumber === 'function') return ts.toNumber();
  if (ts && typeof ts === 'object' && 'low' in ts) return (ts.high || 0) * 4294967296 + (ts.low >>> 0);
  const n = Number(ts);
  return Number.isFinite(n) ? n : 0;
}

function clip(text, max) {
  const t = String(text ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

module.exports = { writeJsonAtomic, sleep, randInt, toNumber, clip };
