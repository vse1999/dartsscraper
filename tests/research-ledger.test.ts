import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceSnapshot, type EvidenceSnapshot } from "../src/research/evidence.js";
import { FileEvidenceLedger, MemoryEvidenceLedger } from "../src/research/ledger.js";

const now = (): Date => new Date("2026-01-03T00:00:00.000Z");
function snapshot(average = 90, observedAt = "2026-01-02T00:00:00.000Z"): EvidenceSnapshot {
  return createEvidenceSnapshot({ player: { id: 13, name: "Damon Heta", slug: "damon-heta" }, matches: [
    { date: "2026-01-01", tournament: "Example", round: null, result: "Won", opponent: "Opponent", score: "6 V 2", average },
  ] }, observedAt, "2026-01-01", 20);
}
const directories: string[] = [];
async function directory(): Promise<string> {
  const path = await mkdtemp(join(process.cwd(), ".test-evidence-"));
  directories.push(path);
  return path;
}
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
describe("evidence ledgers", () => {
  it("keeps old evidence replayable while choosing latest eligible observation", async () => {
    const ledger = new MemoryEvidenceLedger({ now });
    const first = snapshot(); const correction = snapshot(91, "2026-01-02T01:00:00.000Z");
    await ledger.write(first); await ledger.write(correction);
    expect(await ledger.read(first.id)).toEqual(first);
    expect(await ledger.latest(13, "2026-01-01", 20)).toEqual(correction);
    expect(await ledger.latest(14, "2026-01-01", 20)).toBeNull();
    expect(await ledger.latest(13, "2026-01-01", 21)).toBeNull();
    expect(await ledger.latest(13, "2026-01-02", 20)).toBeNull();
    const returned = await ledger.read(first.id);
    if (returned !== null) returned.matches[0]!.average = 1;
    expect(await ledger.read(first.id)).toEqual(first);
  });
  it("survives restart without restamping observation times", async () => {
    const path = await directory(); const first = snapshot();
    await new FileEvidenceLedger(path, { now }).write(first);
    const restarted = new FileEvidenceLedger(path, { now });
    expect(await restarted.read(first.id)).toEqual(first);
    expect(await restarted.latest(13, "2026-01-01", 10)).toEqual(first);
  });
  it("atomically deduplicates parallel writes and bounds record/file size", async () => {
    const path = await directory(); const first = snapshot();
    const ledger = new FileEvidenceLedger(path, { now, maxRecords: 1 });
    await Promise.all(Array.from({ length: 10 }, () => ledger.write(first)));
    expect(await readdir(path)).toEqual([`${first.id}.json`]);
    await expect(ledger.write(snapshot(91))).rejects.toThrow("full");
    await expect(new FileEvidenceLedger(await directory(), { now, maxBytes: 1 }).write(first)).rejects.toThrow("byte limit");
    const memory = new MemoryEvidenceLedger({ now, maxRecords: 1 });
    await memory.write(first); await expect(memory.write(snapshot(91))).rejects.toThrow("full");
  });
  it("rejects path injection, future records, invalid keys and corrupt content", async () => {
    const path = await directory(); const ledger = new FileEvidenceLedger(path, { now }); const first = snapshot();
    await expect(ledger.read("../private")).rejects.toThrow();
    await expect(ledger.latest(13, "2026-02-30", 1)).rejects.toThrow("Invalid");
    await expect(ledger.write(snapshot(90, "2026-01-04T00:00:00.000Z"))).rejects.toThrow("future");
    await ledger.write(first);
    await writeFile(join(path, `${first.id}.json`), JSON.stringify({ ...first, acquiredCount: 0 }));
    await expect(ledger.read(first.id)).rejects.toThrow("corrupt");
    await expect(ledger.latest(13, "2026-01-01", 1)).rejects.toThrow("corrupt");
    await writeFile(join(path, "unexpected.json"), "{}");
    await expect(ledger.latest(13, "2026-01-01", 1)).rejects.toThrow("unexpected");
  });
  it("does not steal an active or stale writer lock", async () => {
    const path = await directory();
    await mkdir(join(path, ".write-lock"));
    await expect(new FileEvidenceLedger(path, { now }).write(snapshot())).rejects.toThrow("locked");
    expect(await readdir(path)).toEqual([".write-lock"]);
  });
});
