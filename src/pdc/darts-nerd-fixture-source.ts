import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

import { IsoDateSchema } from "../agent/date.js";
import { noopLogger, type Logger } from "../logger.js";
import { normalizePlayerName } from "../player/resolver.js";
import { PdcFixtureSchema, type PdcFixture, type PdcFixtureSource } from "./schemas.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";

const DEFAULT_PREVIEW_URL = "https://www.darts-nerd.com/en/matches/preview";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface PdcFixtureNameResolver {
  resolve(name: string, signal?: AbortSignal): Promise<string>;
}

export interface DartsNerdPdcFixtureSourceOptions {
  readonly resolver: PdcFixtureNameResolver;
  readonly previewUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

export class DartsNerdPdcFixtureSource implements PdcFixtureSource {
  public readonly name = "Darts Nerd live fixture feed";
  private readonly resolver: PdcFixtureNameResolver;
  private readonly previewUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  public constructor(options: DartsNerdPdcFixtureSourceOptions) {
    this.resolver = options.resolver;
    this.previewUrl = validatePreviewUrl(options.previewUrl ?? DEFAULT_PREVIEW_URL).toString();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = positiveFinite(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.logger = options.logger ?? noopLogger;
  }

  public async getFixtures(date: string, callerSignal?: AbortSignal): Promise<readonly PdcFixture[]> {
    throwIfAborted(callerSignal);
    const validatedDate = IsoDateSchema.parse(date);
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(callerSignal?.reason ?? new Error("PDC live fixture request cancelled."));
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("PDC live fixture request timed out.")), this.timeoutMs);
    try {
      const response = await waitWithSignal(this.fetchImpl(this.previewUrl, {
        method: "GET",
        headers: { Accept: "text/html", "User-Agent": "DartsResearchAgent/0.7" },
        signal: controller.signal,
      }), controller.signal);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await waitWithSignal(response.text(), controller.signal);
      throwIfAborted(callerSignal);
      if (body.trim() === "") throw new Error("empty response");
      const fixtures = parseDartsNerdPdcFixtures(body, validatedDate, this.previewUrl);
      return Promise.all(fixtures.map(async (fixture): Promise<PdcFixture> => PdcFixtureSchema.parse({
        ...fixture,
        playerOne: await this.resolveName(fixture.playerOne, validatedDate, callerSignal),
        playerTwo: await this.resolveName(fixture.playerTwo, validatedDate, callerSignal),
      })));
    } catch (error: unknown) {
      if (callerSignal?.aborted === true) throw error;
      const reason = controller.signal.aborted ? `timed out after ${this.timeoutMs} ms` : errorMessage(error);
      throw new Error(`Darts Nerd fixture request failed: ${reason}.`, { cause: error });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private async resolveName(name: string, date: string, signal?: AbortSignal): Promise<string> {
    try {
      return await this.resolver.resolve(name, signal);
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error;
      this.logger.warn("Live PDC fixture player could not be resolved; preserving provider label.", {
        date,
        player: name,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return name;
    }
  }
}

export function parseDartsNerdPdcFixtures(
  html: string,
  date: string,
  sourceUrl: string = DEFAULT_PREVIEW_URL,
): readonly PdcFixture[] {
  const validatedDate = IsoDateSchema.parse(date);
  const trustedSource = validatePreviewUrl(sourceUrl).toString();
  const $ = cheerio.load(html);
  const fixtures: PdcFixture[] = [];
  $(".hm-match").each((index, element) => {
    const match = $(element);
    const competition = match.closest("[data-competition-group]");
    if (
      competition.length > 0
      && normalizeText(competition.attr("data-federation") ?? "").toLocaleLowerCase("en-US") !== "pdc"
    ) return;
    const startTime = match.find(".hm-time[data-utc]").first().attr("data-utc");
    if (startTime?.slice(0, 10) !== validatedDate) return;
    const names = match.find(".hm-name").map((_nameIndex, nameElement) => normalizeText($(nameElement).text())).get();
    const playerOne = names[0];
    const playerTwo = names[1];
    if (playerOne === undefined || playerTwo === undefined || !isNamedPlayer(playerOne) || !isNamedPlayer(playerTwo)) return;
    const eventContext = livePdcEventContext(match, competition, trustedSource);
    if (competition.length > 0 && eventContext === null) return;
    const tournamentName = eventContext ?? "PDC live fixture";
    const roundText = normalizeText(match.find(".hm-round-badge").first().text()).replace(/\\\//gu, "/");
    fixtures.push(PdcFixtureSchema.parse({
      id: `darts-nerd:${validatedDate}:${index + 1}:${normalizeId(playerOne)}:${normalizeId(playerTwo)}`,
      tournamentName,
      date: validatedDate,
      startTime,
      session: null,
      round: roundText === "" ? null : roundText,
      playerOne,
      playerTwo,
      sourceUrl: trustedSource,
    }));
  });
  return fixtures;
}

export interface CorroboratedPdcFixtureSourceOptions {
  readonly officialSource: PdcFixtureSource;
  readonly liveSource: PdcFixtureSource;
  readonly logger?: Logger;
}

/**
 * PDPA establishes that a fixture belongs to an official PDC event. The live
 * feed then supplies late withdrawals, replacements, and match-level times.
 * Exact two-player rows need a unique participant pairing. A one-player
 * replacement needs unique pairing evidence plus a matching PDC event label.
 */
export class CorroboratedPdcFixtureSource implements PdcFixtureSource {
  public readonly name = "official PDPA schedule corroborated by live fixtures";
  private readonly officialSource: PdcFixtureSource;
  private readonly liveSource: PdcFixtureSource;
  private readonly logger: Logger;

  public constructor(options: CorroboratedPdcFixtureSourceOptions) {
    this.officialSource = options.officialSource;
    this.liveSource = options.liveSource;
    this.logger = options.logger ?? noopLogger;
  }

  public async getFixtures(date: string, signal?: AbortSignal): Promise<readonly PdcFixture[]> {
    throwIfAborted(signal);
    const official = await this.officialSource.getFixtures(date, signal);
    throwIfAborted(signal);
    if (official.length === 0) return [];
    try {
      const live = await this.liveSource.getFixtures(date, signal);
      return reconcileFixtures(official, live);
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error;
      this.logger.warn("Live PDC fixture corroboration failed; using the official schedule.", {
        date,
        source: this.liveSource.name,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return official;
    }
  }
}

export function reconcileFixtures(
  officialFixtures: readonly PdcFixture[],
  liveFixtures: readonly PdcFixture[],
): readonly PdcFixture[] {
  const matches = matchLiveFixtures(officialFixtures, liveFixtures);
  return officialFixtures.map((official, officialIndex): PdcFixture => {
    const live = matches.get(officialIndex);
    if (live === undefined) return official;
    const officialPlayers = [official.playerOne, official.playerTwo];
    return PdcFixtureSchema.parse({
      ...official,
      startTime: live.startTime,
      round: live.round ?? official.round,
      playerOne: contextualPlayerName(live.playerOne, officialPlayers),
      playerTwo: contextualPlayerName(live.playerTwo, officialPlayers),
      evidenceUrls: [...new Set([official.sourceUrl, live.sourceUrl])],
    });
  });
}

function matchLiveFixtures(
  officialFixtures: readonly PdcFixture[],
  liveFixtures: readonly PdcFixture[],
): ReadonlyMap<number, PdcFixture> {
  const exactEdges: Array<{ readonly officialIndex: number; readonly liveIndex: number }> = [];
  const replacementEdges: Array<{ readonly officialIndex: number; readonly liveIndex: number }> = [];
  for (const [officialIndex, official] of officialFixtures.entries()) {
    for (const [liveIndex, live] of liveFixtures.entries()) {
      const overlap = liveOverlap(official, live);
      if (overlap === 2 && (official.round === null || live.round === null || hasMatchingRoundContext(official, live))) {
        exactEdges.push({ officialIndex, liveIndex });
      }
      else if (overlap === 1 && hasMatchingEventContext(official, live) && hasMatchingRoundContext(official, live)) {
        replacementEdges.push({ officialIndex, liveIndex });
      }
    }
  }

  const matches = new Map<number, PdcFixture>();
  const reservedOfficial = new Set<number>();
  const reservedLive = new Set<number>();
  const exactOfficialCounts = countEdges(exactEdges, "officialIndex");
  const exactLiveCounts = countEdges(exactEdges, "liveIndex");
  for (const edge of exactEdges) {
    reservedOfficial.add(edge.officialIndex);
    reservedLive.add(edge.liveIndex);
    if (exactOfficialCounts.get(edge.officialIndex) !== 1 || exactLiveCounts.get(edge.liveIndex) !== 1) continue;
    const fixture = liveFixtures[edge.liveIndex];
    if (fixture !== undefined) matches.set(edge.officialIndex, fixture);
  }

  const eligibleReplacementEdges = replacementEdges.filter((edge) => (
    !reservedOfficial.has(edge.officialIndex) && !reservedLive.has(edge.liveIndex)
  ));
  const replacementOfficialCounts = countEdges(eligibleReplacementEdges, "officialIndex");
  const replacementLiveCounts = countEdges(eligibleReplacementEdges, "liveIndex");
  for (const edge of eligibleReplacementEdges) {
    if (replacementOfficialCounts.get(edge.officialIndex) !== 1 || replacementLiveCounts.get(edge.liveIndex) !== 1) continue;
    const fixture = liveFixtures[edge.liveIndex];
    if (fixture !== undefined) matches.set(edge.officialIndex, fixture);
  }
  return matches;
}

function liveOverlap(official: PdcFixture, live: PdcFixture): number {
  if (official.date !== live.date || hasExplicitEventContext(live) && !hasMatchingEventContext(official, live)) return 0;
  const officialNames = [official.playerOne, official.playerTwo];
  const matchedOfficialIndices = new Set<number>();
  for (const liveName of [live.playerOne, live.playerTwo]) {
    const matches = officialNames
      .map((officialName, index) => samePlayerLabel(liveName, officialName) ? index : -1)
      .filter((index) => index >= 0);
    // Abbreviations such as "Smith R." can describe more than one player in
    // a draw. Such evidence cannot safely identify a participant or fixture.
    if (matches.length > 1) return 0;
    const officialIndex = matches[0];
    if (officialIndex !== undefined) matchedOfficialIndices.add(officialIndex);
  }
  return matchedOfficialIndices.size;
}

function hasMatchingEventContext(official: PdcFixture, live: PdcFixture): boolean {
  return hasExplicitEventContext(live)
    && normalizeEventName(official.tournamentName) !== ""
    && normalizeEventName(official.tournamentName) === normalizeEventName(live.tournamentName);
}

function hasMatchingRoundContext(official: PdcFixture, live: PdcFixture): boolean {
  if (official.round === null || live.round === null) return false;
  const officialRound = roundIdentity(official.round, official.tournamentName);
  return officialRound !== "" && !/^(?:tbc|tba|unknown|to be confirmed)$/u.test(officialRound)
    && officialRound === roundIdentity(live.round, live.tournamentName);
}

function roundIdentity(round: string, tournamentName: string): string {
  const text = normalizeText(round).toLocaleLowerCase("en-US")
    .replace(/\bx\d+\b/gu, " ").replace(/[^a-z0-9/]+/gu, " ").trim().replace(/\s+/gu, " ");
  const fraction = /^1\/(\d+)(?:\s+finals?)?$/u.exec(text);
  if (fraction !== null) return `last ${Number(fraction[1]) * 2}`;
  if (/^(?:quarter finals?|quarterfinals?|qf)$/u.test(text)) return "last 8";
  if (/^(?:semi finals?|semifinals?|sf)$/u.test(text)) return "last 4";
  if (/^finals?$/u.test(text)) return "last 2";
  const last = /^(?:last|round of)\s+(\d+)$/u.exec(text);
  if (last !== null) return `last ${last[1] ?? ""}`;
  const ordinal = /^round (one|two|three|four|five|[1-5])$/u.exec(text)?.[1];
  const numbers: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const number = ordinal === undefined ? undefined : numbers[ordinal] ?? Number(ordinal);
  if (number === undefined) return text;
  // These existing event formats have 32-player main draws. Do not infer a
  // field size for other tournaments just from a label such as "Round One".
  const event = normalizeEventName(tournamentName);
  const known32PlayerEvent = event === "world-grand-prix"
    || event === "world-series-of-darts-finals" || event === "world-series-finals";
  return known32PlayerEvent ? `last ${32 / 2 ** (number - 1)}` : `round ${number}`;
}

function hasExplicitEventContext(fixture: PdcFixture): boolean {
  return normalizeEventName(fixture.tournamentName) !== normalizeEventName("PDC live fixture");
}

function normalizeEventName(value: string): string {
  return normalizeId(value.replace(/\b20\d{2}\b/gu, " "));
}

function countEdges<T extends "officialIndex" | "liveIndex">(
  edges: readonly { readonly officialIndex: number; readonly liveIndex: number }[],
  key: T,
): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const edge of edges) counts.set(edge[key], (counts.get(edge[key]) ?? 0) + 1);
  return counts;
}

function livePdcEventContext(
  match: cheerio.Cheerio<AnyNode>,
  competition: cheerio.Cheerio<AnyNode>,
  previewUrl: string,
): string | null {
  if (competition.length === 0) return null;
  const header = competition.find(".hm-round-header").first();
  const headerClone = header.clone();
  headerClone.find(".hm-round-count").remove();
  const title = normalizeText(headerClone.text());
  if (title === "") return null;

  const eventSlug = pdcEventSlug(match.attr("href") ?? "", previewUrl);
  if (eventSlug === null || eventSlug !== normalizeEventName(title)) return null;
  return title;
}

function pdcEventSlug(href: string, previewUrl: string): string | null {
  try {
    const url = new URL(href, previewUrl);
    if (url.protocol !== "https:" || url.hostname !== "www.darts-nerd.com") return null;
    const match = /^\/en\/federations\/pdc\/([a-z0-9]+(?:-[a-z0-9]+)*)\/\d{4}\/matches\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.exec(url.pathname);
    return match?.[1] ?? null;
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function contextualPlayerName(liveName: string, officialNames: readonly string[]): string {
  const matches = officialNames.filter((officialName) => samePlayerLabel(liveName, officialName));
  return matches.length === 1 ? matches[0] ?? liveName : liveName;
}

function samePlayerLabel(left: string, right: string): boolean {
  if (normalizePlayerName(left) === normalizePlayerName(right)) return true;
  return abbreviationMatches(left, right) || abbreviationMatches(right, left);
}

function abbreviationMatches(abbreviated: string, fullName: string): boolean {
  const tokens = abbreviated.trim().split(/\s+/u).filter((token) => token !== "");
  const initials: string[] = [];
  while (tokens.length > 0) {
    const token = tokens.at(-1) ?? "";
    if (!/^[\p{L}]\.$/u.test(token)) break;
    tokens.pop();
    initials.unshift(comparableParts(token)[0] ?? "");
  }
  const surnameParts = comparableParts(tokens.join(" "));
  const fullParts = comparableParts(fullName);
  if (initials.length === 0 || surnameParts.length === 0 || fullParts.length <= surnameParts.length) return false;
  const surnameStart = fullParts.length - surnameParts.length;
  if (fullParts.slice(surnameStart).join(" ") !== surnameParts.join(" ")) return false;
  const givenParts = fullParts.slice(0, surnameStart);
  return initials.every((initial, index) => initial !== "" && givenParts[index]?.startsWith(initial) === true);
}

function comparableParts(value: string): readonly string[] {
  return normalizePlayerName(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part !== "");
}

function validatePreviewUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.darts-nerd.com" || url.pathname !== "/en/matches/preview") {
    throw new Error("Only the Darts Nerd HTTPS preview URL is supported.");
  }
  return url;
}

function isNamedPlayer(name: string): boolean {
  return name !== "" && name !== "?" && !/^(?:tba|winner|loser|to be confirmed)\b/iu.test(name);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
