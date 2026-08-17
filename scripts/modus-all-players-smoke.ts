import bundledModusIndex from "../data/modus-results-index.json" with { type: "json" };
import {
  ModusResultsIndexSchema,
  type ModusMatchReference,
} from "../src/modus/history-schemas.js";
import { OfficialModusHistorySource } from "../src/modus/history-source.js";
import { identityKey } from "../src/modus/player-history-service.js";
import { parseStatsQuery } from "../src/telegram/query.js";
import {
  createDefaultPlayerStatsService,
  type PlayerStatsResult,
} from "../src/telegram/stats-service.js";

const REQUESTED_MATCHES = 10;
const OFFICIAL_HOST = "modussuperseries.com";
const OFFICIAL_RESULTS_PATH = "/results.php";
const OFFICIAL_DETAILS_PATH = "/match-db-stats.php";

interface PlayerSmokeResult {
  readonly player: string;
  readonly status: "PASS" | "FAIL";
  readonly matches?: number;
  readonly evidenceUrls?: number;
  readonly error?: string;
}

const index = ModusResultsIndexSchema.parse(bundledModusIndex);
const source = new OfficialModusHistorySource({ timeoutMs: 15_000 });
const liveReferences = await source.getLiveReferences(index);
const players = currentPlayerNames(liveReferences);
if (players.length === 0) {
  throw new Error("The official current MODUS pages contained no players to validate.");
}

const service = createDefaultPlayerStatsService();
const results: PlayerSmokeResult[] = [];
for (const player of players) {
  try {
    const queryText = `${player} last ${REQUESTED_MATCHES} matches from MODUS`;
    const query = parseStatsQuery(queryText);
    if (query === null || query.playerName !== player || query.source !== "modus") {
      throw new Error("The Telegram query parser did not preserve the official player name and MODUS source.");
    }
    const stats = await service.getPlayerStats(query.playerName, query.matchCount, query.source);
    assertOfficialPlayerResult(player, stats);
    const passed: PlayerSmokeResult = {
      player,
      status: "PASS",
      matches: stats.matches.length,
      evidenceUrls: stats.evidenceUrls.length,
    };
    results.push(passed);
    process.stdout.write(`${JSON.stringify(passed)}\n`);
  } catch (error: unknown) {
    const failed: PlayerSmokeResult = {
      player,
      status: "FAIL",
      error: error instanceof Error ? error.message : "Unknown validation failure.",
    };
    results.push(failed);
    process.stdout.write(`${JSON.stringify(failed)}\n`);
  }
}

const failures = results.filter((result: PlayerSmokeResult): boolean => result.status === "FAIL");
const summary = {
  source: "Official MODUS Super Series",
  playersChecked: results.length,
  passed: results.length - failures.length,
  failed: failures.length,
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (failures.length > 0) {
  throw new Error(`${failures.length} of ${results.length} official current MODUS players failed validation.`);
}

function currentPlayerNames(references: readonly ModusMatchReference[]): string[] {
  const byIdentity = new Map<string, string>();
  for (const reference of references) {
    for (const name of [reference.homeName, reference.awayName]) {
      const key = identityKey(name);
      if (key !== "" && !byIdentity.has(key)) byIdentity.set(key, name);
    }
  }
  return [...byIdentity.values()].sort((left: string, right: string): number => left.localeCompare(right, "en"));
}

function assertOfficialPlayerResult(
  requestedPlayer: string,
  stats: PlayerStatsResult,
): void {
  if (stats.provider !== "modus-official") {
    throw new Error(`Expected modus-official, received ${stats.provider}.`);
  }
  if (identityKey(stats.playerName) !== identityKey(requestedPlayer)) {
    throw new Error(`Official result resolved to unexpected player ${JSON.stringify(stats.playerName)}.`);
  }
  if (stats.matches.length === 0 || stats.matches.length > REQUESTED_MATCHES) {
    throw new Error(`Expected 1-${REQUESTED_MATCHES} completed matches, received ${stats.matches.length}.`);
  }
  if (stats.evidenceUrls.length !== stats.matches.length) {
    throw new Error("Official match rows and evidence URLs are not aligned.");
  }
  assertOfficialUrl(stats.sourceUrl, OFFICIAL_RESULTS_PATH);
  for (const evidenceUrl of stats.evidenceUrls) assertOfficialUrl(evidenceUrl, OFFICIAL_DETAILS_PATH);
}

function assertOfficialUrl(value: string, expectedPath: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== OFFICIAL_HOST || url.pathname !== expectedPath) {
    throw new Error(`Unexpected official evidence URL ${JSON.stringify(value)}.`);
  }
}
