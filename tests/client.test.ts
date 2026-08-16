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
      "player-matches-v3-29-1900-01-01-2026-08-09-25-All-all-tournaments-all-rows",
    ]);
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
      "player-matches-v3-29-2026-05-14-2026-08-12-25-All-all-tournaments-all-rows",
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
