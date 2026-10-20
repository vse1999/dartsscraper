import { createReportBudget, raceWithReportDeadline } from "../daily/report-budget.js";
import type { Logger } from "../logger.js";
import { normalizePlayerName } from "../player/resolver.js";
import type { PdcFixture, PdcScheduleSnapshot } from "./schemas.js";
import { flattenScheduleFixtures } from "./schedule.js";
import type { PdcPlayerResearch, PdcTournamentService, PdcUpcomingReport } from "./service.js";
import { PDC_JOB_BATCH_SIZE, PdcReportJobSchema, type PdcReportJob } from "./report-job-protocol.js";
import { limitImageReports } from "../telegram/image-report-model.js";
import { formatPdcSchedulePreviewMessages } from "../telegram/pdc-formatter.js";
import { pdcImageReports, pdcPlayerKeyboard } from "../telegram/pdc-image-reports.js";
import { MAX_REPORT_IMAGES } from "../telegram/report-image.js";
import type { TelegramMessageSender } from "../telegram/sender.js";
import { PdcJobDispatchError, type PdcReportJobDispatcher } from "../telegram/pdc-job-trigger.js";

export interface PdcReportJobDependencies {
  readonly reader: Pick<PdcTournamentService, "getScheduleForDate" | "getReportForFixtures">;
  readonly sender: TelegramMessageSender;
  readonly chatId: number;
  readonly editStatus: (messageId: number, text: string, signal: AbortSignal) => Promise<void>;
  readonly dispatcher: PdcReportJobDispatcher;
  readonly logger: Logger;
  readonly researchMs?: number;
  readonly totalMs?: number;
  readonly now?: () => number;
}

/** One sequential bounded chunk. The next invocation starts only after delivery. */
export async function runPdcReportJob(job: PdcReportJob, dependencies: PdcReportJobDependencies): Promise<void> {
  const budget = createReportBudget({
    totalMs: dependencies.totalMs ?? 280_000,
    researchMs: dependencies.researchMs ?? 220_000,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  let total: number | undefined = job.fixtures?.length;
  let completed = job.cursor;
  let deliveredCards = job.deliveredCount ?? job.cursor;
  let failedPairings = job.failedCount ?? 0;
  const deliveredFixtureIds = new Set(job.deliveredFixtureIds ?? []);
  let stage: "schedule" | "preview" | "statistics" | "delivery" | "continuation" | "completion" = "schedule";
  const startedAt = dependencies.now?.() ?? performance.now();
  try {
    const schedule = job.schedule ?? (job.fixtures === undefined
      ? await raceWithReportDeadline(
        dependencies.reader.getScheduleForDate(job.date, budget.researchSignal),
        budget.researchSignal,
        "research",
      )
      : createLegacyJobSchedule(job));
    if (schedule.date !== job.date) throw new Error("PDC schedule date did not match the signed report date.");
    const fixtures = job.fixtures ?? flattenScheduleFixtures(schedule);
    if (job.deliveredFixtureIds === undefined && job.cursor > 0) {
      for (const fixture of fixtures.slice(0, job.cursor)) deliveredFixtureIds.add(fixture.id);
    }
    const validatedJob = PdcReportJobSchema.parse({ ...job, fixtures, schedule });
    total = fixtures.length;

    if (job.cursor === 0) {
      stage = "preview";
      const previewParts = formatPdcSchedulePreviewMessages(schedule);
      const preview = previewParts[0] ?? `🎯 PDC SCHEDULE · ${job.date}\nSchedule preview unavailable.`;
      await dependencies.editStatus(job.acknowledgementMessageId, preview, budget.totalSignal);
      for (const continuation of previewParts.slice(1)) {
        await dependencies.sender.sendMessage(dependencies.chatId, continuation, { signal: budget.totalSignal });
      }
      dependencies.logger.info("PDC schedule preview delivered.", {
        reportId: job.jobId,
        phase: "first-useful-output",
        durationMs: Math.max(0, Math.round((dependencies.now?.() ?? performance.now()) - startedAt)),
        calendarStatus: schedule.calendarStatus,
        eventCount: schedule.events.length,
        namedFixtures: fixtures.length,
        pendingSlots: schedule.events.reduce((sum, event) => sum + (event.pendingSlots ?? 0), 0),
        previewParts: previewParts.length,
      });
    } else {
      stage = "statistics";
    }

    if (fixtures.length === 0) {
      dependencies.logger.info("PDC report finished without player-history work.", {
        reportId: job.jobId,
        phase: "completion",
        calendarStatus: schedule.calendarStatus,
        unresolvedEvents: schedule.events.filter((event) => event.coverage !== "available").length,
        reason: schedule.calendarStatus === "verified" && schedule.events.length === 0 ? "verified_empty_scope" : "no_verified_named_pairings",
      });
      return;
    }

    const batch = fixtures.slice(job.cursor, job.cursor + PDC_JOB_BATCH_SIZE);
    const end = job.cursor + batch.length;
    if (batch.length === 0) throw new Error("PDC job cursor is outside its pinned schedule.");
    stage = "statistics";
    const researchStartedAt = dependencies.now?.() ?? performance.now();
    const report = await raceWithReportDeadline(
      dependencies.reader.getReportForFixtures(job.date, batch, budget.researchSignal, undefined, schedule),
      budget.researchSignal,
      "research",
    );
    validateReportIdentity(report, job.date, batch);

    const byName = new Map(report.players.map((player) => [normalizePlayerName(player.requestedName), player]));
    const readyFixtures = batch.filter((fixture) => (
      hasCompleteStats(byName.get(normalizePlayerName(fixture.playerOne)))
      && hasCompleteStats(byName.get(normalizePlayerName(fixture.playerTwo)))
    ));
    const failedThisBatch = batch.length - readyFixtures.length;
    const readyNames = new Set(readyFixtures.flatMap((fixture) => [
      normalizePlayerName(fixture.playerOne),
      normalizePlayerName(fixture.playerTwo),
    ]));
    const readyPlayers = report.players.filter((player) => readyNames.has(normalizePlayerName(player.requestedName)));
    const readyReport: PdcUpcomingReport = { ...report, fixtures: readyFixtures, players: readyPlayers, schedule };
    const metricGapPlayers = readyPlayers.filter((player) => player.stats?.matches.some((match) => (
      match.oneEighties === undefined || match.checkoutHits === undefined || match.checkoutAttempts === undefined
    )) === true).length;

    stage = "delivery";
    const rows = pdcImageReports(readyReport).map((image, index) => {
      const fixture = readyFixtures[index];
      const source = fixture?.sourceUrl ?? "https://www.pdc.tv/matches";
      const fixtureIndex = fixture === undefined ? index : fixtures.findIndex((candidate) => candidate.id === fixture.id);
      const label = `Match ${fixtureIndex < 0 ? job.cursor + index + 1 : fixtureIndex + 1}/${total}`;
      return {
        ...image,
        text: `${label}\n${image.text}\nPairing source: ${source}`,
        caption: `${label}\n${image.caption}\nPairing source: ${source}`.slice(0, 1024),
      };
    });
    const limited = limitImageReports(rows, Math.max(0, MAX_REPORT_IMAGES - job.cursor));
    for (const image of limited) {
      if (dependencies.sender.sendReport === undefined) throw new Error("PDC report delivery transport is unavailable.");
      await dependencies.sender.sendReport(dependencies.chatId, image, { signal: budget.totalSignal });
    }
    for (const fixture of readyFixtures) deliveredFixtureIds.add(fixture.id);

    completed = end;
    deliveredCards += readyFixtures.length;
    failedPairings += failedThisBatch;
    const statsDuration = Math.max(0, Math.round((dependencies.now?.() ?? performance.now()) - researchStartedAt));
    dependencies.logger.info("PDC isolated statistics batch processed.", {
      reportId: job.jobId,
      phase: "statistics",
      cursor: job.cursor,
      processedPairings: batch.length,
      readyPairings: readyFixtures.length,
      failedPairings: failedThisBatch,
      playerLookups: report.players.length,
      durationMs: statsDuration,
      metricGapPlayers,
    });

    if (end < fixtures.length) {
      stage = "continuation";
      await dependencies.editStatus(
        job.acknowledgementMessageId,
        `PDC · ${job.date}\nProgress: ${end}/${total} matchups processed · ${deliveredCards} complete cards delivered · ${failedPairings} pairings withheld after isolated research failures.`,
        budget.totalSignal,
      );
      await dependencies.dispatcher.dispatch({
        ...validatedJob,
        cursor: end,
        deliveredCount: deliveredCards,
        failedCount: failedPairings,
        deliveredFixtureIds: [...deliveredFixtureIds],
      }, budget.totalSignal);
      return;
    }

    stage = "completion";
    if (deliveredCards > 0) {
      const allReadyFixtures = fixtures.filter((fixture) => deliveredFixtureIds.has(fixture.id));
      const names = [...new Set(allReadyFixtures.flatMap((fixture) => [fixture.playerOne, fixture.playerTwo]))];
      const keyboardReport: PdcUpcomingReport = {
        date: job.date,
        fixtures: allReadyFixtures,
        players: names.map((requestedName) => ({ requestedName, stats: null, failureCode: null })),
        schedule,
      };
      await dependencies.sender.sendMessage(
        dependencies.chatId,
        `PDC · ${job.date} · research finished\nComplete cards delivered: ${deliveredCards}/${total}. Pairings withheld after isolated research failures: ${failedPairings}. Missing source values remain marked unavailable.\nOfficial calendar: https://www.pdc.tv/matches\nTap a player for their match rows.`,
        { signal: budget.totalSignal, replyMarkup: pdcPlayerKeyboard(keyboardReport) },
      );
    } else {
      await dependencies.sender.sendMessage(
        dependencies.chatId,
        `PDC · ${job.date} · research finished\nNo complete matchup cards were available. ${failedPairings}/${total} pairings were withheld after isolated research failures. No missing metric was substituted.`,
        { signal: budget.totalSignal },
      );
    }
    await dependencies.editStatus(
      job.acknowledgementMessageId,
      `PDC · ${job.date}\nCompleted: ${deliveredCards}/${total} complete cards delivered · ${failedPairings} pairings withheld after isolated research failures.`,
      budget.totalSignal,
    );
    dependencies.logger.info("PDC report completed.", {
      reportId: job.jobId,
      phase: "completion",
      totalPairings: total,
      deliveredCards,
      failedPairings,
      durationMs: Math.max(0, Math.round((dependencies.now?.() ?? performance.now()) - startedAt)),
      calendarStatus: schedule.calendarStatus,
    });
  } catch (error: unknown) {
    const statusCode = error instanceof PdcJobDispatchError ? error.statusCode : undefined;
    dependencies.logger.error("PDC full statistics job stopped.", {
      reportId: job.jobId,
      date: job.date,
      cursor: job.cursor,
      stage,
      statusCode,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    const uncertain = error instanceof PdcJobDispatchError && error.uncertain;
    const message = uncertain
      ? "The next statistics batch could not be confirmed and may still be running. No automatic retry was sent."
      : "The full statistics lookup stopped. Incomplete cards were not substituted. Please retry later.";
    await dependencies.editStatus(
      job.acknowledgementMessageId,
      `PDC · ${job.date}\n${message}\nStopped at: ${stage}${statusCode === undefined ? "" : ` (HTTP ${statusCode})`}.\nPreviously processed: ${completed}${total === undefined ? "" : `/${total}`} · complete cards delivered: ${deliveredCards} · pairings withheld: ${failedPairings}.`,
      AbortSignal.timeout(10_000),
    ).catch((): void => { dependencies.logger.warn("PDC failure status could not be delivered."); });
  } finally {
    budget.close();
  }
}

function createLegacyJobSchedule(job: PdcReportJob): PdcScheduleSnapshot {
  const fixtures = job.fixtures ?? [];
  return {
    schemaVersion: 1,
    date: job.date,
    timeZone: "Europe/Budapest",
    observedAt: new Date(job.createdAt).toISOString(),
    calendarStatus: "unavailable",
    calendarReason: "calendar_unavailable",
    events: fixtures.length === 0 ? [] : [{
      eventId: `legacy:${job.jobId}`,
      name: "Pinned legacy PDC schedule",
      coverage: "partial",
      fixtures,
      pendingSlots: null,
      reason: "fallback_only",
      evidenceUrls: [...new Set(fixtures.flatMap((fixture) => [fixture.sourceUrl, ...(fixture.evidenceUrls ?? [])]))].slice(0, 10),
    }],
  };
}

function validateReportIdentity(report: PdcUpcomingReport, date: string, fixtures: readonly PdcFixture[]): void {
  if (report.date !== date || report.fixtures.length !== fixtures.length
    || report.fixtures.some((fixture, index) => fixture.id !== fixtures[index]?.id)) {
    throw new Error("PDC statistics report did not match the pinned matchup batch.");
  }
  const expectedNames = new Set(fixtures.flatMap((fixture) => [fixture.playerOne, fixture.playerTwo]).map(normalizePlayerName));
  const receivedNames = report.players.map((player) => normalizePlayerName(player.requestedName));
  if (receivedNames.length !== expectedNames.size || new Set(receivedNames).size !== expectedNames.size
    || receivedNames.some((name) => !expectedNames.has(name))) {
    throw new Error("PDC statistics report did not match the pinned matchup participants.");
  }
}

function hasCompleteStats(player: PdcPlayerResearch | undefined): boolean {
  return player !== undefined && player.stats !== null && player.stats.matches.length > 0 && player.failureCode === null;
}
