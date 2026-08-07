// /api/monthly-costs-write.js — Vercel serverless function (Node runtime)
// Upserts one row into the Monthly Costs Google Sheet, keyed by "Month" (YYYY-MM).
// Submitting the same month twice updates the row rather than duplicating.
//
// Sheet schema (row 1): Month | Delivery Cost | Acquisition Spend | Timestamp
//
// ENV VARS:
//   GOOGLE_SERVICE_ACCOUNT_KEY  — same one used by /api/sheets
//   MONTHLY_COSTS_SHEET_ID      — 1rgMzVz3DIgwRQGBvH93wie_zG5W8Ql4eL6inDhxiMSg
//   MONTHLY_COSTS_TAB           — default "Sheet1"

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
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return cachedAuth;
}

function quoteTab(t) { return `'${String(t).replace(/'/g, "''")}'`; }

const HEADERS = ["Month", "Delivery Cost", "Acquisition Spend", "Timestamp"];

export default async function handler(req, res) {
  try {
    if (req.method !== "POST" && req.method !== "PUT") {
      return send(res, 405, { error: "Method not allowed" });
    }

    const sheetId = process.env.MONTHLY_COSTS_SHEET_ID;
    const tab = (process.env.MONTHLY_COSTS_TAB || "Sheet1").trim();
    if (!sheetId) return send(res, 500, { error: "MONTHLY_COSTS_SHEET_ID not set" });

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body || typeof body !== "object" || !body.month) {
      return send(res, 400, { error: "Body must include a 'month' field (YYYY-MM)" });
    }
    if (!/^\d{4}-\d{2}$/.test(body.month)) {
      return send(res, 400, { error: "'month' must be in YYYY-MM format" });
    }

    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const range = `${quoteTab(tab)}!A:D`;

    // 1. Read existing content
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const values = cur.data.values || [];

    // 2. Seed header row if the sheet is empty
    if (values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${quoteTab(tab)}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [HEADERS] },
      });
    }

    // 3. Look for an existing row with the same Month
    const rowsAfterHeader = values.slice(1);
    const idx = rowsAfterHeader.findIndex(r => String(r[0] || "").trim() === body.month);

    const row = [
      body.month,
      body.deliveryCost != null ? body.deliveryCost : "",
      body.acquisitionSpend != null ? body.acquisitionSpend : "",
      new Date().toISOString(),
    ];

    if (idx >= 0) {
      const rowNumber = idx + 2; // +2 for header + 0-index
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${quoteTab(tab)}!A${rowNumber}:D${rowNumber}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
      });
      return send(res, 200, { ok: true, mode: "updated", row: rowNumber });
    }

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
