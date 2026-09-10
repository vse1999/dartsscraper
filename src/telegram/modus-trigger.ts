import type { ModusReportDateExpression, ModusReportTrigger } from "./modus-command.js";

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
        if (!response.ok) throw new Error(`MODUS report endpoint returned HTTP ${response.status}.`);
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
