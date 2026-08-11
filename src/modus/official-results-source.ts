import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import { z } from "zod";

import { IsoDateSchema } from "../agent/date.js";
import {
  ModusIsoDateTimeSchema,
  ModusResultsContextSchema,
  ModusResultsSnapshotSchema,
  type ModusMatch,
  type ModusResultsContext,
  type ModusResultsSnapshot,
  type ModusWeekAverage,
} from "./results-schemas.js";

const DEFAULT_DAILY_FEED_URL = "https://modussuperseries.com/live-scores-json.php";
const DEFAULT_RESULTS_URL = "https://modussuperseries.com/results.php";
const DEFAULT_TIMEOUT_MS = 15_000;

const DailyCompetitorSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  qualifier: z.enum(["home", "away"]),
});

const DailyStatisticSchema = z.object({
  id: z.string().trim().min(1).optional(),
  qualifier: z.enum(["home", "away"]).optional(),
  statistics: z
    .object({
      average_3_darts: z.number().finite().nonnegative().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const DailySummarySchema = z.object({
  sport_event: z.object({
    id: z.string().trim().min(1),
    start_time: ModusIsoDateTimeSchema,
    competitors: z.array(DailyCompetitorSchema).length(2),
  }),
  sport_event_status: z.object({
    status: z.string().trim().min(1),
    match_status: z.string().trim().min(1).optional(),
    home_score: z.number().int().nonnegative().nullable().optional(),
    away_score: z.number().int().nonnegative().nullable().optional(),
  }),
  statistics: z
    .object({
      totals: z
        .object({ competitors: z.array(DailyStatisticSchema).optional() })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

const DailyFeedSchema = z.object({
  generated_at: ModusIsoDateTimeSchema,
  date: IsoDateSchema,
  summaries: z.array(DailySummarySchema),
});

type DailyFeed = z.infer<typeof DailyFeedSchema>;
type DailySummary = z.infer<typeof DailySummarySchema>;
type DailyCompetitor = z.infer<typeof DailyCompetitorSchema>;
type DailyStatistic = z.infer<typeof DailyStatisticSchema>;

export interface OfficialModusResultsSourceOptions {
  dailyFeedUrl?: string;
  resultsUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export interface ParsedModusResultsContext {
  context: ModusResultsContext;
  weekAveragesUrl: string;
}

export class OfficialModusResultsSourceError extends Error {
  public readonly url: string;

  public constructor(message: string, url: string, cause?: unknown) {
    super(`${message} Source: ${url}`, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.url = url;
  }
}

export class OfficialModusResultsSource {
  private readonly dailyFeedUrl: string;
  private readonly resultsUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private cachedContext: ParsedModusResultsContext | undefined;

  public constructor(options: OfficialModusResultsSourceOptions = {}) {
    this.dailyFeedUrl = validateHttpUrl(options.dailyFeedUrl ?? DEFAULT_DAILY_FEED_URL, "daily feed URL");
    this.resultsUrl = validateHttpUrl(options.resultsUrl ?? DEFAULT_RESULTS_URL, "results URL");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Official MODUS results timeoutMs must be a positive finite number.");
    }
    this.now = options.now ?? (() => new Date());
  }

  public async getResults(date: string, signal?: AbortSignal): Promise<ModusResultsSnapshot> {
    const requestedDate = IsoDateSchema.parse(date);
    const fetchedAt = ModusIsoDateTimeSchema.parse(this.now().toISOString());

    const contextAtRequestStart = this.cachedContext;
    const cachedAveragesRequest = this.fetchCachedAverages(contextAtRequestStart, signal);
    const [dailyFeed, resultsHtml, cachedAveragesHtml] = await Promise.all([
      this.fetchDailyFeed(signal),
      this.fetchText(this.resultsUrl, "text/html", signal),
      cachedAveragesRequest,
    ]);
    if (dailyFeed.date !== requestedDate) {
      throw new OfficialModusResultsSourceError(
        `Official daily feed date mismatch: it reported ${JSON.stringify(dailyFeed.date)} but ${JSON.stringify(requestedDate)} was requested.`,
        this.dailyFeedUrl,
      );
    }

    let parsedContext: ParsedModusResultsContext;
    try {
      parsedContext = parseModusResultsContext(resultsHtml, this.resultsUrl);
    } catch (error: unknown) {
      throw new OfficialModusResultsSourceError(
        `The official results page could not be parsed: ${errorMessage(error)}.`,
        this.resultsUrl,
        error,
      );
    }
    const contextUnchanged = cachedAveragesHtml !== undefined
      && contextAtRequestStart !== undefined
      && sameResultsContext(contextAtRequestStart, parsedContext);
    this.cachedContext = parsedContext;

    let matches: ModusMatch[];
    const warnings: string[] = [];
    try {
      matches = dailyFeed.summaries.map((summary, index) => parseDailyMatch(summary, index, warnings));
    } catch (error: unknown) {
      throw new OfficialModusResultsSourceError(
        `The official daily feed contained an unsafe match record: ${errorMessage(error)}.`,
        this.dailyFeedUrl,
        error,
      );
    }
    try {
      assertResultsPageMatchesDailyFeed(resultsHtml, matches);
    } catch (error: unknown) {
      throw new OfficialModusResultsSourceError(
        `The official results page does not match the daily feed: ${errorMessage(error)}.`,
        this.resultsUrl,
        error,
      );
    }

    const averagesHtml = contextUnchanged
      ? cachedAveragesHtml
      : await this.fetchText(parsedContext.weekAveragesUrl, "text/html", signal);
    let weekAverages: ModusWeekAverage[];
    try {
      weekAverages = parseModusWeekAverages(averagesHtml);
    } catch (error: unknown) {
      throw new OfficialModusResultsSourceError(
        `The official weekly averages page could not be parsed: ${errorMessage(error)}.`,
        parsedContext.weekAveragesUrl,
        error,
      );
    }

    return ModusResultsSnapshotSchema.parse({
      event: "MODUS Super Series",
      date: requestedDate,
      generatedAt: dailyFeed.generated_at,
      fetchedAt,
      context: parsedContext.context,
      matches,
      weekAverages,
      source: {
        dailyFeedUrl: this.dailyFeedUrl,
        resultsUrl: this.resultsUrl,
        weekAveragesUrl: parsedContext.weekAveragesUrl,
      },
      warnings,
    });
  }

  private async fetchDailyFeed(signal?: AbortSignal): Promise<DailyFeed> {
    const body = await this.fetchText(this.dailyFeedUrl, "application/json", signal);
    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch (error: unknown) {
      throw new OfficialModusResultsSourceError(
        `The official daily feed returned invalid JSON: ${errorMessage(error)}.`,
        this.dailyFeedUrl,
        error,
      );
    }
    const parsed = DailyFeedSchema.safeParse(payload);
    if (!parsed.success) {
      throw new OfficialModusResultsSourceError(
        `The official daily feed changed structure: ${formatZodIssues(parsed.error)}.`,
        this.dailyFeedUrl,
        parsed.error,
      );
    }
    return parsed.data;
  }

  private async fetchCachedAverages(context: ParsedModusResultsContext | undefined, signal?: AbortSignal): Promise<string | undefined> {
    if (context === undefined) return undefined;
    try {
      return await this.fetchText(context.weekAveragesUrl, "text/html", signal);
    } catch {
      return undefined;
    }
  }

  private async fetchText(url: string, accept: string, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = (): void => controller.abort(signal?.reason ?? new Error("Official MODUS request was cancelled."));
    if (signal?.aborted === true) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Official MODUS request timed out."));
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        cache: "no-store",
        headers: {
          Accept: accept,
          "User-Agent": "DartsResearchAgent/0.3",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new OfficialModusResultsSourceError(
          `The official MODUS source returned HTTP ${response.status} ${response.statusText}.`,
          url,
        );
      }
      const body = await response.text();
      if (body.trim() === "") {
        throw new OfficialModusResultsSourceError("The official MODUS source returned an empty response.", url);
      }
      return body;
    } catch (error: unknown) {
      if (error instanceof OfficialModusResultsSourceError) throw error;
      if (signal?.aborted === true) {
        throw new OfficialModusResultsSourceError("The official MODUS request was cancelled.", url, error);
      }
      if (timedOut) {
        throw new OfficialModusResultsSourceError(
          `The official MODUS request timed out after ${this.timeoutMs} ms.`,
          url,
          error,
        );
      }
      throw new OfficialModusResultsSourceError(
        `The official MODUS request failed: ${errorMessage(error)}.`,
        url,
        error,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

export function parseModusResultsContext(html: string, resultsUrl: string): ParsedModusResultsContext;
export function parseModusResultsContext(html: string): ParsedModusResultsContext;
export function parseModusResultsContext(html: string, resultsUrl = DEFAULT_RESULTS_URL): ParsedModusResultsContext {
  const validatedResultsUrl = validateHttpUrl(resultsUrl, "results URL");
  const $ = cheerio.load(html);
  const series = selectedOption($, "#seriesSelect, #series", "series");
  const week = selectedOption($, "#weekSelect, #week", "week");
  const activeGroup = $(".group-tabs button.active, nav[aria-label='Groups'] .active, [aria-current='page']").first();
  const group = normalizeGroup(activeGroup);
  if (activeGroup.length !== 1 || group === "") {
    throw new Error("No active MODUS group was found.");
  }

  const averageButton = $(".group-tabs button, a.averages, button.averages").filter((_index, element) => {
    return normalizeText($(element).text()).toLocaleLowerCase("en-US") === "averages";
  }).first();
  if (averageButton.length !== 1) {
    throw new Error("No Averages button was found in the MODUS results page.");
  }
  const onclick = averageButton.attr("onclick") ?? "";
  const observedPath = /location\.href\s*=\s*["']([^"']*week-averages\.php\?[^"']+)["']/i.exec(onclick)?.[1]
    ?? averageButton.attr("href");
  if (observedPath === undefined) {
    throw new Error("The Averages button did not expose a week-averages.php URL.");
  }
  const weekAveragesUrl = validateRelatedUrl(observedPath.replaceAll("&amp;", "&"), validatedResultsUrl);
  const averageParams = new URL(weekAveragesUrl).searchParams;
  if (averageParams.get("series_id") !== series.value || averageParams.get("week_id") !== week.value) {
    throw new Error("The Averages button URL does not match the selected MODUS series and week.");
  }

  return {
    context: ModusResultsContextSchema.parse({
      seriesId: series.value,
      seriesName: series.name,
      weekId: week.value,
      weekName: week.name,
      group,
    }),
    weekAveragesUrl,
  };
}

export function parseModusWeekAverages(html: string): ModusWeekAverage[] {
  const $ = cheerio.load(html);
  const rows = $(".week-averages-table .table-row").filter((_index, element) => !$(element).hasClass("table-header"));
  if (rows.length === 0) {
    throw new Error("No .week-averages-table .table-row records were found.");
  }

  const averages: ModusWeekAverage[] = [];
  rows.each((_index, element) => {
    const cells: string[] = [];
    $(element).children().each((_cellIndex, cell) => {
      cells.push(normalizeText($(cell).text()));
    });
    if (cells.length !== 6) {
      throw new Error(`A MODUS weekly averages row contained ${cells.length} cells; expected 6.`);
    }
    const player = cells[1] ?? "";
    const points = parseInteger(cells[3] ?? "", `points for ${JSON.stringify(player)}`);
    const darts = parseInteger(cells[4] ?? "", `darts for ${JSON.stringify(player)}`);
    const reportedAverage = parseNumber(cells[5] ?? "", `average for ${JSON.stringify(player)}`);
    if (darts <= 0) {
      throw new Error(`MODUS weekly averages row for ${JSON.stringify(player)} reported no darts.`);
    }
    const calculatedAverage = roundToTwo((points / darts) * 3);
    if (Math.abs(calculatedAverage - reportedAverage) > 0.02) {
      throw new Error(
        `MODUS weekly average for ${JSON.stringify(player)} is inconsistent: reported ${reportedAverage.toFixed(2)}, calculated ${calculatedAverage.toFixed(2)} from points/darts.`,
      );
    }
    averages.push({
      position: parsePositiveInteger(cells[0] ?? "", `position for ${JSON.stringify(player)}`),
      player: requireText(player, "player"),
      played: parseNonNegativeInteger(cells[2] ?? "", `played for ${JSON.stringify(player)}`),
      points,
      darts,
      average: reportedAverage,
    });
  });
  return averages;
}

function parseDailyMatch(summary: DailySummary, index: number, warnings: string[]): ModusMatch {
  const competitors = summary.sport_event.competitors;
  const home = findCompetitor(competitors, "home");
  const away = findCompetitor(competitors, "away");
  const statistics = summary.statistics?.totals?.competitors ?? [];
  const homeStatistic = findStatistic(statistics, home);
  const awayStatistic = findStatistic(statistics, away);
  const homeAverage = readAverage(homeStatistic, home, warnings);
  const awayAverage = readAverage(awayStatistic, away, warnings);
  const status = mapStatus(summary.sport_event_status.status, summary.sport_event_status.match_status);
  if (status === "unknown") {
    warnings.push(`Match ${index + 1} has an unknown official status.`);
  }
  return {
    id: summary.sport_event.id,
    matchNumber: index + 1,
    startTime: summary.sport_event.start_time,
    status,
    home: {
      name: canonicalizeCommaName(home.name),
      score: summary.sport_event_status.home_score ?? null,
      average: homeAverage,
    },
    away: {
      name: canonicalizeCommaName(away.name),
      score: summary.sport_event_status.away_score ?? null,
      average: awayAverage,
    },
  };
}

function assertResultsPageMatchesDailyFeed(html: string, matches: readonly ModusMatch[]): void {
  const $ = cheerio.load(html);
  const cards = $(".fixture-card");
  if (cards.length === 0) throw new Error("No official .fixture-card records were found for context verification");

  const observed = new Map<string, number>();
  cards.each((_index, card) => {
    const names: string[] = [];
    $(card).find(".player-row").each((_playerIndex, playerRow) => {
      const row = $(playerRow).clone();
      row.find(".score").remove();
      names.push(normalizeText(row.text()));
    });
    if (names.length !== 2 || names.some((name) => name === "")) {
      throw new Error("A result fixture card did not contain exactly two named player rows");
    }
    incrementCount(observed, matchupSignature(names[0] ?? "", names[1] ?? ""));
  });

  const expected = new Map<string, number>();
  for (const match of matches) incrementCount(expected, matchupSignature(match.home.name, match.away.name));
  if (!containsCounts(observed, expected)) {
    throw new Error(`Fixture-card matchups (${cards.length}) do not contain every daily-feed matchup (${matches.length})`);
  }
}

function matchupSignature(first: string, second: string): string {
  return [normalizeIdentity(first), normalizeIdentity(second)].sort().join("|");
}

function normalizeIdentity(value: string): string {
  return normalizeText(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-US");
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function containsCounts(available: ReadonlyMap<string, number>, required: ReadonlyMap<string, number>): boolean {
  for (const [key, count] of required) {
    if ((available.get(key) ?? 0) < count) return false;
  }
  return true;
}

function sameResultsContext(left: ParsedModusResultsContext, right: ParsedModusResultsContext): boolean {
  return left.weekAveragesUrl === right.weekAveragesUrl
    && left.context.seriesId === right.context.seriesId
    && left.context.weekId === right.context.weekId
    && left.context.group === right.context.group;
}

function findCompetitor(competitors: readonly DailyCompetitor[], qualifier: "home" | "away"): DailyCompetitor {
  const matches = competitors.filter((competitor) => competitor.qualifier === qualifier);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${qualifier} competitor, found ${matches.length}.`);
  }
  const competitor = matches[0];
  if (competitor === undefined) throw new Error(`Missing ${qualifier} competitor.`);
  return competitor;
}

function findStatistic(statistics: readonly DailyStatistic[], competitor: DailyCompetitor): DailyStatistic | undefined {
  if (statistics.length === 0) return undefined;
  const byId = statistics.filter((statistic) => statistic.id === competitor.id);
  if (byId.length > 1) throw new Error(`Statistics contain duplicate competitor id ${JSON.stringify(competitor.id)}.`);
  if (byId.length === 1) return byId[0];
  const byQualifier = statistics.filter((statistic) => statistic.qualifier === competitor.qualifier);
  if (byQualifier.length > 1) throw new Error(`Statistics contain duplicate ${competitor.qualifier} qualifiers.`);
  return byQualifier[0];
}

function readAverage(statistic: DailyStatistic | undefined, competitor: DailyCompetitor, warnings: string[]): number | null {
  const average = statistic?.statistics?.average_3_darts;
  if (average === undefined || average === null) {
    warnings.push(`No official match average was reported for ${canonicalizeCommaName(competitor.name)}.`);
    return null;
  }
  return average;
}

function mapStatus(status: string, matchStatus: string | undefined): "scheduled" | "live" | "completed" | "cancelled" | "unknown" {
  const value = `${status} ${matchStatus ?? ""}`.toLocaleLowerCase("en-US");
  if (/(cancel|postpon|abandon)/u.test(value)) return "cancelled";
  if (/(closed|ended|finished|complete)/u.test(value)) return "completed";
  if (/(scheduled|not[ -]?started|upcoming|pending)/u.test(value)) return "scheduled";
  if (/(live|in[ -]?progress|started|playing)/u.test(value)) return "live";
  return "unknown";
}

function canonicalizeCommaName(name: string): string {
  const normalized = normalizeText(name);
  const comma = /^([^,]+),\s*(.+)$/.exec(normalized);
  return comma === null ? normalized : `${comma[2] ?? ""} ${comma[1] ?? ""}`.trim();
}

function normalizeGroup(element: cheerio.Cheerio<Element>): string {
  const dataGroup = normalizeText(element.attr("data-group") ?? "");
  if (dataGroup !== "") return dataGroup;
  return normalizeText(element.text());
}

function selectedOption(root: CheerioAPI, selector: string, label: string): { value: string; name: string } {
  const options = root(selector).find("option").filter((_index, element) => root(element).attr("selected") !== undefined);
  if (options.length !== 1) throw new Error(`Expected exactly one selected ${label} option, found ${options.length}.`);
  const option = options.first();
  const value = normalizeText(option.attr("value") ?? "");
  const name = normalizeText(option.text());
  if (value === "" || name === "") throw new Error(`The selected ${label} option has no value or name.`);
  return { value, name };
}

function validateHttpUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error: unknown) {
    throw new Error(`Invalid ${label}: ${errorMessage(error)}.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ${label}: only HTTP(S) URLs are supported.`);
  }
  return parsed.toString();
}

function validateRelatedUrl(value: string, baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value, baseUrl);
  } catch (error: unknown) {
    throw new Error(`The Averages button URL is invalid: ${errorMessage(error)}.`);
  }
  const base = new URL(baseUrl);
  if (parsed.protocol !== base.protocol || parsed.host !== base.host) {
    throw new Error("The Averages button points outside the official MODUS results host.");
  }
  if (!parsed.pathname.endsWith("/week-averages.php")) {
    throw new Error(`The Averages button points to unexpected path ${JSON.stringify(parsed.pathname)}.`);
  }
  return parsed.toString();
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function requireText(value: string, label: string): string {
  if (value === "") throw new Error(`Missing ${label}.`);
  return value;
}

function parseInteger(value: string, label: string): number {
  if (!/^-?\d+$/u.test(value)) throw new Error(`Invalid integer ${JSON.stringify(value)} for ${label}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Integer ${JSON.stringify(value)} for ${label} is outside the safe range.`);
  return parsed;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = parseInteger(value, label);
  if (parsed <= 0) throw new Error(`Expected a positive integer for ${label}.`);
  return parsed;
}

function parseNonNegativeInteger(value: string, label: string): number {
  const parsed = parseInteger(value, label);
  if (parsed < 0) throw new Error(`Expected a non-negative integer for ${label}.`);
  return parsed;
}

function parseNumber(value: string, label: string): number {
  if (!/^-?\d+(?:\.\d+)?$/u.test(value)) throw new Error(`Invalid number ${JSON.stringify(value)} for ${label}.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Number ${JSON.stringify(value)} for ${label} is not finite.`);
  return parsed;
}

function roundToTwo(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function formatZodIssues(error: z.ZodError<unknown>): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}
