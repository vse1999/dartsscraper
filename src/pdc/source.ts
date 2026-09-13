import * as cheerio from "cheerio";
import { z } from "zod";

import { IsoDateSchema } from "../agent/date.js";
import type { Logger } from "../logger.js";
import { noopLogger } from "../logger.js";
import {
  PDC_TOURNAMENT_NAMES,
  PdcCalendarCategorySchema,
  PdcTournamentEventSchema,
  PdcTournamentMatchSchema,
  PdcTournamentResultSchema,
  type PdcCalendarCategory,
  type PdcTournamentEvent,
  type PdcTournamentMatch,
  type PdcTournamentResult,
  type PdcTournamentSource,
} from "./schemas.js";

const DEFAULT_BASE_URL = "https://dartsorakel.com";
const DEFAULT_TIMEOUT_MS = 15_000;

const DartsOrakelCalendarResponseSchema = z.object({
  data: z.array(z.unknown()),
});

const DartsOrakelCalendarRowSchema = z.object({
  event_key: z.number().int().positive(),
  tournament_key: z.number().int().positive(),
  tournament_name: z.string().trim().min(1),
  tournament_no: z.union([z.number().int().nonnegative(), z.string().trim().min(1)]).nullable().optional(),
  category: z.string().trim().min(1),
  event_date: z.string().trim().min(1),
  start_date: z.string().trim().min(1),
  end_date: z.string().trim().min(1),
  event_avg: z.number().finite().nonnegative().nullable().optional(),
  winner_avg: z.number().finite().nonnegative().nullable().optional(),
  winner_name: z.string().trim().min(1).nullable().optional(),
  player_key: z.number().int().positive().nullable().optional(),
  events_result_url: z.string().url(),
});

export interface DartsOrakelPdcSourceOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

export class PdcSourceUnavailableError extends Error {
  public readonly url: string;

  public constructor(message: string, url: string, cause?: unknown) {
    super(`${message} Source: ${url}`, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.url = url;
  }
}

export class DartsOrakelPdcSource implements PdcTournamentSource {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  public constructor(options: DartsOrakelPdcSourceOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = positiveFinite(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.logger = options.logger ?? noopLogger;
  }

  public async getCalendar(year: number, category: PdcCalendarCategory): Promise<readonly PdcTournamentEvent[]> {
    validateYear(year);
    const validatedCategory = PdcCalendarCategorySchema.parse(category);
    const url = new URL("/api/events", this.baseUrl);
    url.searchParams.set("year", String(year));
    url.searchParams.set("organCal", validatedCategory);
    const payload = await this.fetchJson(url.toString());
    const response = DartsOrakelCalendarResponseSchema.safeParse(payload);
    if (!response.success) throw new PdcSourceUnavailableError("The DartsOrakel PDC calendar changed structure.", url.toString(), response.error);

    const events: PdcTournamentEvent[] = [];
    for (const [index, row] of response.data.data.entries()) {
      const parsed = parseCalendarRow(row, url.toString(), index);
      if (parsed !== null) events.push(parsed);
    }
    this.logger.debug("PDC calendar loaded.", { year, category: validatedCategory, events: events.length });
    return events;
  }

  public async getResults(event: PdcTournamentEvent): Promise<PdcTournamentResult> {
    const validatedEvent = PdcTournamentEventSchema.parse(event);
    const response = await this.fetchText(validatedEvent.resultsUrl, "text/html, text/plain");
    try {
      return PdcTournamentResultSchema.parse({
        event: validatedEvent,
        matches: parsePdcTournamentMatches(response, validatedEvent.resultsUrl),
        sourceUrl: validatedEvent.resultsUrl,
      });
    } catch (error: unknown) {
      throw new PdcSourceUnavailableError(
        `The PDC tournament results page changed structure for ${validatedEvent.tournamentName}.`,
        validatedEvent.resultsUrl,
        error,
      );
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const body = await this.fetchText(url, "application/json");
    try {
      return JSON.parse(body) as unknown;
    } catch (error: unknown) {
      throw new PdcSourceUnavailableError("DartsOrakel returned invalid PDC calendar JSON.", url, error);
    }
  }

  private async fetchText(url: string, accept: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: accept, "User-Agent": "DartsResearchAgent/0.5" },
        signal: controller.signal,
      });
      if (!response.ok) throw new PdcSourceUnavailableError(`DartsOrakel returned HTTP ${response.status}.`, url);
      const body = await response.text();
      if (body.trim() === "") throw new PdcSourceUnavailableError("DartsOrakel returned an empty PDC response.", url);
      return body;
    } catch (error: unknown) {
      if (error instanceof PdcSourceUnavailableError) throw error;
      throw new PdcSourceUnavailableError(
        controller.signal.aborted
          ? `DartsOrakel PDC request timed out after ${this.timeoutMs} ms.`
          : "DartsOrakel PDC request failed.",
        url,
        error,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parsePdcTournamentMatches(content: string, sourceUrl: string): readonly PdcTournamentMatch[] {
  const url = validateDartsOrakelUrl(sourceUrl);
  if (content.trim() === "") throw new Error("The PDC tournament results page was empty.");
  const htmlMatches = parseHtmlMatches(content, url);
  if (htmlMatches.length > 0) return deduplicateMatches(htmlMatches);
  return deduplicateMatches(parseReaderMarkdownMatches(content, url));
}

function parseCalendarRow(value: unknown, calendarUrl: string, index: number): PdcTournamentEvent | null {
  const parsed = DartsOrakelCalendarRowSchema.safeParse(value);
  if (!parsed.success) throw new PdcSourceUnavailableError(`PDC calendar row ${index + 1} failed validation.`, calendarUrl, parsed.error);
  if (!isPdcTournamentName(parsed.data.tournament_name)) return null;

  const eventDate = parseSourceDate(parsed.data.event_date, "event_date");
  const startDate = parseSourceDate(parsed.data.start_date, "start_date");
  const endDate = parseSourceDate(parsed.data.end_date, "end_date");
  const tournamentNumber = parseTournamentNumber(parsed.data.tournament_no);
  const resultsUrl = validateDartsOrakelUrl(parsed.data.events_result_url).toString();
  const result = PdcTournamentEventSchema.safeParse({
    eventKey: parsed.data.event_key,
    tournamentKey: parsed.data.tournament_key,
    tournamentName: parsed.data.tournament_name,
    tournamentNumber,
    category: parsed.data.category,
    eventDate,
    startDate,
    endDate,
    eventAverage: parsed.data.event_avg ?? null,
    winnerAverage: parsed.data.winner_avg ?? null,
    winnerName: parsed.data.winner_name ?? null,
    winnerPlayerId: parsed.data.player_key ?? null,
    calendarUrl,
    resultsUrl,
  });
  if (!result.success) throw new PdcSourceUnavailableError(`PDC calendar row ${index + 1} failed normalized validation.`, calendarUrl, result.error);
  return result.data;
}

function parseHtmlMatches(content: string, sourceUrl: URL): PdcTournamentMatch[] {
  if (!/<table\b/i.test(content)) return [];
  const $ = cheerio.load(content);
  const matches: PdcTournamentMatch[] = [];
  $("table").each((_tableIndex, table) => {
    const round = normalizeText($(table).closest(".card").find(".card-header,.card-title,h1,h2,h3,h4,h5").first().text()) || null;
    $(table).find("tbody tr").each((_rowIndex, row) => {
      const players = $(row).find('a[href*="/player/details/"]').toArray().map((element) => parsePlayerLink($(element).attr("href") ?? "", $(element).text(), sourceUrl));
      const score = normalizeText($(row).find("td").eq(1).text());
      const matchLink = $(row).find('a[href*="/match/stats/"]').attr("href") ?? "";
      if (players.length !== 2 || score === "" || matchLink === "") return;
      matches.push(buildMatch(players[0], players[1], score, round, matchLink, sourceUrl));
    });
  });
  return matches;
}

function parseReaderMarkdownMatches(content: string, sourceUrl: URL): PdcTournamentMatch[] {
  const matches: PdcTournamentMatch[] = [];
  const pattern = /\[([^\]]+)\]\((https:\/\/dartsorakel\.com\/player\/details\/\d+\/[^)]+)\)\s*(\d+)\s+V\s+(\d+)\s*\[([^\]]+)\]\((https:\/\/dartsorakel\.com\/player\/details\/\d+\/[^)]+)\)\s*\[\]\((https:\/\/dartsorakel\.com\/match\/stats\/\d+)\)/gu;
  for (const match of content.matchAll(pattern)) {
    const winner = parsePlayerLink(match[2] ?? "", match[1] ?? "", sourceUrl);
    const loser = parsePlayerLink(match[6] ?? "", match[5] ?? "", sourceUrl);
    matches.push(buildMatch(winner, loser, `${match[3] ?? ""} V ${match[4] ?? ""}`, null, match[7] ?? "", sourceUrl));
  }
  return matches;
}

interface PdcPlayerLink { readonly name: string; readonly id: number; }

function parsePlayerLink(href: string, text: string, sourceUrl: URL): PdcPlayerLink {
  const url = new URL(href, sourceUrl);
  const allowed = new URL("https://dartsorakel.com/player/details/1/player");
  if (url.protocol !== allowed.protocol || url.host !== allowed.host || !/^\/player\/details\/\d+\/[^/]+$/u.test(url.pathname)) {
    throw new Error("A PDC result row pointed outside the allowed DartsOrakel player endpoint.");
  }
  const id = Number(url.pathname.split("/")[3]);
  const name = normalizeText(text);
  if (!Number.isSafeInteger(id) || id <= 0 || name === "") throw new Error("A PDC result row contained an invalid player.");
  return { name, id };
}

function buildMatch(
  winner: PdcPlayerLink | undefined,
  loser: PdcPlayerLink | undefined,
  scoreText: string,
  round: string | null,
  matchHref: string,
  sourceUrl: URL,
): PdcTournamentMatch {
  if (winner === undefined || loser === undefined) throw new Error("A PDC result row did not contain two players.");
  const scores = /^(\d+)\s+V\s+(\d+)$/iu.exec(normalizeText(scoreText));
  if (scores === null) throw new Error(`Invalid PDC result score ${JSON.stringify(scoreText)}.`);
  const matchUrl = new URL(matchHref, sourceUrl);
  const allowed = new URL("https://dartsorakel.com/match/stats/1");
  if (matchUrl.protocol !== allowed.protocol || matchUrl.host !== allowed.host || !/^\/match\/stats\/\d+$/u.test(matchUrl.pathname)) {
    throw new Error("A PDC result row pointed outside the allowed DartsOrakel match endpoint.");
  }
  const matchId = Number(matchUrl.pathname.split("/").at(-1));
  if (!Number.isSafeInteger(matchId) || matchId <= 0) throw new Error("A PDC result row contained an invalid match id.");
  return PdcTournamentMatchSchema.parse({
    matchId,
    round,
    winnerName: winner.name,
    winnerPlayerId: winner.id,
    loserName: loser.name,
    loserPlayerId: loser.id,
    winnerScore: Number(scores[1]),
    loserScore: Number(scores[2]),
    sourceUrl: matchUrl.toString(),
  });
}

function deduplicateMatches(matches: readonly PdcTournamentMatch[]): PdcTournamentMatch[] {
  const byId = new Map<number, PdcTournamentMatch>();
  for (const match of matches) byId.set(match.matchId, match);
  return [...byId.values()];
}

function parseSourceDate(value: string, label: string): string {
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1];
  if (date === undefined) throw new Error(`PDC calendar ${label} was not an ISO date.`);
  return IsoDateSchema.parse(date);
}

function parseTournamentNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined || String(value).trim() === "") return 0;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("PDC tournament number must be a non-negative integer.");
  return number;
}

function isPdcTournamentName(value: string): value is typeof PDC_TOURNAMENT_NAMES[number] {
  return (PDC_TOURNAMENT_NAMES as readonly string[]).includes(value);
}

function validateDartsOrakelUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.host !== "dartsorakel.com") throw new Error("Only DartsOrakel HTTPS URLs are supported for PDC results.");
  return url;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("PDC baseUrl must use HTTPS unless it points to localhost.");
  return url.toString().replace(/\/$/u, "");
}

function validateYear(value: number): void {
  if (!Number.isSafeInteger(value) || value < 2000 || value > 2100) throw new Error("PDC calendar year must be between 2000 and 2100.");
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number.`);
  return value;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}
