import { describe, expect, it } from "vitest";

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
});
