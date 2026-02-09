/**
 * ChachChat - simple realtime-ish chat with per-user accounts (username + password).
 * - No external DB (stores JSON files). Good for small demos.
 * - IMPORTANT: Storage on Railway free tier may reset; treat as demo.
 */
import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "128kb" }));

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MSG_FILE = path.join(DATA_DIR, "messages.json");

// Sign tokens so we don't need to store sessions.
// Set TOKEN_SECRET in Railway Variables for better security.
const TOKEN_SECRET = process.env.TOKEN_SECRET || "change-me-in-railway-variables";

// Limits
const MAX_MESSAGES = 500;
const MAX_TEXT_LEN = 500;

// Username rules (match UI copy)
const USERNAME_RE = /^[A-Za-z0-9 _.-]{2,24}$/;

// ---------- Tiny JSON store helpers ----------
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({ users: {} }, null, 2));
  if (!fs.existsSync(MSG_FILE)) fs.writeFileSync(MSG_FILE, JSON.stringify({ messages: [] }, null, 2));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

ensureDataDir();

// In-memory caches (loaded from disk at startup)
let usersDb = readJson(USERS_FILE, { users: {} });   // { users: { [username]: { salt, hash, createdAt } } }
let msgDb = readJson(MSG_FILE, { messages: [] });    // { messages: [{ id, at, user, text }] }

// ---------- Password hashing ----------
function hashPassword(password, saltB64) {
  const salt = saltB64 ? Buffer.from(saltB64, "base64") : crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 120_000, 32, "sha256");
  return {
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
  };
}
function constantTimeEqual(aB64, bB64) {
  const a = Buffer.from(aB64, "base64");
  const b = Buffer.from(bB64, "base64");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------- Token helpers ----------
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function unb64url(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}
function signToken(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const payloadB64 = b64url(payload);
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(payloadB64).digest();
  const sigB64 = b64url(sig);
  return `${payloadB64}.${sigB64}`;
}
function verifyToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  const expected = b64url(crypto.createHmac("sha256", TOKEN_SECRET).update(payloadB64).digest());
  if (expected !== sigB64) return null;
  try {
    const payload = JSON.parse(unb64url(payloadB64).toString("utf8"));
    if (!payload?.u || !payload?.exp) return null;
    if (Date.now() > payload.exp) return null;
    return payload; // { u, exp }
  } catch {
    return null;
  }
}

function makeToken(username) {
  // 7 days
  return signToken({ u: username, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
}

// ---------- Auth middleware ----------
function auth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const m = hdr.match(/^Bearer (.+)$/i);
  if (!m) return res.status(401).json({ ok: false, error: "Missing token" });
  const payload = verifyToken(m[1]);
  if (!payload) return res.status(401).json({ ok: false, error: "Invalid token" });
  const username = payload.u;
  if (!usersDb.users[username]) return res.status(401).json({ ok: false, error: "Unknown user" });
  req.user = username;
  next();
}

// ---------- API ----------
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/register", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ ok: false, error: "Username must be 2–24 chars. Allowed: letters, numbers, space, _ . -" });
  }
  if (password.length < 4 || password.length > 64) {
    return res.status(400).json({ ok: false, error: "Password must be 4–64 characters." });
  }
  if (usersDb.users[username]) {
    return res.status(409).json({ ok: false, error: "That username is already taken." });
  }

  const { salt, hash } = hashPassword(password);
  usersDb.users[username] = { salt, hash, createdAt: new Date().toISOString() };
  writeJson(USERS_FILE, usersDb);

  const token = makeToken(username);
  return res.json({ ok: true, token, username });
});

app.post("/api/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const rec = usersDb.users[username];
  if (!rec) return res.status(401).json({ ok: false, error: "Wrong username or password." });

  const { hash } = hashPassword(password, rec.salt);
  if (!constantTimeEqual(hash, rec.hash)) {
    return res.status(401).json({ ok: false, error: "Wrong username or password." });
  }

  const token = makeToken(username);
  return res.json({ ok: true, token, username });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ ok: true, username: req.user });
});

app.get("/api/messages", auth, (req, res) => {
  const since = Number(req.query.since || 0);
  const now = Date.now();
  const messages = msgDb.messages.filter(m => m.at > since);
  res.json({ ok: true, messages, now });
});

app.post("/api/messages", auth, (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "Message is empty." });
  if (text.length > MAX_TEXT_LEN) return res.status(400).json({ ok: false, error: `Message too long (max ${MAX_TEXT_LEN}).` });

  const msg = {
    id: crypto.randomUUID(),
    at: Date.now(),
    user: req.user,
    text,
  };
  msgDb.messages.push(msg);
  if (msgDb.messages.length > MAX_MESSAGES) msgDb.messages.splice(0, msgDb.messages.length - MAX_MESSAGES);
  writeJson(MSG_FILE, msgDb);

  res.json({ ok: true, message: msg });
});

// Optional: serve favicon to stop console 404 noise
app.get("/favicon.ico", (req, res) => {
  const ico = path.join(__dirname, "public", "favicon.ico");
  if (fs.existsSync(ico)) return res.sendFile(ico);
  res.status(204).end();
});

// ---------- Static site ----------
app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"]
}));

// SPA-ish fallback (if someone hits /)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ChachChat listening on port ${PORT}`);
});
