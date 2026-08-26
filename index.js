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

function chakraSendUrl() {
  return `https://api.chakrahq.com/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/api/${CHAKRA_API_VERSION}/${CHAKRA_PHONE_NUMBER_ID}/messages`;
}

// Sends ONE WhatsApp message via Chakra's pass-through Messages API (same
// shape as Meta's own Cloud API). `to` must be bare digits with country code
// — no leading '+', no 'whatsapp:' prefix. `message` is a plain string,
// { text, mediaUrl } to send an image (with optional caption),
// { buttons: { body, buttons: [{id,title}] } } for up to 3 reply buttons, or
// { list: { body, buttonLabel, sections } } for a native list message.
async function sendWhatsAppMessage(to, message) {
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

  const res = await withTimeout(fetch(chakraSendUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHAKRA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }), 10000);

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
  if (!CHAKRA_API_KEY || !CHAKRA_PLUGIN_ID || !CHAKRA_PHONE_NUMBER_ID || !messageId) return;
  try {
    const res = await withTimeout(fetch(chakraSendUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CHAKRA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      }),
    }), 5000);
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
function sendReply(res, to, textOrMessages) {
  if (process.env.DEBUG_REPLIES) console.log(`REPLY >>> to ${to}:`, JSON.stringify(textOrMessages));
  pushTranscript(to, 'bot', replySummaryText(textOrMessages));
  if (!res.headersSent) res.sendStatus(200); // the webhook is usually already acked earlier — see app.post('/whatsapp')
  const messages = Array.isArray(textOrMessages) ? textOrMessages : [textOrMessages];
  (async () => {
    for (const m of messages.filter(Boolean)) {
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
  })();
}

// ---- DELIVERY DRIVER NOTIFICATION ----
// EDIT THIS: add real driver WhatsApp number(s) as bare digits with country
// code, NO '+' and NO 'whatsapp:' prefix (e.g. '5016256563').
// Empty list = nothing gets sent.
const DRIVER_NUMBERS = [
  '5016162492',
];

async function notifyDriver(orderNumber, session, from) {
  if (DRIVER_NUMBERS.length === 0) return;

  const itemLines = session.cart.map(i => {
    const noteStr = i.note ? ` [${i.note}]` : '';
    return `- ${i.name}${noteStr} x${i.qty} - $${(i.price * i.qty).toFixed(2)}`;
  }).join('\n');

  const total = session.cart.reduce((sum, i) => sum + i.price * i.qty, 0).toFixed(2);

  const divider = '━━━━━━━━━━━━━━';

  const preorderTag = session.isPreorder ? (session.language === 'es' ? '🕐 *PRE-PEDIDO — armar cuando abramos*\n\n' : '🕐 *PRE-ORDER — prep when we open*\n\n') : '';

  const profile = customerProfiles[from];
  const noteTag = profile && profile.notes
    ? (session.language === 'es' ? `\n\n⚠️ *Nota del cliente:* ${profile.notes}` : `\n\n⚠️ *Customer note:* ${profile.notes}`)
    : '';

  const message = preorderTag + (session.language === 'es'
    ? `🏍️ *NUEVA ORDEN DE ENTREGA #${orderNumber}*\n${divider}\n🛍️ *Artículos:*\n${itemLines}\n${divider}\n💵 *Total a cobrar: $${total} BZD*\n\n📍 *Entregar a:*\n${session.address}\n📞 *Teléfono del cliente:* +${from}${noteTag}`
    : `🏍️ *NEW DELIVERY ORDER #${orderNumber}*\n${divider}\n🛍️ *Items:*\n${itemLines}\n${divider}\n💵 *Total to collect: $${total} BZD*\n\n📍 *Deliver to:*\n${session.address}\n📞 *Customer phone:* +${from}${noteTag}`);

  for (const driverNumber of DRIVER_NUMBERS) {
    try {
      await sendWhatsAppMessage(driverNumber, message);
    } catch (err) {
      console.error('Driver notification error:', err.message || err);
    }
  }
}

const sheetsAuth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

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
    // Explicitly find the next empty row instead of using values.append(),
    // which tries to auto-detect the "table" boundaries and can misplace
    // rows when a sheet has mixed row widths (older rows only reach column F,
    // newer ones reach H) combined with dropdown validation further down the
    // column — exactly what caused rows to land at column H instead of A.
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
    // So the status poller doesn't treat this brand-new "Confirmed" row as a
    // change to notify about the next time it runs.
    lastKnownStatus.set(String(orderNumber), 'Confirmed');
  } catch (err) {
    console.error('Google Sheets log error:', err);
  }
}

// Powers the post-confirmation cancel window (see the "cancel order"
// command). Matches by BOTH order number AND phone — matching by order
// number alone would risk touching the wrong row if a stale duplicate
// order number exists (this exact class of bug already bit
// pollOrderStatus once — see the row-position rewrite above). Returns
// true if a matching row was found and updated, false otherwise.
async function cancelOrderInSheet(orderNumber, from) {
  if (!process.env.GOOGLE_SHEETS_ID) return false;
  const res = await withTimeout(sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'Manager!A2:H',
  }), 8000);
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const [rowOrderNumber, , , , , , phoneCell] = rows[i];
    const phoneDigits = (phoneCell || '').replace(/\D/g, '');
    if (String(rowOrderNumber) === String(orderNumber) && phoneDigits === String(from)) {
      const rowNum = i + 2; // range above starts at row 2 (header is row 1)
      await withTimeout(sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: `Manager!H${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['Cancelled']] },
      }), 6000);
      return true;
    }
  }
  return false;
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

// ---- PER-SENDER SESSION LOCK ----
// Serializes message processing per sender so two near-simultaneous
// messages from the SAME customer can't interleave against the same mutable
// session object (e.g. one message's cart update getting lost to a race
// with another, since the AI calls in between mean a single message's
// processing can take several seconds). Different senders are completely
// unaffected — each gets its own independent chain. Single-process only:
// if this ever runs as more than one instance, each gets its own lock and
// the guarantee above no longer holds across instances.
const sessionLocks = new Map(); // from -> tail promise of the current chain

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

// Pure row-parsing logic, pulled out of the Sheets fetch so it can be
// exercised with synthetic rows (no network/write) as well as real ones.
// Mutates price directly onto the shared MENU item objects — every existing
// read site (cart, checkout, size buttons, AI order text, etc.) already
// reads item.price/item.sizes[i].price straight off MENU, so this is the
// only place that needs to know sheet rows exist at all. A missing/invalid
// price cell is skipped and the previous price kept (never let a typo'd
// cell silently become $0 or NaN); once a price IS overridden this way,
// clearing the cell does not revert it — retype the original number to
// undo an override.
function applyMenuSheetRows(rows) {
  const soldOut = new Set();
  for (const row of rows) {
    const [id, , , availableCell, priceCell, largePriceCell] = row;
    if (!id) continue;
    const key = id.trim();

    const rawAvail = String(availableCell || '').trim().toLowerCase();
    if (['false', 'no', '0', 'out', 'sold out'].includes(rawAvail)) soldOut.add(key);

    const item = menuItemById.get(key);
    if (!item) continue; // unrecognized id — not something this build knows about

    if (item.sizes) {
      const regular = parseFloat(priceCell);
      if (Number.isFinite(regular) && regular > 0) item.sizes[0].price = regular;
      const large = parseFloat(largePriceCell);
      if (Number.isFinite(large) && large > 0) item.sizes[item.sizes.length - 1].price = large;
    } else {
      const price = parseFloat(priceCell);
      if (Number.isFinite(price) && price > 0) item.price = price;
    }
  }
  return soldOut;
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
    soldOutIds = applyMenuSheetRows(res.data.values || []);
  } catch (err) {
    console.error('Menu sheet refresh failed (keeping previous prices/availability):', err.message || err);
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
      const phone = (phoneCell || '').replace(/\D/g, '');
      if (!phone) continue;
      next[phone] = { savedAddress: savedAddress || '', notes: notes || '', updatedAt: updatedAt || '' };
    }
    customerProfiles = next;
  } catch (err) {
    // Fail open — most likely the Customers tab hasn't been created yet
    // (run seed-customers.js), or a transient Sheets error either way.
    console.error('Customer profile refresh failed (keeping previous profiles):', err.message || err);
  }
}

// Optimistic: updates the in-memory cache immediately (so the very next
// message in this same conversation sees it), then writes through to the
// sheet in the background. `fields` is a partial { savedAddress, notes }.
async function saveCustomerProfile(from, fields) {
  const merged = { ...(customerProfiles[from] || {}), ...fields, updatedAt: new Date().toISOString() };
  customerProfiles[from] = merged;

  if (!process.env.GOOGLE_SHEETS_ID) return;
  const res = await withTimeout(sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'Customers!A2:D',
  }), 8000);
  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => (r[0] || '').replace(/\D/g, '') === String(from));
  const rowValues = [`'+${from}`, merged.savedAddress || '', merged.notes || '', merged.updatedAt];
  const rowNum = rowIndex >= 0 ? rowIndex + 2 : rows.length + 2; // +2: range starts at row 2 (header is row 1)
  await withTimeout(sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `Customers!A${rowNum}:D${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowValues] },
  }), 6000);
}

// ---- ORDER STATUS POLLING (proactive WhatsApp updates) ----
// orderNumber (string) -> last status we've seen for that order. Runs on a
// timer, completely off the request path — same reasoning as availability
// above. On the very first poll after server start, we only build this map
// silently (no notifications) so a restart doesn't re-blast every recent
// order's current status to its customer.
let lastKnownStatus = new Map();
let statusPollingInitialized = false;

async function pollOrderStatus() {
  if (!process.env.GOOGLE_SHEETS_ID || !CHAKRA_API_KEY) return;
  try {
    const res = await withTimeout(sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Manager!A2:H',
    }), 8000);
    const rows = res.data.values || [];

    if (!statusPollingInitialized) {
      rows.forEach((row, i) => {
        const [orderNumber, , , , , , , status] = row;
        if (orderNumber) lastKnownStatus.set(i, status || 'Confirmed');
      });
      statusPollingInitialized = true;
      return;
    }

    for (const [i, row] of rows.entries()) {
      const [orderNumber, , , , , language, phoneCell, statusCell] = row;
      if (!orderNumber) continue;
      const status = (statusCell || 'Confirmed').trim();
      // Keyed by row position, not order number — two rows sharing the same
      // order number (a stale duplicate, or a random 4-digit collision) must
      // never be compared against each other's status, or they flip-flop
      // forever, re-notifying the customer every poll cycle indefinitely.
      const key = i;
      const previous = lastKnownStatus.get(key);

      if (previous === status) continue;
      lastKnownStatus.set(key, status); // always update, even if we don't message

      const lang = language === 'es' ? 'es' : 'en';
      const buildMessage = STATUS_MESSAGES[lang][status];
      const phone = (phoneCell || '').replace(/^\+/, ''); // strip '+' — Chakra/Meta wants bare digits

      if (!buildMessage) {
        // Status text doesn't exactly match one of STATUS_MESSAGES's keys
        // (case-sensitive) — likely a typo in the sheet's status column, or
        // it's free-text rather than a locked dropdown. Worth knowing about
        // even though there's nothing to send: the customer silently never
        // gets notified otherwise, with no other signal that anything's off.
        console.warn(`Order #${orderNumber}: status changed to "${status}" but no message template matches it (check for a typo/case mismatch in the Manager sheet) — customer not notified.`);
        continue;
      }
      if (!phone) continue; // no phone on file for this order — nothing to notify, this is expected

      try {
        await sendWhatsAppMessage(phone, buildMessage(orderNumber));
        console.log(`Status update sent for order #${orderNumber}: ${status}`);
      } catch (sendErr) {
        console.error(`Failed to send status update for order #${orderNumber}:`, sendErr.message || sendErr);
      }
    }
  } catch (err) {
    console.error('Order status poll failed:', err.message || err);
  }
}

const MAX_QTY = 50;

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
  paymentEn: 'Cash only or online, including cash on delivery.',
  paymentEs: 'Solo efectivo o enlinea, incluso contra entrega.',
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
    howToOrder: () => `🍧 *Créme De La Créme* 🍧

*How to order:*
1️⃣ Reply with a category number to browse
2️⃣ Or just type what you want, e.g. "2 hot dogs, no onion, and a large mango smoothie, extra ice"
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
*language* = change language`,
    menuButtonPrompt: 'Tap below whenever you\'re ready to see the menu 👇',
    menuButtonTitle: 'View Menu 📋',
    mainMenu: (menuList) => `🍧 *Créme De La Créme* 🍧\nReply with a number, or type your order:\n\n${menuList}\n\n*cart* = view order   *done* = checkout   *help* = instructions`,
    cartEmpty: 'Your cart is empty.',
    cartHeader: '🛒 *Your order:*',
    cartTotal: (t) => `*Total: $${t}*`,
    backHint: '\n0. Back to menu',
    bulkHint: '\n\n💡 Tip for big orders: type itemNumber x quantity, e.g. *3x12*. (Bulk shortcut uses Regular size, no customization notes.)',
    itemNotFound: 'Item number not found.',
    qtyRange: (max) => `Please enter a quantity between 1 and ${max}.`,
    added: (lines, total) => `Added ✅\n${lines}\nCart total: $${total}`,
    askQty: (name, price, max) => `${name} - $${price}\nHow many would you like? (1-${max}, or 0 to go back)`,
    invalidQty: (max) => `Please enter a valid quantity (1-${max}).`,
    askSize: (name, sizes) => `${name} — choose a size:\n${sizes.map(s => `${s.key}. ${s.label} - $${s.price.toFixed(2)}`).join('\n')}\n\n0. Back`,
    invalidSize: 'Please reply with a valid size number.',
    askNotes: 'Any special requests for this item? (extra ice, no onions, etc.) Type *none* if not.',
    cartEmptyCheckout: "Cart's empty — pick something first!",
    askMode: (fee) => `Pickup 📦 or delivery 🏍️? (Delivery is $${fee} BZD)`,
    pickupConfirm: '📦 Pickup order. Confirm? (yes/no)',
    askAddress: (fee) => `🏍️ What's the delivery address 📍 and a contact number?\n(Delivery fee: $${fee} BZD)`,
    deliveryConfirm: (addr) => `🏍️ Delivery to: ${addr}\n\nConfirm order? (yes/no)`,
    askModeInvalid: "Please reply 'pickup' or 'delivery'.",
    orderConfirmed: (num, phone) => `🎉 Order #${num} confirmed! Thank you!\n\nWe'll be in touch shortly.\n\n📞 Need anything else? Call us at ${phone}.`,
    orderConfirmedPreorder: (num, phone, nextOpen) => `🎉 Pre-order #${num} received! Thank you!\n\nWe're closed right now, but we'll start on it right when we open ${nextOpen}.\n\n📞 Need anything else? Call us at ${phone}.`,
    orderCancelled: 'Order cancelled.',
    confirmInvalid: "Please reply 'yes' to confirm or 'no' to cancel.",
    notUnderstood: "Sorry, I didn't quite catch that — try a menu number, or type *help* for instructions.",
    humanHelp: (phone) => `📞 Need to talk to someone? Call us at ${phone}.`,
    askConfirmNudge: "🧾 Want to add anything else? Just tell me — or type *done* whenever you're ready to checkout!",
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
  },
  es: {
    howToOrder: () => `🍧 *Créme De La Créme* 🍧

*Cómo ordenar:*
1️⃣ Responde con el número de una categoría para explorar
2️⃣ O simplemente escribe lo que quieres, ej. "2 hot dogs, sin cebolla, y un smoothie grande de mango, con hielo extra"
3️⃣ Pregúntanos lo que sea — horario, entregas, formas de pago
4️⃣ Puedes añadir más artículos en cualquier momento, incluso a mitad de la orden — nada queda fijo hasta que confirmes ✅

🏍️ Entrega disponible en ${SHOP_INFO.deliveryAreasEs} (${SHOP_INFO.deliveryTimeEs}) — o recoge en tienda 📦

*cart* = ver tu orden
*repeat* = repetir tu última orden
*done* = finalizar
*back* = volver un paso
*cancel* = cancelar tu orden
*cancelar orden* = cancelar una orden recién hecha (hasta 3 min)
*nota <texto>* = guardar una nota de alergia/preferencia para la próxima vez
*status* = ver el estado de tu última orden
*agent* = hablar con una persona real
*help* = ver estas instrucciones otra vez
*language* = cambiar idioma`,
    menuButtonPrompt: 'Toca abajo cuando quieras ver el menú 👇',
    menuButtonTitle: 'Ver Menú 📋',
    mainMenu: (menuList) => `🍧 *Créme De La Créme* 🍧\nResponde con un número, o escribe tu orden:\n\n${menuList}\n\n*cart* = ver orden   *done* = finalizar   *help* = instrucciones`,
    cartEmpty: 'Tu carrito está vacío.',
    cartHeader: '🛒 *Tu orden:*',
    cartTotal: (t) => `*Total: $${t}*`,
    backHint: '\n0. Volver al menú',
    bulkHint: '\n\n💡 Tip para órdenes grandes: escribe número x cantidad, ej. *3x12*. (El atajo usa tamaño Regular, sin notas de personalización.)',
    itemNotFound: 'Número de artículo no encontrado.',
    qtyRange: (max) => `Ingresa una cantidad entre 1 y ${max}.`,
    added: (lines, total) => `Añadido ✅\n${lines}\nTotal del carrito: $${total}`,
    askQty: (name, price, max) => `${name} - $${price}\n¿Cuántos quieres? (1-${max}, o 0 para volver)`,
    invalidQty: (max) => `Ingresa una cantidad válida (1-${max}).`,
    askSize: (name, sizes) => `${name} — elige un tamaño:\n${sizes.map(s => `${s.key}. ${s.label} - $${s.price.toFixed(2)}`).join('\n')}\n\n0. Volver`,
    invalidSize: 'Responde con un número de tamaño válido.',
    askNotes: '¿Alguna petición especial para este artículo? (extra hielo, sin cebolla, etc.) Escribe *ninguno* si no.',
    cartEmptyCheckout: '¡Carrito vacío, elige algo primero!',
    askMode: (fee) => `¿Recoger 📦 o entrega 🏍️? (La entrega cuesta $${fee} BZD)`,
    pickupConfirm: '📦 Orden para recoger. ¿Confirmas? (si/no)',
    askAddress: (fee) => `🏍️ ¿Cuál es la dirección de entrega 📍 y un número de contacto?\n(Costo de entrega: $${fee} BZD)`,
    deliveryConfirm: (addr) => `🏍️ Entrega a: ${addr}\n\n¿Confirmas la orden? (si/no)`,
    askModeInvalid: "Responde 'recoger' o 'entrega'.",
    orderConfirmed: (num, phone) => `🎉 ¡Orden #${num} confirmada! ¡Gracias!\n\nNos pondremos en contacto pronto.\n\n📞 ¿Necesitas algo más? Llámanos al ${phone}.`,
    orderConfirmedPreorder: (num, phone, nextOpen) => `🎉 ¡Pre-pedido #${num} recibido! ¡Gracias!\n\nEstamos cerrados ahora, pero empezaremos apenas abramos ${nextOpen}.\n\n📞 ¿Necesitas algo más? Llámanos al ${phone}.`,
    orderCancelled: 'Orden cancelada.',
    confirmInvalid: "Responde 'si' o 'no'.",
    notUnderstood: 'No entendí eso — intenta un número del menú, o escribe *help* para instrucciones.',
    humanHelp: (phone) => `📞 ¿Necesitas hablar con alguien? Llámanos al ${phone}.`,
    askConfirmNudge: "🧾 ¿Quieres añadir algo más? Solo dime — o escribe *done* cuando estés listo para finalizar!",
    closedBanner: (hours, nextOpen) => `😴 *Estamos cerrados en este momento.*\nHorario: ${hours}\nAbrimos de nuevo ${nextOpen}.\n\n✅ Aún puedes hacer un pre-pedido — ¡empezaremos apenas abramos!\n\n`,
    soldOutItem: (name, substitute) => `😔 Lo sentimos, ${name} está agotado en este momento.${substitute ? ` ¿Qué tal ${substitute} en su lugar? 😋` : ''}`,
    noPreviousOrder: 'Aún no tienes una orden anterior para repetir — ¡empecemos una! 😊',
    idleStillThere: '👋 ¿Sigues ahí? Tu carrito está guardado para cuando quieras continuar.',
    idleConfirmPrompt: '🧾 ¿Listo para confirmar esta orden? Responde *SI* para confirmar.',
    idleHold: '⏳ Todavía tenemos tu orden guardada — la mantendremos unos 20 minutos más.',
    idleExpired: '🕐 No queríamos seguir molestándote, ¡así que guardamos tu carrito! ¿Quieres continuar donde lo dejaste? Responde *SI* para continuar, o escribe *MENU* para empezar de nuevo.',
    resumeOffer: '👋 ¿Quieres continuar tu orden anterior? Responde *SI* para continuar, o escribe *MENU* para empezar de nuevo.',
    resumeRestored: (cart) => `✅ ¡Bienvenido de nuevo! Tu carrito fue restaurado:\n\n${cart}`,
    agentRequested: (phone) => `📞 Listo — te estamos conectando con nuestro equipo, alguien se comunicará pronto. También puedes llamarnos directamente al ${phone}.`,
    statusReply: (num, status) => `📦 Orden #${num}: *${status}*`,
    statusUnavailable: (phone) => `Lo sentimos, no pudimos consultar el estado de tu orden ahora — por favor llámanos al ${phone}.`,
    stopGuessing: '🤔 Intentemos de otra forma — toca una opción abajo, o escribe *agent* para hablar con una persona real.',
    frustrationSoften: '😊 Disculpa el ir y venir — vamos a resolver esto.',
    frustrationShortcut: '¿Quieres que nuestro equipo te llame en vez de esto? Escribe *agent* cuando quieras.',
    cancelWindowClosed: (phone) => `Lo sentimos, la ventana de 3 minutos para cancelar tu orden ya cerró — llámanos al ${phone} si necesitas hacer cambios.`,
    orderCancelledConfirmed: (num) => `❌ La orden #${num} fue cancelada. Escribe *menu* si quieres hacer una nueva.`,
    cancelOrderNotFound: (phone) => `Lo sentimos, no pudimos encontrar esa orden para cancelar — por favor llámanos al ${phone}.`,
    savedAddressOffer: (addr) => `📍 ¿Usar tu dirección guardada?\n${addr}`,
    savedAddressUseIt: 'Usar dirección guardada',
    savedAddressNew: 'Escribir nueva dirección',
    noteSaved: 'Listo — guardé esa nota para la próxima vez. 📝',
    reorderUsualPrompt: '¿Repetir lo de siempre? 🔁',
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
      };
      const preservedLanguage = session.language;
      sessions[from] = newSession();
      sessions[from].language = preservedLanguage;
      sessions[from].pendingResume = true;
      sendWhatsAppMessage(from, t.idleExpired).catch(err => console.error(`Idle-expiry message failed for ${from}:`, err.message || err));
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
      const message = session.step === 'confirm' ? t.idleConfirmPrompt : t.idleStillThere;
      sendWhatsAppMessage(from, message).catch(err => console.error(`Idle nudge failed for ${from}:`, err.message || err));
    }
  }

  for (const from of Object.keys(savedCarts)) {
    if (now - savedCarts[from].savedAt > SAVED_CART_MAX_AGE_MS) {
      delete savedCarts[from];
      // Clean up the paired empty pendingResume shell left in `sessions`
      // (see above) at the same time, now that there's nothing left to resume.
      if (sessions[from] && sessions[from].pendingResume) delete sessions[from];
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

function transcriptText(session) {
  if (!session.transcript || session.transcript.length === 0) return '(no transcript)';
  return session.transcript.map(e => `${e.role === 'customer' ? '👤' : '🤖'} ${e.text}`).join('\n');
}

// Shared by the manual AGENT command and the automatic frustration-ladder
// escalation — both need to reach the same staff number with the same
// context so the customer never has to repeat themselves either way.
function escalateToHuman(from, session, lang, reasonLine) {
  const cartSummary = session.cart.length > 0 ? `\n\nCart:\n${cartText(session.cart, lang)}` : '';
  const profile = customerProfiles[from];
  const noteTag = profile && profile.notes ? `\n⚠️ Customer note: ${profile.notes}` : '';
  const staffMsg = `🔔 ${reasonLine}\nCustomer: +${from} (step: ${session.step})${noteTag}${cartSummary}\n\n📝 Recent conversation:\n${transcriptText(session)}`;
  if (process.env.DEBUG_REPLIES) console.log('ESCALATE >>>', staffMsg);
  DRIVER_NUMBERS.forEach(num => {
    sendWhatsAppMessage(num, staffMsg).catch(err => console.error(`Escalation notify failed for ${num}:`, err.message || err));
  });
}

// ---- CART HELPERS ----
function addToCart(cart, name, price, qty, note = '', categoryId = null, itemIndex = null) {
  const existing = cart.find(c => c.name === name && c.price === price && (c.note || '') === note);
  if (existing) {
    existing.qty += qty;
  } else {
    cart.push({ name, price, qty, note, categoryId, itemIndex });
  }
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

function welcomeText(lang) {
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
  const toRows = cats => cats.map(cat => ({ id: cat.id, title: cat.category }));
  const buttonLabel = lang === 'es' ? 'Ver categoría' : 'View category';
  return [
    {
      list: {
        body: lang === 'es' ? '🍹 Bebidas' : '🍹 Drinks Menu',
        buttonLabel,
        sections: [{ rows: toRows(MENU.filter(c => Number(c.id) <= 7)) }],
      },
      fallback: mainMenuText(lang), // carries the FULL text menu (both drinks & food) so the second list below doesn't need its own fallback
    },
    {
      list: {
        body: lang === 'es' ? '🍔 Comida' : '🍔 Food Menu',
        buttonLabel,
        sections: [{ rows: toRows(MENU.filter(c => Number(c.id) > 7)) }],
      },
    },
  ];
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
    rows.push({ id: String(i + 1), title, description });
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

function sizeButtonsMessage(item, lang) {
  const body = TXT[lang].askSize(item.name, item.sizes);
  return {
    buttons: {
      body,
      buttons: item.sizes.map(s => ({ id: s.key, title: `${s.label} - $${s.price.toFixed(2)}`.slice(0, 20) })),
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
      hours: `We're open ${s.hoursEn}.`,
      deliveryFee: `Delivery is $${s.deliveryFee} BZD within ${s.deliveryAreasEn}, usually ${s.deliveryTimeEn}. Minimum order for delivery is $${s.minDeliveryOrder} BZD.`,
      deliveryGeneral: `Yes, we deliver! $${s.deliveryFee} BZD within ${s.deliveryAreasEn}, usually ${s.deliveryTimeEn}. Minimum order $${s.minDeliveryOrder} BZD.`,
      payment: s.paymentEn,
      location: `We're based in ${s.deliveryAreasEn}. For exact directions, best to call us.`,
    },
    es: {
      hours: `Abrimos ${s.hoursEs}.`,
      deliveryFee: `La entrega cuesta $${s.deliveryFee} BZD dentro de ${s.deliveryAreasEs}, normalmente ${s.deliveryTimeEs}. Pedido mínimo para entrega: $${s.minDeliveryOrder} BZD.`,
      deliveryGeneral: `¡Sí, hacemos entregas! $${s.deliveryFee} BZD dentro de ${s.deliveryAreasEs}, normalmente ${s.deliveryTimeEs}. Pedido mínimo $${s.minDeliveryOrder} BZD.`,
      payment: s.paymentEs,
      location: `Estamos en ${s.deliveryAreasEs}. Para direcciones exactas, mejor llámanos.`,
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

    addToCart(session.cart, name, price, qty, note, cat.id, m.itemIndex);
    const noteStr = note ? ` [${note}]` : '';
    addedLines.push(`${name}${noteStr} x${qty} - $${(price * qty).toFixed(2)}`);
  }
  return { added: addedLines, soldOut: soldOutNames };
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
  if (matches.length === 0) return { added: [], soldOut: [], answer };
  const { added, soldOut } = applyMatchesToCart(session, matches);
  return { added, soldOut, answer: null };
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
function orderResultText(result, session, lang) {
  const t = TXT[lang];
  const bits = [];
  if (result.soldOut.length > 0) {
    bits.push(result.soldOut.map(s => t.soldOutItem(s.name, suggestSubstitute(s.categoryId, s.itemIndex))).join('\n'));
  }
  if (result.added.length > 0) {
    bits.push(t.added(result.added.join('\n'), cartTotal(session.cart).toFixed(2)));
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
            "Sorry, I couldn't understand that voice message — could you try typing it, or record again? 🙏",
            'Lo sentimos, no pude entender el mensaje de voz — ¿puedes escribirlo o grabar de nuevo? 🙏'
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

    const msg = rawMsg.toLowerCase();
    const isFreeform = message.type === 'text' || message.type === 'audio'; // structured button/list taps don't carry frustration signals the same way

    console.log(`Message from ${from}: ${rawMsg}`);
    pushTranscript(from, 'customer', rawMsg);

    if (msg === 'cancel' || msg === 'cancelar') {
      const lang = session.language || 'en';
      delete savedCarts[from];
      sessions[from] = newSession();
      return sendReply(res, from, lang === 'es'
        ? 'Orden cancelada ❌. Escribe *menu* para empezar de nuevo.'
        : 'Order cancelled ❌. Type *menu* to start over.');
    }

    if (!session.language) {
      if (msg === '1' || msg === 'english' || msg === 'en') {
        session.language = 'en';
        session.step = 'menu';
        return sendReply(res, from, [withClosedBanner(welcomeText('en'), 'en'), menuButtonMessage('en')]);
      }
      if (msg === '2' || msg === 'español' || msg === 'espanol' || msg === 'es') {
        session.language = 'es';
        session.step = 'menu';
        return sendReply(res, from, [withClosedBanner(welcomeText('es'), 'es'), menuButtonMessage('es')]);
      }
      // Only auto-picks on a strong, unambiguous signal — a bare "hi" or a
      // stray number stays with the explicit picker rather than risk
      // guessing wrong. *language* remains available anytime to switch.
      const detected = detectLanguage(rawMsg);
      if (detected) {
        session.language = detected;
        session.step = 'menu';
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
      } else if (msg === 'menu' || msg === 'no' || msg === 'cancel' || msg === 'cancelar') {
        session.pendingResume = false;
        delete savedCarts[from];
        // Don't return — let the normal "menu"/global handling below run too.
      } else {
        return sendReply(res, from, t.resumeOffer);
      }
    }

    if (msg === 'language' || msg === 'idioma' || msg === 'lang') {
      session.language = null;
      session.step = 'language';
      return sendReply(res, from, languageButtonsMessage());
    }

    if (msg === 'help' || msg === 'ayuda') {
      return sendReply(res, from, welcomeText(lang));
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
        const statusRes = await withTimeout(sheets.spreadsheets.values.get({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          range: 'Manager!A2:H',
        }), 8000);
        const rows = statusRes.data.values || [];
        let foundStatus = null;
        for (const row of rows) {
          const [orderNumber, , , , , , , statusCell] = row;
          if (String(orderNumber) === String(last.orderNumber)) foundStatus = (statusCell || 'Confirmed').trim();
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
          const cancelMsg = `❌ Order #${last.orderNumber} was cancelled by the customer (within the 3-minute window).`;
          DRIVER_NUMBERS.forEach(num => {
            sendWhatsAppMessage(num, cancelMsg).catch(err => console.error(`Cancel-order driver notify failed for ${num}:`, err.message || err));
          });
        }
        const cancelledOrderNumber = last.orderNumber;
        delete lastOrders[from]; // one cancel per confirmed order — prevents a second cancel attempt on an already-cancelled order
        return sendReply(res, from, t.orderCancelledConfirmed(cancelledOrderNumber));
      } catch (err) {
        console.error('Order cancel failed:', err.message || err);
        return sendReply(res, from, t.cancelOrderNotFound(SHOP_INFO.phone));
      }
    }

    // Skipped while session.step === 'notes' — that step already treats ALL
    // free text as the per-item note itself (e.g. "note: extra spicy"), so
    // this global command would otherwise hijack it before it ever reaches
    // the per-item handler and the pending item would never get added.
    if (session.step !== 'notes' && /^(note|nota)\s+\S/i.test(rawMsg.trim())) {
      const noteText = rawMsg.trim().replace(/^(note|nota)\s+/i, '').slice(0, 200);
      try {
        await saveCustomerProfile(from, { notes: noteText });
      } catch (err) {
        console.error(`Failed to save note for ${from}:`, err.message || err);
      }
      return sendReply(res, from, t.noteSaved);
    }

    if (msg === 'hola' || msg === 'hi' || msg === 'hello' || msg === 'menu' || msg === 'start') {
      session.step = 'menu';
      const messages = [withClosedBanner('', lang), ...categoryListMessages(lang)];
      if (session.cart.length === 0 && lastOrders[from] && lastOrders[from].cart && lastOrders[from].cart.length > 0) {
        messages.push(reorderUsualButtonMessage(lang));
      }
      return sendReply(res, from, messages);
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
          const last = lastOrders[from];
          if (!last || last.cart.length === 0) {
            reply = [t.noPreviousOrder, ...categoryListMessages(lang)];
          } else {
            const addedLines = [];
            const soldOutLines = [];
            last.cart.forEach(item => {
              if (item.categoryId != null && item.itemIndex != null && isItemSoldOut(item.categoryId, item.itemIndex)) {
                soldOutLines.push(t.soldOutItem(item.name, suggestSubstitute(item.categoryId, item.itemIndex)));
                return;
              }
              addToCart(session.cart, item.name, item.price, item.qty, item.note, item.categoryId, item.itemIndex);
              const noteStr = item.note ? ` [${item.note}]` : '';
              addedLines.push(`${item.name}${noteStr} x${item.qty} - $${(item.price * item.qty).toFixed(2)}`);
            });

            const bits = [];
            if (soldOutLines.length > 0) bits.push(soldOutLines.join('\n'));
            if (addedLines.length > 0) bits.push(t.added(addedLines.join('\n'), cartTotal(session.cart).toFixed(2)));

            reply = [
              bits.length > 0 ? bits.join('\n\n') : t.noPreviousOrder,
              t.askConfirmNudge,
              ...categoryListMessages(lang),
            ];
          }
        } else if (msg === 'done' || msg === 'listo' || msg === 'checkout') {
          if (session.cart.length === 0) {
            reply = [t.cartEmptyCheckout, ...categoryListMessages(lang)];
          } else {
            // Checkout proceeds even while closed — confirming becomes a
            // pre-order instead of a dead end (see the 'confirm' step below).
            session.step = 'mode';
            reply = [cartText(session.cart, lang), modeButtonsMessage(SHOP_INFO.deliveryFee, lang)];
          }
        } else {
          const faqKey = matchFAQKeyword(msg);
          if (faqKey) {
            reply = `${faqAnswer(faqKey, lang)}\n\n${t.humanHelp(SHOP_INFO.phone)}`;
            break;
          }

          const orderResult = await attemptFreeOrder(rawMsg, session);

          if (orderResult.added.length > 0 || orderResult.soldOut.length > 0) {
            // Two separate bubbles: the cart/sold-out update, then a dedicated
            // nudge asking if they want more or are ready to confirm/checkout.
            reply = [
              orderResultText(orderResult, session, lang),
              t.askConfirmNudge,
              ...categoryListMessages(lang),
            ];
          } else if (orderResult.answer) {
            // Not a recognized order — fall back to the FAQ-style AI answer
            // attemptFreeOrder already got from the same call.
            reply = `${orderResult.answer}\n\n${t.humanHelp(SHOP_INFO.phone)}`;
          } else {
            parseFailed = true;
            reply = `${t.notUnderstood}\n\n${t.humanHelp(SHOP_INFO.phone)}`;
          }
        }
        break;
      }

      case 'item': {
        const cat = MENU.find(c => c.id === session.currentCategory);

        if (msg === '0' || msg === 'atras' || msg === 'back') {
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
          if (session.cart.length === 0) {
            reply = [t.cartEmptyCheckout, categoryItemsListMessage(cat, lang)];
          } else {
            session.step = 'mode';
            reply = [cartText(session.cart, lang), modeButtonsMessage(SHOP_INFO.deliveryFee, lang)];
          }
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
            addToCart(session.cart, name, price, qty, '', cat.id, itemIndex + 1);
            session.step = 'menu';
            reply = [
              t.added(`${name} x${qty} - $${(price * qty).toFixed(2)}`, cartTotal(session.cart).toFixed(2)),
              t.askConfirmNudge,
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
            reply = sizeButtonsMessage(item, lang);
          } else {
            session.step = 'quantity';
            reply = t.askQty(item.name, item.price.toFixed(2), MAX_QTY);
          }
        } else {
          // Not a valid item number — maybe they typed a whole new order instead.
          const orderResult = await attemptFreeOrder(rawMsg, session);
          if (orderResult.added.length > 0 || orderResult.soldOut.length > 0) {
            reply = [orderResultText(orderResult, session, lang), categoryItemsListMessage(cat, lang)];
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

        if (msg === '0' || msg === 'atras' || msg === 'back') {
          session.pendingItem = null;
          session.pendingSize = null;
          session.step = 'item';
          reply = categoryItemsListMessage(cat, lang);
          break;
        }

        const size = matchSizeChoice(msg, item.sizes);
        if (!size) {
          // Not a valid size reply — try it as a new/extra order before giving up,
          // then re-ask the size question so the original item isn't lost.
          const orderResult = await attemptFreeOrder(rawMsg, session);
          if (orderResult.added.length > 0 || orderResult.soldOut.length > 0) {
            reply = [orderResultText(orderResult, session, lang), sizeButtonsMessage(item, lang)];
          } else {
            parseFailed = true;
            reply = [t.invalidSize, sizeButtonsMessage(item, lang)];
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

        if (msg === '0' || msg === 'atras' || msg === 'back') {
          session.pendingItem = null;
          session.pendingSize = null;
          session.step = 'item';
          reply = categoryItemsListMessage(cat, lang);
          break;
        }

        const qty = parseInt(msg, 10);
        if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY || !/^\d+$/.test(msg)) {
          // Not a valid quantity — try it as a new/extra order first, then
          // re-ask the quantity question so the pending item isn't lost.
          const item = session.pendingItem;
          const size = session.pendingSize;
          const label = size ? `${item.name} (${size.label})` : item.name;
          const price = size ? size.price : item.price;
          const orderResult = await attemptFreeOrder(rawMsg, session);
          if (orderResult.added.length > 0 || orderResult.soldOut.length > 0) {
            reply = `${orderResultText(orderResult, session, lang)}\n\n` + t.askQty(label, price.toFixed(2), MAX_QTY);
          } else {
            parseFailed = true;
            reply = t.invalidQty(MAX_QTY);
          }
        } else {
          session.pendingQty = qty;
          session.step = 'notes';
          reply = t.askNotes;
        }
        break;
      }

      case 'notes': {
        const item = session.pendingItem;
        const size = session.pendingSize;
        const qty = session.pendingQty;
        const name = size ? `${item.name} (${size.label})` : item.name;
        const price = size ? size.price : item.price;

        if (msg === 'atras' || msg === 'back') {
          // NOTE: '0' is deliberately excluded here — it already means "no
          // note" for this step (see noNoteWords below), so treating it as
          // "go back" too would silently break that existing shorthand.
          session.step = 'quantity';
          reply = t.askQty(name, price.toFixed(2), MAX_QTY);
          break;
        }

        const noNoteWords = ['none', 'no', 'ninguno', 'ninguna', 'nada', 'n/a', 'na', '0'];
        const note = noNoteWords.includes(msg) ? '' : rawMsg.trim().slice(0, 60);

        addToCart(session.cart, name, price, qty, note, session.pendingCategoryId, session.pendingItemIndex);
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

        const noteStr = note ? ` [${note}]` : '';
        reply = [
          t.added(`${name}${noteStr} x${qty} - $${(price * qty).toFixed(2)}`, cartTotal(session.cart).toFixed(2)),
          t.askConfirmNudge,
          categoryItemsListMessage(cat, lang),
        ];
        break;
      }

      case 'mode': {
        if (msg === '0' || msg === 'atras' || msg === 'back') {
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
          const savedAddr = customerProfiles[from] && customerProfiles[from].savedAddress;
          reply = savedAddr ? savedAddressButtonsMessage(savedAddr, lang) : t.askAddress(SHOP_INFO.deliveryFee);
        } else {
          // Didn't say pickup/delivery — maybe they're adding one more item first.
          const orderResult = await attemptFreeOrder(rawMsg, session);
          if (orderResult.added.length > 0 || orderResult.soldOut.length > 0) {
            reply = [orderResultText(orderResult, session, lang), cartText(session.cart, lang), modeButtonsMessage(SHOP_INFO.deliveryFee, lang)];
          } else {
            parseFailed = true;
            reply = t.askModeInvalid;
          }
        }
        break;
      }

      case 'address': {
        if (msg === '0' || msg === 'atras' || msg === 'back') {
          session.step = 'mode';
          reply = modeButtonsMessage(SHOP_INFO.deliveryFee, lang);
          break;
        }
        const savedAddr = customerProfiles[from] && customerProfiles[from].savedAddress;
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
        session.address = rawMsg;
        session.step = 'confirm';
        // Fire-and-forget write-through — saved for next time regardless of
        // whether THIS order goes on to be confirmed or cancelled; it's a
        // convenience cache, not tied to any one order's outcome.
        saveCustomerProfile(from, { savedAddress: rawMsg }).catch(err => console.error(`Failed to save address for ${from}:`, err.message || err));
        reply = [cartText(session.cart, lang), confirmButtonsMessage(t.deliveryConfirm(session.address), lang)];
        break;
      }

      case 'confirm': {
        if (msg === '0' || msg === 'atras' || msg === 'back') {
          session.step = session.mode === 'delivery' ? 'address' : 'mode';
          reply = session.mode === 'delivery' ? t.askAddress(SHOP_INFO.deliveryFee) : modeButtonsMessage(SHOP_INFO.deliveryFee, lang);
          break;
        }
        if (msg === 'yes' || msg === 'si' || msg === 'sí' || msg === 'confirm' || msg === 'confirmo') {
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

          // Fire-and-forget: Sheets logging and driver notification both run
          // in the background WITHOUT being awaited here. The WhatsApp
          // confirmation must go out immediately regardless of how long
          // these take — same reasoning as the original Sheets-logging fix.
          logOrderToSheets(orderNumber, session, from).catch(err => {
            console.error('Background Sheets log failed:', err);
          });
          if (session.mode === 'delivery') {
            notifyDriver(orderNumber, session, from).catch(err => {
              console.error('Background driver notification failed:', err);
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
          sessions[from] = newSession();
        } else if (msg === 'no' || msg === 'cancel' || msg === 'cancelar') {
          sessions[from] = newSession();
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
        const replyArr = Array.isArray(reply) ? reply : [reply];
        let fallbackButtons = [];
        if (session.step === 'menu' || session.step === 'item') {
          fallbackButtons = categoryListMessages(lang);
        } else if (session.step === 'size' && session.pendingItem) {
          fallbackButtons = [sizeButtonsMessage(session.pendingItem, lang)];
        } else if (session.step === 'mode') {
          fallbackButtons = [modeButtonsMessage(SHOP_INFO.deliveryFee, lang)];
        } else if (session.step === 'confirm') {
          const reconfirm = session.mode === 'delivery' ? t.deliveryConfirm(session.address) : t.pickupConfirm;
          fallbackButtons = [confirmButtonsMessage(reconfirm, lang)];
        }
        reply = [...replyArr, t.stopGuessing, ...fallbackButtons];
      }

      // One-way ratchet per session (escalationStage only moves up) so the
      // same rung doesn't re-fire every single message once crossed.
      if (session.frustrationScore >= FRUSTRATION_ESCALATE_THRESHOLD && session.escalationStage < 3) {
        session.escalationStage = 3;
        escalateToHuman(from, session, lang, 'Auto-escalated: customer seems frustrated.');
        const replyArr = Array.isArray(reply) ? reply : [reply];
        reply = [...replyArr, t.agentRequested(SHOP_INFO.phone)];
      } else if (session.frustrationScore >= FRUSTRATION_SHORTCUT_THRESHOLD && session.escalationStage < 2) {
        session.escalationStage = 2;
        const replyArr = Array.isArray(reply) ? reply : [reply];
        reply = [...replyArr, t.frustrationShortcut];
      } else if (session.frustrationScore >= FRUSTRATION_SOFTEN_THRESHOLD && session.escalationStage < 1) {
        session.escalationStage = 1;
        const replyArr = Array.isArray(reply) ? reply : [reply];
        reply = [t.frustrationSoften, ...replyArr];
      }
    }

    sendReply(res, from, reply);
  } catch (err) {
    console.error('Webhook error:', err);
    // The webhook itself was already acked by the caller before this
    // function was ever invoked — this is just the best-effort customer
    // reply. sendReply's headersSent guard makes it safe either way.
    try {
      sendReply(res, from, "Sorry, something went wrong on our end — please try again in a moment. 🙏 / Lo sentimos, hubo un error — intenta de nuevo en un momento. 🙏");
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  refreshMenuFromSheet(); // load once at startup so it's not empty for the first 2 min
  setInterval(refreshMenuFromSheet, 2 * 60 * 1000);
  pollOrderStatus(); // silent baseline pass — establishes "current" status without notifying
  setInterval(pollOrderStatus, 60 * 1000);
  setInterval(sweepIdleSessions, 30 * 1000);
  refreshCustomerProfiles(); // load once at startup; changes rarely so a slower refresh than availability is fine
  setInterval(refreshCustomerProfiles, 5 * 60 * 1000);
});