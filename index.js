require('dotenv').config();
const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');
const genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

// ---- CHAKRA / META CLOUD API CONFIG ----
// Get these from your Chakra dashboard's WhatsApp Setup page:
//   CHAKRA_API_KEY          - Admin > API Keys > create one > copy its Access Token
//   CHAKRA_PLUGIN_ID        - WhatsApp Setup page > "..." menu > Copy Plugin Id
//   CHAKRA_PHONE_NUMBER_ID  - WhatsApp Setup page > "WhatsApp Phone Numbers"
//                             list > the "Phone Number" column's ID (NOT the
//                             WABA column's ID — those are two different IDs
//                             on the same row and easy to mix up)
//   CHAKRA_API_VERSION      - optional, defaults to v24.0 if not set
const CHAKRA_API_KEY = process.env.CHAKRA_API_KEY;
const CHAKRA_PLUGIN_ID = process.env.CHAKRA_PLUGIN_ID;
const CHAKRA_PHONE_NUMBER_ID = process.env.CHAKRA_PHONE_NUMBER_ID;
const CHAKRA_API_VERSION = process.env.CHAKRA_API_VERSION || 'v24.0';

// ---- REPLAY-TEST DRY RUN ----
// Set only by test/replay.test.js, BEFORE requiring this file — never by
// production config. When on, every real outbound side effect (WhatsApp
// sends, Sheets reads/writes) is captured/stubbed instead of hitting the
// network, so replay tests can safely require() this module even with real
// production credentials sitting in .env. See sendWhatsAppMessage, markAsRead,
// and the `sheets` stub-install below.
const BOT_DRY_RUN = process.env.BOT_DRY_RUN === '1';
const dryRunSent = []; // { to, message } — inspected by replay tests, cleared per-test

function chakraSendUrl() {
  return `https://api.chakrahq.com/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/api/${CHAKRA_API_VERSION}/${CHAKRA_PHONE_NUMBER_ID}/messages`;
}

// Sends ONE WhatsApp message via Chakra's pass-through Messages API (same
// shape as Meta's own Cloud API). `to` must be bare digits with country code
// — no leading '+', no 'whatsapp:' prefix. `message` is a plain string,
// { text, mediaUrl } to send an image (with optional caption),
// { buttons: { body, buttons: [{id,title}] } } for up to 3 reply buttons, or
// { list: { body, buttonLabel, sections } } for a native list message.
// Raw POST to Chakra's messages endpoint — the low-level piece shared by
// sendWhatsAppMessage (actual replies) and markAsRead (read receipt/typing
// indicator) below. Callers keep their own credential checks and response
// handling (one throws on failure, the other just warns) since those
// differ enough not to be worth forcing into one shared shape.
function postToChakra(body, timeoutMs) {
  return withTimeout(fetch(chakraSendUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHAKRA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }), timeoutMs);
}

async function sendWhatsAppMessage(to, message) {
  if (BOT_DRY_RUN) {
    dryRunSent.push({ to, message });
    return { dryRun: true };
  }
  if (!CHAKRA_API_KEY || !CHAKRA_PLUGIN_ID || !CHAKRA_PHONE_NUMBER_ID) {
    console.error('Chakra credentials not fully configured — cannot send message.');
    return;
  }

  let body;
  if (typeof message === 'string') {
    body = { messaging_product: 'whatsapp', to, type: 'text', text: { body: message } };
  } else if (message && message.mediaUrl) {
    body = {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: message.mediaUrl, ...(message.text ? { caption: message.text } : {}) },
    };
  } else if (message && message.buttons) {
    const { body: bodyText, buttons } = message.buttons;
    body = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
      },
    };
  } else if (message && message.list) {
    const { body: bodyText, buttonLabel, sections } = message.list;
    body = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: { button: buttonLabel, sections },
      },
    };
  } else if (message && message.text) {
    body = { messaging_product: 'whatsapp', to, type: 'text', text: { body: message.text } };
  } else {
    return;
  }

  const res = await postToChakra(body, 10000);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Chakra send failed (HTTP ${res.status}): ${errText}`);
  }
  return res.json();
}

// Marks the inbound message as read (blue ticks) and, on API versions that
// support it, shows the in-chat "typing..." indicator for a few seconds —
// makes replies feel like a person is there instead of an instant bot dump.
// Best-effort only: fire-and-forget from the caller, failures are just
// logged since this is cosmetic and must never block or break a reply.
async function markAsRead(messageId) {
  if (BOT_DRY_RUN) return;
  if (!CHAKRA_API_KEY || !CHAKRA_PLUGIN_ID || !CHAKRA_PHONE_NUMBER_ID || !messageId) return;
  try {
    const res = await postToChakra({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    }, 5000);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`Mark-as-read failed for message ${messageId} (HTTP ${res.status}): ${errText}`);
    }
  } catch (err) {
    console.warn(`Mark-as-read failed for message ${messageId}:`, err.message || err);
  }
}

// Acks the inbound webhook IMMEDIATELY (Chakra/Meta will retry if your
// response is slow), then sends the actual reply message(s) as separate,
// asynchronous API calls. Unlike Twilio's TwiML, there is no way to reply
// synchronously within the webhook response — every reply now uses the same
// fire-and-forget pattern the proactive status-update code already used.
// `async` (not fire-and-forget) so the caller's returned promise only
// resolves once every send has actually gone out — withSessionLock's
// per-sender chain relies on that to keep two rapid messages' ACTUAL sends
// in order, not just their session mutations (a plain returned promise from
// an unawaited IIFE used to let the lock release before the sends below
// even started). The HTTP ack above still happens synchronously first, so
// this doesn't slow down the webhook response — Chakra/Meta never wait on
// this loop, only in-process callers (and the replay-test harness) do.
async function sendReply(res, to, textOrMessages) {
  if (process.env.DEBUG_REPLIES) console.log(`REPLY >>> to ${to}:`, JSON.stringify(textOrMessages));
  pushTranscript(to, 'bot', replySummaryText(textOrMessages));
  if (!res.headersSent) res.sendStatus(200); // the webhook is usually already acked earlier — see app.post('/whatsapp')
  const messages = Array.isArray(textOrMessages) ? textOrMessages : [textOrMessages];
  const toSend = messages.filter(Boolean);
  for (const [i, m] of toSend.entries()) {
    // A small stagger before the 2nd+ message in a multi-message reply so a
    // 2-3 message bundle (very common — e.g. [itemNotFound, categoryList])
    // reads like someone sending a quick follow-up thought instead of a
    // simultaneous dump. Skipped in dry-run since it's purely a real-network
    // pacing effect and would just slow down the test suite for no benefit.
    if (i > 0 && !BOT_DRY_RUN) await new Promise(r => setTimeout(r, 400));
    try {
      await sendWhatsAppMessage(to, m);
    } catch (err) {
      console.error(`Failed to send WhatsApp message to ${to}:`, err.message || err);
      // Interactive (buttons/list) messages carry a plain-text `fallback` —
      // if Chakra/Meta rejects the interactive send for any reason, the
      // customer still gets a usable menu instead of silence.
      if (m && typeof m === 'object' && m.fallback) {
        try {
          await sendWhatsAppMessage(to, m.fallback);
        } catch (err2) {
          console.error(`Fallback send also failed for ${to}:`, err2.message || err2);
        }
      }
    }
  }
}

// ---- DELIVERY DRIVER NOTIFICATION ----
// EDIT THIS: add real driver WhatsApp number(s) as bare digits with country
// code, NO '+' and NO 'whatsapp:' prefix (e.g. '5016256563').
// Empty list = nothing gets sent.
const DRIVER_NUMBERS = [
  '5016162492',
];

// Single source of truth for "does this customer have a saved note" — both
// notifyDriver and escalateToHuman need it (in different wording/languages
// for different audiences), so the LOOKUP is shared even though the
// formatting deliberately isn't.
function getCustomerNote(from) {
  const profile = customerProfiles[from];
  return (profile && profile.notes) || null;
}

// Same idea, for the saved-delivery-address offer in the 'mode'/'address'
// steps — both read this exact expression.
function getSavedAddress(from) {
  const profile = customerProfiles[from];
  return (profile && profile.savedAddress) || null;
}

// Broadcasts one message to every number in `numbers`, best-effort (one
// failure doesn't stop the rest). Shared underlying piece for
// notifyAllDrivers (DRIVER_NUMBERS) and notifyOwners (OWNER_NUMBERS) below.
async function broadcastTo(numbers, message) {
  for (const number of numbers) {
    try {
      await sendWhatsAppMessage(number, message);
    } catch (err) {
      console.error(`Broadcast notify failed for ${number}:`, err.message || err);
    }
  }
}

// Shared by notifyDriver, escalateToHuman, and the "cancel order" command's
// driver notification.
function notifyAllDrivers(message) {
  return broadcastTo(DRIVER_NUMBERS, message);
}

// New-order alert to staff — see notifyOwnerOfPickupOrder below (delivery
// orders already get an equivalent alert via notifyDriver/DRIVER_NUMBERS).
function notifyOwners(message) {
  return broadcastTo(OWNER_NUMBERS, message);
}

// ---- ERROR ALERTING ----
// Best-effort "something is broken and nobody's watching" channel — reuses
// the exact WhatsApp path the owner already gets SOLDOUT/order alerts on,
// so there's no new channel to configure. Rate-limited per `tag` (one alert
// per tag per ALERT_COOLDOWN_MS) so a sustained failure — Sheets down for
// an hour, say — sends one ping, not one per request. Callers pick the tag:
// a fixed string for "this whole class of thing is broken" (e.g. 'crash'),
// or a per-order tag (e.g. `sheets-log-${orderNumber}`) when EVERY instance
// matters because each one is a potentially lost order.
// Known limitation, not solved here: if Chakra/WhatsApp itself is the thing
// that's down, this can't get through either — closing that needs an
// external watchdog (e.g. a free uptime monitor hitting GET /), which needs
// a third-party account this code can't create on its own.
const lastAlertSentAt = new Map(); // tag -> timestamp
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;

async function alertOwner(tag, message) {
  console.error(`[ALERT:${tag}] ${message}`); // always logged, regardless of whether the WhatsApp send below succeeds or is on cooldown
  const last = lastAlertSentAt.get(tag);
  if (last !== undefined && Date.now() - last < ALERT_COOLDOWN_MS) return;
  lastAlertSentAt.set(tag, Date.now());
  const text = `🚨 ${message}`;
  // Sent per-number with its own retry (NOT via notifyOwners/broadcastTo,
  // which deliberately swallow per-number failures and never reject — fine
  // for a routine broadcast, but this is the one send where a transient
  // failure is worth one retry rather than silently giving up).
  for (const number of OWNER_NUMBERS) {
    try {
      await sendWhatsAppMessage(number, text);
    } catch (err) {
      console.error(`alertOwner first attempt failed for ${number} (tag "${tag}"):`, err.message || err);
      await new Promise(r => setTimeout(r, 3000));
      try {
        await sendWhatsAppMessage(number, text);
      } catch (err2) {
        console.error(`alertOwner retry also failed for ${number} (tag "${tag}"):`, err2.message || err2);
      }
    }
  }
}

// For the periodic background jobs (refreshMenuFromSheet, pollOrderStatus,
// etc.) — those already fail open (log and keep using stale in-memory data)
// on a SINGLE bad poll, which is the right call for one transient blip. But
// sustained failure (Sheets down for an hour) previously had no signal
// beyond a log line nobody reads. jobFailed()/jobSucceeded() track
// consecutive failures per job name and alert once sustained failure is
// confirmed (3 in a row) rather than on the first blip; a single success
// resets the counter.
const consecutiveJobFailures = new Map(); // job name -> count
const JOB_ALERT_THRESHOLD = 3;

function jobFailed(name, err) {
  const count = (consecutiveJobFailures.get(name) || 0) + 1;
  consecutiveJobFailures.set(name, count);
  if (count >= JOB_ALERT_THRESHOLD) {
    alertOwner(`job-${name}`, `Background job "${name}" has failed ${count} times in a row (still running on stale data): ${err.message || err}`);
  }
}

function jobSucceeded(name) {
  consecutiveJobFailures.delete(name);
}

// Last-resort safety net for anything that slips past the try/catch blocks
// already covering the webhook route and the periodic jobs. Doesn't replace
// those — it's what catches a genuine bug in code THIS session didn't
// anticipate needing a try/catch.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception — process will exit so Railway restarts it:', err);
  // Fire-and-forget with a short grace period rather than awaited: an
  // uncaught exception means something is broken in a way this process
  // shouldn't keep running with, so exiting promptly matters more than
  // guaranteeing the alert lands. alertOwner still gets a moment to try.
  alertOwner('crash', `Bot crashed with an uncaught exception and is restarting: ${err.message || err}`)
    .finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000).unref(); // hard stop if the alert hangs
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('Unhandled promise rejection:', err);
  alertOwner('rejection', `Bot hit an unhandled promise rejection (still running): ${err.message || err}`);
});

// Dash-prefixed "- item x2 - $14.00" cart lines, the staff-facing format
// used in both the delivery driver alert and the pickup owner alert below —
// distinct from cartText's customer-facing numbered-list format.
function staffItemLines(cart) {
  return cart.map(i => {
    const noteStr = i.note ? ` [${i.note}]` : '';
    return `- ${i.name}${noteStr} x${i.qty} - $${(i.price * i.qty).toFixed(2)}`;
  }).join('\n');
}

async function notifyDriver(orderNumber, session, from) {
  if (DRIVER_NUMBERS.length === 0) return;

  const itemLines = staffItemLines(session.cart);
  const total = session.cart.reduce((sum, i) => sum + i.price * i.qty, 0).toFixed(2);

  const divider = '━━━━━━━━━━━━━━';

  const preorderTag = session.isPreorder ? (session.language === 'es' ? '🕐 *PRE-PEDIDO — armar cuando abramos*\n\n' : '🕐 *PRE-ORDER — prep when we open*\n\n') : '';

  const note = getCustomerNote(from);
  const noteTag = note
    ? (session.language === 'es' ? `\n\n⚠️ *Nota del cliente:* ${note}` : `\n\n⚠️ *Customer note:* ${note}`)
    : '';

  const message = preorderTag + (session.language === 'es'
    ? `🏍️ *NUEVA ORDEN DE ENTREGA #${orderNumber}*\n${divider}\n🛍️ *Artículos:*\n${itemLines}\n${divider}\n💵 *Total a cobrar: $${total} BZD*\n\n📍 *Entregar a:*\n${session.address}\n📞 *Teléfono del cliente:* +${from}${noteTag}`
    : `🏍️ *NEW DELIVERY ORDER #${orderNumber}*\n${divider}\n🛍️ *Items:*\n${itemLines}\n${divider}\n💵 *Total to collect: $${total} BZD*\n\n📍 *Deliver to:*\n${session.address}\n📞 *Customer phone:* +${from}${noteTag}`);

  await notifyAllDrivers(message);
}

// Delivery orders already alert staff via notifyDriver (DRIVER_NUMBERS) —
// this closes the gap where a PICKUP order previously triggered no WhatsApp
// notification at all, only a Sheets row, so it was easy for staff to miss
// one if nobody happened to be watching the sheet at that moment. English-
// only, matching the rest of the owner-facing text in this codebase.
async function notifyOwnerOfPickupOrder(orderNumber, session, from) {
  if (OWNER_NUMBERS.length === 0) return;

  const itemLines = staffItemLines(session.cart);
  const total = session.cart.reduce((sum, i) => sum + i.price * i.qty, 0).toFixed(2);
  const divider = '━━━━━━━━━━━━━━';
  const preorderTag = session.isPreorder ? '🕐 *PRE-ORDER — prep when we open*\n\n' : '';
  const note = getCustomerNote(from);
  const noteTag = note ? `\n\n⚠️ *Customer note:* ${note}` : '';

  const message = preorderTag + `📦 *NEW PICKUP ORDER #${orderNumber}*\n${divider}\n🛍️ *Items:*\n${itemLines}\n${divider}\n💵 *Total: $${total} BZD*\n\n📞 *Customer phone:* +${from}${noteTag}`;

  await notifyOwners(message);
}

const sheetsAuth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

// Replay tests never touch the real spreadsheet, even if real credentials
// are sitting in .env — every read comes back empty and every write is a
// silent no-op. This means replay tests exercise the FSM/state-machine
// layer only, not real Sheets integration (that's covered by this project's
// existing live-smoke-test practice instead).
if (BOT_DRY_RUN) {
  sheets.spreadsheets.values.get = async () => ({ data: { values: [] } });
  sheets.spreadsheets.values.update = async () => ({ data: {} });
}

// ---- OWNER COMMANDS ----
// Text these from a number in OWNER_NUMBERS (bare digits, no '+') to
// control the bot without opening the Sheet or redeploying:
//   pause orders          - stop taking new checkouts until "resume orders"
//   resume orders
//   soldout <item name>   - mark an item sold out (partial name OK)
//   instock <item name>   - mark it back in stock (also accepts "available")
//   queue                 - how many orders are open right now, by status
//   stats                 - all-time top items/peak hour + since-restart
//                            funnel counts (language picked, checkout
//                            started, carts abandoned)
// A deliberately separate list from DRIVER_NUMBERS, even though it's the
// same number today — these are different concepts (a driver shouldn't
// necessarily be able to pause the whole shop) and DRIVER_NUMBERS could
// grow a genuinely different number later without silently also granting
// owner powers to whoever that is.
const OWNER_NUMBERS = [
  '5016162492',
];

function isOwner(from) {
  return OWNER_NUMBERS.includes(from);
}

// In-memory only, by design — a deliberate "stop the queue" the owner
// toggles for the rest of THIS process's life (e.g. kitchen slammed),
// distinct from SHOP_HOURS/isShopOpen() (a schedule) or a sold-out item.
// Resets to false on restart/redeploy — the owner should re-check the
// state after a deploy rather than have a pause silently persist forever.
let ordersPaused = false;

// ---- FUNNEL COUNTERS (lightweight, in-memory, since server start) ----
// Deliberately NOT Sheets-backed — logging every step transition to a
// Sheet would mean a write (or more) per customer message, which risks
// hitting Sheets API rate limits and adds latency/cost to the request path
// exactly where this file's existing comments repeatedly warn against
// doing that. These are just tallies, exposed via the owner STATS command;
// "peak hours"/"top items" are computed on demand FROM the Manager sheet
// instead (that data already exists there for every confirmed order — no
// new instrumentation needed for that half). Resets on restart/redeploy.
const funnelCounters = {
  languageSelected: 0,
  checkoutStarted: 0,
  cartAbandoned: 0,
};

// Only these statuses trigger a customer notification. "Confirmed" is
// skipped on purpose — the customer already got that message right when
// they placed the order.
const STATUS_MESSAGES = {
  en: {
    'Preparing': (num) => `👨‍🍳 Update on order #${num}: we're preparing it now!`,
    'Ready for Pickup': (num) => `🎉 Order #${num} is ready for pickup!`,
    'Out for Delivery': (num) => `🏍️ Order #${num} is out for delivery!`,
    'Completed': (num) => `✅ Order #${num} is complete. Thanks for ordering — enjoy!`,
  },
  es: {
    'Preparing': (num) => `👨‍🍳 Actualización de la orden #${num}: ¡la estamos preparando!`,
    'Ready for Pickup': (num) => `🎉 ¡La orden #${num} está lista para recoger!`,
    'Out for Delivery': (num) => `🏍️ ¡La orden #${num} va en camino!`,
    'Completed': (num) => `✅ La orden #${num} está completa. ¡Gracias por tu compra!`,
  },
};

async function logOrderToSheets(orderNumber, session, from) {
  if (!process.env.GOOGLE_SHEETS_ID) return;

  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/Belize',
    dateStyle: 'short',
    timeStyle: 'short',
  });

  const itemsWithPrice = session.cart.map(i => {
    const noteStr = i.note ? ` [${i.note}]` : '';
    return `${i.name}${noteStr} x${i.qty} - $${(i.price * i.qty).toFixed(2)}`;
  }).join('; ');

  const itemsNoPrice = session.cart.map(i => {
    const noteStr = i.note ? ` [${i.note}]` : '';
    return `${i.name}${noteStr} x${i.qty}`;
  }).join('; ');

  const total = session.cart.reduce((sum, i) => sum + i.price * i.qty, 0).toFixed(2);
  const modeText = (session.mode === 'delivery' ? `Delivery - ${session.address}` : 'Pickup') + (session.isPreorder ? ' [PRE-ORDER]' : '');
  // `from` is bare digits (Meta/Chakra format, no '+'). Store it human-readable
  // with a '+' — the leading apostrophe forces Sheets to keep it as text
  // instead of trying to evaluate "+50161234567" as a formula.
  const phoneForSheet = `'+${from || ''}`;

  try {
    // Serialized against every OTHER order's logging call, not just this
    // sender's own messages (withSessionLock's per-sender chain doesn't
    // help here — two DIFFERENT customers confirming near-simultaneously
    // would each read "next row = N" before either had written, and one
    // order's row would silently clobber the other's). Explicitly finding
    // the next empty row (rather than values.append(), which tries to
    // auto-detect the "table" boundaries and can misplace rows when a
    // sheet has mixed row widths combined with dropdown validation further
    // down the column — exactly what caused rows to land at column H
    // instead of A) is what makes this read-then-write racy in the first
    // place, hence the lock.
    await withSessionLock('__sheets_manager_kitchen_write__', async () => {
      const managerRows = await withTimeout(sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: 'Manager!A:A',
      }), 6000);
      const managerNextRow = (managerRows.data.values || []).length + 1;

      await withTimeout(sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: `Manager!A${managerNextRow}:H${managerNextRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[orderNumber, timestamp, itemsWithPrice, total, modeText, session.language, phoneForSheet, 'Confirmed']] },
      }), 6000);

      const kitchenRows = await withTimeout(sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: 'Kitchen!A:A',
      }), 6000);
      const kitchenNextRow = (kitchenRows.data.values || []).length + 1;

      await withTimeout(sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: `Kitchen!A${kitchenNextRow}:D${kitchenNextRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[orderNumber, timestamp, itemsNoPrice, modeText]] },
      }), 6000);

      console.log(`Order #${orderNumber} logged to Sheets ✅ (Manager row ${managerNextRow}, Kitchen row ${kitchenNextRow})`);
    });
    // So the status poller doesn't treat this brand-new "Confirmed" row as a
    // change to notify about the next time it runs. Key MUST match
    // pollOrderStatus's `${orderNumber}|${timestamp}` scheme exactly — same
    // `timestamp` string written into the row above.
    lastKnownStatus.set(`${orderNumber}|${timestamp}`, 'Confirmed');
  } catch (err) {
    console.error('Google Sheets log error:', err);
    // The customer was already told "order confirmed" by the time this
    // runs (see the 'confirm' step — this call is fire-and-forget on
    // purpose so a slow Sheets call never delays that reply). If THIS
    // fails, the order may exist nowhere staff can see it except whatever
    // driver/owner WhatsApp alert fired separately — worth a real alert,
    // not just a log line nobody's watching.
    alertOwner(`sheets-log-${orderNumber}`, `Order #${orderNumber} was confirmed to the customer but FAILED to log to the Manager/Kitchen sheet: ${err.message || err}`);
  }
}

// Strips a Sheets phone cell (e.g. "'+50161234567") down to bare digits for
// comparison — the one normalization every phone-matching/lookup site needs.
function normalizePhoneDigits(cell) {
  return (cell || '').replace(/\D/g, '');
}

// Shared by every owner/customer command that just needs to READ the
// Manager sheet (cancelOrderInSheet's row-finding, QUEUE, STATS, the
// "status" command) — NOT used by pollOrderStatus, which has its own
// first-run-vs-steady-state logic that doesn't fit this shape. Short-lived
// cache (a few seconds) so an owner running "queue" then "stats" back to
// back — or a burst of customers checking "status" at once — doesn't
// re-fetch data that hasn't meaningfully changed; long enough to help the
// common case, short enough that nobody's ever looking at data more than a
// few seconds stale.
const MANAGER_ROWS_CACHE_MS = 5000;
let managerRowsCache = null; // { rows, fetchedAt }

async function fetchManagerRows() {
  if (managerRowsCache && Date.now() - managerRowsCache.fetchedAt < MANAGER_ROWS_CACHE_MS) {
    return managerRowsCache.rows;
  }
  const res = await withTimeout(sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'Manager!A2:H',
  }), 8000);
  const rows = res.data.values || [];
  managerRowsCache = { rows, fetchedAt: Date.now() };
  return rows;
}

// Powers the post-confirmation cancel window (see the "cancel order"
// command). Matches by BOTH order number AND phone — matching by order
// number alone would risk touching the wrong row if a stale duplicate
// order number exists (this exact class of bug already bit
// pollOrderStatus once — see the row-position rewrite above). Returns
// true if a matching row was found and updated, false otherwise.
async function cancelOrderInSheet(orderNumber, from) {
  if (!process.env.GOOGLE_SHEETS_ID) return false;
  // Shares logOrderToSheets' lock: this only updates a status cell on an
  // already-located row rather than appending (so it doesn't have that
  // function's "two writers compute the same next-empty-row" race), but
  // serializing it against order writes anyway removes any doubt about
  // overlapping requests hitting the same Manager sheet at once.
  return withSessionLock('__sheets_manager_kitchen_write__', async () => {
    // Bypasses fetchManagerRows' cache deliberately — this is about to WRITE
    // based on the row it finds, so it needs the freshest possible read,
    // not a value that might be a few seconds stale.
    const res = await withTimeout(sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Manager!A2:H',
    }), 8000);
    const rows = res.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      const [rowOrderNumber, , , , , , phoneCell] = rows[i];
      if (String(rowOrderNumber) === String(orderNumber) && normalizePhoneDigits(phoneCell) === String(from)) {
        const rowNum = i + 2; // range above starts at row 2 (header is row 1)
        await withTimeout(sheets.spreadsheets.values.update({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          range: `Manager!H${rowNum}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [['Cancelled']] },
        }), 6000);
        managerRowsCache = null; // this row just changed — don't let a stale cached copy answer the next QUEUE/STATS/status lookup
        return true;
      }
    }
    return false;
  });
}

// Owner-facing QUEUE command: how many orders are still open (i.e. not yet
// Completed or Cancelled), broken down by status.
async function getQueueSummary() {
  const rows = await fetchManagerRows();
  const counts = {};
  let total = 0;
  for (const row of rows) {
    const orderNumber = row[0];
    if (!orderNumber) continue;
    const status = (row[7] || 'Confirmed').trim();
    if (status === 'Completed' || status === 'Cancelled') continue;
    counts[status] = (counts[status] || 0) + 1;
    total++;
  }
  return { total, counts };
}

// Owner-facing STATS command. Top items and peak hour are computed on
// demand straight from the Manager sheet (that data already exists there
// for every confirmed order — no new write instrumentation needed for it);
// funnel counters are the in-memory tallies from funnelCounters instead,
// since THAT data (language picked but never checked out, etc.) has no
// other home. `itemsWithPrice` cells look like "Vanilla Bean x2 - $14.00;
// Coffee x1 - $7.00" — stripping back to bare item names for the tally.
async function getOrderStats() {
  const rows = await fetchManagerRows();
  const itemCounts = {};
  const hourCounts = {};
  let confirmedCount = 0;

  for (const row of rows) {
    const [orderNumber, timestamp, itemsWithPrice] = row;
    if (!orderNumber) continue;
    confirmedCount++;

    (itemsWithPrice || '').split(';').forEach(segment => {
      // Anchored through to the end of the segment (the trailing
      // "x<qty> - $<total>" logOrderToSheets always writes) rather than
      // stopping at the FIRST "x<digit>" — a customer's free-text note can
      // itself contain something like "x2" (e.g. "[add x2 syrup]"), which a
      // non-anchored match would misread as the real quantity marker and
      // truncate the item name there instead of at the actual one.
      const match = segment.match(/^\s*(.+?)\s*x\d+\s*-\s*\$[\d.]+\s*$/);
      if (!match) return;
      const name = match[1].replace(/\s*\[.*\]\s*$/, '').trim();
      if (name) itemCounts[name] = (itemCounts[name] || 0) + 1;
    });

    // timestamp was written via toLocaleString('en-US', {dateStyle:'short',
    // timeStyle:'short'}) — e.g. "8/26/26, 2:30 PM". Best-effort parse; a
    // row that doesn't match this shape just doesn't count toward hours.
    const hourMatch = (timestamp || '').match(/(\d{1,2}):\d{2}\s*(AM|PM)/i);
    if (hourMatch) {
      let hour = parseInt(hourMatch[1], 10) % 12;
      if (hourMatch[2].toUpperCase() === 'PM') hour += 12;
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    }
  }

  const topItems = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const peakHourEntry = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];

  return { confirmedCount, topItems, peakHour: peakHourEntry ? Number(peakHourEntry[0]) : null };
}

const app = express();
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf; }, // needed for HMAC signature verification below
})); // Meta/Chakra webhooks send JSON, not form-encoded like Twilio did

// ---- WEBHOOK SIGNATURE VERIFICATION ----
// Chakra can sign webhook deliveries with HMAC-SHA256 in an
// X-Chakra-Signature-256 header once you set a secret at
// Admin > Team > Secrets in the Chakra dashboard. Set that same value as
// CHAKRA_WEBHOOK_SECRET below to enforce it.
// NOTE: Chakra's docs describe this for their own "Chakra Events Webhook"
// format — it's unconfirmed whether the header is also attached to the raw
// Meta pass-through webhook this bot uses (see the GET /whatsapp handler
// below). So this verifies the signature WHEN PRESENT and rejects a
// mismatch, but does not require it — that avoids locking out real traffic
// if pass-through mode turns out not to send it. Check your server logs
// after deploying; if you see "signature verified" on real inbound
// messages, it's working and you can tighten this to require it.
const CHAKRA_WEBHOOK_SECRET = process.env.CHAKRA_WEBHOOK_SECRET;

function verifyChakraSignature(req) {
  const signature = req.get('X-Chakra-Signature-256');
  if (!CHAKRA_WEBHOOK_SECRET || !signature || !req.rawBody) return null; // nothing to check against
  const expected = crypto.createHmac('sha256', CHAKRA_WEBHOOK_SECRET).update(req.rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const gotBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== gotBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, gotBuf);
}

// A real WhatsApp sender id is bare digits, no more than ~15 of them (E.164
// max length). Reject anything else before it's ever used as a key below —
// otherwise a forged payload with a fresh random "from" on every request
// would dodge per-sender rate limiting entirely (each new key starts an
// unthrottled fresh bucket) while still growing rateBuckets/sessionLocks/
// sessions without bound.
function isValidSenderId(from) {
  return typeof from === 'string' && /^\d{5,15}$/.test(from);
}

// ---- BASIC RATE LIMITING ----
// Cheap, in-memory, no dependency. The signature check above is best-effort
// (see note), so this is the real backstop against a spammy sender — or a
// burst of forged requests — running up real Gemini/Chakra costs. Not meant
// to handle legitimate high traffic gracefully, just to put a ceiling on
// runaway cost (it's a fixed-window counter, so a sender can burst up to
// ~2x max right at a window boundary — acceptable for a cost ceiling, not
// a precise guarantee). Bump these if this shop ever gets genuinely busy.
const RATE_LIMIT_PER_SENDER = { max: 20, windowMs: 60 * 1000 };
const RATE_LIMIT_GLOBAL = { max: 120, windowMs: 60 * 1000 };
const rateBuckets = new Map(); // key -> { count, windowStart }

function isRateLimited(key, { max, windowMs }) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    rateBuckets.set(key, { count: 1, windowStart: now });
    return false;
  }
  bucket.count++;
  return bucket.count > max;
}

// Sweep stale buckets periodically so this doesn't grow for the life of the
// process — same "just enough housekeeping" pattern as the availability/
// order-status polling below. .unref() so it never keeps the process alive.
setInterval(() => {
  const now = Date.now();
  const staleAfterMs = 5 * 60 * 1000; // well past either window above
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.windowStart > staleAfterMs) rateBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

// ---- KEYED ASYNC LOCK ----
// General-purpose: serializes async calls sharing the same key, in order,
// each waiting for the previous to settle. Originally built for per-sender
// session processing (two near-simultaneous messages from the SAME customer
// can't interleave against the same mutable session object) but reused
// as-is for the Manager/Kitchen/Customers Sheets writes below — those have
// the SAME shape of problem (read-current-row-count-then-write can race
// between two DIFFERENT customers' orders landing on the same row) with a
// fixed key instead of a per-sender one. Different keys are completely
// unaffected by each other. Single-process only: if this ever runs as more
// than one instance, each gets its own lock and the guarantee no longer
// holds across instances.
const sessionLocks = new Map(); // key -> tail promise of the current chain

function withSessionLock(key, fn) {
  const prev = sessionLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  sessionLocks.set(key, tail);
  // Self-clean once this sender goes idle — but only if nothing newer has
  // taken over the slot in the meantime.
  tail.finally(() => {
    if (sessionLocks.get(key) === tail) sessionLocks.delete(key);
  });
  return run;
}

// ---- INBOUND MESSAGE DEDUPLICATION ----
// Meta/Chakra webhooks are at-least-once delivery — if our ack is slow (an
// AI call, voice transcription, or a same-sender queue wait) the provider
// can retry with the IDENTICAL payload. Without this, a retry is processed
// as a brand-new message — e.g. doubling a cart addition, or worse at
// checkout. Every WhatsApp message carries a unique id ("wamid"); track
// ones already handled so a retry becomes a harmless no-op ack instead.
const seenMessageIds = new Map(); // id -> timestamp first seen
const SEEN_ID_TTL_MS = 10 * 60 * 1000; // comfortably longer than any realistic retry window

function isDuplicateMessage(id) {
  if (!id) return false; // nothing to key on — let it through rather than block real traffic
  const now = Date.now();
  if (seenMessageIds.size > 5000) {
    for (const [k, t] of seenMessageIds) {
      if (now - t > SEEN_ID_TTL_MS) seenMessageIds.delete(k);
    }
  }
  const seenAt = seenMessageIds.get(id);
  if (seenAt !== undefined && now - seenAt < SEEN_ID_TTL_MS) return true;
  seenMessageIds.set(id, now);
  return false;
}

// ---- MENU DATA ----
// Lives in menu-data.js so it stays in sync with the availability seed script.
const MENU = require('./menu-data.js');

// ---- SOLD-OUT ITEM TRACKING + SHEET-DRIVEN PRICE OVERRIDES ----
// Availability (and now price) lives in a "Availability" tab in the same
// Google Sheet, keyed by "categoryId.itemIndex" (NOT by name — several items
// share a name across categories, e.g. "Strawberry" appears in 4 different
// sections, so name alone would be ambiguous). Read into memory on a timer,
// never on the request path, so a slow/broken Sheets call can never delay or
// break a WhatsApp reply — same lesson as the order-logging fix.
let soldOutIds = new Set();

function itemKey(categoryId, itemIndex) {
  return `${categoryId}.${itemIndex}`;
}

function isItemSoldOut(categoryId, itemIndex) {
  return soldOutIds.has(itemKey(categoryId, itemIndex));
}

// Best-effort substitute for a sold-out item — the first OTHER non-sold-out
// item in the SAME category, so the customer gets a concrete alternative
// instead of the item just disappearing. Returns null if categoryId is
// unrecognized or everything else in that category is also sold out.
function suggestSubstitute(categoryId, itemIndex) {
  const cat = MENU.find(c => c.id === categoryId);
  if (!cat) return null;
  const alt = cat.items.find((item, i) => i + 1 !== itemIndex && !isItemSoldOut(categoryId, i + 1));
  return alt ? alt.name : null;
}

// categoryId.itemIndex -> item object reference, built once from the static
// menu-data.js structure. Only existing items can be price-overridden this
// way — adding brand-new items isn't sheet-driven (see refreshMenuFromSheet).
const menuItemById = new Map();
MENU.forEach(cat => {
  cat.items.forEach((item, idx) => menuItemById.set(itemKey(cat.id, idx + 1), item));
});

// Ids this process has confirmed present in the Availability sheet as of
// the most recent successful (non-empty) refresh — the baseline
// applyMenuSheetRows compares against to detect "row deleted -> discontinue
// this item". Starts empty so the very first refresh (before any baseline
// exists) never treats every item as newly-missing.
let knownSheetItemKeys = new Set();

// Test-only: lets menu-sheet.test.js start each scenario without residue
// from a previous test's calls (knownSheetItemKeys is exactly the kind of
// hidden state that assumes every real caller always passes the FULL
// current sheet snapshot, which unit tests deliberately don't). No
// production caller ever calls this.
function resetMenuSheetTrackingForTests() {
  knownSheetItemKeys = new Set();
}

// Pure row-parsing logic, pulled out of the Sheets fetch so it can be
// exercised with synthetic rows (no network/write) as well as real ones —
// it never touches `sheets` itself. Mutates price/name directly onto the
// shared MENU item objects (creating or removing them too, for brand-new/
// discontinued items) — every existing read site (cart, checkout, size
// buttons, AI order text, etc.) already reads straight off MENU, so this is
// the only place that needs to know sheet rows exist at all. A missing/
// invalid price cell is skipped and the previous price kept (never let a
// typo'd cell silently become $0 or NaN); once a price IS overridden this
// way, clearing the cell does not revert it — retype the original number.
//
// Row id contract (column A):
//   "categoryId.itemIndex" (e.g. "1.10") — an EXISTING item: update its
//     name/price/availability in place. An id in this shape that ISN'T
//     already known is left alone with a warning, not auto-created — a
//     full id that doesn't match anything is more likely a typo than
//     genuine intent, and guessing wrong here would file it under the
//     wrong item permanently (see the corrections mechanism below for why
//     the itemIndex can't just be trusted as typed).
//   bare "categoryId" (e.g. "1", no dot) — ADD a brand-new item to that
//     category. The itemIndex is deliberately never taken from what the
//     owner typed (an owner-guessed index that doesn't match the item's
//     real position in the category array would silently desync every
//     sold-out/cart lookup for it) — it's computed from the category's
//     actual current length instead, and the row's id gets corrected
//     write-through so the sheet is self-documenting and this same row
//     isn't re-treated as "new" again next cycle. `corrections` (returned
//     alongside `soldOut`) carries those {rowIndex, id} pairs for the
//     caller — which has the network client this function deliberately
//     doesn't — to actually write back.
//   blank/deleted — simply absent from `rows`; see the "removed" pass
//     below, driven by comparing against knownSheetItemKeys.
function applyMenuSheetRows(rows) {
  const soldOut = new Set();
  const seenIds = new Set();
  const corrections = [];

  rows.forEach((row, rowIndex) => {
    const [idCell, , nameCell, availableCell, priceCell, largePriceCell] = row;
    if (!idCell) return;
    const rawId = idCell.trim();
    if (!rawId) return;
    const name = (nameCell || '').trim();

    let key = rawId;
    let item = menuItemById.get(key);

    if (!item && !rawId.includes('.')) {
      // Bare category id — create a new item, see the contract above.
      const cat = MENU.find(c => c.id === rawId);
      if (!cat) {
        console.warn(`Availability sheet: skipping row ${rowIndex + 2} — "${rawId}" isn't a recognized category id.`);
        return;
      }
      if (!name) {
        console.warn(`Availability sheet: skipping new-item row ${rowIndex + 2} in category ${rawId} — no Item name filled in yet.`);
        return;
      }
      const large = parseFloat(largePriceCell);
      const hasSizes = Number.isFinite(large) && large > 0;
      const regular = parseFloat(priceCell) || 0;
      item = hasSizes
        ? { name, sizes: [{ key: '1', label: 'Regular', price: regular }, { key: '2', label: 'Large', price: large }] }
        : { name, price: regular };
      cat.items.push(item);
      key = itemKey(cat.id, cat.items.length);
      menuItemById.set(key, item);
      corrections.push({ rowIndex, id: key });
      console.log(`Availability sheet: created new item "${name}" as ${key}.`);
    } else if (!item) {
      console.warn(`Availability sheet: skipping row ${rowIndex + 2} — id "${rawId}" isn't a known existing item (a genuinely new item's id column should be just the category number, e.g. "1", not "${rawId}").`);
      return;
    } else if (name && name !== item.name) {
      console.log(`Availability sheet: renamed item ${key} from "${item.name}" to "${name}".`);
      item.name = name;
    }

    seenIds.add(key);

    const rawAvail = String(availableCell || '').trim().toLowerCase();
    if (['false', 'no', '0', 'out', 'sold out'].includes(rawAvail)) soldOut.add(key);

    if (item.sizes) {
      const regular = parseFloat(priceCell);
      if (Number.isFinite(regular) && regular > 0) item.sizes[0].price = regular;
      const large = parseFloat(largePriceCell);
      if (Number.isFinite(large) && large > 0) item.sizes[item.sizes.length - 1].price = large;
    } else {
      const price = parseFloat(priceCell);
      if (Number.isFinite(price) && price > 0) item.price = price;
    }
  });

  // Discontinue: an id previously confirmed present that's missing from
  // THIS successful read is treated as "its row got deleted — remove the
  // item." Guarded against a bad/partial read wiping the whole menu: if
  // more than 30% of previously-known items vanish at once, that smells
  // like something wrong with the READ, not a genuine bulk discontinue —
  // skip removal entirely this cycle (keep everything, stale-but-safe) and
  // alert the owner instead of silently emptying the menu.
  if (knownSheetItemKeys.size > 0) {
    const missing = [...knownSheetItemKeys].filter(k => !seenIds.has(k));
    if (missing.length > knownSheetItemKeys.size * 0.3) {
      console.error(`Availability sheet refresh: ${missing.length}/${knownSheetItemKeys.size} previously-known items missing at once — skipping item removal this cycle (suspected bad/partial read).`);
      alertOwner('menu-sheet-mass-removal', `The Availability sheet refresh saw ${missing.length} of ${knownSheetItemKeys.size} known menu items disappear at once — that looked like a bad read rather than a real bulk discontinue, so no items were removed this cycle. If you really did delete that many rows on purpose, this will resolve itself next refresh — ignore this message.`);
    } else {
      for (const key of missing) {
        const item = menuItemById.get(key);
        if (!item) continue;
        const cat = MENU.find(c => c.id === key.split('.')[0]);
        const idx = cat && cat.items.indexOf(item);
        if (cat && idx !== -1) cat.items.splice(idx, 1);
        menuItemById.delete(key);
        console.log(`Availability sheet: removed item ${key} ("${item.name}") — its row is gone from the sheet.`);
      }
    }
  }
  knownSheetItemKeys = seenIds;

  return { soldOut, corrections };
}

// Case-insensitive substring match across all categories, for the owner-
// facing SOLDOUT/INSTOCK <item> chat commands (see isOwner() below) — lets
// staff toggle availability by texting a name instead of opening the
// Availability sheet. Returns the FIRST match; ambiguous partial names
// (e.g. "strawberry", which exists in 4 categories) resolve to whichever
// category is listed first in menu-data.js — acceptable for a quick chat
// command where the owner can immediately see if it picked the wrong one.
function findMenuItemByName(query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  for (const cat of MENU) {
    const idx = cat.items.findIndex(item => item.name.toLowerCase().includes(q));
    if (idx >= 0) return { categoryId: cat.id, itemIndex: idx + 1, item: cat.items[idx] };
  }
  return null;
}

// Toggles availability both in-memory (immediate effect on the very next
// customer message) and in the Availability sheet (so it survives the next
// 2-minute refreshMenuFromSheet cycle instead of being overwritten back).
// Fails open on the sheet-write half — an owner command should still work
// in-memory for this process's lifetime even if the write-through fails,
// same "never let Sheets flakiness break the live path" principle as
// everywhere else in this file.
async function setItemAvailability(categoryId, itemIndex, available) {
  const key = itemKey(categoryId, itemIndex);
  if (available) soldOutIds.delete(key); else soldOutIds.add(key);

  if (!process.env.GOOGLE_SHEETS_ID) return;
  try {
    await withSessionLock('__sheets_availability_write__', async () => {
      const res = await withTimeout(sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: 'Availability!A2:A',
      }), 8000);
      const rows = res.data.values || [];
      const rowIndex = rows.findIndex(r => (r[0] || '').trim() === key);
      if (rowIndex < 0) return; // item not in the Availability sheet (never seeded) — in-memory toggle still applies
      const rowNum = rowIndex + 2;
      await withTimeout(sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: `Availability!D${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[available]] },
      }), 6000);
    });
  } catch (err) {
    console.error(`Availability sheet write-through failed for ${key} (in-memory toggle still applied):`, err.message || err);
  }
}

async function refreshMenuFromSheet() {
  if (!process.env.GOOGLE_SHEETS_ID) return;
  try {
    const res = await withTimeout(sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Availability!A2:F',
    }), 8000);

    // Only reassigned on a successful fetch — if the call above throws, we
    // never reach here, so both sold-out state AND prices fail open
    // (keep whatever was already in memory) rather than resetting to blank.
    const { soldOut, corrections } = applyMenuSheetRows(res.data.values || []);
    soldOutIds = soldOut;
    jobSucceeded('refreshMenuFromSheet');

    // Write back the real "categoryId.itemIndex" id for any row that was
    // just created from a bare category-id row (see applyMenuSheetRows'
    // contract comment) — best-effort/fire-and-forget, same as every other
    // sheet write-through in this file: a customer-facing reply must never
    // wait on it. If this write keeps failing, the row's id column still
    // reads the bare category id next cycle too, which would create a
    // second duplicate item — logged loudly so a sustained failure here is
    // visible rather than silently duplicating menu items.
    for (const { rowIndex, id } of corrections) {
      const rowNumber = rowIndex + 2; // rows[] is 0-based from range A2:F — sheet row 2 is rows[0]
      withTimeout(sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: `Availability!A${rowNumber}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[id]] },
      }), 6000).catch(err => {
        console.error(`Availability sheet: failed to write back corrected id "${id}" to row ${rowNumber} — this row will be treated as a new item again next refresh:`, err.message || err);
      });
    }
  } catch (err) {
    console.error('Menu sheet refresh failed (keeping previous prices/availability):', err.message || err);
    jobFailed('refreshMenuFromSheet', err);
  }
}

// ---- CUSTOMER PROFILES (saved address, allergy/preference notes) ----
// Backed by a "Customers" tab (Phone, SavedAddress, Notes, UpdatedAt) so
// this survives restarts/redeploys — unlike `sessions`, which is meant to
// reset. Run `node seed-customers.js` once to create the tab if it doesn't
// exist yet; reads/writes here fail open (log and continue) if it's missing
// so a customer's order is never blocked on this being set up.
let customerProfiles = {};

async function refreshCustomerProfiles() {
  if (!process.env.GOOGLE_SHEETS_ID) return;
  try {
    const res = await withTimeout(sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Customers!A2:D',
    }), 8000);
    const rows = res.data.values || [];
    const next = {};
    for (const row of rows) {
      const [phoneCell, savedAddress, notes, updatedAt] = row;
      const phone = normalizePhoneDigits(phoneCell);
      if (!phone) continue;
      next[phone] = { savedAddress: savedAddress || '', notes: notes || '', updatedAt: updatedAt || '' };
    }
    customerProfiles = next;
    jobSucceeded('refreshCustomerProfiles');
  } catch (err) {
    // Fail open — most likely the Customers tab hasn't been created yet
    // (run seed-customers.js), or a transient Sheets error either way.
    console.error('Customer profile refresh failed (keeping previous profiles):', err.message || err);
    jobFailed('refreshCustomerProfiles', err);
  }
}

// Optimistic: updates the in-memory cache immediately (so the very next
// message in this same conversation sees it), then writes through to the
// sheet in the background. `fields` is a partial { savedAddress, notes }.
async function saveCustomerProfile(from, fields) {
  const merged = { ...(customerProfiles[from] || {}), ...fields, updatedAt: new Date().toISOString() };
  customerProfiles[from] = merged;

  if (!process.env.GOOGLE_SHEETS_ID) return;
  // Same cross-customer read-then-write race as logOrderToSheets — two
  // different customers saving a profile at once could otherwise both read
  // "row not found, append at N" and collide. Own lock key since this
  // writes to a different sheet and has no reason to queue behind orders.
  await withSessionLock('__sheets_customers_write__', async () => {
    const res = await withTimeout(sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Customers!A2:D',
    }), 8000);
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => normalizePhoneDigits(r[0]) === String(from));
    const rowValues = [`'+${from}`, merged.savedAddress || '', merged.notes || '', merged.updatedAt];
    const rowNum = rowIndex >= 0 ? rowIndex + 2 : rows.length + 2; // +2: range starts at row 2 (header is row 1)
    await withTimeout(sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `Customers!A${rowNum}:D${rowNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowValues] },
    }), 6000);
  });
}

// ---- ORDER STATUS POLLING (proactive WhatsApp updates) ----
// orderNumber (string) -> last status we've seen for that order. Runs on a
// timer, completely off the request path — same reasoning as availability
// above. On the very first poll after server start, we only build this map
// silently (no notifications) so a restart doesn't re-blast every recent
// order's current status to its customer.
let lastKnownStatus = new Map();
let statusPollingInitialized = false;

// Sends the customer their status update and records it, so whichever path
// notices a status change first wins and the other won't repeat it.
//
// Two callers: pollOrderStatus (which catches manual Manager-sheet edits on
// its 60s cycle) and the /kitchen dashboard (which calls this the instant
// staff tap a button). The dashboard MUST call this rather than leaving it
// to the poller: staff routinely move an order Preparing -> Out for
// Delivery -> Completed inside a single 60s window, and the poller only ever
// sees whatever the status happens to be when it next looks. Every
// intermediate status in between was silently dropped — verified in
// production, where real "Out for Delivery" messages for orders #5780 and
// #7586 were never sent because Completed was tapped before the next poll.
//
// Marking the status BEFORE awaiting the send is deliberate: it means a slow
// or failed send can't let a concurrent poll fire the same message twice.
async function notifyStatusChange({ orderNumber, timestamp, status, language, phoneCell }) {
  const key = `${orderNumber}|${timestamp}`;
  if (lastKnownStatus.get(key) === status) return false;
  lastKnownStatus.set(key, status); // record even when we don't message

  const lang = language === 'es' ? 'es' : 'en';
  const buildMessage = STATUS_MESSAGES[lang][status];
  const phone = String(phoneCell || '').replace(/^\+/, ''); // Chakra/Meta wants bare digits

  if (!buildMessage) {
    // Status text doesn't exactly match one of STATUS_MESSAGES's keys
    // (case-sensitive) — likely a typo in the sheet's status column, or
    // it's free-text rather than a locked dropdown. Worth knowing about
    // even though there's nothing to send: the customer silently never
    // gets notified otherwise, with no other signal that anything's off.
    console.warn(`Order #${orderNumber}: status changed to "${status}" but no message template matches it (check for a typo/case mismatch in the Manager sheet) — customer not notified.`);
    return false;
  }
  if (!phone) return false; // no phone on file for this order — expected for older rows

  try {
    await sendWhatsAppMessage(phone, buildMessage(orderNumber));
    console.log(`Status update sent for order #${orderNumber}: ${status}`);
    return true;
  } catch (sendErr) {
    console.error(`Failed to send status update for order #${orderNumber}:`, sendErr.message || sendErr);
    return false;
  }
}

async function pollOrderStatus() {
  if (!process.env.GOOGLE_SHEETS_ID || !CHAKRA_API_KEY) return;
  try {
    const res = await withTimeout(sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Manager!A2:H',
    }), 8000);
    const rows = res.data.values || [];
    jobSucceeded('pollOrderStatus');

    if (!statusPollingInitialized) {
      rows.forEach(row => {
        const [orderNumber, timestamp, , , , , , status] = row;
        if (orderNumber) lastKnownStatus.set(`${orderNumber}|${timestamp}`, status || 'Confirmed');
      });
      statusPollingInitialized = true;
      return;
    }

    for (const row of rows) {
      const [orderNumber, timestamp, , , , language, phoneCell, statusCell] = row;
      if (!orderNumber) continue;
      const status = (statusCell || 'Confirmed').trim();
      // Keyed by order number + timestamp together, not order number alone
      // and not row position either. Order-number-alone was the original
      // bug: two rows sharing the same order number (a stale duplicate, or
      // a random 4-digit collision) got compared against each other's
      // status and flip-flopped forever. Row-position was an earlier fix
      // for that, but it's fragile to staff manually reordering/deleting
      // rows in the sheet — every row below the edit point shifts to a
      // DIFFERENT order's row index, so a live order's tracked status
      // silently swaps to a stranger's. Timestamp doesn't change when rows
      // are reordered, so this key is stable across edits AND still unique
      // enough to keep genuine duplicate order numbers from colliding
      // (they're vanishingly unlikely to share the exact same timestamp
      // too). Must match the pre-seed logOrderToSheets writes right after
      // creating a new order — see the comment there.
      const key = `${orderNumber}|${timestamp}`;
      if (lastKnownStatus.get(key) === status) continue;
      await notifyStatusChange({ orderNumber, timestamp, status, language, phoneCell });
    }
  } catch (err) {
    console.error('Order status poll failed:', err.message || err);
    jobFailed('pollOrderStatus', err);
  }
}

const MAX_QTY = 50;
// Caps the number of DISTINCT cart lines, not quantity per line (MAX_QTY
// above already caps that). Generous enough for any genuine order this
// shop's menu could produce, tight enough to stop a joke cart from growing
// into dozens of different items. Bumping the quantity of an item ALREADY
// in the cart never counts against this — only adding a genuinely NEW line
// does (see addToCart).
const MAX_CART_LINES = 20;
// Generous enough for a real address plus landmark directions (common in
// Belize where formal street addressing is sparse) — see where it's used
// in the 'address' step for why this needs a cap at all.
const MAX_ADDRESS_LENGTH = 300;

// ---- SHOP FACTS ----
// EDIT THESE FOUR VALUES to your shop's real numbers before going live.
const SHOP_INFO = {
  hoursEn: 'open 24/7',
  hoursEs: 'abierto 24/7',
  deliveryFee: 5,           // <-- EDIT: real delivery fee in $BZD
  minDeliveryOrder:  5 ,    // <-- EDIT: real minimum order for delivery in $BZD
  deliveryAreasEn: 'Belize City limits',   // <-- EDIT: real delivery area
  deliveryAreasEs: 'Belize City limits',
  deliveryTimeEn: '30-45 minutes',
  deliveryTimeEs: '30-45 minutos',
  paymentEn: 'Cash only for now, including cash on delivery.',
  paymentEs: 'Por ahora solo efectivo, incluso contra entrega.',
  phone: '+501 606-9511',
};

// ---- STRUCTURED HOURS (for the open/closed check) ----
// IMPORTANT: keep this in sync with hoursEn/hoursEs above — those are just the
// display text, this is what the code actually checks against.
// openDays uses 0=Sunday, 1=Monday, ... 6=Saturday. openHour/closeHour are in
// 24-hour time, e.g. 9 = 9am, 18 = 6pm.
const SHOP_HOURS = {
  timezone: 'America/Belize',
  openDays: [0, 1, 2, 3, 4, 5, 6], // open every day
  openHour: 0,
  closeHour: 24,
};

const WEEKDAY_NAMES_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_NAMES_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function getShopTimeParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_HOURS.timezone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[parts.find(p => p.type === 'weekday').value];
  let hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  if (hour === 24) hour = 0; // some environments report midnight as 24
  return { weekday, hour };
}

function isShopOpen() {
  const { weekday, hour } = getShopTimeParts();
  if (!SHOP_HOURS.openDays.includes(weekday)) return false;
  return hour >= SHOP_HOURS.openHour && hour < SHOP_HOURS.closeHour;
}

function formatHour12(hour) {
  const period = hour >= 12 ? 'PM' : 'AM';
  let h = hour % 12;
  if (h === 0) h = 12;
  return `${h}:00 ${period}`;
}

// Human-readable "when do we reopen" string, e.g. "today at 9:00 AM",
// "tomorrow at 9:00 AM", or "Monday at 9:00 AM".
function nextOpeningText(lang) {
  const { weekday, hour } = getShopTimeParts();

  if (SHOP_HOURS.openDays.includes(weekday) && hour < SHOP_HOURS.openHour) {
    return lang === 'es'
      ? `hoy a las ${formatHour12(SHOP_HOURS.openHour)}`
      : `today at ${formatHour12(SHOP_HOURS.openHour)}`;
  }

  for (let offset = 1; offset <= 7; offset++) {
    const d = (weekday + offset) % 7;
    if (SHOP_HOURS.openDays.includes(d)) {
      const label = offset === 1
        ? (lang === 'es' ? 'mañana' : 'tomorrow')
        : (lang === 'es' ? WEEKDAY_NAMES_ES[d] : WEEKDAY_NAMES_EN[d]);
      return lang === 'es'
        ? `${label} a las ${formatHour12(SHOP_HOURS.openHour)}`
        : `${label} at ${formatHour12(SHOP_HOURS.openHour)}`;
    }
  }
  return '';
}

// ---- LANGUAGE TEXT ----
const TXT = {
  en: {
    // Shown right after language selection, before a first-time customer has
    // seen the menu — deliberately shorter than howToOrder() below (which
    // adds the full command glossary). A stranger's first message shouldn't
    // be a reference manual; the full list is one *help* away.
    howToOrderShort: () => `🍧 *Créme De La Créme* 🍧

Ordering is easy! 🎉

1️⃣ Tap *View Menu* below 👇
2️⃣ Tap what you want
3️⃣ Tap *Done* ✅ when you're ready

Prefer to type, or send a voice note 🎙️? That works too — just tell us what you want!

🏍️ We deliver in ${SHOP_INFO.deliveryAreasEn} (${SHOP_INFO.deliveryTimeEn}) — or pick up in-store 📦

Need help? Type *help* anytime.`,
    howToOrder: () => `🍧 *Créme De La Créme* 🍧

*How to order:*
1️⃣ Reply with a category number to browse
2️⃣ Type it out, or send a voice note 🎙️ — e.g. "2 hot dogs, no onion, and a large mango smoothie, extra ice." Speaking clearly helps us catch every detail!
3️⃣ Ask us anything — hours, delivery, payment methods
4️⃣ You can add more items any time, even mid-order — nothing locks in until you confirm ✅

🏍️ Delivery available in ${SHOP_INFO.deliveryAreasEn} (${SHOP_INFO.deliveryTimeEn}) — or pick up in-store 📦

*cart* = view your order
*repeat* = reorder your last order
*done* = checkout
*back* = go back a step
*cancel* = cancel your order
*cancel order* = cancel a just-placed order (within 3 min)
*note <text>* = save an allergy/preference note for next time
*status* = check your last order's status
*agent* = talk to a real person
*help* = show these instructions again
*lang* = change language`,
    menuButtonPrompt: 'Tap below whenever you\'re ready to see the menu 👇',
    menuButtonTitle: 'View Menu 📋',
    mainMenu: (menuList) => `🍧 *Créme De La Créme* 🍧\nReply with a number, or type your order:\n\n${menuList}\n\n*cart* = view order   *done* = checkout   *help* = instructions`,
    cartEmpty: 'Your cart is empty.',
    cartHeader: '🛒 *Your order:*',
    cartTotal: (t) => `*Total: $${t}*`,
    backHint: '\n0. Back to menu',
    bulkHint: '\n\n💡 Tip for big orders: type itemNumber x quantity, e.g. *3x12*. (Bulk shortcut uses Regular size, no customization notes.)',
    itemNotFound: "I don't see that number on the menu — mind trying again?",
    qtyRange: (max) => `Just need a number between 1 and ${max} there.`,
    added: (lines, total) => `Added ✅\n${lines}\nCart total: $${total}`,
    askQty: (name, price, max) => `${name} - $${price}\nHow many would you like? (1-${max}, or 0 to go back)`,
    invalidQty: (max) => `That doesn't look like a valid quantity — try a number between 1 and ${max}.`,
    askSize: (name, sizes) => `${name} — choose a size:\n${sizes.map(s => `${s.key}. ${s.label} - $${s.price.toFixed(2)}`).join('\n')}\n\n0. Back`,
    invalidSize: 'Can you double check that size number and try again?',
    askNotes: 'Any special requests for this item? (extra ice, no onions, etc.) Type *none* if not.',
    noneButtonTitle: 'None ✅',
    helpButtonTitle: 'How to order 💡',
    cartEmptyCheckout: "Cart's empty — pick something first!",
    cartFull: `Your cart's got a LOT going on already (${MAX_CART_LINES} different items!) — let's get this order checked out before adding more. Type *done* whenever you're ready!`,
    askMode: (fee) => `Pickup 📦 or delivery 🏍️? (Delivery is $${fee} BZD)`,
    pickupConfirm: '📦 Pickup order. Confirm? (yes/no)',
    askAddress: (fee) => `🏍️ What's the delivery address 📍 and a contact number?\n(Delivery fee: $${fee} BZD)`,
    deliveryConfirm: (addr) => `🏍️ Delivery to: ${addr}\n\nConfirm order? (yes/no)`,
    askModeInvalid: 'Pickup or delivery — which one?',
    orderConfirmed: (num, phone) => `🎉 Order #${num} confirmed! Thank you!\n\nWe'll be in touch shortly.\n\n📞 Need anything else? Call us at ${phone}.`,
    orderConfirmedPreorder: (num, phone, nextOpen) => `🎉 Pre-order #${num} received! Thank you!\n\nWe're closed right now, but we'll start on it right when we open ${nextOpen}.\n\n📞 Need anything else? Call us at ${phone}.`,
    orderCancelled: "No problem — order cancelled. Type *menu* if you'd like to start a new one.",
    confirmInvalid: 'Yes to confirm, or no to cancel?',
    notUnderstood: "Sorry, I didn't quite catch that — try a menu number, or type *help* for instructions.",
    humanHelp: (phone) => `📞 Need to talk to someone? Call us at ${phone}.`,
    askConfirmNudge: "🧾 Want to add anything else? Type *menu* to see other categories, or *done* whenever you're ready to checkout!",
    doneButtonTitle: 'Done ✅',
    closedBanner: (hours, nextOpen) => `😴 *We're closed right now.*\nHours: ${hours}\nWe'll be back open ${nextOpen}.\n\n✅ You can still place a pre-order — we'll get started on it right when we open!\n\n`,
    soldOutItem: (name, substitute) => `😔 Sorry, ${name} is sold out right now.${substitute ? ` How about ${substitute} instead? 😋` : ''}`,
    noPreviousOrder: "You don't have a previous order to repeat yet — let's start one! 😊",
    idleStillThere: "👋 Still with me? Your cart's saved whenever you're ready to continue.",
    idleConfirmPrompt: "🧾 Ready to place this order? Reply *YES* to confirm.",
    idleHold: "⏳ Still holding your order — I'll keep your cart saved for about 20 more minutes.",
    idleExpired: "🕐 Didn't want to keep bugging you, so I saved your cart! Want to continue where you left off? Reply *YES* to resume, or type *MENU* to start fresh.",
    resumeOffer: "👋 Want to continue your earlier order? Reply *YES* to resume, or type *MENU* to start fresh.",
    resumeRestored: (cart) => `✅ Welcome back! Your cart is restored:\n\n${cart}`,
    agentRequested: (phone) => `📞 Got it — connecting you with our team, someone will reach out shortly. You can also call us directly at ${phone}.`,
    statusReply: (num, status) => `📦 Order #${num}: *${status}*`,
    statusUnavailable: (phone) => `Sorry, I couldn't look up your order status right now — please call us at ${phone}.`,
    stopGuessing: "🤔 Let's try this a different way — tap an option below, or type *agent* to talk to a real person.",
    frustrationSoften: "😊 Sorry for the back-and-forth — let's get this sorted out for you.",
    frustrationShortcut: "Want me to just have our team give you a call instead? Type *agent* anytime.",
    cancelWindowClosed: (phone) => `Sorry, that 3-minute window to cancel your order has closed — please call us at ${phone} if you need changes.`,
    orderCancelledConfirmed: (num) => `❌ Order #${num} has been cancelled. Type *menu* if you'd like to place a new one.`,
    cancelOrderNotFound: (phone) => `Sorry, I couldn't find that order to cancel — please call us at ${phone}.`,
    savedAddressOffer: (addr) => `📍 Use your saved address?\n${addr}`,
    savedAddressUseIt: 'Use saved address',
    savedAddressNew: 'Enter new address',
    noteSaved: "Got it — I've saved that note for next time. 📝",
    reorderUsualPrompt: 'Reorder your usual? 🔁',
    abandonedCartRecovery: () => `👋 Still thinking it over? Your cart's still saved — just say *YES* whenever you're ready and we'll pick up right where you left off!`,
    ordersPausedMsg: "😔 We're not able to take new orders for the next little while — your cart's saved, just type *done* again in a bit to check out.",
    duplicateOrderWarning: (num) => `⚠️ Heads up — you just placed order #${num} a couple minutes ago. Sure you want to place *another* order? Reply *yes* again to confirm.`,
  },
  es: {
    // Ver la nota en howToOrderShort (inglés) más arriba — misma idea, versión
    // corta para el primer contacto, la lista completa de comandos vive en *help*.
    howToOrderShort: () => `🍧 *Créme De La Créme* 🍧

¡Ordenar es fácil! 🎉

1️⃣ Toca *Ver Menú* abajo 👇
2️⃣ Toca lo que quieras
3️⃣ Toca *Listo* ✅ cuando estés listo

¿Prefieres escribir, o enviar una nota de voz 🎙️? ¡Eso también funciona — solo dinos qué quieres!

🏍️ Entregamos en ${SHOP_INFO.deliveryAreasEs} (${SHOP_INFO.deliveryTimeEs}) — o recoge en tienda 📦

¿Necesitas ayuda? Escribe *ayuda* cuando quieras.`,
    howToOrder: () => `🍧 *Créme De La Créme* 🍧

*Cómo ordenar:*
1️⃣ Responde con el número de una categoría para explorar
2️⃣ Escríbelo, o envía una nota de voz 🎙️ — ej. "2 hot dogs, sin cebolla, y un smoothie grande de mango, con hielo extra." ¡Hablar claro nos ayuda a captar cada detalle!
3️⃣ Pregúntanos lo que sea — horario, entregas, formas de pago
4️⃣ Puedes añadir más artículos en cualquier momento, incluso a mitad de la orden — nada queda fijo hasta que confirmes ✅

🏍️ Entrega disponible en ${SHOP_INFO.deliveryAreasEs} (${SHOP_INFO.deliveryTimeEs}) — o recoge en tienda 📦

*carrito* = ver tu orden
*repetir* = repetir tu última orden
*listo* = finalizar
*atrás* = volver un paso
*cancelar* = cancelar tu orden
*cancelar orden* = cancelar una orden recién hecha (hasta 3 min)
*nota <texto>* = guardar una nota de alergia/preferencia para la próxima vez
*estado* = ver el estado de tu última orden
*agente* = hablar con una persona real
*ayuda* = ver estas instrucciones otra vez
*idioma* = cambiar idioma`,
    menuButtonPrompt: 'Toca abajo cuando quieras ver el menú 👇',
    menuButtonTitle: 'Ver Menú 📋',
    mainMenu: (menuList) => `🍧 *Créme De La Créme* 🍧\nResponde con un número, o escribe tu orden:\n\n${menuList}\n\n*carrito* = ver orden   *listo* = finalizar   *ayuda* = instrucciones`,
    cartEmpty: 'Tu carrito está vacío.',
    cartHeader: '🛒 *Tu orden:*',
    cartTotal: (t) => `*Total: $${t}*`,
    backHint: '\n0. Volver al menú',
    bulkHint: '\n\n💡 Tip para órdenes grandes: escribe número x cantidad, ej. *3x12*. (El atajo usa tamaño Regular, sin notas de personalización.)',
    itemNotFound: 'Ese número no está en el menú — ¿lo intentas de nuevo?',
    qtyRange: (max) => `Necesito un número entre 1 y ${max} para eso.`,
    added: (lines, total) => `Añadido ✅\n${lines}\nTotal del carrito: $${total}`,
    askQty: (name, price, max) => `${name} - $${price}\n¿Cuántos quieres? (1-${max}, o 0 para volver)`,
    invalidQty: (max) => `Esa cantidad no es válida — intenta un número entre 1 y ${max}.`,
    askSize: (name, sizes) => `${name} — elige un tamaño:\n${sizes.map(s => `${s.key}. ${s.label} - $${s.price.toFixed(2)}`).join('\n')}\n\n0. Volver`,
    invalidSize: '¿Puedes revisar el número de tamaño e intentar de nuevo?',
    askNotes: '¿Alguna petición especial para este artículo? (extra hielo, sin cebolla, etc.) Escribe *ninguno* si no.',
    noneButtonTitle: 'Ninguna ✅',
    helpButtonTitle: 'Cómo ordenar 💡',
    cartEmptyCheckout: '¡Carrito vacío, elige algo primero!',
    cartFull: `Tu carrito ya tiene bastante (¡${MAX_CART_LINES} artículos distintos!) — finalicemos esta orden antes de añadir más. ¡Escribe *listo* cuando estés listo!`,
    askMode: (fee) => `¿Recoger 📦 o entrega 🏍️? (La entrega cuesta $${fee} BZD)`,
    pickupConfirm: '📦 Orden para recoger. ¿Confirmas? (si/no)',
    askAddress: (fee) => `🏍️ ¿Cuál es la dirección de entrega 📍 y un número de contacto?\n(Costo de entrega: $${fee} BZD)`,
    deliveryConfirm: (addr) => `🏍️ Entrega a: ${addr}\n\n¿Confirmas la orden? (si/no)`,
    askModeInvalid: '¿Recoger o entrega — cuál prefieres?',
    orderConfirmed: (num, phone) => `🎉 ¡Orden #${num} confirmada! ¡Gracias!\n\nNos pondremos en contacto pronto.\n\n📞 ¿Necesitas algo más? Llámanos al ${phone}.`,
    orderConfirmedPreorder: (num, phone, nextOpen) => `🎉 ¡Pre-pedido #${num} recibido! ¡Gracias!\n\nEstamos cerrados ahora, pero empezaremos apenas abramos ${nextOpen}.\n\n📞 ¿Necesitas algo más? Llámanos al ${phone}.`,
    orderCancelled: 'Sin problema — orden cancelada. Escribe *menú* si quieres empezar una nueva.',
    confirmInvalid: '¿Sí para confirmar, o no para cancelar?',
    notUnderstood: 'No entendí eso — intenta un número del menú, o escribe *ayuda* para instrucciones.',
    humanHelp: (phone) => `📞 ¿Necesitas hablar con alguien? Llámanos al ${phone}.`,
    askConfirmNudge: "🧾 ¿Quieres añadir algo más? Escribe *menú* para ver otras categorías, o *listo* cuando estés listo para finalizar!",
    doneButtonTitle: 'Listo ✅',
    closedBanner: (hours, nextOpen) => `😴 *Estamos cerrados en este momento.*\nHorario: ${hours}\nAbrimos de nuevo ${nextOpen}.\n\n✅ Aún puedes hacer un pre-pedido — ¡empezaremos apenas abramos!\n\n`,
    soldOutItem: (name, substitute) => `😔 Lo sentimos, ${name} está agotado en este momento.${substitute ? ` ¿Qué tal ${substitute} en su lugar? 😋` : ''}`,
    noPreviousOrder: 'Aún no tienes una orden anterior para repetir — ¡empecemos una! 😊',
    idleStillThere: '👋 ¿Sigues ahí? Tu carrito está guardado para cuando quieras continuar.',
    idleConfirmPrompt: '🧾 ¿Listo para confirmar esta orden? Responde *SI* para confirmar.',
    idleHold: '⏳ Todavía tenemos tu orden guardada — la mantendremos unos 20 minutos más.',
    idleExpired: '🕐 No queríamos seguir molestándote, ¡así que guardamos tu carrito! ¿Quieres continuar donde lo dejaste? Responde *SI* para continuar, o escribe *MENÚ* para empezar de nuevo.',
    resumeOffer: '👋 ¿Quieres continuar tu orden anterior? Responde *SI* para continuar, o escribe *MENÚ* para empezar de nuevo.',
    resumeRestored: (cart) => `✅ ¡Bienvenido de nuevo! Tu carrito fue restaurado:\n\n${cart}`,
    agentRequested: (phone) => `📞 Listo — te estamos conectando con nuestro equipo, alguien se comunicará pronto. También puedes llamarnos directamente al ${phone}.`,
    statusReply: (num, status) => `📦 Orden #${num}: *${status}*`,
    statusUnavailable: (phone) => `Lo sentimos, no pudimos consultar el estado de tu orden ahora — por favor llámanos al ${phone}.`,
    stopGuessing: '🤔 Intentemos de otra forma — toca una opción abajo, o escribe *agente* para hablar con una persona real.',
    frustrationSoften: '😊 Disculpa el ir y venir — vamos a resolver esto.',
    frustrationShortcut: '¿Quieres que nuestro equipo te llame en vez de esto? Escribe *agente* cuando quieras.',
    cancelWindowClosed: (phone) => `Lo sentimos, la ventana de 3 minutos para cancelar tu orden ya cerró — llámanos al ${phone} si necesitas hacer cambios.`,
    orderCancelledConfirmed: (num) => `❌ La orden #${num} fue cancelada. Escribe *menú* si quieres hacer una nueva.`,
    cancelOrderNotFound: (phone) => `Lo sentimos, no pudimos encontrar esa orden para cancelar — por favor llámanos al ${phone}.`,
    savedAddressOffer: (addr) => `📍 ¿Usar tu dirección guardada?\n${addr}`,
    savedAddressUseIt: 'Usar dirección guardada',
    savedAddressNew: 'Escribir nueva dirección',
    noteSaved: 'Listo — guardé esa nota para la próxima vez. 📝',
    reorderUsualPrompt: '¿Repetir lo de siempre? 🔁',
    abandonedCartRecovery: () => `👋 ¿Todavía lo estás pensando? Tu carrito sigue guardado — solo responde *SI* cuando quieras y seguimos justo donde lo dejaste.`,
    ordersPausedMsg: '😔 No podemos tomar pedidos nuevos por un momento — tu carrito está guardado, solo escribe *listo* otra vez en un rato para finalizar.',
    duplicateOrderWarning: (num) => `⚠️ Un momento — hiciste la orden #${num} hace un par de minutos. ¿Seguro que quieres hacer *otra* orden? Responde *si* otra vez para confirmar.`,
  },
};

// ---- SESSION STORAGE (in-memory, resets if server restarts) ----
const sessions = {};

// ---- LAST-ORDER STORAGE (for "repeat" command) ----
// Keyed by phone number. Same in-memory tradeoff as `sessions` above — resets
// if the server restarts. Stores enough to rebuild the cart, including each
// line's categoryId/itemIndex so sold-out status can be re-checked against
// TODAY's availability, not just blindly re-added.
const lastOrders = {};

// ---- SAVED (ABANDONED) CART STORAGE ----
// Keyed by phone number. Populated when sweepIdleSessions() expires a session
// with a non-empty cart (~30 min idle) — see below. In-memory, same
// restart/no-persistence tradeoff as `sessions` and `lastOrders`.
const savedCarts = {};

// Fresh session that keeps the one thing a customer already told us and
// shouldn't have to repeat: their language. Used everywhere a session is
// reset mid-relationship (order confirmed, order cancelled, 'cancel'
// command) — previously those three sites called newSession() directly and
// silently dumped a returning customer back onto the English/Español picker
// right after they'd finished ordering. The idle-expiry path already
// preserved language by hand; this makes that the shared rule.
function resetSessionKeepingLanguage(from) {
  const preservedLanguage = sessions[from] && sessions[from].language;
  sessions[from] = newSession();
  if (preservedLanguage) {
    sessions[from].language = preservedLanguage;
    sessions[from].step = 'menu';
  }
  return sessions[from];
}

function newSession() {
  return {
    step: 'language',
    language: null,
    cart: [],
    currentCategory: null,
    pendingItem: null,
    pendingSize: null,
    pendingQty: null,
    pendingCategoryId: null,
    pendingItemIndex: null,
    mode: null,
    address: null,
    lastMessageAt: Date.now(),
    nudgeStage: 0, // 0 = none sent, 1 = ~3min nudge sent, 2 = ~10min hold sent — see sweepIdleSessions()
    pendingResume: false, // true right after a saved cart is offered back to the customer
    frustrationScore: 0,
    parseFailureStreak: 0, // consecutive "didn't understand" replies — see scoreFrustrationSignals()
    lastRawMsg: null,
    escalationStage: 0, // 0=none, 1=softened tone shown, 2=shortcut offered, 3=escalated to a human — one-way ratchet, resets with the session
    transcript: [], // { role: 'customer'|'bot', text } — capped, attached on human handoff
    duplicateWarningAcked: false, // see the duplicate-order soft-warning at 'confirm'
  };
}

function getSession(from) {
  if (!sessions[from]) sessions[from] = newSession();
  return sessions[from];
}

// ---- IDLE-SESSION SWEEP (staged nudges, hold warning, graceful expiry) ----
// Runs off a setInterval (see app.listen below), same non-request-path
// pattern as refreshMenuFromSheet/pollOrderStatus. Only nudges sessions that
// actually have something at stake (a non-empty cart) — an empty session
// that only said "hi" gets silently garbage-collected instead of pestered.
const IDLE_NUDGE_MS = 3 * 60 * 1000;   // ~3 min: "still with me?" / confirm-prompt
const IDLE_HOLD_MS = 10 * 60 * 1000;   // ~10 min: "holding your order..."
const IDLE_EXPIRE_MS = 30 * 60 * 1000; // ~30 min: save cart + offer resume next time
const SAVED_CART_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // prune very old unclaimed saved carts
const ORDER_CANCEL_WINDOW_MS = 3 * 60 * 1000; // post-confirmation edit/cancel window — see the "cancel order" command
// Abandoned-cart recovery (Phase 5): a second, incentivized nudge ~1hr after
// the cart was first saved (~1.5hr total idle) — well within WhatsApp's
// 24-hour free-form messaging window, so no pre-approved template is
// needed for this one (unlike a genuinely next-day recovery would require).
const ABANDONED_CART_RECOVERY_DELAY_MS = 60 * 60 * 1000;
// Duplicate-order soft warning (Phase 5): confirming again within this
// window of a previous confirmed order asks "are you sure?" once, rather
// than silently creating a second order — catches confused double-orders
// from impatience/accidental resubmission without permanently blocking a
// customer who genuinely wants two separate orders close together.
const DUPLICATE_ORDER_WARNING_MS = 2 * 60 * 1000;

function sweepIdleSessions() {
  const now = Date.now();

  for (const from of Object.keys(sessions)) {
    const session = sessions[from];
    if (!session || !session.lastMessageAt) continue;
    const idleMs = now - session.lastMessageAt;

    if (session.cart.length === 0) {
      // A pendingResume session is deliberately left with an empty cart (its
      // items live in savedCarts instead) — never garbage-collect it just
      // for being idle, or the "want to continue?" offer silently vanishes
      // while savedCarts still thinks it's live. That pairing is cleaned up
      // together in the savedCarts prune pass below instead.
      if (idleMs >= IDLE_EXPIRE_MS && !session.pendingResume) delete sessions[from];
      continue;
    }

    const lang = session.language || 'en';
    const t = TXT[lang];

    if (idleMs >= IDLE_EXPIRE_MS) {
      savedCarts[from] = {
        cart: session.cart.map(item => ({ ...item })),
        mode: session.mode,
        address: session.address,
        savedAt: now,
        recoverySent: false, // see the recovery pass below
      };
      funnelCounters.cartAbandoned++;
      const preservedLanguage = session.language;
      sessions[from] = newSession();
      sessions[from].language = preservedLanguage;
      sessions[from].pendingResume = true;
      sendWhatsAppMessage(from, resumeChoiceMessage(lang, t.idleExpired)).catch(err => console.error(`Idle-expiry message failed for ${from}:`, err.message || err));
      continue;
    }

    if (idleMs >= IDLE_HOLD_MS && session.nudgeStage < 2) {
      session.nudgeStage = 2;
      sendWhatsAppMessage(from, t.idleHold).catch(err => console.error(`Idle-hold nudge failed for ${from}:`, err.message || err));
      continue;
    }

    if (idleMs >= IDLE_NUDGE_MS && session.nudgeStage < 1) {
      session.nudgeStage = 1;
      // Cart is complete but unconfirmed — nudge the action (confirm),
      // not the silence, per the product spec for this stage.
      const message = session.step === 'confirm' ? idleConfirmButtonMessage(lang) : t.idleStillThere;
      sendWhatsAppMessage(from, message).catch(err => console.error(`Idle nudge failed for ${from}:`, err.message || err));
    }
  }

  for (const from of Object.keys(savedCarts)) {
    const saved = savedCarts[from];

    if (now - saved.savedAt > SAVED_CART_MAX_AGE_MS) {
      delete savedCarts[from];
      // Clean up the paired empty pendingResume shell left in `sessions`
      // (see above) at the same time, now that there's nothing left to resume.
      if (sessions[from] && sessions[from].pendingResume) delete sessions[from];
      continue;
    }

    // Second win-back nudge — only once per saved cart, and only for a
    // session still in the pendingResume state (i.e. they haven't already
    // come back and either resumed or started fresh in the meantime).
    // This used to offer a 10% discount; the discount was removed by
    // business decision, so it's now a plain reminder.
    if (!saved.recoverySent && now - saved.savedAt >= ABANDONED_CART_RECOVERY_DELAY_MS
      && sessions[from] && sessions[from].pendingResume) {
      saved.recoverySent = true;
      const lang = (sessions[from] && sessions[from].language) || 'en';
      sendWhatsAppMessage(from, TXT[lang].abandonedCartRecovery())
        .catch(err => console.error(`Abandoned-cart recovery message failed for ${from}:`, err.message || err));
    }
  }
}

// ---- MOOD DETECTION / ESCALATION (Phase 2) ----
// Deliberately conservative: false positives (softening tone or offering a
// human to someone who isn't actually frustrated) are worse than a missed
// detection, per the product spec. Scoring only runs on genuine free-form
// text/voice input (see isFreeform in processWhatsAppMessage) — structured
// button/list taps can't meaningfully signal frustration the same way.
const FRUSTRATION_SOFTEN_THRESHOLD = 3;
const FRUSTRATION_SHORTCUT_THRESHOLD = 5;
const FRUSTRATION_ESCALATE_THRESHOLD = 8;

// Small, unambiguous, word-boundary-matched lists on purpose — this is meant
// to catch clear anger, not to be an exhaustive profanity filter.
const PROFANITY_REGEX = /\b(fuck(ing)?|shit|bullshit|pendej[oa]|mierda|carajo|estúpid[oa]|estupid[oa])\b/i;
const IMPATIENCE_REGEX = /how long|still waiting|this is ridiculous|hurry up|worst service|terrible service|cu[aá]nto (tiempo|falta)|todav[ií]a estoy esperando|esto es (una )?broma/i;

// Pure and side-effect-free so it's easy to reason about/test in isolation —
// only reads the raw text, doesn't touch session state.
function scoreFrustrationSignals(rawMsg) {
  const msg = rawMsg.trim();
  let score = 0;
  if (/\?{2,}/.test(msg)) score += 1; // "???"
  const letters = msg.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 6 && letters === letters.toUpperCase()) score += 1; // ALL CAPS (ignore short caps like "OK")
  if (PROFANITY_REGEX.test(msg)) score += 3;
  if (IMPATIENCE_REGEX.test(msg.toLowerCase())) score += 2;
  return score;
}

// ---- TRANSCRIPT (for human handoff — "never repeat themselves") ----
const TRANSCRIPT_MAX_ENTRIES = 24;

function pushTranscript(from, role, text) {
  const session = sessions[from];
  if (!session) return;
  if (!session.transcript) session.transcript = [];
  session.transcript.push({ role, text: (text || '').slice(0, 300) });
  if (session.transcript.length > TRANSCRIPT_MAX_ENTRIES) session.transcript.shift();
}

// Flattens a sendReply-shaped textOrMessages (string, array, button/list
// object) down to plain text for the transcript — staff reading a handoff
// don't need the actual WhatsApp button JSON, just what it said.
function replySummaryText(textOrMessages) {
  const messages = Array.isArray(textOrMessages) ? textOrMessages : [textOrMessages];
  return messages.filter(Boolean).map(m => {
    if (typeof m === 'string') return m;
    if (m.buttons) return m.buttons.body;
    if (m.list) return m.list.body;
    if (m.fallback) return m.fallback;
    return '[message]';
  }).filter(Boolean).join(' | ').slice(0, 300);
}

// Normalizes a sendReply-shaped `reply` (string or array) to an array and
// appends/prepends onto it — the escalation ladder below needed this same
// "normalize then splice in extra bubbles" step at every rung.
function appendReply(reply, ...extra) {
  return [...(Array.isArray(reply) ? reply : [reply]), ...extra];
}
function prependReply(reply, ...extra) {
  return [...extra, ...(Array.isArray(reply) ? reply : [reply])];
}

function transcriptText(session) {
  if (!session.transcript || session.transcript.length === 0) return '(no transcript)';
  return session.transcript.map(e => `${e.role === 'customer' ? '👤' : '🤖'} ${e.text}`).join('\n');
}

// Shared by the manual AGENT command and the automatic frustration-ladder
// escalation — both need to reach the same staff number with the same
// context so the customer never has to repeat themselves either way.
// Per-customer cooldown so repeating "agent"/"human" doesn't flood a real
// driver/owner phone — real staff attention is the scarce resource being
// protected here, not the customer's reply (see below, the customer still
// gets the normal "connecting you" reply every time regardless of this).
// The auto-escalation path (frustration score) doesn't strictly need this —
// it already has its own one-way-ratchet (escalationStage only fires once
// per session) — but keying the cooldown here rather than per-call-site
// means ANY future caller gets the same protection automatically.
const lastEscalationAt = new Map(); // from -> timestamp
const ESCALATION_COOLDOWN_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [from, at] of lastEscalationAt) {
    if (now - at > ESCALATION_COOLDOWN_MS) lastEscalationAt.delete(from);
  }
}, 10 * 60 * 1000).unref();

function escalateToHuman(from, session, lang, reasonLine) {
  const lastAt = lastEscalationAt.get(from);
  if (lastAt !== undefined && Date.now() - lastAt < ESCALATION_COOLDOWN_MS) return;
  lastEscalationAt.set(from, Date.now());

  const cartSummary = session.cart.length > 0 ? `\n\nCart:\n${cartText(session.cart, lang)}` : '';
  const note = getCustomerNote(from);
  const noteTag = note ? `\n⚠️ Customer note: ${note}` : '';
  const staffMsg = `🔔 ${reasonLine}\nCustomer: +${from} (step: ${session.step})${noteTag}${cartSummary}\n\n📝 Recent conversation:\n${transcriptText(session)}`;
  if (process.env.DEBUG_REPLIES) console.log('ESCALATE >>>', staffMsg);
  notifyAllDrivers(staffMsg); // fire-and-forget — notifyAllDrivers catches every send internally, so this promise can't reject
}

// ---- CART HELPERS ----
// Returns true if the item was added/bumped, false if refused because the
// cart is already at MAX_CART_LINES — bumping an item ALREADY in the cart
// always succeeds (it doesn't grow the line count), only a genuinely NEW
// line can be refused. Callers that skip checking the return value just
// silently stop growing the cart past the cap, which is a safe default —
// see the 'notes' step and applyMatchesToCart for the callers that DO
// surface this to the customer.
function addToCart(cart, name, price, qty, note = '', categoryId = null, itemIndex = null) {
  const existing = cart.find(c => c.name === name && c.price === price && (c.note || '') === note);
  if (existing) {
    existing.qty += qty;
    return true;
  }
  if (cart.length >= MAX_CART_LINES) return false;
  cart.push({ name, price, qty, note, categoryId, itemIndex });
  return true;
}

function cartTotal(cart) {
  return cart.reduce((sum, item) => sum + item.price * item.qty, 0);
}

function cartText(cart, lang) {
  const t = TXT[lang];
  if (cart.length === 0) return t.cartEmpty;
  let text = `${t.cartHeader}\n`;
  cart.forEach((item, i) => {
    const noteStr = item.note ? ` [${item.note}]` : '';
    text += `${i + 1}. ${item.name}${noteStr} x${item.qty} - $${(item.price * item.qty).toFixed(2)}\n`;
  });
  text += `\n${t.cartTotal(cartTotal(cart).toFixed(2))}`;
  return text;
}

function matchSizeChoice(msg, sizes) {
  const byKey = sizes.find(s => s.key === msg);
  if (byKey) return byKey;
  if (/large|grande|big/.test(msg)) return sizes[sizes.length - 1];
  if (/regular|normal|small|chico|chica/.test(msg)) return sizes[0];
  return null;
}

// ---- TEXT BUILDERS ----
function menuListText() {
  return MENU.map(cat => `${cat.id}. ${cat.category}`).join('\n');
}

// First-contact only (right after language selection) — deliberately the
// short variant. Use helpText() for the *help*/*ayuda* command instead.
function welcomeText(lang) {
  return TXT[lang].howToOrderShort();
}

// Full instructions + command glossary, shown on explicit request (*help*/
// *ayuda*) — not reused for first contact, see welcomeText() above.
function helpText(lang) {
  return TXT[lang].howToOrder();
}

// Sent before the customer has picked a language, so the body/fallback text
// is deliberately bilingual — this is the one place in the UI where `lang`
// isn't known yet. Button ids ('en'/'es') match the exact tokens the
// language-selection branch already accepts from typed text, so no other
// change is needed to wire it up.
function languageButtonsMessage() {
  const body = '🍧 *Créme De La Créme* 🍧\n\nChoose your language / Elige tu idioma:';
  return {
    buttons: {
      body,
      buttons: [
        { id: 'en', title: 'English 🇬🇧' },
        { id: 'es', title: 'Español 🇪🇸' },
      ],
    },
    fallback: `${body}\n1. English\n2. Español`,
  };
}

// Single-button prompt sent right after the how-to-order text — tapping it
// sends id 'menu', which the main switch already treats identically to
// typing "menu" (see the early menu/hi/hello check), so no other change
// is needed to wire it up.
function menuButtonMessage(lang) {
  const t = TXT[lang];
  return {
    buttons: {
      body: t.menuButtonPrompt,
      buttons: [{ id: 'menu', title: t.menuButtonTitle }],
    },
    fallback: t.menuButtonPrompt,
  };
}

function mainMenuText(lang) {
  return TXT[lang].mainMenu(menuListText());
}

// Prepends a closed-shop notice to a menu display, but only when actually
// closed — a no-op the rest of the time. Used at the greeting/menu entry
// points so customers know upfront, without nagging them on every reply.
function withClosedBanner(text, lang) {
  if (isShopOpen()) return text;
  const hours = lang === 'es' ? SHOP_INFO.hoursEs : SHOP_INFO.hoursEn;
  const nextOpen = nextOpeningText(lang);
  return TXT[lang].closedBanner(hours, nextOpen) + text;
}

function categoryItemsText(cat, lang) {
  let text = `*${cat.category}*\n`;
  cat.items.forEach((item, i) => {
    const soldOut = isItemSoldOut(cat.id, i + 1);
    const soldOutTag = soldOut ? (lang === 'es' ? '  ❌ AGOTADO' : '  ❌ SOLD OUT') : '';
    if (item.sizes) {
      text += `${i + 1}. ${item.name} - $${item.sizes[0].price.toFixed(2)}–$${item.sizes[item.sizes.length - 1].price.toFixed(2)}${soldOutTag}\n`;
    } else {
      text += `${i + 1}. ${item.name} - $${item.price.toFixed(2)}${soldOutTag}\n`;
    }
  });
  text += TXT[lang].backHint;
  text += TXT[lang].bulkHint;
  return text;
}

// ---- INTERACTIVE (BUTTONS/LIST) BUILDERS ----
// Row/button ids are chosen to exactly match the tokens the switch statement
// below already accepts from typed text (category id, item index, size key,
// "pickup"/"delivery", "yes"/"no") — see the `type === 'interactive'` inbound
// branch above. Every builder also carries a `fallback` (plain text/string,
// using the existing *Text builders) that sendReply sends automatically if
// the interactive send itself fails — see sendReply's catch block.
const LIST_ROW_TITLE_MAX = 24;
const LIST_ROW_DESC_MAX = 72;

function truncateForRow(name) {
  if (name.length <= LIST_ROW_TITLE_MAX) return { title: name, full: null };
  return { title: name.slice(0, LIST_ROW_TITLE_MAX - 1) + '…', full: name };
}

// Categories 1-7 are drinks, 8-11 are food (menu-data.js order). Split this
// way — rather than any other grouping — because Meta list messages cap at
// 10 rows total and MENU has 11 categories, so one list can't hold them all.
function categoryListMessages(lang) {
  // Prefixed ("cat:8", not bare "8") so a TAP is self-describing and can
  // never collide with an item index or size key — see the global
  // interactive-tap handler above the main switch for why this matters:
  // WhatsApp never expires old interactive messages, so a customer can
  // scroll up and tap a category button from much earlier in the chat at
  // any time, long after the bot's internally moved on to a different
  // category. Free-typed numbers are unaffected — they still resolve
  // relative to whatever step the customer's currently on.
  const toRows = cats => cats.map(cat => ({ id: `cat:${cat.id}`, title: cat.category }));
  const buttonLabel = lang === 'es' ? 'Ver categoría' : 'View category';
  // Both carry the SAME full text menu as fallback — sendReply's retry-on-
  // failure logic is per-message, not "one fallback covers the whole
  // batch," so if just the second (food) list send fails while the first
  // succeeds, it still needs its own fallback or that customer silently
  // never gets a food menu at all.
  return [
    {
      list: {
        body: lang === 'es' ? '🍹 Bebidas' : '🍹 Drinks Menu',
        buttonLabel,
        sections: [{ rows: toRows(MENU.filter(c => Number(c.id) <= 7)) }],
      },
      fallback: mainMenuText(lang),
    },
    {
      list: {
        body: lang === 'es' ? '🍔 Comida' : '🍔 Food Menu',
        buttonLabel,
        sections: [{ rows: toRows(MENU.filter(c => Number(c.id) > 7)) }],
      },
      fallback: mainMenuText(lang),
    },
  ];
}

// ---- REORDER PHRASINGS ----
// The *repeat*/*repetir* keywords are advertised in the help glossary, but
// most customers never read it — they just say "otra vez" or "la misma orden
// que ayer". These are the natural ways people ask for their last order in
// both languages; the bare keywords still work (and the "Reorder 🔁" button
// sends the id 'repeat', matched by the first alternative).
//
// Deliberately conservative: this path ADDS the previous order's items to
// the cart, so a false positive costs the customer real money. Every
// alternative below needs an explicit reorder phrase — bare "again",
// "usual", or "same" on their own are NOT enough, since "same" shows up in
// ordinary chatter ("same for my friend") and would silently refill a cart.
const REPEAT_RE = new RegExp([
  '^(repeat|repetir|reorder|reordenar|otra vez|lo mismo)$',
  '\\b(same (again|order|thing|as (last|before|always|usual)))',
  '\\b(order|get|have) (the )?same\\b',
  '\\b(order|buy) (it |that )?again\\b',
  '\\b(my|the) usual\\b',
  '\\brepeat (my |the )?(last )?order\\b',
  '\\breorder\\b',
  '\\b(otra vez|de nuevo|nuevamente)\\b',
  '\\blo mismo\\b',
  '\\bla misma orden\\b',
  '\\bel mismo pedido\\b',
  '\\blo de siempre\\b',
  '\\b(igual|lo mismo) que (ayer|siempre|la (vez )?pasada|antes)\\b',
  '\\bla misma de (ayer|siempre|la (vez )?pasada)\\b',
  '\\brepet(ir|e|ime) (mi |la |el )?(orden|pedido)\\b',
  '\\bcomo (siempre|la (vez )?pasada|ayer)\\b',
].join('|'), 'i');

// ---- NATURAL-LANGUAGE COMMAND ALIASES ----
// Customers don't read the help glossary — they type "what's in my cart",
// "eso es todo", "where's my order". Each entry maps a natural phrasing onto
// a canonical command the existing handlers already understand, so nothing
// downstream changes.
//
// Order matters: the FIRST match wins, so more specific intents come first.
// "where is my order" must resolve to `status` before the vaguer "my order"
// can claim it for `cart`.
//
// Only applied at the 'menu' and 'item' browsing steps (see its call site) —
// at the address/notes/quantity steps free text is the customer's ANSWER,
// and treating it as a command would swallow real content, the same class of
// bug that once stored a note as someone's delivery address.
// Each entry has two optional patterns:
//   `re`    — distinctive enough to match anywhere in a longer sentence.
//   `whole` — short/ambiguous, so it ONLY counts when it's essentially the
//             entire message (politeness words stripped).
//
// The `whole` tier exists because of real, tested false positives: "2 hot
// dogs no more onions" matched "no more" and CHECKED OUT instead of
// ordering, and "mejor no le pongas cebolla" matched "mejor no" and
// CANCELLED the order. Those fragments are perfectly normal inside an order,
// so they can only be trusted when they're the whole message.
const NATURAL_COMMANDS = [
  // Order status — needs a "where/ready/how's it going" cue so it can't
  // steal plain "my order" from the cart lookup below.
  {
    cmd: 'status',
    re: /\b(where('?s| is)?\s*(my|the)\s*(order|food)|is (my|the) (order|food) (ready|done|coming)|how('?s| is| long for) (my|the) (order|food)|track (my )?order|order status|what happened (to|with) (my|the) (order|food)|any (update|news) (on|about) (my|the) (order|food)|when (will|is|does) (my|the) (order|food)|status of (my|the) order)\b|\b(d[oó]nde (est[aá]|va|anda) mi (orden|pedido|comida)|c[oó]mo va mi (orden|pedido)|estado de mi (orden|pedido)|ya (est[aá] (lista|listo)|viene|sali[oó])|qu[eé] pas[oó] con mi (orden|pedido)|hay (novedades|noticias|alguna novedad)|cu[aá]ndo (llega|estar[aá]|sale)|cu[aá]nto (falta|tarda|demora) (para )?(mi|el) (orden|pedido))/i,
    // Bare "how long?" / "cuánto falta?" mean the order only when they ARE
    // the whole message. Inside a sentence they are ordinary pre-order FAQ
    // questions ("how long for delivery?", "¿cuánto tarda la entrega?"),
    // and this runs before matchFAQKeyword, so a loose match answered them
    // with "you don't have a previous order".
    whole: /^(how long|how long more|how much longer|cu[aá]nto falta|cu[aá]nto (tarda|demora))$/i,
  },

  // Human handoff.
  { cmd: 'agent', re: /\b(real (person|human)|talk to (a |an )?(human|person|someone|agent)|speak (to|with) (a |an )?(human|person|someone)|customer service)\b|\b(persona real|hablar con (alguien|una persona|un humano)|servicio al cliente)/i },

  // Cart contents.
  {
    cmd: 'cart',
    re: /\b(what('?s| is| was| do i have)?\s*(in )?(my|the) (cart|order|basket)|show (me )?(my|the) (cart|order)|see (my|the) (cart|order)|my cart|check (my )?cart|how much (is it|do i owe|so far)|what did i (order|get|add|ask for)|review (my )?order)\b|\b(qu[eé] (tengo|llevo)(?!\s+que\b)( en el carrito| hasta ahora)?|ver (mi|el) (carrito|orden|pedido)|mi carrito|cu[aá]nto (es|va|llevo)|mu[eé]strame (mi|el) (orden|carrito|pedido)|cu[aá]l (fue|es) mi (orden|pedido)|qu[eé] (ped[ií]|orden[eé]|agregu[eé])(?![a-zà-ÿ]))/i,
    // Bare "my order" / "mi pedido" with nothing else — unambiguous on its
    // own, but far too common inside longer sentences to trust anywhere.
    whole: /^(my (order|cart)|mi (orden|pedido|carrito)|el pedido|la orden)$/i,
  },

  // Checkout. Note "no more"/"nada más"/"ya está" live in `whole` only —
  // they're extremely common mid-order ("no more onions").
  {
    cmd: 'done',
    re: /\b(that('?s| is) (all|it|everything)|i('?m| am) (done|finished)|finish (my )?order|check ?out|place (my )?order|ready to (pay|checkout))\b|\b(eso es todo|terminar( mi)? (orden|pedido)|finalizar( mi)? (orden|pedido)|listo para (ordenar|pagar)|ya termin[eé])/i,
    whole: /^(no more|nothing else|that'?s all|done|finished|nada m[aá]s|es todo|ya est[aá]|ya)$/i,
  },

  // Instructions.
  { cmd: 'help', re: /\b(how does this work|how do i (order|use)|i('?m| am)? ?(lost|confused)|don'?t understand|what do i do|instructions)\b|\b(c[oó]mo funciona|c[oó]mo (ordeno|pido|hago)|no entiendo|estoy perdid|qu[eé] (tengo|hay) que hacer|qu[eé] hago|instrucciones)/i },

  // Back to the category list.
  { cmd: 'menu', re: /\b(show (me )?(the )?menu|see (the )?menu|go (back )?to (the )?menu|other (categories|options)|full menu)\b|\b(ver (el )?men[uú]|mu[eé]strame el men[uú]|otras (categor[ií]as|opciones)|men[uú] completo)/i },

  // Abandon the whole thing. "mejor no" / "déjalo" are whole-message only —
  // both appear naturally inside customization requests.
  {
    cmd: 'cancel',
    re: /\b(never ?mind|forget it|start over|cancel everything)\b|\b(olv[ií]dalo|empezar de nuevo|cancelar todo|ya no quiero nada)/i,
    whole: /^(mejor no|d[eé]jalo|ya no quiero|olvidalo)$/i,
  },
];

// Strips trailing/leading politeness and punctuation so a `whole` pattern
// still fires on "no more, thanks" or "por favor ya está".
function coreMessage(rawMsg) {
  return String(rawMsg || '')
    .toLowerCase()
    .replace(/[¿?¡!.,;]/g, ' ')
    .replace(/\b(please|thanks|thank you|pls|por ?favor|gracias|ok|okay)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveNaturalCommand(rawMsg) {
  // The bare keywords and button ids are matched by the existing handlers
  // before this ever runs — this is purely the "customer never learned the
  // commands" fallback.
  if (REPEAT_RE.test(rawMsg)) return 'repeat';
  const core = coreMessage(rawMsg);
  for (const { cmd, re, whole } of NATURAL_COMMANDS) {
    if (re && re.test(rawMsg)) return cmd;
    if (whole && whole.test(core)) return cmd;
  }
  return null;
}

// ---- FLAVOR / CRAVING RECOMMENDATIONS ----
// "anything mango?", "I want something cheesy", "algo de chocolate" — a
// craving rather than a specific item. Matches loosely against the words in
// menu item names so it keeps working as the menu changes (including items
// added through the Availability sheet), instead of hardcoding a flavor list.
//
// Voice notes get this for free: a transcript becomes rawMsg before any of
// this runs, so speaking "do you have anything mango" behaves like typing it.
// NOTE: no trailing \b on these. The Spanish alternatives are deliberately
// word STEMS ("recomiend" covers recomiendas/recomiendan/recomiende), and a
// trailing \b would reject exactly those — after "recomiend" the next
// character is a letter, so there's no boundary there. Cost a real miss on
// "qué me recomiendas" before it was caught.
const CRAVING_RE = /\b(something|anything|craving|crave|mood for|in the mood|recommend|suggest|what.*(have|got)|any\b.*\?|options?)|\b(algo|antojo|antoja|recomiend|recomend|recomendaci|sugerenc|sugier|opcion|tienen)/i;

// A recommendation request with NO flavor attached — "what do you recommend?",
// "what's good?", "surprise me", "no sé qué pedir". Kept separate from
// CRAVING_RE because these need best-sellers rather than a keyword match.
// Mirrored in both languages, including the accent-less spellings people
// actually type on a phone ("que me recomiendas", "no se que pedir").
// Same no-trailing-\b rule as CRAVING_RE above — these are stems too.
const GENERAL_RECOMMEND_RE = /\b(what('?s| is| do you)?\s*(you\s*)?(recommend|suggest|good|best|popular|nice|tasty)|recommend me|suggest me|surprise me|your best|most popular|best ?seller|what should i (get|order|try)|help me (choose|decide|pick)|don'?t know what|not sure what|any ?recommendation)|\b(qu[eé]\s*(me\s*)?(recomiend|recomend|sugier)|recomi[eé]ndame|sug[ieé]reme|sorpr[eé]ndeme|lo m[aá]s (pedido|popular|vendido)|el mejor|los mejores|qu[eé] est[aá] (bueno|rico)|no s[eé] qu[eé] (pedir|quiero|escoger|ordenar)|ay[uú]dame a (elegir|escoger|decidir)|qu[eé] me sugier)/i;

// Words too generic to be a useful craving signal — they'd match half the
// menu ("large coffee" shouldn't recommend every coffee).
const CRAVING_STOPWORDS = new Set([
  'with', 'and', 'the', 'our', 'for', 'you', 'have', 'want', 'like', 'some',
  'something', 'anything', 'please', 'large', 'regular', 'small', 'order',
  'menu', 'this', 'that', 'what', 'your', 'from', 'give', 'need', 'about',
  'quiero', 'algo', 'tienen', 'tiene', 'para', 'grande', 'menu', 'menú',
  'porfavor', 'favor', 'dame', 'quisiera', 'pero', 'como', 'cual', 'cuál',
]);

// Loose stem match: "cheesy"/"cheese" share "chees", "berries"/"berry" share
// "berr". A shared 4-character prefix is the cheapest rule that catches the
// plural/adjective forms customers actually type without matching unrelated
// words.
function cravingWordsMatch(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length, 5);
  if (n < 4) return false;
  return a.slice(0, n) === b.slice(0, n);
}

// The menu is written in English, so a Spanish craving ("algo de fresa")
// would never match a word in it without this. Only flavors/ingredients that
// actually appear on this menu are listed — there's no value in translating
// words we could never match anyway.
const FLAVOR_SYNONYMS = {
  fresa: 'strawberry', fresas: 'strawberry',
  chocolate: 'chocolate', vainilla: 'vanilla',
  cafe: 'coffee', café: 'coffee',
  pina: 'pineapple', piña: 'pineapple',
  mora: 'blackberry', moras: 'blackberry',
  frambuesa: 'raspberry', frambuesas: 'raspberry',
  arandano: 'blueberry', arándano: 'blueberry', arandanos: 'blueberry', arándanos: 'blueberry',
  platano: 'banana', plátano: 'banana', banano: 'banana',
  menta: 'mint', mani: 'peanut', maní: 'peanut', cacahuate: 'peanut',
  galleta: 'cookie', galletas: 'cookie',
  queso: 'cheese', quesos: 'cheese',
  pollo: 'chicken', carne: 'steak', res: 'steak',
  cerdo: 'pork', jamon: 'ham', jamón: 'ham',
  limon: 'lemon', limón: 'lemon', miel: 'honey',
  fruta: 'fruit', frutas: 'fruit',
  mango: 'mango', papaya: 'papaya', kiwi: 'kiwi',
  helado: 'frozen', frio: 'frozen', frío: 'frozen',
  te: 'tea', té: 'tea', batido: 'smoothie',
  sandwich: 'sandwich', emparedado: 'sandwich',
  picante: 'chili', chile: 'chili',
};

function significantWords(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-záéíóúñü\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !CRAVING_STOPWORDS.has(w));

  // Keep the original AND its English equivalent — a message mixing both
  // languages (common here) still matches either way.
  const expanded = [];
  for (const w of words) {
    if (w.length >= 4) expanded.push(w);
    const synonym = FLAVOR_SYNONYMS[w];
    if (synonym) expanded.push(synonym);
  }
  return expanded;
}

// Returns in-stock menu items whose name shares a significant word with the
// message. Capped — a WhatsApp list can hold 10 rows, and a wall of options
// is worse than a short suggestion anyway.
function findItemsByCraving(rawMsg, limit = 8) {
  const words = significantWords(rawMsg);
  if (words.length === 0) return [];

  const hits = [];
  MENU.forEach(cat => {
    cat.items.forEach((item, i) => {
      const itemIndex = i + 1;
      if (isItemSoldOut(cat.id, itemIndex)) return;
      const nameWords = significantWords(item.name);
      // The category name counts too, so "cheesy" can surface Quesadillas
      // and "smoothie" the whole Fruity Smoothie section.
      const catWords = significantWords(cat.category);
      const matched = words.some(w =>
        nameWords.some(nw => cravingWordsMatch(w, nw)) ||
        catWords.some(cw => cravingWordsMatch(w, cw))
      );
      if (matched) hits.push({ cat, item, itemIndex });
    });
  });
  return hits.slice(0, limit);
}

// "what do you recommend?", "what's good?", "surprise me" — a recommendation
// request with no flavor attached, so there's nothing to keyword-match on.
// Answer with what people ACTUALLY order most (from the Manager sheet), and
// fall back to a spread across categories when there's no history yet.
async function findRecommendedItems(limit = 6) {
  const byName = new Map();
  MENU.forEach(cat => {
    cat.items.forEach((item, i) => {
      const itemIndex = i + 1;
      if (isItemSoldOut(cat.id, itemIndex)) return;
      // Sheet rows record sized items as "Papaya (Large)" — key on the bare
      // name so both sizes count toward the same item.
      byName.set(item.name.toLowerCase(), { cat, item, itemIndex });
    });
  });

  try {
    const { topItems } = await getOrderStats();
    const hits = [];
    for (const [name] of topItems) {
      const bare = String(name).replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
      const found = byName.get(bare);
      if (found && !hits.includes(found)) hits.push(found);
      if (hits.length >= limit) break;
    }
    if (hits.length > 0) return { hits, fromHistory: true };
  } catch (err) {
    // Never let a Sheets hiccup turn a recommendation into an error reply —
    // the category spread below is a perfectly good answer on its own.
    console.error('Recommendation stats lookup failed, using menu spread:', err.message || err);
  }

  // No history (or Sheets unavailable): one item from each of the first few
  // categories, so the customer still sees a varied, useful sample.
  const spread = [];
  for (const cat of MENU) {
    const idx = cat.items.findIndex((_, i) => !isItemSoldOut(cat.id, i + 1));
    if (idx !== -1) spread.push({ cat, item: cat.items[idx], itemIndex: idx + 1 });
    if (spread.length >= limit) break;
  }
  return { hits: spread, fromHistory: false };
}

function recommendationMessage(hits, lang, opts = {}) {
  const rows = hits.map(({ cat, item, itemIndex }) => {
    const priceText = item.sizes
      ? `$${item.sizes[0].price.toFixed(2)}–$${item.sizes[item.sizes.length - 1].price.toFixed(2)}`
      : `$${item.price.toFixed(2)}`;
    const { title, full } = truncateForRow(item.name);
    const description = ((full ? `${full} — ` : '') + priceText).slice(0, LIST_ROW_DESC_MAX);
    // Same self-describing id the category lists use, so a tap routes through
    // the existing interactive handler — no new routing logic, and a stale
    // tap still resolves to the right item.
    return { id: `item:${cat.id}:${itemIndex}`, title, description };
  });

  const body = opts.popular
    ? (lang === 'es'
      ? '⭐ Estos son los favoritos de nuestros clientes:'
      : '⭐ These are our customers\' favorites:')
    : opts.spread
      ? (lang === 'es'
        ? '😋 Aquí tienes un poco de todo — ¿algo te llama la atención?'
        : '😋 Here\'s a bit of everything — anything catch your eye?')
      : (lang === 'es'
        ? '😋 Esto es lo que tenemos que te podría gustar:'
        : '😋 Here\'s what we\'ve got that you might like:');

  const fallback = body + '\n' + hits
    .map(({ cat, item, itemIndex }) => `${cat.id}.${itemIndex} ${item.name}`)
    .join('\n');

  return {
    list: {
      body,
      buttonLabel: lang === 'es' ? 'Ver opciones' : 'See options',
      sections: [{ rows }],
    },
    fallback,
  };
}

function categoryItemsListMessage(cat, lang) {
  const soldOutNames = [];
  const rows = [];
  cat.items.forEach((item, i) => {
    if (isItemSoldOut(cat.id, i + 1)) {
      soldOutNames.push(item.name);
      return;
    }
    const priceText = item.sizes
      ? `$${item.sizes[0].price.toFixed(2)}–$${item.sizes[item.sizes.length - 1].price.toFixed(2)}`
      : `$${item.price.toFixed(2)}`;
    const { title, full } = truncateForRow(item.name);
    const description = ((full ? `${full} — ` : '') + priceText).slice(0, LIST_ROW_DESC_MAX);
    // Self-describing id ("item:8:3": category 8, item 3) — same reasoning
    // as categoryListMessages' "cat:" prefix above, so a stale tap on this
    // exact row (possibly tapped much later, after the bot's moved on to
    // tracking a different category) still resolves to THIS item, not
    // whatever the current category happens to be.
    rows.push({ id: `item:${cat.id}:${i + 1}`, title, description });
  });

  if (rows.length === 0) return categoryItemsText(cat, lang); // everything's sold out — plain text already explains that per item

  const soldOutNote = soldOutNames.length > 0
    ? (lang === 'es' ? `❌ Agotado hoy: ${soldOutNames.join(', ')}\n\n` : `❌ Sold out today: ${soldOutNames.join(', ')}\n\n`)
    : '';

  return {
    list: {
      body: `${soldOutNote}*${cat.category}*`,
      buttonLabel: lang === 'es' ? 'Elegir artículo' : 'Select Item',
      sections: [{ rows }],
    },
    fallback: categoryItemsText(cat, lang),
  };
}

// categoryId/itemIndex identify WHICH item these size buttons belong to —
// needed so each button's id can be self-describing ("size:6:1:2": category
// 6, item 1, Large), same reasoning as the "cat:"/"item:" prefixes above. A
// bare size key alone ("1"/"2") would collide with category and item-row
// ids in the exact same small-integer space.
function sizeButtonsMessage(item, lang, categoryId, itemIndex) {
  const body = TXT[lang].askSize(item.name, item.sizes);
  return {
    buttons: {
      body,
      buttons: item.sizes.map(s => ({ id: `size:${categoryId}:${itemIndex}:${s.key}`, title: `${s.label} - $${s.price.toFixed(2)}`.slice(0, 20) })),
    },
    fallback: body,
  };
}

function modeButtonsMessage(fee, lang) {
  const body = TXT[lang].askMode(fee);
  return {
    buttons: {
      body,
      buttons: [
        { id: 'pickup', title: lang === 'es' ? 'Recoger 📦' : 'Pickup 📦' },
        { id: 'delivery', title: lang === 'es' ? 'Entrega 🏍️' : 'Delivery 🏍️' },
      ],
    },
    fallback: body,
  };
}

function confirmButtonsMessage(bodyText, lang) {
  return {
    buttons: {
      body: bodyText,
      buttons: [
        { id: 'yes', title: lang === 'es' ? 'Sí ✅' : 'Yes ✅' },
        { id: 'no', title: lang === 'es' ? 'No ❌' : 'No ❌' },
      ],
    },
    fallback: bodyText,
  };
}

// Adds a one-tap "None" quick-reply alongside the existing typed shorthand
// (noNoteWords in the 'notes' step already accepts 'none'/'no'/'ninguno'/'0'
// as plain text) — the button's id 'none' lands in that same check because
// interactive taps set rawMsg to the tapped id (see extractInboundMessage),
// so no new routing logic was needed here.
// Shown the FIRST time the bot doesn't understand something, instead of the
// old text-only reply that told the customer to "type *help*" — the exact
// thing a stuck customer won't do. Both ids ('help', 'menu') are already
// global commands, so a tap routes with no new logic, and it works even if
// tapped much later from an older message.
//
// Deliberately no "talk to a person" button here: that pings real staff, and
// the frustration ladder already offers it once someone is genuinely stuck
// (see stopGuessing). One bad parse shouldn't route a customer to a human.
function stuckHelpMessage(lang) {
  const t = TXT[lang];
  const body = `${t.notUnderstood}\n\n${t.humanHelp(SHOP_INFO.phone)}`;
  return {
    buttons: {
      body,
      buttons: [
        { id: 'help', title: t.helpButtonTitle },
        { id: 'menu', title: t.menuButtonTitle },
      ],
    },
    fallback: body,
  };
}

function notesButtonsMessage(lang) {
  const t = TXT[lang];
  const body = t.askNotes;
  return {
    buttons: {
      body,
      buttons: [{ id: 'none', title: t.noneButtonTitle }],
    },
    fallback: body,
  };
}

// Adds a one-tap "Done" quick-reply alongside the existing typed shorthand
// ('done'/'listo'/'checkout' are already handled at both the 'menu' and
// 'item' steps — see the case blocks below). Browsing other categories still
// has its own buttons via the categoryList/categoryItems message that's
// always sent right after this one; this only adds the missing checkout tap.
function confirmNudgeMessage(lang) {
  const t = TXT[lang];
  const body = t.askConfirmNudge;
  return {
    buttons: {
      body,
      buttons: [{ id: 'done', title: t.doneButtonTitle }],
    },
    fallback: body,
  };
}

// These three are sent proactively by sweepIdleSessions()/the abandoned-cart
// recovery pass, OUTSIDE the normal webhook request/reply cycle — but the
// button ids still route through the exact same per-step checks a typed
// reply would ('yes'/'menu' at the pendingResume block, 'yes' at the
// 'confirm' step's msg check), so no new routing logic is needed for any of
// these; see sweepIdleSessions for why each one is safe to tap into.

// Used for both idleExpired (session already flipped to pendingResume=true
// right before this is sent) and the reactive resumeOffer reply — same
// choice, same ids, different body text depending on which fired.
function resumeChoiceMessage(lang, body) {
  return {
    buttons: {
      body,
      buttons: [
        { id: 'yes', title: lang === 'es' ? 'Continuar Orden 🔁' : 'Resume Order 🔁' },
        { id: 'menu', title: lang === 'es' ? 'Empezar de Nuevo 🆕' : 'Start Fresh 🆕' },
      ],
    },
    fallback: body,
  };
}

function idleConfirmButtonMessage(lang) {
  const t = TXT[lang];
  const body = t.idleConfirmPrompt;
  return {
    buttons: {
      body,
      buttons: [{ id: 'yes', title: lang === 'es' ? 'Confirmar Orden ✅' : 'Confirm Order ✅' }],
    },
    fallback: body,
  };
}

function savedAddressButtonsMessage(addr, lang) {
  const t = TXT[lang];
  const body = t.savedAddressOffer(addr);
  return {
    buttons: {
      body,
      buttons: [
        { id: 'use_saved_address', title: t.savedAddressUseIt },
        { id: 'new_address', title: t.savedAddressNew },
      ],
    },
    fallback: body,
  };
}

// Tapping this sends id 'repeat', which the 'menu' step's existing repeat/
// repetir handler already treats identically to typing it — no other wiring
// needed. Only shown when there's an empty-cart fresh start AND real order
// history, so it's a genuine shortcut rather than clutter mid-order.
function reorderUsualButtonMessage(lang) {
  const t = TXT[lang];
  return {
    buttons: {
      body: t.reorderUsualPrompt,
      buttons: [{ id: 'repeat', title: lang === 'es' ? 'Repetir 🔁' : 'Reorder 🔁' }],
    },
    fallback: t.reorderUsualPrompt,
  };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('AI call timed out')), ms)),
  ]);
}

// ---- LANGUAGE DETECTION (first message only, before a language is picked) ----
// Deliberately conservative — same "false positives are worse than misses"
// principle as the frustration scoring: only fires on a strong, unambiguous
// signal, never on a short or ambiguous first message.
const SPANISH_SIGNAL_REGEX = /[¿¡]|\b(hola|quiero|quisiera|buenas|gracias|por favor|men[uú]|tienen|hacen entrega|env[ií]an|cu[aá]nto|d[oó]nde|cu[aá]ndo|quisieramos|pedido)\b/i;
const ENGLISH_SIGNAL_REGEX = /\b(hello|hi there|i want|i'd like|i would like|do you have|menu please|thanks|good morning|good afternoon)\b/i;

function detectLanguage(rawMsg) {
  const msg = rawMsg.trim();
  if (msg.length < 4) return null; // too short to be confident either way
  if (SPANISH_SIGNAL_REGEX.test(msg)) return 'es';
  if (ENGLISH_SIGNAL_REGEX.test(msg.toLowerCase())) return 'en';
  return null;
}

// ---- FAQ (deterministic, zero AI cost, checked before AI) ----
function matchFAQKeyword(lowerMsg) {
  const feeRe = /(delivery|deliver).*(cost|fee|much|price|charge)|(cost|fee|much|price|charge).*(delivery|deliver)/;
  const feeEsRe = /(cuanto|cuánto).*(entrega|delivery)|(entrega|delivery).*(cuanto|cuánto)/;
  if (feeRe.test(lowerMsg) || feeEsRe.test(lowerMsg)) return 'deliveryFee';

  if (/\b(hour|hours|open|close|closing|closed|time)\b/.test(lowerMsg) || /\b(horario|horas|abren|cierran|abierto|cerrado)\b/.test(lowerMsg)) return 'hours';
  if (/\b(deliver|delivery)\b/.test(lowerMsg) || /\bentrega/.test(lowerMsg)) return 'deliveryGeneral';
  if (/\b(pay|payment|cash|card|credit)\b/.test(lowerMsg) || /\b(pago|pagar|efectivo|tarjeta)\b/.test(lowerMsg)) return 'payment';
  if (/\b(where|location|address)\b/.test(lowerMsg) || /\b(donde|dónde|ubicaci|direcci)/.test(lowerMsg)) return 'location';
  return null;
}

function faqAnswer(key, lang) {
  const s = SHOP_INFO;
  const answers = {
    en: {
      hours: `🕐 We're open ${s.hoursEn}!`,
      deliveryFee: `🏍️ Delivery is $${s.deliveryFee} BZD within ${s.deliveryAreasEn}, usually ${s.deliveryTimeEn}. Minimum order for delivery is $${s.minDeliveryOrder} BZD.`,
      deliveryGeneral: `🏍️ Yes, we deliver! $${s.deliveryFee} BZD within ${s.deliveryAreasEn}, usually ${s.deliveryTimeEn}. Minimum order $${s.minDeliveryOrder} BZD.`,
      payment: `💵 ${s.paymentEn}`,
      location: `📍 We're based in ${s.deliveryAreasEn}. For exact directions, best to give us a call!`,
    },
    es: {
      hours: `🕐 ¡Abrimos ${s.hoursEs}!`,
      deliveryFee: `🏍️ La entrega cuesta $${s.deliveryFee} BZD dentro de ${s.deliveryAreasEs}, normalmente ${s.deliveryTimeEs}. Pedido mínimo para entrega: $${s.minDeliveryOrder} BZD.`,
      deliveryGeneral: `🏍️ ¡Sí, hacemos entregas! $${s.deliveryFee} BZD dentro de ${s.deliveryAreasEs}, normalmente ${s.deliveryTimeEs}. Pedido mínimo $${s.minDeliveryOrder} BZD.`,
      payment: `💵 ${s.paymentEs}`,
      location: `📍 Estamos en ${s.deliveryAreasEs}. Para direcciones exactas, ¡mejor llámanos!`,
    },
  };
  return (answers[lang] && answers[lang][key]) || null;
}

// ---- DIRECT MENU MATCHING (exact/near-exact item names, zero AI cost) ----
// Skipped when the message hints at customization/size, since those need AI to parse properly.
const CUSTOMIZATION_HINT_RE = /\b(no|sin|extra|más|mas|less|without|large|grande|big|regular)\b/i;

function findDirectMatches(rawMsg) {
  const lower = rawMsg.toLowerCase();
  const candidates = [];
  MENU.forEach(cat => {
    cat.items.forEach((item, idx) => {
      candidates.push({ categoryId: cat.id, itemIndex: idx + 1, nameLower: item.name.toLowerCase() });
    });
  });
  candidates.sort((a, b) => b.nameLower.length - a.nameLower.length);

  // Longest names are matched first so e.g. "Strawberry Cheesecake" claims
  // its own text before plain "Strawberry" is considered — but a shorter
  // name should only be skipped when it overlaps the SAME text span a
  // longer match already claimed, not just because its name happens to be
  // a substring of some longer name that matched ELSEWHERE in the message.
  // (Previously this compared names only, so "1 strawberry cheesecake and
  // 1 strawberry" silently dropped the second item.) Track claimed
  // character ranges and require an unclaimed occurrence instead.
  const claimedRanges = [];
  const matched = [];
  for (const c of candidates) {
    let searchFrom = 0;
    let matchIndex = -1;
    while (true) {
      const idx = lower.indexOf(c.nameLower, searchFrom);
      if (idx === -1) break;
      const end = idx + c.nameLower.length;
      const overlapsClaimed = claimedRanges.some(([s, e]) => idx < e && end > s);
      if (!overlapsClaimed) { matchIndex = idx; break; }
      searchFrom = idx + 1;
    }
    if (matchIndex === -1) continue;
    claimedRanges.push([matchIndex, matchIndex + c.nameLower.length]);
    matched.push({ ...c, matchIndex });
  }
  matched.sort((a, b) => a.matchIndex - b.matchIndex); // report in the order they appeared

  return matched.map(c => {
    const before = lower.slice(Math.max(0, c.matchIndex - 6), c.matchIndex);
    const digitMatch = before.match(/(\d+)\s*$/);
    const qty = digitMatch ? parseInt(digitMatch[1], 10) : 1;
    return { categoryId: c.categoryId, itemIndex: c.itemIndex, qty, size: 'regular' };
  });
}

// ---- AI FALLBACK (orders it can't match directly + FAQ questions) ----
// The AI only ever picks from this real list and these real shop facts —
// it can pick the wrong thing, but it can never invent a fake item, price, or policy.
function buildMenuListingForAI() {
  const lines = [];
  MENU.forEach(cat => {
    const categoryName = cat.category.replace(/\s*–\s*\$[\d.]+$/, ''); // strip trailing "– $7" — price is per-item below
    cat.items.forEach((item, idx) => {
      if (item.sizes) {
        const sizeStr = item.sizes.map(s => `${s.label.toLowerCase()}=$${s.price}`).join(', ');
        lines.push(`${cat.id}.${idx + 1} | ${categoryName} | ${item.name} | sizes: ${sizeStr}`);
      } else {
        lines.push(`${cat.id}.${idx + 1} | ${categoryName} | ${item.name} | $${item.price}`);
      }
    });
  });
  return lines.join('\n');
}

// ---- VOICE NOTE TRANSCRIPTION ----
// Downloads a WhatsApp voice note via Chakra's media endpoint (Bearer auth,
// same CHAKRA_API_KEY as everything else — no separate credentials needed
// like Twilio required) and transcribes it with Gemini. The transcript is
// then fed through the EXACT SAME pipeline a typed message goes through
// (attemptFreeOrder, interpretMessage, etc.) — no separate order-matching
// logic needed for voice.
async function transcribeVoiceNote(mediaId, mimeType) {
  const mediaUrl = `https://api.chakrahq.com/v1/whatsapp/${CHAKRA_API_VERSION}/media/${mediaId}/show`;
  const audioRes = await withTimeout(fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${CHAKRA_API_KEY}` },
  }), 10000);
  if (!audioRes.ok) throw new Error(`Failed to download voice note (HTTP ${audioRes.status})`);
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
  const base64Audio = audioBuffer.toString('base64');
  // WhatsApp sometimes appends codec params, e.g. "audio/ogg; codecs=opus" —
  // Gemini expects a clean MIME type.
  const cleanMimeType = (mimeType || '').split(';')[0].trim();

  const result = await withTimeout(genAI.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: [
      { text: 'Transcribe this voice message exactly as spoken, in whatever language it is (English or Spanish). Respond with ONLY the transcription text — no commentary, no quotation marks, no translation.' },
      { inlineData: { mimeType: cleanMimeType, data: base64Audio } },
    ],
  }), 25000);

  return (result.text || '').trim();
}

async function interpretMessage(rawMsg) {
  const menuListing = buildMenuListingForAI();
  const shopFacts = `Hours: ${SHOP_INFO.hoursEn}
Delivery: $${SHOP_INFO.deliveryFee} BZD fee, area: ${SHOP_INFO.deliveryAreasEn}, time: ${SHOP_INFO.deliveryTimeEn}, minimum order: $${SHOP_INFO.minDeliveryOrder} BZD
Payment: ${SHOP_INFO.paymentEn}`;

  const prompt = `
You are a strict assistant for a WhatsApp food ordering bot. Do not guess or invent facts.

Customer message (English or Spanish, possibly with typos):
"${rawMsg}"

Exact menu (categoryId.itemIndex | category | name | price or sizes):
${menuListing}

Shop facts (use ONLY these — never invent hours, fees, or policies not listed here):
${shopFacts}

Task:
1. If the customer is trying to order food/drinks, return matched item(s) in "matches". ONLY match items from the exact menu list above — never invent one. The category column matters: if the customer names a category (e.g. "smoothie", "latte", "chamoyada") or a size like "large"/"grande" that only makes sense for sized items, only match within that category — do not substitute a same-named or similar-sounding item from a different category. Include a "note" field with any customization mentioned verbatim (e.g. "no ice", "extra cheese"), or omit it if none. If an item has sizes and "large"/"grande"/"big" is mentioned, set size to "large", otherwise "regular". Include qty if mentioned, default 1. Only include a match if confident — leave vague requests out entirely rather than guessing at the closest item.
2. If the customer is asking a question the shop facts above can answer, answer briefly in "answer" using ONLY those facts, in the SAME language the customer used. If the facts don't cover it, leave "answer" null.
3. If it's neither a clear order nor something the shop facts can answer, leave "matches" empty and "answer" null.

Respond with ONLY raw JSON, no markdown, no explanation, in this exact shape:
{"matches": [{"categoryId": "6", "itemIndex": 1, "qty": 2, "size": "large", "note": "no ice"}], "answer": null}
`.trim();

  try {
    // temperature: 0 — this is menu-item matching, not creative writing;
    // an ambiguous compound order like "1 mango and 1 mango pine" needs the
    // same correct split every time, not sampling variance between calls.
    const result = await withTimeout(
      genAI.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: prompt,
        config: { temperature: 0 },
      }),
      8000
    );
    const text = result.text.trim()
      .replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(text);
    return {
      matches: Array.isArray(parsed.matches) ? parsed.matches : [],
      answer: typeof parsed.answer === 'string' ? parsed.answer : null,
    };
  } catch (err) {
    console.error('AI parse error:', err);
    return { matches: [], answer: null };
  }
}

function applyMatchesToCart(session, matches) {
  const addedLines = [];
  const soldOutNames = [];
  let capped = false;
  for (const m of matches) {
    const cat = MENU.find(c => c.id === String(m.categoryId));
    if (!cat) continue;
    const item = cat.items[m.itemIndex - 1];
    if (!item) continue;

    if (isItemSoldOut(cat.id, m.itemIndex)) {
      soldOutNames.push({ name: item.name, categoryId: cat.id, itemIndex: m.itemIndex });
      continue;
    }

    const qty = Math.min(Math.max(parseInt(m.qty, 10) || 1, 1), MAX_QTY);
    const note = (m.note || '').toString().trim().slice(0, 60);

    let name = item.name;
    let price;
    if (item.sizes) {
      const wantLarge = (m.size || '').toLowerCase() === 'large';
      const size = wantLarge ? item.sizes[item.sizes.length - 1] : item.sizes[0];
      name = `${item.name} (${size.label})`;
      price = size.price;
    } else {
      price = item.price;
    }

    // addToCart itself decides whether this needs a new line (subject to
    // MAX_CART_LINES) or is bumping an existing one (always allowed) — see
    // its own comment. Stop processing further matches once genuinely
    // capped, rather than silently dropping some and not others.
    if (!addToCart(session.cart, name, price, qty, note, cat.id, m.itemIndex)) {
      capped = true;
      break;
    }
    const noteStr = note ? ` [${note}]` : '';
    addedLines.push(`${name}${noteStr} x${qty} - $${(price * qty).toFixed(2)}`);
  }
  return { added: addedLines, soldOut: soldOutNames, capped };
}

// ---- ORDER-ANYTIME HELPER ----
// Tries to interpret a message as a food order (direct match first, then AI fallback)
// and adds any in-stock matches straight to the cart. Returns
// { added: [...], soldOut: [{name, categoryId, itemIndex}, ...] } — either
// array may be empty — soldOut carries categoryId/itemIndex (not just the
// name) so a substitute from the same category can be suggested instead of
// just dropping the item silently — or null if nothing in the message
// looked like an order at all. Used both in the main
// menu step AND as a fallback inside every other step, so a customer can slip
// in "also add a hot dog" while answering a size/quantity/mode/confirm question
// without losing their place in that flow.
// Returns { added, soldOut, answer } — added/soldOut may be empty arrays if
// nothing was recognized as an order. `answer` carries the AI's FAQ-style
// answer (if any) from the SAME call that checked for an order match, so
// callers never need a second AI round-trip just to get it.
async function attemptFreeOrder(rawMsg, session) {
  const msg = rawMsg.trim().toLowerCase();
  let matches = CUSTOMIZATION_HINT_RE.test(msg) ? [] : findDirectMatches(rawMsg);
  let answer = null;
  if (matches.length === 0) {
    const result = await interpretMessage(rawMsg);
    matches = result.matches;
    answer = result.answer;
  }
  // Neither direct match nor the AI found a confident match — before giving
  // up, check whether the message is a short/partial name that's genuinely
  // ambiguous between two or more real items (e.g. "homemade" matches both
  // "Homemade Cheese Dip" and "Ground Steak & Homemade Dip"). Silently
  // adding nothing here is exactly why that case slipped through before —
  // the customer sees no clear reason their item never made it into the cart.
  if (matches.length === 0 && !answer) {
    const ambiguous = findAmbiguousItemNames(rawMsg);
    if (ambiguous.length >= 2) {
      const list = ambiguous.map((n, i) => `${i + 1}. ${n}`).join('\n');
      answer = session.language === 'es'
        ? `Podría ser varias cosas:\n${list}\n\n¿Cuál quisiste decir?`
        : `That could be a few different things:\n${list}\n\nWhich one did you mean?`;
    }
  }
  if (matches.length === 0) return { added: [], soldOut: [], answer, capped: false };
  const { added, soldOut, capped } = applyMatchesToCart(session, matches);
  return { added, soldOut, answer: null, capped };
}

// Reverse of findDirectMatches's substring check — here the CUSTOMER'S text
// is short (e.g. a single word) and might be a partial match INSIDE one or
// more full item names, rather than the other way around. Only meaningful
// as a genuine ambiguity signal when it hits 2+ items; a single hit means
// the AI should have matched it directly, so this isn't a fallback matcher.
function findAmbiguousItemNames(rawMsg) {
  const q = rawMsg.trim().toLowerCase();
  if (q.length < 3) return [];
  const hits = [];
  MENU.forEach(cat => {
    cat.items.forEach(item => {
      if (item.name.toLowerCase().includes(q)) hits.push(item.name);
    });
  });
  return hits;
}

// Combines an attemptFreeOrder result into a reply fragment: sold-out
// apologies (if any) followed by the "Added ✅" cart update (if anything was
// actually added). The caller appends whatever follow-up text fits their
// step (re-ask a question, show the menu, show the category again, etc.).
// Refills the cart from this customer's last order, honouring sold-out items
// and the cart-line cap. Shared by the *repeat*/*repetir* command at both the
// 'menu' and 'item' steps (and the "Reorder 🔁" button, which sends the same
// id) so the two can't drift apart.
function buildRepeatReply(from, session, lang) {
  const t = TXT[lang];
  const last = lastOrders[from];
  if (!last || last.cart.length === 0) {
    return [t.noPreviousOrder, ...categoryListMessages(lang)];
  }

  const addedLines = [];
  const soldOutLines = [];
  let repeatCapped = false;
  last.cart.forEach(item => {
    if (repeatCapped) return;
    if (item.categoryId != null && item.itemIndex != null && isItemSoldOut(item.categoryId, item.itemIndex)) {
      soldOutLines.push(t.soldOutItem(item.name, suggestSubstitute(item.categoryId, item.itemIndex)));
      return;
    }
    if (!addToCart(session.cart, item.name, item.price, item.qty, item.note, item.categoryId, item.itemIndex)) {
      repeatCapped = true;
      return;
    }
    const noteStr = item.note ? ` [${item.note}]` : '';
    addedLines.push(`${item.name}${noteStr} x${item.qty} - $${(item.price * item.qty).toFixed(2)}`);
  });

  const bits = [];
  if (soldOutLines.length > 0) bits.push(soldOutLines.join('\n'));
  if (addedLines.length > 0) bits.push(t.added(addedLines.join('\n'), cartTotal(session.cart).toFixed(2)));
  if (repeatCapped) bits.push(t.cartFull);

  return [
    bits.length > 0 ? bits.join('\n\n') : t.noPreviousOrder,
    confirmNudgeMessage(lang),
    ...categoryListMessages(lang),
  ];
}

function orderResultText(result, session, lang) {
  const t = TXT[lang];
  const bits = [];
  if (result.soldOut.length > 0) {
    bits.push(result.soldOut.map(s => t.soldOutItem(s.name, suggestSubstitute(s.categoryId, s.itemIndex))).join('\n'));
  }
  if (result.added.length > 0) {
    bits.push(t.added(result.added.join('\n'), cartTotal(session.cart).toFixed(2)));
  }
  if (result.capped) {
    bits.push(t.cartFull);
  }
  return bits.join('\n\n');
}

// ---- MAIN WEBHOOK ----
// Meta Cloud API webhook format (Chakra pass-through) — the single place
// that knows this shape, parsed once per request. Returns null for a
// bodyless/non-JSON POST (body-parser leaves req.body undefined for those —
// verified against the installed body-parser version, not assumed) or any
// payload that isn't an inbound message (status callbacks, etc).
function extractInboundMessage(req) {
  const body = req.body;
  if (!body || typeof body !== 'object') return null;
  const entry = body.entry && body.entry[0];
  const change = entry && entry.changes && entry.changes[0];
  const value = change && change.value;
  return (value && value.messages && value.messages[0]) || null;
}

app.post('/whatsapp', async (req, res) => {
  const sigResult = verifyChakraSignature(req);
  if (sigResult === false) {
    console.warn('Webhook signature mismatch — rejecting request.');
    return res.sendStatus(403);
  }

  const message = extractInboundMessage(req);
  if (!message || !isValidSenderId(message.from)) {
    // Not a real inbound customer message — bodyless ping, delivery-status
    // event, template update, or a malformed/forged sender id. Ack and stop
    // here, BEFORE touching either rate limiter, so the bot's own
    // status-callback echo traffic (and forged junk) can't eat into the
    // budget real customer messages depend on.
    return res.sendStatus(200);
  }
  const from = message.from;

  if (isDuplicateMessage(message.id)) {
    console.warn(`Duplicate delivery for message ${message.id} from ${from} — acking without reprocessing.`);
    return res.sendStatus(200);
  }

  if (isRateLimited('__global__', RATE_LIMIT_GLOBAL)) {
    console.warn('Global rate limit hit — dropping request.');
    return res.sendStatus(200);
  }
  if (isRateLimited(from, RATE_LIMIT_PER_SENDER)) {
    console.warn(`Rate limit hit for ${from} — dropping request.`);
    return res.sendStatus(200);
  }

  // Ack immediately. Everything past this point — AI calls, Sheets writes,
  // the per-sender queue below — can legitimately take seconds, and making
  // Meta/Chakra wait on that is exactly what risks the retry the dedup
  // check above exists to make harmless. sendReply()'s own ack becomes a
  // no-op once headers are already sent (see its headersSent guard).
  res.sendStatus(200);
  markAsRead(message.id); // fire-and-forget, purely cosmetic — never awaited
  withSessionLock(from, () => processWhatsAppMessage(message, res)).catch(err => {
    console.error('Unhandled error processing message:', err);
  });
});

// Shared by the 'menu' and 'item' steps' "done"/checkout handling — the
// only real difference between those two call sites was which view to fall
// back to when the cart is empty. Returns the reply value for that branch;
// mutates session.step/funnelCounters same as the original inline code did.
function tryCheckout(session, lang, emptyCartFallbackViews) {
  const t = TXT[lang];
  if (session.cart.length === 0) {
    return [t.cartEmptyCheckout, ...emptyCartFallbackViews];
  }
  if (ordersPaused) {
    return t.ordersPausedMsg;
  }
  // Checkout proceeds even while closed — confirming becomes a pre-order
  // instead of a dead end (see the 'confirm' step's isPreorder handling).
  session.step = 'mode';
  funnelCounters.checkoutStarted++;
  return [cartText(session.cart, lang), modeButtonsMessage(SHOP_INFO.deliveryFee, lang)];
}

// Table-driven owner commands (see OWNER_NUMBERS above for the full list
// and what each does). `match(msg, rawMsg)` returns a truthy value if this
// entry applies — `true` for a plain command, or a regex match array whose
// captures the handler needs — and `handler(match)` does the work and
// returns the reply text. Adding a 7th command is one entry here instead of
// a new if-block hand-wired into the main flow, and this is the one place
// any future cross-cutting behavior (logging every owner command, rate-
// limiting them, etc.) would go.
const OWNER_COMMANDS = [
  {
    match: (msg) => msg === 'pause orders',
    handler: async () => {
      ordersPaused = true;
      return '⏸️ Orders paused. New checkouts will be blocked until you send "resume orders".';
    },
  },
  {
    match: (msg) => msg === 'resume orders',
    handler: async () => {
      ordersPaused = false;
      return '▶️ Orders resumed — customers can check out again.';
    },
  },
  {
    match: (msg, rawMsg) => rawMsg.trim().match(/^soldout\s+(.+)/i),
    handler: async (match) => {
      const found = findMenuItemByName(match[1]);
      if (!found) return `Couldn't find a menu item matching "${match[1]}".`;
      await setItemAvailability(found.categoryId, found.itemIndex, false);
      return `😔 Marked *${found.item.name}* sold out.`;
    },
  },
  {
    match: (msg, rawMsg) => rawMsg.trim().match(/^(instock|available)\s+(.+)/i),
    handler: async (match) => {
      const found = findMenuItemByName(match[2]);
      if (!found) return `Couldn't find a menu item matching "${match[2]}".`;
      await setItemAvailability(found.categoryId, found.itemIndex, true);
      return `✅ Marked *${found.item.name}* back in stock.`;
    },
  },
  {
    match: (msg) => msg === 'queue',
    handler: async () => {
      try {
        const { total, counts } = await getQueueSummary();
        const breakdown = Object.entries(counts).map(([status, n]) => `  ${status}: ${n}`).join('\n') || '  (nothing open)';
        return `📋 *${total} open order${total === 1 ? '' : 's'}*\n${breakdown}`;
      } catch (err) {
        console.error('QUEUE command failed:', err.message || err);
        return "Sorry, couldn't read the order queue right now — try again in a moment.";
      }
    },
  },
  {
    match: (msg) => msg === 'stats',
    handler: async () => {
      try {
        const { confirmedCount, topItems, peakHour } = await getOrderStats();
        const topItemsText = topItems.length > 0
          ? topItems.map(([name, n], i) => `  ${i + 1}. ${name} (${n})`).join('\n')
          : '  (no orders yet)';
        const peakHourText = peakHour === null ? 'n/a' : formatHour12(peakHour);
        return `📊 *Stats*\n\n*All-time confirmed orders:* ${confirmedCount}\n*Peak hour:* ${peakHourText}\n*Top items:*\n${topItemsText}\n\n*Since server start:*\n  Language picked: ${funnelCounters.languageSelected}\n  Checkout started: ${funnelCounters.checkoutStarted}\n  Carts abandoned (30+ min idle): ${funnelCounters.cartAbandoned}`;
      } catch (err) {
        console.error('STATS command failed:', err.message || err);
        return "Sorry, couldn't compute stats right now — try again in a moment.";
      }
    },
  },
];

async function processWhatsAppMessage(message, res) {
  const from = message.from; // bare digits with country code, e.g. "50161234567" — no '+', already validated above
  try {
    const session = getSession(from);
    session.lastMessageAt = Date.now();
    session.nudgeStage = 0; // any real inbound message clears pending idle-nudge state
    const knownLang = session.language;
    const bilingual = (en, es) => (knownLang === 'es' ? es : knownLang === 'en' ? en : `${en} / ${es}`);

    let rawMsg = '';

    if (message.type === 'text') {
      rawMsg = ((message.text && message.text.body) || '').trim();
    } else if (message.type === 'interactive') {
      // Button/list taps arrive here instead of as typed text. Reply/row ids
      // are deliberately chosen (see the *ButtonsMessage/*ListMessage builders)
      // to equal the exact tokens the switch statement below already accepts
      // from free text (category id, item index, size key, "pickup"/"delivery",
      // "yes"/"no") — so feeding the id in as rawMsg needs no other changes.
      const inter = message.interactive || {};
      rawMsg = (inter.button_reply && inter.button_reply.id) || (inter.list_reply && inter.list_reply.id) || '';
    } else if (message.type === 'audio') {
      const mediaId = message.audio && message.audio.id;
      const mimeType = (message.audio && message.audio.mime_type) || '';

      try {
        const transcript = await transcribeVoiceNote(mediaId, mimeType);
        if (!transcript) {
          return sendReply(res, from, bilingual(
            "Sorry, I couldn't quite catch that — could you try speaking slowly and clearly, or just type it instead? 🙏",
            'Lo sentimos, no logré entender bien eso — ¿puedes hablar despacio y claro, o prefieres escribirlo? 🙏'
          ));
        }
        rawMsg = transcript;
        console.log(`Transcribed voice note from ${from}: "${rawMsg}"`);
      } catch (transcribeErr) {
        console.error('Voice transcription failed:', transcribeErr);
        return sendReply(res, from, bilingual(
          'Sorry, I had trouble with that voice message — could you try typing it instead? 🙏',
          'Lo sentimos, tuve problemas con el mensaje de voz — ¿puedes escribirlo? 🙏'
        ));
      }
    } else {
      return sendReply(res, from, bilingual(
        'Sorry, I can only handle text and voice messages right now — please type instead. 🙏',
        'Lo siento, solo puedo procesar mensajes de texto y voz por ahora — por favor escribe tu mensaje. 🙏'
      ));
    }

    // Unicode-normalize before ANY comparison. Every accented literal in this
    // file ('atrás', 'menú', 'sí', 'español') is precomposed (NFC), but iOS/
    // Android keyboards and voice transcription can emit the decomposed (NFD)
    // form — visually identical, different bytes, so a correctly-typed
    // "atrás" would match nothing and fall through to an AI call plus "no
    // entendí eso". Normalizing rawMsg itself (not just `msg`) also keeps
    // stored notes/addresses in one consistent form.
    rawMsg = rawMsg.normalize('NFC');
    let msg = rawMsg.toLowerCase();
    const isFreeform = message.type === 'text' || message.type === 'audio'; // structured button/list taps don't carry frustration signals the same way

    console.log(`Message from ${from}: ${rawMsg}`);
    pushTranscript(from, 'customer', rawMsg);

    // ---- OWNER COMMANDS (Phase 5) ----
    // Checked before anything else, regardless of the owner's own session
    // state (language picked or not, mid-order or not) — these are
    // administrative overrides, not part of the customer conversation flow.
    // English-only replies: this is a staff tool, not customer-facing UX.
    // See OWNER_COMMANDS above for the actual command table.
    if (isOwner(from)) {
      for (const cmd of OWNER_COMMANDS) {
        const match = cmd.match(msg, rawMsg);
        if (match) {
          const replyText = await cmd.handler(match);
          return sendReply(res, from, replyText);
        }
      }
    }

    if (msg === 'cancel' || msg === 'cancelar') {
      const lang = session.language || 'en';
      delete savedCarts[from];
      resetSessionKeepingLanguage(from);
      return sendReply(res, from, lang === 'es'
        ? 'Orden cancelada ❌. Escribe *menú* para empezar de nuevo.'
        : 'Order cancelled ❌. Type *menu* to start over.');
    }

    if (!session.language) {
      if (msg === '1' || msg === 'english' || msg === 'en') {
        session.language = 'en';
        session.step = 'menu';
        funnelCounters.languageSelected++;
        return sendReply(res, from, [withClosedBanner(welcomeText('en'), 'en'), menuButtonMessage('en')]);
      }
      if (msg === '2' || msg === 'español' || msg === 'espanol' || msg === 'es') {
        session.language = 'es';
        session.step = 'menu';
        funnelCounters.languageSelected++;
        return sendReply(res, from, [withClosedBanner(welcomeText('es'), 'es'), menuButtonMessage('es')]);
      }
      // Only auto-picks on a strong, unambiguous signal — a bare "hi" or a
      // stray number stays with the explicit picker rather than risk
      // guessing wrong. *language* remains available anytime to switch.
      const detected = detectLanguage(rawMsg);
      if (detected) {
        session.language = detected;
        session.step = 'menu';
        funnelCounters.languageSelected++;
        return sendReply(res, from, [withClosedBanner(welcomeText(detected), detected), menuButtonMessage(detected)]);
      }
      return sendReply(res, from, languageButtonsMessage());
    }
    const lang = session.language;
    const t = TXT[lang];

    // ---- RESUME OFFER (abandoned cart from a prior session) ----
    // Set by sweepIdleSessions() when a session with items expires (~30 min
    // idle) — it saves the cart to savedCarts[from] and flags this session
    // pendingResume so the very next message, whenever it arrives, is
    // treated as an answer to "want to continue?" instead of guessed at.
    if (session.pendingResume) {
      const saved = savedCarts[from];
      if (!saved) {
        session.pendingResume = false; // stale flag, nothing to resume — fall through to normal handling
      } else if (msg === 'yes' || msg === 'si' || msg === 'sí' || msg === 'resume' || msg === 'continuar') {
        const soldOutLines = [];
        const restoredCart = [];
        saved.cart.forEach(item => {
          if (item.categoryId != null && item.itemIndex != null && isItemSoldOut(item.categoryId, item.itemIndex)) {
            soldOutLines.push(t.soldOutItem(item.name, suggestSubstitute(item.categoryId, item.itemIndex)));
          } else {
            restoredCart.push(item);
          }
        });
        // NOTE: the abandoned-cart win-back message still goes out (~1hr
        // after a cart is saved), but it no longer offers money off — the
        // discount was removed by business decision. Restored lines keep
        // their normal menu prices.
        session.cart = restoredCart;
        session.mode = saved.mode;
        session.address = saved.address;
        session.step = 'menu';
        session.pendingResume = false;
        delete savedCarts[from];
        const bits = [];
        if (soldOutLines.length > 0) bits.push(soldOutLines.join('\n'));
        bits.push(t.resumeRestored(cartText(session.cart, lang)));
        return sendReply(res, from, [bits.join('\n\n'), ...categoryListMessages(lang)]);
      } else if (msg === 'menu' || msg === 'menú' || msg === 'no' || msg === 'cancel' || msg === 'cancelar') {
        session.pendingResume = false;
        delete savedCarts[from];
        // Don't return — let the normal "menu"/global handling below run too.
      } else {
        return sendReply(res, from, resumeChoiceMessage(lang, t.resumeOffer));
      }
    }

    // ---- NATURAL-LANGUAGE COMMAND FALLBACK ----
    // Maps prose like "eso es todo" or "where's my order" onto the canonical
    // keyword the handlers below already accept, for customers who never
    // read the command glossary. Placed HERE deliberately: after the resume
    // offer (so a "yes"/"menu" answer to it isn't reinterpreted) but before
    // help/agent/status/menu, which are global commands — resolving any
    // later would leave those unreachable by prose.
    //
    // Only at the browsing steps: everywhere else free text is the answer to
    // a specific question, and treating it as a command would swallow real
    // content (the same class of bug that once saved a note as an address).
    // Skipped for interactive taps and bare numbers, which are unambiguous
    // already — so this can only ADD understanding, never change existing
    // behavior.
    if ((session.step === 'menu' || session.step === 'item')
      && message.type !== 'interactive' && !/^\d+$/.test(msg)) {
      const natural = resolveNaturalCommand(rawMsg);
      if (natural && natural !== msg) {
        console.log(`Natural-language command: "${rawMsg}" -> ${natural}`);
        msg = natural;
        // 'cancel' is handled by a global check that already ran above, so
        // the prose form has to be honoured here instead of falling through
        // to a step handler that doesn't know the word.
        if (msg === 'cancel') {
          delete savedCarts[from];
          resetSessionKeepingLanguage(from);
          return sendReply(res, from, lang === 'es'
            ? 'Orden cancelada ❌. Escribe *menú* para empezar de nuevo.'
            : 'Order cancelled ❌. Type *menu* to start over.');
        }
      }
    }

    if (msg === 'language' || msg === 'idioma' || msg === 'lang') {
      session.language = null;
      session.step = 'language';
      return sendReply(res, from, languageButtonsMessage());
    }

    if (msg === 'help' || msg === 'ayuda') {
      // howToOrder no longer carries the menu inline (it used to) — pair it
      // with the same menu-access button the language-selection reply
      // already sends, so "help" doesn't leave a confused customer with
      // instructions but no visible way to actually reach the menu.
      // Uses helpText() (the full command glossary), not welcomeText() (the
      // trimmed first-contact version) — help is exactly the moment someone
      // wants the complete reference.
      return sendReply(res, from, [helpText(lang), menuButtonMessage(lang)]);
    }

    if (msg === 'agent' || msg === 'agente' || msg === 'human' || msg === 'humano') {
      escalateToHuman(from, session, lang, 'Customer requested a human agent.');
      session.escalationStage = 3; // don't also auto-escalate again this session — they've already been connected
      return sendReply(res, from, t.agentRequested(SHOP_INFO.phone));
    }

    if (msg === 'status' || msg === 'estado') {
      const last = lastOrders[from];
      if (!last || !last.orderNumber) {
        return sendReply(res, from, t.noPreviousOrder);
      }
      try {
        const rows = await fetchManagerRows();
        let foundStatus = null;
        // Match by BOTH order number AND phone — order numbers are random
        // 4-digit values (~9000 possible), so matching by number alone risks
        // showing this customer a DIFFERENT customer's status on a collision.
        // Same rule cancelOrderInSheet already follows, for the same reason.
        for (const row of rows) {
          const [orderNumber, , , , , , phoneCell, statusCell] = row;
          if (String(orderNumber) === String(last.orderNumber) && normalizePhoneDigits(phoneCell) === String(from)) {
            foundStatus = (statusCell || 'Confirmed').trim();
          }
        }
        return sendReply(res, from, t.statusReply(last.orderNumber, foundStatus || 'Confirmed'));
      } catch (err) {
        console.error('Status lookup failed:', err.message || err);
        return sendReply(res, from, t.statusUnavailable(SHOP_INFO.phone));
      }
    }

    if (msg === 'cancel order' || msg === 'cancel my order' || msg === 'cancelar orden' || msg === 'cancelar mi orden' || msg === 'cancelar pedido') {
      const last = lastOrders[from];
      const withinWindow = last && last.confirmedAt && (Date.now() - last.confirmedAt) < ORDER_CANCEL_WINDOW_MS;
      if (!withinWindow) {
        return sendReply(res, from, t.cancelWindowClosed(SHOP_INFO.phone));
      }
      try {
        const found = await cancelOrderInSheet(last.orderNumber, from);
        if (!found) {
          return sendReply(res, from, t.cancelOrderNotFound(SHOP_INFO.phone));
        }
        if (last.mode === 'delivery') {
          notifyAllDrivers(`❌ Order #${last.orderNumber} was cancelled by the customer (within the 3-minute window).`);
        }
        const cancelledOrderNumber = last.orderNumber;
        delete lastOrders[from]; // one cancel per confirmed order — prevents a second cancel attempt on an already-cancelled order
        return sendReply(res, from, t.orderCancelledConfirmed(cancelledOrderNumber));
      } catch (err) {
        console.error('Order cancel failed:', err.message || err);
        return sendReply(res, from, t.cancelOrderNotFound(SHOP_INFO.phone));
      }
    }

    // Skipped during 'notes' (per-item note, e.g. "note: extra spicy") and
    // 'address' (a delivery address very plausibly starts with "note" as
    // natural instructions, e.g. "note house behind the blue gate, ring
    // bell twice") — both steps already treat ALL free text as that step's
    // own answer, so this global command would otherwise silently swallow
    // it: the customer sees a friendly "saved!" reply and thinks their
    // answer went through, but session.step never advances and checkout
    // gets stuck without them realizing why.
    if (session.step !== 'notes' && session.step !== 'address' && /^(note|nota)\s+\S/i.test(rawMsg.trim())) {
      const noteText = rawMsg.trim().replace(/^(note|nota)\s+/i, '').slice(0, 200);
      // Fire-and-forget, same as the delivery-address save below —
      // saveCustomerProfile updates the in-memory customerProfiles cache
      // synchronously before its own network write, so the customer doesn't
      // need to wait on a Sheets round-trip just to see "note saved".
      saveCustomerProfile(from, { notes: noteText }).catch(err => console.error(`Failed to save note for ${from}:`, err.message || err));
      return sendReply(res, from, t.noteSaved);
    }

    if (msg === 'hola' || msg === 'hi' || msg === 'hello' || msg === 'menu' || msg === 'menú' || msg === 'start') {
      session.step = 'menu';
      const messages = [withClosedBanner('', lang), ...categoryListMessages(lang)];
      if (session.cart.length === 0 && lastOrders[from] && lastOrders[from].cart && lastOrders[from].cart.length > 0) {
        messages.push(reorderUsualButtonMessage(lang));
      }
      return sendReply(res, from, messages);
    }

    // ---- STALE/CROSS-CONTEXT BUTTON TAPS ----
    // WhatsApp never expires old interactive messages — a customer can
    // scroll up and tap a category/item/size button from EARLIER in the
    // conversation at any time, long after the bot's internally moved on
    // to tracking a different category or step. Free-typed numbers stay
    // interpreted relative to whatever step the customer is currently on
    // (typing "1" while being asked for a quantity must still mean
    // quantity=1) — but a genuine button/list TAP carries a self-
    // describing id ("cat:8", "item:8:3", "size:6:1:2" — see
    // categoryListMessages/categoryItemsListMessage/sizeButtonsMessage)
    // specifically so it ALWAYS routes to the right place regardless of
    // current step, instead of being silently misread as an item number in
    // whatever category the session happens to currently be tracking (the
    // exact real-world bug this was built to fix — a customer tapped an
    // old category button and either got the wrong item added with no
    // error, or "Item number not found" if the id didn't happen to
    // resolve to a valid index in the current category). Only fires for
    // message.type === 'interactive' — never for typed text, which keeps
    // its existing step-relative meaning untouched. An id from a message
    // sent before this fix shipped (bare "1".."11", no prefix) simply
    // won't match any of these patterns and falls through to the normal
    // per-step handling below, same as it always has.
    if (message.type === 'interactive') {
      const catMatch = msg.match(/^cat:(\d+)$/);
      const itemMatch = msg.match(/^item:(\d+):(\d+)$/);
      const sizeMatch = msg.match(/^size:(\d+):(\d+):(\w+)$/);

      if (catMatch) {
        const cat = MENU.find(c => c.id === catMatch[1]);
        if (cat) {
          session.currentCategory = cat.id;
          session.step = 'item';
          return sendReply(res, from, categoryItemsListMessage(cat, lang));
        }
      } else if (itemMatch) {
        const cat = MENU.find(c => c.id === itemMatch[1]);
        const itemIndex = parseInt(itemMatch[2], 10);
        const item = cat && cat.items[itemIndex - 1];
        if (cat && item) {
          session.currentCategory = cat.id;
          if (isItemSoldOut(cat.id, itemIndex)) {
            session.step = 'item';
            return sendReply(res, from, [t.soldOutItem(item.name, suggestSubstitute(cat.id, itemIndex)), categoryItemsListMessage(cat, lang)]);
          }
          session.pendingItem = item;
          session.pendingCategoryId = cat.id;
          session.pendingItemIndex = itemIndex;
          if (item.sizes) {
            session.step = 'size';
            return sendReply(res, from, sizeButtonsMessage(item, lang, cat.id, itemIndex));
          }
          session.step = 'quantity';
          return sendReply(res, from, t.askQty(item.name, item.price.toFixed(2), MAX_QTY));
        }
      } else if (sizeMatch) {
        const cat = MENU.find(c => c.id === sizeMatch[1]);
        const itemIndex = parseInt(sizeMatch[2], 10);
        const item = cat && cat.items[itemIndex - 1];
        const size = item && item.sizes && item.sizes.find(s => s.key === sizeMatch[3]);
        if (cat && item && size) {
          session.currentCategory = cat.id;
          if (isItemSoldOut(cat.id, itemIndex)) {
            session.step = 'item';
            return sendReply(res, from, [t.soldOutItem(item.name, suggestSubstitute(cat.id, itemIndex)), categoryItemsListMessage(cat, lang)]);
          }
          session.pendingItem = item;
          session.pendingCategoryId = cat.id;
          session.pendingItemIndex = itemIndex;
          session.pendingSize = size;
          session.step = 'quantity';
          return sendReply(res, from, t.askQty(`${item.name} (${size.label})`, size.price.toFixed(2), MAX_QTY));
        }
      }
    }

    let reply = '';
    let parseFailed = false; // set true at each "didn't understand" branch below — see the frustration-scoring block after the switch

    switch (session.step) {
      case 'menu': {
        const cat = MENU.find(c => c.id === msg);
        if (cat) {
          session.currentCategory = cat.id;
          session.step = 'item';
          reply = categoryItemsListMessage(cat, lang);
        } else if (msg === 'cart' || msg === 'carrito') {
          reply = cartText(session.cart, lang);
        } else if (msg === 'repeat' || msg === 'repetir') {
          reply = buildRepeatReply(from, session, lang);
        } else if (msg === 'done' || msg === 'listo' || msg === 'checkout') {
          reply = tryCheckout(session, lang, categoryListMessages(lang));
        } else {
          const faqKey = matchFAQKeyword(msg);
          if (faqKey) {
            reply = `${faqAnswer(faqKey, lang)}\n\n${t.humanHelp(SHOP_INFO.phone)}`;
            break;
          }

          // A craving or recommendation request is a browsing question, not
          // an order — answer it BEFORE the AI order-parser gets a chance to
          // guess a single item and silently drop it in the cart. Only fires
          // on phrasing that actually signals one, so "2 mango smoothies"
          // still orders normally. Also cheaper and more reliable than the
          // AI path: it works even when Gemini is rate-limited or down.
          if (CRAVING_RE.test(rawMsg) || GENERAL_RECOMMEND_RE.test(rawMsg)) {
            // A named flavor wins — "what do you recommend that's mango"
            // should answer with mango, not with best-sellers.
            const hits = findItemsByCraving(rawMsg);
            if (hits.length > 0) {
              reply = recommendationMessage(hits, lang);
              break;
            }
            if (GENERAL_RECOMMEND_RE.test(rawMsg)) {
              const { hits: recs, fromHistory } = await findRecommendedItems();
              if (recs.length > 0) {
                reply = recommendationMessage(recs, lang, { popular: fromHistory, spread: !fromHistory });
                break;
              }
            }
          }

          const orderResult = await attemptFreeOrder(rawMsg, session);

          if (orderResult.added.length > 0 || orderResult.soldOut.length > 0) {
            // Two separate bubbles: the cart/sold-out update, then a dedicated
            // nudge asking if they want more or are ready to confirm/checkout.
            reply = [
              orderResultText(orderResult, session, lang),
              confirmNudgeMessage(lang),
              ...categoryListMessages(lang),
            ];
          } else if (orderResult.answer) {
            // Not a recognized order — fall back to the FAQ-style AI answer
            // attemptFreeOrder already got from the same call.
            reply = `${orderResult.answer}\n\n${t.humanHelp(SHOP_INFO.phone)}`;
          } else {
            // Last chance before giving up: if anything on the menu relates
            // to what they said, suggest it rather than replying "I didn't
            // understand". Someone who typed a flavor we couldn't parse into
            // an order is still telling us what they're in the mood for.
            const hits = findItemsByCraving(rawMsg);
            if (hits.length > 0) {
              reply = recommendationMessage(hits, lang);
            } else {
              parseFailed = true;
              reply = stuckHelpMessage(lang);
            }
          }
        }
        break;
      }

      case 'item': {
        const cat = MENU.find(c => c.id === session.currentCategory);

        if (msg === '0' || msg === 'atras' || msg === 'atrás' || msg === 'back') {
          session.step = 'menu';
          reply = categoryListMessages(lang);
          break;
        }

        // Same shortcuts as the top-level menu step — needed here now that
        // adding an item keeps them inside the category (see the 'notes'
        // case) instead of bouncing back out to the category list each time,
        // so "done"/"cart" must work mid-category too.
        if (msg === 'cart' || msg === 'carrito') {
          reply = [cartText(session.cart, lang), categoryItemsListMessage(cat, lang)];
          break;
        }

        if (msg === 'done' || msg === 'listo' || msg === 'checkout') {
          reply = tryCheckout(session, lang, [categoryItemsListMessage(cat, lang)]);
          break;
        }

        // The help glossary advertises *repeat*/*repetir* unconditionally,
        // but it was only wired into the 'menu' case — and after every add
        // the customer is parked HERE, in 'item', which is exactly where
        // they'd reach for it. Shares buildRepeatReply with the 'menu' case
        // rather than duplicating its sold-out/cart-cap handling. (Not a
        // recursive re-dispatch: that would re-run the dedup/transcript
        // preamble and drop the message as an id it had already seen.)
        if (msg === 'repeat' || msg === 'repetir') {
          session.step = 'menu';
          reply = buildRepeatReply(from, session, lang);
          break;
        }

        const bulkMatch = msg.match(/^(\d+)\s*[x*]\s*(\d+)$/i);
        if (bulkMatch) {
          const itemIndex = parseInt(bulkMatch[1], 10) - 1;
          const qty = parseInt(bulkMatch[2], 10);
          const item = cat && cat.items[itemIndex];

          if (!item) {
            parseFailed = true;
            reply = [t.itemNotFound, categoryItemsListMessage(cat, lang)];
          } else if (isItemSoldOut(cat.id, itemIndex + 1)) {
            reply = [t.soldOutItem(item.name, suggestSubstitute(cat.id, itemIndex + 1)), categoryItemsListMessage(cat, lang)];
          } else if (qty < 1 || qty > MAX_QTY) {
            reply = [t.qtyRange(MAX_QTY), categoryItemsListMessage(cat, lang)];
          } else {
            const name = item.sizes ? `${item.name} (${item.sizes[0].label})` : item.name;
            const price = item.sizes ? item.sizes[0].price : item.price;
            if (!addToCart(session.cart, name, price, qty, '', cat.id, itemIndex + 1)) {
              reply = [t.cartFull, categoryItemsListMessage(cat, lang)];
              break;
            }
            session.step = 'menu';
            reply = [
              t.added(`${name} x${qty} - $${(price * qty).toFixed(2)}`, cartTotal(session.cart).toFixed(2)),
              confirmNudgeMessage(lang),
              ...categoryListMessages(lang),
            ];
          }
          break;
        }

        const index = parseInt(msg, 10) - 1;
        const item = cat && cat.items[index];

        if (item && isItemSoldOut(cat.id, index + 1)) {
          reply = [t.soldOutItem(item.name, suggestSubstitute(cat.id, index + 1)), categoryItemsListMessage(cat, lang)];
        } else if (item) {
          session.pendingItem = item;
          session.pendingCategoryId = cat.id;
          session.pendingItemIndex = index + 1;
          if (item.sizes) {
            session.step = 'size';
            reply = sizeButtonsMessage(item, lang, cat.id, index + 1);
          } else {
            session.step = 'quantity';
            reply = t.askQty(item.name, item.price.toFixed(2), MAX_QTY);
          }
        } else {
          // Not a valid item number — could be a question (hours, payment,
          // delivery...) or a whole new order. Cheap keyword match first
          // (same shortcut the 'menu' step uses) so a payment/hours
          // question mid-category gets answered instantly instead of
          // silently falling through to "item not found" — that used to
          // happen here even when attemptFreeOrder's AI fallback DID
          // generate a correct answer, because this branch only ever
          // checked added/soldOut and threw the answer away.
          const faqKey = matchFAQKeyword(msg);
          const orderResult = faqKey ? null : await attemptFreeOrder(rawMsg, session);
          if (faqKey) {
            reply = [faqAnswer(faqKey, lang), categoryItemsListMessage(cat, lang)];
          } else if (orderResult.added.length > 0 || orderResult.soldOut.length > 0) {
            reply = [orderResultText(orderResult, session, lang), categoryItemsListMessage(cat, lang)];
          } else if (orderResult.answer) {
            reply = [orderResult.answer, categoryItemsListMessage(cat, lang)];
          } else {
            parseFailed = true;
            reply = [t.itemNotFound, categoryItemsListMessage(cat, lang)];
          }
        }
        break;
      }

      case 'size': {
        const item = session.pendingItem;
        const cat = MENU.find(c => c.id === session.currentCategory);

        if (msg === '0' || msg === 'atras' || msg === 'atrás' || msg === 'back') {
          session.pendingItem = null;
          session.pendingSize = null;
          session.step = 'item';
          reply = categoryItemsListMessage(cat, lang);
          break;
        }

        const size = matchSizeChoice(msg, item.sizes);
        if (!size) {
          // Not a valid size reply — check for a quick FAQ match first (see
          // the identical fix in the 'item' case above for why), then try
          // it as a new/extra order, then re-ask the size question so the
          // original item isn't lost.
          const faqKey = matchFAQKeyword(msg);
          const orderResult = faqKey ? null : await attemptFreeOrder(rawMsg, session);
          if (faqKey) {
            reply = [faqAnswer(faqKey, lang), sizeButtonsMessage(item, lang, session.pendingCategoryId, session.pendingItemIndex)];
          } else if (orderResult.added.length > 0 || orderResult.soldOut.length > 0) {
            reply = [orderResultText(orderResult, session, lang), sizeButtonsMessage(item, lang, session.pendingCategoryId, session.pendingItemIndex)];
          } else if (orderResult.answer) {
            reply = [orderResult.answer, sizeButtonsMessage(item, lang, session.pendingCategoryId, session.pendingItemIndex)];
          } else {
            parseFailed = true;
            reply = [t.invalidSize, sizeButtonsMessage(item, lang, session.pendingCategoryId, session.pendingItemIndex)];
          }
        } else {
          session.pendingSize = size;
          session.step = 'quantity';
          reply = t.askQty(`${item.name} (${size.label})`, size.price.toFixed(2), MAX_QTY);
        }
        break;
      }

      case 'quantity': {
        const cat = MENU.find(c => c.id === session.currentCategory);

        if (msg === '0' || msg === 'atras' || msg === 'atrás' || msg === 'back') {
          session.pendingItem = null;
          session.pendingSize = null;
          session.step = 'item';
          reply = categoryItemsListMessage(cat, lang);
          break;
        }

        // Stale-tap guard, same family as the 'notes'/'address' steps below.
        // Nothing is corrupted here (a non-numeric id just fails the check
        // below), but without this a tapped id burned a real Gemini call via
        // attemptFreeOrder before landing on "that's not a valid quantity".
        if (message.type === 'interactive' && !/^\d+$/.test(msg)) {
          const pending = session.pendingItem;
          const pendingSize = session.pendingSize;
          reply = t.askQty(
            pendingSize ? `${pending.name} (${pendingSize.label})` : pending.name,
            (pendingSize ? pendingSize.price : pending.price).toFixed(2),
            MAX_QTY
          );
          break;
        }

        const qty = parseInt(msg, 10);
        if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY || !/^\d+$/.test(msg)) {
          // Not a valid quantity — check for a quick FAQ match first (see
          // the identical fix in the 'item' case above for why), then try
          // it as a new/extra order, then re-ask the quantity question so
          // the pending item isn't lost.
          const item = session.pendingItem;
          const size = session.pendingSize;
          const label = size ? `${item.name} (${size.label})` : item.name;
          const price = size ? size.price : item.price;
          const faqKey = matchFAQKeyword(msg);
          const orderResult = faqKey ? null : await attemptFreeOrder(rawMsg, session);
          if (faqKey) {
            reply = `${faqAnswer(faqKey, lang)}\n\n` + t.askQty(label, price.toFixed(2), MAX_QTY);
          } else if (orderResult.added.length > 0 || orderResult.soldOut.length > 0) {
            reply = `${orderResultText(orderResult, session, lang)}\n\n` + t.askQty(label, price.toFixed(2), MAX_QTY);
          } else if (orderResult.answer) {
            reply = `${orderResult.answer}\n\n` + t.askQty(label, price.toFixed(2), MAX_QTY);
          } else {
            parseFailed = true;
            reply = t.invalidQty(MAX_QTY);
          }
        } else {
          session.pendingQty = qty;
          session.step = 'notes';
          reply = notesButtonsMessage(lang);
        }
        break;
      }

      case 'notes': {
        const item = session.pendingItem;
        const size = session.pendingSize;
        const qty = session.pendingQty;
        const name = size ? `${item.name} (${size.label})` : item.name;
        const price = size ? size.price : item.price;

        if (msg === 'atras' || msg === 'atrás' || msg === 'back') {
          // NOTE: '0' is deliberately excluded here — it already means "no
          // note" for this step (see noNoteWords below), so treating it as
          // "go back" too would silently break that existing shorthand.
          session.step = 'quantity';
          reply = t.askQty(name, price.toFixed(2), MAX_QTY);
          break;
        }

        const noNoteWords = ['none', 'no', 'ninguno', 'ninguna', 'nada', 'n/a', 'na', '0'];
        const isNoNote = noNoteWords.includes(msg);

        // A button/list TAP can never BE this item's note — the customer
        // typed nothing. WhatsApp never expires old interactive messages, so
        // any other id reaching here is a stale tap on an earlier message
        // (e.g. the "Done ✅" button from the add-more nudge, or a mode/
        // confirm button from a previous order). Without this guard that id
        // was silently stored as the note text and printed on the kitchen
        // ticket — a real "Vanilla Bean [done] x2" was reproduced this way.
        // Free-typed text is untouched: it arrives as message.type 'text'.
        if (!isNoNote && message.type === 'interactive') {
          reply = notesButtonsMessage(lang);
          break;
        }

        const note = isNoNote ? '' : rawMsg.trim().slice(0, 60);

        const added = addToCart(session.cart, name, price, qty, note, session.pendingCategoryId, session.pendingItemIndex);
        // Land back on this SAME category's item list (not the top-level
        // category list) so picking several items from one category — e.g.
        // three different drinks, each with its own note — doesn't require
        // re-tapping the category button every single time.
        const cat = MENU.find(c => c.id === session.pendingCategoryId);
        session.currentCategory = session.pendingCategoryId;
        session.pendingItem = null;
        session.pendingSize = null;
        session.pendingQty = null;
        session.pendingCategoryId = null;
        session.pendingItemIndex = null;
        session.step = 'item';

        if (!added) {
          reply = [t.cartFull, categoryItemsListMessage(cat, lang)];
          break;
        }

        const noteStr = note ? ` [${note}]` : '';
        reply = [
          t.added(`${name}${noteStr} x${qty} - $${(price * qty).toFixed(2)}`, cartTotal(session.cart).toFixed(2)),
          confirmNudgeMessage(lang),
          categoryItemsListMessage(cat, lang),
        ];
        break;
      }

      case 'mode': {
        if (msg === '0' || msg === 'atras' || msg === 'atrás' || msg === 'back') {
          session.step = 'menu';
          reply = [cartText(session.cart, lang), ...categoryListMessages(lang)];
          break;
        }
        if (msg.includes('pickup') || msg.includes('pick up') || msg.includes('recoger')) {
          session.mode = 'pickup';
          session.step = 'confirm';
          reply = [cartText(session.cart, lang), confirmButtonsMessage(t.pickupConfirm, lang)];
        } else if (msg.includes('delivery') || msg.includes('entrega')) {
          session.mode = 'delivery';
          session.step = 'address';
          const savedAddr = getSavedAddress(from);
          reply = savedAddr ? savedAddressButtonsMessage(savedAddr, lang) : t.askAddress(SHOP_INFO.deliveryFee);
        } else {
          // Didn't say pickup/delivery — check for a quick FAQ match first
          // (see the identical fix in the 'item' case above for why), then
          // maybe they're adding one more item first.
          const faqKey = matchFAQKeyword(msg);
          const orderResult = faqKey ? null : await attemptFreeOrder(rawMsg, session);
          if (faqKey) {
            reply = [faqAnswer(faqKey, lang), modeButtonsMessage(SHOP_INFO.deliveryFee, lang)];
          } else if (orderResult.added.length > 0 || orderResult.soldOut.length > 0) {
            reply = [orderResultText(orderResult, session, lang), cartText(session.cart, lang), modeButtonsMessage(SHOP_INFO.deliveryFee, lang)];
          } else if (orderResult.answer) {
            reply = [orderResult.answer, modeButtonsMessage(SHOP_INFO.deliveryFee, lang)];
          } else {
            parseFailed = true;
            reply = t.askModeInvalid;
          }
        }
        break;
      }

      case 'address': {
        if (msg === '0' || msg === 'atras' || msg === 'atrás' || msg === 'back') {
          session.step = 'mode';
          reply = modeButtonsMessage(SHOP_INFO.deliveryFee, lang);
          break;
        }
        const savedAddr = getSavedAddress(from);
        if (msg === 'use_saved_address' && savedAddr) {
          session.address = savedAddr;
          session.step = 'confirm';
          reply = [cartText(session.cart, lang), confirmButtonsMessage(t.deliveryConfirm(session.address), lang)];
          break;
        }
        if (msg === 'new_address') {
          reply = t.askAddress(SHOP_INFO.deliveryFee); // stay in 'address', re-ask plainly
          break;
        }
        // Same stale-tap guard as the 'notes' step above, and higher stakes
        // here: an unhandled button id used to become the literal delivery
        // address ("done"), advance straight to confirm, AND get written
        // through to the customer's saved profile — so a real driver could
        // be dispatched to "done" and the bad address would be re-offered on
        // every future order. Only 'text'/'audio' messages are real answers
        // to "what's the address?".
        if (message.type === 'interactive') {
          reply = savedAddr ? savedAddressButtonsMessage(savedAddr, lang) : t.askAddress(SHOP_INFO.deliveryFee);
          break;
        }
        // Capped, same reasoning as the per-item note cap above — this text
        // goes straight into a real driver's WhatsApp notification and the
        // Manager sheet, uncapped it could be up to WhatsApp's own ~4096-
        // char message limit.
        session.address = rawMsg.trim().slice(0, MAX_ADDRESS_LENGTH);
        session.step = 'confirm';
        // Fire-and-forget write-through — saved for next time regardless of
        // whether THIS order goes on to be confirmed or cancelled; it's a
        // convenience cache, not tied to any one order's outcome.
        saveCustomerProfile(from, { savedAddress: rawMsg }).catch(err => console.error(`Failed to save address for ${from}:`, err.message || err));
        reply = [cartText(session.cart, lang), confirmButtonsMessage(t.deliveryConfirm(session.address), lang)];
        break;
      }

      case 'confirm': {
        if (msg === '0' || msg === 'atras' || msg === 'atrás' || msg === 'back') {
          session.step = session.mode === 'delivery' ? 'address' : 'mode';
          reply = session.mode === 'delivery' ? t.askAddress(SHOP_INFO.deliveryFee) : modeButtonsMessage(SHOP_INFO.deliveryFee, lang);
          break;
        }
        if ((msg === 'yes' || msg === 'si' || msg === 'sí' || msg === 'confirm' || msg === 'confirmo') && ordersPaused) {
          // Defense in depth: the 'done' checkout step already blocks on
          // this, but an owner could toggle PAUSE ORDERS while a customer
          // is already sitting at 'confirm' — don't let a stale "yes" slip
          // an order through after that.
          reply = t.ordersPausedMsg;
        } else if (msg === 'yes' || msg === 'si' || msg === 'sí' || msg === 'confirm' || msg === 'confirmo') {
          const recentOrder = lastOrders[from];
          const duplicateRisk = recentOrder && recentOrder.confirmedAt
            && (Date.now() - recentOrder.confirmedAt) < DUPLICATE_ORDER_WARNING_MS
            && !session.duplicateWarningAcked;
          if (duplicateRisk) {
            // Don't create the order yet — wait for a second explicit "yes"
            // now that they've seen the warning. Session stays at 'confirm'.
            session.duplicateWarningAcked = true;
            reply = t.duplicateOrderWarning(recentOrder.orderNumber);
            break;
          }

          const orderNumber = Math.floor(1000 + Math.random() * 9000);
          const isPreorder = !isShopOpen();
          session.isPreorder = isPreorder; // read by logOrderToSheets/notifyDriver below to tag the order
          reply = isPreorder
            ? t.orderConfirmedPreorder(orderNumber, SHOP_INFO.phone, nextOpeningText(lang))
            : t.orderConfirmed(orderNumber, SHOP_INFO.phone);

          console.log(`ORDER #${orderNumber} —`, JSON.stringify(session, null, 2));

          lastOrders[from] = {
            orderNumber,
            cart: session.cart.map(item => ({ ...item })),
            mode: session.mode,
            address: session.address,
            confirmedAt: Date.now(), // powers the 3-minute post-confirmation cancel window — see the "cancel order" command
          };

          // Fire-and-forget: Sheets logging and the staff notification both
          // run in the background WITHOUT being awaited here. The WhatsApp
          // confirmation must go out immediately regardless of how long
          // these take — same reasoning as the original Sheets-logging fix.
          logOrderToSheets(orderNumber, session, from).catch(err => {
            console.error('Background Sheets log failed:', err);
          });
          // EVERY confirmed order alerts staff by WhatsApp, not just
          // deliveries — a pickup order used to only land in the Sheet with
          // no notification at all, which was easy to miss if nobody
          // happened to be watching it right then.
          if (session.mode === 'delivery') {
            notifyDriver(orderNumber, session, from).catch(err => {
              console.error('Background driver notification failed:', err);
              alertOwner(`driver-notify-${orderNumber}`, `Order #${orderNumber} (delivery) confirmed but the driver notification FAILED to send: ${err.message || err}`);
            });
          } else {
            notifyOwnerOfPickupOrder(orderNumber, session, from).catch(err => {
              console.error('Background pickup-order notification failed:', err);
              alertOwner(`pickup-notify-${orderNumber}`, `Order #${orderNumber} (pickup) confirmed but the staff notification FAILED to send: ${err.message || err}`);
            });
          }

          // logOrderToSheets keeps reading from this `session` object across
          // its own internal awaits, which can still be in flight after the
          // lock for this sender has released. That's only safe because the
          // next line REPLACES sessions[from] with a new object rather than
          // mutating this one in place — the in-flight background call keeps
          // its own reference, untouched by whatever the next message does.
          // If this reset is ever changed to mutate in place (e.g.
          // Object.assign(session, newSession())), that safety goes away.
          // (resetSessionKeepingLanguage assigns a NEW object before setting
          // the preserved language on it, so it upholds that contract.)
          resetSessionKeepingLanguage(from);
        } else if (msg === 'no' || msg === 'cancel' || msg === 'cancelar') {
          resetSessionKeepingLanguage(from);
          reply = t.orderCancelled;
        } else {
          // Last chance to add something before confirming — cart isn't locked
          // in until they actually say yes.
          const orderResult = await attemptFreeOrder(rawMsg, session);
          if (orderResult.added.length > 0 || orderResult.soldOut.length > 0) {
            const reconfirm = session.mode === 'delivery'
              ? t.deliveryConfirm(session.address)
              : t.pickupConfirm;
            reply = [orderResultText(orderResult, session, lang), cartText(session.cart, lang), confirmButtonsMessage(reconfirm, lang)];
          } else {
            parseFailed = true;
            reply = t.confirmInvalid;
          }
        }
        break;
      }

      default: {
        session.step = 'menu';
        reply = categoryListMessages(lang);
      }
    }

    // ---- MOOD DETECTION / ESCALATION LADDER (Phase 2) ----
    // Only scored on genuine free-form input — see isFreeform above.
    if (isFreeform) {
      session.parseFailureStreak = parseFailed ? session.parseFailureStreak + 1 : 0;

      let signalScore = scoreFrustrationSignals(rawMsg);
      if (session.lastRawMsg && msg === session.lastRawMsg.toLowerCase() && msg.length > 0) signalScore += 2; // repeated identical message
      if (session.parseFailureStreak >= 2) signalScore += 3; // strongest signal per the spec — the bot failing to parse the same input twice
      session.frustrationScore = Math.max(0, session.frustrationScore - 1) + signalScore; // mild decay per calm message, quick rise on real signals
      session.lastRawMsg = rawMsg;

      // Two (or more) failed parses in a row: stop letting the AI keep
      // guessing — hand back a clear set of tappable options instead.
      // IMPORTANT: only offer buttons that are safe for the CURRENT step —
      // e.g. showing category buttons while stuck in 'quantity' would have
      // a tapped category id like "1" silently read as "quantity = 1"
      // instead of navigating, since session.step hasn't changed. Steps
      // that are inherently free-text (quantity/notes/address) get just the
      // text redirect toward MENU/AGENT, no buttons.
      if (session.parseFailureStreak >= 2) {
        let fallbackButtons = [];
        if (session.step === 'menu' || session.step === 'item') {
          fallbackButtons = categoryListMessages(lang);
        } else if (session.step === 'size' && session.pendingItem) {
          fallbackButtons = [sizeButtonsMessage(session.pendingItem, lang, session.pendingCategoryId, session.pendingItemIndex)];
        } else if (session.step === 'mode') {
          fallbackButtons = [modeButtonsMessage(SHOP_INFO.deliveryFee, lang)];
        } else if (session.step === 'confirm') {
          const reconfirm = session.mode === 'delivery' ? t.deliveryConfirm(session.address) : t.pickupConfirm;
          fallbackButtons = [confirmButtonsMessage(reconfirm, lang)];
        }
        reply = appendReply(reply, t.stopGuessing, ...fallbackButtons);
      }

      // One-way ratchet per session (escalationStage only moves up) so the
      // same rung doesn't re-fire every single message once crossed.
      if (session.frustrationScore >= FRUSTRATION_ESCALATE_THRESHOLD && session.escalationStage < 3) {
        session.escalationStage = 3;
        escalateToHuman(from, session, lang, 'Auto-escalated: customer seems frustrated.');
        reply = appendReply(reply, t.agentRequested(SHOP_INFO.phone));
      } else if (session.frustrationScore >= FRUSTRATION_SHORTCUT_THRESHOLD && session.escalationStage < 2) {
        session.escalationStage = 2;
        reply = appendReply(reply, t.frustrationShortcut);
      } else if (session.frustrationScore >= FRUSTRATION_SOFTEN_THRESHOLD && session.escalationStage < 1) {
        session.escalationStage = 1;
        reply = prependReply(reply, t.frustrationSoften);
      }
    }

    return sendReply(res, from, reply);
  } catch (err) {
    console.error('Webhook error:', err);
    // The webhook itself was already acked by the caller before this
    // function was ever invoked — this is just the best-effort customer
    // reply. sendReply's headersSent guard makes it safe either way. Now
    // that sendReply is a real async function (see its definition), this
    // is awaited so the returned promise — which withSessionLock and the
    // replay-test harness both rely on to know processing has actually
    // finished — doesn't resolve before this last-resort reply goes out.
    try {
      // Prefer the customer's already-known language (set on an earlier
      // turn) so a mid-conversation crash doesn't dump both languages at
      // once — only a crash before language is ever established falls
      // back to showing both.
      const knownLang = sessions[from] && sessions[from].language;
      const fallbackMsg = knownLang === 'es'
        ? 'Lo sentimos, hubo un error de nuestro lado — intenta de nuevo en un momento. 🙏'
        : knownLang === 'en'
          ? 'Sorry, something went wrong on our end — please try again in a moment. 🙏'
          : 'Sorry, something went wrong on our end — please try again in a moment. 🙏 / Lo sentimos, hubo un error — intenta de nuevo en un momento. 🙏';
      return await sendReply(res, from, fallbackMsg);
    } catch (e2) {
      console.error('Also failed to send the error reply:', e2);
    }
  }
}

// Meta requires this GET endpoint for initial webhook verification when you
// configure the webhook URL in the Chakra dashboard (if using the pass-through
// webhook option — Chakra's own "Chakra webhook" option doesn't need this,
// only the raw Meta pass-through does). Set WEBHOOK_VERIFY_TOKEN in .env to
// whatever you enter in the dashboard's verify-token field.
app.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.get('/', (req, res) => {
  res.send('WhatsApp bot is running.');
});

// ---- KITCHEN DASHBOARD ----
// A live order queue for a tablet in the kitchen. Deliberately writes status
// straight back to Manager!H, which means the EXISTING pollOrderStatus job
// picks the change up and messages the customer — no separate notification
// path to keep in sync. Status values must therefore match STATUS_MESSAGES's
// keys exactly (case-sensitive); KITCHEN_STATUSES below is the whitelist.
//
// Auth: one shared password (KITCHEN_PASSWORD) exchanged for a long-lived
// cookie, so staff type it once per device. This page exposes customer
// phone numbers and delivery addresses and can trigger real WhatsApp sends,
// so it is never left open — if KITCHEN_PASSWORD is unset the routes refuse
// to serve rather than defaulting to public.
const KITCHEN_STATUSES = ['Preparing', 'Ready for Pickup', 'Out for Delivery', 'Completed', 'Cancelled'];
const KITCHEN_COOKIE = 'kitchen_auth';

function kitchenPasswordHash() {
  return crypto.createHash('sha256').update(String(process.env.KITCHEN_PASSWORD || '')).digest('hex');
}

function kitchenAuthed(req) {
  if (!process.env.KITCHEN_PASSWORD) return false;
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(c => c.trim()).find(c => c.startsWith(`${KITCHEN_COOKIE}=`));
  if (!match) return false;
  const supplied = match.slice(KITCHEN_COOKIE.length + 1);
  const expected = kitchenPasswordHash();
  // Constant-time compare — this is a shared secret guarding customer PII.
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireKitchenAuth(req, res) {
  if (!process.env.KITCHEN_PASSWORD) {
    res.status(503).send('Kitchen dashboard is not configured — set KITCHEN_PASSWORD in the environment.');
    return false;
  }
  if (!kitchenAuthed(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

app.post('/kitchen/login', (req, res) => {
  if (!process.env.KITCHEN_PASSWORD) return res.status(503).json({ error: 'not configured' });
  const supplied = String((req.body && req.body.password) || '');
  const a = Buffer.from(crypto.createHash('sha256').update(supplied).digest('hex'));
  const b = Buffer.from(kitchenPasswordHash());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'wrong password' });
  }
  // 1 year — the whole point is that staff authenticate once per device.
  res.setHeader('Set-Cookie', `${KITCHEN_COOKIE}=${kitchenPasswordHash()}; Max-Age=31536000; Path=/kitchen; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

// Open orders, newest first. "Open" = anything not yet Completed/Cancelled.
app.get('/kitchen/orders', async (req, res) => {
  if (!requireKitchenAuth(req, res)) return;
  try {
    managerRowsCache = null; // the kitchen needs live data, not a 5s-stale copy
    const rows = await fetchManagerRows();
    const orders = rows.map((r, i) => {
      const [orderNumber, timestamp, items, total, mode, language, phone, status] = r;
      return {
        rowNum: i + 2, // sheet row (header is row 1) — used for the status write
        orderNumber, timestamp, items, total, mode, language, phone,
        status: (status || 'Confirmed').trim(),
      };
    }).filter(o => o.orderNumber && !['Completed', 'Cancelled'].includes(o.status));
    orders.reverse();
    res.json({ orders, statuses: KITCHEN_STATUSES });
  } catch (err) {
    console.error('Kitchen dashboard order fetch failed:', err.message || err);
    res.status(500).json({ error: 'could not load orders' });
  }
});

app.post('/kitchen/status', async (req, res) => {
  if (!requireKitchenAuth(req, res)) return;
  const { rowNum, orderNumber, status } = req.body || {};
  if (!KITCHEN_STATUSES.includes(status)) return res.status(400).json({ error: 'unknown status' });
  if (!Number.isInteger(rowNum) || rowNum < 2) return res.status(400).json({ error: 'bad row' });
  try {
    // Re-read and verify the row still holds the order the tablet thinks it
    // does before writing. Staff reorder and delete Manager rows routinely
    // (the same hazard documented on pollOrderStatus's cache key), so a row
    // number captured seconds ago can already point at a different order —
    // and writing blind would set a STRANGER's order status, firing a wrong
    // WhatsApp update to a real customer.
    const rows = await fetchManagerRows();
    const current = rows[rowNum - 2];
    if (!current || String(current[0]) !== String(orderNumber)) {
      return res.status(409).json({ error: 'This order moved in the sheet — refresh and try again.' });
    }
    await withSessionLock('__sheets_manager_kitchen_write__', async () => {
      await withTimeout(sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: `Manager!H${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[status]] },
      }), 6000);
    });
    managerRowsCache = null;
    console.log(`Kitchen dashboard: order #${orderNumber} -> ${status}`);
    // Notify immediately rather than waiting for pollOrderStatus's 60s
    // cycle. Staff commonly tap Preparing -> Out for Delivery -> Completed
    // within one window, and the poller only sees the final value — every
    // status in between used to be silently dropped. notifyStatusChange
    // records the status before sending, so the next poll won't repeat it.
    // Awaited so a failure surfaces to the tablet instead of vanishing.
    await notifyStatusChange({
      orderNumber: String(orderNumber),
      timestamp: current[1],
      status,
      language: current[5],
      phoneCell: current[6],
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Kitchen dashboard status update failed:', err.message || err);
    res.status(500).json({ error: 'could not update status' });
  }
});

// Self-contained: no CDN, no build step, works on an old tablet browser.
// Polls every 10s; a genuinely new order number triggers a sound + flash,
// because the whole point is that it's hard to miss during a rush.
const KITCHEN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kitchen — Créme De La Créme</title>
<style>
  :root { --bg:#12141a; --card:#1c1f28; --line:#2c3140; --text:#f2f4f8; --dim:#98a0b3;
          --new:#ffb020; --prep:#3b82f6; --ready:#22c55e; --deliver:#a855f7; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line);
           padding:14px 18px; display:flex; align-items:center; gap:14px; z-index:5; }
  h1 { font-size:19px; margin:0; font-weight:650; }
  .count { background:var(--new); color:#000; font-weight:700; border-radius:999px;
           padding:2px 11px; font-size:15px; }
  .muted { color:var(--dim); font-size:13px; margin-left:auto; }
  main { padding:16px; display:grid; gap:14px;
         grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-left:5px solid var(--new);
          border-radius:12px; padding:15px; }
  .card.s-Preparing { border-left-color:var(--prep); }
  .card.s-Ready { border-left-color:var(--ready); }
  .card.s-Out { border-left-color:var(--deliver); }
  .card.flash { animation:flash 1s ease-in-out 3; }
  @keyframes flash { 0%,100%{background:var(--card);} 50%{background:#3a2f12;} }
  .top { display:flex; align-items:baseline; gap:10px; margin-bottom:8px; }
  .num { font-size:23px; font-weight:700; }
  .time { color:var(--dim); font-size:13px; margin-left:auto; }
  .mode { font-size:14px; font-weight:600; margin-bottom:8px; }
  .items { white-space:pre-line; margin:10px 0; padding:10px; background:#161923;
           border-radius:8px; font-size:15px; }
  .meta { color:var(--dim); font-size:13px; margin:3px 0; word-break:break-word; }
  .status { display:inline-block; font-size:12px; font-weight:700; text-transform:uppercase;
            letter-spacing:.04em; color:var(--dim); margin-bottom:9px; }
  .btns { display:flex; flex-wrap:wrap; gap:7px; margin-top:11px; }
  button { font:inherit; font-size:14px; font-weight:600; border:1px solid var(--line);
           background:#252a36; color:var(--text); border-radius:8px; padding:9px 13px;
           cursor:pointer; min-height:42px; }
  button:hover { background:#2f3543; }
  button:disabled { opacity:.45; cursor:default; }
  button.go { background:var(--ready); color:#04210f; border-color:transparent; }
  button.warn { background:#3a2020; color:#ffc9c9; border-color:#5a2b2b; }
  .empty { color:var(--dim); text-align:center; padding:70px 20px; grid-column:1/-1; }
  #login { max-width:340px; margin:16vh auto; padding:26px; background:var(--card);
           border:1px solid var(--line); border-radius:12px; }
  #login input { width:100%; font:inherit; padding:12px; margin:12px 0; border-radius:8px;
                 border:1px solid var(--line); background:#161923; color:var(--text); }
  #login button { width:100%; background:var(--ready); color:#04210f; border-color:transparent; }
  .err { color:#ff9b9b; font-size:14px; min-height:20px; }
</style>
</head>
<body>
<div id="login" hidden>
  <h1>Kitchen Login</h1>
  <input type="password" id="pw" placeholder="Password" autocomplete="current-password">
  <button onclick="login()">Enter</button>
  <div class="err" id="loginErr"></div>
</div>

<div id="app" hidden>
  <header>
    <h1>Orders</h1><span class="count" id="count">0</span>
    <span class="muted" id="updated">—</span>
  </header>
  <main id="list"></main>
</div>

<script>
var seen = JSON.parse(sessionStorage.getItem('seenOrders') || '[]');
var first = true;

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

function beep(){
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; o.type = 'sine';
    g.gain.setValueAtTime(0.28, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.55);
    o.start(); o.stop(ctx.currentTime + 0.55);
  } catch (e) {}
}

function login(){
  var pw = document.getElementById('pw').value;
  fetch('/kitchen/login', { method:'POST', headers:{'Content-Type':'application/json'},
                            body: JSON.stringify({ password: pw }) })
    .then(function(r){ return r.ok ? load() : r.json().then(function(j){ throw new Error(j.error || 'failed'); }); })
    .catch(function(e){ document.getElementById('loginErr').textContent = e.message; });
}

function showLogin(){
  document.getElementById('login').hidden = false;
  document.getElementById('app').hidden = true;
}

function setStatus(rowNum, orderNumber, status, btn){
  btn.disabled = true;
  fetch('/kitchen/status', { method:'POST', headers:{'Content-Type':'application/json'},
                             body: JSON.stringify({ rowNum: rowNum, orderNumber: orderNumber, status: status }) })
    .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||'failed'); }); })
    .then(load)
    .catch(function(e){ alert(e.message); btn.disabled = false; });
}

function card(o){
  var short = o.status === 'Ready for Pickup' ? 'Ready'
            : o.status === 'Out for Delivery' ? 'Out' : o.status;
  var isNew = seen.indexOf(String(o.orderNumber)) === -1;
  var d = document.createElement('div');
  d.className = 'card s-' + short + (isNew && !first ? ' flash' : '');
  var deliver = String(o.mode || '').toLowerCase().indexOf('delivery') === 0;
  d.innerHTML =
    '<div class="top"><span class="num">#' + esc(o.orderNumber) + '</span>' +
      '<span class="time">' + esc(o.timestamp) + '</span></div>' +
    '<div class="status">' + esc(o.status) + '</div>' +
    '<div class="mode">' + (deliver ? '🏍️ ' : '📦 ') + esc(o.mode) + '</div>' +
    '<div class="items">' + esc(o.items) + '</div>' +
    '<div class="meta"><strong>$' + esc(o.total) + '</strong></div>' +
    (o.phone ? '<div class="meta">📞 ' + esc(o.phone) + '</div>' : '') +
    '<div class="btns"></div>';
  var btns = d.querySelector('.btns');
  var next = [['Preparing','Preparing'],
              deliver ? ['Out for Delivery','Out for delivery'] : ['Ready for Pickup','Ready'],
              ['Completed','Done'], ['Cancelled','Cancel']];
  next.forEach(function(pair){
    if (pair[0] === o.status) return;
    var b = document.createElement('button');
    b.textContent = pair[1];
    if (pair[0] === 'Completed') b.className = 'go';
    if (pair[0] === 'Cancelled') b.className = 'warn';
    b.onclick = function(){ setStatus(o.rowNum, o.orderNumber, pair[0], b); };
    btns.appendChild(b);
  });
  return d;
}

function load(){
  return fetch('/kitchen/orders')
    .then(function(r){
      if (r.status === 401) { showLogin(); throw new Error('auth'); }
      return r.json();
    })
    .then(function(data){
      document.getElementById('login').hidden = true;
      document.getElementById('app').hidden = false;
      var list = document.getElementById('list');
      list.innerHTML = '';
      var orders = data.orders || [];
      document.getElementById('count').textContent = orders.length;
      document.getElementById('updated').textContent =
        'updated ' + new Date().toLocaleTimeString();
      if (!orders.length) {
        list.innerHTML = '<div class="empty">No open orders.</div>';
      } else {
        var fresh = orders.some(function(o){ return seen.indexOf(String(o.orderNumber)) === -1; });
        orders.forEach(function(o){ list.appendChild(card(o)); });
        if (fresh && !first) beep();
      }
      seen = orders.map(function(o){ return String(o.orderNumber); });
      sessionStorage.setItem('seenOrders', JSON.stringify(seen));
      first = false;
      document.title = (orders.length ? '(' + orders.length + ') ' : '') + 'Kitchen';
    })
    .catch(function(e){ if (e.message !== 'auth') console.error(e); });
}

load();
setInterval(load, 10000);
document.getElementById('pw').addEventListener('keydown', function(e){
  if (e.key === 'Enter') login();
});
</script>
</body>
</html>`;

app.get('/kitchen', (req, res) => {
  if (!process.env.KITCHEN_PASSWORD) {
    return res.status(503).send('Kitchen dashboard is not configured — set KITCHEN_PASSWORD in the environment.');
  }
  res.type('html').send(KITCHEN_HTML);
});

// Guarded so require()'ing this file (the replay-test harness does exactly
// that) never starts a real server, hits the network, or schedules timers —
// only `node index.js` (require.main === module) boots the live bot.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    // Doubles as the practical "did the bot just crash-restart" signal in
    // production — the only OTHER reason this process restarts is a manual
    // deploy, which is a low-cost false positive to accept in exchange for
    // otherwise-silent crashes (see the crash/uncaughtException handlers
    // below) getting noticed within minutes instead of hours.
    alertOwner('boot', `🤖 Bot started (or restarted) at ${new Date().toLocaleString('en-US', { timeZone: 'America/Belize' })}.`);
    refreshMenuFromSheet(); // load once at startup so it's not empty for the first 2 min
    setInterval(refreshMenuFromSheet, 2 * 60 * 1000);
    pollOrderStatus(); // silent baseline pass — establishes "current" status without notifying
    setInterval(pollOrderStatus, 60 * 1000);
    setInterval(sweepIdleSessions, 30 * 1000);
    refreshCustomerProfiles(); // load once at startup; changes rarely so a slower refresh than availability is fine
    setInterval(refreshCustomerProfiles, 5 * 60 * 1000);
  });
}

// For the replay-test harness (test/replay.test.js) only — production never
// requires this file as a module, so these exports are inert otherwise.
module.exports = { app, processWhatsAppMessage, dryRunSent, sessions, lastOrders, savedCarts, cartTotal, OWNER_NUMBERS, DRIVER_NUMBERS, soldOutIds, sweepIdleSessions, replySummaryText, MENU, applyMenuSheetRows, resetMenuSheetTrackingForTests, notifyStatusChange };