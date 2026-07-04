// /api/scorecard-write.js — Vercel serverless function (Node runtime)
// Upserts a CEO scorecard day into a Google Sheet using the same service
// account you use for reads. Keyed by the "Date" column: submitting the same
// day twice updates that row rather than creating a duplicate.
//
// ENV VARS required in Vercel:
//   GOOGLE_SERVICE_ACCOUNT_KEY  — same one used by /api/sheets (JSON or base64)
//   CEO_SCORECARD_SHEET_ID      — the target Google Sheet's ID
//   CEO_SCORECARD_TAB           — the tab name (default "Sheet1")
//
// The target sheet must be shared with the service account email as EDITOR
// (not just Viewer — this endpoint needs write access).
//
// Row schema (must match the target sheet's row 1, in order):
//   Date | Hours worked | Hours on business | Hours A+ | A+ %
//   Needle 1 | Needle 2 | Needle 3 | Cash | Booked calls | Story posted
//   CEO rating /10 | Energy /10 | Focus tomorrow

import { google } from "googleapis";

const COLUMNS = [
  { key: "date",       header: "Date" },
  { key: "hoursTotal", header: "Hours worked" },
  { key: "hoursBiz",   header: "Hours on business" },
  { key: "hoursAplus", header: "Hours A+" },
  { key: "aplusPct",   header: "A+ %",         compute: e => {
    const t=parseFloat(e.hoursTotal)||0, a=parseFloat(e.hoursAplus)||0;
    return t>0 ? Math.round(a/t*100) : "";
  }},
  { key: "nm1",         header: "Needle 1" },
  { key: "nm2",         header: "Needle 2" },
  { key: "nm3",         header: "Needle 3" },
  { key: "cash",        header: "Cash" },
  { key: "calls",       header: "Booked calls" },
  { key: "story",       header: "Story posted" },
  { key: "ceoRating",   header: "CEO rating /10" },
  { key: "energy",      header: "Energy /10" },
  { key: "focus",       header: "Focus tomorrow" },
];

function send(res, status, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(JSON.stringify(obj));
}

let cachedAuth = null;
function getAuth() {
  if (cachedAuth) return cachedAuth;
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY env var is not set");
  raw = raw.trim();
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const creds = JSON.parse(json);
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  cachedAuth = new google.auth.GoogleAuth({
    credentials: creds,
    // Full Sheets scope — this endpoint writes, unlike /api/sheets which reads.
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return cachedAuth;
}

function buildRow(entry) {
  return COLUMNS.map(c => {
    if (c.compute) return c.compute(entry);
    const v = entry[c.key];
    return v == null ? "" : v;
  });
}

function quoteTab(t) { return `'${String(t).replace(/'/g, "''")}'`; }

export default async function handler(req, res) {
  try {
    if (req.method !== "POST" && req.method !== "PUT") {
      return send(res, 405, { error: "Method not allowed" });
    }

    const sheetId = process.env.CEO_SCORECARD_SHEET_ID;
    const tab = (process.env.CEO_SCORECARD_TAB || "Sheet1").trim();
    if (!sheetId) return send(res, 500, { error: "CEO_SCORECARD_SHEET_ID env var is not set" });

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body || typeof body !== "object" || !body.date) {
      return send(res, 400, { error: "Body must be a JSON object with at least a 'date' field" });
    }

    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const range = `${quoteTab(tab)}!A:Z`;

    // 1. Read current sheet content so we can decide append-vs-update
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const values = cur.data.values || [];

    // 2. If empty, seed the header row so the sheet self-describes
    if (values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${quoteTab(tab)}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [COLUMNS.map(c => c.header)] },
      });
    }

    // 3. Find existing row for this date (Date is column A, matching COLUMNS[0])
    const rowsAfterHeader = values.slice(1);
    const targetDate = String(body.date).trim();
    const idx = rowsAfterHeader.findIndex(r => String(r[0] || "").trim() === targetDate);

    const row = buildRow(body);

    if (idx >= 0) {
      // Update existing row (sheet is 1-indexed; +2 accounts for header + 0-index)
      const rowNumber = idx + 2;
      const endCol = String.fromCharCode(64 + COLUMNS.length); // A..Z (fine up to 26 cols)
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${quoteTab(tab)}!A${rowNumber}:${endCol}${rowNumber}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
      });
      return send(res, 200, { ok: true, mode: "updated", row: rowNumber });
    }

    // Append new row
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${quoteTab(tab)}!A:A`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });
    return send(res, 200, { ok: true, mode: "appended" });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const code =
      /permission|forbidden|403/i.test(msg) ? 403 :
      /not found|404|unable to parse range/i.test(msg) ? 404 : 500;
    return send(res, code, { error: msg });
  }
}
