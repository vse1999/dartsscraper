import assert from "node:assert/strict";
import { ResearchHistoryService } from "../src/research/history-service.js";
import { MemoryEvidenceLedger } from "../src/research/ledger.js";
import type { Match } from "../src/schemas/match.js";
import type { PlayerIdentity } from "../src/schemas/player.js";

interface ScenarioResult {
  readonly players: number;
  readonly coldAcquisitions: number;
  readonly warmAdditionalAcquisitions: number;
  readonly restartAdditionalAcquisitions: number;
  readonly syntheticElapsedMs: number;
  readonly modeledColdStatisticViews: number;
  readonly modeledColdLaunchSpanMs: number;
}

async function scenario(count: number): Promise<ScenarioResult> {
  const now = (): Date => new Date("2026-09-30T12:00:00Z");
  const ledger = new MemoryEvidenceLedger({ now });
  let acquisitions = 0;
  const resolver = { resolvePlayer: async (name: string): Promise<PlayerIdentity> => ({ id: Number(name.split(" ")[1]), name, slug: name.replace(" ", "-") }) };
  const scraper = { getPlayerMatches: async (): Promise<Match[]> => {
    acquisitions += 1;
    return Array.from({ length: 20 }, (_, index): Match => ({ date: "2026-09-29", tournament: "Synthetic", round: null,
      result: "Won", opponent: `Opponent ${index}`, score: "6 V 2", average: 90 }));
  } };
  const options = { resolver, scraper, ledger, now };
  const service = new ResearchHistoryService(options);
  const names = Array.from({ length: count }, (_, index): string => `Player ${index + 1}`);
  const start = performance.now();
  await Promise.all(names.map((name: string) => service.getLastMatches(name, 10)));
  const cold = acquisitions;
  await Promise.all(names.map((name: string) => service.getLastMatches(name, 20)));
  const warm = acquisitions - cold;
  const restarted = new ResearchHistoryService(options);
  await Promise.all(names.map((name: string) => restarted.getLastMatches(name, 10)));
  const restart = acquisitions - cold - warm;
  assert.equal(cold, count); assert.equal(warm, 0); assert.equal(restart, 0);
  return { players: count, coldAcquisitions: cold, warmAdditionalAcquisitions: warm, restartAdditionalAcquisitions: restart,
    syntheticElapsedMs: Math.round(performance.now() - start), modeledColdStatisticViews: cold * 3,
    modeledColdLaunchSpanMs: Math.max(0, cold * 3 - 1) * 3_200 };
}

async function main(): Promise<void> {
  const scenarios: ScenarioResult[] = [];
  for (const count of [4, 16, 32]) scenarios.push(await scenario(count));
  process.stdout.write(`${JSON.stringify({ synthetic: true, networkRequests: 0, messagesSent: 0,
    note: "Elapsed time is mocked local processing, not provider latency. Restart uses the same injected ledger; disk restart is covered separately by tests.", scenarios }, null, 2)}\n`);
}
void main().catch((): void => { process.stderr.write("Synthetic research reuse assertions failed.\n"); process.exitCode = 1; });
