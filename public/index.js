import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "256kb" }));

// --- Config ---
const PORT = process.env.PORT || 3000;
// Optional: set a site-wide admin password? Not used now.
// Users create their own passwords.
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// --- SQLite (persistent on Railway as long as the container storage persists for that deploy;
// still best-effort persistence; if redeployed to new container, DB resets) ---
const db = new Database(path.join(__dirname, "chachchat.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const stmtInsertUser = db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)");
const stmtGetUser = db.prepare("SELECT username, password_hash FROM users WHERE username = ?");
const stmtInsertMsg = db.prepare("INSERT INTO messages (username, text, created_at) VALUES (?, ?, ?)");
const stmtGetMsgs = db.prepare("SELECT id, username, text, created_at FROM messages ORDER BY id DESC LIMIT ?");
const stmtGetMsgsAfter = db.prepare("SELECT id, username, text, created_at FROM messages WHERE id > ? ORDER BY id ASC");

// --- In-memory token store (simple) ---
/** @type {Map<string, {username: string, expiresAt: number}>} */
const tokens = new Map();

function newToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function normalizeUsername(u) {
  return String(u || "").trim();
}

function validateUsername(u) {
  // 2-24 chars; letters/numbers/space/_-.
  if (!u) return "Username is required.";
  if (u.length < 2 || u.length > 24) return "Username must be 2–24 characters.";
  if (!/^[A-Za-z0-9 _.-]+$/.test(u)) return "Username can only use letters, numbers, spaces, _ . -";
  return null;
}

function validatePassword(p) {
  if (!p) return "Password is required.";
  if (p.length < 4) return "Password must be at least 4 characters.";
  if (p.length > 64) return "Password must be 64 characters or less.";
  return null;
}

// Basic content filter (optional but helps prevent slurs/spam).
const banned = [
  // keep small & obvious; you can expand this
  "nigger", "nigga", "faggot", "kike", "wetback"
];
function isBanned(text) {
  const t = String(text || "").toLowerCase();
  return banned.some(w => t.includes(w));
}

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ error: "Missing token" });
  const rec = tokens.get(token);
  if (!rec) return res.status(401).json({ error: "Invalid token" });
  if (Date.now() > rec.expiresAt) {
    tokens.delete(token);
    return res.status(401).json({ error: "Token expired" });
  }
  req.user = { username: rec.username, token };
  next();
}

// --- Auth endpoints ---
app.post("/api/register", (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = String(req.body?.password || "");

  const uerr = validateUsername(username);
  if (uerr) return res.status(400).json({ error: uerr });

  const perr = validatePassword(password);
  if (perr) return res.status(400).json({ error: perr });

  const existing = stmtGetUser.get(username);
  if (existing) return res.status(409).json({ error: "Username already taken. Try a different one." });

  const hash = bcrypt.hashSync(password, 10);
  stmtInsertUser.run(username, hash, Date.now());

  const token = newToken();
  tokens.make?.(); // no-op for older runtimes
  tokens.set(token, { username, expiresAt: Date.now() + TOKEN_TTL_MS });

  return res.json({ token, username });
});

app.post("/api/login", (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = String(req.body?.password || "");

  const uerr = validateUsername(username);
  if (uerr) return res.status(400).json({ error: uerr });

  const perr = validatePassword(password);
  if (perr) return res.status(400).json({ error: perr });

  const user = stmtGetUser.get(username);
  if (!user) return res.status(401).json({ error: "Invalid username or password." });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid username or password." });

  const token = newToken();
  tokens.set(token, { username, expiresAt: Date.now() + TOKEN_TTL_MS });

  return res.json({ token, username });
});

app.post("/api/logout", auth, (req, res) => {
  tokens.delete(req.user.token);
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ username: req.user.username });
});

// --- Chat endpoints ---
app.get("/api/messages", auth, (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  const rows = stmtGetMsgs.all(limit).reverse();
  res.json({ messages: rows });
});

app.post("/api/messages", auth, (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Message can't be empty." });
  if (text.length > 500) return res.status(400).json({ error: "Message too long (max 500)." });
  if (isBanned(text)) return res.status(400).json({ error: "That message contains banned words." });

  const info = stmtInsertMsg.run(req.user.username, text, Date.now());
  const msg = { id: Number(info.lastInsertRowid), username: req.user.username, text, created_at: Date.now() };
  broadcast(msg);
  res.json({ ok: true, message: msg });
});

// SSE stream (live updates)
const clients = new Set(); // { res, lastId }
function broadcast(msg) {
  const payload = `event: message\ndata: ${JSON.stringify(msg)}\n\n`;
  for (const c of clients) {
    try { c.res.write(payload); } catch {}
  }
}


function authFromQuery(req, res, next) {
  const token = String(req.query.token || "").trim();
  if (!token) return res.status(401).end();
  const rec = tokens.get(token);
  if (!rec) return res.status(401).end();
  if (Date.now() > rec.expiresAt) {
    tokens.delete(token);
    return res.status(401).end();
  }
  req.user = { username: rec.username, token };
  next();
}

app.get("/api/stream", authFromQuery, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // send last 30 on connect (optional)
  const last = stmtGetMsgs.all(30).reverse();
  res.write(`event: hello\ndata: ${JSON.stringify({ username: req.user.username, recent: last })}\n\n`);

  const client = { res };
  clients.add(client);

  req.on("close", () => {
    clients.delete(client);
  });
});

// --- Static site ---
app.use(express.static(path.join(__dirname, "public")));

// SPA-ish fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`ChachChat running on ${PORT}`);
});