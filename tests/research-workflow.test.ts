import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvidenceSnapshot } from "../src/research/evidence.js";
import { FileEvidenceLedger } from "../src/research/ledger.js";
import { ResearchHistoryService } from "../src/research/history-service.js";
import { collectResearchBatch } from "../src/research/collection-runner.js";
import { recordResearchFeedback } from "../src/research/feedback.js";
import { createResearchStorage } from "../src/research/config.js";
import { LocalRequestGate } from "../src/research/request-gate.js";
import { readLocalJson, writeLocalJson } from "../src/research/local-files.js";
import type { Match } from "../src/schemas/match.js";
import type { PlayerIdentity } from "../src/schemas/player.js";

const directories: string[] = [];
const now = (): Date => new Date("2026-09-30T12:00:00Z");
async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(process.cwd(), ".test-research-workflow-"));
  directories.push(value); return value;
}
afterEach(async (): Promise<void> => { for (const value of directories.splice(0)) await rm(value, { recursive: true, force: true }); });
function fixture(): Match { return { date: "2026-09-29", tournament: "Example", round: null, result: "Won", opponent: "Opponent", score: "6 V 2", average: 90 }; }

describe("local research workflow", () => {
  it("checkpoints, resumes and preserves the exact evidence version", async () => {
    const root = await directory();
    const ledger = new FileEvidenceLedger(path.join(root, "evidence"), { now });
    const source = vi.fn(async (): Promise<Match[]> => [fixture()]);
    const reader = new ResearchHistoryService({ ledger, persistence: "local", now,
      resolver: { resolvePlayer: async (name: string): Promise<PlayerIdentity> => ({ id: name === "Alice" ? 1 : 2, name, slug: name.toLowerCase() }) },
      scraper: { getPlayerMatches: source } });
    const input = { version: 1, runLabel: "session-1", players: ["Alice", "Bob", "Alice"] };
    const options = { directory: path.join(root, "runs"), ledger, reader, now };
    const first = await collectResearchBatch(input, options);
    const resumed = await collectResearchBatch(input, options);
    expect(first.status).toBe("complete");
    expect(first.deliveryAuthorized).toBe(false);
    expect(resumed.resumed).toBe(2);
    expect(resumed.checkpoint).toEqual(first.checkpoint);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("records feedback only against existing evidence with bounded enumerated reasons", async () => {
    const root = await directory(); const ledger = new FileEvidenceLedger(path.join(root, "evidence"), { now });
    const evidence = createEvidenceSnapshot({ player: { id: 1, name: "Alice", slug: "alice" }, matches: [fixture()] }, now().toISOString(), "2026-10-01", 20);
    await ledger.write(evidence);
    const feedback = await recordResearchFeedback({ evidenceId: evidence.id, label: "useful", reason: "time-saved" }, ledger, path.join(root, "feedback"), now);
    expect(feedback.evidenceId).toBe(evidence.id);
    await expect(recordResearchFeedback({ evidenceId: "0".repeat(64), label: "useful", reason: "time-saved" }, ledger, root)).rejects.toThrow("does not exist");
    await expect(recordResearchFeedback({ evidenceId: evidence.id, label: "useful", reason: "secret token" }, ledger, root)).rejects.toThrow();
  });

  it("preserves complete rows and records failures without abandoning the inventory", async () => {
    const root = await directory(); const ledger = new FileEvidenceLedger(path.join(root, "evidence"), { now });
    const reader = new ResearchHistoryService({ ledger, persistence: "local", now,
      resolver: { resolvePlayer: async (name: string): Promise<PlayerIdentity> => ({ id: name === "Alice" ? 1 : 2, name, slug: name.toLowerCase() }) },
      scraper: { getPlayerMatches: async (player: PlayerIdentity): Promise<Match[]> => { if (player.id === 2) throw new Error("provider failure"); return [fixture()]; } } });
    const result = await collectResearchBatch({ version: 1, runLabel: "partial", players: ["Alice", "Bob"] }, { directory: root, ledger, reader, now });
    expect(result.status).toBe("partial");
    expect(result.pending).toBe(1);
    expect(result.checkpoint.rows.map((row) => row.status)).toEqual(["complete", "failed"]);
    expect(JSON.stringify(result)).not.toContain("provider failure");
  });

  it("rejects overlapping collection rather than stealing a lock", async () => {
    const root = await directory(); const ledger = new FileEvidenceLedger(path.join(root, "evidence"), { now });
    await writeFile(path.join(root, "collection.lock"), "existing owner");
    const reader = { getLastMatchesSnapshot: vi.fn() };
    await expect(collectResearchBatch({ version: 1, runLabel: "overlap", players: ["Alice"] }, { directory: root, ledger, reader, now })).rejects.toThrow("locked");
    expect(reader.getLastMatchesSnapshot).not.toHaveBeenCalled();
  });

  it("bounds input and collection budgets", async () => {
    const root = await directory(); const ledger = new FileEvidenceLedger(path.join(root, "evidence"), { now });
    const reader = { getLastMatchesSnapshot: vi.fn() };
    await expect(collectResearchBatch({ version: 1, runLabel: "../bad", players: ["Alice"] }, { directory: root, ledger, reader, now })).rejects.toThrow();
    await expect(collectResearchBatch({ version: 1, runLabel: "valid", players: ["Alice"] }, { directory: root, ledger, reader, now, budgetMs: 300_001 })).rejects.toThrow("budget");
  });

  it("bounds non-cooperative history work at a deadline", async () => {
    const root = await directory(); const ledger = new FileEvidenceLedger(path.join(root, "evidence"), { now });
    const reader = { getLastMatchesSnapshot: vi.fn(async () => new Promise<never>(() => undefined)) };
    const result = await collectResearchBatch({ version: 1, runLabel: "deadline", players: ["Alice", "Bob"] }, { directory: root, ledger, reader, now, budgetMs: 5 });
    expect(result.status).toBe("partial");
    expect(result.pending).toBe(2);
    expect(reader.getLastMatchesSnapshot).toHaveBeenCalledOnce();
    expect(result.checkpoint.rows[0]?.failure).toBe("DEADLINE");
  });

  it("defaults to memory and rejects false local-durability claims on serverless", () => {
    expect(createResearchStorage({}).persistence).toBe("memory");
    expect(() => createResearchStorage({ RESEARCH_LOCAL_LEDGER_ENABLED: "yes" })).toThrow("true or false");
    expect(() => createResearchStorage({ RESEARCH_LOCAL_LEDGER_ENABLED: "true", VERCEL: "1" })).toThrow("serverless");
  });

  it("reserves Reader allowance once and makes cancelled follow-up wait start no fetch", async () => {
    const root = await directory(); const gate = new LocalRequestGate(root);
    await gate.acquire();
    const controller = new AbortController();
    const pending = new LocalRequestGate(root).acquire(controller.signal);
    controller.abort(new Error("cancel pacing"));
    await expect(pending).rejects.toThrow("cancel pacing");
  });

  it("fails closed on corrupt request-reservation state", async () => {
    const root = await directory(); await writeFile(path.join(root, "reader-state.json"), "not JSON");
    await expect(new LocalRequestGate(root).acquire()).rejects.toThrow();
  });

  it("rejects altered checkpoint evidence associations before skipping work", async () => {
    const root = await directory(); const ledger = new FileEvidenceLedger(path.join(root, "evidence"), { now });
    const reader = new ResearchHistoryService({ ledger, persistence: "local", now,
      resolver: { resolvePlayer: async (name: string): Promise<PlayerIdentity> => ({ id: name === "Alice" ? 1 : 2, name, slug: name.toLowerCase() }) },
      scraper: { getPlayerMatches: async (): Promise<Match[]> => [fixture()] } });
    const input = { version: 1, runLabel: "integrity", players: ["Alice", "Bob"] };
    const options = { directory: path.join(root, "runs"), ledger, reader, now };
    const first = await collectResearchBatch(input, options);
    const rows = first.checkpoint.rows.map((row) => ({ ...row, evidenceId: first.checkpoint.rows[1]?.evidenceId }));
    await writeLocalJson(path.join(options.directory, `${first.checkpoint.id}.json`), { ...first.checkpoint, rows });
    await expect(collectResearchBatch(input, options)).rejects.toThrow("identity");
  });

  it("rejects oversized local input without reading it into an unbounded buffer", async () => {
    const root = await directory(); const file = path.join(root, "large.json");
    await writeFile(file, "x".repeat(2_000));
    await expect(readLocalJson(file, 100)).rejects.toThrow("byte limit");
  });
});
