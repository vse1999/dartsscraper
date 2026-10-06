import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlayerNotFoundError } from "../src/errors.js";
import { PdcFixtureSchema, type PdcFixture } from "../src/pdc/schemas.js";
import { buildFixtureInventory } from "../src/research/fixture-inventory.js";
import { collectFixtureResearch, type FixtureCollectionOptions } from "../src/research/fixture-collection.js";
import { collectResearchBatch } from "../src/research/collection-runner.js";
import { FileEvidenceLedger } from "../src/research/ledger.js";
import { readLocalJson } from "../src/research/local-files.js";
import { ResearchHistoryService } from "../src/research/history-service.js";
import { createCollectionBudget } from "../src/research/collection-budget.js";
import type { Match } from "../src/schemas/match.js";
import type { PlayerIdentity } from "../src/schemas/player.js";

const WORKSPACE = path.resolve(process.cwd());
const TEST_DIRECTORY_PREFIX = ".test-fixture-collection-";
const TEST_DATE = "2026-09-30";
const directories: string[] = [];

interface TestHarness {
  readonly ledger: FileEvidenceLedger;
  readonly history: ResearchHistoryService;
  readonly scraper: ReturnType<typeof vi.fn<(player: PlayerIdentity, limit?: number, dateTo?: string, signal?: AbortSignal) => Promise<Match[]>>>;
  readonly clock: () => Date;
  advanceClock(milliseconds: number): void;
}

function assertTestDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== WORKSPACE || !path.basename(resolved).startsWith(TEST_DIRECTORY_PREFIX)) {
    throw new Error(`Refusing to access a test directory outside the owned workspace scope: ${resolved}`);
  }
}

async function createTestDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(WORKSPACE, TEST_DIRECTORY_PREFIX));
  directories.push(directory);
  assertTestDirectory(directory);
  return directory;
}

afterEach(async (): Promise<void> => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    assertTestDirectory(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

function player(id: number, name: string): PlayerIdentity {
  return { id, name, slug: name.toLocaleLowerCase("en-US").replaceAll(" ", "-") };
}

function fixture(id: string, playerOne: string, playerTwo: string, startTime: string | null = null): PdcFixture {
  return PdcFixtureSchema.parse({
    id,
    tournamentName: "Fixture collection test",
    date: TEST_DATE,
    startTime,
    session: null,
    round: "Round One",
    playerOne,
    playerTwo,
    sourceUrl: "https://pdpa.co.uk/event/fixture-collection-test/",
  });
}

function historyRows(): Match[] {
  return Array.from({ length: 20 }, (_, index: number): Match => ({
    date: "2026-09-29",
    tournament: "Synthetic event",
    round: null,
    result: "Won",
    opponent: `Synthetic opponent ${index + 1}`,
    score: "6 V 2",
    average: 90 + (index % 5),
  }));
}

function createHarness(directory: string, identities: ReadonlyMap<string, PlayerIdentity>, options: {
  readonly scrape?: (player: PlayerIdentity, limit: number | undefined, dateTo: string | undefined, signal: AbortSignal | undefined) => Promise<Match[]>;
} = {}): TestHarness {
  let currentTime = Date.parse("2026-09-30T12:00:00.000Z");
  const clock = (): Date => new Date(currentTime);
  const ledger = new FileEvidenceLedger(path.join(directory, "evidence"), { now: clock });
  const scraper = vi.fn(async (identity: PlayerIdentity, limit?: number, dateTo?: string, signal?: AbortSignal): Promise<Match[]> => {
    if (options.scrape !== undefined) return options.scrape(identity, limit, dateTo, signal);
    return historyRows();
  });
  const history = new ResearchHistoryService({
    resolver: {
      resolvePlayer: async (name: string): Promise<PlayerIdentity> => {
        const resolved = identities.get(name);
        if (resolved === undefined) throw new PlayerNotFoundError(name);
        return resolved;
      },
    },
    scraper: { getPlayerMatches: scraper },
    ledger,
    persistence: "local",
    now: clock,
  });
  return {
    ledger,
    history,
    scraper,
    clock,
    advanceClock: (milliseconds: number): void => { currentTime += milliseconds; },
  };
}

function participantResolver(identities: ReadonlyMap<string, PlayerIdentity>): FixtureCollectionOptions["resolveParticipant"] {
  return async (name: string): Promise<PlayerIdentity> => {
    const resolved = identities.get(name);
    if (resolved === undefined) throw new PlayerNotFoundError(name);
    return resolved;
  };
}

function collectionOptions(
  root: string,
  harness: TestHarness,
  inventory: ReturnType<typeof buildFixtureInventory>,
  resolveParticipant: FixtureCollectionOptions["resolveParticipant"],
  options: Pick<FixtureCollectionOptions, "budgetMs"> = {},
): FixtureCollectionOptions {
  return {
    directory: path.join(root, "runs"),
    ledger: harness.ledger,
    reader: harness.history,
    resolveParticipant,
    discover: async (): Promise<ReturnType<typeof buildFixtureInventory>> => inventory,
    now: harness.clock,
    ...options,
  };
}

async function manifestPath(runDirectory: string): Promise<string> {
  const files = (await readdir(path.join(runDirectory, "fixture-v2"))).filter((name: string): boolean => name.endsWith(".json"));
  if (files.length !== 1) throw new Error(`Expected exactly one v2 manifest, found ${files.length}.`);
  const name = files[0];
  if (name === undefined) throw new Error("Fixture manifest path was not returned.");
  return path.join(runDirectory, "fixture-v2", name);
}

function withCorruptChecksum(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected the saved manifest to be an object.");
  }
  return { ...value, checksum: "0".repeat(64) };
}

describe("fixture-driven local research collection", () => {
  it("rejects canonical names that the legacy runner would collapse before persisting a manifest", async () => {
    const root = await createTestDirectory();
    const identities = new Map([["First Alias", player(1, "Example Player")], ["Second Alias", player(2, "EXAMPLE PLAYER")]]);
    const harness = createHarness(root, identities);
    const inventory = buildFixtureInventory("pdc", TEST_DATE, [fixture("collision", "First Alias", "Second Alias")]);
    const options = collectionOptions(root, harness, inventory, participantResolver(identities));
    await expect(collectFixtureResearch({ source: "pdc", date: TEST_DATE, runLabel: "collision" }, options))
      .rejects.toThrow("conflicting normalized names");
    expect(harness.scraper).not.toHaveBeenCalled();
    expect(await readdir(options.directory)).toEqual([]);
  });
  it("deduplicates aliases to canonical participants, acquires one 20-row scope per player, and accounts for every reference", async () => {
    const root = await createTestDirectory();
    const identities = new Map([
      ["Alice Alias", player(1, "Alice")],
      ["Alice", player(1, "Alice")],
      ["Bob", player(2, "Bob")],
      ["Rob", player(3, "Rob")],
    ]);
    const harness = createHarness(root, identities);
    const inventory = buildFixtureInventory("pdc", TEST_DATE, [
      fixture("fixture-1", "Alice Alias", "Bob"),
      fixture("fixture-2", "Alice", "Rob"),
      fixture("fixture-3", "TBD", "Bob"),
      fixture("fixture-4", "Missing", "Alice"),
    ]);
    const readSpy = vi.spyOn(harness.history, "getResolvedMatchesSnapshot");

    const result = await collectFixtureResearch(
      { source: "pdc", date: TEST_DATE, runLabel: "fixture-run" },
      collectionOptions(root, harness, inventory, participantResolver(identities)),
    );

    expect(result.inventory.participants.map((participant) => participant.player.id)).toEqual([1, 2, 3]);
    expect(result.inventory.participants[0]?.aliases).toEqual(["Alice Alias", "Alice"]);
    expect(result.inventory.references).toHaveLength(8);
    expect(result.inventory.references.filter((reference) => reference.status === "unresolved")).toHaveLength(2);
    expect(result.referenceCounts).toEqual({ total: 8, complete: 6, failed: 0, deferred: 0, unresolved: 2, excluded: 0 });
    expect(result.status).toBe("partial");
    expect(result.deliveryAuthorized).toBe(false);
    expect(harness.scraper).toHaveBeenCalledTimes(3);
    expect(harness.scraper.mock.calls.every((call): boolean => call[1] === 20)).toBe(true);
    expect(readSpy).toHaveBeenCalledTimes(3);
    expect(readSpy.mock.calls.map((call) => call[0].id)).toEqual([1, 2, 3]);
    expect(result.collection?.status).toBe("complete");
  });

  it("returns an explicit complete empty inventory without invoking history", async () => {
    const root = await createTestDirectory();
    const identities = new Map<string, PlayerIdentity>();
    const harness = createHarness(root, identities);
    const inventory = buildFixtureInventory("modus", TEST_DATE, []);

    const result = await collectFixtureResearch(
      { source: "modus", date: TEST_DATE, runLabel: "empty-slate" },
      collectionOptions(root, harness, inventory, participantResolver(identities)),
    );

    expect(result.status).toBe("complete");
    expect(result.inventory.participants).toEqual([]);
    expect(result.inventory.references).toEqual([]);
    expect(result.collection).toBeNull();
    expect(result.referenceCounts).toEqual({ total: 0, complete: 0, failed: 0, deferred: 0, unresolved: 0, excluded: 0 });
    expect(harness.scraper).not.toHaveBeenCalled();
  });

  it("prioritizes warm participants while preserving stable order for cold work", async () => {
    const root = await createTestDirectory();
    const identities = new Map([["Alice", player(1, "Alice")], ["Bob", player(2, "Bob")]]);
    const harness = createHarness(root, identities);
    const bob = player(2, "Bob");
    await harness.history.getResolvedMatchesSnapshot(bob, 20);
    const readSpy = vi.spyOn(harness.history, "getResolvedMatchesSnapshot");
    const inventory = buildFixtureInventory("pdc", TEST_DATE, [
      fixture("fixture-1", "Alice", "Bob", "2026-09-30T18:00:00Z"),
    ]);

    const result = await collectFixtureResearch(
      { source: "pdc", date: TEST_DATE, runLabel: "warm-first" },
      collectionOptions(root, harness, inventory, participantResolver(identities)),
    );

    expect(result.plan.items.map((item) => item.player.id)).toEqual([2, 1]);
    expect(readSpy.mock.calls.map((call) => call[0].id)).toEqual([2, 1]);
    expect(harness.scraper).toHaveBeenCalledTimes(2);
    expect(result.collection?.checkpoint.players).toEqual(["Bob", "Alice"]);
  });

  it("resumes v2 work past the observation TTL without reacquiring or restamping evidence, preserving existing v1 files", async () => {
    const root = await createTestDirectory();
    const identities = new Map([["Alice", player(1, "Alice")]]);
    const harness = createHarness(root, identities);
    const runs = path.join(root, "runs");
    const legacy = await collectResearchBatch(
      { version: 1, runLabel: "legacy", players: ["Alice"] },
      { directory: runs, ledger: harness.ledger, reader: harness.history, now: harness.clock },
    );
    const legacyFile = path.join(runs, `${legacy.checkpoint.id}.json`);
    const legacyBytes = await readFile(legacyFile, "utf8");
    // Aliases may recur across fixtures, but the two sides of one fixture must be distinct players.
    const inventory = buildFixtureInventory("pdc", TEST_DATE, [fixture("fixture-1", "Alice", "Bob"), fixture("fixture-2", "Alice Alias", "Bob")]);
    const aliases = new Map([["Alice", player(1, "Alice")], ["Alice Alias", player(1, "Alice")], ["Bob", player(2, "Bob")]]);
    const options = collectionOptions(root, harness, inventory, participantResolver(aliases));
    const first = await collectFixtureResearch({ source: "pdc", date: TEST_DATE, runLabel: "resume-proof" }, options);
    expect(first.status).toBe("complete");
    expect(first.outcomes).toHaveLength(2);
    const originalObservation = await harness.ledger.read(first.outcomes[0]?.evidenceId ?? "");
    harness.advanceClock(120_000);

    const resumed = await collectFixtureResearch({ source: "pdc", date: TEST_DATE, runLabel: "resume-proof" }, options);

    expect(resumed.collection?.resumed).toBe(2);
    expect(resumed.outcomes[0]?.evidenceId).toBe(first.outcomes[0]?.evidenceId);
    expect((await harness.ledger.read(first.outcomes[0]?.evidenceId ?? ""))?.observedAt).toBe(originalObservation?.observedAt);
    expect(harness.scraper).toHaveBeenCalledTimes(2);
    expect(await readFile(legacyFile, "utf8")).toBe(legacyBytes);
  });

  it("rejects a changed inventory under the same label without rewriting the prior manifest", async () => {
    const root = await createTestDirectory();
    const identities = new Map([["Alice", player(1, "Alice")], ["Bob", player(2, "Bob")], ["Cara", player(3, "Cara")]]);
    const harness = createHarness(root, identities);
    let current = buildFixtureInventory("pdc", TEST_DATE, [fixture("fixture-1", "Alice", "Bob")]);
    const options = collectionOptions(root, harness, current, participantResolver(identities));
    const input = { source: "pdc", date: TEST_DATE, runLabel: "immutable-label" };
    await collectFixtureResearch(input, options);
    const file = await manifestPath(options.directory);
    const previous = await readFile(file, "utf8");
    current = buildFixtureInventory("pdc", TEST_DATE, [fixture("fixture-1", "Alice", "Cara")]);
    const changedOptions = { ...options, discover: async (): Promise<ReturnType<typeof buildFixtureInventory>> => current };

    await expect(collectFixtureResearch(input, changedOptions)).rejects.toThrow(/inventory or identity associations changed/u);
    expect(await readFile(file, "utf8")).toBe(previous);
  });

  it("fails closed on a corrupted v2 manifest and leaves the corrupt bytes untouched", async () => {
    const root = await createTestDirectory();
    const identities = new Map([["Alice", player(1, "Alice")], ["Bob", player(2, "Bob")]]);
    const harness = createHarness(root, identities);
    const inventory = buildFixtureInventory("pdc", TEST_DATE, [fixture("fixture-1", "Alice", "Bob")]);
    const options = collectionOptions(root, harness, inventory, participantResolver(identities));
    const input = { source: "pdc", date: TEST_DATE, runLabel: "corrupt-manifest" };
    await collectFixtureResearch(input, options);
    const file = await manifestPath(options.directory);
    const corrupt = withCorruptChecksum(await readLocalJson(file));
    await import("../src/research/local-files.js").then(({ writeLocalJson }): Promise<void> => writeLocalJson(file, corrupt));
    const corruptBytes = await readFile(file, "utf8");

    await expect(collectFixtureResearch(input, options)).rejects.toThrow(/checkpoint inventory or identity associations changed/u);
    expect(await readFile(file, "utf8")).toBe(corruptBytes);
  });

  it("returns explicit deadline outcomes for non-cooperative history work", async () => {
    const root = await createTestDirectory();
    const identities = new Map([["Alice", player(1, "Alice")], ["Bob", player(2, "Bob")]]);
    let readerEntered = (): void => undefined;
    const entered = new Promise<void>((resolve): void => { readerEntered = resolve; });
    const harness = createHarness(root, identities, {
      scrape: async (): Promise<Match[]> => {
        readerEntered();
        return new Promise<Match[]>(() => undefined);
      },
    });
    const inventory = buildFixtureInventory("pdc", TEST_DATE, [fixture("fixture-1", "Alice", "Bob")]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = collectFixtureResearch(
      { source: "pdc", date: TEST_DATE, runLabel: "deadline" },
      collectionOptions(root, harness, inventory, participantResolver(identities), { budgetMs: 1_000 }),
    );
    await entered;
    await vi.advanceTimersByTimeAsync(900);
    const result = await pending;

    expect(result.status).toBe("partial");
    expect(result.referenceCounts).toEqual({ total: 2, complete: 0, failed: 0, deferred: 2, unresolved: 0, excluded: 0 });
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["deferred-deadline", "deferred-deadline"]);
    expect(harness.scraper).toHaveBeenCalledOnce();
  });

  it("propagates caller cancellation during history acquisition without classifying it as a provider failure", async () => {
    const root = await createTestDirectory();
    const identities = new Map([["Alice", player(1, "Alice")], ["Bob", player(2, "Bob")]]);
    let readerEntered = (): void => undefined;
    const entered = new Promise<void>((resolve): void => { readerEntered = resolve; });
    const harness = createHarness(root, identities, {
      scrape: async (): Promise<Match[]> => {
        readerEntered();
        return new Promise<Match[]>(() => undefined);
      },
    });
    const inventory = buildFixtureInventory("pdc", TEST_DATE, [fixture("fixture-1", "Alice", "Bob")]);
    const controller = new AbortController();
    const ownerReason = new Error("operator cancelled fixture research");
    const pending = collectFixtureResearch(
      { source: "pdc", date: TEST_DATE, runLabel: "cancelled" },
      collectionOptions(root, harness, inventory, participantResolver(identities)),
      controller.signal,
    );
    const expectedRejection = expect(pending).rejects.toBe(ownerReason);
    await entered;
    controller.abort(ownerReason);
    await expectedRejection;

    expect(harness.scraper).toHaveBeenCalledOnce();
    expect(harness.history.diagnostics().activeAcquisitions).toBe(0);
  });

  it("reports a provider failure as a sanitized participant outcome and still accounts for its references", async () => {
    const root = await createTestDirectory();
    const identities = new Map([["Alice", player(1, "Alice")], ["Bob", player(2, "Bob")]]);
    const harness = createHarness(root, identities, {
      scrape: async (identity: PlayerIdentity): Promise<Match[]> => {
        if (identity.id === 2) throw new Error("private provider response body");
        return historyRows();
      },
    });
    const inventory = buildFixtureInventory("pdc", TEST_DATE, [fixture("fixture-1", "Alice", "Bob")]);

    const result = await collectFixtureResearch(
      { source: "pdc", date: TEST_DATE, runLabel: "provider-failure" },
      collectionOptions(root, harness, inventory, participantResolver(identities)),
    );

    expect(result.status).toBe("partial");
    expect(result.outcomes.map((outcome) => [outcome.playerId, outcome.status, outcome.failure])).toEqual([
      [1, "complete", null],
      [2, "failed", "SOURCE_UNAVAILABLE"],
    ]);
    expect(result.referenceCounts).toEqual({ total: 2, complete: 1, failed: 1, deferred: 0, unresolved: 0, excluded: 0 });
    expect(JSON.stringify(result)).not.toContain("private provider response body");
  });

  it("does not freeze partial resolution in a durable identity manifest", async () => {
    const root = await createTestDirectory();
    const identities = new Map([["Alice", player(1, "Alice")], ["Bob", player(2, "Bob")]]);
    const harness = createHarness(root, identities);
    const draft = buildFixtureInventory("pdc", TEST_DATE, [fixture("fixture-1", "Alice", "Bob")]);
    let entered: () => void = (): void => undefined;
    const started = new Promise<void>((resolve): void => { entered = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = collectFixtureResearch({ source: "pdc", date: TEST_DATE, runLabel: "resolve-partial" }, {
      ...collectionOptions(root, harness, draft, participantResolver(identities)), budgetMs: 1000,
      resolveParticipant: async (name: string): Promise<PlayerIdentity> => {
        if (name === "Alice") return player(1, "Alice");
        entered(); return new Promise<PlayerIdentity>(() => undefined);
      },
    });
    await started; await vi.advanceTimersByTimeAsync(900);
    const result = await pending;
    expect(result.referenceCounts).toEqual({ total: 2, complete: 0, failed: 0, deferred: 1, unresolved: 1, excluded: 0 });
    expect(harness.scraper).not.toHaveBeenCalled();
    expect(await readdir(path.join(root, "runs"))).not.toContain("fixture-v2");
  });

  it("honors independent caller cancellation even with a supplied unlinked budget", async () => {
    const root = await createTestDirectory();
    const harness = createHarness(root, new Map());
    const controller = new AbortController();
    const budget = createCollectionBudget();
    let entered: () => void = (): void => undefined;
    const started = new Promise<void>((resolve): void => { entered = resolve; });
    const pending = collectFixtureResearch({ source: "pdc", date: TEST_DATE, runLabel: "supplied-budget" }, {
      directory: path.join(root, "runs"), ledger: harness.ledger, reader: harness.history, budget,
      resolveParticipant: async (): Promise<PlayerIdentity> => player(1, "Alice"),
      discover: async (): Promise<never> => { entered(); return new Promise<never>(() => undefined); },
    }, controller.signal);
    const reason = new Error("independent owner stop");
    const failure = expect(pending).rejects.toBe(reason);
    try { await started; controller.abort(reason); await failure; }
    finally { budget.close(); }
    await new Promise<void>((resolve): void => { setImmediate(resolve); });
  });
});
