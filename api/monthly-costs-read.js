// /api/monthly-costs-read.js — reads all monthly cost rows for the form's history.
// Read-only endpoint, uses readonly scope.
//
// ENV VARS:
//   GOOGLE_SERVICE_ACCOUNT_KEY, MONTHLY_COSTS_SHEET_ID, MONTHLY_COSTS_TAB

import { google } from "googleapis";

function send(res, status, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(JSON.stringify(obj));
}

let cachedAuth = null;
function getAuth() {
  if (cachedAuth) return cachedAuth;
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
  raw = raw.trim();
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const creds = JSON.parse(json);
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  cachedAuth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return cachedAuth;
}

export default async function handler(req, res) {
  try {
    const sheetId = process.env.MONTHLY_COSTS_SHEET_ID;
    const tab = (process.env.MONTHLY_COSTS_TAB || "Sheet1").trim();
    if (!sheetId) return send(res, 500, { error: "MONTHLY_COSTS_SHEET_ID not set" });

    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const range = `'${tab.replace(/'/g, "''")}'!A:D`;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const values = resp.data.values || [];
    if (values.length < 2) return send(res, 200, { headers: values[0] || [], rows: [] });

    const headers = values[0].map(h => String(h).trim());
    const rows = values.slice(1).map(r => {
      const o = {};
      headers.forEach((h, i) => { o[h] = r[i] !== undefined ? r[i] : ""; });
      return o;
    });
    return send(res, 200, { headers, rows });
  } catch (err) {
    return send(res, 500, { error: err && err.message ? err.message : String(err) });
  }
}
