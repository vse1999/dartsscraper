import { timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import type { AbortSignal as GrammyAbortSignal } from "abort-controller";
import { ConsoleLogger, type Logger } from "../src/logger.js";
import { PDC_JOB_MAX_BYTES, PDC_JOB_TTL_MS, readPdcSigningSecret, verifyPdcJob, type PdcReportJob } from "../src/pdc/report-job-protocol.js";
import { runPdcReportJob } from "../src/pdc/report-job.js";
import { createDefaultPdcTournamentService } from "../src/pdc/default.js";
import { createDefaultBulkPlayerStatsService } from "../src/telegram/stats-service.js";
import { createBot, readBotConfiguration, resolvePdcReportEndpointUrl } from "../src/telegram/bot.js";
import { createTelegramSender } from "../src/telegram/sender.js";
import { createTelegramDeliveryPolicy } from "../src/telegram/delivery-policy.js";
import { reportImagesEnabled } from "../src/telegram/report-image.js";
import { createPdcJobDispatcher } from "../src/telegram/pdc-job-trigger.js";

export const config = { maxDuration: 300 };
export interface PdcJobEndpointDependencies {
  readonly cronSecret: string; readonly signingSecret: string; readonly logger: Logger;
  readonly execute: (job: PdcReportJob) => Promise<void>;
  readonly schedule: (task: Promise<void>) => void;
  readonly now?: () => number;
  readonly receipts: Map<string, { readonly signature: string; readonly expiresAt: number }>;
}

export async function handlePdcJobRequest(request: Request, dependencies: PdcJobEndpointDependencies): Promise<Response> {
  const authorization = Buffer.from(request.headers.get("authorization") ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${dependencies.cronSecret}`, "utf8");
  if (request.method !== "POST" || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) return response(404);
  let signed: ReturnType<typeof verifyPdcJob>;
  const now = dependencies.now?.() ?? Date.now();
  try {
    const declared = request.headers.get("content-length");
    if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > PDC_JOB_MAX_BYTES)) return response(413);
    const body = await request.text();
    if (Buffer.byteLength(body) > PDC_JOB_MAX_BYTES) return response(413);
    signed = verifyPdcJob(JSON.parse(body) as unknown, dependencies.signingSecret, now);
  } catch { return response(400); }
  for (const [key, receipt] of dependencies.receipts) if (receipt.expiresAt <= now) dependencies.receipts.delete(key);
  const key = `${signed.job.jobId}:${signed.job.cursor}`;
  const previous = dependencies.receipts.get(key);
  if (previous !== undefined) return response(previous.signature === signed.signature ? 202 : 409);
  if (dependencies.receipts.size >= 1024) return response(503);
  let release: (allowed: boolean) => void = (): void => undefined;
  const gate = new Promise<boolean>((resolve): void => { release = resolve; });
  const task = gate.then(async (allowed: boolean): Promise<void> => { if (allowed) await dependencies.execute(signed.job); }).catch((): void => { dependencies.logger.error("PDC job execution failed."); });
  try {
    dependencies.schedule(task);
    dependencies.receipts.set(key, { signature: signed.signature, expiresAt: now + PDC_JOB_TTL_MS });
    release(true);
    return response(202);
  } catch {
    release(false);
    return response(503);
  }
}
function response(status: number): Response { return new Response(null, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }); }

const logger = new ConsoleLogger({ minimumLevel: "info" });
const receipts: PdcJobEndpointDependencies["receipts"] = new Map();
let productionExecute: PdcJobEndpointDependencies["execute"] | undefined;
function getProductionExecute(): PdcJobEndpointDependencies["execute"] {
  if (productionExecute !== undefined) return productionExecute;
  const configuration = readBotConfiguration(process.env);
  const stats = createDefaultBulkPlayerStatsService(logger);
  // Hide the lightweight capability: every batch must fetch all three views.
  const reader = createDefaultPdcTournamentService(logger, { getPlayerStats: stats.getPlayerStats.bind(stats) });
  const policy = createTelegramDeliveryPolicy();
  const sender = createTelegramSender({ token: configuration.token, imagesEnabled: reportImagesEnabled(process.env), deliveryPolicy: policy, logger });
  const bot = createBot({ ...configuration, statsService: stats, deliveryPolicy: policy, logger });
  const endpointUrl = resolvePdcReportEndpointUrl(process.env);
  if (endpointUrl === undefined) throw new Error("PDC continuation endpoint is not configured.");
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret === undefined) throw new Error("PDC jobs require CRON_SECRET.");
  const dispatcher = createPdcJobDispatcher({ endpointUrl, cronSecret, signingSecret: readPdcSigningSecret(process.env) });
  productionExecute = async (job: PdcReportJob): Promise<void> => {
    await runPdcReportJob(job, { reader, sender, dispatcher, chatId: configuration.allowedUserId, logger,
      editStatus: async (id: number, text: string, signal: AbortSignal): Promise<void> => { await bot.api.editMessageText(configuration.allowedUserId, id, text, undefined, signal as unknown as GrammyAbortSignal); },
    });
  };
  return productionExecute;
}
export default { fetch: async (request: Request): Promise<Response> => {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret === undefined || !/^[A-Za-z0-9_-]{32,256}$/u.test(cronSecret)) throw new Error("PDC jobs require a valid CRON_SECRET.");
  return handlePdcJobRequest(request, { cronSecret, signingSecret: readPdcSigningSecret(process.env), receipts, logger, schedule: waitUntil, execute: async (job: PdcReportJob): Promise<void> => getProductionExecute()(job) });
} };
