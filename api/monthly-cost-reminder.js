// /api/monthly-cost-reminder.js — Vercel serverless, triggered by Vercel Cron.
// Fires ONLY on the last day of the month at 18:00 UK time. Pings SooWei in
// Discord if the Monthly Costs sheet doesn't yet have a row for this month.
//
// The cron in vercel.json runs at both 17:00 and 18:00 UTC daily; this function
// only acts when it's actually 18:00 in London (handles BST/GMT transitions
// automatically) AND today is the last day of the current month.
//
// ENV VARS:
//   GOOGLE_SERVICE_ACCOUNT_KEY   → same one used elsewhere
//   MONTHLY_COSTS_SHEET_ID       → same sheet the write endpoint uses
//   MONTHLY_COSTS_TAB            → default "Sheet1"
//   DISCORD_WEBHOOK_URL          → Discord webhook to post to
//   DISCORD_SOOWEI_ID            → SooWei's Discord user ID for the <@id> ping
//   MONTHLY_COSTS_FORM_URL       → public URL of /monthly-costs.html
//   CRON_SECRET                  → set by Vercel; verified when present
//   MONTHLY_REMINDER_FORCE       → set to "1" to bypass time gate when testing

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

// Current hour, date, and month/year as seen in London.
function ukNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce((o, p) => (o[p.type] = p.value, o), {});
  const hour = parseInt(parts.hour, 10) % 24;
  const y = parseInt(parts.year, 10);
  const m = parseInt(parts.month, 10);
  const d = parseInt(parts.day, 10);
  return { hour, year: y, month: m, day: d, monthKey: `${parts.year}-${parts.month}` };
}

// True if `day` is the last day of month `m` in year `y`.
function isLastDayOfMonth(y, m, d) {
  const nextDay = new Date(y, m - 1, d + 1);
  return nextDay.getMonth() !== (m - 1);
}

export default async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers["authorization"] || "";
      if (auth !== `Bearer ${secret}`) return send(res, 401, { error: "Unauthorized" });
    }

    const { hour, year, month, day, monthKey } = ukNow();
    const force = process.env.MONTHLY_REMINDER_FORCE === "1";

    // Time gate: only send at 18:00 London.
    if (!force && hour !== 18) {
      return send(res, 200, { ok: true, reminded: false, reason: `Not 18:00 UK (currently ${hour}:00)` });
    }
    // Day gate: only send on last day of month.
    if (!force && !isLastDayOfMonth(year, month, day)) {
      return send(res, 200, { ok: true, reminded: false, reason: `Not last day of month (today is ${monthKey}-${String(day).padStart(2,"0")})` });
    }

    const sheetId = process.env.MONTHLY_COSTS_SHEET_ID;
    const tab = process.env.MONTHLY_COSTS_TAB || "Sheet1";
    const webhook = process.env.DISCORD_WEBHOOK_URL;
    if (!sheetId) return send(res, 500, { error: "MONTHLY_COSTS_SHEET_ID not set" });
    if (!webhook) return send(res, 500, { error: "DISCORD_WEBHOOK_URL not set" });

    // Check whether this month's row already exists.
    const sheets = google.sheets({ version: "v4", auth: getAuth() });
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${tab.replace(/'/g, "''")}'!A:A`,
    });
    const rows = resp.data.values || [];
    const alreadyLogged = rows.slice(1).some(r => String(r[0] || "").trim() === monthKey);

    if (alreadyLogged) {
      return send(res, 200, { ok: true, reminded: false, reason: `Costs for ${monthKey} already logged` });
    }

    const ping = process.env.DISCORD_SOOWEI_ID ? `<@${process.env.DISCORD_SOOWEI_ID}>` : "@SooWei";
    const formUrl = process.env.MONTHLY_COSTS_FORM_URL || "";
    const monthLabel = new Date(year, month - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

    const content = `${ping} — end of ${monthLabel}. Time to log this month's delivery cost and acquisition spend.`;
    const embed = {
      title: "Monthly Costs — pending",
      description: formUrl
        ? `Log two numbers and the dashboard's Gross Margin, LTGP, CAC, and LTGP:CAC will update automatically.\n\n**[Open the form →](${formUrl})**`
        : "Log this month's delivery cost and acquisition spend.",
      color: 0xc8a24b,
    };

    const dr = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, embeds: [embed], allowed_mentions: { parse: ["users"] } }),
    });
    if (!dr.ok) return send(res, 500, { error: "Discord " + dr.status + ": " + (await dr.text()).slice(0, 200) });

    return send(res, 200, { ok: true, reminded: true, month: monthKey });
  } catch (err) {
    return send(res, 500, { error: (err && err.message) || String(err) });
  }
}
