import { describe, expect, it, vi } from "vitest";

import { DartsOrakelClient } from "../src/dartsorakel/client.js";
import { DartsOrakelRequestError, DartsOrakelStructureChangedError } from "../src/errors.js";
import { readMatchFixture } from "./helpers.js";

describe("DartsOrakelClient", () => {
  it("retries a transient HTTP failure with deterministic backoff", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(readMatchFixture("damon-heta-matches.json")), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = new DartsOrakelClient({
      baseUrl: "https://example.com",
      fetchImpl,
      sleep,
      backoffMs: 10,
      minRequestIntervalMs: 0,
    });

    await expect(client.getPlayerMatches(13)).resolves.toHaveProperty("recordsTotal", 640);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("cancels failed response bodies before retrying", async () => {
    const cancel = vi.fn<() => Promise<void>>(async (): Promise<void> => undefined);
    const failedResponse = {
      ok: false,
      status: 503,
      headers: new Headers(),
      body: { cancel },
    } as unknown as Response;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(failedResponse)
      .mockResolvedValueOnce(Response.json(readMatchFixture("damon-heta-matches.json")));
    const client = new DartsOrakelClient({
      baseUrl: "https://example.com",
      fetchImpl,
      minRequestIntervalMs: 0,
      backoffMs: 0,
    });

    await expect(client.getPlayerMatches(13)).resolves.toHaveProperty("recordsTotal", 640);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("retries a transient network failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(Response.json(readMatchFixture("damon-heta-matches.json")));
    const client = new DartsOrakelClient({
      baseUrl: "https://example.com",
      fetchImpl,
      minRequestIntervalMs: 0,
      backoffMs: 0,
    });

    await expect(client.getPlayerMatches(13)).resolves.toHaveProperty("recordsTotal", 640);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("cancels an active response body parse and its transport", async () => {
    let beginParsing: () => void = () => undefined;
    let releaseBody: () => void = () => undefined;
    const parsing = new Promise<void>((resolve) => { beginParsing = resolve; });
    const body = new Promise<void>((resolve) => { releaseBody = resolve; });
    const cancelBody = vi.fn<() => Promise<void>>(async (): Promise<void> => undefined);
    let requestSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_input, init): Promise<Response> => {
      requestSignal = init?.signal ?? undefined;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: { cancel: cancelBody },
        json: async (): Promise<unknown> => {
          beginParsing();
          await body;
          return { draw: 0, recordsTotal: 0, recordsFiltered: 0, data: [] };
        },
      } as unknown as Response;
    };
    const client = new DartsOrakelClient({
      baseUrl: "https://example.com",
      fetchImpl,
      minRequestIntervalMs: 0,
      timeoutMs: 10_000,
      maxRetries: 0,
    });
    const controller = new AbortController();
    const pending = client.getPlayerStats(controller.signal);
    await parsing;

    controller.abort(new Error("report deadline"));
    await expect(pending).rejects.toThrow("report deadline");
    expect(requestSignal?.aborted).toBe(true);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    releaseBody();
  });

  it("keeps the per-attempt timeout active while parsing the response body", async () => {
    vi.useFakeTimers();
    try {
      let beginParsing: () => void = () => undefined;
      let releaseBody: () => void = () => undefined;
      const parsing = new Promise<void>((resolve) => { beginParsing = resolve; });
      const body = new Promise<void>((resolve) => { releaseBody = resolve; });
      const fetchImpl: typeof fetch = async (): Promise<Response> => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async (): Promise<unknown> => {
          beginParsing();
          await body;
          return { draw: 0, recordsTotal: 0, recordsFiltered: 0, data: [] };
        },
      } as Response);
      const client = new DartsOrakelClient({
        baseUrl: "https://example.com",
        fetchImpl,
        minRequestIntervalMs: 0,
        timeoutMs: 25,
        maxRetries: 0,
      });
      const pending = client.getPlayerStats();
      await parsing;
      vi.advanceTimersByTime(25);
      await expect(pending).rejects.toBeInstanceOf(DartsOrakelRequestError);
      releaseBody();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a retry after cancellation during backoff", async () => {
    let releaseSleep: () => void = () => undefined;
    const sleep = vi.fn<(milliseconds: number, signal?: AbortSignal) => Promise<void>>(() => new Promise<void>((resolve) => {
      releaseSleep = resolve;
    }));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("temporary failure", { status: 503 }));
    const client = new DartsOrakelClient({
      baseUrl: "https://example.com",
      fetchImpl,
      sleep,
      backoffMs: 100,
      minRequestIntervalMs: 0,
    });
    const controller = new AbortController();
    const pending = client.getPlayerStats(controller.signal);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledWith(100, controller.signal));
    controller.abort(new Error("cancelled retry"));
    await expect(pending).rejects.toThrow("cancelled retry");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    releaseSleep();
  });

  it("does not issue a queued request after its caller is cancelled", async () => {
    let startDelayedSleep: () => void = () => undefined;
    const delayedSleep = new Promise<void>((resolve) => { startDelayedSleep = resolve; });
    const sleep = vi.fn<(milliseconds: number, signal?: AbortSignal) => Promise<void>>((milliseconds: number) => {
      return milliseconds > 0 ? delayedSleep : Promise.resolve();
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (): Promise<Response> => {
      return new Response(JSON.stringify({ draw: 0, recordsTotal: 0, recordsFiltered: 0, data: [] }), { status: 200 });
    });
    const client = new DartsOrakelClient({
      baseUrl: "https://example.com",
      fetchImpl,
      sleep,
      minRequestIntervalMs: 10_000,
      maxRetries: 0,
    });
    await client.getPlayerStats();
    const controller = new AbortController();
    const pending = client.getPlayerStats(controller.signal);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledWith( expect.any(Number), controller.signal));
    controller.abort(new Error("cancelled queue"));
    await expect(pending).rejects.toThrow("cancelled queue");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    startDelayedSleep();
  });

  it("keeps FIFO ordering when the middle queued request is cancelled", async () => {
    const sleepReleases: Array<() => void> = [];
    const sleep = vi.fn<(milliseconds: number, signal?: AbortSignal) => Promise<void>>((milliseconds: number) => {
      if (milliseconds <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => sleepReleases.push(resolve));
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (): Promise<Response> => {
      return new Response(JSON.stringify({ draw: 0, recordsTotal: 0, recordsFiltered: 0, data: [] }), { status: 200 });
    });
    const client = new DartsOrakelClient({
      baseUrl: "https://example.com",
      fetchImpl,
      sleep,
      minRequestIntervalMs: 10_000,
      maxRetries: 0,
    });
    await client.getPlayerStats();

    const first = client.getPlayerStats();
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
    const middleController = new AbortController();
    const middle = client.getPlayerStats(middleController.signal);
    const last = client.getPlayerStats();
    middleController.abort(new Error("middle cancelled"));
    await expect(middle).rejects.toThrow("middle cancelled");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const firstSleep = sleepReleases[0];
    if (firstSleep === undefined) throw new Error("Expected first request to be waiting in the queue.");
    firstSleep();
    await first;
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(2));
    const lastSleep = sleepReleases[1];
    if (lastSleep === undefined) throw new Error("Expected last request to wait for pacing.");
    lastSleep();
    await last;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("honors a longer Retry-After delay from a rate-limited source", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "2" },
      }))
      .mockResolvedValueOnce(Response.json(readMatchFixture("damon-heta-matches.json")));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = new DartsOrakelClient({
      baseUrl: "https://example.com",
      fetchImpl,
      sleep,
      backoffMs: 10,
      minRequestIntervalMs: 0,
    });

    await expect(client.getPlayerMatches(13)).resolves.toHaveProperty("recordsTotal", 640);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("paces request starts without serializing independent network responses", async () => {
    const fixture = readMatchFixture("damon-heta-matches.json");
    const releases: Array<() => void> = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (): Promise<Response> => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return Response.json(fixture);
    });
    const client = new DartsOrakelClient({
      baseUrl: "https://example.com",
      fetchImpl,
      minRequestIntervalMs: 0,
      maxRetries: 0,
    });

    const first = client.getPlayerMatches(13);
    const second = client.getPlayerMatches(29);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    for (const release of releases) release();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("sends the complete live Averages filter and versions the cache key", async () => {
    let requestedUrl: string | undefined;
    const writtenCacheKeys: string[] = [];
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL): Promise<Response> => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(readMatchFixture("rob-cross-matches.json")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new DartsOrakelClient({
      baseUrl: "https://example.com",
      fetchImpl,
      minRequestIntervalMs: 0,
      now: () => Date.parse("2026-08-08T12:00:00Z"),
      cache: {
        get: async (): Promise<null> => null,
        set: async (key: string): Promise<void> => { writtenCacheKeys.push(key); },
      },
    });

    await client.getPlayerMatches(29);
    if (requestedUrl === undefined) {
      throw new Error("Expected the client to issue a request.");
    }
    const url = new URL(requestedUrl);
    expect(url.searchParams.get("rankKey")).toBe("25");
    expect(url.searchParams.get("organStat")).toBe("All");
    expect(url.searchParams.get("tourns")).toBe("");
    expect(url.searchParams.get("dateFrom")).toBe("1900-01-01");
    expect(url.searchParams.get("dateTo")).toBe("2026-08-09");
    expect(writtenCacheKeys).toEqual([
      "player-matches-v4-29-1900-01-01-2026-08-09-25-All-all-tournaments-all-rows",
    ]);
  });

  it.each([
    ["average", "25"],
    ["oneEighties", "26"],
    ["checkoutPercentage", "1053"],
  ] as const)("maps the %s statistic to rankKey %s and isolates its cache entry", async (statistic, expectedRankKey) => {
    let requestedUrl: string | undefined;
    const cacheSet = vi.fn<(key: string, value: unknown, ttlMs: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = new DartsOrakelClient({
      baseUrl: "https://example.com",
      minRequestIntervalMs: 0,
      fetchImpl: async (input: RequestInfo | URL): Promise<Response> => {
        requestedUrl = String(input);
        return Response.json(readMatchFixture("rob-cross-matches.json"));
      },
      cache: { get: async (): Promise<null> => null, set: cacheSet },
    });

    await client.getPlayerMatches(29, { statistic, limit: 10 });

    expect(new URL(requestedUrl ?? "https://invalid.test").searchParams.get("rankKey")).toBe(expectedRankKey);
    expect(cacheSet.mock.calls[0]?.[0]).toContain(`-${expectedRankKey}-All-`);
  });

  it("raises request errors after retry exhaustion", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("failure", { status: 500 }));
    const client = new DartsOrakelClient({
      baseUrl: "https://example.com",
      fetchImpl,
      sleep: async () => undefined,
      minRequestIntervalMs: 0,
      maxRetries: 1,
    });

    await expect(client.getPlayerMatches(13)).rejects.toBeInstanceOf(DartsOrakelRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("scopes recent-history requests and cache keys by both date boundaries", async () => {
    let requestedUrl: string | undefined;
    const cacheSet = vi.fn<(key: string, value: unknown, ttlMs: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = new DartsOrakelClient({
      baseUrl: "https://example.com",
      minRequestIntervalMs: 0,
      fetchImpl: async (input): Promise<Response> => {
        requestedUrl = String(input);
        return new Response(JSON.stringify(readMatchFixture("rob-cross-matches.json")), { status: 200 });
      },
      cache: { get: async () => null, set: cacheSet },
    });

    await client.getPlayerMatches(29, { dateFrom: "2026-05-14", dateTo: "2026-08-12" });

    expect(new URL(requestedUrl ?? "https://invalid.test").searchParams.get("dateFrom")).toBe("2026-05-14");
    expect(new URL(requestedUrl ?? "https://invalid.test").searchParams.get("dateTo")).toBe("2026-08-12");
    expect(cacheSet).toHaveBeenCalledWith(
      "player-matches-v4-29-2026-05-14-2026-08-12-25-All-all-tournaments-all-rows",
      expect.any(Object),
      expect.any(Number),
    );
  });

  it("bounds match response rows when a limit is supplied", async () => {
    let requestedUrl: string | undefined;
    const client = new DartsOrakelClient({
      baseUrl: "https://example.com",
      minRequestIntervalMs: 0,
      fetchImpl: async (input: RequestInfo | URL): Promise<Response> => {
        requestedUrl = String(input);
        return Response.json(readMatchFixture("rob-cross-matches.json"));
      },
    });

    await client.getPlayerMatches(29, { limit: 50 });

    const url = new URL(requestedUrl ?? "https://invalid.test");
    expect(url.searchParams.get("start")).toBe("0");
    expect(url.searchParams.get("length")).toBe("50");
  });

  it("detects an unexpected JSON shape", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = new DartsOrakelClient({ baseUrl: "https://example.com", fetchImpl, minRequestIntervalMs: 0 });

    await expect(client.getPlayerMatches(13)).rejects.toBeInstanceOf(DartsOrakelStructureChangedError);
  });
});
