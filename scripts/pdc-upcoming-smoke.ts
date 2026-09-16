import { resolveResearchDate } from "../src/agent/date.js";
import { ConsoleLogger } from "../src/logger.js";
import { createDefaultPdcTournamentService } from "../src/pdc/default.js";
import { normalizePlayerName } from "../src/player/resolver.js";
import { formatPdcUpcomingMessages } from "../src/telegram/pdc-formatter.js";
import { createDefaultBulkPlayerStatsService } from "../src/telegram/stats-service.js";
import { TELEGRAM_MAX_TEXT_LENGTH } from "../src/telegram/formatter.js";

const logger = new ConsoleLogger({ minimumLevel: "warn" });
const date = resolveResearchDate("tomorrow", { timeZone: "Europe/Budapest" }).date;
const playerStats = createDefaultBulkPlayerStatsService(logger);
const service = createDefaultPdcTournamentService(logger, playerStats);
const report = await service.getUpcomingReportForDate(date);

if (report.fixtures.length === 0) throw new Error(`No PDC fixtures were discovered for ${date}.`);
const uncorroboratedFixtures = report.fixtures.filter((fixture) => (fixture.evidenceUrls?.length ?? 0) < 2);
if (uncorroboratedFixtures.length > 0) {
  throw new Error(`Live corroboration was missing for ${uncorroboratedFixtures.length} PDC fixture(s).`);
}
const scheduledPlayers = new Set(report.fixtures.flatMap((fixture) => (
  [normalizePlayerName(fixture.playerOne), normalizePlayerName(fixture.playerTwo)]
)));
if (report.players.length !== scheduledPlayers.size) {
  throw new Error(`Expected ${scheduledPlayers.size} unique researched players, received ${report.players.length}.`);
}
const failedPlayers = report.players.filter((player) => player.stats === null);
if (failedPlayers.length > 0) {
  throw new Error(`Player form failed for: ${failedPlayers.map((player) => player.requestedName).join(", ")}.`);
}
const emptyPlayers = report.players.filter((player) => player.stats?.matches.length === 0);
if (emptyPlayers.length > 0) {
  throw new Error(`No completed match history was returned for: ${emptyPlayers.map((player) => player.requestedName).join(", ")}.`);
}
const messages = formatPdcUpcomingMessages(report);
if (messages.some((message) => message.length > TELEGRAM_MAX_TEXT_LENGTH)) {
  throw new Error("Upcoming PDC Telegram output exceeded Telegram's message limit.");
}

process.stdout.write(`${JSON.stringify({
  status: "passed",
  date,
  fixtures: report.fixtures.map((fixture) => ({
    tournament: fixture.tournamentName,
    playerOne: fixture.playerOne,
    playerTwo: fixture.playerTwo,
    sourceUrl: fixture.sourceUrl,
    evidenceUrls: fixture.evidenceUrls,
  })),
  players: report.players.map((player) => ({
    requestedName: player.requestedName,
    resolvedName: player.stats?.playerName,
    matches: player.stats?.matches.length,
    sourceUrl: player.stats?.sourceUrl,
  })),
  telegramMessages: messages.length,
  longestTelegramMessage: Math.max(...messages.map((message) => message.length)),
})}\n`);
