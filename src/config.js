'use strict';
const fs = require('fs');
const { writeJsonAtomic } = require('./util');

const CONFIG_VERSION = 12;

const DEFAULT_CONFIG = {
  configVersion: CONFIG_VERSION,
  groqApiKey: '',
  // Current Groq production models. The bot also auto-falls back if a configured model disappears.
  model: 'openai/gpt-oss-120b',
  fallbackModel: 'openai/gpt-oss-20b',
  reasoningEffort: 'medium',
  maxCompletionTokens: 360,
  ignoreList: [], // chat ids that never get replies
  allowList: [], // if not empty, reply ONLY to these chat ids
  onlyReplyToKnownChats: true, // reply only where YOU have chatted before (skips OTP/bank/unknown senders)
  minLearnedMessages: 5, // stay silent until this many of your messages are learned
  debounceMs: 3000, // wait this long for follow-up messages and answer them together
  minReadDelayMs: 800, // "reading" pause before the bot starts typing
  maxReadDelayMs: 2500,
  typingMsPerChar: 25,
  maxTypingDelayMs: 1500,
  pauseAfterManualMs: 2 * 60 * 1000, // stay quiet in a chat for this long after YOU reply manually
  maxRepliesPerChatPerHour: 90,
  minReplyGapMs: 900,
  maxConsecutiveFailures: 8,
  duplicateReplyWindow: 12, // loop / runaway protection (0 = unlimited)
  quietHours: '', // for example "23:00-07:00": no auto-replies during this window
  markAsRead: true, // mark the message as read when the bot starts replying
  notifyOwnerOnSkip: true, // message yourself when the bot decides a chat needs the real you
  preferIPv4: true, // helps on networks with broken IPv6 (a common cause of connection problems)
  learningEnabled: true,
  analyzeEachContact: true,
  contactHistoryLimit: 300,
  longMemoryTurns: 18,
  recentTurnsForPrompt: 28,
  requireGlobalLearning: false,
  proactiveQuestion: true,
  questionDelayMs: 700,
  maxQuestionLength: 220,
  memoryTurnsPerChat: 900,
  pairLimitPerChat: 400,
  adaptiveQuestion: true,
  smartSkip: true,
  learnFromHistoryWithoutOwnerReply: true,
  adaptiveReplyLength: true,
  responseQualityGate: true,
  repairOnLowQuality: true,
  maxRepairAttempts: 1,
  topicMemoryLimit: 40,
  openQuestionMemory: true,
  memoryCompaction: true,
  maxContextChars: 12000,
  naturalnessTemperature: 0.25,
  voiceNotes: true,
  transcriptionModel: 'whisper-large-v3-turbo',
  transcriptionLanguage: '',
  dashboardEnabled: true,
  dashboardPort: 8787,
  maxAudioBytes: 25 * 1024 * 1024,
  confidenceHandoff: false,
  lowConfidenceThreshold: 50,
  auditLog: true,
  responseFormat: 'text' // kept for migration compatibility; generation is plain-text only
};

const NUMERIC_KEYS = [
  'minLearnedMessages',
  'debounceMs',
  'minReadDelayMs',
  'maxReadDelayMs',
  'typingMsPerChar',
  'maxTypingDelayMs',
  'pauseAfterManualMs',
  'maxRepliesPerChatPerHour',
  'maxCompletionTokens',
  'contactHistoryLimit',
  'questionDelayMs',
  'maxQuestionLength',
  'longMemoryTurns',
  'recentTurnsForPrompt',
  'minReplyGapMs',
  'maxConsecutiveFailures',
  'duplicateReplyWindow',
  'memoryTurnsPerChat',
  'pairLimitPerChat',
  'maxRepairAttempts',
  'topicMemoryLimit',
  'maxContextChars',
  'dashboardPort',
  'maxAudioBytes',
  'lowConfidenceThreshold'
];

class ConfigError extends Error {}

/** Merge a raw object with the defaults, migrate old versions and sanitise every value. */
function normalizeConfig(fromFile = {}) {
  const config = { ...DEFAULT_CONFIG, ...fromFile };

  if (fromFile.configVersion === undefined || fromFile.configVersion < 2) {
    // very old config.json: switch to the faster timing defaults, keep everything else
    config.minLearnedMessages = DEFAULT_CONFIG.minLearnedMessages;
    config.typingMsPerChar = DEFAULT_CONFIG.typingMsPerChar;
    config.maxTypingDelayMs = DEFAULT_CONFIG.maxTypingDelayMs;
  }
  if (Number(fromFile.configVersion || 0) < 12 && Number(fromFile.naturalnessTemperature || 0) >= 0.7) {
    // v7/v8 were intentionally more creative; v10 prioritises answer relevance over randomness.
    config.naturalnessTemperature = DEFAULT_CONFIG.naturalnessTemperature;
  }
  config.configVersion = CONFIG_VERSION;

  // Repair configs from older releases automatically. Groq retired these IDs in 2026.
  const modelMigration = {
    'llama-3.3-70b-versatile': 'openai/gpt-oss-120b',
    'llama-3.1-8b-instant': 'openai/gpt-oss-20b'
  };
  if (modelMigration[config.model]) config.model = modelMigration[config.model];
  if (modelMigration[config.fallbackModel]) config.fallbackModel = modelMigration[config.fallbackModel];

  for (const key of NUMERIC_KEYS) {
    const n = Number(config[key]);
    config[key] = Number.isFinite(n) && n >= 0 ? n : DEFAULT_CONFIG[key];
  }
  if (config.maxReadDelayMs < config.minReadDelayMs) config.maxReadDelayMs = config.minReadDelayMs;
  for (const key of ['ignoreList', 'allowList']) {
    config[key] = Array.isArray(config[key]) ? config[key].map(String) : [];
  }
  config.reasoningEffort = ['low', 'medium', 'high'].includes(String(config.reasoningEffort)) ? String(config.reasoningEffort) : DEFAULT_CONFIG.reasoningEffort;
  config.maxCompletionTokens = Math.min(Math.max(Number(config.maxCompletionTokens) || DEFAULT_CONFIG.maxCompletionTokens, 32), 2048);
  config.quietHours = typeof config.quietHours === 'string' ? config.quietHours.trim() : '';
  config.analyzeEachContact = config.analyzeEachContact !== false;
  config.proactiveQuestion = config.proactiveQuestion !== false;
  config.contactHistoryLimit = Math.min(Math.max(Number(config.contactHistoryLimit) || DEFAULT_CONFIG.contactHistoryLimit, 20), 500);
  config.questionDelayMs = Math.min(Math.max(Number(config.questionDelayMs) || DEFAULT_CONFIG.questionDelayMs, 0), 10000);
  config.maxQuestionLength = Math.min(Math.max(Number(config.maxQuestionLength) || DEFAULT_CONFIG.maxQuestionLength, 40), 500);
  config.longMemoryTurns = Math.min(Math.max(Number(config.longMemoryTurns) || DEFAULT_CONFIG.longMemoryTurns, 6), 60);
  config.recentTurnsForPrompt = Math.min(Math.max(Number(config.recentTurnsForPrompt) || DEFAULT_CONFIG.recentTurnsForPrompt, 12), 80);
  config.minReplyGapMs = Math.min(Math.max(Number(config.minReplyGapMs) || DEFAULT_CONFIG.minReplyGapMs, 0), 10000);
  config.maxConsecutiveFailures = Math.min(Math.max(Number(config.maxConsecutiveFailures) || DEFAULT_CONFIG.maxConsecutiveFailures, 1), 20);
  config.duplicateReplyWindow = Math.min(Math.max(Number(config.duplicateReplyWindow) || DEFAULT_CONFIG.duplicateReplyWindow, 2), 50);
  config.memoryTurnsPerChat = Math.min(Math.max(Number(config.memoryTurnsPerChat) || DEFAULT_CONFIG.memoryTurnsPerChat, 100), 3000);
  config.pairLimitPerChat = Math.min(Math.max(Number(config.pairLimitPerChat) || DEFAULT_CONFIG.pairLimitPerChat, 50), 1000);
  config.adaptiveQuestion = config.adaptiveQuestion !== false;
  config.smartSkip = config.smartSkip !== false;
  config.learnFromHistoryWithoutOwnerReply = config.learnFromHistoryWithoutOwnerReply !== false;
  config.adaptiveReplyLength = config.adaptiveReplyLength !== false;
  config.responseQualityGate = config.responseQualityGate !== false;
  config.repairOnLowQuality = config.repairOnLowQuality !== false;
  config.openQuestionMemory = config.openQuestionMemory !== false;
  config.memoryCompaction = config.memoryCompaction !== false;
  config.maxRepairAttempts = Math.min(Math.max(Number(config.maxRepairAttempts) || 1, 0), 2);
  config.topicMemoryLimit = Math.min(Math.max(Number(config.topicMemoryLimit) || 40, 10), 100);
  config.maxContextChars = Math.min(Math.max(Number(config.maxContextChars) || 12000, 4000), 30000);
  config.naturalnessTemperature = Math.min(Math.max(Number(config.naturalnessTemperature) || DEFAULT_CONFIG.naturalnessTemperature, 0.2), 1.2);
  config.dashboardPort = Math.min(Math.max(Number(config.dashboardPort) || 8787, 1024), 65535);
  config.maxAudioBytes = Math.min(Math.max(Number(config.maxAudioBytes) || 25 * 1024 * 1024, 100000), 100 * 1024 * 1024);
  config.lowConfidenceThreshold = Math.min(Math.max(Number(config.lowConfidenceThreshold) || 58, 0), 100);
  config.voiceNotes = config.voiceNotes !== false;
  config.dashboardEnabled = config.dashboardEnabled !== false;
  config.confidenceHandoff = config.confidenceHandoff !== false;
  config.auditLog = config.auditLog !== false;
  config.responseFormat = ['text', 'json'].includes(String(config.responseFormat)) ? String(config.responseFormat) : DEFAULT_CONFIG.responseFormat;
  config.transcriptionModel = String(config.transcriptionModel || 'whisper-large-v3-turbo');
  config.transcriptionLanguage = String(config.transcriptionLanguage || '').trim();
  config.requireGlobalLearning = config.requireGlobalLearning === true;
  config.groqApiKey = String(config.groqApiKey || '').trim();
  return config;
}

/** Load config.json (creating it on first run and asking only for the Groq API key). */
async function loadConfig(file, ask) {
  let fromFile = {};
  if (fs.existsSync(file)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (fromFile === null || typeof fromFile !== 'object' || Array.isArray(fromFile)) throw new Error('not an object');
    } catch {
      throw new ConfigError('config.json is corrupted. Delete it and start the bot again.');
    }
  }
  const config = normalizeConfig(fromFile);

  if (process.env.GROQ_API_KEY && String(process.env.GROQ_API_KEY).trim()) {
    config.groqApiKey = String(process.env.GROQ_API_KEY).trim();
  }

  if (!config.groqApiKey || config.groqApiKey.startsWith('PASTE_')) {
    const answer = await ask(
      '\nFirst-time setup: a free Groq API key is required (console.groq.com > API Keys > Create API key).\nPaste your Groq API key: '
    );
    config.groqApiKey = String(answer || '').trim();
    if (!config.groqApiKey) throw new ConfigError('A Groq API key is required to run the bot.');
  }
  writeJsonAtomic(file, config, true);
  return config;
}

module.exports = { CONFIG_VERSION, DEFAULT_CONFIG, ConfigError, normalizeConfig, loadConfig };
