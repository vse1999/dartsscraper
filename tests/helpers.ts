import { readFileSync } from "node:fs";
import path from "node:path";

import { DartsOrakelMatchesResponseSchema, type DartsOrakelMatchesResponse } from "../src/dartsorakel/parser.js";
import { PlayerStatsResponseSchema, type PlayerStatsResponse } from "../src/schemas/player.js";

const fixtureDirectory = path.resolve(process.cwd(), "tests", "fixtures");

export function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtureDirectory, name), "utf8")) as unknown;
}

export function readMatchFixture(name: string): DartsOrakelMatchesResponse {
  return DartsOrakelMatchesResponseSchema.parse(readFixture(name));
}

export function readPlayerStatsFixture(): PlayerStatsResponse {
  return PlayerStatsResponseSchema.parse(readFixture("player-stats.json"));
}
