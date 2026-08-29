'use strict';

// Security regression tests for the externally reachable HTTP surface.
//
// These exist because every bug they cover was a SILENT one: the endpoint
// answered 200 and the bot carried on, so nothing in the logs or the replay
// suite would ever have flagged it. They drive the real Express app over a
// real socket rather than calling handlers directly, because the defects were
// in the request-handling edges (a missing header, an unset env var), not in
// business logic.
//
// Env must be set BEFORE requiring index.js — CHAKRA_WEBHOOK_SECRET is read
// into a const at module load. `node --test` runs each test file in its own
// process, so this does not leak into the replay suite.
process.env.BOT_DRY_RUN = '1';
process.env.CHAKRA_WEBHOOK_SECRET = 'test-secret';
process.env.KITCHEN_PASSWORD = 'correct-horse-battery-staple';
process.env.MANAGER_PASSWORD = 'manager-correct-horse-battery';
process.env.DRIVER_PASSWORD = 'driver-correct-horse-battery';
delete process.env.WEBHOOK_VERIFY_TOKEN; // the fail-open case, on purpose

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

const bot = require('../index.js');

let server, base;
test.before(async () => {
  server = http.createServer(bot.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

// The owner number is the highest-value `from` to forge: isOwner() trusts it
// outright, and owner commands can pause the whole shop.
const OWNER = bot.OWNER_NUMBERS[0];
const body = (from, id, text) => JSON.stringify({
  entry: [{ changes: [{ value: { messages: [{ from, id, type: 'text', text: { body: text } }] } }] }],
});
const sign = (raw) => crypto.createHmac('sha256', 'test-secret').update(raw).digest('hex');

async function post(path, raw, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: raw,
  });
  return res;
}

test('unsigned webhook is rejected when a secret is configured', async () => {
  // The original bypass: verifyChakraSignature returned null for a MISSING
  // signature and the route only rejected on `false`, so omitting the header
  // skipped HMAC verification entirely — and with a forged `from`, that meant
  // anyone could issue owner commands.
  const raw = body(OWNER, 'sec-unsigned', 'stats');
  const res = await post('/whatsapp', raw);
  assert.equal(res.status, 403, 'an unsigned request must not be accepted');
});

test('webhook with a wrong signature is rejected', async () => {
  const raw = body('19995550001', 'sec-badsig', 'hello');
  const res = await post('/whatsapp', raw, { 'X-Chakra-Signature-256': 'deadbeef' });
  assert.equal(res.status, 403);
});

test('correctly signed webhook is still accepted', async () => {
  // The half that matters just as much: the fix must not lock out real traffic.
  const raw = body('19995550002', 'sec-goodsig', 'hello');
  const res = await post('/whatsapp', raw, { 'X-Chakra-Signature-256': sign(raw) });
  assert.equal(res.status, 200);
});

test('verify endpoint does not hand out the challenge when the token is unset', async () => {
  // `token === process.env.WEBHOOK_VERIFY_TOKEN` was `undefined === undefined`
  // for a request carrying no token at all — which is true, so the challenge
  // came straight back to any caller.
  const res = await fetch(`${base}/whatsapp?hub.mode=subscribe&hub.challenge=pwned`);
  assert.equal(res.status, 403);
  assert.notEqual(await res.text(), 'pwned', 'the challenge must not be echoed');
});

test('the correct kitchen password is accepted and its cookie is Secure', async () => {
  // Declared BEFORE the lockout test on purpose: a correct password inside an
  // active lockout legitimately returns 429, so running this second would let
  // the test pass while asserting nothing.
  const res = await post('/kitchen/login', JSON.stringify({ password: 'correct-horse-battery-staple' }));
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie') || '';
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i, 'the kitchen cookie is a bearer token for customer PII');
});

test('kitchen login locks out after repeated wrong passwords', async () => {
  const attempt = () => post('/kitchen/login', JSON.stringify({ password: 'wrong' }));
  const codes = [];
  for (let i = 0; i < 14; i++) codes.push((await attempt()).status);
  assert.ok(codes.includes(429), `expected a 429 lockout, got: ${codes.join(',')}`);
  assert.equal(codes[0], 401, 'the first wrong guess should be a plain 401, not a lockout');
});

// The manager and driver boards were added after /kitchen and did not inherit
// its login hardening: both accepted unlimited password guesses, and neither
// cookie carried Secure. /manager guards strictly MORE than /kitchen does —
// sales, the customer list, live conversations, prices, pause-orders and the
// promo broadcast — so it was the least-defended door to the most valuable
// room. These pin all three boards to the same bar.
//
// Ordering below is load-bearing, same as the kitchen pair above: every
// "correct password" test has to run before anything hammers that board,
// because a correct password inside an active lockout legitimately returns
// 429 and would let the test pass while asserting nothing.
for (const board of ['manager', 'driver']) {
  test(`the correct ${board} password is accepted and its cookie is Secure`, async () => {
    const res = await post(`/${board}/login`, JSON.stringify({ password: `${board}-correct-horse-battery` }));
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie') || '';
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i, `the ${board} cookie is a year-long bearer token and must never cross plain HTTP`);
    assert.match(cookie, /SameSite=Lax/i);
  });
}

// Doubles as the driver board's own lockout test. The two assertions have to
// share one test because they share one precondition: the manager board can
// only be shown to survive the driver's lockout while it is still unlocked,
// which stops being true the moment the manager lockout test below runs.
test('driver login locks out, and that lockout does not reach the manager board', async () => {
  const codes = [];
  for (let i = 0; i < 14; i++) {
    codes.push((await post('/driver/login', JSON.stringify({ password: 'wrong' }))).status);
  }
  assert.ok(codes.includes(429), `expected a 429 lockout, got: ${codes.join(',')}`);
  assert.equal(codes[0], 401, 'the first wrong guess should be a plain 401, not a lockout');

  // Separate limiter keys per board — a brute-force run against one must not
  // lock staff out of another mid-shift.
  const manager = await post('/manager/login', JSON.stringify({ password: 'manager-correct-horse-battery' }));
  assert.notEqual(manager.status, 429, 'the driver lockout leaked into the manager board');
});

test('manager login locks out after repeated wrong passwords', async () => {
  const codes = [];
  for (let i = 0; i < 14; i++) {
    codes.push((await post('/manager/login', JSON.stringify({ password: 'wrong' }))).status);
  }
  assert.ok(codes.includes(429), `expected a 429 lockout, got: ${codes.join(',')}`);
  assert.equal(codes[0], 401, 'the first wrong guess should be a plain 401, not a lockout');
});
