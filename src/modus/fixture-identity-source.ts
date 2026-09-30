import { IsoDateSchema } from "../agent/date.js";
import { noopLogger, type Logger } from "../logger.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import {
  modusAbbreviationMatches,
  modusCountryQualifiers,
  modusNameBaseKey,
  modusNameKey,
  parseModusAbbreviatedName,
} from "./identity.js";
import type { ModusMatchReference } from "./history-schemas.js";
import type { OfficialModusHistorySource } from "./history-source.js";
import type { ParsedModusResultsPage } from "./results-index-source.js";
import { canonicalizeFixtureName } from "./fixture-name-resolver.js";

const DEFAULT_PAGE_TTL_MS = 15_000;
const MAX_MATCH_DETAIL_REQUESTS_PER_PAGE = 4;

export type ModusFixtureIdentityPair = readonly [playerOne: string, playerTwo: string];

export interface ModusFixtureIdentityFallback {
  resolvePair(
    date: string,
    playerOne: string,
    playerTwo: string,
    signal?: AbortSignal,
  ): Promise<ModusFixtureIdentityPair | null>;
}

export interface ModusFixtureIdentitySourceOptions {
  readonly source: Pick<OfficialModusHistorySource, "getResultsPage" | "getMatchDetails">;
  readonly knownIdentityNames?: readonly string[];
  readonly logger?: Logger;
  readonly pageTtlMs?: number;
  readonly now?: () => number;
}

interface PageState {
  pagePromise: Promise<ParsedModusResultsPage>;
  expiresAt: number;
  readonly matchDetails: Map<string, Promise<Awaited<ReturnType<OfficialModusHistorySource["getMatchDetails"]>> | undefined>>;
  detailRequestCount: number;
}

/**
 * Recovers one fixture pair from the current official MODUS results page.
 * It deliberately reads only the selected page and verifies one exact match
 * detail before returning canonical names; it never creates player IDs.
 */
export class ModusFixtureIdentitySource implements ModusFixtureIdentityFallback {
  private readonly source: Pick<OfficialModusHistorySource, "getResultsPage" | "getMatchDetails">;
  private readonly knownIdentityNames: readonly string[];
  private readonly logger: Logger;
  private readonly pageTtlMs: number;
  private readonly now: () => number;
  private pageState: PageState | undefined;

  public constructor(options: ModusFixtureIdentitySourceOptions) {
    this.source = options.source;
    this.knownIdentityNames = uniqueFullNames(options.knownIdentityNames ?? []);
    this.logger = options.logger ?? noopLogger;
    this.pageTtlMs = positiveFinite(options.pageTtlMs ?? DEFAULT_PAGE_TTL_MS, "pageTtlMs");
    this.now = options.now ?? Date.now;
  }

  public async resolvePair(
    date: string,
    playerOne: string,
    playerTwo: string,
    signal?: AbortSignal,
  ): Promise<ModusFixtureIdentityPair | null> {
    const validatedDate = IsoDateSchema.parse(date);
    const firstLabel = canonicalizeFixtureName(playerOne);
    const secondLabel = canonicalizeFixtureName(playerTwo);
    if (firstLabel === "" || secondLabel === "" || modusNameKey(firstLabel) === modusNameKey(secondLabel)) return null;
    throwIfAborted(signal);

    try {
      const pageState = await this.readCurrentPage(signal);
      const page = await waitWithSignal(pageState.pagePromise, signal);
      throwIfAborted(signal);
      const pageNames = page.matches.flatMap((reference) => [reference.homeName, reference.awayName]);
      const allNames = uniqueFullNames([...pageNames, ...this.knownIdentityNames]);
      const firstIdentity = uniqueLabelIdentity(firstLabel, allNames);
      const secondIdentity = uniqueLabelIdentity(secondLabel, allNames);
      if (firstIdentity === undefined || secondIdentity === undefined || firstIdentity === secondIdentity) return null;

      const candidates = page.matches.filter((reference: ModusMatchReference): boolean => {
        const homeIdentity = uniqueLabelIdentity(reference.homeName, allNames);
        const awayIdentity = uniqueLabelIdentity(reference.awayName, allNames);
        return (homeIdentity === firstIdentity && awayIdentity === secondIdentity)
          || (homeIdentity === secondIdentity && awayIdentity === firstIdentity);
      }).filter((reference: ModusMatchReference): boolean => isSelectedPageMatch(page, reference))
        .sort((left: ModusMatchReference, right: ModusMatchReference): number => {
          return right.matchNumber - left.matchNumber || Number(right.matchId) - Number(left.matchId);
        });
      if (candidates.length === 0) return null;

      for (const reference of candidates) {
        const details = await this.matchDetailsFor(pageState, reference.matchId, signal);
        throwIfAborted(signal);
        if (details === undefined || !detailsMatchReference(details, reference, validatedDate, allNames)) continue;
        const homeIdentity = uniqueLabelIdentity(reference.homeName, allNames);
        const awayIdentity = uniqueLabelIdentity(reference.awayName, allNames);
        const homeName = allNames.find((name: string): boolean => modusNameKey(name) === homeIdentity);
        const awayName = allNames.find((name: string): boolean => modusNameKey(name) === awayIdentity);
        if (homeName === undefined || awayName === undefined) continue;
        return homeIdentity === firstIdentity ? [homeName, awayName] : [awayName, homeName];
      }
      return null;
    } catch (error: unknown) {
      throwIfAborted(signal);
      this.logger.warn("Official MODUS fixture identity recovery was inconclusive; retaining the original fixture labels.", {
        provider: "modus-official",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return null;
    }
  }

  private async readCurrentPage(signal?: AbortSignal): Promise<PageState> {
    throwIfAborted(signal);
    if (this.pageState !== undefined && this.now() < this.pageState.expiresAt) {
      return this.pageState;
    }
    let state: PageState;
    const request = this.source.getResultsPage(undefined, undefined, undefined).then(
      (page: ParsedModusResultsPage): ParsedModusResultsPage => {
        if (this.pageState === state) state.expiresAt = this.now() + this.pageTtlMs;
        return page;
      },
      (error: unknown): never => {
        if (this.pageState === state) this.pageState = undefined;
        throw error;
      },
    );
    state = {
      pagePromise: request,
      expiresAt: Number.POSITIVE_INFINITY,
      matchDetails: new Map(),
      detailRequestCount: 0,
    };
    this.pageState = state;
    return state;
  }

  private matchDetailsFor(
    state: PageState,
    matchId: string,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<OfficialModusHistorySource["getMatchDetails"]>> | undefined> {
    const cached = state.matchDetails.get(matchId);
    if (cached !== undefined) return waitWithSignal(cached, signal);
    if (state.detailRequestCount >= MAX_MATCH_DETAIL_REQUESTS_PER_PAGE) return Promise.resolve(undefined);

    state.detailRequestCount += 1;
    const request = this.source.getMatchDetails(matchId).catch((error: unknown): undefined => {
      this.logger.warn("Official MODUS fixture detail could not be verified.", {
        provider: "modus-official",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return undefined;
    });
    state.matchDetails.set(matchId, request);
    return waitWithSignal(request, signal);
  }
}

function uniqueLabelIdentity(label: string, knownNames: readonly string[]): string | undefined {
  const candidates = uniqueFullNames(knownNames);
  if (candidates.length === 0) return undefined;
  const requestedQualifiers = modusCountryQualifiers(label);
  if (parseModusAbbreviatedName(label) === undefined) {
    if (requestedQualifiers.length > 0) {
      const exact = candidates.filter((name: string): boolean => modusNameKey(name) === modusNameKey(label));
      return uniqueIdentityKey(exact);
    }
    const sameBase = candidates.filter((name: string): boolean => modusNameBaseKey(name) === modusNameBaseKey(label));
    if (sameBase.some((name: string): boolean => modusCountryQualifiers(name).length > 0)) return undefined;
    return uniqueIdentityKey(sameBase);
  }
  const matches = candidates.filter((name: string): boolean => modusAbbreviationMatches(label, name));
  if (requestedQualifiers.length === 0 && matches.some((name: string): boolean => modusCountryQualifiers(name).length > 0)) {
    return undefined;
  }
  return uniqueIdentityKey(matches);
}

function uniqueFullNames(names: readonly string[]): string[] {
  const identities = new Map<string, string>();
  for (const name of names) {
    if (parseModusAbbreviatedName(name) !== undefined) continue;
    const key = modusNameKey(name);
    if (key !== "" && !identities.has(key)) identities.set(key, name);
  }
  return [...identities.values()];
}

function uniqueIdentityKey(names: readonly string[]): string | undefined {
  const keys = [...new Set(names.map((name: string): string => modusNameKey(name)))];
  return keys.length === 1 ? keys[0] : undefined;
}

function isSelectedPageMatch(page: ParsedModusResultsPage, reference: ModusMatchReference): boolean {
  return reference.seriesId === page.selectedSeriesId
    && reference.weekId === page.selectedWeekId
    && reference.group === page.selectedGroup;
}

function detailsMatchReference(
  details: Awaited<ReturnType<OfficialModusHistorySource["getMatchDetails"]>>,
  reference: ModusMatchReference,
  requestedDate: string,
  knownNames: readonly string[],
): boolean {
  const sameOrder = sourceNameVerified(reference.homeName, details.home.name, knownNames)
    && sourceNameVerified(reference.awayName, details.away.name, knownNames);
  const reversedOrder = sourceNameVerified(reference.homeName, details.away.name, knownNames)
    && sourceNameVerified(reference.awayName, details.home.name, knownNames);
  const referenceGroup = modusNameKey(reference.group);
  const detailsGroup = modusNameKey(details.group);
  const groupMatches = reference.group === "Final"
    || detailsGroup === referenceGroup
    || detailsGroup.startsWith(`${referenceGroup} `);
  return details.matchId === reference.matchId
    && sourceUrlVerifiesMatch(details.sourceUrl, reference.matchId)
    && details.date === requestedDate
    && modusNameKey(details.seriesName) === modusNameKey(reference.seriesName)
    && modusNameKey(details.weekName) === modusNameKey(reference.weekName)
    && groupMatches
    && (sameOrder || reversedOrder);
}

function sourceUrlVerifiesMatch(sourceUrl: string, matchId: string): boolean {
  try {
    const url = new URL(sourceUrl);
    return url.protocol === "https:"
      && url.hostname === "modussuperseries.com"
      && url.pathname === "/match-db-stats.php"
      && url.searchParams.get("match_id") === matchId;
  } catch {
    return false;
  }
}

function sourceNameVerified(left: string, right: string, knownNames: readonly string[]): boolean {
  const leftQualifiers = modusCountryQualifiers(left);
  const rightQualifiers = modusCountryQualifiers(right);
  if (leftQualifiers.length !== rightQualifiers.length
    || leftQualifiers.join(",") !== rightQualifiers.join(",")) return false;
  const leftIdentity = uniqueLabelIdentity(left, knownNames);
  if (leftIdentity === undefined) return false;
  const rightIdentity = uniqueLabelIdentity(right, knownNames);
  if (rightIdentity === leftIdentity) return true;
  if (rightIdentity !== undefined) return false;
  return modusAbbreviationMatches(left, right)
    || modusAbbreviationMatches(right, left)
    || sourceSurnameFirstVariant(left, right);
}

function sourceSurnameFirstVariant(left: string, right: string): boolean {
  const leftParts = modusNameBaseKey(left).split(" ").filter((part: string): boolean => part !== "");
  const rightParts = modusNameBaseKey(right).split(" ").filter((part: string): boolean => part !== "");
  return leftParts.length === 2
    && rightParts.length === 2
    && leftParts[0] === rightParts[1]
    && leftParts[1] === rightParts[0];
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number.`);
  return value;
}
