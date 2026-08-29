'use strict';

// Unit tests for applyMenuSheetRows — the Availability-sheet row parser
// that lets the owner add/rename/discontinue/reprice menu items without a
// deploy (see the big contract comment above applyMenuSheetRows in
// index.js). This runs in its own process (node --test isolates each test
// file), so it's safe for these tests to mutate the shared MENU array —
// nothing here can leak into replay.test.js's process.
//
// Every test calls resetMenuSheetTrackingForTests() first: applyMenuSheetRows
// tracks "which ids were seen last time" (knownSheetItemKeys) to detect
// discontinued items, and that hidden state assumes every real caller
// always passes a FULL current sheet snapshot — which these focused,
// single-purpose test row sets deliberately don't. Without the reset, an
// earlier test's small row set would look like "most of the menu just
// disappeared" to a later test and spuriously trip the mass-removal guard.
process.env.BOT_DRY_RUN = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const bot = require('../index.js');

function findItem(categoryId, name) {
  const cat = bot.MENU.find(c => c.id === categoryId);
  return cat && cat.items.find(i => i.name === name);
}

// A realistic "full sheet" snapshot — every real menu item's current row,
// same shape refreshMenuFromSheet actually reads. Used by the tests below
// that need to exercise the removal/mass-removal logic against a baseline
// resembling production, not a token 1-2 row set.
function fullSnapshotRows() {
  const rows = [];
  bot.MENU.forEach(cat => {
    cat.items.forEach((item, idx) => {
      const price = item.sizes ? item.sizes[0].price : item.price;
      const large = item.sizes ? item.sizes[item.sizes.length - 1].price : '';
      rows.push([`${cat.id}.${idx + 1}`, cat.category, item.name, 'TRUE', String(price), String(large)]);
    });
  });
  return rows;
}

test('updates price and availability on an existing item', () => {
  bot.resetMenuSheetTrackingForTests();
  const before = findItem('1', 'Coffee');
  assert.ok(before, 'fixture assumes category 1 has a "Coffee" item');

  const { soldOut } = bot.applyMenuSheetRows([
    ['1.2', 'Frozen Drinks', 'Coffee', 'FALSE', '9', ''],
  ]);

  assert.equal(before.price, 9);
  assert.ok(soldOut.has('1.2'));

  // Revert so the item is back to normal for any other test reading it.
  bot.applyMenuSheetRows([['1.2', 'Frozen Drinks', 'Coffee', 'TRUE', '7', '']]);
  assert.equal(before.price, 7);
});

test('renames an existing item when the Name cell differs', () => {
  bot.resetMenuSheetTrackingForTests();
  const item = findItem('1', 'Coffee');
  bot.applyMenuSheetRows([['1.2', 'Frozen Drinks', 'Iced Coffee', 'TRUE', '7', '']]);
  assert.equal(item.name, 'Iced Coffee');
  // Revert.
  bot.applyMenuSheetRows([['1.2', 'Frozen Drinks', 'Coffee', 'TRUE', '7', '']]);
  assert.equal(item.name, 'Coffee');
});

test('a bare category id creates a new flat-price item, and reports a correction', () => {
  bot.resetMenuSheetTrackingForTests();
  const cat = bot.MENU.find(c => c.id === '1');
  const before = cat.items.length;

  const { corrections } = bot.applyMenuSheetRows([
    ['1', 'Frozen Drinks', 'Mint Chip', 'TRUE', '7.5', ''],
  ]);

  assert.equal(cat.items.length, before + 1);
  const created = cat.items[cat.items.length - 1];
  assert.equal(created.name, 'Mint Chip');
  assert.equal(created.price, 7.5);
  assert.deepEqual(corrections, [{ rowIndex: 0, id: `1.${before + 1}` }]);

  // Clean up so later tests see the original item count.
  cat.items.pop();
});

test('a bare category id with a Large Price creates a sized item', () => {
  bot.resetMenuSheetTrackingForTests();
  const cat = bot.MENU.find(c => c.id === '6'); // Fruity Smoothie — sized items
  const before = cat.items.length;

  bot.applyMenuSheetRows([['6', 'Fruity Smoothie', 'Mango', 'TRUE', '6', '8']]);

  const created = cat.items[cat.items.length - 1];
  assert.ok(created.sizes, 'expected a sizes array since Large Price was populated');
  assert.equal(created.sizes[0].price, 6);
  assert.equal(created.sizes[1].price, 8);

  cat.items.pop();
  assert.equal(cat.items.length, before);
});

test('an unrecognized full id is skipped, not auto-created', () => {
  bot.resetMenuSheetTrackingForTests();
  const cat = bot.MENU.find(c => c.id === '1');
  const before = cat.items.length;
  bot.applyMenuSheetRows([['1.999', 'Frozen Drinks', 'Ghost Item', 'TRUE', '7', '']]);
  assert.equal(cat.items.length, before, 'a full "categoryId.N" id that is not already known must not silently create an item');
});

test('a bare id for an unknown category is skipped without throwing', () => {
  bot.resetMenuSheetTrackingForTests();
  assert.doesNotThrow(() => {
    bot.applyMenuSheetRows([['99', 'Nonexistent', 'Ghost Item', 'TRUE', '7', '']]);
  });
});

test('removing a row discontinues the item on the next refresh', () => {
  bot.resetMenuSheetTrackingForTests();
  const cat = bot.MENU.find(c => c.id === '1');

  // Snapshot BEFORE adding the temp item — fullSnapshotRows() reads live
  // MENU state, so calling it again after the add would include Temp Item
  // too and defeat the "its row disappeared" scenario being tested here.
  const originalRows = fullSnapshotRows();
  const baseline = [...originalRows, ['1', 'Frozen Drinks', 'Temp Item', 'TRUE', '7', '']];
  bot.applyMenuSheetRows(baseline);
  assert.ok(cat.items.some(i => i.name === 'Temp Item'));

  // Refresh again with the ORIGINAL snapshot — Temp Item's row is gone, so
  // it should be discontinued.
  bot.applyMenuSheetRows(originalRows);
  assert.ok(!cat.items.some(i => i.name === 'Temp Item'), 'item whose row disappeared should be removed from MENU');
});

test('a mass disappearance (>30%) is treated as a bad read, not a bulk discontinue', () => {
  bot.resetMenuSheetTrackingForTests();
  const allRows = fullSnapshotRows();
  bot.applyMenuSheetRows(allRows);
  const totalBefore = bot.MENU.reduce((n, c) => n + c.items.length, 0);

  const before = bot.dryRunSent.length;
  // "Refresh" with almost nothing in it — simulates a bad/partial read.
  bot.applyMenuSheetRows(allRows.slice(0, 2));

  const totalAfter = bot.MENU.reduce((n, c) => n + c.items.length, 0);
  assert.equal(totalAfter, totalBefore, 'a >30% single-cycle drop must not remove items');

  const alerts = bot.dryRunSent.slice(before);
  assert.ok(alerts.length > 0, 'expected the mass-removal guard to alert the owner');

  // Restore the real baseline.
  bot.applyMenuSheetRows(allRows);
});

// ---- STABLE ITEM IDENTITY ----
// Deleting a row splices the category array, so every later item shifts down
// one display position. Sold-out state is keyed by the item's stable sheetId
// precisely so it does NOT shift with it — this used to compare a new position
// against a flag recorded under the old one, which sold an out-of-stock item
// and refused its in-stock neighbour at the same time.

// Rows for exactly these items, addressed by their STABLE ids (not by their
// current position, which is the thing under test).
function rowsForItems(cat, items, soldOutName) {
  return items.map(it => [
    it.sheetId,
    cat.category,
    it.name,
    it.name === soldOutName ? 'FALSE' : 'TRUE',
    String(it.sizes ? it.sizes[0].price : it.price),
    '',
  ]);
}

test('sold-out state follows the item when an earlier row is discontinued', () => {
  bot.resetMenuSheetTrackingForTests();
  const cat = bot.MENU.find(c => c.items.length >= 4);
  const original = cat.items.slice();
  bot.applyMenuSheetRows(rowsForItems(cat, original));

  const discontinued = original[1];
  const soldOut = original[2];
  const survivors = original.filter(it => it !== discontinued);

  const res = bot.applyMenuSheetRows(rowsForItems(cat, survivors, soldOut.name));
  bot.soldOutIds.clear();
  res.soldOut.forEach(id => bot.soldOutIds.add(id));

  assert.ok(!cat.items.includes(discontinued), 'the discontinued item should be gone from the category');
  assert.ok(cat.items.indexOf(soldOut) !== original.indexOf(soldOut),
    'this test is only meaningful if the sold-out item actually shifted position');

  const pos = cat.items.indexOf(soldOut) + 1;
  assert.equal(bot.isItemSoldOut(cat.id, pos), true,
    `${soldOut.name} is sold out in the sheet and must still read as sold out at its new position ${pos}`);

  cat.items.forEach((item, i) => {
    if (item === soldOut) return;
    assert.equal(bot.isItemSoldOut(cat.id, i + 1), false,
      `${item.name} is in stock and must not inherit a shifted flag`);
  });
});

test('an item created after a discontinue does not reuse a surviving item id', () => {
  bot.resetMenuSheetTrackingForTests();
  const cat = bot.MENU.find(c => c.items.length >= 4);
  const original = cat.items.slice();
  bot.applyMenuSheetRows(rowsForItems(cat, original));

  const survivors = original.filter(it => it !== original[1]);
  // Discontinue one row and add a brand-new item (bare category id) in the
  // same refresh: the category is now shorter than its highest issued id, so a
  // naive `items.length + 1` would collide with a surviving item.
  bot.applyMenuSheetRows([
    ...rowsForItems(cat, survivors),
    [cat.id, cat.category, 'Test Brand New Item', 'TRUE', '3', ''],
  ]);

  const created = cat.items.find(i => i.name === 'Test Brand New Item');
  assert.ok(created, 'the new item should have been created');
  const ids = cat.items.map(i => i.sheetId);
  assert.equal(new Set(ids).size, ids.length, `sheetIds must be unique within a category, got: ${ids.join(', ')}`);
});

// A stored cart line (lastOrders, savedCarts) records the item's position at
// the moment it was added. Both the *repeat* command and the abandoned-cart
// resume re-check sold-out status later — by which point a discontinue may
// have slid a different item into that slot. Both now resolve through
// resolveCartLine(), so this covers the shared helper.
test('a repeat order re-checks the item it ordered, not whatever now sits in that slot', async () => {
  bot.resetMenuSheetTrackingForTests();
  const cat = bot.MENU.find(c => c.items.length >= 4);
  const original = cat.items.slice();
  bot.applyMenuSheetRows(rowsForItems(cat, original));

  const from = '19990000951';
  delete bot.sessions[from];
  delete bot.lastOrders[from];
  const res = () => ({ headersSent: false, sendStatus() { this.headersSent = true; } });
  let n = 0;
  const send = (body) => bot.processWhatsAppMessage(
    { from, id: `repeat-stale-${++n}`, type: 'text', text: { body } }, res());

  // Order the item at display position 3 and confirm it.
  // Tap the item, finish selecting, answer the one quantity question, skip
  // the notes recap, then confirm.
  for (const turn of ['1', cat.id, '3', 'done', '1', 'skip', 'pickup', 'yes']) await send(turn);
  const ordered = original[2];
  assert.equal(bot.lastOrders[from].cart[0].name, ordered.name);
  assert.equal(bot.lastOrders[from].cart[0].sheetId, ordered.sheetId,
    'the cart line must record the stable id, not just the position');

  // Discontinue the item ABOVE it (everything below shifts up one) and mark
  // the ordered item sold out.
  const survivors = original.filter(it => it !== original[1]);
  const r = bot.applyMenuSheetRows(rowsForItems(cat, survivors, ordered.name));
  bot.soldOutIds.clear();
  r.soldOut.forEach(id => bot.soldOutIds.add(id));
  assert.notEqual(cat.items.indexOf(ordered) + 1, 3,
    'this test is only meaningful if the ordered item actually shifted position');

  bot.dryRunSent.length = 0;
  await send('repeat');

  const cartNames = bot.sessions[from].cart.map(c => c.name);
  assert.ok(!cartNames.includes(ordered.name),
    `${ordered.name} is sold out and must not be re-added by repeat, got cart: ${cartNames.join(', ')}`);
});
