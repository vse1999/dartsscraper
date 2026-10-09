import { mkdir, writeFile } from "node:fs/promises";
import { resolveResearchDate } from "../src/agent/date.js";
import { ConsoleLogger } from "../src/logger.js";
import { createDefaultPdcTournamentService } from "../src/pdc/default.js";
import { runPdcReportJob } from "../src/pdc/report-job.js";
import type { PdcReportJob } from "../src/pdc/report-job-protocol.js";
import { createDefaultBulkPlayerStatsService } from "../src/telegram/stats-service.js";
import { newPdcReportJob } from "../src/telegram/pdc-job-trigger.js";
import { renderReportImage, type ImageReport } from "../src/telegram/report-image.js";
import { createTelegramSender } from "../src/telegram/sender.js";
import { readBotConfiguration } from "../src/telegram/bot.js";
import type { PdcFixture } from "../src/pdc/schemas.js";
import type { PdcUpcomingReport } from "../src/pdc/service.js";

const sendOwner = process.argv.includes("--send-owner");
if (sendOwner) process.loadEnvFile(".env.local");
const date = resolveResearchDate(process.argv[2] ?? "today", { timeZone: "Europe/Budapest" }).date;
const logger = new ConsoleLogger({ minimumLevel: "warn" });
const stats = createDefaultBulkPlayerStatsService(logger);
const service = createDefaultPdcTournamentService(logger, { getPlayerStats: stats.getPlayerStats.bind(stats) });
const configuration = sendOwner ? readBotConfiguration(process.env) : undefined;
const sender = configuration === undefined ? undefined : createTelegramSender({ token: configuration.token, imagesEnabled: true, logger });
const queued: PdcReportJob[] = [newPdcReportJob(date, 1)];
const players: Array<{ readonly name: string; readonly rows: number; readonly averageRows: number; readonly oneEightiesRows: number; readonly checkoutRows: number }> = [];
let cards = 0;
let failed = false;
let batches = 0;
const started = performance.now();
await mkdir(".tmp/pdc-complete", { recursive: true });
while (queued.length > 0 && !failed) {
  const job = queued.shift();
  if (job === undefined) break;
  batches += 1;
  await runPdcReportJob(job, {
    reader: { getFixturesForDate: service.getFixturesForDate.bind(service), getReportForFixtures: async (requested: string, fixtures: readonly PdcFixture[], signal?: AbortSignal): Promise<PdcUpcomingReport> => {
      const report = await service.getReportForFixtures(requested, fixtures, signal);
      for (const player of report.players) players.push({ name: player.requestedName, rows: player.stats?.matches.length ?? 0, averageRows: player.stats?.availableAverageCount ?? 0,
        oneEightiesRows: player.stats?.matches.filter((match) => match.oneEighties !== undefined).length ?? 0,
        checkoutRows: player.stats?.matches.filter((match) => match.checkoutHits !== undefined && match.checkoutAttempts !== undefined).length ?? 0 });
      process.stdout.write(`${JSON.stringify({ batch: batches, players: players.slice(-report.players.length) })}\n`);
      return report;
    } },
    dispatcher: { dispatch: async (next: PdcReportJob): Promise<void> => { queued.push(next); } },
    sender: {
      sendReport: async (_chat: number | string, image: ImageReport): Promise<void> => {
        cards += 1;
        if (image.card !== undefined && (cards === 1 || cards === 16)) await writeFile(`.tmp/pdc-complete/match-${cards}.png`, await renderReportImage(image.card));
        if (sender?.sendReport !== undefined && configuration !== undefined) await sender.sendReport(configuration.allowedUserId, image);
      },
      sendMessage: async (_chat: number | string, text: string): Promise<void> => { if (sender !== undefined && configuration !== undefined) await sender.sendMessage(configuration.allowedUserId, text); },
    },
    editStatus: async (_id: number, text: string): Promise<void> => {
      if (/stopped|could not be confirmed|not substituted/u.test(text)) failed = true;
      process.stdout.write(`${JSON.stringify({ progress: text })}\n`);
    },
    chatId: configuration?.allowedUserId ?? 1, logger,
  });
}
const complete = players.length > 0 && players.every((player) => player.rows === 10 && player.averageRows === 10 && player.oneEightiesRows === 10 && player.checkoutRows === 10);
const result = { status: !failed && complete ? "all-statistics-complete" : "incomplete-source-statistics", date, wallMs: Math.round(performance.now() - started), batches, cards, players };
await writeFile(".tmp/pdc-complete/result.json", JSON.stringify(result, null, 2));
process.stdout.write(`${JSON.stringify(result)}\n`);
if (failed || !complete) process.exitCode = 1;
