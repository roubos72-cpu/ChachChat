/**
 * ChachChat - stable Node/Express + SQLite chat server
 * Fixes:
 *  - Serves /public correctly on Railway (__dirname + /public)
 *  - SSE auth via ?token=... (EventSource can't send headers)
 *  - Message timestamps are always "createdAt" (ms since epoch)
 *
 * Drop-in replacement for index.js
 */
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const sqlite3 = require("sqlite3").verbose();

const app = express();

// ---- config ----
const PORT = process.env.PORT || 8080;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "chachchat.sqlite");

// ---- middleware ----
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true }));

// ✅ CRITICAL: Serve static files from the correct absolute path
app.use(express.static(path.join(__dirname, "public")));

// ---- db ----
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      salt TEXT NOT NULL,
      passhash TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      text TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);
});

function nowMs() {
  return Date.now();
}

function normalizeUsername(u) {
  return (u || "").trim();
}

function validUsername(u) {
  // 2-24 chars, letters/numbers/spaces/_-.
  return /^[A-Za-z0-9 _\-.]{2,24}$/.test(u);
}

function validPassword(p) {
  return typeof p === "string" && p.length >= 4 && p.length <= 64;
}

function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256");
  return hash.toString("hex");
}

function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

function getToken(req) {
  // Accept token via:
  //  - Authorization: Bearer <token>
  //  - query param ?token=
  //  - body.token
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  if (req.query && req.query.token) return String(req.query.token);
  if (req.body && req.body.token) return String(req.body.token);
  return "";
}

function authRequired(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Missing token" });

  db.get(
    `SELECT username FROM sessions WHERE token = ?`,
    [token],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(401).json({ error: "Invalid token" });
      req.user = { username: row.username, token };
      next();
    }
  );
}

// Optional lightweight content safety: block extreme hateful slurs.
// Keep simple; you can remove if you want.
const BLOCKED = [
  "nigger", "nigga", "faggot", "kike", "spic", "chink", "raghead"
];
function containsBlocked(text) {
  const t = (text || "").toLowerCase();
  return BLOCKED.some(w => t.includes(w));
}

function insertMessage(username, text, cb) {
  const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  const createdAt = nowMs();

  db.run(
    `INSERT INTO messages (id, username, text, createdAt) VALUES (?, ?, ?, ?)`,
    [id, username, text, createdAt],
    (err) => cb(err, { id, username, text, createdAt })
  );
}

// ---- SSE clients ----
const sseClients = new Set();

function sseSend(res, event, dataObj) {
  // data must be JSON string
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
}

function broadcastMessage(msg) {
  for (const client of sseClients) {
    try {
      sseSend(client.res, "message", msg);
    } catch (_) {}
  }
}

// ---- routes ----
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/api/register", (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = req.body.password;

  if (!validUsername(username)) return res.status(400).json({ error: "Invalid username" });
  if (!validPassword(password)) return res.status(400).json({ error: "Invalid password" });

  const salt = crypto.randomBytes(16).toString("hex");
  const passhash = hashPassword(password, salt);
  const createdAt = nowMs();

  db.run(
    `INSERT INTO users (username, salt, passhash, createdAt) VALUES (?, ?, ?, ?)`,
    [username, salt, passhash, createdAt],
    function (err) {
      if (err) {
        if (String(err).toLowerCase().includes("unique")) {
          return res.status(409).json({ error: "Username already exists" });
        }
        return res.status(500).json({ error: "DB error" });
      }

      const token = newToken();
      db.run(
        `INSERT INTO sessions (token, username, createdAt) VALUES (?, ?, ?)`,
        [token, username, nowMs()],
        (err2) => {
          if (err2) return res.status(500).json({ error: "DB error" });
          res.json({ token, username });
        }
      );
    }
  );
});

app.post("/api/login", (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = req.body.password;

  if (!validUsername(username)) return res.status(400).json({ error: "Invalid username" });
  if (!validPassword(password)) return res.status(400).json({ error: "Invalid password" });

  db.get(
    `SELECT salt, passhash FROM users WHERE username = ?`,
    [username],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(401).json({ error: "Wrong username or password" });

      const computed = hashPassword(password, row.salt);
      if (computed !== row.passhash) {
        return res.status(401).json({ error: "Wrong username or password" });
      }

      const token = newToken();
      db.run(
        `INSERT INTO sessions (token, username, createdAt) VALUES (?, ?, ?)`,
        [token, username, nowMs()],
        (err2) => {
          if (err2) return res.status(500).json({ error: "DB error" });
          res.json({ token, username });
        }
      );
    }
  );
});

app.post("/api/logout", authRequired, (req, res) => {
  db.run(`DELETE FROM sessions WHERE token = ?`, [req.user.token], (err) => {
    if (err) return res.status(500).json({ error: "DB error" });
    res.json({ ok: true });
  });
});

app.get("/api/messages", authRequired, (req, res) => {
  db.all(
    `SELECT id, username, text, createdAt FROM messages ORDER BY createdAt ASC LIMIT 500`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json({ messages: rows || [] });
    }
  );
});

app.post("/api/send", authRequired, (req, res) => {
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "Empty message" });
  if (text.length > 500) return res.status(400).json({ error: "Message too long" });
  if (containsBlocked(text)) return res.status(400).json({ error: "Message blocked" });

  insertMessage(req.user.username, text, (err, msg) => {
    if (err) return res.status(500).json({ error: "DB error" });
    broadcastMessage(msg);
    res.json({ ok: true, message: msg });
  });
});

app.get("/api/stream", (req, res) => {
  // ✅ EventSource can't send headers, so token must be query param
  const token = getToken(req);
  if (!token) return res.status(401).end("Missing token");

  db.get(`SELECT username FROM sessions WHERE token = ?`, [token], (err, row) => {
    if (err || !row) return res.status(401).end("Invalid token");

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Initial ping
    sseSend(res, "hello", { ok: true, username: row.username, ts: nowMs() });

    const client = { res, username: row.username };
    sseClients.add(client);

    req.on("close", () => {
      sseClients.delete(client);
    });
  });
});

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`ChachChat listening on port ${PORT}`);
});
