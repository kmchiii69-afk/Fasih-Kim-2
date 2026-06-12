// api/sheets.js
// Reads your PRIVATE Google Sheets via a service account and returns clean JSON.
// Runs on Vercel as a serverless function. The dashboard (index.html) fetches it
// from the same origin: /api/sheets?id=SPREADSHEET_ID&tab=TabName
//
// Env vars required (set in Vercel → Settings → Environment Variables):
//   GOOGLE_SERVICE_ACCOUNT_KEY  → the full service-account JSON (or its base64)
//   DASHBOARD_TOKEN             → optional shared secret to lock the endpoint

const { google } = require('googleapis');

// Parse the service-account credentials from the env var (raw JSON or base64).
function getCreds() {
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var is not set');
  raw = raw.trim();
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const creds = JSON.parse(json);
  // Vercel sometimes escapes newlines in the private key — normalise them.
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  return creds;
}

function makeSheetsClient() {
  const creds = getCreds();
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  return google.sheets({ version: 'v4', auth });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, max-age=0'); // always fresh
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Optional shared-secret gate (only enforced if DASHBOARD_TOKEN is set).
  const required = process.env.DASHBOARD_TOKEN;
  if (required && req.query.token !== required) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = req.query.id;   // spreadsheet ID (the part of the URL between /d/ and /edit)
  const tab = req.query.tab; // tab/sheet name; omit to list the tabs in the spreadsheet
  if (!id) return res.status(400).json({ error: 'Missing ?id (spreadsheet id)' });

  try {
    const sheets = makeSheetsClient();

    // No tab → return the list of tab names so the dashboard can offer a dropdown.
    if (!tab) {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: id,
        fields: 'sheets.properties.title',
      });
      const tabs = (meta.data.sheets || []).map(s => s.properties.title);
      return res.status(200).json({ tabs });
    }

    // Tab provided → return that tab's rows as an array of {header: value} objects.
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: id,
      range: `'${String(tab).replace(/'/g, "''")}'`, // whole tab, name safely quoted
    });
    const values = resp.data.values || [];
    if (!values.length) return res.status(200).json({ headers: [], rows: [] });

    const headers = values[0].map(h => String(h).trim());
    const rows = values.slice(1).map(r => {
      const o = {};
      headers.forEach((h, i) => { o[h] = r[i] != null ? r[i] : ''; });
      return o;
    });
    return res.status(200).json({ headers, rows });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
