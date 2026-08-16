import { noopLogger, type Logger } from "../logger.js";
import {
  MODUS_RESULTS_URL,
  MODUS_RESULT_GROUPS,
  type ModusHistoricalMatch,
  type ModusMatchReference,
  type ModusResultGroup,
  type ModusResultsIndex,
} from "./history-schemas.js";
import { parseModusMatchDetails } from "./match-details-source.js";
import {
  buildModusResultsUrl,
  parseModusResultsPage,
  type ParsedModusResultsPage,
} from "./results-index-source.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PARALLEL_GROUP_REQUESTS = 4;

export class OfficialModusHistorySourceError extends Error {
  public readonly url: string;
  public readonly status: number | undefined;

  public constructor(message: string, details: { readonly url: string; readonly status?: number; readonly cause?: unknown }) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = new.target.name;
    this.url = details.url;
    this.status = details.status;
  }
}

export interface OfficialModusHistorySourceOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

export interface OfficialModusHistoryReader {
  getLiveReferences(index: ModusResultsIndex, signal?: AbortSignal): Promise<readonly ModusMatchReference[]>;
  getMatchDetails(matchId: string, signal?: AbortSignal): Promise<ModusHistoricalMatch>;
}

export class OfficialModusHistorySource implements OfficialModusHistoryReader {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  public constructor(options: OfficialModusHistorySourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = positiveFinite(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.logger = options.logger ?? noopLogger;
  }

  public async getResultsPage(
    seriesId?: string,
    weekId?: string,
    group?: ModusResultGroup,
    signal?: AbortSignal,
  ): Promise<ParsedModusResultsPage> {
    const url = resultsUrl(seriesId, weekId, group);
    const html = await this.fetchText(url, signal);
    try {
      return parseModusResultsPage(html, url);
    } catch (error: unknown) {
      throw new OfficialModusHistorySourceError(
        `The official MODUS results page changed structure: ${errorMessage(error)}`,
        { url, cause: error },
      );
    }
  }

  public async getLiveReferences(index: ModusResultsIndex, signal?: AbortSignal): Promise<readonly ModusMatchReference[]> {
    const root = await this.getResultsPage(undefined, undefined, undefined, signal);
    const knownSeries = new Set(index.series.map((series) => series.id));
    const lastKnownSeries = index.series.at(-1);
    const candidateSeries = root.series.filter((series) => {
      return !knownSeries.has(series.id) || series.id === lastKnownSeries?.id || series.id === root.selectedSeriesId;
    });
    const pages: ParsedModusResultsPage[] = [];
    for (const series of candidateSeries) {
      if (signal?.aborted === true) throw signal.reason;
      const seriesPage = series.id === root.selectedSeriesId
        ? root
        : await this.getResultsPage(series.id, undefined, "Group A", signal);
      const knownWeekIds = new Set(index.series.find((item) => item.id === series.id)?.weeks.map((week) => week.id) ?? []);
      const weeksToRefresh = seriesPage.weeks.filter((week) => {
        const isCurrentWeek = series.id === root.selectedSeriesId && week.id === root.selectedWeekId;
        return isCurrentWeek || !knownWeekIds.has(week.id);
      });
      for (const week of weeksToRefresh) {
        const groupPages = await mapWithConcurrency(
          MODUS_RESULT_GROUPS,
          MAX_PARALLEL_GROUP_REQUESTS,
          async (group: ModusResultGroup): Promise<ParsedModusResultsPage> => {
            const canReuse = seriesPage.selectedSeriesId === series.id
              && seriesPage.selectedWeekId === week.id
              && seriesPage.selectedGroup === group;
            return canReuse ? seriesPage : this.getResultsPage(series.id, week.id, group, signal);
          },
        );
        pages.push(...groupPages);
      }
    }
    const references = deduplicateReferences(pages.flatMap((page) => page.matches));
    this.logger.debug("Official MODUS live catalogue refresh completed.", {
      seriesChecked: candidateSeries.length,
      pagesChecked: pages.length,
      matchesFound: references.length,
    });
    return references;
  }

  public async getMatchDetails(matchId: string, signal?: AbortSignal): Promise<ModusHistoricalMatch> {
    if (!/^\d+$/u.test(matchId)) throw new Error("MODUS matchId must contain only digits.");
    const url = new URL("https://modussuperseries.com/match-db-stats.php");
    url.searchParams.set("match_id", matchId);
    const sourceUrl = url.toString();
    const html = await this.fetchText(sourceUrl, signal);
    try {
      return parseModusMatchDetails(html, sourceUrl);
    } catch (error: unknown) {
      throw new OfficialModusHistorySourceError(
        `Official MODUS match ${matchId} changed structure: ${errorMessage(error)}`,
        { url: sourceUrl, cause: error },
      );
    }
  }

  private async fetchText(url: string, callerSignal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = (): void => controller.abort(callerSignal?.reason ?? new Error("MODUS request cancelled."));
    if (callerSignal?.aborted === true) abortFromCaller();
    else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("MODUS request timed out."));
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        cache: "no-store",
        headers: { Accept: "text/html", "User-Agent": "DartsResearchAgent/0.4" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new OfficialModusHistorySourceError(
          `The official MODUS source returned HTTP ${response.status}.`,
          { url, status: response.status },
        );
      }
      const body = await response.text();
      if (body.trim() === "") throw new OfficialModusHistorySourceError("The official MODUS source returned an empty page.", { url });
      return body;
    } catch (error: unknown) {
      if (error instanceof OfficialModusHistorySourceError) throw error;
      const message = timedOut ? `The official MODUS source timed out after ${this.timeoutMs} ms.` : "The official MODUS source request failed.";
      throw new OfficialModusHistorySourceError(message, { url, cause: error });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

function resultsUrl(seriesId?: string, weekId?: string, group?: ModusResultGroup): string {
  if (seriesId !== undefined && weekId !== undefined && group !== undefined) {
    return buildModusResultsUrl(seriesId, weekId, group);
  }
  const url = new URL(MODUS_RESULTS_URL);
  if (seriesId !== undefined) {
    requireNumericId(seriesId, "seriesId");
    url.searchParams.set("series_id", seriesId);
  }
  if (weekId !== undefined) {
    requireNumericId(weekId, "weekId");
    url.searchParams.set("week_id", weekId);
  }
  if (group !== undefined) url.searchParams.set("group", group);
  return url.toString();
}

function deduplicateReferences(references: readonly ModusMatchReference[]): ModusMatchReference[] {
  const byId = new Map<string, ModusMatchReference>();
  for (const reference of references) byId.set(reference.matchId, reference);
  return [...byId.values()];
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function requireNumericId(value: string, label: string): void {
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must contain only digits.`);
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
