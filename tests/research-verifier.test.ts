import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathWithin, validateVerifierArguments, verificationCommands } from "../scripts/verify-research.js";
import { RESEARCH_BENCHMARK_ASSUMPTIONS, runPlanningBenchmark, simulateResearchScenario } from "../scripts/research-planning-benchmark.js";

describe("offline research verification commands", () => {
  it("rejects all unrecognized arguments", () => {
    expect(validateVerifierArguments([])).toBe(true);
    expect(validateVerifierArguments(["--skip-tests"])).toBe(false);
  });

  it("runs build, bounded full tests, reuse benchmark, then planning benchmark without audit recursion", () => {
    const commands = verificationCommands("C:/Node/npm-cli.js");
    expect(commands.map((command) => command.label)).toEqual([
      "TypeScript build",
      "Full test suite (max 2 workers)",
      "Research reuse benchmark",
      "Deadline-aware planning benchmark",
    ]);
    expect(commands[1]?.args).toEqual([
      "C:/Node/npm-cli.js", "run", "test", "--", "--maxWorkers=2", "--minWorkers=1",
    ]);
    expect(commands.some((command) => command.args.includes("audit:prod"))).toBe(false);
  });

  it("recognizes only strict descendants for owned temp cleanup", () => {
    const workspace = path.resolve("workspace");
    expect(isPathWithin(workspace, path.join(workspace, ".tmp", "verify-research-x"))).toBe(true);
    expect(isPathWithin(workspace, workspace)).toBe(false);
    expect(isPathWithin(workspace, path.resolve(workspace, "..", "outside"))).toBe(false);
  });
});

describe("deterministic research planning simulation", () => {
  it("models the declared deadline, per-player views, pacing, and synthetic latency", () => {
    expect(RESEARCH_BENCHMARK_ASSUMPTIONS).toEqual({
      deadlineMs: 220_000,
      viewCountPerColdAcquisition: 3,
      requestPaceMs: 3_200,
      fixedLatencyOverheadMs: 5_000,
      boundedConcurrency: 4,
    });
  });

  it("performs zero mock transport calls for warm reuse and three for each cold completion", () => {
    const warm = simulateResearchScenario(16, "warm", 4);
    expect(warm.completedParticipants).toBe(16);
    expect(warm.mockViewCalls).toBe(0);
    expect(warm.completedAcquisitions).toBe(0);

    const mixed = simulateResearchScenario(16, "mixed", 4);
    expect(mixed.completedParticipants).toBe(16);
    expect(mixed.mockViewCalls).toBe(24);
    expect(mixed.completedAcquisitions).toBe(8);
  });

  it("counts actual mock calls, honors global pacing and deadline, and exposes serial regressions", () => {
    const results = runPlanningBenchmark();
    expect(results).toHaveLength(9);
    for (const result of results) {
      for (const measurement of [result.serial, result.boundedFour]) {
        expect(measurement.calls).toHaveLength(measurement.mockViewCalls);
        expect(measurement.calls.every((call) => call.startedAtMs < result.deadlineMs)).toBe(true);
        expect(measurement.maxConcurrentAcquisitions).toBeLessThanOrEqual(measurement === result.serial ? 1 : 4);
        for (let index = 1; index < measurement.calls.length; index += 1) {
          const current = measurement.calls[index];
          const previous = measurement.calls[index - 1];
          expect(current?.startedAtMs).toBeGreaterThanOrEqual((previous?.startedAtMs ?? 0) + RESEARCH_BENCHMARK_ASSUMPTIONS.requestPaceMs);
        }
      }
    }

    const cold32 = results.find((result) => result.slate === "cold" && result.participants === 32);
    expect(cold32?.serialGatePassed).toBe(false);
    expect(cold32?.recommendation).toBe("retain-four-concurrency");
    expect(cold32?.boundedFour.completedParticipants).toBeGreaterThan(cold32?.serial.completedParticipants ?? 0);
  });

  it("rejects unbounded direct simulation inputs", () => {
    expect(() => simulateResearchScenario(0, "cold", 1)).toThrow("between 1 and 100");
    expect(() => simulateResearchScenario(4, "cold", 5)).toThrow("between 1 and 4");
  });
});
