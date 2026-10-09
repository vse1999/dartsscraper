import { describe, expect, it, vi } from "vitest";
import type { Match } from "../src/schemas/match.js";
import type { PlayerIdentity } from "../src/schemas/player.js";
import { ResearchHistoryService } from "../src/research/history-service.js";
import { MemoryEvidenceLedger, type EvidenceLedger } from "../src/research/ledger.js";
import { createEvidenceSnapshot } from "../src/research/evidence.js";

const player: PlayerIdentity = { id: 1, name: "Example Player", slug: "example-player" };
const now = (): Date => new Date("2026-09-30T12:00:00Z");
function history(count: number = 20): Match[] {
  return Array.from({ length: count }, (_, index): Match => ({ date: "2026-09-20", tournament: "Example", round: null,
    result: "Won", opponent: `Opponent ${index}`, score: "6 V 2", average: 90 + index % 4 }));
}
function setup(ledger: EvidenceLedger = new MemoryEvidenceLedger({ now }), clock: () => Date = now): {
  readonly service: ResearchHistoryService;
  readonly scrape: ReturnType<typeof vi.fn<(player: PlayerIdentity, limit?: number, dateTo?: string, signal?: AbortSignal) => Promise<Match[]>>>;
} {
  const scrape = vi.fn(async (_player: PlayerIdentity, _limit?: number, _dateTo?: string, _signal?: AbortSignal): Promise<Match[]> => history());
  const service = new ResearchHistoryService({ resolver: { resolvePlayer: async (): Promise<PlayerIdentity> => player },
    scraper: { getPlayerMatches: scrape }, ledger, now: clock });
  return { service, scrape };
}

describe("canonical research history", () => {
  it("supports a bounded lightweight ten-row acquisition without fabricating previous-ten history", async () => {
    const scrape = vi.fn(async (): Promise<Match[]> => history(10));
    const service = new ResearchHistoryService({ resolver: { resolvePlayer: async (): Promise<PlayerIdentity> => player }, scraper: { getPlayerMatches: scrape }, ledger: new MemoryEvidenceLedger({ now }), now, minimumAcquisitionCount: 10 });
    const result = await service.getLastMatchesSnapshot(player.name, 10);
    expect(scrape).toHaveBeenCalledWith(player, 10, "2026-10-01", expect.any(AbortSignal));
    expect(result.value.matches).toHaveLength(10);
    expect(result.research.previous10.matchCount).toBe(0);
    expect(service.peekFreshSnapshot(player, 10)?.evidence.id).toBe(result.evidence.id);
    expect(() => new ResearchHistoryService({ resolver: { resolvePlayer: async (): Promise<PlayerIdentity> => player }, scraper: { getPlayerMatches: scrape }, ledger: new MemoryEvidenceLedger(), minimumAcquisitionCount: 1001 })).toThrow();
  });
  it("rejects conflicting identities before joining an in-flight acquisition", async () => {
    let release: (matches: Match[]) => void = (): void => undefined;
    const pending = new Promise<Match[]>((resolve): void => { release = resolve; });
    const { service, scrape } = setup();
    scrape.mockImplementation(async (): Promise<Match[]> => pending);
    const first = service.getResolvedMatchesSnapshot(player, 20);
    await vi.waitFor(() => expect(scrape).toHaveBeenCalledOnce());
    const conflicting = service.getResolvedMatchesSnapshot({ ...player, slug: "conflicting-profile" }, 20);
    const rejection = expect(conflicting).rejects.toThrow("conflicting canonical identity");
    release(history());
    await rejection;
    expect((await first).value.player).toEqual(player);
    expect(scrape).toHaveBeenCalledOnce();
  });
  it("inspects canonical warm history without resolving, reading storage or fetching", async () => {
    const { service, scrape } = setup();
    expect(service.peekFreshSnapshot(player)).toBeNull();
    await service.getResolvedMatchesSnapshot(player, 20);
    const peek = service.peekFreshSnapshot(player, 10);
    expect(peek?.value.matches).toHaveLength(10);
    expect(service.peekFreshSnapshot({ ...player, name: "Different identity" })).toBeNull();
    expect(scrape).toHaveBeenCalledOnce();
    if (peek !== null) peek.value.matches[0]!.average = 1;
    expect(service.peekFreshSnapshot(player)?.value.matches[0]?.average).toBe(90);
  });
  it("uses one full scope for 10 then 20 and aliases, retaining original evidence time", async () => {
    const { service, scrape } = setup();
    const first = await service.getLastMatchesSnapshot("Example", 10, new AbortController().signal);
    const second = await service.getLastMatchesSnapshot("Example Player", 20);
    expect(scrape).toHaveBeenCalledOnce();
    expect(scrape.mock.calls[0]?.[1]).toBe(20);
    expect(first.value.matches).toHaveLength(10);
    expect(second.value.matches).toHaveLength(20);
    expect(first.research.previous10.matchCount).toBe(10);
    expect(second.evidence.id).toBe(first.evidence.id);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.evidence.sourceUpdatedAt).toBeNull();
    expect(second.evidence.quality?.ordering).toBe("date-only-ambiguous");
  });

  it("reuses 20 for 10 and isolates caller mutation", async () => {
    const { service, scrape } = setup();
    const first = await service.getLastMatches("Example", 20);
    first.matches[0]!.average = 1;
    const next = await service.getLastMatches("Example", 10);
    expect(next.matches[0]?.average).toBe(90);
    expect(scrape).toHaveBeenCalledOnce();
  });

  it("reuses restart ledger observations without restamping them", async () => {
    const ledger = new MemoryEvidenceLedger({ now });
    const original = await setup(ledger).service.getLastMatchesSnapshot("Example", 10);
    const restarted = setup(ledger);
    const read = await restarted.service.getLastMatchesSnapshot("Example", 20);
    expect(read.evidence.id).toBe(original.evidence.id);
    expect(read.fetchedAt).toBe(original.fetchedAt);
    expect(restarted.scrape).not.toHaveBeenCalled();
  });

  it("refreshes expired snapshots and separates next-day query scopes", async () => {
    let time = now().getTime();
    const clock = (): Date => new Date(time);
    const ledger = new MemoryEvidenceLedger({ now: clock });
    const { service, scrape } = setup(ledger, clock);
    await service.getLastMatches("Example", 10);
    time += 60_001;
    await service.getLastMatches("Example", 10);
    time = Date.parse("2026-09-30T22:30:00Z");
    await service.getLastMatches("Example", 10);
    expect(scrape).toHaveBeenCalledTimes(3);
    expect(scrape.mock.calls[2]?.[2]).toBe("2026-10-02");
  });

  it("shares concurrent canonical requests without poisoning another subscriber", async () => {
    let release: (matches: Match[]) => void = (): void => undefined;
    const pending = new Promise<Match[]>((resolve): void => { release = resolve; });
    const { service, scrape } = setup();
    scrape.mockImplementation(async (): Promise<Match[]> => pending);
    const controller = new AbortController();
    const cancelled = service.getLastMatches("Alias", 10, controller.signal);
    const surviving = service.getLastMatches("Example", 20);
    await vi.waitFor(() => expect(scrape).toHaveBeenCalledOnce());
    const upstream = scrape.mock.calls[0]?.[3];
    controller.abort(new Error("caller deadline"));
    await expect(cancelled).rejects.toThrow("caller deadline");
    expect(upstream?.aborted).toBe(false);
    release(history());
    expect((await surviving).matches).toHaveLength(20);
    expect((await service.getLastMatches("Example", 10)).matches).toHaveLength(10);
    expect(scrape).toHaveBeenCalledOnce();
  });

  it("aborts upstream when all subscribers leave, even with non-cooperative acquisition", async () => {
    const { service, scrape } = setup();
    scrape.mockImplementation(async (): Promise<Match[]> => new Promise((): void => undefined));
    const controller = new AbortController();
    const pending = service.getLastMatches("Example", 10, controller.signal);
    await vi.waitFor(() => expect(scrape).toHaveBeenCalledOnce());
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    expect(scrape.mock.calls[0]?.[3]?.aborted).toBe(true);
    expect(service.diagnostics().activeAcquisitions).toBe(0);
  });

  it("does not start source work for already cancelled requests", async () => {
    const { service, scrape } = setup();
    const controller = new AbortController(); controller.abort();
    await expect(service.getLastMatches("Example", 10, controller.signal)).rejects.toThrow();
    expect(scrape).not.toHaveBeenCalled();
  });

  it("does not return future/live data even when persistence is optional", async () => {
    const { service, scrape } = setup();
    scrape.mockResolvedValue([{ ...history(1)[0]!, date: "2026-10-01" }]);
    await expect(service.getLastMatches("Example", 10)).rejects.toThrow("future completed");
    scrape.mockResolvedValue([{ ...history(1)[0]!, result: "live" }]);
    await expect(service.getLastMatches("Example", 10)).rejects.toThrow("completed");
  });

  it("keeps valid source data with an explicit non-durable persistence warning", async () => {
    const failure = vi.fn();
    const ledger: EvidenceLedger = { latest: async () => { throw new Error("corrupt"); }, read: async () => null, write: async () => { throw new Error("permission"); } };
    const service = new ResearchHistoryService({ resolver: { resolvePlayer: async (): Promise<PlayerIdentity> => player },
      scraper: { getPlayerMatches: async (): Promise<Match[]> => history() }, ledger, now, onPersistenceError: failure });
    const result = await service.getLastMatchesSnapshot("Example", 10);
    expect(result.evidence.persistence).toBe("failed");
    expect(result.value.matches).toHaveLength(10);
    expect(failure).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a different player's injected ledger result", async () => {
    const other = createEvidenceSnapshot({ player: { ...player, id: 2 }, matches: history() }, now().toISOString(), "2026-10-01", 20);
    const ledger: EvidenceLedger = { latest: async () => other, read: async () => null, write: async () => undefined };
    const { service, scrape } = setup(ledger);
    expect((await service.getLastMatches("Example", 10)).player.id).toBe(1);
    expect(scrape).toHaveBeenCalledOnce();
  });

  it("keeps larger request scope and validates input", async () => {
    const { service, scrape } = setup();
    await service.getLastMatches("Example", 30);
    expect(scrape.mock.calls[0]?.[1]).toBe(30);
    await expect(service.getLastMatches("Example", 1001)).rejects.toThrow("limit");
  });

  it("discloses inconsistent unique-date ordering rather than certifying chronology", async () => {
    const { service, scrape } = setup();
    scrape.mockResolvedValue([{ ...history(1)[0]!, date: "2026-09-01" }, { ...history(1)[0]!, date: "2026-09-02" }]);
    const read = await service.getLastMatchesSnapshot("Example", 10);
    expect(read.evidence.quality?.ordering).toBe("source-order-inconsistent");
    expect(read.research.warnings.join(" ")).toContain("inconsistent");
  });
});
