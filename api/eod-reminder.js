// /api/eod-reminder.js  — Vercel serverless, triggered by Vercel Cron.
// Self-checks UK time so you NEVER touch the cron at daylight-saving changes.
// The cron fires at both 20:00 and 21:00 UTC; this function only acts when it's
// actually 21:00 in London (covers BST in summer and GMT in winter automatically).
//
// What it does: checks the EOD sheet for today's George row. If it's missing,
// posts a Discord reminder pinging George. If it's there, does nothing.
//
// ENV VARS:
//   GOOGLE_SERVICE_ACCOUNT_KEY → same service account as the dashboard
//   EOD_SHEET_ID, EOD_TAB      → the EOD sheet (EOD_TAB defaults to "EOD")
//   DISCORD_WEBHOOK_URL        → channel webhook to post the reminder to
//   DISCORD_GEORGE_ID          → George's Discord user ID (for the <@id> ping)
//   EOD_FORM_URL               → public URL of closer-eod.html ("Open EOD" link)
//   CRON_SECRET                → set by Vercel; we verify the caller when present
//   REMINDER_FORCE             → (optional) set to "1" to bypass the 21:00 gate when testing

const { google } = require("googleapis");

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

    // Only act at 21:00 London time, unless forced for testing.
    if (process.env.REMINDER_FORCE !== "1" && hour !== 21) {
      return send(res, 200, { ok: true, reminded: false, reason: `Not 21:00 UK (currently ${hour}:00)` });
    }

    const sheetId = process.env.EOD_SHEET_ID;
    const tab = process.env.EOD_TAB || "EOD";
    const webhook = process.env.DISCORD_WEBHOOK_URL;
    if (!sheetId) return send(res, 500, { error: "EOD_SHEET_ID not set" });
    if (!webhook) return send(res, 500, { error: "DISCORD_WEBHOOK_URL not set" });

    // Has George already submitted today? Read date (A) + closer (B).
    const sheets = google.sheets({ version: "v4", auth: getAuth() });
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${tab.replace(/'/g, "''")}'!A:B`,
    });
    const rows = resp.data.values || [];
    const alreadyDone = rows.some((r) => {
      const dateCell = String(r[0] || "").trim();
      const closerCell = String(r[1] || "").trim().toLowerCase();
      const matchesDate = dateCell === today || ddmmyyyy(dateCell) === today;
      return matchesDate && closerCell.includes("george");
    });

    if (alreadyDone) {
      return send(res, 200, { ok: true, reminded: false, reason: "EOD already submitted today" });
    }

    const ping = process.env.DISCORD_GEORGE_ID ? `<@${process.env.DISCORD_GEORGE_ID}>` : "@George";
    const formUrl = process.env.EOD_FORM_URL || "";
    const content = `${ping} — your End of Day report isn't in yet. Please complete it before you log off.`;
    const embed = {
      title: "End of Day Report — pending",
      description: formUrl
        ? `Your calls are already auto-filled. Just verify and submit.\n\n**[Open your EOD →](${formUrl})**`
        : "Your calls are already auto-filled. Just verify and submit.",
      color: 0xc8a24b,
    };

    const dr = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, embeds: [embed], allowed_mentions: { parse: ["users"] } }),
    });
    if (!dr.ok) return send(res, 500, { error: "Discord " + dr.status + ": " + (await dr.text()).slice(0, 200) });

    return send(res, 200, { ok: true, reminded: true });
  } catch (err) {
    return send(res, 500, { error: (err && err.message) || String(err) });
  }
}
