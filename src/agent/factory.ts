import path from "node:path";
import bundledModusIndex from "../../data/modus-results-index.json" with { type: "json" };
import { FileCache } from "../cache.js";
import { DartsOrakelClient } from "../dartsorakel/client.js";
import { DartsOrakelScraper } from "../dartsorakel/scraper.js";
import { ConsoleLogger, type LogLevel } from "../logger.js";
import { DartsNerdModusSource } from "../modus/darts-nerd-source.js";
import { FixtureNameResolver } from "../modus/fixture-name-resolver.js";
import { ModusFixtureIdentitySource } from "../modus/fixture-identity-source.js";
import { OfficialModusHistorySource } from "../modus/history-source.js";
import { OfficialModusSource } from "../modus/official-source.js";
import { OfficialModusResultsSource } from "../modus/official-results-source.js";
import { OfficialModusResultsService } from "../modus/results-service.js";
import { ModusPlayersService } from "../modus/service.js";
import { createDefaultPdcTournamentService } from "../pdc/default.js";
import { PlayerResolver } from "../player/resolver.js";
import { PlayerMatchesService } from "../services/player-matches.js";
import { FastResearchService } from "../services/fast-research.js";
import { DartsResearchAgent } from "./harness.js";
import { OllamaClient } from "./ollama-client.js";
import { DartsAgentToolExecutor } from "./tools.js";
import { DEFAULT_OLLAMA_MODEL } from "./config.js";

export interface CreateAgentOptions {
  model?: string;
  debug?: boolean;
  cacheDirectory?: string;
  ollamaBaseUrl?: string;
  ollamaKeepAlive?: string;
}

export interface DartsResearchRuntime {
  agent: DartsResearchAgent;
  fastResearchService: FastResearchService;
}

export function createDartsResearchRuntime(options: CreateAgentOptions = {}): DartsResearchRuntime {
  const level: LogLevel = options.debug === true ? "debug" : "warn";
  const logger = new ConsoleLogger({ minimumLevel: level });
  const rootCache = options.cacheDirectory ?? path.resolve(process.cwd(), ".cache");
  const dartsClient = new DartsOrakelClient({ cache: new FileCache({ directory: path.join(rootCache, "dartsorakel"), logger }), logger });
  const playerResolver = new PlayerResolver(dartsClient);
  const playerMatchesService = new PlayerMatchesService({
    resolver: playerResolver,
    scraper: new DartsOrakelScraper(dartsClient),
    logger,
  });
  const fixtureNameResolver = new FixtureNameResolver(dartsClient);
  const fixtureIdentityFallback = new ModusFixtureIdentitySource({
    source: new OfficialModusHistorySource({ logger }), logger,
    knownIdentityNames: bundledModusIndex.matches.flatMap((reference) => [reference.homeName, reference.awayName]),
  });
  const modusService = new ModusPlayersService({
    sources: [
      new OfficialModusSource({ resolver: fixtureNameResolver, fixtureIdentityFallback, logger }),
      new DartsNerdModusSource({ resolver: fixtureNameResolver, fixtureIdentityFallback, logger }),
    ],
    cache: new FileCache({ directory: path.join(rootCache, "modus"), logger }), logger,
  });
  const modusResultsService = new OfficialModusResultsService({
    source: new OfficialModusResultsSource(),
    cache: new FileCache({ directory: path.join(rootCache, "modus-results"), logger }),
    logger,
  });
  const pdcTournamentService = createDefaultPdcTournamentService(logger, undefined, path.join(rootCache, "pdc"));
  const configuredToolExecutor = new DartsAgentToolExecutor({ modusService, modusResultsService, pdcTournamentService, playerMatchesService });
  const ollamaOptions = {
    ...(options.ollamaBaseUrl === undefined ? {} : { baseUrl: options.ollamaBaseUrl }),
    ...(options.ollamaKeepAlive === undefined ? {} : { keepAlive: options.ollamaKeepAlive }),
  };
  const agent = new DartsResearchAgent({
    client: new OllamaClient(ollamaOptions), toolExecutor: configuredToolExecutor,
    model: options.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL, logger,
  });
  const fastResearchService = new FastResearchService({
    modusResultsService,
    pdcTournamentService,
    playerMatchesService,
    playerResolver,
    logger,
  });
  return { agent, fastResearchService };
}

export function createDartsResearchAgent(options: CreateAgentOptions = {}): DartsResearchAgent {
  return createDartsResearchRuntime(options).agent;
}




