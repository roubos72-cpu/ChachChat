// ChachChat - Railway-ready Node.js realtime chat
// - Enforces username on the client (modal) + server-side validation
// - Realtime updates via Socket.IO (no manual refresh)
// - Serves /public (index.html, client.js, styles.css, logo.png)

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Allow Railway/behind-proxy websockets + long-polling fallback
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

// ---- Config ----
const PORT = process.env.PORT || 3000;
const MAX_MESSAGES = 200;

// ---- In-memory message store (for demo) ----
// If you redeploy/restart, history resets.
/** @type {{id:string, user:string, text:string, ts:number}[]} */
const messages = [];

function safeString(v) {
  return String(v ?? "").trim();
}

function clampText(s, maxLen) {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

function addMessage(user, text) {
  const msg = {
    id: Math.random().toString(16).slice(2) + Date.now().toString(16),
    user,
    text,
    ts: Date.now(),
  };
  messages.push(msg);
  if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
  return msg;
}

// ---- Static site ----
app.use(express.static(pubDir()));

function pubDir() {
  return path.join(__dirname, "public");
}

// Health + optional REST history
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/messages", (_req, res) => res.json({ messages }));

// ---- Socket.IO ----
io.on("connection", (socket) => {
  // Send current history to the newly-connected client
  socket.emit("history", messages);

  socket.on("chat:send", (payload, ack) => {
    try {
      const user = clampText(safeString(payload?.user), 24);
      const text = clampText(safeString(payload?.text), 500);

      // Server-side enforcement too (never trust the browser)
      if (!user) {
        if (typeof ack === "function") ack({ ok: false, error: "Username required." });
        return;
      }
      // Basic username rules (edit if you want)
      if (!/^[a-zA-Z0-9 _.-]{2,24}$/.test(user)) {
        if (typeof ack === "function") ack({ ok: false, error: "Username must be 2-24 chars: letters/numbers/space/._-" });
        return;
      }
      if (!text) {
        if (typeof ack === "function") ack({ ok: false, error: "Message can't be empty." });
        return;
      }

      const msg = addMessage(user, text);

      // Broadcast to everyone (including sender)
      io.emit("chat:new", msg);

      if (typeof ack === "function") ack({ ok: true });
    } catch (e) {
      if (typeof ack === "function") ack({ ok: false, error: "Server error." });
    }
  });
});

server.listen(PORT, () => {
  console.log(`ChachChat listening on port ${PORT}`);
});
