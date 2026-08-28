# Handoff notes — Créme De La Créme WhatsApp bot

Read this before doing anything else. This is context a fresh Claude session
(or a fresh developer) won't have from the code alone.

## This is live in production, not a demo

This is a WhatsApp food-ordering bot for a real business — **Créme De La
Créme**, a drinks/food shop in Belize. Orders placed through it write to a
real Google Sheet that kitchen/management staff act on, and replies go out
via a paid WhatsApp Business number customers actually text. Treat any code
path that writes to the Sheet or sends a WhatsApp message as touching a real,
external, shared system — not something to fire casually during testing.

**Live number:** +501 606-9511. **Shop's own number:** +501 616-2492 (also
the current value in both `DRIVER_NUMBERS` and `OWNER_NUMBERS`).

## Stack

- Node/Express, single-file app in `index.js` (~3600 lines)
- `menu-data.js` — static menu structure
- Google Sheets (`googleapis`) — order log (Manager/Kitchen tabs), menu
  availability + prices (Availability tab), customer profiles (Customers tab)
- Google Gemini (`@google/genai`, model `gemini-3.1-flash-lite` as of
  2026-08) — free-text order parsing and FAQ answers
- Chakra (`chakrahq.com`) — WhatsApp send/receive, a paid pass-through in
  front of Meta's WhatsApp Cloud API

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in real values (transferred
   separately/securely — never via git; see "Secrets" below).
3. `node index.js` runs it locally. `npm test` runs the replay suite
   (`node --test test/*.test.js`) — 40 tests covering the ordering FSM,
   button routing, owner commands, and the escalation ladder. They use
   `BOT_DRY_RUN=1` (set by the test files themselves) so no real WhatsApp
   send or Sheets write happens, even with real credentials in `.env`.
   Run them before every deploy — `npm run predeploy` is the same thing.
   Note: on Windows/Node 25 the glob form `node --test test/*.test.js` is
   required; bare `node --test test/` fails with `Cannot find module 'test'`.
4. Deploy target is **Railway**, project `creme-de-la-creme-bot`. **There is
   no CI/CD** — deploy is a manual `railway up --detach` run from this
   directory. Editing `index.js` locally does nothing to the live bot until
   you deploy. Requires the Railway CLI logged in to the account that owns
   that project.

## Secrets (transfer separately, never via git)

`.env` is gitignored and was **not** pushed to GitHub. Get the real values
directly from whoever has them (or from Railway's environment variables
dashboard for the linked project, which has the live values) via a secure
channel — password manager, encrypted note, etc. `.env.example` in this repo
lists every variable name that's needed and what it's for.

**Known trap:** `CHAKRA_PHONE_NUMBER_ID` must be the WhatsApp *phone
number's own ID*, not the WABA (WhatsApp Business Account) ID. Chakra's
"WhatsApp Phone Numbers" table shows a `Phone Number` row and a `WABA` row
side by side with different IDs — it's easy to copy the wrong one, and this
cost a long debugging saga previously (silent "not connected" failures).

## Feature status

All of a prior internal roadmap's Phases 1, 2, 3, and 5 are shipped and live
(session intelligence / idle nudges, mood detection + escalation ladder,
personalization + saved addresses + substitutions, owner commands +
abandoned-cart recovery). See `ROADMAP.md` in this repo for the up-to-date
list — it's the source of truth for feature asks going forward.

Voice-note ordering **is** built and live (`transcribeVoiceNote()` — Gemini
audio in, transcript through the same text-parsing path). An earlier version
of this file listed it as not started; that was wrong.

**Not built:** kitchen ticket/printer integration — blocked on the owner
specifying what hardware/service they'd actually use. Don't guess.

## In-flight work at handoff time

`index.js` had uncommitted local changes when this handoff was prepared,
now committed as part of the handoff (check `git log` for the exact
message). Summary of what it adds:

- **`alertOwner(tag, message)`** — sends a WhatsApp alert to `OWNER_NUMBERS`
  when something breaks (Sheets write failures, driver/owner notification
  failures, crashes, sustained background-job failure). Rate-limited per tag
  (one alert per tag per 15 min) so a sustained outage pages once, not
  repeatedly.
- **`jobFailed`/`jobSucceeded`** — tracks consecutive failures of the
  periodic background jobs (menu refresh, order-status poll, customer
  profile refresh) and alerts after 3 in a row, rather than on first blip
  (those already fail open on a single bad poll, which is correct — this
  adds visibility into *sustained* failure, which previously had no signal
  beyond a log line nobody reads).
- **`uncaughtException`/`unhandledRejection` handlers** — alert the owner
  and exit cleanly so Railway restarts the process, instead of an unnoticed
  silent hang or crash loop.
- **`BOT_DRY_RUN` / replay tests** — when `BOT_DRY_RUN=1` is set *before*
  requiring `index.js`, all real WhatsApp sends and Sheets reads/writes are
  stubbed instead of hitting the network, and `module.exports` exposes the
  internals a test harness needs to drive it. This was scaffolding-only at
  handoff time; **it is finished now** — `test/replay.test.js` and
  `test/menu-sheet.test.js` exist, with fixtures in `test/replays/*.json`,
  and all 40 pass. Do not rip it out.
- `sendReply` was changed from fire-and-forget to properly `async`/awaited
  so that two rapid messages from the same sender have their actual sends
  (not just session-state mutations) stay in order under the existing
  per-sender lock.

## Testing safety rules (important)

- Safe to test freely: syntax/type checks, running the server locally,
  read-only Sheets calls, and webhook simulations aimed at an obviously-fake
  phone number (e.g. `10000000000`) — Chakra bounces these as invalid
  without real delivery.
- **Not safe by default:** anything that writes to the real Google Sheet, or
  any code path that sends to a *hardcoded* real number constant —
  `DRIVER_NUMBERS`, `OWNER_NUMBERS`, `SHOP_INFO.phone` — even during an
  otherwise-safe fake-sender test. A fake inbound sender number only
  protects the inbound leg; if the bot's logic reacts by messaging one of
  those real constants (e.g. the `AGENT`/escalation/owner-alert paths), that
  send is real regardless of who triggered it. Past sessions have been
  burned by this — grep for those constants before triggering any new
  command/flow during a live test, or temporarily point them at a fake
  number for the duration of the test and revert before committing.
- Confirm with whoever's driving before any real Sheets write or real
  WhatsApp send during testing.

## Known past incidents worth knowing about

- A stale duplicate Manager-sheet row sharing an order number with a real
  row once caused the status-poller to flip-flop and re-send a real "Out for
  Delivery" WhatsApp message every 60s. Fixed by keying tracked status by
  row position / `orderNumber|timestamp` instead of order number alone —
  but staff manually reordering/deleting Manager sheet rows is routine, so
  any *new* code that keys off row identity needs to account for that.
- `logOrderToSheets` and `saveCustomerProfile` both do read-next-row-then-
  write against a shared Sheet; a per-sender lock alone isn't enough because
  two *different* customers confirming near-simultaneously could clobber
  each other's row. There's a shared lock mechanism with fixed keys for
  these critical sections — reuse it for any new Sheets-write code rather
  than adding a new one.
