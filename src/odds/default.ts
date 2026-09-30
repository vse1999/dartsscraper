import type { Browser, BrowserContext, Page, Response, Route } from "playwright-core";
import type { OddsDay, OddsIdentityReader, OddsMatch, OddsMatchIdentityEvidence, OddsReader, OddsReport } from "./contracts.js";
import { parseEredmenyekMatchIdentity, parseEredmenyekPlayerProfile, profileUrlsFromDetailUrl, type EredmenyekPlayerProfile } from "./identity.js";
import { parseEredmenyekRenderedOdds, type EredmenyekRenderedOddsResult } from "./parser.js";
import { abortError, throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import { appendCleanupError, closeLateBrowser, closeLateContext, enqueueBrowserRun, ensureHttpStatus, errorMessage, filterElapsedMatches, hasTippmixProMapping, requestedDateFor, safeUrl } from "./runtime.js";
import { ConsoleLogger } from "../logger.js";

const SOURCE_ORIGIN = "https://www.eredmenyek.com";
const TODAY_PATH = "/darts/oddsok/";
const TOMORROW_PATH = "/darts/oddsok/holnap/";
const TIME_ZONE = "Europe/Budapest";
const CACHE_TTL_MS = 5 * 60 * 1_000;
const TOTAL_TIMEOUT_MS = 45_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
const RENDER_TIMEOUT_MS = 15_000;
const IDENTITY_REQUEST_TIMEOUT_MS = 8_000;
const IDENTITY_MAX_HTML_BYTES = 2_500_000;
const IDENTITY_TIMEOUT_MESSAGE = "Eredmenyek identity read timed out.";
// Keep profile verification within the shared source latency budget. The value
// layer exposes this declared capacity and abstains from any residual guesses.
const IDENTITY_MAX_MATCHES = 12;
const VISIBLE_SOURCE_COVERAGE_WARNING = "Visible source coverage only; not a complete PDC market inventory.";
const ALLOWED_SUBRESOURCE_HOSTS = new Set([
  "www.eredmenyek.com",
  "global.flashscore.ninja",
  "15.flashscore.ninja",
  "static.flashscore.com",
]);

export interface DefaultOddsReaderOptions {
  readonly executablePath?: string;
  /** Injectable wall clock for deterministic date/cache tests. */
  readonly now?: () => Date;
  /** Internal identity wall-clock bound; injectable only for deterministic tests. */
  readonly identityTimeoutMs?: number;
  /** Per-document public identity request bound; injectable only for deterministic tests. */
  readonly identityRequestTimeoutMs?: number;
  /** Optional structured identity summary sink; defaults to safe console info/warn output. */
  readonly identityLogger?: (summary: OddsIdentitySummary) => void;
}

export interface OddsIdentitySummary {
  readonly stage: "complete" | "partial-timeout" | "cancelled" | "failed";
  readonly requestedMatches: number;
  readonly detailRequests: number;
  readonly profileRequests: number;
  readonly verifiedMatches: number;
  readonly failedMatches: number;
  readonly timedOut: boolean;
}

export class OddsSourceError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OddsSourceError";
  }
}

interface CachedReport { readonly report: OddsReport; readonly cachedAt: number; }
interface RenderedCapture { readonly html: string; readonly dateLabel: string; readonly scripts: readonly string[]; }
interface RenderState { readonly rows: number; readonly loading: boolean; }
interface SharedRun {
  readonly day: OddsDay;
  readonly controller: AbortController;
  readonly promise: Promise<OddsReport>;
  readonly timeout: ReturnType<typeof setTimeout>;
  waiters: number;
  settled: boolean;
}

interface IdentityRunStats {
  readonly requestedMatches: number;
  detailRequests: number;
  profileRequests: number;
  verifiedMatches: number;
  failedMatches: number;
  timedOut: boolean;
  externallyAborted: boolean;
}

class EredmenyekOddsReader implements OddsReader, OddsIdentityReader {
  public readonly maxIdentityEvidenceMatches = IDENTITY_MAX_MATCHES;
  private readonly executablePath: string | undefined;
  private readonly now: () => Date;
  private readonly identityTimeoutMs: number;
  private readonly identityRequestTimeoutMs: number;
  private readonly identityLogger: (summary: OddsIdentitySummary) => void;
  private readonly cache = new Map<OddsDay, CachedReport>();
  private readonly inFlight = new Map<OddsDay, SharedRun>();

  public constructor(options: DefaultOddsReaderOptions) {
    const configuredPath = options.executablePath ?? process.env.ODDS_BROWSER_EXECUTABLE_PATH;
    this.executablePath = configuredPath === undefined || configuredPath.trim() === "" ? undefined : configuredPath;
    this.now = options.now ?? ((): Date => new Date());
    this.identityTimeoutMs = positiveTimeout(options.identityTimeoutMs ?? TOTAL_TIMEOUT_MS, "identityTimeoutMs");
    this.identityRequestTimeoutMs = positiveTimeout(options.identityRequestTimeoutMs ?? IDENTITY_REQUEST_TIMEOUT_MS, "identityRequestTimeoutMs");
    this.identityLogger = options.identityLogger ?? defaultIdentityLogger;
  }

  public async getOdds(day: OddsDay, signal?: AbortSignal): Promise<OddsReport> {
    validateDay(day);
    throwIfAborted(signal);
    const now = validNow(this.now());
    const requestedDate = requestedDateFor(day, now);
    const cached = this.cache.get(day);
    const cacheAge = cached === undefined ? Number.POSITIVE_INFINITY : now.getTime() - cached.cachedAt;
    if (cached !== undefined && cached.report.date === requestedDate && cacheAge >= 0 && cacheAge < CACHE_TTL_MS) {
      const cachedResult = Promise.resolve().then((): OddsReport => {
        const current = validNow(this.now());
        if (cached.report.date !== requestedDateFor(day, current)) throw new OddsSourceError("Eredmenyek cached date is no longer current for this request.");
        return filterElapsedMatches(cached.report, current);
      });
      return waitWithSignal(cachedResult, signal);
    }
    if (cached !== undefined && cached.report.date !== requestedDate) this.cache.delete(day);

    let shared = this.inFlight.get(day);
    if (shared === undefined) {
      shared = this.startSharedRun(day);
      this.inFlight.set(day, shared);
    }
    return this.waitForShared(shared, signal);
  }

  public async getIdentityEvidence(
    matches: readonly OddsMatch[],
    date: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, OddsMatchIdentityEvidence>> {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new OddsSourceError("Eredmenyek identity date must be YYYY-MM-DD.");
    throwIfAborted(signal);
    if (matches.length === 0) {
      emitIdentitySummary(this.identityLogger, { requestedMatches: 0, detailRequests: 0, profileRequests: 0, verifiedMatches: 0, failedMatches: 0, timedOut: false, externallyAborted: false }, "complete");
      return new Map<string, OddsMatchIdentityEvidence>();
    }
    const controller = new AbortController();
    const timeout = setTimeout((): void => controller.abort(new Error(IDENTITY_TIMEOUT_MESSAGE)), this.identityTimeoutMs);
    const stats: IdentityRunStats = { requestedMatches: Math.min(matches.length, IDENTITY_MAX_MATCHES), detailRequests: 0, profileRequests: 0, verifiedMatches: 0, failedMatches: 0, timedOut: false, externallyAborted: false };
    const onAbort = (): void => { stats.externallyAborted = true; controller.abort(signal?.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      throwIfAborted(signal);
      const operation = enqueueBrowserRun(
        (): Promise<ReadonlyMap<string, OddsMatchIdentityEvidence>> => this.fetchIdentityEvidence(matches.slice(0, IDENTITY_MAX_MATCHES), date, controller.signal, stats),
        controller.signal,
      );
      try {
        const result = await waitWithSignal(operation, controller.signal);
        if (stats.externallyAborted) throw abortError(signal ?? controller.signal);
        emitIdentitySummary(this.identityLogger, stats, "complete");
        if (stats.externallyAborted) throw abortError(signal ?? controller.signal);
        return result;
      } catch (error: unknown) {
        if (!isInternalIdentityTimeout(controller.signal, stats.externallyAborted)) {
          emitIdentitySummary(this.identityLogger, stats, stats.externallyAborted ? "cancelled" : "failed");
          throw error;
        }
        stats.timedOut = true;
        try {
          const partial = await operation;
          if (stats.externallyAborted) {
            emitIdentitySummary(this.identityLogger, stats, "cancelled");
            throw abortError(signal ?? controller.signal);
          }
          emitIdentitySummary(this.identityLogger, stats, "partial-timeout");
          if (stats.externallyAborted) throw abortError(signal ?? controller.signal);
          return partial;
        } catch (operationError: unknown) {
          if (stats.externallyAborted) {
            emitIdentitySummary(this.identityLogger, stats, "cancelled");
            throw abortError(signal ?? controller.signal);
          }
          void operationError;
          emitIdentitySummary(this.identityLogger, stats, "partial-timeout");
          if (stats.externallyAborted) throw abortError(signal ?? controller.signal);
          return new Map<string, OddsMatchIdentityEvidence>();
        }
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private startSharedRun(day: OddsDay): SharedRun {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Eredmenyek odds read timed out (including queue wait).")), TOTAL_TIMEOUT_MS);
    let shared: SharedRun;
    const operation = enqueueBrowserRun(() => this.fetchFresh(day, controller.signal), controller.signal);
    const promise = operation.then((report: OddsReport): OddsReport => {
      throwIfAborted(controller.signal);
      this.cache.set(day, { report, cachedAt: validNow(this.now()).getTime() });
      return report;
    }).finally((): void => {
      clearTimeout(timeout);
      shared.settled = true;
      if (this.inFlight.get(day) === shared) this.inFlight.delete(day);
    });
    shared = { day, controller, promise, timeout, waiters: 0, settled: false };
    return shared;
  }

  private waitForShared(shared: SharedRun, signal: AbortSignal | undefined): Promise<OddsReport> {
    throwIfAborted(signal);
    shared.waiters += 1;
    return new Promise<OddsReport>((resolve, reject) => {
      let settled = false;
      const release = (): void => {
        if (settled) return;
        settled = true;
        shared.waiters = Math.max(0, shared.waiters - 1);
        if (shared.waiters === 0 && !shared.settled) shared.controller.abort(new Error("Eredmenyek odds read cancelled: no callers remain."));
      };
      const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        if (settled) return;
        cleanup();
        release();
        reject(signal === undefined ? new Error("Operation was cancelled.") : abortError(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) { onAbort(); return; }
      shared.promise.then(
        (report: OddsReport): void => {
          if (settled) return;
          try {
            const current = validNow(this.now());
            if (report.date !== requestedDateFor(shared.day, current)) throw new OddsSourceError("Eredmenyek returned a date that is no longer current for this request.");
            cleanup();
            release();
            resolve(filterElapsedMatches(report, current));
          } catch (error: unknown) {
            cleanup();
            release();
            reject(error);
          }
        },
        (error: unknown): void => { if (settled) return; cleanup(); release(); reject(error); },
      );
    });
  }

  private async fetchFresh(day: OddsDay, timeoutSignal: AbortSignal): Promise<OddsReport> {
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let lateBrowserCleanup: Promise<void> | undefined;
    let lateContextCleanup: Promise<void> | undefined;
    let operationError: unknown;
    let result: OddsReport | undefined;
    try {
      throwIfAborted(timeoutSignal);
      const playwright = await waitWithSignal(import("playwright-core"), timeoutSignal);
      const chromiumModule = await waitWithSignal(import("@sparticuz/chromium"), timeoutSignal);
      const chromiumRuntime = chromiumModule.default;
      const executablePath = this.executablePath ?? await waitWithSignal(chromiumRuntime.executablePath(), timeoutSignal);
      const launchPromise = playwright.chromium.launch({
        headless: true,
        executablePath,
        ...(this.executablePath === undefined ? { args: chromiumRuntime.args } : {}),
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      try {
        browser = await waitWithSignal(launchPromise, timeoutSignal);
      } catch (error: unknown) {
        lateBrowserCleanup = closeLateBrowser(launchPromise);
        throw error;
      }
      const contextPromise = browser.newContext({
        locale: "hu-HU",
        timezoneId: TIME_ZONE,
        serviceWorkers: "block",
      });
      try {
        context = await waitWithSignal(contextPromise, timeoutSignal);
      } catch (error: unknown) {
        lateContextCleanup = closeLateContext(contextPromise);
        throw error;
      }
      const page = await waitWithSignal(context.newPage(), timeoutSignal);
      page.setDefaultTimeout(RENDER_TIMEOUT_MS);
      let fatalResponse: string | undefined;
      page.on("response", (response: Response): void => {
        const status = response.status();
        if (status !== 401 && status !== 403 && status !== 429) return;
        const resourceType = response.request().resourceType();
        fatalResponse = `Eredmenyek ${resourceType} resource is unavailable (HTTP ${status}).`;
      });
      const sourceUrl = requestedUrl(day);
      await this.configurePage(page, sourceUrl);
      const sourceResponse = await waitWithSignal(page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }), timeoutSignal);
      if (sourceResponse === null) throw new OddsSourceError("Eredmenyek returned no main document response.");
      ensureHttpStatus(sourceResponse, "main Eredmenyek document");
      if (page.url() !== sourceUrl) throw new OddsSourceError("Eredmenyek redirected away from the fixed odds page.");
      const initialChallenge = await waitWithSignal(page.evaluate((): boolean => {
        const text = `${document.title}\n${document.body?.innerText.slice(0, 4_000) ?? ""}`;
        return /(?:checking your browser|just a moment|access denied|verify you are human|unusual traffic|captcha)/iu.test(text);
      }), timeoutSignal);
      if (initialChallenge) throw new OddsSourceError("Eredmenyek returned a challenge page instead of rendered odds.");

      await waitWithSignal(page.waitForFunction((): boolean => {
        const root = document.querySelector("#live-table");
        if (root === null) return false;
        const date = root?.querySelector('[data-testid="wcl-dayPickerButton"]');
        const oddsTab = root?.querySelector('.filters__tab.selected[data-analytics-alias="odds"]');
        const rowNodes = Array.from(root.querySelectorAll(".sportName.darts .event__match"));
        const emptyText = root.textContent ?? "";
        const empty = root.querySelector("[data-testid*='empty' i], .empty, .emptyState, .noEvents") !== null
          || /(?:nincs(?:enek)?\s+(?:mérkőzések|események)|no\s+(?:matches|events))/iu.test(emptyText);
        let rowsWithRenderedOdds = false;
        for (const row of rowNodes) {
          const odd1 = row.querySelectorAll(".event__odd--odd1");
          const odd2 = row.querySelectorAll(".event__odd--odd2");
          const firstOdd = odd1[0];
          const secondOdd = odd2[0];
          const firstValue = firstOdd?.querySelector("span")?.textContent?.trim() ?? "";
          const secondValue = secondOdd?.querySelector("span")?.textContent?.trim() ?? "";
          if (firstOdd !== undefined && secondOdd !== undefined && odd1.length === 1 && odd2.length === 1 && firstValue !== "" && secondValue !== "") rowsWithRenderedOdds = true;
        }
        return date !== null && oddsTab !== null && (rowsWithRenderedOdds || empty);
      }, undefined, { timeout: RENDER_TIMEOUT_MS }), timeoutSignal);
      if (fatalResponse !== undefined) throw new OddsSourceError(fatalResponse);
      const challenge = await waitWithSignal(page.evaluate((): boolean => {
        const text = `${document.title}\n${document.body?.innerText.slice(0, 4_000) ?? ""}`;
        return /(?:checking your browser|just a moment|access denied|verify you are human|unusual traffic|captcha)/iu.test(text);
      }), timeoutSignal);
      if (challenge) throw new OddsSourceError("Eredmenyek returned a challenge page instead of rendered odds.");
      const capture = await waitWithSignal(page.evaluate((): RenderedCapture | null => {
        const root = document.querySelector("#live-table");
        const dateButton = root?.querySelector('[data-testid="wcl-dayPickerButton"]');
        if (!(root instanceof HTMLElement) || !(dateButton instanceof HTMLElement)) return null;
        const scripts = Array.from(document.scripts, (script: HTMLScriptElement): string => script.textContent ?? "").join("\n");
        return {
          html: root.outerHTML,
          dateLabel: dateButton.getAttribute("aria-label") ?? "",
          scripts: [scripts],
        };
      }), timeoutSignal);
      if (fatalResponse !== undefined) throw new OddsSourceError(fatalResponse);
      if (capture === null) throw new OddsSourceError("Eredmenyek rendered odds container is unavailable.");
      const renderState = await waitWithSignal(page.evaluate((): RenderState => {
        const root = document.querySelector("#live-table");
        const overlay = root?.querySelector(".loadingOverlay");
        const loadingStyle = overlay instanceof HTMLElement ? window.getComputedStyle(overlay) : undefined;
        return {
          rows: root?.querySelectorAll(".sportName.darts .event__match").length ?? 0,
          loading: loadingStyle !== undefined && loadingStyle.display !== "none" && loadingStyle.visibility !== "hidden",
        };
      }), timeoutSignal);
      if (renderState.rows === 0 && renderState.loading) throw new OddsSourceError("Eredmenyek odds page remained in a loading state.");
      if (!hasTippmixProMapping(capture.scripts)) throw new OddsSourceError("Eredmenyek bookmaker mapping is missing or drifted; TippmixPro 498 was not verified.");

      const observationTime = validNow(this.now());
      const observedAt = observationTime.toISOString();
      let parsed: EredmenyekRenderedOddsResult;
      try {
        parsed = parseEredmenyekRenderedOdds({
          html: capture.html,
          sourceUrl,
          observedAt,
          requestedDate: requestedDateFor(day, observationTime),
          dateLabel: capture.dateLabel,
          bookmakerMappingValidated: true,
        });
      } catch (error: unknown) {
        if (error instanceof OddsSourceError) throw error;
        throw new OddsSourceError(`Eredmenyek rendered odds structure was unavailable: ${errorMessage(error)}`, error);
      }
      result = {
        source: "eredmenyek",
        sourceUrl,
        observedAt,
        date: parsed.date,
        timeZone: TIME_ZONE,
        matches: parsed.matches,
        warnings: [...parsed.warnings, VISIBLE_SOURCE_COVERAGE_WARNING],
      };
      throwIfAborted(timeoutSignal);
    } catch (error: unknown) {
      operationError = error;
    } finally {
      if (lateBrowserCleanup !== undefined) {
        try { await lateBrowserCleanup; } catch (error: unknown) { operationError = appendCleanupError(operationError, "late browser", error); }
      }
      if (lateContextCleanup !== undefined) {
        try { await lateContextCleanup; } catch (error: unknown) { operationError = appendCleanupError(operationError, "late browser context", error); }
      }
      if (context !== undefined) {
        try { await context.close(); } catch (error: unknown) { operationError = appendCleanupError(operationError, "browser context", error); }
      }
      if (browser !== undefined) {
        try { await browser.close(); } catch (error: unknown) { operationError = appendCleanupError(operationError, "browser", error); }
      }
    }
    if (operationError !== undefined) throw toSourceError(operationError);
    if (result === undefined) throw new OddsSourceError("Eredmenyek odds read ended without a result.");
    return result;
  }

  private async fetchIdentityEvidence(
    matches: readonly OddsMatch[],
    date: string,
    timeoutSignal: AbortSignal,
    stats: IdentityRunStats,
  ): Promise<ReadonlyMap<string, OddsMatchIdentityEvidence>> {
    const evidence = new Map<string, OddsMatchIdentityEvidence>();
    for (const match of matches) {
      try {
        throwIfAborted(timeoutSignal);
        const detailUrl = validatedDetailUrl(match.sourceUrl, match.eventId);
        if (detailUrl === undefined) continue;
        stats.detailRequests += 1;
        const html = await this.fetchIdentityDocument(detailUrl, timeoutSignal);
        const profileUrls = profileUrlsFromDetailUrl(detailUrl, match.eventId);
        const verifiedProfiles: EredmenyekPlayerProfile[] = [];
        for (const profileUrl of profileUrls) {
          stats.profileRequests += 1;
          const profileHtml = await this.fetchIdentityDocument(profileUrl, timeoutSignal);
          verifiedProfiles.push(parseEredmenyekPlayerProfile({ html: profileHtml, profileUrl }));
        }
        const parsed = parseEredmenyekMatchIdentity({ html, detailUrl, match, date, profileUrls, verifiedProfiles });
        evidence.set(match.eventId, parsed);
        stats.verifiedMatches += 1;
      } catch (error: unknown) {
        if (isInternalIdentityTimeout(timeoutSignal, stats.externallyAborted)) {
          stats.timedOut = true;
          return evidence;
        }
        if (timeoutSignal.aborted) throw toSourceError(error);
        stats.failedMatches += 1;
        // A single stale, redirected, oversized, or unavailable document must
        // not make other already-verifiable matchups unsafe.
      }
    }
    return evidence;
  }

  private async fetchIdentityDocument(url: string, timeoutSignal: AbortSignal): Promise<string> {
    const requestController = new AbortController();
    const abortRequest = (): void => requestController.abort(timeoutSignal.reason);
    timeoutSignal.addEventListener("abort", abortRequest, { once: true });
    const requestTimeout = setTimeout((): void => requestController.abort(new Error(`Eredmenyek identity document timed out: ${url}`)), this.identityRequestTimeoutMs);
    try {
      throwIfAborted(timeoutSignal);
      const response = await waitWithSignal(fetch(url, { redirect: "error", signal: requestController.signal, headers: { accept: "text/html" } }), requestController.signal);
      if (response.url !== url) throw new OddsSourceError("Eredmenyek identity document redirected away from its validated URL.");
      ensureIdentityHttpStatus(response, url);
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number.isFinite(Number(contentLength)) && Number(contentLength) > IDENTITY_MAX_HTML_BYTES) {
        throw new OddsSourceError("Eredmenyek identity document exceeded the bounded HTML size.");
      }
      return await readBoundedIdentityHtml(response, requestController.signal);
    } finally {
      clearTimeout(requestTimeout);
      timeoutSignal.removeEventListener("abort", abortRequest);
    }
  }

  private async configurePage(page: Page, targetUrl: string, allowedDocumentUrls: Set<string> = new Set([targetUrl])): Promise<void> {
    await page.route("**/*", async (route: Route): Promise<void> => {
      const request = route.request();
      const requestUrl = safeUrl(request);
      const resourceType = request.resourceType();
      if (requestUrl === undefined || requestUrl.protocol !== "https:" || requestUrl.username !== "" || requestUrl.password !== "" || requestUrl.port !== "" || !ALLOWED_SUBRESOURCE_HOSTS.has(requestUrl.hostname) || ["image", "media", "font"].includes(resourceType)) {
        await route.abort("blockedbyclient");
        return;
      }
      if (resourceType === "document" && (requestUrl.origin !== SOURCE_ORIGIN || !allowedDocumentUrls.has(requestUrl.toString()))) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
  }

}

export function createDefaultOddsReader(options: DefaultOddsReaderOptions = {}): OddsReader & OddsIdentityReader {
  return new EredmenyekOddsReader(options);
}

function requestedUrl(day: OddsDay): string { return `${SOURCE_ORIGIN}${day === "today" ? TODAY_PATH : TOMORROW_PATH}`; }

function validatedDetailUrl(raw: string, eventId: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.origin !== SOURCE_ORIGIN || url.username !== "" || url.password !== "" || url.port !== "" || !/^\/merkozes\/darts\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/$/u.test(url.pathname) || url.hash !== "" || url.searchParams.getAll("mid").length !== 1 || url.searchParams.get("mid") !== eventId || [...url.searchParams.keys()].some((key) => key !== "mid")) return undefined;
    return url.toString();
  } catch (error: unknown) {
    void error;
    return undefined;
  }
}

function validateDay(day: OddsDay): void {
  if (day !== "today" && day !== "tomorrow") throw new OddsSourceError("Odds day must be 'today' or 'tomorrow'.");
}

function toSourceError(error: unknown): OddsSourceError {
  if (error instanceof OddsSourceError) return error;
  if (error instanceof Error && error.name === "AbortError") return new OddsSourceError("Eredmenyek odds read was cancelled or timed out.", error);
  return new OddsSourceError(`Eredmenyek odds read failed: ${errorMessage(error)}`, error);
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new OddsSourceError("Odds reader clock returned an invalid date.");
  return value;
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new OddsSourceError(`${label} must be a positive finite number.`);
  return value;
}

function isInternalIdentityTimeout(signal: AbortSignal, externallyAborted: boolean): boolean {
  return !externallyAborted && signal.aborted && signal.reason instanceof Error && signal.reason.message === IDENTITY_TIMEOUT_MESSAGE;
}

function emitIdentitySummary(logger: (summary: OddsIdentitySummary) => void, stats: IdentityRunStats, stage: OddsIdentitySummary["stage"]): void {
  try {
    logger({
      stage,
      requestedMatches: stats.requestedMatches,
      detailRequests: stats.detailRequests,
      profileRequests: stats.profileRequests,
      verifiedMatches: stats.verifiedMatches,
      failedMatches: stats.failedMatches,
      timedOut: stats.timedOut,
    });
  } catch (error: unknown) {
    void error;
  }
}

function defaultIdentityLogger(summary: OddsIdentitySummary): void {
  const logger = defaultIdentityLoggerInstance();
  const message = "eredmenyek_identity_summary";
  const context = { ...summary };
  if (summary.stage === "complete") logger.info(message, context);
  else logger.warn(message, context);
}

let identityLoggerInstance: ConsoleLogger | undefined;

function defaultIdentityLoggerInstance(): ConsoleLogger {
  identityLoggerInstance ??= new ConsoleLogger({ minimumLevel: "info" });
  return identityLoggerInstance;
}

function ensureIdentityHttpStatus(response: globalThis.Response, url: string): void {
  if (response.status === 401 || response.status === 403 || response.status === 429) throw new OddsSourceError(`Eredmenyek identity document ${url} is unavailable (HTTP ${response.status}).`);
  if (!response.ok) throw new OddsSourceError(`Eredmenyek identity document ${url} returned HTTP ${response.status}.`);
}

async function readBoundedIdentityHtml(response: globalThis.Response, signal: AbortSignal): Promise<string> {
  const body = response.body;
  if (body === null) {
    const text = await waitWithSignal(response.text(), signal);
    if (new TextEncoder().encode(text).byteLength > IDENTITY_MAX_HTML_BYTES) throw new OddsSourceError("Eredmenyek identity document exceeded the bounded HTML size.");
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let readPending = false;
  try {
    while (true) {
      throwIfAborted(signal);
      readPending = true;
      const result = await waitWithSignal(reader.read(), signal);
      readPending = false;
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > IDENTITY_MAX_HTML_BYTES) {
        void reader.cancel().catch((): void => undefined);
        throw new OddsSourceError("Eredmenyek identity document exceeded the bounded HTML size.");
      }
      chunks.push(result.value);
    }
  } finally {
    if (!readPending) reader.releaseLock();
    void reader.cancel().catch((): void => undefined);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
