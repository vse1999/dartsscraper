import type { MatchResult } from "../schemas/match.js";
import { calculateMatchSummary } from "../services/statistics.js";

export function formatPlayerCliJson(result: MatchResult): string {
  return JSON.stringify({ ...result, summary: calculateMatchSummary(result.matches) }, null, 2);
}

export function formatPlayerCliText(result: MatchResult, requestedLimit: number): string {
  const summary = calculateMatchSummary(result.matches);
  const lines = [
    result.player.name,
    "",
    `Last ${result.matches.length} matches:`,
    ...(result.matches.length === requestedLimit ? [] : [`Requested ${requestedLimit}; found ${result.matches.length}.`]),
    `Record: ${summary.wins}W–${summary.losses}L–${summary.draws}D`,
    "",
    ...result.matches.map((match) => `${match.date} ${match.result} ${match.score} vs ${match.opponent}   Avg ${formatAverage(match.average)} · 180s ${formatInteger(match.oneEighties)} · Checkout ${formatPercentage(match.checkoutPercentage)}`),
    "",
    `Mean match average: ${summary.average === null ? "N/A" : summary.average.toFixed(2)}`,
    `Best match average: ${summary.bestAverage === null ? "N/A" : summary.bestAverage.toFixed(2)}`,
    `Total 180s: ${formatInteger(summary.totalOneEighties)}`,
    `Checkout: ${summary.checkoutPercentage === null ? "N/A" : `${summary.checkoutPercentage.toFixed(2)}% (${summary.checkoutHits}/${summary.checkoutAttempts})`}`,
    `Coverage (average/180s/checkout): ${summary.availableAverageCount}/${summary.matchCount} · ${summary.availableOneEightiesCount}/${summary.matchCount} · ${summary.availableCheckoutCount}/${summary.matchCount}`,
  ];
  return lines.join("\n");
}

function formatAverage(average: number | null): string {
  return average === null ? "—" : average.toFixed(2);
}

function formatInteger(value: number | null | undefined): string {
  return value === null || value === undefined ? "N/A" : String(value);
}

function formatPercentage(value: number | null | undefined): string {
  return value === null || value === undefined ? "N/A" : `${value.toFixed(2)}%`;
}
