import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import { z } from "zod";
import type { OddsMatch } from "./contracts.js";

const SOURCE_ORIGIN = "https://www.eredmenyek.com";
const TIME_ZONE = "Europe/Budapest";
const EXPECTED_BOOKMAKER_ID = "498";
const MAX_HTML_BYTES = 2_500_000;
const MAX_ROWS = 500;

const InputSchema = z.object({
  html: z.string().min(1),
  sourceUrl: z.string().min(1).max(2_048),
  observedAt: z.string().datetime({ offset: true }),
  requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  dateLabel: z.string().min(1).max(200),
  bookmakerMappingValidated: z.literal(true),
}).strict();

export interface EredmenyekRenderedOddsInput {
  readonly html: string;
  readonly sourceUrl: string;
  readonly observedAt: string;
  readonly requestedDate: string;
  readonly dateLabel: string;
  readonly bookmakerMappingValidated: true;
}

export interface EredmenyekRenderedOddsResult {
  readonly date: string;
  readonly dateLabel: string;
  readonly matches: readonly OddsMatch[];
  readonly warnings: readonly string[];
}

export class EredmenyekOddsParserError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EredmenyekOddsParserError";
  }
}

/**
 * Parses the rendered darts table only. It never follows links or infers
 * participant order from the event URL; displayed home/away nodes are used.
 */
export function parseEredmenyekRenderedOdds(input: unknown): EredmenyekRenderedOddsResult {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) {
    throw new EredmenyekOddsParserError(`Eredmenyek parser input failed validation: ${formatIssues(parsed.error)}.`);
  }
  const sourceUrl = validatePageUrl(parsed.data.sourceUrl);
  const htmlBytes = new TextEncoder().encode(parsed.data.html).byteLength;
  if (htmlBytes > MAX_HTML_BYTES) {
    throw new EredmenyekOddsParserError(`Rendered Eredmenyek HTML exceeds the ${MAX_HTML_BYTES}-byte limit.`);
  }
  const requestedDate = validateIsoDate(parsed.data.requestedDate);
  const expectedLabel = formatEredmenyekDateLabel(requestedDate);
  if (normalizeLabel(parsed.data.dateLabel) !== normalizeLabel(expectedLabel)) {
    throw new EredmenyekOddsParserError(`Eredmenyek date marker does not match requested Budapest date ${requestedDate}.`);
  }

  const $ = cheerio.load(parsed.data.html);
  const liveTables = $("#live-table");
  if (liveTables.length !== 1) {
    throw new EredmenyekOddsParserError("Eredmenyek rendered table is missing the expected #live-table container.");
  }
  const liveTable = liveTables;
  const dateButtons = liveTable.find('[data-testid="wcl-dayPickerButton"]');
  const marker = dateButtons.length === 1 ? dateButtons.attr("aria-label") : undefined;
  if (dateButtons.length !== 1 || marker === undefined || normalizeLabel(marker) !== normalizeLabel(parsed.data.dateLabel)) {
    throw new EredmenyekOddsParserError("Eredmenyek rendered table date marker is missing or inconsistent.");
  }
  if (liveTable.find('.filters__tab.selected[data-analytics-alias="odds"]').length !== 1) {
    throw new EredmenyekOddsParserError("Eredmenyek rendered table is not on the Oddsok view.");
  }

  const sports = liveTable.find(".sportName.darts");
  if (sports.length === 0) {
    if (!hasRecognizedEmptyMarker(liveTable)) {
      throw new EredmenyekOddsParserError("Eredmenyek returned no darts section and no recognized empty-day marker.");
    }
    return { date: requestedDate, dateLabel: parsed.data.dateLabel, matches: [], warnings: ["Eredmenyek returned a recognized empty darts day."] };
  }
  const rowCount = sports.find(".event__match").length;
  if (rowCount > MAX_ROWS) {
    throw new EredmenyekOddsParserError(`Eredmenyek rendered darts table exceeds the ${MAX_ROWS}-row limit.`);
  }

  const matchesById = new Map<string, OddsMatch>();
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const warnings: string[] = [];
  let directRowCount = 0;
  sports.each((_sportIndex: number, sportElement: Element): void => {
    directRowCount += parseSport($, sportElement, sourceUrl, matchesById, seenIds, duplicateIds, warnings);
  });
  if (directRowCount !== rowCount) {
    throw new EredmenyekOddsParserError(`Eredmenyek darts row layout changed: found ${rowCount} rows but parsed ${directRowCount} direct rows.`);
  }
  if (sports.length > 0 && rowCount === 0 && !hasRecognizedEmptyMarker(liveTable)) {
    throw new EredmenyekOddsParserError("Eredmenyek darts section has no event rows; the rendered wrapper layout may have changed.");
  }
  const matches = [...matchesById.values()];
  if (rowCount > 0 && matches.length === 0 && warnings.length === 0) {
    warnings.push("Eredmenyek rendered darts rows contained no eligible scheduled matches.");
  }
  return { date: requestedDate, dateLabel: parsed.data.dateLabel, matches, warnings };
}

function parseSport(
  $: CheerioAPI,
  sportElement: Element,
  pageUrl: string,
  matchesById: Map<string, OddsMatch>,
  seenIds: Set<string>,
  duplicateIds: Set<string>,
  warnings: string[],
): number {
  let competition: string | undefined;
  let leagueValid = false;
  const sport = $(sportElement);
  let directRowCount = 0;
  sport.children().each((_index: number, child: Element): void => {
    const node = $(child);
    if (node.hasClass("headerLeague__wrapper")) {
      const titleNodes = node.find(".headerLeague__title");
      const oddsHeaderNodes = node.find(".headerLeague__odds-cell");
      const title = titleNodes.length === 1 ? normalizeText(titleNodes.text()) : "";
      const oddsHeaders = oddsHeaderNodes.map((_headerIndex: number, item: Element): string => normalizeText($(item).text())).get();
      competition = title === "" ? undefined : title;
      leagueValid = titleNodes.length === 1 && title !== "" && oddsHeaderNodes.length === 2 && oddsHeaders[0] === "1" && oddsHeaders[1] === "2";
      if (!leagueValid) warnings.push(`Rejected an ambiguous or malformed darts competition header${title === "" ? "" : ` '${title}'`}.`);
      return;
    }
    if (!node.hasClass("event__match")) return;
    directRowCount += 1;
    const candidateId = eventIdForRow(node);
    if (candidateId !== undefined) {
      if (seenIds.has(candidateId)) {
        matchesById.delete(candidateId);
        if (!duplicateIds.has(candidateId)) warnings.push(`Rejected duplicate Eredmenyek event ${candidateId}; all occurrences were quarantined.`);
        duplicateIds.add(candidateId);
        return;
      }
      seenIds.add(candidateId);
    }
    const parsed = parseRow($, child, competition, leagueValid, pageUrl);
    if (parsed.eventId !== undefined && duplicateIds.has(parsed.eventId)) return;
    if (parsed.kind === "warning") {
      warnings.push(parsed.message);
      return;
    }
    matchesById.set(parsed.match.eventId, parsed.match);
  });
  return directRowCount;
}

interface ParsedRowMatch { readonly kind: "match"; readonly match: OddsMatch; readonly eventId: string; }
interface ParsedRowWarning { readonly kind: "warning"; readonly message: string; readonly eventId?: string; }
type ParsedRow = ParsedRowMatch | ParsedRowWarning;

function parseRow(
  $: CheerioAPI,
  element: Element,
  competition: string | undefined,
  leagueValid: boolean,
  pageUrl: string,
): ParsedRow {
  const row = $(element);
  const rowId = row.attr("id") ?? "";
  const idMatch = /^g_14_([A-Za-z0-9_-]+)$/u.exec(rowId);
  const eventId = idMatch?.[1];
  if (!leagueValid || competition === undefined) return warning(`Rejected row ${rowId || "without an event id"}: competition header is not valid.`);
  if (eventId === undefined) return warning("Rejected a darts row with a malformed event id.");

  const isScheduled = row.hasClass("event__match--scheduled");
  const isLive = row.hasClass("event__match--live");
  const isFinished = row.hasClass("event__match--finished") || row.find(".event__stage--block").text().trim().toLocaleLowerCase("hu-HU") === "vége";
  if (!isScheduled || isLive || isFinished) {
    const state = isLive ? "live" : isFinished ? "finished" : "unknown";
    return warning(`Excluded ${state} Eredmenyek row ${eventId}; only scheduled rows are eligible.`);
  }
  if (hasSuspendedMarker($, row)) return warning(`Rejected suspended Eredmenyek row ${eventId}.`);

  const homeNodes = row.find(".event__participant--home");
  const awayNodes = row.find(".event__participant--away");
  const timeNodes = row.find(".event__time");
  if (homeNodes.length !== 1 || awayNodes.length !== 1 || timeNodes.length !== 1) {
    return warning(`Rejected ambiguous participant/time nodes for Eredmenyek event ${eventId}.`, eventId);
  }
  const player1 = normalizeText(homeNodes.text());
  const player2 = normalizeText(awayNodes.text());
  const scheduledTime = normalizeText(timeNodes.text());
  if (player1 === "" || player2 === "" || player1 === player2) return warning(`Rejected ambiguous participant names for Eredmenyek event ${eventId}.`, eventId);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(scheduledTime)) return warning(`Rejected malformed scheduled time for Eredmenyek event ${eventId}.`, eventId);

  const sourceUrl = parseEventUrl($, row, eventId);
  if (sourceUrl === undefined) return warning(`Rejected malformed source link for Eredmenyek event ${eventId}.`, eventId);
  const odd1 = parseOdd($, row, ".event__odd--odd1");
  const odd2 = parseOdd($, row, ".event__odd--odd2");
  if (odd1 === undefined || odd2 === undefined) return warning(`Rejected malformed or mismatched-bookmaker odds for Eredmenyek event ${eventId}.`, eventId);
  return { kind: "match", eventId, match: { eventId, competition, player1, player2, odds1: odd1, odds2: odd2, bookmaker: "TippmixPro", scheduledTime, sourceUrl } };
}

function parseOdd($: CheerioAPI, row: cheerio.Cheerio<Element>, selector: string): number | undefined {
  const cells = row.find(selector);
  if (cells.length !== 1) return undefined;
  const cell = cells;
  if (cell.attr("data-bookmaker-id") !== EXPECTED_BOOKMAKER_ID) return undefined;
  const spans = cell.find("span").toArray();
  if (spans.length !== 1) return undefined;
  const raw = normalizeText($(spans[0]).text());
  if (!/^\d+(?:\.\d+)?$/u.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 1 || value > 100) return undefined;
  return value;
}

function eventIdForRow(row: cheerio.Cheerio<Element>): string | undefined {
  const rowId = row.attr("id") ?? "";
  return /^g_14_([A-Za-z0-9_-]+)$/u.exec(rowId)?.[1];
}

function parseEventUrl($: CheerioAPI, row: cheerio.Cheerio<Element>, eventId: string): string | undefined {
  const links = row.find(".eventRowLink");
  if (links.length !== 1) return undefined;
  const href = links.attr("href");
  if (href === undefined) return undefined;
  try {
    const url = new URL(href, SOURCE_ORIGIN);
    if (url.origin !== SOURCE_ORIGIN || url.username !== "" || url.password !== "" || !/^\/merkozes\/darts\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/$/u.test(url.pathname)) return undefined;
    if (url.hash !== "" || url.searchParams.getAll("mid").length !== 1 || url.searchParams.get("mid") !== eventId || [...url.searchParams.keys()].some((key) => key !== "mid")) return undefined;
    return url.toString();
  } catch (error: unknown) {
    void error;
    return undefined;
  }
}

function hasSuspendedMarker($: CheerioAPI, row: cheerio.Cheerio<Element>): boolean {
  const classText = row.attr("class") ?? "";
  return row.attr("aria-disabled") === "true" || /suspend|closed|inactive/iu.test(classText) || row.find("[aria-disabled=\"true\"]").length > 0;
}

function validatePageUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch (error: unknown) { throw new EredmenyekOddsParserError("Eredmenyek source URL is not a valid URL.", error); }
  if (url.protocol !== "https:" || url.origin !== SOURCE_ORIGIN || url.username !== "" || url.password !== "" || !/^\/darts\/oddsok\/(?:holnap\/)?$/u.test(url.pathname) || url.search !== "" || url.hash !== "") {
    throw new EredmenyekOddsParserError("Eredmenyek source URL is outside the fixed darts odds allowlist.");
  }
  return url.toString();
}

function validateIsoDate(raw: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw);
  if (match === null) throw new EredmenyekOddsParserError("Eredmenyek requested date must be YYYY-MM-DD.");
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) throw new EredmenyekOddsParserError(`Eredmenyek requested date '${raw}' is not a calendar date.`);
  return raw;
}

export function formatEredmenyekDateLabel(date: string): string {
  const validated = validateIsoDate(date);
  const noonUtc = new Date(`${validated}T12:00:00.000Z`);
  return new Intl.DateTimeFormat("hu-HU", { timeZone: TIME_ZONE, dateStyle: "full" }).format(noonUtc);
}

function warning(message: string, eventId?: string): ParsedRowWarning { return eventId === undefined ? { kind: "warning", message } : { kind: "warning", eventId, message }; }
function normalizeText(value: string): string { return value.replace(/\s+/gu, " ").trim(); }
function normalizeLabel(value: string): string { return normalizeText(value).replace(/\u00a0/gu, " "); }
function formatIssues(error: z.ZodError<unknown>): string { return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "); }

function hasRecognizedEmptyMarker(liveTable: cheerio.Cheerio<Element>): boolean {
  const explicit = liveTable.find("[data-testid*='empty' i], .empty, .emptyState, .noEvents").length > 0;
  if (explicit) return true;
  const text = normalizeText(liveTable.text());
  return /(?:nincs(?:enek)?\s+(?:mérkőzések|események)|no\s+(?:matches|events))/iu.test(text);
}
