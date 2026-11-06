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
  contextVisualizer: $("context-visualizer"),
  contextCurrent: $("context-current"),
  contextProgress: $("context-progress"),
  tempInput: $("temp-input"),
  toppInput: $("topp-input"),
  maxtokensInput: $("maxtokens-input"),
  promptLibrary: $("prompt-library"),
  promptList: $("prompt-list"),
  promptAddBtn: $("prompt-add-btn"),
};

/* ---------- constants ---------- */

const LS_KEYS = {
  token: "stheno_hf_token",
  space: "stheno_space",
  persona: "stheno_persona",
  contextCount: "stheno_context_count",
  worldNotes: "stheno_world_notes",
  theme: "stheno_theme",
  temperature: "stheno_temperature",
  topP: "stheno_top_p",
  maxTokens: "stheno_max_tokens",
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
  temperature: Number(localStorage.getItem(LS_KEYS.temperature) ?? 0.7),
  topP: Number(localStorage.getItem(LS_KEYS.topP) ?? 0.9),
  maxTokens: Number(localStorage.getItem(LS_KEYS.maxTokens) ?? 512),
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

function renderMessage(role, text, { error = false, actions = false } = {}) {
  const el = document.createElement("div");
  el.className = `msg msg-${role}${error ? " error" : ""}`;
  el.textContent = text;
  if (actions) {
    const actionsEl = document.createElement("div");
    actionsEl.className = "msg-actions";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "mini-btn";
    copyBtn.setAttribute("aria-label", "Copy message");
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 16l4-4m0 0l4 4m-4-4l-4 4"/></svg>';
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(text).then(() => {
        addSystemMessage("Message copied to clipboard.");
      }).catch(() => {
        addSystemMessage("Failed to copy message.", true);
      });
    });
    const regenBtn = document.createElement("button");
    regenBtn.type = "button";
    regenBtn.className = "mini-btn";
    regenBtn.setAttribute("aria-label", "Regenerate response");
    regenBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 14l2-2l4.5 4.5"/></svg>';
    regenBtn.addEventListener("click", () => {
      // Could trigger a regenerate - for now just notify
      addSystemMessage("Regenerate not yet implemented - long-press the bot message.");
    });
    const thumbsUp = document.createElement("button");
    thumbsUp.type = "button";
    thumbsUp.className = "mini-btn thumb-btn";
    thumbsUp.setAttribute("aria-label", "Thumbs up");
    thumbsUp.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08l-1.44 1.44a1.5 1.5 0 0 1-2.12 0L12 14.31a1.5 1.5 0 0 1-2.12 0L2.06 9.35a1.5 1.5 0 0 1 0-2.12l1.44-1.44a1.5 1.5 0 0 1 2.12 0z"/><polyline points="22 2 12 22 2 12"/></svg>';
    thumbsUp.addEventListener("click", () => {
      toggleFeedback(el, "up");
    });
    const thumbsDown = document.createElement("button");
    thumbsDown.type = "button";
    thumbsDown.className = "mini-btn thumb-btn";
    thumbsDown.setAttribute("aria-label", "Thumbs down");
    thumbsDown.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><polyline points="14 8 10 12 6 14"/></svg>';
    thumbsDown.addEventListener("click", () => {
      toggleFeedback(el, "down");
    });
    actionsEl.append(thumbsUp, thumbsDown);
    // Add copy, regen, and delete buttons too
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "mini-btn";
    copyBtn.setAttribute("aria-label", "Copy message");
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 16l4-4m0 0l4 4m-4-4l-4 4"/></svg>';
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(text).then(() => {
        addSystemMessage("Message copied to clipboard.");
      }).catch(() => {
        addSystemMessage("Failed to copy message.", true);
      });
    });
    const regenBtn = document.createElement("button");
    regenBtn.type = "button";
    regenBtn.className = "mini-btn";
    regenBtn.setAttribute("aria-label", "Regenerate response");
    regenBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 14l2-2l4.5 4.5"/></svg>';
    regenBtn.addEventListener("click", () => {
      addSystemMessage("Regenerate not yet implemented.");
    });
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "mini-btn danger";
    deleteBtn.setAttribute("aria-label", "Delete message");
    deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`Delete this "${role === "bot" ? "bot" : "user"} message?"`)) {
        addSystemMessage("Message deletion coming in a future update.");
      }
    });
    actionsEl.append(copyBtn, regenBtn, deleteBtn, thumbsUp, thumbsDown);
    el.appendChild(actionsEl);
  }
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
    for (const m of chat.messages) renderMessage(m.role, m.text, { actions: m.role === "bot" });
  }
  // Show memory summary hint if chat is long and has no summary
  const chat = activeChat(chatState);
  if (chat && chat.messages.length >= 30 && !chat.memorySummary.trim()) {
    const hint = document.createElement("div");
    hint.className = "msg-system";
    hint.textContent = "Tip: This chat has many messages. Use the Summarize button in Settings to create a memory summary.";
    els.chat.appendChild(hint);
  }
  scrollToBottom();
  updateContextVisualizer();
}

function updateContextVisualizer() {
  const chat = activeChat(chatState);
  if (!chat || !settings.token) {
    els.contextVisualizer.hidden = true;
    return;
  }
  els.contextVisualizer.hidden = false;
  // Count recent message characters (same logic as buildMessagePayload)
  const count = Math.max(0, Math.min(50, Number(settings.contextCount) || 0));
  const recent = chat.messages.slice(-count);
  let transcript = recent.map((m) => `${m.role === "user" ? "User" : "Stheno"}: ${m.text}`).join("\n\n");
  let used = transcript.length;
  const total = MAX_TRANSCRIPT_CHARS;
  const percent = Math.round((used / total) * 100);
  els.contextCurrent.textContent = `${used} / ${total} chars (${percent}%)`;
  // Add warning classes
  els.contextVisualizer.classList.remove("warn", "danger");
  if (percent >= 80) {
    els.contextVisualizer.classList.add("warn");
  }
  if (percent >= 95) {
    els.contextVisualizer.classList.add("danger");
  }
}



function toggleFeedback(messageEl, direction) {
  // Find the thumbs up/down buttons in this message element
  const thumbBtns = messageEl.querySelectorAll('.thumb-btn');
  const isUp = direction === 'up';
  
  thumbBtns.forEach((btn) => {
    btn.disabled = true;
    if (isUp) {
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08l-1.44 1.44a1.5 1.5 0 0 1-2.12 0L12 14.31a1.5 1.5 0 0 1-2.12 0L2.06 9.35a1.5 1.5 0 0 1 0-2.12l1.44-1.44a1.5 1.5 0 0 1 2.12 0z"/><polyline points="22 2 12 22 2 12"/></svg>';
      btn.style.color = '#16a34a';
      btn.style.background = 'var(--ok-soft)';
    } else {
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><polyline points="14 8 10 12 6 14"/></svg>';
      btn.style.color = '#ef4444';
      btn.style.background = 'var(--danger-soft)';
    }
  });
  
  // Store feedback in localStorage
  const chat = activeChat(chatState);
  if (chat && settings.token) {
    const feedbackKey = "stheno_feedback_" + chat.id;
    const existing = JSON.parse(localStorage.getItem(feedbackKey) || '{}');
    existing[messageEl.textContent] = direction;
    localStorage.setItem(feedbackKey, JSON.stringify(existing));
  }
  
  // Show temporary feedback
  addSystemMessage('Feedback recorded: ' + (direction === 'up' ? 'up' : 'down'));
  
  // Re-enable after a brief delay
  setTimeout(() => {
    thumbBtns.forEach((btn) => {
      btn.disabled = false;
    });
  }, 1000);
}

function storeMessage(chat, role, text) {
  addChatMessage(chatState, chat, role, text);
  refreshChatList();
  updateContextVisualizer();
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

async function predictReply(message, systemPrompt, temperature, topP, maxTokens) {
  const c = await ensureClient();
  if (!c) throw new Error("No Hugging Face token set.");

  let attempt = 0;
  const maxAttempts = 3;
  const baseDelay = 1000; // 1 second

  while (attempt < maxAttempts) {
    try {
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
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts) {
        throw err; // Re-throw the last error
      }
      // Exponential backoff: 1s, 2s, 4s
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
      // If it's a network error, reset the client connection
      if (/network|fetch|connection|abort/i.test(err.message || err)) {
        client = null;
        connectedSpace = null;
      }
    }
  }
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
  const temperature = settings.temperature;
  const topP = settings.topP;
  const maxTokens = settings.maxTokens;

  storeMessage(chat, "user", text);
  renderMessage("user", text);
  els.input.value = "";
  resizeInput();

  generating = true;
  updateSendButton();
  setStatus("generating", "Generating…");
  showTyping();

  try {
    const reply = await predictReply(payload, systemPrompt, temperature, topP, maxTokens);
    hideTyping();
    storeMessage(chat, "bot", reply);
    if (chatState.activeId === chat.id) renderMessage("bot", reply, { actions: true });
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
  const searchTerm = els.searchInput ? (els.searchInput.value || "").toLowerCase() : "";
  const tagFilter = els.tagFilter ? (els.tagFilter.value || "") : "";
  const filteredChats = tagFilter
    ? filterChatsByTag(chatState, tagFilter)
    : chatState.chats;
  const selectedChats = bulkGetSelected(chatState);
  if (!filteredChats.length) {
    const empty = document.createElement("p");
    empty.className = "chat-list-empty";
    empty.textContent = searchTerm
      ? `No chats match “${els.searchInput?.value || ""}” with tag “${tagFilter || "all"}”.`
      : "No chats yet — start a new one.";
    els.chatList.appendChild(empty);
    return;
  }
  for (const chat of filteredChats) {
    const isSelected = selectedChats.some((c) => c.id === chat.id);
    const item = document.createElement("div");
    item.className = `chat-item${chat.id === chatState.activeId ? " active" : ""}${isSelected ? " selected" : ""}`;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "chat-item-main";
    const title = document.createElement("span");
    title.className = "chat-item-title";
    // Apply strikethrough for selected chats
    if (isSelected) title.style.textDecoration = "line-through";
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
    // Add tag badges
    if (chat.tags && chat.tags.length) {
      const tagsSpan = document.createElement("span");
      tagsSpan.className = "chat-item-tags";
      for (const tag of chat.tags) {
        const tagBtn = document.createElement("span");
        tagBtn.className = "tag-badge";
        tagBtn.textContent = `#${tag}`;
        tagBtn.title = tag;
        tagsSpan.appendChild(tagBtn);
      }
      meta.appendChild(tagsSpan);
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

    // Bulk select toggle for bulk mode
    if (selectedChats.length > 0 || chat._selected) {
      const selectToggle = document.createElement("button");
      selectToggle.type = "button";
      selectToggle.className = "mini-btn";
      selectToggle.setAttribute("aria-label", "Deselect chat");
      selectToggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M33 11l-1 6L18 21l-5-5L14 4l8.58 8.58a5 5 0 0 1-7.07 7.07l-0.07 0.07"/><path d="M5 18h14"/><path d="M13 11l7 7L27 3"/><path d="M11 5l7 7L27 3"/></svg>';
      selectToggle.addEventListener("click", () => {
        bulkDeselectAll(chatState);
        refreshChatList();
      });
      actions.append(selectToggle);
    }

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

    // Bulk operation buttons shown when in bulk mode
    if (selectedChats.length > 0 || chat._selected) {
      const bulkDeleteBtn = document.createElement("button");
      bulkDeleteBtn.type = "button";
      bulkDeleteBtn.className = "mini-btn danger";
      bulkDeleteBtn.setAttribute("aria-label", "Delete selected chats");
      bulkDeleteBtn.textContent = `${selectedChats.length > 1 ? `${selectedChats.length} chats` : "1 chat"} delete`;
      bulkDeleteBtn.addEventListener("click", () => {
        bulkDeleteSelected(chatState);
        renderActiveChat();
        refreshChatList();
      });
      actions.append(bulkDeleteBtn);
    }

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

els.exportCurrentBtn.addEventListener("click", () => {
  const chat = activeChat(chatState);
  if (!chat) {
    addSystemMessage("No active chat to export.", true);
    return;
  }
  const data = exportCurrentChat(chatState);
  if (!data) return;
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `stheno-export-${chat.title || "chat"}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  addSystemMessage(`Exported chat “${chat.title || "untitled"}".`);
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
  els.tempInput.value = settings.temperature;
  els.toppInput.value = settings.topP;
  els.maxtokensInput.value = settings.maxTokens;
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
  settings.temperature = Math.max(0.1, Math.min(2, Number(els.tempInput.value) || 0.7));
  settings.topP = Math.max(0.1, Math.min(1, Number(els.toppInput.value) || 0.9));
  settings.maxTokens = Math.max(1, Math.min(4096, Number(els.maxtokensInput.value) || 512));

  localStorage.setItem(LS_KEYS.token, settings.token);
  updateContextVisualizer();
  localStorage.setItem(LS_KEYS.space, settings.space);
  localStorage.setItem(LS_KEYS.persona, settings.persona);
  localStorage.setItem(LS_KEYS.contextCount, String(settings.contextCount));
  localStorage.setItem(LS_KEYS.temperature, String(settings.temperature));
  localStorage.setItem(LS_KEYS.topP, String(settings.topP));
  localStorage.setItem(LS_KEYS.maxTokens, String(settings.maxTokens));

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
  // Show brief warning when revealing sensitive text
  if (show) {
    const existingWarning = els.tokenToggle.dataset.revealedWarning;
    if (!existingWarning) {
      const warn = document.createElement("span");
      warn.className = "token-warning";
      warn.textContent = " — input revealed (keep screen clean)";
      warn.style.fontSize = "10px";
      warn.style.marginLeft = "6px";
      warn.style.color = "#a81f3c";
      els.tokenToggle.appendChild(warn);
      els.tokenToggle.dataset.revealedWarning = "1";
      // Auto-remove after 3 seconds
      setTimeout(() => {
        if (warn.parentNode) warn.parentNode.removeChild(warn);
        els.tokenToggle.dataset.revealedWarning = "";
      }, 3000);
    }
  }
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
  updateContextVisualizer();
  updateSendButton();

  if (settings.token) {
    ensureClient().catch(() => setStatus("disconnected", "Connection failed"));
  } else {
    setStatus("disconnected", "Token required");
    if (!chatState.chats.length) openSettings();
  }
  // Populate tag filter
  populateTagFilter();
  setupChatSearch();
  if ("serviceWorker" in navigator) {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./sw.js")
        .catch((err) => console.warn("Service worker registration failed:", err));
    });
  }
}



/* ---------- mobile enhancements ---------- */

// Shake to summarize (mobile Easter egg)
let shakeTimeout = null;
let shakeCount = 0;

window.addEventListener('devicemotion', (event) => {
  if (!settings.token || generating) return;
  
  const acceleration = event.accelerationIncludingGravity;
  if (!acceleration) return;
  
  const threshold = 15;
  const currentTime = Date.now();
  
  if (shakeTimeout) {
    if (currentTime - shakeTimeout < 800) {
      shakeCount++;
      if (shakeCount >= 3) {
        shakeCount = 0;
        shakeTimeout = null;
        // Trigger summarize if in settings
        if (els.panel.classList.contains('open')) {
          summarizeChatMemory();
        } else {
          addSystemMessage('Shake detected! Open Settings and tap Summarize to capture memory.');
        }
      }
    } else {
      shakeTimeout = currentTime;
      shakeCount = 1;
    }
  } else {
    shakeTimeout = currentTime;
    shakeCount = 1;
  }
}, { passive: true });

// Improve textarea height adjustment for mobile
function resizeInput() {
  els.input.style.height = 'auto';
  const height = Math.min(els.input.scrollHeight, 200);
  els.input.style.height = height + 'px';
  els.input.style.overflowY = els.input.scrollHeight > 200 ? 'auto' : 'hidden';
}

// Focus management on mobile
els.input.addEventListener('focus', () => {
  // Small delay to ensure keyboard is shown
  setTimeout(() => {
    els.chat.scrollTop = els.chat.scrollHeight;
  }, 100);
});

// Remove default drag on images within the chat
els.chat.addEventListener('dragstart', (e) => {
  const tag = e.target.tagName.toLowerCase();
  if (tag === 'img' || tag === 'svg') {
    e.preventDefault();
  }
});
init();

/* ---------- quick prompt library ---------- */

const LS_KEYS_QUICK_PROMPT = "stheno_quick_prompts";

const quickPrompts = (() => {
  try {
    const raw = localStorage.getItem(LS_KEYS_QUICK_PROMPT);
    const prompts = raw ? JSON.parse(raw) : [];
    return Array.isArray(prompts) ? prompts : [];
  } catch {
    return [];
  }
})();

function saveQuickPrompts() {
  try {
    localStorage.setItem(LS_KEYS_QUICK_PROMPT, JSON.stringify(quickPrompts));
  } catch {
    // storage unavailable — prompts simply won't persist
  }
}

function renderPromptList() {
  els.promptList.innerHTML = "";
  if (!quickPrompts.length) {
    const empty = document.createElement("p");
    empty.className = "chat-list-empty";
    empty.textContent = "No saved prompts yet — add one below.";
    els.promptList.appendChild(empty);
    return;
  }
  for (const prompt of quickPrompts) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "prompt-btn";
    btn.textContent = prompt.length > 30 ? `${prompt.slice(0, 30)}…` : prompt;
    btn.addEventListener("click", () => insertPrompt(prompt));
    els.promptList.appendChild(btn);
  }
}

function insertPrompt(text) {
  els.input.value += text + " ";
  resizeInput();
  updateSendButton();
  els.input.focus();
}

els.promptAddBtn.addEventListener("click", () => {
  const name = prompt("Enter a name for this prompt template:", "");
  if (name === null) return;
  const text = prompt("Enter the prompt text:", "") || "";
  if (text.trim()) {
    quickPrompts.push({ name: name.trim(), text: text.trim() });
    saveQuickPrompts();
    renderPromptList();
  }
});

// Initialize
renderPromptList();


/* ---------- persona presets ---------- */

const LS_KEYS_PERSONA_PRESETS = 'stheno_persona_presets';

const personaPresets = (() => {
  try {
    const raw = localStorage.getItem(LS_KEYS_PERSONA_PRESETS);
    const presets = raw ? JSON.parse(raw) : [];
    return Array.isArray(presets) ? presets : [];
  } catch {
    return [];
  }
})();

function savePersonaPresets() {
  try {
    localStorage.setItem(LS_KEYS_PERSONA_PRESETS, JSON.stringify(personaPresets));
  } catch {
    // storage unavailable — presets simply won't persist
  }
}

function renderPresetList() {
  els.presetList.innerHTML = '';
  if (!personaPresets.length) {
    const empty = document.createElement('p');
    empty.className = 'chat-list-empty';
    empty.textContent = 'No saved presets yet — add one below.';
    els.presetList.appendChild(empty);
    return;
  }
  for (const preset of personaPresets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-btn' + (preset.isActive ? ' active' : '');
    btn.textContent = preset.name.length > 20 ? preset.name.slice(0, 20) + '…' : preset.name;
    btn.addEventListener('click', () => applyPreset(preset.name));
    els.presetList.appendChild(btn);
  }
}

function applyPreset(name) {
  const preset = personaPresets.find((p) => p.name === name);
  if (!preset) return;
  // Set the persona input to the preset's system prompt
  els.personaInput.value = preset.systemPrompt;
  // Update settings
  settings.persona = preset.systemPrompt;
  // Save to localStorage
  localStorage.setItem(LS_KEYS.persona, settings.persona);
  // Close presets and refresh
  closeSettings();
  addSystemMessage('Applied preset: ' + name);
}

els.presetAddBtn.addEventListener('click', () => {
  const name = prompt('Enter a name for this persona preset:', '');
  if (name === null) return;
  const systemPrompt = prompt('Enter the system prompt text:', '') || '';
  if (systemPrompt.trim()) {
    personaPresets.push({ name: name.trim(), systemPrompt: systemPrompt.trim(), isActive: false });
    savePersonaPresets();
    renderPresetList();
  }
});

// Initialize
renderPresetList();
