(() => {
  const socket = io({ transports: ["websocket", "polling"] });

  const chatlog = document.getElementById("chatlog");
  const chatForm = document.getElementById("chatForm");
  const msgInput = document.getElementById("msgInput");
  const statusEl = document.getElementById("status");

  const meNameEl = document.getElementById("meName");
  const changeNameBtn = document.getElementById("changeNameBtn");

  const nameModal = document.getElementById("nameModal");
  const nameForm = document.getElementById("nameForm");
  const nameInput = document.getElementById("nameInput");
  const nameError = document.getElementById("nameError");

  const USERNAME_KEY = "chachchat.username";

  function getUsername() {
    return (localStorage.getItem(USERNAME_KEY) || "").trim();
  }

  function setUsername(name) {
    localStorage.setItem(USERNAME_KEY, name.trim());
    meNameEl.textContent = name.trim();
  }

  function isValidUsername(name) {
    const s = String(name || "").trim();
    if (s.length < 2 || s.length > 24) return false;
    return /^[a-zA-Z0-9 _.-]+$/.test(s);
  }

  function openNameModal(prefill = "") {
    nameError.textContent = "";
    nameInput.value = prefill || getUsername() || "";
    nameModal.classList.add("show");
    nameModal.setAttribute("aria-hidden", "false");
    setTimeout(() => nameInput.focus(), 0);
  }

  function closeNameModal() {
    nameModal.classList.remove("show");
    nameModal.setAttribute("aria-hidden", "true");
  }

  // Enforce username for everyone
  const existing = getUsername();
  if (existing && isValidUsername(existing)) {
    meNameEl.textContent = existing;
  } else {
    openNameModal("");
  }

  changeNameBtn.addEventListener("click", () => openNameModal(getUsername()));

  nameForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!isValidUsername(name)) {
      nameError.textContent = "Pick 2–24 chars: letters/numbers/space/._-";
      return;
    }
    setUsername(name);
    closeNameModal();
  });

  // Render
  function initials(name) {
    const s = (name || "?").trim();
    const parts = s.split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] || s[0] || "?";
    const b = parts[1]?.[0] || "";
    return (a + b).toUpperCase();
  }

  function formatTime(ts) {
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function addMsgToUI(msg) {
    const row = document.createElement("div");
    row.className = "msg";

    const av = document.createElement("div");
    av.className = "avatar";
    av.textContent = initials(msg.user);

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const meta = document.createElement("div");
    meta.className = "meta";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = msg.user;

    const time = document.createElement("div");
    time.className = "time";
    time.textContent = formatTime(msg.ts);

    const text = document.createElement("div");
    text.className = "text";
    text.textContent = msg.text;

    meta.appendChild(name);
    meta.appendChild(time);
    bubble.appendChild(meta);
    bubble.appendChild(text);

    row.appendChild(av);
    row.appendChild(bubble);
    chatlog.appendChild(row);

    // autoscroll if user is near bottom
    const nearBottom = (chatlog.scrollTop + chatlog.clientHeight) >= (chatlog.scrollHeight - 120);
    if (nearBottom) chatlog.scrollTop = chatlog.scrollHeight;
  }

  function clearChat() {
    chatlog.innerHTML = "";
  }

  // Socket status
  socket.on("connect", () => {
    statusEl.textContent = "Connected ✅";
  });
  socket.on("disconnect", () => {
    statusEl.textContent = "Disconnected… trying to reconnect";
  });
  socket.io.on("reconnect_attempt", () => {
    statusEl.textContent = "Reconnecting…";
  });

  // Receive history + new messages (auto-refresh)
  socket.on("history", (msgs) => {
    clearChat();
    (msgs || []).forEach(addMsgToUI);
    statusEl.textContent = "Connected ✅";
  });

  socket.on("chat:new", (msg) => {
    addMsgToUI(msg);
  });

  // Send
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const user = getUsername();
    if (!user || !isValidUsername(user)) {
      openNameModal(user || "");
      return;
    }

    const text = msgInput.value.trim();
    if (!text) return;

    // Optimistic clear (server will broadcast back)
    msgInput.value = "";

    socket.emit("chat:send", { user, text }, (resp) => {
      if (!resp?.ok) {
        statusEl.textContent = resp?.error || "Send failed";
      } else {
        statusEl.textContent = "Connected ✅";
      }
    });
  });

})();