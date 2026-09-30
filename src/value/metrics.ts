import type { OddsMatch, OddsReport } from "../odds/contracts.js";
import type { Match } from "../schemas/match.js";
import type {
  ValueAverageSummary,
  ValueCardStatus,
  ValueCheckoutSummary,
  ValueMatchCard,
  ValueMetricStatus,
  ValueOddsObservation,
  ValueOneEightiesSummary,
  ValuePlayerAssessment,
  ValueReport,
  ValueReportCounts,
  ValueSourceCoverage,
  ValueWindowSummary,
} from "./contracts.js";

export const UNKNOWN_CONTEXT = { stage: null, format: null, status: "unknown" as const };

export function cardFrom(match: OddsMatch, player1: ValuePlayerAssessment, player2: ValuePlayerAssessment): ValueMatchCard {
  const players: readonly [ValuePlayerAssessment, ValuePlayerAssessment] = [player1, player2];
  return { match, players, player1, player2, status: cardStatus(player1, player2), context: UNKNOWN_CONTEXT };
}

function cardStatus(first: ValuePlayerAssessment, second: ValuePlayerAssessment): ValueCardStatus {
  const statuses = [first.status, second.status];
  if (statuses.includes("cancelled")) return "cancelled";
  if (statuses.includes("timed_out")) return "timed_out";
  if (statuses.includes("unresolved")) return "unresolved";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("partial")) return "partial";
  return "complete";
}

export function summarizeWindow(history: readonly Match[], requestedMatches: 10 | 20): ValueWindowSummary {
  const matches = history.slice(0, requestedMatches);
  const averages = matches
    .filter((match: Match): match is Match & { readonly average: number } => typeof match.average === "number" && Number.isFinite(match.average))
    .map((match): number => match.average);
  const oneEightiesValues = matches
    .filter((match: Match): match is Match & { readonly oneEighties: number } => typeof match.oneEighties === "number")
    .map((match): number => match.oneEighties);
  const checkoutRows = matches.filter((match: Match): boolean => match.checkoutHits !== null && match.checkoutHits !== undefined && match.checkoutAttempts !== null && match.checkoutAttempts !== undefined);
  const checkoutHits = checkoutRows.reduce((sum: number, match: Match): number => sum + (match.checkoutHits ?? 0), 0);
  const checkoutAttempts = checkoutRows.reduce((sum: number, match: Match): number => sum + (match.checkoutAttempts ?? 0), 0);
  return {
    window: requestedMatches,
    requestedMatches,
    matchCount: matches.length,
    average: averageSummary(averages, matches.length),
    oneEighties: oneEightiesSummary(oneEightiesValues, matches.length),
    checkout: checkoutSummary(checkoutRows.length, matches.length, checkoutHits, checkoutAttempts, checkoutRows.filter((match: Match): boolean => match.checkoutAttempts === 0).length),
  };
}

export function windowMetricsAvailable(summary: ValueWindowSummary): boolean {
  return summary.average.coverage.status === "available"
    && summary.average.value !== null
    && summary.oneEighties.coverage.status === "available"
    && summary.checkout.coverage.status === "available"
    && summary.checkout.percentage !== null;
}

function averageSummary(values: readonly number[], total: number): ValueAverageSummary {
  return { value: values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length), coverage: coverage(values.length, total) };
}

function oneEightiesSummary(values: readonly number[], total: number): ValueOneEightiesSummary {
  return { total: total > 0 && values.length === total ? values.reduce((sum, value) => sum + value, 0) : null, average: values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length), coverage: coverage(values.length, total) };
}

function checkoutSummary(available: number, total: number, hits: number, attempts: number, zeroAttemptMatches: number): ValueCheckoutSummary {
  return { hits: available === 0 ? null : hits, attempts: available === 0 ? null : attempts, percentage: available === 0 || attempts === 0 ? null : round((hits / attempts) * 100), zeroAttemptMatches, coverage: coverage(available, total) };
}

function coverage(available: number, total: number): ValueSourceCoverage {
  const status: ValueMetricStatus = available === 0 ? "unavailable" : available === total ? "available" : "partial";
  return { available, total, ratio: total === 0 ? 0 : round(available / total), status };
}

export function completedNewestFirst(matches: readonly Match[], cutoffDate?: string): readonly Match[] {
  const seen = new Set<string>();
  return matches
    .filter((match: Match): boolean => {
      const result = match.result.trim().toLocaleLowerCase("en-US");
      if (!COMPLETED_RESULTS.has(result) || !isIsoDate(match.date) || (cutoffDate !== undefined && match.date > cutoffDate)) return false;
      const key = [match.date, match.tournament, match.round ?? "", result, match.opponent, match.score].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((match: Match, index: number): { readonly match: Match; readonly index: number } => ({ match, index }))
    .sort((left, right): number => right.match.date.localeCompare(left.match.date) || left.index - right.index)
    .map(({ match }): Match => match);
}

const COMPLETED_RESULTS = new Set(["won", "win", "w", "lost", "loss", "l", "draw", "drawn", "d"]);

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function observationFromOdds(odds: OddsReport): ValueOddsObservation {
  return { source: odds.source, sourceUrl: odds.sourceUrl, observedAt: odds.observedAt, date: odds.date, timeZone: odds.timeZone, warnings: odds.warnings, matchCount: odds.matches.length };
}

export function uniqueRequestedNames(matches: readonly OddsMatch[]): readonly string[] {
  const names = new Set<string>();
  for (const match of matches) { names.add(match.player1); names.add(match.player2); }
  return [...names];
}

export function countsFromCards(cards: readonly ValueMatchCard[]): ValueReportCounts {
  let completeCards = 0;
  let partialCards = 0;
  let unresolvedCards = 0;
  let timedOutCards = 0;
  let cancelledCards = 0;
  let failedCards = 0;
  const identities = new Set<number>();
  let unresolvedPlayers = 0;
  for (const card of cards) {
    if (card.status === "complete") completeCards += 1;
    else if (card.status === "partial") partialCards += 1;
    else if (card.status === "unresolved") unresolvedCards += 1;
    else if (card.status === "timed_out") timedOutCards += 1;
    else if (card.status === "cancelled") cancelledCards += 1;
    else failedCards += 1;
    for (const player of card.players) {
      if (player.identity === null) unresolvedPlayers += 1;
      else identities.add(player.identity.id);
    }
  }
  return { oddsMatches: cards.length, cards: cards.length, completeCards, partialCards, unresolvedCards, timedOutCards, cancelledCards, failedCards, resolvedPlayers: identities.size, unresolvedPlayers };
}

export function emptyCounts(): ValueReportCounts { return { oddsMatches: 0, cards: 0, completeCards: 0, partialCards: 0, unresolvedCards: 0, timedOutCards: 0, cancelledCards: 0, failedCards: 0, resolvedPlayers: 0, unresolvedPlayers: 0 }; }

export function reportStatus(cards: readonly ValueMatchCard[], signal: AbortSignal | undefined): ValueReport["status"] {
  if (signal?.aborted === true) return "partial";
  if (cards.every((card: ValueMatchCard): boolean => card.status === "complete")) return "complete";
  return "partial";
}

function round(value: number): number { return Number(value.toFixed(2)); }
