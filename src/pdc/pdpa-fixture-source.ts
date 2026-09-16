import * as cheerio from "cheerio";

import { IsoDateSchema } from "../agent/date.js";
import { noopLogger, type Logger } from "../logger.js";
import { PdcFixtureSchema, type PdcFixture, type PdcFixtureSource } from "./schemas.js";

const DEFAULT_BASE_URL = "https://pdpa.co.uk";
const DEFAULT_TIMEOUT_MS = 15_000;
const EVENT_LOOKBACK_DAYS = 10;

const MONTHS: Readonly<Record<string, string>> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

export interface PdpaEventReference {
  readonly title: string;
  readonly startDate: string;
  readonly url: string;
}

export interface PdpaPdcFixtureSourceOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

export class PdpaFixtureSourceUnavailableError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
  }
}

export class PdpaPdcFixtureSource implements PdcFixtureSource {
  public readonly name = "official PDPA event schedule";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  public constructor(options: PdpaPdcFixtureSourceOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = positiveFinite(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.logger = options.logger ?? noopLogger;
  }

  public async getFixtures(date: string): Promise<readonly PdcFixture[]> {
    const validatedDate = IsoDateSchema.parse(date);
    const calendarUrl = new URL("/events/calendar/", this.baseUrl).toString();
    const references = parsePdpaEventReferences(
      await this.fetchText(calendarUrl),
      calendarUrl,
      validatedDate,
    );
    if (references.length === 0) return [];

    const fixtures: PdcFixture[] = [];
    let successfulPages = 0;
    for (const reference of references) {
      try {
        const eventFixtures = parsePdpaEventFixtures(
          await this.fetchText(reference.url),
          reference.url,
          validatedDate,
        );
        successfulPages += 1;
        fixtures.push(...eventFixtures);
      } catch (error: unknown) {
        this.logger.warn("PDPA event schedule could not be parsed.", {
          date: validatedDate,
          event: reference.title,
          sourceUrl: reference.url,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    if (successfulPages === 0) {
      throw new PdpaFixtureSourceUnavailableError(`Every candidate PDPA event page failed for ${validatedDate}.`);
    }
    return deduplicateFixtures(fixtures);
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "text/html", "User-Agent": "DartsResearchAgent/0.6" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      if (body.trim() === "") throw new Error("empty response");
      return body;
    } catch (error: unknown) {
      throw new PdpaFixtureSourceUnavailableError(
        controller.signal.aborted
          ? `PDPA request timed out after ${this.timeoutMs} ms: ${url}`
          : `PDPA request failed: ${url}`,
        error,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parsePdpaEventReferences(
  html: string,
  calendarUrl: string,
  targetDate: string,
): readonly PdpaEventReference[] {
  const validatedTarget = IsoDateSchema.parse(targetDate);
  const trustedCalendar = validatePdpaUrl(calendarUrl);
  const earliestStart = addDays(validatedTarget, -EVENT_LOOKBACK_DAYS);
  const $ = cheerio.load(html);
  const references: PdpaEventReference[] = [];
  $("a.event-tile-small[href]").each((_index, element) => {
    const card = $(element);
    const title = normalizeText(card.find(".title").first().text());
    const startDate = parseWrittenDate(card.find(".date").first().text());
    const href = card.attr("href");
    if (title === "" || startDate === null || href === undefined) return;
    if (startDate < earliestStart || startDate > validatedTarget) return;
    const url = validatePdpaUrl(new URL(href, trustedCalendar).toString()).toString();
    references.push({ title, startDate, url });
  });
  return deduplicateReferences(references);
}

export function parsePdpaEventFixtures(
  html: string,
  sourceUrl: string,
  targetDate: string,
): readonly PdcFixture[] {
  const validatedDate = IsoDateSchema.parse(targetDate);
  const trustedSource = validatePdpaUrl(sourceUrl).toString();
  const $ = cheerio.load(html);
  const tournamentName = normalizeText($("h1.page-title").first().text());
  if (tournamentName === "") throw new Error("The PDPA event page had no title.");
  const details = $(".info-group").filter((_index, element) => (
    normalizeText($(element).find(".heading").first().text()).toLocaleLowerCase("en-US") === "more information:"
  )).find(".content").first();
  if (details.length === 0) return [];

  const fixtures: PdcFixture[] = [];
  details.find("p").each((_paragraphIndex, paragraph) => {
    const lines = htmlLines($(paragraph).html() ?? "");
    let activeDate = false;
    let round: string | null = null;
    let session: string | null = null;
    for (const line of lines) {
      const lineDate = dateFromScheduleHeading(line, validatedDate.slice(0, 4));
      if (lineDate !== null) {
        activeDate = lineDate === validatedDate;
        session = activeDate ? scheduleLabel(line) : null;
        round = null;
        continue;
      }
      if (!activeDate) continue;
      if (isRoundLabel(line)) {
        round = line;
        continue;
      }
      if (isSessionLabel(line)) {
        session = line;
        continue;
      }
      const players = parseMatchup(line);
      if (players === null) continue;
      fixtures.push(PdcFixtureSchema.parse({
        id: `pdpa:${validatedDate}:${fixtures.length + 1}:${normalizeId(players.playerOne)}:${normalizeId(players.playerTwo)}`,
        tournamentName,
        date: validatedDate,
        startTime: null,
        session,
        round,
        playerOne: players.playerOne,
        playerTwo: players.playerTwo,
        sourceUrl: trustedSource,
      }));
    }
  });
  return deduplicateFixtures(fixtures);
}

function htmlLines(value: string): readonly string[] {
  return value.split(/<br\s*\/?\s*>/iu).map((fragment) => normalizeText(cheerio.load(fragment).text())).filter((line) => line !== "");
}

function dateFromScheduleHeading(value: string, fallbackYear: string): string | null {
  const normalized = normalizeText(value).toLocaleLowerCase("en-US");
  const monthFirst = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/u.exec(normalized);
  const dayFirst = /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/u.exec(normalized);
  const month = monthFirst?.[1] ?? dayFirst?.[2];
  const day = monthFirst?.[2] ?? dayFirst?.[1];
  const year = monthFirst?.[3] ?? dayFirst?.[3] ?? fallbackYear;
  if (month === undefined || day === undefined || year === undefined) return null;
  const monthNumber = MONTHS[month];
  if (monthNumber === undefined) return null;
  const candidate = `${year}-${monthNumber}-${day.padStart(2, "0")}`;
  const parsed = IsoDateSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function parseWrittenDate(value: string): string | null {
  return dateFromScheduleHeading(value, "0000");
}

function parseMatchup(value: string): { readonly playerOne: string; readonly playerTwo: string } | null {
  const parts = value.split(/\s+v(?:s\.?)?\s+/iu);
  if (parts.length !== 2) return null;
  const playerOne = normalizePlayer(parts[0] ?? "");
  const playerTwo = normalizePlayer(parts[1] ?? "");
  if (!isConcretePlayer(playerOne) || !isConcretePlayer(playerTwo)) return null;
  return { playerOne, playerTwo };
}

function normalizePlayer(value: string): string {
  return normalizeText(value).replace(/^\(\d+\)\s*/u, "");
}

function isConcretePlayer(value: string): boolean {
  return value !== ""
    && !value.includes("/")
    && !/^(?:winner|loser|tba|to be confirmed)\b/iu.test(value)
    && /\p{L}/u.test(value);
}

function isRoundLabel(value: string): boolean {
  return !value.includes(" v ") && /^(?:round\b|last\s+\d+|quarter-finals?|semi-finals?|finals?\b)/iu.test(value);
}

function isSessionLabel(value: string): boolean {
  return /\bsession\b/iu.test(value);
}

function scheduleLabel(value: string): string | null {
  const time = /\((\d{2})(\d{2})\s+([A-Z]{2,5})\)/u.exec(value);
  return time === null ? null : `${time[1]}:${time[2]} ${time[3]}`;
}

function deduplicateReferences(references: readonly PdpaEventReference[]): readonly PdpaEventReference[] {
  return [...new Map(references.map((reference) => [reference.url, reference])).values()];
}

function deduplicateFixtures(fixtures: readonly PdcFixture[]): readonly PdcFixture[] {
  const unique = new Map<string, PdcFixture>();
  for (const fixture of fixtures) {
    const key = `${fixture.date}|${normalizeId(fixture.playerOne)}|${normalizeId(fixture.playerTwo)}`;
    unique.set(key, fixture);
  }
  return [...unique.values()];
}

function parseDateMilliseconds(value: string): number {
  return new Date(`${IsoDateSchema.parse(value)}T00:00:00Z`).getTime();
}

function addDays(value: string, days: number): string {
  const date = new Date(parseDateMilliseconds(value));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validatePdpaUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "pdpa.co.uk") throw new Error("Only PDPA HTTPS URLs are supported.");
  return url;
}

function normalizeBaseUrl(value: string): string {
  const url = validatePdpaUrl(value);
  return url.toString().replace(/\/$/u, "");
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number.`);
  return value;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizeId(value: string): string {
  return normalizeText(value).toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "");
}
