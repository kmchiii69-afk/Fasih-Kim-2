// /api/backfill-bookings.js — one-shot backfill of Calendly bookings for a
// specific date. Uses the same allowlist + dedup logic as the webhook, so
// running this multiple times is safe (existing rows won't be duplicated).
//
// USAGE:
//   GET /api/backfill-bookings                 → backfills today (UK)
//   GET /api/backfill-bookings?date=2026-08-11 → backfills a specific date
//   GET /api/backfill-bookings?days=7          → backfills last N days
//
// ENV VARS (same as webhook):
//   GOOGLE_SERVICE_ACCOUNT_KEY
//   BOOKED_CALLS_SHEET_ID, BOOKED_CALLS_TAB
//   CALENDLY_PERSONAL_TOKEN            — required for this endpoint
//   BOOKED_CALLS_ALLOWED_EVENT_TYPES   — same allowlist as webhook

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

// See calendly-webhook.js — prevents phone numbers and other +/=/-/@-prefixed
// values from being interpreted as formulas by Google Sheets.
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

// Format an ISO datetime as "YYYY-MM-DD HH:mm" in London time (matches webhook)
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

// Same q-and-a helper as the webhook so backfilled rows look identical
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

// Return the ISO date (YYYY-MM-DD) that a UTC timestamp falls on in London time.
// Used to decide "did this booking happen on the target UK day?"
function ukDate(iso) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(iso)).reduce((o, p) => (o[p.type] = p.value, o), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function ukToday() {
  return ukDate(new Date().toISOString());
}

// UK-midnight boundaries for a given day, converted to UTC ISO strings.
// Same trick as eod-extract.js — needed for Calendly's min/max_start_time.
function ukDayBounds(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const now = new Date();
  const ukNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/London" }));
  const offsetMs = now.getTime() - ukNow.getTime();
  const startLocal = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const endLocal = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
  return {
    start: new Date(startLocal + offsetMs).toISOString(),
    end: new Date(endLocal + offsetMs).toISOString(),
  };
}

// Fetch all pages of a Calendly list endpoint
async function fetchAllPages(url, token) {
  const all = [];
  let next = url;
  while (next) {
    const r = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Calendly API ${r.status} on ${next.split("?")[0]}`);
    const data = await r.json();
    all.push(...(data.collection || []));
    next = data.pagination?.next_page || null;
  }
  return all;
}

export default async function handler(req, res) {
  try {
    const sheetId = process.env.BOOKED_CALLS_SHEET_ID;
    const tab = (process.env.BOOKED_CALLS_TAB || "Sheet1").trim();
    const token = process.env.CALENDLY_PERSONAL_TOKEN;
    if (!sheetId) return send(res, 500, { error: "BOOKED_CALLS_SHEET_ID not set" });
    if (!token) return send(res, 500, { error: "CALENDLY_PERSONAL_TOKEN required for backfill" });

    // Determine which day(s) to backfill
    const targetDate = (req.query?.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? req.query.date : ukToday();
    const days = Math.max(1, Math.min(30, parseInt(req.query?.days || "1", 10) || 1));

    // Build the set of target UK dates we want backfilled
    const targetDates = new Set();
    const [ty, tm, td] = targetDate.split("-").map(Number);
    for (let i = 0; i < days; i++) {
      const d = new Date(ty, tm - 1, td - i);
      targetDates.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    }

    // Get org URI (needed for the Calendly events list)
    const meResp = await fetch("https://api.calendly.com/users/me", { headers: { Authorization: `Bearer ${token}` } });
    if (!meResp.ok) return send(res, 500, { error: `Calendly /users/me returned ${meResp.status}` });
    const me = await meResp.json();
    const orgUri = me.resource?.current_organization;
    if (!orgUri) return send(res, 500, { error: "Couldn't resolve current organization from token" });

    // Calls booked today can be scheduled for anywhere from today to months out.
    // Widen the window to catch that — 90 days back and 180 forward is generous
    // but keeps the request count manageable.
    const now = new Date();
    const minStart = new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString();
    const maxStart = new Date(now.getTime() + 180 * 24 * 3600 * 1000).toISOString();
    const eventsUrl = `https://api.calendly.com/scheduled_events?organization=${encodeURIComponent(orgUri)}&min_start_time=${encodeURIComponent(minStart)}&max_start_time=${encodeURIComponent(maxStart)}&status=active&count=100`;
    const events = await fetchAllPages(eventsUrl, token);

    // Optional allowlist filter (same as webhook)
    const allowedList = (process.env.BOOKED_CALLS_ALLOWED_EVENT_TYPES || "")
      .split(",").map(s => s.trim()).filter(Boolean);
    const allowedSet = new Set(allowedList);

    // Filter events by allowlist FIRST (cheaper than fetching invitees for events we'll reject)
    const eligibleEvents = allowedSet.size
      ? events.filter(e => allowedSet.has(e.event_type))
      : events;

    // Load existing sheet rows so we don't duplicate what the webhook already has
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${quoteTab(tab)}!A:N`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const values = cur.data.values || [];
    if (values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${quoteTab(tab)}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [HEADERS] },
      });
    }
    const idIdx = HEADERS.indexOf("Calendly ID");
    const existingIds = new Set(values.slice(1).map(r => String(r[idIdx] || "").trim()).filter(Boolean));

    // Fetch invitees for each eligible event, then filter to bookings whose
    // created_at falls on any of the target dates.
    const rowsToAppend = [];
    let checked = 0, filteredByDate = 0, dupes = 0;
    for (const evt of eligibleEvents) {
      const inviteesUrl = `${evt.uri}/invitees?count=100`;
      const invitees = await fetchAllPages(inviteesUrl, token);
      for (const inv of invitees) {
        checked++;
        // Only include invitees whose booking (created_at) landed on a target date
        if (!targetDates.has(ukDate(inv.created_at))) { filteredByDate++; continue; }
        // Idempotent — skip anything already in the sheet
        if (existingIds.has(inv.uri)) { dupes++; continue; }

        const name = inv.name || [inv.first_name, inv.last_name].filter(Boolean).join(" ") || "";
        const qas = inv.questions_and_answers || [];
        const instagram = findAnswer(qas, "What's your Instagram handle?", "Instagram", "Instagram handle");
        const revenue = findAnswer(qas, "What is your current monthly revenue with your business?", "monthly revenue", "revenue");
        const phone = findAnswer(qas, "Phone number", "phone");
        const tracking = inv.tracking || {};
        const source = tracking.utm_source || tracking.utm_content || "direct";

        rowsToAppend.push([
          fmtUK(inv.created_at),
          fmtUK(evt.start_time),
          name,
          inv.email || "",
          instagram,
          phone,
          revenue,
          source,
          "" /* Qualified */,
          inv.uri,
          "" /* Notes */,
          "" /* Triage */,
          "" /* Outcome */,
          "" /* Cash Collected */,
        ].map(safeCell));
        existingIds.add(inv.uri); // avoid duplicating within this same backfill run
      }
    }

    // Batch append everything at the end — one write instead of N.
    if (rowsToAppend.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: `${quoteTab(tab)}!A:A`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: rowsToAppend },
      });
    }

    return send(res, 200, {
      ok: true,
      targetDates: [...targetDates],
      eventsScanned: events.length,
      eventsAfterAllowlist: eligibleEvents.length,
      inviteesChecked: checked,
      filteredByDate,
      duplicatesSkipped: dupes,
      appended: rowsToAppend.length,
    });
  } catch (err) {
    return send(res, 500, { error: err && err.message ? err.message : String(err) });
  }
}
