// --- PATCH: Online user list (presence) ---
// Drop-in replacement for your existing index.js from ChachChat_All_Fixed.zip.
// Keeps login/chat/persistence the same, adds:
//   GET /api/online  -> { ok: true, online: [usernames...] }
//   SSE event "presence" -> { online: [...] }

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");

const app = express();
app.disable("x-powered-by");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// ✅ Use Railway volume if present; fallback to local file
const DB_PATH =
  process.env.DB_PATH ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "chachchat.sqlite")
    : (require("fs").existsSync("/data") ? "/data/chachchat.sqlite" : path.join(__dirname, "data.sqlite")));

app.use(express.json({ limit: "64kb" }));

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  cookieHeader.split(";").forEach(part => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setAuthCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `chachchat_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}`
  );
}
function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", "chachchat_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

const db = new sqlite3.Database(DB_PATH);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function initDb() {
  await dbRun(`PRAGMA journal_mode = WAL;`);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  setInterval(async () => {
    try {
      await dbRun(`DELETE FROM sessions WHERE expires_at < ?`, [new Date().toISOString()]);
    } catch {}
  }, 60_000).unref();
}

function normalizeUsername(u) {
  if (typeof u !== "string") return "";
  return u.trim();
}
function validateUsername(u) {
  if (!u || u.length < 2 || u.length > 24) return false;
  return /^[A-Za-z0-9 _\-.]+$/.test(u);
}
function validatePassword(p) {
  return typeof p === "string" && p.length >= 4 && p.length <= 64;
}

async function requireAuth(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie || "");
    const token = cookies.chachchat_token;
    if (!token) return res.status(401).json({ error: "Not signed in" });

    const session = await dbGet(
      `SELECT username, expires_at FROM sessions WHERE token = ?`,
      [token]
    );
    if (!session) return res.status(401).json({ error: "Not signed in" });
    if (session.expires_at < new Date().toISOString()) {
      await dbRun(`DELETE FROM sessions WHERE token = ?`, [token]);
      return res.status(401).json({ error: "Session expired" });
    }
    req.user = { username: session.username, token };
    next();
  } catch (e) {
    console.error("auth error", e);
    res.status(500).json({ error: "Server error" });
  }
}

async function createSession(username, res) {
  const token = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 14);
  await dbRun(
    `INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    [token, username, now.toISOString(), expires.toISOString()]
  );
  setAuthCookie(res, token);
}

// ---- SSE hub + Presence
const sseClients = new Set(); // Set<res>
const presenceCounts = new Map(); // username -> count

function sseBroadcast(event, dataObj) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

function onlineList() {
  return Array.from(presenceCounts.keys()).sort((a,b)=>a.localeCompare(b));
}

function bumpPresence(username, delta) {
  const prev = presenceCounts.get(username) || 0;
  const next = prev + delta;
  if (next <= 0) presenceCounts.delete(username);
  else presenceCounts.set(username, next);
  sseBroadcast("presence", { online: onlineList() });
}

// ---- API
app.post("/api/register", async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password;

    if (!validateUsername(username)) return res.status(400).json({ error: "Invalid username" });
    if (!validatePassword(password)) return res.status(400).json({ error: "Invalid password" });

    const existing = await dbGet(`SELECT username FROM users WHERE username = ?`, [username]);
    if (existing) return res.status(409).json({ error: "Username already exists" });

    const pass_hash = await bcrypt.hash(password, 10);
    await dbRun(
      `INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)`,
      [username, pass_hash, new Date().toISOString()]
    );

    await createSession(username, res);
    res.json({ ok: true, username });
  } catch (e) {
    console.error("register error", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password;

    if (!validateUsername(username) || !validatePassword(password)) {
      return res.status(400).json({ error: "Invalid username or password" });
    }

    const user = await dbGet(`SELECT username, pass_hash FROM users WHERE username = ?`, [username]);
    if (!user) return res.status(401).json({ error: "Wrong username or password" });

    const ok = await bcrypt.compare(password, user.pass_hash);
    if (!ok) return res.status(401).json({ error: "Wrong username or password" });

    await createSession(username, res);
    res.json({ ok: true, username });
  } catch (e) {
    console.error("login error", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/logout", requireAuth, async (req, res) => {
  try {
    await dbRun(`DELETE FROM sessions WHERE token = ?`, [req.user.token]);
    clearAuthCookie(res);
    res.json({ ok: true });
  } catch (e) {
    console.error("logout error", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/me", requireAuth, async (req, res) => {
  res.json({ ok: true, username: req.user.username });
});

app.get("/api/messages", requireAuth, async (req, res) => {
  try {
    const since = Number(req.query.since || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const rows = await dbAll(
      `SELECT id, username, text, created_at FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`,
      [since, limit]
    );
    res.json({ ok: true, messages: rows });
  } catch (e) {
    console.error("messages get error", e);
    res.status(500).json({ error: "Server error" });
  }
});

function sanitizeText(s) {
  if (typeof s !== "string") return "";
  return s.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 500);
}

app.post("/api/messages", requireAuth, async (req, res) => {
  try {
    const text = sanitizeText(req.body?.text);
    if (!text) return res.status(400).json({ error: "Empty message" });

    const now = new Date().toISOString();
    const result = await dbRun(
      `INSERT INTO messages (username, text, created_at) VALUES (?, ?, ?)`,
      [req.user.username, text, now]
    );

    const msg = { id: result.lastID, username: req.user.username, text, created_at: now };
    sseBroadcast("message", msg);
    res.json({ ok: true, message: msg });
  } catch (e) {
    console.error("messages post error", e);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Online list endpoint
app.get("/api/online", requireAuth, async (req, res) => {
  res.json({ ok: true, online: onlineList() });
});

// SSE stream
app.get("/api/stream", requireAuth, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  sseClients.add(res);

  // presence bump for this connection
  bumpPresence(req.user.username, +1);

  // initial hello + presence snapshot
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  res.write(`event: presence\ndata: ${JSON.stringify({ online: onlineList() })}\n\n`);

  req.on("close", () => {
    sseClients.delete(res);
    bumpPresence(req.user.username, -1);
  });
});

// Static
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: "1h",
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
  }
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`ChachChat listening on port ${PORT}`));
}).catch((e) => {
  console.error("Failed to init DB", e);
  process.exit(1);
});
