// /api/eod-extract.js  — Vercel serverless (Node runtime)
// Pulls George's Fathom meetings for "today" (UK), runs each transcript through
// the Claude API to score ICP + classify outcome, and returns the CALLS array
// in the exact shape closer-eod.html already consumes.
//
// Frontend: GET /api/eod-extract?closer=george   (closer optional; defaults to George)
//
// ENV VARS (Vercel → Settings → Environment Variables):
//   FATHOM_API_KEY        → your Fathom API key (Settings > API in Fathom)
//   ANTHROPIC_API_KEY     → your Anthropic API key
//   CLOSER_GEORGE_EMAIL   → the email George records Fathom calls under (recorded_by filter)
//   DASHBOARD_TOKEN       → (optional) shared secret; if set, request must pass ?token=

const FATHOM_BASE = "https://api.fathom.ai/external/v1";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function send(res, status, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(JSON.stringify(obj));
}

// Start/end of a UK day, returned as UTC ISO strings for Fathom filters.
// dateStr is an optional YYYY-MM-DD — defaults to today (as seen in London).
function ukDayWindow(dateStr) {
  const now = new Date();
  let y, m, d;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    // Explicit date requested (e.g. yesterday when the closer backdates the EOD).
    const [yy, mm, dd] = dateStr.split("-").map(Number);
    y = yy; m = mm - 1; d = dd;
  } else {
    const ukNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/London" }));
    y = ukNow.getFullYear(); m = ukNow.getMonth(); d = ukNow.getDate();
  }
  // Build local-London midnight and next midnight, then convert to UTC by
  // measuring London's offset right now.
  const ukNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/London" }));
  const offsetMs = now.getTime() - ukNow.getTime();
  const startLocal = new Date(y, m, d, 0, 0, 0, 0).getTime();
  const endLocal = new Date(y, m, d + 1, 0, 0, 0, 0).getTime();
  return {
    after: new Date(startLocal + offsetMs).toISOString(),
    before: new Date(endLocal + offsetMs).toISOString(),
  };
}

async function fathomMeetings(apiKey, email, after, before) {
  const all = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const u = new URL(FATHOM_BASE + "/meetings");
    u.searchParams.set("recorded_by[]", email);
    u.searchParams.set("created_after", after);
    u.searchParams.set("created_before", before);
    u.searchParams.set("include_transcript", "true");
    if (cursor) u.searchParams.set("cursor", cursor);
    const r = await fetch(u.toString(), { headers: { "X-Api-Key": apiKey } });
    if (!r.ok) throw new Error("Fathom " + r.status + ": " + (await r.text()).slice(0, 200));
    const data = await r.json();
    (data.items || []).forEach((m) => all.push(m));
    cursor = data.next_cursor;
    if (!cursor) break;
  }
  return all;
}

// Approximate FX rates for converting non-USD amounts mentioned in transcripts
// into USD. Anchored to mid-market rates; bump these here when they drift more
// than a few percent. The values flow into the RUBRIC string below.
const CURRENCY_RATES = {
  GBP: 1.34,   // £ → $
  EUR: 1.15,   // € → $
  CAD: 0.73,   // C$ → $
  AUD: 0.65,   // A$ → $
};
const RUBRIC = `You are scoring a sales call for Goh Consulting, a business coaching company.
Score the LEAD (the prospect, not the closer) on five ICP factors. Max points per factor:
- Budget: 30  (can they afford the program? revenue/cash on hand)
- Income: 25  (current monthly revenue of their business)
- Pain: 20    (urgency and depth of the problem they want solved)
- Opp. Cost: 15 (cost of NOT solving it / what's at stake)
- Social Proof: 10 (do they trust the brand / cite results / referrals)

Then classify call OUTCOME. Valid outcome tags (zero or more): "Offer Pitched", "Closed", "Rescheduled".
Identify the OFFER if one was pitched: one of "Brand Architect", "Acquisition Mastery", "Advisory Group", or null.

CURRENCY — IMPORTANT. The "cash" and "revenue" fields MUST be returned in USD.
- If the transcript explicitly mentions amounts in another currency (£, GBP, pounds, €, EUR, euros, C$/CAD, A$/AUD), CONVERT to USD using these rates:
    GBP → USD × ${CURRENCY_RATES.GBP}
    EUR → USD × ${CURRENCY_RATES.EUR}
    CAD → USD × ${CURRENCY_RATES.CAD}
    AUD → USD × ${CURRENCY_RATES.AUD}
  Round to the nearest whole dollar. Example: "£5,600" → 5600 × ${CURRENCY_RATES.GBP} = ${Math.round(5600 * CURRENCY_RATES.GBP)}.
- If the currency is not explicitly mentioned in the transcript, assume USD (do NOT convert).
- "Cash" is the deposit paid today; "revenue" is the full contract value (which can be higher than cash on a payment plan).

Return ONLY valid JSON, no markdown, no preamble, with this exact shape:
{
  "lead": "<lead full name>",
  "factors": { "Budget":[<score>,30], "Income":[<score>,25], "Pain":[<score>,20], "Opp. Cost":[<score>,15], "Social Proof":[<score>,10] },
  "outcomes": ["Offer Pitched", ...],
  "offer": "Acquisition Mastery" | null,
  "cash": <number, cash collected today>,
  "revenue": <number, contract value if closed else 0>,
  "note": "<one-sentence summary of what happened>"
}
If a factor cannot be assessed from the transcript, use null for that score, e.g. "Budget":[null,30].`;

function transcriptToText(m) {
  const t = m.transcript || [];
  if (!t.length) return "";
  return t.map((x) => `${x.speaker?.display_name || "Unknown"}: ${x.text}`).join("\n");
}

function leadNameFromMeeting(m) {
  const ext = (m.calendar_invitees || []).find((i) => i.is_external && i.name);
  return ext?.name || m.meeting_title || m.title || "Unknown Lead";
}

// Titles that mean "internal" — these calls are dropped no matter who's on them.
// Matching is case-insensitive and substring-based, so "Weekly Sales Huddle"
// and "Team Call - Monday" both get caught. Add more phrases as needed.
const TITLE_BLOCKLIST = [
  "sales huddle",
  "team call",
  "team meeting",
  "standup",
  "stand-up",
  "internal",
  "huddle",
  "1:1",
  "1-1",
  "all hands",
  "all-hands",
  "weekly sync",
  "daily sync",
];

function isInternalTitle(m) {
  const t = `${m.title || ""} ${m.meeting_title || ""}`.toLowerCase();
  return TITLE_BLOCKLIST.some((phrase) => t.includes(phrase));
}

function hasExternalInvitee(m) {
  return (m.calendar_invitees || []).some((i) => i.is_external);
}

// One-off exclusion: drop any call where Lazar is on the invite list, regardless
// of whether the title or external-invitee checks would otherwise pass.
const INVITEE_EMAIL_BLOCKLIST = ["lazzartopalovic@gmail.com"];
function hasBlockedInvitee(m) {
  const invitees = m.calendar_invitees || [];
  return invitees.some((i) => {
    const email = String(i.email || "").trim().toLowerCase();
    return INVITEE_EMAIL_BLOCKLIST.includes(email);
  });
}

// A call counts as a real sales call only if its title isn't on the blocklist
// AND it has at least one external (prospect) invitee AND no invitee email
// is on the exclusion list.
function isSalesCall(m) {
  return !isInternalTitle(m) && !hasBlockedInvitee(m) && hasExternalInvitee(m);
}

async function scoreCall(anthropicKey, m) {
  const text = transcriptToText(m);
  const fallbackLead = leadNameFromMeeting(m);
  if (!text) {
    return { lead: fallbackLead, factors: { Budget: [null, 30], Income: [null, 25], Pain: [null, 20], "Opp. Cost": [null, 15], "Social Proof": [null, 10] }, outcomes: [], offer: null, cash: 0, revenue: 0, note: "No transcript available for this call." };
  }
  const body = {
    model: "claude-opus-4-8",
    max_tokens: 1024,
    system: RUBRIC,
    messages: [{ role: "user", content: `Lead (from calendar): ${fallbackLead}\n\nTranscript:\n${text.slice(0, 100000)}` }],
  };
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Anthropic " + r.status + ": " + (await r.text()).slice(0, 200));
  const data = await r.json();
  const raw = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const clean = raw.replace(/^```json\s*/i, "").replace(/```$/g, "").trim();
  let parsed;
  try { parsed = JSON.parse(clean); }
  catch { parsed = { lead: fallbackLead, factors: { Budget: [null, 30], Income: [null, 25], Pain: [null, 20], "Opp. Cost": [null, 15], "Social Proof": [null, 10] }, outcomes: [], offer: null, cash: 0, revenue: 0, note: "Could not parse extraction for this call." }; }
  if (!parsed.lead) parsed.lead = fallbackLead;
  return parsed;
}

export default async function handler(req, res) {
  try {
    const required = process.env.DASHBOARD_TOKEN;
    if (required && req.query.token !== required) return send(res, 401, { error: "Unauthorized" });

    const fathomKey = process.env.FATHOM_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const email = process.env.CLOSER_GEORGE_EMAIL;
    if (!fathomKey) return send(res, 500, { error: "FATHOM_API_KEY not set" });
    if (!anthropicKey) return send(res, 500, { error: "ANTHROPIC_API_KEY not set" });
    if (!email) return send(res, 500, { error: "CLOSER_GEORGE_EMAIL not set" });

    const { after, before } = ukDayWindow(req.query.date);
    const meetings = await fathomMeetings(fathomKey, email, after, before);

    // Keep only real sales calls: drop internal-titled meetings (Sales Huddle,
    // Team Call, etc.) and anything with no external prospect on it.
    const salesCalls = meetings.filter(isSalesCall);

    // Score sequentially to respect Fathom/Anthropic rate limits.
    const calls = [];
    for (const m of salesCalls) calls.push(await scoreCall(anthropicKey, m));

    return send(res, 200, {
      closer: "George",
      date: after.slice(0, 10),
      count: calls.length,
      skipped: meetings.length - salesCalls.length,
      calls,
    });
  } catch (err) {
    return send(res, 500, { error: (err && err.message) || String(err) });
  }
}
