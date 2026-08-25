// test-sheets.js
// Standalone test — calls logOrderToSheets() directly with fake order data.
// Doesn't touch Twilio, Express, or WhatsApp at all. Just checks: can this
// server account actually write to your Google Sheet?
//
// Run with:  node test-sheets.js
// Then check your "Kitchen" and "Manager Log" tabs for a new test row.

require('dotenv').config();
const { google } = require('googleapis');

console.log('DEBUG email:', JSON.stringify(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL));
console.log('DEBUG key length:', (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').length);
console.log('DEBUG sheet id:', JSON.stringify(process.env.GOOGLE_SHEETS_ID));

// Object-style constructor (the modern, reliable form). The old positional
// form — new JWT(email, null, key, scopes) — is deprecated and on recent
// google-auth-library versions can silently fail to attach credentials,
// which is exactly the "missing required authentication credential" error.
const sheetsAuth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Sheets call timed out')), ms)),
  ]);
}

async function logOrderToSheets(orderNumber, session) {
  if (!process.env.GOOGLE_SHEETS_ID) {
    console.error('❌ GOOGLE_SHEETS_ID is not set — nothing to write to.');
    return;
  }

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
  const modeText = session.mode === 'delivery' ? `Delivery - ${session.address}` : 'Pickup';

  console.log('Authorizing with Google...');
  const tokens = await withTimeout(sheetsAuth.authorize(), 8000);
  console.log('✅ Authorized. Token type:', tokens.token_type, '| Expires:', new Date(tokens.expiry_date).toLocaleString());

  console.log('Attempting to write to Manager tab...');
  await withTimeout(sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'Manager!A:F',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[orderNumber, timestamp, itemsWithPrice, total, modeText, session.language]] },
  }), 8000);
  console.log('✅ Manager tab write succeeded.');

  console.log('Attempting to write to Kitchen tab...');
  await withTimeout(sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'Kitchen!A:D',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[orderNumber, timestamp, itemsNoPrice, modeText]] },
  }), 8000);
  console.log('✅ Kitchen tab write succeeded.');
}

// ---- Fake test order ----
const fakeSession = {
  cart: [
    { name: 'Hot Dog', price: 2.5, qty: 2, note: '' },
    { name: 'Papaya (Large)', price: 8, qty: 1, note: 'extra ice' },
  ],
  mode: 'pickup',
  address: null,
  language: 'en',
};

const testOrderNumber = 9999;

logOrderToSheets(testOrderNumber, fakeSession)
  .then(() => {
    console.log('\n🎉 Test complete — check your Google Sheet for order #9999.');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Test failed with error:');
    console.error(err.message || err);
    if (err.response?.data) {
      console.error('API response data:', JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  });