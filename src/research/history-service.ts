import { InsufficientMatchDataError } from "../errors.js";
import { IsoDateSchema } from "../agent/date.js";
import type { DartsOrakelScraper } from "../dartsorakel/scraper.js";
import type { PlayerResolver } from "../player/resolver.js";
import { PlayerIdentitySchema, type PlayerIdentity } from "../schemas/player.js";
import { MatchResultSchema, type MatchResult } from "../schemas/match.js";
import { abortError, throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import { validateLimit } from "../services/player-matches.js";
import type { SnapshotRead } from "../services/snapshot-store.js";
import { createEvidenceSnapshot, validateEvidenceSnapshot, type EvidenceSnapshot } from "./evidence.js";
import type { EvidenceLedger } from "./ledger.js";
import { summarizeResearchHistory, type ResearchHistorySummary } from "./statistics.js";

export interface ResearchEvidenceReference {
  readonly id: string;
  readonly observedAt: string;
  readonly sourceUpdatedAt: null;
  readonly sourceObservation: "normalized-response";
  readonly persistence: "memory" | "local" | "failed";
  readonly stale: boolean;
  readonly quality?: {
    readonly identity: "canonical";
    readonly sourceFreshness: "unknown";
    readonly completeness: "unknown";
    readonly ordering: "date-only-ambiguous" | "date-ordered" | "source-order-inconsistent";
    readonly comparability: "unknown-format";
  };
}

export interface ResearchHistoryRead extends SnapshotRead<MatchResult> {
  readonly evidence: ResearchEvidenceReference;
  readonly research: ResearchHistorySummary;
}

export interface ResearchHistoryReader {
  getLastMatches(playerName: string, limit: number, signal?: AbortSignal): Promise<MatchResult>;
  getLastMatchesSnapshot?(playerName: string, limit: number, signal?: AbortSignal): Promise<SnapshotRead<MatchResult> & {
    readonly evidence?: ResearchEvidenceReference;
    readonly research?: ResearchHistorySummary;
  }>;
}

export interface ResearchHistoryOptions {
  readonly resolver: Pick<PlayerResolver, "resolvePlayer">;
  readonly scraper: Pick<DartsOrakelScraper, "getPlayerMatches">;
  readonly ledger: EvidenceLedger;
  readonly persistence?: "memory" | "local";
  readonly freshTtlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => Date;
  readonly onPersistenceError?: () => void;
}

interface Entry {
  readonly snapshot: EvidenceSnapshot;
  readonly persistence: ResearchEvidenceReference["persistence"];
}

interface Flight {
  readonly controller: AbortController;
  readonly promise: Promise<Entry>;
  subscribers: number;
  settled: boolean;
}

export interface ResearchHistoryDiagnostics {
  readonly acquisitions: number;
  readonly cacheHits: number;
  readonly failures: number;
  readonly activeAcquisitions: number;
}

/** Canonical, bounded research reuse. Persistence is local or memory, never distributed. */
export class ResearchHistoryService {
  private readonly options: ResearchHistoryOptions;
  private readonly now: () => Date;
  private readonly freshTtlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, Entry>();
  private readonly flights = new Map<string, Flight>();
  private acquisitions = 0;
  private cacheHits = 0;
  private failures = 0;

  public constructor(options: ResearchHistoryOptions) {
    this.options = options;
    this.now = options.now ?? ((): Date => new Date());
    this.freshTtlMs = positiveInteger(options.freshTtlMs ?? 60_000, "Research freshness TTL");
    this.maxEntries = positiveInteger(options.maxEntries ?? 500, "Research cache capacity");
  }

  public async getLastMatches(name: string, limit: number, signal?: AbortSignal): Promise<MatchResult> {
    return (await this.getLastMatchesSnapshot(name, limit, signal)).value;
  }

  public async getLastMatchesSnapshot(name: string, limit: number, signal?: AbortSignal): Promise<ResearchHistoryRead> {
    validateLimit(limit);
    throwIfAborted(signal);
    const player = PlayerIdentitySchema.parse(await waitWithSignal(this.options.resolver.resolvePlayer(name, signal), signal));
    throwIfAborted(signal);
    const dateTo = nextBudapestDate(this.clock());
    const acquiredLimit = Math.max(20, limit);
    const key = `${player.id}:${dateTo}:${acquiredLimit}`;
    const current = this.entries.get(key);
    if (current !== undefined && this.isFresh(current.snapshot)) {
      this.cacheHits += 1;
      return this.toRead(current, limit);
    }
    let flight = this.flights.get(key);
    if (flight === undefined) {
      if (this.flights.size >= this.maxEntries) throw new Error("Research capacity reached; retry after existing history jobs finish.");
      const controller = new AbortController();
      flight = { controller, subscribers: 0, settled: false, promise: this.acquire(player, acquiredLimit, dateTo, controller.signal) };
      const active = flight;
      this.flights.set(key, active);
      void active.promise.then((entry: Entry): void => {
        if (!active.controller.signal.aborted) {
          this.entries.delete(key);
          this.entries.set(key, entry);
          while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
          }
        }
      }, (): void => { this.failures += 1; }).finally((): void => {
        active.settled = true;
        if (this.flights.get(key) === active) this.flights.delete(key);
      });
    }
    flight.subscribers += 1;
    try {
      return this.toRead(await waitWithSignal(flight.promise, signal), limit);
    } finally {
      flight.subscribers -= 1;
      if (flight.subscribers === 0 && !flight.settled) {
        flight.controller.abort(signal?.aborted === true ? abortError(signal) : new Error("No active history consumers remain."));
        if (this.flights.get(key) === flight) this.flights.delete(key);
      }
    }
  }

  public diagnostics(): ResearchHistoryDiagnostics {
    return { acquisitions: this.acquisitions, cacheHits: this.cacheHits, failures: this.failures, activeAcquisitions: this.flights.size };
  }

  private async acquire(player: PlayerIdentity, limit: number, dateTo: string, signal: AbortSignal): Promise<Entry> {
    let persistenceFailed = false;
    try {
      const previous = await waitWithSignal(this.options.ledger.latest(player.id, dateTo, limit), signal);
      throwIfAborted(signal);
      if (previous !== null) validateEvidenceSnapshot(previous, this.clock());
      if (previous !== null && previous.player.id === player.id && previous.player.name === player.name
        && previous.dateTo === dateTo && previous.requestedCount >= limit && previous.matches.length > 0 && this.isFresh(previous)) {
        this.cacheHits += 1;
        return { snapshot: previous, persistence: this.options.persistence ?? "memory" };
      }
    } catch (error: unknown) {
      throwIfAborted(signal);
      void error;
      persistenceFailed = true;
      this.options.onPersistenceError?.();
    }
    this.acquisitions += 1;
    const matches = await waitWithSignal(this.options.scraper.getPlayerMatches(player, limit, dateTo, signal), signal);
    throwIfAborted(signal);
    const result = MatchResultSchema.parse({ player, matches: matches.slice(0, limit) });
    if (result.matches.length === 0) throw new InsufficientMatchDataError(limit, 0);
    const snapshot = validateEvidenceSnapshot(createEvidenceSnapshot(result, this.clock().toISOString(), dateTo, limit), this.clock());
    try {
      await waitWithSignal(this.options.ledger.write(snapshot), signal);
      throwIfAborted(signal);
    } catch (error: unknown) {
      throwIfAborted(signal);
      void error;
      persistenceFailed = true;
      this.options.onPersistenceError?.();
    }
    return { snapshot, persistence: persistenceFailed ? "failed" : this.options.persistence ?? "memory" };
  }

  private isFresh(snapshot: EvidenceSnapshot): boolean {
    const age = this.clock().getTime() - Date.parse(snapshot.observedAt);
    return age >= 0 && age <= this.freshTtlMs;
  }

  private toRead(entry: Entry, limit: number): ResearchHistoryRead {
    const age = this.clock().getTime() - Date.parse(entry.snapshot.observedAt);
    if (age < 0 || !Number.isFinite(age)) throw new Error("Research observation has an invalid/future timestamp.");
    return {
      value: MatchResultSchema.parse({ player: entry.snapshot.player, matches: entry.snapshot.matches.slice(0, limit) }),
      fetchedAt: entry.snapshot.observedAt,
      dataAgeMs: age,
      stale: age > this.freshTtlMs,
      research: summarizeResearchHistory(entry.snapshot.matches),
      evidence: {
        id: entry.snapshot.id, observedAt: entry.snapshot.observedAt, sourceUpdatedAt: null,
        sourceObservation: "normalized-response", persistence: entry.persistence, stale: age > this.freshTtlMs,
        quality: {
          identity: "canonical", sourceFreshness: "unknown", completeness: "unknown", comparability: "unknown-format",
          ordering: entry.snapshot.matches.some((match, index) => index > 0 && match.date > (entry.snapshot.matches[index - 1]?.date ?? match.date))
            ? "source-order-inconsistent" : new Set(entry.snapshot.matches.map((match) => match.date)).size < entry.snapshot.matches.length
              ? "date-only-ambiguous" : "date-ordered",
        },
      },
    };
  }

  private clock(): Date {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) throw new Error("Research clock must return a valid date.");
    return value;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function nextBudapestDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? "";
  const local = IsoDateSchema.parse(`${part("year")}-${part("month")}-${part("day")}`);
  const next = new Date(`${local}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
