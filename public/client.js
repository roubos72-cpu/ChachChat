/* global io */
const $ = (id) => document.getElementById(id);

const authModal = $("authModal");
const tabSignIn = $("tabSignIn");
const tabCreate = $("tabCreate");
const authSubmit = $("authSubmit");
const authAlert = $("authAlert");
const authUsername = $("authUsername");
const authPassword = $("authPassword");

const statusDot = $("statusDot");
const statusText = $("statusText");
const userPill = $("userPill");
const meName = $("meName");
const logoutBtn = $("logoutBtn");

const messagesEl = $("messages");
const composer = $("composer");
const messageInput = $("messageInput");

let mode = "login"; // or "register"
let token = localStorage.getItem("chachchat_token") || "";
let socket = null;

function setAlert(msg, kind = "error") {
  if (!msg) {
    authAlert.hidden = true;
    authAlert.textContent = "";
    authAlert.className = "alert";
    return;
  }
  authAlert.hidden = false;
  authAlert.textContent = msg;
  authAlert.className = "alert " + (kind === "ok" ? "ok" : "error");
}

function openModal() {
  authModal.classList.add("open");
  authModal.setAttribute("aria-hidden", "false");
  setAlert("");
  authPassword.value = "";
  setTimeout(() => authUsername.focus(), 50);
}

function closeModal() {
  authModal.classList.remove("open");
  authModal.setAttribute("aria-hidden", "true");
  setAlert("");
}

function setMode(next) {
  mode = next;
  const isLogin = mode === "login";
  tabSignIn.classList.toggle("active", isLogin);
  tabCreate.classList.toggle("active", !isLogin);
  authSubmit.textContent = isLogin ? "Sign in" : "Create account";
  authPassword.autocomplete = isLogin ? "current-password" : "new-password";
  setAlert("");
}

tabSignIn.addEventListener("click", () => setMode("login"));
tabCreate.addEventListener("click", () => setMode("register"));

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { res, data };
}

function setStatus(connected) {
  statusDot.classList.toggle("on", !!connected);
  statusText.textContent = connected ? "Connected" : "Disconnected";
}

function esc(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function addMessage(m, toBottom = true) {
  const row = document.createElement("div");
  row.className = "msg";
  row.innerHTML = `
    <div class="msgMeta">
      <span class="msgUser">${esc(m.username)}</span>
      <span class="msgTime">${esc(fmtTime(m.ts))}</span>
    </div>
    <div class="msgText">${esc(m.text)}</div>
  `;
  messagesEl.appendChild(row);
  if (toBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function clearMessages() {
  messagesEl.innerHTML = "";
}

function connectSocket() {
  if (!token) return;

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  socket = io({
    auth: { token }
  });

  socket.on("connect", () => setStatus(true));
  socket.on("disconnect", () => setStatus(false));

  socket.on("connect_error", (err) => {
    setStatus(false);
    // session expired -> show modal
    if ((err?.message || "").toLowerCase().includes("expired")) {
      localStorage.removeItem("chachchat_token");
      token = "";
      openModal();
      setAlert("Session expired. Please sign in again.");
    }
  });

  socket.on("init", (payload) => {
    clearMessages();
    const msgs = payload?.messages || [];
    msgs.forEach((m) => addMessage(m, false));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  socket.on("message", (m) => addMessage(m, true));
}

async function ensureSignedIn() {
  if (!token) {
    openModal();
    return false;
  }
  const { res } = await api("/api/me");
  if (!res.ok) {
    localStorage.removeItem("chachchat_token");
    token = "";
    openModal();
    return false;
  }
  return true;
}

async function afterAuth() {
  const { data } = await api("/api/me");
  const username = data?.username || "";
  meName.textContent = username;
  userPill.hidden = !username;
  logoutBtn.hidden = !username;
  closeModal();
  connectSocket();
}

authSubmit.addEventListener("click", async () => {
  const username = authUsername.value.trim();
  const password = authPassword.value;

  setAlert("");
  authSubmit.disabled = true;

  try {
    const path = mode === "login" ? "/api/login" : "/api/register";
    const { res, data } = await api(path, {
      method: "POST",
      body: JSON.stringify({ username, password })
    });

    if (!res.ok) {
      setAlert(data?.error || "Request failed");
      return;
    }

    token = data.token;
    localStorage.setItem("chachchat_token", token);
    await afterAuth();
  } catch (e) {
    setAlert("Request failed");
  } finally {
    authSubmit.disabled = false;
  }
});

authPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter") authSubmit.click();
});

logoutBtn.addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  localStorage.removeItem("chachchat_token");
  token = "";
  setStatus(false);
  userPill.hidden = true;
  logoutBtn.hidden = true;
  if (socket) socket.disconnect();
  openModal();
});

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  messageInput.value = "";

  // send via socket (fast); fallback to HTTP if socket isn't connected
  if (socket && socket.connected) {
    socket.emit("send", { text });
  } else {
    api("/api/messages", { method: "POST", body: JSON.stringify({ text }) }).catch(() => {});
  }
});

(async function boot() {
  setMode("login");
  setStatus(false);

  const ok = await ensureSignedIn();
  if (ok) await afterAuth();
})();
