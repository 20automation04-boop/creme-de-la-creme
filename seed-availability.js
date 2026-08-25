// seed-availability.js
// Run ONCE to create and populate the "Availability" tab in your Google
// Sheet from your current menu. After that, you toggle items sold-out by
// unchecking the checkbox in the sheet itself — you do NOT need to run this
// again unless you add brand-new menu items to menu-data.js.
//
// Run with:  node seed-availability.js

require('dotenv').config();
const { google } = require('googleapis');
const MENU = require('./menu-data.js');

const sheetsAuth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

async function main() {
  if (!process.env.GOOGLE_SHEETS_ID) {
    console.error('❌ GOOGLE_SHEETS_ID is not set in .env');
    process.exit(1);
  }

  // Build one row per menu item: [ID, Category, Item Name, Available]
  // ID is "categoryId.itemIndex" — this is what the bot actually checks
  // against, so it stays unambiguous even for items that share a name
  // across categories (e.g. "Strawberry" appears 4 times in this menu).
  const rows = [['ID', 'Category', 'Item', 'Available']];
  MENU.forEach(cat => {
    cat.items.forEach((item, idx) => {
      rows.push([`${cat.id}.${idx + 1}`, cat.category, item.name, true]);
    });
  });

  console.log(`Writing ${rows.length - 1} menu items to the Availability tab...`);

  // Check whether the tab already exists so we don't wipe out any toggles
  // someone's already made if this gets run a second time by accident.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEETS_ID });
  const existingTab = meta.data.sheets.find(s => s.properties.title === 'Availability');

  if (existingTab) {
    console.log('⚠️  An "Availability" tab already exists.');
    console.log('   Re-running this would overwrite any items you\'ve already marked sold out.');
    console.log('   If you really want to reset it, delete the "Availability" tab in Google Sheets first, then run this again.');
    process.exit(0);
  }

  // Create the tab
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: 'Availability' } } }],
    },
  });

  // Write all the rows
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `Availability!A1:D${rows.length}`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  console.log('✅ Availability tab created and populated.');
  console.log('   Next: open the sheet, select column D (Available), and use');
  console.log('   Insert > Checkbox to turn those TRUE/FALSE values into tappable');
  console.log('   checkboxes. Uncheck an item to mark it sold out — the bot picks');
  console.log('   up the change within about 2 minutes.');
}

main().catch(err => {
  console.error('❌ Failed:', err.message || err);
  process.exit(1);
});