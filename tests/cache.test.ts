import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileCache } from "../src/cache.js";

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
