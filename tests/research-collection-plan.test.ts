import { describe, expect, it, vi, afterEach } from "vitest";
import { buildCollectionPlan, type CollectionParticipant } from "../src/research/collection-plan.js";
import { createCollectionBudget, bindCollectionCancellation } from "../src/research/collection-budget.js";

function participant(id: number, startTime: string | null = null): CollectionParticipant {
  return { player: { id, name: `Player ${id}`, slug: `player-${id}` }, inventoryIndex: id, startTime };
}
afterEach((): void => { vi.useRealTimers(); });
describe("bounded pure research planning", () => {
  it("closes both signals and timers so consumers cannot keep using a finished budget", () => {
    vi.useFakeTimers();
    const budget = createCollectionBudget();
    budget.close();
    expect(budget.workSignal.aborted).toBe(true);
    expect(budget.totalSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => createCollectionBudget({ budgetMs: 1 })).toThrow("between 2 and 300000");
  });
  it("places warm work first and cold work by known time then original inventory", () => {
    const inspect = vi.fn((player: CollectionParticipant["player"]): boolean => player.id === 3);
    const plan = buildCollectionPlan([participant(1), participant(2, "2026-10-06T17:00:00Z"), participant(3)], inspect);
    expect(plan.items.map((item) => item.player.id)).toEqual([3, 2, 1]);
    expect(plan.modeledStatisticViews).toBe(6);
    expect(plan.modelIsAdmissionGuarantee).toBe(false);
    expect(inspect).toHaveBeenCalledTimes(3);
  });
  it("rejects duplicates, unsafe counts and ambiguous start times", () => {
    expect(() => buildCollectionPlan([participant(1), participant(1)], () => false)).toThrow();
    expect(() => buildCollectionPlan([participant(1, "2026-10-06T17:00:00")], () => false)).toThrow();
    expect(() => buildCollectionPlan([], () => false, 1001)).toThrow();
  });
  it("has one work deadline and a distinct final reserve", async () => {
    vi.useFakeTimers();
    const budget = createCollectionBudget({ budgetMs: 100, finalReserveMs: 10 });
    await vi.advanceTimersByTimeAsync(90);
    expect(budget.workSignal.aborted).toBe(true);
    expect(budget.totalSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(budget.totalSignal.aborted).toBe(true);
    budget.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("propagates caller cancellation through both phases and cleans listeners/timers", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const budget = createCollectionBudget({ signal: controller.signal });
    const reason = new Error("owner stopped"); controller.abort(reason);
    expect(budget.workSignal.reason).toBe(reason);
    expect(budget.totalSignal.reason).toBe(reason);
    budget.close(); expect(vi.getTimerCount()).toBe(0);
  });

  it("binds a separate owner signal without resetting a supplied deadline", () => {
    vi.useFakeTimers();
    const original = createCollectionBudget({ budgetMs: 1000 });
    const controller = new AbortController();
    const bound = bindCollectionCancellation(original, controller.signal);
    const reason = new Error("independent owner cancelled"); controller.abort(reason);
    expect(bound.workSignal.reason).toBe(reason);
    expect(bound.totalSignal.reason).toBe(reason);
    expect(original.totalSignal.aborted).toBe(false);
    original.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
