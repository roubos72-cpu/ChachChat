// index.js
// ChachChat - simple Discord-like chat backend
// Free-friendly (Railway compatible)

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// In-memory messages (resets on restart)
const messages = [];
const MAX_MESSAGES = 200;

// Serve UI
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat_ui.html"));
});

// Get messages
app.get("/messages", (req, res) => {
  res.json({ messages });
});

// Send message (username required)
app.post("/send", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const message = String(req.body?.message || "").trim();

  if (!username) {
    return res.status(400).json({ reply: "Username is required." });
  }

  if (!message) {
    return res.status(400).json({ reply: "Message cannot be empty." });
  }

  const entry = {
    username: username.slice(0, 24),
    message: message.slice(0, 500),
    time: Date.now()
  };

  messages.push(entry);
  if (messages.length > MAX_MESSAGES) messages.shift();

  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`ChachChat running on port ${PORT}`);
});
