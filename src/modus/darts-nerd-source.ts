import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { IsoDateSchema } from "../agent/date.js";
import { noopLogger, type Logger } from "../logger.js";
import type { FixtureNameResolver } from "./fixture-name-resolver.js";
import { ModusFixtureSchema, type ModusFixture, type ModusFixtureSource } from "./schemas.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import type { ModusFixtureIdentityFallback, ModusFixtureIdentityPair } from "./fixture-identity-source.js";

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
  fixtureIdentityFallback?: ModusFixtureIdentityFallback;
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
  private readonly fixtureIdentityFallback: ModusFixtureIdentityFallback | undefined;

  public constructor(options: DartsNerdModusSourceOptions) {
    this.resolver = options.resolver;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.previewUrl = options.previewUrl ?? `${this.baseUrl}${PREVIEW_PATH}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? "Europe/Budapest";
    this.logger = options.logger ?? noopLogger;
    this.fixtureIdentityFallback = options.fixtureIdentityFallback;
  }

  public sourceUrl(date: string): string {
    const validatedDate = IsoDateSchema.parse(date);
    return isFutureDate(validatedDate, this.now(), this.timeZone)
      ? this.previewUrl
      : this.seasonUrl(validatedDate);
  }

  public async getPlayers(date: string, callerSignal?: AbortSignal): Promise<readonly string[]> {
    throwIfAborted(callerSignal);
    const validatedDate = IsoDateSchema.parse(date);
    const url = this.sourceUrl(validatedDate);
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(callerSignal?.reason ?? new Error("MODUS fixture request cancelled."));
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("MODUS fixture request timed out.")), this.timeoutMs);
    try {
      const response = await waitWithSignal(this.fetchImpl(url, {
        headers: { Accept: "text/html", "User-Agent": "DartsResearchAgent/0.2" }, signal: controller.signal,
      }), controller.signal);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await waitWithSignal(response.text(), controller.signal);
      const parseOptions = { modusOnly: url === this.previewUrl };
      const names = parsePlayersForDate(html, validatedDate, parseOptions);
      throwIfAborted(callerSignal);
      if (this.fixtureIdentityFallback !== undefined) {
        const fixtures = parseFixturesForDate(html, validatedDate, {
          ...parseOptions,
          baseUrl: this.baseUrl,
          pageUrl: url,
        });
        if (fixtures.length > 0) {
          const resolvedBySourceName = new Map<string, Set<string>>();
          await Promise.all(fixtures.map(async (fixture): Promise<void> => {
            const resolved = await this.resolveFixturePair(fixture.playerOne, fixture.playerTwo, validatedDate, callerSignal);
            rememberResolvedName(resolvedBySourceName, fixture.playerOne, resolved[0]);
            rememberResolvedName(resolvedBySourceName, fixture.playerTwo, resolved[1]);
          }));
          return Promise.all(names.map(async (name): Promise<string> => {
            const resolved = resolvedBySourceName.get(normalizeFixtureName(name));
            if (resolved?.size === 1) return [...resolved][0] ?? name;
            if (resolved !== undefined) return name;
            return this.resolveName(name, validatedDate, callerSignal);
          }));
        }
      }
      return Promise.all(names.map((name: string): Promise<string> => this.resolveName(name, validatedDate, callerSignal)));
    } catch (error: unknown) {
      throwIfAborted(callerSignal);
      throw error;
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  public async getFixtures(date: string, callerSignal?: AbortSignal): Promise<readonly ModusFixture[]> {
    throwIfAborted(callerSignal);
    const validatedDate = IsoDateSchema.parse(date);
    const pageUrl = this.sourceUrl(validatedDate);
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(callerSignal?.reason ?? new Error("MODUS fixture request cancelled."));
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("MODUS fixture request timed out.")), this.timeoutMs);
    try {
      const response = await waitWithSignal(this.fetchImpl(pageUrl, {
        headers: { Accept: "text/html", "User-Agent": "DartsResearchAgent/0.2" }, signal: controller.signal,
      }), controller.signal);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const fixtures = parseFixturesForDate(await waitWithSignal(response.text(), controller.signal), validatedDate, {
        modusOnly: pageUrl === this.previewUrl,
        baseUrl: this.baseUrl,
        pageUrl,
      });
      return Promise.all(fixtures.map(async (fixture): Promise<ModusFixture> => {
        const [playerOne, playerTwo] = await this.resolveFixturePair(
          fixture.playerOne,
          fixture.playerTwo,
          validatedDate,
          callerSignal,
        );
        return ModusFixtureSchema.parse({ ...fixture, playerOne, playerTwo });
      }));
    } catch (error: unknown) {
      throwIfAborted(callerSignal);
      throw error;
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private async resolveName(name: string, date: string, signal?: AbortSignal): Promise<string> {
    return (await this.resolveNameWithStatus(name, date, signal)).name;
  }

  private async resolveNameWithStatus(
    name: string,
    date: string,
    signal?: AbortSignal,
  ): Promise<{ readonly name: string; readonly resolved: boolean }> {
    try {
      return { name: await this.resolver.resolve(name, signal), resolved: true };
    } catch (error: unknown) {
      throwIfAborted(signal);
      this.logger.warn("MODUS fixture player could not be resolved; preserving provider label.", {
        source: this.name,
        date,
        player: name,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return { name, resolved: false };
    }
  }

  private async resolveFixturePair(
    sourcePlayerOne: string,
    sourcePlayerTwo: string,
    date: string,
    signal?: AbortSignal,
  ): Promise<ModusFixtureIdentityPair> {
    const [first, second] = await Promise.all([
      this.resolveNameWithStatus(sourcePlayerOne, date, signal),
      this.resolveNameWithStatus(sourcePlayerTwo, date, signal),
    ]);
    if ((first.resolved && second.resolved) || this.fixtureIdentityFallback === undefined) {
      return [first.name, second.name];
    }
    try {
      const recovered = await this.fixtureIdentityFallback.resolvePair(date, sourcePlayerOne, sourcePlayerTwo, signal);
      throwIfAborted(signal);
      return recovered ?? [first.name, second.name];
    } catch (error: unknown) {
      throwIfAborted(signal);
      this.logger.warn("MODUS fixture identity fallback failed; preserving verified and unresolved source labels.", {
        date,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return [first.name, second.name];
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

function rememberResolvedName(mapping: Map<string, Set<string>>, sourceName: string, resolvedName: string): void {
  const key = normalizeFixtureName(sourceName);
  const existing = mapping.get(key) ?? new Set<string>();
  existing.add(resolvedName);
  mapping.set(key, existing);
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
