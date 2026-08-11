"use strict";

const STORAGE_KEY = "darts-chat-state-v1";
const MAX_STORED_MESSAGES = 20;
const MAX_STORED_CHARACTERS = 40_000;

const elements = {
  form: document.querySelector("#chat-form"),
  input: document.querySelector("#message-input"),
  send: document.querySelector("#send-button"),
  stop: document.querySelector("#stop-button"),
  clear: document.querySelector("#clear-button"),
  messages: document.querySelector("#messages"),
  welcome: document.querySelector("#welcome"),
  template: document.querySelector("#message-template"),
  statusBadge: document.querySelector("#status-badge"),
  statusLabel: document.querySelector("#status-label"),
  modelName: document.querySelector("#model-name"),
};

let state = loadState();
let isReady = false;
let isSending = false;
let activeController;

restoreTranscript();
bindEvents();
void refreshHealth();
window.setInterval(() => void refreshHealth(), 30_000);

function bindEvents() {
  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage(elements.input.value);
  });
  elements.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.form.requestSubmit();
    }
  });
  elements.input.addEventListener("input", resizeInput);
  elements.stop.addEventListener("click", () => activeController?.abort());
  elements.clear.addEventListener("click", () => void clearConversation());
  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      const prompt = button.getAttribute("data-prompt");
      if (prompt !== null) void sendMessage(prompt);
    });
  });
}

async function refreshHealth() {
  setStatus("checking", "Checking Ollama");
  try {
    const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
    const payload = await readJsonObject(response);
    const model = readString(payload, "model");
    if (model !== undefined) elements.modelName.textContent = prettyModelName(model);
    const status = readString(payload, "status");
    const message = readString(payload, "message") ?? "Ollama is unavailable.";
    const fastPathReady = payload.fastPathReady === true;
    const ollamaReady = response.ok && status === "ready";
    isReady = ollamaReady || fastPathReady;
    const label = ollamaReady ? "Ollama ready" : fastPathReady ? "Stats ready" : message;
    const title = ollamaReady ? message : fastPathReady ? `Instant stats are ready. Open-ended answers need Ollama. ${message}` : message;
    setStatus(isReady ? "ready" : "error", label, title);
  } catch {
    isReady = false;
    setStatus("error", "Ollama offline", "The local chatbot server could not reach Ollama.");
  }
  updateControls();
}

async function sendMessage(rawMessage) {
  const message = rawMessage.trim();
  if (message === "" || isSending) return;
  if (!isReady) {
    appendMessage("error", "Ollama or Gemma 4 is not ready. Check the status in the top-right corner, then try again.");
    return;
  }

  isSending = true;
  activeController = new AbortController();
  elements.welcome?.remove();
  elements.input.value = "";
  resizeInput();
  appendMessage("user", message);
  state.messages.push({ role: "user", content: message });
  saveState();
  const thinking = appendThinkingMessage();
  updateControls();
  const requestStartedAt = performance.now();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, message }),
      signal: activeController.signal,
    });
    const payload = await readJsonObject(response);
    if (!response.ok) throw new Error(readString(payload, "error") ?? `Chat request failed with HTTP ${response.status}.`);
    const answer = readString(payload, "answer");
    if (answer === undefined || answer.trim() === "") throw new Error("The model returned an empty answer.");
    thinking.remove();
    const executionMode = readString(payload, "executionMode");
    const label = executionMode === "fast-path" ? "Verified stats · Direct source" : "Gemma 4 · Research agent";
    const browserLatencyMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
    appendMessage("assistant", answer, formatMetrics(payload, browserLatencyMs), label);
    state.messages.push({ role: "assistant", content: answer });
    saveState();
  } catch (error) {
    thinking.remove();
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    const messageText = cancelled ? "Generation stopped. You can edit your question or ask something else." : error instanceof Error ? error.message : "The chat request failed.";
    appendMessage("error", messageText);
  } finally {
    isSending = false;
    activeController = undefined;
    updateControls();
    elements.input.focus();
  }
}

async function clearConversation() {
  if (isSending) activeController?.abort();
  const oldSessionId = state.sessionId;
  state = { sessionId: crypto.randomUUID(), messages: [] };
  saveState();
  try {
    await fetch(`/api/sessions/${encodeURIComponent(oldSessionId)}`, { method: "DELETE", headers: { Accept: "application/json" } });
  } catch {
    // The local in-memory session will expire automatically if the server is unavailable.
  }
  window.location.reload();
}

function appendMessage(role, content, meta = "", customLabel = "") {
  const fragment = elements.template.content.cloneNode(true);
  const article = fragment.querySelector(".message");
  const label = fragment.querySelector(".message-label");
  const body = fragment.querySelector(".message-content");
  const metadata = fragment.querySelector(".message-meta");
  article.classList.add(`is-${role}`);
  label.textContent = customLabel !== "" ? customLabel : role === "assistant" ? "Gemma 4 · Research agent" : role === "user" ? "You" : "Local error";
  if (role === "assistant") renderSafeAnswer(body, content);
  else body.textContent = content;
  metadata.textContent = meta;
  elements.messages.append(fragment);
  scrollToBottom();
  return article;
}

function appendThinkingMessage() {
  const article = appendMessage("assistant", "");
  article.classList.add("is-thinking");
  const content = article.querySelector(".message-content");
  content.setAttribute("aria-label", "The research agent is checking available sources");
  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement("span");
    dot.className = "thinking-dot";
    content.append(dot);
  }
  article.querySelector(".message-meta").textContent = "Checking cache, official sources, and tools…";
  return article;
}

function renderSafeAnswer(container, content) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    if (lines[index].trim() === "") {
      index += 1;
      continue;
    }
    if (index + 1 < lines.length && isTableRow(lines[index]) && isTableDivider(lines[index + 1])) {
      const tableLines = [lines[index]];
      index += 2;
      while (index < lines.length && isTableRow(lines[index]) && lines[index].trim() !== "") {
        tableLines.push(lines[index]);
        index += 1;
      }
      container.append(createSafeTable(tableLines));
      continue;
    }
    if (/^\s*[-*]\s+/.test(lines[index])) {
      const list = document.createElement("ul");
      list.className = "answer-list";
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        const item = document.createElement("li");
        appendInlineFormatting(item, lines[index].replace(/^\s*[-*]\s+/, ""));
        list.append(item);
        index += 1;
      }
      container.append(list);
      continue;
    }
    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() !== "" && !(index + 1 < lines.length && isTableRow(lines[index]) && isTableDivider(lines[index + 1])) && !/^\s*[-*]\s+/.test(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    const paragraph = document.createElement("p");
    appendInlineFormatting(paragraph, paragraphLines.join(" "));
    container.append(paragraph);
  }
}

function createSafeTable(lines) {
  const wrapper = document.createElement("div");
  wrapper.className = "answer-table-wrap";
  const table = document.createElement("table");
  table.className = "answer-table";
  const head = document.createElement("thead");
  const body = document.createElement("tbody");
  const rows = lines.map(parseTableCells);
  rows.forEach((cells, rowIndex) => {
    const row = document.createElement("tr");
    cells.forEach((cell) => {
      const element = document.createElement(rowIndex === 0 ? "th" : "td");
      appendInlineFormatting(element, cell);
      row.append(element);
    });
    (rowIndex === 0 ? head : body).append(row);
  });
  table.append(head, body);
  wrapper.append(table);
  return wrapper;
}

function appendInlineFormatting(parent, value) {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) parent.append(document.createTextNode(value.slice(cursor, start)));
    const token = match[0];
    const element = document.createElement(token.startsWith("**") ? "strong" : "em");
    element.textContent = token.startsWith("**") ? token.slice(2, -2) : token.slice(1, -1);
    parent.append(element);
    cursor = start + token.length;
  }
  if (cursor < value.length) parent.append(document.createTextNode(value.slice(cursor)));
}

function isTableRow(line) {
  return line.includes("|") && parseTableCells(line).length >= 2;
}

function isTableDivider(line) {
  const cells = parseTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function parseTableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function restoreTranscript() {
  if (state.messages.length === 0) return;
  elements.welcome?.remove();
  for (const message of state.messages) appendMessage(message.role, message.content);
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!isRecord(parsed) || typeof parsed.sessionId !== "string" || !isUuid(parsed.sessionId) || !Array.isArray(parsed.messages)) throw new Error("Invalid state");
    const messages = parsed.messages.filter(isStoredMessage).slice(-MAX_STORED_MESSAGES);
    if (messages.reduce((total, message) => total + message.content.length, 0) > MAX_STORED_CHARACTERS) throw new Error("Transcript is too large");
    return { sessionId: parsed.sessionId, messages };
  } catch {
    return { sessionId: crypto.randomUUID(), messages: [] };
  }
}

function saveState() {
  while (state.messages.length > MAX_STORED_MESSAGES || state.messages.reduce((total, message) => total + message.content.length, 0) > MAX_STORED_CHARACTERS) {
    state.messages.splice(0, Math.min(2, state.messages.length));
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Chat remains usable when browser storage is disabled or full.
  }
}

function isStoredMessage(value) {
  return isRecord(value) && (value.role === "user" || value.role === "assistant") && typeof value.content === "string" && value.content.trim() !== "";
}

function updateControls() {
  elements.input.disabled = isSending || !isReady;
  elements.send.disabled = isSending || !isReady || elements.input.value.trim() === "";
  elements.stop.hidden = !isSending;
  elements.send.hidden = isSending;
}

function resizeInput() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 150)}px`;
  updateControls();
}

function setStatus(kind, label, title = label) {
  elements.statusBadge.className = `status-badge is-${kind}`;
  elements.statusBadge.title = title;
  elements.statusLabel.textContent = label.length > 28 ? `${label.slice(0, 27)}…` : label;
}

function prettyModelName(model) {
  if (model.toLocaleLowerCase("en-US") === "gemma4:12b") return "Gemma 4 · 12B";
  return model;
}

function formatMetrics(value, browserLatencyMs) {
  if (!isRecord(value)) return "Verified locally";
  const executionMode = readString(value, "executionMode");
  if (executionMode === "fast-path") {
    const latency = typeof value.sourceLatencyMs === "number" ? Math.max(0, Math.round(value.sourceLatencyMs)) : undefined;
    const age = typeof value.dataAgeMs === "number" ? Math.max(0, Math.round(value.dataAgeMs / 1000)) : undefined;
    const stale = value.stale === true ? " · cached refresh running" : "";
    return `direct source${latency === undefined ? "" : ` · ${latency} ms source`}${browserLatencyMs === undefined ? "" : ` · ${browserLatencyMs} ms total`}${age === undefined ? "" : ` · data age ${age}s`}${stale}`;
  }
  const metrics = isRecord(value.metrics) ? value.metrics : value;
  const iterations = typeof metrics.iterations === "number" ? metrics.iterations : undefined;
  const toolCalls = typeof metrics.toolCalls === "number" ? metrics.toolCalls : undefined;
  if (iterations === undefined || toolCalls === undefined) return "Verified locally";
  return `${toolCalls} tool call${toolCalls === 1 ? "" : "s"} · ${iterations} agent step${iterations === 1 ? "" : "s"} · local inference${browserLatencyMs === undefined ? "" : ` · ${browserLatencyMs} ms total`}`;
}

async function readJsonObject(response) {
  const value = await response.json();
  if (!isRecord(value)) throw new Error("The server returned an invalid response.");
  return value;
}

function readString(value, key) {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function scrollToBottom() {
  window.requestAnimationFrame(() => elements.messages.scrollTo({ top: elements.messages.scrollHeight, behavior: "smooth" }));
}
