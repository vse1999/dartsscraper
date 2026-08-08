import path from "node:path";

import { FileCache } from "./cache.js";
import { DartsOrakelClient } from "./dartsorakel/client.js";
import { DartsOrakelScraper } from "./dartsorakel/scraper.js";
import { DartsOrakelError } from "./errors.js";
import { ConsoleLogger } from "./logger.js";
import { PlayerResolver } from "./player/resolver.js";
import { calculateMatchAverage } from "./services/statistics.js";
import { PlayerMatchesService } from "./services/player-matches.js";

interface CliArguments {
  playerName: string;
  limit: number;
  json: boolean;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const logger = new ConsoleLogger();
  const client = new DartsOrakelClient({
    cache: new FileCache({ directory: path.resolve(process.cwd(), ".cache", "dartsorakel"), logger }),
    logger,
  });
  const service = new PlayerMatchesService({
    resolver: new PlayerResolver(client),
    scraper: new DartsOrakelScraper(client),
  });

  const result = await service.getLastMatches(args.playerName, args.limit);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const mean = calculateMatchAverage(result.matches);
  const lines = [
    result.player.name,
    "",
    `Last ${result.matches.length} matches:`,
    "",
    ...result.matches.map((match) => `${match.date} vs ${match.opponent}   ${formatAverage(match.average)}`),
    "",
    `Mean match average: ${mean === null ? "N/A" : mean.toFixed(2)}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function parseArguments(args: readonly string[]): CliArguments {
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  const playerName = positional[0]?.trim();
  const limitText = positional[1];
  if (playerName === undefined || playerName === "" || limitText === undefined || positional.length !== 2) {
    throw new Error('Usage: npm run player -- "Damon Heta" 10 [--json]');
  }
  const limit = Number(limitText);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error("limit must be a positive integer no greater than 1000.");
  }
  return { playerName, limit, json };
}

function formatAverage(average: number | null): string {
  return average === null ? "—" : average.toFixed(2);
}

main().catch((error: unknown) => {
  const message = error instanceof DartsOrakelError || error instanceof Error ? error.message : "Unexpected error.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
