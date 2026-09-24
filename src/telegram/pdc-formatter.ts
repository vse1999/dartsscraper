import type { PdcTournamentResult } from "../pdc/schemas.js";
import type { PdcFixture } from "../pdc/schemas.js";
import type { PdcUpcomingReport } from "../pdc/service.js";
import { normalizePlayerName } from "../player/resolver.js";
import { formatPlayerStats, TELEGRAM_MAX_TEXT_LENGTH } from "./formatter.js";
import { formatPdcMatchupMessages } from "./pdc-matchup-formatter.js";

const MAX_BODY_LENGTH = TELEGRAM_MAX_TEXT_LENGTH - 200;

export function formatPdcUpcomingMessages(report: PdcUpcomingReport): readonly string[] {
  const messages: string[] = [...formatPdcMatchupMessages(report)];
  if (report.fixtures.length === 0) return messages;
  for (const player of report.players) {
    const scheduled = report.fixtures.filter((fixture) => (
      normalizePlayerName(fixture.playerOne) === normalizePlayerName(player.requestedName)
      || normalizePlayerName(fixture.playerTwo) === normalizePlayerName(player.requestedName)
    ));
    const schedule = scheduled.map((fixture) => opponentLabel(fixture, player.requestedName)).join(" · ");
    const prefix = `📅 Scheduled: ${schedule === "" ? player.requestedName : schedule}`;
    if (player.stats === null) {
      const reason = player.failureCode === "timeout"
        ? "timed out at the research deadline"
        : player.failureCode === "unstarted"
          ? "was skipped because the research deadline was reached before this lookup started"
          : "could not be loaded";
      messages.push(`${prefix}\n⚠️ Last-10 form ${reason} for ${player.requestedName}.`);
      continue;
    }
    const body = formatPlayerStats(player.stats);
    const combined = `${prefix}\n\n${body}`;
    if (combined.length <= TELEGRAM_MAX_TEXT_LENGTH) messages.push(combined);
    else messages.push(prefix, body);
  }
  return messages;
}

export function formatPdcTournamentMessages(
  date: string,
  results: readonly PdcTournamentResult[],
  latest: boolean,
): readonly string[] {
  if (results.length === 0) {
    return [latest
      ? `🎯 PDC LATEST · ${date}\nNo completed PDC tournament was found on or before ${date}.`
      : `🎯 PDC ${date}\nNo completed PDC tournament was found for this date.`];
  }

  const messages: string[] = [];
  let current = header(date, results, latest);
  for (const result of results) {
    const section = formatTournament(result);
    const candidate = `${current}\n\n${section}`;
    if (current !== header(date, results, latest) && candidate.length > MAX_BODY_LENGTH) {
      messages.push(current);
      current = continuationHeader(date);
    }
    current = `${current}\n\n${section}`;
  }
  messages.push(current);
  return messages;
}

function header(date: string, results: readonly PdcTournamentResult[], latest: boolean): string {
  return [
    `🎯 PDC ${latest ? "LATEST" : "RESULTS"} · ${date}`,
    `${results.length} tournament${results.length === 1 ? "" : "s"} found`,
    "Scores and rounds are from DartsOrakel's PDC event results.",
  ].join("\n");
}
function continuationHeader(date: string): string {
  return `🎯 PDC RESULTS · ${date} · continued`;
}

function formatTournament(result: PdcTournamentResult): string {
  const event = result.event;
  const title = event.tournamentNumber === 0 ? event.tournamentName : `${event.tournamentName} ${event.tournamentNumber}`;
  const winner = event.winnerName === null ? "Winner unavailable" : `Winner: ${event.winnerName}`;
  const average = event.eventAverage === null ? "—" : event.eventAverage.toFixed(2);
  const rows = result.matches.map((match) => {
    const round = match.round ?? "Match";
    return `${round}: ${match.winnerName} ${match.winnerScore}–${match.loserScore} ${match.loserName}`;
  });
  return [
    `${title} · ${event.eventDate}`,
    winner,
    `Event average: ${average} · ${result.matches.length} matches`,
    ...rows,
    `Source: ${result.sourceUrl}`,
  ].join("\n");
}

function opponentLabel(fixture: PdcFixture, playerName: string): string {
  const normalized = normalizePlayerName(playerName);
  const opponent = normalizePlayerName(fixture.playerOne) === normalized ? fixture.playerTwo : fixture.playerOne;
  return `${fixture.tournamentName}: ${playerName} vs ${opponent}`;
}
