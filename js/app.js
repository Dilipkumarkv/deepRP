import { Client } from "https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js";
import { resolveTheme, nextTheme } from "./theme.js";
import {
  loadChats,
  saveChats,
  activeChat,
  createChat,
  selectChat,
  deleteChat,
  renameChat,
  addChatMessage,
  clearChatMessages,
  setChatMemory,
  buildSystemPrompt,
  buildMessagePayload,
  buildSummaryRequest,
  exportBackup,
  importBackup,
} from "./chats.js";

/* ---------- DOM refs ---------- */

const $ = (id) => document.getElementById(id);

const els = {
  badge: $("status-badge"),
  statusText: $("status-text"),
  chat: $("chat"),
  input: $("message-input"),
  send: $("send-btn"),
  themeToggle: $("theme-toggle"),
  settingsBtn: $("settings-btn"),
  backdrop: $("settings-backdrop"),
  panel: $("settings-panel"),
  settingsClose: $("settings-close"),
  settingsCancel: $("settings-cancel"),
  settingsSave: $("settings-save"),
  tokenInput: $("token-input"),
  tokenToggle: $("token-toggle"),
  eyeOpen: $("eye-open"),
  eyeClosed: $("eye-closed"),
  spaceInput: $("space-input"),
  personaInput: $("persona-input"),
  contextInput: $("context-input"),
  worldNotesInput: $("world-notes-input"),
  chatMemoryInput: $("chat-memory-input"),
  summarizeBtn: $("summarize-btn"),
  clearChatBtn: $("clear-chat-btn"),
  chatsBtn: $("chats-btn"),
  chatsBackdrop: $("chats-backdrop"),
  chatsPanel: $("chats-panel"),
  chatsClose: $("chats-close"),
  chatList: $("chat-list"),
  newChatBtn: $("new-chat-btn"),
  exportBtn: $("export-btn"),
  importBtn: $("import-btn"),
  importFile: $("import-file"),
};

/* ---------- constants ---------- */

const LS_KEYS = {
  token: "stheno_hf_token",
  space: "stheno_space",
  persona: "stheno_persona",
  contextCount: "stheno_context_count",
  worldNotes: "stheno_world_notes",
  theme: "stheno_theme",
};

const DEFAULT_SPACE = "deepstrike87/RPO";
const ENDPOINT = "/chat_response";
// ZeroGPU cold start alone takes 15-25s; allow generous headroom for queuing
const REQUEST_TIMEOUT_MS = 180_000;

const DEFAULT_PERSONA = [
  "You are Stheno, a vivid, immersive roleplay companion.",
  "",
  "Roleplay rules:",
  "- Stay fully in character at all times.",
  "- Write in second person, present tense, with rich sensory detail.",
  "- Advance the scene with dialogue and action; never narrate or decide the user's actions or words.",
  "- Keep replies to 2-4 short paragraphs unless the user asks for more.",
  "- Use plain prose; asterisks for actions only if the user uses them.",
  "",
  "The user's first message sets the scenario.",
].join("\n");

/* ---------- state ---------- */

const settings = {
  token: localStorage.getItem(LS_KEYS.token) || "",
  space: localStorage.getItem(LS_KEYS.space) || DEFAULT_SPACE,
  persona: localStorage.getItem(LS_KEYS.persona) || DEFAULT_PERSONA,
  contextCount: Number(localStorage.getItem(LS_KEYS.contextCount) ?? 20),
  worldNotes: localStorage.getItem(LS_KEYS.worldNotes) || "",
};

const chatState = loadChats();
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
let theme = resolveTheme(localStorage.getItem(LS_KEYS.theme), themeMedia.matches);
let client = null; // keep one Gradio Client alive across turns instead of reconnecting
let connectedSpace = null;
let generating = false;
let typingEl = null;
let typingLabel = null;
let typingTimer = null;

function applyTheme() {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]').content = dark ? "#171416" : "#ffffff";
  els.themeToggle.setAttribute("aria-pressed", String(dark));
  els.themeToggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  els.themeToggle.title = dark ? "Switch to light mode" : "Switch to dark mode";
}

els.themeToggle.addEventListener("click", () => {
  theme = nextTheme(theme);
  localStorage.setItem(LS_KEYS.theme, theme);
  applyTheme();
});

themeMedia.addEventListener("change", (event) => {
  if (localStorage.getItem(LS_KEYS.theme)) return;
  theme = resolveTheme(null, event.matches);
  applyTheme();
});

/* ---------- status ---------- */

function setStatus(state, text) {
  els.badge.dataset.state = state;
  els.statusText.textContent = text;
}

/* ---------- chat rendering ---------- */

function scrollToBottom() {
  requestAnimationFrame(() => {
    els.chat.scrollTop = els.chat.scrollHeight;
  });
}

function renderMessage(role, text, { error = false } = {}) {
  const el = document.createElement("div");
  el.className = `msg msg-${role}${error ? " error" : ""}`;
  el.textContent = text;
  els.chat.appendChild(el);
  scrollToBottom();
  return el;
}

function addSystemMessage(text, error = false) {
  return renderMessage("system", text, { error });
}

function renderActiveChat() {
  els.chat.innerHTML = "";
  const chat = activeChat(chatState);
  if (!chat) {
    addSystemMessage(settings.token
      ? `Connected to ${settings.space} — say hi to begin!`
      : "Welcome! Open Settings (⚙) to add your Hugging Face token and character prompt.");
  } else if (!chat.messages.length) {
    addSystemMessage("New chat — set the scene with your first message.");
  } else {
    for (const m of chat.messages) renderMessage(m.role, m.text);
  }
  scrollToBottom();
}

function storeMessage(chat, role, text) {
  addChatMessage(chatState, chat, role, text);
  refreshChatList();
}

function showTyping() {
  typingEl = document.createElement("div");
  typingEl.className = "msg msg-bot msg-loading";
  typingLabel = document.createElement("span");
  typingLabel.className = "loading-label";
  typingLabel.textContent = "Acquiring GPU & generating…";
  const dots = document.createElement("span");
  dots.className = "loading-dots";
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("span"));
  typingEl.append(typingLabel, dots);
  els.chat.appendChild(typingEl);
  const started = Date.now();
  typingTimer = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    typingLabel.textContent = `Acquiring GPU & generating… · ${s}s`;
  }, 1000);
  scrollToBottom();
}

function hideTyping() {
  if (typingTimer) clearInterval(typingTimer);
  typingTimer = null;
  if (typingEl) typingEl.remove();
  typingEl = null;
  typingLabel = null;
}

/* ---------- gradio client ---------- */

async function ensureClient() {
  if (!settings.token) return null;
  if (client && connectedSpace === settings.space) return client;
  setStatus("connecting", "Connecting…");
  try {
    const c = await Client.connect(settings.space, {
      token: settings.token,
      hf_token: settings.token, // alias kept for older @gradio/client builds
    });
    client = c;
    connectedSpace = settings.space;
    setStatus("ready", "Ready");
    return c;
  } catch (err) {
    client = null;
    connectedSpace = null;
    throw err;
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describeError(err) {
  const raw = String(err?.message || err || "Unknown error");
  const msg = raw.toLowerCase();
  if (/401|403|unauthorized|invalid credentials|permission|not allowed|could not resolve/.test(msg)) {
    return "Authentication failed — the Space rejected the token. Open Settings (⚙) and check your HF token has “Read” access to this Space.";
  }
  if (/404|not found|does not exist/.test(msg)) {
    return `Could not find the Space “${settings.space}”. Check the Space ID in Settings (⚙).`;
  }
  if (/timed out|timeout/i.test(msg)) {
    return "The request timed out. ZeroGPU may be busy or the Space is still waking up — tap Send to retry.";
  }
  if (/gpu|quota|rate|queue/i.test(msg)) {
    return `ZeroGPU error: ${raw}`;
  }
  if (/fetch|network|socket|websocket|connection|offline|abort|econn/i.test(msg)) {
    return "Network error — check your connection and try again.";
  }
  return `Error: ${raw}`;
}

async function predictReply(message, systemPrompt) {
  const c = await ensureClient();
  if (!c) throw new Error("No Hugging Face token set.");
  const result = await withTimeout(
    c.predict(ENDPOINT, [message, systemPrompt]),
    REQUEST_TIMEOUT_MS,
    "Request timed out"
  );
  const reply = Array.isArray(result?.data) ? result.data[0] : null;
  if (typeof reply !== "string" || !reply.trim()) {
    throw new Error("The model returned an empty reply — try again.");
  }
  return reply;
}

/* ---------- sending ---------- */

async function sendMessage() {
  if (generating) return;
  const text = els.input.value.trim();
  if (!text) return;

  if (!settings.token) {
    addSystemMessage("Add your Hugging Face token in Settings (⚙) before chatting.", true);
    return;
  }

  const chat = activeChat(chatState) || createChat(chatState);
  // Payload is built before storing the new message so it isn't duplicated in the transcript
  const payload = buildMessagePayload(chat, text, settings.contextCount);
  const systemPrompt = buildSystemPrompt(settings.persona, settings.worldNotes, chat);

  storeMessage(chat, "user", text);
  renderMessage("user", text);
  els.input.value = "";
  resizeInput();

  generating = true;
  updateSendButton();
  setStatus("generating", "Generating…");
  showTyping();

  try {
    const reply = await predictReply(payload, systemPrompt);
    hideTyping();
    storeMessage(chat, "bot", reply);
    if (chatState.activeId === chat.id) renderMessage("bot", reply);
    setStatus("ready", "Ready");
  } catch (err) {
    hideTyping();
    client = null; // drop the connection so the next send reconnects cleanly
    connectedSpace = null;
    addSystemMessage(describeError(err), true);
    setStatus("disconnected", "Disconnected");
  } finally {
    generating = false;
    updateSendButton();
    els.input.focus();
  }
}

/* ---------- summarize into memory ---------- */

async function summarizeChatMemory() {
  if (generating) return;
  const chat = activeChat(chatState);
  if (!chat || !chat.messages.length) {
    closeSettings();
    addSystemMessage("There are no messages in this chat to summarize yet.", true);
    return;
  }
  if (!settings.token) {
    closeSettings();
    addSystemMessage("Add your Hugging Face token in Settings (⚙) first.", true);
    return;
  }

  generating = true;
  updateSendButton();
  els.summarizeBtn.disabled = true;
  els.summarizeBtn.textContent = "Summarizing…";
  setStatus("generating", "Summarizing…");

  try {
    const [message, system] = buildSummaryRequest(chat);
    const summary = await predictReply(message, system);
    setChatMemory(chatState, chat, summary.trim());
    els.chatMemoryInput.value = chat.memorySummary;
    closeSettings();
    addSystemMessage("Story memory updated for this chat.");
    setStatus("ready", "Ready");
  } catch (err) {
    client = null;
    connectedSpace = null;
    closeSettings();
    addSystemMessage(describeError(err), true);
    setStatus("disconnected", "Disconnected");
  } finally {
    generating = false;
    updateSendButton();
    els.summarizeBtn.disabled = false;
    els.summarizeBtn.textContent = "Summarize story into memory";
  }
}

/* ---------- input handling ---------- */

function resizeInput() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 150)}px`;
  els.input.style.overflowY = els.input.scrollHeight > 150 ? "auto" : "hidden";
}

function updateSendButton() {
  els.send.disabled = generating || !els.input.value.trim();
}

els.input.addEventListener("input", () => {
  resizeInput();
  updateSendButton();
});

els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});

els.send.addEventListener("click", sendMessage);

/* ---------- chats drawer ---------- */

function openChats() {
  refreshChatList();
  els.chatsBackdrop.hidden = false;
  els.chatsPanel.classList.add("open");
  els.chatsPanel.setAttribute("aria-hidden", "false");
}

function closeChats() {
  els.chatsBackdrop.hidden = true;
  els.chatsPanel.classList.remove("open");
  els.chatsPanel.setAttribute("aria-hidden", "true");
}

const ICONS = {
  rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

function refreshChatList() {
  els.chatList.innerHTML = "";
  if (!chatState.chats.length) {
    const empty = document.createElement("p");
    empty.className = "chat-list-empty";
    empty.textContent = "No chats yet — start a new one.";
    els.chatList.appendChild(empty);
    return;
  }
  for (const chat of chatState.chats) {
    const item = document.createElement("div");
    item.className = `chat-item${chat.id === chatState.activeId ? " active" : ""}`;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "chat-item-main";
    const title = document.createElement("span");
    title.className = "chat-item-title";
    title.textContent = chat.title;
    const meta = document.createElement("span");
    meta.className = "chat-item-meta";
    const date = new Date(chat.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    meta.textContent = `${chat.messages.length} messages · ${date}`;
    if (chat.memorySummary.trim()) {
      const dot = document.createElement("span");
      dot.className = "memory-dot";
      dot.title = "Has story memory";
      meta.appendChild(dot);
    }
    main.append(title, meta);
    main.addEventListener("click", () => {
      selectChat(chatState, chat.id);
      renderActiveChat();
      refreshChatList();
      closeChats();
    });

    const actions = document.createElement("div");
    actions.className = "chat-item-actions";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "mini-btn";
    renameBtn.setAttribute("aria-label", "Rename chat");
    renameBtn.innerHTML = ICONS.rename;
    renameBtn.addEventListener("click", () => {
      const name = prompt("Rename chat:", chat.title);
      if (name !== null) {
        renameChat(chatState, chat.id, name);
        refreshChatList();
      }
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "mini-btn danger";
    deleteBtn.setAttribute("aria-label", "Delete chat");
    deleteBtn.innerHTML = ICONS.delete;
    deleteBtn.addEventListener("click", () => {
      if (!confirm(`Delete “${chat.title}” and its messages?`)) return;
      deleteChat(chatState, chat.id);
      renderActiveChat();
      refreshChatList();
    });

    actions.append(renameBtn, deleteBtn);
    item.append(main, actions);
    els.chatList.appendChild(item);
  }
}

els.chatsBtn.addEventListener("click", openChats);
els.chatsClose.addEventListener("click", closeChats);
els.chatsBackdrop.addEventListener("click", closeChats);

els.newChatBtn.addEventListener("click", () => {
  createChat(chatState);
  renderActiveChat();
  refreshChatList();
  closeChats();
  els.input.focus();
});

els.exportBtn.addEventListener("click", () => {
  const blob = new Blob([exportBackup(chatState)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `stheno-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

els.importBtn.addEventListener("click", () => els.importFile.click());

els.importFile.addEventListener("change", async () => {
  const file = els.importFile.files?.[0];
  els.importFile.value = "";
  if (!file) return;
  if (!confirm("Importing replaces all current chats. Continue?")) return;
  try {
    const count = importBackup(chatState, await file.text());
    renderActiveChat();
    refreshChatList();
    closeChats();
    addSystemMessage(`Imported ${count} chat${count === 1 ? "" : "s"}.`);
  } catch (err) {
    closeChats();
    addSystemMessage(`Import failed: ${err.message}`, true);
  }
});

/* ---------- settings drawer ---------- */

function openSettings() {
  syncSettingsForm();
  els.backdrop.hidden = false;
  els.panel.classList.add("open");
  els.panel.setAttribute("aria-hidden", "false");
  els.tokenInput.focus();
}

function closeSettings() {
  els.backdrop.hidden = true;
  els.panel.classList.remove("open");
  els.panel.setAttribute("aria-hidden", "true");
  els.settingsBtn.focus();
}

function syncSettingsForm() {
  els.tokenInput.value = settings.token;
  els.spaceInput.value = settings.space;
  els.personaInput.value = settings.persona;
  els.contextInput.value = settings.contextCount;
  els.worldNotesInput.value = settings.worldNotes;
  els.chatMemoryInput.value = activeChat(chatState)?.memorySummary || "";
}

function applySettings() {
  const tokenChanged = els.tokenInput.value.trim() !== settings.token;
  const spaceChanged = els.spaceInput.value.trim() !== settings.space;

  settings.token = els.tokenInput.value.trim();
  settings.space = els.spaceInput.value.trim() || DEFAULT_SPACE;
  settings.persona = els.personaInput.value;
  settings.contextCount = Math.max(0, Math.min(50, Number(els.contextInput.value) || 0));
  settings.worldNotes = els.worldNotesInput.value;

  localStorage.setItem(LS_KEYS.token, settings.token);
  localStorage.setItem(LS_KEYS.space, settings.space);
  localStorage.setItem(LS_KEYS.persona, settings.persona);
  localStorage.setItem(LS_KEYS.contextCount, String(settings.contextCount));
  localStorage.setItem(LS_KEYS.worldNotes, settings.worldNotes);

  const chat = activeChat(chatState);
  if (chat) setChatMemory(chatState, chat, els.chatMemoryInput.value);

  if (tokenChanged || spaceChanged) {
    client = null;
    connectedSpace = null;
  }

  if (settings.token) {
    ensureClient().catch(() => setStatus("disconnected", "Connection failed"));
  } else {
    setStatus("disconnected", "Token required");
  }
  refreshChatList();
  closeSettings();
}

els.settingsBtn.addEventListener("click", openSettings);
els.settingsClose.addEventListener("click", closeSettings);
els.settingsCancel.addEventListener("click", closeSettings);
els.backdrop.addEventListener("click", closeSettings);
els.settingsSave.addEventListener("click", applySettings);
els.summarizeBtn.addEventListener("click", summarizeChatMemory);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (els.panel.classList.contains("open")) closeSettings();
  if (els.chatsPanel.classList.contains("open")) closeChats();
});

els.tokenToggle.addEventListener("click", () => {
  const show = els.tokenInput.type === "password";
  els.tokenInput.type = show ? "text" : "password";
  els.eyeOpen.hidden = show;
  els.eyeClosed.hidden = !show;
  els.tokenToggle.setAttribute("aria-pressed", String(show));
  els.tokenInput.focus();
});

els.clearChatBtn.addEventListener("click", () => {
  if (generating) return;
  const chat = activeChat(chatState);
  if (!chat) return;
  if (!confirm(`Clear all messages and story memory in “${chat.title}”?`)) return;
  clearChatMessages(chatState, chat);
  els.chatMemoryInput.value = "";
  renderActiveChat();
  refreshChatList();
  closeSettings();
  addSystemMessage("Chat cleared.");
});

/* ---------- init ---------- */

function init() {
  applyTheme();
  syncSettingsForm();
  renderActiveChat();
  refreshChatList();
  updateSendButton();

  if (settings.token) {
    ensureClient().catch(() => setStatus("disconnected", "Connection failed"));
  } else {
    setStatus("disconnected", "Token required");
    if (!chatState.chats.length) openSettings();
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./sw.js")
        .catch((err) => console.warn("Service worker registration failed:", err));
    });
  }
}

init();
