const state = {
  markdown: "",
  html: "",
  view: "preview",
};

const els = {
  editor: document.getElementById("editor"),
  previewFrame: document.getElementById("previewFrame"),
  versionsPane: document.getElementById("versionsPane"),
  chatLog: document.getElementById("chatLog"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  applyEdits: document.getElementById("applyEdits"),
  aiStatus: document.getElementById("aiStatus"),
  fileImport: document.getElementById("fileImport"),
  btnSave: document.getElementById("btnSave"),
  btnClearChat: document.getElementById("btnClearChat"),
};

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch (_) {}
    throw new Error(detail);
  }
  const type = res.headers.get("content-type") || "";
  if (type.includes("application/json")) return res.json();
  return res.text();
}

function setPreview(html) {
  state.html = html;
  els.previewFrame.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.title = "CV preview";
  iframe.srcdoc = html;
  els.previewFrame.appendChild(iframe);
}

function setMarkdown(md, html) {
  state.markdown = md;
  els.editor.value = md;
  if (html) setPreview(html);
}

function appendBubble(role, content, metaText) {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  div.textContent = content;
  if (metaText) {
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = metaText;
    div.appendChild(meta);
  }
  els.chatLog.appendChild(div);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function flashStatus(text) {
  const prev = els.aiStatus.textContent;
  const prevState = els.aiStatus.dataset.state;
  els.aiStatus.textContent = text;
  setTimeout(() => {
    els.aiStatus.textContent = prev;
    els.aiStatus.dataset.state = prevState;
  }, 1600);
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  const showVersions = view === "versions";
  els.versionsPane.classList.toggle("hidden", !showVersions);
  els.previewFrame.classList.toggle("hidden", showVersions);
  if (showVersions) loadVersions();
}

async function loadHealth() {
  try {
    const health = await api("/api/health");
    if (health.ai_enabled) {
      els.aiStatus.dataset.state = "on";
      els.aiStatus.textContent = `AI on · ${health.model}`;
    } else {
      els.aiStatus.dataset.state = "off";
      els.aiStatus.textContent = "AI offline · set OPENAI_API_KEY";
    }
  } catch (_) {
    els.aiStatus.dataset.state = "off";
    els.aiStatus.textContent = "API unreachable";
  }
}

async function loadCv() {
  const data = await api("/api/cv");
  setMarkdown(data.markdown, data.html);
}

async function loadChat() {
  els.chatLog.innerHTML = "";
  const data = await api("/api/chat");
  if (!data.messages.length) {
    appendBubble(
      "assistant",
      "Import your draft (Sigurd-Tenfjord-CV-draft.md / .html) or edit the seeded LinkedIn-based draft. Ask me to update bullets, add certs, or tailor for a role."
    );
    return;
  }
  for (const msg of data.messages) {
    const meta = msg.meta?.applied
      ? `applied · v${msg.meta.version_id || "?"}`
      : msg.meta?.provider || "";
    appendBubble(msg.role, msg.content, meta);
  }
}

async function loadVersions() {
  const data = await api("/api/versions");
  els.versionsPane.innerHTML = "";
  if (!data.versions.length) {
    els.versionsPane.innerHTML = "<p class='hint'>No versions yet.</p>";
    return;
  }
  for (const v of data.versions) {
    const card = document.createElement("article");
    card.className = "version-card";
    card.innerHTML = `
      <h3>#${v.id} · ${escapeHtml(v.label)}</h3>
      <p>${escapeHtml(v.created_at)} · ${escapeHtml(v.source)}${v.note ? " · " + escapeHtml(v.note) : ""}</p>
      <div class="row">
        <button type="button" class="btn subtle" data-restore="${v.id}">Restore</button>
        <button type="button" class="btn subtle" data-load="${v.id}">Open in editor</button>
      </div>
    `;
    els.versionsPane.appendChild(card);
  }
}

async function saveCv() {
  const markdown = els.editor.value;
  const data = await api("/api/cv", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown, label: "manual-save", note: "Saved from editor" }),
  });
  setMarkdown(markdown, data.html);
  await loadVersions();
  flashStatus(`Saved v${data.version.id}`);
}

async function sendChat(message) {
  appendBubble("user", message);
  els.chatInput.value = "";
  const data = await api("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      apply: els.applyEdits.checked,
      label: "ai-edit",
    }),
  });
  const meta = [
    data.provider || "assistant",
    data.applied ? `applied v${data.version?.id}` : data.updated_markdown ? "edit ready" : "advice",
  ].join(" · ");
  appendBubble("assistant", data.reply, meta);
  if (data.markdown) setMarkdown(data.markdown, data.html);
  await loadVersions();
  await loadHealth();
}

els.btnSave.addEventListener("click", () => {
  saveCv().catch((err) => alert(err.message));
});

els.btnClearChat.addEventListener("click", () => {
  api("/api/chat", { method: "DELETE" })
    .then(loadChat)
    .catch((err) => alert(err.message));
});

els.chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const message = els.chatInput.value.trim();
  if (!message) return;
  sendChat(message).catch((err) => {
    appendBubble("assistant", `Error: ${err.message}`);
  });
});

document.querySelectorAll(".quick-prompts [data-prompt]").forEach((btn) => {
  btn.addEventListener("click", () => {
    els.chatInput.value = btn.dataset.prompt;
    els.chatInput.focus();
  });
});

document.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

els.fileImport.addEventListener("change", async () => {
  const file = els.fileImport.files?.[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  try {
    const data = await api("/api/import", { method: "POST", body: form });
    setMarkdown(data.markdown, data.html);
    await loadVersions();
    appendBubble("assistant", `Imported ${file.name} as version #${data.version.id}.`);
  } catch (err) {
    alert(err.message);
  } finally {
    els.fileImport.value = "";
  }
});

els.versionsPane.addEventListener("click", async (e) => {
  const restoreId = e.target.closest("[data-restore]")?.dataset.restore;
  const loadId = e.target.closest("[data-load]")?.dataset.load;
  try {
    if (restoreId) {
      const data = await api("/api/versions/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version_id: Number(restoreId) }),
      });
      setMarkdown(data.markdown, data.html);
      await loadVersions();
      flashStatus(`Restored → v${data.version.id}`);
      setView("preview");
    }
    if (loadId) {
      const data = await api(`/api/versions/${loadId}`);
      setMarkdown(data.markdown, data.html || undefined);
      setView("preview");
    }
  } catch (err) {
    alert(err.message);
  }
});

async function boot() {
  await Promise.all([loadHealth(), loadCv(), loadChat(), loadVersions()]);
}

boot().catch((err) => {
  appendBubble("assistant", `Failed to start: ${err.message}`);
});
