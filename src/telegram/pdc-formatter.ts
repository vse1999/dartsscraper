import type { PdcTournamentResult } from "../pdc/schemas.js";
import type { PdcFixture, PdcScheduleSnapshot } from "../pdc/schemas.js";
import type { PdcUpcomingReport } from "../pdc/service.js";
import { normalizePlayerName } from "../player/resolver.js";
import { formatPlayerStats, TELEGRAM_MAX_TEXT_LENGTH } from "./formatter.js";
import { formatPdcMatchupMessages } from "./pdc-matchup-formatter.js";

const MAX_BODY_LENGTH = TELEGRAM_MAX_TEXT_LENGTH - 200;

export function formatPdcSchedulePreviewMessages(snapshot: PdcScheduleSnapshot): readonly string[] {
  const fixtures = snapshot.events.flatMap((event) => event.fixtures);
  const header = [
    `🎯 PDC SCHEDULE · ${snapshot.date}`,
    snapshot.calendarStatus === "verified"
      ? `Calendar validated · ${fixtures.length} named matchup${fixtures.length === 1 ? "" : "s"}`
      : "Calendar verification unavailable · any listed matchups are partial source evidence, not a complete slate",
  ];
  const lines: string[] = [];
  let fixtureIndex = 0;
  if (snapshot.events.length === 0 && snapshot.calendarStatus === "verified") {
    lines.push("No scheduled matchups were found in the validated PDC calendar scope.");
  }
  for (const event of snapshot.events) {
    const eventName = safeLabel(event.name, 120);
    if (event.coverage === "available") {
      lines.push(`${eventName} · ${event.fixtures.length} named matchup${event.fixtures.length === 1 ? "" : "s"} · validated`);
    } else if (event.coverage === "opponents_pending") {
      lines.push(`${eventName} · ${event.pendingSlots ?? "Unknown"} opponent slot${event.pendingSlots === 1 ? "" : "s"} pending · no history requested`);
    } else if (event.coverage === "partial") {
      const pending = event.pendingSlots === null ? "coverage gap unknown" : `${event.pendingSlots} opponent slot${event.pendingSlots === 1 ? "" : "s"} pending`;
      lines.push(`${eventName} · ${event.fixtures.length} named matchup${event.fixtures.length === 1 ? "" : "s"} · partial, ${pending}`);
    } else {
      lines.push(`${eventName} · schedule verification unavailable; no conclusion that the draw is unpublished`);
    }
    for (const fixture of event.fixtures) {
      fixtureIndex += 1;
      lines.push(`${fixtureIndex}. ${safeLabel(fixture.round ?? "Match", 48)} · ${safeLabel(fixture.playerOne, 72)} vs ${safeLabel(fixture.playerTwo, 72)}`);
    }
  }
  return splitScheduleLines(header, lines);
}

export function formatPdcUpcomingMessages(report: PdcUpcomingReport): readonly string[] {
  if (report.fixtures.length === 0 && report.schedule !== undefined) {
    const unresolved = report.schedule.events.some((event) => event.coverage !== "available");
    if (report.schedule.calendarStatus !== "verified" || unresolved) {
      return [`🎯 PDC · ${report.date}\nSchedule coverage remains unresolved. No complete-empty-day claim or player-history request was made.`];
    }
  }
  const messages: string[] = [...formatPdcMatchupMessages(report)];
  if (report.schedule !== undefined) {
    const unresolved = report.schedule.events.filter((event) => event.coverage !== "available");
    if (report.schedule.calendarStatus !== "verified" || unresolved.length > 0) {
      messages.unshift(
        report.schedule.calendarStatus !== "verified"
          ? "⚠️ PDC calendar verification was unavailable; source-backed pairings are not a complete-slate claim."
          : `⚠️ PDC schedule coverage is partial for ${unresolved.map((event) => safeLabel(event.name, 80)).join(" · ")}.`,
      );
    }
  }
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

function splitScheduleLines(header: readonly string[], lines: readonly string[]): readonly string[] {
  const messages: string[] = [];
  let currentLines = [...header];
  const maximumLength = TELEGRAM_MAX_TEXT_LENGTH - 80;
  for (const line of lines) {
    const candidate = [...currentLines, line].join("\n");
    if (candidate.length > maximumLength && currentLines.length > header.length) {
      messages.push(currentLines.join("\n"));
      currentLines = [header[0] ?? "🎯 PDC SCHEDULE", "continued"];
    }
    currentLines.push(line);
  }
  if (currentLines.length > header.length) messages.push(currentLines.join("\n"));
  if (messages.length === 0) messages.push(header.join("\n"));
  if (messages.some((message) => message.length > TELEGRAM_MAX_TEXT_LENGTH)) throw new Error("A PDC schedule preview exceeds Telegram's message limit.");
  return messages;
}

function safeLabel(value: string, maximumLength: number): string {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized.length <= maximumLength ? normalized : `${normalized.slice(0, maximumLength - 1)}…`;
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
