/**
 * A small, dependency-free deadline coordinator for report jobs.
 *
 * Reports have two deadlines: research is allowed to finish early enough to
 * leave room for Telegram delivery, while the total deadline is a hard stop.
 * The race helper is intentionally separate from AbortSignal: callers cannot
 * assume that an injected dependency observes aborts (test doubles and some
 * third-party clients do not).
 */

export type ReportBudgetPhase = "research" | "delivery" | "total";

export interface ReportBudgetOptions {
  readonly totalMs: number;
  readonly researchMs: number;
  readonly now?: () => number;
}

export interface ReportBudget {
  readonly startedAt: number;
  readonly totalDeadlineAt: number;
  readonly researchDeadlineAt: number;
  readonly totalSignal: AbortSignal;
  readonly researchSignal: AbortSignal;
  remainingMs(): number;
  researchRemainingMs(): number;
  close(): void;
}

export class ReportDeadlineExceededError extends Error {
  public readonly phase: ReportBudgetPhase;

  public constructor(phase: ReportBudgetPhase) {
    super(`Report ${phase} deadline exceeded.`);
    this.name = "ReportDeadlineExceededError";
    this.phase = phase;
  }
}

/** Create a report budget and arm both deadline abort signals immediately. */
export function createReportBudget(options: ReportBudgetOptions): ReportBudget {
  validateDuration(options.totalMs, "totalMs");
  validateDuration(options.researchMs, "researchMs");
  if (options.researchMs > options.totalMs) {
    throw new Error("researchMs must not exceed totalMs.");
  }

  const now = options.now ?? Date.now;
  const startedAt = now();
  const totalDeadlineAt = startedAt + options.totalMs;
  const researchDeadlineAt = startedAt + options.researchMs;
  const totalController = new AbortController();
  const researchController = new AbortController();
  const totalTimer = setTimeout((): void => {
    totalController.abort(new ReportDeadlineExceededError("total"));
  }, options.totalMs);
  const researchTimer = setTimeout((): void => {
    researchController.abort(new ReportDeadlineExceededError("research"));
  }, options.researchMs);

  const close = (): void => {
    clearTimeout(totalTimer);
    clearTimeout(researchTimer);
    if (!totalController.signal.aborted) totalController.abort(new ReportDeadlineExceededError("total"));
    if (!researchController.signal.aborted) researchController.abort(new ReportDeadlineExceededError("research"));
  };
  return {
    startedAt,
    totalDeadlineAt,
    researchDeadlineAt,
    totalSignal: totalController.signal,
    researchSignal: researchController.signal,
    remainingMs: (): number => Math.max(0, totalDeadlineAt - now()),
    researchRemainingMs: (): number => Math.max(0, researchDeadlineAt - now()),
    close,
  };
}

/**
 * Resolve a dependency result before a deadline, even when the dependency
 * ignores its AbortSignal. The original promise is still observed, so a late
 * rejection cannot become an unhandled rejection after the report has ended.
 */
export function raceWithReportDeadline<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
  phase: ReportBudgetPhase,
): Promise<T> {
  if (signal.aborted) {
    // The operation may already have been started by the caller. Observe it
    // even when the deadline has fired so a late rejection is not unhandled.
    Promise.resolve(operation).catch((): void => undefined);
    return Promise.reject(new ReportDeadlineExceededError(phase));
  }
  return new Promise<T>((resolve, reject): void => {
    let settled = false;
    const finish = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      finish();
      reject(new ReportDeadlineExceededError(phase));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value: T): void => {
        if (settled) return;
        settled = true;
        finish();
        resolve(value);
      },
      (error: unknown): void => {
        if (settled) return;
        settled = true;
        finish();
        reject(error);
      },
    );
  });
}

export function isReportDeadlineExceeded(error: unknown): error is ReportDeadlineExceededError {
  return error instanceof ReportDeadlineExceededError;
}

function validateDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}
