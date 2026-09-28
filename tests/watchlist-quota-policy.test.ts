import { describe, expect, it } from "vitest";

import {
  evaluateWatchlistQuotaPolicy,
  type WatchlistQuotaPolicyInput,
} from "../src/watchlist/quota-policy.js";

const NOW = new Date("2026-09-27T10:00:00.000Z");

function baseInput(overrides: Partial<WatchlistQuotaPolicyInput> = {}): WatchlistQuotaPolicyInput {
  return {
    session: {
      startAt: "2026-09-27T09:00:00.000Z",
      endAt: "2026-09-27T11:00:00.000Z",
    },
    requestedCadenceMinutes: 5,
    safetyFraction: 0.8,
    zeroSpendEntitlementProven: true,
    resources: [
      {
        resourceId: "source-http",
        tickUpperBound: {
          collectionUnits: 2,
          recheckUnits: 1,
          historyUnits: 3,
          retryUnits: 1,
        },
        windows: [
          {
            startAt: "2026-09-27T09:00:00.000Z",
            endAt: "2026-09-27T12:00:00.000Z",
            allowanceUnits: 1_000,
            usedUnits: 0,
            outstandingReservationUnits: 0,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("watchlist quota policy", () => {
  it("proposes the next tick only when the complete measured tick fits", () => {
    const result = evaluateWatchlistQuotaPolicy(baseInput(), NOW);

    expect(result.allowed).toBe(true);
    expect(result.paused).toBe(false);
    expect(result.effectiveCadenceMinutes).toBe(5);
    expect(result.nextTickAt).toBe("2026-09-27T10:05:00.000Z");
    expect(result.coverage).toMatchObject({
      requestedCadenceMinutes: 5,
      effectiveCadenceMinutes: 5,
      plannedTickCount: 11,
      degraded: false,
      state: "normal",
    });
    expect(result.reservation).toMatchObject({
      tickAt: "2026-09-27T10:05:00.000Z",
      requiresDurableCompareAndSwap: true,
    });
    expect(result.reservation?.resources).toEqual([{
      resourceId: "source-http",
      windowStartAt: "2026-09-27T09:00:00.000Z",
      windowEndAt: "2026-09-27T12:00:00.000Z",
      units: 7,
    }]);
  });

  it("accepts the exact safety-fraction boundary", () => {
    const result = evaluateWatchlistQuotaPolicy({
      ...baseInput(),
      session: {
        startAt: "2026-09-27T09:59:00.000Z",
        endAt: "2026-09-27T10:06:00.000Z",
      },
      resources: [resource("bounded", 20, 25)],
    }, NOW);

    expect(result.allowed).toBe(true);
    expect(result.effectiveCadenceMinutes).toBe(5);
    expect(result.coverage.plannedTickCount).toBe(1);
  });

  it("requires every resource to fit, not only the first resource", () => {
    const result = evaluateWatchlistQuotaPolicy({
      ...baseInput(),
      session: {
        startAt: "2026-09-27T09:59:00.000Z",
        endAt: "2026-09-27T10:06:00.000Z",
      },
      resources: [resource("source-http", 10, 100), resource("browser", 10, 100, 72)],
    }, NOW);

    expect(result.allowed).toBe(false);
    expect(result.pausedReason).toBe("NO_REMAINING_SAFE_QUOTA");
    expect(result.reservation).toBeNull();
  });

  it("subtracts both used units and outstanding reservations", () => {
    const result = evaluateWatchlistQuotaPolicy({
      ...baseInput(),
      session: {
        startAt: "2026-09-27T09:59:00.000Z",
        endAt: "2026-09-27T10:06:00.000Z",
      },
      resources: [resource("source-http", 20, 100, 10, 50)],
    }, NOW);

    expect(result.allowed).toBe(true);
    expect(result.reservation?.resources[0]?.units).toBe(20);

    const exhausted = evaluateWatchlistQuotaPolicy({
      ...baseInput(),
      session: {
        startAt: "2026-09-27T09:59:00.000Z",
        endAt: "2026-09-27T10:06:00.000Z",
      },
      resources: [resource("source-http", 20, 100, 11, 50)],
    }, NOW);
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.pausedReason).toBe("NO_REMAINING_SAFE_QUOTA");
  });

  it("fails closed when zero-spend entitlement is not proven", () => {
    const result = evaluateWatchlistQuotaPolicy({
      ...baseInput(),
      zeroSpendEntitlementProven: false,
    }, NOW);

    expect(result.allowed).toBe(false);
    expect(result.pausedReason).toBe("ZERO_SPEND_UNVERIFIED");
    expect(result.nextTickAt).toBeNull();
  });

  it("fails closed for unknown measured costs", () => {
    const input = baseInput();
    input.resources[0]!.tickUpperBound.collectionUnits = null;
    const result = evaluateWatchlistQuotaPolicy(input, NOW);

    expect(result.allowed).toBe(false);
    expect(result.pausedReason).toBe("UNKNOWN_RESOURCE_COSTS");
  });

  it("defaults an omitted zero-spend entitlement to paused", () => {
    const input = structuredClone(baseInput()) as Record<string, unknown>;
    delete input["zeroSpendEntitlementProven"];

    const result = evaluateWatchlistQuotaPolicy(input, NOW);

    expect(result.allowed).toBe(false);
    expect(result.pausedReason).toBe("ZERO_SPEND_UNVERIFIED");
  });

  it("distinguishes future and expired allowance windows", () => {
    const future = evaluateWatchlistQuotaPolicy({
      ...baseInput(),
      resources: [resource("source-http", 1, 100, 0, 0, "2026-09-27T11:00:00.000Z", "2026-09-27T12:00:00.000Z")],
    }, NOW);
    expect(future.pausedReason).toBe("ALLOWANCE_WINDOW_FUTURE");

    const expired = evaluateWatchlistQuotaPolicy({
      ...baseInput(),
      resources: [resource("source-http", 1, 100, 0, 0, "2026-09-27T08:00:00.000Z", "2026-09-27T09:00:00.000Z")],
    }, NOW);
    expect(expired.pausedReason).toBe("ALLOWANCE_WINDOW_EXPIRED");
  });

  it("rejects duplicate and overlapping windows for one resource", () => {
    const duplicate = baseInput();
    const originalWindow = duplicate.resources[0]!.windows[0]!;
    duplicate.resources[0]!.windows = [originalWindow, { ...originalWindow }];
    expect(evaluateWatchlistQuotaPolicy(duplicate, NOW).pausedReason).toBe("INVALID_INPUT");

    const overlap = baseInput();
    overlap.resources[0]!.windows = [
      {
        ...originalWindow,
        endAt: "2026-09-27T11:00:00.000Z",
      },
      {
        ...originalWindow,
        startAt: "2026-09-27T10:30:00.000Z",
        endAt: "2026-09-27T12:00:00.000Z",
      },
    ];
    expect(evaluateWatchlistQuotaPolicy(overlap, NOW).pausedReason).toBe("INVALID_INPUT");
  });

  it("allows adjacent allowance-window resets without double counting them", () => {
    const input = baseInput();
    input.resources[0]!.windows = [
      {
        startAt: "2026-09-27T09:00:00.000Z",
        endAt: "2026-09-27T10:00:00.000Z",
        allowanceUnits: 100,
        usedUnits: 0,
        outstandingReservationUnits: 0,
      },
      {
        startAt: "2026-09-27T10:00:00.000Z",
        endAt: "2026-09-27T12:00:00.000Z",
        allowanceUnits: 100,
        usedUnits: 0,
        outstandingReservationUnits: 0,
      },
    ];
    const result = evaluateWatchlistQuotaPolicy(input, NOW);

    expect(result.allowed).toBe(true);
    expect(result.pausedReason).toBeNull();
    expect(result.reservation?.resources[0]?.windowStartAt).toBe("2026-09-27T10:00:00.000Z");
  });

  it("can move a scheduled tick across an adjacent reset exactly once", () => {
    const input = baseInput();
    input.session = {
      startAt: "2026-09-27T09:00:00.000Z",
      endAt: "2026-09-27T10:31:00.000Z",
    };
    input.resources[0]!.windows = [
      {
        startAt: "2026-09-27T09:00:00.000Z",
        endAt: "2026-09-27T10:00:00.000Z",
        allowanceUnits: 1_000,
        usedUnits: 0,
        outstandingReservationUnits: 0,
      },
      {
        startAt: "2026-09-27T10:00:00.000Z",
        endAt: "2026-09-27T11:00:00.000Z",
        allowanceUnits: 1_000,
        usedUnits: 0,
        outstandingReservationUnits: 0,
      },
    ];
    const before = structuredClone(input);
    const result = evaluateWatchlistQuotaPolicy(input, new Date("2026-09-27T09:55:00.000Z"));

    expect(result.allowed).toBe(true);
    expect(result.nextTickAt).toBe("2026-09-27T10:00:00.000Z");
    expect(result.coverage.plannedTickCount).toBe(7);
    expect(input).toEqual(before);
  });

  it("rejects an overflowing complete-tick measurement", () => {
    const result = evaluateWatchlistQuotaPolicy({
      ...baseInput(),
      resources: [
        {
          ...resource("source-http", 0, 100),
          tickUpperBound: {
            collectionUnits: 500_000_000_000,
            recheckUnits: 500_000_000_000,
            historyUnits: 500_000_000_000,
            retryUnits: 0,
          },
        },
      ],
    }, NOW);

    expect(result.allowed).toBe(false);
    expect(result.pausedReason).toBe("INVALID_INPUT");
  });

  it("never proposes a tick outside the monitored session", () => {
    const result = evaluateWatchlistQuotaPolicy({
      ...baseInput(),
      session: {
        startAt: "2026-09-27T09:59:00.000Z",
        endAt: "2026-09-27T10:04:00.000Z",
      },
    }, NOW);

    expect(result.allowed).toBe(false);
    expect(result.pausedReason).toBe("SESSION_WINDOW_TOO_SHORT");
    expect(result.nextTickAt).toBeNull();
  });

  it("chooses a slower supported cadence when the requested schedule does not fit", () => {
    const result = evaluateWatchlistQuotaPolicy({
      ...baseInput(),
      session: {
        startAt: "2026-09-27T09:59:00.000Z",
        endAt: "2026-09-27T10:31:00.000Z",
      },
      resources: [resource("source-http", 20, 100)],
    }, NOW);

    expect(result.allowed).toBe(true);
    expect(result.effectiveCadenceMinutes).toBe(10);
    expect(result.coverage).toMatchObject({
      requestedCadenceMinutes: 5,
      effectiveCadenceMinutes: 10,
      plannedTickCount: 3,
      degraded: true,
      state: "slower_cadence",
    });
  });

  it("suspends when one complete tick is larger than the safe quota", () => {
    const result = evaluateWatchlistQuotaPolicy({
      ...baseInput(),
      session: {
        startAt: "2026-09-27T09:59:00.000Z",
        endAt: "2026-09-27T10:06:00.000Z",
      },
      resources: [resource("source-http", 20, 24)],
    }, NOW);

    expect(result.allowed).toBe(false);
    expect(result.pausedReason).toBe("TICK_COST_EXCEEDS_SAFE_QUOTA");
    expect(result.message).toContain("reducing cadence cannot make it fit");
  });

  it("rejects malformed input and an invalid injected clock", () => {
    const malformed = evaluateWatchlistQuotaPolicy(null, NOW);
    expect(malformed.pausedReason).toBe("INVALID_INPUT");

    const invalidClock = evaluateWatchlistQuotaPolicy(baseInput(), new Date(Number.NaN));
    expect(invalidClock.pausedReason).toBe("INVALID_INPUT");
  });
});

function resource(
  resourceId: string,
  cost: number,
  allowanceUnits: number,
  usedUnits: number = 0,
  outstandingReservationUnits: number = 0,
  startAt: string = "2026-09-27T09:00:00.000Z",
  endAt: string = "2026-09-27T12:00:00.000Z",
): WatchlistQuotaPolicyInput["resources"][number] {
  return {
    resourceId,
    tickUpperBound: {
      collectionUnits: cost,
      recheckUnits: 0,
      historyUnits: 0,
      retryUnits: 0,
    },
    windows: [{ startAt, endAt, allowanceUnits, usedUnits, outstandingReservationUnits }],
  };
}
