import { FileCache } from "./cache.js";
import { DartsOrakelClient, type DartsOrakelClientOptions } from "./dartsorakel/client.js";
import { DartsOrakelScraper } from "./dartsorakel/scraper.js";
import { PlayerResolver } from "./player/resolver.js";
import { PlayerMatchesService } from "./services/player-matches.js";
import type { MatchResult } from "./schemas/match.js";
import type { PlayerIdentity } from "./schemas/player.js";

export type { Match, MatchResult } from "./schemas/match.js";
export type { PlayerIdentity } from "./schemas/player.js";
export { calculateMatchAverage, calculateMatchSummary } from "./services/statistics.js";
export type { MatchSummary } from "./services/statistics.js";
export { DartsOrakelClient } from "./dartsorakel/client.js";
export type { DartsOrakelClientOptions, DartsOrakelMatchRequestOptions } from "./dartsorakel/client.js";
export { DartsOrakelMatchRankKey, DartsOrakelMatchStatistic } from "./dartsorakel/selectors.js";
export { DartsOrakelScraper } from "./dartsorakel/scraper.js";
export type { RecentPlayerMatchesOptions } from "./dartsorakel/scraper.js";
export { PlayerResolver, normalizePlayerName } from "./player/resolver.js";
export { PlayerMatchesService } from "./services/player-matches.js";
export { mapWithConcurrency, runModusReport } from "./daily/modus-report.js";
export type {
  ModusReportDependencies,
  ModusReportPlayerResult,
  ModusReportPlayerStatus,
  ModusReportResult,
  RunModusReportOptions,
} from "./daily/modus-report.js";
export { createTelegramSender } from "./telegram/sender.js";
export type { TelegramMessageSender, TelegramSenderOptions } from "./telegram/sender.js";
export * from "./errors.js";

export interface DefaultServiceOptions {
  client?: DartsOrakelClient;
  clientOptions?: DartsOrakelClientOptions;
}

export async function resolvePlayer(
  name: string,
  options: DefaultServiceOptions = {},
): Promise<PlayerIdentity> {
  const resolver = createResolver(options);
  return resolver.resolvePlayer(name);
}

export async function getLastMatches(
  playerName: string,
  limit: number,
  options: DefaultServiceOptions = {},
): Promise<MatchResult> {
  const client = options.client ?? new DartsOrakelClient(options.clientOptions);
  const service = new PlayerMatchesService({
    resolver: new PlayerResolver(client),
    scraper: new DartsOrakelScraper(client),
  });
  return service.getLastMatches(playerName, limit);
}

export function createDefaultClient(cacheDirectory?: string): DartsOrakelClient {
  if (cacheDirectory === undefined) {
    return new DartsOrakelClient();
  }
  return new DartsOrakelClient({ cache: new FileCache({ directory: cacheDirectory }) });
}

function createResolver(options: DefaultServiceOptions): PlayerResolver {
  const client = options.client ?? new DartsOrakelClient(options.clientOptions);
  return new PlayerResolver(client);
}
export { resolveResearchDate, resolveTomorrowDate, IsoDateSchema } from "./agent/date.js";
export { createDartsResearchAgent, createDartsResearchRuntime } from "./agent/factory.js";
export type { CreateAgentOptions, DartsResearchRuntime } from "./agent/factory.js";
export { DartsResearchAgent } from "./agent/harness.js";
export type { AgentConversationMessage, AgentRunOptions, AgentRunResult } from "./agent/harness.js";
export { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_KEEP_ALIVE, DEFAULT_OLLAMA_MODEL } from "./agent/config.js";
export { ChatSessionStore } from "./chat/session-store.js";
export type { ChatSessionStoreOptions } from "./chat/session-store.js";
export { createChatServer, startChatServer } from "./chat/server.js";
export type { ChatAgent, ChatServerOptions, FastChatService, StartChatServerOptions, StartedChatServer } from "./chat/server.js";
export { createOllamaHealthChecker } from "./chat/ollama-health.js";
export type { OllamaHealthChecker, OllamaHealthCheckerOptions, OllamaHealthResult, OllamaHealthStatus } from "./chat/ollama-health.js";
export { OllamaClient } from "./agent/ollama-client.js";
export { AGENT_TOOL_DEFINITIONS, DartsAgentToolExecutor } from "./agent/tools.js";
export { DartsNerdModusSource, parsePlayersForDate } from "./modus/darts-nerd-source.js";
export { FixtureNameResolver } from "./modus/fixture-name-resolver.js";
export { OfficialModusSource } from "./modus/official-source.js";
export {
  OfficialModusResultsSource,
  OfficialModusResultsSourceError,
  parseModusResultsContext,
  parseModusWeekAverages,
} from "./modus/official-results-source.js";
export type {
  OfficialModusResultsSourceOptions,
  ParsedModusResultsContext,
} from "./modus/official-results-source.js";
export { OfficialModusResultsService } from "./modus/results-service.js";
export type { OfficialModusResultsServiceOptions } from "./modus/results-service.js";
export {
  ModusIsoDateTimeSchema,
  ModusResultsContextSchema,
  ModusResultsSnapshotSchema,
} from "./modus/results-schemas.js";
export type {
  ModusMatch,
  ModusMatchPlayer,
  ModusResultsContext,
  ModusResultsSnapshot,
  ModusResultsSource,
  ModusWeekAverage,
} from "./modus/results-schemas.js";
export { ModusPlayersService } from "./modus/service.js";
export type { ModusPlayer, ModusPlayersResult } from "./modus/schemas.js";
export { FastResearchService } from "./services/fast-research.js";
export type { FastResearchAnswer, FastResearchServiceDependencies, ResearchIntent } from "./services/fast-research.js";
export { SnapshotStore } from "./services/snapshot-store.js";
export type { SnapshotRead, SnapshotStoreOptions } from "./services/snapshot-store.js";
