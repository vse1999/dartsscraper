import { describe, expect, it, vi } from "vitest";

import { PlayerAmbiguousError, PlayerNotFoundError } from "../src/errors.js";
import { DartsNerdModusSource } from "../src/modus/darts-nerd-source.js";
import { FixtureNameResolver } from "../src/modus/fixture-name-resolver.js";
import { modusAbbreviationMatches, modusNamesEquivalent } from "../src/modus/identity.js";
import type { PlayerStatsResponse } from "../src/schemas/player.js";

function directory(names: readonly [number, string][]): PlayerStatsResponse {
  return {
    draw: 1,
    recordsTotal: names.length,
    recordsFiltered: names.length,
    data: names.map(([playerKey, playerName]) => ({
      player_key: playerKey,
      player_name: playerName,
      player_profile_url: `https://dartsorakel.com/player/details/${playerKey}/player-${playerKey}`,
    })),
  };
}

describe("conservative MODUS identity", () => {
  it("matches full names across diacritics and punctuation while retaining the source id", async () => {
    const resolver = new FixtureNameResolver({
      getPlayerStats: async (): Promise<PlayerStatsResponse> => directory([[7, "Karel Němec"], [8, "John O'Shea"]]),
    });

    await expect(resolver.resolveWithIdentity("Karel Nemec")).resolves.toEqual({
      canonicalName: "Karel Němec",
      sourceId: "7",
    });
    await expect(resolver.resolve("O'Shea J.")).resolves.toBe("John O'Shea");
  });

  it("matches trailing initials for compound given names and surname parts", () => {
    expect(modusAbbreviationMatches("van Peer B.", "Berry van Peer")).toBe(true);
    expect(modusAbbreviationMatches("Leung K. F.", "Kai Fan Leung")).toBe(true);
    expect(modusAbbreviationMatches("De Sousa J. M.", "John Michael De Sousa Jr")).toBe(true);
  });

  it("abstains on a collision instead of picking by popularity or order", async () => {
    const resolver = new FixtureNameResolver({
      getPlayerStats: async (): Promise<PlayerStatsResponse> => directory([[1, "John Smith"], [2, "Jack Smith"]]),
    });

    await expect(resolver.resolve("Smith J.")).rejects.toBeInstanceOf(PlayerAmbiguousError);
    await expect(resolver.resolve("Jon Smith")).rejects.toBeInstanceOf(PlayerNotFoundError);
  });

  it("quarantines a source id that claims conflicting names", async () => {
    const resolver = new FixtureNameResolver({
      getPlayerStats: async (): Promise<PlayerStatsResponse> => directory([[7, "John Smith"], [7, "Jane Smith"]]),
    });

    await expect(resolver.resolve("John Smith")).rejects.toBeInstanceOf(PlayerNotFoundError);
  });

  it("does not treat arbitrary token order as the same person", () => {
    expect(modusNamesEquivalent("John Smith", "Smith John")).toBe(false);
    expect(modusNamesEquivalent("Márton Nagy", "MARTON NAGY")).toBe(true);
  });

  it("retains official country qualifiers and refuses to merge qualified people", async () => {
    expect(modusNamesEquivalent("Lee (ENG) Evans", "Lee (WAL) Evans")).toBe(false);
    expect(modusNamesEquivalent("Lee (ENG) Evans", "Lee Evans")).toBe(false);
    expect(modusAbbreviationMatches("Evans L. (ENG)", "Lee (ENG) Evans")).toBe(true);
    expect(modusAbbreviationMatches("Evans L. (ENG)", "Lee (WAL) Evans")).toBe(false);

    const resolver = new FixtureNameResolver({
      getPlayerStats: async (): Promise<PlayerStatsResponse> => directory([
        [1, "Lee (ENG) Evans"],
        [2, "Lee (WAL) Evans"],
      ]),
    });
    await expect(resolver.resolve("Lee (ENG) Evans")).resolves.toBe("Lee (ENG) Evans");
    await expect(resolver.resolve("Lee Evans")).rejects.toBeInstanceOf(PlayerAmbiguousError);
  });

  it("maps an unqualified name to one uniquely qualified directory identity", async () => {
    const resolver = new FixtureNameResolver({
      getPlayerStats: async (): Promise<PlayerStatsResponse> => directory([[1, "Lee (ENG) Evans"]]),
    });

    await expect(resolver.resolve("Lee Evans")).resolves.toBe("Lee (ENG) Evans");
  });

  it("does not let an unqualified directory row hide competing qualified identities", async () => {
    const resolver = new FixtureNameResolver({
      getPlayerStats: async (): Promise<PlayerStatsResponse> => directory([
        [1, "Lee Evans"],
        [2, "Lee (ENG) Evans"],
        [3, "Lee (WAL) Evans"],
      ]),
    });

    await expect(resolver.resolve("Lee Evans")).rejects.toBeInstanceOf(PlayerAmbiguousError);
  });

  it("does not treat an explicit qualifier as a match for an unqualified row", async () => {
    const resolver = new FixtureNameResolver({
      getPlayerStats: async (): Promise<PlayerStatsResponse> => directory([[1, "Lee Evans"]]),
    });

    await expect(resolver.resolve("Lee (ENG) Evans")).rejects.toBeInstanceOf(PlayerNotFoundError);
  });

  it("refreshes the directory once after a genuine player miss", async () => {
    const getPlayerStats = vi.fn(async (): Promise<PlayerStatsResponse> => directory([]));
    const refreshPlayerStats = vi.fn(async (): Promise<PlayerStatsResponse> => directory([[7, "Jack Drayton"]]));
    const resolver = new FixtureNameResolver({ getPlayerStats, refreshPlayerStats });

    await expect(resolver.resolve("Jack Drayton")).resolves.toBe("Jack Drayton");
    expect(getPlayerStats).toHaveBeenCalledOnce();
    expect(refreshPlayerStats).toHaveBeenCalledOnce();
  });

  it("does not refresh the directory when a name is already ambiguous", async () => {
    const refreshPlayerStats = vi.fn(async (): Promise<PlayerStatsResponse> => directory([[3, "J. Smith"]]));
    const resolver = new FixtureNameResolver({
      getPlayerStats: async (): Promise<PlayerStatsResponse> => directory([[1, "John Smith"], [2, "Jack Smith"]]),
      refreshPlayerStats,
    });

    await expect(resolver.resolve("Smith J.")).rejects.toBeInstanceOf(PlayerAmbiguousError);
    expect(refreshPlayerStats).not.toHaveBeenCalled();
  });

  it("publicly resolves a MODUS fixture before it reaches history/stat routing", async () => {
    const resolver = new FixtureNameResolver({
      getPlayerStats: async (): Promise<PlayerStatsResponse> => directory([
        [7, "Karel Němec"],
        [8, "Kai Fan Leung"],
      ]),
    });
    const source = new DartsNerdModusSource({
      resolver,
      now: (): Date => new Date("2026-09-30T12:00:00Z"),
      fetchImpl: async (): Promise<Response> => new Response(
        '<a class="hm-match" href="/en/federations/modus/super-series/2026/matches/a"><span class="hm-time" data-utc="2026-09-29T08:40:00Z"></span><span class="hm-name">Němec K.</span><span class="hm-name">Leung K. F.</span></a>',
        { status: 200 },
      ),
    });

    await expect(source.getFixtures("2026-09-29")).resolves.toMatchObject([{
      playerOne: "Karel Němec",
      playerTwo: "Kai Fan Leung",
    }]);
  });

  it("uses official pair recovery after a Darts Nerd label misses, without calling it on a complete resolution", async () => {
    const fallback = {
      resolvePair: vi.fn(async (): Promise<readonly [string, string] | null> => ["Richie Howson", "Daryl Evans"]),
    };
    const source = new DartsNerdModusSource({
      resolver: {
        resolve: async (name: string): Promise<string> => {
          if (name === "Evans D.") throw new Error("not in DartsOrakel");
          return name === "Howson R." ? "Richie Howson" : name;
        },
      },
      fixtureIdentityFallback: fallback,
      now: (): Date => new Date("2026-09-13T12:00:00Z"),
      fetchImpl: async (): Promise<Response> => new Response(
        '<a class="hm-match" href="/en/federations/modus/super-series/2026/matches/howson-r-vs-evans-d-14-09-2026"><span class="hm-time" data-utc="2026-09-14T08:40:00Z"></span><span class="hm-name">Howson R.</span><span class="hm-name">Evans D.</span></a>',
        { status: 200 },
      ),
    });

    await expect(source.getFixtures("2026-09-14")).resolves.toMatchObject([{
      playerOne: "Richie Howson",
      playerTwo: "Daryl Evans",
    }]);
    expect(fallback.resolvePair).toHaveBeenCalledWith("2026-09-14", "Howson R.", "Evans D.", undefined);
  });
});
