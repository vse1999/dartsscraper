import { createDefaultValueReader } from "../src/value/reader.js";
import type { OddsDay } from "../src/odds/contracts.js";
import type { ValueWindowSummary } from "../src/value/contracts.js";

const startedAt = Date.now();
const reader = createDefaultValueReader({ researchBudgetMs: 210_000 });
const controller = new AbortController();
const dayArg = process.argv[2] ?? "today";
if (dayArg !== "today" && dayArg !== "tomorrow") {
  console.error(JSON.stringify({ status: "invalid", error: "Usage: tsx scripts/value-smoke.ts [today|tomorrow]" }));
  process.exit(2);
}
const requestedDay: OddsDay = dayArg;
try {
  const report = await reader.getReport(requestedDay, controller.signal);
  const elapsedMs = Date.now() - startedAt;
  const samples = report.cards.slice(0, 3).map((card) => ({
    odds: { player1: card.match.player1, odds1: card.match.odds1, player2: card.match.player2, odds2: card.match.odds2 },
    status: card.status,
    players: card.players.map((player) => ({
      requestedName: player.requestedName,
      canonicalName: player.canonicalName,
      status: player.status,
      last10: summarySample(player.last10),
      last20: summarySample(player.last20),
    })),
  }));
  const verifiedComparison = report.cards.some((card) => card.status === "complete");
  console.log(JSON.stringify({
    day: requestedDay,
    source: report.odds.source,
    observedAt: report.odds.observedAt,
    date: report.odds.date,
    oddsMatches: report.odds.matchCount,
    status: report.status,
    counts: report.counts,
    elapsedMs,
    proof: verifiedComparison ? "verified_comparison_sample" : "no_verified_comparison_sample",
    samples,
  }, null, 2));
} catch (error: unknown) {
  const elapsedMs = Date.now() - startedAt;
  const message = error instanceof Error ? error.message : "Unexpected value smoke failure.";
  console.error(JSON.stringify({ status: "failed", elapsedMs, error: message }));
  process.exitCode = 1;
}

function summarySample(summary: ValueWindowSummary | null): object | null {
  if (summary === null) return null;
  return {
    matches: summary.matchCount,
    average: { value: summary.average.value, coverage: summary.average.coverage },
    oneEighties: { total: summary.oneEighties.total, coverage: summary.oneEighties.coverage },
    checkout: { percentage: summary.checkout.percentage, hits: summary.checkout.hits, attempts: summary.checkout.attempts, coverage: summary.checkout.coverage },
  };
}
