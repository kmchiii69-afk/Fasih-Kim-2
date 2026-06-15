// /api/config.js  — Vercel serverless (ESM)
// Stores the dashboard's mapping config in ONE cell of a Google Sheet tab so it's
// shared across everyone's browser instead of trapped in localStorage.
//   GET  /api/config            → { config: <object|null> }
//   POST /api/config  (JSON)    → saves body as the config; returns { ok:true }
// Last-save-wins: whoever saves most recently sets the shared config for all.
//
// ENV VARS:
//   GOOGLE_SERVICE_ACCOUNT_KEY → same service account (needs WRITE scope)
//   CONFIG_SHEET_ID            → spreadsheet ID to store config in (your existing sheet is fine)
//   CONFIG_TAB                 → tab name to use (default "_config"); create this tab
//   DASHBOARD_TOKEN            → (optional) shared secret; if set, required on POST

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
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY env var is not set");
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
    const sheetId = process.env.CONFIG_SHEET_ID;
    const tab = process.env.CONFIG_TAB || "_config";
    if (!sheetId) return send(res, 500, { error: "CONFIG_SHEET_ID not set" });

    const sheets = google.sheets({ version: "v4", auth: getAuth() });
    const cell = `'${tab.replace(/'/g, "''")}'!A1`;

    if (req.method === "GET") {
      let value = null;
      try {
        const r = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: cell });
        const raw = r.data.values && r.data.values[0] && r.data.values[0][0];
        if (raw) value = JSON.parse(raw);
      } catch (e) {
        // empty cell / not-yet-created → just return null config
        value = null;
      }
      return send(res, 200, { config: value });
    }

    if (req.method === "POST") {
      const required = process.env.DASHBOARD_TOKEN;
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};
      if (required && body.token !== required) return send(res, 401, { error: "Unauthorized" });

      // The config object is either body.config or the body itself (minus token).
      const cfg = body.config !== undefined ? body.config : (() => { const c = { ...body }; delete c.token; return c; })();
      const serialized = JSON.stringify(cfg);
      if (serialized.length > 45000) return send(res, 413, { error: "Config too large for one cell" });

      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: cell,
        valueInputOption: "RAW",
        requestBody: { values: [[serialized]] },
      });
      return send(res, 200, { ok: true, savedAt: new Date().toISOString() });
    }

    return send(res, 405, { error: "Use GET or POST" });
  } catch (err) {
    return send(res, 500, { error: (err && err.message) || String(err) });
  }
}
