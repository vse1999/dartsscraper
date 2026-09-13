import path from "node:path";

import { FileCache } from "../cache.js";
import { createJinaReaderFetch } from "../dartsorakel/reader-fetch.js";
import type { Logger } from "../logger.js";
import { DartsOrakelPdcSource } from "./source.js";
import { PdcTournamentService } from "./service.js";

export function createDefaultPdcTournamentService(logger: Logger, cacheDirectory?: string): PdcTournamentService {
  const resolvedCacheDirectory = cacheDirectory ?? path.resolve(process.cwd(), ".cache", "pdc");
  return new PdcTournamentService({
    source: new DartsOrakelPdcSource({ fetchImpl: createJinaReaderFetch(), logger }),
    cache: new FileCache({ directory: resolvedCacheDirectory, logger }),
    logger,
  });
}
