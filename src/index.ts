import { FileCache } from "./cache.js";
import { DartsOrakelClient, type DartsOrakelClientOptions } from "./dartsorakel/client.js";
import { DartsOrakelScraper } from "./dartsorakel/scraper.js";
import { PlayerResolver } from "./player/resolver.js";
import { PlayerMatchesService } from "./services/player-matches.js";
import type { MatchResult } from "./schemas/match.js";
import type { PlayerIdentity } from "./schemas/player.js";

export type { Match, MatchResult } from "./schemas/match.js";
export type { PlayerIdentity } from "./schemas/player.js";
export { calculateMatchAverage } from "./services/statistics.js";
export { DartsOrakelClient } from "./dartsorakel/client.js";
export { DartsOrakelScraper } from "./dartsorakel/scraper.js";
export { PlayerResolver, normalizePlayerName } from "./player/resolver.js";
export { PlayerMatchesService } from "./services/player-matches.js";
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
