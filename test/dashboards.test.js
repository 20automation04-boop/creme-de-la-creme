// Dashboard tests — kitchen, manager and driver.
//
// Entirely offline: BOT_DRY_RUN stubs every Sheets read/write and every
// WhatsApp send, and the sheet is SEEDED with fixture rows (see
// bot.dryRunSheetRows) so the endpoints' real parsing runs against known
// data. Nothing here touches the production spreadsheet or sends a message.
//
// Passwords are set here too, so the tests never depend on whatever happens
// to be in .env.
process.env.BOT_DRY_RUN = '1';
process.env.KITCHEN_PASSWORD = 'kitchen-test-pw';
process.env.MANAGER_PASSWORD = 'manager-test-pw';
process.env.DRIVER_PASSWORD = 'driver-test-pw';
process.env.GOOGLE_SHEETS_ID = 'test-sheet';

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

// ---- fixtures -------------------------------------------------------------
// Manager sheet shape, matching logOrderToSheets:
// [order#, timestamp, items, total, mode, language, phone, status]
const ROWS = [
  ['1001', '8/28/26, 1:00 PM', 'Vanilla Bean x2 - $14.00', '14',
    'Delivery - 19 Baymen Ave (blue gate, dog barks)', 'en', '+10000000001', 'Confirmed'],
  ['1002', '8/28/26, 1:05 PM', 'Coffee x1 - $7.00', '7.5',
    'Pickup', 'en', '+10000000002', 'Preparing'],
  ['1003', '8/28/26, 1:10 PM', 'Hot Dog x1 - $2.50', '2.50',
    'Delivery - Princess Margaret Dr\n📍 https://maps.google.com/?q=17.5,-88.2 (yellow door)', 'es', '+10000000003', 'Out for Delivery'],
  ['1004', '8/28/26, 1:15 PM', 'Mango x1 - $9.00', '9',
    'Pickup', 'en', '+10000000004', 'Completed'],   // closed — must be hidden
  ['1005', '8/28/26, 1:20 PM', 'Oreo Cookie x1 - $7.00', '7',
    'Delivery - Somewhere', 'en', '+10000000005', 'Cancelled'], // closed — must be hidden
];

function seed() {
  bot.dryRunSheetRows['Manager!A2:H'] = ROWS.map(r => r.slice());
  bot.dryRunSheetWrites.length = 0;
}

// ---- tiny fetch helper ----------------------------------------------------
function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(`${base}${path}`, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, res => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch (e) { /* html pages aren't json */ }
        resolve({ status: res.statusCode, body: out, json, setCookie: res.headers['set-cookie'] });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function loginAs(board, password) {
  const res = await req('POST', `/${board}/login`, { body: { password } });
  assert.equal(res.status, 200, `${board} login should succeed`);
  return res.setCookie[0].split(';')[0];
}

// ---- auth -----------------------------------------------------------------
test('every dashboard page renders, and its data is locked behind auth', async () => {
  for (const board of ['kitchen', 'manager', 'driver']) {
    const page = await req('GET', `/${board}`);
    assert.equal(page.status, 200, `/${board} page should render`);
    assert.match(page.body, /<title>/, `/${board} should be an HTML page`);
  }
  for (const path of ['/kitchen/orders', '/manager/data', '/manager/menu',
    '/manager/live', '/manager/customers', '/driver/orders']) {
    const res = await req('GET', path);
    assert.equal(res.status, 401, `${path} must reject an unauthenticated read`);
  }
});

test('each board rejects the other boards\' passwords', async () => {
  const pws = { kitchen: 'kitchen-test-pw', manager: 'manager-test-pw', driver: 'driver-test-pw' };
  for (const board of Object.keys(pws)) {
    for (const [other, pw] of Object.entries(pws)) {
      const res = await req('POST', `/${board}/login`, { body: { password: pw } });
      const expected = other === board ? 200 : 401;
      assert.equal(res.status, expected,
        `${board} login with the ${other} password should be ${expected}`);
    }
    const wrong = await req('POST', `/${board}/login`, { body: { password: 'nope' } });
    assert.equal(wrong.status, 401, `${board} must reject a wrong password`);
  }
});

// ---- kitchen --------------------------------------------------------------
test('kitchen lists only open orders, with money formatted', async () => {
  seed();
  const cookie = await loginAs('kitchen', 'kitchen-test-pw');
  const res = await req('GET', '/kitchen/orders', { cookie });
  assert.equal(res.status, 200);

  const nums = res.json.orders.map(o => o.orderNumber);
  assert.deepEqual(nums.sort(), ['1001', '1002', '1003'],
    'Completed and Cancelled orders must not appear on the kitchen board');

  const o = res.json.orders.find(x => x.orderNumber === '1002');
  assert.equal(o.total, '7.50', 'sheet value "7.5" should render as 7.50');
  assert.equal(o.rowNum, 3, 'rowNum must point at the real sheet row (header is row 1)');
});

test('kitchen status write is validated and guarded against a shifted row', async () => {
  seed();
  const cookie = await loginAs('kitchen', 'kitchen-test-pw');

  const bad = await req('POST', '/kitchen/status',
    { cookie, body: { rowNum: 2, orderNumber: '1001', status: 'Teleported' } });
  assert.equal(bad.status, 400, 'an unknown status must be rejected');

  const moved = await req('POST', '/kitchen/status',
    { cookie, body: { rowNum: 2, orderNumber: '9999', status: 'Preparing' } });
  assert.equal(moved.status, 409,
    'writing to a row that no longer holds that order must 409, not update a stranger');

  assert.equal(bot.dryRunSheetWrites.length, 0, 'neither rejected call may write');

  const ok = await req('POST', '/kitchen/status',
    { cookie, body: { rowNum: 2, orderNumber: '1001', status: 'Preparing' } });
  assert.equal(ok.status, 200);
  assert.equal(bot.dryRunSheetWrites.length, 1, 'a valid change writes exactly once');
  assert.equal(bot.dryRunSheetWrites[0].range, 'Manager!H2', 'writes the status column of that row');
  assert.deepEqual(bot.dryRunSheetWrites[0].values, [['Preparing']]);
});

test('kitchen message to a customer is validated', async () => {
  seed();
  const cookie = await loginAs('kitchen', 'kitchen-test-pw');

  const empty = await req('POST', '/kitchen/message',
    { cookie, body: { rowNum: 2, orderNumber: '1001', text: '   ' } });
  assert.equal(empty.status, 400, 'an empty message must be rejected');

  const moved = await req('POST', '/kitchen/message',
    { cookie, body: { rowNum: 2, orderNumber: '9999', text: 'hello' } });
  assert.equal(moved.status, 409, 'a shifted row must not message a different customer');

  bot.dryRunSent.length = 0;
  const ok = await req('POST', '/kitchen/message',
    { cookie, body: { rowNum: 2, orderNumber: '1001', text: 'the one marked [P] has pepper' } });
  assert.equal(ok.status, 200);
  assert.equal(bot.dryRunSent.length, 1, 'exactly one message goes out');
  assert.equal(bot.dryRunSent[0].to, '10000000001', "sent to that order's phone, '+' stripped");
  assert.match(bot.dryRunSent[0].message, /Créme De La Créme/, 'prefixed so it never reads like a stranger');
  assert.match(bot.dryRunSent[0].message, /has pepper/);
});

// ---- driver ---------------------------------------------------------------
test('driver board shows only open deliveries, with address and landmark split out', async () => {
  seed();
  const cookie = await loginAs('driver', 'driver-test-pw');
  const res = await req('GET', '/driver/orders', { cookie });
  assert.equal(res.status, 200);

  const nums = res.json.orders.map(o => o.orderNumber).sort();
  assert.deepEqual(nums, ['1001', '1003'],
    'pickups and closed orders must not appear on the driver board');

  const typed = res.json.orders.find(o => o.orderNumber === '1001');
  assert.equal(typed.address, '19 Baymen Ave');
  assert.equal(typed.landmark, 'blue gate, dog barks');
  assert.match(typed.mapsLink, /^https:\/\/maps\.google\.com\/\?q=19%20Baymen/,
    'a typed address is geocoded so the driver still gets a tappable link');
  assert.equal(typed.total, '14.00', 'sheet value "14" should render as 14.00');

  const pinned = res.json.orders.find(o => o.orderNumber === '1003');
  assert.equal(pinned.landmark, 'yellow door');
  assert.equal(pinned.mapsLink, 'https://maps.google.com/?q=17.5,-88.2',
    "a shared pin's own link must be used, not a re-geocoded guess");
});

test('driver cannot set arbitrary statuses', async () => {
  seed();
  const cookie = await loginAs('driver', 'driver-test-pw');
  for (const status of ['Preparing', 'Ready for Pickup', 'Cancelled', 'Confirmed']) {
    const res = await req('POST', '/driver/status',
      { cookie, body: { rowNum: 2, orderNumber: '1001', status } });
    assert.equal(res.status, 400, `a driver must not be able to set "${status}"`);
  }
  assert.equal(bot.dryRunSheetWrites.length, 0);

  for (const status of ['Out for Delivery', 'Completed']) {
    const res = await req('POST', '/driver/status',
      { cookie, body: { rowNum: 2, orderNumber: '1001', status } });
    assert.equal(res.status, 200, `a driver must be able to set "${status}"`);
  }
});

// ---- manager --------------------------------------------------------------
test('manager totals exclude cancelled orders', async () => {
  seed();
  const cookie = await loginAs('manager', 'manager-test-pw');
  const res = await req('GET', '/manager/data', { cookie });
  assert.equal(res.status, 200);

  // 14 + 7.5 + 2.50 + 9 = 33.00; the £7 Cancelled row must not count.
  assert.equal(res.json.allRevenue, '33.00', 'cancelled orders must not count toward revenue');
  assert.equal(res.json.allCount, 4, 'cancelled orders must not count toward order count');
  assert.equal(res.json.orders.length, 5, 'but they are still visible in history');
});

test('manager menu and live views return usable shapes', async () => {
  seed();
  const cookie = await loginAs('manager', 'manager-test-pw');

  const menu = await req('GET', '/manager/menu', { cookie });
  assert.equal(menu.status, 200);
  assert.ok(menu.json.categories.length > 0, 'the menu should not be empty');
  const item = menu.json.categories[0].items[0];
  for (const field of ['itemIndex', 'name', 'price', 'sized', 'soldOut']) {
    assert.ok(field in item, `menu items must expose "${field}"`);
  }

  const live = await req('GET', '/manager/live', { cookie });
  assert.equal(live.status, 200);
  assert.ok(Array.isArray(live.json.live), 'live sessions must be an array');
});

test('manager item edits reject bad prices and unknown items', async () => {
  seed();
  const cookie = await loginAs('manager', 'manager-test-pw');

  const cases = [
    [{ categoryId: '1', itemIndex: 1, price: -5 }, 400, 'a negative price'],
    [{ categoryId: '1', itemIndex: 1, price: 'free' }, 400, 'a non-numeric price'],
    [{ categoryId: '1', itemIndex: 1, largePrice: 0 }, 400, 'a zero large price'],
    [{ categoryId: '99', itemIndex: 1, price: 5 }, 400, 'an unknown category'],
    [{ categoryId: '1', itemIndex: 999, price: 5 }, 400, 'an unknown item index'],
  ];
  for (const [body, expected, label] of cases) {
    const res = await req('POST', '/manager/item', { cookie, body });
    assert.equal(res.status, expected, `${label} must be rejected`);
  }
});

test('manager pause toggle round-trips', async () => {
  seed();
  const cookie = await loginAs('manager', 'manager-test-pw');

  const on = await req('POST', '/manager/pause', { cookie, body: { paused: true } });
  assert.equal(on.json.ordersPaused, true);
  const check = await req('GET', '/manager/data', { cookie });
  assert.equal(check.json.ordersPaused, true, 'the pause must be visible to the dashboard');

  const off = await req('POST', '/manager/pause', { cookie, body: { paused: false } });
  assert.equal(off.json.ordersPaused, false, 'and must be reversible');
});

// ---- shared UI contract ---------------------------------------------------
test('every dashboard page is themeable and mobile-ready', async () => {
  for (const board of ['kitchen', 'manager', 'driver']) {
    const { body } = await req('GET', `/${board}`);
    assert.match(body, /width=device-width/, `/${board} needs a responsive viewport`);
    assert.match(body, /@media \(max-width/, `/${board} needs mobile styles`);
    assert.match(body, /data-theme="night"/, `/${board} needs a night palette`);
    assert.match(body, /function toggleTheme/, `/${board} needs a theme toggle`);
    // A hardcoded dark panel colour would render dark-on-dark in day mode.
    const stray = (body.match(/background:#(1[0-9a-f]|2[0-9a-f])[0-9a-f]{4}/g) || [])
      .filter(c => !/#161923|#12141a|#1c1f28/.test(c));
    assert.deepEqual(stray, [], `/${board} should use theme tokens, found ${stray.join(', ')}`);
  }
});
