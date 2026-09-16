import path from "node:path";

import { FileCache } from "../cache.js";
import { DartsOrakelClient } from "../dartsorakel/client.js";
import { createJinaReaderFetch } from "../dartsorakel/reader-fetch.js";
import type { Logger } from "../logger.js";
import { FixtureNameResolver } from "../modus/fixture-name-resolver.js";
import { CorroboratedPdcFixtureSource, DartsNerdPdcFixtureSource } from "./darts-nerd-fixture-source.js";
import { PdpaPdcFixtureSource } from "./pdpa-fixture-source.js";
import { DartsOrakelPdcSource } from "./source.js";
import { PdcTournamentService, type PdcPlayerStatsReader } from "./service.js";

export function createDefaultPdcTournamentService(
  logger: Logger,
  playerStats?: PdcPlayerStatsReader,
  cacheDirectory?: string,
): PdcTournamentService {
  const resolvedCacheDirectory = cacheDirectory ?? path.resolve(process.cwd(), ".cache", "pdc");
  const readerFetch = createJinaReaderFetch();
  const fixtureNameClient = new DartsOrakelClient({
    fetchImpl: readerFetch,
    maxRetries: 1,
    minRequestIntervalMs: 500,
    logger,
  });
  const officialFixtures = new PdpaPdcFixtureSource({ logger });
  const liveFixtures = new DartsNerdPdcFixtureSource({
    resolver: new FixtureNameResolver(fixtureNameClient),
    logger,
  });
  return new PdcTournamentService({
    source: new DartsOrakelPdcSource({ fetchImpl: readerFetch, logger }),
    fixtureSource: new CorroboratedPdcFixtureSource({
      officialSource: officialFixtures,
      liveSource: liveFixtures,
      logger,
    }),
    ...(playerStats === undefined ? {} : { playerStats }),
    cache: new FileCache({ directory: resolvedCacheDirectory, logger }),
    logger,
  });
}
