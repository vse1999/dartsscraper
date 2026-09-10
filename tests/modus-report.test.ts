import { describe, expect, it, vi } from "vitest";

import { runModusReport } from "../src/daily/modus-report.js";
import type { Logger } from "../src/logger.js";
import type { ModusPlayersResult } from "../src/modus/schemas.js";
import type { PlayerStatsReader, PlayerStatsResult } from "../src/telegram/stats-service.js";
import type { TelegramMessageSender } from "../src/telegram/sender.js";

const silentLogger: Logger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

function modusPlayers(names: readonly string[]): ModusPlayersResult {
  return {
    date: "2026-09-11",
    event: "MODUS Super Series",
    players: names.map((name) => ({ name, source: "https://example.com/modus", confidence: 1 })),
  };
}

function stats(playerName: string, matchCount: number): PlayerStatsResult {
  return {
    playerName,
    requestedCount: matchCount,
    matches: [{
      date: "2026-09-01",
      tournament: "MODUS Super Series",
      round: null,
      result: "Won",
      opponent: "Opponent",
      score: "6 V 3",
      average: 92,
      oneEighties: 1,
      checkoutPercentage: 50,
      checkoutHits: 1,
      checkoutAttempts: 2,
    }],
    meanAverage: 92,
    availableAverageCount: 1,
    sourceUrl: "https://dartsorakel.com/player/details/1/player",
    sourceLabel: "DartsOrakel",
    provider: "dartsorakel",
    evidenceUrls: [],
  };
}

interface Harness {
  readonly getPlayerStats: ReturnType<typeof vi.fn<PlayerStatsReader["getPlayerStats"]>>;
  readonly sendMessage: ReturnType<typeof vi.fn<TelegramMessageSender["sendMessage"]>>;
}

function harness(names: readonly string[]): Harness {
  const getPlayerStats = vi.fn<PlayerStatsReader["getPlayerStats"]>(async (playerName: string, matchCount: number): Promise<PlayerStatsResult> => stats(playerName, matchCount));
  const sendMessage = vi.fn<TelegramMessageSender["sendMessage"]>(async (): Promise<void> => undefined);
  return { getPlayerStats, sendMessage };
}

function options(names: readonly string[], harnessValue: Harness, overrides: { readonly concurrency?: number } = {}) {
  return {
    date: "2026-09-11",
    matchCount: 10,
    chatId: 123,
    concurrency: overrides.concurrency ?? 3,
    dependencies: {
      modusPlayersService: { getModusPlayers: async () => modusPlayers(names) },
      playerStatsService: { getPlayerStats: harnessValue.getPlayerStats },
      telegram: { sendMessage: harnessValue.sendMessage },
      logger: silentLogger,
    },
  } as const;
}

describe("automatic MODUS report", () => {
  it("deduplicates fixture players and sends one formatted card per unique player", async () => {
    const value = harness(["Rob Cross", " rob   cross ", "Luke Littler"]);
    const result = await runModusReport(options(["Rob Cross", " rob   cross ", "Luke Littler"], value));

    expect(result.players).toEqual(["Rob Cross", "Luke Littler"]);
    expect(value.getPlayerStats).toHaveBeenCalledTimes(2);
    expect(value.sendMessage).toHaveBeenCalledTimes(4);
    expect(value.sendMessage.mock.calls.filter(([_, text]) => text.includes("🎯 Rob Cross"))).toHaveLength(1);
    expect(value.sendMessage.mock.calls.filter(([_, text]) => text.includes("🎯 Luke Littler"))).toHaveLength(1);
  });

  it("performs six stat lookups for six players", async () => {
    const value = harness(["A", "B", "C", "D", "E", "F"]);
    const result = await runModusReport(options(["A", "B", "C", "D", "E", "F"], value));

    expect(result.results).toHaveLength(6);
    expect(value.getPlayerStats).toHaveBeenCalledTimes(6);
    expect(value.getPlayerStats.mock.calls.every((call) => call[1] === 10 && call[2] === "dartsorakel")).toBe(true);
  });

  it("continues after one failed player lookup and reports the failed name", async () => {
    const value = harness(["A", "B", "C"]);
    value.getPlayerStats.mockImplementation(async (playerName: string, matchCount: number): Promise<PlayerStatsResult> => {
      if (playerName === "B") throw new Error("upstream unavailable");
      return stats(playerName, matchCount);
    });

    const result = await runModusReport(options(["A", "B", "C"], value));
    const summary = value.sendMessage.mock.calls.at(-1)?.[1] ?? "";

    expect(result.results.map((item) => item.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(value.getPlayerStats).toHaveBeenCalledTimes(3);
    expect(summary).toContain("2/3 succeeded");
    expect(summary).toContain("Failed: B");
  });

  it("continues after one Telegram player delivery failure", async () => {
    const value = harness(["A", "B", "C"]);
    value.sendMessage.mockImplementation(async (_chatId: number | string, text: string): Promise<void> => {
      if (text.startsWith("🎯 B")) throw new Error("Telegram unavailable");
    });

    const result = await runModusReport(options(["A", "B", "C"], value));
    const summary = value.sendMessage.mock.calls.at(-1)?.[1] ?? "";

    expect(result.results.map((item) => item.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(value.getPlayerStats).toHaveBeenCalledTimes(3);
    expect(summary).toContain("2/3 succeeded");
    expect(summary).toContain("Failed: B");
  });

  it("warns and does not fan out when no fixtures are available", async () => {
    const value = harness([]);
    const result = await runModusReport(options([], value));

    expect(result.results).toEqual([]);
    expect(value.getPlayerStats).not.toHaveBeenCalled();
    expect(value.sendMessage).toHaveBeenCalledTimes(3);
    expect(value.sendMessage.mock.calls[1]?.[1]).toContain("No MODUS players");
  });

  it("handles fixture source failure without player fan-out", async () => {
    const value = harness([]);
    const base = options([], value);
    const result = await runModusReport({
      ...base,
      dependencies: {
        ...base.dependencies,
        modusPlayersService: { getModusPlayers: async () => { throw new Error("all sources unavailable"); } },
      },
    });

    expect(result.discoverySucceeded).toBe(false);
    expect(value.getPlayerStats).not.toHaveBeenCalled();
    expect(value.sendMessage.mock.calls[1]?.[1]).toContain("could not be discovered");
  });

  it("never exceeds configured lookup concurrency", async () => {
    const value = harness(["A", "B", "C", "D", "E", "F"]);
    let active = 0;
    let maximum = 0;
    value.getPlayerStats.mockImplementation(async (playerName: string, matchCount: number): Promise<PlayerStatsResult> => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return stats(playerName, matchCount);
    });

    await runModusReport(options(["A", "B", "C", "D", "E", "F"], value, { concurrency: 2 }));

    expect(maximum).toBeLessThanOrEqual(2);
  });
});
