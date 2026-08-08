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

  it("detects an unexpected JSON shape", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = new DartsOrakelClient({ baseUrl: "https://example.com", fetchImpl, minRequestIntervalMs: 0 });

    await expect(client.getPlayerMatches(13)).rejects.toBeInstanceOf(DartsOrakelStructureChangedError);
  });
});
