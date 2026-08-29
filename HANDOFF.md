# Handoff notes — Créme De La Créme WhatsApp bot

Read this before doing anything else. This is context a fresh Claude session
(or a fresh developer) won't have from the code alone.

See `CHANGELOG.md` for what changed recently and why — several decisions in
this codebase look arbitrary without the reason behind them, and it records
the bugs that motivated the guards you'll find scattered through `index.js`.

## Status: pre-launch (confirmed directly with the owner, 2026-08-28)

**Créme De La Créme is not yet taking real customer orders.** The owner
confirmed this directly when asked point-blank — not inferred from behavior.
Earlier revisions of this file said "live in production," written on the
assumption that careful, production-grade handling implied a live business;
that assumption was wrong. The number, Sheet, and menu are all real (this
is a genuine business preparing to launch, not a throwaway sandbox), but
no paying customer is ordering through it today.

**What that changes:** the "every write/send touches a real customer"
urgency can relax somewhat while building — a stray test order isn't
disrupting a real customer's evening.

**What that does NOT change:** the dashboards (`/kitchen`, `/manager`,
`/driver`) expose real phone numbers, addresses, and order data regardless
of launch status, and their passwords should stay private — treat them the
same as any other credential. Nobody has confirmed sharing them externally
is fine; don't assume it because the launch-status question got a relaxed
answer. If unsure, ask the owner the specific question, not the general one.

**When this actually launches**, re-instate full production caution
everywhere below — that transition should get its own explicit
confirmation and a dated note here, the same way this one did.

**Number:** +501 606-9511. **Shop's own number:** +501 616-2492 (also the
current value in both `DRIVER_NUMBERS` and `OWNER_NUMBERS`).

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
   (`node --test test/*.test.js`) — 102 tests covering the ordering FSM,
   button routing, owner commands, the escalation ladder, and the dashboards.
   They use
   `BOT_DRY_RUN=1` (set by the test files themselves) so no real WhatsApp
   send or Sheets write happens, even with real credentials in `.env`.
   Run them before every deploy — `npm run predeploy` is the same thing.
   Note: on Windows/Node 25 the glob form `node --test test/*.test.js` is
   required; bare `node --test test/` fails with `Cannot find module 'test'`.
4. Deploy target is **Railway**, project `creme-de-la-creme-bot`. **There is
   no CD** — deploy is a manual `railway up --detach` run from this
   directory. Editing `index.js` locally does nothing to the live bot until
   you deploy. Requires the Railway CLI logged in to the account that owns
   that project.

   **That Railway project contains TWO services, and one of them is
   permanently broken on purpose.** `railway status` shows:

   - `creme-de-la-creme-bot` — ● Online. **This is the bot.** It is what
     the local link points at, so a plain `railway up` targets it.
   - `creme-de-la-creme` — ● Failed, always. It auto-deploys from the
     GitHub repo's `main` branch, which is the unrelated README/"taste
     skill" content described under "Repo / branch layout" below. There is
     no bot in it and there never was; the failure is expected and is not a
     symptom of anything being wrong.

   Do not "fix" the Failed one by deploying the bot into it. Both services
   would then run the same code against the same WhatsApp number, and every
   customer message would be answered twice. If `railway up` ever asks which
   service to use, the answer is `creme-de-la-creme-bot` — confirm with
   `railway status` first, never guess.

   There IS CI: `.github/workflows/test.yml` runs `npm test` on every push
   and PR, with no credentials (BOT_DRY_RUN keeps it off the live number and
   the real Sheet). It covers the state machine, the ordering flow, the sheet
   parser and the HTTP auth surface — but NOT the Gemini prompt, which needs
   a real key. Use `node check-ai-parsing.js` for that, by hand.
   Because nothing gates the deploy itself, a green CI run is necessary but
   not sufficient: still run the suite locally before `railway up`.

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

## Staff dashboards (added 2026-08-28)

Three web dashboards served by the same Express app, each behind its OWN
password so a credential only opens what that role needs. All are day/night
themeable and work on phone, tablet and desktop. Passwords live in Railway
env vars — never in git.

| Board | Path | Env var | Who it's for |
|---|---|---|---|
| Kitchen | `/kitchen` | `KITCHEN_PASSWORD` | Order queue, status buttons, message a customer |
| Manager | `/manager` | `MANAGER_PASSWORD` | Sales, menu editing, live conversations, customers, pause orders |
| Driver | `/driver` | `DRIVER_PASSWORD` | Active deliveries, navigate, tap-to-call, mark delivered |

Design rules these follow — keep them if you extend:

- **They are a VIEW over the Manager sheet, not a second store.** Status
  changes write to `Manager!H`, and the existing `pollOrderStatus` job then
  notifies the customer, so a dashboard tap and a manual sheet edit behave
  identically. Editing the sheet by hand still works exactly as before.
- **Menu edits write through to the Availability sheet**, because
  `refreshMenuFromSheet` reads that sheet back over memory every 2 minutes
  and would otherwise silently undo the change.
- **Every status/message write re-reads the row and checks the order number
  still matches** before writing (409 otherwise). Staff reorder and delete
  Manager rows routinely; a row number captured seconds ago can already
  point at a different order, and writing blind would update — or text — a
  stranger.
- **The driver's status whitelist is deliberately narrower** than the
  kitchen's: `Out for Delivery` and `Completed` only.
- **`PUBLIC_BASE_URL`** (or Railway's `RAILWAY_PUBLIC_DOMAIN`) is what puts
  the tap-through dashboard link into staff notifications.

Covered by `test/dashboards.test.js` — 12 offline tests including
cross-board password rejection and the shifted-row guards.

## Feature status

All of a prior internal roadmap's Phases 1, 2, 3, and 5 are shipped and live
(session intelligence / idle nudges, mood detection + escalation ladder,
personalization + saved addresses + substitutions, owner commands +
abandoned-cart recovery). See `ROADMAP.md` in this repo for the up-to-date
list — it's the source of truth for feature asks going forward.

Voice-note ordering **is** built and live (`transcribeVoiceNote()` — Gemini
audio in, transcript through the same text-parsing path). An earlier version
of this file listed it as not started; that was wrong.

Also live since: photo recognition (send a picture of a drink, Gemini matches
it against the real menu), shared-location delivery addresses, an optional
delivery-landmark step (typed, spoken, or a photo of the gate that Gemini
describes for the driver), craving/recommendation replies, natural-language
command aliases, and a one-time checkout upsell.

**Not built:**

- **Kitchen ticket / printer** — blocked on the owner specifying what
  hardware they actually have. Note the constraint: the bot runs on Railway
  (cloud) and *cannot* reach a printer on the shop's LAN. It needs either a
  cloud print service (PrintNode, Star CloudPRNT) or a small agent running
  at the shop. Printer age barely matters — if it prints a Windows test
  page, it works.
- **Menu photos / WhatsApp catalog** — blocked on the owner supplying
  photos. Worth knowing before building: WhatsApp's native cart has **no
  per-item customization field**, so a straight swap would LOSE the
  per-item notes ("no onions") that currently reach the kitchen. The sane
  shape is catalog-for-browsing, existing cart for customization.
- **Add/remove menu items from the dashboard** — prices, renames and
  sold-out toggles are done; creating and discontinuing items still goes
  through the Availability sheet's row-ID contract, which has real footguns.

## Known gaps worth fixing before advertising

1. **`DRIVER_NUMBERS` and `OWNER_NUMBERS` are both the shop's own phone**
   (`5016162492`). No actual driver is being notified — every delivery ping
   lands on the shop handset and someone relays it by hand. This breaks
   exactly when volume arrives.
2. **No external uptime monitor.** `alertOwner` rides the same WhatsApp
   channel it would need to report on, so a Chakra/WhatsApp outage is
   silent. A free UptimeRobot pinging `/` would close it.
3. **Sessions are in memory.** A deploy or crash drops in-flight carts
   (saved carts survive to the sheet; a cart mid-order does not).
4. **Cash only in production today.** A generic online-payments SCAFFOLD
   exists (`PAYMENTS_ENABLED`, the 'payment' step, `/payment-webhook`) but no
   real provider is wired in — see "Online payments" below before turning it
   on.

## Online payments (scaffold, not live — added 2026-08-28)

The owner asked whether online payment could remove the manual "did they
actually deposit it" check. Researched Belize-specific options (Belize
Bank's card payment gateway, Atlantic Bank's gateway, E-kyash, DigiWallet) —
every real path requires an in-person branch visit, a signed merchant
agreement, and a bank's KYC/approval process. That's a real-world business
step nobody but the owner can do, and Belize Bank's technical integration
guide had already been taken down from their live site by the time this was
researched (a PDF found via search 404'd; only a stale web.archive.org copy
exists, and it wasn't fetchable either) — so nothing here is wired to any
specific provider's real API.

What IS built: the generic plumbing so that once there's a real merchant
account and real API docs, wiring one in is a small, isolated change instead
of a checkout redesign.

- **`PAYMENTS_ENABLED`** (env var) — OFF by default. With it off (today's
  state), `'confirm'`'s "yes" behaves exactly as it always has: immediate
  cash-style confirm, no payment step. This is a runtime flag
  (`let paymentsEnabled`, not a frozen `const`), not just an env read, so
  `test/payments.test.js` can flip it per-test via
  `setPaymentsEnabledForTests()`.
- **`createPaymentLink(orderNumber, session)`** and **`verifyPaymentWebhook(req)`**
  (both in index.js, right above `tryCheckoutWithUpsell`) — the ONLY two
  functions a real integration needs to fill in. `createPaymentLink` today
  always throws; `verifyPaymentWebhook` always returns `null`. A thrown/falsy
  result from `createPaymentLink` is treated as "payments aren't usable yet"
  and checkout silently falls back to the normal unpaid confirm (plus an
  `alertOwner` ping) — same "must never block a real order" principle the
  checkout upsell already follows. Test-only overrides:
  `setPaymentAdapterForTests()` / `setPaymentWebhookVerifierForTests()`.
- **`finalizeOrder(session, from, lang, presetOrderNumber)`** — a pure
  extraction of what used to be inline in the 'confirm' case's "yes" branch
  (mint order number, write `lastOrders`, log to Sheets, notify
  driver/owner). Shared by BOTH the cash path and the payment-webhook path,
  so a paid order goes through the exact same staff-facing code the kitchen/
  manager dashboards already depend on — not a parallel path that could
  quietly drift from it.
- **`'payment'` step + `pendingPayments`** — when `createPaymentLink`
  succeeds, the cart is snapshotted into `pendingPayments[reference]`
  (keyed by whatever `createPaymentLink` returned), the customer gets the
  link, and the order is deliberately NOT written to `lastOrders`/Sheets yet.
  `POST /payment-webhook` is what actually finalizes it, once
  `verifyPaymentWebhook` confirms payment. The cart is locked at this
  step — unlike `'confirm'`, it does not accept "add one more thing" free
  text, since that would desync the cart from the amount already sent to
  the payment page.
- Typing `cancel` at the `'payment'` step is caught by the pre-existing
  GLOBAL cancel command (same one every other step uses) — it now also
  deletes the matching `pendingPayments` entry so a cancelled payment
  doesn't leak forever; see that handler's comment.

**Known gap, left unsolved on purpose:** nothing expires a `pendingPayments`
entry if the customer just abandons the chat without paying OR typing
`cancel` — not worth guessing a cleanup policy before there's a real gateway
to see actual webhook timing/retry behavior against.

**To actually go live:** get a merchant account (Belize Bank / Atlantic Bank
/ E-kyash / other), replace `createPaymentLink`/`verifyPaymentWebhook`'s
bodies with that provider's real API calls and signature scheme (mirror
`verifyChakraSignature`'s HMAC pattern near the top of index.js for the
signature check), set `PAYMENTS_ENABLED=true`, and register the provider's
webhook URL as `https://<your-domain>/payment-webhook`. Covered by
`test/payments.test.js` (4 tests, all using the test-only overrides above —
none of it touches a real provider).

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
  and all 52 pass. Do not rip it out.
- `sendReply` was changed from fire-and-forget to properly `async`/awaited
  so that two rapid messages from the same sender have their actual sends
  (not just session-state mutations) stay in order under the existing
  per-sender lock.

## Security posture (read before exposing this to a new client)

The Railway URL is public — anyone who finds it can reach every route. What
holds the line, and what to re-check if you change any of it:

- **`CHAKRA_WEBHOOK_SECRET` must be set.** With it set, `/whatsapp` requires a
  valid HMAC. With it UNSET, verification is skipped entirely (a deliberate
  opt-out) — and since `isOwner()` trusts the `from` in the payload, an
  unverified deployment lets anyone run owner commands by putting the owner
  number in a forged webhook. Treat an unset secret as "no access control".
- **`WEBHOOK_VERIFY_TOKEN` must be set**, or `GET /whatsapp` refuses every
  verification handshake. It previously handed the challenge to any caller
  when the variable was missing.
- **All three dashboard passwords must be long and random.** Each is the only
  thing guarding its board: `/kitchen` and `/driver` expose customer phone
  numbers and addresses, and `/manager` adds sales, the full customer list,
  live conversations, price edits, pause-orders and the promo broadcast.
  Wrong guesses are capped at 10 per 15 minutes globally on each board
  (failures only, so staff logins never count), on SEPARATE limiter keys so a
  brute-force run at one board cannot lock staff out of another mid-shift.
  Every cookie is a bearer token valid for a year and carries `Secure` +
  `HttpOnly` + `SameSite=Lax`, so rotating the password is what revokes a lost
  or stolen device.
  Note for anyone adding a FOURTH board: `/manager` and `/driver` were added
  after `/kitchen` and silently inherited none of this — no rate limit, no
  `Secure` — for a while, because each login handler is written out
  longhand rather than sharing a helper. Copy the whole shape, and add the
  pair of tests in `test/security.test.js` that pins it.
- **Customer-typed values go through `sheetSafe()` before any Sheets write.**
  Sheets evaluates a cell starting with `=`, `+`, `-` or `@` as a formula, so an
  unescaped saved address can execute when staff open the tab. Any NEW code that
  writes user text to a sheet must use it.
- **The Gemini prompt fences the customer message as data.** `answer` is sent to
  the customer verbatim as the shop, so a customer who can steer it can make the
  business appear to say things. Before changing that prompt, run
  `GOOGLE_API_KEY=... node check-ai-parsing.js` on the old and new versions and
  compare — it checks order matching (a regression there costs real orders), FAQ
  answers, and injection resistance. Nothing else in the repo can catch a prompt
  regression: the replay suite runs with no AI at all.
- `test/security.test.js` pins all of the above. Run it after touching any
  route auth — it drives the real Express app over a socket, so it sees the
  request-edge cases the replay suite cannot.

## Menu item identity (do not key off display position)

Each menu item carries a stable `item.sheetId` (`"categoryId.N"`), stamped once
at load and never recomputed. The Availability sheet, `soldOutIds`, and the
owner's `soldout`/`instock` write-through all key off it.

They must, because a display position is NOT stable: deleting a row from the
Availability tab splices the category array, so every later item shifts down
one. Keying sold-out state by position used to produce both failure modes at
once — the item that was really sold out kept selling, and its in-stock
neighbour was refused. `itemAt(categoryId, itemIndex)` is the one sanctioned
place to turn a position (what the customer typed or tapped) into an item.

That applies to stored cart lines too. `savedCarts` and `lastOrders` outlive
menu edits, so each line carries `sheetId` and is resolved back to a live item
with `resolveCartLine()` before its sold-out status is re-checked — the *repeat*
command and the abandoned-cart resume both do this. Checking the stored position
instead read whatever item had since slid into that slot.

New code that records anything per-item should key off `item.sheetId`, never
off the item's index. `test/menu-sheet.test.js` pins this.
## Testing safety rules (important)

Pre-launch status (above) means no paying customer is downstream right now
— but `DRIVER_NUMBERS`/`OWNER_NUMBERS`/`SHOP_INFO.phone` are still the
owner's own real phone, a real device a real person checks. These rules
still apply; "pre-launch" is not "nobody real is on the other end."

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
- Dashboard passwords (`KITCHEN_PASSWORD`/`MANAGER_PASSWORD`/
  `DRIVER_PASSWORD`) stay private regardless of launch status — they gate
  real phone numbers and addresses collected during testing.

## Repo / branch layout

Local `master` is pushed to the **`bot`** branch of
`github.com/20automation04-boop/creme-de-la-creme`. The repo's `main` branch
is unrelated content (a README and a different "taste" skill) and shares no
history with this project — don't merge them expecting a common ancestor.

Deploys are still a manual `railway up --detach` from this directory, and
run from the WORKING DIRECTORY, not from git. Committing does not deploy,
and deploying does not require committing — keep them in step yourself.

## Known past incidents worth knowing about

- A stale duplicate Manager-sheet row sharing an order number with a real
  row once caused the status-poller to flip-flop and re-send a real "Out for
  Delivery" WhatsApp message every 60s. Fixed by keying tracked status by
  row position / `orderNumber|timestamp` instead of order number alone —
  but staff manually reordering/deleting Manager sheet rows is routine, so
  any *new* code that keys off row identity needs to account for that.
- **Stale button taps.** WhatsApp never expires interactive messages, so a
  customer can tap a button from days ago. Bare-word button ids were being
  swallowed as free text: a stale "Done" tap became an item's kitchen note
  (`Vanilla Bean [done] x2`), and at the address step it became the literal
  delivery address AND was saved to the customer's profile. Fixed by
  rejecting interactive taps wherever free text is the expected *answer*
  (notes, address, quantity, delivery-landmark). Any NEW step that accepts
  free text needs the same guard.
- **Silent rate-limit drops.** The per-sender limit was 20/min with no reply
  on breach; a customer tapping quickly through a normal order blew past it
  and the bot simply went quiet mid-order. Now 60/min, and a breach sends
  one friendly notice instead of silence. Rapid identical taps are also
  debounced (1.2s) since they arrive as different message ids.
- **Accented commands.** Literals here are precomposed (NFC) but phone
  keyboards can emit decomposed (NFD) — a correctly-typed "atrás" matched
  nothing. `rawMsg` is normalized once at entry; don't compare un-normalized
  text.
- `logOrderToSheets` and `saveCustomerProfile` both do read-next-row-then-
  write against a shared Sheet; a per-sender lock alone isn't enough because
  two *different* customers confirming near-simultaneously could clobber
  each other's row. There's a shared lock mechanism with fixed keys for
  these critical sections — reuse it for any new Sheets-write code rather
  than adding a new one.
