import { randomUUID } from "node:crypto";
import { signPdcJob, PDC_JOB_MAX_BYTES, type PdcReportJob } from "../pdc/report-job-protocol.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";

export interface PdcReportJobDispatcher { dispatch(job: PdcReportJob, signal?: AbortSignal): Promise<void>; }
export class PdcJobDispatchError extends Error {
  public constructor(message: string, public readonly uncertain: boolean, cause?: unknown, public readonly statusCode?: number) { super(message, cause === undefined ? undefined : { cause }); this.name = new.target.name; }
}
export function createPdcJobDispatcher(options: {
  readonly endpointUrl: string; readonly cronSecret: string; readonly signingSecret: string; readonly fetchImpl?: typeof fetch;
}): PdcReportJobDispatcher {
  const endpoint = new URL(options.endpointUrl);
  const local = ["localhost", "127.0.0.1"].includes(endpoint.hostname);
  if ((endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:")) || endpoint.username !== "" || endpoint.password !== "" || endpoint.pathname !== "/api/pdc-report" || endpoint.search !== "" || endpoint.hash !== "") throw new Error("PDC job endpoint must be an HTTPS /api/pdc-report URL (HTTP allowed only on localhost).");
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(options.cronSecret)) throw new Error("PDC jobs require a valid CRON_SECRET.");
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(options.signingSecret)) throw new Error("PDC jobs require a valid signing secret.");
  const fetchImpl = options.fetchImpl ?? fetch;
  return { async dispatch(job: PdcReportJob, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const body = JSON.stringify(signPdcJob(job, options.signingSecret));
    if (Buffer.byteLength(body) > PDC_JOB_MAX_BYTES) throw new Error("PDC continuation exceeds the bounded payload size.");
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    const timeout = setTimeout((): void => controller.abort(), 10_000);
    try {
      const response = await waitWithSignal(fetchImpl(endpoint, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${options.cronSecret}`, "content-type": "application/json" }, body, signal: controller.signal }), controller.signal);
      if (response.status !== 202) throw new PdcJobDispatchError(`PDC job endpoint rejected dispatch (HTTP ${response.status}).`, response.status >= 500, undefined, response.status);
      await response.body?.cancel();
    } catch (error: unknown) {
      // Do not automatically repeat a dispatch: an accepted background job may
      // already be sending cards when a network response is lost.
      throw error instanceof PdcJobDispatchError ? error : new PdcJobDispatchError("PDC job dispatch could not be confirmed.", true, error);
    } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
  } };
}
export function newPdcReportJob(date: string, acknowledgementMessageId: number): PdcReportJob {
  return { version: 1, jobId: randomUUID(), date, createdAt: new Date().toISOString(), acknowledgementMessageId, cursor: 0 };
}
