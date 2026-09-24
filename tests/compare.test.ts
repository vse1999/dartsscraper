import { describe, expect, it } from "vitest";

import type { Match } from "../src/schemas/match.js";
import { formatCompareMessages } from "../src/telegram/compare-formatter.js";
import { handleCompareCommand, type CompareMessageResponder } from "../src/telegram/compare-command.js";
import { parseCompareCommand } from "../src/telegram/compare-query.js";
import type { PlayerStatsReader, PlayerStatsResult } from "../src/telegram/stats-service.js";
import type { LogContext, Logger } from "../src/logger.js";
import { createBot } from "../src/telegram/bot.js";
import type { Update, UserFromGetMe } from "grammy/types";

class TestLogger implements Logger {
  public readonly entries: Array<{ readonly level: string; readonly message: string; readonly context?: LogContext }> = [];

  public debug(message: string, context?: LogContext): void { this.entries.push({ level: "debug", message, ...(context === undefined ? {} : { context }) }); }
  public info(message: string, context?: LogContext): void { this.entries.push({ level: "info", message, ...(context === undefined ? {} : { context }) }); }
  public warn(message: string, context?: LogContext): void { this.entries.push({ level: "warn", message, ...(context === undefined ? {} : { context }) }); }
  public error(message: string, context?: LogContext): void { this.entries.push({ level: "error", message, ...(context === undefined ? {} : { context }) }); }
}

class TestResponder implements CompareMessageResponder {
  public readonly replies: string[] = [];
  public readonly edits: Array<{ readonly messageId: number; readonly text: string }> = [];

  public async reply(text: string): Promise<{ readonly messageId: number }> {
    this.replies.push(text);
    return { messageId: this.replies.length };
  }

  public async edit(messageId: number, text: string): Promise<void> {
    this.edits.push({ messageId, text });
  }
}

function match(average: number | null, opponent: string, date: string, oneEighties = 2): Match {
  return {
    date,
    tournament: "Example Open",
    round: "Last 16",
    result: "Won",
    opponent,
    score: "6 V 3",
    average,
    oneEighties,
    checkoutPercentage: 50,
    checkoutHits: 3,
    checkoutAttempts: 6,
  };
}

function result(playerName: string, requestedCount = 2): PlayerStatsResult {
  const matches = [
    match(95, "Luke Littler", "2026-08-02"),
    match(90, "Michael van Gerwen", "2026-08-01", 0),
  ];
  return {
    playerName,
    requestedCount,
    matches,
    meanAverage: 92.5,
    availableAverageCount: 2,
    sourceUrl: `https://dartsorakel.com/player/details/1/${playerName.toLocaleLowerCase("en-US").replace(/\s+/gu, "-")}`,
    sourceLabel: "DartsOrakel",
    provider: "dartsorakel",
    evidenceUrls: [],
  };
}

describe("compare command parsing", () => {
  it("parses the default and explicit history counts", () => {
    expect(parseCompareCommand("/compare Rob Cross, Luke Littler")).toEqual({
      playerNames: ["Rob Cross", "Luke Littler"],
      matchCount: 10,
    });
    expect(parseCompareCommand("/compare Rob Cross, Luke Littler last 20")).toEqual({
      playerNames: ["Rob Cross", "Luke Littler"],
      matchCount: 20,
    });
  });

  it("rejects malformed, duplicate, and unsupported requests", () => {
    expect(parseCompareCommand("/compare Rob Cross")).toBeNull();
    expect(parseCompareCommand("/compare Rob Cross, Luke Littler last 11")).toBeNull();
    expect(parseCompareCommand("/compare Rob Cross, Rob Cross")).toBeNull();
    expect(parseCompareCommand("/compare A, B, C")).toBeNull();
    expect(parseCompareCommand("Rob Cross, Luke Littler")).toBeNull();
  });
});

describe("compare command execution", () => {
  it("fetches both players from DartsOrakel and sends comparison evidence", async () => {
    const calls: Array<{ readonly name: string; readonly count: number; readonly source: string | undefined }> = [];
    const service: PlayerStatsReader = {
      getPlayerStats: async (playerName: string, matchCount: number, source: "auto" | "modus" | "dartsorakel"): Promise<PlayerStatsResult> => {
        calls.push({ name: playerName, count: matchCount, source });
        return result(playerName, matchCount);
      },
    };
    const responder = new TestResponder();
    const outcome = await handleCompareCommand("/compare Rob Cross, Luke Littler last 2", service, responder, new TestLogger(), 10);

    expect(outcome).toBe("invalid");
    expect(calls).toHaveLength(0);
  });

  it("uses an allowed count and explicit DartsOrakel source", async () => {
    const calls: Array<{ readonly name: string; readonly count: number; readonly source: string | undefined }> = [];
    const service: PlayerStatsReader = {
      getPlayerStats: async (playerName: string, matchCount: number, source: "auto" | "modus" | "dartsorakel"): Promise<PlayerStatsResult> => {
        calls.push({ name: playerName, count: matchCount, source });
        return result(playerName, matchCount);
      },
    };
    const responder = new TestResponder();
    const outcome = await handleCompareCommand("/compare Rob Cross, Luke Littler last 20", service, responder, new TestLogger(), 11);

    expect(outcome).toBe("success");
    expect(calls).toEqual([
      { name: "Rob Cross", count: 20, source: "dartsorakel" },
      { name: "Luke Littler", count: 20, source: "dartsorakel" },
    ]);
    expect(responder.edits[0]?.text).toContain("PLAYER COMPARISON");
    expect(responder.replies.some((message: string): boolean => message.includes("evidence"))).toBe(true);
  });

  it("preserves one successful player when the other fails", async () => {
    const service: PlayerStatsReader = {
      getPlayerStats: async (playerName: string): Promise<PlayerStatsResult> => {
        if (playerName === "Missing Player") throw new Error("source detail");
        return result(playerName);
      },
    };
    const responder = new TestResponder();
    const outcome = await handleCompareCommand("/compare Rob Cross, Missing Player", service, responder, new TestLogger(), 12);

    expect(outcome).toBe("partial");
    expect(responder.edits[0]?.text).toContain("Missing Player");
    expect(responder.edits[0]?.text).toContain("statistics lookup failed");
  });

  it("retains timeout and unstarted states when research exceeds its deadline", async () => {
    const service: PlayerStatsReader = {
      getPlayerStats: async (): Promise<PlayerStatsResult> => new Promise<PlayerStatsResult>(() => undefined),
    };
    const responder = new TestResponder();
    const outcome = await handleCompareCommand(
      "/compare Rob Cross, Luke Littler",
      service,
      responder,
      new TestLogger(),
      13,
      undefined,
      { totalMs: 50, researchMs: 10 },
    );

    expect(outcome).toBe("failed");
    expect(responder.edits[0]?.text).toContain("timed out");
    expect(responder.edits[0]?.text).toContain("skipped because the research deadline");
  });

  it("can schedule background work without losing a rejection", async () => {
    const service: PlayerStatsReader = {
      getPlayerStats: async (playerName: string, matchCount: number): Promise<PlayerStatsResult> => result(playerName, matchCount),
    };
    const responder = new TestResponder();
    const scheduled: Promise<void>[] = [];
    const outcome = await handleCompareCommand(
      "/compare Rob Cross, Luke Littler",
      service,
      responder,
      new TestLogger(),
      14,
      (task: Promise<void>): void => { scheduled.push(task); },
    );

    expect(outcome).toBe("started");
    expect(scheduled).toHaveLength(1);
    await scheduled[0];
    expect(responder.edits[0]?.text).toContain("PLAYER COMPARISON");
  });
});

describe("comparison formatter", () => {
  it("keeps long evidence pages within Telegram's message limit", () => {
    const report = {
      requestedCount: 20 as const,
      players: [
        { requestedName: "A", result: result("A", 20), failureCode: null, failureMessage: "" },
        { requestedName: "B", result: result("B", 20), failureCode: null, failureMessage: "" },
      ],
      analysis: null,
      generatedAt: "2026-09-24T12:00:00.000Z",
    } as const;
    const messages = formatCompareMessages(report);
    expect(messages.length).toBeGreaterThan(2);
    expect(messages.every((message: string): boolean => message.length <= 4_096)).toBe(true);
  });
});

describe("Telegram compare routing", () => {
  it("keeps the compare command owner-only and avoids service work for outsiders", async () => {
    const apiMethods: string[] = [];
    const apiFetch: typeof fetch = async (input: string | URL | Request): Promise<Response> => {
      const method = new URL(String(input)).pathname.split("/").at(-1) ?? "unknown";
      apiMethods.push(method);
      return Response.json({
        ok: true,
        result: method === "answerCallbackQuery"
          ? true
          : { message_id: apiMethods.length, date: 0, chat: { id: 123, type: "private" }, text: "ok" },
      });
    };
    let calls = 0;
    const service: PlayerStatsReader = {
      getPlayerStats: async (playerName: string, matchCount: number): Promise<PlayerStatsResult> => {
        calls += 1;
        return result(playerName, matchCount);
      },
    };
    const botInfo: UserFromGetMe = {
      id: 999,
      is_bot: true,
      first_name: "Test",
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
    const bot = createBot({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      allowedUserId: 123,
      statsService: service,
      logger: new TestLogger(),
      apiFetch,
      botInfo,
    });
    const outsider: Update = {
      update_id: 20,
      message: {
        message_id: 1,
        date: 0,
        from: { id: 456, is_bot: false, first_name: "Outsider" },
        chat: { id: 456, type: "private", first_name: "Outsider" },
        text: "/compare Rob Cross, Luke Littler",
        entities: [{ type: "bot_command", offset: 0, length: 8 }],
      },
    };
    const owner: Update = {
      update_id: 21,
      message: {
        message_id: 2,
        date: 0,
        from: { id: 123, is_bot: false, first_name: "Owner" },
        chat: { id: 123, type: "private", first_name: "Owner" },
        text: "/compare Rob Cross, Luke Littler",
        entities: [{ type: "bot_command", offset: 0, length: 8 }],
      },
    };

    await bot.handleUpdate(outsider);
    expect(calls).toBe(0);
    expect(apiMethods).toEqual([]);
    await bot.handleUpdate(owner);
    expect(calls).toBe(2);
    expect(apiMethods).toEqual(["sendMessage", "editMessageText", "sendMessage", "sendMessage"]);
  });
});
