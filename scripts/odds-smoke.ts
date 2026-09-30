import { createDefaultOddsReader } from "../src/odds/default.js";
import type { OddsDay } from "../src/odds/contracts.js";

const rawDay = process.argv[2] ?? "today";
if (rawDay !== "today" && rawDay !== "tomorrow") {
  throw new Error("Usage: tsx scripts/odds-smoke.ts [today|tomorrow].");
}
const day: OddsDay = rawDay;
const reader = createDefaultOddsReader({
  ...(process.env.ODDS_BROWSER_EXECUTABLE_PATH === undefined ? {} : { executablePath: process.env.ODDS_BROWSER_EXECUTABLE_PATH }),
});
const report = await reader.getOdds(day);
console.log(JSON.stringify({
  source: report.source,
  sourceUrl: report.sourceUrl,
  observedAt: report.observedAt,
  date: report.date,
  timeZone: report.timeZone,
  matchCount: report.matches.length,
  warningCount: report.warnings.length,
  warnings: report.warnings.slice(0, 5),
  samples: report.matches.slice(0, 3).map((match) => ({
    eventId: match.eventId,
    competition: match.competition,
    player1: match.player1,
    player2: match.player2,
    scheduledTime: match.scheduledTime,
    odds1: match.odds1,
    odds2: match.odds2,
    bookmaker: match.bookmaker,
  })),
}, null, 2));
