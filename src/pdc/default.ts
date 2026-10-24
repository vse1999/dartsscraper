import path from "node:path";

import { FileCache, MemoryCache } from "../cache.js";
import { DartsOrakelClient } from "../dartsorakel/client.js";
import { createResearchReaderFetch } from "../research/config.js";
import { isServerlessRuntime } from "../services/runtime-environment.js";
import type { Logger } from "../logger.js";
import { FixtureNameResolver } from "../modus/fixture-name-resolver.js";
import { CorroboratedPdcFixtureSource, DartsNerdPdcFixtureSource } from "./darts-nerd-fixture-source.js";
import { PdpaPdcFixtureSource } from "./pdpa-fixture-source.js";
import { OfficialPdcApiFixtureSource } from "./official-api-fixture-source.js";
import { EredmenyekPdcFixtureSource } from "./eredmenyek-fixture-source.js";
import { DartsOrakelPdcSource } from "./source.js";
import { PdcTournamentService, type PdcPlayerStatsReader } from "./service.js";

export function createDefaultPdcTournamentService(
  logger: Logger,
  playerStats?: PdcPlayerStatsReader,
  cacheDirectory?: string,
  sharedFixtureNameClient?: DartsOrakelClient,
  sharedFixtureNameResolver?: FixtureNameResolver,
): PdcTournamentService {
  const resolvedCacheDirectory = cacheDirectory ?? path.resolve(process.cwd(), ".cache", "pdc");
  const readerFetch = createResearchReaderFetch();
  // Schedule presentation retains provider-backed labels. An explicit resolver
  // remains available to the offline research workflow's targeted fallback.
  const fallbackResolver = sharedFixtureNameResolver
    ?? (sharedFixtureNameClient === undefined ? undefined : new FixtureNameResolver(sharedFixtureNameClient));
  const officialFixtures = new EredmenyekPdcFixtureSource({
    officialSource: new OfficialPdcApiFixtureSource({ logger, fallbackSource: new PdpaPdcFixtureSource({ logger }) }),
    ...(fallbackResolver === undefined ? {} : { resolver: fallbackResolver }),
    logger,
  });
  const liveFixtures = new DartsNerdPdcFixtureSource({
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
    cache: isServerlessRuntime(process.env) ? new MemoryCache({ maxEntries: 256 }) : new FileCache({ directory: resolvedCacheDirectory, logger }),
    logger,
  });
}
