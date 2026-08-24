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

    // Filter mode — either a single day or a whole month.
    //   ?date=YYYY-MM-DD  → single day
    //   ?month=YYYY-MM    → whole calendar month
    //   (neither)         → today (UK)
    const dateParam = req.query?.date;
    const monthParam = req.query?.month;
    let filterPrefix, filterLabel;
    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      filterPrefix = monthParam;      // "2026-08" matches all "2026-08-*" rows
      filterLabel = monthParam;
    } else if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      filterPrefix = dateParam;
      filterLabel = dateParam;
    } else {
      filterPrefix = ukToday();
      filterLabel = filterPrefix;
    }

    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${tab.replace(/'/g, "''")}'!A:N`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const values = resp.data.values || [];
    if (values.length < 2) return send(res, 200, { date: filterLabel, rows: [] });

    const headers = values[0].map(h => String(h).trim());
    const bookingTimeIdx = headers.indexOf("Booking Time");

    // Match on "Booking Time" starting with the prefix — YYYY-MM-DD for day,
    // YYYY-MM for month. Both work because Booking Time values look like
    // "2026-08-11 14:30".
    const rows = values.slice(1)
      .filter(r => String(r[bookingTimeIdx] || "").startsWith(filterPrefix))
      .map((r, i) => {
        const o = { _rowNumber: values.indexOf(r) + 1 };
        headers.forEach((h, j) => { o[h] = r[j] !== undefined ? r[j] : ""; });
        return o;
      })
      // Sort by booking time descending — most recent bookings first
      .sort((a, b) => String(b["Booking Time"]).localeCompare(String(a["Booking Time"])));

    return send(res, 200, { date: filterLabel, rows });
  } catch (err) {
    return send(res, 500, { error: err && err.message ? err.message : String(err) });
  }
}
