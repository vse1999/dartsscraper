import { resolveResearchDate } from "../src/agent/date.js";
import { ReportDeadlineExceededError } from "../src/daily/report-budget.js";
import { ConsoleLogger } from "../src/logger.js";
import { createDefaultPdcTournamentService } from "../src/pdc/default.js";
import { createDefaultBulkPlayerStatsService } from "../src/telegram/stats-service.js";

// Read-only production-path diagnostic. No Telegram sends or credentials needed.
const date = resolveResearchDate(process.argv[2] ?? "today", { timeZone: "Europe/Budapest" }).date;
const logger = new ConsoleLogger({ minimumLevel: "warn" });
const service = createDefaultPdcTournamentService(logger, createDefaultBulkPlayerStatsService(logger));
const controller = new AbortController();
const timer = setTimeout((): void => controller.abort(new ReportDeadlineExceededError("research")), 220_000);
const started = performance.now();
try {
  const report = await service.getUpcomingReportForDate(date, controller.signal);
  const players = report.players.map((player) => ({
    requestedName: player.requestedName,
    canonicalName: player.stats?.playerName ?? null,
    available: player.stats !== null && player.stats.matches.length > 0,
    rows: player.stats?.matches.length ?? 0,
    averageRows: player.stats?.availableAverageCount ?? 0,
    oneEightiesRows: player.stats?.matches.filter((match) => match.oneEighties !== undefined).length ?? 0,
    checkoutRows: player.stats?.matches.filter((match) => match.checkoutHits !== undefined && match.checkoutAttempts !== undefined).length ?? 0,
    failureCode: player.failureCode,
  }));
  const available = players.filter((player) => player.available).length;
  const status = report.fixtures.length > 0 && available === players.length ? "all-player-histories-available" : "incomplete-player-coverage";
  process.stdout.write(`${JSON.stringify({ status, date, wallMs: Math.round(performance.now() - started), fixtures: report.fixtures.length, scheduledPlayers: players.length, availablePlayers: available, players })}\n`);
  if (status !== "all-player-histories-available") process.exitCode = 1;
} catch (error: unknown) {
  process.stderr.write(`${JSON.stringify({ status: "unavailable", message: error instanceof Error ? error.message : "Unknown PDC coverage error" })}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
