import type { AgentConversationMessage } from "../agent/harness.js";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_MAX_HISTORY_CHARACTERS = 32_000;

export interface ChatSessionStoreOptions {
  ttlMs?: number;
  maxSessions?: number;
  maxMessages?: number;
  maxHistoryCharacters?: number;
  now?: () => number;
}

interface ChatSession {
  messages: AgentConversationMessage[];
  lastAccessedAt: number;
}

export class ChatSessionStore {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly maxMessages: number;
  private readonly maxHistoryCharacters: number;
  private readonly now: () => number;

  public constructor(options: ChatSessionStoreOptions = {}) {
    this.ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, "ttlMs");
    this.maxSessions = positiveInteger(options.maxSessions ?? DEFAULT_MAX_SESSIONS, "maxSessions");
    this.maxMessages = evenMessageLimit(options.maxMessages ?? DEFAULT_MAX_MESSAGES);
    this.maxHistoryCharacters = minimumInteger(options.maxHistoryCharacters ?? DEFAULT_MAX_HISTORY_CHARACTERS, "maxHistoryCharacters", 2);
    this.now = options.now ?? Date.now;
  }

  public getHistory(sessionId: string): readonly AgentConversationMessage[] {
    this.deleteExpired();
    const session = this.sessions.get(sessionId);
    if (session === undefined) return [];
    session.lastAccessedAt = this.now();
    return session.messages.map((message) => ({ ...message }));
  }

  public appendExchange(sessionId: string, userContent: string, assistantContent: string): void {
    const user = requiredText(userContent, "userContent");
    const assistant = requiredText(assistantContent, "assistantContent");
    this.deleteExpired();

    let session = this.sessions.get(sessionId);
    if (session === undefined) {
      this.evictLeastRecentlyUsedIfFull();
      session = { messages: [], lastAccessedAt: this.now() };
      this.sessions.set(sessionId, session);
    }

    session.messages.push({ role: "user", content: user }, { role: "assistant", content: assistant });
    session.lastAccessedAt = this.now();
    this.trimSession(session);
  }

  public delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  public clear(): void {
    this.sessions.clear();
  }

  public get size(): number {
    this.deleteExpired();
    return this.sessions.size;
  }

  private trimSession(session: ChatSession): void {
    while (session.messages.length > this.maxMessages || characterCount(session.messages) > this.maxHistoryCharacters) {
      if (session.messages.length <= 2) {
        const latestUser = session.messages.at(-2);
        const latestAssistant = session.messages.at(-1);
        const userBudget = Math.max(1, Math.floor(this.maxHistoryCharacters / 3));
        const assistantBudget = this.maxHistoryCharacters - userBudget;
        session.messages = [
          ...(latestUser === undefined ? [] : [{ ...latestUser, content: latestUser.content.slice(-userBudget) }]),
          ...(latestAssistant === undefined ? [] : [{ ...latestAssistant, content: latestAssistant.content.slice(-assistantBudget) }]),
        ];
        return;
      }
      session.messages.splice(0, 2);
    }
  }

  private deleteExpired(): void {
    const expirationThreshold = this.now() - this.ttlMs;
    for (const [sessionId, session] of this.sessions) {
      if (session.lastAccessedAt <= expirationThreshold) this.sessions.delete(sessionId);
    }
  }

  private evictLeastRecentlyUsedIfFull(): void {
    if (this.sessions.size < this.maxSessions) return;
    let oldestId: string | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [sessionId, session] of this.sessions) {
      if (session.lastAccessedAt < oldestAccess) {
        oldestAccess = session.lastAccessedAt;
        oldestId = sessionId;
      }
    }
    if (oldestId !== undefined) this.sessions.delete(oldestId);
  }
}

function characterCount(messages: readonly AgentConversationMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function requiredText(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`${name} must not be empty.`);
  return trimmed;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function minimumInteger(value: number, name: string, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}.`);
  return value;
}

function evenMessageLimit(value: number): number {
  const parsed = minimumInteger(value, "maxMessages", 2);
  if (parsed % 2 !== 0) throw new Error("maxMessages must be even so complete user/assistant exchanges are retained.");
  return parsed;
}
