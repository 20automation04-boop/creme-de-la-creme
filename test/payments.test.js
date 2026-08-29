'use strict';

// Tests for the online-payments SCAFFOLD (see the "ONLINE PAYMENTS" block in
// index.js, right above tryCheckoutWithUpsell, and the "Online payments"
// section in HANDOFF.md). No real payment provider is wired in — this
// exercises the plumbing (the 'payment' step, pendingPayments, and
// /payment-webhook) using test-only overrides for createPaymentLink and
// verifyPaymentWebhook, the two functions a real integration would replace.
//
// The single most important thing this file proves: with paymentsEnabled
// left at its default (false), checkout behaves EXACTLY as before this
// scaffold existed — see 'payments disabled by default...' below. That's
// also covered implicitly by every fixture in test/replays/, none of which
// touch these overrides.
process.env.BOT_DRY_RUN = '1';
process.env.GOOGLE_SHEETS_ID = 'test-sheet'; // so logOrderToSheets actually writes, proving the payment path shares it

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const bot = require('../index.js');

let server, base;

test.before(async () => {
  server = http.createServer(bot.app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

function postWebhook(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request(`${base}/payment-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    r.end(data);
  });
}

function fakeRes() {
  return { headersSent: false, sendStatus() { this.headersSent = true; } };
}

// Walks a fresh customer through language -> category -> item -> checkout up
// to (and including) "yes" at 'confirm', leaving the caller to inspect
// whatever happened at that final step. Mirrors the guided-order shape used
// throughout test/replays/*.json, just driven directly instead of via a
// fixture (this file needs mid-test control over the payment overrides that
// the generic replay harness doesn't expose).
async function orderUpToConfirmYes(from) {
  const send = (body) => bot.processWhatsAppMessage({ from, id: `pay-${from}-${Math.random()}`, type: 'text', text: { body } }, fakeRes());
  await send('1');       // English
  await send('1');       // category 1 (Frozen Drinks)
  await send('1');       // Vanilla Bean — tap-equivalent add, qtyExplicit=false
  await send('done');    // -> qtyrecap (one implicit-qty line)
  await send('1');       // "1" for the one cart line -> qtyrecap resolves -> notesrecap
  await send('skip');    // no special requests -> mode
  await send('pickup');  // -> confirm
  bot.dryRunSent.length = 0; // only care about what "yes" itself triggers
  await send('yes');
}

test('payments disabled by default — "yes" finalizes immediately, no payment step', async () => {
  const from = '19990000101';
  delete bot.sessions[from];
  delete bot.lastOrders[from];
  bot.setPaymentsEnabledForTests(false);

  await orderUpToConfirmYes(from);

  assert.equal(bot.sessions[from].step, 'menu', 'should reset straight back to menu, same as before this scaffold existed');
  assert.ok(bot.lastOrders[from], 'order should be finalized immediately');
  assert.equal(Object.keys(bot.pendingPayments).length, 0, 'nothing should be pending — payments are off');
});

test('a broken/unfinished payment adapter must never block a real order', async () => {
  const from = '19990000102';
  delete bot.sessions[from];
  delete bot.lastOrders[from];
  bot.setPaymentsEnabledForTests(true);
  bot.setPaymentAdapterForTests(async () => { throw new Error('not configured yet'); });

  await orderUpToConfirmYes(from);

  assert.ok(bot.lastOrders[from], 'order must still finalize even though the adapter is broken');
  assert.equal(bot.sessions[from].step, 'menu');

  bot.setPaymentsEnabledForTests(false); // reset for later tests in this file
});

test('a working adapter sends the customer a link and holds the order until the webhook confirms it', async () => {
  const from = '19990000103';
  delete bot.sessions[from];
  delete bot.lastOrders[from];
  bot.setPaymentsEnabledForTests(true);
  bot.setPaymentAdapterForTests(async (orderNumber) => ({
    url: `https://pay.example/checkout/${orderNumber}`,
    reference: `ref-${orderNumber}`,
  }));

  await orderUpToConfirmYes(from);

  const session = bot.sessions[from];
  assert.equal(session.step, 'payment');
  assert.ok(session.paymentReference, 'session should remember which pending payment this is');
  assert.ok(!bot.lastOrders[from], 'order must NOT be finalized yet — only the webhook does that');
  const pending = bot.pendingPayments[session.paymentReference];
  assert.ok(pending, 'pendingPayments should hold a snapshot keyed by the reference');
  assert.equal(pending.from, from);
  assert.equal(pending.cart.length, 1);

  const linkReply = bot.dryRunSent.at(-1);
  assert.ok(bot.replySummaryText(linkReply.message).includes(`https://pay.example/checkout/`), 'the payment link should actually be sent to the customer');

  // A webhook that doesn't verify (wrong signature, unknown shape) must be a
  // total no-op — no crash, no state change, order stays pending.
  bot.setPaymentWebhookVerifierForTests(() => null);
  const badResp = await postWebhook({ bogus: true });
  assert.equal(badResp.status, 200, 'still acks 200 even when verification fails, so the gateway does not retry forever');
  assert.ok(bot.pendingPayments[session.paymentReference], 'unverified webhook must not touch pending state');
  assert.ok(!bot.lastOrders[from]);

  // Now the real (stubbed) verification succeeds and reports payment.
  bot.setPaymentWebhookVerifierForTests(() => ({ reference: session.paymentReference, paid: true }));
  bot.dryRunSent.length = 0;
  const goodResp = await postWebhook({ reference: session.paymentReference, paid: true });
  assert.equal(goodResp.status, 200);

  assert.ok(!bot.pendingPayments[session.paymentReference], 'the pending entry should be consumed');
  assert.ok(bot.lastOrders[from], 'the webhook should finalize the order');
  assert.equal(bot.lastOrders[from].cart.length, 1);

  const confirmReply = bot.dryRunSent.find(s => s.to === from);
  assert.ok(confirmReply, 'the customer should get a WhatsApp confirmation once paid');
  assert.ok(/confirmed|#\d{4}/i.test(bot.replySummaryText(confirmReply.message)), 'the confirmation should read like a normal order-confirmed message');

  assert.equal(bot.sessions[from].step, 'menu', 'the session should reset the same way the cash path does');

  // Shares finalizeOrder with the cash path, so it must also share the
  // Sheets-logging side effect — proves this isn't a parallel code path that
  // could silently drift from the one staff actually rely on.
  const managerWrite = bot.dryRunSheetWrites.find(w => w.range.startsWith('Manager!'));
  assert.ok(managerWrite, 'a paid order must land in the Manager sheet exactly like a cash order does');

  bot.setPaymentsEnabledForTests(false); // reset for later tests in this file
});

test('cancelling at the payment step fully cancels the order and cleans up the pending entry', async () => {
  const from = '19990000104';
  delete bot.sessions[from];
  delete bot.lastOrders[from];
  bot.setPaymentsEnabledForTests(true);
  bot.setPaymentAdapterForTests(async (orderNumber) => ({
    url: `https://pay.example/checkout/${orderNumber}`,
    reference: `ref-cancel-${orderNumber}`,
  }));

  await orderUpToConfirmYes(from);
  const session = bot.sessions[from];
  assert.equal(session.step, 'payment');
  const reference = session.paymentReference;

  // 'cancel' is caught by the GLOBAL cancel command (same one every other
  // step uses) — it must still know to clean up pendingPayments even though
  // it doesn't know anything about the 'payment' step specifically.
  await bot.processWhatsAppMessage({ from, id: `pay-cancel-${from}`, type: 'text', text: { body: 'cancel' } }, fakeRes());

  assert.equal(bot.sessions[from].step, 'menu', 'a cancelled order resets the same way it does from anywhere else');
  assert.equal(bot.sessions[from].cart.length, 0, 'cancelling clears the cart, same as the existing global cancel command');
  assert.ok(!bot.pendingPayments[reference], 'the abandoned pending-payment entry must not leak');
  assert.ok(!bot.lastOrders[from]);

  bot.setPaymentsEnabledForTests(false); // reset for later tests in this file
});

// The FAQ's payment answer used to be a frozen "Cash only for now" string
// with no link to the flag, so turning payments on would have left the bot
// telling customers cash-only while checkout handed them a payment link —
// the same copy-vs-behaviour drift that let it quote a $5 delivery fee it
// never charged. Both flag states are asserted here because only pinning the
// "on" case would let the answer silently become wrong when it is off.
test('the payment FAQ follows PAYMENTS_ENABLED instead of a frozen string', async () => {
  const ask = async (from) => {
    const send = (body) => bot.processWhatsAppMessage({ from, id: `faq-${from}-${Math.random()}`, type: 'text', text: { body } }, fakeRes());
    await send('1'); // English
    bot.dryRunSent.length = 0;
    await send('how can I pay?');
    return bot.dryRunSent.filter(s => s.to === from).map(s => bot.replySummaryText(s.message)).join(' | ');
  };

  try {
    bot.setPaymentsEnabledForTests(false);
    const off = await ask('19995551201');
    assert.match(off, /cash only/i, `payments off should still say cash only, got: ${off}`);

    bot.setPaymentsEnabledForTests(true);
    const on = await ask('19995551202');
    assert.doesNotMatch(on, /cash only/i, `payments on must NOT claim cash only, got: ${on}`);
    assert.match(on, /online/i, `payments on should mention paying online, got: ${on}`);
  } finally {
    // Leave the flag as every other test in this file expects to find it.
    bot.setPaymentsEnabledForTests(false);
  }
});
