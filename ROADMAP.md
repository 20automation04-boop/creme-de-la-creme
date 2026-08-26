# Roadmap

## Shipped

- **Phase 1 — Session intelligence**: idle nudges (3/10/30 min staged), cart save + resume offer, `AGENT` (human handoff) and `STATUS` (order lookup) commands, `BACK` navigation on all steps.
- **Phase 2 — Mood detection & escalation**: frustration scoring (caps, `???`, profanity, impatience, repeated parse failures), three-rung escalation ladder (soften tone → callback offer → auto-escalate with transcript).
- **Phase 3 — Personalization**: saved delivery addresses & preference notes per customer, sold-out substitutions, one-tap reorder, language auto-detection, post-confirmation cancel window, pre-order support when closed.
- **Phase 5 — Business tooling**: owner commands (`pause/resume orders`, `soldout/instock <item>`, `queue`, `stats`), abandoned-cart recovery with a real discount, pickup-order staff notifications, idempotency fix for concurrent Sheet writes.

## Not started

- **Kitchen ticket / printer integration** — blocked on the owner specifying what printer/service hardware is actually in use.
- **Voice note ordering** — transcribe → parse → confirm as text. Customer sends a WhatsApp voice note instead of typing; bot transcribes it, runs the transcript through the existing order-parsing pipeline, and confirms back as text same as today. Huge in WhatsApp-first markets and rare among competitors — highest wow-per-effort item on this list.
