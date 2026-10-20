import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileCache, MemoryCache, createDefaultDartsCache } from "../src/cache.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("FileCache", () => {
  it("persists a valid entry without leaving a staging file behind", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "darts-cache-"));
    temporaryDirectories.push(directory);
    const cache = new FileCache({ directory, now: () => 1_000 });

    await cache.set("player-stats", { players: 3 }, 10_000);

    await expect(cache.get("player-stats")).resolves.toEqual({ players: 3 });
    await expect(readdir(directory)).resolves.toEqual([expect.stringMatching(/^[a-f0-9]{64}\.json$/u)]);
  });
});

describe("MemoryCache", () => {
  it("keeps bounded process-local entries and does not refresh age on a hit", async () => {
    let now = 100;
    const cache = new MemoryCache({ maxEntries: 2, now: (): number => now });
    await cache.set("one", { value: 1 }, 50);
    await cache.set("two", { value: 2 }, 50);
    await expect(cache.get("one")).resolves.toEqual({ value: 1 });
    await cache.set("three", { value: 3 }, 50);
    await expect(cache.get("two")).resolves.toBeNull();
    now = 151;
    await expect(cache.get("one")).resolves.toBeNull();
    await expect(cache.get("three")).resolves.toBeNull();
  });
});

describe("createDefaultDartsCache", () => {
  it("uses FileCache when local retention is explicitly enabled and MemoryCache otherwise", () => {
    const memory = createDefaultDartsCache(undefined, { RESEARCH_LOCAL_LEDGER_ENABLED: "false" });
    expect(memory).toBeInstanceOf(MemoryCache);
    const local = createDefaultDartsCache(undefined, { RESEARCH_LOCAL_LEDGER_ENABLED: "true" });
    expect(local).toBeInstanceOf(FileCache);
    const serverless = createDefaultDartsCache(undefined, { RESEARCH_LOCAL_LEDGER_ENABLED: "true", VERCEL: "1" });
    expect(serverless).toBeInstanceOf(MemoryCache);
  });
});
