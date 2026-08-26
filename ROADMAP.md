# Roadmap

## Shipped

- **Phase 1 — Session intelligence**: idle nudges (3/10/30 min staged), cart save + resume offer, `AGENT` (human handoff) and `STATUS` (order lookup) commands, `BACK` navigation on all steps.
- **Phase 2 — Mood detection & escalation**: frustration scoring (caps, `???`, profanity, impatience, repeated parse failures), three-rung escalation ladder (soften tone → callback offer → auto-escalate with transcript).
- **Phase 3 — Personalization**: saved delivery addresses & preference notes per customer, sold-out substitutions, one-tap reorder, language auto-detection, post-confirmation cancel window, pre-order support when closed.
- **Phase 5 — Business tooling**: owner commands (`pause/resume orders`, `soldout/instock <item>`, `queue`, `stats`), abandoned-cart recovery with a real discount, pickup-order staff notifications, idempotency fix for concurrent Sheet writes.
- **Voice note ordering** — customer sends a WhatsApp voice note instead of typing; the bot downloads it, transcribes with Gemini, and feeds the transcript through the exact same order-parsing pipeline as typed text (`transcribeVoiceNote()` in `index.js`). Graceful bilingual fallback replies if the download or transcription fails.
- **Crash/error alerting** — `alertOwner()` sends a WhatsApp ping to the owner number for sustained background-job failures, order-logging/notification failures, and uncaught crashes (rate-limited per failure type so it can't spam). Also pings on every boot/restart, which doubles as a live "is the bot still up" signal.

## Not started

- **Kitchen ticket / printer integration** — blocked on the owner specifying what printer/service hardware is actually in use.
- **Automated replay tests** — a `BOT_DRY_RUN` mode exists in `index.js` (stubs WhatsApp sends and Sheets reads/writes) but no test file uses it yet. Would let future changes be regression-tested against recorded conversations instead of only live manual smoke tests.
