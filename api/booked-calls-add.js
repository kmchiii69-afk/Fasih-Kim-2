// /api/booked-calls-add.js — manually add a booking row (calls that came in
// outside Calendly: DMs, phone, referrals, etc.). Uses the same sheet schema
// and safety rules as the webhook, but IDs are prefixed with "manual-" so they
// never collide with Calendly's URIs.
//
// ENV: GOOGLE_SERVICE_ACCOUNT_KEY, BOOKED_CALLS_SHEET_ID, BOOKED_CALLS_TAB

import { google } from "googleapis";
import crypto from "crypto";

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

// See calendly-webhook.js — prevents formula-triggering values (phone numbers
// starting with +, notes starting with =, etc.) from breaking cells.
function safeCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

const HEADERS = [
  "Booking Time", "Call Time", "Name", "Email", "Instagram",
  "Phone", "Current Revenue", "Source", "Qualified", "Calendly ID", "Notes",
];

// Format "YYYY-MM-DDTHH:mm" (browser datetime-local input) → "YYYY-MM-DD HH:mm"
// so the value looks identical to what the webhook writes and the read
// endpoint's prefix filter (which relies on this format) still works.
function normalizeDT(v) {
  if (!v) return "";
  const s = String(v).trim().replace("T", " ");
  const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : s;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

    const sheetId = process.env.BOOKED_CALLS_SHEET_ID;
    const tab = (process.env.BOOKED_CALLS_TAB || "Sheet1").trim();
    if (!sheetId) return send(res, 500, { error: "BOOKED_CALLS_SHEET_ID not set" });

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body || typeof body !== "object") return send(res, 400, { error: "Body must be JSON" });

    // Required fields — at least one identifying piece of information.
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    if (!name && !email) {
      return send(res, 400, { error: "At least one of name or email is required" });
    }

    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    // Ensure the header row exists — same seed as webhook.
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${quoteTab(tab)}!A1:K1`,
    });
    if (!cur.data.values || cur.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${quoteTab(tab)}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [HEADERS] },
      });
    }

    // Generate a unique ID for this manual entry. "manual-" prefix guarantees
    // it can never collide with a Calendly URI (which start with "https://").
    const id = "manual-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");

    const row = [
      normalizeDT(body.bookingTime) || new Date().toISOString().replace("T", " ").slice(0, 16),
      normalizeDT(body.callTime),
      name,
      email,
      body.instagram || "",
      body.phone || "",
      body.revenue || "",
      body.source || "direct",
      body.qualified || "",
      id,
      body.notes || "",
    ].map(safeCell);

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${quoteTab(tab)}!A:A`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    return send(res, 200, { ok: true, id });
  } catch (err) {
    return send(res, 500, { error: err && err.message ? err.message : String(err) });
  }
}
