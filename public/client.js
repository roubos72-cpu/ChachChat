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
  let es = null;
  let lastId = 0;
  let pollTimer = null;

  function setConnected(on) {
    statusEl.classList.toggle("connected", !!on);
    statusEl.innerHTML = on
      ? '<span class="dot"></span>Connected'
      : '<span class="dot"></span>Disconnected';
  }

  function showAuth(show) {
    authModal.hidden = !show;
    authBackdrop.hidden = !show;
    if (show) {
      authUser.value = "";
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

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error || `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&":"&amp;",
      "<":"&lt;",
      ">":"&gt;",
      '"':"&quot;",
      "'":"&#39;"
    }[c]));
  }

  function addMessage(m) {
    if (!m || !m.id) return;
    lastId = Math.max(lastId, m.id);

    const div = document.createElement("div");
    div.className = "msg";
    div.innerHTML = `
      <div class="msgTop">
        <div class="msgUser">${escapeHtml(m.username || "")}</div>
        <div class="msgTime">${escapeHtml(fmtTime(m.created_at))}</div>
      </div>
      <div class="msgText">${escapeHtml(m.text || "")}</div>
    `;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function loadInitial() {
    messagesEl.innerHTML = "";
    lastId = 0;
    const data = await api(`/api/messages?since=0&limit=50`, { method: "GET" });
    for (const m of data.messages || []) addMessage(m);
  }

  function stopRealtime() {
    if (es) {
      try { es.close(); } catch {}
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
        const data = await api(`/api/messages?since=${lastId}&limit=200`, { method: "GET" });
        const msgs = data.messages || [];
        if (msgs.length) {
          for (const m of msgs) addMessage(m);
        }
        setConnected(true);
      } catch {
        setConnected(false);
      }
    }, 2500);
  }

  function startRealtime() {
    stopRealtime();

    // Try SSE first
    try {
      es = new EventSource("/api/stream", { withCredentials: true });
      es.addEventListener("open", () => setConnected(true));
      es.addEventListener("error", () => {
        setConnected(false);
        try { es.close(); } catch {}
        es = null;
        startPollingFallback();
      });
      es.addEventListener("message", (ev) => {
        try {
          const m = JSON.parse(ev.data);
          addMessage(m);
        } catch {}
      });
      // safety fallback: if SSE doesn't open quickly, poll
      setTimeout(() => {
        if (!es) return;
        // if not connected yet, start polling too
        if (!statusEl.classList.contains("connected")) startPollingFallback();
      }, 2000);
    } catch {
      startPollingFallback();
    }
  }

  async function ensureSignedIn() {
    try {
      const me = await api("/api/me", { method: "GET" });
      who.textContent = `You are: ${me.username}`;
      btnLogout.hidden = false;
      showAuth(false);
      setAuthError("");
      await loadInitial();
      startRealtime();
      return true;
    } catch {
      who.textContent = "Not signed in";
      btnLogout.hidden = true;
      showAuth(true);
      stopRealtime();
      return false;
    }
  }

  authSubmit.addEventListener("click", async () => {
    const username = authUser.value.trim();
    const password = authPass.value;
    setAuthError("");

    try {
      if (mode === "login") {
        await api("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
      } else {
        await api("/api/register", { method: "POST", body: JSON.stringify({ username, password }) });
      }
      await ensureSignedIn();
    } catch (e) {
      setAuthError(e.message || "Request failed");
    }
  });

  authPass.addEventListener("keydown", (e) => {
    if (e.key === "Enter") authSubmit.click();
  });
  authUser.addEventListener("keydown", (e) => {
    if (e.key === "Enter") authPass.focus();
  });

  btnLogout.addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST", body: "{}" }); } catch {}
    await ensureSignedIn();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = text.value.trim();
    if (!msg) return;
    text.value = "";
    try {
      await api("/api/messages", { method: "POST", body: JSON.stringify({ text: msg }) });
      // message will appear via SSE/poll; but in case of latency, fetch quickly
      setTimeout(() => startPollingFallback(), 0);
    } catch (e) {
      // if auth expired, prompt sign in
      await ensureSignedIn();
    }
  });

  // boot
  setMode("login");
  ensureSignedIn();
})();
