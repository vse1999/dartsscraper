import { z } from "zod";
import { DartsOrakelStructureChangedError } from "../errors.js";
import { IsoDateSchema } from "../agent/date.js";
import type { FixtureNameResolver } from "./fixture-name-resolver.js";
import { canonicalizeFixtureName } from "./fixture-name-resolver.js";
import { ModusFixtureSchema, type ModusFixture, type ModusFixtureSource } from "./schemas.js";

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
  public async getPlayers(date: string): Promise<readonly string[]> {
    const validatedDate = IsoDateSchema.parse(date);
    const feed = await this.fetchFeed();
    if (feed.date !== validatedDate) return [];
    const names = feed.summaries
      .flatMap((summary) => summary.sport_event.competitors?.map((competitor) => canonicalizeFixtureName(competitor.name)) ?? [])
      .filter(isNamedPlayer);
    return this.resolveNames(names);
  }

  public async getFixtures(date: string): Promise<readonly ModusFixture[]> {
    const validatedDate = IsoDateSchema.parse(date);
    const feed = await this.fetchFeed();
    if (feed.date !== validatedDate) return [];

    const fixtures: ModusFixture[] = [];
    for (const [index, summary] of feed.summaries.entries()) {
      const competitors = summary.sport_event.competitors ?? [];
      if (competitors.length !== 2) continue;
      const rawNames = competitors.map((competitor) => canonicalizeFixtureName(competitor.name));
      if (rawNames.some((name) => !isNamedPlayer(name))) continue;
      const resolvedNames = await this.resolveNames(rawNames);
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

  private async fetchFeed(): Promise<OfficialFeed> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        headers: { Accept: "application/json", "User-Agent": "DartsResearchAgent/0.2" }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await response.json();
      const parsed = OfficialFeedSchema.safeParse(payload);
      if (!parsed.success) throw new DartsOrakelStructureChangedError("The official MODUS daily feed changed structure.", parsed.error);
      return parsed.data;
    } finally { clearTimeout(timeout); }
  }

  private async resolveNames(names: readonly string[]): Promise<readonly string[]> {
    if (this.resolver === undefined) return names;
    return Promise.all(names.map((name) => isAbbreviatedName(name) ? this.resolver?.resolve(name) ?? name : name));
  }
}

function isNamedPlayer(name: string): boolean {
  return !/^(winner|runner[- ]?up|semi[- ]?final|tba|to be confirmed)\b/i.test(name);
}

function isAbbreviatedName(name: string): boolean {
  return /^.+?\s+[\p{L}]\.$/u.test(name.trim());
}
