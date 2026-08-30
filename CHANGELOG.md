# Changelog

Written for whoever picks this up next — what changed, and more importantly
*why*, since several of these decisions look arbitrary without the reason.

Full detail is in the commit messages (`git log`); this is the map.

---

## 2026-08-29 — bug hunt: quantity loss, Spanish skip words, dashboard logins

Found by driving realistic customer conversations through the real FSM in
both languages, plus a review of the pending diff. Every fix below ships
with regression tests that were confirmed to FAIL against the old code first
— a pinning test that passes either way is worth nothing.

### Customer-facing bugs

**Repeated taps silently lost their quantity.** Tapping an item three times
correctly built a line of three (`cart` even showed "x3 - $21.00"), but the
quantity recap rendered every line at its *unit* price, so the screen said
"Vanilla Bean — $7.00" and gave no sign the line held three. Tapping the
finalize row — labelled "1 of each", which reads as plain confirmation —
then reset it to one. Two drinks gone, no message saying so.

Two causes, both fixed. The recap body now shows `x3 — $21.00` whenever a
line holds more than one. And the finalize handler no longer writes
`line.qty = 1`: an implicit line is *always* at least 1, so that assignment
could only ever REDUCE a quantity — it was never doing useful work. It now
just marks lines settled. The row also reads "Done" rather than "1 of each"
once any line holds more than one, since that label would otherwise be a lie.

**Spanish `saltar` was not a skip word.** The lists had `omitir` but not
`saltar`, the more common everyday word. At the notes recap it was rejected
as unclear; at the delivery-landmark step it was worse — not rejected but
*stored*, so the driver was handed the word "saltar" as the find-me
instruction. Same family as the stale "Done" tap that once became a
delivery address.

**Asking to see your cart failed at both recap steps.** `cart`/`carrito`/
`total` were only wired at the menu and item steps, though the command
glossary advertises them as working anywhere. At a recap they fell into the
quantity/note parser and came back as a parse failure — which also feeds the
frustration ladder, so asking to see your own order twice was enough to get
offered a human agent. Now resolved (prose forms included) but ONLY after
the step's own parse returns zero matches, so it cannot swallow a real
quantity phrase or note: anything reaching it was already a failure.

### Security

**The manager and driver boards never inherited /kitchen's login
hardening.** Both accepted unlimited password guesses — no rate limit at all
— and neither cookie carried `Secure`, despite being year-long bearer
tokens. `/manager` guards strictly more than `/kitchen` does (sales, the
customer list, live conversations, prices, pause-orders, the promo
broadcast), so the least-defended door opened the most valuable room. All
three boards now share the same 10-per-15-minute ceiling, on separate keys
so a run at one cannot lock staff out of another, and all three cookies are
`Secure`.

**`.gitignore` had lost `.claude/settings.local.json`** to a typo
(`setngs`). It still looked ignored locally only because a *global* gitignore
covered it — machine-local, so any other clone would have seen the file
untracked and ready to be committed by `git add -A`.

**The manager menu editor wrote item names to the sheet without
`sheetSafe`.** Staff-typed, so low risk, but an item renamed to `=1+1` would
be evaluated by Sheets and read back by `refreshMenuFromSheet` as the name
"2" — shown to customers.

### Money

**The $5 delivery fee was never actually charged.** `cartTotal` summed items
only, and so did the customer's total, the Manager sheet row, and the
driver's notification — which said "Total to collect: $7.00" on an order the
customer had twice been told carried a $5 delivery fee. Every delivery lost
the fee and recorded revenue was short by the same amount.

Now charged, on the owner's call. `orderTotal(cart, mode)` adds the fee for
delivery and nothing otherwise; it feeds the customer's total, the sheet, and
both staff notifications from one place. It takes the *mode* rather than a
session so the cart helpers stay pure and every pre-mode screen (menu, item,
both recaps) renders exactly as before — `session.mode` is null until the
customer picks one. The fee gets its own visible line rather than being
folded into the total: someone who watched their items reach $14 and then
sees $19 needs to see why.

**The advertised $5 delivery minimum was removed rather than enforced.** It
appeared in four FAQ strings and the Gemini shop facts, and nothing anywhere
checked it — a $2.50 hot dog went out for delivery just fine. The owner
chose to drop the claim. `SHOP_INFO.minDeliveryOrder` is kept but marked
unused, with a note that putting the promise back means also gating the
`'mode'` step on it, or the copy drifts from the behaviour again.

### Regression tests for the item-question and delivery-question fixes

The two fixes that stopped questions being read as orders ("how much is the
chicken & cheese sub?" adding a $10 sub to the cart; "do you deliver to
Ladyville?" committing mode=delivery with address="Ladyville?" and then
fast-tracking checkout past both questions) shipped without any test. Both
guards — `isItemQuestion()` and `MODE_QUESTION_RE` — run BEFORE the AI and
are pure, so they pin cleanly.

Three fixtures added, each verified to fail against the pre-fix `index.js`.
They assert on the CART and the SESSION FIELDS rather than on reply wording,
because the reply is AI-generated: that keeps them honest in CI, where there
is no Gemini key and the call fails outright. Each carries a control — a real
order, and a real "deliver it to 123 Main St" — because a question filter
that also swallowed genuine orders would be a worse bug than the one it
fixed.

Needed one more harness assertion, `expectFieldEquals`: `session.mode` and
`session.address` both default to null, and `null <= 0` is true in JS, so the
existing AtMost check would have passed whether or not the fields had been
wrongly committed — exactly the property under test.

### The claims audit

Every bug above turned out to be the same shape: a promise made in the copy
and kept somewhere else, or nowhere. So the last pass stopped hunting bugs
and instead took every customer-facing claim in `SHOP_INFO` and the `TXT`
blocks and asked what enforces it. A generated command × step matrix
(12 documented commands against all 8 steps of the ordering funnel, both
languages) found four more:

- **`cart` died at `mode` and `confirm`** — answered with "Pickup or
  delivery — which one?" and "Yes to confirm, or no to cancel?". Those are
  the two screens where someone is most likely to ask what they are about to
  pay, and with the delivery fee now real, `confirm` is where the number
  actually changes. Both resolved before `attemptFreeOrder` so the question
  no longer burns a Gemini call being misread as an item.
- **`done` died at `qtyrecap`** — `notesrecap` had always accepted the word.
- **`back` died at `menu`.** Nowhere to go from the top of the tree, but
  answering a documented command with the generic confusion line also
  counted as a *parse failure*, nudging the customer toward the agent ladder
  for using the bot correctly. Now re-shows the menu.
- **"You can add more items any time, even mid-order"** was false at both
  recap steps. Fixed in the COPY, not the code: those steps treat all free
  text as their own answer, and item-parsing there is exactly the
  content-swallowing hazard the `note <text>` command is already excluded
  from. The claim now says "while browsing, or right up to the final
  confirm", which is what actually happens.

Also found and fixed: **the payment FAQ was a frozen "Cash only for now"
string with no link to `PAYMENTS_ENABLED`**, so flipping that flag would have
left the bot telling customers cash-only while checkout handed them a payment
link — the delivery-fee bug waiting to happen a second time. Now derived from
the flag, with both states pinned in `test/payments.test.js`.

**Checked and found honest:** the 3-minute cancel window, the "20 more
minutes" idle hold (10-minute nudge + 30-minute expiry), the `MAX_QTY` and
`MAX_CART_LINES` ceilings, the `3x12` bulk shortcut, `stop deals`, and the
voice-note / photo / shared-location claims (all three have real handlers).

**Accepted as-is, deliberately:**

- **`deliveryAreas` is display-only** — nothing validates that an address is
  inside Belize City limits, so an out-of-area order is accepted and
  dispatched. Left alone on purpose: real validation needs geocoding, and a
  naive keyword check would falsely reject the landmark-style addresses that
  are normal here. A false rejection costs a real order, which is worse than
  the shop ringing back.
- **`repeat` refuses mid-order** (at both recaps, `mode` and `confirm`).
  Correct — it replaces the cart, which would be destructive there — but it
  says "I didn't catch that" rather than explaining. Behaviour right,
  message wrong.
- **`hoursEn`/`hoursEs` duplicate `SHOP_HOURS`.** Already carries an
  IMPORTANT "keep in sync" comment; the display string and the actual
  open/closed logic are still two sources of truth for one fact.

### Test harness

Two additions, both driven by the bugs above. `expectReplyContains` now takes
an array as well as a string (ALL-of), because one reply often has to satisfy
several claims at once and splitting them across turns silently sends extra
messages instead of asserting twice about the same one. And
`expectSentToContains` can assert the CONTENT of a message sent to the driver
or owner — previously only the customer's own replies were inspectable, which
is exactly why a wrong "total to collect" on every delivery order was
invisible to the suite.

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
