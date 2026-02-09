(() => {
  const $ = (id) => document.getElementById(id);

  const messagesEl = $("messages");
  const form = $("form");
  const text = $("text");

  const who = $("who");
  const statusEl = $("status");
  const btnLogout = $("btnLogout");

  const authModal = $("authModal");
  const authBackdrop = $("authBackdrop");
  const authError = $("authError");
  const authUser = $("authUser");
  const authPass = $("authPass");
  const authSubmit = $("authSubmit");
  const tabLogin = $("tabLogin");
  const tabRegister = $("tabRegister");

  let mode = "login"; // or "register"
  let token = localStorage.getItem("chachchat_token") || "";
  let username = localStorage.getItem("chachchat_username") || "";
  let es = null;

  function setConnected(on) {
    statusEl.innerHTML = on
      ? '<span class="dot ok"></span>Connected'
      : '<span class="dot"></span>Disconnected';
  }

  function showAuth(show) {
    authModal.hidden = !show;
    authBackdrop.hidden = !show;
    if (show) {
      authUser.value = username || "";
      authPass.value = "";
      authUser.focus();
    }
  }

  function setAuthError(msg) {
    if (!msg) {
      authError.hidden = true;
      authError.textContent = "";
      return;
    }
    authError.hidden = false;
    authError.textContent = msg;
  }

  function setMode(next) {
    mode = next;
    tabLogin.classList.toggle("active", mode === "login");
    tabRegister.classList.toggle("active", mode === "register");
    authSubmit.textContent = mode === "login" ? "Sign in" : "Create account";
    setAuthError("");
  }

  tabLogin.addEventListener("click", () => setMode("login"));
  tabRegister.addEventListener("click", () => setMode("register"));

  async function api(path, options = {}) {
    const headers = options.headers || {};
    if (token) headers["Authorization"] = "Bearer " + token;
    headers["Content-Type"] = "application/json";
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function addMessage(msg) {
    const div = document.createElement("div");
    div.className = "msg";

    const time = new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    div.innerHTML = `
      <div class="meta">
        <span class="user">${escapeHtml(msg.username)}</span>
        <span class="time">${escapeHtml(time)}</span>
      </div>
      <div class="text">${escapeHtml(msg.text)}</div>
    `;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function resetMessages() {
    messagesEl.innerHTML = "";
  }

  async function loadInitial() {
    const data = await api("/api/messages?limit=80");
    resetMessages();
    for (const m of data.messages) addMessage(m);
  }

  function connectStream() {
    if (es) es.close();
    setConnected(false);

    // SSE doesn't support custom headers, so we pass token in query.
    // (Token is random; still keep it short-lived.)
    es = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);

    es.addEventListener("open", () => setConnected(true));
    es.addEventListener("error", () => setConnected(false));

    es.addEventListener("hello", (e) => {
      try {
        const payload = JSON.parse(e.data);
        resetMessages();
        for (const m of payload.recent || []) addMessage(m);
      } catch {}
    });

    es.addEventListener("message", (e) => {
      try {
        const msg = JSON.parse(e.data);
        addMessage(msg);
      } catch {}
    });
  }

  // Because we need token in SSE query, we also accept it on server via query param.
  // We'll mirror token into localStorage and also into a global variable used in query.
  // Server validates it in auth middleware for other endpoints; stream endpoint handles query param token.
  // We'll do a small trick: rewrite EventSource URL to include token; server will read req.query.token.

  // Patch: override connectStream to use token query param; server route reads query token.
  // (Already done above.)

  async function doAuth() {
    const u = authUser.value.trim();
    const p = authPass.value;
    setAuthError("");

    if (!u) return setAuthError("Enter a username.");
    if (u.length < 2 || u.length > 24) return setAuthError("Username must be 2–24 characters.");
    if (!/^[A-Za-z0-9 _.-]+$/.test(u)) return setAuthError("Username can only use letters, numbers, spaces, _ . -");
    if (!p || p.length < 4) return setAuthError("Password must be at least 4 characters.");

    try {
      const endpoint = mode === "login" ? "/api/login" : "/api/register";
      const data = await api(endpoint, { method: "POST", body: JSON.stringify({ username: u, password: p }) });
      token = data.token;
      username = data.username;
      localStorage.setItem("chachchat_token", token);
      localStorage.setItem("chachchat_username", username);

      who.textContent = `You are: ${username}`;
      btnLogout.hidden = false;

      showAuth(false);
      await loadInitial();
      connectStream();
      text.focus();
    } catch (err) {
      setAuthError(err.message || "Login failed");
    }
  }

  authSubmit.addEventListener("click", doAuth);
  authPass.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doAuth();
  });

  btnLogout.addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST" }); } catch {}
    token = "";
    username = "";
    localStorage.removeItem("chachchat_token");
    localStorage.removeItem("chachchat_username");
    btnLogout.hidden = true;
    who.textContent = "Not signed in";
    if (es) es.close();
    setConnected(false);
    showAuth(true);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = text.value.trim();
    if (!t) return;
    text.value = "";
    try {
      await api("/api/messages", { method: "POST", body: JSON.stringify({ text: t }) });
      // Message will arrive via SSE broadcast
    } catch (err) {
      alert(err.message || "Failed to send");
    }
  });

  async function start() {
    if (token) {
      try {
        const me = await api("/api/me");
        username = me.username;
        localStorage.setItem("chachchat_username", username);
        who.textContent = `You are: ${username}`;
        btnLogout.hidden = false;

        await loadInitial();
        connectStream();
        return;
      } catch {
        // token invalid
        token = "";
        localStorage.removeItem("chachchat_token");
      }
    }
    showAuth(true);
  }

  // --- SSE auth via query param ---
  // EventSource cannot send Authorization headers, so we support ?token=.
  // We keep other API calls using Bearer header.
  // This is okay for a demo; for production you'd use cookies or a dedicated SSE token.
  start();
})();