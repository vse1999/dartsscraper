import type { Match } from "../schemas/match.js";
import { summarizeResearchWindow } from "./statistics.js";

export type CoverageGapCode =
  | "empty-scope"
  | "requested-observed-count-mismatch"
  | "missing-averages"
  | "missing-one-eighties"
  | "checkout-missing-denominator"
  | "checkout-zero-attempts"
  | "checkout-no-positive-attempts"
  | "paired-legs-unavailable"
  | "paired-one-eighties-unavailable";

export interface ResearchCoverageOptions {
  /** Expected row count for this exact scope, when known. */
  readonly requestedRowCount?: number;
}

export interface ResearchCoverageScopes {
  readonly displayed: CoverageDiagnostics;
  readonly latest10: CoverageDiagnostics;
  readonly previous10: CoverageDiagnostics;
}

/** Keep displayed scope separate from the acquired history used for disjoint windows. */
export function diagnoseResearchCoverageScopes(
  rows: readonly Match[],
  requestedRowCount: number,
  displayedRows: readonly Match[] = rows,
): ResearchCoverageScopes {
  return {
    displayed: diagnoseResearchCoverage(displayedRows, { requestedRowCount }),
    latest10: diagnoseResearchCoverage(rows.slice(0, 10), { requestedRowCount: 10 }),
    previous10: diagnoseResearchCoverage(rows.slice(10, 20), { requestedRowCount: 10 }),
  };
}

export interface CoverageRatio {
  readonly availableRows: number;
  readonly missingRows: number;
  /** Available rows divided by observed rows; null for an empty scope. */
  readonly proportion: number | null;
}

export interface CoverageDiagnostics {
  readonly version: 1;
  readonly requestedRowCount: number | null;
  readonly observedRowCount: number;
  /** Observed/requested, or null when the requested denominator is zero or unknown. */
  readonly scopeProportion: number | null;
  readonly scopeCountMatches: boolean | null;
  readonly average: CoverageRatio & { readonly mean: number | null };
  readonly oneEighties: CoverageRatio & { readonly completeTotal: number | null };
  readonly checkout: {
    readonly positiveAttemptRows: number;
    readonly zeroAttemptRows: number;
    readonly missingDenominatorRows: number;
    readonly totalHits: number;
    readonly totalAttempts: number;
    readonly percentage: number | null;
    /** Rows with positive attempts divided by observed rows; null for an empty scope. */
    readonly positiveAttemptProportion: number | null;
  };
  readonly explicitLegs: {
    readonly rowsWithLegs: number;
    readonly rowsWithLegsButMissingOneEighties: number;
    readonly pairedRows: number;
    readonly pairedRowProportion: number | null;
    readonly pairedLegs: number;
    readonly pairedOneEighties: number;
  };
  readonly gaps: readonly CoverageGapCode[];
}

/**
 * Reports the coverage of exactly the supplied rows. Callers can run it for
 * displayed, latest-window, and previous-window rows separately.
 */
export function diagnoseResearchCoverage(
  rows: readonly Match[],
  options: ResearchCoverageOptions = {},
): CoverageDiagnostics {
  const requestedRowCount = options.requestedRowCount;
  if (requestedRowCount !== undefined && (!Number.isSafeInteger(requestedRowCount) || requestedRowCount < 0)) {
    throw new RangeError("Requested research row count must be a non-negative safe integer.");
  }

  // Reuse the existing summary implementation so denominators and rounding
  // stay aligned with the statistics displayed to the user.
  const summary = summarizeResearchWindow(rows);
  const observedRowCount = rows.length;
  const averageAvailable = summary.summary.availableAverageCount;
  const oneEightiesAvailable = summary.summary.availableOneEightiesCount;
  let positiveAttemptRows = 0;
  let zeroAttemptRows = 0;
  let missingDenominatorRows = 0;
  let rowsWithLegs = 0;
  let rowsWithLegsButMissingOneEighties = 0;
  let pairedRows = 0;

  for (const row of rows) {
    const hits = row.checkoutHits;
    const attempts = row.checkoutAttempts;
    if (hits === null || hits === undefined || attempts === null || attempts === undefined) {
      missingDenominatorRows += 1;
    } else if (attempts === 0) {
      zeroAttemptRows += 1;
    } else if (attempts > 0) {
      positiveAttemptRows += 1;
    }

    const hasLegs = row.legsPlayed !== undefined && Number.isInteger(row.legsPlayed) && row.legsPlayed > 0;
    const hasOneEighties = row.oneEighties !== undefined && row.oneEighties !== null;
    if (hasLegs) {
      rowsWithLegs += 1;
      if (hasOneEighties) pairedRows += 1;
      else rowsWithLegsButMissingOneEighties += 1;
    }
  }

  const gaps: CoverageGapCode[] = [];
  if (observedRowCount === 0) gaps.push("empty-scope");
  const scopeCountMatches = requestedRowCount === undefined ? null : requestedRowCount === observedRowCount;
  if (scopeCountMatches === false) gaps.push("requested-observed-count-mismatch");
  if (averageAvailable < observedRowCount) gaps.push("missing-averages");
  if (oneEightiesAvailable < observedRowCount) gaps.push("missing-one-eighties");
  if (missingDenominatorRows > 0) gaps.push("checkout-missing-denominator");
  if (zeroAttemptRows > 0) gaps.push("checkout-zero-attempts");
  if (observedRowCount > 0 && positiveAttemptRows === 0) gaps.push("checkout-no-positive-attempts");
  if (rowsWithLegs === 0) gaps.push("paired-legs-unavailable");
  if (rowsWithLegsButMissingOneEighties > 0 || pairedRows === 0) gaps.push("paired-one-eighties-unavailable");

  return {
    version: 1,
    requestedRowCount: requestedRowCount ?? null,
    observedRowCount,
    scopeProportion: requestedRowCount === undefined ? null : ratio(observedRowCount, requestedRowCount),
    scopeCountMatches,
    average: {
      availableRows: averageAvailable,
      missingRows: observedRowCount - averageAvailable,
      proportion: ratio(averageAvailable, observedRowCount),
      mean: summary.summary.average,
    },
    oneEighties: {
      availableRows: oneEightiesAvailable,
      missingRows: observedRowCount - oneEightiesAvailable,
      proportion: ratio(oneEightiesAvailable, observedRowCount),
      completeTotal: summary.summary.totalOneEighties,
    },
    checkout: {
      positiveAttemptRows,
      zeroAttemptRows,
      missingDenominatorRows,
      totalHits: summary.summary.checkoutHits,
      totalAttempts: summary.summary.checkoutAttempts,
      percentage: summary.summary.checkoutPercentage,
      positiveAttemptProportion: ratio(positiveAttemptRows, observedRowCount),
    },
    explicitLegs: {
      rowsWithLegs,
      rowsWithLegsButMissingOneEighties,
      pairedRows,
      pairedRowProportion: ratio(pairedRows, observedRowCount),
      pairedLegs: summary.pairedLegs,
      pairedOneEighties: summary.pairedOneEighties,
    },
    gaps,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}
