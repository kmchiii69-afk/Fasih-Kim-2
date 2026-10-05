// /api/eod-reminder.js  — Vercel serverless, triggered by Vercel Cron.
// Self-checks UK time so you NEVER touch the cron at daylight-saving changes.
// The cron fires at both 20:00 and 21:00 UTC; this function only acts when it's
// actually 21:00 in London (covers BST in summer and GMT in winter automatically).
//
// What it does: checks the EOD sheet for each configured closer's today row.
// For any closer whose row is missing, posts a Discord reminder pinging them.
//
// Who to remind is set via EOD_CLOSERS (comma-separated: "George,Abhishek").
// For each name, the function reads DISCORD_<NAME>_ID for the ping ID and
// optionally EOD_FORM_URL_<NAME> for a per-closer bookmarked form URL.
//
// ENV VARS:
//   GOOGLE_SERVICE_ACCOUNT_KEY → same service account as the dashboard
//   EOD_SHEET_ID, EOD_TAB      → the EOD sheet (EOD_TAB defaults to "EOD")
//   DISCORD_WEBHOOK_URL        → channel webhook to post reminders to
//   EOD_CLOSERS                → "George,Abhishek" (defaults to "George" for backward compat)
//   DISCORD_GEORGE_ID          → George's Discord user ID (for the <@id> ping)
//   DISCORD_ABHISHEK_ID        → Abhishek's Discord user ID (for the <@id> ping)
//   EOD_FORM_URL               → public URL of closer-eod.html; appended with ?closer=<name>
//   EOD_FORM_URL_<NAME>        → optional override per closer (full URL)
//   CRON_SECRET                → set by Vercel; we verify the caller when present
//   REMINDER_FORCE             → (optional) set to "1" to bypass the 21:00 gate when testing

import { google } from "googleapis";

function send(res, status, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(status).send(JSON.stringify(obj));
}

function getAuth() {
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
  raw = raw.trim();
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const creds = JSON.parse(json);
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  return new google.auth.JWT(creds.client_email, null, creds.private_key, [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  ]);
}

// Current hour (0-23) and YYYY-MM-DD date, both as seen in London.
function ukNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce((o, p) => (o[p.type] = p.value, o), {});
  const hour = parseInt(parts.hour, 10) % 24;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { hour, date };
}

function ddmmyyyy(s) {
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

export default async function handler(req, res) {
  try {
    // Verify Vercel Cron caller when CRON_SECRET is set.
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers["authorization"] || "";
      if (auth !== `Bearer ${secret}`) return send(res, 401, { error: "Unauthorized" });
    }

    const { hour, date: today } = ukNow();

    // Manual ping URL patterns (all bypass the 21:00 gate when force=1):
    //   ?force=1                       → ping every closer in EOD_CLOSERS right now
    //   ?closer=George&force=1         → ping just George, skip the "already submitted" check
    //   ?closer=George,Abhishek&force=1 → ping both, skip the "already submitted" check
    const manualClosers = String(req.query.closer || "")
      .split(",").map(s => s.trim()).filter(Boolean);
    const manualForce = req.query.force === "1";

    // Only act at 21:00 London time, unless forced for testing or by the manual param.
    if (!manualForce && process.env.REMINDER_FORCE !== "1" && hour !== 21) {
      return send(res, 200, { ok: true, reminded: false, reason: `Not 21:00 UK (currently ${hour}:00)` });
    }

    const sheetId = process.env.EOD_SHEET_ID;
    const tab = process.env.EOD_TAB || "EOD";
    const webhook = process.env.DISCORD_WEBHOOK_URL;
    if (!sheetId) return send(res, 500, { error: "EOD_SHEET_ID not set" });
    if (!webhook) return send(res, 500, { error: "DISCORD_WEBHOOK_URL not set" });

    const configured = (process.env.EOD_CLOSERS || "George")
      .split(",").map(s => s.trim()).filter(Boolean);
    // Who to ping on this run.
    const useManualList = manualClosers.length > 0;
    const closers = useManualList ? manualClosers : configured;
    // Always ping every configured closer — the earlier "skip if already
    // submitted" gate was dropping George when it shouldn't. Simpler + robust:
    // 21:00 UK fires reminders for everyone, every day.
    const results = [];
    for (const name of closers) {
      const idEnv = "DISCORD_" + name.toUpperCase() + "_ID";
      const ping = process.env[idEnv] ? `<@${process.env[idEnv]}>` : `@${name}`;
      // Per-closer form URL override, else base URL + ?closer=<name>
      const perCloser = process.env["EOD_FORM_URL_" + name.toUpperCase()];
      const baseUrl = process.env.EOD_FORM_URL || "";
      const formUrl = perCloser || (baseUrl ? baseUrl + (baseUrl.includes("?") ? "&" : "?") + "closer=" + encodeURIComponent(name) : "");
      const content = `${ping} — your End of Day report isn't in yet. Please complete it before you log off.`;
      const embed = {
        title: `End of Day Report — pending (${name})`,
        description: formUrl
          ? `Your calls are already auto-filled. Just verify and submit.\n\n**[Open your EOD →](${formUrl})**`
          : "Your calls are already auto-filled. Just verify and submit.",
        color: 0xc8a24b,
      };
      try {
        const dr = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, embeds: [embed], allowed_mentions: { parse: ["users"] } }),
        });
        if (!dr.ok) { results.push({ closer: name, reminded: false, error: "Discord " + dr.status }); continue; }
        results.push({ closer: name, reminded: true });
      } catch (e) {
        results.push({ closer: name, reminded: false, error: String(e && e.message || e) });
      }
    }
    return send(res, 200, { ok: true, results });
  } catch (err) {
    return send(res, 500, { error: (err && err.message) || String(err) });
  }
}