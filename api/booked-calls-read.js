// /api/booked-calls-read.js — returns rows filtered to a specific date (default today, UK).
// ENV: GOOGLE_SERVICE_ACCOUNT_KEY, BOOKED_CALLS_SHEET_ID, BOOKED_CALLS_TAB

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

function ukToday() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export default async function handler(req, res) {
  try {
    const sheetId = process.env.BOOKED_CALLS_SHEET_ID;
    const tab = (process.env.BOOKED_CALLS_TAB || "Sheet1").trim();
    if (!sheetId) return send(res, 500, { error: "BOOKED_CALLS_SHEET_ID not set" });

    // Date filter — either explicit ?date=YYYY-MM-DD, or "today" in UK time.
    const targetDate = (req.query?.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? req.query.date : ukToday();

    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${tab.replace(/'/g, "''")}'!A:K`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const values = resp.data.values || [];
    if (values.length < 2) return send(res, 200, { date: targetDate, rows: [] });

    const headers = values[0].map(h => String(h).trim());
    const callTimeIdx = headers.indexOf("Call Time");

    // Match on "Call Time" starting with the target date (format is "YYYY-MM-DD HH:mm")
    const rows = values.slice(1)
      .filter(r => String(r[callTimeIdx] || "").startsWith(targetDate))
      .map((r, i) => {
        const o = { _rowNumber: values.indexOf(r) + 1 }; // 1-indexed sheet row
        headers.forEach((h, j) => { o[h] = r[j] !== undefined ? r[j] : ""; });
        return o;
      })
      // Sort by call time ascending
      .sort((a, b) => String(a["Call Time"]).localeCompare(String(b["Call Time"])));

    return send(res, 200, { date: targetDate, rows });
  } catch (err) {
    return send(res, 500, { error: err && err.message ? err.message : String(err) });
  }
}
