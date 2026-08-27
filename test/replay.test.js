'use strict';

// Replay tests: feed realistic conversations through the actual FSM
// (processWhatsAppMessage in ../index.js) and assert on the resulting
// state/replies. Catches step-transition/cart-math regressions that manual
// spot-testing misses. Run with `npm run test:replay`; wired into
// `npm run predeploy` so it runs before every `railway up`.
//
// BOT_DRY_RUN=1 MUST be set before requiring index.js — it makes every real
// outbound side effect (WhatsApp sends, Sheets reads/writes) a captured/
// stubbed no-op, so this suite is safe to run even with real production
// credentials sitting in .env. See the BOT_DRY_RUN guards in index.js
// (sendWhatsAppMessage, markAsRead, the `sheets` stub install) for what
// exactly gets short-circuited.
//
// Scope: this exercises the FSM/state-machine layer (steps, cart math, menu
// navigation, language, BACK, owner commands, the escalation ladder) — NOT
// real Sheets integration, which stays covered by this project's existing
// live-smoke-test practice. Gemini/AI calls are left real (no mock), so
// fixtures assert on structural outcomes (step reached, cart total, a
// short distinctive substring) rather than exact AI-generated wording.
process.env.BOT_DRY_RUN = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../index.js');

// Fixture "from" values may use these placeholders instead of a literal
// number, resolved against the bot's real config so fixtures never hardcode
// (or drift from) the actual OWNER_NUMBERS/DRIVER_NUMBERS entries.
function resolvePlaceholder(value) {
  if (value === '__OWNER__') return bot.OWNER_NUMBERS[0];
  if (value === '__DRIVER__') return bot.DRIVER_NUMBERS[0];
  return value;
}

function makeMessage(from, id, turn) {
  if (turn.buttonId) return { from, id, type: 'interactive', interactive: { button_reply: { id: turn.buttonId } } };
  if (turn.listId) return { from, id, type: 'interactive', interactive: { list_reply: { id: turn.listId } } };
  return { from, id, type: 'text', text: { body: turn.in } };
}

function fakeRes() {
  return { headersSent: false, sendStatus() { this.headersSent = true; } };
}

// Resolves a dotted field path against a session object, e.g. "address" or
// "address.length" (for expectFieldAtLeast/expectFieldAtMost).
function readSessionField(session, path) {
  return path.split('.').reduce((v, key) => (v === undefined || v === null ? v : v[key]), session);
}

function repliesText(sent, to) {
  return sent
    .filter(s => to === undefined || s.to === to)
    .map(s => bot.replySummaryText(s.message))
    .join(' | ');
}

const fixturesDir = path.join(__dirname, 'replays');
const fixtureFiles = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.json'));
assert.ok(fixtureFiles.length > 0, 'no replay fixtures found in test/replays — did the directory get cleared?');

for (const file of fixtureFiles) {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8'));
  const from = resolvePlaceholder(fixture.from);

  test(fixture.name || file, async () => {
    // Isolate this fixture's conversation state even if a `from` were ever
    // accidentally reused across fixtures (each fixture file should use its
    // own unique number in practice — see the other fixtures for the
    // convention — but this makes re-running a single fixture idempotent
    // too).
    delete bot.sessions[from];
    delete bot.lastOrders[from];
    delete bot.savedCarts[from];
    bot.soldOutIds.clear();

    for (let i = 0; i < fixture.turns.length; i++) {
      const turn = fixture.turns[i];
      const label = `turn ${i} (${turn.in || turn.buttonId || turn.listId || 'setup'})`;

      // Setup-only actions some fixtures need before the message below is
      // processed — e.g. marking an item sold out, or fast-forwarding a
      // session's idle clock to exercise sweepIdleSessions().
      if (turn.markSoldOut) turn.markSoldOut.forEach(id => bot.soldOutIds.add(id));
      if (turn.clearSoldOut) bot.soldOutIds.clear();
      if (turn.setLastMessageAtMsAgo !== undefined) {
        const s = bot.sessions[from];
        assert.ok(s, `${label}: setLastMessageAtMsAgo needs an existing session`);
        s.lastMessageAt = Date.now() - turn.setLastMessageAtMsAgo;
      }
      if (turn.sweepIdle) bot.sweepIdleSessions();
      if (turn.presetCartLines !== undefined) {
        // Directly seeds N distinct dummy cart lines — for cart-cap tests,
        // where actually walking the guided flow N times would make the
        // fixture enormous and slow for no extra coverage value. Needs an
        // existing session (fixtures should pick a language first).
        const s = bot.sessions[from];
        assert.ok(s, `${label}: presetCartLines needs an existing session`);
        for (let n = 0; n < turn.presetCartLines; n++) {
          s.cart.push({ name: `Dummy Item ${n}`, price: 1, qty: 1, note: '', categoryId: null, itemIndex: null });
        }
      }

      let sent = [];
      if (turn.in !== undefined || turn.buttonId || turn.listId) {
        const message = makeMessage(from, `${fixture.name || file}-${i}`, turn);
        const before = bot.dryRunSent.length;
        await bot.processWhatsAppMessage(message, fakeRes());
        sent = bot.dryRunSent.slice(before);
      }

      const replyText = repliesText(sent, from);

      // processWhatsAppMessage has its own top-level try/catch (by design —
      // a bug in one customer's message must never take down the process)
      // that swallows the real error and replies with a generic "something
      // went wrong" message instead of rejecting. That's the right call in
      // production, but it means a genuine crash would otherwise pass this
      // suite silently. Fixtures that intentionally expect that generic
      // fallback (there currently are none) can opt out with `allowError`.
      if (!turn.allowError && sent.length > 0) {
        assert.ok(
          !replyText.includes('something went wrong') && !replyText.includes('hubo un error'),
          `${label}: got the generic error-fallback reply, meaning something threw inside processWhatsAppMessage: ${replyText}`
        );
      }

      if (turn.expectStep !== undefined) {
        const session = bot.sessions[from];
        assert.equal(session && session.step, turn.expectStep, `${label}: expected step "${turn.expectStep}", got "${session && session.step}"`);
      }
      if (turn.expectCartTotal !== undefined) {
        const total = bot.cartTotal(bot.sessions[from].cart);
        assert.ok(Math.abs(total - turn.expectCartTotal) < 0.005, `${label}: expected cart total ${turn.expectCartTotal}, got ${total}`);
      }
      if (turn.expectCartLength !== undefined) {
        assert.equal(bot.sessions[from].cart.length, turn.expectCartLength, `${label}: expected ${turn.expectCartLength} cart line(s), got ${bot.sessions[from].cart.length}`);
      }
      if (turn.expectReplyContains) {
        assert.ok(
          replyText.toLowerCase().includes(turn.expectReplyContains.toLowerCase()),
          `${label}: expected reply to contain "${turn.expectReplyContains}", got: ${replyText}`
        );
      }
      if (turn.expectReplyNotContains) {
        assert.ok(
          !replyText.toLowerCase().includes(turn.expectReplyNotContains.toLowerCase()),
          `${label}: expected reply to NOT contain "${turn.expectReplyNotContains}", got: ${replyText}`
        );
      }
      if (turn.expectNoReply) {
        assert.equal(sent.length, 0, `${label}: expected no reply, got: ${replyText}`);
      }
      if (turn.expectFieldAtLeast) {
        const [field, min] = turn.expectFieldAtLeast;
        const got = readSessionField(bot.sessions[from], field);
        assert.ok(got >= min, `${label}: expected session.${field} >= ${min}, got ${got}`);
      }
      if (turn.expectFieldAtMost) {
        const [field, max] = turn.expectFieldAtMost;
        const got = readSessionField(bot.sessions[from], field);
        assert.ok(got <= max, `${label}: expected session.${field} <= ${max}, got ${got}`);
      }
      if (turn.expectSentTo) {
        const target = resolvePlaceholder(turn.expectSentTo);
        const gotSentToTarget = sent.some(s => s.to === target);
        assert.ok(gotSentToTarget, `${label}: expected a message sent to ${target}, but sends this turn went to: ${sent.map(s => s.to).join(', ') || '(none)'}`);
      }
      if (turn.expectNotSentTo) {
        const target = resolvePlaceholder(turn.expectNotSentTo);
        const gotSentToTarget = sent.some(s => s.to === target);
        assert.ok(!gotSentToTarget, `${label}: expected NO message sent to ${target} this turn, but one was sent`);
      }
    }
  });
}
