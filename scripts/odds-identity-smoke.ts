import { createDefaultOddsReader } from "../src/odds/default.js";
import type { OddsDay } from "../src/odds/contracts.js";

const rawDay = process.argv[2] ?? "tomorrow";
if (rawDay !== "today" && rawDay !== "tomorrow") throw new Error("Usage: tsx scripts/odds-identity-smoke.ts [today|tomorrow].");
const day: OddsDay = rawDay;
const startedAt = Date.now();
const reader = createDefaultOddsReader({
  ...(process.env.ODDS_BROWSER_EXECUTABLE_PATH === undefined ? {} : { executablePath: process.env.ODDS_BROWSER_EXECUTABLE_PATH }),
});

try {
  const report = await reader.getOdds(day);
  const candidates = report.matches;
  const evidence = candidates.length === 0 ? new Map() : await reader.getIdentityEvidence(candidates, report.date);
  const expectedProof = report.matches.filter((match): boolean => /(?:Smith\s+R\.|Humphries\s+L\.)/iu.test(`${match.player1} ${match.player2}`));
  if (expectedProof.length > 0 && !expectedProof.some((match): boolean => evidence.has(match.eventId))) {
    throw new Error("Expected Smith R. or Humphries L. identity evidence was not verified.");
  }
  console.log(JSON.stringify({
    day,
    date: report.date,
    oddsMatches: report.matches.length,
    identityCandidates: candidates.length,
    verifiedIdentityMatches: evidence.size,
    samples: [...evidence.values()].slice(0, 5).map((item) => ({ eventId: item.eventId, date: item.date, home: item.home, away: item.away })),
    elapsedMs: Date.now() - startedAt,
  }, null, 2));
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected odds identity smoke failure.";
  console.error(JSON.stringify({ status: "failed", elapsedMs: Date.now() - startedAt, error: message }));
  process.exitCode = 1;
}
