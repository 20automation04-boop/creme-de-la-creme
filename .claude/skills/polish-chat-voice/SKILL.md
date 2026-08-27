---
name: polish-chat-voice
description: Audit and rewrite this WhatsApp bot's user-facing message copy in index.js (translation blocks, SHOP_INFO strings, inline reply text, button/list labels) so replies read like a warm, human-written business conversation instead of templated bot output. Use when the user wants the bot's wording/tone "polished," "humanized," made to sound less robotic, or asks for a copy/UX-writing pass — not for logic, routing, or feature changes.
---

# Polish chat voice

This bot has no visual UI — the entire "design" surface is WhatsApp message text: the
`t.en`/`t.es` reply strings, `SHOP_INFO` facts folded into sentences, inline template
strings built at call sites, and interactive button/list labels. "Looks human-designed"
here means the copy, not pixels.

## Scope — copy only

Edit wording, tone, warmth, punctuation, and emoji use. Do **not** touch:
- Step/routing logic, command keywords, or the state machine
- `${...}` interpolations — preserve every one exactly, just reword around them
- WhatsApp markdown tokens (`*bold*`) — keep, don't add/remove without reason
- The `t` object's key names/structure, or interactive button/list `id` values
- Business facts — prices, fees, hours, phone numbers, delivery area/time. If one of
  these looks wrong or placeholder-like mid-pass, flag it as a separate factual
  question; don't silently "improve" it as if it were a tone problem.

## Finding the copy surface

Grep for these to gather everything before editing anything:
- `t\.(en|es)\s*=|^\s*\w+:\s*[`'"]` — the paired EN/ES translation blocks
- `SHOP_INFO` — shop facts that get folded into sentences
- `sendReply\(` and template-literal replies built inline at step-handler call sites
  (not every user-facing string is routed through `t` — some are assembled on the spot)

Read the EN and ES sides of each block together, not separately — parity is judged
per-pair.

## What to look for

The existing copy is already fairly warm in places (e.g. `notUnderstood: "Sorry, I
didn't quite catch that — try a menu number, or type *help* for instructions."`, or the
delivery-address prompt's 🏍️📍 emoji pairing). Calibrate toward that register, and hunt
for the spots that don't match it:

- **Robotic/generic phrasing** — "Invalid selection," "Error occurred," "Input not
  recognized" style text. Rewrite in the voice already established elsewhere.
- **Inconsistent tone across messages** — some warm and conversational, others terse or
  formal. Normalize toward the warmer register, don't average down.
- **EN/ES parity** — not literal translation. Each language should sound equally
  natural and equally warm to a native reader, with matching emoji/formatting rhythm,
  even if the exact words differ.
- **Cold failure/edge paths** — sold-out substitutions, errors, escalation-ladder
  messages, idle nudges, cancellations. These are exactly the moments a machine-built
  bot sounds coldest, and exactly where a little warmth matters most (a real customer
  hitting a snag).
- **Stilted confirmations** — "Your order has been successfully received" vs. "Got it!
  Order #1234 is on its way to the kitchen 🎉" — prefer the latter register.
- **Wall-of-text messages** that could break into short WhatsApp-natural lines.
- **Emoji/punctuation drift** — inconsistent density or placement across
  similar message types (e.g. every list-message title should read the same register).

## Process

1. Read the full copy surface first — every `t.en`/`t.es` pair, `SHOP_INFO` strings,
   inline reply strings — before editing anything, to calibrate the "already good"
   voice so you don't overwrite tone that's already right.
2. Produce a findings list (location → what's off → proposed EN/ES rewrite) before
   touching code. This project's convention is to batch a review, then fix everything
   in one pass rather than edit ad hoc or ask permission per line.
3. Apply the edits as string-literal changes only.
4. Run `npm test` afterward. `test/replay.test.js` fixtures mostly assert structural
   outcomes (step reached, cart total) rather than exact text, but check for any
   substring-matching assertions that pin specific phrasing you changed, and update
   those fixtures to match the new copy — don't loosen the assertion instead.

## Safety

This is a local, copy-only change — no real Sheet writes or WhatsApp sends are needed
to verify it, so the whole review-and-edit pass is safe to do without an extra
confirmation gate. Deploying the result to Railway afterward still needs the user's
explicit go-ahead, per this project's existing deploy practice (no CI/CD — `railway up`
is a manual, confirmed step).
