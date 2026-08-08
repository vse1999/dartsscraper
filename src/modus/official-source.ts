import { z } from "zod";
import { DartsOrakelStructureChangedError } from "../errors.js";
import { IsoDateSchema } from "../agent/date.js";
import type { FixtureNameResolver } from "./fixture-name-resolver.js";
import { canonicalizeFixtureName } from "./fixture-name-resolver.js";
import type { ModusFixtureSource } from "./schemas.js";

const DEFAULT_URL = "https://modussuperseries.com/live-scores-json.php";
const OfficialFeedSchema = z.object({
  date: IsoDateSchema,
  summaries: z.array(z.object({ sport_event: z.object({ competitors: z.array(z.object({ name: z.string().trim().min(1) })).optional() }) })),
});
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
    IsoDateSchema.parse(date);
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
      if (parsed.data.date !== date) return [];
      const names = parsed.data.summaries.flatMap((summary) => summary.sport_event.competitors?.map((competitor) => canonicalizeFixtureName(competitor.name)) ?? []).filter(isNamedPlayer);
      return this.resolver === undefined ? names : Promise.all(names.map((name) => this.resolver?.resolve(name) ?? name));
    } finally { clearTimeout(timeout); }
  }
}

function isNamedPlayer(name: string): boolean {
  return !/^(winner|runner[- ]?up|semi[- ]?final|tba|to be confirmed)\b/i.test(name);
}
