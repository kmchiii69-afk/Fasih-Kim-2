// /api/calendly-webhook.js — Vercel serverless function (Node runtime)
// Calendly POSTs here on every booking. Verifies the signature, deduplicates
// by invitee URI, and appends a row to the Booked Calls Google Sheet.
//
// TEAM FILTERING (choose one):
//   BOOKED_CALLS_ALLOWED_EVENT_TYPES — comma-separated event type URIs to accept.
//     Fastest option; whitelist specific booking pages.
//   BOOKED_CALLS_TEAM_URI — accept only bookings whose event type belongs to this team.
//     Requires CALENDLY_PERSONAL_TOKEN (one extra API call per booking to check ownership).
//     Auto-includes any new event types added to the team later.
//   Neither → accept all bookings (default).
//
// SETUP:
//   1. Deploy this endpoint first, note its URL (e.g. https://goh-dashboard.vercel.app/api/calendly-webhook)
//   2. Create a webhook subscription in Calendly via API (see README below in deploy notes)
//   3. Calendly returns a signing_key — save it as CALENDLY_WEBHOOK_SIGNING_KEY env var
//   4. Set BOOKED_CALLS_SHEET_ID + BOOKED_CALLS_TAB (default "Sheet1") env vars
//   5. Optionally set team filtering via env vars above
//
// ENV VARS:
//   GOOGLE_SERVICE_ACCOUNT_KEY          — same one used by /api/sheets
//   BOOKED_CALLS_SHEET_ID               — target Google Sheet's ID
//   BOOKED_CALLS_TAB                    — default "Sheet1"
//   CALENDLY_WEBHOOK_SIGNING_KEY        — returned when you create the webhook subscription
//   BOOKED_CALLS_ALLOWED_EVENT_TYPES    — (optional) comma-separated event type URIs
//   BOOKED_CALLS_TEAM_URI               — (optional) team URI (used with CALENDLY_PERSONAL_TOKEN)
//   CALENDLY_PERSONAL_TOKEN             — (required if using BOOKED_CALLS_TEAM_URI)
//
// Row schema (must match sheet row 1):
//   Booking Time | Call Time | Name | Email | Instagram | Phone | Current Revenue | Source | Qualified | Calendly ID | Notes

import { google } from "googleapis";
import crypto from "crypto";

// Vercel default parses JSON body; we need the RAW body for signature verification.
export const config = { api: { bodyParser: false } };

function send(res, status, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(status).send(JSON.stringify(obj));
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Verify Calendly's signature. Header format: "t=<timestamp>,v1=<hex>"
// Signed payload = "<timestamp>.<raw_body>"
function verifySignature(header, rawBody, signingKey) {
  if (!header || !signingKey) return false;
  const parts = header.split(",").reduce((o, p) => {
    const [k, v] = p.split("=");
    if (k && v) o[k.trim()] = v.trim();
    return o;
  }, {});
  if (!parts.t || !parts.v1) return false;
  const signedPayload = `${parts.t}.${rawBody}`;
  const expected = crypto.createHmac("sha256", signingKey).update(signedPayload).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch { return false; }
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

// Escape values that Google Sheets would otherwise interpret as a formula.
// Any cell starting with =, +, -, or @ triggers formula parsing — so phone
// numbers like "+15551234567" become #ERROR! Prefix with an apostrophe: it's
// Sheets' invisible "this is text" marker (stripped from the displayed value).
function safeCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

const HEADERS = [
  "Booking Time", "Call Time", "Name", "Email", "Instagram",
  "Phone", "Current Revenue", "Source", "Qualified", "Calendly ID", "Notes",
  "Triage", "Outcome", "Cash Collected",
];

// Format an ISO datetime as "YYYY-MM-DD HH:mm" in London time — matches how
// the rest of the dashboard displays times, and makes date-picker filtering
// on the UI page trivial (just string-compare the leading YYYY-MM-DD).
function fmtUK(iso) {
  if (!iso) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(iso)).reduce((o, p) => (o[p.type] = p.value, o), {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  } catch { return iso; }
}

// Pull the answer to a Calendly custom question by best-effort matching.
// Calendly's question labels are copied verbatim from your booking form, so
// exact-match works when the labels stay stable. Substring fallback catches
// small edits (extra whitespace, punctuation added later) without breaking.
function findAnswer(qas, ...needles) {
  if (!Array.isArray(qas)) return "";
  const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  for (const needle of needles) {
    const n = norm(needle);
    const hit = qas.find(qa => norm(qa.question) === n);
    if (hit) return String(hit.answer || "").trim();
  }
  for (const needle of needles) {
    const n = norm(needle);
    const hit = qas.find(qa => norm(qa.question).includes(n));
    if (hit) return String(hit.answer || "").trim();
  }
  return "";
}

// Module-level cache of event-type-URI → belongs-to-target-team boolean.
// Persists across warm invocations; resets on cold start (which is fine —
// worst case we do one extra API call after a cold start per unique event type).
const _eventTypeTeamCache = new Map();

// Returns {ok: true} if the booking should be accepted, or {ok: false, reason: "..."}.
// Evaluates env-var filters in priority order:
//   1. BOOKED_CALLS_ALLOWED_EVENT_TYPES — whitelist specific event types (no API call)
//   2. BOOKED_CALLS_TEAM_URI — check the event type's owner is this team (one API call, cached)
//   3. Neither set → accept all
async function checkTeamMembership(eventTypeUri) {
  const allowedList = (process.env.BOOKED_CALLS_ALLOWED_EVENT_TYPES || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const teamUri = (process.env.BOOKED_CALLS_TEAM_URI || "").trim();

  // No filter configured → accept all
  if (!allowedList.length && !teamUri) return { ok: true };

  if (!eventTypeUri) return { ok: false, reason: "no event type URI on payload" };

  // Method 1 — explicit event type whitelist
  if (allowedList.length) {
    if (allowedList.includes(eventTypeUri)) return { ok: true };
    return { ok: false, reason: "event type not in allowlist" };
  }

  // Method 2 — team ownership check via Calendly API
  const token = process.env.CALENDLY_PERSONAL_TOKEN;
  if (!token) return { ok: false, reason: "CALENDLY_PERSONAL_TOKEN required for team filtering" };

  // Check cache
  if (_eventTypeTeamCache.has(eventTypeUri)) {
    const cached = _eventTypeTeamCache.get(eventTypeUri);
    return cached ? { ok: true } : { ok: false, reason: "event type not owned by target team (cached)" };
  }

  // Fetch event type from Calendly to check its owner
  try {
    const r = await fetch(eventTypeUri, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      // If we can't verify, err on the side of rejection so we don't accidentally
      // let through bookings we shouldn't. Don't cache — retry on next webhook.
      return { ok: false, reason: `Calendly API returned ${r.status} for event type` };
    }
    const et = await r.json();
    // Event types owned by a team have profile.owner_type = "Team" and profile.owner = team URI.
    // (User-owned event types have owner_type = "User".)
    const ownerType = et?.resource?.profile?.owner_type;
    const ownerUri = et?.resource?.profile?.owner;
    const matches = ownerType === "Team" && ownerUri === teamUri;
    _eventTypeTeamCache.set(eventTypeUri, matches);
    return matches
      ? { ok: true }
      : { ok: false, reason: `event type owner (${ownerType}:${ownerUri}) doesn't match target team` };
  } catch (err) {
    return { ok: false, reason: `Calendly API error: ${err.message || err}` };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

    const sheetId = process.env.BOOKED_CALLS_SHEET_ID;
    const tab = (process.env.BOOKED_CALLS_TAB || "Sheet1").trim();
    const signingKey = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
    if (!sheetId) return send(res, 500, { error: "BOOKED_CALLS_SHEET_ID not set" });

    const rawBody = await getRawBody(req);

    // Signature verification (Calendly signs every webhook)
    if (signingKey) {
      const sig = req.headers["calendly-webhook-signature"];
      if (!verifySignature(sig, rawBody, signingKey)) {
        return send(res, 401, { error: "Invalid signature" });
      }
    }
    // If no signing key is configured, we still accept — but log a warning.
    // Best practice: always set the signing key in production.

    let payload;
    try { payload = JSON.parse(rawBody); } catch { return send(res, 400, { error: "Invalid JSON" }); }

    // We only care about invitee.created. Ignore invitee.canceled and other events.
    if (payload.event !== "invitee.created") {
      return send(res, 200, { ok: true, ignored: payload.event });
    }

    const p = payload.payload || {};
    const inviteeUri = p.uri || "";
    if (!inviteeUri) return send(res, 400, { error: "Missing invitee URI" });

    // Team / event type filtering — reject bookings that don't match the
    // configured allowlist. Same 200 OK response so Calendly's retry logic
    // isn't triggered, but the row is not written.
    const eventTypeUri = p.scheduled_event?.event_type || "";
    const teamCheck = await checkTeamMembership(eventTypeUri);
    if (!teamCheck.ok) {
      return send(res, 200, { ok: true, filtered: true, reason: teamCheck.reason });
    }

    // Idempotency check — skip if we already have this invitee in the sheet.
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${quoteTab(tab)}!A:N`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const values = cur.data.values || [];

    // Seed header row on first webhook
    if (values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${quoteTab(tab)}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [HEADERS] },
      });
    }

    // Check for duplicate — Calendly ID is column J (index 9)
    const idIdx = HEADERS.indexOf("Calendly ID");
    const existingRow = values.slice(1).findIndex(r => String(r[idIdx] || "").trim() === inviteeUri);
    if (existingRow >= 0) {
      return send(res, 200, { ok: true, deduped: true, row: existingRow + 2 });
    }

    // Extract fields from the webhook payload
    const name = p.name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "";
    const email = p.email || "";
    const qas = p.questions_and_answers || [];
    const instagram = findAnswer(qas, "What's your Instagram handle?", "Instagram", "Instagram handle");
    const revenue = findAnswer(qas, "What is your current monthly revenue with your business?", "monthly revenue", "revenue");
    const phone = findAnswer(qas, "Phone number", "phone");
    const tracking = p.tracking || {};
    // UTM source is the primary attribution. Fall back to utm_content or 'direct'
    // if the booking came in without any tracking params.
    const source = tracking.utm_source || tracking.utm_content || "direct";
    const bookingTime = fmtUK(p.created_at);
    const callTime = fmtUK(p.scheduled_event?.start_time);

    const row = [
      bookingTime, callTime, name, email, instagram,
      phone, revenue, source, "" /* Qualified */, inviteeUri, "" /* Notes */,
      "" /* Triage */, "" /* Outcome */, "" /* Cash Collected */,
    ].map(safeCell);

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${quoteTab(tab)}!A:A`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    return send(res, 200, { ok: true, appended: true, name, email, source });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return send(res, 500, { error: msg });
  }
}
