import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import { z } from "zod";

const MAX_ODDSPORTAL_HTML_BYTES = 1_000_000;
const MAX_ODDSPORTAL_ROWS = 200;

const OddsPortalRenderedInputSchema = z.object({
  html: z.string().min(1).max(MAX_ODDSPORTAL_HTML_BYTES),
  sourceUrl: z.string().min(1).max(2_048),
  observedAt: z.string().datetime({ offset: true }),
}).strict();

export type OddsPortalRenderedInput = z.infer<typeof OddsPortalRenderedInputSchema>;

export type OddsPortalParserIssueCode =
  | "html_shell_no_market_table"
  | "unsupported_or_missing_headings"
  | "ambiguous_market_tables"
  | "no_markets"
  | "row_shape_mismatch"
  | "bookmaker_missing"
  | "bookmaker_identity_conflict"
  | "duplicate_bookmaker"
  | "disabled_or_suspended_odds"
  | "empty_decimal"
  | "invalid_decimal";

export interface OddsPortalParserIssue {
  readonly code: OddsPortalParserIssueCode;
  readonly message: string;
  readonly rowNumber?: number;
}

export interface OddsPortalSelectionQuote {
  readonly column: "1" | "2";
  readonly rawText: string;
  readonly decimalPrice: number;
}

/**
 * Raw aggregator evidence. Player order, event status, round, start time and
 * market tab are intentionally unverified and must be resolved elsewhere.
 */
export interface OddsPortalRawBookmakerPair {
  readonly bookmakerSlug: string;
  readonly bookmakerName: string;
  readonly sourceUrl: string;
  readonly observedAt: string;
  readonly sourceKind: "aggregator_display";
  readonly marketType: "two_outcome_unverified";
  readonly marketStatus: "unverified";
  readonly eventStatus: null;
  readonly round: null;
  readonly scheduledStart: null;
  readonly sourceUpdatedAt: null;
  readonly playerMappingStatus: "unknown";
  readonly selection1: OddsPortalSelectionQuote;
  readonly selection2: OddsPortalSelectionQuote;
}

export interface OddsPortalRenderedTableResult {
  readonly sourceUrl: string;
  readonly observedAt: string;
  readonly quotes: readonly OddsPortalRawBookmakerPair[];
  readonly issues: readonly OddsPortalParserIssue[];
  readonly clean: boolean;
}

export class OddsPortalParserError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OddsPortalParserError";
  }
}

/**
 * Parses only the rendered two-outcome odds table. This function never opens
 * odds, bookmaker, bonus or betslip links and never infers players from URL
 * order. A non-clean result is evidence for quarantine, not an eligible quote.
 */
export function parseOddsPortalRenderedTable(input: unknown): OddsPortalRenderedTableResult {
  const parsed = OddsPortalRenderedInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new OddsPortalParserError(`OddsPortal parser input failed validation: ${formatIssues(parsed.error)}.`);
  }

  const sourceUrl = validateOddsPortalSourceUrl(parsed.data.sourceUrl);
  const htmlBytes = new TextEncoder().encode(parsed.data.html).byteLength;
  if (htmlBytes > MAX_ODDSPORTAL_HTML_BYTES) {
    throw new OddsPortalParserError(`OddsPortal HTML exceeds the ${MAX_ODDSPORTAL_HTML_BYTES}-byte parser limit.`);
  }

  const $ = cheerio.load(parsed.data.html);
  const tables = findMarketTables($);
  if (tables.length === 0) {
    const code: OddsPortalParserIssueCode = $("table").length === 0
      ? "html_shell_no_market_table"
      : "unsupported_or_missing_headings";
    return result(sourceUrl, parsed.data.observedAt, [], [{ code, message: issueMessage(code) }]);
  }
  if (tables.length > 1) {
    const code: OddsPortalParserIssueCode = "ambiguous_market_tables";
    return result(sourceUrl, parsed.data.observedAt, [], [{ code, message: issueMessage(code) }]);
  }

  const table = tables[0];
  if (table === undefined) throw new OddsPortalParserError("OddsPortal market table selection became invalid.");
  const rows = table.find("tr").filter((_index: number, element: Element): boolean => $(element).find("th").length === 0);
  if (rows.length > MAX_ODDSPORTAL_ROWS) {
    throw new OddsPortalParserError(`OddsPortal market table exceeds the ${MAX_ODDSPORTAL_ROWS}-row parser limit.`);
  }
  if (rows.length === 0) {
    const code: OddsPortalParserIssueCode = "no_markets";
    return result(sourceUrl, parsed.data.observedAt, [], [{ code, message: issueMessage(code) }]);
  }

  const quotes: OddsPortalRawBookmakerPair[] = [];
  const issues: OddsPortalParserIssue[] = [];
  const seenBookmakers = new Set<string>();
  rows.each((index: number, element: Element): void => {
    const rowNumber = index + 1;
    const rowCells = $(element).children("td");
    const rowBookmaker = rowCells.length > 0 ? parseBookmaker($, rowCells.eq(0)) : { kind: "missing" as const };
    if (rowBookmaker.kind === "label" && seenBookmakers.has(rowBookmaker.slug)) {
      issues.push({
        code: "duplicate_bookmaker",
        message: `Bookmaker slug '${rowBookmaker.slug}' occurs more than once in the rendered table.`,
        rowNumber,
      });
      return;
    }
    if (rowBookmaker.kind === "label") seenBookmakers.add(rowBookmaker.slug);
    const parsedRow = parseRow($, element, sourceUrl, parsed.data.observedAt, rowNumber);
    if ("issue" in parsedRow) {
      issues.push(parsedRow.issue);
      return;
    }
    quotes.push(parsedRow.quote);
  });

  if (quotes.length === 0 && issues.length === 0) {
    issues.push({ code: "no_markets", message: issueMessage("no_markets") });
  }
  return result(sourceUrl, parsed.data.observedAt, quotes, issues);
}

interface ParsedRow {
  readonly quote: OddsPortalRawBookmakerPair;
}

interface RejectedRow {
  readonly issue: OddsPortalParserIssue;
}

function findMarketTables($: CheerioAPI): readonly cheerio.Cheerio<Element>[] {
  const tables: cheerio.Cheerio<Element>[] = [];
  $("table").each((_index: number, element: Element): void => {
    const table = $(element);
    const headerRows = table.find("tr").filter((_rowIndex: number, row: Element): boolean => $(row).find("th").length > 0);
    const matching = headerRows.filter((_rowIndex: number, row: Element): boolean => {
      const headings = $(row).find("th").map((_headingIndex: number, heading: Element): string => normalizeText($(heading).text()).toLocaleLowerCase("en-US")).get();
      return headings.length === 4 && headings[0] === "bookmakers" && headings[1] === "1" && headings[2] === "2" && headings[3] === "payout";
    });
    if (matching.length > 0) tables.push(table);
  });
  return tables;
}

function parseRow(
  $: CheerioAPI,
  element: Element,
  sourceUrl: string,
  observedAt: string,
  rowNumber: number,
): ParsedRow | RejectedRow {
  const row = $(element);
  const cells = row.children("td");
  if (cells.length !== 4) return rejected("row_shape_mismatch", `Rendered odds row ${rowNumber} has ${cells.length} cells; expected 4.`, rowNumber);
  const bookmaker = parseBookmaker($, cells.eq(0));
  if (bookmaker.kind === "missing") return rejected("bookmaker_missing", `Rendered odds row ${rowNumber} has no exact bookmaker slug/name link.`, rowNumber);
  if (bookmaker.kind === "conflict") return rejected("bookmaker_identity_conflict", `Rendered odds row ${rowNumber} contains conflicting bookmaker links or labels.`, rowNumber);
  if (hasDisabledMarker($, row)) return rejected("disabled_or_suspended_odds", `Rendered odds row ${rowNumber} is marked disabled, inactive, closed or suspended.`, rowNumber);
  const first = parseDecimal(cells.eq(1), bookmaker.slug, "1", rowNumber);
  if ("issue" in first) return first;
  const second = parseDecimal(cells.eq(2), bookmaker.slug, "2", rowNumber);
  if ("issue" in second) return second;
  return {
    quote: {
      bookmakerSlug: bookmaker.slug,
      bookmakerName: bookmaker.name,
      sourceUrl,
      observedAt,
      sourceKind: "aggregator_display",
      marketType: "two_outcome_unverified",
      marketStatus: "unverified",
      eventStatus: null,
      round: null,
      scheduledStart: null,
      sourceUpdatedAt: null,
      playerMappingStatus: "unknown",
      selection1: first,
      selection2: second,
    },
  };
}

interface BookmakerLabel {
  readonly kind: "label";
  readonly slug: string;
  readonly name: string;
}

interface BookmakerConflict {
  readonly kind: "conflict";
}

interface MissingBookmaker {
  readonly kind: "missing";
}

type BookmakerParseResult = BookmakerLabel | BookmakerConflict | MissingBookmaker;

function parseBookmaker($: CheerioAPI, cell: cheerio.Cheerio<Element>): BookmakerParseResult {
  const slugs = new Set<string>();
  const names = new Set<string>();
  cell.find("a[href]").each((_index: number, element: Element): void => {
    const href = $(element).attr("href") ?? "";
    const slug = extractBookmakerIdentitySlug(href);
    if (slug === undefined) return;
    slugs.add(slug);
    const name = normalizeText($(element).find("p").first().text()) || normalizeText($(element).text());
    if (name !== "") names.add(name);
  });
  if (slugs.size === 0 || names.size === 0) return { kind: "missing" };
  if (slugs.size !== 1 || names.size !== 1) return { kind: "conflict" };
  const slug = [...slugs][0];
  const name = [...names][0];
  if (slug === undefined || name === undefined) return { kind: "missing" };
  return { kind: "label", slug, name };
}

function parseDecimal(cell: cheerio.Cheerio<Element>, expectedBookmakerSlug: string, column: "1" | "2", rowNumber: number): OddsPortalSelectionQuote | RejectedRow {
  for (const link of cell.find("a[href]").toArray()) {
    const href = link.attribs?.href ?? "";
    const slug = extractBookmakerPathSlug(href);
    if (slug === undefined) return rejected("bookmaker_identity_conflict", `Rendered odds row ${rowNumber} column ${column} contains an unsupported or off-site odds link.`, rowNumber);
    if (slug !== expectedBookmakerSlug) return rejected("bookmaker_identity_conflict", `Rendered odds row ${rowNumber} column ${column} points to bookmaker '${slug}', not '${expectedBookmakerSlug}'.`, rowNumber);
  }
  const rawText = normalizeText(cell.text());
  if (rawText === "") return rejected("empty_decimal", `Rendered odds row ${rowNumber} has an empty column ${column} price.`, rowNumber);
  if (!/^\d+(?:\.\d+)?$/u.test(rawText)) return rejected("invalid_decimal", `Rendered odds row ${rowNumber} has a non-decimal column ${column} price.`, rowNumber);
  const decimalPrice = Number(rawText);
  if (!Number.isFinite(decimalPrice) || decimalPrice <= 1) return rejected("invalid_decimal", `Rendered odds row ${rowNumber} has an invalid column ${column} price.`, rowNumber);
  return { column, rawText, decimalPrice };
}

function extractBookmakerIdentitySlug(href: string): string | undefined {
  const proxy = /^\/proxy\/bookmakers\/([A-Za-z0-9_-]+)\/link\/?$/u.exec(href);
  if (proxy?.[1] !== undefined) return proxy[1];
  const review = /^\/bookmakers\/([A-Za-z0-9_-]+)\/?$/u.exec(href);
  return review?.[1];
}

function extractBookmakerPathSlug(href: string): string | undefined {
  const relative = /^\/(?:proxy\/)?bookmakers\/([A-Za-z0-9_-]+)(?:\/|$)/u.exec(href);
  return relative?.[1];
}

function hasDisabledMarker($: CheerioAPI, row: cheerio.Cheerio<Element>): boolean {
  const attributes = [row.attr("class") ?? "", row.attr("data-status") ?? "", row.attr("aria-disabled") ?? ""];
  const descendants = row.find("*");
  descendants.each((_index: number, element: Element): void => {
    attributes.push($(element).attr("class") ?? "", $(element).attr("data-status") ?? "", $(element).attr("aria-disabled") ?? "");
  });
  const explicitDisabled = [row, ...row.find("*").toArray().map((element): cheerio.Cheerio<Element> => $(element))]
    .some((element): boolean => {
      const ariaDisabled = (element.attr("aria-disabled") ?? "").toLocaleLowerCase("en-US");
      return ariaDisabled === "true" || ariaDisabled === "disabled" || element.attr("disabled") !== undefined;
    });
  if (explicitDisabled) return true;
  const markerText = `${attributes.join(" ")} ${row.text()}`.toLocaleLowerCase("en-US");
  return /\b(?:suspended|disabled|inactive|closed|withdrawn|not\s+available)\b/u.test(markerText);
}

function rejected(code: OddsPortalParserIssueCode, message: string, rowNumber: number): RejectedRow {
  return { issue: { code, message, rowNumber } };
}

function result(
  sourceUrl: string,
  observedAt: string,
  quotes: readonly OddsPortalRawBookmakerPair[],
  issues: readonly OddsPortalParserIssue[],
): OddsPortalRenderedTableResult {
  return { sourceUrl, observedAt, quotes, issues, clean: issues.length === 0 && quotes.length > 0 };
}

function validateOddsPortalSourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new OddsPortalParserError(`OddsPortal source URL is invalid: ${errorMessage(error)}.`, error);
  }
  const rawPath = value.split(/[?#]/u)[0]?.replace(/^https?:\/\/[^/]+/iu, "") ?? "";
  if (/(?:^|\/)(?:\.{1,2})(?:\/|$)|%2e/iu.test(rawPath)) {
    throw new OddsPortalParserError("OddsPortal source URL must not contain dot-segment or encoded traversal paths.");
  }
  if (url.protocol !== "https:" || (url.hostname !== "www.oddsportal.com" && url.hostname !== "oddsportal.com") || url.port !== "" || url.username !== "" || url.password !== "" || !url.pathname.startsWith("/darts/")) {
    throw new OddsPortalParserError("OddsPortal source URL must be HTTPS, same-host, portless and under /darts/.");
  }
  return url.toString();
}

function issueMessage(code: OddsPortalParserIssueCode): string {
  switch (code) {
    case "html_shell_no_market_table": return "Rendered HTML contained no odds table; the page may be a JavaScript shell or unavailable response.";
    case "unsupported_or_missing_headings": return "No unambiguous table with exact Bookmakers/1/2/Payout headings was found.";
    case "ambiguous_market_tables": return "More than one table matched the exact two-outcome headings; market identity is ambiguous.";
    case "no_markets": return "The exact odds table contained no market rows.";
    default: return "OddsPortal rendered table did not produce a clean market result.";
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function formatIssues(error: z.ZodError<unknown>): string {
  return error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
