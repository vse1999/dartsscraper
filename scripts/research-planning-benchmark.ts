import path from "node:path";
import { fileURLToPath } from "node:url";

export const RESEARCH_BENCHMARK_ASSUMPTIONS = {
  deadlineMs: 220_000,
  viewCountPerColdAcquisition: 3,
  requestPaceMs: 3_200,
  fixedLatencyOverheadMs: 5_000,
  boundedConcurrency: 4,
} as const;

export type ResearchSlateKind = "cold" | "warm" | "mixed";

export interface SimulatedViewCall {
  readonly participantIndex: number;
  readonly viewIndex: number;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
}

export interface StrategyMeasurement {
  readonly maxConcurrentAcquisitions: number;
  readonly mockViewCalls: number;
  readonly completedAcquisitions: number;
  readonly incompleteAcquisitions: number;
  readonly completedParticipants: number;
  readonly elapsedMs: number;
  readonly calls: readonly SimulatedViewCall[];
}

export interface PlanningBenchmarkResult {
  readonly slate: ResearchSlateKind;
  readonly participants: number;
  readonly deadlineMs: number;
  readonly serial: StrategyMeasurement;
  readonly boundedFour: StrategyMeasurement;
  readonly serialGatePassed: boolean;
  readonly recommendation: "serial-no-regression" | "retain-four-concurrency";
}

interface WorkItem {
  readonly participantIndex: number;
  readonly warm: boolean;
  nextViewIndex: number;
  requestReadyAtMs: number;
  parallelViewCompletionAtMs: number[];
  completedAtMs: number | null;
}

interface CandidateRequest {
  readonly item: WorkItem;
  readonly startedAtMs: number;
}

/**
 * Runs a deterministic, offline discrete-event simulation through a mock view
 * transport. Each row in `calls` is one invoked mock request, not an estimated
 * `participants * views` extrapolation.
 */
export function simulateResearchScenario(
  participantCount: number,
  slate: ResearchSlateKind,
  maxConcurrency: number,
): StrategyMeasurement {
  if (!Number.isSafeInteger(participantCount) || participantCount < 1 || participantCount > 100) {
    throw new RangeError("Participant count must be between 1 and 100.");
  }
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4) {
    throw new RangeError("Mock acquisition concurrency must be between 1 and 4.");
  }

  const items: WorkItem[] = Array.from({ length: participantCount }, (_unused: unknown, participantIndex: number): WorkItem => ({
    participantIndex,
    warm: slate === "warm" || (slate === "mixed" && participantIndex % 2 === 0),
    nextViewIndex: 0,
    requestReadyAtMs: 0,
    parallelViewCompletionAtMs: [],
    completedAtMs: null,
  }));
  const coldPending = items.filter((item: WorkItem): boolean => !item.warm);
  const active: WorkItem[] = [];
  const calls: SimulatedViewCall[] = [];
  let currentTimeMs = 0;
  let nextRequestAtMs = 0;
  let maxConcurrentAcquisitions = 0;

  while (true) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const item = active[index];
      if (item !== undefined && item.completedAtMs !== null && item.completedAtMs <= currentTimeMs) {
        active.splice(index, 1);
      }
    }
    if (currentTimeMs < RESEARCH_BENCHMARK_ASSUMPTIONS.deadlineMs) {
      while (active.length < maxConcurrency && coldPending.length > 0) {
        const nextItem = coldPending.shift();
        if (nextItem !== undefined) active.push(nextItem);
      }
    }
    maxConcurrentAcquisitions = Math.max(maxConcurrentAcquisitions, active.length);

    const candidate = nextRequestCandidate(active, currentTimeMs, nextRequestAtMs);
    const nextCompletion = active
      .map((item: WorkItem): number | null => item.completedAtMs)
      .filter((value: number | null): value is number => value !== null && value > currentTimeMs)
      .sort((first: number, second: number): number => first - second)[0];

    if (candidate !== null && candidate.startedAtMs < RESEARCH_BENCHMARK_ASSUMPTIONS.deadlineMs
      && (nextCompletion === undefined || candidate.startedAtMs <= nextCompletion)) {
      currentTimeMs = candidate.startedAtMs;
      const viewCompletionAtMs = invokeMockView(calls, candidate.item, currentTimeMs);
      nextRequestAtMs = currentTimeMs + RESEARCH_BENCHMARK_ASSUMPTIONS.requestPaceMs;
      if (candidate.item.nextViewIndex === 0) {
        // The average request is awaited before the two enrichment requests begin.
        candidate.item.requestReadyAtMs = viewCompletionAtMs;
      } else {
        // OneEighties and checkout enrichment run in parallel after the average.
        candidate.item.parallelViewCompletionAtMs.push(viewCompletionAtMs);
      }
      candidate.item.nextViewIndex += 1;
      if (candidate.item.nextViewIndex === RESEARCH_BENCHMARK_ASSUMPTIONS.viewCountPerColdAcquisition) {
        candidate.item.completedAtMs = Math.max(...candidate.item.parallelViewCompletionAtMs);
      }
      continue;
    }

    if (nextCompletion !== undefined && nextCompletion <= RESEARCH_BENCHMARK_ASSUMPTIONS.deadlineMs) {
      currentTimeMs = nextCompletion;
      continue;
    }
    break;
  }

  const completedAcquisitions = items.filter((item: WorkItem): boolean => !item.warm
    && item.completedAtMs !== null && item.completedAtMs <= RESEARCH_BENCHMARK_ASSUMPTIONS.deadlineMs).length;
  const warmParticipants = items.filter((item: WorkItem): boolean => item.warm).length;
  const coldParticipants = participantCount - warmParticipants;
  const elapsedMs = calls.reduce((latest: number, call: SimulatedViewCall): number => Math.max(latest, call.completedAtMs), 0);

  return {
    maxConcurrentAcquisitions,
    mockViewCalls: calls.length,
    completedAcquisitions,
    incompleteAcquisitions: coldParticipants - completedAcquisitions,
    completedParticipants: warmParticipants + completedAcquisitions,
    elapsedMs: Math.min(elapsedMs, RESEARCH_BENCHMARK_ASSUMPTIONS.deadlineMs),
    calls,
  };
}

export function runPlanningBenchmark(): PlanningBenchmarkResult[] {
  const results: PlanningBenchmarkResult[] = [];
  for (const participants of [4, 16, 32]) {
    for (const slate of ["cold", "warm", "mixed"] as const) {
      const serial = simulateResearchScenario(participants, slate, 1);
      const boundedFour = simulateResearchScenario(participants, slate, RESEARCH_BENCHMARK_ASSUMPTIONS.boundedConcurrency);
      const serialGatePassed = serial.completedParticipants >= boundedFour.completedParticipants;
      results.push({
        slate,
        participants,
        deadlineMs: RESEARCH_BENCHMARK_ASSUMPTIONS.deadlineMs,
        serial,
        boundedFour,
        serialGatePassed,
        recommendation: serialGatePassed ? "serial-no-regression" : "retain-four-concurrency",
      });
    }
  }
  return results;
}

function nextRequestCandidate(items: readonly WorkItem[], nowMs: number, nextRequestAtMs: number): CandidateRequest | null {
  let candidate: CandidateRequest | null = null;
  for (const item of items) {
    if (item.completedAtMs !== null || item.nextViewIndex >= RESEARCH_BENCHMARK_ASSUMPTIONS.viewCountPerColdAcquisition) continue;
    const startedAtMs = Math.max(nowMs, item.requestReadyAtMs, nextRequestAtMs);
    if (candidate === null || startedAtMs < candidate.startedAtMs
      || (startedAtMs === candidate.startedAtMs && item.participantIndex < candidate.item.participantIndex)) {
      candidate = { item, startedAtMs };
    }
  }
  return candidate;
}

function invokeMockView(calls: SimulatedViewCall[], item: WorkItem, startedAtMs: number): number {
  const completedAtMs = startedAtMs + RESEARCH_BENCHMARK_ASSUMPTIONS.fixedLatencyOverheadMs;
  calls.push({
    participantIndex: item.participantIndex,
    viewIndex: item.nextViewIndex,
    startedAtMs,
    completedAtMs,
  });
  return completedAtMs;
}

async function main(): Promise<void> {
  const results = runPlanningBenchmark();
  const findings = results.filter((result: PlanningBenchmarkResult): boolean => !result.serialGatePassed);
  process.stdout.write(`${JSON.stringify({
    synthetic: true,
    networkRequests: 0,
    telegramMessages: 0,
    mockTransportCalls: results.reduce((sum: number, result: PlanningBenchmarkResult): number => sum + result.serial.mockViewCalls + result.boundedFour.mockViewCalls, 0),
    assumptions: RESEARCH_BENCHMARK_ASSUMPTIONS,
    conclusion: findings.length === 0
      ? "Serial policy had no participant-yield regression in these deterministic cases; this is not evidence to change production concurrency."
      : "Serial cold work reduced complete participants in at least one deadline case; retain the existing bounded four-way concurrency and do not ship serial admission.",
    results: results.map(({ serial, boundedFour, ...result }: PlanningBenchmarkResult) => ({
      ...result,
      serial: { ...serial, calls: serial.calls.length },
      boundedFour: { ...boundedFour, calls: boundedFour.calls.length },
    })),
  }, null, 2)}\n`);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(entry).toLowerCase();
}

if (isMainModule()) {
  void main().catch((_error: unknown): void => {
    process.stderr.write("Synthetic research planning benchmark failed; no provider requests or messages were sent.\n");
    process.exitCode = 1;
  });
}
