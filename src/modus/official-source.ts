import { z } from "zod";
import { DartsOrakelStructureChangedError } from "../errors.js";
import { IsoDateSchema } from "../agent/date.js";
import { noopLogger, type Logger } from "../logger.js";
import type { FixtureNameResolver } from "./fixture-name-resolver.js";
import { canonicalizeFixtureName } from "./fixture-name-resolver.js";
import { ModusFixtureSchema, type ModusFixture, type ModusFixtureSource } from "./schemas.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import type { ModusFixtureIdentityFallback, ModusFixtureIdentityPair } from "./fixture-identity-source.js";

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
export interface OfficialModusSourceOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  resolver?: Pick<FixtureNameResolver, "resolve">;
  logger?: Logger;
  fixtureIdentityFallback?: ModusFixtureIdentityFallback;
}
export class OfficialModusSource implements ModusFixtureSource {
  public readonly name = "official MODUS daily feed";
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly resolver: Pick<FixtureNameResolver, "resolve"> | undefined;
  private readonly logger: Logger;
  private readonly fixtureIdentityFallback: ModusFixtureIdentityFallback | undefined;
  public constructor(options: OfficialModusSourceOptions = {}) {
    this.url = options.url ?? DEFAULT_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.resolver = options.resolver;
    this.logger = options.logger ?? noopLogger;
    this.fixtureIdentityFallback = options.fixtureIdentityFallback;
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
    let resolved: readonly string[];
    if (this.fixtureIdentityFallback === undefined) {
      resolved = await this.resolveNames(names, signal);
    } else {
      const resolvedBySourceName = new Map<string, Set<string>>();
      await Promise.all(feed.summaries.map(async (summary): Promise<void> => {
        const competitors = summary.sport_event.competitors ?? [];
        if (competitors.length !== 2) return;
        const first = canonicalizeFixtureName(competitors[0]?.name ?? "");
        const second = canonicalizeFixtureName(competitors[1]?.name ?? "");
        if (!isNamedPlayer(first) || !isNamedPlayer(second)) return;
        const pair = await this.resolveFixturePair([first, second], validatedDate, signal);
        rememberResolvedName(resolvedBySourceName, first, pair[0]);
        rememberResolvedName(resolvedBySourceName, second, pair[1]);
      }));
      resolved = await Promise.all(names.map(async (name): Promise<string> => {
        const candidates = resolvedBySourceName.get(nameKey(name));
        if (candidates?.size === 1) return [...candidates][0] ?? name;
        if (candidates !== undefined) return name;
        const singleResolution = await this.resolveNames([name], signal);
        return singleResolution[0] ?? name;
      }));
    }
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
      const firstName = rawNames[0];
      const secondName = rawNames[1];
      if (firstName === undefined || secondName === undefined) continue;
      throwIfAborted(signal);
      const resolvedNames = await this.resolveFixturePair([firstName, secondName], validatedDate, signal);
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
    return Promise.all(names.map(async (name): Promise<string> => {
      if (!isAbbreviatedName(name)) return name;
      try {
        return await this.resolver?.resolve(name, signal) ?? name;
      } catch (error: unknown) {
        throwIfAborted(signal);
        this.logger.warn("Official MODUS fixture label could not be resolved; preserving its source name.", {
          source: this.name,
          player: name,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        return name;
      }
    }));
  }

  private async resolveFixturePair(
    names: readonly [string, string],
    date: string,
    signal?: AbortSignal,
  ): Promise<ModusFixtureIdentityPair> {
    const resolved = await Promise.all(names.map(async (name): Promise<{ readonly name: string; readonly resolved: boolean }> => {
      if (!isAbbreviatedName(name)) return { name, resolved: true };
      if (this.resolver === undefined) return { name, resolved: false };
      try {
        return { name: await this.resolver.resolve(name, signal), resolved: true };
      } catch (error: unknown) {
        throwIfAborted(signal);
        this.logger.warn("Official MODUS fixture player could not be resolved; preserving its source label.", {
          source: this.name,
          player: name,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        return { name, resolved: false };
      }
    }));
    const first = resolved[0];
    const second = resolved[1];
    if (first === undefined || second === undefined) return names;
    if ((first.resolved && second.resolved) || this.fixtureIdentityFallback === undefined) {
      return [first.name, second.name];
    }
    try {
      const recovered = await this.fixtureIdentityFallback.resolvePair(date, names[0], names[1], signal);
      throwIfAborted(signal);
      return recovered ?? [first.name, second.name];
    } catch (error: unknown) {
      throwIfAborted(signal);
      this.logger.warn("Official MODUS fixture identity fallback failed; preserving verified and unresolved source labels.", {
        date,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return [first.name, second.name];
    }
  }
}

function isNamedPlayer(name: string): boolean {
  return !/^(winner|runner[- ]?up|semi[- ]?final|tba|to be confirmed)\b/i.test(name);
}

function isAbbreviatedName(name: string): boolean {
  return /^.+?\s+(?:[\p{L}]\.\s*)+$/u.test(name.trim());
}

function nameKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function rememberResolvedName(mapping: Map<string, Set<string>>, sourceName: string, resolvedName: string): void {
  const key = nameKey(sourceName);
  const existing = mapping.get(key) ?? new Set<string>();
  existing.add(resolvedName);
  mapping.set(key, existing);
}
