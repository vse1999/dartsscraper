import path from "node:path";
import { FileCache } from "../cache.js";
import { DartsOrakelClient } from "../dartsorakel/client.js";
import { DartsOrakelScraper } from "../dartsorakel/scraper.js";
import { ConsoleLogger, type LogLevel } from "../logger.js";
import { DartsNerdModusSource } from "../modus/darts-nerd-source.js";
import { FixtureNameResolver } from "../modus/fixture-name-resolver.js";
import { OfficialModusSource } from "../modus/official-source.js";
import { ModusPlayersService } from "../modus/service.js";
import { PlayerResolver } from "../player/resolver.js";
import { PlayerMatchesService } from "../services/player-matches.js";
import { DartsResearchAgent } from "./harness.js";
import { OllamaClient } from "./ollama-client.js";
import { DartsAgentToolExecutor } from "./tools.js";
import { DEFAULT_OLLAMA_MODEL } from "./config.js";

export interface CreateAgentOptions { model?: string; debug?: boolean; cacheDirectory?: string; ollamaBaseUrl?: string; }
export function createDartsResearchAgent(options: CreateAgentOptions = {}): DartsResearchAgent {
  const level: LogLevel = options.debug === true ? "debug" : "warn";
  const logger = new ConsoleLogger({ minimumLevel: level });
  const rootCache = options.cacheDirectory ?? path.resolve(process.cwd(), ".cache");
  const dartsClient = new DartsOrakelClient({ cache: new FileCache({ directory: path.join(rootCache, "dartsorakel"), logger }), logger });
  const playerMatchesService = new PlayerMatchesService({ resolver: new PlayerResolver(dartsClient), scraper: new DartsOrakelScraper(dartsClient) });
  const fixtureNameResolver = new FixtureNameResolver(dartsClient);
  const modusService = new ModusPlayersService({
    sources: [new OfficialModusSource({ resolver: fixtureNameResolver }), new DartsNerdModusSource({ resolver: fixtureNameResolver })],
    cache: new FileCache({ directory: path.join(rootCache, "modus"), logger }), logger,
  });
  const toolExecutor = new DartsAgentToolExecutor({ modusService, playerMatchesService });
  return new DartsResearchAgent({
    client: new OllamaClient(options.ollamaBaseUrl === undefined ? {} : { baseUrl: options.ollamaBaseUrl }), toolExecutor,
    model: options.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL, logger,
  });
}




