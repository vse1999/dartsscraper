import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEredmenyekMatchIdentity, parseEredmenyekPlayerProfile } from "../src/odds/identity.js";
import { createDefaultOddsReader } from "../src/odds/default.js";
import type { OddsMatch } from "../src/odds/contracts.js";

const detailUrl = "https://www.eredmenyek.com/merkozes/darts/menzies-cameron-2NUpDqVt/smith-ross-l8mIsYNm/?mid=p26kVvmS";

const identityDate = "2026-09-28";

function identityMatch(eventId: string): OddsMatch {
  return {
    eventId,
    competition: "World Grand Prix",
    player1: "Smith R.",
    player2: "Menzies C.",
    odds1: 2.2,
    odds2: 1.7,
    bookmaker: "TippmixPro",
    scheduledTime: "20:00",
    sourceUrl: `https://www.eredmenyek.com/merkozes/darts/menzies-cameron-2NUpDqVt/smith-ross-l8mIsYNm/?mid=${eventId}`,
  };
}

function identityDetailHtml(): string {
  return `<html><head><title>Match</title></head><body><h1>Ross Smith v Cameron Menzies (28/09/2026)</h1></body></html>`;
}

function identityProfileHtml(profileUrl: string, fullName: string): string {
  return `<html><head><link rel="canonical" href="${profileUrl}"></head><body><h1>Darts: ${fullName} eredmények, meccsek</h1><div class="heading__name">${fullName}</div></body></html>`;
}

function identityResponse(url: string, body: string, status = 200, headers: HeadersInit = { "content-type": "text/html" }): Response {
  const response = new Response(body, { status, headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function detailHtml(title = "Ross Smith v Cameron Menzies (28/09/2026)"): string {
  return `<html><body><main><h1>${title}</h1>
    <a href="/jatekos/smith-ross/l8mIsYNm/">Smith R.</a>
    <a href="/jatekos/menzies-cameron/2NUpDqVt/">Menzies C.</a>
    <a href="/jatekos/smith-ross/l8mIsYNm/"></a>
  </main></body></html>`;
}

function swappedDetailHtml(): string {
  return `<html><body><main><h1>Ross Smith v Cameron Menzies (28/09/2026)</h1>
    <a href="/jatekos/menzies-cameron/2NUpDqVt/">Menzies C.</a>
    <a href="/jatekos/smith-ross/l8mIsYNm/">Smith R.</a>
  </main></body></html>`;
}

describe("Eredmenyek match identity evidence", () => {
  it("verifies ordinary SSR detail/profile HTML without launching Chromium", async () => {
    const info = vi.spyOn(console, "info");
    const match = identityMatch("identity-ssr");
    const profileRoss = "https://www.eredmenyek.com/jatekos/smith-ross/l8mIsYNm/";
    const profileCameron = "https://www.eredmenyek.com/jatekos/menzies-cameron/2NUpDqVt/";
    const pages = new Map<string, string>([
      [match.sourceUrl, identityDetailHtml()],
      [profileRoss, identityProfileHtml(profileRoss, "Ross Smith")],
      [profileCameron, identityProfileHtml(profileCameron, "Cameron Menzies")],
    ]);
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      const body = pages.get(url);
      return body === undefined ? identityResponse(url, "missing", 404) : identityResponse(url, body);
    });
    vi.stubGlobal("fetch", fetchMock);
    const reader = createDefaultOddsReader({ executablePath: "C:/not-used/chrome.exe" });
    const evidence = await reader.getIdentityEvidence([match], identityDate);
    expect(evidence.get(match.eventId)?.home.fullName).toBe("Ross Smith");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(info).not.toHaveBeenCalled();
  });

  it("retains completed evidence when the internal identity budget expires", async () => {
    const first = identityMatch("identity-fast");
    const second = identityMatch("identity-slow");
    const slowProfile = "https://www.eredmenyek.com/jatekos/menzies-cameron/2NUpDqVt/";
    const pages = new Map<string, string>([
      [first.sourceUrl, identityDetailHtml()],
      [`${first.sourceUrl.replace("identity-fast", "identity-slow")}`, identityDetailHtml()],
      ["https://www.eredmenyek.com/jatekos/smith-ross/l8mIsYNm/", identityProfileHtml("https://www.eredmenyek.com/jatekos/smith-ross/l8mIsYNm/", "Ross Smith")],
      [slowProfile, identityProfileHtml(slowProfile, "Cameron Menzies")],
    ]);
    let requestCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requestCount += 1;
      const url = requestUrl(input);
      if (url === slowProfile && requestCount > 4 && init?.signal !== undefined) {
        return await new Promise<Response>((_resolve, reject): void => {
          const onAbort = (): void => reject(init.signal?.reason ?? new Error("identity request aborted"));
          init.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      const body = pages.get(url);
      return body === undefined ? identityResponse(url, "missing", 404) : identityResponse(url, body);
    });
    vi.stubGlobal("fetch", fetchMock);
    const reader = createDefaultOddsReader({ identityTimeoutMs: 30, identityRequestTimeoutMs: 1_000 });
    const evidence = await reader.getIdentityEvidence([first, second], identityDate);
    expect(evidence.has(first.eventId)).toBe(true);
    expect(evidence.has(second.eventId)).toBe(false);
  });

  it("bounds a non-cooperative fetch after the internal budget expires", async () => {
    const match = identityMatch("identity-noncooperative");
    const fetchMock = vi.fn<typeof fetch>(async (): Promise<Response> => await new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const reader = createDefaultOddsReader({ identityTimeoutMs: 25, identityRequestTimeoutMs: 1_000 });
    const started = Date.now();
    const evidence = await reader.getIdentityEvidence([match], identityDate);
    expect(evidence.size).toBe(0);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("bounds a stalled response body and does not await cancellation cleanup", async () => {
    const match = identityMatch("identity-stalled-body");
    const response = identityResponse(match.sourceUrl, identityDetailHtml());
    const stalledReader = {
      read: (): Promise<ReadableStreamReadResult<Uint8Array>> => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
      cancel: (): Promise<void> => new Promise<void>(() => undefined),
      releaseLock: (): void => undefined,
    };
    Object.defineProperty(response, "body", { configurable: true, value: { getReader: (): typeof stalledReader => stalledReader } });
    const fetchMock = vi.fn<typeof fetch>(async (): Promise<Response> => response);
    vi.stubGlobal("fetch", fetchMock);
    const reader = createDefaultOddsReader({ identityTimeoutMs: 25, identityRequestTimeoutMs: 1_000 });
    const started = Date.now();
    const evidence = await reader.getIdentityEvidence([match], identityDate);
    expect(evidence.size).toBe(0);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("propagates external identity cancellation instead of returning partial evidence", async () => {
    const match = identityMatch("identity-cancel");
    const slowProfile = "https://www.eredmenyek.com/jatekos/smith-ross/l8mIsYNm/";
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (url === slowProfile && init?.signal !== undefined) {
        return await new Promise<Response>((_resolve, reject): void => {
          const onAbort = (): void => reject(init.signal?.reason ?? new Error("identity request aborted"));
          init.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (url === "https://www.eredmenyek.com/jatekos/menzies-cameron/2NUpDqVt/") return identityResponse(url, identityProfileHtml(url, "Cameron Menzies"));
      return identityResponse(url, identityDetailHtml());
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const reader = createDefaultOddsReader({ identityTimeoutMs: 1_000, identityRequestTimeoutMs: 1_000 });
    const pending = reader.getIdentityEvidence([match], identityDate, controller.signal);
    setTimeout((): void => controller.abort(new Error("caller cancelled")), 5);
    await expect(pending).rejects.toThrow("caller cancelled");
  });

  it("lets external cancellation win during internal-timeout recovery", async () => {
    const match = identityMatch("identity-cancel-recovery");
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async (): Promise<Response> => await new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const reader = createDefaultOddsReader({
      identityTimeoutMs: 25,
      identityRequestTimeoutMs: 1_000,
      identityLogger: (summary): void => {
        if (summary.stage === "partial-timeout") controller.abort(new Error("Eredmenyek identity read timed out."));
      },
    });
    await expect(reader.getIdentityEvidence([match], identityDate, controller.signal)).rejects.toThrow("Eredmenyek identity read timed out.");
  });

  it("continues to another match when one SSR profile is unavailable", async () => {
    const unavailable = identityMatch("identity-unavailable");
    const available = identityMatch("identity-available");
    const pages = new Map<string, string>([
      [available.sourceUrl, identityDetailHtml()],
      ["https://www.eredmenyek.com/jatekos/smith-ross/l8mIsYNm/", identityProfileHtml("https://www.eredmenyek.com/jatekos/smith-ross/l8mIsYNm/", "Ross Smith")],
      ["https://www.eredmenyek.com/jatekos/menzies-cameron/2NUpDqVt/", identityProfileHtml("https://www.eredmenyek.com/jatekos/menzies-cameron/2NUpDqVt/", "Cameron Menzies")],
    ]);
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url === unavailable.sourceUrl) return identityResponse(url, "unavailable", 503);
      const body = pages.get(url);
      return body === undefined ? identityResponse(url, "missing", 404) : identityResponse(url, body);
    });
    vi.stubGlobal("fetch", fetchMock);
    const reader = createDefaultOddsReader();
    const evidence = await reader.getIdentityEvidence([unavailable, available], identityDate);
    expect(evidence.has(unavailable.eventId)).toBe(false);
    expect(evidence.has(available.eventId)).toBe(true);
  });

  it.each([403, 429])("fails closed on identity challenge/status HTTP %s", async (status: number) => {
    const match = identityMatch(`identity-http-${status}`);
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL): Promise<Response> => identityResponse(requestUrl(input), "blocked", status));
    vi.stubGlobal("fetch", fetchMock);
    const reader = createDefaultOddsReader();
    const evidence = await reader.getIdentityEvidence([match], identityDate);
    expect(evidence.size).toBe(0);
  });

  it("fails closed on redirected or oversized identity documents", async () => {
    const redirected = identityMatch("identity-redirect");
    const oversized = identityMatch("identity-oversized");
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url === redirected.sourceUrl) return identityResponse("https://www.eredmenyek.com/other", identityDetailHtml());
      return identityResponse(url, "small", 200, { "content-type": "text/html", "content-length": "2500001" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const reader = createDefaultOddsReader();
    const evidence = await reader.getIdentityEvidence([redirected, oversized], identityDate);
    expect(evidence.size).toBe(0);
  });

  it("uses DOM participant order rather than reversed detail URL slug order", () => {
    const evidence = parseEredmenyekMatchIdentity({
      html: detailHtml(),
      detailUrl,
      date: "2026-09-28",
      match: { eventId: "p26kVvmS", player1: "Smith R.", player2: "Menzies C." },
    });
    expect(evidence.home).toEqual({
      sourcePlayerId: "l8mIsYNm",
      fullName: "Ross Smith",
      profileUrl: "https://www.eredmenyek.com/jatekos/smith-ross/l8mIsYNm/",
    });
    expect(evidence.away.sourcePlayerId).toBe("2NUpDqVt");
  });

  it("matches swapped profile anchors by their verified participant labels", () => {
    const evidence = parseEredmenyekMatchIdentity({
      html: swappedDetailHtml(),
      detailUrl,
      date: "2026-09-28",
      match: { eventId: "p26kVvmS", player1: "Smith R.", player2: "Menzies C." },
    });
    expect(evidence.home.sourcePlayerId).toBe("l8mIsYNm");
    expect(evidence.away.sourcePlayerId).toBe("2NUpDqVt");
  });

  it("rejects a source ID whose DOM label disagrees with its verified profile page", () => {
    const html = `<html><body><main><h1>Ross Smith v Cameron Menzies (28/09/2026)</h1>
      <a href="/jatekos/raymond-smith/raymond-id/">Smith R.</a>
      <a href="/jatekos/menzies-cameron/2NUpDqVt/">Menzies C.</a>
    </main></body></html>`;
    expect(() => parseEredmenyekMatchIdentity({
      html,
      detailUrl,
      date: "2026-09-28",
      match: { eventId: "p26kVvmS", player1: "Smith R.", player2: "Menzies C." },
      verifiedProfiles: [
        { sourcePlayerId: "raymond-id", fullName: "Raymond Smith", profileUrl: "https://www.eredmenyek.com/jatekos/raymond-smith/raymond-id/" },
        { sourcePlayerId: "2NUpDqVt", fullName: "Cameron Menzies", profileUrl: "https://www.eredmenyek.com/jatekos/menzies-cameron/2NUpDqVt/" },
      ],
    })).toThrow(/displayed odds participant|missing a participant profile|profile page/iu);
  });

  it("rejects conflicting full labels repeated for one source profile ID", () => {
    const html = detailHtml().replace(">Smith R.</a>", ">Ross Smith</a>").replace("<a href=\"/jatekos/smith-ross/l8mIsYNm/\"></a>", "<a href=\"/jatekos/smith-ross/l8mIsYNm/\">Raymond Smith</a>");
    expect(() => parseEredmenyekMatchIdentity({
      html,
      detailUrl,
      date: "2026-09-28",
      match: { eventId: "p26kVvmS", player1: "Smith R.", player2: "Menzies C." },
    })).toThrow(/conflicting labels/iu);
  });

  it("fails closed when an unrelated third profile appears in the detail participants", () => {
    expect(() => parseEredmenyekMatchIdentity({
      html: `${swappedDetailHtml().replace("</main>", "<a href=\"/jatekos/anderson-gary/MyKZZS6r/\">Anderson G.</a></main>")}`,
      detailUrl,
      date: "2026-09-28",
      match: { eventId: "p26kVvmS", player1: "Smith R.", player2: "Menzies C." },
    })).toThrow(/exactly two/iu);
  });

  it("fails closed when the detail date does not match the report date", () => {
    expect(() => parseEredmenyekMatchIdentity({
      html: detailHtml(),
      detailUrl,
      date: "2026-09-29",
      match: { eventId: "p26kVvmS", player1: "Smith R.", player2: "Menzies C." },
    })).toThrow(/date/iu);
  });

  it("fails closed when full heading names do not match displayed slots", () => {
    expect(() => parseEredmenyekMatchIdentity({
      html: detailHtml("Ross Smith v Gary Anderson (28/09/2026)"),
      detailUrl,
      date: "2026-09-28",
      match: { eventId: "p26kVvmS", player1: "Smith R.", player2: "Menzies C." },
    })).toThrow(/displayed odds participant|missing a participant profile/iu);
  });

  it("verifies a public profile full name and canonical source ID", () => {
    const profileUrl = "https://www.eredmenyek.com/jatekos/smith-ross/l8mIsYNm/";
    const profile = parseEredmenyekPlayerProfile({
      profileUrl,
      html: `<head><link rel="canonical" href="${profileUrl}"></head><main><h1>Darts: Ross Smith eredmények, meccsek</h1><div class="heading__name">Ross Smith</div></main>`,
    });
    expect(profile).toEqual({ sourcePlayerId: "l8mIsYNm", fullName: "Ross Smith", profileUrl });
  });

  it("rejects conflicting profile headings and canonical IDs", () => {
    const profileUrl = "https://www.eredmenyek.com/jatekos/smith-ross/l8mIsYNm/";
    expect(() => parseEredmenyekPlayerProfile({
      profileUrl,
      html: `<head><link rel="canonical" href="${profileUrl.replace("l8mIsYNm", "other-id")}"></head><main><h1>Darts: Ross Smith eredmények, meccsek</h1><div class="heading__name">Raymond Smith</div></main>`,
    })).toThrow(/conflicting full-name headings|canonical/iu);
  });

  it("does not queue browser work for an already-aborted identity request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("identity request already cancelled"));
    const reader = createDefaultOddsReader({ executablePath: "C:/does-not-exist/chrome.exe" });
    await expect(reader.getIdentityEvidence([], "2026-09-28", controller.signal)).rejects.toThrow(/already cancelled/iu);
  });
});
