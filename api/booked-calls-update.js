// /api/booked-calls-update.js — updates specific fields of one row, keyed by Calendly ID.
// Called by the UI when SooWei toggles Qualified, edits Source, or types Notes.
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
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return cachedAuth;
}

// Column letter for a 0-indexed column number (A=0, B=1, ..., Z=25, AA=26)
function colLetter(n) {
  let s = "";
  n++;
  while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// See calendly-webhook.js. Prefixes formula-triggering values with an
// apostrophe so a Notes entry like "= see call recording" writes as plain
// text instead of parsing as a broken formula.
function safeCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") {
      return send(res, 405, { error: "Method not allowed" });
    }

    const sheetId = process.env.BOOKED_CALLS_SHEET_ID;
    const tab = (process.env.BOOKED_CALLS_TAB || "Sheet1").trim();
    if (!sheetId) return send(res, 500, { error: "BOOKED_CALLS_SHEET_ID not set" });

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body || typeof body !== "object" || !body.calendlyId) {
      return send(res, 400, { error: "Body must include calendlyId + at least one field to update" });
    }
    // Only these fields are user-editable via this endpoint. Everything else
    // is set by the webhook and stays authoritative to Calendly.
    const EDITABLE = ["Qualified", "Source", "Notes", "Triage", "Outcome", "Cash Collected"];
    const updates = {};
    EDITABLE.forEach(k => {
      // Two accepted JSON key forms so the frontend has flexibility:
      //  - lowercase: "qualified", "source", "cash collected"
      //  - camelCase: "cashCollected"   ← preferred for multi-word fields
      const lower = k.toLowerCase();
      const camel = k.replace(/\s+(.)/g, (_, c) => c.toUpperCase()).replace(/^./, c => c.toLowerCase());
      const key = camel in body ? camel : (lower in body ? lower : null);
      if (key !== null) updates[k] = body[key];
    });
    if (!Object.keys(updates).length) return send(res, 400, { error: "No editable fields provided" });

    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const quotedTab = `'${tab.replace(/'/g, "''")}'`;
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${quotedTab}!A:N`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const values = cur.data.values || [];
    if (values.length < 2) return send(res, 404, { error: "Sheet is empty" });

    const headers = values[0].map(h => String(h).trim());
    const idIdx = headers.indexOf("Calendly ID");
    if (idIdx < 0) return send(res, 500, { error: "Sheet missing 'Calendly ID' column" });

    const rowIdx = values.slice(1).findIndex(r => String(r[idIdx] || "").trim() === body.calendlyId);
    if (rowIdx < 0) return send(res, 404, { error: "Row not found for calendlyId" });
    const rowNumber = rowIdx + 2; // header offset + 0-index

    // Batch updates — one range per field, all in one API call.
    const data = Object.entries(updates).map(([col, val]) => {
      const colIdx = headers.indexOf(col);
      if (colIdx < 0) return null;
      return {
        range: `${quotedTab}!${colLetter(colIdx)}${rowNumber}`,
        values: [[safeCell(val)]],
      };
    }).filter(Boolean);

    if (!data.length) return send(res, 400, { error: "None of the update fields exist as columns" });

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data },
    });

    return send(res, 200, { ok: true, row: rowNumber, updated: Object.keys(updates) });
  } catch (err) {
    return send(res, 500, { error: err && err.message ? err.message : String(err) });
  }
}
