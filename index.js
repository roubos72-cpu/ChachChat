'use strict';

/**
 * ChachChat
 * - Serves /public
 * - Users create account (username + password) stored in ./data/users.json
 * - Login returns a token stored in localStorage
 * - Chat uses Server-Sent Events (SSE) for live updates
 * - Messages stored in ./data/messages.json (keeps last 500)
 *
 * Demo notes:
 * - Tokens are in-memory (server restart logs everyone out)
 * - Passwords are hashed (bcrypt)
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');

const app = express();
app.disable('x-powered-by');

// --- Storage (JSON files) ---
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MSG_FILE = path.join(DATA_DIR, 'messages.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeWriteJson(file, obj) {
  ensureDataDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// users: { [usernameLower]: { username, passHash, createdAt } }
let users = safeReadJson(USERS_FILE, {});
// messages: [{ id, username, text, createdAt }]
let messages = safeReadJson(MSG_FILE, []);
if (!Array.isArray(messages)) messages = [];

function persistUsers() {
  safeWriteJson(USERS_FILE, users);
}

function persistMessages() {
  // keep last 500
  if (messages.length > 500) messages = messages.slice(-500);
  safeWriteJson(MSG_FILE, messages);
}

// --- Auth / sessions ---
// tokens are in-memory (token -> { username, createdAt })
const sessions = new Map();

function newToken() {
  // URL-safe token
  return crypto.randomBytes(24).toString('base64url');
}

function normalizeUsername(u) {
  return (u || '').trim();
}

function validateUsername(u) {
  // 2-24 chars, letters/numbers/space/._-
  if (typeof u !== 'string') return { ok: false, msg: 'Username is required.' };
  const username = normalizeUsername(u);
  if (username.length < 2 || username.length > 24) return { ok: false, msg: 'Username must be 2–24 characters.' };
  if (!/^[A-Za-z0-9 ._\-]+$/.test(username)) return { ok: false, msg: 'Username can contain letters, numbers, spaces, . _ -' };
  return { ok: true, username };
}

function validatePassword(p) {
  if (typeof p !== 'string') return { ok: false, msg: 'Password is required.' };
  const pass = p;
  if (pass.length < 4 || pass.length > 64) return { ok: false, msg: 'Password must be 4–64 characters.' };
  return { ok: true, password: pass };
}

function getTokenFromReq(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  if (req.body && typeof req.body.token === 'string') return req.body.token;
  return null;
}

function requireAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  const s = sessions.get(token);
  if (!s) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  req.user = { username: s.username, token };
  return next();
}

// --- Middleware ---
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false }));

// Serve static UI
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  etag: true,
  maxAge: '1h'
}));

// --- API ---
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/register', (req, res) => {
  const u = validateUsername(req.body.username);
  if (!u.ok) return res.status(400).json({ error: u.msg });

  const p = validatePassword(req.body.password);
  if (!p.ok) return res.status(400).json({ error: p.msg });

  const key = u.username.toLowerCase();
  if (users[key]) return res.status(409).json({ error: 'That username is already taken.' });

  const passHash = bcrypt.hashSync(p.password, 10);
  users[key] = {
    username: u.username,
    passHash,
    createdAt: new Date().toISOString()
  };
  persistUsers();

  const token = newToken();
  sessions.set(token, { username: u.username, createdAt: Date.now() });
  return res.json({ token, username: u.username });
});

app.post('/api/login', (req, res) => {
  const u = validateUsername(req.body.username);
  if (!u.ok) return res.status(400).json({ error: u.msg });

  const p = validatePassword(req.body.password);
  if (!p.ok) return res.status(400).json({ error: p.msg });

  const key = u.username.toLowerCase();
  const record = users[key];
  if (!record) return res.status(401).json({ error: 'Invalid username or password.' });

  const ok = bcrypt.compareSync(p.password, record.passHash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });

  const token = newToken();
  sessions.set(token, { username: record.username, createdAt: Date.now() });
  return res.json({ token, username: record.username });
});

app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete(req.user.token);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username });
});

app.get('/api/messages', requireAuth, (_req, res) => {
  res.json({ messages });
});

app.post('/api/messages', requireAuth, (req, res) => {
  const text = (req.body && typeof req.body.text === 'string') ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'Message is empty.' });
  if (text.length > 500) return res.status(400).json({ error: 'Message is too long (max 500 chars).' });

  const msg = {
    id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    username: req.user.username,
    text,
    createdAt: new Date().toISOString()
  };

  messages.push(msg);
  persistMessages();
  broadcast({ type: 'message', message: msg });

  res.json({ ok: true, message: msg });
});

// --- SSE stream ---
/** @type {Set<import('http').ServerResponse>} */
const clients = new Set();

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(payload) {
  for (const res of clients) {
    try {
      sseWrite(res, 'msg', payload);
    } catch {
      // ignore
    }
  }
}

app.get('/api/stream', (req, res) => {
  const token = getTokenFromReq(req);
  const s = token ? sessions.get(token) : null;
  if (!s) return res.status(401).end('Not authorized');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Initial
  sseWrite(res, 'msg', { type: 'hello', username: s.username, messages });

  clients.add(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // ignore
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

// SPA-ish: always serve index.html for root
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start ---
const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, () => {
  console.log(`ChachChat listening on port ${PORT}`);
});
