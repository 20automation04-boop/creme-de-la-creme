// add-price-columns.js
// One-time migration: adds "Price" and "Large Price" columns to the existing
// "Availability" tab, pre-filled with each item's CURRENT price(s) from
// menu-data.js — so the sheet starts populated with real numbers to edit,
// not blank cells. Does NOT touch the existing ID/Category/Item/Available
// columns or any sold-out toggles already made.
//
// Safe to re-run: if the Price/Large Price headers already exist, this exits
// without changing anything.
//
// Run with:      node add-price-columns.js
// Preview first: node add-price-columns.js --dry-run

require('dotenv').config();
const { google } = require('googleapis');
const MENU = require('./menu-data.js');

const DRY_RUN = process.argv.includes('--dry-run');

const sheetsAuth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

function itemKey(categoryId, itemIndex) {
  return `${categoryId}.${itemIndex}`;
}

async function main() {
  if (!process.env.GOOGLE_SHEETS_ID) {
    console.error('❌ GOOGLE_SHEETS_ID is not set in .env');
    process.exit(1);
  }

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'Availability!A1:F',
  });
  const rows = existing.data.values || [];
  if (rows.length === 0) {
    console.error('❌ The "Availability" tab is empty or missing — run seed-availability.js first.');
    process.exit(1);
  }

  const header = rows[0];
  if (header[4] === 'Price' || header[5] === 'Large Price') {
    console.log('✅ Price columns already exist — nothing to do.');
    process.exit(0);
  }

  // Build categoryId.itemIndex -> item lookup so each existing row can be
  // filled with its real current price(s).
  const priceById = new Map();
  MENU.forEach(cat => {
    cat.items.forEach((item, idx) => {
      priceById.set(itemKey(cat.id, idx + 1), item.sizes
        ? { price: item.sizes[0].price, large: item.sizes[item.sizes.length - 1].price }
        : { price: item.price, large: '' });
    });
  });

  const updates = [['Price', 'Large Price']]; // header row for columns E:F
  for (let i = 1; i < rows.length; i++) {
    const id = (rows[i][0] || '').trim();
    const found = priceById.get(id);
    updates.push(found ? [found.price, found.large] : ['', '']);
  }

  console.log(`Will write Price/Large Price for ${updates.length - 1} rows (columns E:F) in the "Availability" tab.`);
  console.log('Preview of first 5 data rows:');
  updates.slice(0, 6).forEach((r, i) => console.log(`  ${i === 0 ? 'header' : 'row ' + i}:`, r));

  if (DRY_RUN) {
    console.log('\n--dry-run: no changes written. Re-run without --dry-run to apply.');
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `Availability!E1:F${updates.length}`,
    valueInputOption: 'RAW',
    requestBody: { values: updates },
  });

  console.log('✅ Price/Large Price columns added and pre-filled with current menu prices.');
  console.log('   Edit a number in column E (or F for the Large size) and the bot picks it up within about 2 minutes.');
  console.log('   Leaving a cell blank does NOT revert to the original price — retype the original number to undo a change.');
}

main().catch(err => {
  console.error('❌ Failed:', err.message || err);
  process.exit(1);
});
