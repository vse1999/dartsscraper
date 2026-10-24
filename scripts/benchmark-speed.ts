import { performance } from "node:perf_hooks";
import { resolveDartsOrakelRequestIntervalMs } from "../src/telegram/stats-service.js";
import { parseEredmenyekPlayerProfile } from "../src/odds/identity.js";
import { MemoryCache } from "../src/cache.js";

interface PacingComparison {
  readonly workload: string;
  readonly requests: number;
  readonly baselineMs: number;
  readonly optimizedJinaMs: number;
  readonly directFetchMs: number;
  readonly modeledRatioJina: string;
  readonly modeledRatioDirect: string;
}

function calculatePacing(requests: number): { baseline: number; jina: number; direct: number } {
  const baselineInterval = resolveDartsOrakelRequestIntervalMs({}, 3_200);
  const jinaInterval = resolveDartsOrakelRequestIntervalMs({ JINA_API_KEY: "free_test_key" });
  const directInterval = resolveDartsOrakelRequestIntervalMs({ DARTSORAKEL_DIRECT_FETCH: "true" });

  const baseline = Math.max(0, requests - 1) * baselineInterval;
  const jina = Math.max(0, requests - 1) * jinaInterval;
  const direct = Math.max(0, requests - 1) * directInterval;

  return { baseline, jina, direct };
}

function runPacingBenchmarks(): PacingComparison[] {
  const workloads = [
    { name: "Warm single player (average, 180s, checkout)", requests: 3 },
    { name: "Cold single player (directory + 3 statistics views)", requests: 4 },
    { name: "PDC Batch (4 pairings = 8 players × 3 views)", requests: 24 },
    { name: "Daily MODUS Slate (12 players × 3 views)", requests: 36 },
    { name: "Full PDC Tournament (32 players × 3 views)", requests: 96 },
  ];

  return workloads.map((w) => {
    const p = calculatePacing(w.requests);
    return {
      workload: w.name,
      requests: w.requests,
      baselineMs: p.baseline,
      optimizedJinaMs: p.jina,
      directFetchMs: p.direct,
      modeledRatioJina: `${(p.baseline / Math.max(1, p.jina)).toFixed(1)}x`,
      modeledRatioDirect: `${(p.baseline / Math.max(1, p.direct)).toFixed(1)}x`,
    };
  });
}

async function benchmarkOddsProfileConcurrency(): Promise<{
  readonly sequentialMs: number;
  readonly concurrentMs: number;
  readonly simulatedRatio: string;
}> {
  const sampleProfiles = [
    { url: "https://www.eredmenyek.com/jatekos/smith-ross/l8mIsYNm/", name: "Ross Smith" },
    { url: "https://www.eredmenyek.com/jatekos/menzies-cameron/2NUpDqVt/", name: "Cameron Menzies" },
  ];

  const html = (url: string, name: string): string =>
    `<html><head><link rel="canonical" href="${url}"></head><body><h1>Darts: ${name} eredmények, meccsek</h1><div class="heading__name">${name}</div></body></html>`;

  const simulatedNetworkFetch = async (url: string, name: string): Promise<string> => {
    await new Promise((resolve) => setTimeout(resolve, 50)); // 50ms simulated network latency
    return html(url, name);
  };

  // 1. Sequential measurement
  const seqStart = performance.now();
  for (let i = 0; i < 6; i++) {
    for (const p of sampleProfiles) {
      const doc = await simulatedNetworkFetch(p.url, p.name);
      parseEredmenyekPlayerProfile({ html: doc, profileUrl: p.url });
    }
  }
  const sequentialMs = Math.round(performance.now() - seqStart);

  // 2. Concurrent measurement
  const conStart = performance.now();
  for (let i = 0; i < 6; i++) {
    await Promise.all(
      sampleProfiles.map(async (p) => {
        const doc = await simulatedNetworkFetch(p.url, p.name);
        return parseEredmenyekPlayerProfile({ html: doc, profileUrl: p.url });
      }),
    );
  }
  const concurrentMs = Math.round(performance.now() - conStart);

  return {
    sequentialMs,
    concurrentMs,
    simulatedRatio: `${(sequentialMs / concurrentMs).toFixed(1)}x`,
  };
}

async function benchmarkDirectoryCache(): Promise<{
  readonly coldLookupMs: number;
  readonly warmCacheHitMs: number;
  readonly simulatedRatio: string;
}> {
  const cache = new MemoryCache({ maxEntries: 100 });
  const directoryPayload = Array.from({ length: 4_000 }, (_, i) => ({
    player_key: i + 1,
    player_name: `Player ${i + 1}`,
    player_profile_url: `https://dartsorakel.com/player/details/${i + 1}/player-${i + 1}`,
  }));

  const coldStart = performance.now();
  // Simulate cold JSON serialization & cache set
  await cache.set("player-stats", directoryPayload, 60_000);
  const coldLookupMs = Number((performance.now() - coldStart).toFixed(2));

  const warmStart = performance.now();
  // Warm read from memory cache
  const cached = await cache.get("player-stats");
  const warmCacheHitMs = Number((performance.now() - warmStart).toFixed(3));

  return {
    coldLookupMs,
    warmCacheHitMs,
    simulatedRatio: `${(coldLookupMs / Math.max(0.001, warmCacheHitMs)).toFixed(1)}x`,
  };
}

async function main(): Promise<void> {
  const pacingResults = runPacingBenchmarks();
  const oddsResults = await benchmarkOddsProfileConcurrency();
  const cacheResults = await benchmarkDirectoryCache();

  const report = {
    benchmarkDate: new Date().toISOString(),
    measurementType: "synthetic model; does not measure DartsOrakel, Jina, Telegram, or production latency",
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
    },
    results: {
      modeledRequestSpacing: pacingResults,
      syntheticOddsProfileConcurrency: oddsResults,
      syntheticMemoryCacheTiming: cacheResults,
    },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Benchmark failed: ${error instanceof Error ? error.message : "unknown"}\n`);
  process.exitCode = 1;
});
