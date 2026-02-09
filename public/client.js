let socket;
let user;

function register() {
  fetch("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: user.value, password: pass.value })
  }).then(r => r.json()).then(d => {
    if (d.ok) login();
    else err.innerText = d.error;
  });
}

function login() {
  fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: user.value, password: pass.value })
  }).then(r => r.json()).then(d => {
    if (!d.ok) return err.innerText = d.error;
    document.getElementById("login").hidden = true;
    document.getElementById("chat").hidden = false;
    user = document.getElementById("user").value;
    startChat();
  });
}

function startChat() {
  socket = io();
  socket.on("history", msgs => msgs.forEach(add));
  socket.on("message", add);
}

function send() {
  const text = msg.value;
  if (!text) return;
  socket.emit("message", { user, text });
  msg.value = "";
}

function add(m) {
  const d = document.createElement("div");
  d.textContent = `[${m.time}] ${m.user}: ${m.text}`;
  messages.appendChild(d);
}
