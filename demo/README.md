# Order Line — live demo

A demo of the WhatsApp ordering bot, built to be edited in front of a client.
One file, no build step, no API key, no network calls. Open `chatbot.html` in
a browser and it runs.

It mirrors the command flow in `WhatsAppOrderBot/main.py` — the same commands,
the same order-id shape, the same "estimated delivery" close — so a client who
buys after seeing this gets what they saw.

## The commands it answers

| Command | What happens |
|---|---|
| `MENU` | Menu grouped by course, **with prices**, ending in the ORDER hint |
| `ORDER [item] [quantity]` | Places the order, returns the ticket |
| `STATUS` | Last 5 orders with status, total and time |
| `DELIVERY` | Prompts for `Address: [your full address]` |
| `Address: ...` | Confirms the saved address |
| `HELP` / `hi` | The welcome message and the command list |
| anything else | "I'm not sure I understand. Type HELP…" |

Item matching is a substring of the menu name, the same as the webhook — so
`ORDER fried rice 2` and `ORDER rice 2` both land on Fried Rice.

## Where the demo deliberately differs from main.py

Three of these are bugs in the bot that the demo does **not** reproduce,
because reproducing them would make the demo unsellable. They need fixing in
the bot before a client sees a real deployment.

1. **Ordering works here.** In `main.py` the `elif "order" in user_message`
   branch is tested *before* `elif user_message.startswith("order ")`, so
   `process_order()` is unreachable and no order can ever be placed. The demo
   tests the specific command first.
2. **Prices show here.** `get_menu_text()` prints name and description but no
   price, and both `Total:` lines — in the order confirmation and in the
   status list — interpolate nothing and come out blank.
3. **A driver is assigned here.** The `Driver` model and `Order.driver_id`
   exist, but nothing ever writes them and no message names a driver.

Also worth knowing: `save_address()` returns success without saving anything,
and orders are created with no `delivery_address`.

## What to edit on the spot, in order

1. **Restaurant name** — retype it as theirs. Header, avatar initials and the
   menu title change at once.
2. **The menu** — their real dishes, courses and prices. Then hand them the
   phone and let them type `ORDER <their dish> 2` themselves.
3. **The order prefix** — set it to their initials so the ticket reads
   `#GD20260829…` in their own branding.
4. **The drivers** — their real drivers and numbers. Whoever is available gets
   the next order and flips to delivering, so a second order goes to a second
   driver.

Then open **What this looks like to us** and say the true thing: on a real
account this comes out of their existing menu, nobody retypes it.

## Editing the file instead of the panel

Everything the panel edits also lives in a `PITCH_CONFIG` block at the top of
the `<script>`. Change it, save, reload — good for loading a client's menu
before a meeting. The panel is for changes during the meeting.

`Reset demo` restores `PITCH_CONFIG`, clears the orders and the thread.

## Why nothing here is risky

- No network calls, no API keys, no backend. It works with the wifi off.
- No model. Replies are the command handlers above, so the bot cannot invent
  a price or a promise.
- Edits persist per-browser in `localStorage` only. Nothing leaves the device.
- Menu, drivers and prices are placeholders — replace them in the panel.
- Styled as a messaging thread and labelled with the channel it targets; it
  does not use Meta branding or claim to be their product.

## One gap to plan for

Editing the menu live is the demo's strongest moment, but in `main.py` the
menu is a hardcoded `CHINESE_MENU` dict. To make the demo true, the menu needs
to move to the database or a JSON file the bot reads at request time.
