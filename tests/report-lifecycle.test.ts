import { describe, expect, it, vi } from "vitest";

import type { LogContext, Logger } from "../src/logger.js";
import {
  runReportLifecycle,
  type ReportSession,
} from "../src/daily/report-lifecycle.js";

class TestLogger implements Logger {
  public readonly entries: Array<{ readonly level: string; readonly message: string; readonly context?: LogContext }> = [];

  public debug(message: string, context?: LogContext): void { this.entries.push({ level: "debug", message, ...(context === undefined ? {} : { context }) }); }
  public info(message: string, context?: LogContext): void { this.entries.push({ level: "info", message, ...(context === undefined ? {} : { context }) }); }
  public warn(message: string, context?: LogContext): void { this.entries.push({ level: "warn", message, ...(context === undefined ? {} : { context }) }); }
  public error(message: string, context?: LogContext): void { this.entries.push({ level: "error", message, ...(context === undefined ? {} : { context }) }); }
}

const budget = { totalMs: 100, researchMs: 50 };

describe("report lifecycle", () => {
  it("does not invoke report work when acknowledgement fails", async () => {
    const logger = new TestLogger();
    let reportCalls = 0;

    const result = await runReportLifecycle({
      budget,
      logger,
      acknowledge: async (): Promise<string> => { throw new Error("ack failed"); },
      report: async (): Promise<string> => {
        reportCalls += 1;
        return "unexpected";
      },
    });

    expect(result).toEqual({ status: "failed", phase: "acknowledgement" });
    expect(reportCalls).toBe(0);
  });

  it("gates report work until scheduler registration is accepted", async () => {
    const logger = new TestLogger();
    let reportCalls = 0;
    let editCalls = 0;
    let task: Promise<void> | undefined;

    const result = await runReportLifecycle({
      budget,
      logger,
      acknowledge: async (): Promise<number> => 17,
      report: async (): Promise<string> => {
        reportCalls += 1;
        return "unexpected";
      },
      scheduleBackgroundTask: (scheduled: Promise<void>): void => {
        task = scheduled;
        throw new Error("scheduler unavailable");
      },
      schedulingFailureEdit: async (): Promise<void> => { editCalls += 1; },
    });

    expect(result).toEqual({ status: "failed", phase: "scheduling" });
    expect(reportCalls).toBe(0);
    expect(editCalls).toBe(1);
    await task;
    expect(reportCalls).toBe(0);
  });

  it("keeps accepted background work alive after the handler returns", async () => {
    const logger = new TestLogger();
    let resolveReport: (() => void) | undefined;
    let scheduled: Promise<void> | undefined;
    const reportFinished = new Promise<void>((resolve): void => { resolveReport = resolve; });

    const result = await runReportLifecycle({
      budget,
      logger,
      acknowledge: async (): Promise<number> => 17,
      report: async (): Promise<string> => {
        await reportFinished;
        return "done";
      },
      scheduleBackgroundTask: (task: Promise<void>): void => { scheduled = task; },
    });

    expect(result).toEqual({ status: "started" });
    expect(scheduled).toBeDefined();
    let completed = false;
    void scheduled?.then((): void => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    resolveReport?.();
    await scheduled;
    expect(completed).toBe(true);
  });

  it("latches uncertain delivery failure and refuses later sends", async () => {
    const logger = new TestLogger();
    let deliveryCalls = 0;
    let canDeliverAfterFailure = true;

    const result = await runReportLifecycle({
      budget,
      logger,
      acknowledge: async (): Promise<number> => 17,
      report: async (session: ReportSession): Promise<string> => {
        try {
          await session.deliver(async (): Promise<void> => {
            deliveryCalls += 1;
            throw new Error("uncertain send");
          });
        } catch {
          canDeliverAfterFailure = session.canDeliver();
        }
        try {
          await session.deliver(async (): Promise<void> => {
            deliveryCalls += 1;
          });
        } catch {
          // The second operation must be refused before its callback starts.
        }
        return "done";
      },
    });

    expect(result).toEqual({ status: "completed", result: "done" });
    expect(deliveryCalls).toBe(1);
    expect(canDeliverAfterFailure).toBe(false);
  });

  it("races a non-cooperative research operation and observes its late rejection", async () => {
    vi.useFakeTimers();
    let lateRejected = false;
    try {
      const running = runReportLifecycle({
        budget: { totalMs: 100, researchMs: 10 },
        logger: new TestLogger(),
        acknowledge: async (): Promise<number> => 17,
        report: async (session: ReportSession): Promise<string> => {
          await session.research(async (): Promise<string> => new Promise<string>((_resolve, reject): void => {
            setTimeout((): void => {
              lateRejected = true;
              reject(new Error("late failure"));
            }, 40);
          }));
          return "unexpected";
        },
      });
      await vi.advanceTimersByTimeAsync(11);
      await expect(running).resolves.toEqual({ status: "failed", phase: "execution" });
      await vi.advanceTimersByTimeAsync(40);
      expect(lateRejected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits no research operation after the injected research deadline", async () => {
    let elapsed = 0;
    let researchCalls = 0;
    const result = await runReportLifecycle({
      budget: { totalMs: 200, researchMs: 100, now: (): number => elapsed },
      logger: new TestLogger(),
      acknowledge: async (): Promise<number> => {
        elapsed = 100;
        return 17;
      },
      report: async (session: ReportSession): Promise<string> => {
        try {
          await session.research(async (): Promise<string> => {
            researchCalls += 1;
            return "unexpected";
          });
        } catch {
          // Research admission is refused before the callback starts.
        }
        return "partial";
      },
    });

    expect(result).toEqual({ status: "completed", result: "partial" });
    expect(researchCalls).toBe(0);
  });

  it("bounds the optional scheduling-failure edit and clears its timers", async () => {
    vi.useFakeTimers();
    let editCalls = 0;
    let editSignal: AbortSignal | undefined;
    try {
      const running = runReportLifecycle({
        budget: { totalMs: 20, researchMs: 10 },
        logger: new TestLogger(),
        acknowledge: async (): Promise<number> => 17,
        report: async (): Promise<string> => "unexpected",
        scheduleBackgroundTask: (): void => { throw new Error("registration failed"); },
        schedulingFailureEdit: async (_acknowledgement: number, signal: AbortSignal): Promise<void> => {
          editCalls += 1;
          editSignal = signal;
          await new Promise<void>(() => undefined);
        },
      });
      await vi.advanceTimersByTimeAsync(21);
      await expect(running).resolves.toEqual({ status: "failed", phase: "scheduling" });
      expect(editCalls).toBe(1);
      expect(editSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
