import type { AgentConversationMessage } from "../agent/harness.js";
import { resolveResearchDate } from "../agent/date.js";
import type { Logger } from "../logger.js";
import { noopLogger } from "../logger.js";
import type { OfficialModusResultsService } from "../modus/results-service.js";
import type { ModusResultsSnapshot } from "../modus/results-schemas.js";
import type { PlayerResolver } from "../player/resolver.js";
import type { Match } from "../schemas/match.js";
import type { PlayerIdentity } from "../schemas/player.js";
import type { PlayerMatchesService } from "./player-matches.js";
import { calculateMatchAverage } from "./statistics.js";

export type ResearchIntent =
  | { kind: "modus-current-results"; date: string }
  | { kind: "player-last-matches"; player: PlayerIdentity; limit: number; includeAverage: boolean }
  | { kind: "player-latest-match"; player: PlayerIdentity }
  | { kind: "player-last-n-average"; player: PlayerIdentity; limit: number };

export interface FastResearchAnswer {
  answer: string;
  intent: ResearchIntent["kind"];
  executionMode: "fast-path";
  sourceLatencyMs: number;
  dataAgeMs: number;
  fetchedAt: string;
  stale: boolean;
}

export interface FastResearchServiceDependencies {
  modusResultsService: Pick<OfficialModusResultsService, "activate" | "stopBackgroundRefresh">;
  playerMatchesService: Pick<PlayerMatchesService, "getLastMatchesSnapshot">;
  playerResolver: Pick<PlayerResolver, "findMentions" | "preload">;
  now?: () => Date;
  timeZone?: string;
  logger?: Logger;
}

export class FastResearchService {
  private readonly modusResultsService: FastResearchServiceDependencies["modusResultsService"];
  private readonly playerMatchesService: FastResearchServiceDependencies["playerMatchesService"];
  private readonly playerResolver: FastResearchServiceDependencies["playerResolver"];
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly logger: Logger;
  private initialization: Promise<void> | undefined;

  public constructor(dependencies: FastResearchServiceDependencies) {
    this.modusResultsService = dependencies.modusResultsService;
    this.playerMatchesService = dependencies.playerMatchesService;
    this.playerResolver = dependencies.playerResolver;
    this.now = dependencies.now ?? (() => new Date());
    this.timeZone = dependencies.timeZone ?? "Europe/Budapest";
    this.logger = dependencies.logger ?? noopLogger;
  }

  public async initialize(): Promise<void> {
    if (this.initialization !== undefined) return this.initialization;
    this.initialization = this.runInitialization();
    return this.initialization;
  }

  private async runInitialization(): Promise<void> {
    const date = resolveResearchDate("today", { now: this.now(), timeZone: this.timeZone }).date;
    const playerDirectory = this.playerResolver.preload().catch((error: unknown) => {
      this.logger.warn("DartsOrakel player directory preload failed; the first player request will retry.", {
        error: error instanceof Error ? error.message : "unknown error",
      });
    });
    await this.modusResultsService.activate(date);
    await playerDirectory;
  }

  public close(): void {
    this.modusResultsService.stopBackgroundRefresh();
  }

  public async tryAnswer(
    query: string,
    history: readonly AgentConversationMessage[] = [],
    signal?: AbortSignal,
  ): Promise<FastResearchAnswer | null> {
    const startedAt = performance.now();
    const intent = await this.resolveIntent(query, history);
    if (intent === null) return null;

    if (intent.kind === "modus-current-results") {
      const snapshot = await this.modusResultsService.activate(intent.date, signal);
      return {
        answer: renderModusResults(query, snapshot.value, snapshot.stale, snapshot.dataAgeMs),
        intent: intent.kind,
        executionMode: "fast-path",
        sourceLatencyMs: Math.round(performance.now() - startedAt),
        dataAgeMs: snapshot.dataAgeMs,
        fetchedAt: snapshot.fetchedAt,
        stale: snapshot.stale,
      };
    }

    const limit = intent.kind === "player-latest-match" ? 1 : intent.limit;
    const snapshot = await this.playerMatchesService.getLastMatchesSnapshot(intent.player.name, limit, signal);
    const answer = intent.kind === "player-latest-match"
      ? renderLatestMatch(query, snapshot.value.player, snapshot.value.matches[0], snapshot.stale, snapshot.dataAgeMs)
      : intent.kind === "player-last-n-average"
        ? renderPlayerAverage(query, snapshot.value.player, snapshot.value.matches, snapshot.stale, snapshot.dataAgeMs)
        : renderPlayerMatches(query, snapshot.value.player, snapshot.value.matches, intent.includeAverage, snapshot.stale, snapshot.dataAgeMs);
    return {
      answer,
      intent: intent.kind,
      executionMode: "fast-path",
      sourceLatencyMs: Math.round(performance.now() - startedAt),
      dataAgeMs: snapshot.dataAgeMs,
      fetchedAt: snapshot.fetchedAt,
      stale: snapshot.stale,
    };
  }

  private async resolveIntent(query: string, history: readonly AgentConversationMessage[]): Promise<ResearchIntent | null> {
    const normalized = normalizeQuery(query);
    if (/\b(explain|why|how|compare|predict|magyaraz|miert|hogyan|hasonlit)\b/u.test(normalized)) return null;

    if (normalized.includes("modus") && /\b(today|current|latest|results?|scores?|matches?|averages?|mai|aktualis|legfrissebb|eredmeny\w*|meccs\w*|atlag\w*)\b/u.test(normalized)) {
      const today = resolveResearchDate("today", { now: this.now(), timeZone: this.timeZone }).date;
      try {
        const resolved = resolveResearchDate(query, { now: this.now(), timeZone: this.timeZone });
        if (resolved.date !== today) return null;
      } catch {
        // Current/latest queries without an explicit date use today.
      }
      return { kind: "modus-current-results", date: today };
    }

    const directPlayers = await this.playerResolver.findMentions(query);
    const contextual = directPlayers.length === 0 ? await this.contextPlayer(history) : undefined;
    const players = directPlayers.length === 0 && contextual !== undefined ? [contextual] : directPlayers;
    if (players.length !== 1) return null;
    const player = players[0];
    if (player === undefined) return null;

    const historyLimit = this.contextLimit(history);
    const limit = extractLimit(normalized) ?? historyLimit;
    const mentionsMatches = /\b(matches?|games?|meccs\w*)\b/u.test(normalized);
    const mentionsAverage = /\b(average|mean|atlag\w*)\b/u.test(normalized);
    const latest = /\b(latest|most recent|last opponent|last match|legutobbi|legfrissebb)\b/u.test(normalized);
    const latestFact = /\b(opponent|result|score|average|ellenfel|eredmeny|atlag)\b/u.test(normalized);

    if (latest && (latestFact || mentionsMatches) && limit === undefined) return { kind: "player-latest-match", player };
    if (limit !== undefined && mentionsMatches) return { kind: "player-last-matches", player, limit, includeAverage: mentionsAverage };
    if (mentionsAverage && (limit !== undefined || contextual !== undefined)) {
      return { kind: "player-last-n-average", player, limit: limit ?? 10 };
    }
    return null;
  }

  private async contextPlayer(history: readonly AgentConversationMessage[]): Promise<PlayerIdentity | undefined> {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      if (message?.role !== "user") continue;
      const players = await this.playerResolver.findMentions(message.content);
      if (players.length === 1) return players[0];
    }
    return undefined;
  }

  private contextLimit(history: readonly AgentConversationMessage[]): number | undefined {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      if (message?.role !== "user") continue;
      const limit = extractLimit(normalizeQuery(message.content));
      if (limit !== undefined) return limit;
    }
    return undefined;
  }
}

function renderModusResults(query: string, evidence: ModusResultsSnapshot, stale: boolean, ageMs: number): string {
  const hungarian = isHungarian(query);
  const title = hungarian ? `Hivatalos MODUS eredmények — ${evidence.date}` : `Official MODUS results — ${evidence.date}`;
  const matchHeader = hungarian
    ? "| # | Állapot | Játékos 1 | Eredmény | Meccsátlag | Játékos 2 | Meccsátlag |\n|---:|---|---|---:|---:|---|---:|"
    : "| # | Status | Player 1 | Score | Match avg | Player 2 | Match avg |\n|---:|---|---|---:|---:|---|---:|";
  const matches = evidence.matches.map((match) => `| ${match.matchNumber} | ${match.status} | ${match.home.name} | ${formatScore(match.home.score, match.away.score)} | ${formatAverage(match.home.average)} | ${match.away.name} | ${formatAverage(match.away.average)} |`);
  const weeklyHeader = hungarian
    ? "| Hely | Játékos | Meccsek | Dobások | Heti átlag |\n|---:|---|---:|---:|---:|"
    : "| Pos | Player | Played | Darts | Weekly average |\n|---:|---|---:|---:|---:|";
  const weekly = evidence.weekAverages.map((row) => `| ${row.position} | ${row.player} | ${row.played} | ${row.darts} | ${row.average.toFixed(2)} |`);
  return [
    title,
    `${evidence.context.seriesName} · ${evidence.context.weekName} · ${evidence.context.group}`,
    "",
    matchHeader,
    ...matches,
    "",
    hungarian ? "Hivatalos heti összesített átlagok" : "Official cumulative weekly averages",
    weeklyHeader,
    ...weekly,
    "",
    freshnessLine(stale, ageMs, hungarian),
    `Sources: ${evidence.source.dailyFeedUrl} · ${evidence.source.weekAveragesUrl}`,
  ].join("\n");
}

function renderPlayerMatches(query: string, player: PlayerIdentity, matches: readonly Match[], includeAverage: boolean, stale: boolean, ageMs: number): string {
  const hungarian = isHungarian(query);
  const header = hungarian
    ? "| Dátum | Verseny | Forduló | Eredmény | Ellenfél | Pontszám | Átlag |\n|---|---|---|---|---|---|---:|"
    : "| Date | Tournament | Round | Result | Opponent | Score | Average |\n|---|---|---|---|---|---|---:|";
  const rows = matches.map((match) => `| ${match.date} | ${match.tournament} | ${match.round ?? "—"} | ${match.result} | ${match.opponent} | ${match.score} | ${formatAverage(match.average)} |`);
  const mean = calculateMatchAverage(matches);
  const summary = includeAverage
    ? `\n${hungarian ? "Átlag" : "Mean match average"}: ${mean === null ? "—" : mean.toFixed(2)}`
    : "";
  return `${player.name} — ${matches.length} ${hungarian ? "legutóbbi meccs" : "latest matches"}\n\n${header}\n${rows.join("\n")}${summary}\n\n${freshnessLine(stale, ageMs, hungarian)}\nSource: ${playerUrl(player)}`;
}

function renderLatestMatch(query: string, player: PlayerIdentity, match: Match | undefined, stale: boolean, ageMs: number): string {
  const hungarian = isHungarian(query);
  if (match === undefined) return `${player.name}: ${hungarian ? "nincs elérhető befejezett meccs" : "no completed match is available"}.`;
  const header = hungarian
    ? "| Dátum | Ellenfél | Eredmény | Pontszám | Átlag |\n|---|---|---|---|---:|"
    : "| Date | Opponent | Result | Score | Average |\n|---|---|---|---|---:|";
  return `${player.name} — ${hungarian ? "legutóbbi meccs" : "latest match"}\n\n${header}\n| ${match.date} | ${match.opponent} | ${match.result} | ${match.score} | ${formatAverage(match.average)} |\n\n${freshnessLine(stale, ageMs, hungarian)}\nSource: ${playerUrl(player)}`;
}

function renderPlayerAverage(query: string, player: PlayerIdentity, matches: readonly Match[], stale: boolean, ageMs: number): string {
  const hungarian = isHungarian(query);
  const average = calculateMatchAverage(matches);
  const header = hungarian ? "| Játékos | Meccsek | Átlag |\n|---|---:|---:|" : "| Player | Matches | Average |\n|---|---:|---:|";
  return `${hungarian ? "Ellenőrzött meccsátlag" : "Verified match average"}\n\n${header}\n| ${player.name} | ${matches.length} | ${average === null ? "—" : average.toFixed(2)} |\n\n${freshnessLine(stale, ageMs, hungarian)}\nSource: ${playerUrl(player)}`;
}

function extractLimit(query: string): number | undefined {
  const text = /\b(?:last|latest|utolso)\s+(\d{1,3})\b/u.exec(query)?.[1]
    ?? /\b(\d{1,3})\s+(?:matches?|games?|meccs\w*)\b/u.exec(query)?.[1];
  const word = /\b(?:last|latest)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/u.exec(query)?.[1];
  const value = text === undefined ? numberWord(word) : Number(text);
  return Number.isInteger(value) && value > 0 && value <= 1_000 ? value : undefined;
}

function numberWord(value: string | undefined): number {
  if (value === undefined) return Number.NaN;
  const words: Readonly<Record<string, number>> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20,
  };
  return words[value] ?? Number.NaN;
}

function normalizeQuery(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-US");
}

function isHungarian(query: string): boolean {
  return /[áéíóöőúüű]|\b(mai|meccs|átlag|eredmény|ellenfél|utolsó)\b/iu.test(query);
}

function freshnessLine(stale: boolean, ageMs: number, hungarian: boolean): string {
  const seconds = Math.max(0, Math.round(ageMs / 1_000));
  if (stale) return hungarian ? `Figyelmeztetés: ${seconds} másodperces gyorsítótárazott adat; frissítés folyamatban.` : `Warning: cached data is ${seconds}s old; refresh is running.`;
  return hungarian ? `Adat kora: ${seconds} másodperc.` : `Data age: ${seconds}s.`;
}

function playerUrl(player: PlayerIdentity): string {
  return `https://dartsorakel.com/player/details/${player.id}/${encodeURIComponent(player.slug)}`;
}

function formatScore(home: number | null, away: number | null): string {
  return home === null || away === null ? "—" : `${home}–${away}`;
}

function formatAverage(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}
