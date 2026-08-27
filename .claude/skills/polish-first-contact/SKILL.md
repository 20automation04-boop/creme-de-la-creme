---
name: polish-first-contact
description: Audit the very first thing a new customer sees after picking a language — index.js's welcomeText()/howToOrder() — for onboarding overload before they've even reached the menu. Use when the user wants the bot's first impression to feel like a designed product intro, not a reference manual dumped on a stranger — not for ongoing message wording (polish-chat-voice) elsewhere in the flow.
---

# Polish first contact

The very first real content message a new customer reads (right after tapping
English/Español, before they've seen a single menu item) is `welcomeText(lang)` →
`TXT[lang].howToOrder()` — the same text also re-shown by the `help`/`ayuda` command.
That reuse is the actual issue: a reference-manual-length message (4 numbered points
plus an 10-line command glossary — `cart`, `repeat`, `done`, `back`, `cancel`, `cancel
order`, `note`, `status`, `agent`, `help`, `language`) is appropriate when someone
explicitly asks for help mid-order, but is a wall of text to front-load on a stranger
who hasn't even opened the menu yet.

## What to check

1. **Confirm this is still one shared string.** Read `welcomeText()` and every call
   site (first-contact language-selection branches, and the `help`/`ayuda` command) —
   a prior pass may have already split them.
2. **Judge by length/purpose, not vibes.** The command glossary is genuinely useful
   reference material — it belongs in `help`, which someone reaches for on purpose.
   The first-contact message should carry only what's needed to place a first order:
   how to browse, how to free-text order, that questions are welcome, and delivery
   basics — plus a pointer ("*help* any time") to the full list, not the full list
   itself.
3. **Keep both languages equally trimmed**, not just English — check `TXT.es` in
   lockstep.

## The fix pattern

Split into two variants sharing the branded header and the ordering how-to, diverging
on the command list:
- A short first-contact version (what's needed before the first order) — used by
  `welcomeText()` / the language-selection branches.
- The existing full version (adds the command glossary) — used only by `help`/`ayuda`,
  via its own accessor so it doesn't silently regress back to one shared string next
  time someone edits `welcomeText`.

Preserve every `${SHOP_INFO...}` interpolation and the emoji/heading style already
established — this is a length/structure edit, not a tone rewrite (that's
`polish-chat-voice`'s job).

## What NOT to touch

- The language-picker message itself (`languageButtonsMessage`) — that's a separate,
  already-minimal first touchpoint (branded header + two buttons), not part of this
  audit.
- The `help` command's content — trimming applies to first-contact only; `help` should
  stay comprehensive since that's exactly when a customer wants the full reference.
- Routing/step logic — `session.step = 'menu'` and friends stay untouched; this is a
  copy split, not a flow change.

## Process

1. Read `welcomeText()`, `TXT.en.howToOrder`/`TXT.es.howToOrder`, and every call site
   listed above.
2. Draft the short first-contact copy (EN+ES) alongside the existing full version.
3. Repoint the language-selection call sites at the short version; repoint `help`/
   `ayuda` at the full version explicitly.
4. Run `npm test` — the replay fixtures exercise both first-contact and `help`, so a
   wiring mistake (short text where the full glossary was expected, or vice versa)
   should surface there if a fixture asserts on it.
