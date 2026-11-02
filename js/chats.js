const CHATS_KEY = "stheno_chats_v1";
const LEGACY_MESSAGES_KEY = "stheno_messages";

const MAX_MESSAGES_PER_CHAT = 200;
const MAX_CHATS = 50;
const MAX_TRANSCRIPT_CHARS = 12000;

function save(state) {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(state));
  } catch {
    // storage unavailable — chats simply won't persist
  }
}

function sanitizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "bot") && typeof m.text === "string")
    .slice(-MAX_MESSAGES_PER_CHAT)
    .map((m) => ({ role: m.role, text: m.text, ts: m.ts || Date.now() }));
}

function sanitizeChat(chat) {
  return {
    id: typeof chat.id === "string" && chat.id ? chat.id : crypto.randomUUID(),
    title: typeof chat.title === "string" && chat.title.trim() ? chat.title : "New chat",
    createdAt: chat.createdAt || Date.now(),
    updatedAt: chat.updatedAt || Date.now(),
    memorySummary: typeof chat.memorySummary === "string" ? chat.memorySummary : "",
    messages: sanitizeMessages(chat.messages),
  };
}

function migrateLegacy() {
  const state = { version: 1, activeId: null, chats: [] };
  try {
    const raw = localStorage.getItem(LEGACY_MESSAGES_KEY);
    const legacy = raw ? JSON.parse(raw) : [];
    if (Array.isArray(legacy) && legacy.length) {
      const chat = sanitizeChat({ id: crypto.randomUUID(), title: "First chat", messages: legacy });
      state.chats.push(chat);
      state.activeId = chat.id;
    }
    localStorage.removeItem(LEGACY_MESSAGES_KEY);
  } catch {
    // corrupt legacy data is simply not migrated
  }
  save(state);
  return state;
}

export function loadChats() {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    if (raw) {
      const state = JSON.parse(raw);
      if (state && Array.isArray(state.chats)) {
        state.chats = state.chats.filter((c) => c && Array.isArray(c.messages)).map(sanitizeChat);
        if (!state.chats.some((c) => c.id === state.activeId)) {
          state.activeId = state.chats[0]?.id ?? null;
        }
        return state;
      }
    }
  } catch {
    // fall through to a fresh state
  }
  return migrateLegacy();
}

export function saveChats(state) {
  save(state);
}

export function activeChat(state) {
  return state.chats.find((c) => c.id === state.activeId) || null;
}

function touch(state, chat) {
  chat.updatedAt = Date.now();
  state.chats = [chat, ...state.chats.filter((c) => c.id !== chat.id)];
}

export function createChat(state) {
  const chat = sanitizeChat({ id: crypto.randomUUID(), title: "New chat", messages: [] });
  state.chats.unshift(chat);
  state.activeId = chat.id;
  if (state.chats.length > MAX_CHATS) state.chats.length = MAX_CHATS;
  save(state);
  return chat;
}

export function selectChat(state, id) {
  if (state.chats.some((c) => c.id === id)) {
    state.activeId = id;
    save(state);
  }
}

export function deleteChat(state, id) {
  state.chats = state.chats.filter((c) => c.id !== id);
  if (state.activeId === id) state.activeId = state.chats[0]?.id ?? null;
  save(state);
}

export function renameChat(state, id, title) {
  const chat = state.chats.find((c) => c.id === id);
  if (chat && title.trim()) {
    chat.title = title.trim().slice(0, 80);
    save(state);
  }
}

export function addChatMessage(state, chat, role, text) {
  if (!state.chats.includes(chat)) return;
  chat.messages.push({ role, text, ts: Date.now() });
  if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
    chat.messages = chat.messages.slice(-MAX_MESSAGES_PER_CHAT);
  }
  if (role === "user" && chat.title === "New chat" && !chat.messages.some((m, i) => m.role === "user" && i < chat.messages.length - 1)) {
    chat.title = text.length > 42 ? `${text.slice(0, 42)}…` : text;
  }
  touch(state, chat);
  save(state);
}

export function clearChatMessages(state, chat) {
  if (!state.chats.includes(chat)) return;
  chat.messages = [];
  chat.memorySummary = "";
  touch(state, chat);
  save(state);
}

export function setChatMemory(state, chat, summary) {
  if (!state.chats.includes(chat)) return;
  chat.memorySummary = summary;
  save(state);
}

export function buildSystemPrompt(persona, worldNotes, chat) {
  const parts = [];
  if (persona?.trim()) parts.push(persona.trim());
  if (worldNotes?.trim()) parts.push(`World notes (always true):\n${worldNotes.trim()}`);
  if (chat?.memorySummary?.trim()) {
    parts.push(`Story memory (summary of earlier events):\n${chat.memorySummary.trim()}`);
  }
  return parts.join("\n\n");
}

export function buildMessagePayload(chat, text, contextCount = 20) {
  const count = Math.max(0, Math.min(50, Number(contextCount) || 0));
  if (!count || !chat) return text;
  const recent = chat.messages.slice(-count);
  if (!recent.length) return text;
  let transcript = recent.map((m) => `${m.role === "user" ? "User" : "Stheno"}: ${m.text}`).join("\n\n");
  while (transcript.length > MAX_TRANSCRIPT_CHARS && recent.length > 1) {
    recent.shift();
    transcript = recent.map((m) => `${m.role === "user" ? "User" : "Stheno"}: ${m.text}`).join("\n\n");
  }
  return `Previous messages (context):\n${transcript}\n\nNew message:\n${text}`;
}

export function buildSummaryRequest(chat) {
  const system = [
    "You are a memory keeper for an ongoing roleplay.",
    "Write compact, factual memory notes (max 200 words) capturing: characters and their traits,",
    "relationships, key events so far, the current scene and open plot threads, and any user preferences.",
    "Plain text only, no preamble or headings.",
  ].join(" ");
  const transcript = chat.messages
    .map((m) => `${m.role === "user" ? "User" : "Stheno"}: ${m.text}`)
    .join("\n\n")
    .slice(-MAX_TRANSCRIPT_CHARS * 2);
  const previous = chat.memorySummary?.trim()
    ? `Previous memory notes to update:\n${chat.memorySummary.trim()}\n\n`
    : "";
  return [`${previous}Update the memory notes using this conversation:\n\n${transcript}`, system];
}

export function exportBackup(state) {
  return JSON.stringify(
    { app: "stheno-rp", version: 1, exportedAt: new Date().toISOString(), chats: state.chats },
    null,
    2
  );
}

export function importBackup(state, jsonText) {
  const data = JSON.parse(jsonText);
  const chats = Array.isArray(data) ? data : data?.chats;
  if (!Array.isArray(chats)) throw new Error("Not a valid Stheno backup file.");
  const seen = new Set();
  const cleaned = chats.filter((c) => c && Array.isArray(c.messages)).map((c) => {
    const chat = sanitizeChat(c);
    if (seen.has(chat.id)) chat.id = crypto.randomUUID();
    seen.add(chat.id);
    return chat;
  });
  state.chats = cleaned;
  state.activeId = cleaned[0]?.id ?? null;
  save(state);
  return cleaned.length;
}
