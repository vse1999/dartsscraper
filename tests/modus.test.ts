import { describe, expect, it, vi } from "vitest";
import { parsePlayersForDate } from "../src/modus/darts-nerd-source.js";
import { FixtureNameResolver } from "../src/modus/fixture-name-resolver.js";
import { OfficialModusSource } from "../src/modus/official-source.js";
import { ModusPlayersService } from "../src/modus/service.js";
import { ModusSourceUnavailableError, PlayerAmbiguousError } from "../src/errors.js";
import type { ModusFixtureSource } from "../src/modus/schemas.js";
import type { PlayerStatsResponse } from "../src/schemas/player.js";

const html = `<div class="hm-date-header">Monday 10 August</div>
<a class="hm-match"><span class="hm-time" data-utc="2026-08-10T09:30:00Z"></span><span class="hm-name">van Peer B.</span><span class="hm-name">Drayton J.</span></a>
<a class="hm-match"><span class="hm-time" data-utc="2026-08-10T09:50:00Z"></span><span class="hm-name">Drayton J.</span><span class="hm-name">Cressey G.</span></a>
<a class="hm-match"><span class="hm-time" data-utc="2026-08-11T09:30:00Z"></span><span class="hm-name">Other O.</span></a>`;
function playerStats(names: readonly string[]): PlayerStatsResponse {
  return { draw: 1, recordsTotal: names.length, recordsFiltered: names.length, data: names.map((name, index) => ({ player_key: index + 1, player_name: name, player_profile_url: `https://dartsorakel.com/player/details/${index + 1}/player-${index + 1}` })) };
}
function source(name: string, result: readonly string[] | Error): ModusFixtureSource {
  return { name, sourceUrl: () => `https://example.com/${name}`, getPlayers: async () => { if (result instanceof Error) throw result; return result; } };
}

describe("MODUS discovery", () => {
  it("extracts and deduplicates only the requested date", () => {
    expect(parsePlayersForDate(html, "2026-08-10")).toEqual(["van Peer B.", "Drayton J.", "Cressey G."]);
  });
  it("resolves provider abbreviations deterministically", async () => {
    const resolver = new FixtureNameResolver({ getPlayerStats: async () => playerStats(["Berry van Peer", "Carlo van Peer", "Jack Drayton", "George Cressey"]) });
    await expect(resolver.resolve("van Peer B.")).resolves.toBe("Berry van Peer");
    await expect(resolver.resolve("Drayton J.")).resolves.toBe("Jack Drayton");
  });
  it("does not silently choose an ambiguous abbreviation", async () => {
    const resolver = new FixtureNameResolver({ getPlayerStats: async () => playerStats(["John Smith", "Jack Smith"]) });
    await expect(resolver.resolve("Smith J.")).rejects.toBeInstanceOf(PlayerAmbiguousError);
  });
  it("parses the official daily feed and ignores a different date", async () => {
    const payload = { date: "2026-08-10", summaries: [{ sport_event: { competitors: [{ name: "One Player" }, { name: "Two Player" }] } }] };
    const official = new OfficialModusSource({ fetchImpl: vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 })) });
    await expect(official.getPlayers("2026-08-10")).resolves.toEqual(["One Player", "Two Player"]);
    await expect(official.getPlayers("2026-08-11")).resolves.toEqual([]);
  });
  it("canonicalizes official comma names and excludes bracket placeholders", async () => {
    const payload = { date: "2026-08-10", summaries: [{ sport_event: { competitors: [{ name: "Branley, Ryan" }, { name: "Winner Group 1" }, { name: "Runner Up Group 2" }] } }] };
    const official = new OfficialModusSource({ fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }) });
    await expect(official.getPlayers("2026-08-10")).resolves.toEqual(["Ryan Branley"]);
  });  it("falls back, deduplicates, and caches a successful provider", async () => {
    const writes: { key: string; value: unknown; ttlMs: number }[] = [];
    const service = new ModusPlayersService({
      sources: [source("official", []), source("fallback", ["Jack Drayton", " jack   drayton ", "George Cressey"])],
      cache: { get: async () => null, set: async (key, value, ttlMs) => { writes.push({ key, value, ttlMs }); } },
      now: () => new Date("2026-08-10T12:00:00Z"),
    });
    const result = await service.getModusPlayers("2026-08-10");
    expect(result.players.map((player) => player.name)).toEqual(["Jack Drayton", "George Cressey"]);
    expect(result.players.every((player) => player.confidence === 1)).toBe(true);
    expect(writes).toMatchObject([{ key: "modus-players-v2-2026-08-10", ttlMs: 30_000 }]);
  });
  it("reports all unavailable sources", async () => {
    const service = new ModusPlayersService({ sources: [source("official", new Error("offline")), source("fallback", [])] });
    await expect(service.getModusPlayers("2026-08-10")).rejects.toBeInstanceOf(ModusSourceUnavailableError);
    await expect(service.getModusPlayers("2026-08-10")).rejects.toThrow("official: offline");
  });
});


