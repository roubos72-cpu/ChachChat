const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const { nanoid } = require("nanoid");

const app = express();
app.use(express.json({ limit: "200kb" }));

// ----- DB (SQLite) -----
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, "chachchat.db");
const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  passhash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(username) REFERENCES users(username)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
`);

const USERNAME_RE = /^[A-Za-z0-9 _.-]{2,24}$/;

// ----- Helpers -----
function bad(res, code, msg) {
  return res.status(code).json({ ok: false, error: msg });
}

function validateUsername(username) {
  if (typeof username !== "string") return "Username required.";
  const u = username.trim();
  if (!USERNAME_RE.test(u)) return "Username must be 2–24 chars: letters, numbers, space, _ . -";
  return null;
}

function validatePassword(password) {
  if (typeof password !== "string") return "Password required.";
  if (password.length < 4 || password.length > 64) return "Password must be 4–64 characters.";
  return null;
}

function getToken(req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function auth(req, res, next) {
  const token = getToken(req);
  if (!token) return bad(res, 401, "Not signed in.");
  const row = db.prepare("SELECT username FROM sessions WHERE token=?").get(token);
  if (!row) return bad(res, 401, "Session expired. Please sign in again.");
  req.user = { username: row.username, token };
  next();
}

// ----- Static files -----
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// ----- API -----
app.post("/api/register", (req, res) => {
  const { username, password } = req.body || {};
  const uErr = validateUsername(username);
  if (uErr) return bad(res, 400, uErr);
  const pErr = validatePassword(password);
  if (pErr) return bad(res, 400, pErr);

  const u = username.trim();

  const existing = db.prepare("SELECT username FROM users WHERE username=?").get(u);
  if (existing) return bad(res, 409, "That username is already taken.");

  const passhash = bcrypt.hashSync(password, 10);
  db.prepare("INSERT INTO users(username, passhash, created_at) VALUES(?,?,?)")
    .run(u, passhash, Date.now());

  // auto-login after register
  const token = nanoid(32);
  db.prepare("INSERT INTO sessions(token, username, created_at) VALUES(?,?,?)")
    .run(token, u, Date.now());

  res.json({ ok: true, token, username: u });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const uErr = validateUsername(username);
  if (uErr) return bad(res, 400, uErr);
  const pErr = validatePassword(password);
  if (pErr) return bad(res, 400, pErr);

  const u = username.trim();
  const row = db.prepare("SELECT username, passhash FROM users WHERE username=?").get(u);
  if (!row) return bad(res, 401, "Wrong username or password.");

  const ok = bcrypt.compareSync(password, row.passhash);
  if (!ok) return bad(res, 401, "Wrong username or password.");

  const token = nanoid(32);
  db.prepare("INSERT INTO sessions(token, username, created_at) VALUES(?,?,?)")
    .run(token, u, Date.now());

  res.json({ ok: true, token, username: u });
});

app.post("/api/logout", auth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token=?").run(req.user.token);
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ ok: true, username: req.user.username });
});

app.get("/api/messages", auth, (req, res) => {
  const msgs = db.prepare(
    "SELECT id, username, text, ts FROM messages ORDER BY ts DESC LIMIT 100"
  ).all().reverse();
  res.json({ ok: true, messages: msgs });
});

app.post("/api/messages", auth, (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== "string") return bad(res, 400, "Message required.");
  const cleaned = text.trim();
  if (!cleaned) return bad(res, 400, "Message required.");
  if (cleaned.length > 500) return bad(res, 400, "Message too long (max 500).");

  const ts = Date.now();
  const info = db.prepare("INSERT INTO messages(username, text, ts) VALUES(?,?,?)")
    .run(req.user.username, cleaned, ts);

  const msg = { id: info.lastInsertRowid, username: req.user.username, text: cleaned, ts };
  io.emit("message", msg);
  res.json({ ok: true, message: msg });
});

// ----- Socket.IO -----
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: false }
});

function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error("Not signed in"));
  const row = db.prepare("SELECT username FROM sessions WHERE token=?").get(String(token));
  if (!row) return next(new Error("Session expired"));
  socket.user = { username: row.username, token: String(token) };
  next();
}

io.use(socketAuth);

io.on("connection", (socket) => {
  // Send recent messages on connect (already signed in)
  const msgs = db.prepare(
    "SELECT id, username, text, ts FROM messages ORDER BY ts DESC LIMIT 100"
  ).all().reverse();
  socket.emit("init", { messages: msgs, username: socket.user.username });

  socket.on("send", (payload) => {
    const text = (payload?.text ?? "").toString().trim();
    if (!text) return;
    if (text.length > 500) return;

    const ts = Date.now();
    const info = db.prepare("INSERT INTO messages(username, text, ts) VALUES(?,?,?)")
      .run(socket.user.username, text, ts);

    const msg = { id: info.lastInsertRowid, username: socket.user.username, text, ts };
    io.emit("message", msg);
  });
});

// ----- Start -----
const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  console.log(`ChachChat listening on port ${PORT}`);
});
