import { timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { readBoundedRequestBody } from "../src/services/bounded-request-body.js";
import { ConsoleLogger, type Logger } from "../src/logger.js";
import { PDC_JOB_MAX_BYTES, PDC_JOB_TTL_MS, readPdcSigningSecret, verifyPdcJob, type PdcReportJob } from "../src/pdc/report-job-protocol.js";
import { InMemoryPdcJobReceiptStore, type PdcJobReceiptReservation, type PdcJobReceiptStore } from "../src/pdc/job-receipt-store.js";
import { runPdcReportJob } from "../src/pdc/report-job.js";
import { createDefaultPdcTournamentService } from "../src/pdc/default.js";
import { createDefaultBulkPlayerStatsService } from "../src/telegram/stats-service.js";
import { readBotConfiguration, resolvePdcReportEndpointUrl } from "../src/telegram/bot.js";
import { createTelegramMessageEditor, createTelegramSender } from "../src/telegram/sender.js";
import { createTelegramDeliveryPolicy } from "../src/telegram/delivery-policy.js";
import { reportImagesEnabled } from "../src/telegram/report-image.js";
import { createPdcJobDispatcher } from "../src/telegram/pdc-job-trigger.js";

export const config = { maxDuration: 300 };
export interface PdcJobEndpointDependencies {
  readonly cronSecret: string; readonly signingSecret: string; readonly logger: Logger;
  readonly execute: (job: PdcReportJob) => Promise<void>;
  readonly schedule: (task: Promise<void>) => void;
  readonly now?: () => number;
  readonly receiptStore: PdcJobReceiptStore;
}

export async function handlePdcJobRequest(request: Request, dependencies: PdcJobEndpointDependencies): Promise<Response> {
  const authorization = Buffer.from(request.headers.get("authorization") ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${dependencies.cronSecret}`, "utf8");
  if (request.method !== "POST" || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) return response(404);
  let signed: ReturnType<typeof verifyPdcJob>;
  const now = dependencies.now?.() ?? Date.now();
  try {
    const body = await readBoundedRequestBody(request, PDC_JOB_MAX_BYTES);
    if (body.kind !== "ok") return response(413);
    signed = verifyPdcJob(JSON.parse(body.text) as unknown, dependencies.signingSecret, now);
  } catch { return response(400); }
  const key = `${signed.job.jobId}:${signed.job.cursor}`;
  let reservation: PdcJobReceiptReservation;
  try {
    reservation = await dependencies.receiptStore.reserve(key, {
      signature: signed.signature,
      expiresAt: now + PDC_JOB_TTL_MS,
    }, now);
  } catch (error: unknown) {
    dependencies.logger.error("PDC job receipt admission failed.", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return response(503);
  }
  if (reservation === "duplicate") return response(202);
  if (reservation === "conflict") return response(409);
  if (reservation === "capacity_reached") return response(503);

  let release: (allowed: boolean) => void = (): void => undefined;
  const gate = new Promise<boolean>((resolve): void => { release = resolve; });
  const task = gate.then(async (allowed: boolean): Promise<void> => { if (allowed) await dependencies.execute(signed.job); }).catch((): void => { dependencies.logger.error("PDC job execution failed."); });
  try {
    dependencies.schedule(task);
    release(true);
    return response(202);
  } catch {
    release(false);
    await dependencies.receiptStore.release(key, signed.signature).catch((error: unknown): void => {
      dependencies.logger.warn("PDC job receipt reservation could not be released.", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    });
    return response(503);
  }
}
function response(status: number): Response { return new Response(null, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }); }

const logger = new ConsoleLogger({ minimumLevel: "info" });
const receiptStore: PdcJobEndpointDependencies["receiptStore"] = new InMemoryPdcJobReceiptStore();
let productionExecute: PdcJobEndpointDependencies["execute"] | undefined;
function getProductionExecute(): PdcJobEndpointDependencies["execute"] {
  if (productionExecute !== undefined) return productionExecute;
  const configuration = readBotConfiguration(process.env);
  const stats = createDefaultBulkPlayerStatsService(logger);
  // Hide the lightweight capability: every batch must fetch all three views.
  const reader = createDefaultPdcTournamentService(logger, { getPlayerStats: stats.getPlayerStats.bind(stats) });
  const policy = createTelegramDeliveryPolicy();
  const sender = createTelegramSender({ token: configuration.token, imagesEnabled: reportImagesEnabled(process.env), deliveryPolicy: policy, logger });
  const editor = createTelegramMessageEditor({ token: configuration.token });
  const endpointUrl = resolvePdcReportEndpointUrl(process.env);
  if (endpointUrl === undefined) throw new Error("PDC continuation endpoint is not configured.");
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret === undefined) throw new Error("PDC jobs require CRON_SECRET.");
  const dispatcher = createPdcJobDispatcher({ endpointUrl, cronSecret, signingSecret: readPdcSigningSecret(process.env) });
  productionExecute = async (job: PdcReportJob): Promise<void> => {
    await runPdcReportJob(job, { reader, sender, dispatcher, chatId: configuration.allowedUserId, logger,
      editStatus: async (id: number, text: string, signal: AbortSignal): Promise<void> => { await editor.editMessageText(configuration.allowedUserId, id, text, signal); },
    });
  };
  return productionExecute;
}
export default { fetch: async (request: Request): Promise<Response> => {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret === undefined || !/^[A-Za-z0-9_-]{32,256}$/u.test(cronSecret)) throw new Error("PDC jobs require a valid CRON_SECRET.");
  return handlePdcJobRequest(request, { cronSecret, signingSecret: readPdcSigningSecret(process.env), receiptStore, logger, schedule: waitUntil, execute: async (job: PdcReportJob): Promise<void> => getProductionExecute()(job) });
} };
