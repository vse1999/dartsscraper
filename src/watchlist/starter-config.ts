import type { WatchlistRuleConfig } from "./contracts.js";

/**
 * Provisional, owner-reviewable starter preferences for offline shadow runs.
 * These values are not calibrated probabilities and must be accepted before
 * any live alert activation.
 */
export const WATCHLIST_STARTER_RULES: WatchlistRuleConfig = {
  version: "watchlist-v2-starter-2026-09",
  minimumMatchesByWindow: { 10: 10, 20: 20 },
  minimumMetricCoverage: { average: 1, checkoutRate: 1, oneEightyPerLeg: 0.5 },
  requiredMetrics: ["average", "checkoutRate"],
  superiority: { average: 1, checkoutRate: 0.05, oneEightyPerLeg: 0.05 },
  priceBands: [
    { minInclusive: 1.01, maxExclusive: 1.5, minimumAverageDifference: 3, minimumCheckoutRateDifference: 0.08, minimumOneEightyDifference: 0.08 },
    { minInclusive: 1.5, maxExclusive: 2, minimumAverageDifference: 2, minimumCheckoutRateDifference: 0.06, minimumOneEightyDifference: 0.06 },
    { minInclusive: 2, maxExclusive: 3, minimumAverageDifference: 1.5, minimumCheckoutRateDifference: 0.05, minimumOneEightyDifference: 0.05 },
    // Prices at or above 3.00 are intentionally outside this starter scope.
  ],
  allowedBookmakers: ["tippmixpro", "unibet"],
  allowedSourceIds: ["oddsportal"],
  quoteMaxAgeMs: 120_000,
  historyMaxAgeMs: 86_400_000,
  minimumStartLeadMs: 120_000,
};

export interface StarterScreeningExample {
  readonly name: string;
  readonly decimalPrice: number;
  readonly averageDifference: number;
  readonly checkoutRateDifference: number;
  readonly expectedPass: boolean;
}

/** Boundary examples are illustrative cases, not fitted to force a result. */
export const WATCHLIST_STARTER_EXAMPLES: readonly StarterScreeningExample[] = [
  { name: "owner 1.42 example (15 avg / 5pp checkout)", decimalPrice: 1.42, averageDifference: 15, checkoutRateDifference: 0.05, expectedPass: false },
  { name: "short-price independent pass case", decimalPrice: 1.42, averageDifference: 15, checkoutRateDifference: 0.09, expectedPass: true },
  { name: "owner 1.83 example (8.4 avg / 4pp checkout)", decimalPrice: 1.83, averageDifference: 8.4, checkoutRateDifference: 0.04, expectedPass: false },
  { name: "mid-price independent pass case", decimalPrice: 1.83, averageDifference: 8.4, checkoutRateDifference: 0.07, expectedPass: true },
];
