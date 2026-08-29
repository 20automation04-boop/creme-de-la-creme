// seed-customers.js
// Run ONCE to create the "Customers" tab in your Google Sheet. The bot
// writes to it itself from then on (saved delivery address + allergy/
// preference notes, keyed by phone) — this script only creates the empty
// tab with headers so those writes have somewhere to land.
//
// Run with:  node seed-customers.js

require('dotenv').config();
const { google } = require('googleapis');

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

  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEETS_ID });
  const existingTab = meta.data.sheets.find(s => s.properties.title === 'Customers');

  if (existingTab) {
    console.log('✅ Customers tab already exists — nothing to do.');
    process.exit(0);
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: 'Customers' } } }],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'Customers!A1:F1',
    valueInputOption: 'RAW',
    requestBody: { values: [['Phone', 'SavedAddress', 'Notes', 'UpdatedAt', 'PromoOptIn', 'Language']] },
  });

  console.log('✅ Customers tab created with headers (Phone, SavedAddress, Notes, UpdatedAt, PromoOptIn, Language).');
  console.log('   The bot fills this in on its own — a customer\'s delivery address is saved');
  console.log('   automatically the first time they type one in, and *note <text>* / *nota <texto>*');
  console.log('   lets them save an allergy or preference note. Both show up to staff when relevant');
  console.log('   (delivery notifications, human handoffs) — nothing to configure here by hand.');
}

main().catch(err => {
  console.error('❌ Failed:', err.message || err);
  process.exit(1);
});
