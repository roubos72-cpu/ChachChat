(() => {
  const $ = (id) => document.getElementById(id);

  const messagesEl = $("messages");
  const form = $("form");
  const textEl = $("text");
  const whoEl = $("who");
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

  let mode = "login"; // "login" or "register"
  let token = localStorage.getItem("chachchat_token") || "";
  let username = localStorage.getItem("chachchat_username") || "";
  let es = null;
  let pollTimer = null;

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
      setAuthError("");
    }
  }

  function setAuthError(msg) {
    if (msg) {
      authError.hidden = false;
      authError.textContent = msg;
    } else {
      authError.hidden = true;
      authError.textContent = "";
    }
  }

  function setMode(next) {
    mode = next;
    tabLogin.classList.toggle("active", mode === "login");
    tabRegister.classList.toggle("active", mode === "register");
    authSubmit.textContent = mode === "login" ? "Sign in" : "Create account";
  }

  tabLogin.addEventListener("click", () => setMode("login"));
  tabRegister.addEventListener("click", () => setMode("register"));

  async function api(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    const init = Object.assign({}, opts, { headers });
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, init);
    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    const data = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => "");
    if (!res.ok) {
      const msg = (data && data.error) ? data.error : `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  function escapeHtml(s) {
    return (s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatTime(ms) {
    const d = new Date(ms);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function renderMessages(list) {
    messagesEl.innerHTML = "";
    for (const m of list) addMessage(m, true);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(m, silent = false) {
    // ✅ Fix date: accept createdAt or created_at
    const ts = m.createdAt ?? m.created_at ?? m.ts ?? Date.now();
    const time = formatTime(ts);

    const row = document.createElement("div");
    row.className = "msg";

    row.innerHTML = `
      <div class="msgMeta">
        <span class="msgUser">${escapeHtml(m.username || "")}</span>
        <span class="msgTime">${escapeHtml(time)}</span>
      </div>
      <div class="msgText">${escapeHtml(m.text || "")}</div>
    `;

    messagesEl.appendChild(row);

    if (!silent) {
      const nearBottom = (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 120;
      if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  async function loadMessages() {
    const data = await api("/api/messages");
    renderMessages(data.messages || []);
  }

  function stopRealtime() {
    if (es) {
      try { es.close(); } catch (_) {}
      es = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    setConnected(false);
  }

  function startPollingFallback() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        await loadMessages();
      } catch (_) {}
    }, 2500);
  }

  function startRealtime() {
    stopRealtime();

    // ✅ SSE must pass token in query string (EventSource can't send headers)
    const url = `/api/stream?token=${encodeURIComponent(token)}`;
    es = new EventSource(url);

    es.addEventListener("open", () => {
      setConnected(true);
    });

    es.addEventListener("hello", () => {
      setConnected(true);
    });

    es.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        addMessage(msg);
      } catch (_) {}
    });

    es.addEventListener("error", () => {
      setConnected(false);
      // Some networks/proxies break SSE; keep chat "auto-refresh" via polling fallback
      startPollingFallback();
    });
  }

  async function doAuth() {
    const u = (authUser.value || "").trim();
    const p = (authPass.value || "").trim();

    if (!u || u.length < 2) return setAuthError("Username is required.");
    if (!p || p.length < 4) return setAuthError("Password must be at least 4 characters.");

    try {
      const data = await api(mode === "login" ? "/api/login" : "/api/register", {
        method: "POST",
        body: JSON.stringify({ username: u, password: p }),
        headers: {} // no bearer token yet
      });

      token = data.token;
      username = data.username;

      localStorage.setItem("chachchat_token", token);
      localStorage.setItem("chachchat_username", username);

      whoEl.textContent = username;
      showAuth(false);

      await loadMessages();
      startRealtime();
    } catch (e) {
      setAuthError(e.message || "Request failed");
    }
  }

  authSubmit.addEventListener("click", (e) => {
    e.preventDefault();
    doAuth();
  });

  authPass.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doAuth();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = (textEl.value || "").trim();
    if (!text) return;
    textEl.value = "";
    try {
      await api("/api/send", {
        method: "POST",
        body: JSON.stringify({ text })
      });
      // message arrives via SSE (or polling)
    } catch (err) {
      // Put text back if failed
      textEl.value = text;
      alert(err.message || "Send failed");
    }
  });

  btnLogout.addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST" }); } catch (_) {}
    token = "";
    username = "";
    localStorage.removeItem("chachchat_token");
    localStorage.removeItem("chachchat_username");
    whoEl.textContent = "";
    stopRealtime();
    showAuth(true);
  });

  // ---- boot ----
  whoEl.textContent = username || "";
  if (!token) {
    showAuth(true);
  } else {
    // validate by loading messages; if fails show auth
    loadMessages()
      .then(() => startRealtime())
      .catch(() => {
        token = "";
        localStorage.removeItem("chachchat_token");
        showAuth(true);
      });
  }

  // Clicking backdrop doesn't close (forces auth)
})();
