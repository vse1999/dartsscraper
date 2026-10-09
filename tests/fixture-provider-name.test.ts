import { describe, expect, it } from "vitest";
import { FixtureNameResolver } from "../src/modus/fixture-name-resolver.js";
import { PlayerAmbiguousError, PlayerNotFoundError } from "../src/errors.js";
import type { PlayerStatsResponse } from "../src/schemas/player.js";

function resolver(names: readonly string[]): FixtureNameResolver {
  const response: PlayerStatsResponse = { draw: 1, recordsTotal: names.length, recordsFiltered: names.length,
    data: names.map((name: string, index: number) => ({ player_key: index + 1, player_name: name, player_profile_url: `https://dartsorakel.com/player/details/${index + 1}/example` })),
  };
  return new FixtureNameResolver({ getPlayerStats: async (): Promise<PlayerStatsResponse> => response });
}

describe("fixture-only provider given-name resolution", () => {
  it("resolves a unique Rob Owen provider label without loosening strict resolution", async () => {
    const names = resolver(["Robert Owen", "Michael Smith", "Robert Thornton"]);
    await expect(names.resolveProviderName("Rob Owen")).resolves.toBe("Robert Owen");
    await expect(names.resolve("Rob Owen")).rejects.toBeInstanceOf(PlayerNotFoundError);
  });
  it("refuses ambiguity and does not select the first candidate", async () => {
    await expect(resolver(["Robert Owen", "Robin Owen"]).resolveProviderName("Rob Owen")).rejects.toBeInstanceOf(PlayerAmbiguousError);
  });
  it("requires an exact complete surname and at least three given-name letters", async () => {
    for (const name of ["Ro Owen", "Rob Owens", "Rob van Owen", "Bob Owen", "Rob Owen (WAL)"]) {
      await expect(resolver(["Robert Owen"]).resolveProviderName(name)).rejects.toBeInstanceOf(PlayerNotFoundError);
    }
  });
  it("prefers an exact full-name identity over a prefix candidate", async () => {
    await expect(resolver(["Rob Owen", "Robert Owen"]).resolveProviderName("Rob Owen")).resolves.toBe("Rob Owen");
  });
  it("does not resolve a corrupt source ID claiming two different names", async () => {
    const names = new FixtureNameResolver({ getPlayerStats: async (): Promise<PlayerStatsResponse> => ({ draw: 1, recordsTotal: 2, recordsFiltered: 2, data: [
      { player_key: 1, player_name: "Robert Owen", player_profile_url: "https://dartsorakel.com/player/details/1/robert-owen" },
      { player_key: 1, player_name: "Robin Owen", player_profile_url: "https://dartsorakel.com/player/details/1/robin-owen" },
    ] }) });
    await expect(names.resolveProviderName("Rob Owen")).rejects.toBeInstanceOf(PlayerNotFoundError);
  });
});
