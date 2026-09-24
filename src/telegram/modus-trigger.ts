import type { ModusReportDateExpression, ModusReportTrigger } from "./modus-command.js";
import type { ModusReportStatus } from "../daily/modus-report.js";
import { IsoDateSchema } from "../agent/date.js";

export interface HttpModusReportTriggerOptions {
  readonly endpointUrl: string;
  readonly cronSecret: string;
  readonly apiFetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createHttpModusReportTrigger(options: HttpModusReportTriggerOptions): ModusReportTrigger {
  const endpointUrl = new URL(options.endpointUrl);
  const cronSecret = options.cronSecret.trim();
  if (cronSecret === "") throw new Error("MODUS report trigger cron secret must not be empty.");
  const fetchImpl = options.apiFetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 170_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("MODUS report trigger timeoutMs must be a positive integer.");
  }

  return {
    async start(date: ModusReportDateExpression): Promise<void> {
      const requestUrl = new URL(endpointUrl);
      requestUrl.searchParams.set("date", date);
      const controller = new AbortController();
      const timeout = setTimeout((): void => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(requestUrl, {
          method: "GET",
          headers: { authorization: `Bearer ${cronSecret}` },
          signal: controller.signal,
        });
        const payload: unknown = await response.json().catch((): null => null);
        if (!response.ok) {
          const status = reportStatus(payload);
          if (status !== undefined) {
            throw new Error(`MODUS report endpoint reported status ${status} (HTTP ${response.status}).`);
          }
          throw new Error(`MODUS report endpoint returned HTTP ${response.status}.`);
        }
        if (!isSuccessfulReportResponse(payload)) {
          const status = reportStatus(payload);
          if (status !== undefined && status !== "succeeded") {
            throw new Error(`MODUS report endpoint reported status ${status}.`);
          }
          throw new Error("MODUS report endpoint returned an unexpected response.");
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) {
          throw new Error(`MODUS report endpoint timed out after ${timeoutMs}ms.`, { cause: error });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function isSuccessfulReportResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.ok !== true || value.status !== "succeeded" || typeof value.date !== "string" || !IsoDateSchema.safeParse(value.date).success) return false;
  if (!isNonNegativeInteger(value.players) || value.players === 0 || !isNonNegativeInteger(value.succeeded) || !isNonNegativeInteger(value.failed)) return false;
  if (value.succeeded + value.failed !== value.players || value.discoverySucceeded !== true) return false;
  if (!isRecord(value.outcome) || value.outcome.status !== "succeeded") return false;

  const discovery = value.outcome.discovery;
  if (!isRecord(discovery)
    || discovery.status !== "succeeded"
    || discovery.playersDiscovered !== value.players
    || !isNonNegativeInteger(discovery.fixturesDiscovered)
    || !isStringArray(discovery.warnings)
    || discovery.warnings.length !== 0
    || Object.prototype.hasOwnProperty.call(discovery, "failureCode")) return false;

  const data = value.outcome.data;
  if (!isRecord(data)
    || data.status !== "complete"
    || data.attempted !== value.players
    || data.succeeded !== value.succeeded
    || data.failed !== value.failed
    || data.failed !== 0
    || (Object.prototype.hasOwnProperty.call(data, "unstarted") && data.unstarted !== 0)
    || (Object.prototype.hasOwnProperty.call(data, "timedOut") && data.timedOut !== 0)) return false;

  const delivery = value.outcome.delivery;
  return isRecord(delivery)
    && delivery.status === "complete"
    && isNonNegativeInteger(delivery.attempted)
    && delivery.attempted > 0
    && isNonNegativeInteger(delivery.succeeded)
    && delivery.failed === 0
    && (!Object.prototype.hasOwnProperty.call(delivery, "skipped") || delivery.skipped === 0)
    && delivery.succeeded === delivery.attempted
    && Array.isArray(delivery.failures)
    && delivery.failures.length === 0;
}

function reportStatus(value: unknown): ModusReportStatus | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  return status === "succeeded" || status === "partial" || status === "failed" ? status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item: unknown): item is string => typeof item === "string");
}
