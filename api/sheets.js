// /api/sheets.js  — Vercel serverless function (Node runtime)
// Reads a single tab of a Google Sheet live via the Sheets API using a service account.
// Returns: { headers: [...], rows: [ { Header1: val, Header2: val, ... }, ... ] }
//
// Frontend calls:  /api/sheets?id=<sheetIdOrUrl>&tab=<TabName>&token=<optional>
//
// ENV VARS required in Vercel (Project → Settings → Environment Variables):
//   GOOGLE_SERVICE_ACCOUNT_KEY  = the ENTIRE contents of your service-account JSON key (or its base64)
//   DASHBOARD_TOKEN             = (optional) a shared secret; if set, requests must pass &token=<that value>

import { google } from "googleapis";

function send(res, status, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(JSON.stringify(obj));
}

// pull the sheet ID out of a full URL, or accept a bare ID
function extractId(s) {
  s = String(s || "").trim();
  const m = s.match(/\/d\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : s;
}

let cachedAuth = null;
function getAuth() {
  if (cachedAuth) return cachedAuth;
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY env var is not set");
  raw = raw.trim();
  // Accept either raw JSON or base64-encoded JSON.
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  let creds;
  try {
    creds = JSON.parse(json);
  } catch (e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON");
  }
  // handle the \n-escaped private key that Vercel env vars often produce
  if (creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  }
  cachedAuth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return cachedAuth;
}

export default async function handler(req, res) {
  try {
    // optional token gate
    const required = process.env.DASHBOARD_TOKEN;
    if (required && req.query.token !== required) {
      return send(res, 401, { error: "Unauthorized: bad or missing token" });
    }

    const id = extractId(req.query.id);
    const tab = String(req.query.tab || "").trim();
    if (!id) return send(res, 400, { error: "Missing ?id (sheet ID or URL)" });
    if (!tab) return send(res, 400, { error: "Missing ?tab (sheet/tab name)" });

    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    // Read the whole tab. Quote the tab name to survive spaces/symbols.
    const range = `'${tab.replace(/'/g, "''")}'`;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: id,
      range,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });

    const values = resp.data.values || [];
    if (values.length === 0) {
      return send(res, 200, { headers: [], rows: [] });
    }

    const headers = (values[0] || []).map((h) => String(h).trim());
    const rows = values.slice(1).map((r) => {
      const o = {};
      headers.forEach((h, i) => {
        o[h] = r[i] !== undefined ? r[i] : "";
      });
      return o;
    });

    return send(res, 200, { headers, rows });
  } catch (err) {
    // ALWAYS return JSON, even on error, so the frontend's r.json() never gets binary garbage
    const msg = err && err.message ? err.message : String(err);
    const code =
      /permission|forbidden|403/i.test(msg) ? 403 :
      /not found|404|unable to parse range/i.test(msg) ? 404 : 500;
    return send(res, code, { error: msg });
  }
}
