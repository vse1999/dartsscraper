import { z } from "zod";

import { IsoDateSchema } from "../agent/date.js";
import { noopLogger, type Logger } from "../logger.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import { PdcFixtureSchema, PdcScheduleSnapshotSchema, type PdcFixture, type PdcFixtureSource, type PdcScheduleEvent, type PdcScheduleSnapshot } from "./schemas.js";
import { createCalendarUnavailableSnapshot, flattenScheduleFixtures, mergeFallbackFixtures } from "./schedule.js";
import type { PdcFixtureNameResolver } from "./darts-nerd-fixture-source.js";

// Public, unauthenticated endpoints used by www.pdc.tv's DartsWeb client.
const TOURNAMENTS_URL = "https://tournaments.darts.web.gc.pdcservices.co.uk/v2";
const FIXTURES_URL = "https://fixtures.darts.web.gc.pdcservices.co.uk/v2";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const ParticipantSchema = z.object({
  // The official draw includes object-shaped, unassigned bracket slots.
  participantID: z.string().regex(/^\d+$/u).nullable(),
  firstName: z.string().trim().nullable(),
  lastName: z.string().trim().nullable(),
});
const TournamentSchema = z.object({
  id: z.string().regex(/^\d+$/u),
  attributes: z.object({ name: z.string().trim().min(1), startDate: IsoDateSchema, endDate: IsoDateSchema }),
});
const FixtureRowSchema = z.object({
  id: z.string().regex(/^\d+$/u),
  attributes: z.object({
    tournamentID: z.string().regex(/^\d+$/u),
    startDate: IsoDateSchema,
    startTime: z.string().nullable(),
    participant1: ParticipantSchema.nullable(),
    participant2: ParticipantSchema.nullable(),
    stage: z.object({ name: z.string().trim().min(1) }).nullable(),
  }),
});

export class OfficialPdcScheduleUnavailableError extends Error {
  public readonly date: string | undefined;
  public readonly tournamentNames: readonly string[];
  public readonly availableFixtures: readonly PdcFixture[];

  public constructor(message: string, cause?: unknown, details?: {
    readonly date: string;
    readonly tournamentNames: readonly string[];
    readonly availableFixtures: readonly PdcFixture[];
  }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.date = details?.date;
    this.tournamentNames = details?.tournamentNames ?? [];
    this.availableFixtures = details?.availableFixtures ?? [];
  }
}

export interface OfficialPdcApiFixtureSourceOptions {
  readonly fetchImpl?: typeof fetch;
  readonly fallbackSource?: PdcFixtureSource;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
  readonly resolver?: PdcFixtureNameResolver;
}

/** Official API first; PDPA's dated concrete draw remains a safe fallback. */
export class OfficialPdcApiFixtureSource implements PdcFixtureSource {
  public readonly name = "official PDC fixture API with PDPA schedule fallback";
  private readonly fetchImpl: typeof fetch;
  private readonly fallbackSource: PdcFixtureSource | undefined;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly resolver: PdcFixtureNameResolver | undefined;

  public constructor(options: OfficialPdcApiFixtureSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fallbackSource = options.fallbackSource;
    this.logger = options.logger ?? noopLogger;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.resolver = options.resolver;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("timeoutMs must be positive and finite.");
  }

  public async getFixtures(date: string, signal?: AbortSignal): Promise<readonly PdcFixture[]> {
    const schedule = await this.getSchedule(date, signal);
    const fixtures = flattenScheduleFixtures(schedule);
    const unavailableEvents = schedule.events.filter((event) => event.coverage !== "available");
    if (schedule.calendarStatus !== "verified" || unavailableEvents.length > 0) {
      throw new OfficialPdcScheduleUnavailableError(
        `Official PDC schedule could not be fully verified for ${schedule.date}. Please retry later.`,
        undefined,
        { date: schedule.date, tournamentNames: unavailableEvents.map((event) => event.name), availableFixtures: fixtures },
      );
    }
    return fixtures;
  }

  public async getSchedule(date: string, signal?: AbortSignal): Promise<PdcScheduleSnapshot> {
    const validatedDate = IsoDateSchema.parse(date);
    throwIfAborted(signal);
    let schedule: PdcScheduleSnapshot;
    try {
      schedule = await this.discover(validatedDate, signal);
    } catch (error: unknown) {
      throwIfAborted(signal);
      this.logger.warn("Official PDC calendar could not be validated.", {
        date: validatedDate,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      schedule = createCalendarUnavailableSnapshot(validatedDate, new Date().toISOString());
    }
    return this.applyFallback(schedule, signal);
  }

  private async discover(date: string, signal?: AbortSignal): Promise<PdcScheduleSnapshot> {
    const startedAt = performance.now();
    const year = Number(date.slice(0, 4));
    const seasons = date.slice(5, 7) === "01" ? [year - 1, year] : [year];
    const tournaments = new Map<string, z.infer<typeof TournamentSchema>>();
    let requestCount = 0;
    for (const season of seasons) {
      const rows = await this.pages(TOURNAMENTS_URL, `seasonID:eq:${season}`, TournamentSchema, signal, (): void => { requestCount += 1; });
      for (const row of rows) {
        if (row.attributes.startDate <= date && row.attributes.endDate >= date) tournaments.set(row.id, row);
      }
    }
    if (tournaments.size > 64) throw new Error("PDC calendar exceeded the supported event count.");

    const events = await mapEventsWithConcurrency([...tournaments.values()], 2, async (tournament): Promise<PdcScheduleEvent> => {
      try {
        // The tournament-ID endpoint is the reliable path; validate dates locally.
        const rows = await this.pages(FIXTURES_URL, `tournamentID:eq:${tournament.id}`, FixtureRowSchema, signal, (): void => { requestCount += 1; });
        const datedRows = rows.filter((row) => row.attributes.startDate === date);
        const fixtures: PdcFixture[] = [];
        let pendingSlots = 0;
        for (const row of datedRows) {
          const attributes = row.attributes;
          if (attributes.tournamentID !== tournament.id) throw new Error("PDC API returned a fixture from another tournament.");
          const playerOne = participantName(attributes.participant1);
          const playerTwo = participantName(attributes.participant2);
          if (playerOne === null) pendingSlots += 1;
          if (playerTwo === null) pendingSlots += 1;
          if (playerOne === null || playerTwo === null) continue;
          // The official API's source timezone is not established; only retain an explicit offset.
          const timestamp = z.string().datetime({ offset: true }).safeParse(attributes.startTime);
          fixtures.push(PdcFixtureSchema.parse({
            id: `pdc-official:${row.id}`, tournamentName: tournament.attributes.name,
            date, startTime: timestamp.success ? timestamp.data : null,
            session: null, round: attributes.stage?.name ?? null,
            playerOne: await this.resolveName(playerOne, signal), playerTwo: await this.resolveName(playerTwo, signal), sourceUrl: `${FIXTURES_URL}/${row.id}`,
            evidenceUrls: [`${TOURNAMENTS_URL}/${tournament.id}`, `${FIXTURES_URL}/${row.id}`],
          }));
        }
        if (datedRows.length === 0) {
          return unavailableEvent(tournament.id, tournament.attributes.name, "no_dated_fixtures", `${TOURNAMENTS_URL}/${tournament.id}`);
        }
        if (pendingSlots > 0) {
          return {
            eventId: tournament.id,
            name: tournament.attributes.name,
            coverage: fixtures.length === 0 ? "opponents_pending" : "partial",
            fixtures,
            pendingSlots,
            reason: "opponents_unassigned",
            evidenceUrls: [`${TOURNAMENTS_URL}/${tournament.id}`, ...datedRows.map((row) => `${FIXTURES_URL}/${row.id}`)].slice(0, 10),
          };
        }
        return {
          eventId: tournament.id,
          name: tournament.attributes.name,
          coverage: "available",
          fixtures,
          pendingSlots: 0,
          reason: null,
          evidenceUrls: [`${TOURNAMENTS_URL}/${tournament.id}`, ...datedRows.map((row) => `${FIXTURES_URL}/${row.id}`)].slice(0, 10),
        };
      } catch (error: unknown) {
        throwIfAborted(signal);
        this.logger.warn("Official PDC event draw could not be validated.", {
          date,
          eventId: tournament.id,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        return unavailableEvent(tournament.id, tournament.attributes.name, "event_unavailable", `${TOURNAMENTS_URL}/${tournament.id}`);
      }
    }, signal);
    const snapshot = PdcScheduleSnapshotSchema.parse({
      schemaVersion: 1,
      date,
      timeZone: "Europe/Budapest",
      observedAt: new Date().toISOString(),
      calendarStatus: "verified",
      calendarReason: null,
      events,
    });
    this.logger.info("Official PDC schedule discovery completed.", {
      date,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      requestCount,
      events: events.length,
      availableEvents: events.filter((event) => event.coverage === "available").length,
      partialEvents: events.filter((event) => event.coverage === "partial").length,
      pendingEvents: events.filter((event) => event.coverage === "opponents_pending").length,
      unavailableEvents: events.filter((event) => event.coverage === "unavailable").length,
    });
    return snapshot;
  }

  private async applyFallback(schedule: PdcScheduleSnapshot, signal?: AbortSignal): Promise<PdcScheduleSnapshot> {
    const needsFallback = schedule.calendarStatus === "unavailable"
      || schedule.events.some((event) => event.coverage !== "available");
    if (!needsFallback || this.fallbackSource === undefined) return schedule;
    try {
      const rows = await this.fallbackSource.getFixtures(schedule.date, signal);
      return mergeFallbackFixtures(schedule, rows);
    } catch (error: unknown) {
      throwIfAborted(signal);
      this.logger.warn("PDPA PDC fallback could not supplement unresolved schedule coverage.", {
        date: schedule.date,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return schedule;
    }
  }

  private async resolveName(name: string, signal?: AbortSignal): Promise<string> {
    if (this.resolver === undefined) return name;
    try { return await this.resolver.resolve(name, signal); }
    catch (error: unknown) {
      throwIfAborted(signal);
      this.logger.warn("Official PDC player directory resolution unavailable; retaining source-backed name.", { errorType: error instanceof Error ? error.name : "UnknownError" });
      return name;
    }
  }

  private async pages<T extends { readonly id: string }>(baseUrl: string, filter: string, schema: z.ZodType<T>, signal: AbortSignal | undefined, onRequest: () => void): Promise<readonly T[]> {
    const rows: T[] = [];
    const ids = new Set<string>();
    const pageSchema = z.object({
      data: z.array(schema), meta: z.object({ totalCount: z.number().int().nonnegative(), count: z.number().int().nonnegative() }),
    });
    let expectedTotal: number | undefined;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = new URL(baseUrl);
      url.searchParams.set("filter", filter);
      url.searchParams.set("page.size", String(PAGE_SIZE));
      url.searchParams.set("page.number", String(page));
      const parsed = pageSchema.parse(await this.fetchJson(url.toString(), signal, onRequest));
      if (parsed.meta.count !== parsed.data.length) throw new Error("PDC API page count did not match its rows.");
      if (expectedTotal !== undefined && expectedTotal !== parsed.meta.totalCount) throw new Error("PDC schedule changed during pagination; retry the report.");
      expectedTotal = parsed.meta.totalCount;
      for (const row of parsed.data) {
        if (ids.has(row.id)) throw new Error("PDC API repeated a row during pagination; retry the report.");
        ids.add(row.id);
      }
      rows.push(...parsed.data);
      if (rows.length === expectedTotal) return rows;
      if (parsed.data.length === 0 || rows.length > expectedTotal) throw new Error("PDC API pagination was incomplete or inconsistent.");
    }
    throw new Error(`PDC API exceeded the safety limit of ${MAX_PAGES} pages.`);
  }

  private async fetchJson(url: string, callerSignal: AbortSignal | undefined, onRequest: () => void): Promise<unknown> {
    throwIfAborted(callerSignal);
    const controller = new AbortController();
    const abort = (): void => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("Official PDC API request timed out.")), this.timeoutMs);
    try {
      onRequest();
      const response = await waitWithSignal(this.fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "DartsResearchAgent/0.8" }, signal: controller.signal,
      }), controller.signal);
      if (!response.ok) throw new Error(`Official PDC API returned HTTP ${response.status}.`);
      return await waitWithSignal(response.json() as Promise<unknown>, controller.signal);
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abort);
    }
  }
}

function unavailableEvent(eventId: string, name: string, reason: "event_unavailable" | "no_dated_fixtures", evidenceUrl: string): PdcScheduleEvent {
  return {
    eventId,
    name,
    coverage: "unavailable",
    fixtures: [],
    pendingSlots: null,
    reason,
    evidenceUrls: [evidenceUrl],
  };
}

async function mapEventsWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<readonly R[]> {
  const results: Array<R | undefined> = new Array<R | undefined>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async (): Promise<void> => {
    while (nextIndex < values.length) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) continue;
      results[index] = await mapper(value);
    }
  });
  await Promise.all(workers);
  return results.filter((result): result is R => result !== undefined);
}

function participantName(participant: z.infer<typeof ParticipantSchema> | null): string | null {
  if (participant === null || participant.participantID === null || participant.firstName === null || participant.lastName === null) return null;
  const name = `${participant.firstName} ${participant.lastName}`.normalize("NFKC").trim();
  return name !== "" && !/^(?:winner|loser|tba|tbc|bye|unknown|to be confirmed)\b/iu.test(name) && !name.includes("/") ? name : null;
}
