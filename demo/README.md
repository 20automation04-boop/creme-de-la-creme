# Pedidos Bot — live demo

A WhatsApp-style ordering bot you can edit in front of a client. One file, no
build step, no API key, no network calls. Open `chatbot.html` in a browser and
it runs.

It takes a real order end to end: reads the menu, understands quantities,
builds a cart, totals it with delivery, confirms, **issues an order number and
assigns a driver**, and then answers "¿dónde va mi pedido?" with that ticket.

## The two surfaces

| Surface | Who touches it | Where |
|---|---|---|
| **The chat** | The client, on your phone | top on mobile, left on desktop |
| **Live setup panel** | You, mid-pitch | below on mobile, right on desktop |

Every edit applies to the running conversation and drops a `PEDIDO ACTUALIZADO`
divider into the thread, so the client *sees* the bot learn their business.

## What to edit on the spot, in order

1. **Shop name** — retype it as theirs. Header, avatar initials and several
   answers change at once. Ten seconds and the demo is about them.
2. **The menu** — the strongest beat. Ask for three real dishes and prices,
   type them in, then **hand them the phone** and let them order their own food
   in their own words. The bot parses `"quiero 2 tacos al pastor"` — digits or
   words (`dos`, `una`), accent- and case-insensitive.
3. **Confirm the order in front of them** — this is the close. The ticket shows
   the order number, the totals, and the driver assigned off their own roster.
   Ask them what number they'd want their orders to start at and set it live.
4. **The drivers** — put their real drivers and unit numbers in. Whoever is
   marked available gets assigned next; the bot flips them to *en ruta* on
   assignment, so the second order goes to the second driver.
5. **Answers you write** — ask "what question are you sickest of answering?"
   Type their trigger word and their answer. It works on the next message.

Then open **What this looks like to us** and say the true thing: on a real
account that comes out of their existing menu, nobody retypes it.

## The language switch

Top-right of the panel flips the bot between **Español** and **English** — the
replies, the quick-reply chips, the send button and the status labels. The
opening message is per-language, so each one keeps its own wording.

Worth doing live if your client serves both.

## What the bot handles

- **Ordering** — any menu item by name, with quantities as digits or words;
  several items in one message (`"2 tacos y una agua"`)
- **`menú` / `carta`** — the full list with prices
- **`mi pedido`** — the cart so far, with subtotal, delivery and total
- **`confirmar`** — places it, numbers it, assigns a driver
- **`¿dónde va mi pedido?`** — the live ticket
- Delivery fee, zone, hours, payment methods, "hablar con una persona"
- Anything you added under **Answers you write**
- Everything else gets a fallback that names what it *can* do

## Editing the file instead of the panel

Everything the panel edits also lives in a `PITCH_CONFIG` block at the top of
the `<script>`. Change it, save, reload — good for loading a client's menu
*before* a meeting so the demo opens already looking like theirs. The panel is
for changes during the meeting.

`Reset demo` restores `PITCH_CONFIG`, empties the cart and clears the thread.
Hit it between meetings.

## Why nothing here is risky

- No network calls, no API keys, no backend. It works with the wifi off.
- No model. Answers are keyword matching over your config, so **the bot cannot
  say anything you did not write** — no invented prices, no invented promises.
- Edits persist per-browser in `localStorage` only. Nothing leaves the device.
- The menu, drivers and phone number are fictional. Replace them in the panel.
- It's styled as a messaging thread and labelled WhatsApp because that's the
  channel it's for; it doesn't use Meta's branding or claim to be their product.
