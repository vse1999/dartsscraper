import type { Browser, BrowserContext, Request, Response } from "playwright-core";
import type { OddsDay, OddsReport } from "./contracts.js";
import { abortError } from "../services/cancellation.js";

const TIME_ZONE = "Europe/Budapest";
const SOURCE_ORIGIN = "https://www.eredmenyek.com";
const MAX_QUEUED_RUNS = 2;

interface BrowserQueueItem {
  readonly signal: AbortSignal;
  readonly work: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly onAbort: () => void;
  started: boolean;
}

const browserQueue: BrowserQueueItem[] = [];
let browserRunActive = false;

export function enqueueBrowserRun<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  if (browserQueue.length >= MAX_QUEUED_RUNS) return Promise.reject(new Error("Eredmenyek odds reader is busy; retry after the active bounded read completes."));
  return new Promise<T>((resolve, reject) => {
    let item: BrowserQueueItem;
    const onAbort = (): void => {
      if (item.started) return;
      const index = browserQueue.indexOf(item);
      if (index < 0) return;
      browserQueue.splice(index, 1);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    item = {
      signal,
      work: async (): Promise<unknown> => work(),
      resolve: (value: unknown): void => resolve(value as T),
      reject,
      onAbort,
      started: false,
    };
    signal.addEventListener("abort", onAbort, { once: true });
    browserQueue.push(item);
    if (signal.aborted) { onAbort(); return; }
    drainBrowserQueue();
  });
}

function drainBrowserQueue(): void {
  if (browserRunActive) return;
  const next = browserQueue.shift();
  if (next === undefined) return;
  next.started = true;
  next.signal.removeEventListener("abort", next.onAbort);
  if (next.signal.aborted) {
    next.reject(abortError(next.signal));
    drainBrowserQueue();
    return;
  }
  browserRunActive = true;
  void next.work().then(next.resolve, next.reject).finally((): void => {
    browserRunActive = false;
    drainBrowserQueue();
  });
}

export function requestedDateFor(day: OddsDay, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const dayOfMonth = Number(parts.find((part) => part.type === "day")?.value);
  const utc = new Date(Date.UTC(year, month - 1, dayOfMonth + (day === "tomorrow" ? 1 : 0)));
  return utc.toISOString().slice(0, 10);
}

export function filterElapsedMatches(report: OddsReport, now: Date): OddsReport {
  if (report.date !== requestedDateFor("today", now)) return report;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const nowMinutes = Number(parts.find((part) => part.type === "hour")?.value) * 60 + Number(parts.find((part) => part.type === "minute")?.value);
  const matches = report.matches.filter((match) => {
    const [hours, minutes] = match.scheduledTime.split(":").map(Number);
    if (hours === undefined || minutes === undefined) return false;
    return hours * 60 + minutes > nowMinutes;
  });
  if (matches.length === report.matches.length) return report;
  const removed = report.matches.length - matches.length;
  return { ...report, matches, warnings: [...report.warnings, `Filtered ${removed} match(es) whose displayed Budapest start time had passed.`] };
}

export function hasTippmixProMapping(scripts: readonly string[]): boolean {
  for (const script of scripts) {
    const keyPattern = /["']default["']\s*:\s*\[/gu;
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyPattern.exec(script)) !== null) {
      const openingBracket = script.indexOf("[", keyMatch.index);
      if (openingBracket < 0) continue;
      const arrayText = extractBalancedJson(script, openingBracket, "[", "]");
      if (arrayText === undefined) continue;
      let decoded: unknown;
      try { decoded = JSON.parse(arrayText) as unknown; } catch (error: unknown) { void error; continue; }
      if (!Array.isArray(decoded)) continue;
      for (const candidate of decoded) {
        if (!isRecord(candidate)) continue;
        if (candidate.main_bookmaker_id === "498" && candidate.name === "TippmixPro" && candidate.project_id === "15" && candidate.geo_ip === "default") return true;
      }
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractBalancedJson(source: string, openingIndex: number, opening: "[" | "{", closing: "]" | "}"): string | undefined {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return source.slice(openingIndex, index + 1);
    }
  }
  return undefined;
}

export function appendCleanupError(operationError: unknown, resource: string, cleanupError: unknown): Error {
  const detail = `Eredmenyek ${resource} cleanup failed: ${errorMessage(cleanupError)}`;
  if (operationError === undefined) return new Error(detail, { cause: cleanupError });
  return new Error(`${errorMessage(operationError)}; ${detail}`, { cause: operationError });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "unexpected browser or source error";
}

export async function closeLateBrowser(launchPromise: Promise<Browser>): Promise<void> {
  let browser: Browser;
  try { browser = await launchPromise; } catch (error: unknown) { return; }
  await browser.close();
}

export async function closeLateContext(contextPromise: Promise<BrowserContext>): Promise<void> {
  let context: BrowserContext;
  try { context = await contextPromise; } catch (error: unknown) { return; }
  await context.close();
}

export function safeUrl(request: Request): URL | undefined {
  try { return new URL(request.url()); } catch (error: unknown) { void error; return undefined; }
}

export function ensureHttpStatus(response: Response, resource: string): void {
  const status = response.status();
  if (status === 401 || status === 403 || status === 429) throw new Error(`Eredmenyek ${resource} is unavailable (HTTP ${status}).`);
  if (!response.ok()) throw new Error(`Eredmenyek ${resource} returned HTTP ${status}.`);
}
