import { DartsOrakelClient, type DartsOrakelClientOptions } from "../dartsorakel/client.js";
import { createJinaReaderFetch } from "../dartsorakel/reader-fetch.js";
import { InsufficientMatchDataError } from "../errors.js";
import { createDefaultOddsReader, type DefaultOddsReaderOptions } from "../odds/default.js";
import type { OddsDay, OddsIdentityReader, OddsMatch, OddsReader, OddsReport, OddsMatchIdentityEvidence, OddsParticipantIdentityEvidence } from "../odds/contracts.js";
import { createDefaultBulkPlayerStatsService, type PlayerStatsReader, type PlayerStatsResult } from "../telegram/stats-service.js";
import { MatchSchema, type Match } from "../schemas/match.js";
import type { PlayerIdentity } from "../schemas/player.js";
import { throwIfAborted } from "../services/cancellation.js";
import {
  type ValueMatchCard,
  type ValuePlayerAssessment,
  type ValuePlayerDirectory,
  type ValueReader,
  type ValueReaderDependencies,
  type ValueReport,
} from "./contracts.js";
import {
  cardFrom,
  completedNewestFirst,
  countsFromCards,
  emptyCounts,
  observationFromOdds,
  reportStatus,
  summarizeWindow,
  uniqueRequestedNames,
  UNKNOWN_CONTEXT,
  windowMetricsAvailable,
} from "./metrics.js";
import { abbreviatedNameParts, identityKey, isTimeout, normalizeForMatch, positiveInteger, samePlayerName, signalStatus, unresolvedResolution, validDate, waitForSignal } from "./helpers.js";
import { DartsOrakelPlayerDirectory, resolveFromDirectory, type Resolution } from "./directory.js";
import { matchesDisplayedName } from "../odds/identity.js";

const MAX_HISTORY = 20;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RESEARCH_BUDGET_MS = 210_000;

export interface DefaultValueReaderOptions extends Partial<Omit<ValueReaderDependencies, "playerDirectory" | "oddsReader" | "playerStatsReader">> {
  readonly oddsReader?: Pick<OddsReader, "getOdds"> & Partial<Pick<OddsIdentityReader, "getIdentityEvidence" | "maxIdentityEvidenceMatches">>;
  readonly playerStatsReader?: Pick<PlayerStatsReader, "getPlayerStats">;
  readonly playerDirectory?: ValuePlayerDirectory;
  readonly dartsOrakel?: DartsOrakelClientOptions;
  readonly odds?: DefaultOddsReaderOptions;
  readonly researchBudgetMs?: number;
}

/**
 * Joins the visible odds observation to independently sourced completed history.
 * It intentionally contains no probability or value-screening policy.
 */
export class DefaultValueReader implements ValueReader {
  private readonly oddsReader: Pick<OddsReader, "getOdds"> & Partial<Pick<OddsIdentityReader, "getIdentityEvidence" | "maxIdentityEvidenceMatches">>;
  private readonly statsReader: Pick<PlayerStatsReader, "getPlayerStats">;
  private readonly directory: ValuePlayerDirectory;
  private readonly maxConcurrency: number;
  private readonly researchBudgetMs: number;
  private readonly now: () => Date;
  private readonly sourceIdentityCache = new Map<string, SourceIdentityCacheEntry>();
  private readonly conflictingSourcePlayerIds = new Set<string>();

  public constructor(dependencies: ValueReaderDependencies) {
    this.oddsReader = dependencies.oddsReader;
    this.statsReader = dependencies.playerStatsReader;
    this.directory = dependencies.playerDirectory;
    this.maxConcurrency = positiveInteger(dependencies.maxConcurrency ?? DEFAULT_CONCURRENCY, "maxConcurrency");
    this.researchBudgetMs = positiveInteger(dependencies.researchBudgetMs ?? DEFAULT_RESEARCH_BUDGET_MS, "researchBudgetMs");
    this.now = dependencies.now ?? ((): Date => new Date());
  }

  public async getReport(day: OddsDay, signal?: AbortSignal): Promise<ValueReport> {
    throwIfAborted(signal);
    const researchController = new AbortController();
    const cutoff = setTimeout((): void => researchController.abort(new Error("Value research deadline exceeded.")), this.researchBudgetMs);
    const onExternalAbort = (): void => researchController.abort(signal?.reason);
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const researchSignal = researchController.signal;
      const pendingOdds = this.oddsReader.getOdds(day, researchSignal);
      const odds = await waitForSignal(pendingOdds, researchSignal);
      const observation = observationFromOdds(odds);
      if (odds.matches.length === 0) {
        const generatedAt = validDate(this.now(), "Value report clock").toISOString();
        return { day, generatedAt, odds: observation, cards: [], counts: emptyCounts(), status: "complete", warnings: [...odds.warnings] };
      }
      const collectionDate = localIsoDate(validDate(this.now(), "Value report clock"));

      const requestedNames = uniqueRequestedNames(odds.matches);
      let resolutions: ReadonlyMap<string, Resolution>;
      let directoryPlayers: readonly PlayerIdentity[] = [];
      try {
        const loaded = await this.resolveNames(requestedNames, researchSignal);
        resolutions = loaded.resolutions;
        directoryPlayers = loaded.players;
      } catch (_error: unknown) {
        // A directory timeout/error must leave every visible odds card intact.
        const directoryStatus: Resolution["status"] = researchSignal.aborted ? signalStatus(researchSignal) : "failed";
        resolutions = new Map(requestedNames.map((name: string): readonly [string, Resolution] => [
          name,
          { status: directoryStatus, identity: null, error: directoryStatus === "timed_out" ? "Player directory lookup timed out." : directoryStatus === "cancelled" ? "Player directory lookup cancelled." : "Player directory unavailable." },
        ]));
      }

      const slotResolutionResult = await this.resolveMatchSlots(odds, resolutions, directoryPlayers, researchSignal);
      const slotResolutions = slotResolutionResult.slots;

      const stats = await this.fetchResolvedStats(flattenSlotResolutions(slotResolutions), researchSignal);
      const cards = odds.matches.map((match: OddsMatch): ValueMatchCard => {
        const matchResolutions = slotResolutions.get(match.eventId);
        const firstResolution = matchResolutions?.first ?? resolutions.get(match.player1) ?? unresolvedResolution(match.player1);
        const secondResolution = matchResolutions?.second ?? resolutions.get(match.player2) ?? unresolvedResolution(match.player2);
        let first = assessmentFor(match.player1, firstResolution, stats.get(identityKey(firstResolution.identity)), collectionDate);
        let second = assessmentFor(match.player2, secondResolution, stats.get(identityKey(secondResolution.identity)), collectionDate);
        if (first.identity !== null && second.identity !== null && first.identity.id === second.identity.id) {
          first = sameMatchupIdentity(first);
          second = sameMatchupIdentity(second);
        }
        const verifiedMatch = slotResolutionResult.evidence.get(match.eventId);
        return cardFrom(verifiedMatch === undefined ? match : { ...match, identityEvidence: verifiedMatch }, first, second);
      });
      const generatedAt = validDate(this.now(), "Value report clock").toISOString();
      return {
        day,
        generatedAt,
        odds: observation,
        cards,
        counts: countsFromCards(cards),
        status: reportStatus(cards, researchSignal),
        warnings: slotResolutionResult.identityCoverageWarning === undefined
          ? [...odds.warnings]
          : [...odds.warnings, slotResolutionResult.identityCoverageWarning],
      };
    } finally {
      clearTimeout(cutoff);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async resolveNames(names: readonly string[], signal?: AbortSignal): Promise<DirectoryResolution> {
    throwIfAborted(signal);
    const pending = this.directory.getPlayers(signal);
    const players = signal === undefined ? await pending : await waitForSignal(pending, signal);
    throwIfAborted(signal);
    const result = new Map<string, Resolution>();
    for (const requestedName of names) result.set(requestedName, resolveFromDirectory(requestedName, players));
    return { resolutions: result, players };
  }

  private async resolveMatchSlots(
    odds: OddsReport,
    nameResolutions: ReadonlyMap<string, Resolution>,
    directoryPlayers: readonly PlayerIdentity[],
    signal?: AbortSignal,
  ): Promise<MatchSlotResolutionResult> {
    const slots = new Map<string, MatchSlotResolutions>();
    const verifiedEvidence = new Map<string, OddsMatchIdentityEvidence>();
    for (const match of odds.matches) {
      slots.set(match.eventId, {
        first: nameResolutions.get(match.player1) ?? unresolvedResolution(match.player1),
        second: nameResolutions.get(match.player2) ?? unresolvedResolution(match.player2),
      });
    }
    const provider = this.oddsReader.getIdentityEvidence;
    const providerConfigured = provider !== undefined;
    const providerLimit = provider === undefined ? undefined : validIdentityEvidenceLimit(this.oddsReader.maxIdentityEvidenceMatches);
    const directEvidence = new Map<string, OddsMatchIdentityEvidence>();
    for (const match of odds.matches) {
      const embedded = match.identityEvidence;
      if (embedded !== undefined && validEvidenceContext(embedded, match, odds.date)) {
        directEvidence.set(match.eventId, embedded);
        verifiedEvidence.set(match.eventId, embedded);
      }
    }
    for (const [eventId, detail] of directEvidence) {
      const match = odds.matches.find((candidate: OddsMatch): boolean => candidate.eventId === eventId);
      const current = slots.get(eventId);
      if (match === undefined || current === undefined) continue;
      const first = this.resolveSourceParticipant(detail.home, match.player1, directoryPlayers);
      const second = this.resolveSourceParticipant(detail.away, match.player2, directoryPlayers);
      slots.set(eventId, { first, second });
    }
    const candidates = odds.matches.filter((match: OddsMatch): boolean => {
      const slot = slots.get(match.eventId);
      return slot !== undefined && !directEvidence.has(match.eventId)
        && (slot.first.status === "unresolved" || slot.second.status === "unresolved" || needsSourceVerification(match.player1) || needsSourceVerification(match.player2));
    });
    const providerCandidates = providerLimit === undefined
      ? candidates
      : candidates.slice(0, Math.max(0, Math.floor(providerLimit)));
    let evidence: ReadonlyMap<string, OddsMatchIdentityEvidence> = new Map<string, OddsMatchIdentityEvidence>();
    if (provider !== undefined && providerCandidates.length > 0 && directoryPlayers.length > 0) {
      try {
        evidence = await waitForSignal(provider.call(this.oddsReader, providerCandidates, odds.date, signal), signal ?? new AbortController().signal);
      } catch (error: unknown) {
        void error;
      }
    }
    for (const match of candidates) {
      const current = slots.get(match.eventId);
      const detail = evidence.get(match.eventId);
      if (current === undefined || detail === undefined || !validEvidenceContext(detail, match, odds.date)) continue;
      verifiedEvidence.set(match.eventId, detail);
      const first = this.resolveSourceParticipant(detail.home, match.player1, directoryPlayers);
      const second = this.resolveSourceParticipant(detail.away, match.player2, directoryPlayers);
      slots.set(match.eventId, { first, second });
    }
    if (providerConfigured) {
      for (const match of candidates) {
        const detail = evidence.get(match.eventId);
        if (detail !== undefined && validEvidenceContext(detail, match, odds.date)) continue;
        const current = slots.get(match.eventId);
        if (current === undefined) continue;
        slots.set(match.eventId, {
          first: needsSourceVerification(match.player1) ? unavailableSourceResolution() : current.first,
          second: needsSourceVerification(match.player2) ? unavailableSourceResolution() : current.second,
        });
      }
    }
    // A source profile ID is a stable key. If one ID was observed with two
    // full names anywhere in this report, quarantine every slot using it,
    // including the first occurrence that initially looked valid.
    const allEvidence = new Map<string, OddsMatchIdentityEvidence>(directEvidence);
    for (const [eventId, detail] of evidence) allEvidence.set(eventId, detail);
    for (const [eventId, detail] of allEvidence) {
      const current = slots.get(eventId);
      if (current === undefined) continue;
      const blocked = (participant: OddsParticipantIdentityEvidence): boolean => this.conflictingSourcePlayerIds.has(participant.sourcePlayerId);
      slots.set(eventId, {
        first: blocked(detail.home) ? conflictingSourceResolution() : current.first,
        second: blocked(detail.away) ? conflictingSourceResolution() : current.second,
      });
    }
    for (const [eventId, detail] of verifiedEvidence) {
      if (this.conflictingSourcePlayerIds.has(detail.home.sourcePlayerId) || this.conflictingSourcePlayerIds.has(detail.away.sourcePlayerId)) verifiedEvidence.delete(eventId);
    }
    const omitted = providerLimit === undefined ? 0 : Math.max(0, candidates.length - providerCandidates.length);
    return {
      slots,
      evidence: verifiedEvidence,
      ...(omitted === 0 ? {} : {
        identityCoverageWarning: `Source identity verification was bounded to ${providerCandidates.length} of ${candidates.length} odds matchups; ${omitted} remaining abbreviated or unresolved matchup(s) remain unresolved.`,
      }),
    };
  }

  private resolveSourceParticipant(
    participant: OddsParticipantIdentityEvidence,
    displayedName: string,
    directoryPlayers: readonly PlayerIdentity[],
  ): Resolution {
    if (!matchesDisplayedName(participant.fullName, displayedName)) {
      return { status: "unresolved", identity: null, error: "Source identity full name does not match the displayed odds slot." };
    }
    if (!validSourceProfileUrl(participant.profileUrl, participant.sourcePlayerId)) {
      return { status: "unresolved", identity: null, error: "Source identity profile URL failed validation." };
    }
    if (this.conflictingSourcePlayerIds.has(participant.sourcePlayerId)) {
      return { status: "unresolved", identity: null, error: "Source profile ID was observed with conflicting full names." };
    }
    const normalizedName = normalizeForMatch(participant.fullName);
    const cached = this.sourceIdentityCache.get(participant.sourcePlayerId);
    if (cached !== undefined && normalizeForMatch(cached.fullName) !== normalizedName) {
      this.conflictingSourcePlayerIds.add(participant.sourcePlayerId);
      this.sourceIdentityCache.delete(participant.sourcePlayerId);
      return { status: "unresolved", identity: null, error: "Source profile ID was observed with conflicting full names." };
    }
    const exact = resolveExactFullName(participant.fullName, directoryPlayers);
    const entry: SourceIdentityCacheEntry = cached ?? {
      fullName: participant.fullName,
      identity: exact.identity,
      error: exact.error,
    };
    if (cached === undefined) this.sourceIdentityCache.set(participant.sourcePlayerId, entry);
    if (exact.status !== "available" || exact.identity === null) {
      return exact;
    }
    return { status: "available", identity: exact.identity, error: null };
  }

  private async fetchResolvedStats(
    resolutions: ReadonlyMap<string, Resolution>,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, StatsRead>> {
    const byIdentity = new Map<string, PlayerIdentity>();
    for (const resolution of resolutions.values()) {
      if (resolution.identity !== null && resolution.status === "available") {
        byIdentity.set(String(resolution.identity.id), resolution.identity);
      }
    }
    const keys = [...byIdentity.keys()];
    const results = new Map<string, StatsRead>();
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = cursor;
        cursor += 1;
        const key = keys[index];
        if (key === undefined) return;
        const identity = byIdentity.get(key);
        if (identity === undefined) return;
        if (signal?.aborted === true) {
          const status = signalStatus(signal);
          results.set(key, { status, result: null, error: status === "timed_out" ? "Player history lookup timed out." : "Player history lookup cancelled." });
          continue;
        }
        try {
          const pending = signal === undefined
            ? this.statsReader.getPlayerStats(identity.name, MAX_HISTORY)
            : this.statsReader.getPlayerStats(identity.name, MAX_HISTORY, undefined, signal);
          const result = signal === undefined ? await pending : await waitForSignal(pending, signal);
          if (!samePlayerName(result.playerName, identity.name)) {
            results.set(key, {
              status: "failed",
              result: null,
              error: "Stats source returned a different player name than the resolved directory identity.",
            });
          } else {
            results.set(key, { status: "available", result, error: null });
          }
        } catch (error: unknown) {
          const status = signal !== undefined && signal.aborted
            ? signalStatus(signal)
            : error instanceof InsufficientMatchDataError
              ? "partial"
              : isTimeout(error) ? "timed_out" : "failed";
          results.set(key, {
            status,
            result: null,
            error: status === "partial"
              ? "Insufficient completed match history."
              : status === "timed_out"
                ? "Player history lookup timed out."
                : status === "cancelled"
                  ? "Player history lookup cancelled."
                  : "Player history unavailable.",
          });
        }
      }
    };
    const workerCount = Math.min(this.maxConcurrency, Math.max(1, keys.length));
    await Promise.all(Array.from({ length: workerCount }, (): Promise<void> => worker()));
    return results;
  }
}

export { DefaultValueReader as ValueResearchReader, DefaultValueReader as ValueReaderService };

interface StatsRead {
  readonly status: "available" | "partial" | "failed" | "timed_out" | "cancelled";
  readonly result: PlayerStatsResult | null;
  readonly error: string | null;
}

interface DirectoryResolution {
  readonly resolutions: ReadonlyMap<string, Resolution>;
  readonly players: readonly PlayerIdentity[];
}

interface MatchSlotResolutions {
  readonly first: Resolution;
  readonly second: Resolution;
}

interface MatchSlotResolutionResult {
  readonly slots: ReadonlyMap<string, MatchSlotResolutions>;
  readonly evidence: ReadonlyMap<string, OddsMatchIdentityEvidence>;
  readonly identityCoverageWarning?: string;
}

interface SourceIdentityCacheEntry {
  readonly fullName: string;
  readonly identity: PlayerIdentity | null;
  readonly error: string | null;
}

function flattenSlotResolutions(slots: ReadonlyMap<string, MatchSlotResolutions>): ReadonlyMap<string, Resolution> {
  const result = new Map<string, Resolution>();
  for (const [eventId, pair] of slots) {
    result.set(`${eventId}:home`, pair.first);
    result.set(`${eventId}:away`, pair.second);
  }
  return result;
}

function conflictingSourceResolution(): Resolution {
  return { status: "unresolved", identity: null, error: "Source profile ID was observed with conflicting full names." };
}

function unavailableSourceResolution(): Resolution {
  return { status: "unresolved", identity: null, error: "Verified source identity evidence was unavailable for this abbreviated odds slot." };
}

function validIdentityEvidenceLimit(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function resolveExactFullName(name: string, players: readonly PlayerIdentity[]): Resolution {
  const normalized = normalizeForMatch(name);
  const matches = [...new Map(players.filter((player: PlayerIdentity): boolean => normalizeForMatch(player.name) === normalized).map((player): readonly [number, PlayerIdentity] => [player.id, player])).values()];
  if (matches.length === 1) return { status: "available", identity: matches[0] ?? null, error: null };
  if (matches.length > 1) return { status: "unresolved", identity: null, error: "Source full name matched multiple canonical player identities." };
  return { status: "unresolved", identity: null, error: "Source full name was not found in the canonical player directory." };
}

function needsSourceVerification(value: string): boolean {
  return abbreviatedNameParts(value) !== null;
}

function validEvidenceContext(evidence: OddsMatchIdentityEvidence, match: OddsMatch, date: string): boolean {
  return evidence.eventId === match.eventId
    && evidence.date === date
    && evidence.home.sourcePlayerId !== ""
    && evidence.away.sourcePlayerId !== ""
    && evidence.home.sourcePlayerId !== evidence.away.sourcePlayerId
    && matchesDisplayedName(evidence.home.fullName, match.player1)
    && matchesDisplayedName(evidence.away.fullName, match.player2)
    && validSourceProfileUrl(evidence.home.profileUrl, evidence.home.sourcePlayerId)
    && validSourceProfileUrl(evidence.away.profileUrl, evidence.away.sourcePlayerId);
}

function validSourceProfileUrl(value: string, sourcePlayerId: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.origin === "https://www.eredmenyek.com"
      && url.username === ""
      && url.password === ""
      && url.port === ""
      && url.search === ""
      && url.hash === ""
      && new RegExp(`^/jatekos/[A-Za-z0-9_-]+/${escapeRegExp(sourcePlayerId)}/$`, "u").test(url.pathname);
  } catch (error: unknown) {
    void error;
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function createDefaultValueReader(options: DefaultValueReaderOptions = {}): ValueReader {
  const directoryClient = new DartsOrakelClient({
    ...(options.dartsOrakel ?? {}),
    fetchImpl: options.dartsOrakel?.fetchImpl ?? createJinaReaderFetch(),
  });
  const dependencies: ValueReaderDependencies = {
    oddsReader: options.oddsReader ?? createDefaultOddsReader(options.odds),
    playerStatsReader: options.playerStatsReader ?? createDefaultBulkPlayerStatsService(),
    playerDirectory: options.playerDirectory ?? new DartsOrakelPlayerDirectory(directoryClient),
    ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
    ...(options.researchBudgetMs === undefined ? {} : { researchBudgetMs: options.researchBudgetMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return new DefaultValueReader(dependencies);
}


function assessmentFor(requestedName: string, resolution: Resolution, stats: StatsRead | undefined, cutoffDate: string): ValuePlayerAssessment {
  const baseSource = { label: null, provider: null, sourceUrl: null, evidenceUrls: [] as readonly string[] };
  if (resolution.status !== "available" || resolution.identity === null) {
    return {
      requestedName,
      status: resolution.status,
      identity: null,
      canonicalName: null,
      source: baseSource,
      last10: null,
      last20: null,
      error: resolution.error,
      context: UNKNOWN_CONTEXT,
    };
  }
  if (stats === undefined) {
    return {
      requestedName,
      status: "failed",
      identity: resolution.identity,
      canonicalName: resolution.identity.name,
      source: baseSource,
      last10: null,
      last20: null,
      error: "Player history was not fetched.",
      context: UNKNOWN_CONTEXT,
    };
  }
  if (stats.status !== "available" || stats.result === null) {
    const emptyHistory: readonly Match[] = [];
    return {
      requestedName,
      status: stats.status,
      identity: resolution.identity,
      canonicalName: resolution.identity.name,
      source: baseSource,
      last10: stats.status === "partial" ? summarizeWindow(emptyHistory, 10) : null,
      last20: stats.status === "partial" ? summarizeWindow(emptyHistory, 20) : null,
      error: stats.error,
      context: UNKNOWN_CONTEXT,
    };
  }
  const rawMatches: readonly unknown[] = stats.result.matches as readonly unknown[];
  const parsedMatches: Match[] = [];
  let invalidMatchCount = 0;
  for (const rawMatch of rawMatches) {
    const parsed = MatchSchema.safeParse(rawMatch);
    if (parsed.success) parsedMatches.push(parsed.data);
    else invalidMatchCount += 1;
  }
  // Do not backfill around malformed source rows: a schema drift must remain visible.
  const history = invalidMatchCount === 0
    ? completedNewestFirst(parsedMatches, cutoffDate).slice(0, MAX_HISTORY)
    : [];
  const source = {
    label: stats.result.sourceLabel,
    provider: stats.result.provider,
    sourceUrl: stats.result.sourceUrl,
    evidenceUrls: stats.result.evidenceUrls,
  };
  if (invalidMatchCount > 0) {
    return {
      requestedName,
      status: "failed",
      identity: resolution.identity,
      canonicalName: resolution.identity.name,
      source,
      last10: null,
      last20: null,
      error: "History contained invalid match records; statistics were withheld.",
      context: UNKNOWN_CONTEXT,
    };
  }
  const last10 = summarizeWindow(history, 10);
  const last20 = summarizeWindow(history, 20);
  const historyComplete = invalidMatchCount === 0 && history.length >= MAX_HISTORY;
  const metricsComplete = windowMetricsAvailable(last10) && windowMetricsAvailable(last20);
  return {
    requestedName,
    status: historyComplete && metricsComplete ? "available" : "partial",
    identity: resolution.identity,
    canonicalName: resolution.identity.name,
    source,
    last10,
    last20,
    error: historyComplete && metricsComplete ? null : historyComplete
        ? "One or more statistics had incomplete source coverage."
        : `Only ${history.length} completed match(es) were available; 20 requested.`,
    context: UNKNOWN_CONTEXT,
  };
}

function sameMatchupIdentity(player: ValuePlayerAssessment): ValuePlayerAssessment {
  return {
    ...player,
    status: "unresolved",
    identity: null,
    canonicalName: null,
    source: { label: null, provider: null, sourceUrl: null, evidenceUrls: [] },
    last10: null,
    last20: null,
    error: "The odds matchup resolved both displayed slots to the same player identity.",
  };
}

function localIsoDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
