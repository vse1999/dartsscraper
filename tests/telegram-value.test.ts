import { describe, expect, it, vi } from "vitest";
import type { Update, UserFromGetMe } from "grammy/types";

import type { Logger } from "../src/logger.js";
import type {
  ValueMatchCard,
  ValuePlayerAssessment,
  ValueReader,
  ValueReport,
  ValueSourceCoverage,
  ValueWindowSummary,
} from "../src/value/contracts.js";
import { createBot } from "../src/telegram/bot.js";
import {
  handleValueCommand,
  parseValueCommand,
  type ValueAcknowledgement,
  type ValueCommandResponder,
} from "../src/telegram/value-command.js";
import { formatValueMessages } from "../src/telegram/value-formatter.js";

const logger: Logger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

function coverage(available: number, total: number): ValueSourceCoverage {
  return {
    available,
    total,
    ratio: total === 0 ? 0 : available / total,
    status: available === total ? "available" : available === 0 ? "unavailable" : "partial",
  };
}

function windowSummary(window: 10 | 20, matchCount: number = window): ValueWindowSummary {
  return {
    window,
    requestedMatches: window,
    matchCount,
    average: { value: 92.25, coverage: coverage(matchCount, window) },
    oneEighties: { total: 4, average: 0.4, coverage: coverage(matchCount, window) },
    checkout: {
      hits: 9,
      attempts: 20,
      percentage: 45,
      zeroAttemptMatches: 0,
      coverage: coverage(matchCount, window),
    },
  };
}

function player(name: string, status: ValuePlayerAssessment["status"] = "available"): ValuePlayerAssessment {
  const available = status === "available" || status === "partial";
  return {
    requestedName: name,
    status,
    identity: available ? { id: 1, name, slug: name.toLocaleLowerCase("en-US").replace(/\s+/gu, "-") } : null,
    canonicalName: available ? name : null,
    source: {
      label: available ? "DartsOrakel" : null,
      provider: available ? "dartsorakel" : null,
      sourceUrl: available ? "https://dartsorakel.com/player/details/1/test" : null,
      evidenceUrls: [],
    },
    last10: available ? windowSummary(10) : null,
    last20: available ? windowSummary(20, status === "partial" ? 14 : 20) : null,
    error: available ? null : "identity unresolved",
    context: { stage: null, format: null, status: "unknown" },
  };
}

function card(index: number, firstStatus: ValuePlayerAssessment["status"] = "available"): ValueMatchCard {
  const first = player(`Player ${index} One`, firstStatus);
  const second = player(`Player ${index} Two`);
  const status = firstStatus === "available" ? "complete" : firstStatus === "partial" ? "partial" : firstStatus === "unresolved" ? "unresolved" : "failed";
  return {
    match: {
      eventId: `event-${index}`,
      competition: "World Grand Prix",
      player1: first.requestedName,
      player2: second.requestedName,
      odds1: 1.72,
      odds2: 2.15,
      bookmaker: "TippmixPro",
      scheduledTime: "18:00",
      sourceUrl: "https://www.eredmenyek.com/match/event/",
    },
    players: [first, second],
    player1: first,
    player2: second,
    status,
    context: { stage: null, format: null, status: "unknown" },
  };
}

function report(cards: readonly ValueMatchCard[]): ValueReport {
  return {
    day: "today",
    generatedAt: "2026-09-30T16:00:00.000Z",
    odds: {
      source: "eredmenyek",
      sourceUrl: "https://www.eredmenyek.com/darts/",
      observedAt: "2026-09-30T16:00:00.000Z",
      date: "2026-09-30",
      timeZone: "Europe/Budapest",
      warnings: [],
      matchCount: cards.length,
    },
    cards,
    counts: {
      oddsMatches: cards.length,
      cards: cards.length,
      completeCards: cards.filter((entry): boolean => entry.status === "complete").length,
      partialCards: cards.filter((entry): boolean => entry.status === "partial").length,
      unresolvedCards: cards.filter((entry): boolean => entry.status === "unresolved").length,
      timedOutCards: 0,
      cancelledCards: 0,
      failedCards: 0,
      resolvedPlayers: cards.length * 2,
      unresolvedPlayers: 0,
    },
    status: cards.every((entry): boolean => entry.status === "complete") ? "complete" : "partial",
    warnings: [],
  };
}

function responder(
  replies: string[],
  edits: Array<{ readonly messageId: number; readonly text: string }>,
): ValueCommandResponder {
  return {
    reply: async (text: string): Promise<ValueAcknowledgement> => {
      replies.push(text);
      return { messageId: replies.length };
    },
    edit: async (messageId: number, text: string): Promise<void> => {
      edits.push({ messageId, text });
    },
  };
}

function testBotInfo(): UserFromGetMe {
  return {
    id: 777,
    is_bot: true,
    first_name: "Test Bot",
    username: "test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
}

function valueUpdate(updateId: number, userId: number, chatType: "private" | "group", text: string): Update {
  const chat = chatType === "private"
    ? { id: userId, type: "private" as const, first_name: "Owner" }
    : { id: userId, type: "group" as const, title: "Darts" };
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      from: { id: userId, is_bot: false, first_name: "Owner" },
      chat,
      text,
      entities: [{ offset: 0, length: text.split(/\s/gu)[0]?.length ?? 0, type: "bot_command" }],
    },
  };
}

describe("Telegram value command", () => {
  it("accepts only today/tomorrow and defaults to today", () => {
    expect(parseValueCommand("/value")).toBe("today");
    expect(parseValueCommand("/value today")).toBe("today");
    expect(parseValueCommand("/value@darts_bot tomorrow")).toBe("tomorrow");
    expect(parseValueCommand("/value next-week")).toBeNull();
  });

  it("renders complete, partial and unresolved evidence without recommendations", () => {
    const unresolved = card(3, "unresolved");
    const secretPlayer = { ...unresolved.player1, error: "secret provider HTML and token" };
    const safeUnresolved: ValueMatchCard = { ...unresolved, player1: secretPlayer, players: [secretPlayer, unresolved.player2] };
    const messages = formatValueMessages(report([card(1), card(2, "partial"), safeUnresolved]));
    const text = messages.join("\n");
    expect(text).toContain("schedule/source order preserved");
    expect(text).toContain("weighted");
    expect(text).toContain("unknown");
    expect(text).toContain("Cannot compare");
    expect(text).not.toContain("secret provider HTML");
    expect(text).not.toMatch(/best bet|value alert|recommended/iu);
    expect(messages.every((message): boolean => message.length <= 4_096)).toBe(true);
  });

  it("keeps every source-order card in bounded pages", () => {
    const messages = formatValueMessages(report(Array.from({ length: 30 }, (_value: unknown, index: number): ValueMatchCard => card(index))));
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message): boolean => message.length <= 4_096)).toBe(true);
    expect(messages.join("\n")).toContain("Player 0 One");
    expect(messages.join("\n")).toContain("Player 29 One");
  });

  it("bounds pathological source fields without dropping matchup cards", () => {
    const cards = Array.from({ length: 12 }, (_value: unknown, index: number): ValueMatchCard => {
      const base = card(index);
      const first = {
        ...base.player1,
        requestedName: `Player ${index} One ${"X".repeat(700)}`,
        canonicalName: `Player ${index} One ${"X".repeat(700)}`,
        source: {
          ...base.player1.source,
          sourceUrl: `https://dartsorakel.com/${"s".repeat(700)}`,
          evidenceUrls: [`https://dartsorakel.com/${"e".repeat(700)}`],
        },
      };
      return {
        ...base,
        player1: first,
        players: [first, base.player2],
        match: { ...base.match, player1: first.requestedName },
      };
    });
    const messages = formatValueMessages(report(cards));
    expect(messages.every((message): boolean => message.length <= 4_096)).toBe(true);
    const text = messages.join("\n");
    for (let index = 0; index < cards.length; index += 1) expect(text).toContain(`Player ${index} One`);
  });

  it("does not research when disabled or acknowledgement fails", async () => {
    const research = vi.fn(async (): Promise<ValueReport> => report([card(1)]));
    const replies: string[] = [];
    const edits: Array<{ readonly messageId: number; readonly text: string }> = [];
    await expect(handleValueCommand("/value", undefined, responder(replies, edits), logger)).resolves.toBe("unavailable");
    expect(research).not.toHaveBeenCalled();
    const failing: ValueCommandResponder = { reply: async (): Promise<never> => { throw new Error("Telegram unavailable"); } };
    await expect(handleValueCommand("/value", { getReport: research }, failing, logger)).resolves.toBe("failed");
    expect(research).not.toHaveBeenCalled();
  });

  it("delivers a full report and edits the acknowledgement", async () => {
    const replies: string[] = [];
    const edits: Array<{ readonly messageId: number; readonly text: string }> = [];
    const reader: ValueReader = { getReport: vi.fn(async (): Promise<ValueReport> => report([card(1)])) };
    await expect(handleValueCommand("/value tomorrow", reader, responder(replies, edits), logger)).resolves.toBe("success");
    expect(reader.getReport).toHaveBeenCalledWith("tomorrow", expect.any(AbortSignal));
    expect(edits[0]?.text).toContain("VALUE RESEARCH");
    expect(replies).toHaveLength(1);
  });

  it("logs bounded completion counts after research without chat or payload data", async () => {
    const records: Array<{ readonly message: string; readonly context: Readonly<Record<string, unknown>> | undefined }> = [];
    const completionLogger: Logger = {
      debug: (): void => undefined,
      info: (message: string, context?: Readonly<Record<string, unknown>>): void => { records.push({ message, context }); },
      warn: (): void => undefined,
      error: (): void => undefined,
    };
    const outcome = await handleValueCommand(
      "/value",
      { getReport: async (): Promise<ValueReport> => report([card(1), card(2, "partial")]) },
      responder([], []),
      completionLogger,
    );
    expect(outcome).toBe("partial");
    const completion = records.find((entry): boolean => entry.message === "Value report research completed.");
    expect(completion?.context).toMatchObject({
      command: "value",
      day: "today",
      status: "partial",
      oddsMatches: 2,
      cards: 2,
      completeCards: 1,
      partialCards: 1,
      unresolvedCards: 0,
      timedOutCards: 0,
      cancelledCards: 0,
      failedCards: 0,
      resolvedPlayers: 4,
      unresolvedPlayers: 0,
    });
    const serialized = JSON.stringify(completion?.context);
    expect(serialized).not.toMatch(/chat|token|secret|message/iu);
  });

  it("keeps backend failure details out of Telegram", async () => {
    const replies: string[] = [];
    const edits: Array<{ readonly messageId: number; readonly text: string }> = [];
    const outcome = await handleValueCommand(
      "/value",
      { getReport: async (): Promise<ValueReport> => { throw new Error("private upstream HTML"); } },
      responder(replies, edits),
      logger,
    );
    expect(outcome).toBe("failed");
    expect(edits[0]?.text).toContain("could not be completed");
    expect(edits.map((entry): string => entry.text).join("\n")).not.toContain("private upstream HTML");
  });

  it("does not overwrite a delivered first page when a later page fails", async () => {
    const cards = Array.from({ length: 30 }, (_value: unknown, index: number): ValueMatchCard => card(index));
    const replies: string[] = [];
    const edits: string[] = [];
    const outcome = await handleValueCommand(
      "/value",
      { getReport: async (): Promise<ValueReport> => report(cards) },
      {
        reply: async (text: string): Promise<ValueAcknowledgement> => {
          replies.push(text);
          if (replies.length > 1) throw new Error("uncertain Telegram result");
          return { messageId: 11 };
        },
        edit: async (_messageId: number, text: string): Promise<void> => { edits.push(text); },
      },
      logger,
    );
    expect(outcome).toBe("failed");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("Player 0 One");
    expect(edits[0]).not.toContain("could not be completed");
  });

  it("does not research after scheduler rejection", async () => {
    const research = vi.fn(async (): Promise<ValueReport> => report([card(1)]));
    const replies: string[] = [];
    const edits: Array<{ readonly messageId: number; readonly text: string }> = [];
    const outcome = await handleValueCommand(
      "/value",
      { getReport: research },
      responder(replies, edits),
      logger,
      (): never => { throw new Error("scheduler unavailable"); },
    );
    expect(outcome).toBe("failed");
    expect(research).not.toHaveBeenCalled();
    expect(edits[0]?.text).toContain("could not be scheduled");
  });

  it("aborts an in-flight research call at the research deadline", async () => {
    let aborted = false;
    const reader: ValueReader = {
      getReport: async (_day, signal): Promise<ValueReport> => new Promise<ValueReport>((_resolve, reject): void => {
        signal?.addEventListener("abort", (): void => {
          aborted = true;
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        }, { once: true });
      }),
    };
    const replies: string[] = [];
    const edits: Array<{ readonly messageId: number; readonly text: string }> = [];
    const outcome = await handleValueCommand(
      "/value",
      reader,
      responder(replies, edits),
      logger,
      undefined,
      { totalMs: 200, researchMs: 10 },
    );
    expect(outcome).toBe("failed");
    expect(aborted).toBe(true);
    expect(edits[0]?.text).toContain("timed out");
  });

  it("authorizes value only in the owner private chat", async () => {
    const apiMethods: string[] = [];
    const getReport = vi.fn(async (): Promise<ValueReport> => report([card(1)]));
    const apiFetch: typeof fetch = async (input: string | URL | Request): Promise<Response> => {
      apiMethods.push(new URL(String(input)).pathname.split("/").at(-1) ?? "unknown");
      return Response.json({ ok: true, result: { message_id: apiMethods.length, date: 0, chat: { id: 123, type: "private" }, text: "ok" } });
    };
    const bot = createBot({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      allowedUserId: 123,
      statsService: { getPlayerStats: async (): Promise<never> => { throw new Error("not used"); } },
      valueReader: { getReport },
      logger,
      apiFetch,
      botInfo: testBotInfo(),
    });
    await bot.handleUpdate(valueUpdate(1, 999, "private", "/value"));
    await bot.handleUpdate(valueUpdate(2, 123, "group", "/value"));
    expect(getReport).not.toHaveBeenCalled();
    expect(apiMethods).toEqual([]);
    await bot.handleUpdate(valueUpdate(3, 123, "private", "/value today"));
    expect(getReport).toHaveBeenCalledOnce();
    expect(apiMethods).toEqual(["sendMessage", "editMessageText"]);
  });
});
