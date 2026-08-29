# Pizza Bot Roadmap

A phased plan for launching an AI ordering assistant for the pizza side of the
business — a contained pilot, kept separate from the rest of the restaurant
group until it proves itself. Prepared for the Monday pitch meeting.

Live version (for the meeting): see the published artifact link shared in
chat, or re-open it via `/artifacts` in Claude Code.

## Why start with pizza

- **A finite menu.** Build-your-own pizza is a clean decision tree — size,
  crust, toppings. It's the easiest order type to automate well, and the
  fastest to prove.
- **High order volume.** Phone-in pizza orders are frequent and easy to
  mishear. It's the clearest place to show time saved and orders recovered,
  fast.
- **Contained blast radius.** One pizza location, one pilot. Nothing changes
  for the full restaurant group until the numbers say it should.

## The build — 6 phases, ~8 weeks to a working pilot

| Phase | Weeks | Name | What happens | Deliverable |
|---|---|---|---|---|
| 00 | 1 | Discovery & scope | Map the full pizza menu (sizes, crusts, toppings, combos, deals), pick the ordering channel (web chat first), confirm the pilot location's POS and payment system. | Signed-off scope + conversation map |
| 01 | 2–3 | Conversation & menu design | Design the order flow — pickup or delivery, build-the-pizza, upsell prompts, review, pay, confirm — and script half-and-half toppings, allergies, substitutions, sold-out items. | Approved flow + sample conversations |
| 02 | 3–5 | Build & integrate | Build the bot, connect it to the POS for live menu sync and order entry, wire up payment, route tickets to the kitchen like any other order. | Working bot in a staging environment |
| 03 | 6 | Testing & staff training | Run every topping combination and edge case, load-test for peak hours, train staff on watching for orders that need a human. | QA sign-off, staff ready |
| 04 | 7 | Pilot launch | Go live at one location. Daily check-ins on order volume, accuracy, and handoffs. Fix issues in real time. | Live pilot + daily monitoring |
| 05 | 8+ | Optimize & decide | Tune against real order data, then decide: more pizza locations, or start scoping a bot for the full restaurant group. | Performance report + next-step recommendation |

## What's in scope

**In the pilot (weeks 1–8)**
- Order taking by web chat
- Pickup and delivery
- Full customization, including half-and-half
- Upsell prompts — sides, drinks, dessert
- Order confirmation with time estimate
- Basic FAQ — hours, address, allergens
- Human handoff for anything unusual

**Once it's proven (next phase)**
- SMS and WhatsApp ordering
- "Your usual" — repeat-order memory
- Multi-location routing
- Promo codes and loyalty tie-in
- Catering and large-order requests
- Extending to the full group's menus and reservations

## What we'll track

Pilot targets, measured against the location's current numbers — not
promises. Phase 05 reports the real figures.

| Metric | Target |
|---|---|
| Phone orders shifted to chat | 30–50% |
| Avg. upsell attached per order | +1 item |
| Order accuracy, no re-fires | 99%+ |
| Staff phone time saved per week | 10–15 hrs |

## Why this leads somewhere bigger

If the pilot moves the numbers above, the same playbook scopes cleanly onto
the rest of the restaurant group — different menus, reservations,
multi-location complexity — with real pilot data behind it instead of a
pitch.

## To start Phase 00, we need from her

- Full pizza menu, current pricing
- Which location runs the pilot
- POS / online ordering system in use
- Sign-off on the 8-week timeline
