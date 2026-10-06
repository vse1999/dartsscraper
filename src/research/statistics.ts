import type { Match } from "../schemas/match.js";
import { calculateMatchSummary, type MatchSummary } from "../services/statistics.js";
import { inspectResearchOrdering } from "./quality.js";

export interface ResearchWindowSummary {
  readonly matchCount: number;
  readonly summary: MatchSummary;
  readonly dateSpan: { readonly oldest: string; readonly newest: string; readonly days: number } | null;
  readonly medianAverage: number | null;
  readonly sampleStandardDeviation: number | null;
  /** Removing one extreme observation at a time: a sensitivity check, not an outlier diagnosis. */
  readonly meanWithoutLowest: number | null;
  readonly meanWithoutHighest: number | null;
  readonly oneEightiesPerLeg: number | null;
  readonly pairedLegs: number;
  readonly pairedOneEighties: number;
  readonly pairedLegMatchCount: number;
}

export interface ResearchHistorySummary {
  readonly version: 1;
  readonly latest10: ResearchWindowSummary;
  readonly previous10: ResearchWindowSummary;
  readonly averageDelta: number | null;
  readonly warnings: readonly string[];
}

/** Input is validated provider order (newest first); date-only ties are never reordered. */
export function summarizeResearchHistory(matches: readonly Match[]): ResearchHistorySummary {
  const latest10 = summarizeResearchWindow(matches.slice(0, 10));
  const previous10 = summarizeResearchWindow(matches.slice(10, 20));
  const warnings: string[] = [
    "Mean is an arithmetic mean of available match averages, not a pooled scoring average.",
    "Match format and source-update freshness are unknown; collection time is not source-update time.",
  ];
  const selected = matches.slice(0, 20);
  const dates = new Set<string>();
  if (selected.some((match: Match): boolean => {
    if (dates.has(match.date)) return true;
    dates.add(match.date);
    return false;
  })) warnings.push("Date-only same-day ordering may be ambiguous; source order is retained.");
  if (selected.some((match: Match, index: number): boolean => index > 0 && match.date > (selected[index - 1]?.date ?? match.date))) {
    warnings.push("Source date order is inconsistent; latest/previous windows may not be chronological.");
  }
  if (latest10.matchCount < 10 || previous10.matchCount < 10) warnings.push("Disjoint latest-10/previous-10 comparison lacks a complete 20-match history.");
  if (latest10.summary.availableAverageCount < latest10.matchCount || previous10.summary.availableAverageCount < previous10.matchCount) {
    warnings.push("Missing averages are excluded, not replaced with zero.");
  }
  return {
    version: 1,
    latest10,
    previous10,
    averageDelta: inspectResearchOrdering(selected, 10).chronological && latest10.matchCount === 10 && previous10.matchCount === 10
      && latest10.summary.availableAverageCount === 10 && previous10.summary.availableAverageCount === 10
      && latest10.summary.average !== null && previous10.summary.average !== null
      ? round(latest10.summary.average - previous10.summary.average) : null,
    warnings,
  };
}

export function summarizeResearchWindow(matches: readonly Match[]): ResearchWindowSummary {
  const averages = matches.map((match: Match): number | null => match.average)
    .filter((value: number | null): value is number => value !== null && Number.isFinite(value))
    .sort((first: number, second: number): number => first - second);
  const mean = averages.length === 0 ? null : averages.reduce((sum: number, value: number): number => sum + value, 0) / averages.length;
  const middle = Math.floor(averages.length / 2);
  const median = averages.length === 0 ? null : averages.length % 2 === 1
    ? averages[middle] ?? null : ((averages[middle - 1] ?? 0) + (averages[middle] ?? 0)) / 2;
  const dates = matches.map((match: Match): string => match.date).sort();
  const oldest = dates[0];
  const newest = dates[dates.length - 1];
  let pairedLegs = 0;
  let pairedOneEighties = 0;
  let pairedLegMatchCount = 0;
  for (const match of matches) {
    const legs = match.legsPlayed;
    if (legs !== undefined && legs !== null && Number.isInteger(legs) && legs > 0
      && match.oneEighties !== undefined && match.oneEighties !== null) {
      pairedLegs += legs;
      pairedOneEighties += match.oneEighties;
      pairedLegMatchCount += 1;
    }
  }
  return {
    matchCount: matches.length,
    summary: calculateMatchSummary(matches),
    dateSpan: oldest === undefined || newest === undefined ? null : {
      oldest, newest, days: Math.round((Date.parse(newest) - Date.parse(oldest)) / 86_400_000),
    },
    medianAverage: median === null ? null : round(median),
    sampleStandardDeviation: mean === null || averages.length < 2 ? null
      : round(Math.sqrt(averages.reduce((sum: number, value: number): number => sum + (value - mean) ** 2, 0) / (averages.length - 1))),
    meanWithoutLowest: averages.length < 3 ? null : arithmeticMean(averages.slice(1)),
    meanWithoutHighest: averages.length < 3 ? null : arithmeticMean(averages.slice(0, -1)),
    oneEightiesPerLeg: pairedLegs === 0 ? null : round(pairedOneEighties / pairedLegs),
    pairedLegs, pairedOneEighties, pairedLegMatchCount,
  };
}

function arithmeticMean(values: readonly number[]): number | null {
  return values.length === 0 ? null : round(values.reduce((sum: number, value: number): number => sum + value, 0) / values.length);
}

function round(value: number): number { return Number(value.toFixed(2)); }
