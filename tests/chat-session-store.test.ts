import { describe, expect, it } from "vitest";

import { ChatSessionStore } from "../src/chat/session-store.js";

describe("ChatSessionStore", () => {
  it("keeps complete recent exchanges within the message limit", () => {
    const store = new ChatSessionStore({ maxMessages: 4 });
    store.appendExchange("session", "question one", "answer one");
    store.appendExchange("session", "question two", "answer two");
    store.appendExchange("session", "question three", "answer three");

    expect(store.getHistory("session")).toEqual([
      { role: "user", content: "question two" },
      { role: "assistant", content: "answer two" },
      { role: "user", content: "question three" },
      { role: "assistant", content: "answer three" },
    ]);
  });

  it("expires inactive sessions", () => {
    let now = 1_000;
    const store = new ChatSessionStore({ ttlMs: 100, now: () => now });
    store.appendExchange("session", "question", "answer");
    now = 1_099;
    expect(store.getHistory("session")).toHaveLength(2);
    now = 1_200;
    expect(store.getHistory("session")).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("evicts the least recently used session at capacity", () => {
    let now = 1;
    const store = new ChatSessionStore({ maxSessions: 2, now: () => now });
    store.appendExchange("old", "question", "answer");
    now += 1;
    store.appendExchange("recent", "question", "answer");
    now += 1;
    store.getHistory("old");
    now += 1;
    store.appendExchange("new", "question", "answer");

    expect(store.getHistory("recent")).toEqual([]);
    expect(store.getHistory("old")).toHaveLength(2);
    expect(store.getHistory("new")).toHaveLength(2);
  });

  it("trims oversized history without exposing mutable internal messages", () => {
    const store = new ChatSessionStore({ maxHistoryCharacters: 12 });
    store.appendExchange("session", "123456789", "abcdefghijklmnop");
    const history = store.getHistory("session");
    expect(history.map((message) => message.content).join("")).toHaveLength(12);
    const first = history[0];
    if (first === undefined) throw new Error("Expected stored history.");
    (first as { content: string }).content = "changed";
    expect(store.getHistory("session")[0]?.content).not.toBe("changed");
  });

  it("requires an even message limit", () => {
    expect(() => new ChatSessionStore({ maxMessages: 3 })).toThrow("must be even");
  });
});
