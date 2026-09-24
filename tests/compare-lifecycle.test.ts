import { describe, expect, it, vi } from "vitest";

import type { Match } from "../src/schemas/match.js";
import type { LogContext, Logger } from "../src/logger.js";
import {
  handleCompareCommand,
  type CompareMessageResponder,
} from "../src/telegram/compare-command.js";
import type { PlayerStatsReader, PlayerStatsResult } from "../src/telegram/stats-service.js";
import { createTelegramDeliveryPolicy } from "../src/telegram/delivery-policy.js";

class LifecycleLogger implements Logger {
  public readonly entries: Array<{ readonly level: string; readonly message: string; readonly context?: LogContext }> = [];

  public debug(message: string, context?: LogContext): void { this.entries.push({ level: "debug", message, ...(context === undefined ? {} : { context }) }); }
  public info(message: string, context?: LogContext): void { this.entries.push({ level: "info", message, ...(context === undefined ? {} : { context }) }); }
  public warn(message: string, context?: LogContext): void { this.entries.push({ level: "warn", message, ...(context === undefined ? {} : { context }) }); }
  public error(message: string, context?: LogContext): void { this.entries.push({ level: "error", message, ...(context === undefined ? {} : { context }) }); }
}

class LifecycleResponder implements CompareMessageResponder {
  public readonly replies: string[] = [];
  public readonly edits: string[] = [];
  public readonly signals: AbortSignal[] = [];
  public failEdit = false;
  public failReplyNumber: number | undefined;

  public async reply(text: string, options?: { readonly signal?: AbortSignal }): Promise<{ readonly messageId: number }> {
    this.replies.push(text);
    if (options?.signal !== undefined) this.signals.push(options.signal);
    if (this.failReplyNumber === this.replies.length) throw new Error("reply failed");
    return { messageId: this.replies.length };
  }

  public async edit(_messageId: number, text: string, options?: { readonly signal?: AbortSignal }): Promise<void> {
    this.edits.push(text);
    if (options?.signal !== undefined) this.signals.push(options.signal);
    if (this.failEdit) throw new Error("edit failed");
  }
}

function result(playerName: string, requestedCount = 10): PlayerStatsResult {
  const match: Match = {
    date: "2026-09-20",
    tournament: "Example Open",
    round: "Final",
    result: "Won",
    opponent: "Other Player",
    score: "6 V 2",
    average: 95,
    oneEighties: 2,
    checkoutPercentage: 50,
    checkoutHits: 2,
    checkoutAttempts: 4,
  };
  return {
    playerName,
    requestedCount,
    matches: [match],
    meanAverage: 95,
    availableAverageCount: 1,
    sourceUrl: "https://dartsorakel.com/player/details/1/example",
    sourceLabel: "DartsOrakel",
    provider: "dartsorakel",
    evidenceUrls: [],
  };
}

describe("compare lifecycle", () => {
  it("waits for a successful acknowledgement before scheduling or researching", async () => {
    const events: string[] = [];
    let resolveAck: ((value: { readonly messageId: number }) => void) | undefined;
    let replyCount = 0;
    const responder: CompareMessageResponder = {
      reply: async (): Promise<{ readonly messageId: number }> => {
        replyCount += 1;
        if (replyCount > 1) {
          events.push(`reply:${replyCount}`);
          return { messageId: replyCount };
        }
        events.push("ack-start");
        return new Promise<{ readonly messageId: number }>((resolve): void => { resolveAck = resolve; });
      },
      edit: async (): Promise<void> => undefined,
    };
    const service: PlayerStatsReader = {
      getPlayerStats: async (playerName: string): Promise<PlayerStatsResult> => {
        events.push(`lookup:${playerName}`);
        return result(playerName);
      },
    };
    const scheduled: Promise<void>[] = [];
    const pending = handleCompareCommand(
      "/compare Alpha Player, Beta Player",
      service,
      responder,
      new LifecycleLogger(),
      1,
      (task: Promise<void>): void => { events.push("scheduled"); scheduled.push(task); },
      { totalMs: 1_000, researchMs: 500 },
    );

    await Promise.resolve();
    expect(events).toEqual(["ack-start"]);
    resolveAck?.({ messageId: 1 });
    await expect(pending).resolves.toBe("started");
    expect(events[0]).toBe("ack-start");
    expect(events).toContain("scheduled");
    await scheduled[0];
    expect(events).toContain("lookup:Alpha Player");
  });

  it("does not schedule or research when the acknowledgement fails", async () => {
    let lookups = 0;
    let scheduled = 0;
    const responder: CompareMessageResponder = {
      reply: async (): Promise<{ readonly messageId: number }> => { throw new Error("ack failed"); },
      edit: async (): Promise<void> => undefined,
    };
    const service: PlayerStatsReader = {
      getPlayerStats: async (): Promise<PlayerStatsResult> => {
        lookups += 1;
        return result("Alpha Player");
      },
    };

    await expect(handleCompareCommand(
      "/compare Alpha Player, Beta Player",
      service,
      responder,
      new LifecycleLogger(),
      2,
      (): void => { scheduled += 1; },
    )).resolves.toBe("failed");
    expect(lookups).toBe(0);
    expect(scheduled).toBe(0);
  });

  it("does not research after scheduler registration fails and edits the confirmed acknowledgement once", async () => {
    let lookups = 0;
    const responder = new LifecycleResponder();
    const service: PlayerStatsReader = {
      getPlayerStats: async (): Promise<PlayerStatsResult> => {
        lookups += 1;
        return result("Alpha Player");
      },
    };

    await expect(handleCompareCommand(
      "/compare Alpha Player, Beta Player",
      service,
      responder,
      new LifecycleLogger(),
      20,
      (): void => { throw new Error("registration failed"); },
      { totalMs: 1_000, researchMs: 500 },
    )).resolves.toBe("failed");
    expect(lookups).toBe(0);
    expect(responder.edits).toHaveLength(1);
    expect(responder.replies).toHaveLength(1);
  });

  it("stops after an uncertain edit failure instead of sending a fallback page", async () => {
    const responder = new LifecycleResponder();
    responder.failEdit = true;
    const logger = new LifecycleLogger();
    const service: PlayerStatsReader = {
      getPlayerStats: async (playerName: string): Promise<PlayerStatsResult> => result(playerName, 20),
    };

    await expect(handleCompareCommand(
      "/compare Alpha Player, Beta Player last 20",
      service,
      responder,
      logger,
      3,
      undefined,
      { totalMs: 1_000, researchMs: 500 },
    )).resolves.toBe("failed");
    expect(responder.edits).toHaveLength(1);
    expect(responder.replies).toHaveLength(1);
    const completed = logger.entries.find((entry) => entry.message === "Player comparison completed.");
    expect(completed?.context).toMatchObject({
      delivery: expect.objectContaining({ failed: 1, uncertain: true }),
    });
  });

  it("propagates the total signal and sends no page after a non-cooperative edit reaches the deadline", async () => {
    vi.useFakeTimers();
    const responder = new LifecycleResponder();
    responder.edit = async (_messageId: number, text: string, options?: { readonly signal?: AbortSignal }): Promise<void> => {
      responder.edits.push(text);
      if (options?.signal !== undefined) responder.signals.push(options.signal);
      await new Promise<void>(() => undefined);
    };
    const service: PlayerStatsReader = {
      getPlayerStats: async (playerName: string): Promise<PlayerStatsResult> => result(playerName, 20),
    };

    try {
      const pending = handleCompareCommand(
        "/compare Alpha Player, Beta Player last 20",
        service,
        responder,
        new LifecycleLogger(),
        4,
        undefined,
        { totalMs: 30, researchMs: 10 },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(responder.edits).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(31);
      await expect(pending).resolves.toBe("failed");
      expect(responder.replies).toHaveLength(1);
      expect(responder.edits).toHaveLength(1);
      expect(responder.signals).toHaveLength(2);
      expect(responder.signals[0]).toBe(responder.signals[1]);
      expect(responder.signals[1]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves partial delivery accounting when a later page hangs at the cutoff", async () => {
    vi.useFakeTimers();
    const responder = new LifecycleResponder();
    responder.reply = async (text: string, options?: { readonly signal?: AbortSignal }): Promise<{ readonly messageId: number }> => {
      responder.replies.push(text);
      if (options?.signal !== undefined) responder.signals.push(options.signal);
      if (responder.replies.length > 1) await new Promise<void>(() => undefined);
      return { messageId: responder.replies.length };
    };
    const logger = new LifecycleLogger();
    const service: PlayerStatsReader = {
      getPlayerStats: async (playerName: string): Promise<PlayerStatsResult> => result(playerName, 20),
    };

    try {
      const pending = handleCompareCommand(
        "/compare Alpha Player, Beta Player last 20",
        service,
        responder,
        logger,
        21,
        undefined,
        { totalMs: 30, researchMs: 10 },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(responder.edits).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(31);
      await expect(pending).resolves.toBe("partial");
      expect(responder.replies).toHaveLength(2);
      const completed = logger.entries.find((entry) => entry.message === "Player comparison completed.");
      expect(completed?.context).toMatchObject({
        delivery: expect.objectContaining({ delivered: 1, failed: 1, uncertain: true }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one successful source result when the other lookup fails", async () => {
    const responder = new LifecycleResponder();
    const service: PlayerStatsReader = {
      getPlayerStats: async (playerName: string): Promise<PlayerStatsResult> => {
        if (playerName === "Missing Player") throw new Error("upstream detail");
        return result(playerName);
      },
    };

    await expect(handleCompareCommand(
      "/compare Alpha Player, Missing Player",
      service,
      responder,
      new LifecycleLogger(),
      5,
      undefined,
      { totalMs: 1_000, researchMs: 500 },
    )).resolves.toBe("partial");
    expect(responder.edits[0]).toContain("Alpha Player");
    expect(responder.edits[0]).toContain("Missing Player");
  });

  it("marks canonical aliases as the same player without inventing a comparison", async () => {
    const responder = new LifecycleResponder();
    const service: PlayerStatsReader = {
      getPlayerStats: async (): Promise<PlayerStatsResult> => result("Phil Taylor Jr"),
    };

    await expect(handleCompareCommand(
      "/compare Phil Taylor Jr, Phil Taylor Jnr",
      service,
      responder,
      new LifecycleLogger(),
      6,
      undefined,
      { totalMs: 1_000, researchMs: 500 },
    )).resolves.toBe("partial");
    expect(responder.edits[0]).toContain("both names resolved to the same player");
  });

  it("records partial pagination when a later page fails after the summary edit", async () => {
    const responder = new LifecycleResponder();
    responder.failReplyNumber = 2;
    const logger = new LifecycleLogger();
    const service: PlayerStatsReader = {
      getPlayerStats: async (playerName: string): Promise<PlayerStatsResult> => result(playerName),
    };

    await expect(handleCompareCommand(
      "/compare Alpha Player, Beta Player",
      service,
      responder,
      logger,
      7,
      undefined,
      { totalMs: 1_000, researchMs: 500 },
    )).resolves.toBe("partial");
    expect(responder.edits).toHaveLength(1);
    expect(responder.replies).toHaveLength(2);
    const completed = logger.entries.find((entry) => entry.message === "Player comparison completed.");
    expect(completed?.context).toMatchObject({
      delivery: expect.objectContaining({ delivered: 1, failed: 1, uncertain: true }),
    });
  });

  it("preflights injected elapsed time before the next lookup and page send", async () => {
    let elapsed = 0;
    let lookups = 0;
    const responder = new LifecycleResponder();
    responder.edit = async (_messageId: number, text: string): Promise<void> => {
      responder.edits.push(text);
      elapsed = 150;
    };
    const service: PlayerStatsReader = {
      getPlayerStats: async (playerName: string): Promise<PlayerStatsResult> => {
        lookups += 1;
        elapsed = 120;
        return result(playerName);
      },
    };

    await expect(handleCompareCommand(
      "/compare Alpha Player, Beta Player",
      service,
      responder,
      new LifecycleLogger(),
      8,
      undefined,
      { totalMs: 150, researchMs: 120, now: (): number => elapsed },
    )).resolves.toBe("partial");
    expect(lookups).toBe(1);
    expect(responder.edits).toHaveLength(1);
    expect(responder.replies).toHaveLength(1);
  });

  it("observes a late rejecting reader after the research deadline without an unhandled rejection", async () => {
    let lateRejected = false;
    const service: PlayerStatsReader = {
      getPlayerStats: async (): Promise<PlayerStatsResult> => new Promise<PlayerStatsResult>((_resolve, reject): void => {
        setTimeout((): void => {
          lateRejected = true;
          reject(new Error("late reader failure"));
        }, 40);
      }),
    };
    const responder = new LifecycleResponder();

    await expect(handleCompareCommand(
      "/compare Alpha Player, Beta Player",
      service,
      responder,
      new LifecycleLogger(),
      9,
      undefined,
      { totalMs: 100, researchMs: 10 },
    )).resolves.toBe("failed");
    await new Promise<void>((resolve): void => { setTimeout(resolve, 60); });
    expect(lateRejected).toBe(true);
  });

  it("removes a queued delivery when its total signal aborts before the underlying operation starts", async () => {
    const policy = createTelegramDeliveryPolicy({ minIntervalMs: 0 });
    const firstController = new AbortController();
    const secondController = new AbortController();
    let secondStarted = false;
    const first = policy.execute(
      "chat",
      async (): Promise<string> => new Promise<string>(() => undefined),
      { signal: firstController.signal },
    );
    const second = policy.execute(
      "chat",
      async (): Promise<string> => {
        secondStarted = true;
        return "second";
      },
      { signal: secondController.signal },
    );
    secondController.abort();
    await expect(second).rejects.toThrow("aborted");
    firstController.abort();
    await expect(first).rejects.toThrow("aborted");
    expect(secondStarted).toBe(false);
  });
});
