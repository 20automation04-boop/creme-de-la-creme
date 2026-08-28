# Roadmap

## Shipped

- **Phase 1 — Session intelligence**: idle nudges (3/10/30 min staged), cart save + resume offer, `AGENT` (human handoff) and `STATUS` (order lookup) commands, `BACK` navigation on all steps.
- **Phase 2 — Mood detection & escalation**: frustration scoring (caps, `???`, profanity, impatience, repeated parse failures), three-rung escalation ladder (soften tone → callback offer → auto-escalate with transcript).
- **Phase 3 — Personalization**: saved delivery addresses & preference notes per customer, sold-out substitutions, one-tap reorder, language auto-detection, post-confirmation cancel window, pre-order support when closed.
- **Phase 5 — Business tooling**: owner commands (`pause/resume orders`, `soldout/instock <item>`, `queue`, `stats`), abandoned-cart recovery with a real discount, pickup-order staff notifications, idempotency fix for concurrent Sheet writes.
- **Voice note ordering** — customer sends a WhatsApp voice note instead of typing; the bot downloads it, transcribes with Gemini, and feeds the transcript through the exact same order-parsing pipeline as typed text (`transcribeVoiceNote()` in `index.js`). Graceful bilingual fallback replies if the download or transcription fails.
- **Crash/error alerting** — `alertOwner()` sends a WhatsApp ping to the owner number for sustained background-job failures, order-logging/notification failures, and uncaught crashes (rate-limited per failure type so it can't spam). Also pings on every boot/restart, which doubles as a live "is the bot still up" signal.

- **Automated replay tests** — `npm test` runs 35 fixture-driven conversations (`test/replays/*.json`) through the real message handler under `BOT_DRY_RUN=1`, covering the ordering FSM, button/list routing, stale-tap handling, owner commands, idle expiry + resume, and the escalation ladder. Plus `test/menu-sheet.test.js` for the sheet-driven menu CRUD, and `test/security.test.js` for the HTTP surface (webhook signature enforcement, verify-token handling, kitchen login lockout, cookie flags).
- **Tap-to-add ordering** — a tap adds one of the item and leaves the category list up. Nothing is asked mid-selection: not quantity, and not size (a sized item goes in at its default). That matters because the old size/quantity prompts consumed the customer's NEXT tap as their answer, so tapping five smoothie flavours produced one drink in a size nobody chose.
- **One-reply quantity recap** — after *done*, the bot reads the whole order back and takes every amount in a single message: a *1 of each* button for the common case, or free text like `2 large banana, 3 vanilla, 1 papaya no sugar`, which sets quantity, size and a per-item request at once. Bare numbers (`2, 1, 3`) are applied in listed order; anything not mentioned defaults to one. An answer it cannot parse re-asks rather than guessing, and a question typed here is answered instead of being written onto the kitchen ticket. A quantity the customer already stated (the `2x3` shorthand, a typed order, a repeat, the add-on button) is never re-asked.

- **Add-on suggestion at checkout** — when a cart has food but no drink (or a drink but no food), the pickup/delivery question carries one extra line and a third button offering the cheapest available item from the missing side. Deliberately not a checkout step: ignoring it costs nothing, it is offered at most once per order, it stays silent when the cart already has both or is large, and it never suggests a sold-out or sized item. Bilingual copy in `t.upsellLine`/`t.upsellAdded`; tuning lives in `pickUpsell()`.
- **Sheet-driven menu management** — add, rename, re-price, or discontinue menu items straight from the Availability tab, no deploy needed. Items carry a stable `sheetId`, so discontinuing one no longer shifts its neighbours' sold-out flags.
- **Reliability hardening** — webhook dedup/signature verification, per-sender locking, rate limiting, and a >30% shrink guard that refuses to wipe the menu on a bad Sheets read.
- **Abuse hardening** — per-customer cooldown on human-escalation pings, delivery-address length cap, cart line-count cap.
- **Conversational UX polish** — native buttons on the notes/checkout/idle-resume prompts, staggered multi-message replies, a trimmed first-contact welcome, real Spanish command words (`carrito`, `listo`, `atrás`, `ayuda`…) instead of English ones, and accent-tolerant (NFC-normalized) command matching.

## Not started

- **Kitchen ticket / printer integration** — blocked on the owner specifying what printer/service hardware is actually in use.
- **Menu item photos** — `sendWhatsAppMessage` already supports sending an image with a caption; nothing sources or stores per-item image URLs yet. Needs the owner to supply photos and somewhere to host them (an extra Availability column would fit).
