import { z } from "zod";
import { DartsOrakelStructureChangedError } from "../errors.js";
import { IsoDateSchema } from "../agent/date.js";
import type { FixtureNameResolver } from "./fixture-name-resolver.js";
import { canonicalizeFixtureName } from "./fixture-name-resolver.js";
import { ModusFixtureSchema, type ModusFixture, type ModusFixtureSource } from "./schemas.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";

const DEFAULT_URL = "https://modussuperseries.com/live-scores-json.php";
const OfficialCompetitorSchema = z.object({
  name: z.string().trim().min(1),
});
const OfficialFeedSchema = z.object({
  date: IsoDateSchema,
  summaries: z.array(z.object({
    sport_event: z.object({
      id: z.string().trim().min(1).optional(),
      start_time: z.string().datetime({ offset: true }).optional(),
      competitors: z.array(OfficialCompetitorSchema).optional(),
    }),
  })),
});
type OfficialFeed = z.infer<typeof OfficialFeedSchema>;
export interface OfficialModusSourceOptions { url?: string; fetchImpl?: typeof fetch; timeoutMs?: number; resolver?: Pick<FixtureNameResolver, "resolve">; }
export class OfficialModusSource implements ModusFixtureSource {
  public readonly name = "official MODUS daily feed";
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly resolver: Pick<FixtureNameResolver, "resolve"> | undefined;
  public constructor(options: OfficialModusSourceOptions = {}) {
    this.url = options.url ?? DEFAULT_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.resolver = options.resolver;
  }
  public sourceUrl(_date: string): string { return this.url; }
  public async getPlayers(date: string, signal?: AbortSignal): Promise<readonly string[]> {
    throwIfAborted(signal);
    const validatedDate = IsoDateSchema.parse(date);
    const feed = await this.fetchFeed(signal);
    if (feed.date !== validatedDate) return [];
    const names = feed.summaries
      .flatMap((summary) => summary.sport_event.competitors?.map((competitor) => canonicalizeFixtureName(competitor.name)) ?? [])
      .filter(isNamedPlayer);
    const resolved = await this.resolveNames(names, signal);
    throwIfAborted(signal);
    return resolved;
  }

  public async getFixtures(date: string, signal?: AbortSignal): Promise<readonly ModusFixture[]> {
    throwIfAborted(signal);
    const validatedDate = IsoDateSchema.parse(date);
    const feed = await this.fetchFeed(signal);
    if (feed.date !== validatedDate) return [];

    const fixtures: ModusFixture[] = [];
    for (const [index, summary] of feed.summaries.entries()) {
      const competitors = summary.sport_event.competitors ?? [];
      if (competitors.length !== 2) continue;
      const rawNames = competitors.map((competitor) => canonicalizeFixtureName(competitor.name));
      if (rawNames.some((name) => !isNamedPlayer(name))) continue;
      throwIfAborted(signal);
      const resolvedNames = await this.resolveNames(rawNames, signal);
      throwIfAborted(signal);
      const playerOne = resolvedNames[0];
      const playerTwo = resolvedNames[1];
      if (playerOne === undefined || playerTwo === undefined) continue;
      fixtures.push(ModusFixtureSchema.parse({
        id: summary.sport_event.id ?? `official:${validatedDate}:${index + 1}`,
        event: "MODUS Super Series",
        date: validatedDate,
        startTime: summary.sport_event.start_time ?? null,
        playerOne,
        playerTwo,
        source: this.url,
      }));
    }
    return fixtures;
  }

  private async fetchFeed(callerSignal?: AbortSignal): Promise<OfficialFeed> {
    throwIfAborted(callerSignal);
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(callerSignal?.reason ?? new Error("MODUS request cancelled."));
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("MODUS request timed out.")), this.timeoutMs);
    try {
      const response = await waitWithSignal(this.fetchImpl(this.url, {
        headers: { Accept: "application/json", "User-Agent": "DartsResearchAgent/0.2" }, signal: controller.signal,
      }), controller.signal);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await waitWithSignal(response.json(), controller.signal);
      throwIfAborted(callerSignal);
      const parsed = OfficialFeedSchema.safeParse(payload);
      if (!parsed.success) throw new DartsOrakelStructureChangedError("The official MODUS daily feed changed structure.", parsed.error);
      return parsed.data;
    } catch (error: unknown) {
      throwIfAborted(callerSignal);
      throw error;
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private async resolveNames(names: readonly string[], signal?: AbortSignal): Promise<readonly string[]> {
    if (this.resolver === undefined) return names;
    return Promise.all(names.map((name): Promise<string> => isAbbreviatedName(name)
      ? this.resolver?.resolve(name, signal) ?? Promise.resolve(name)
      : Promise.resolve(name)));
  }
}

function isNamedPlayer(name: string): boolean {
  return !/^(winner|runner[- ]?up|semi[- ]?final|tba|to be confirmed)\b/i.test(name);
}

function isAbbreviatedName(name: string): boolean {
  return /^.+?\s+[\p{L}]\.$/u.test(name.trim());
}
