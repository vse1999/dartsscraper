import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createReportBudget,
  ReportDeadlineExceededError,
  raceWithReportDeadline,
} from "../src/daily/report-budget.js";
import {
  runModusReport,
  type RunModusReportOptions,
} from "../src/daily/modus-report.js";
import type { Logger } from "../src/logger.js";
import type { ModusFixturesResult, ModusPlayersResult } from "../src/modus/schemas.js";
import {
  asPdcTournamentReader,
  handlePdcReportCommand,
  type PdcCommandResponder,
} from "../src/telegram/pdc-command.js";
import {
  PdcTournamentService,
  type PdcPlayerStats,
} from "../src/pdc/service.js";
import type {
  PdcFixture,
  PdcTournamentEvent,
  PdcTournamentResult,
  PdcTournamentSource,
} from "../src/pdc/schemas.js";
import type { PlayerStatsReader, PlayerStatsResult } from "../src/telegram/stats-service.js";
import type { TelegramMessageSender } from "../src/telegram/sender.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject): void => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise === undefined || rejectPromise === undefined) {
    throw new Error("Deferred promise handlers were not initialized.");
  }
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

const logger: Logger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

function modusPlayers(names: readonly string[]): ModusPlayersResult {
  return {
    date: "2026-09-17",
    event: "MODUS Super Series",
    players: names.map((name) => ({
      name,
      source: "https://example.com/modus",
      confidence: 1,
    })),
  };
}

function playerStats(playerName: string, requestedCount: number): PlayerStatsResult {
  return {
    playerName,
    requestedCount,
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

function modusOptions(
  names: readonly string[],
  getPlayerStats: PlayerStatsReader["getPlayerStats"],
  sendMessage: TelegramMessageSender["sendMessage"],
  overrides: Partial<RunModusReportOptions["budget"]> = {},
  concurrency = 3,
): RunModusReportOptions {
  return {
    date: "2026-09-17",
    dateLabel: "tomorrow",
    matchCount: 10,
    chatId: 123,
    concurrency,
    budget: {
      totalMs: overrides.totalMs ?? 200,
      researchMs: overrides.researchMs ?? 100,
      ...(overrides.now === undefined ? {} : { now: overrides.now }),
    },
    dependencies: {
      modusPlayersService: {
        getModusPlayers: async (): Promise<ModusPlayersResult> => modusPlayers(names),
      },
      playerStatsService: { getPlayerStats },
      telegram: { sendMessage },
      logger,
    },
  };
}

function pdcFixture(id: string, playerOne: string, playerTwo: string): PdcFixture {
  return {
    id,
    tournamentName: "World Series of Darts Finals 2026",
    date: "2026-09-17",
    startTime: null,
    session: "19:00 CEST",
    round: "Round One",
    playerOne,
    playerTwo,
    sourceUrl: "https://pdpa.co.uk/event/world-series/",
  };
}

function pdcStats(playerName: string, requestedCount: number): PdcPlayerStats {
  const playerSlug = playerName.toLocaleLowerCase("en-US").replace(/\s+/gu, "-");
  const average = playerName === "A" ? 101 : 97;
  return {
    playerName,
    requestedCount,
    matches: [{
      date: "2026-09-01",
      tournament: "PDC Autumn Series",
      round: "Round One",
      result: "Won",
      opponent: `${playerName} opponent`,
      score: "6 V 3",
      average,
      oneEighties: 2,
      checkoutPercentage: 50,
      checkoutHits: 1,
      checkoutAttempts: 2,
    }],
    meanAverage: average,
    availableAverageCount: 1,
    sourceUrl: `https://dartsorakel.com/player/details/1/${playerSlug}`,
    sourceLabel: "DartsOrakel",
    provider: "dartsorakel",
    evidenceUrls: [`https://dartsorakel.com/match/stats/${playerSlug}`],
  };
}

function pdcSource(): PdcTournamentSource {
  return {
    getCalendar: async (): Promise<readonly PdcTournamentEvent[]> => [],
    getResults: async (): Promise<PdcTournamentResult> => {
      throw new Error("PDC result lookup was not expected in this test.");
    },
  };
}

function pdcResponder(
  replies: string[],
  onReply?: (text: string, signal: AbortSignal | undefined) => Promise<void>,
): PdcCommandResponder {
  return {
    reply: async (text: string, options?: { readonly signal?: AbortSignal }): Promise<void> => {
      replies.push(text);
      await onReply?.(text, options?.signal);
    },
  };
}

afterEach((): void => {
  vi.useRealTimers();
});

describe("report deadline coordination", () => {
  it("aborts research and total at exact boundaries and clears both timers", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const budget = createReportBudget({ totalMs: 100, researchMs: 40 });

    expect(budget.startedAt).toBe(10_000);
    expect(budget.researchRemainingMs()).toBe(40);
    expect(budget.remainingMs()).toBe(100);
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(39);
    expect(budget.researchSignal.aborted).toBe(false);
    expect(budget.totalSignal.aborted).toBe(false);
    expect(budget.researchRemainingMs()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(budget.researchSignal.aborted).toBe(true);
    expect(budget.totalSignal.aborted).toBe(false);
    expect(budget.researchRemainingMs()).toBe(0);

    await vi.advanceTimersByTimeAsync(59);
    expect(budget.totalSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(budget.totalSignal.aborted).toBe(true);
    expect(budget.remainingMs()).toBe(0);

    budget.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an already-aborted race while observing a later operation rejection", async () => {
    const controller = new AbortController();
    const operation = deferred<void>();
    controller.abort(new Error("deadline"));

    const raced = raceWithReportDeadline(operation.promise, controller.signal, "research");
    await expect(raced).rejects.toMatchObject({ phase: "research" });

    operation.reject(new Error("late dependency failure"));
    await expect(operation.promise).rejects.toThrow("late dependency failure");
  });

  it("bounds hanging MODUS discovery at research deadline and delivers warning during reserve", async () => {
    vi.useFakeTimers();
    const fixturesPending = deferred<ModusFixturesResult>();
    let discoverySignal: AbortSignal | undefined;
    const getModusFixtures = vi.fn<(date: string, signal?: AbortSignal) => Promise<ModusFixturesResult>>(
      (_date: string, signal?: AbortSignal): Promise<ModusFixturesResult> => {
        discoverySignal = signal;
        return fixturesPending.promise;
      },
    );
    const getModusPlayers = vi.fn(async (): Promise<ModusPlayersResult> => modusPlayers([]));
    const sendMessage = vi.fn<TelegramMessageSender["sendMessage"]>(async (): Promise<void> => undefined);
    const baseOptions = modusOptions([], async (): Promise<PlayerStatsResult> => playerStats("unused", 10), sendMessage, {
      totalMs: 100,
      researchMs: 40,
    });
    const options: RunModusReportOptions = {
      ...baseOptions,
      dependencies: {
        ...baseOptions.dependencies,
        modusPlayersService: { getModusFixtures, getModusPlayers },
      },
    };

    const running = runModusReport(options);
    await vi.advanceTimersByTimeAsync(40);
    const result = await running;

    expect(getModusFixtures).toHaveBeenCalledTimes(1);
    expect(discoverySignal?.aborted).toBe(true);
    expect(getModusPlayers).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[1]?.[1]).toContain("timed out");
    expect(result.outcome.discovery).toMatchObject({
      status: "failed",
      failureCode: "MODUS_RESEARCH_DEADLINE_EXCEEDED",
    });
    expect(result.outcome.delivery).toMatchObject({ status: "complete", attempted: 3, skipped: 0 });
  });

  it("distinguishes an active timed-out MODUS lookup from an unstarted lookup", async () => {
    vi.useFakeTimers();
    const active = deferred<PlayerStatsResult>();
    const calls: string[] = [];
    const getPlayerStats = vi.fn<PlayerStatsReader["getPlayerStats"]>(
      (playerName: string, count: number): Promise<PlayerStatsResult> => {
        calls.push(playerName);
        if (playerName === "A") {
          return new Promise<PlayerStatsResult>((resolve): void => {
            setTimeout((): void => resolve(playerStats(playerName, count)), 5);
          });
        }
        if (playerName === "B") return active.promise;
        return Promise.resolve(playerStats(playerName, count));
      },
    );
    const sendMessage = vi.fn<TelegramMessageSender["sendMessage"]>(async (): Promise<void> => undefined);
    const running = runModusReport(modusOptions(["A", "B", "C"], getPlayerStats, sendMessage, {
      totalMs: 200,
      researchMs: 50,
    }, 1));

    await vi.advanceTimersByTimeAsync(5);
    expect(calls).toEqual(["A", "B"]);
    await vi.advanceTimersByTimeAsync(45);
    const result = await running;

    expect(calls).toEqual(["A", "B"]);
    expect(result.results.map((item) => [item.player, item.error])).toEqual([
      ["A", undefined],
      ["B", "MODUS_RESEARCH_DEADLINE_EXCEEDED"],
      ["C", "MODUS_RESEARCH_NOT_STARTED"],
    ]);
    expect(result.outcome.data).toMatchObject({
      status: "partial",
      attempted: 2,
      succeeded: 1,
      failed: 1,
      timedOut: 1,
      unstarted: 1,
    });
  });

  it("stops MODUS delivery after total cutoff and reports attempted versus skipped sends", async () => {
    vi.useFakeTimers();
    const names = Array.from({ length: 100 }, (_value: undefined, index: number): string => `Player ${index + 1} ${"x".repeat(60)}`);
    const getPlayerStats = vi.fn<PlayerStatsReader["getPlayerStats"]>(
      async (playerName: string, count: number): Promise<PlayerStatsResult> => playerStats(playerName, count),
    );
    const firstSendStarted = deferred<void>();
    const hangingSend = deferred<void>();
    let sendCount = 0;
    const sendMessage = vi.fn<TelegramMessageSender["sendMessage"]>(
      async (): Promise<void> => {
        sendCount += 1;
        if (sendCount === 1) {
          firstSendStarted.resolve();
          await hangingSend.promise;
        }
      },
    );
    const running = runModusReport(modusOptions(names, getPlayerStats, sendMessage, {
      totalMs: 40,
      researchMs: 10,
    }, 8));

    await firstSendStarted.promise;
    await vi.advanceTimersByTimeAsync(40);
    const result = await running;

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(result.outcome.delivery).toMatchObject({ attempted: 1, failed: 1 });
    expect(result.outcome.delivery.skipped).toBeGreaterThan(0);

    hangingSend.resolve();
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("runs a completed PDC service report through the command and forwards source signals", async () => {
    vi.useFakeTimers();
    const sourceSignals: AbortSignal[] = [];
    const statsSignals: AbortSignal[] = [];
    const fixtures = [pdcFixture("fixture-1", "A", "B")];
    const service: PdcTournamentService = new PdcTournamentService({
      source: pdcSource(),
      fixtureSource: {
        name: "test fixture source",
        getFixtures: async (_date: string, signal?: AbortSignal): Promise<readonly PdcFixture[]> => {
          if (signal !== undefined) sourceSignals.push(signal);
          return fixtures;
        },
      },
      playerStats: {
        getPlayerStats: async (
          name: string,
          count: number,
          _source: "auto" | "dartsorakel" | "modus" | undefined,
          signal?: AbortSignal,
        ): Promise<PdcPlayerStats> => {
          if (signal !== undefined) statsSignals.push(signal);
          return pdcStats(name, count);
        },
      },
      playerConcurrency: 1,
    });
    const replies: string[] = [];
    const outcome = await handlePdcReportCommand(
      "/pdc tomorrow",
      asPdcTournamentReader(service),
      (): string => "2026-09-17",
      pdcResponder(replies),
      logger,
      undefined,
      { totalMs: 100, researchMs: 70 },
    );

    expect(outcome).toBe("success");
    expect(replies[0]).toContain("Scanning PDC tomorrow");
    expect(replies.join("\n")).toContain("A vs B");
    expect(sourceSignals).toHaveLength(1);
    expect(statsSignals).toHaveLength(2);
    expect(statsSignals.every((signal) => signal === sourceSignals[0])).toBe(true);
  });

  it("preserves a PDC partial snapshot with completed, timed-out, and unstarted players", async () => {
    vi.useFakeTimers();
    const hanging = deferred<PdcPlayerStats>();
    const playerCalls: string[] = [];
    const sourceSignals: AbortSignal[] = [];
    const statsSignals: AbortSignal[] = [];
    const playerBegan = deferred<void>();
    const fixtures = [
      pdcFixture("fixture-1", "A", "B"),
      pdcFixture("fixture-2", "B", "C"),
    ];
    const service = new PdcTournamentService({
      source: pdcSource(),
      fixtureSource: {
        name: "test fixture source",
        getFixtures: async (_date: string, signal?: AbortSignal): Promise<readonly PdcFixture[]> => {
          if (signal !== undefined) sourceSignals.push(signal);
          return fixtures;
        },
      },
      playerStats: {
        getPlayerStats: async (
          name: string,
          count: number,
          _source: "auto" | "dartsorakel" | "modus" | undefined,
          signal?: AbortSignal,
        ): Promise<PdcPlayerStats> => {
          playerCalls.push(name);
          if (signal !== undefined) statsSignals.push(signal);
          if (name === "B") {
            playerBegan.resolve();
            return hanging.promise;
          }
          return pdcStats(name, count);
        },
      },
      playerConcurrency: 1,
    });
    const replies: string[] = [];
    const running = handlePdcReportCommand(
      "/pdc tomorrow",
      asPdcTournamentReader(service),
      (): string => "2026-09-17",
      pdcResponder(replies),
      logger,
      undefined,
      { totalMs: 120, researchMs: 50 },
    );

    await playerBegan.promise;
    await vi.advanceTimersByTimeAsync(50);
    const outcome = await running;

    expect(outcome).toBe("failed");
    expect(replies[0]).toContain("Scanning PDC tomorrow");
    expect(replies[1]).toContain("Research incomplete");
    const playerAReport = replies.find((reply): boolean => reply.includes("\n🎯 A\n"));
    expect(playerAReport).toContain("1 latest completed matches");
    expect(playerAReport).toContain("Average: 101.00");
    expect(playerAReport).toContain("https://dartsorakel.com/player/details/1/a");
    expect(replies.join("\n")).toContain("Research incomplete");
    expect(replies.join("\n")).toContain("timed out at the research deadline");
    expect(replies.join("\n")).toContain("was skipped because the research deadline was reached before this lookup started");
    expect(playerCalls).toEqual(["A", "B"]);
    expect(statsSignals).toHaveLength(2);
    expect(statsSignals.every((signal) => signal.aborted)).toBe(true);
    expect(sourceSignals[0]?.aborted).toBe(true);

    const repliesAtDeadline = replies.length;
    hanging.resolve(pdcStats("B", 10));
    await Promise.resolve();
    await Promise.resolve();
    expect(replies).toHaveLength(repliesAtDeadline);
    expect(playerCalls).toEqual(["A", "B"]);
  });

  it("retains completed PDC player stats when a later lookup misses the research deadline", async () => {
    const hanging = deferred<PdcPlayerStats>();
    const playerBegan = deferred<void>();
    const playerCalls: string[] = [];
    const controller = new AbortController();
    const fixtures = [
      pdcFixture("fixture-1", "A", "B"),
      pdcFixture("fixture-2", "B", "C"),
    ];
    const service = new PdcTournamentService({
      source: pdcSource(),
      fixtureSource: {
        name: "test fixture source",
        getFixtures: async (): Promise<readonly PdcFixture[]> => fixtures,
      },
      playerStats: {
        getPlayerStats: async (
          name: string,
          count: number,
        ): Promise<PdcPlayerStats> => {
          playerCalls.push(name);
          if (name === "B") {
            playerBegan.resolve();
            return hanging.promise;
          }
          return pdcStats(name, count);
        },
      },
      playerConcurrency: 1,
    });

    const running = service.getUpcomingReportForDate("2026-09-17", controller.signal);
    await playerBegan.promise;
    controller.abort(new ReportDeadlineExceededError("research"));
    const report = await running;

    expect(playerCalls).toEqual(["A", "B"]);
    expect(report.players.map((player): readonly [string, string | null, boolean] => [
      player.requestedName,
      player.failureCode,
      player.stats !== null,
    ])).toEqual([
      ["A", null, true],
      ["B", "timeout", false],
      ["C", "unstarted", false],
    ]);
    expect(report.players[0]?.stats?.matches[0]).toMatchObject({
      opponent: "A opponent",
      average: 101,
      oneEighties: 2,
      checkoutPercentage: 50,
    });

    hanging.resolve(pdcStats("B", 10));
    await Promise.resolve();
    await Promise.resolve();
    expect(playerCalls).toEqual(["A", "B"]);
  });

  it("bounds hanging PDC latest discovery at research deadline", async () => {
    vi.useFakeTimers();
    const pendingCalendar = deferred<readonly PdcTournamentEvent[]>();
    let sourceSignal: AbortSignal | undefined;
    const service = new PdcTournamentService({
      source: {
        getCalendar: async (
          _year: number,
          _category: "All Rankings" | "TV Ranking" | "TV" | "PDCE",
          signal?: AbortSignal,
        ): Promise<readonly PdcTournamentEvent[]> => {
          sourceSignal = signal;
          return pendingCalendar.promise;
        },
        getResults: async (): Promise<PdcTournamentResult> => {
          throw new Error("result lookup was not expected");
        },
      },
      categories: ["PDCE"],
    });
    const replies: string[] = [];
    const running = handlePdcReportCommand(
      "/pdc latest",
      asPdcTournamentReader(service),
      (): string => "2026-09-17",
      pdcResponder(replies),
      logger,
      undefined,
      { totalMs: 100, researchMs: 30 },
    );

    await vi.advanceTimersByTimeAsync(30);
    const outcome = await running;

    expect(outcome).toBe("failed");
    expect(sourceSignal?.aborted).toBe(true);
    expect(replies[0]).toContain("Scanning PDC latest");
    expect(replies.at(-1)).toContain("research deadline");
  });

  it("bounds non-cooperative PDC upcoming fixture discovery at research deadline", async () => {
    vi.useFakeTimers();
    const pendingFixtures = deferred<readonly PdcFixture[]>();
    let fixtureSignal: AbortSignal | undefined;
    const service = new PdcTournamentService({
      source: pdcSource(),
      fixtureSource: {
        name: "non-cooperative fixture source",
        getFixtures: async (
          _date: string,
          signal?: AbortSignal,
        ): Promise<readonly PdcFixture[]> => {
          fixtureSignal = signal;
          return pendingFixtures.promise;
        },
      },
      playerStats: {
        getPlayerStats: async (name: string, count: number): Promise<PdcPlayerStats> => pdcStats(name, count),
      },
      playerConcurrency: 1,
    });
    const replies: string[] = [];
    const running = handlePdcReportCommand(
      "/pdc tomorrow",
      asPdcTournamentReader(service),
      (): string => "2026-09-17",
      pdcResponder(replies),
      logger,
      undefined,
      { totalMs: 100, researchMs: 30 },
    );

    await vi.advanceTimersByTimeAsync(30);
    const outcome = await running;

    expect(outcome).toBe("failed");
    expect(fixtureSignal?.aborted).toBe(true);
    expect(replies[0]).toContain("Scanning PDC tomorrow");
    expect(replies.at(-1)).toContain("research deadline");
    expect(replies).toHaveLength(2);

    pendingFixtures.resolve([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(replies).toHaveLength(2);
  });

  it("does not send a later PDC message after a total-deadline delivery hangs", async () => {
    vi.useFakeTimers();
    const hangingReply = deferred<void>();
    const reportResult: PdcTournamentResult = {
      event: {
        eventKey: 8022,
        tournamentKey: 5,
        tournamentName: "European Tour",
        tournamentNumber: 12,
        category: "ET",
        eventDate: "2026-09-06",
        startDate: "2026-09-06",
        endDate: "2026-09-06",
        eventAverage: 93.47,
        winnerAverage: 101.73,
        winnerName: "Luke Littler",
        winnerPlayerId: 5403,
        calendarUrl: "https://dartsorakel.com/api/events?year=2026&organCal=PDCE",
        resultsUrl: "https://dartsorakel.com/events/result/8022/2026-european-tour",
      },
      matches: [{
        matchId: 565570,
        round: "Final",
        winnerName: "Luke Littler",
        winnerPlayerId: 5403,
        loserName: "Luke Humphries",
        loserPlayerId: 34,
        winnerScore: 8,
        loserScore: 6,
        sourceUrl: "https://dartsorakel.com/match/stats/565570",
      }],
      sourceUrl: "https://dartsorakel.com/events/result/8022/2026-european-tour",
    };
    let replyCount = 0;
    const replies: string[] = [];
    const reportDeliveryStarted = deferred<void>();
    const responder = pdcResponder(replies, async (_text: string): Promise<void> => {
      replyCount += 1;
      if (replyCount === 2) {
        reportDeliveryStarted.resolve();
        await hangingReply.promise;
      }
    });
    const running = handlePdcReportCommand(
      "/pdc latest",
      {
        getLatestResults: async (): Promise<readonly PdcTournamentResult[]> => [reportResult],
        getUpcomingReportForDate: async (): Promise<never> => {
          throw new Error("upcoming lookup was not expected");
        },
      },
      (): string => "2026-09-17",
      responder,
      logger,
      undefined,
      { totalMs: 40, researchMs: 20 },
    );

    await reportDeliveryStarted.promise;
    expect(replyCount).toBe(2);
    await vi.advanceTimersByTimeAsync(40);
    const outcome = await running;

    expect(outcome).toBe("failed");
    expect(replies).toHaveLength(2);
  });
});
