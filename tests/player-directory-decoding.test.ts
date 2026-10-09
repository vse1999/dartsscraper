import { describe, expect, it } from "vitest";
import { PlayerResolver } from "../src/player/resolver.js";
import { FixtureNameResolver } from "../src/modus/fixture-name-resolver.js";
import { PlayerStatsResponseSchema, type PlayerStatsResponse } from "../src/schemas/player.js";

function directory(): PlayerStatsResponse {
  return PlayerStatsResponseSchema.parse({ draw: 0, recordsTotal: 3, recordsFiltered: 3, data: [
    { player_key: 30, player_name: "William O&#039;Connor", player_profile_url: "https://dartsorakel.com/player/details/30/william-oconnor" },
    { player_key: 2, player_name: "D&#xE1;vid &amp; Test", player_profile_url: "https://dartsorakel.com/player/details/2/david-test" },
    { player_key: 3, player_name: "Example&nbsp;Player", player_profile_url: "https://dartsorakel.com/player/details/3/example-player" },
  ] });
}
describe("provider directory name decoding", () => {
  it("decodes numeric, hex and named entities once at the provider boundary", () => {
    expect(directory().data.map((row) => row.player_name)).toEqual(["William O'Connor", "Dávid & Test", "Example Player"]);
  });
  it("resolves the captured top-player encoded spelling through both history and fixture resolvers", async () => {
    const response = directory();
    const client = { getPlayerStats: async () => response };
    expect(await new PlayerResolver(client).resolvePlayer("William O'Connor")).toMatchObject({ id: 30, name: "William O'Connor" });
    expect(await new FixtureNameResolver(client).resolve("O'Connor W.")).toBe("William O'Connor");
  });
  it("does not make conflicting decoded identities unambiguous", async () => {
    const response = directory();
    const duplicate = response.data[0];
    if (duplicate === undefined) throw new Error("Expected test identity");
    response.data.push({ ...duplicate, player_key: 4, player_profile_url: "https://dartsorakel.com/player/details/4/william-oconnor" });
    await expect(new PlayerResolver({ getPlayerStats: async () => response }).resolvePlayer("William O'Connor")).rejects.toThrow("ambiguous");
  });
});
