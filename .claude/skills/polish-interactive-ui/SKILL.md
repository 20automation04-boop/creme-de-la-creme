---
name: polish-interactive-ui
description: Audit index.js for places still using plain numbered text where a native WhatsApp button/list/quick-reply would read as more designed. Use when the user wants the bot's UI to look more "native app" and less "type a number into a text box" — not for wording/tone (see polish-chat-voice) or send timing (see polish-message-pacing).
---

# Polish interactive UI

Native WhatsApp buttons/lists (`categoryListMessages`, `categoryItemsListMessage`,
`sizeButtonsMessage`, `modeButtonsMessage`, `confirmButtonsMessage`,
`savedAddressButtonsMessage`, `languageButtonsMessage`) already cover most of the
ordering flow — this bot is not starting from zero. `t.mainMenu`/`mainMenuText` is
already demoted to interactive-message fallback text only, not a primary UI. So the
first time this runs, expect **few, specific** gaps, not a sweeping rewrite — resist
the urge to buttonize things that are genuinely free-text by nature (quantities,
addresses, item notes, free-form questions).

## What actually counts as a gap

A real gap is a moment where:
1. The customer's answer is from a **small, fixed set** (not open-ended text), and
2. It's currently only accepted as typed text with no button offered, and
3. Buttonizing it wouldn't remove a genuinely faster typed shortcut power users rely on
   (e.g. don't take away `3x12` bulk-order typing — that's a feature, not a gap).

Known example already found and fixed once: the notes-step prompt (`askNotes`, "Any
special requests... Type *none* if not.") accepted a fixed `none`/`no`/`ninguno`/`0`
shorthand as pure text with no button — added a one-button "None" quick-reply
(`notesButtonsMessage`) alongside the same text, wired through the existing
`noNoteWords` check via the button's `id: 'none'` (interactive taps set `rawMsg` to the
tapped id — see `extractInboundMessage` — so no new routing logic was needed, it falls
through the existing per-step switch exactly like typed "none" already did).

Second known example, also already found and fixed: the proactive idle/recovery nudges
(`idleExpired`, `resumeOffer`, `idleConfirmPrompt`, `abandonedCartRecovery`) are sent by
`sweepIdleSessions()` — a background sweep, not a webhook reply — so they'd been missed
by anything only auditing `sendReply(...)` call sites. Each offered a small fixed
YES/MENU-style choice as plain text only. Added `resumeChoiceMessage`/
`idleConfirmButtonMessage`/`abandonedCartRecoveryMessage` builders sent via
`sendWhatsAppMessage` directly (same as the plain-text versions were), with button ids
(`yes`/`menu`) that already matched the existing checks at the `pendingResume` block and
the `'confirm'` step — verified safe by reading exactly which state each nudge fires
from before wiring it (e.g. `abandonedCartRecovery` only ever fires while
`pendingResume` is already true, so its `yes` tap was guaranteed to land in that block).
`idleHold`/`idleStillThere` were deliberately left as plain text — they're FYI nudges
with no action being requested, not a choice to buttonize.

Other places worth checking each run, since menu/flow changes over time can introduce
new free-text-only prompts: any new `askX` prompt added to `TXT.en`/`TXT.es`, any new
step handler that only checks `msg === 'literal'` without an accompanying button
message, and any new proactive/background send (grep `sendWhatsAppMessage(` directly,
not just `sendReply(`, since background sends bypass the normal webhook reply path).

## What NOT to touch

- Free-text-by-nature fields: address, item notes/allergies, quantity numbers, the
  free-text order parser itself (`attemptFreeOrder`) — these exist precisely because
  typing is faster/more expressive than tapping for these.
- Owner commands (`OWNER_COMMANDS`) — explicitly a staff tool, English-only by design,
  not customer-facing UX.
- Anything requiring a WhatsApp Business **catalog** (native product cards with images)
  — that's infrastructure/config work outside `index.js`, not a code polish pass. Note
  it as a bigger, separate idea if relevant; don't attempt it inline.

## Process

1. Grep `index.js` for every `t\.ask\w+` / free-text-only step handler to enumerate
   current prompts.
2. For each, check whether the expected answer set is small/fixed. If yes and no
   button exists, add one alongside the existing text (a `<name>ButtonsMessage(lang)`
   builder following the existing `confirmButtonsMessage`/`savedAddressButtonsMessage`
   pattern: `{ buttons: { body, buttons: [...] }, fallback: <same text> }`), with a
   button `id` that already matches (or is added to) the step's existing text-matching
   logic — verify by reading the step handler, don't assume.
3. Preserve the plain-text path exactly as-is (typed shortcuts keep working) — buttons
   are additive, never a replacement that removes a typing option.
4. Run `npm test` after any change — `test/replay.test.js` exercises button-tap
   equivalence (`interactive-button-tap-equivalence`, `stale-category-button-tap-still-routes-correctly`)
   which will catch a wrongly-wired button id.
