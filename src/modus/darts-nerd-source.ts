import * as cheerio from "cheerio";
import { IsoDateSchema } from "../agent/date.js";
import type { FixtureNameResolver } from "./fixture-name-resolver.js";
import type { ModusFixtureSource } from "./schemas.js";

const DEFAULT_BASE_URL = "https://www.darts-nerd.com";
export interface DartsNerdModusSourceOptions {
  resolver: Pick<FixtureNameResolver, "resolve">;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
export class DartsNerdModusSource implements ModusFixtureSource {
  public readonly name = "Darts Nerd fixture provider";
  private readonly resolver: Pick<FixtureNameResolver, "resolve">;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  public constructor(options: DartsNerdModusSourceOptions) {
    this.resolver = options.resolver;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }
  public sourceUrl(date: string): string {
    return `${this.baseUrl}/en/federations/modus/super-series/${IsoDateSchema.parse(date).slice(0, 4)}/matches`;
  }
  public async getPlayers(date: string): Promise<readonly string[]> {
    const url = this.sourceUrl(date);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: { Accept: "text/html", "User-Agent": "DartsResearchAgent/0.2" }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const abbreviatedNames = parsePlayersForDate(await response.text(), date);
      return Promise.all(abbreviatedNames.map((name) => this.resolver.resolve(name)));
    } finally { clearTimeout(timeout); }
  }
}
export function parsePlayersForDate(html: string, date: string): readonly string[] {
  IsoDateSchema.parse(date);
  const $ = cheerio.load(html);
  const names: string[] = [];
  $(".hm-match .hm-time[data-utc]").each((_index, timeElement) => {
    if ($(timeElement).attr("data-utc")?.slice(0, 10) !== date) return;
    $(timeElement).closest(".hm-match").find(".hm-name").each((_nameIndex, nameElement) => {
      const name = $(nameElement).text().replace(/\s+/g, " ").trim();
      if (name !== "") names.push(name);
    });
  });
  return [...new Set(names)];
}
