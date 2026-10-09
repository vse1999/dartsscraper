import { createReportBudget, raceWithReportDeadline } from "../daily/report-budget.js";
import type { Logger } from "../logger.js";
import type { PdcTournamentService, PdcUpcomingReport } from "./service.js";
import { PDC_JOB_BATCH_SIZE, PdcReportJobSchema, type PdcReportJob } from "./report-job-protocol.js";
import { limitImageReports } from "../telegram/image-report-model.js";
import { pdcImageReports, pdcPlayerKeyboard } from "../telegram/pdc-image-reports.js";
import { MAX_REPORT_IMAGES } from "../telegram/report-image.js";
import type { TelegramMessageSender } from "../telegram/sender.js";
import { PdcJobDispatchError, type PdcReportJobDispatcher } from "../telegram/pdc-job-trigger.js";

export interface PdcReportJobDependencies {
  readonly reader: Pick<PdcTournamentService, "getFixturesForDate" | "getReportForFixtures">;
  readonly sender: TelegramMessageSender;
  readonly chatId: number;
  readonly editStatus: (messageId: number, text: string, signal: AbortSignal) => Promise<void>;
  readonly dispatcher: PdcReportJobDispatcher;
  readonly logger: Logger;
  readonly researchMs?: number;
  readonly totalMs?: number;
}

/** One sequential bounded chunk. The next invocation starts only after delivery. */
export async function runPdcReportJob(job: PdcReportJob, dependencies: PdcReportJobDependencies): Promise<void> {
  const budget = createReportBudget({ totalMs: dependencies.totalMs ?? 280_000, researchMs: dependencies.researchMs ?? 220_000 });
  let total: number | undefined = job.fixtures?.length;
  let completed = job.cursor;
  try {
    const fixtures = job.fixtures ?? await raceWithReportDeadline(dependencies.reader.getFixturesForDate(job.date, budget.researchSignal), budget.researchSignal, "research");
    if (fixtures.length === 0) {
      await dependencies.editStatus(job.acknowledgementMessageId, `PDC · ${job.date}\nNo scheduled matchups were found in the verified calendar.`, budget.totalSignal);
      return;
    }
    const snapshot = PdcReportJobSchema.parse({ ...job, fixtures });
    total = fixtures.length;
    const batch = fixtures.slice(job.cursor, job.cursor + PDC_JOB_BATCH_SIZE);
    const end = job.cursor + batch.length;
    await dependencies.editStatus(job.acknowledgementMessageId, `PDC · ${job.date}\nFull statistics: matches ${job.cursor + 1}–${end}/${total}. Cards arrive as each batch finishes.`, budget.totalSignal);
    const report = await raceWithReportDeadline(dependencies.reader.getReportForFixtures(job.date, batch, budget.researchSignal), budget.researchSignal, "research");
    // No average-first adapter in this path. A transport/identity/deadline
    // failure must not be disguised as a completed statistics card.
    const expectedNames = new Set(batch.flatMap((fixture) => [fixture.playerOne, fixture.playerTwo]));
    if (report.date !== job.date || report.fixtures.length !== batch.length || report.fixtures.some((fixture, index) => fixture.id !== batch[index]?.id)
      || report.players.length !== expectedNames.size || new Set(report.players.map((player) => player.requestedName)).size !== expectedNames.size
      || report.players.some((player) => !expectedNames.has(player.requestedName) || player.stats === null || player.stats.matches.length === 0 || player.failureCode !== null)) throw new Error("PDC full statistic lookup failed; incomplete cards were withheld.");
    const metricGapPlayers = report.players.filter((player) => player.stats?.matches.some((match) => match.oneEighties === undefined || match.checkoutHits === undefined || match.checkoutAttempts === undefined) === true).length;
    const rows = pdcImageReports(report).map((image, index) => {
      const source = batch[index]?.sourceUrl ?? "https://www.pdc.tv/matches";
      const label = `Match ${job.cursor + index + 1}/${total}`;
      return { ...image, text: `${label}\n${image.text}\nPairing source: ${source}`, caption: `${label}\n${image.caption}\nPairing source: ${source}`.slice(0, 1024) };
    });
    const limited = limitImageReports(rows, Math.max(0, MAX_REPORT_IMAGES - job.cursor));
    for (const image of limited) {
      if (dependencies.sender.sendReport === undefined) throw new Error("PDC report delivery transport is unavailable.");
      await dependencies.sender.sendReport(dependencies.chatId, image, { signal: budget.totalSignal });
    }
    completed = end;
    dependencies.logger.info("PDC complete statistics batch delivered.", {
      date: job.date, cursor: job.cursor, fixtures: batch.length, players: report.players.length, metricGapPlayers,
      historyRows: report.players.reduce((sum, player) => sum + (player.stats?.matches.length ?? 0), 0),
      averageRows: report.players.reduce((sum, player) => sum + (player.stats?.availableAverageCount ?? 0), 0),
      oneEightiesRows: report.players.reduce((sum, player) => sum + (player.stats?.matches.filter((match) => match.oneEighties !== undefined).length ?? 0), 0),
      checkoutRows: report.players.reduce((sum, player) => sum + (player.stats?.matches.filter((match) => match.checkoutHits !== undefined && match.checkoutAttempts !== undefined).length ?? 0), 0),
    });
    if (end < fixtures.length) {
      await dependencies.dispatcher.dispatch({ ...snapshot, cursor: end }, budget.totalSignal);
      return;
    }
    const names = [...new Set(fixtures.flatMap((fixture) => [fixture.playerOne, fixture.playerTwo]))];
    const keyboardReport: PdcUpcomingReport = { date: job.date, fixtures, players: names.map((requestedName) => ({ requestedName, stats: null, failureCode: null })) };
    await dependencies.sender.sendMessage(dependencies.chatId, `PDC · ${job.date} · ${total} matchups\nAll average/180/checkout lookups finished. Any source-missing values remain marked unavailable.\nOfficial calendar: https://www.pdc.tv/matches\nTap a player for their match rows.`, { signal: budget.totalSignal, replyMarkup: pdcPlayerKeyboard(keyboardReport) });
    await dependencies.editStatus(job.acknowledgementMessageId, `PDC · ${job.date}\nCompleted: ${total} matchups with full statistic lookups.`, budget.totalSignal);
  } catch (error: unknown) {
    dependencies.logger.error("PDC full statistics job stopped.", { date: job.date, cursor: job.cursor, errorType: error instanceof Error ? error.name : "UnknownError" });
    const uncertain = error instanceof PdcJobDispatchError && error.uncertain;
    const message = uncertain
      ? "The next statistics batch could not be confirmed and may still be running. No automatic retry was sent."
      : "The full statistics lookup stopped. Incomplete cards were not substituted. Please retry later.";
    await dependencies.editStatus(job.acknowledgementMessageId, `PDC · ${job.date}\n${message}\nPreviously completed: ${completed}${total === undefined ? "" : `/${total}`} matchups.`, AbortSignal.timeout(10_000)).catch((): void => { dependencies.logger.warn("PDC failure status could not be delivered."); });
  } finally { budget.close(); }
}
