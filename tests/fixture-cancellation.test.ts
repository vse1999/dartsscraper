import { describe, expect, it, vi } from "vitest";

import { DartsNerdModusSource } from "../src/modus/darts-nerd-source.js";
import { PdpaPdcFixtureSource } from "../src/pdc/pdpa-fixture-source.js";

const MODUS_PREVIEW_HTML = `<a class="hm-match" href="/en/federations/modus/super-series/2026/matches/howson-r-vs-evans-d-14-09-2026">
  <span class="hm-time" data-utc="2026-09-14T08:40:00Z"></span>
  <span class="hm-name">Howson R.</span><span class="hm-name">Evans D.</span>
</a>`;

describe("fixture provider cancellation", () => {
  it("does not fetch when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    const modusFetch = vi.fn<typeof fetch>();
    const modus = new DartsNerdModusSource({
      resolver: { resolve: async (name: string): Promise<string> => name },
      fetchImpl: modusFetch,
      now: () => new Date("2026-09-13T12:00:00Z"),
    });
    const pdpaFetch = vi.fn<typeof fetch>();
    const pdpa = new PdpaPdcFixtureSource({ fetchImpl: pdpaFetch });

    await expect(modus.getPlayers("2026-09-14", controller.signal)).rejects.toThrow("caller cancelled");
    await expect(pdpa.getFixtures("2026-09-17", controller.signal)).rejects.toThrow("caller cancelled");
    expect(modusFetch).not.toHaveBeenCalled();
    expect(pdpaFetch).not.toHaveBeenCalled();
  });

  it("passes the caller signal through abbreviated MODUS name resolution", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const resolve = vi.fn(async (name: string, signal?: AbortSignal): Promise<string> => {
      signals.push(signal);
      return name;
    });
    const source = new DartsNerdModusSource({
      resolver: { resolve },
      fetchImpl: async (): Promise<Response> => new Response(MODUS_PREVIEW_HTML, { status: 200 }),
      baseUrl: "https://example.test",
      now: () => new Date("2026-09-13T12:00:00Z"),
    });

    await expect(source.getPlayers("2026-09-14", controller.signal)).resolves.toEqual(["Howson R.", "Evans D."]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  it("stops PDPA event-page discovery after cancellation without fetching later pages", async () => {
    const controller = new AbortController();
    const calendarHtml = `<a class="event-tile-small" href="/event/one/"><div class="title">One</div><div class="date">17 September 2026</div></a>
      <a class="event-tile-small" href="/event/two/"><div class="title">Two</div><div class="date">17 September 2026</div></a>`;
    let releaseFirstPage: ((response: Response) => void) | undefined;
    const firstPage = new Promise<Response>((resolve): void => {
      releaseFirstPage = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/events/calendar/")) return new Response(calendarHtml, { status: 200 });
      if (url.endsWith("/event/one/")) return firstPage;
      throw new Error(`unexpected fetch: ${url}`);
    });
    const source = new PdpaPdcFixtureSource({ fetchImpl, timeoutMs: 10_000 });
    const pending = source.getFixtures("2026-09-17", controller.signal);

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    controller.abort(new Error("caller cancelled"));
    releaseFirstPage?.(new Response("", { status: 200 }));

    await expect(pending).rejects.toThrow("caller cancelled");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://pdpa.co.uk/event/one/");
  });
});
