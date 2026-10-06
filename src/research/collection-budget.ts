import { createReportBudget, type ReportBudget } from "../daily/report-budget.js";
import { throwIfAborted } from "../services/cancellation.js";

export interface CollectionBudgetOptions {
  readonly budgetMs?: number;
  readonly finalReserveMs?: number;
  readonly elapsedNow?: () => number;
  readonly signal?: AbortSignal;
}

export interface CollectionBudget {
  readonly workSignal: AbortSignal;
  readonly totalSignal: AbortSignal;
  remainingMs(): number;
  workRemainingMs(): number;
  close(): void;
}

/** A supplied budget never overrides an independently supplied owner's cancellation. */
export function bindCollectionCancellation(budget: CollectionBudget, signal: AbortSignal | undefined): CollectionBudget {
  if (signal === undefined) return budget;
  return { workSignal: AbortSignal.any([budget.workSignal, signal]), totalSignal: AbortSignal.any([budget.totalSignal, signal]),
    remainingMs: (): number => budget.remainingMs(), workRemainingMs: (): number => budget.workRemainingMs(), close: (): void => budget.close() };
}

/** One monotonic budget from preflight through output, separate from evidence wall time. */
export function createCollectionBudget(options: CollectionBudgetOptions = {}): CollectionBudget {
  throwIfAborted(options.signal);
  const total = options.budgetMs ?? 220_000;
  if (!Number.isSafeInteger(total) || total < 2 || total > 300_000) {
    throw new Error("Research collection budget must be between 2 and 300000 milliseconds.");
  }
  const reserve = options.finalReserveMs ?? Math.min(5_000, Math.max(1, Math.floor(total / 10)));
  if (!Number.isSafeInteger(reserve) || reserve < 1 || reserve >= total) {
    throw new Error("Final collection reserve must be positive and smaller than the total budget.");
  }
  const elapsedNow = options.elapsedNow ?? ((): number => performance.now());
  const checkedNow = (): number => {
    const value = elapsedNow();
    if (!Number.isFinite(value)) throw new Error("Collection elapsed clock must be finite.");
    return value;
  };
  const budget: ReportBudget = createReportBudget({ totalMs: total, researchMs: total - reserve, now: checkedNow });
  return bindCollectionCancellation({
    workSignal: AbortSignal.any([budget.researchSignal, budget.totalSignal]),
    totalSignal: budget.totalSignal,
    remainingMs: (): number => budget.remainingMs(),
    workRemainingMs: (): number => budget.researchRemainingMs(),
    close: (): void => budget.close(),
  }, options.signal);
}
