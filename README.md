# EVERBEST — Adaptive Personal AI Agent for WhatsApp

> A portfolio-grade WhatsApp AI agent focused on **reliable, context-relevant replies and style-only personalization**.

EVERBEST is not a simple `message -> LLM -> reply` script. It combines event-driven WhatsApp messaging, per-contact memory, online style learning, conversational heuristics, voice transcription, model failover, quality checks, observability and human takeover controls.

## The core design

The most important rule in EVERBEST is:

**What to say = the current message.**  
**How to say it = the owner's learned texting style.**

Historical owner replies are deliberately **not** supplied to the LLM as semantic answer evidence. This prevents the common failure mode where a model recycles an old answer for a new question.

Historical contact messages are used to learn that person's messaging behaviour and conversation timing, but they are not treated as facts for a new request.

## Architecture

```text
WhatsApp event
   │
   ├── message normalization / duplicate protection
   ├── text or voice-note extraction
   │
   ├── per-contact behaviour learning
   │      ├── message length
   │      ├── casing / punctuation
   │      ├── emoji frequency
   │      ├── question frequency
   │      └── activity / burst behaviour
   │
   ├── current conversation context
   │      ├── current incoming message  ← authoritative
   │      ├── optional quoted message
   │      └── recent incoming context
   │
   ├── intent / urgency / sentiment heuristics
   │
   ├── style-only personalization
   │
   ├── Groq plain-text generation
   │      ├── GPT-OSS 120B
   │      └── GPT-OSS 20B fallback
   │
   ├── deterministic quality gate
   │      └── optional repair pass
   │
   ├── natural delivery + follow-up decision
   │
   └── persistent memory + telemetry
```

## Why v12 is different

- **No provider-side JSON requirement for normal replies.** The normal generation request is plain text. This removes the `HTTP 400 Failed to validate JSON` failure mode that caused earlier builds to stop replying.
- **Model fallback** for rate limits, unavailable models and transient provider failures.
- **Old-history learning immediately** when WhatsApp delivers history; it does not wait for a new message.
- **One owner message is enough to recognise a real conversation** instead of requiring three old replies.
- **Incoming-history deduplication** prevents repeated sync batches from inflating contact profiles.
- **Owner style is semantic-free.** The style summary does not feed favourite words/topics back into the answer model.
- **Current-message-first prompting.** The current message is authoritative; optional quoted/recent incoming context only helps resolve conversational references.
- **Voice-note pipeline** using Groq transcription.
- **Burst handling** groups rapid incoming messages so the bot does not answer only the final fragment.
- **Adaptive follow-up questions** are topic-grounded; filler questions such as `aur batao?` are rejected.
- **Manual takeover** pauses the bot after the owner replies personally.
- **Quiet hours, mute, allow/ignore lists and rate limiting.**
- **Local Control Center dashboard** on `127.0.0.1`.
- **Runtime telemetry** for latency, failures, repairs and handoffs without putting message text into metrics.
- **Atomic persistence and migration** for `learned.json`.
- **Sensitive-data filtering** for OTPs, credentials, links and similar content.
- **Automated test suite** for message flow, memory, prompt separation, provider fallback and connection handling.

## Commands

Send these from the bot's self-chat:

```text
/bot on
/bot off
/bot mute 60
/bot status
/bot metrics
/bot dashboard
/bot resync
/bot forget confirm
/bot help
```

## Requirements

- Node.js 20+
- A WhatsApp account that can be linked as a companion device
- A Groq API key
- Internet access that permits WhatsApp WebSocket traffic

## Local setup

### Windows

1. Install Node.js LTS.
2. Extract this repository.
3. Open Command Prompt/PowerShell in the project folder.
4. Install dependencies:

```bash
npm ci
```

5. Start:

```bash
npm start
```

Or double-click `START.bat`.

### First run

The bot asks for your Groq key and then asks whether you want a QR code or a phone-number pairing code.

You can also set the key without storing it in `config.json`:

```text
GROQ_API_KEY=your_key_here
```

The environment variable takes precedence over the value in `config.json`.

## Re-linking / history sync

If WhatsApp does not send the old history to the current companion session:

```bash
npm run relink
```

This removes only the WhatsApp `auth/` directory. It does **not** delete `learned.json`.

WhatsApp controls what history is actually delivered to the linked session. The project cannot retrieve private server-side history that WhatsApp does not sync.

## Configuration

Copy `config.example.json` to `config.json` if you want to edit settings manually.

Important defaults:

- Primary model: `openai/gpt-oss-120b`
- Fallback model: `openai/gpt-oss-20b`
- Reasoning: `medium`
- Normal reply transport: **plain text**
- Proactive follow-up: enabled with adaptive gating
- Voice notes: enabled
- Dashboard: `127.0.0.1:8787`
- Global-learning gate: disabled; a known conversation can reply even while background learning continues

## Testing

Run:

```bash
npm test
```

The test suite covers:

- history learning
- per-person style learning
- current-message-first prompting
- burst/debounce handling
- duplicate deliveries
- manual takeover
- sensitive-message skips
- rate limiting
- quiet hours
- memory persistence/migration
- Groq fallback behaviour
- plain-text generation transport
- configuration migration
- WebSocket diagnostics

## GitHub / portfolio

This repository is intentionally safe to publish:

- `config.json` is ignored
- `auth/` is ignored
- `learned.json` is ignored
- `.env` is ignored
- no WhatsApp credentials are part of the repository

See [`PORTFOLIO.md`](./PORTFOLIO.md) for a recruiter-friendly project description and [`GITHUB_UPLOAD_GUIDE.md`](./GITHUB_UPLOAD_GUIDE.md) for the exact GitHub upload steps.

## Suggested resume bullet

> Built an event-driven WhatsApp conversational AI agent with per-contact behavioural learning, current-message-first generation, long-term memory, voice-note transcription, model failover, deterministic response validation, human takeover controls and real-time observability using Node.js, Baileys and Groq.

## Responsible use

Only use the agent on accounts/chats you are authorised to automate. Do not use it to impersonate someone for fraud, bypass account security, or automatically handle high-impact decisions. Sensitive messages are deliberately excluded from learning/automation.
