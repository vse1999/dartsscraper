import { z } from "zod";

import { IsoDateSchema } from "../agent/date.js";
import { noopLogger, type Logger } from "../logger.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import { PdcFixtureSchema, type PdcFixture, type PdcFixtureSource } from "./schemas.js";

// Public, unauthenticated endpoints used by www.pdc.tv's DartsWeb client.
const TOURNAMENTS_URL = "https://tournaments.darts.web.gc.pdcservices.co.uk/v2";
const FIXTURES_URL = "https://fixtures.darts.web.gc.pdcservices.co.uk/v2";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const ParticipantSchema = z.object({
  participantID: z.string().regex(/^\d+$/u),
  firstName: z.string().trim(),
  lastName: z.string().trim(),
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
}

/** Official API first; PDPA's dated concrete draw remains a safe fallback. */
export class OfficialPdcApiFixtureSource implements PdcFixtureSource {
  public readonly name = "official PDC fixture API with PDPA schedule fallback";
  private readonly fetchImpl: typeof fetch;
  private readonly fallbackSource: PdcFixtureSource | undefined;
  private readonly logger: Logger;
  private readonly timeoutMs: number;

  public constructor(options: OfficialPdcApiFixtureSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fallbackSource = options.fallbackSource;
    this.logger = options.logger ?? noopLogger;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("timeoutMs must be positive and finite.");
  }

  public async getFixtures(date: string, signal?: AbortSignal): Promise<readonly PdcFixture[]> {
    const validatedDate = IsoDateSchema.parse(date);
    throwIfAborted(signal);
    try {
      return await this.discover(validatedDate, signal);
    } catch (error: unknown) {
      throwIfAborted(signal);
      this.logger.warn("Official PDC API discovery unavailable; checking dated PDPA draw.", {
        date: validatedDate, errorType: error instanceof Error ? error.name : "UnknownError",
      });
      if (this.fallbackSource !== undefined) {
        try {
          const fallback = await this.fallbackSource.getFixtures(validatedDate, signal);
          if (fallback.length > 0) return fallback;
        } catch (fallbackError: unknown) {
          throwIfAborted(signal);
          this.logger.warn("PDPA fallback unavailable.", { errorType: fallbackError instanceof Error ? fallbackError.name : "UnknownError" });
        }
      }
      // An outage or an event without a published draw is not a verified empty day.
      throw error instanceof OfficialPdcScheduleUnavailableError ? error
        : new OfficialPdcScheduleUnavailableError(`Official PDC schedule could not be verified for ${validatedDate}. Please retry later.`, error);
    }
  }

  private async discover(date: string, signal?: AbortSignal): Promise<readonly PdcFixture[]> {
    const year = Number(date.slice(0, 4));
    const seasons = date.slice(5, 7) === "01" ? [year - 1, year] : [year];
    const tournaments = new Map<string, z.infer<typeof TournamentSchema>>();
    for (const season of seasons) {
      const rows = await this.pages(TOURNAMENTS_URL, `seasonID:eq:${season}`, TournamentSchema, signal);
      for (const row of rows) {
        if (row.attributes.startDate <= date && row.attributes.endDate >= date) tournaments.set(row.id, row);
      }
    }
    const fixtures = new Map<string, PdcFixture>();
    const unpublished: string[] = [];
    for (const tournament of tournaments.values()) {
      // startDate filters currently return false empty responses. Tournament ID
      // filtering is the official site's reliable path; validate dates locally.
      const rows = await this.pages(FIXTURES_URL, `tournamentID:eq:${tournament.id}`, FixtureRowSchema, signal);
      let datedNamedRows = 0;
      for (const row of rows) {
        const attributes = row.attributes;
        if (attributes.tournamentID !== tournament.id) throw new Error("PDC API returned a fixture from another tournament.");
        if (attributes.startDate !== date) continue;
        const playerOne = participantName(attributes.participant1);
        const playerTwo = participantName(attributes.participant2);
        if (playerOne === null || playerTwo === null) continue;
        // startTime's timezone is not documented: retain no match-level timestamp
        // rather than silently treating a bare local time as UTC.
        const timestamp = z.string().datetime({ offset: true }).safeParse(attributes.startTime);
        const fixture = PdcFixtureSchema.parse({
          id: `pdc-official:${row.id}`, tournamentName: tournament.attributes.name,
          date, startTime: timestamp.success ? timestamp.data : null,
          session: null, round: attributes.stage?.name ?? null,
          playerOne, playerTwo, sourceUrl: `${FIXTURES_URL}/${row.id}`,
          evidenceUrls: [`${TOURNAMENTS_URL}/${tournament.id}`, `${FIXTURES_URL}/${row.id}`],
        });
        fixtures.set(fixture.id, fixture);
        datedNamedRows += 1;
      }
      if (datedNamedRows === 0) unpublished.push(tournament.attributes.name);
    }
    if (unpublished.length > 0) {
      throw new OfficialPdcScheduleUnavailableError(
        `Official PDC event exists on ${date}, but its dated matchups are not published or could not be verified: ${unpublished.join(", ")}. Please retry later.`,
        undefined, { date, tournamentNames: unpublished, availableFixtures: [...fixtures.values()] },
      );
    }
    return [...fixtures.values()];
  }

  private async pages<T extends { readonly id: string }>(baseUrl: string, filter: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<readonly T[]> {
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
      const parsed = pageSchema.parse(await this.fetchJson(url.toString(), signal));
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

  private async fetchJson(url: string, callerSignal?: AbortSignal): Promise<unknown> {
    throwIfAborted(callerSignal);
    const controller = new AbortController();
    const abort = (): void => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("Official PDC API request timed out.")), this.timeoutMs);
    try {
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

function participantName(participant: z.infer<typeof ParticipantSchema> | null): string | null {
  if (participant === null) return null;
  const name = `${participant.firstName} ${participant.lastName}`.normalize("NFKC").trim();
  return name !== "" && !/^(?:winner|loser|tba|tbc|bye|unknown|to be confirmed)\b/iu.test(name) && !name.includes("/") ? name : null;
}
