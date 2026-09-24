import * as cheerio from "cheerio";

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
    const startTime = match.find(".hm-time[data-utc]").first().attr("data-utc");
    if (startTime?.slice(0, 10) !== validatedDate) return;
    const names = match.find(".hm-name").map((_nameIndex, nameElement) => normalizeText($(nameElement).text())).get();
    const playerOne = names[0];
    const playerTwo = names[1];
    if (playerOne === undefined || playerTwo === undefined || !isNamedPlayer(playerOne) || !isNamedPlayer(playerTwo)) return;
    const roundText = normalizeText(match.find(".hm-round-badge").first().text()).replace(/\\\//gu, "/");
    fixtures.push(PdcFixtureSchema.parse({
      id: `darts-nerd:${validatedDate}:${index + 1}:${normalizeId(playerOne)}:${normalizeId(playerTwo)}`,
      tournamentName: "PDC live fixture",
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
 * A live row is accepted only when it shares a participant with one official
 * row, preventing unrelated darts fixtures from leaking into the PDC report.
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
  const unusedLive = new Set(liveFixtures.map((_fixture, index) => index));
  return officialFixtures.map((official): PdcFixture => {
    const match = bestLiveMatch(official, liveFixtures, unusedLive);
    if (match === undefined) return official;
    unusedLive.delete(match.index);
    const live = match.fixture;
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

function bestLiveMatch(
  official: PdcFixture,
  liveFixtures: readonly PdcFixture[],
  unused: ReadonlySet<number>,
): { readonly index: number; readonly fixture: PdcFixture } | undefined {
  const officialNames = [official.playerOne, official.playerTwo];
  let best: { readonly index: number; readonly fixture: PdcFixture; readonly overlap: number } | undefined;
  for (const index of unused) {
    const fixture = liveFixtures[index];
    if (fixture === undefined || fixture.date !== official.date) continue;
    const overlap = [fixture.playerOne, fixture.playerTwo]
      .filter((name) => officialNames.some((officialName) => samePlayerLabel(name, officialName))).length;
    if (overlap === 0 || (best !== undefined && best.overlap >= overlap)) continue;
    best = { index, fixture, overlap };
  }
  return best;
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
