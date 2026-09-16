import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { IsoDateSchema } from "../agent/date.js";
import { noopLogger, type Logger } from "../logger.js";
import type { FixtureNameResolver } from "./fixture-name-resolver.js";
import { ModusFixtureSchema, type ModusFixture, type ModusFixtureSource } from "./schemas.js";

const DEFAULT_BASE_URL = "https://www.darts-nerd.com";
const PREVIEW_PATH = "/en/matches/preview";
const MODUS_MATCH_PATH_PATTERN = /^\/en\/federations\/modus\/super-series\/\d{4}\/matches(?:\/|$)/u;

export interface DartsNerdModusSourceOptions {
  resolver: Pick<FixtureNameResolver, "resolve">;
  baseUrl?: string;
  previewUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  timeZone?: string;
  logger?: Logger;
}

export class DartsNerdModusSource implements ModusFixtureSource {
  public readonly name = "Darts Nerd fixture provider";
  private readonly resolver: Pick<FixtureNameResolver, "resolve">;
  private readonly baseUrl: string;
  private readonly previewUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly logger: Logger;

  public constructor(options: DartsNerdModusSourceOptions) {
    this.resolver = options.resolver;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.previewUrl = options.previewUrl ?? `${this.baseUrl}${PREVIEW_PATH}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? "Europe/Budapest";
    this.logger = options.logger ?? noopLogger;
  }

  public sourceUrl(date: string): string {
    const validatedDate = IsoDateSchema.parse(date);
    return isFutureDate(validatedDate, this.now(), this.timeZone)
      ? this.previewUrl
      : this.seasonUrl(validatedDate);
  }

  public async getPlayers(date: string): Promise<readonly string[]> {
    const validatedDate = IsoDateSchema.parse(date);
    const url = this.sourceUrl(validatedDate);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: { Accept: "text/html", "User-Agent": "DartsResearchAgent/0.2" }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const names = parsePlayersForDate(await response.text(), validatedDate, { modusOnly: url === this.previewUrl });
      return Promise.all(names.map((name: string): Promise<string> => this.resolveName(name, validatedDate)));
    } finally { clearTimeout(timeout); }
  }

  public async getFixtures(date: string): Promise<readonly ModusFixture[]> {
    const validatedDate = IsoDateSchema.parse(date);
    const pageUrl = this.sourceUrl(validatedDate);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(pageUrl, {
        headers: { Accept: "text/html", "User-Agent": "DartsResearchAgent/0.2" }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const fixtures = parseFixturesForDate(await response.text(), validatedDate, {
        modusOnly: pageUrl === this.previewUrl,
        baseUrl: this.baseUrl,
        pageUrl,
      });
      return Promise.all(fixtures.map(async (fixture): Promise<ModusFixture> => ModusFixtureSchema.parse({
        ...fixture,
        playerOne: await this.resolveName(fixture.playerOne, validatedDate),
        playerTwo: await this.resolveName(fixture.playerTwo, validatedDate),
      })));
    } finally { clearTimeout(timeout); }
  }

  private async resolveName(name: string, date: string): Promise<string> {
    try {
      return await this.resolver.resolve(name);
    } catch (error: unknown) {
      this.logger.warn("MODUS fixture player could not be resolved; preserving provider label.", {
        source: this.name,
        date,
        player: name,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return name;
    }
  }

  private seasonUrl(date: string): string {
    return `${this.baseUrl}/en/federations/modus/super-series/${date.slice(0, 4)}/matches`;
  }
}

export interface ParsePlayersForDateOptions {
  readonly modusOnly?: boolean;
}

export interface ParseFixturesForDateOptions extends ParsePlayersForDateOptions {
  readonly baseUrl?: string;
  readonly pageUrl?: string;
}

export function parseFixturesForDate(
  html: string,
  date: string,
  options: ParseFixturesForDateOptions = {},
): readonly ModusFixture[] {
  const validatedDate = IsoDateSchema.parse(date);
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const pageUrl = options.pageUrl ?? `${baseUrl}${PREVIEW_PATH}`;
  const $ = cheerio.load(html);
  const fixtures: ModusFixture[] = [];
  $(".hm-match").each((index, matchElement) => {
    const match = $(matchElement);
    if (options.modusOnly === true && !isModusMatch(match)) return;
    const startTime = match.find(".hm-time[data-utc]").first().attr("data-utc");
    if (startTime?.slice(0, 10) !== validatedDate) return;
    const names = match.find(".hm-name").map((_nameIndex, nameElement) => normalizeFixtureName($(nameElement).text())).get();
    if (names.length !== 2 || names.some((name) => !isNamedPlayer(name))) return;
    const playerOne = names[0];
    const playerTwo = names[1];
    if (playerOne === undefined || playerTwo === undefined) return;
    const matchUrl = resolveMatchUrl(match, baseUrl) ?? pageUrl;
    fixtures.push(ModusFixtureSchema.parse({
      id: resolveMatchUrl(match, baseUrl) ?? `darts-nerd:${validatedDate}:${index + 1}:${playerOne}:${playerTwo}`,
      event: "MODUS Super Series",
      date: validatedDate,
      startTime,
      playerOne,
      playerTwo,
      source: matchUrl,
    }));
  });
  return fixtures;
}

export function parsePlayersForDate(
  html: string,
  date: string,
  options: ParsePlayersForDateOptions = {},
): readonly string[] {
  IsoDateSchema.parse(date);
  const $ = cheerio.load(html);
  const names: string[] = [];
  $(".hm-match").each((_index, matchElement) => {
    const match = $(matchElement);
    if (options.modusOnly === true && !isModusMatch(match)) return;
    const timeElement = match.find(".hm-time[data-utc]").first();
    if (timeElement.attr("data-utc")?.slice(0, 10) !== date) return;
    match.find(".hm-name").each((_nameIndex, nameElement) => {
      const name = normalizeFixtureName($(nameElement).text());
      if (!isNamedPlayer(name)) return;
      if (name !== "") names.push(name);
    });
  });
  return [...new Set(names)];
}

function isModusMatch(match: cheerio.Cheerio<Element>): boolean {
  const href = match.attr("href") ?? match.find("a[href]").first().attr("href") ?? "";
  if (href === "") return false;
  try {
    const url = new URL(href, DEFAULT_BASE_URL);
    return MODUS_MATCH_PATH_PATTERN.test(url.pathname);
  } catch {
    return false;
  }
}

function resolveMatchUrl(match: cheerio.Cheerio<Element>, baseUrl: string): string | undefined {
  const href = match.attr("href") ?? match.find("a[href]").first().attr("href");
  if (href === undefined || href.trim() === "") return undefined;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function normalizeFixtureName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function isNamedPlayer(name: string): boolean {
  return name !== ""
    && name !== "?"
    && !/^(?:tba|winner|runner[- ]?up|semi[- ]?final|to be confirmed)\b/iu.test(name);
}

function isFutureDate(date: string, now: Date, timeZone: string): boolean {
  return date > localIsoDate(now, timeZone);
}

function localIsoDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return IsoDateSchema.parse(`${read("year")}-${read("month")}-${read("day")}`);
}
