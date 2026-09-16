import path from "node:path";

import { FileCache } from "../cache.js";
import { createJinaReaderFetch } from "../dartsorakel/reader-fetch.js";
import type { Logger } from "../logger.js";
import { PdpaPdcFixtureSource } from "./pdpa-fixture-source.js";
import { DartsOrakelPdcSource } from "./source.js";
import { PdcTournamentService, type PdcPlayerStatsReader } from "./service.js";

export function createDefaultPdcTournamentService(
  logger: Logger,
  playerStats?: PdcPlayerStatsReader,
  cacheDirectory?: string,
): PdcTournamentService {
  const resolvedCacheDirectory = cacheDirectory ?? path.resolve(process.cwd(), ".cache", "pdc");
  return new PdcTournamentService({
    source: new DartsOrakelPdcSource({ fetchImpl: createJinaReaderFetch(), logger }),
    fixtureSource: new PdpaPdcFixtureSource({ logger }),
    ...(playerStats === undefined ? {} : { playerStats }),
    cache: new FileCache({ directory: resolvedCacheDirectory, logger }),
    logger,
  });
}
