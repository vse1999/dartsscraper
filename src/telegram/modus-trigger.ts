import type { ModusReportDateExpression, ModusReportTrigger } from "./modus-command.js";

export interface HttpModusReportTriggerOptions {
  readonly endpointUrl: string;
  readonly cronSecret: string;
  readonly apiFetch?: typeof fetch;
}

export function createHttpModusReportTrigger(options: HttpModusReportTriggerOptions): ModusReportTrigger {
  const endpointUrl = new URL(options.endpointUrl);
  const cronSecret = options.cronSecret.trim();
  if (cronSecret === "") throw new Error("MODUS report trigger cron secret must not be empty.");
  const fetchImpl = options.apiFetch ?? fetch;

  return {
    async start(date: ModusReportDateExpression): Promise<void> {
      const requestUrl = new URL(endpointUrl);
      requestUrl.searchParams.set("date", date);
      const response = await fetchImpl(requestUrl, {
        method: "GET",
        headers: { authorization: `Bearer ${cronSecret}` },
      });
      if (!response.ok) throw new Error(`MODUS report endpoint returned HTTP ${response.status}.`);
    },
  };
}
