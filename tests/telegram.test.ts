import { describe, expect, it } from "vitest";

import {
  DartsOrakelRequestError,
  DartsOrakelStructureChangedError,
  InsufficientMatchDataError,
  ModusHistoryUnavailableError,
  PlayerAmbiguousError,
  PlayerNotFoundError,
} from "../src/errors.js";
import type { LogContext, Logger } from "../src/logger.js";
import type { Match, MatchResult } from "../src/schemas/match.js";
import type { Update, UserFromGetMe } from "grammy/types";
import { isOwnerPrivateChat, parseAllowedUserId } from "../src/telegram/authorization.js";
import {
  createBot,
  handleStatsText,
  readBotConfiguration,
  TELEGRAM_BOT_RELEASE,
  type StatsMessageResponder,
} from "../src/telegram/bot.js";
import { formatPlayerStats, TELEGRAM_MAX_TEXT_LENGTH } from "../src/telegram/formatter.js";
import { parseStatsQuery, statsQueryUsage } from "../src/telegram/query.js";
import {
  DartsPlayerStatsService,
  type PlayerMatchesReader,
  type PlayerStatsReader,
  type PlayerStatsResult,
} from "../src/telegram/stats-service.js";

class MemoryLogger implements Logger {
  public readonly entries: Array<{ level: string; message: string; context?: LogContext }> = [];

  public debug(message: string, context?: LogContext): void { this.add("debug", message, context); }
  public info(message: string, context?: LogContext): void { this.add("info", message, context); }
  public warn(message: string, context?: LogContext): void { this.add("warn", message, context); }
  public error(message: string, context?: LogContext): void { this.add("error", message, context); }

  private add(level: string, message: string, context?: LogContext): void {
    this.entries.push(context === undefined ? { level, message } : { level, message, context });
  }
}

class MemoryResponder implements StatsMessageResponder {
  public readonly replies: string[] = [];
  public readonly edits: Array<{ messageId: number; text: string }> = [];

  public async reply(text: string): Promise<{ readonly messageId: number }> {
    this.replies.push(text);
    return { messageId: this.replies.length };
  }

  public async edit(messageId: number, text: string): Promise<void> {
    this.edits.push({ messageId, text });
  }
}

function match(average: number | null, opponent = "Opponent", date = "2026-08-01"): Match {
  return {
    date,
    tournament: "Example Open",
    round: "Last 16",
    result: "Won",
    opponent,
    score: "6 V 3",
    average,
  };
}

function result(overrides: Partial<PlayerStatsResult> = {}): PlayerStatsResult {
  return {
    playerName: "Rob Cross",
    requestedCount: 2,
    matches: [match(95.5, "Luke Littler"), match(null, "Michael van Gerwen", "2026-07-31")],
    meanAverage: 95.5,
    availableAverageCount: 1,
    sourceUrl: "https://dartsorakel.com/player/details/1/rob-cross",
    sourceLabel: "DartsOrakel",
    provider: "dartsorakel",
    evidenceUrls: [],
    ...overrides,
  };
}

describe("Telegram owner authorization", () => {
  it("accepts only the configured owner in that owner's private chat", () => {
    expect(isOwnerPrivateChat(123, "private", 123)).toBe(true);
    expect(isOwnerPrivateChat(999, "private", 123)).toBe(false);
    expect(isOwnerPrivateChat(123, "supergroup", 123)).toBe(false);
    expect(isOwnerPrivateChat(undefined, undefined, 123)).toBe(false);
  });

  it("rejects malformed or unsafe IDs", () => {
    expect(parseAllowedUserId("123456789")).toBe(123456789);
    expect(() => parseAllowedUserId(undefined)).toThrow("ALLOWED_USER_ID");
    expect(() => parseAllowedUserId("-1")).toThrow("positive numeric");
    expect(() => parseAllowedUserId("12.5")).toThrow("positive numeric");
    expect(() => parseAllowedUserId("9007199254740992")).toThrow("safe integer");
  });

  it("validates both required bot settings", () => {
    const validToken = "123456:abcdefghijklmnopqrstuvwxyz_123456";
    expect(readBotConfiguration({ BOT_TOKEN: validToken, ALLOWED_USER_ID: "123" })).toEqual({
      token: validToken,
      allowedUserId: 123,
    });
    expect(() => readBotConfiguration({ ALLOWED_USER_ID: "123" })).toThrow("BOT_TOKEN");
    expect(() => readBotConfiguration({ BOT_TOKEN: "bad token", ALLOWED_USER_ID: "123" })).toThrow("BOT_TOKEN");
  });
});

describe("Telegram query parser", () => {
  it("parses the small documented command grammar", () => {
    expect(parseStatsQuery("  Rob   Cross LAST 10 match averages!  ")).toEqual({
      playerName: "Rob Cross",
      matchCount: 10,
      source: "auto",
    });
    expect(parseStatsQuery("Luke Littler last 1 matches average")).toEqual({
      playerName: "Luke Littler",
      matchCount: 1,
      source: "auto",
    });
  });

  it("infers statistics from natural last-match wording and accepts explicit providers", () => {
    expect(parseStatsQuery("Dylan Slevin last 10 match")).toEqual({
      playerName: "Dylan Slevin",
      matchCount: 10,
      source: "auto",
    });
    expect(parseStatsQuery("Show me Dylan Slevin's last 10 matches from MODUS")).toEqual({
      playerName: "Dylan Slevin",
      matchCount: 10,
      source: "modus",
    });
    expect(parseStatsQuery("Darts Orakel: what are Dylan Slevin's latest 5 match stats?")).toEqual({
      playerName: "Dylan Slevin",
      matchCount: 5,
      source: "dartsorakel",
    });
  });

  it.each([
    "Robert Thornton last 10 matches 180s from DartsOrakel",
    "Robert Thornton last 10 matches checkout percentage from DartsOrakel",
    "Robert Thornton last 10 matches with averages, 180s and checkout percentage from DartsOrakel",
    "DartsOrakel: show me Robert Thornton's latest 10 match stats",
  ])("accepts explicit DartsOrakel match-metric wording: %s", (request: string) => {
    expect(parseStatsQuery(request)).toEqual({
      playerName: "Robert Thornton",
      matchCount: 10,
      source: "dartsorakel",
    });
  });

  it.each([
    "Dylan Slevin last 10 match averages from modus",
    "Dylan Slevin last 10 matches from modus",
    "Dylan Slevin last 10 matches from MODUS",
  ])("accepts the exact failed Telegram request: %s", (request: string) => {
    expect(parseStatsQuery(request)).toEqual({
      playerName: "Dylan Slevin",
      matchCount: 10,
      source: "modus",
    });
  });

  it.each([
    "Andy Baetens",
    "Arne Spee",
    "Dylan Slevin",
    "Jose de Sousa",
    "Killian Heffernan",
    "Paul Krohne",
  ])("accepts the current official MODUS player %s", (playerName: string) => {
    expect(parseStatsQuery(`${playerName} last 10 matches from MODUS`)).toEqual({
      playerName,
      matchCount: 10,
      source: "modus",
    });
  });

  it("rejects out-of-range and unrelated input", () => {
    expect(parseStatsQuery("Rob Cross last 0 match averages")).toBeNull();
    expect(parseStatsQuery("Rob Cross last 21 match averages")).toBeNull();
    expect(parseStatsQuery("Rob Cross last 10 matches goals")).toBeNull();
    expect(parseStatsQuery("show Rob Cross statistics")).toBeNull();
    expect(parseStatsQuery(`${"x".repeat(81)} last 10 match averages`)).toBeNull();
    expect(statsQueryUsage()).toContain("1-20");
  });
});

describe("Telegram statistics service and formatting", () => {
  it("uses only available averages and preserves source evidence", async () => {
    const matchesReader: PlayerMatchesReader = {
      getLastMatches: async (playerName: string, limit: number): Promise<MatchResult> => ({
        player: { id: 7, name: playerName, slug: "rob-cross" },
        matches: [match(90), match(null), match(96)],
      }),
    };

    const stats = await new DartsPlayerStatsService(matchesReader).getPlayerStats("Rob Cross", 3);
    expect(stats.meanAverage).toBe(93);
    expect(stats.availableAverageCount).toBe(2);
    expect(stats.requestedCount).toBe(3);
    expect(stats.sourceUrl).toBe("https://dartsorakel.com/player/details/7/rob-cross");
    expect(stats.provider).toBe("dartsorakel");
  });

  it("formats transparent missing-data and denominator evidence", () => {
    const message = formatPlayerStats(result());
    expect(message).toContain("🎯 Rob Cross\n2 latest completed matches\n📍 DartsOrakel");
    expect(message).toContain("1. ✅ WIN vs Luke Littler (6–3)\n   1 Aug 2026  │  Avg 95.50");
    expect(message).toContain("2. ✅ WIN vs Michael van Gerwen (6–3)\n   31 Jul 2026  │  Avg —");
    expect(message).toContain("📊 SUMMARY");
    expect(message).toContain("Form: 2W · 0L · 0D");
    expect(message).toContain("Average: 95.50  │  Best: 95.50");
    expect(message).toContain("Coverage: Avg 1/2 · 180s 0/2 · Checkout 0/2");
    expect(message).toContain("ℹ️ Unavailable source values are shown as —.");
    expect(message).toContain("🔗 Source: https://dartsorakel.com/player/details/1/rob-cross");
  });

  it("formats 180 totals and weighted checkout evidence", () => {
    const enrichedMatches: Match[] = [
      { ...match(95.5, "Luke Littler"), oneEighties: 2, checkoutPercentage: 50, checkoutHits: 3, checkoutAttempts: 6 },
      { ...match(90.5, "Michael van Gerwen", "2026-07-31"), oneEighties: 1, checkoutPercentage: 50, checkoutHits: 2, checkoutAttempts: 4 },
    ];
    const message = formatPlayerStats(result({
      matches: enrichedMatches,
      meanAverage: 93,
      availableAverageCount: 2,
    }));

    expect(message).toContain("Avg 95.50  │  180s 2  │  Checkout 50.00%");
    expect(message).toContain("180s: 3 total");
    expect(message).toContain("Checkout: 50.00% · 5/10 converted");
    expect(message).toContain("Coverage: Avg 2/2 · 180s 2/2 · Checkout 2/2");
  });

  it("shows an official proof URL for every MODUS row", () => {
    const message = formatPlayerStats(result({
      provider: "modus-official",
      sourceLabel: "Official MODUS Super Series",
      sourceUrl: "https://modussuperseries.com/results.php",
      evidenceUrls: [
        "https://modussuperseries.com/match-db-stats.php?match_id=19003",
        "https://modussuperseries.com/match-db-stats.php?match_id=18819",
      ],
    }));
    expect(message.match(/Proof: https:\/\/modussuperseries\.com\/match-db-stats\.php\?match_id=/gu)).toHaveLength(2);
    expect(message).toContain("📍 Official MODUS Super Series");
    expect(message).toContain("1 Aug 2026  │  Average 95.50");
  });

  it("keeps a worst-case permitted response inside Telegram's limit", () => {
    const matches = Array.from({ length: 20 }, (_, index: number): Match =>
      match(100 + index / 10, "x".repeat(500), `2026-07-${String(index + 1).padStart(2, "0")}`));
    const message = formatPlayerStats(result({
      playerName: "p".repeat(500),
      requestedCount: 20,
      matches,
      meanAverage: 100.95,
      availableAverageCount: 20,
      sourceUrl: `https://example.com/${"s".repeat(500)}`,
    }));
    expect(message.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT_LENGTH);
  });

  it("keeps a 20-row MODUS response with proof links inside Telegram's limit", () => {
    const matches = Array.from({ length: 20 }, (_, index: number): Match =>
      match(100 + index / 10, "x".repeat(500), `2026-07-${String(index + 1).padStart(2, "0")}`));
    const message = formatPlayerStats(result({
      playerName: "p".repeat(500),
      requestedCount: 20,
      matches,
      meanAverage: 100.95,
      availableAverageCount: 20,
      provider: "modus-official",
      sourceLabel: "Official MODUS Super Series",
      sourceUrl: "https://modussuperseries.com/results.php",
      evidenceUrls: Array.from(
        { length: 20 },
        (_, index: number): string => `https://modussuperseries.com/match-db-stats.php?match_id=${19_000 + index}`,
      ),
    }));
    expect(message.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT_LENGTH);
    expect(message.match(/↗ Proof:/gu)).toHaveLength(20);
  });
});

describe("Telegram request handler", () => {
  it("silently blocks outsiders before API or scraper work and serves the owner end to end", async () => {
    const apiMethods: string[] = [];
    const apiFetch: typeof fetch = async (input: string | URL | Request): Promise<Response> => {
      const method = new URL(String(input)).pathname.split("/").at(-1) ?? "unknown";
      apiMethods.push(method);
      return Response.json({
        ok: true,
        result: {
          message_id: apiMethods.length,
          date: 0,
          chat: { id: 123, type: "private" },
          text: "test response",
        },
      });
    };
    let serviceCalls = 0;
    const service: PlayerStatsReader = {
      getPlayerStats: async (): Promise<PlayerStatsResult> => {
        serviceCalls += 1;
        return result();
      },
    };
    const botInfo: UserFromGetMe = {
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
    const bot = createBot({
      token: "123456:abcdefghijklmnopqrstuvwxyz_123456",
      allowedUserId: 123,
      statsService: service,
      logger: new MemoryLogger(),
      apiFetch,
      botInfo,
    });
    const outsiderUpdate: Update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        from: { id: 999, is_bot: false, first_name: "Outsider" },
        chat: { id: 999, type: "private", first_name: "Outsider" },
        text: "Rob Cross last 2 match averages",
      },
    };
    const ownerUpdate: Update = {
      update_id: 2,
      message: {
        message_id: 2,
        date: 0,
        from: { id: 123, is_bot: false, first_name: "Owner" },
        chat: { id: 123, type: "private", first_name: "Owner" },
        text: "Rob Cross last 2 match averages",
      },
    };

    await bot.handleUpdate(outsiderUpdate);
    expect(apiMethods).toEqual([]);
    expect(serviceCalls).toBe(0);

    await bot.handleUpdate(ownerUpdate);
    expect(apiMethods).toEqual(["sendMessage", "editMessageText"]);
    expect(serviceCalls).toBe(1);
  });

  it("returns usage without calling the scraper for invalid input", async () => {
    let callCount = 0;
    const service: PlayerStatsReader = {
      getPlayerStats: async (): Promise<PlayerStatsResult> => {
        callCount += 1;
        return result();
      },
    };
    const responder = new MemoryResponder();
    const outcome = await handleStatsText("nonsense", service, responder, new MemoryLogger(), 1);

    expect(outcome).toBe("invalid-query");
    expect(callCount).toBe(0);
    expect(responder.replies).toHaveLength(1);
    expect(responder.replies[0]).toContain("Dylan Slevin last 10 match");
    expect(responder.replies[0]).toContain(`Release: ${TELEGRAM_BOT_RELEASE}`);
  });

  it("passes an explicit source override to the statistics router", async () => {
    const calls: Array<{ playerName: string; matchCount: number; source: string | undefined }> = [];
    const service: PlayerStatsReader = {
      getPlayerStats: async (playerName, matchCount, source): Promise<PlayerStatsResult> => {
        calls.push({ playerName, matchCount, source });
        return result({ playerName, requestedCount: matchCount });
      },
    };

    await handleStatsText(
      "Dylan Slevin last 10 matches from MODUS",
      service,
      new MemoryResponder(),
      new MemoryLogger(),
      2,
    );

    expect(calls).toEqual([{ playerName: "Dylan Slevin", matchCount: 10, source: "modus" }]);
  });

  it("replaces the status message with a successful result", async () => {
    const service: PlayerStatsReader = {
      getPlayerStats: async (): Promise<PlayerStatsResult> => result(),
    };
    const responder = new MemoryResponder();
    const logger = new MemoryLogger();
    const outcome = await handleStatsText(
      "Rob Cross last 2 match averages",
      service,
      responder,
      logger,
      42,
    );

    expect(outcome).toBe("success");
    expect(responder.replies).toEqual(["Looking up completed matches…"]);
    expect(responder.edits[0]?.messageId).toBe(1);
    expect(responder.edits[0]?.text).toContain("Rob Cross");
    expect(logger.entries[0]?.context).toMatchObject({ updateId: 42, requestedCount: 2, returnedCount: 2 });
  });

  it("delivers per-match 180 and checkout values through the Telegram handler", async () => {
    const service: PlayerStatsReader = {
      getPlayerStats: async (): Promise<PlayerStatsResult> => result({
        matches: [
          {
            ...match(95.5, "Luke Littler"),
            oneEighties: 2,
            checkoutPercentage: 50,
            checkoutHits: 3,
            checkoutAttempts: 6,
          },
          {
            ...match(90.5, "Michael van Gerwen", "2026-07-31"),
            oneEighties: 1,
            checkoutPercentage: 50,
            checkoutHits: 2,
            checkoutAttempts: 4,
          },
        ],
        meanAverage: 93,
        availableAverageCount: 2,
      }),
    };
    const responder = new MemoryResponder();

    const outcome = await handleStatsText(
      "Robert Thornton last 2 matches with 180s and checkout percentage from DartsOrakel",
      service,
      responder,
      new MemoryLogger(),
      44,
    );

    expect(outcome).toBe("success");
    expect(responder.edits[0]?.text).toContain("Avg 95.50  │  180s 2  │  Checkout 50.00%");
    expect(responder.edits[0]?.text).toContain("180s: 3 total");
    expect(responder.edits[0]?.text).toContain("Checkout: 50.00% · 5/10 converted");
  });

  it("falls back to a new message if Telegram cannot edit the status", async () => {
    const replies: string[] = [];
    const responder: StatsMessageResponder = {
      reply: async (text: string): Promise<{ readonly messageId: number }> => {
        replies.push(text);
        return { messageId: replies.length };
      },
      edit: async (): Promise<void> => { throw new Error("edit failed"); },
    };
    const service: PlayerStatsReader = {
      getPlayerStats: async (): Promise<PlayerStatsResult> => result(),
    };

    const outcome = await handleStatsText(
      "Rob Cross last 2 match averages",
      service,
      responder,
      new MemoryLogger(),
      43,
    );

    expect(outcome).toBe("success");
    expect(replies).toHaveLength(2);
    expect(replies[1]).toContain("Average: 95.50  │  Best: 95.50");
  });

  it("propagates complete Telegram delivery failure so the webhook can retry", async () => {
    let replyCount = 0;
    const responder: StatsMessageResponder = {
      reply: async (): Promise<{ readonly messageId: number }> => {
        replyCount += 1;
        if (replyCount > 1) throw new Error("send failed");
        return { messageId: 1 };
      },
      edit: async (): Promise<void> => { throw new Error("edit failed"); },
    };
    const service: PlayerStatsReader = {
      getPlayerStats: async (): Promise<PlayerStatsResult> => result(),
    };

    await expect(handleStatsText(
      "Rob Cross last 2 match averages",
      service,
      responder,
      new MemoryLogger(),
      44,
    )).rejects.toThrow("Telegram final response delivery failed");
  });

  it.each([
    [new PlayerNotFoundError("private input"), "player-not-found", "Player not found"],
    [new PlayerAmbiguousError("private input", ["one", "two"]), "player-ambiguous", "ambiguous"],
    [new InsufficientMatchDataError(10, 0), "no-matches", "No completed matches"],
    [new DartsOrakelRequestError("private upstream detail", { url: "https://secret", retryable: true }), "upstream-timeout", "timed out"],
    [new DartsOrakelRequestError("private upstream detail", { url: "https://secret", status: 503, retryable: true }), "upstream-unavailable", "temporarily unavailable"],
    [new DartsOrakelStructureChangedError("private HTML detail"), "upstream-unavailable", "temporarily unavailable"],
    [new ModusHistoryUnavailableError("private MODUS detail"), "upstream-unavailable", "official MODUS"],
    [new Error("private stack detail"), "internal-error", "unexpectedly"],
  ] as const)("maps failures to safe public responses", async (failure, expectedOutcome, expectedText) => {
    const service: PlayerStatsReader = {
      getPlayerStats: async (): Promise<PlayerStatsResult> => { throw failure; },
    };
    const responder = new MemoryResponder();
    const logger = new MemoryLogger();
    const outcome = await handleStatsText(
      "Rob Cross last 10 match averages",
      service,
      responder,
      logger,
      9,
    );

    expect(outcome).toBe(expectedOutcome);
    expect(responder.edits[0]?.text).toContain(expectedText);
    const serialized = JSON.stringify({ replies: responder.replies, edits: responder.edits, logs: logger.entries });
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("https://secret");
  });
});
