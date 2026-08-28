# Changelog

Written for whoever picks this up next — what changed, and more importantly
*why*, since several of these decisions look arbitrary without the reason.

Full detail is in the commit messages (`git log`); this is the map.

---

## 2026-08-28 — dashboards, WhatsApp-native input, UX polish

### New features

**Three staff dashboards**, served by the same Express app, each behind its
own password (`/kitchen`, `/manager`, `/driver`).

- **Kitchen** (`02eb2dc`) — live order queue, beeps and flashes on a new
  order, one-tap status changes, and an inline composer for messaging a
  customer ("the one marked [P] has pepper"). Composer replaced a `prompt()`
  popup, which kiosk/locked-down tablet browsers block outright (`ff20a92`).
  Drafts survive the 10s auto-refresh — without that, staff watched their
  message vanish mid-sentence.
- **Manager** (`c9a60ac`, `099cb21`) — sales, top items, busiest hour, plus
  tabs for editing the menu (prices, renames, sold-out), viewing customers,
  and a **Live** tab showing who is mid-conversation right now, sorted so
  escalated → frustrated → stuck customers surface first. That session data
  exists only in memory and is in no sheet, so a customer going in circles
  was previously invisible until they gave up.
- **Driver** (`dff99c9`, `6fb6d3a`, `2698d75`) — active deliveries with
  Navigate, tap-to-call, cash to collect, and Picked up / Delivered.
  Defaults to a **bright day theme** because it's read outdoors in direct
  sun where a dark UI is unreadable.

**WhatsApp-native input** (`4de2511`)

- **Shared location** — customers can send a pin instead of typing an
  address. Local addresses are often landmark-based ("house behind the blue
  gate") and not navigable; a pin always is.
- **Photo recognition** — send a picture of a drink and Gemini matches it
  against the real menu. Three-way outcome, not two: a confident single
  match orders it, a narrowed set is offered to tap, anything unclear shows
  the menu. Names are verified against the real menu, so a hallucinated item
  can never reach the order path.
- **Delivery landmarks** — optional step after a first-time address,
  answerable by text, voice note, or a photo of the gate which Gemini
  describes for the driver. One tap skips it; returning customers with a
  saved address skip it automatically.

**Conversational**

- **Craving & recommendation replies** (`8df2330`) — "anything mango?",
  "what do you recommend?", "no sé qué pedir". Flavour matching works off
  the words in menu item and category names, so it keeps working as the menu
  changes. Open-ended asks answer with genuine best-sellers from order
  history. Runs *before* the AI parser so a browsing question can't be
  guessed into a silent cart addition — which also keeps it working when
  Gemini is rate-limited.
- **Natural-language commands** (`5e38a21`, `451495a`, `c1df339`) — "otra
  vez", "eso es todo", "where's my order" map onto the real commands, in
  both languages, with a keyword fallback tier for anything unanticipated.
- **Checkout upsell** (`27a16e4`, reconciled in `cb0d0be`) — one best-seller
  from a *different* category, offered alongside the checkout buttons. Two
  implementations landed independently and were merged down to this one;
  **note that `ROADMAP.md` still describes the other** (cheapest item from
  the missing food/drink side). The code is the best-seller version — see
  `pickUpsell()`. Worth reconciling.
- **Help button when stuck** (`451495a`) — the "didn't catch that" reply used
  to say "type *help*", the exact thing a stuck customer won't do.

### Bug fixes

Ordered by how much damage each was doing.

1. **Stale button taps corrupted real orders** (`5df3111`) — WhatsApp never
   expires interactive messages. Tapping an old "Done" stored `done` as an
   item's kitchen note (`Vanilla Bean [done] x2` reproduced), and at the
   address step it became the literal **delivery address** *and* was written
   to the customer's saved profile — so a driver could be sent to "done" and
   the bad address re-offered forever. Now rejected wherever free text is the
   expected answer.
2. **Fast tappers were silently cut off mid-order** (`522af90`) — the
   per-sender rate limit was 20/min, dropped with **no reply**. One item is
   already ~10 messages, so a normal multi-item order at speed hit the
   ceiling and the bot just went quiet. Now 60/min with a friendly notice,
   plus a 1.2s debounce for double-taps (which arrive as *different* message
   ids, so id-dedup never caught them).
3. **Customers never learned their food was on the way** (`7c568bb`) — the
   status poller ran every 60s and only saw the *current* status, so staff
   moving an order Preparing → Out for Delivery → Completed inside one window
   silently dropped the middle one. Confirmed in production logs for two real
   orders. Dashboards now notify immediately; the poller remains the fallback.
4. **Spanish speakers were told to type English commands** (`3524564`) — the
   help glossary showed `cart`, `done`, `status` even in Spanish, though
   `carrito`, `listo`, `estado` already worked. Also fixed accent handling:
   literals are precomposed (NFC) but phone keyboards emit decomposed (NFD),
   so a correctly-typed "atrás" matched nothing.
5. **Language picker reappeared after every order** (`5df3111`) — completing
   or cancelling reset the session with `newSession()`, dumping a customer
   back on English/Español right after they'd ordered. The idle-expiry path
   already preserved language by hand; that's now the shared rule.
6. **`repeat` was advertised but only half-wired** (`5df3111`) — documented
   in help, but only handled at the `menu` step, not `item` — which is
   exactly where customers are parked after every add.
7. **"Mango" resolved to "Mango/Pine"** (`522af90`) — `findMenuItemByName`
   matched by substring only, so asking for one item could quietly get you a
   different one. Exact match now wins.
8. **Misleading onboarding docs** (`742acfa`) — `HANDOFF.md` claimed the test
   suite "was never written" and advised ripping out the harness; a developer
   following it would have deleted 34 working tests. Also fixed
   `test-sheets.js`, which is named like a test but writes a real row to the
   production sheet — it wrote only 6 of 8 columns, leaving rows with no
   phone (which permanently breaks `STATUS` and `cancel order` lookups) and
   is the origin of the orphan Manager row 2. Now requires an explicit
   `--write-to-production` flag.

### Removed

- **Abandoned-cart discount** (`ecd9331`) — business decision. The ~1hr
  win-back reminder still goes out; it just no longer offers money off.

### Data cleanup

23 stale pre-launch test orders marked **Cancelled** (not Completed —
Completed would have fired a real "your order is complete" WhatsApp to each).
Manager totals went from an inflated $774.50 to an honest $170.00.

### Merged with parallel work

This session's branch was rebased onto 13 commits done in parallel (security
fixes, an ordering-flow rework, and CI — PR #2). Those changed the ordering
flow underneath everything above: a tap now **adds an item directly** and
quantities are collected **once at the end** in a new `qtyrecap` step, rather
than being asked mid-selection. So "done" now goes `qtyrecap → mode`, not
straight to `mode`. Fixtures throughout `test/replays/` reflect that.

The two upsell implementations were reconciled in `cb0d0be`, keeping the
best-seller version.

### Tests

34 → **63** after the merge. Added `test/dashboards.test.js` (12 offline tests: cross-board
password rejection, shifted-row guards, the driver's narrowed permissions,
money formatting, revenue excluding cancellations) plus fixtures for the
stale-tap guards, natural-language false positives, craving replies, repeat
from the item step, and the upsell.

To make dashboard tests meaningful the dry-run Sheets stub became seedable
(`dryRunSheetRows` / `dryRunSheetWrites`) — previously every read returned
empty, so the endpoints' real parsing could never be exercised.

### Design decisions worth not re-litigating

- **The upsell is not a checkout step.** The first version made it one, and
  it broke a dozen checkout fixtures — the tell that it had inserted a
  mandatory extra tap into *every* order. It's now appended to the normal
  checkout reply; ignoring it costs nothing.
- **Dashboards are a view over the Manager sheet, not a second store.** Edits
  write through, so a dashboard tap and a manual sheet edit behave
  identically and can't drift.
- **Separate password per board.** Kitchen staff don't need revenue; a
  driver needs neither. One shared credential would hand them everything.
- **Fuzzy keyword matching can never reach a destructive command.** `done`,
  `cancel` and `repeat` are excluded from the loosest matching tier — a wrong
  guess there costs real money.
