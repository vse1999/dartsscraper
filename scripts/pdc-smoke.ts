import { resolveResearchDate } from "../src/agent/date.js";
import { createJinaReaderFetch } from "../src/dartsorakel/reader-fetch.js";
import { DartsOrakelPdcSource } from "../src/pdc/source.js";
import { PdcTournamentService } from "../src/pdc/service.js";
import { formatPdcTournamentMessages } from "../src/telegram/pdc-formatter.js";
import { TELEGRAM_MAX_TEXT_LENGTH } from "../src/telegram/formatter.js";

const date = resolveResearchDate("today", { timeZone: "Europe/Budapest" }).date;
const service = new PdcTournamentService({
  source: new DartsOrakelPdcSource({ fetchImpl: createJinaReaderFetch() }),
});

const results = await service.getLatestResults(date);
if (results.length === 0) {
  throw new Error(`PDC smoke test found no completed tournament on or before ${date}.`);
}

const matchCount = results.reduce((total, result) => total + result.matches.length, 0);
if (matchCount === 0) throw new Error("PDC smoke test returned no matches.");
const telegramMessages = formatPdcTournamentMessages(date, results, true);
if (telegramMessages.some((message) => message.length > TELEGRAM_MAX_TEXT_LENGTH)) {
  throw new Error("PDC smoke Telegram output exceeded Telegram's message limit.");
}

for (const result of results) {
  const sourceUrl = new URL(result.sourceUrl);
  if (sourceUrl.protocol !== "https:" || sourceUrl.host !== "dartsorakel.com") {
    throw new Error(`PDC smoke test returned an untrusted source URL: ${result.sourceUrl}`);
  }
}

process.stdout.write(`${JSON.stringify({
  status: "passed",
  date,
  tournaments: results.map((result) => ({
    name: result.event.tournamentNumber === 0
      ? result.event.tournamentName
      : `${result.event.tournamentName} ${result.event.tournamentNumber}`,
    eventDate: result.event.eventDate,
    winner: result.event.winnerName,
    matches: result.matches.length,
    sourceUrl: result.sourceUrl,
  })),
  matchCount,
  telegramMessages: telegramMessages.length,
  longestTelegramMessage: Math.max(...telegramMessages.map((message) => message.length)),
})}\n`);
