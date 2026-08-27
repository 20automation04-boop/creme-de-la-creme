---
name: polish-message-pacing
description: Audit how index.js's sendReply() delivers multi-message replies — whether several messages land instantly back-to-back like a data dump, or with enough natural stagger to read like someone actually typing. Use when the user wants the bot's send rhythm/timing to feel less like a script and more like a person — not for wording (polish-chat-voice) or which UI element is used (polish-interactive-ui).
---

# Polish message pacing

`sendReply()` (index.js, ~line 155) sends every message in a reply array via a plain
`for` loop with `await sendWhatsAppMessage(to, m)` — no delay between them. Combined
with `markAsRead()`'s WhatsApp typing indicator firing once per inbound message (not
once per outbound message), a 2-3 message reply — very common in this bot, e.g.
`[cartText, categoryItemsListMessage]` or `[t.itemNotFound, categoryItemsListMessage]`
— can land in the customer's chat within milliseconds of each other: reads as a data
dump, not a person sending a quick follow-up thought.

## What to check

1. **Confirm the gap still exists.** Read `sendReply()` fresh each run — this may have
   already been fixed by a prior pass. Look for whether sends inside the loop are
   already staggered.
2. **Confirm WhatsApp requires separate API calls for mixed text+interactive replies.**
   A text message and an interactive (buttons/list) message can't be combined into one
   Chakra/Meta API call — so multi-message replies aren't automatically avoidable by
   "just combining the text." Pacing, not consolidation, is the lever here.
3. **Size the fix to the loop, not the whole architecture.** This is a timing tweak in
   one function, not a redesign of the reply-building call sites (there are ~40+ of
   those across the step handlers — don't touch them).

## The fix pattern

Add a short stagger (300-500ms reads as "someone glancing at the last message before
sending the next" without slowing the flow down noticeably) before every message after
the first in the array, real sends only:

- Skip the delay entirely when `BOT_DRY_RUN` is set — it exists purely for human-facing
  pacing over a real network, and would just slow down `npm test` (which runs ~30
  fixtures, several with multi-message replies) for no benefit.
- Skip it when there's only one message in the reply — no pacing needed for a single
  send.
- Keep it a fixed small constant, not proportional to message length or anything
  clever — the goal is "doesn't feel instant," not a typing-speed simulation.

## What NOT to touch

- The webhook ack (`res.sendStatus(200)`) — must stay synchronous/immediate, Chakra/Meta
  will retry if the HTTP response itself is slow. The stagger only affects the
  message-send loop that runs after the ack.
- `markAsRead`'s typing-indicator call itself — that's a separate, already-working
  mechanism; don't duplicate or re-trigger it per message.
- Message ordering or content — this is purely inter-message timing.

## Process

1. Read `sendReply()` and `markAsRead()` to confirm current behavior.
2. Add the stagger inside `sendReply()`'s loop, guarded by `BOT_DRY_RUN` and array
   length, per the pattern above.
3. Run `npm test` — confirm the full suite still passes and total runtime doesn't
   meaningfully increase (it shouldn't, since dry-run tests skip the delay).
