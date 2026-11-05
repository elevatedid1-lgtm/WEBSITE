/**
 * Elevated ID Inner Circle: signup and Telegram invite service.
 *
 * What it does
 *   1. POST /api/lead         The landing page form sends name, email, phone and
 *                             Telegram username here. The lead is saved and passed
 *                             on to GoHighLevel (if GHL_WEBHOOK_URL is set).
 *   2. POST /api/admin/mark-paid   Called once a $50 payment is confirmed. Creates a
 *                             personal Telegram invite link for that buyer.
 *   3. Bot loop               Telegram asks the bot to approve each join request.
 *                             The bot lets in only the person whose Telegram
 *                             username matches the one given when they signed up.
 *
 * Zero dependencies on purpose, like the website server. Needs Node 20 or newer.
 *
 * Secrets (BOT_TOKEN, ADMIN_KEY, ...) come from environment variables only and are
 * never written to the repository or to the logs.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------- Configuration (all from the environment) ----------
const PORT = Number(process.env.PORT) || 4000;
const HOST = "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const CHECKOUT_URL = (process.env.CHECKOUT_URL || "").trim();
const GHL_WEBHOOK_URL = (process.env.GHL_WEBHOOK_URL || "").trim();
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const CHANNEL_ID = (process.env.CHANNEL_ID || "").trim();
const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();
const TG_API = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");

const MAX_BODY = 10 * 1024;
const RATE_LIMIT = 10;                 // lead submissions per IP
const RATE_WINDOW_MS = 60 * 60 * 1000; // per hour

// ---------- Storage: one small JSON file, written atomically ----------
const LEADS_FILE = path.join(DATA_DIR, "leads.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

let leads = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(LEADS_FILE, "utf8"));
  leads = new Map(saved.map((l) => [l.id, l]));
} catch {
  /* first run: no file yet */
}

function persist() {
  const tmp = LEADS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify([...leads.values()], null, 2), { mode: 0o600 });
  fs.renameSync(tmp, LEADS_FILE);
}

// ---------- Small helpers ----------
const hits = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    if (!list.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  return ((req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress || "").trim();
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function isAdmin(req) {
  return Boolean(ADMIN_KEY) && safeEqual(req.headers["x-admin-key"] || "", ADMIN_KEY);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
  }
  return { Vary: "Origin" };
}

function sendJson(req, res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(req),
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("bad json"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// ---------- Validation ----------
function clean(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function validateLead(body) {
  const name = clean(body.name, 100);
  const email = clean(body.email, 160).toLowerCase();
  const phone = clean(body.phone, 40);
  const telegram = clean(body.telegram, 40).replace(/^@+/, "").replace(/^https?:\/\/t\.me\//i, "");
  const errors = {};

  if (name.length < 2) errors.name = "Please enter your full name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = "Please enter a valid email address.";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) errors.phone = "Please enter a valid phone number.";
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(telegram)) {
    errors.telegram = "Enter your Telegram username (5 to 32 letters, numbers or underscores).";
  }

  const src = body.source && typeof body.source === "object" ? body.source : {};
  const source = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "ttclid", "referrer"]) {
    if (src[k]) source[k] = clean(src[k], 200);
  }
  return { ok: Object.keys(errors).length === 0, errors, value: { name, email, phone, telegram, source } };
}

// ---------- Outbound calls ----------
async function tg(method, payload, signal) {
  const res = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    // The description never contains the token, so it is safe to surface.
    throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
  }
  return data.result;
}

function notifyGhl(event, lead) {
  if (!GHL_WEBHOOK_URL) return;
  const payload = {
    event,
    id: lead.id,
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    telegram_username: lead.telegram,
    status: lead.status,
    invite_link: lead.inviteLink || "",
    created_at: lead.createdAt,
    ...lead.source,
  };
  fetch(GHL_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  }).catch((e) => console.error(`GoHighLevel webhook failed (${event}): ${e.message}`));
}

// ---------- Core actions ----------
function findLead(ref) {
  if (!ref) return null;
  if (leads.has(ref)) return leads.get(ref);
  const e = String(ref).toLowerCase();
  const matches = [...leads.values()].filter((l) => l.email === e);
  return matches.length ? matches[matches.length - 1] : null;
}

/** Payment confirmed: create this buyer's personal invite link. */
async function markPaid(lead) {
  if (!BOT_TOKEN || !CHANNEL_ID) throw new Error("BOT_TOKEN and CHANNEL_ID are not set");
  if (lead.status === "joined") return lead;

  const firstTime = !lead.inviteLink;
  if (firstTime) {
    // A join request link: Telegram asks the bot to approve each person, so the
    // bot can check the username before letting them in.
    const invite = await tg("createChatInviteLink", {
      chat_id: CHANNEL_ID,
      name: `${lead.name} ${lead.id}`.slice(0, 32),
      creates_join_request: true,
    });
    lead.inviteLink = invite.invite_link;
  }
  lead.status = lead.status === "lead" ? "paid" : lead.status;
  lead.paidAt = lead.paidAt || new Date().toISOString();
  persist();
  // Tell GoHighLevel only once, so asking again never triggers a second email or text.
  if (firstTime) notifyGhl("paid_invite_created", lead);
  return lead;
}

async function handleJoinRequest(req) {
  const link = req.invite_link && req.invite_link.invite_link;
  const lead = link && [...leads.values()].find((l) => l.inviteLink === link);
  const username = String((req.from && req.from.username) || "").toLowerCase();
  const chat_id = req.chat.id;
  const user_id = req.from.id;

  if (lead && username && username === lead.telegram.toLowerCase()) {
    await tg("approveChatJoinRequest", { chat_id, user_id });
    lead.status = "joined";
    lead.joinedAt = new Date().toISOString();
    persist();
    notifyGhl("joined", lead);
    return;
  }

  await tg("declineChatJoinRequest", { chat_id, user_id });
  if (lead) {
    lead.declined = (lead.declined || 0) + 1;
    lead.lastDeclinedAt = new Date().toISOString();
    persist();
    notifyGhl("join_declined", lead);
  }
}

let polling = true;
async function pollTelegram() {
  if (!BOT_TOKEN) {
    console.log("BOT_TOKEN not set: Telegram bot is off.");
    return;
  }
  let offset = 0;
  while (polling) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["chat_join_request"],
      }, AbortSignal.timeout(40000));
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.chat_join_request) {
          try { await handleJoinRequest(u.chat_join_request); }
          catch (e) { console.error(e.message); }
        }
      }
    } catch (e) {
      console.error(e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ---------- HTTP routes ----------
async function route(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  if (req.method === "GET" && p === "/health") {
    return sendJson(req, res, 200, { ok: true, bot: Boolean(BOT_TOKEN && CHANNEL_ID) });
  }

  if (req.method === "POST" && p === "/api/lead") {
    if (rateLimited(clientIp(req))) {
      return sendJson(req, res, 429, { ok: false, error: "Too many attempts. Please try again later." });
    }
    const body = await readJson(req);
    if (body.website) return sendJson(req, res, 200, { ok: true }); // honeypot: bots fill this in
    const v = validateLead(body);
    if (!v.ok) return sendJson(req, res, 422, { ok: false, errors: v.errors });

    // The same person submitting again updates their record instead of creating a copy.
    let lead = [...leads.values()].find(
      (l) => l.email === v.value.email && l.status === "lead"
    );
    const isNew = !lead;
    if (isNew) {
      lead = { id: crypto.randomBytes(6).toString("hex"), createdAt: new Date().toISOString(), status: "lead" };
      leads.set(lead.id, lead);
    }
    const { source, ...details } = v.value;
    Object.assign(lead, details, { updatedAt: new Date().toISOString() });
    // Keep the first ad source; a repeat visit without one must not erase it.
    if (Object.keys(source).length && (isNew || !lead.source || !Object.keys(lead.source).length)) lead.source = source;
    if (!lead.source) lead.source = {};
    persist();
    notifyGhl(isNew ? "lead_created" : "lead_updated", lead);

    return sendJson(req, res, 200, {
      ok: true,
      id: lead.id,
      checkoutUrl: CHECKOUT_URL || null,
    });
  }

  // ----- Admin routes (need the x-admin-key header) -----
  if (p.startsWith("/api/admin")) {
    if (!isAdmin(req)) return sendJson(req, res, 401, { ok: false, error: "Unauthorized" });

    if (req.method === "GET" && p === "/api/admin/leads") {
      return sendJson(req, res, 200, { ok: true, leads: [...leads.values()] });
    }

    if (req.method === "POST" && p === "/api/admin/mark-paid") {
      const body = await readJson(req);
      const lead = findLead(body.id || body.email);
      if (!lead) return sendJson(req, res, 404, { ok: false, error: "Lead not found" });
      try {
        await markPaid(lead);
      } catch (e) {
        console.error(e.message);
        return sendJson(req, res, 502, { ok: false, error: e.message });
      }
      return sendJson(req, res, 200, { ok: true, id: lead.id, status: lead.status, inviteLink: lead.inviteLink });
    }
  }

  return sendJson(req, res, 404, { ok: false, error: "Not found" });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = e.status || 500;
    if (status === 500) console.error(e.message);
    if (!res.headersSent) sendJson(req, res, status, { ok: false, error: status === 500 ? "Server error" : e.message });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Inner Circle service listening on ${HOST}:${PORT}`);
  if (!ALLOWED_ORIGINS.length) console.warn("ALLOWED_ORIGINS is empty: browsers will be blocked from calling /api/lead.");
  pollTelegram();
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    polling = false;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
