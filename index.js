const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("public"));

const users = {};
const messages = [];

function makeId() {
  return crypto.randomBytes(8).toString("hex");
}

app.post("/api/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Missing fields" });
  if (users[username]) return res.status(400).json({ error: "User exists" });
  users[username] = password;
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (users[username] !== password) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  res.json({ ok: true });
});

io.on("connection", socket => {
  socket.emit("history", messages);

  socket.on("message", msg => {
    const entry = {
      id: makeId(),
      user: msg.user,
      text: msg.text,
      time: new Date().toLocaleTimeString()
    };
    messages.push(entry);
    io.emit("message", entry);
  });
});

server.listen(process.env.PORT || 8080, () => {
  console.log("ChachChat running");
});
