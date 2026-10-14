import { IsoDateSchema, resolveResearchDate } from "../agent/date.js";
import { noopLogger, type Logger } from "../logger.js";
import { normalizePlayerName } from "../player/resolver.js";
import type { FixtureNameResolver } from "./fixture-name-resolver.js";
import { parseModusAbbreviatedName } from "./identity.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import { ModusFixtureSchema, type ModusFixture, type ModusFixtureSource } from "./schemas.js";
import {
  EredmenyekModusScheduleDateMismatchError,
  parseEredmenyekModusDetail,
  parseEredmenyekModusSchedule,
} from "./eredmenyek-parser.js";

export { parseEredmenyekModusDetail, parseEredmenyekModusSchedule } from "./eredmenyek-parser.js";

const DEFAULT_ORIGIN = "https://m.eredmenyek.com";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_FIXTURES = 64;
const FIXTURE_BATCH_SIZE = 4;

export interface EredmenyekModusSourceOptions {
  readonly origin?: string;
  readonly fetchImpl?: typeof fetch;
  readonly resolver?: Pick<FixtureNameResolver, "resolve">;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly timeZone?: string;
  readonly logger?: Logger;
}

/** Public, date-scoped schedule fallback for when the daily MODUS feed is stale. */
export class EredmenyekModusSource implements ModusFixtureSource {
  public readonly name = "Eredmenyek MODUS schedule";
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly resolver: Pick<FixtureNameResolver, "resolve"> | undefined;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly logger: Logger;

  public constructor(options: EredmenyekModusSourceOptions = {}) {
    this.origin = validatedOrigin(options.origin ?? DEFAULT_ORIGIN);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolver = options.resolver;
    this.timeoutMs = positiveFinite(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? "Europe/Budapest";
    this.logger = options.logger ?? noopLogger;
  }

  public sourceUrl(date: string): string {
    const validatedDate = IsoDateSchema.parse(date);
    return this.scheduleUrl(dateOffsetFromToday(validatedDate, this.now(), this.timeZone));
  }

  public async getPlayers(date: string, signal?: AbortSignal): Promise<readonly string[]> {
    const fixtures = await this.getFixtures(date, signal);
    const seen = new Set<string>();
    return fixtures.flatMap((fixture): string[] => [fixture.playerOne, fixture.playerTwo]).filter((name: string): boolean => {
      const key = normalizePlayerName(name);
      if (key === "" || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  public async getFixtures(date: string, callerSignal?: AbortSignal): Promise<readonly ModusFixture[]> {
    const validatedDate = IsoDateSchema.parse(date);
    throwIfAborted(callerSignal);
    const offset = dateOffsetFromToday(validatedDate, this.now(), this.timeZone);
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(callerSignal?.reason ?? new Error("Eredmenyek MODUS request cancelled."));
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    if (callerSignal?.aborted === true) abortFromCaller();
    const timeout = setTimeout(() => controller.abort(new Error("Eredmenyek MODUS fixture discovery timed out.")), this.timeoutMs);

    try {
      const schedule = await this.read(this.scheduleUrl(offset), controller.signal);
      const listed = parseEredmenyekModusSchedule(schedule, offset, this.origin);
      if (listed.length === 0) return [];
      if (listed.length > MAX_FIXTURES) throw new Error("Eredmenyek MODUS fixture safety limit exceeded.");

      const fixtures: ModusFixture[] = [];
      for (let index = 0; index < listed.length; index += FIXTURE_BATCH_SIZE) {
        const batch = await Promise.all(listed.slice(index, index + FIXTURE_BATCH_SIZE).map(async (row): Promise<ModusFixture | undefined> => {
          const detailHtml = await this.read(row.matchUrl, controller.signal);
          let detail: ReturnType<typeof parseEredmenyekModusDetail>;
          try {
            detail = parseEredmenyekModusDetail(detailHtml, row, validatedDate, this.timeZone);
          } catch (error: unknown) {
            if (!(error instanceof EredmenyekModusScheduleDateMismatchError)) throw error;
            this.logger.info("Eredmenyek MODUS adjacent-date fixture was excluded from the requested slate.", {
              matchId: row.matchId,
              requestedDate: error.requestedDate,
              actualDate: error.actualDate,
            });
            return undefined;
          }
          const [playerOne, playerTwo] = await Promise.all([
            this.resolvePlayer(detail.playerOne, controller.signal),
            this.resolvePlayer(detail.playerTwo, controller.signal),
          ]);
          return ModusFixtureSchema.parse({
            id: `eredmenyek:${row.matchId}`,
            event: "MODUS Super Series",
            date: validatedDate,
            startTime: detail.startTime,
            playerOne,
            playerTwo,
            source: row.matchUrl,
          });
        }));
        fixtures.push(...batch.filter((fixture): fixture is ModusFixture => fixture !== undefined));
      }
      throwIfAborted(callerSignal);
      this.logger.info("Eredmenyek supplied dated MODUS fixtures.", { date: validatedDate, fixturesFound: fixtures.length });
      return fixtures;
    } catch (error: unknown) {
      throwIfAborted(callerSignal);
      throw error;
    } finally {
      clearTimeout(timeout);
      controller.abort(new Error("Eredmenyek MODUS discovery finished."));
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private async resolvePlayer(name: string, signal: AbortSignal): Promise<string> {
    if (this.resolver === undefined || parseModusAbbreviatedName(name) === undefined) return name;
    try {
      return await this.resolver.resolve(name, signal);
    } catch (error: unknown) {
      throwIfAborted(signal);
      this.logger.warn("Eredmenyek MODUS player could not be resolved; preserving its source-backed name.", {
        player: name,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return name;
    }
  }

  private scheduleUrl(offset: number): string {
    return `${this.origin}/darts/?d=${offset}&s=1`;
  }

  private async read(url: string, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const response = await waitWithSignal(this.fetchImpl(url, {
      signal,
      redirect: "error",
      headers: { Accept: "text/html", "User-Agent": "DartsResearchAgent/0.8" },
    }), signal);
    if (!response.ok) throw new Error(`Eredmenyek MODUS request returned HTTP ${response.status}.`);
    const html = await waitWithSignal(response.text(), signal);
    if (html.trim() === "" || html.length > 1_000_000) throw new Error("Eredmenyek MODUS response was empty or oversized.");
    return html;
  }
}

function dateOffsetFromToday(date: string, now: Date, timeZone: string): number {
  const today = resolveResearchDate("today", { now, timeZone }).date;
  const offset = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  if (!Number.isSafeInteger(offset) || Math.abs(offset) > 7) throw new Error("Eredmenyek MODUS schedule supports dates only within seven days of today.");
  return offset;
}

function validatedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Eredmenyek origin must be a valid HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Eredmenyek origin must be a plain HTTPS origin.");
  }
  return url.origin;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number.`);
  return value;
}
