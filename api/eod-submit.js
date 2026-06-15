// /api/eod-submit.js  — Vercel serverless (Node runtime)
// Receives George's submitted EOD (POST JSON) and appends a row to the EOD
// Google Sheet so the dashboard reads it live. Uses the SAME service account
// you already set up for /api/sheets — just share the new EOD sheet with the
// same client_email.
//
// ENV VARS:
//   GOOGLE_SERVICE_ACCOUNT_KEY → same service-account JSON you already use
//   EOD_SHEET_ID               → the spreadsheet ID of your NEW EOD sheet
//   EOD_TAB                    → tab name to append to (default "EOD")
//   DASHBOARD_TOKEN            → (optional) shared secret

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
  cachedAuth = new google.auth.JWT(creds.client_email, null, creds.private_key, [
    "https://www.googleapis.com/auth/spreadsheets",
  ]);
  return cachedAuth;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
    const required = process.env.DASHBOARD_TOKEN;

    // body may already be parsed by Vercel; handle both.
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    if (required && body.token !== required) return send(res, 401, { error: "Unauthorized" });

    const sheetId = process.env.EOD_SHEET_ID;
    const tab = process.env.EOD_TAB || "EOD";
    if (!sheetId) return send(res, 500, { error: "EOD_SHEET_ID not set" });

    // Column order — keep this stable so the dashboard can map it.
    const row = [
      body.date || new Date().toISOString().slice(0, 10),
      body.closer || "George",
      num(body.m_qual), num(body.m_disq), num(body.m_closed), num(body.m_offers),
      num(body.m_resched), num(body.m_cash), num(body.m_rev), num(body.m_comm),
      num(body.cancellations), num(body.noShowCount),
      (body.noShowNames || []).join("; "),
      new Date().toISOString(),
    ];

    const sheets = google.sheets({ version: "v4", auth: getAuth() });
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${tab.replace(/'/g, "''")}'!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    // Post the filled EOD summary to Discord (best-effort; never blocks the save).
    const webhook = process.env.DISCORD_EOD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
    if (webhook) {
      const closer = body.closer || "George";
      const fmtMoney = (n) => "$" + Number(num(n)).toLocaleString("en-US");
      const lines = [
        `**${closer} just submitted his EOD form**`,
        `Calls Taken: ${num(body.m_qual)}`,
        `Calls Closed: ${num(body.m_closed)}`,
        `Calls Rescheduled: ${num(body.m_resched)}`,
        `Calls DQ: ${num(body.m_disq)}`,
        `Cancellations: ${num(body.cancellations)}`,
        `Offers Pitched: ${num(body.m_offers)}`,
        `No Shows: ${num(body.noShowCount)}`,
        `Leads That No Showed: ${(body.noShowNames || []).filter(Boolean).join(", ") || "0"}`,
        `Cash Collected: ${fmtMoney(body.m_cash)}`,
        `Commission: ${fmtMoney(body.m_comm)}`,
        `Rev Generated: ${fmtMoney(body.m_rev)}`,
      ];
      try {
        await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: lines.join("\n") }),
        });
      } catch (e) { /* Discord failure must not fail the submission */ }
    }

    return send(res, 200, { ok: true, written: row });
  } catch (err) {
    return send(res, 500, { error: (err && err.message) || String(err) });
  }
}

function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
